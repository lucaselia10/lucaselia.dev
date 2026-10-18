"""Lambda environment configuration for the AWS grounding path.

Values are read only when grounding is enabled. This module does not log them
and does not put them in exception text.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

APPLICATION_REGION = "us-west-2"
DEFAULT_NOVA_INFERENCE_PROFILE_ID = "us.amazon.nova-2-lite-v1:0"
MAX_RETRIEVAL_LIMIT = 5
_NOVA_INFERENCE_PROFILE_PATTERN = re.compile(r"^us\.amazon\.nova-2-lite-v[0-9]+:[0-9]+$")
_KNOWLEDGE_BASE_ID_PATTERN = re.compile(r"^[A-Za-z0-9]{1,20}$")


class GroundingConfigurationError(Exception):
    """Enabled grounding is missing or has an invalid setting."""

    def __init__(self) -> None:
        super().__init__("Grounding configuration is unavailable.")


@dataclass(frozen=True)
class GroundingConfig:
    """Validated settings required to construct the AWS grounding providers."""

    knowledge_base_id: str
    nova_model_id: str
    retrieval_limit: int


def is_nova_inference_profile(value: str) -> bool:
    """Return whether a model id is the configured Nova 2 Lite profile shape."""
    return _NOVA_INFERENCE_PROFILE_PATTERN.fullmatch(value) is not None


def grounding_enabled(environ: Mapping[str, str] | None = None) -> bool:
    """Return whether this invocation should use the AWS grounding path."""
    source = os.environ if environ is None else environ
    return source.get("GROUNDING_ENABLED", "").strip().lower() == "true"


def load_grounding_config(environ: Mapping[str, str] | None = None) -> GroundingConfig | None:
    """Load grounding settings, or return None when grounding is disabled."""
    source = os.environ if environ is None else environ
    if not grounding_enabled(source):
        return None
    knowledge_base_id = source.get("KNOWLEDGE_BASE_ID", "").strip()
    nova_model_id = source.get("NOVA_MODEL_ID", "").strip()
    retrieval_limit = source.get("GROUNDING_RETRIEVAL_LIMIT", "").strip()
    if (
        _KNOWLEDGE_BASE_ID_PATTERN.fullmatch(knowledge_base_id) is None
        or _NOVA_INFERENCE_PROFILE_PATTERN.fullmatch(nova_model_id) is None
        or not retrieval_limit.isdecimal()
    ):
        raise GroundingConfigurationError()
    limit = int(retrieval_limit)
    if limit < 1 or limit > MAX_RETRIEVAL_LIMIT:
        raise GroundingConfigurationError()
    return GroundingConfig(
        knowledge_base_id=knowledge_base_id,
        nova_model_id=nova_model_id,
        retrieval_limit=limit,
    )
