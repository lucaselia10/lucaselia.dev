"""The production HTTP app for the ask function, run behind the AWS Lambda Web Adapter.

The adapter forwards each function URL request to this standard-library server on
127.0.0.1 and streams the response back. ``POST /api/ask`` answers with the same NDJSON
events as local model mode: the local-4 prompt, the bundled evidence package, the history
window, SOURCES validation, the fixed refusal, and the shared answer style all come from the
modules local mode uses. ``GET /ready`` answers the adapter's readiness check; CloudFront
routes only ``/api/*`` here, so the public cannot reach it.

Production differences from the development server:

- Responses never carry token counts or cost estimates.
- Statuses are 200, 400, 413, 429, and 503 only. CloudFront maps 403 and 404 to the site's
  404 page, so the app never sends them.
- A spend-limit or overload error from the provider pauses this environment for
  PAUSE_SECONDS: requests get 503 "paused" without calling the model.
- The Anthropic key comes from Secrets Manager (see ask_api.secret_key).
- One log line per request: request id, outcome, status, token counts, and latency.
"""

from __future__ import annotations

import os
import re
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import chain
from pathlib import Path
from typing import cast

from ask_api.ask_request import RequestError
from ask_api.local_evidence import EvidencePackage, LocalEvidenceError, load_evidence_package
from ask_api.local_stream import (
    BUSY_MESSAGE,
    PAUSED_MESSAGE,
    UNAVAILABLE_MESSAGE,
    iter_model_events,
)
from ask_api.model_providers import FixtureProvider, ModelProvider, ModelSetupError, anthropic_api
from ask_api.secret_key import ApiKeySource, KeyUnavailable, SecretsClient
from ask_api.stream_http import (
    JSON_CONTENT_TYPE,
    MAX_STREAM_BODY_BYTES,
    NDJSON_CONTENT_TYPE,
    TOO_LARGE_MESSAGE,
    JsonReply,
    StreamReply,
    error_name,
    json_reply,
    observe,
    parse_stream_request,
    token_counts,
    without_development_fields,
    write_chunked,
)

HOST = "127.0.0.1"
DEFAULT_PORT = 8080
ASK_PATH = "/api/ask"
READY_PATH = "/ready"
#: How long one environment skips the model after a spend-limit or overload error.
PAUSE_SECONDS = 300.0
PROVIDER_VARIABLE = "ASK_PROVIDER"
FIXTURE_DELAY_VARIABLE = "ASK_FIXTURE_DELAY_MS"
MAX_FIXTURE_DELAY_MS = 2000
UNSUPPORTED_MESSAGE = "Unsupported request."
MODE_MESSAGE = "mode must be career_question."
PROVIDER_MESSAGE = f"{PROVIDER_VARIABLE} must be anthropic or fixture."
DATA_DIRECTORY = Path(__file__).resolve().parent / "data"
EVIDENCE_DIRECTORY = DATA_DIRECTORY / "evidence"
EVIDENCE_MANIFEST = DATA_DIRECTORY / "evidence-manifest.json"

Log = Callable[[str], None]


def stderr_log(line: str) -> None:
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


class PauseGate:
    """Per-environment pause after a spend-limit or overload error."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._until = 0.0
        self._lock = threading.Lock()

    def pause(self, seconds: float = PAUSE_SECONDS) -> None:
        with self._lock:
            self._until = max(self._until, self._clock() + seconds)

    def paused(self) -> bool:
        with self._lock:
            return self._clock() < self._until


class ProviderSetupFailure(ModelSetupError):
    """The provider could not be built. ``cause`` is an exception class name."""

    def __init__(self, cause: str) -> None:
        super().__init__(UNAVAILABLE_MESSAGE)
        self.cause = cause


class ProviderSource:
    """Builds the configured provider once and reuses it for the life of the environment."""

    def __init__(
        self,
        environ: Mapping[str, str],
        *,
        secrets_client_factory: Callable[[], SecretsClient] | None = None,
        anthropic_client_factory: Callable[..., anthropic_api.MessagesClient] | None = None,
    ) -> None:
        self.name = environ.get(PROVIDER_VARIABLE, "").strip().lower() or anthropic_api.NAME
        if self.name not in {anthropic_api.NAME, FixtureProvider.name}:
            raise ModelSetupError(PROVIDER_MESSAGE)
        self._lock = threading.Lock()
        self._provider: ModelProvider | None = None
        self._client_factory = anthropic_client_factory
        if self.name == FixtureProvider.name:
            self._provider = FixtureProvider(delay_seconds=_fixture_delay(environ) / 1000)
            return
        self._model_id = anthropic_api.configured_model_id(environ)
        self._keys = ApiKeySource(environ, secrets_client_factory=secrets_client_factory)
        self._keys.check()

    def __call__(self) -> ModelProvider:
        with self._lock:
            if self._provider is None:
                key = self._keys.key()
                try:
                    client = anthropic_api.live_client(key, client_factory=self._client_factory)
                except Exception as error:
                    raise ProviderSetupFailure(error_name(error)) from None
                self._provider = anthropic_api.AnthropicProvider(client, self._model_id)
            return self._provider


@dataclass
class ProductionApp:
    """Request handling, independent of sockets so tests can drive it directly."""

    package: EvidencePackage
    provider: Callable[[], ModelProvider]
    log: Log = stderr_log
    clock: Callable[[], float] = time.monotonic
    new_request_id: Callable[[], str] = field(default=lambda: str(uuid.uuid4()))
    gate: PauseGate = field(default_factory=PauseGate)

    def warm(self) -> None:
        """Build the provider at cold start. A failure is logged and retried per request."""
        try:
            self.provider()
        except ModelSetupError as error:
            self._log_setup_error(error)

    def handle(
        self, method: str, path: str, body: bytes, *, oversized: bool = False
    ) -> JsonReply | StreamReply:
        started = self.clock()
        if method == "GET" and path == READY_PATH:
            return JsonReply(200, {"status": "ready"})
        request_id = self.new_request_id()

        def reply(status: int, outcome: str, message: str, code: str | None = None) -> JsonReply:
            self._log_request(request_id, outcome, status, None, started)
            return json_reply(status, message, request_id, code)

        if method != "POST" or path != ASK_PATH:
            return reply(400, "unsupported", UNSUPPORTED_MESSAGE)
        if oversized:
            return reply(413, "too_large", TOO_LARGE_MESSAGE)
        if self.gate.paused():
            return reply(503, "paused", PAUSED_MESSAGE, "paused")
        try:
            ask = parse_stream_request(body)
        except RequestError as error:
            return reply(400, "invalid", str(error))
        if ask.mode != "career_question":
            return reply(400, "invalid", MODE_MESSAGE)
        try:
            provider = self.provider()
            events = iter_model_events(
                ask.question,
                ask.history,
                request_id,
                package=self.package,
                provider=provider,
                on_setup_error=self._log_setup_error,
            )
            first = next(events, None)
        except ModelSetupError as error:
            self._log_setup_error(error)
            return reply(503, "unavailable", UNAVAILABLE_MESSAGE, "unavailable")

        if first is None:
            return reply(503, "unavailable", UNAVAILABLE_MESSAGE, "unavailable")
        if first.get("type") == "error":
            code = first.get("code")
            if code == "paused":
                self.gate.pause()
                return reply(503, "paused", PAUSED_MESSAGE, "paused")
            if code == "busy":
                return reply(429, "busy", BUSY_MESSAGE, "busy")
            if code == "unavailable":
                return reply(503, "unavailable", UNAVAILABLE_MESSAGE, "unavailable")

        def finished(outcome: str, usage: object) -> None:
            if outcome == "error_paused":
                self.gate.pause()
            self._log_request(request_id, outcome, 200, usage, started)

        stream: Iterator[dict[str, object]] = chain([first], events)
        return StreamReply(without_development_fields(observe(stream, finished)))

    def _log_request(
        self, request_id: str, outcome: str, status: int, usage: object, started: float
    ) -> None:
        """The one line per request. Never the question, answer, prompt, history, or body.

        The request id is the random UUID the visitor sees in an error, so a reported
        failure can be matched to its line.
        """
        input_tokens, output_tokens = token_counts(usage)
        latency_ms = max(0, round((self.clock() - started) * 1000))
        self.log(
            f"ask request={safe_request_id(request_id)} outcome={outcome} status={status} "
            f"input_tokens={input_tokens} "
            f"output_tokens={output_tokens} latency_ms={latency_ms}"
        )

    def _log_setup_error(self, error: BaseException) -> None:
        if isinstance(error, KeyUnavailable | ProviderSetupFailure):
            cause = error.cause
        else:
            cause = error_name(error)
        self.log(f"ask setup_error error={cause}")


class ProductionServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], app: ProductionApp) -> None:
        super().__init__(address, ProductionHandler)
        self.app = app


class ProductionHandler(BaseHTTPRequestHandler):
    """Reads one request, hands it to the app, and writes JSON or a chunked NDJSON stream."""

    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> ProductionApp:
        return cast(ProductionServer, self.server).app

    def handle_one_request(self) -> None:
        try:
            self.raw_requestline = self.rfile.readline(65537)
            if not self.raw_requestline:
                self.close_connection = True
                return
            if len(self.raw_requestline) > 65536 or not self.parse_request():
                self.close_connection = True
                # An unparsable line leaves the version at HTTP/0.9, which suppresses headers.
                self.request_version = "HTTP/1.1"
                if not self.wfile.closed:
                    self._send_json(JsonReply(400, {"message": UNSUPPORTED_MESSAGE}))
                return
            self._dispatch()
            self.wfile.flush()
        except TimeoutError:
            self.close_connection = True

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        # parse_request reports problems here; the caller sends the JSON 400 instead.
        del code, message, explain

    def _dispatch(self) -> None:
        path = self.path.split("?", 1)[0]
        raw_length = self.headers.get("Content-Length")
        try:
            length = 0 if raw_length is None else int(raw_length)
        except ValueError:
            length = -1
        oversized = length > MAX_STREAM_BODY_BYTES
        if length < 0:
            self.close_connection = True
            reply = self.app.handle(self.command, path, b"")
        elif oversized:
            self.close_connection = True
            reply = self.app.handle(self.command, path, b"", oversized=True)
        else:
            body = self.rfile.read(length) if length > 0 else b""
            reply = self.app.handle(self.command, path, body)
        if isinstance(reply, StreamReply):
            self._send_stream(reply)
        else:
            self._send_json(reply)

    def _send_json(self, reply: JsonReply) -> None:
        body = reply.body()
        self.send_response_only(reply.status)
        self.send_header("Content-Type", JSON_CONTENT_TYPE)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_stream(self, reply: StreamReply) -> None:
        self.send_response_only(200)
        self.send_header("Content-Type", NDJSON_CONTENT_TYPE)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        if not write_chunked(self.wfile, reply.events):
            self.close_connection = True

    def log_message(self, format: str, *args: object) -> None:
        # The app writes the one line per request; the standard access log stays off.
        del format, args


def create_app(
    environ: Mapping[str, str],
    *,
    package: EvidencePackage | None = None,
    log: Log = stderr_log,
    secrets_client_factory: Callable[[], SecretsClient] | None = None,
    anthropic_client_factory: Callable[..., anthropic_api.MessagesClient] | None = None,
) -> ProductionApp:
    """Build the app from the environment. Raises on configuration that cannot work."""
    provider = ProviderSource(
        environ,
        secrets_client_factory=secrets_client_factory,
        anthropic_client_factory=anthropic_client_factory,
    )
    evidence = package if package is not None else load_bundled_evidence()
    return ProductionApp(package=evidence, provider=provider, log=log)


def load_bundled_evidence() -> EvidencePackage:
    """The evidence package staged next to this module (ask_api/data)."""
    return load_evidence_package(EVIDENCE_DIRECTORY, EVIDENCE_MANIFEST)


_REQUEST_ID = re.compile(r"^[0-9a-f-]{1,64}$")


def safe_request_id(value: str) -> str:
    """The generated request id, or "-" if it is not one (it never comes from the request)."""
    return value if _REQUEST_ID.match(value) else "-"


def listen_port(environ: Mapping[str, str]) -> int:
    """The adapter's port: AWS_LWA_PORT, then PORT, then 8080."""
    for name in ("AWS_LWA_PORT", "PORT"):
        value = environ.get(name, "").strip()
        if value.isdigit() and 0 < int(value) < 65536:
            return int(value)
    return DEFAULT_PORT


def main() -> None:
    """Serve until stopped. Configuration or evidence problems end the process at startup."""
    try:
        app = create_app(os.environ)
    except (ModelSetupError, LocalEvidenceError) as error:
        stderr_log(f"ask setup_error error={error_name(error)}")
        raise SystemExit(2) from None
    app.warm()
    port = listen_port(os.environ)
    server = ProductionServer((HOST, port), app)
    stderr_log(f"ask listening port={port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def _fixture_delay(environ: Mapping[str, str]) -> int:
    value = environ.get(FIXTURE_DELAY_VARIABLE, "").strip()
    if not value.isdigit():
        return 0
    return min(int(value), MAX_FIXTURE_DELAY_MS)


if __name__ == "__main__":
    main()
