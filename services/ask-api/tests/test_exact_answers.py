from ask_api.exact_answers import (
    FALLBACK_ANSWER,
    Intent,
    answer_career_question,
    normalize_question,
    recognize_intent,
    suggested_questions,
)
from ask_api.index_loader import (
    CareerFact,
    CareerIndex,
    CareerSource,
    IndexedDocument,
    JsonValue,
    load_index,
)

CURRENT_ROLE = "/experience/aws-sde-ii#role-description"
BLOOMTECH = "/background/bloomtech-backend-development#program"
SIERRA = "/background/sierra-college-general-studies#coursework"


def test_current_role_paraphrases_match() -> None:
    questions = [
        "What is Lucas's current role?",
        "What does Lucas do now?",
        "Where does Lucas work?",
        "What is your current job?",
        "  WHAT IS LUCAS\u2019S CURRENT ROLE??? ",
    ]
    assert all(recognize_intent(question) is Intent.CURRENT_ROLE for question in questions)


def test_employment_history_paraphrases_match() -> None:
    questions = [
        "Where has Lucas worked?",
        "What is Lucas's work history?",
        "Show me your employment history.",
        "where have you worked?",
    ]
    assert all(recognize_intent(question) is Intent.EMPLOYMENT_HISTORY for question in questions)


def test_education_paraphrases_match() -> None:
    questions = [
        "Does Lucas have a college degree?",
        "Did Lucas graduate from college?",
        "What is your education?",
        "Where did Lucas go to school?",
    ]
    assert all(recognize_intent(question) is Intent.EDUCATION for question in questions)


def test_technology_paraphrases_match() -> None:
    questions = [
        "What technologies does Lucas use?",
        "What is Lucas's tech stack?",
        "What programming languages do you work with?",
        "What AWS services does Lucas use?",
    ]
    assert all(recognize_intent(question) is Intent.TECHNOLOGIES for question in questions)


def test_unrelated_questions_do_not_match() -> None:
    questions = [
        "What is the weather in Seattle?",
        "Tell me a joke.",
        "What does the fictional buoy do?",
        "How do I deploy this site?",
    ]
    assert all(recognize_intent(question) is None for question in questions)
    assert normalize_question("  What is Lucas's current role? ") == "what is lucas current role"


def test_current_role_follows_the_profile_reference() -> None:
    result = answer_career_question("What is your current job?", _fixture_index())

    assert result is not None
    assert result.answer == (
        "Fixture Person is Fixture Title at Fixture Employer in Fixture Place. "
        "This role started in January 1999."
    )
    assert result.citations[0].document_id == "made-up-role"
    assert "aws-sde-ii" not in result.answer


def test_real_current_role_comes_from_the_index() -> None:
    result = answer_career_question("What is Lucas's current role?")

    assert result is not None
    assert result.answer == (
        "Lucas Elia is Software Development Engineer II at Amazon Web Services in Seattle, WA. "
        "This role started in December 2025."
    )
    assert [citation.url for citation in result.citations] == [CURRENT_ROLE]
    assert result.suggested_questions == suggested_questions(Intent.CURRENT_ROLE)
    assert "What is Lucas's current role?" not in result.suggested_questions


def test_employment_history_is_sorted_and_omits_unknown_locations() -> None:
    result = answer_career_question("Where has Lucas worked?")

    assert result is not None
    titles = [
        "Software Development Engineer II",
        "Software Development Engineer I",
        "Software Development Engineer Apprentice",
        "Java Developer, Office 365 & SharePoint Consultant",
        "Co-Founder",
    ]
    positions = [result.answer.index(title) for title in titles]
    assert positions == sorted(positions)
    assert (
        "Java Developer, Office 365 & SharePoint Consultant at Expert Assist "
        "from June 2022 to October 2022:" in result.answer
    )
    assert "Expert Assist, 2022-06 to 2022-10," not in result.answer
    assert "public employment history" not in result.answer
    assert [citation.url for citation in result.citations] == [
        "/experience/aws-sde-ii#role-description",
        "/experience/aws-sde-i#role-description",
        "/experience/aws-sde-apprentice#role-description",
        "/experience/expert-assist-consultant#role-description",
        "/experience/hospitality-businesses-co-founder#role-description",
    ]


def test_education_does_not_claim_a_degree() -> None:
    result = answer_career_question("Does Lucas have a college degree?")

    assert result is not None
    assert "does not have a college degree" in result.answer
    assert "BloomTech’s Backend Development program" in result.answer
    assert "Sierra College" in result.answer
    assert "approximately two years" in result.answer
    assert result.answer.count("No degree was awarded.") >= 2
    assert "A degree was awarded." not in result.answer
    assert [citation.url for citation in result.citations] == [BLOOMTECH, SIERRA]


def test_technologies_come_from_the_current_role_skills() -> None:
    fixture = answer_career_question("What is your tech stack?", _fixture_index())
    assert fixture is not None
    assert "OnlySyntheticSkill" in fixture.answer
    assert "Java" not in fixture.answer
    assert fixture.citations[0].document_id == "made-up-role"

    result = answer_career_question("What technologies does Lucas use?")
    index = load_index()
    current = next(document for document in index.documents if document.id == "aws-sde-ii")
    assert result is not None
    for skill in current.skills:
        assert skill in result.answer
    assert [citation.url for citation in result.citations] == [CURRENT_ROLE]


def test_duplicate_citations_keep_the_first_url() -> None:
    index = _fixture_index(duplicate_source=True)
    result = answer_career_question("What is your education?", index)

    assert result is not None
    assert [citation.url for citation in result.citations] == ["/background/fixture-school#program"]


def test_follow_up_uses_the_previous_question() -> None:
    history = (
        ("user", "What is Lucas's current role?"),
        ("assistant", "Lucas Elia is Software Development Engineer II."),
    )
    result = answer_career_question("How long has he been in that role?", history=history)

    assert result is not None
    assert "December 2025" in result.answer
    assert "2025-12" not in result.answer
    assert answer_career_question("How long has he been in that role?") is None


def test_named_role_uses_the_public_summary() -> None:
    result = answer_career_question("What did he do at Expert Assist?")

    assert result is not None
    assert "electric-vehicle charging application" in result.answer
    assert [citation.url for citation in result.citations] == [
        "/experience/expert-assist-consultant#role-description"
    ]


def test_reliability_question_is_not_invented() -> None:
    assert answer_career_question("How has he improved production reliability?") is None


def test_unsupported_question_has_no_answer() -> None:
    assert answer_career_question("What is the weather in Seattle?") is None
    assert FALLBACK_ANSWER == (
        "I don't have anything on that in Lucas's career pages. "
        "You can ask about his roles at AWS, what he's worked on, or his education."
    )


def _fixture_index(*, duplicate_source: bool = False) -> CareerIndex:
    profile = _document(
        "fixture-person",
        "profile",
        "Fixture Person",
        "/profile/fixture-person",
        skills=(),
    )
    role = _document(
        "made-up-role",
        "experience",
        "Fixture Title",
        "/experience/made-up-role",
        skills=("OnlySyntheticSkill",),
        location="Fixture Place",
    )
    school = _document(
        "fixture-school",
        "background",
        "Fixture Program",
        "/background/fixture-school",
        skills=(),
        summary="Completed a fictional program. No degree was awarded.",
    )
    facts = [
        _fact("current_role", "made-up-role", profile.id),
        _fact("role_title", "Fixture Title", role.id),
        _fact("employer", "Fixture Employer", role.id),
        _fact("start_date", "1999-01", role.id),
        _fact("end_date", None, role.id),
        _fact("location", "Fixture Place", role.id),
        _fact("category", "education", school.id),
        _fact("institution", "Fixture School", school.id),
        _fact("program", "Fixture Program", school.id),
        _fact("start_date", "2001-01", school.id),
        _fact("end_date", "2002-01", school.id),
        _fact("education_status", "completed", school.id),
        _fact("degree_awarded", False, school.id),
    ]
    sources = [
        _source(role, "role-description", "Role Description"),
        _source(school, "program", "Program"),
    ]
    if duplicate_source:
        sources.append(_source(school, "program", "Program"))
    return CareerIndex(
        schema_version=1,
        documents=(profile, role, school),
        facts=tuple(facts),
        sources=tuple(sources),
    )


def _document(
    document_id: str,
    document_type: str,
    title: str,
    url: str,
    *,
    skills: tuple[str, ...],
    summary: str = "Fixture summary.",
    location: str | None = None,
) -> IndexedDocument:
    values: dict[str, JsonValue] = {
        "id": document_id,
        "type": document_type,
        "title": title,
        "summary": summary,
        "skills": list(skills),
        "url": url,
        "visibility": "public",
    }
    if location is not None:
        values["location"] = location
    return IndexedDocument(
        id=document_id,
        document_type=document_type,
        title=title,
        summary=summary,
        skills=skills,
        url=url,
        visibility="public",
        values=values,
    )


def _fact(kind: str, value: str | bool | None, document_id: str) -> CareerFact:
    return CareerFact(kind=kind, value=value, document_id=document_id, url=f"/{document_id}")


def _source(document: IndexedDocument, heading: str, section: str) -> CareerSource:
    return CareerSource(
        chunk_id=f"{document.id}:{heading}:0",
        document_id=document.id,
        title=document.title,
        section=section,
        url=f"{document.url}#{heading}",
        document_type=document.document_type,
        roles=(),
        skills=document.skills,
    )
