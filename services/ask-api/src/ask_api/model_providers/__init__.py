"""Model providers and the factory that picks one from configuration.

LOCAL_MODEL_PROVIDER selects a live provider ("anthropic" by default, or "bedrock").
To add a provider, write one module with check_environment(), from_environment(),
and a ModelProvider class, then add one line to _REGISTRY.
"""

from __future__ import annotations

from collections.abc import Mapping

from ask_api.model_providers import anthropic_api, bedrock
from ask_api.model_providers.base import (
    ModelBusy,
    ModelEvent,
    ModelPaused,
    ModelProvider,
    ModelRequest,
    ModelSetupError,
    ProviderSpec,
    StreamFailure,
    StreamStop,
    TextDelta,
    UsageReport,
)
from ask_api.model_providers.fixture import FixtureProvider

PROVIDER_VARIABLE = "LOCAL_MODEL_PROVIDER"
DEFAULT_PROVIDER = anthropic_api.NAME

_REGISTRY: dict[str, ProviderSpec] = {
    anthropic_api.NAME: anthropic_api,  # type: ignore[dict-item]
    bedrock.NAME: bedrock,  # type: ignore[dict-item]
}

PROVIDER_MESSAGE = f"{PROVIDER_VARIABLE} must be one of: {', '.join(sorted(_REGISTRY))}."


def provider_names() -> tuple[str, ...]:
    return tuple(sorted(_REGISTRY))


def provider_name(environ: Mapping[str, str]) -> str:
    """The configured live provider, or refuse an unknown value without echoing it."""
    name = environ.get(PROVIDER_VARIABLE, "").strip().lower() or DEFAULT_PROVIDER
    if name not in _REGISTRY:
        raise ModelSetupError(PROVIDER_MESSAGE)
    return name


def check_provider(environ: Mapping[str, str]) -> str:
    """Validate the configured provider's settings before anything starts."""
    name = provider_name(environ)
    _REGISTRY[name].check_environment(environ)
    return name


def create_provider(environ: Mapping[str, str]) -> ModelProvider:
    """Build the configured live provider and its client."""
    return _REGISTRY[check_provider(environ)].from_environment(environ)


__all__ = [
    "DEFAULT_PROVIDER",
    "PROVIDER_MESSAGE",
    "PROVIDER_VARIABLE",
    "FixtureProvider",
    "ModelBusy",
    "ModelEvent",
    "ModelPaused",
    "ModelProvider",
    "ModelRequest",
    "ModelSetupError",
    "StreamFailure",
    "StreamStop",
    "TextDelta",
    "UsageReport",
    "check_provider",
    "create_provider",
    "provider_name",
    "provider_names",
]
