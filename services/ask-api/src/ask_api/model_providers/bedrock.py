"""Amazon Bedrock (Nova through the US inference profile) via ConverseStream.

Live mode uses an explicitly named profile (LOCAL_AWS_PROFILE) and never the
default credential chain; raw access-key variables are refused.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator, Mapping
from typing import TYPE_CHECKING, Protocol, cast

from ask_api.local_conversation import TokenUsage
from ask_api.model_providers.base import (
    CONNECT_TIMEOUT_SECONDS,
    MODEL_MESSAGE,
    STREAM_DEADLINE_SECONDS,
    ModelEvent,
    ModelRequest,
    ModelSetupError,
    StreamFailure,
    StreamStop,
    TextDelta,
    UsageReport,
    token_count,
)

NAME = "bedrock"
#: Local Bedrock mode only. Production does not use Bedrock (ADR-009).
APPLICATION_REGION = "us-west-2"
DEFAULT_NOVA_INFERENCE_PROFILE_ID = "us.amazon.nova-2-lite-v1:0"
_NOVA_INFERENCE_PROFILE_PATTERN = re.compile(r"^us\.amazon\.nova-2-lite-v[0-9]+:[0-9]+$")
PROFILE_MESSAGE = "Live model mode needs LOCAL_AWS_PROFILE set to a named AWS profile."
RAW_KEYS_MESSAGE = (
    "Live model mode refuses AWS access keys in the environment. Use LOCAL_AWS_PROFILE."
)
RAW_KEY_VARIABLES = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")
_SERVICE_ERRORS = (
    "internalServerException",
    "modelStreamErrorException",
    "throttlingException",
    "serviceUnavailableException",
    "validationException",
)


if TYPE_CHECKING:
    # Typed against the boto3 stubs, so pyright rejects a call shape botocore does not accept.
    from mypy_boto3_bedrock_runtime.client import BedrockRuntimeClient as ConverseStreamClient
else:
    ConverseStreamClient = object


class BedrockProvider:
    """Streams a Nova answer and maps ConverseStream events to ModelEvents."""

    name = NAME
    fixture = False

    def __init__(self, client: ConverseStreamClient, model_id: str) -> None:
        self._client = client
        self._model_id = model_id

    def open_stream(self, request: ModelRequest) -> Iterator[ModelEvent]:
        response = self._client.converse_stream(
            modelId=self._model_id,
            system=[{"text": request.system}],
            messages=[{"role": "user", "content": [{"text": request.user_text}]}],
            inferenceConfig={"maxTokens": request.max_tokens, "temperature": request.temperature},
            additionalModelRequestFields={"reasoningConfig": {"type": "disabled"}},
        )
        # Typed as object: fake clients and malformed responses must still fail closed.
        stream = cast(object, response.get("stream"))
        if stream is None or isinstance(stream, (str, bytes, Mapping)):
            raise RuntimeError
        return _events(iter(cast(Iterator[object], stream)))


def _events(stream: Iterator[object]) -> Iterator[ModelEvent]:
    for event in stream:
        mapped = read_event(event)
        if mapped is not None:
            yield mapped


def read_event(event: object) -> ModelEvent | None:
    """Map one ConverseStream event. None means the event carries nothing we use."""
    if not isinstance(event, Mapping):
        return StreamFailure("invalid")
    record = cast(Mapping[object, object], event)
    if any(name in record for name in _SERVICE_ERRORS):
        return StreamFailure("service")
    delta_event = record.get("contentBlockDelta")
    if isinstance(delta_event, Mapping):
        delta = cast(Mapping[object, object], delta_event).get("delta")
        if not isinstance(delta, Mapping):
            return StreamFailure("invalid")
        body = cast(Mapping[object, object], delta)
        if "toolUse" in body:
            return StreamFailure("invalid")
        text = body.get("text")
        if isinstance(text, str) and "reasoningContent" not in body:
            return TextDelta(text)
        return None
    if "messageStop" in record:
        return StreamStop()
    metadata = record.get("metadata")
    if isinstance(metadata, Mapping):
        usage = cast(Mapping[object, object], metadata).get("usage")
        if isinstance(usage, Mapping):
            counts = cast(Mapping[object, object], usage)
            incoming = token_count(counts.get("inputTokens"))
            outgoing = token_count(counts.get("outputTokens"))
            if incoming is not None and outgoing is not None:
                return UsageReport(TokenUsage(incoming, outgoing))
    return None


def configured_model_id(environ: Mapping[str, str]) -> str:
    """Return the Nova inference profile id, or raise without echoing the value."""
    model_id = environ.get("NOVA_MODEL_ID", "").strip() or DEFAULT_NOVA_INFERENCE_PROFILE_ID
    if not is_nova_inference_profile(model_id):
        raise ModelSetupError(MODEL_MESSAGE)
    return model_id


def configured_profile(environ: Mapping[str, str]) -> str:
    """Return the named profile for live mode, or refuse without echoing values.

    Raw access-key variables are refused even though an explicit profile would ignore them.
    """
    if any(name in environ for name in RAW_KEY_VARIABLES):
        raise ModelSetupError(RAW_KEYS_MESSAGE)
    profile = environ.get("LOCAL_AWS_PROFILE", "").strip()
    if profile == "":
        raise ModelSetupError(PROFILE_MESSAGE)
    return profile


class _Session(Protocol):
    def client(self, service_name: str, *, config: object) -> object: ...


def live_stream_client(
    profile: str, *, session_factory: Callable[..., _Session] | None = None
) -> ConverseStreamClient:
    """Create a bedrock-runtime client from an explicitly named profile.

    The read timeout is the gap between streamed bytes, not a hidden delay.
    """
    from botocore.config import Config

    if session_factory is None:
        module: object = __import__("boto3")
        session_factory = cast(Callable[..., _Session], getattr(module, "Session"))
    session = session_factory(profile_name=profile, region_name=APPLICATION_REGION)
    return cast(
        ConverseStreamClient,
        session.client(
            "bedrock-runtime",
            config=Config(
                connect_timeout=CONNECT_TIMEOUT_SECONDS,
                read_timeout=STREAM_DEADLINE_SECONDS,
                retries={"total_max_attempts": 1},
            ),
        ),
    )


def check_environment(environ: Mapping[str, str]) -> None:
    configured_profile(environ)
    configured_model_id(environ)


def from_environment(environ: Mapping[str, str]) -> BedrockProvider:
    profile = configured_profile(environ)
    model_id = configured_model_id(environ)
    return BedrockProvider(live_stream_client(profile), model_id)


def is_nova_inference_profile(value: str) -> bool:
    """Return whether a model id is the Nova 2 Lite US inference profile shape."""
    return _NOVA_INFERENCE_PROFILE_PATTERN.fullmatch(value) is not None
