"""Orchestrate retrieve-then-generate without calling AWS.

Exact career facts stay on the deterministic path. This service is the future
open-ended path. A deployment supplies the retriever and generator. This module
does not construct AWS clients.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from ask_api.exact_answers import FALLBACK_ANSWER, Citation, suggested_questions
from ask_api.grounding_errors import (
    GenerationUnavailable,
    MalformedGeneratedOutput,
    RetrievalUnavailable,
    UngroundedGeneratedOutput,
)
from ask_api.model_output import MAX_CITED_CHUNK_IDS, validate_grounded_tool_input

MAX_RETRIEVAL_CHUNKS = MAX_CITED_CHUNK_IDS


@dataclass(frozen=True)
class RetrievedChunk:
    """One trusted passage returned by a future retriever."""

    chunk_id: str
    document_id: str
    title: str
    section: str
    url: str
    document_type: str
    text: str
    score: float


@dataclass(frozen=True)
class GroundedAnswerDraft:
    """Untrusted model output before citation checks."""

    answer: str
    cited_chunk_ids: tuple[str, ...]
    suggested_questions: tuple[str, ...]


@dataclass(frozen=True)
class PublicCareerAnswer:
    """The public answer shape shared with exact answers."""

    answer: str
    citations: tuple[Citation, ...]
    suggested_questions: tuple[str, ...]


class Retriever(Protocol):
    """Return at most ``limit`` trusted chunks for a question."""

    def retrieve(self, question: str, limit: int) -> Sequence[RetrievedChunk]:
        """Retrieve public chunks. Implementations must not log the question."""
        ...


class AnswerGenerator(Protocol):
    """Draft an answer from the question and the retrieved chunks only."""

    def generate(
        self,
        question: str,
        chunks: Sequence[RetrievedChunk],
    ) -> GroundedAnswerDraft:
        """Generate a draft. Implementations must not log the question or chunks."""
        ...


class CareerAnswerer(Protocol):
    """Something that can answer one unmatched career question."""

    def answer(self, question: str) -> PublicCareerAnswer:
        """Return a public answer or raise a grounding error."""
        ...


class GroundedAnswerService:
    """Retrieve, generate, and accept only citations from retrieved chunks."""

    def __init__(self, retriever: Retriever, generator: AnswerGenerator) -> None:
        self._retriever = retriever
        self._generator = generator

    def answer(self, question: str) -> PublicCareerAnswer:
        """Answer from retrieved public chunks, or use the unsupported fallback."""
        chunks = self._retrieve(question)
        if not chunks:
            return PublicCareerAnswer(
                answer=FALLBACK_ANSWER,
                citations=(),
                suggested_questions=suggested_questions(None),
            )
        draft = self._generate(question, chunks)
        answer, cited_ids, suggestions = validate_grounded_tool_input(
            {
                "answer": draft.answer,
                "citedChunkIds": list(draft.cited_chunk_ids),
                "suggestedQuestions": list(draft.suggested_questions),
            }
        )
        return PublicCareerAnswer(
            answer=answer,
            citations=_citations(cited_ids, chunks),
            suggested_questions=suggestions,
        )

    def _retrieve(self, question: str) -> tuple[RetrievedChunk, ...]:
        try:
            found = self._retriever.retrieve(question, MAX_RETRIEVAL_CHUNKS)
        except RetrievalUnavailable:
            raise
        except Exception as error:
            raise RetrievalUnavailable() from error
        chunks = tuple(found)[:MAX_RETRIEVAL_CHUNKS]
        return chunks

    def _generate(self, question: str, chunks: Sequence[RetrievedChunk]) -> GroundedAnswerDraft:
        try:
            return self._generator.generate(question, chunks)
        except GenerationUnavailable:
            raise
        except MalformedGeneratedOutput:
            raise
        except UngroundedGeneratedOutput:
            raise
        except Exception as error:
            raise GenerationUnavailable() from error


def _citations(cited_ids: Sequence[str], chunks: Sequence[RetrievedChunk]) -> tuple[Citation, ...]:
    by_id: dict[str, RetrievedChunk] = {}
    for chunk in chunks:
        if chunk.chunk_id not in by_id:
            by_id[chunk.chunk_id] = chunk
    citations: list[Citation] = []
    seen: set[str] = set()
    for chunk_id in cited_ids:
        chunk = by_id.get(chunk_id)
        if chunk is None:
            raise UngroundedGeneratedOutput()
        if chunk_id in seen:
            continue
        seen.add(chunk_id)
        citations.append(
            Citation(
                chunk_id=chunk.chunk_id,
                document_id=chunk.document_id,
                title=chunk.title,
                section=chunk.section,
                url=chunk.url,
                document_type=chunk.document_type,
                roles=(),
                skills=(),
            )
        )
    if not citations:
        raise MalformedGeneratedOutput()
    return tuple(citations)
