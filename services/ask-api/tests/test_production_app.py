"""The production app: streaming over a real socket, statuses, limits, pausing, and logs.

Providers are fakes or the in-process fixture. No network beyond loopback, no model calls.
"""

from __future__ import annotations

import json
import socket
import threading
from collections.abc import Callable, Iterator

import pytest

from ask_api import production_app
from ask_api.local_conversation import TokenUsage
from ask_api.local_evidence import EvidencePackage, EvidenceSection
from ask_api.local_stream import PAUSED_MESSAGE
from ask_api.model_providers import (
    FixtureProvider,
    ModelBusy,
    ModelEvent,
    ModelPaused,
    ModelProvider,
    ModelRequest,
    ModelSetupError,
    StreamStop,
    TextDelta,
    UsageReport,
)
from ask_api.production_app import (
    ASK_PATH,
    PAUSE_SECONDS,
    READY_PATH,
    PauseGate,
    ProductionApp,
    ProductionServer,
)
from ask_api.secret_key import KeyUnavailable
from ask_api.stream_http import JsonReply, StreamReply

CHUNK_ID = "aws-sde-ii:role-description:0"
QUESTION = "Which distinctive-question-marker work improved reliability?"
ANSWER = "Lucas improved distinctive-answer-marker reliability."
HISTORY_TEXT = "distinctive-history-marker"
REQUEST_ID = "00000000-0000-4000-8000-00000000000a"
ALLOWED_STATUSES = {200, 400, 413, 429, 503}


def evidence() -> EvidencePackage:
    return EvidencePackage(
        (
            EvidenceSection(
                chunk_id=CHUNK_ID,
                document_id="aws-sde-ii",
                document_type="experience",
                title="Software Development Engineer II",
                section="Role Description",
                url="/experience/aws-sde-ii#role-description",
                text="Improved production reliability across containerized compute.",
            ),
        )
    )


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class ScriptedProvider:
    """Records each request and replays a script. A script may raise to fail at open."""

    name = "scripted"
    fixture = False

    def __init__(self, script: Callable[[ModelRequest], Iterator[ModelEvent]]) -> None:
        self.script = script
        self.requests: list[ModelRequest] = []

    def open_stream(self, request: ModelRequest) -> Iterator[ModelEvent]:
        self.requests.append(request)
        return self.script(request)


def answer_script(_: ModelRequest) -> Iterator[ModelEvent]:
    return iter(
        [
            TextDelta("Lucas improved "),
            TextDelta("distinctive-answer-marker reliability.\nSOURCES: "),
            TextDelta(CHUNK_ID),
            StreamStop(),
            UsageReport(TokenUsage(120, 30)),
        ]
    )


def raising(error: Exception) -> Callable[[ModelRequest], Iterator[ModelEvent]]:
    def script(_: ModelRequest) -> Iterator[ModelEvent]:
        raise error

    return script


def make_app(
    provider: ScriptedProvider | Callable[[], ModelProvider],
    clock: Clock | None = None,
    lines: list[str] | None = None,
) -> ProductionApp:
    tick = clock or Clock()
    collected: list[str] = lines if lines is not None else []
    source: Callable[[], ModelProvider]
    if isinstance(provider, ScriptedProvider):
        fixed = provider

        def source() -> ModelProvider:
            return fixed

    else:
        source = provider

    return ProductionApp(
        package=evidence(),
        provider=source,
        log=collected.append,
        clock=tick,
        new_request_id=lambda: REQUEST_ID,
        gate=PauseGate(tick),
    )


def ask_body(question: str = QUESTION, **extra: object) -> bytes:
    payload: dict[str, object] = {"question": question, "mode": "career_question", **extra}
    return json.dumps(payload).encode()


def drain(reply: JsonReply | StreamReply) -> list[dict[str, object]]:
    assert isinstance(reply, StreamReply)
    return list(reply.events)


# --- statuses ------------------------------------------------------------------------------


def test_answer_streams_the_existing_contract_without_development_fields() -> None:
    events = drain(make_app(ScriptedProvider(answer_script)).handle("POST", ASK_PATH, ask_body()))

    assert events[0] == {"type": "delta", "text": "Lucas improved"}
    done = events[-1]
    assert done["type"] == "done"
    assert done["answer"] == ANSWER
    assert done["requestId"] == REQUEST_ID
    assert done["fixture"] is False
    assert done["citations"] == [
        {
            "chunkId": CHUNK_ID,
            "documentId": "aws-sde-ii",
            "title": "Software Development Engineer II",
            "section": "Role Description",
            "url": "/experience/aws-sde-ii#role-description",
        }
    ]
    for event in events:
        assert "usage" not in event
        assert "estimatedCostUsd" not in event


def test_readiness_path_answers_ok() -> None:
    reply = make_app(ScriptedProvider(answer_script)).handle("GET", READY_PATH, b"")

    assert reply == JsonReply(200, {"status": "ready"})


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", ASK_PATH),
        ("PUT", ASK_PATH),
        ("OPTIONS", ASK_PATH),
        ("POST", "/ask"),
        ("POST", "/api/other"),
        ("GET", "/"),
        ("POST", READY_PATH),
    ],
)
def test_other_routes_are_400_never_403_404_or_405(method: str, path: str) -> None:
    reply = make_app(ScriptedProvider(answer_script)).handle(method, path, ask_body())

    assert isinstance(reply, JsonReply)
    assert reply.status == 400
    assert reply.payload["message"] == "Unsupported request."


@pytest.mark.parametrize(
    ("body", "message"),
    [
        (b"not json", "Request body is invalid."),
        (b"[]", "Request body is invalid."),
        (b"\xff", "Request body is invalid."),
        (ask_body(""), "question is required."),
        (ask_body("x" * 501), "question is too long."),
        (json.dumps({"question": QUESTION, "mode": "job_comparison"}).encode(), None),
        (ask_body(extra="field"), "Request contains unsupported fields: extra."),
        (ask_body(history="nope"), "history must be an array."),
    ],
)
def test_invalid_requests_are_400_and_never_call_the_model(
    body: bytes, message: str | None
) -> None:
    provider = ScriptedProvider(answer_script)
    reply = make_app(provider).handle("POST", ASK_PATH, body)

    assert isinstance(reply, JsonReply)
    assert reply.status == 400
    if message is not None:
        assert reply.payload["message"] == message
    assert provider.requests == []


def test_a_500_character_question_is_accepted() -> None:
    provider = ScriptedProvider(answer_script)
    events = drain(make_app(provider).handle("POST", ASK_PATH, ask_body("x" * 500)))

    assert events[-1]["type"] == "done"
    assert len(provider.requests) == 1


def test_oversized_body_is_413() -> None:
    reply = make_app(ScriptedProvider(answer_script)).handle("POST", ASK_PATH, b"", oversized=True)

    assert isinstance(reply, JsonReply)
    assert reply.status == 413


def test_history_is_trimmed_to_12000_characters_newest_kept() -> None:
    provider = ScriptedProvider(answer_script)
    old = [
        {"role": "user", "content": "oldest-exchange " + "o" * 4000},
        {"role": "assistant", "content": "a" * 4000},
    ]
    recent = [
        {"role": "user", "content": "newest-exchange " + "n" * 1000},
        {"role": "assistant", "content": "b" * 1000},
    ]
    middle = [{"role": "user", "content": "m" * 2000}, {"role": "assistant", "content": "c" * 2000}]
    body = ask_body(history=old + middle + recent)

    drain(make_app(provider).handle("POST", ASK_PATH, body))

    sent = provider.requests[0].user_text
    assert "newest-exchange" in sent
    assert "oldest-exchange" not in sent


def test_max_tokens_and_prompt_match_local_mode() -> None:
    provider = ScriptedProvider(answer_script)
    drain(make_app(provider).handle("POST", ASK_PATH, ask_body()))

    request = provider.requests[0]
    assert request.max_tokens == 500
    assert request.system.startswith("Prompt version: local-4")


def test_setup_failure_is_503_and_logs_only_the_class_name() -> None:
    lines: list[str] = []

    def broken() -> ModelProvider:
        raise KeyUnavailable("ResourceNotFoundException")

    reply = make_app(broken, lines=lines).handle("POST", ASK_PATH, ask_body())

    assert isinstance(reply, JsonReply)
    assert (reply.status, reply.payload["code"]) == (503, "unavailable")
    assert "ask setup_error error=ResourceNotFoundException" in lines
    assert not any("ANTHROPIC" in line or "secret" in line.lower() for line in lines)


def test_a_failure_opening_the_model_stream_is_503() -> None:
    reply = make_app(ScriptedProvider(raising(RuntimeError("boom")))).handle(
        "POST", ASK_PATH, ask_body()
    )

    assert isinstance(reply, JsonReply)
    assert (reply.status, reply.payload["code"]) == (503, "unavailable")


def test_rate_limit_is_429_and_does_not_pause() -> None:
    provider = ScriptedProvider(raising(ModelBusy()))
    app = make_app(provider)

    first = app.handle("POST", ASK_PATH, ask_body())
    second = app.handle("POST", ASK_PATH, ask_body())

    assert isinstance(first, JsonReply)
    assert (first.status, first.payload["code"]) == (429, "busy")
    assert isinstance(second, JsonReply) and second.status == 429
    assert len(provider.requests) == 2


# --- pausing -------------------------------------------------------------------------------


def test_spend_limit_or_overload_pauses_the_environment() -> None:
    clock = Clock()
    provider = ScriptedProvider(raising(ModelPaused()))
    app = make_app(provider, clock)

    first = app.handle("POST", ASK_PATH, ask_body())
    assert isinstance(first, JsonReply)
    assert first.status == 503
    assert first.payload == {"message": PAUSED_MESSAGE, "requestId": REQUEST_ID, "code": "paused"}

    provider.script = answer_script
    clock.now += PAUSE_SECONDS - 1
    second = app.handle("POST", ASK_PATH, ask_body())
    assert isinstance(second, JsonReply) and second.payload["code"] == "paused"
    assert len(provider.requests) == 1  # the model is skipped while paused

    clock.now += 2
    assert drain(app.handle("POST", ASK_PATH, ask_body()))[-1]["type"] == "done"
    assert len(provider.requests) == 2


def test_a_pause_mid_stream_ends_the_stream_and_pauses_later_requests() -> None:
    def script(_: ModelRequest) -> Iterator[ModelEvent]:
        yield TextDelta("Lucas improved ")
        yield TextDelta("more text ")
        raise ModelPaused()

    provider = ScriptedProvider(script)
    app = make_app(provider)

    events = drain(app.handle("POST", ASK_PATH, ask_body()))
    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "paused"

    later = app.handle("POST", ASK_PATH, ask_body())
    assert isinstance(later, JsonReply) and later.payload["code"] == "paused"
    assert len(provider.requests) == 1


def test_every_reply_uses_an_allowed_status() -> None:
    cases: list[tuple[ScriptedProvider, str, str, bytes, bool]] = [
        (ScriptedProvider(answer_script), "POST", ASK_PATH, ask_body(), False),
        (ScriptedProvider(answer_script), "GET", "/missing", b"", False),
        (ScriptedProvider(answer_script), "POST", ASK_PATH, b"{", False),
        (ScriptedProvider(answer_script), "POST", ASK_PATH, b"", True),
        (ScriptedProvider(raising(ModelBusy())), "POST", ASK_PATH, ask_body(), False),
        (ScriptedProvider(raising(ModelPaused())), "POST", ASK_PATH, ask_body(), False),
        (ScriptedProvider(raising(RuntimeError())), "POST", ASK_PATH, ask_body(), False),
    ]
    for provider, method, path, body, oversized in cases:
        reply = make_app(provider).handle(method, path, body, oversized=oversized)
        status = reply.status if isinstance(reply, JsonReply) else 200
        assert status in ALLOWED_STATUSES


# --- logging -------------------------------------------------------------------------------


def test_one_log_line_per_request_with_no_question_answer_or_history() -> None:
    lines: list[str] = []
    clock = Clock()

    def script(request: ModelRequest) -> Iterator[ModelEvent]:
        clock.now += 0.25
        return answer_script(request)

    app = make_app(ScriptedProvider(script), clock, lines)
    history = [
        {"role": "user", "content": f"Earlier {HISTORY_TEXT} question"},
        {"role": "assistant", "content": f"Earlier {HISTORY_TEXT} answer"},
    ]
    drain(app.handle("POST", ASK_PATH, ask_body(history=history)))
    app.handle("POST", ASK_PATH, b'{"question": "distinctive-invalid-marker"}')

    assert lines == [
        f"ask request={REQUEST_ID} outcome=done status=200 input_tokens=120 "
        "output_tokens=30 latency_ms=250",
        f"ask request={REQUEST_ID} outcome=invalid status=400 input_tokens=- "
        "output_tokens=- latency_ms=0",
    ]
    joined = "\n".join(lines)
    for marker in ("distinctive", "Lucas", "SOURCES", CHUNK_ID):
        assert marker not in joined


# --- real socket -----------------------------------------------------------------------------


class Server:
    """The production server on an ephemeral loopback port, in a background thread."""

    def __init__(self, app: ProductionApp) -> None:
        self.server = ProductionServer(("127.0.0.1", 0), app)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> Server:
        self.thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self.server.shutdown()
        self.server.server_close()

    def connect(self) -> socket.socket:
        connection = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        return connection


def raw_request(method: str, path: str, body: bytes, extra: str = "") -> bytes:
    return (
        f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
        f"Accept: application/x-ndjson\r\nContent-Length: {len(body)}\r\n{extra}\r\n"
    ).encode() + body


def read_until(connection: socket.socket, marker: bytes, buffer: bytes = b"") -> bytes:
    while marker not in buffer:
        chunk = connection.recv(4096)
        if chunk == b"":
            break
        buffer += chunk
    return buffer


def dechunk(raw: bytes) -> bytes:
    head, _, rest = raw.partition(b"\r\n\r\n")
    assert b"transfer-encoding: chunked" in head.lower()
    body = b""
    while True:
        size_line, _, rest = rest.partition(b"\r\n")
        size = int(size_line, 16)
        if size == 0:
            return body
        body += rest[:size]
        rest = rest[size + 2 :]


def test_chunks_reach_the_client_before_the_model_finishes(
    capsys: pytest.CaptureFixture[str],
) -> None:
    release = threading.Event()

    def gated(_: ModelRequest) -> Iterator[ModelEvent]:
        yield TextDelta("Lucas improved ")
        # The rest of the answer waits until the client has seen the first line.
        assert release.wait(5), "the first delta never reached the client"
        yield TextDelta("distinctive-answer-marker reliability.\nSOURCES: ")
        yield TextDelta(CHUNK_ID)
        yield StreamStop()
        yield UsageReport(TokenUsage(120, 30))

    lines: list[str] = []
    with Server(make_app(ScriptedProvider(gated), lines=lines)) as server:
        connection = server.connect()
        connection.sendall(raw_request("POST", ASK_PATH, ask_body()))

        early = read_until(connection, b'"type":"delta"')
        assert b'"type":"delta"' in early
        assert not release.is_set()
        assert b'"type":"done"' not in early

        release.set()
        raw = read_until(connection, b"0\r\n\r\n", early)
        connection.close()

    head = raw.split(b"\r\n\r\n", 1)[0].lower()
    assert head.startswith(b"http/1.1 200")
    assert b"content-type: application/x-ndjson; charset=utf-8" in head
    assert b"cache-control: no-store" in head
    events = [json.loads(line) for line in dechunk(raw).decode().splitlines()]
    assert [event["type"] for event in events] == ["delta", "delta", "done"]
    assert "usage" not in events[-1]
    assert lines == [
        f"ask request={REQUEST_ID} outcome=done status=200 input_tokens=120 "
        "output_tokens=30 latency_ms=0"
    ]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "distinctive" not in captured.err


def test_socket_statuses_for_readiness_bad_routes_and_oversized_bodies() -> None:
    with Server(make_app(ScriptedProvider(answer_script))) as server:
        connection = server.connect()
        connection.sendall(raw_request("GET", READY_PATH, b""))
        ready = read_until(connection, b'"ready"}')
        assert ready.startswith(b"HTTP/1.1 200")
        connection.close()

        connection = server.connect()
        connection.sendall(raw_request("DELETE", "/nowhere", b""))
        assert read_until(connection, b"}").startswith(b"HTTP/1.1 400")
        connection.close()

        connection = server.connect()
        too_big = b"x" * (16 * 1024 + 1)
        connection.sendall(raw_request("POST", ASK_PATH, too_big))
        reply = read_until(connection, b"}")
        assert reply.startswith(b"HTTP/1.1 413")
        connection.close()

        connection = server.connect()
        connection.sendall(b"NOT A REQUEST LINE\r\n\r\n")
        assert read_until(connection, b"}").startswith(b"HTTP/1.1 400")
        connection.close()


def test_client_disconnect_closes_the_model_stream_and_logs_once() -> None:
    closed = threading.Event()
    sent_first = threading.Event()

    def endless(_: ModelRequest) -> Iterator[ModelEvent]:
        try:
            while True:
                yield TextDelta("Lucas improved reliability. ")
                sent_first.set()
        finally:
            closed.set()

    lines: list[str] = []
    with Server(make_app(ScriptedProvider(endless), lines=lines)) as server:
        connection = server.connect()
        connection.sendall(raw_request("POST", ASK_PATH, ask_body()))
        read_until(connection, b'"type":"delta"')
        connection.close()
        assert closed.wait(5)

    assert len(lines) == 1
    assert lines[0].startswith(f"ask request={REQUEST_ID} outcome=")


# --- the local command -------------------------------------------------------------------------


def test_create_app_uses_the_fixture_provider_when_asked() -> None:
    app = production_app.create_app(
        {"ASK_PROVIDER": "fixture", "ASK_FIXTURE_DELAY_MS": "0"}, package=evidence()
    )

    events = drain(app.handle("POST", ASK_PATH, ask_body("What is the current role?")))
    assert events[-1]["type"] == "done"
    assert events[-1]["fixture"] is True
    assert isinstance(app.provider(), FixtureProvider)


def test_unknown_provider_or_missing_key_fails_at_startup() -> None:
    with pytest.raises(ModelSetupError):
        production_app.create_app({"ASK_PROVIDER": "other"}, package=evidence())
    with pytest.raises(ModelSetupError):
        production_app.create_app({"ASK_PROVIDER": "anthropic"}, package=evidence())
    with pytest.raises(ModelSetupError):
        # In Lambda the key may not come from an environment variable.
        production_app.create_app(
            {"AWS_LAMBDA_FUNCTION_NAME": "ask", "ANTHROPIC_API_KEY": "not-used"},
            package=evidence(),
        )


def test_listen_port_prefers_the_adapter_setting() -> None:
    assert production_app.listen_port({}) == 8080
    assert production_app.listen_port({"PORT": "9000"}) == 9000
    assert production_app.listen_port({"AWS_LWA_PORT": "9001", "PORT": "9000"}) == 9001
    assert production_app.listen_port({"PORT": "nope"}) == 8080


def test_the_logged_request_id_is_only_ever_the_generated_one() -> None:
    assert production_app.safe_request_id(REQUEST_ID) == REQUEST_ID
    assert production_app.safe_request_id("injected outcome=done") == "-"
