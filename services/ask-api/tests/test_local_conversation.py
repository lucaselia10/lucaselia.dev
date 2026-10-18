"""Local model conversation, exercised with injected streams. Not a live Nova evaluation."""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

import pytest

import dev_server
from ask_api.exact_answers import FALLBACK_ANSWER
from ask_api.handler import handler
from ask_api.index_loader import load_index
from ask_api.local_conversation import (
    LOCAL_SYSTEM_PROMPT,
    MAX_HISTORY_EXCHANGES,
    LocalAnswerRejected,
    TokenUsage,
    build_user_message,
    estimate_cost_usd,
    parse_model_output,
    parse_rate,
    push_model_text,
    select_history,
)
from ask_api.local_evidence import (
    MAX_CHUNK_CHARS,
    EvidencePackage,
    EvidenceSection,
    LocalEvidenceError,
    load_evidence_package,
)
from ask_api.local_stream import (
    MODEL_MESSAGE,
    SETUP_MESSAGE,
    VALIDATION_MESSAGE,
    LocalModelMode,
    LocalSetupError,
    iter_model_events,
    local_model_mode,
)
from ask_api.model_providers import FixtureProvider
from ask_api.model_providers import bedrock as bedrock_provider
from ask_api.model_providers.bedrock import (
    PROFILE_MESSAGE,
    RAW_KEY_VARIABLES,
    RAW_KEYS_MESSAGE,
    BedrockProvider,
    configured_model_id,
    configured_profile,
    live_stream_client,
)

CHUNK_ID = "aws-sde-ii:role-description:0"
NOVA = "us.amazon.nova-2-lite-v1:0"
RELIABILITY = "Improved production reliability across containerized compute."
USAGE_EVENT: Mapping[str, object] = {
    "metadata": {"usage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16}}
}


def fake(client: object) -> Any:
    """A test double standing in for a typed SDK client (the real types are checked in
    test_model_providers_real_clients.py)."""
    return client


class FakeClient:
    """Records one converse_stream call and replays injected events."""

    def __init__(self, events: Sequence[Mapping[str, object]]) -> None:
        self.events = events
        self.calls: list[dict[str, object]] = []

    def converse_stream(
        self,
        *,
        modelId: str,
        system: Sequence[Mapping[str, str]],
        messages: Sequence[Mapping[str, object]],
        inferenceConfig: Mapping[str, object],
        additionalModelRequestFields: Mapping[str, object],
    ) -> Mapping[str, object]:
        self.calls.append(
            {
                "modelId": modelId,
                "system": system,
                "messages": messages,
                "inferenceConfig": inferenceConfig,
                "additionalModelRequestFields": additionalModelRequestFields,
            }
        )
        return {"stream": iter(self.events)}


def test_simple_fact_uses_generation_and_does_not_bypass_it() -> None:
    package = _package(RELIABILITY)
    client = FakeClient(
        _text_events(f"Lucas is Software Development Engineer II.\nSOURCES: {CHUNK_ID}")
    )

    events = list(
        _run(
            "What is Lucas's current role?",
            package,
            client,
        )
    )

    assert client.calls
    prompt = _prompt(client)
    assert "What is Lucas's current role?" in prompt
    assert RELIABILITY in prompt
    assert "toolConfig" not in client.calls[0]
    settings = client.calls[0]["inferenceConfig"]
    assert settings == {"maxTokens": 500, "temperature": 0.0}
    extra = client.calls[0]["additionalModelRequestFields"]
    assert extra == {"reasoningConfig": {"type": "disabled"}}
    assert events[0]["type"] == "delta"
    done = events[-1]
    assert done["type"] == "done"
    assert done["answer"] == "Lucas is Software Development Engineer II."
    assert "December 2025" not in str(done["answer"])
    citations = done["citations"]
    assert isinstance(citations, list)
    assert citations[0]["url"] == "/experience/aws-sde-ii#role-description"
    assert citations[0]["url"] != "https://model.example/invented"


def test_reliability_question_sends_the_full_section() -> None:
    package = _package(RELIABILITY)
    client = FakeClient(
        _text_events(f"Reliability work is described in the role.\nSOURCES: {CHUNK_ID}")
    )

    list(_run("How has he improved production reliability?", package, client))

    assert RELIABILITY in _prompt(client)
    assert "Conversation context, not evidence" in _prompt(client)


def test_follow_up_keeps_six_exchanges_and_drops_the_oldest() -> None:
    history: list[tuple[str, str]] = []
    for index in range(1, 8):
        history.append(("user", f"Question {index} marker-{index}"))
        history.append(("assistant", f"Answer {index}"))
    kept = select_history(history)

    assert len(kept) == MAX_HISTORY_EXCHANGES * 2
    joined = " ".join(content for _, content in kept)
    assert "marker-1" not in joined
    assert "marker-2" in joined
    assert "marker-7" in joined
    package = _package("Evidence text stays complete.")
    message = build_user_message("And the next one?", history, package)
    assert "marker-1" not in message
    assert "marker-7" in message
    assert "not evidence" in message
    assert "Evidence text stays complete." in message


def test_oversized_history_drops_whole_exchanges() -> None:
    history = (
        ("user", "old"),
        ("assistant", "x" * 30_000),
        ("user", "new-question-marker"),
        ("assistant", "short answer"),
    )
    kept = select_history(history)

    assert kept == (("user", "new-question-marker"), ("assistant", "short answer"))


def test_unsupported_evidence_uses_the_insufficient_sentence() -> None:
    package = _package("A public role description.")
    client = FakeClient(_text_events(f"{FALLBACK_ANSWER}\nSOURCES: none"))

    events = list(_run("What is the weather in Seattle?", package, client))

    done = events[-1]
    assert done["type"] == "done"
    assert done["answer"] == FALLBACK_ANSWER
    assert done["citations"] == []


def test_unknown_citation_rejects_the_answer_after_a_delta() -> None:
    package = _package("A public role description.")
    client = FakeClient(_text_events("A claim.\nSOURCES: missing-chunk"))

    events = list(_run("What has Lucas built?", package, client))

    assert events[0]["type"] == "delta"
    assert events[-1] == {
        "type": "error",
        "code": "validation",
        "message": VALIDATION_MESSAGE,
        "requestId": "request-1",
    }
    assert all(event["type"] != "done" for event in events)


def test_sources_split_across_events_is_not_shown_as_answer_text() -> None:
    package = _package("A public role description.")
    client = FakeClient(
        (
            {"contentBlockDelta": {"delta": {"text": "Visible answer.\nSOUR"}}},
            {"contentBlockDelta": {"delta": {"text": f"CES: {CHUNK_ID}"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16}}},
        )
    )

    events = list(_run("What is Lucas's current role?", package, client))

    deltas = [event["text"] for event in events if event["type"] == "delta"]
    assert "".join(str(item) for item in deltas) == "Visible answer."
    assert "SOURCES" not in "".join(str(item) for item in deltas)
    done = events[-1]
    assert done["type"] == "done"
    assert done["usage"] == {"inputTokens": 12, "outputTokens": 4}
    assert "estimatedCostUsd" not in done


def test_cost_uses_configured_rates_and_not_a_made_up_bill() -> None:
    usage = TokenUsage(1_000_000, 2_000_000)
    assert estimate_cost_usd(usage, None, Decimal("1")) is None
    assert estimate_cost_usd(usage, parse_rate(None), parse_rate("")) is None
    assert estimate_cost_usd(usage, Decimal("0.50"), Decimal("1.25")) == Decimal("3.000000")


def test_validation_failure_does_not_finish_as_success() -> None:
    package = _package("A public role description.")
    client = FakeClient(_text_events("A claim without a sources line"))

    events = list(_run("What is Lucas's current role?", package, client))

    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "validation"


def test_cancellation_and_timeout_are_not_successful() -> None:
    package = _package("A public role description.")
    client = FakeClient(_text_events(f"Partial.\nSOURCES: {CHUNK_ID}"))
    cancelled = iter_model_events(
        "What is Lucas's current role?",
        (),
        "request-1",
        package=package,
        provider=BedrockProvider(fake(client), NOVA),
        cancelled=lambda: True,
    )
    assert list(cancelled) == [
        {
            "type": "error",
            "code": "cancelled",
            "message": "The request was cancelled.",
            "requestId": "request-1",
        }
    ]

    clock = iter((0.0, 0.0, 40.0))

    def now() -> float:
        return next(clock)

    interrupted = FakeClient(
        (
            {"contentBlockDelta": {"delta": {"text": "Partial."}}},
            {"contentBlockDelta": {"delta": {"text": " more"}}},
        )
    )
    events = list(
        iter_model_events(
            "What is Lucas's current role?",
            (),
            "request-1",
            package=package,
            provider=BedrockProvider(fake(interrupted), NOVA),
            now=now,
            deadline_seconds=31,
        )
    )
    assert events[-1]["code"] == "timeout"
    assert all(event["type"] != "done" for event in events)


def test_interrupted_stream_and_tool_json_are_rejected() -> None:
    package = _package("A public role description.")
    stopped = list(
        _run(
            "What is Lucas's current role?",
            package,
            FakeClient(({"contentBlockDelta": {"delta": {"text": "Partial."}}},)),
        )
    )
    assert stopped[-1]["code"] == "interrupted"

    tool = list(
        _run(
            "What is Lucas's current role?",
            package,
            FakeClient(
                ({"contentBlockDelta": {"delta": {"toolUse": {"input": '{"answer":"secret"}'}}}},)
            ),
        )
    )
    assert tool[-1]["code"] == "validation"
    assert "secret" not in json.dumps(tool)


def test_service_exception_does_not_substitute_a_template() -> None:
    package = _package("A public role description.")

    class Boom:
        def converse_stream(self, **kwargs: object) -> Mapping[str, object]:
            raise RuntimeError("aws_secret_access_key=hidden")

    events = list(
        iter_model_events(
            "What is Lucas's current role?",
            (),
            "request-1",
            package=package,
            provider=BedrockProvider(fake(Boom()), NOVA),
        )
    )
    rendered = json.dumps(events)
    assert events == [
        {
            "type": "error",
            "code": "unavailable",
            "message": "The career assistant is temporarily unavailable.",
            "requestId": "request-1",
        }
    ]
    assert "hidden" not in rendered
    assert "December 2025" not in rendered


def test_fixture_mode_does_not_call_bedrock() -> None:
    package = EvidencePackage(
        (
            EvidenceSection(
                chunk_id="aws-sde-apprentice:role-description:0",
                document_id="aws-sde-apprentice",
                document_type="experience",
                title="Software Development Engineer Apprentice",
                section="Role Description",
                url="/experience/aws-sde-apprentice#role-description",
                text="Apprentice text.",
            ),
            _package("Improved production reliability across containerized compute.").sections[0],
        )
    )
    events = list(
        iter_model_events(
            "How has he improved production reliability?",
            (),
            "request-1",
            package=package,
            provider=FixtureProvider(),
        )
    )
    done = events[-1]
    assert done["type"] == "done"
    assert done["fixture"] is True
    assert "Fixture stream" in str(done["answer"])
    assert "not produced by a model" in str(done["answer"])
    citations = done["citations"]
    assert isinstance(citations, list)
    assert citations[0]["chunkId"] == CHUNK_ID
    assert citations[0]["url"] == "/experience/aws-sde-ii#role-description"


def test_unconfigured_mode_and_invalid_model_hide_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LOCAL_MODEL_CONVERSATION", raising=False)
    assert local_model_mode() is LocalModelMode.OFF
    with pytest.raises(Exception, match="Model answers are not configured") as raised:
        dev_server.stream_events("secret-question-token", (), "request-1")
    assert "secret-question-token" not in str(raised.value)

    with pytest.raises(Exception, match=MODEL_MESSAGE) as invalid:
        configured_model_id({"NOVA_MODEL_ID": "anthropic.hidden-model"})
    assert "hidden-model" not in str(invalid.value)
    assert "anthropic" not in str(invalid.value)


def test_diagnostics_do_not_include_the_question(caplog: pytest.LogCaptureFixture) -> None:
    package = _package("A public role description.")
    client = FakeClient(_text_events(f"A public answer.\nSOURCES: {CHUNK_ID}"))
    with caplog.at_level("DEBUG"):
        events = list(_run("secret-question-token", package, client))
    rendered = json.dumps(events)
    assert "secret-question-token" not in rendered
    assert "secret-question-token" not in caplog.text


def test_evidence_loader_rejects_fixtures_oversize_text_and_unsafe_urls(tmp_path: Path) -> None:
    directory, manifest = _write_package(
        tmp_path,
        [
            _record(
                "fictional-lumen-harbor",
                "overview",
                "project",
                "/work/fictional-lumen-harbor#overview",
                "Nope.",
            ),
        ],
    )
    with pytest.raises(LocalEvidenceError):
        load_evidence_package(directory, manifest)

    directory, manifest = _write_package(
        tmp_path / "long",
        [
            _record(
                "aws-sde-ii",
                "role-description",
                "experience",
                "/experience/aws-sde-ii#role-description",
                "x" * (MAX_CHUNK_CHARS + 1),
            )
        ],
    )
    with pytest.raises(LocalEvidenceError):
        load_evidence_package(directory, manifest)

    directory, manifest = _write_package(
        tmp_path / "url",
        [
            _record(
                "aws-sde-ii",
                "role-description",
                "experience",
                "https://evil.example/secret",
                "Text.",
            )
        ],
    )
    with pytest.raises(LocalEvidenceError):
        load_evidence_package(directory, manifest)


def test_real_retrieval_package_contains_the_approved_documents() -> None:
    root = Path(__file__).resolve().parents[3]
    directory = root / "generated" / "retrieval"
    manifest = root / "generated" / "retrieval-manifest.json"
    package = load_evidence_package(directory, manifest)
    document_ids = {section.document_id for section in package.sections}

    assert document_ids == {
        "lucas-elia",
        "aws-sde-ii",
        "aws-sde-i",
        "aws-sde-apprentice",
        "expert-assist-consultant",
        "hospitality-businesses-co-founder",
        "bloomtech-backend-development",
        "sierra-college-general-studies",
    }
    assert "fictional-lumen-harbor" not in document_ids
    joined = "\n".join(section.text for section in package.sections)
    assert "Improved production reliability" in joined
    assert "high-memory workload support" in joined


def test_lambda_json_contract_ignores_local_model_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "fixture")
    result = handler(_event("What is Lucas's current role?"), None)
    body = json.loads(str(result["body"]))

    assert result["statusCode"] == 200
    assert "Software Development Engineer II" in body["answer"]
    assert "Fixture stream" not in body["answer"]


def test_dev_server_streams_injected_events_and_keeps_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "fixture")

    def events(
        question: str,
        history: tuple[tuple[str, str], ...],
        request_id: str,
    ) -> Iterator[dict[str, object]]:
        assert question == "What is Lucas's current role?"
        assert history == ()
        citations: list[object] = []
        done: dict[str, object] = {
            "type": "done",
            "answer": "Hello",
            "citations": citations,
            "requestId": request_id,
            "fixture": True,
        }
        delta: dict[str, object] = {"type": "delta", "text": "Hello"}
        return iter((delta, done))

    monkeypatch.setattr(dev_server, "stream_events", events)
    streamed = dev_server.handle_exchange(
        "POST",
        "/ask",
        {"Accept": "application/x-ndjson"},
        _body({"question": "What is Lucas's current role?", "mode": "career_question"}),
    )
    assert streamed.status == 200
    assert streamed.headers["Content-Type"].startswith("application/x-ndjson")
    lines = [json.loads(line) for line in streamed.body.decode().splitlines()]
    assert lines[0]["type"] == "delta"
    assert lines[1]["type"] == "done"

    json_result = dev_server.handle_exchange(
        "POST",
        "/ask",
        {},
        _body({"question": "What is Lucas's current role?", "mode": "career_question"}),
    )
    payload = json.loads(json_result.body)
    assert "December 2025" in payload["answer"]


def test_unconfigured_stream_is_a_setup_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOCAL_MODEL_CONVERSATION", raising=False)
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    result = dev_server.handle_exchange(
        "POST",
        "/ask",
        {"Accept": "application/x-ndjson"},
        _body({"question": "secret-question-token", "mode": "career_question"}),
    )
    payload = json.loads(result.body)

    assert result.status == 503
    assert payload["message"] == SETUP_MESSAGE
    rendered = result.body.decode()
    assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in rendered
    assert "secret-question-token" not in rendered
    assert "NOVA_MODEL_ID" not in rendered


def test_missing_evidence_does_not_echo_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "fixture")
    missing = tmp_path / "missing-evidence-directory"
    monkeypatch.setenv("LOCAL_EVIDENCE_DIR", str(missing))
    monkeypatch.setenv("LOCAL_EVIDENCE_MANIFEST", str(missing / "manifest.json"))

    result = dev_server.handle_exchange(
        "POST",
        "/ask",
        {"Accept": "application/x-ndjson"},
        _body({"question": "What is Lucas's current role?", "mode": "career_question"}),
    )
    rendered = result.body.decode()

    assert result.status == 503
    assert "The local evidence package is unavailable." in rendered
    assert "missing-evidence-directory" not in rendered


# One entry per case in the SOURCES holdback audit. Each is also replayed char by char.
SOURCES_CASES: dict[str, tuple[str, ...]] = {
    "split_sour_ces": ("Visible answer.\nSOUR", f"CES: {CHUNK_ID}"),
    "newline_at_chunk_end": ("Visible answer.\n", f"SOURCES: {CHUNK_ID}"),
    "trailing_newline": (f"Visible answer.\nSOURCES: {CHUNK_ID}", "\n"),
    "trailing_whitespace_and_newlines": (f"Visible answer.\nSOURCES: {CHUNK_ID}", "  \n\n "),
    "bold_marker": (f"Visible answer.\n**SOURCES:** {CHUNK_ID}",),
    "italic_marker": (f"Visible answer.\n*SOURCES:* {CHUNK_ID}",),
    "blank_line_before": (f"Visible answer.\n\nSOURCES: {CHUNK_ID}",),
}


@pytest.mark.parametrize("by_char", [False, True], ids=["chunks", "char_by_char"])
@pytest.mark.parametrize("pieces", SOURCES_CASES.values(), ids=SOURCES_CASES.keys())
def test_sources_line_never_reaches_visible_text(pieces: tuple[str, ...], by_char: bool) -> None:
    if by_char:
        pieces = tuple("".join(pieces))
    package = _package("A public role description.")
    client = FakeClient(
        (
            *({"contentBlockDelta": {"delta": {"text": piece}}} for piece in pieces),
            {"messageStop": {"stopReason": "end_turn"}},
        )
    )

    events = list(_run("What is Lucas's current role?", package, client))

    visible = "".join(str(event["text"]) for event in events if event["type"] == "delta")
    assert visible == "Visible answer."
    for fragment in ("SOUR", "*", CHUNK_ID):
        assert fragment not in visible
    done = events[-1]
    assert done["type"] == "done"
    assert done["answer"] == "Visible answer."
    citations = cast(list[dict[str, str]], done["citations"])
    assert [item["chunkId"] for item in citations] == [CHUNK_ID]


def test_holdback_releases_lines_that_only_resemble_the_marker() -> None:
    raw = ""
    emitted = 0
    visible = ""
    for character in "Line one.\n\nSeattle line.\n*Note* x.\nSOURCES: none":
        raw += character
        delta, emitted = push_model_text(raw, emitted)
        visible += delta
    assert visible == "Line one.\n\nSeattle line.\n*Note* x."


def test_sources_parsing_keeps_chunk_ids_strict() -> None:
    with pytest.raises(LocalAnswerRejected):
        parse_model_output("A claim.\n**SOURCES:** not a valid id!")
    with pytest.raises(LocalAnswerRejected):
        parse_model_output(f"A claim.\n***SOURCES:*** {CHUNK_ID}")
    with pytest.raises(LocalAnswerRejected):
        parse_model_output(f"A claim.\nSOURCES: {CHUNK_ID}\nMore text after sources.")
    with pytest.raises(LocalAnswerRejected):
        parse_model_output(f"A claim.\nSOURCES: {CHUNK_ID}\nSecond.\nSOURCES: {CHUNK_ID}")
    parsed = parse_model_output(f"A claim.\n*SOURCES:* {CHUNK_ID}, other:id:0 \n\n")
    assert parsed.chunk_ids == (CHUNK_ID, "other:id:0")


def test_rejected_answer_reports_token_usage() -> None:
    package = _package("A public role description.")
    client = FakeClient((*_text_events("A claim.\nSOURCES: missing-chunk"), USAGE_EVENT))

    events = list(_run("What has Lucas built?", package, client))

    assert events[-1]["code"] == "validation"
    assert events[-1]["usage"] == {"inputTokens": 12, "outputTokens": 4}


def test_interrupted_stream_reports_token_usage() -> None:
    package = _package("A public role description.")
    client = FakeClient(({"contentBlockDelta": {"delta": {"text": "Partial."}}}, USAGE_EVENT))

    events = list(_run("What has Lucas built?", package, client))

    assert events[-1]["code"] == "interrupted"
    assert events[-1]["usage"] == {"inputTokens": 12, "outputTokens": 4}


def test_timeout_after_usage_reports_token_usage() -> None:
    package = _package("A public role description.")
    clock = iter((0.0, 0.0, 40.0))
    client = FakeClient((USAGE_EVENT, {"contentBlockDelta": {"delta": {"text": "Late."}}}))

    events = list(
        iter_model_events(
            "What has Lucas built?",
            (),
            "request-1",
            package=package,
            provider=BedrockProvider(fake(client), NOVA),
            now=lambda: next(clock),
        )
    )

    assert events[-1]["code"] == "timeout"
    assert events[-1]["usage"] == {"inputTokens": 12, "outputTokens": 4}


def test_errors_without_reported_usage_omit_it() -> None:
    package = _package("A public role description.")
    events = list(_run("What has Lucas built?", package, FakeClient(_text_events("No sources"))))
    assert "usage" not in events[-1]


def test_fixture_answers_never_show_a_cost() -> None:
    events = list(
        iter_model_events(
            "What is Lucas's current role?",
            (),
            "request-1",
            package=_package("A public role description."),
            provider=FixtureProvider(),
            input_usd_per_million="1",
            output_usd_per_million="1",
        )
    )
    done = events[-1]
    assert done["type"] == "done"
    assert done["fixture"] is True
    assert "usage" in done
    assert "estimatedCostUsd" not in done


def test_live_answers_show_a_cost_only_with_both_rates() -> None:
    package = _package("A public role description.")
    stream = (*_text_events(f"An answer.\nSOURCES: {CHUNK_ID}"), USAGE_EVENT)
    priced = list(
        iter_model_events(
            "What is Lucas's current role?",
            (),
            "request-1",
            package=package,
            provider=BedrockProvider(fake(FakeClient(stream)), NOVA),
            input_usd_per_million="1000000",
            output_usd_per_million="1000000",
        )
    )
    assert priced[-1]["estimatedCostUsd"] == "16.000000"


def test_live_client_uses_the_named_profile_and_region() -> None:
    created: list[dict[str, object]] = []

    class FakeSession:
        def __init__(self, **kwargs: object) -> None:
            created.append(kwargs)

        def client(self, service_name: str, *, config: object) -> object:
            created.append({"service": service_name})
            return FakeClient(())

    client = live_stream_client("example-profile", session_factory=FakeSession)

    assert isinstance(client, FakeClient)
    assert created == [
        {"profile_name": "example-profile", "region_name": "us-west-2"},
        {"service": "bedrock-runtime"},
    ]


def test_live_mode_requires_a_named_profile() -> None:
    assert configured_profile({"LOCAL_AWS_PROFILE": " example-profile "}) == "example-profile"
    for environ in ({}, {"LOCAL_AWS_PROFILE": "  "}, {"AWS_PROFILE": "default"}):
        with pytest.raises(LocalSetupError) as raised:
            configured_profile(environ)
        assert raised.value.public_message == PROFILE_MESSAGE
        assert "default" not in str(raised.value)


@pytest.mark.parametrize("variable", RAW_KEY_VARIABLES)
def test_live_mode_refuses_raw_key_environment_variables(variable: str) -> None:
    environ = {"LOCAL_AWS_PROFILE": "example-profile", variable: "raw-secret-value"}
    with pytest.raises(LocalSetupError) as raised:
        configured_profile(environ)
    assert raised.value.public_message == RAW_KEYS_MESSAGE
    assert "raw-secret-value" not in str(raised.value)
    with pytest.raises(LocalSetupError):
        configured_profile({"LOCAL_AWS_PROFILE": "example-profile", variable: ""})


def test_dev_server_live_stream_refuses_without_a_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "true")
    monkeypatch.setenv("LOCAL_MODEL_PROVIDER", "bedrock")
    monkeypatch.delenv("LOCAL_AWS_PROFILE", raising=False)
    for variable in RAW_KEY_VARIABLES:
        monkeypatch.delenv(variable, raising=False)

    def forbidden(*args: object, **kwargs: object) -> object:
        raise AssertionError("no client may be built without a profile")

    monkeypatch.setattr(bedrock_provider, "live_stream_client", forbidden)
    result = _stream_request()
    assert result.status == 503
    assert json.loads(result.body)["message"] == PROFILE_MESSAGE

    monkeypatch.setenv("LOCAL_AWS_PROFILE", "example-profile")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "raw-secret-value")
    refused = _stream_request()
    assert refused.status == 503
    assert json.loads(refused.body)["message"] == RAW_KEYS_MESSAGE
    assert "raw-secret-value" not in refused.body.decode()
    assert "example-profile" not in refused.body.decode()


def test_dev_server_live_stream_builds_the_client_from_the_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "true")
    monkeypatch.setenv("LOCAL_MODEL_PROVIDER", "bedrock")
    monkeypatch.setenv("LOCAL_AWS_PROFILE", "example-profile")
    for variable in RAW_KEY_VARIABLES:
        monkeypatch.delenv(variable, raising=False)
    profiles: list[str] = []
    package = _package("A public role description.")

    def fake_client(profile: str) -> FakeClient:
        profiles.append(profile)
        return FakeClient((*_text_events(f"An answer.\nSOURCES: {CHUNK_ID}"), USAGE_EVENT))

    monkeypatch.setattr(bedrock_provider, "live_stream_client", fake_client)

    def fake_package(root: Path) -> EvidencePackage:
        return package

    monkeypatch.setattr(dev_server, "load_configured_package", fake_package)
    result = _stream_request()

    assert result.status == 200
    lines = [json.loads(line) for line in result.body.decode().splitlines()]
    assert lines[-1]["type"] == "done"
    assert profiles == ["example-profile"]


def test_dev_server_refuses_to_start_live_mode_without_a_profile(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "true")
    monkeypatch.setenv("LOCAL_MODEL_PROVIDER", "bedrock")
    monkeypatch.delenv("LOCAL_AWS_PROFILE", raising=False)
    monkeypatch.setattr(dev_server.sys, "argv", ["dev_server.py"])

    def forbidden(*args: object, **kwargs: object) -> object:
        raise AssertionError("the server must not bind without a profile")

    monkeypatch.setattr(dev_server, "ThreadingHTTPServer", forbidden)
    with pytest.raises(SystemExit) as exited:
        dev_server.main()
    assert exited.value.code == 2
    assert PROFILE_MESSAGE in capsys.readouterr().err


def test_dev_server_reports_outcome_and_tokens_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "fixture")

    def events(
        question: str, history: tuple[tuple[str, str], ...], request_id: str
    ) -> Iterator[dict[str, object]]:
        delta: dict[str, object] = {"type": "delta", "text": "secret-answer-token"}
        error: dict[str, object] = {
            "type": "error",
            "code": "validation",
            "message": VALIDATION_MESSAGE,
            "requestId": request_id,
            "usage": {"inputTokens": 12, "outputTokens": 4},
        }
        return iter((delta, error))

    monkeypatch.setattr(dev_server, "stream_events", events)
    streamed = _stream_request("secret-question-token")
    request_id = json.loads(streamed.body.decode().splitlines()[-1])["requestId"]
    dev_server.handle_exchange(
        "POST", "/ask", {}, _body({"question": "secret-question-token", "mode": "career_question"})
    )

    lines = capsys.readouterr().err.splitlines()
    assert lines[0] == (
        f"ask request={request_id} outcome=error_validation input_tokens=12 output_tokens=4"
    )
    assert lines[1].endswith("outcome=http_200 input_tokens=- output_tokens=-")
    rendered = "\n".join(lines)
    assert "secret-question-token" not in rendered
    assert "secret-answer-token" not in rendered


def test_dev_server_reports_setup_errors_by_class_name_only(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "true")
    monkeypatch.setenv("LOCAL_MODEL_PROVIDER", "bedrock")
    monkeypatch.setenv("LOCAL_AWS_PROFILE", "example-profile")
    for variable in RAW_KEY_VARIABLES:
        monkeypatch.delenv(variable, raising=False)
    package = _package("A public role description.")

    def fake_package(root: Path) -> EvidencePackage:
        return package

    class MissingDependencyException(Exception):
        pass

    class NoCredentials:
        def converse_stream(self, **kwargs: object) -> Mapping[str, object]:
            raise MissingDependencyException("needs botocore[crt] aws_secret_access_key=hidden")

    monkeypatch.setattr(dev_server, "load_configured_package", fake_package)

    def no_credentials(profile: str) -> NoCredentials:
        return NoCredentials()

    monkeypatch.setattr(bedrock_provider, "live_stream_client", no_credentials)
    streamed = _stream_request("secret-question-token")
    event = json.loads(streamed.body.decode().splitlines()[-1])

    def broken(profile: str) -> object:
        raise MissingDependencyException("profile contents token=hidden")

    monkeypatch.setattr(bedrock_provider, "live_stream_client", broken)
    refused = _stream_request("secret-question-token")

    assert event["code"] == "unavailable"
    assert event["message"] == "The career assistant is temporarily unavailable."
    assert refused.status == 503
    assert json.loads(refused.body)["message"] == MODEL_MESSAGE
    browser = streamed.body.decode() + refused.body.decode()
    assert "MissingDependencyException" not in browser
    lines = capsys.readouterr().err.splitlines()
    setup = [line for line in lines if line.startswith("ask setup_error ")]
    assert setup[0] == (
        f"ask setup_error request={event['requestId']} error=MissingDependencyException"
    )
    assert len(setup) == 2
    assert setup[1].endswith(" error=MissingDependencyException")
    rendered = "\n".join(lines)
    for secret in ("hidden", "crt", "secret-question-token", "example-profile"):
        assert secret not in rendered


def test_evidence_loader_requires_retrievable_documents_in_the_index(tmp_path: Path) -> None:
    record = _record(
        "aws-sde-ii",
        "role-description",
        "experience",
        "/experience/aws-sde-ii#role-description",
        "Text.",
    )
    directory, manifest = _write_package(tmp_path / "ok", [record])
    assert load_evidence_package(directory, manifest).sections[0].document_id == "aws-sde-ii"

    document = json.loads(_packaged_index_bytes())
    for item in document["documents"]:
        if item["id"] == "aws-sde-ii":
            item["assistant_retrievable"] = False
    flipped = load_index(data=json.dumps(document).encode("utf-8"))
    with pytest.raises(LocalEvidenceError):
        load_evidence_package(directory, manifest, index=flipped)

    unknown = _record(
        "unlisted-role",
        "role-description",
        "experience",
        "/experience/unlisted-role#role-description",
        "Text.",
    )
    directory, manifest = _write_package(tmp_path / "unknown", [unknown])
    with pytest.raises(LocalEvidenceError):
        load_evidence_package(directory, manifest)


def test_real_retrieval_package_carries_front_matter_facts() -> None:
    root = Path(__file__).resolve().parents[3]
    package = load_evidence_package(
        root / "generated" / "retrieval", root / "generated" / "retrieval-manifest.json"
    )
    for section in package.sections:
        assert "\nFacts:\n" in section.text
    role = package.by_id()[CHUNK_ID].text
    assert "Employer: " in role
    assert "Start date: " in role
    assert "End date: " in role


def _run(
    question: str, package: EvidencePackage, client: FakeClient
) -> Iterator[dict[str, object]]:
    return iter_model_events(
        question,
        (),
        "request-1",
        package=package,
        provider=BedrockProvider(fake(client), NOVA),
    )


def _prompt(client: FakeClient) -> str:
    messages = client.calls[0]["messages"]
    assert isinstance(messages, list)
    message = cast(Mapping[str, object], cast(list[object], messages)[0])
    content = message.get("content")
    assert isinstance(content, list)
    block = cast(Mapping[str, object], cast(list[object], content)[0])
    text = block.get("text")
    assert isinstance(text, str)
    return text


def _text_events(text: str) -> tuple[Mapping[str, object], ...]:
    midpoint = max(1, len(text) // 2)
    return (
        {"contentBlockDelta": {"delta": {"text": text[:midpoint]}}},
        {"contentBlockDelta": {"delta": {"text": text[midpoint:]}}},
        {"messageStop": {"stopReason": "end_turn"}},
    )


def _package(text: str) -> EvidencePackage:
    return EvidencePackage(
        (
            EvidenceSection(
                chunk_id=CHUNK_ID,
                document_id="aws-sde-ii",
                document_type="experience",
                title="Software Development Engineer II",
                section="Role Description",
                url="/experience/aws-sde-ii#role-description",
                text=text,
            ),
        )
    )


def _record(
    document_id: str,
    slug: str,
    document_type: str,
    url: str,
    text: str,
) -> dict[str, str]:
    return {
        "document_id": document_id,
        "slug": slug,
        "document_type": document_type,
        "url": url,
        "text": text,
        "title": document_id,
        "section": slug,
    }


def _write_package(directory: Path, records: list[dict[str, str]]) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    chunks: list[dict[str, str]] = []
    for record in records:
        filename = f"{record['document_id']}--{record['slug']}.txt"
        metadata_name = f"{filename}.metadata.json"
        (directory / filename).write_text(record["text"], encoding="utf-8")
        attributes = {
            "chunkId": f"{record['document_id']}:{record['slug']}:0",
            "documentId": record["document_id"],
            "type": record["document_type"],
            "title": record["title"],
            "section": record["section"],
            "url": record["url"],
        }
        metadata = {
            "metadataAttributes": {
                key: {
                    "value": {"type": "STRING", "stringValue": value},
                    "includeForEmbedding": False,
                }
                for key, value in attributes.items()
            }
        }
        (directory / metadata_name).write_text(json.dumps(metadata), encoding="utf-8")
        chunks.append(
            {
                "chunkId": attributes["chunkId"],
                "documentId": record["document_id"],
                "sourceFilename": filename,
                "metadataFilename": metadata_name,
                "url": record["url"],
                "title": record["title"],
                "section": record["section"],
            }
        )
    manifest = directory / "manifest.json"
    manifest.write_text(json.dumps({"chunks": chunks}), encoding="utf-8")
    return directory, manifest


def _stream_request(question: str = "What is Lucas's current role?") -> dev_server.HttpResult:
    return dev_server.handle_exchange(
        "POST",
        "/ask",
        {"Accept": "application/x-ndjson"},
        _body({"question": question, "mode": "career_question"}),
    )


def _packaged_index_bytes() -> bytes:
    from importlib import resources

    return resources.files("ask_api.data").joinpath("career-index.json").read_bytes()


def _body(payload: dict[str, object]) -> bytes:
    return json.dumps(payload).encode("utf-8")


def _event(question: str) -> dict[str, object]:
    return {
        "requestContext": {"requestId": "request-1", "http": {"method": "POST", "path": "/ask"}},
        "body": json.dumps({"question": question, "mode": "career_question"}),
        "isBase64Encoded": False,
    }


# --- Follow-ups with partial support, refusals, and "no" answers (live run, Oct 14) -----

TECHNOLOGIES = (
    "Primary technologies: Java, Python, TypeScript, mathematical optimization solvers, "
    "AWS CDK, Lambda, Step Functions, ECS, AWS Batch, DynamoDB, S3, and CloudWatch."
)
RELIABILITY_HISTORY = (
    ("user", "How have you improved production reliability?"),
    ("assistant", "Lucas improved production reliability across containerized compute."),
)


def test_follow_up_receives_the_full_evidence_and_the_earlier_turn() -> None:
    """The follow-up refusal was not an evidence-selection problem: local mode sends every
    section, including the technologies line, together with the earlier exchange."""
    package = _package(f"{RELIABILITY}\n\n{TECHNOLOGIES}")
    client = FakeClient(_text_events(f"An answer.\nSOURCES: {CHUNK_ID}"))

    list(
        iter_model_events(
            "What tools did you use for that?",
            RELIABILITY_HISTORY,
            "request-1",
            package=package,
            provider=BedrockProvider(fake(client), NOVA),
        )
    )

    prompt = _prompt(client)
    assert "user: How have you improved production reliability?" in prompt
    assert "Question:\nWhat tools did you use for that?" in prompt
    assert RELIABILITY in prompt
    assert TECHNOLOGIES in prompt


def test_prompt_answers_partial_support_instead_of_refusing() -> None:
    """The cause was the all-or-nothing rule; the prompt now asks for the supported part."""
    assert "If the evidence is not sufficient, use this exact answer" not in LOCAL_SYSTEM_PROMPT
    assert "lead with what they support, then state the\n  gap in one short clause" in (
        LOCAL_SYSTEM_PROMPT
    )
    assert "Cite the sections you used." in LOCAL_SYSTEM_PROMPT
    assert "Do not infer facts the evidence does not state." in LOCAL_SYSTEM_PROMPT
    assert "Refer to Lucas in the third person." in LOCAL_SYSTEM_PROMPT
    assert "Prompt version: local-3" in LOCAL_SYSTEM_PROMPT


def test_partial_answer_with_a_stated_gap_streams_with_citations() -> None:
    package = _package(f"{RELIABILITY}\n\n{TECHNOLOGIES}")
    answer = (
        "The pages don't tie specific tools to the reliability work, but in that role Lucas "
        "worked with ECS, AWS Batch, Step Functions, and CloudWatch."
    )
    client = FakeClient(_text_events(f"{answer}\nSOURCES: {CHUNK_ID}"))

    events = list(
        iter_model_events(
            "What tools did you use for that?",
            RELIABILITY_HISTORY,
            "request-1",
            package=package,
            provider=BedrockProvider(fake(client), NOVA),
        )
    )

    done = events[-1]
    assert done["type"] == "done"
    assert done["answer"] == answer
    assert [item["chunkId"] for item in cast(list[dict[str, str]], done["citations"])] == [CHUNK_ID]


def test_refusal_wording_and_apostrophe_tolerance() -> None:
    assert FALLBACK_ANSWER == (
        "I don't have anything on that in Lucas's career pages. "
        "You can ask about his roles at AWS, what he's worked on, or his education."
    )
    curly = FALLBACK_ANSWER.replace("'", "’")
    parsed = parse_model_output(f"{curly}\nSOURCES: none")
    assert parsed.answer == FALLBACK_ANSWER
    assert parsed.chunk_ids == ()
    with pytest.raises(LocalAnswerRejected):
        parse_model_output("Something else entirely.\nSOURCES: none")


@pytest.mark.parametrize(
    "question", ["What's Lucas's favorite food?", "Tell me about Lumen Harbor."]
)
def test_off_topic_and_fixture_questions_end_with_the_refusal(question: str) -> None:
    client = FakeClient(_text_events(f"{FALLBACK_ANSWER}\nSOURCES: none"))
    events = list(
        iter_model_events(
            question,
            (),
            "request-1",
            package=_package("A public role description."),
            provider=BedrockProvider(fake(client), NOVA),
        )
    )
    assert events[-1]["answer"] == FALLBACK_ANSWER
    assert events[-1]["citations"] == []
    assert "Lumen Harbor" not in _prompt(client).split("Question:")[1].split("Evidence:")[1]
