"""Stream a model answer from the direct-evidence package.

Local model mode (dev_server.py) and the production app (ask_api.production_app) both
use this module unchanged.

The provider (Anthropic, Bedrock, or the in-process fixture) only turns a request
into ModelEvents. This module owns everything else, identically for every provider:
the prompt and evidence, the bounded history, SOURCES holdback and parsing, citation
validation, deadlines and cancellation, usage reporting, and the public stream events
(delta, done, error). Citation URLs are copied from the evidence package after the
stream ends.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from enum import Enum
from pathlib import Path

from ask_api.local_conversation import (
    LOCAL_SYSTEM_PROMPT,
    MAX_GENERATION_TOKENS,
    TEMPERATURE,
    LocalAnswerRejected,
    TokenUsage,
    build_user_message,
    citations_for,
    estimate_cost_usd,
    parse_model_output,
    parse_rate,
    push_model_text,
    select_history,
)
from ask_api.local_evidence import (
    EvidencePackage,
    EvidenceSection,
    LocalEvidenceError,
    load_evidence_package,
)
from ask_api.model_providers import (
    ModelBusy,
    ModelPaused,
    ModelProvider,
    ModelRequest,
    ModelSetupError,
    StreamStop,
    TextDelta,
    UsageReport,
)
from ask_api.model_providers.base import MODEL_MESSAGE, STREAM_DEADLINE_SECONDS

# Kept under the local name used by the development server and its tests.
LocalSetupError = ModelSetupError

SETUP_MESSAGE = "Model answers are not configured."
EVIDENCE_MESSAGE = "The local evidence package is unavailable."
UNAVAILABLE_MESSAGE = "The career assistant is temporarily unavailable."
VALIDATION_MESSAGE = "The answer could not be verified and was discarded."
INTERRUPTED_MESSAGE = "The response was interrupted. Please try again."
TIMEOUT_MESSAGE = "The request timed out. Please try again."
CANCELLED_MESSAGE = "The request was cancelled."
PAUSED_MESSAGE = "The career assistant is paused for now. The career pages are still here."
BUSY_MESSAGE = "The career assistant is busy. Please try again in a minute."

__all__ = [
    "BUSY_MESSAGE",
    "MODEL_MESSAGE",
    "PAUSED_MESSAGE",
    "SETUP_MESSAGE",
    "STREAM_DEADLINE_SECONDS",
    "LocalModelMode",
    "LocalSetupError",
    "build_model_request",
    "iter_model_events",
    "load_configured_package",
    "local_model_mode",
]


class LocalModelMode(Enum):
    """How the local server answers a streaming request."""

    OFF = "off"
    LIVE = "live"
    FIXTURE = "fixture"


def local_model_mode(environ: Mapping[str, str] | None = None) -> LocalModelMode:
    """Read the opt-in local model switch. The default is deterministic JSON."""
    source = os.environ if environ is None else environ
    raw = source.get("LOCAL_MODEL_CONVERSATION", "").strip().lower()
    if raw in {"1", "true", "live"}:
        return LocalModelMode.LIVE
    if raw == "fixture":
        return LocalModelMode.FIXTURE
    return LocalModelMode.OFF


def build_model_request(
    question: str, history: Sequence[tuple[str, str]], package: EvidencePackage
) -> ModelRequest:
    """The same request for every provider."""
    return ModelRequest(
        system=LOCAL_SYSTEM_PROMPT,
        user_text=build_user_message(question, history, package),
        max_tokens=MAX_GENERATION_TOKENS,
        temperature=TEMPERATURE,
        question=question,
        history=tuple(history),
        evidence=package,
    )


def iter_model_events(
    question: str,
    history: Sequence[tuple[str, str]],
    request_id: str,
    *,
    package: EvidencePackage,
    provider: ModelProvider,
    cancelled: Callable[[], bool] | None = None,
    now: Callable[[], float] | None = None,
    deadline_seconds: float = STREAM_DEADLINE_SECONDS,
    input_usd_per_million: str | None = None,
    output_usd_per_million: str | None = None,
    on_setup_error: Callable[[BaseException], None] | None = None,
) -> Iterator[dict[str, object]]:
    """Yield public stream events. Exceptions are not included in the payload.

    ``on_setup_error`` receives the exception when opening the model stream fails, for
    example while resolving credentials. The caller decides what to log; nothing from the
    exception reaches the public events.
    """
    if cancelled is not None and cancelled():
        yield _error("cancelled", CANCELLED_MESSAGE, request_id)
        return
    clock = time.monotonic if now is None else now
    started = clock()
    try:
        stream = provider.open_stream(build_model_request(question, history, package))
    except ModelSetupError:
        raise
    except ModelPaused:
        yield _error("paused", PAUSED_MESSAGE, request_id)
        return
    except ModelBusy:
        yield _error("busy", BUSY_MESSAGE, request_id)
        return
    except Exception as error:
        if on_setup_error is not None:
            on_setup_error(error)
        yield _error("unavailable", UNAVAILABLE_MESSAGE, request_id)
        return

    raw = ""
    emitted = 0
    usage: TokenUsage | None = None
    stopped = False
    try:
        for event in stream:
            if cancelled is not None and cancelled():
                yield _error("cancelled", CANCELLED_MESSAGE, request_id, usage)
                return
            if clock() - started > deadline_seconds:
                yield _error("timeout", TIMEOUT_MESSAGE, request_id, usage)
                return
            if isinstance(event, TextDelta):
                if event.text == "":
                    continue
                raw += event.text
                delta, emitted = push_model_text(raw, emitted)
                if delta != "":
                    yield {"type": "delta", "text": delta}
            elif isinstance(event, UsageReport):
                usage = event.usage
            elif isinstance(event, StreamStop):
                stopped = True
            else:
                if event.kind == "service":
                    yield _error("unavailable", UNAVAILABLE_MESSAGE, request_id, usage)
                else:
                    yield _error("validation", VALIDATION_MESSAGE, request_id, usage)
                return
    except ModelPaused:
        yield _error("paused", PAUSED_MESSAGE, request_id, usage)
        return
    except ModelBusy:
        yield _error("busy", BUSY_MESSAGE, request_id, usage)
        return
    except Exception:
        yield _error("unavailable", UNAVAILABLE_MESSAGE, request_id, usage)
        return

    if not stopped:
        yield _error("interrupted", INTERRUPTED_MESSAGE, request_id, usage)
        return
    yield _completion(
        raw,
        package,
        request_id,
        usage,
        provider.fixture,
        input_usd_per_million,
        output_usd_per_million,
    )


def default_evidence_paths(repo_root: Path) -> tuple[Path, Path]:
    """Return the retrieval directory and manifest written by the content pipeline."""
    generated = repo_root / "generated"
    return generated / "retrieval", generated / "retrieval-manifest.json"


def load_configured_package(
    repo_root: Path, environ: Mapping[str, str] | None = None
) -> EvidencePackage:
    """Load the evidence package or raise a public setup error."""
    source = os.environ if environ is None else environ
    directory_value = source.get("LOCAL_EVIDENCE_DIR", "").strip()
    manifest_value = source.get("LOCAL_EVIDENCE_MANIFEST", "").strip()
    if directory_value != "" and manifest_value != "":
        directory = Path(directory_value)
        manifest = Path(manifest_value)
    else:
        directory, manifest = default_evidence_paths(repo_root)
    try:
        return load_evidence_package(directory, manifest)
    except LocalEvidenceError:
        raise LocalSetupError(EVIDENCE_MESSAGE) from None


def _completion(
    raw: str,
    package: EvidencePackage,
    request_id: str,
    usage: TokenUsage | None,
    fixture: bool,
    input_rate: str | None,
    output_rate: str | None,
) -> dict[str, object]:
    try:
        parsed = parse_model_output(raw)
        sections = citations_for(package, parsed.chunk_ids)
    except LocalAnswerRejected:
        return _error("validation", VALIDATION_MESSAGE, request_id, usage)
    payload: dict[str, object] = {
        "type": "done",
        "answer": parsed.answer,
        "citations": [_citation(section) for section in sections],
        "requestId": request_id,
        "fixture": fixture,
    }
    if usage is not None:
        payload["usage"] = _usage_payload(usage)
        if not fixture:
            estimate = estimate_cost_usd(usage, parse_rate(input_rate), parse_rate(output_rate))
            if estimate is not None:
                payload["estimatedCostUsd"] = format(estimate, "f")
    return payload


def _citation(section: EvidenceSection) -> dict[str, str]:
    item = section
    return {
        "chunkId": item.chunk_id,
        "documentId": item.document_id,
        "title": item.title,
        "section": item.section,
        "url": item.url,
    }


def _error(
    code: str, message: str, request_id: str, usage: TokenUsage | None = None
) -> dict[str, object]:
    """A public error event. Token counts are included when the stream reported them."""
    payload: dict[str, object] = {
        "type": "error",
        "code": code,
        "message": message,
        "requestId": request_id,
    }
    if usage is not None:
        payload["usage"] = _usage_payload(usage)
    return payload


def _usage_payload(usage: TokenUsage) -> dict[str, int]:
    return {"inputTokens": usage.input_tokens, "outputTokens": usage.output_tokens}


def bounded_history(history: Sequence[tuple[str, str]]) -> tuple[tuple[str, str], ...]:
    """Public wrapper so tests can see the six-exchange window."""
    return select_history(history)
