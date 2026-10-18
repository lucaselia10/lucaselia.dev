from collections.abc import Sequence

from ask_api.exact_answers import FALLBACK_ANSWER
from ask_api.grounding import (
    MAX_RETRIEVAL_CHUNKS,
    GroundedAnswerDraft,
    GroundedAnswerService,
    RetrievedChunk,
)
from ask_api.grounding_errors import (
    GenerationUnavailable,
    MalformedGeneratedOutput,
    RetrievalUnavailable,
    UngroundedGeneratedOutput,
)
from ask_api.grounding_prompt import GROUNDING_PROMPT_VERSION, GROUNDING_SYSTEM_PROMPT


def test_exact_recognition_is_separate_from_grounding() -> None:
    from ask_api.exact_answers import Intent, answer_career_question, recognize_intent

    assert recognize_intent("What is Lucas's current role?") is Intent.CURRENT_ROLE
    assert recognize_intent("What is Lucas's favorite color?") is None
    assert answer_career_question("What is Lucas's favorite color?") is None


def test_no_chunks_returns_the_existing_unsupported_answer() -> None:
    generator = _Generator()
    service = GroundedAnswerService(_Retriever(()), generator)
    result = service.answer("What is Lucas's favorite color?")

    assert generator.calls == 0
    assert result.answer == FALLBACK_ANSWER
    assert result.citations == ()
    assert result.suggested_questions


def test_citations_come_from_retrieved_chunks_in_model_order() -> None:
    first = _chunk("alpha:about:0", "/profile/alpha#about", "Alpha")
    second = _chunk("beta:role:0", "/experience/beta#role", "Beta")
    service = GroundedAnswerService(
        _Retriever((second, first)),
        _Generator(
            GroundedAnswerDraft(
                answer="Alpha then beta.",
                cited_chunk_ids=("alpha:about:0", "beta:role:0"),
                suggested_questions=("Where has Lucas worked?",),
            )
        ),
    )
    result = service.answer("Tell me about the public work.")

    assert [citation.chunk_id for citation in result.citations] == ["alpha:about:0", "beta:role:0"]
    assert result.citations[0].url == "/profile/alpha#about"
    assert result.citations[0].title == "Alpha"
    assert result.suggested_questions == ("Where has Lucas worked?",)


def test_unknown_citation_is_ungrounded_and_duplicates_are_malformed() -> None:
    chunk = _chunk("alpha:about:0", "/profile/alpha#about", "Alpha")
    unknown = GroundedAnswerService(
        _Retriever((chunk,)),
        _Generator(
            GroundedAnswerDraft(
                answer="Invented.",
                cited_chunk_ids=("missing:chunk:0",),
                suggested_questions=(),
            )
        ),
    )
    duplicate = GroundedAnswerService(
        _Retriever((chunk,)),
        _Generator(
            GroundedAnswerDraft(
                answer="Repeated.",
                cited_chunk_ids=("alpha:about:0", "alpha:about:0"),
                suggested_questions=(),
            )
        ),
    )

    try:
        unknown.answer("question")
    except UngroundedGeneratedOutput as error:
        assert str(error) == "Generated output is not grounded."
        assert "missing" not in str(error)
    else:
        raise AssertionError("expected ungrounded output")

    try:
        duplicate.answer("question")
    except MalformedGeneratedOutput:
        pass
    else:
        raise AssertionError("expected malformed output")


def test_retrieval_and_generation_failures_hide_provider_text() -> None:
    class BoomRetriever:
        def retrieve(self, question: str, limit: int) -> Sequence[RetrievedChunk]:
            del question, limit
            raise RuntimeError("/secret/career-index.json")

    class BoomGenerator:
        def generate(self, question: str, chunks: Sequence[RetrievedChunk]) -> GroundedAnswerDraft:
            del question, chunks
            raise RuntimeError("model prompt leaked")

    try:
        GroundedAnswerService(BoomRetriever(), _Generator()).answer("question")
    except RetrievalUnavailable as error:
        assert str(error) == "Retrieval is unavailable."
        assert "secret" not in str(error)
    else:
        raise AssertionError("expected retrieval failure")

    try:
        GroundedAnswerService(
            _Retriever((_chunk("a:b:0", "/profile/a#b", "A"),)), BoomGenerator()
        ).answer("question")
    except GenerationUnavailable as error:
        assert "prompt" not in str(error)
    else:
        raise AssertionError("expected generation failure")


def test_retrieval_is_capped_at_five_chunks() -> None:
    chunks = tuple(
        _chunk(f"doc-{index}:section:0", f"/profile/doc-{index}#section", f"Doc {index}")
        for index in range(6)
    )
    retriever = _Retriever(chunks)
    generator = _Generator(
        GroundedAnswerDraft(
            answer="Capped.",
            cited_chunk_ids=(chunks[0].chunk_id,),
            suggested_questions=(),
        )
    )
    result = GroundedAnswerService(retriever, generator).answer("question")

    assert retriever.limits == [MAX_RETRIEVAL_CHUNKS]
    assert generator.seen_chunk_counts == [MAX_RETRIEVAL_CHUNKS]
    assert result.answer == "Capped."
    assert len(result.citations) == 1


def test_prompt_is_versioned_and_does_not_add_private_facts() -> None:
    assert GROUNDING_PROMPT_VERSION == "3"
    assert "Prompt version: 3" in GROUNDING_SYSTEM_PROMPT
    assert "submit_grounded_answer" in GROUNDING_SYSTEM_PROMPT
    assert "third person" in GROUNDING_SYSTEM_PROMPT
    assert "private" not in GROUNDING_SYSTEM_PROMPT.lower()
    assert FALLBACK_ANSWER in GROUNDING_SYSTEM_PROMPT
    assert "does not yet support" not in GROUNDING_SYSTEM_PROMPT
    assert "lead with what they support" in GROUNDING_SYSTEM_PROMPT


class _Retriever:
    def __init__(self, chunks: Sequence[RetrievedChunk]) -> None:
        self.chunks = tuple(chunks)
        self.limits: list[int] = []

    def retrieve(self, question: str, limit: int) -> Sequence[RetrievedChunk]:
        del question
        self.limits.append(limit)
        return self.chunks


class _Generator:
    def __init__(self, draft: GroundedAnswerDraft | None = None) -> None:
        self.draft = draft
        self.calls = 0
        self.seen_chunk_counts: list[int] = []

    def generate(self, question: str, chunks: Sequence[RetrievedChunk]) -> GroundedAnswerDraft:
        del question
        self.calls += 1
        self.seen_chunk_counts.append(len(chunks))
        if self.draft is None:
            raise AssertionError("generator should not be called")
        return self.draft


def _chunk(chunk_id: str, url: str, title: str) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        document_id=chunk_id.split(":", 1)[0],
        title=title,
        section="Section",
        url=url,
        document_type="profile",
        text="Public text.",
        score=0.5,
    )
