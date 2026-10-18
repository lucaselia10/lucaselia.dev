"""An in-process stream for development and tests. It never calls a model."""

from __future__ import annotations

from collections.abc import Iterator

from ask_api.exact_answers import FALLBACK_ANSWER
from ask_api.local_conversation import TokenUsage
from ask_api.local_evidence import EvidencePackage, EvidenceSection
from ask_api.model_providers.base import (
    ModelEvent,
    ModelRequest,
    StreamStop,
    TextDelta,
    UsageReport,
)

NAME = "fixture"
_CHUNK = 20


class FixtureProvider:
    """Deterministic answers that exercise the same holdback and citation path."""

    name = NAME
    fixture = True

    def open_stream(self, request: ModelRequest) -> Iterator[ModelEvent]:
        return iter(_events(request))


def _events(request: ModelRequest) -> list[ModelEvent]:
    lowered = request.question.lower()
    section = _section(lowered, request.evidence)
    if "weather" in lowered or "unsupported" in lowered:
        answer, sources = FALLBACK_ANSWER, "SOURCES: none"
    elif request.history:
        answer = "Fixture stream. The earlier turn is conversation context, not evidence."
        sources = f"SOURCES: {section.chunk_id}"
    elif "reliability" in lowered:
        answer = "Fixture stream. This open-ended answer was not produced by a model."
        sources = f"SOURCES: {section.chunk_id}"
    else:
        answer = f"Fixture stream. {section.title} is in the public record."
        sources = f"SOURCES: {section.chunk_id}"
    text = f"{answer}\n{sources}"
    events: list[ModelEvent] = [
        TextDelta(text[start : start + _CHUNK]) for start in range(0, len(text), _CHUNK)
    ]
    events.append(StreamStop())
    events.append(UsageReport(TokenUsage(11, 7)))
    return events


def _section(lowered_question: str, package: EvidencePackage) -> EvidenceSection:
    if "reliability" in lowered_question:
        for section in package.sections:
            if section.document_id == "aws-sde-ii":
                return section
    return package.sections[0]
