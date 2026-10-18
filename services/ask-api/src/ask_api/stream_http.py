"""HTTP pieces shared by the development server and the production app.

Both serve the NDJSON answer stream from a standard-library HTTP server. This module holds
what they have in common: the stream request limits and parsing, JSON error replies, NDJSON
framing, chunked writing, removal of development-only fields, and the per-request outcome
each server logs. Nothing here logs or returns a question, answer, prompt, or body.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Protocol, cast

from ask_api.ask_request import RequestError, string_key_dict, validated_ask_request

NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8"
JSON_CONTENT_TYPE = "application/json"
MAX_STREAM_BODY_BYTES = 16 * 1024
MAX_QUESTION_CHARS = 500
INVALID_BODY_MESSAGE = "Request body is invalid."
TOO_LARGE_MESSAGE = "Request body is too large."
QUESTION_TOO_LONG_MESSAGE = "question is too long."
#: Fields the local server shows for cost checks. Production responses never carry them.
DEVELOPMENT_FIELDS = frozenset({"usage", "estimatedCostUsd"})
_OUTCOME_CODE = re.compile(r"^[a-z_]{1,32}$")
_ERROR_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,80}$")


@dataclass(frozen=True)
class AskStreamRequest:
    """A validated streaming ask."""

    question: str
    mode: str
    history: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class JsonReply:
    """A JSON response sent instead of a stream: errors, and the readiness check."""

    status: int
    payload: dict[str, str]

    def body(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


@dataclass(frozen=True)
class StreamReply:
    """A 200 NDJSON response. Each event becomes one line."""

    events: Iterator[dict[str, object]]


def json_reply(status: int, message: str, request_id: str, code: str | None = None) -> JsonReply:
    payload = {"message": message, "requestId": request_id}
    if code is not None:
        payload["code"] = code
    return JsonReply(status, payload)


def parse_stream_request(body: bytes) -> AskStreamRequest:
    """Decode and validate a streaming ask body. Raises RequestError with a public message."""
    try:
        decoded: object = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RequestError(INVALID_BODY_MESSAGE) from None
    payload = string_key_dict(decoded)
    if payload is None:
        raise RequestError(INVALID_BODY_MESSAGE)
    question, mode, history = validated_ask_request(payload)
    if len(question) > MAX_QUESTION_CHARS:
        raise RequestError(QUESTION_TOO_LONG_MESSAGE)
    return AskStreamRequest(question, mode, history)


def without_development_fields(
    events: Iterator[dict[str, object]],
) -> Iterator[dict[str, object]]:
    """Drop token counts and cost estimates from every event."""
    try:
        for event in events:
            yield {key: value for key, value in event.items() if key not in DEVELOPMENT_FIELDS}
    finally:
        close_iterator(events)


def ndjson_line(event: dict[str, object]) -> bytes:
    return (json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8")


def observe(
    events: Iterator[dict[str, object]], on_finish: Callable[[str, object], None]
) -> Iterator[dict[str, object]]:
    """Pass events through, then report the outcome and usage once the stream ends or closes.

    The outcome is "done", "error_<code>", or "disconnected" when the stream is closed early.
    """
    outcome = "disconnected"
    usage: object = None
    try:
        for event in events:
            kind = event.get("type")
            if kind == "done":
                outcome = "done"
                usage = event.get("usage")
            elif kind == "error":
                outcome = f"error_{safe_code(event.get('code'))}"
                usage = event.get("usage")
            yield event
    finally:
        close_iterator(events)
        on_finish(outcome, usage)


def safe_code(value: object) -> str:
    """An event code that is safe to put in a log line."""
    return value if isinstance(value, str) and _OUTCOME_CODE.match(value) else "unknown"


def error_name(error: BaseException) -> str:
    """An exception's class name, safe to log. Never its message."""
    name = type(error).__name__
    return name if _ERROR_NAME.match(name) else "UnknownError"


def token_counts(usage: object) -> tuple[str, str]:
    """Input and output token counts from a usage payload, or "-" when absent."""
    if not isinstance(usage, dict):
        return "-", "-"
    counts = cast(dict[str, object], usage)
    incoming = counts.get("inputTokens")
    outgoing = counts.get("outputTokens")
    if type(incoming) is not int or type(outgoing) is not int:
        return "-", "-"
    return str(incoming), str(outgoing)


class Writable(Protocol):
    def write(self, data: bytes, /) -> object: ...

    def flush(self) -> None: ...


def write_chunked(wfile: Writable, events: Iterator[dict[str, object]]) -> bool:
    """Write events as HTTP/1.1 chunks, flushing after each line.

    Returns False if the client went away. The event iterator is always closed, so the
    model stream stops and the outcome is reported.
    """
    try:
        for event in events:
            line = ndjson_line(event)
            wfile.write(f"{len(line):X}\r\n".encode("ascii"))
            wfile.write(line)
            wfile.write(b"\r\n")
            wfile.flush()
        wfile.write(b"0\r\n\r\n")
        wfile.flush()
        return True
    except (BrokenPipeError, ConnectionResetError):
        return False
    finally:
        close_iterator(events)


def close_iterator(iterator: object) -> None:
    """Close a generator so the model stream behind it stops now, not at garbage collection."""
    close = getattr(iterator, "close", None)
    if callable(close):
        close()
