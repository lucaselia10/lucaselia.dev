"""Bedrock Knowledge Base retriever.

The client is injected. This module does not construct boto3 clients and does
not log questions or retrieved passages.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol, cast

from ask_api.citation_safety import DOCUMENT_TYPES, is_public_citation_url
from ask_api.grounding import MAX_RETRIEVAL_CHUNKS, RetrievedChunk
from ask_api.grounding_errors import RetrievalUnavailable

_METADATA_KEYS = ("chunkId", "documentId", "title", "section", "url", "type")


class KnowledgeBaseRetrieveClient(Protocol):
    """The subset of bedrock-agent-runtime used by retrieval."""

    def retrieve(
        self,
        *,
        knowledgeBaseId: str,
        retrievalQuery: Mapping[str, str],
        retrievalConfiguration: Mapping[str, object],
    ) -> Mapping[str, object]:
        """Call Knowledge Base Retrieve."""
        ...


class BedrockKnowledgeBaseRetriever:
    """Retrieve at most five chunks from one Knowledge Base."""

    def __init__(
        self,
        client: KnowledgeBaseRetrieveClient,
        knowledge_base_id: str,
        retrieval_limit: int,
    ) -> None:
        self._client = client
        self._knowledge_base_id = knowledge_base_id
        self._limit = min(retrieval_limit, MAX_RETRIEVAL_CHUNKS)

    def retrieve(self, question: str, limit: int) -> tuple[RetrievedChunk, ...]:
        """Return trusted chunks, or raise RetrievalUnavailable."""
        bounded = min(self._limit, limit, MAX_RETRIEVAL_CHUNKS)
        if bounded < 1:
            bounded = 1
        try:
            response = self._client.retrieve(
                knowledgeBaseId=self._knowledge_base_id,
                retrievalQuery={"text": question},
                retrievalConfiguration={
                    "vectorSearchConfiguration": {"numberOfResults": bounded},
                },
            )
        except RetrievalUnavailable:
            raise
        except Exception:
            raise RetrievalUnavailable() from None
        return _chunks(response)[:MAX_RETRIEVAL_CHUNKS]


def _chunks(response: object) -> tuple[RetrievedChunk, ...]:
    if not isinstance(response, Mapping):
        raise RetrievalUnavailable()
    raw_results = cast(Mapping[object, object], response).get("retrievalResults", [])
    if raw_results is None:
        return ()
    if not isinstance(raw_results, list):
        raise RetrievalUnavailable()
    chunks: list[RetrievedChunk] = []
    seen: set[str] = set()
    for item in cast(list[object], raw_results):
        chunk = _chunk(item)
        if chunk.chunk_id in seen:
            raise RetrievalUnavailable()
        seen.add(chunk.chunk_id)
        chunks.append(chunk)
    return tuple(chunks)


def _chunk(item: object) -> RetrievedChunk:
    if not isinstance(item, Mapping):
        raise RetrievalUnavailable()
    record = cast(Mapping[object, object], item)
    text = _text(record.get("content"))
    score = _score(record.get("score"))
    metadata = _metadata(record.get("metadata"))
    document_type = metadata["type"]
    if document_type not in DOCUMENT_TYPES:
        raise RetrievalUnavailable()
    if not is_public_citation_url(metadata["url"], document_type):
        raise RetrievalUnavailable()
    return RetrievedChunk(
        chunk_id=metadata["chunkId"],
        document_id=metadata["documentId"],
        title=metadata["title"],
        section=metadata["section"],
        url=metadata["url"],
        document_type=document_type,
        text=text,
        score=score,
    )


def _text(content: object) -> str:
    if not isinstance(content, Mapping):
        raise RetrievalUnavailable()
    text = cast(Mapping[object, object], content).get("text")
    if not isinstance(text, str) or text.strip() == "":
        raise RetrievalUnavailable()
    return text


def _score(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RetrievalUnavailable()
    return float(value)


def _metadata(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        raise RetrievalUnavailable()
    record = cast(Mapping[object, object], value)
    parsed: dict[str, str] = {}
    for key in _METADATA_KEYS:
        parsed[key] = _metadata_string(record.get(key))
    return parsed


def _metadata_string(value: object) -> str:
    if isinstance(value, str) and value.strip() != "":
        return value
    if isinstance(value, Mapping):
        nested = cast(Mapping[object, object], value).get("stringValue")
        if isinstance(nested, str) and nested.strip() != "":
            return nested
    raise RetrievalUnavailable()
