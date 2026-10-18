"""Providers driven through the REAL client libraries, with the network replaced.

Fake clients accept any call shape, which once hid a TypeError the real Anthropic SDK raises.
These tests build the real anthropic.Anthropic (with an httpx2 MockTransport serving a recorded
Server-Sent Events stream) and a real boto3 bedrock-runtime client (with a before-send hook
serving a binary event stream), so the libraries validate our arguments and parse the stream
exactly as they would against the live services. No network, no real credentials.
"""

from __future__ import annotations

import json
import struct
import zlib
from collections.abc import Iterator, Mapping, Sequence
from typing import Any, cast

import anthropic
import boto3
import httpx2
import pytest
from botocore.awsrequest import AWSResponse

import dev_server
from ask_api.local_conversation import LOCAL_SYSTEM_PROMPT
from ask_api.local_evidence import EvidencePackage, EvidenceSection
from ask_api.local_stream import UNAVAILABLE_MESSAGE, iter_model_events
from ask_api.model_providers import ModelProvider
from ask_api.model_providers import anthropic_api as anthropic_provider
from ask_api.model_providers import bedrock as bedrock_provider

CHUNK_ID = "aws-sde-ii:role-description:0"
# Assembled at runtime so the repository holds no key-shaped literal.
DUMMY_KEY = "-".join(["sk", "ant", "dummy", "0000", "not", "a", "real", "key"])
QUESTION = "How did you improve production reliability?"
ANSWER_CHUNKS = ("Lucas improved ", "production reliability.\nSOUR", f"CES: {CHUNK_ID}")


def package() -> EvidencePackage:
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


def run(
    provider: ModelProvider, errors: list[BaseException] | None = None
) -> list[dict[str, object]]:
    return list(
        iter_model_events(
            QUESTION,
            (),
            "request-1",
            package=package(),
            provider=provider,
            input_usd_per_million="1",
            output_usd_per_million="5",
            on_setup_error=None if errors is None else errors.append,
        )
    )


EXPECTED_EVENTS: list[dict[str, object]] = [
    {"type": "delta", "text": "Lucas improved"},
    {"type": "delta", "text": " production reliability."},
    {
        "type": "done",
        "answer": "Lucas improved production reliability.",
        "citations": [
            {
                "chunkId": CHUNK_ID,
                "documentId": "aws-sde-ii",
                "title": "Software Development Engineer II",
                "section": "Role Description",
                "url": "/experience/aws-sde-ii#role-description",
            }
        ],
        "requestId": "request-1",
        "fixture": False,
        "usage": {"inputTokens": 12, "outputTokens": 4},
        "estimatedCostUsd": "0.000032",
    },
]


# --- Anthropic: real SDK, mock HTTP transport -------------------------------------------


def sse(events: Sequence[Mapping[str, object]]) -> bytes:
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
    ).encode()


def recorded_messages_stream(chunks: Sequence[str]) -> list[dict[str, object]]:
    """A streaming Messages response as the API sends it."""
    events: list[dict[str, object]] = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "model": anthropic_provider.DEFAULT_MODEL_ID,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 12, "output_tokens": 1},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
    ]
    for chunk in chunks:
        delta: dict[str, object] = {"type": "text_delta", "text": chunk}
        events.append({"type": "content_block_delta", "index": 0, "delta": delta})
    events.append({"type": "content_block_stop", "index": 0})
    events.append(
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 4},
        }
    )
    events.append({"type": "message_stop"})
    return events


class Recorder:
    """Serves one canned HTTP response and records every request the SDK sends."""

    def __init__(self, status: int, body: bytes, content_type: str) -> None:
        self.status = status
        self.body = body
        self.content_type = content_type
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return httpx2.Response(
            self.status, headers={"content-type": self.content_type}, content=self.body
        )


def real_anthropic(
    recorder: Recorder, model_id: str = anthropic_provider.DEFAULT_MODEL_ID
) -> ModelProvider:
    """Our live_client() settings, applied to the real SDK class, over a mock transport."""

    def factory(**kwargs: Any) -> anthropic.Anthropic:
        transport = httpx2.MockTransport(recorder)
        return anthropic.Anthropic(
            **kwargs, http_client=anthropic.DefaultHttpxClient(transport=transport)
        )

    client = anthropic_provider.live_client(DUMMY_KEY, client_factory=factory)
    return anthropic_provider.AnthropicProvider(client, model_id)


def test_real_anthropic_sdk_streams_and_we_emit_the_expected_events() -> None:
    recorder = Recorder(200, sse(recorded_messages_stream(ANSWER_CHUNKS)), "text/event-stream")
    events = run(real_anthropic(recorder))

    assert events == EXPECTED_EVENTS
    sent = json.loads(recorder.requests[0].content)
    assert sent["model"] == "claude-haiku-4-5-20251001"
    assert sent["max_tokens"] == 500
    assert sent["temperature"] == 0.0
    assert sent["stream"] is True
    assert sent["system"] == LOCAL_SYSTEM_PROMPT
    assert sent["messages"][0]["role"] == "user"
    assert QUESTION in sent["messages"][0]["content"]
    assert recorder.requests[0].headers["x-api-key"] == DUMMY_KEY


def test_real_anthropic_sdk_omits_temperature_for_models_that_reject_it() -> None:
    recorder = Recorder(200, sse(recorded_messages_stream(ANSWER_CHUNKS)), "text/event-stream")
    run(real_anthropic(recorder, "claude-opus-5-5"))

    assert "temperature" not in json.loads(recorder.requests[0].content)
    assert anthropic_provider.sampling_body("claude-sonnet-4-5", 0.0) == {"temperature": 0.0}
    assert anthropic_provider.sampling_body("claude-haiku-4-5", 0.0) == {"temperature": 0.0}
    assert anthropic_provider.sampling_body("claude-opus-4-7", 0.0) is None
    assert anthropic_provider.sampling_body("claude-haiku-5-5", 0.0) is None


def test_real_anthropic_sdk_errors_become_unavailable_without_retry_storms() -> None:
    unauthorized = Recorder(
        401,
        json.dumps(
            {
                "type": "error",
                "error": {"type": "authentication_error", "message": "invalid x-api-key"},
            }
        ).encode(),
        "application/json",
    )
    errors: list[BaseException] = []
    events = run(real_anthropic(unauthorized), errors)

    assert events == [
        {
            "type": "error",
            "code": "unavailable",
            "message": UNAVAILABLE_MESSAGE,
            "requestId": "request-1",
        }
    ]
    assert [type(error).__name__ for error in errors] == ["AuthenticationError"]
    assert len(unauthorized.requests) == 1  # 401 is not retried

    overloaded = Recorder(
        529,
        b'{"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
        "application/json",
    )
    assert run(real_anthropic(overloaded))[-1]["code"] == "unavailable"
    assert len(overloaded.requests) == 2  # one attempt plus at most one retry

    midstream = recorded_messages_stream(("Partial",))[:3]
    midstream.append({"type": "error", "error": {"type": "overloaded_error", "message": "busy"}})
    broken = Recorder(200, sse(midstream), "text/event-stream")
    assert run(real_anthropic(broken))[-1]["code"] == "unavailable"


def test_live_client_settings_are_accepted_by_the_real_constructor() -> None:
    client = anthropic_provider.live_client(DUMMY_KEY)

    assert isinstance(client, anthropic.Anthropic)
    assert client.max_retries == 1
    timeout = cast(httpx2.Timeout, client.timeout)
    assert (timeout.connect, timeout.read) == (2, 31)


# --- Bedrock: real boto3 client, binary event stream -----------------------------------


def event_message(event_type: str, payload: Mapping[str, object]) -> bytes:
    """One AWS event-stream message (prelude, headers, JSON payload, CRCs)."""
    headers = b""
    for name, value in (
        (":event-type", event_type),
        (":content-type", "application/json"),
        (":message-type", "event"),
    ):
        encoded_name, encoded_value = name.encode(), value.encode()
        headers += bytes([len(encoded_name)]) + encoded_name + bytes([7])
        headers += struct.pack(">H", len(encoded_value)) + encoded_value
    body = json.dumps(payload).encode()
    prelude = struct.pack(">II", 12 + len(headers) + len(body) + 4, len(headers))
    message = prelude + struct.pack(">I", zlib.crc32(prelude)) + headers + body
    return message + struct.pack(">I", zlib.crc32(message))


class StreamingRaw:
    """What botocore reads an event-stream body from."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def stream(self, *args: object, **kwargs: object) -> Iterator[bytes]:
        yield self._body

    def read(self, *args: object, **kwargs: object) -> bytes:
        return self._body

    def close(self) -> None:
        return None


def real_bedrock(body: bytes, sent: list[dict[str, object]]) -> ModelProvider:
    """Our live_stream_client() settings on a real boto3 client, answered by a local hook."""

    def session_factory(**kwargs: Any) -> boto3.Session:
        return boto3.Session(
            aws_access_key_id="AKIAIOSFODNN7EXAMPLE",
            aws_secret_access_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            region_name=cast(str, kwargs["region_name"]),
        )

    client = bedrock_provider.live_stream_client(
        "example-profile", session_factory=cast(Any, session_factory)
    )

    def answer(request: Any, **kwargs: object) -> AWSResponse:
        sent.append(json.loads(request.body))
        return AWSResponse(
            request.url,
            200,
            cast(Any, {"content-type": "application/vnd.amazon.eventstream"}),
            StreamingRaw(body),
        )

    cast(Any, client).meta.events.register("before-send.bedrock-runtime.ConverseStream", answer)
    return bedrock_provider.BedrockProvider(client, "us.amazon.nova-2-lite-v1:0")


def converse_stream_body(chunks: Sequence[str]) -> bytes:
    body = event_message("messageStart", {"role": "assistant"})
    for chunk in chunks:
        body += event_message(
            "contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": chunk}}
        )
    body += event_message("contentBlockStop", {"contentBlockIndex": 0})
    body += event_message("messageStop", {"stopReason": "end_turn"})
    body += event_message(
        "metadata",
        {
            "usage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16},
            "metrics": {"latencyMs": 5},
        },
    )
    return body


def test_real_boto3_client_streams_and_we_emit_the_expected_events() -> None:
    sent: list[dict[str, object]] = []
    events = run(real_bedrock(converse_stream_body(ANSWER_CHUNKS), sent))

    assert events == EXPECTED_EVENTS
    assert sent[0]["system"] == [{"text": LOCAL_SYSTEM_PROMPT}]
    assert sent[0]["inferenceConfig"] == {"maxTokens": 500, "temperature": 0.0}
    assert sent[0]["additionalModelRequestFields"] == {"reasoningConfig": {"type": "disabled"}}


def test_real_boto3_stream_errors_become_unavailable() -> None:
    body = converse_stream_body(("Partial",))[:0] + event_message(
        "contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": "Partial"}}
    )
    error_headers = b""
    for name, value in (
        (":exception-type", "modelStreamErrorException"),
        (":content-type", "application/json"),
        (":message-type", "exception"),
    ):
        encoded_name, encoded_value = name.encode(), value.encode()
        error_headers += bytes([len(encoded_name)]) + encoded_name + bytes([7])
        error_headers += struct.pack(">H", len(encoded_value)) + encoded_value
    payload = json.dumps({"message": "stream failed"}).encode()
    prelude = struct.pack(">II", 12 + len(error_headers) + len(payload) + 4, len(error_headers))
    message = prelude + struct.pack(">I", zlib.crc32(prelude)) + error_headers + payload
    body += message + struct.pack(">I", zlib.crc32(message))

    events = run(real_bedrock(body, []))
    assert events[-1]["code"] == "unavailable"


# --- Opt-in debug traceback -------------------------------------------------------------


def test_debug_traceback_is_off_by_default_and_never_shows_values(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def failing(secret: str, question: str) -> None:
        # Argument values must not be printed, and neither may the rendered message.
        raise TypeError(f"bad argument {secret} for {question}")

    with pytest.raises(TypeError) as raised:
        failing(DUMMY_KEY, QUESTION)
    caught = raised.value

    monkeypatch.delenv("LOCAL_DEBUG_TRACEBACK", raising=False)
    dev_server._report_setup_error("request-1", caught)  # pyright: ignore[reportPrivateUsage]
    quiet = capsys.readouterr().err
    assert quiet.splitlines() == ["ask setup_error request=request-1 error=TypeError"]

    monkeypatch.setenv("LOCAL_DEBUG_TRACEBACK", "1")
    dev_server._report_setup_error("request-1", caught)  # pyright: ignore[reportPrivateUsage]
    loud = capsys.readouterr().err
    assert (
        "ask setup_traceback request=request-1 exception builtins.TypeError (message withheld)"
        in loud
    )
    assert "in failing" in loud
    assert DUMMY_KEY not in loud
    assert QUESTION not in loud
    # Source lines are printed as code; the rendered message is not.
    assert f"bad argument {DUMMY_KEY}" not in loud
