"""The Anthropic API (Claude) via streaming Messages.

Live mode needs ANTHROPIC_API_KEY in the process environment. The key is passed to
the SDK client and is never logged, echoed, or included in an error.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import TYPE_CHECKING, cast

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
    field,
    token_count,
)

NAME = "anthropic"
#: The only place the default model id is written. Override with ANTHROPIC_MODEL_ID.
DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001"
_MODEL_ID = re.compile(r"^claude-[a-z]+(?:-[0-9]+){1,2}(?:-[0-9]{8})?$")
# The 1.x SDK removed `temperature` from messages.create() (passing it is a TypeError).
# Models up to the 4.6 generation still honor it on the API, so it is sent in extra_body for
# them; later models reject any sampling parameter, so it is omitted there.
_ACCEPTS_TEMPERATURE = re.compile(r"^claude-(?:haiku|sonnet|opus)-4(?:-[0-6])?(?:-[0-9]{8})?$")
API_KEY_MESSAGE = "Anthropic model mode needs ANTHROPIC_API_KEY in the process environment."
#: At most one retry, matching the one-attempt Nova budget plus the requested retry.
MAX_RETRIES = 1


if TYPE_CHECKING:
    # Typed against the real SDK, so pyright rejects a call shape the SDK does not accept.
    # The SDK is a development dependency; at runtime it is imported only in live_client().
    from anthropic import Anthropic as MessagesClient
else:
    MessagesClient = object


class AnthropicProvider:
    """Streams a Claude answer and maps Messages stream events to ModelEvents."""

    name = NAME
    fixture = False

    def __init__(self, client: MessagesClient, model_id: str) -> None:
        self._client = client
        self._model_id = model_id

    def open_stream(self, request: ModelRequest) -> Iterator[ModelEvent]:
        stream = self._client.messages.create(
            model=self._model_id,
            max_tokens=request.max_tokens,
            system=request.system,
            messages=[{"role": "user", "content": request.user_text}],
            stream=True,
            extra_body=sampling_body(self._model_id, request.temperature),
        )
        return _events(stream)


def sampling_body(model_id: str, temperature: float) -> dict[str, object] | None:
    """Temperature for models that still accept it, sent outside the SDK's typed parameters."""
    if _ACCEPTS_TEMPERATURE.fullmatch(model_id):
        return {"temperature": temperature}
    return None


def _events(stream: Iterable[object]) -> Iterator[ModelEvent]:
    input_tokens: int | None = None
    try:
        for event in stream:
            kind = field(event, "type")
            if kind == "message_start":
                usage = field(field(event, "message"), "usage")
                input_tokens = token_count(field(usage, "input_tokens"))
            elif kind == "content_block_start":
                if field(field(event, "content_block"), "type") == "tool_use":
                    yield StreamFailure("invalid")
            elif kind == "content_block_delta":
                delta = field(event, "delta")
                delta_type = field(delta, "type")
                if delta_type == "text_delta":
                    text = field(delta, "text")
                    if isinstance(text, str):
                        yield TextDelta(text)
                elif delta_type == "input_json_delta":
                    yield StreamFailure("invalid")
            elif kind == "message_delta":
                usage = field(event, "usage")
                outgoing = token_count(field(usage, "output_tokens"))
                incoming = token_count(field(usage, "input_tokens")) or input_tokens
                if outgoing is not None and incoming is not None:
                    yield UsageReport(TokenUsage(incoming, outgoing))
            elif kind == "message_stop":
                yield StreamStop()
            elif kind == "error":
                yield StreamFailure("service")
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            close()


def configured_model_id(environ: Mapping[str, str]) -> str:
    """Return the Claude model id, or raise without echoing the value."""
    model_id = environ.get("ANTHROPIC_MODEL_ID", "").strip() or DEFAULT_MODEL_ID
    if not _MODEL_ID.fullmatch(model_id):
        raise ModelSetupError(MODEL_MESSAGE)
    return model_id


def configured_api_key(environ: Mapping[str, str]) -> str:
    """Return the API key, or raise a message that never contains it."""
    key = environ.get("ANTHROPIC_API_KEY", "").strip()
    if key == "":
        raise ModelSetupError(API_KEY_MESSAGE)
    return key


def live_client(
    api_key: str, *, client_factory: Callable[..., MessagesClient] | None = None
) -> MessagesClient:
    """Create the SDK client: 2-second connect, 31-second read, at most one retry."""
    import anthropic

    factory = client_factory or cast(Callable[..., MessagesClient], anthropic.Anthropic)
    return factory(
        api_key=api_key,
        timeout=anthropic.Timeout(STREAM_DEADLINE_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
        max_retries=MAX_RETRIES,
    )


def check_environment(environ: Mapping[str, str]) -> None:
    configured_api_key(environ)
    configured_model_id(environ)


def from_environment(environ: Mapping[str, str]) -> AnthropicProvider:
    api_key = configured_api_key(environ)
    model_id = configured_model_id(environ)
    return AnthropicProvider(live_client(api_key), model_id)
