"""Construct the AWS grounding service from Lambda environment configuration.

boto3 clients are created only after exact-answer routing misses and only when
grounding is enabled. Successful clients are reused across warm invocations.
A failed attempt is not cached.

Retrieval and generation use separate botocore timeouts and a single attempt
so a slow Bedrock call fails inside the 28-second Lambda timeout.
"""

from __future__ import annotations

from typing import cast

from botocore.config import Config

from ask_api.bedrock_generator import BedrockNovaAnswerGenerator, ConverseClient
from ask_api.bedrock_retriever import BedrockKnowledgeBaseRetriever, KnowledgeBaseRetrieveClient
from ask_api.grounding import CareerAnswerer, GroundedAnswerService
from ask_api.grounding_config import APPLICATION_REGION, load_grounding_config
from ask_api.grounding_errors import RetrievalUnavailable

RETRIEVAL_CONNECT_TIMEOUT_SECONDS = 2
RETRIEVAL_READ_TIMEOUT_SECONDS = 5
GENERATION_CONNECT_TIMEOUT_SECONDS = 2
GENERATION_READ_TIMEOUT_SECONDS = 15
CLIENT_TOTAL_MAX_ATTEMPTS = 1

_cached_service: GroundedAnswerService | None = None


def configured_grounding_service() -> CareerAnswerer | None:
    """Return the cached AWS service, None when disabled, or raise when setup fails."""
    global _cached_service
    config = load_grounding_config()
    if config is None:
        return None
    if _cached_service is not None:
        return _cached_service
    try:
        service = GroundedAnswerService(
            BedrockKnowledgeBaseRetriever(
                agent_runtime_client(),
                config.knowledge_base_id,
                config.retrieval_limit,
            ),
            BedrockNovaAnswerGenerator(runtime_client(), config.nova_model_id),
        )
    except Exception:
        _cached_service = None
        raise RetrievalUnavailable() from None
    _cached_service = service
    return service


def clear_grounding_cache() -> None:
    """Drop cached clients so a later invocation can construct them again."""
    global _cached_service
    _cached_service = None


def agent_runtime_client() -> KnowledgeBaseRetrieveClient:
    """Create a bedrock-agent-runtime client in us-west-2."""
    return cast(
        KnowledgeBaseRetrieveClient,
        _boto3_client(
            "bedrock-agent-runtime",
            _client_config(RETRIEVAL_CONNECT_TIMEOUT_SECONDS, RETRIEVAL_READ_TIMEOUT_SECONDS),
        ),
    )


def runtime_client() -> ConverseClient:
    """Create a bedrock-runtime client in us-west-2."""
    return cast(
        ConverseClient,
        _boto3_client(
            "bedrock-runtime",
            _client_config(GENERATION_CONNECT_TIMEOUT_SECONDS, GENERATION_READ_TIMEOUT_SECONDS),
        ),
    )


def _client_config(connect_timeout: int, read_timeout: int) -> Config:
    return Config(
        connect_timeout=connect_timeout,
        read_timeout=read_timeout,
        retries={"total_max_attempts": CLIENT_TOTAL_MAX_ATTEMPTS},
    )


def _boto3_client(service_name: str, config: Config) -> object:
    module: object = __import__("boto3")
    create = getattr(module, "client")
    if not callable(create):
        raise RetrievalUnavailable()
    return create(service_name, region_name=APPLICATION_REGION, config=config)
