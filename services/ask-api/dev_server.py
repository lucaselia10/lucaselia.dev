"""Development-only HTTP adapter for the ask Lambda handler.

This file lives outside the ask_api package so the Lambda asset does not
include it. It binds to loopback, wraps the exact-answer handler, and does not
log questions, answers, citations, or career content. Each POST writes one
stderr line with the request ID, the outcome, and token counts only.

The NDJSON stream path shares its request limits, parsing, framing, and outcome
reporting with the production app through ask_api.stream_http, and its answer
stream through ask_api.local_stream. What stays here is local only: CORS for the
Astro dev server, the deterministic JSON path, the local model-mode switch, and the
token and cost fields the local UI shows.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import uuid
from collections.abc import Iterator, Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast

from ask_api.ask_request import RequestError
from ask_api.handler import handler
from ask_api.local_stream import (
    MODEL_MESSAGE,
    SETUP_MESSAGE,
    LocalModelMode,
    LocalSetupError,
    iter_model_events,
    load_configured_package,
    local_model_mode,
)
from ask_api.model_providers import (
    FixtureProvider,
    ModelProvider,
    check_provider,
    create_provider,
)
from ask_api.stream_http import (
    MAX_STREAM_BODY_BYTES,
    NDJSON_CONTENT_TYPE,
    error_name,
    ndjson_line,
    observe,
    parse_stream_request,
    token_counts,
    write_chunked,
)

HOST = "127.0.0.1"
DEFAULT_PORT = 8787
#: The production app's body limit, for JSON and streaming requests alike.
MAX_BODY_BYTES = MAX_STREAM_BODY_BYTES
ALLOWED_ORIGINS = frozenset({"http://localhost:4321", "http://127.0.0.1:4321"})
ALLOW_METHODS = "POST, OPTIONS"
# The browser sends the body hash that production's CloudFront OAC needs; allow it locally.
ALLOW_HEADERS = "Content-Type, x-amz-content-sha256"
REPO_ROOT = Path(__file__).resolve().parents[2]


class HttpResult:
    """A local HTTP response translated from the Lambda result or a guard."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body


class StreamResult:
    """A local NDJSON response. Each event is one JSON object and a newline."""

    def __init__(
        self, status: int, headers: dict[str, str], events: Iterator[dict[str, object]]
    ) -> None:
        self.status = status
        self.headers = headers
        self.events = events


def handle_exchange(method: str, path: str, headers: Mapping[str, str], body: bytes) -> HttpResult:
    """Handle one local /ask exchange. A stream is collected for callers that want bytes."""
    opened = open_exchange(method, path, headers, body)
    if isinstance(opened, StreamResult):
        return HttpResult(opened.status, opened.headers, b"".join(map(ndjson_line, opened.events)))
    return opened


def open_exchange(
    method: str, path: str, headers: Mapping[str, str], body: bytes
) -> HttpResult | StreamResult:
    """Handle one local /ask exchange, streaming only when the client asks for NDJSON."""
    request_id = str(uuid.uuid4())
    result = _open_exchange(method, path, headers, body, request_id)
    if method == "POST" and isinstance(result, HttpResult):
        _report(request_id, f"http_{result.status}", None)
    return result


def _open_exchange(
    method: str, path: str, headers: Mapping[str, str], body: bytes, request_id: str
) -> HttpResult | StreamResult:
    origin = _header(headers, "origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        return _json_result(403, {"message": "Origin is not allowed.", "requestId": request_id}, {})

    cors = _cors_headers(origin)
    if path != "/ask":
        return _json_result(404, {"message": "Not found.", "requestId": request_id}, cors)
    if method == "OPTIONS":
        options_headers = {
            "Access-Control-Allow-Methods": ALLOW_METHODS,
            "Access-Control-Allow-Headers": ALLOW_HEADERS,
            **cors,
        }
        return HttpResult(204, options_headers, b"")
    if method != "POST":
        return _json_result(
            405,
            {"message": "Only POST is supported.", "requestId": request_id},
            {"Allow": ALLOW_METHODS, **cors},
        )
    if len(body) > MAX_BODY_BYTES:
        return _json_result(
            413,
            {"message": "Request body is too large.", "requestId": request_id},
            cors,
        )
    if not _wants_stream(headers):
        return _json_exchange(body, request_id, cors)
    return _stream_exchange(body, request_id, cors)


class AskDevHandler(BaseHTTPRequestHandler):
    """Loopback handler. Logs the method, path, and status only."""

    protocol_version = "HTTP/1.1"

    def handle_one_request(self) -> None:
        try:
            self.raw_requestline = self.rfile.readline(65537)
            if len(self.raw_requestline) > 65536:
                self.requestline = ""
                self.request_version = ""
                self.command = ""
                self.send_error(414)
                return
            if not self.raw_requestline:
                self.close_connection = True
                return
            if not self.parse_request():
                return
            self._dispatch(self.command)
            self.wfile.flush()
        except TimeoutError:
            self.close_connection = True

    def _dispatch(self, method: str) -> None:
        body = self._read_body()
        if body is None:
            return
        result = open_exchange(method, self.path.split("?", 1)[0], dict(self.headers.items()), body)
        if isinstance(result, StreamResult):
            self._send_stream(result)
            return
        self._send(result)

    def _read_body(self) -> bytes | None:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return b""
        try:
            length = int(raw_length)
        except ValueError:
            self._send(
                _json_result(
                    400, {"message": "Request body is invalid.", "requestId": str(uuid.uuid4())}, {}
                )
            )
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            path = self.path.split("?", 1)[0]
            self.close_connection = True
            self._send(
                handle_exchange(
                    self.command, path, dict(self.headers.items()), b"x" * (MAX_BODY_BYTES + 1)
                )
            )
            return None
        return self.rfile.read(length)

    def _send(self, result: HttpResult) -> None:
        self.send_response(result.status)
        for name, value in result.headers.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(result.body)))
        self.end_headers()
        self.wfile.write(result.body)

    def _send_stream(self, result: StreamResult) -> None:
        self.send_response(result.status)
        for name, value in result.headers.items():
            self.send_header(name, value)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        if not write_chunked(self.wfile, result.events):
            self.close_connection = True

    def log_message(self, format: str, *args: object) -> None:
        status = args[1] if len(args) > 1 else ""
        sys.stderr.write(f"{self.command} {self.path.split('?', 1)[0]} {status}\n")


def main() -> None:
    """Serve POST /ask on loopback until Ctrl-C."""
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    if local_model_mode() is LocalModelMode.LIVE:
        try:
            check_provider(os.environ)
        except LocalSetupError as error:
            sys.stderr.write(f"{error.public_message}\n")
            raise SystemExit(2) from None
    server = ThreadingHTTPServer((HOST, port), AskDevHandler)
    sys.stderr.write(f"Ask development server listening on http://{HOST}:{port}/ask\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("Ask development server stopped.\n")
    finally:
        server.server_close()


def _api_gateway_event(body: bytes, request_id: str) -> dict[str, object]:
    text = body.decode("utf-8")
    return {
        "version": "2.0",
        "routeKey": "POST /ask",
        "rawPath": "/ask",
        "rawQueryString": "",
        "headers": {"content-type": "application/json"},
        "requestContext": {
            "requestId": request_id,
            "http": {"method": "POST", "path": "/ask"},
        },
        "body": text,
        "isBase64Encoded": False,
    }


def stream_events(
    question: str,
    history: tuple[tuple[str, str], ...],
    request_id: str,
) -> Iterator[dict[str, object]]:
    """Open the configured local model stream. Tests replace this function.

    Setup failures are raised before the first event so the HTTP adapter can
    return one JSON error instead of a partial stream.
    """
    mode = local_model_mode()
    if mode is LocalModelMode.OFF:
        raise LocalSetupError(SETUP_MESSAGE)
    if mode is LocalModelMode.LIVE:
        # Credentials and model id first, so a missing key is reported before evidence loads.
        check_provider(os.environ)
    package = load_configured_package(REPO_ROOT)
    provider: ModelProvider
    if mode is LocalModelMode.FIXTURE:
        provider = FixtureProvider()
    else:
        try:
            provider = create_provider(os.environ)
        except LocalSetupError:
            raise
        except Exception as error:
            _report_setup_error(request_id, error)
            raise LocalSetupError(MODEL_MESSAGE) from None
    return iter_model_events(
        question,
        history,
        request_id,
        package=package,
        provider=provider,
        input_usd_per_million=_optional_env("ASK_INPUT_USD_PER_MILLION"),
        output_usd_per_million=_optional_env("ASK_OUTPUT_USD_PER_MILLION"),
        on_setup_error=lambda error: _report_setup_error(request_id, error),
    )


def _json_exchange(body: bytes, request_id: str, cors: dict[str, str]) -> HttpResult:
    event = _api_gateway_event(body, request_id)
    try:
        result = handler(event, None)
    except Exception:
        return _json_result(
            500,
            {"message": "The career assistant is unavailable.", "requestId": request_id},
            cors,
        )

    status = result.get("statusCode")
    raw_body = result.get("body")
    if not isinstance(status, int) or not isinstance(raw_body, str):
        return _json_result(
            500,
            {"message": "The career assistant is unavailable.", "requestId": request_id},
            cors,
        )
    headers = _string_headers(result.get("headers"))
    headers.update(cors)
    return HttpResult(status, headers, raw_body.encode("utf-8"))


def _stream_exchange(
    body: bytes, request_id: str, cors: dict[str, str]
) -> HttpResult | StreamResult:
    try:
        ask = parse_stream_request(body)
    except RequestError as error:
        return _json_result(400, {"message": str(error), "requestId": request_id}, cors)
    if ask.mode != "career_question":
        return _json_exchange(body, request_id, cors)
    if local_model_mode() is LocalModelMode.OFF:
        return _json_result(503, {"message": SETUP_MESSAGE, "requestId": request_id}, cors)
    try:
        events = stream_events(ask.question, ask.history, request_id)
    except LocalSetupError as error:
        return _json_result(503, {"message": error.public_message, "requestId": request_id}, cors)
    headers = {
        "Content-Type": NDJSON_CONTENT_TYPE,
        "Cache-Control": "no-store",
        **cors,
    }
    observed = observe(events, lambda outcome, usage: _report(request_id, outcome, usage))
    return StreamResult(200, headers, observed)


def _report(request_id: str, outcome: str, usage: object) -> None:
    """One stderr line per request. Never the question, answer, prompt, or evidence."""
    input_tokens, output_tokens = token_counts(usage)
    sys.stderr.write(
        f"ask request={request_id} outcome={outcome} "
        f"input_tokens={input_tokens} output_tokens={output_tokens}\n"
    )


def _report_setup_error(request_id: str, error: BaseException) -> None:
    """One stderr line naming the exception class only. Never its message or credentials.

    With LOCAL_DEBUG_TRACEBACK=1, the stack follows: file, line, function, and source line for
    each frame, and the class of each chained exception. Exception messages, local variables,
    and argument values are never printed, so the key, question, and evidence cannot appear.
    """
    safe = error_name(error)
    sys.stderr.write(f"ask setup_error request={request_id} error={safe}\n")
    if os.environ.get("LOCAL_DEBUG_TRACEBACK", "").strip() == "1":
        for line in safe_traceback(error):
            sys.stderr.write(f"ask setup_traceback request={request_id} {line}\n")


def safe_traceback(error: BaseException) -> list[str]:
    """Frames and exception classes only, oldest cause first. No messages or values."""
    chain: list[BaseException] = []
    current: BaseException | None = error
    while current is not None and all(current is not seen for seen in chain):
        chain.append(current)
        current = current.__cause__ or (
            None if current.__suppress_context__ else current.__context__
        )
    lines: list[str] = []
    for item in reversed(chain):
        kind = type(item)
        lines.append(f"exception {kind.__module__}.{kind.__qualname__} (message withheld)")
        for frame in traceback.extract_tb(item.__traceback__):
            lines.append(f'File "{frame.filename}", line {frame.lineno}, in {frame.name}')
            if frame.line:
                lines.append(f"    {frame.line.strip()}")
    return lines


def _wants_stream(headers: Mapping[str, str]) -> bool:
    accept = _header(headers, "accept")
    if accept is None:
        return False
    return "application/x-ndjson" in accept.lower()


def _optional_env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def _json_result(status: int, payload: dict[str, str], extra_headers: dict[str, str]) -> HttpResult:
    headers = {"Content-Type": "application/json", **extra_headers}
    return HttpResult(status, headers, json.dumps(payload).encode("utf-8"))


def _cors_headers(origin: str | None) -> dict[str, str]:
    if origin is None or origin not in ALLOWED_ORIGINS:
        return {}
    return {"Access-Control-Allow-Origin": origin}


def _string_headers(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {"Content-Type": "application/json"}
    headers: dict[str, str] = {}
    raw = cast(dict[object, object], value)
    for key, item in raw.items():
        if isinstance(key, str) and isinstance(item, str):
            headers[key] = item
    return headers


def _header(headers: Mapping[str, str], name: str) -> str | None:
    folded = {key.lower(): value for key, value in headers.items()}
    value = folded.get(name.lower())
    if not isinstance(value, str) or value == "":
        return None
    return value


if __name__ == "__main__":
    main()
