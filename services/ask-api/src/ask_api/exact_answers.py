"""Deterministic answers from the packaged career index.

Intent recognition uses explicit phrases after normalization. It is not general
language understanding. Prior turns are used only to resolve a follow-up that
points at a fact already in the index. Nothing here calls a model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum

from ask_api.index_loader import (
    CareerFact,
    CareerIndex,
    CareerIndexError,
    CareerSource,
    IndexedDocument,
    load_index,
)

FALLBACK_ANSWER = (
    "I don't have anything on that in Lucas's career pages. "
    "You can ask about his roles at AWS, what he's worked on, or his education."
)


class Intent(Enum):
    """A factual question the public index can answer exactly."""

    CURRENT_ROLE = "current_role"
    EMPLOYMENT_HISTORY = "employment_history"
    EDUCATION = "education"
    TECHNOLOGIES = "technologies"
    AWS_WORK = "aws_work"
    DISTRIBUTED_SYSTEMS = "distributed_systems"
    CAREER_TRANSITION = "career_transition"


_SUGGESTION_ORDER = (
    Intent.CURRENT_ROLE,
    Intent.EMPLOYMENT_HISTORY,
    Intent.EDUCATION,
    Intent.TECHNOLOGIES,
)

_SUGGESTED_BY_INTENT = {
    Intent.CURRENT_ROLE.value: "What is Lucas's current role?",
    Intent.EMPLOYMENT_HISTORY.value: "Where has Lucas worked?",
    Intent.EDUCATION.value: "Does Lucas have a college degree?",
    Intent.TECHNOLOGIES.value: "What technologies does Lucas use?",
}

_EMPLOYMENT_PHRASES = (
    "employment history",
    "work history",
    "where has",
    "where have",
)
_EDUCATION_PHRASES = (
    "college degree",
    "graduate from college",
    "graduated from college",
    "your education",
    "lucas education",
    "go to school",
    "went to school",
)
_TECHNOLOGY_PHRASES = (
    "tech stack",
    "technologies",
    "technology",
    "programming language",
    "programming languages",
    "aws service",
    "aws services",
)
_CURRENT_ROLE_PHRASES = (
    "current role",
    "current job",
    "do now",
    "does now",
    "where does lucas work",
    "where do you work",
    "where does he work",
)
_AWS_WORK_PHRASES = (
    "built at aws",
    "built at amazon",
    "what has he built",
    "what has lucas built",
)
_DISTRIBUTED_PHRASES = ("distributed systems",)
_TRANSITION_PHRASES = (
    "transition into software",
    "transition to software",
    "into software engineering",
)
_DURATION_PHRASES = (
    "how long",
    "when did he start",
    "when did that start",
    "when did this start",
    "since when",
)
_WHERE_PHRASES = (
    "where is that",
    "where was that",
    "where is he",
    "where is this",
    "what city",
)
_DETAIL_PHRASES = (
    "tell me more",
    "what does he do",
    "what does that involve",
    "what did he do there",
)
_STUDY_PHRASES = (
    "where did he study",
    "what did he study",
    "which school",
    "where did he go",
)
_MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


@dataclass(frozen=True)
class Citation:
    """A public page citation copied from an index source."""

    chunk_id: str
    document_id: str
    title: str
    section: str
    url: str
    document_type: str | None
    roles: tuple[str, ...]
    skills: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "chunkId": self.chunk_id,
            "documentId": self.document_id,
            "title": self.title,
            "section": self.section,
            "url": self.url,
            "roles": list(self.roles),
            "skills": list(self.skills),
        }
        if self.document_type is not None:
            payload["type"] = self.document_type
        return payload


@dataclass(frozen=True)
class ExactAnswer:
    """A structured answer derived from the career index."""

    answer: str
    citations: tuple[Citation, ...]
    suggested_questions: tuple[str, ...]


def normalize_question(question: str) -> str:
    """Lowercase a question and drop possessives, punctuation, and extra space."""
    text = question.lower().replace("\u2019", "'").replace("\u2018", "'")
    text = text.replace("'s", " ")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def recognize_intent(question: str) -> Intent | None:
    """Match one supported question family, or return no match."""
    text = f" {normalize_question(question)} "
    if _has_phrase(text, _EMPLOYMENT_PHRASES):
        return Intent.EMPLOYMENT_HISTORY
    if _has_phrase(text, _EDUCATION_PHRASES):
        return Intent.EDUCATION
    if _has_phrase(text, _TECHNOLOGY_PHRASES):
        return Intent.TECHNOLOGIES
    if _has_phrase(text, _CURRENT_ROLE_PHRASES):
        return Intent.CURRENT_ROLE
    if _has_phrase(text, _AWS_WORK_PHRASES):
        return Intent.AWS_WORK
    if _has_phrase(text, _DISTRIBUTED_PHRASES):
        return Intent.DISTRIBUTED_SYSTEMS
    if _has_phrase(text, _TRANSITION_PHRASES):
        return Intent.CAREER_TRANSITION
    return None


def suggested_questions(intent: Intent | None) -> tuple[str, ...]:
    """Return the other original questions, or all of them when nothing matched."""
    return tuple(
        _SUGGESTED_BY_INTENT[item.value]
        for item in _SUGGESTION_ORDER
        if intent is None or item is not intent
    )


def answer_career_question(
    question: str,
    index: CareerIndex | None = None,
    *,
    history: tuple[tuple[str, str], ...] = (),
) -> ExactAnswer | None:
    """Answer one career question from the index, or return no match.

    ``index`` lets tests inject a fixture. The default load uses package data.
    ``history`` is prior user and assistant turns. It changes an answer only when
    the new question refers to the previous topic and the index already has that fact.
    """
    loaded = index if index is not None else load_index()
    intent = recognize_intent(question)
    if intent is not None:
        return _answer_intent(loaded, intent)
    named = _named_experience(loaded, question)
    if named is not None:
        return named
    return _answer_follow_up(loaded, question, history)


def _answer_intent(index: CareerIndex, intent: Intent) -> ExactAnswer:
    if intent is Intent.CURRENT_ROLE:
        return _current_role(index)
    if intent is Intent.EMPLOYMENT_HISTORY:
        return _employment_history(index)
    if intent is Intent.EDUCATION:
        return _education(index)
    if intent is Intent.TECHNOLOGIES:
        return _technologies(index)
    if intent is Intent.AWS_WORK:
        return _aws_work(index)
    if intent is Intent.DISTRIBUTED_SYSTEMS:
        return _distributed_systems(index)
    return _career_transition(index)


def _current_role(index: CareerIndex) -> ExactAnswer:
    profile = _only_profile(index)
    experience = _experience_for_role(index, _string_fact(index, profile.id, "current_role"))
    title = _string_fact(index, experience.id, "role_title")
    employer = _string_fact(index, experience.id, "employer")
    start = _month_label(_string_fact(index, experience.id, "start_date"))
    location = _optional_string_fact(index, experience.id, "location")
    place = f" in {location}" if location else ""
    answer = f"{profile.title} is {title} at {employer}{place}. This role started in {start}."
    return ExactAnswer(
        answer=answer,
        citations=(_citation(index, experience.id, "#role-description"),),
        suggested_questions=suggested_questions(Intent.CURRENT_ROLE),
    )


def _employment_history(index: CareerIndex) -> ExactAnswer:
    profile = _only_profile(index)
    experiences = [doc for doc in index.documents if doc.document_type == "experience"]
    if not experiences:
        raise CareerIndexError("Career index shape is invalid.")
    ordered = sorted(
        experiences,
        key=lambda doc: _string_fact(index, doc.id, "start_date"),
        reverse=True,
    )
    sentences = [_experience_sentence(index, document) for document in ordered]
    citations = [_citation(index, document.id, "#role-description") for document in ordered]
    answer = f"{profile.title} has held these roles, newest first. " + " ".join(sentences)
    return ExactAnswer(
        answer=answer,
        citations=_dedupe(citations),
        suggested_questions=suggested_questions(Intent.EMPLOYMENT_HISTORY),
    )


def _education(index: CareerIndex) -> ExactAnswer:
    profile = _only_profile(index)
    records = [
        document
        for document in index.documents
        if document.document_type == "background"
        and _optional_string_fact(index, document.id, "category") == "education"
    ]
    if not records:
        raise CareerIndexError("Career index shape is invalid.")
    ordered = sorted(
        records,
        key=lambda document: _string_fact(index, document.id, "start_date"),
        reverse=True,
    )
    sentences: list[str] = []
    citations: list[Citation] = []
    awarded: list[bool] = []
    for document in ordered:
        _string_fact(index, document.id, "institution")
        _string_fact(index, document.id, "program")
        _string_fact(index, document.id, "start_date")
        _string_fact(index, document.id, "end_date")
        status = _string_fact(index, document.id, "education_status")
        degree = _single_fact(index, document.id, "degree_awarded").value
        if not isinstance(degree, bool) or status not in {"completed", "attended"}:
            raise CareerIndexError("Career index shape is invalid.")
        degree_text = "A degree was awarded." if degree else "No degree was awarded."
        awarded.append(degree)
        summary = document.summary.strip()
        if degree_text.lower() not in summary.lower():
            summary = f"{summary} {degree_text}"
        sentences.append(summary)
        citations.extend(_citations_for_document(index, document.id))
    if awarded and all(value is False for value in awarded):
        intro = (
            f"{profile.title} does not have a college degree recorded in the "
            "public education documents."
        )
    else:
        intro = f"{profile.title}'s education is described in the public record."
    return ExactAnswer(
        answer=f"{intro} " + " ".join(sentences),
        citations=_dedupe(citations),
        suggested_questions=suggested_questions(Intent.EDUCATION),
    )


def _technologies(index: CareerIndex) -> ExactAnswer:
    profile = _only_profile(index)
    experience = _experience_for_role(index, _string_fact(index, profile.id, "current_role"))
    title = _string_fact(index, experience.id, "role_title")
    employer = _string_fact(index, experience.id, "employer")
    if experience.skills:
        listed = _english_join(experience.skills)
        answer = f"The current role, {title} at {employer}, uses {listed}."
    else:
        answer = f"No technologies are listed for the current role of {title} at {employer}."
    return ExactAnswer(
        answer=answer,
        citations=(_citation(index, experience.id, "#role-description"),),
        suggested_questions=suggested_questions(Intent.TECHNOLOGIES),
    )


def _aws_work(index: CareerIndex) -> ExactAnswer:
    experiences = [
        document
        for document in index.documents
        if document.document_type == "experience"
        and _string_fact(index, document.id, "employer") == "Amazon Web Services"
    ]
    if not experiences:
        raise CareerIndexError("Career index shape is invalid.")
    return _roles_answer(index, experiences, Intent.AWS_WORK)


def _distributed_systems(index: CareerIndex) -> ExactAnswer:
    profile = _only_profile(index)
    experience = _experience_for_role(index, _string_fact(index, profile.id, "current_role"))
    headline = _string_fact(index, profile.id, "headline")
    title = _string_fact(index, experience.id, "role_title")
    employer = _string_fact(index, experience.id, "employer")
    answer = (
        f"{profile.title} describes that focus as {headline}. "
        f"The current role is {title} at {employer}. {experience.summary.strip()}"
    )
    return ExactAnswer(
        answer=answer,
        citations=_dedupe(
            [
                *_citations_for_document(index, profile.id),
                _citation(index, experience.id, "#role-description"),
            ]
        ),
        suggested_questions=suggested_questions(Intent.DISTRIBUTED_SYSTEMS),
    )


def _career_transition(index: CareerIndex) -> ExactAnswer:
    experiences = [
        document for document in index.documents if document.document_type == "experience"
    ]
    education = [
        document
        for document in index.documents
        if document.document_type == "background"
        and _optional_string_fact(index, document.id, "category") == "education"
    ]
    ordered = sorted(
        [*experiences, *education],
        key=lambda document: _string_fact(index, document.id, "start_date"),
    )
    if not ordered:
        raise CareerIndexError("Career index shape is invalid.")
    sentences: list[str] = []
    citations: list[Citation] = []
    for document in ordered:
        if document.document_type == "experience":
            sentences.append(_experience_sentence(index, document))
            citations.append(_citation(index, document.id, "#role-description"))
            continue
        degree = _single_fact(index, document.id, "degree_awarded").value
        if not isinstance(degree, bool):
            raise CareerIndexError("Career index shape is invalid.")
        summary = document.summary.strip()
        degree_text = "A degree was awarded." if degree else "No degree was awarded."
        if degree_text.lower() not in summary.lower():
            summary = f"{summary} {degree_text}"
        sentences.append(summary)
        citations.extend(_citations_for_document(index, document.id))
    return ExactAnswer(
        answer="The public record shows this path. " + " ".join(sentences),
        citations=_dedupe(citations),
        suggested_questions=suggested_questions(Intent.CAREER_TRANSITION),
    )


def _named_experience(index: CareerIndex, question: str) -> ExactAnswer | None:
    text = f" {normalize_question(question)} "
    experiences = [
        document for document in index.documents if document.document_type == "experience"
    ]
    title_matches: list[IndexedDocument] = []
    employer_matches: list[IndexedDocument] = []
    for document in experiences:
        title = normalize_question(_string_fact(index, document.id, "role_title"))
        employer = normalize_question(_string_fact(index, document.id, "employer"))
        if title != "" and f" {title} " in text:
            title_matches.append(document)
        elif employer != "" and f" {employer} " in text:
            employer_matches.append(document)
    if title_matches:
        chosen = max(
            title_matches,
            key=lambda document: len(_string_fact(index, document.id, "role_title")),
        )
        return _roles_answer(index, [chosen], None)
    if not employer_matches:
        return None
    return _roles_answer(index, employer_matches, None)


def _answer_follow_up(
    index: CareerIndex,
    question: str,
    history: tuple[tuple[str, str], ...],
) -> ExactAnswer | None:
    prior = _prior_intent(history)
    if prior is None:
        return None
    text = f" {normalize_question(question)} "
    if prior is Intent.CURRENT_ROLE and _has_phrase(text, _DURATION_PHRASES):
        return _current_role_duration(index)
    if prior is Intent.CURRENT_ROLE and _has_phrase(text, _WHERE_PHRASES):
        return _current_role_place(index)
    if prior is Intent.CURRENT_ROLE and _has_phrase(text, _DETAIL_PHRASES):
        return _current_role_detail(index)
    if prior is Intent.EDUCATION and _has_phrase(text, _STUDY_PHRASES):
        return _education(index)
    return None


def _prior_intent(history: tuple[tuple[str, str], ...]) -> Intent | None:
    for role, content in reversed(history):
        if role == "user":
            return recognize_intent(content)
    return None


def _current_role_duration(index: CareerIndex) -> ExactAnswer:
    profile = _only_profile(index)
    experience = _experience_for_role(index, _string_fact(index, profile.id, "current_role"))
    title = _string_fact(index, experience.id, "role_title")
    employer = _string_fact(index, experience.id, "employer")
    start = _month_label(_string_fact(index, experience.id, "start_date"))
    end = _single_fact(index, experience.id, "end_date").value
    if end is None:
        when = f"since {start}"
        verb = "has been"
    elif isinstance(end, str) and end != "":
        when = f"from {start} to {_month_label(end)}"
        verb = "was"
    else:
        raise CareerIndexError("Career index shape is invalid.")
    return ExactAnswer(
        answer=f"{profile.title} {verb} {title} at {employer} {when}.",
        citations=(_citation(index, experience.id, "#role-description"),),
        suggested_questions=suggested_questions(Intent.CURRENT_ROLE),
    )


def _current_role_place(index: CareerIndex) -> ExactAnswer | None:
    profile = _only_profile(index)
    experience = _experience_for_role(index, _string_fact(index, profile.id, "current_role"))
    location = _optional_string_fact(index, experience.id, "location")
    if location is None:
        return None
    return ExactAnswer(
        answer=f"That role is based in {location}.",
        citations=(_citation(index, experience.id, "#role-description"),),
        suggested_questions=suggested_questions(Intent.CURRENT_ROLE),
    )


def _current_role_detail(index: CareerIndex) -> ExactAnswer:
    profile = _only_profile(index)
    experience = _experience_for_role(index, _string_fact(index, profile.id, "current_role"))
    return ExactAnswer(
        answer=f"The public summary of that role is: {experience.summary.strip()}",
        citations=(_citation(index, experience.id, "#role-description"),),
        suggested_questions=suggested_questions(Intent.CURRENT_ROLE),
    )


def _roles_answer(
    index: CareerIndex,
    documents: list[IndexedDocument],
    intent: Intent | None,
) -> ExactAnswer:
    ordered = sorted(
        documents,
        key=lambda document: _string_fact(index, document.id, "start_date"),
        reverse=True,
    )
    return ExactAnswer(
        answer=" ".join(_experience_sentence(index, document) for document in ordered),
        citations=_dedupe(
            [_citation(index, document.id, "#role-description") for document in ordered]
        ),
        suggested_questions=suggested_questions(intent),
    )


def _experience_sentence(index: CareerIndex, document: IndexedDocument) -> str:
    title = _string_fact(index, document.id, "role_title")
    employer = _string_fact(index, document.id, "employer")
    start = _month_label(_string_fact(index, document.id, "start_date"))
    end = _single_fact(index, document.id, "end_date").value
    location = _optional_string_fact(index, document.id, "location")
    place = f" in {location}" if location else ""
    if end is None:
        when = f"since {start}"
    elif isinstance(end, str) and end != "":
        when = f"from {start} to {_month_label(end)}"
    else:
        raise CareerIndexError("Career index shape is invalid.")
    return f"As {title} at {employer}{place} {when}: {document.summary.strip()}"


def _month_label(value: str) -> str:
    match = re.fullmatch(r"(\d{4})-(0[1-9]|1[0-2])", value)
    if match is None:
        return value
    return f"{_MONTHS[int(match.group(2)) - 1]} {match.group(1)}"


def _english_join(items: tuple[str, ...]) -> str:
    values = list(items)
    if len(values) <= 1:
        return "".join(values)
    if len(values) == 2:
        return f"{values[0]} and {values[1]}"
    return f"{', '.join(values[:-1])}, and {values[-1]}"


def _experience_for_role(index: CareerIndex, role_id: str) -> IndexedDocument:
    document = _document(index, role_id)
    if document.document_type != "experience":
        raise CareerIndexError("Career index shape is invalid.")
    return document


def _only_profile(index: CareerIndex) -> IndexedDocument:
    profiles = [document for document in index.documents if document.document_type == "profile"]
    if len(profiles) != 1:
        raise CareerIndexError("Career index shape is invalid.")
    return profiles[0]


def _document(index: CareerIndex, document_id: str) -> IndexedDocument:
    matches = [document for document in index.documents if document.id == document_id]
    if len(matches) != 1:
        raise CareerIndexError("Career index shape is invalid.")
    return matches[0]


def _string_fact(index: CareerIndex, document_id: str, kind: str) -> str:
    value = _single_fact(index, document_id, kind).value
    if not isinstance(value, str) or value == "":
        raise CareerIndexError("Career index shape is invalid.")
    return value


def _optional_string_fact(index: CareerIndex, document_id: str, kind: str) -> str | None:
    matches = _facts(index, document_id, kind)
    if not matches:
        return None
    if len(matches) != 1 or not isinstance(matches[0].value, str) or matches[0].value == "":
        raise CareerIndexError("Career index shape is invalid.")
    return matches[0].value


def _single_fact(index: CareerIndex, document_id: str, kind: str) -> CareerFact:
    matches = _facts(index, document_id, kind)
    if len(matches) != 1:
        raise CareerIndexError("Career index shape is invalid.")
    return matches[0]


def _facts(index: CareerIndex, document_id: str, kind: str) -> list[CareerFact]:
    return [fact for fact in index.facts if fact.document_id == document_id and fact.kind == kind]


def _citation(index: CareerIndex, document_id: str, heading: str) -> Citation:
    matches = [
        source
        for source in index.sources
        if source.document_id == document_id and source.url.endswith(heading)
    ]
    if len(matches) != 1:
        raise CareerIndexError("Career index shape is invalid.")
    return _citation_from_source(matches[0])


def _citations_for_document(index: CareerIndex, document_id: str) -> list[Citation]:
    matches = [source for source in index.sources if source.document_id == document_id]
    if not matches:
        raise CareerIndexError("Career index shape is invalid.")
    return [_citation_from_source(source) for source in matches]


def _citation_from_source(source: CareerSource) -> Citation:
    return Citation(
        chunk_id=source.chunk_id,
        document_id=source.document_id,
        title=source.title,
        section=source.section,
        url=source.url,
        document_type=source.document_type,
        roles=source.roles,
        skills=source.skills,
    )


def _dedupe(citations: list[Citation]) -> tuple[Citation, ...]:
    seen: set[str] = set()
    ordered: list[Citation] = []
    for citation in citations:
        if citation.url in seen:
            continue
        seen.add(citation.url)
        ordered.append(citation)
    return tuple(ordered)


def _has_phrase(padded_text: str, phrases: tuple[str, ...]) -> bool:
    return any(f" {phrase} " in padded_text for phrase in phrases)
