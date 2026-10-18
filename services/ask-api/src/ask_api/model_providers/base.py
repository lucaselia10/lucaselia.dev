"""The model-provider boundary shared by local model mode and, later, the Lambda.

A provider turns one ModelRequest into a stream of ModelEvents. Everything else
(prompt, evidence, history, SOURCES holdback, citation checks, usage reporting,
the public event contract) lives outside the provider and is the same for all of
them. Adding a provider means one module with check_environment(),
from_environment(), and a class with open_stream(), plus one registry entry.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Literal, Protocol

from ask_api.local_conversation import TokenUsage
from ask_api.local_evidence import EvidencePackage

#: Overall budget for one streamed answer, and the read timeout between streamed bytes.
STREAM_DEADLINE_SECONDS = 31
CONNECT_TIMEOUT_SECONDS = 2

MODEL_MESSAGE = "The model configuration is unavailable."


class ModelSetupError(Exception):
    """A provider cannot start with the current configuration. The message is public."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.public_message = message


@dataclass(frozen=True)
class ModelRequest:
    """One answer to generate. Real providers use system and user_text."""

    system: str
    user_text: str
    max_tokens: int
    temperature: float
    # The structured inputs behind user_text, for the fixture provider.
    question: str
    history: tuple[tuple[str, str], ...]
    evidence: EvidencePackage


@dataclass(frozen=True)
class TextDelta:
    """Answer text as the model produced it."""

    text: str


@dataclass(frozen=True)
class UsageReport:
    """Token counts reported by the provider. The latest report wins."""

    usage: TokenUsage


@dataclass(frozen=True)
class StreamStop:
    """The model finished its message."""


@dataclass(frozen=True)
class StreamFailure:
    """The provider reported an error ("service") or output we refuse ("invalid")."""

    kind: Literal["service", "invalid"]


ModelEvent = TextDelta | UsageReport | StreamStop | StreamFailure


class ModelProvider(Protocol):
    """A configured model client."""

    @property
    def name(self) -> str: ...

    @property
    def fixture(self) -> bool:
        """True only for the in-process fixture, which never calls a model."""
        ...

    def open_stream(self, request: ModelRequest) -> Iterator[ModelEvent]:
        """Start the request now (errors raise here), then yield events lazily."""
        ...


class ProviderSpec(Protocol):
    """What the registry needs from a provider module."""

    def check_environment(self, environ: Mapping[str, str]) -> None:
        """Raise ModelSetupError if the configuration is incomplete. Never echo values."""
        ...

    def from_environment(self, environ: Mapping[str, str]) -> ModelProvider:
        """Build the provider and its client."""
        ...


def field(value: object, name: str) -> object:
    """Read a field from an SDK object or a plain mapping."""
    if isinstance(value, Mapping):
        mapping: Mapping[object, object] = value  # type: ignore[assignment]
        return mapping.get(name)
    return getattr(value, name, None)


def token_count(value: object) -> int | None:
    """A non-negative integer token count, or None."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value
