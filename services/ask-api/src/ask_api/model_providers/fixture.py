"""An in-process stream for development and tests. It never calls a model."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator

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

    def __init__(
        self, delay_seconds: float = 0.0, sleep: Callable[[float], None] = time.sleep
    ) -> None:
        # A pause before each text chunk, so a local run visibly streams. Tests leave it at 0.
        self._delay_seconds = delay_seconds
        self._sleep = sleep

    def open_stream(self, request: ModelRequest) -> Iterator[ModelEvent]:
        if self._delay_seconds <= 0:
            return iter(_events(request))
        return self._paced(_events(request))

    def _paced(self, events: list[ModelEvent]) -> Iterator[ModelEvent]:
        for event in events:
            if isinstance(event, TextDelta):
                self._sleep(self._delay_seconds)
            yield event


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
