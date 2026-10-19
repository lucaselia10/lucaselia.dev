"""Answer-wording rules in the local-4 prompt, which production also uses (ADR-009).

Each rule comes from an answer observed in the October 14, 2026 live recheck; the observed
wording is recorded in tests/evaluation/README.md. These tests check the prompts, not model
output: wording is judged in live runs.
"""

from __future__ import annotations

from ask_api.answer_style import ANSWER_STYLE_RULES
from ask_api.local_conversation import LOCAL_SYSTEM_PROMPT


def test_the_prompt_carries_the_shared_style_rules() -> None:
    assert ANSWER_STYLE_RULES in LOCAL_SYSTEM_PROMPT


def test_answers_never_name_the_evidence_or_the_data() -> None:
    # Observed: "The evidence does not specify which tools..."
    for term in ('"the evidence"', '"the data"', '"the context"', '"the sources"'):
        assert term in ANSWER_STYLE_RULES
    assert "never about" in ANSWER_STYLE_RULES
    assert "Write about Lucas's career pages" in ANSWER_STYLE_RULES


def test_partial_answers_lead_with_support_and_state_the_gap_once() -> None:
    # Target: "His SDE II role lists ECS, AWS Batch, Step Functions, and CloudWatch among its
    # technologies, though his pages don't say which ones he used for the reliability work."
    rules = " ".join(ANSWER_STYLE_RULES.split())
    assert "lead with what they support, then state the gap in one short clause" in rules
    assert "Do not restate an earlier answer." in rules


def test_a_negative_shared_by_several_pages_becomes_one_clause() -> None:
    # Observed in the October 18, 2026 production evaluation: "no degree awarded" twice, once
    # per education page, because each page's Facts block says "Degree awarded: no".
    rules = " ".join(ANSWER_STYLE_RULES.split())
    assert "State each negative fact once, even when several pages support it." in rules
    assert "combine them into one clause for the whole answer" in rules
    assert 'such as "He has not earned a degree," and do not repeat it for each page.' in rules
    # The rule ships in the prompt production sends, under the bumped version.
    assert rules in " ".join(LOCAL_SYSTEM_PROMPT.split())
    assert LOCAL_SYSTEM_PROMPT.startswith("Prompt version: local-4")


def test_negatives_are_stated_once() -> None:
    # Observed: "with no degree awarded" twice in one answer.
    assert "State each negative fact once" in ANSWER_STYLE_RULES
    rules = " ".join(ANSWER_STYLE_RULES.split())
    assert "When the answer to a yes-or-no question is no, say so in one short clause" in rules


def test_no_interpretations_beyond_the_pages() -> None:
    # Observed: the SDE I test suites "contributed to reliability foundations".
    rules = " ".join(ANSWER_STYLE_RULES.split())
    assert (
        "Do not add interpretations, conclusions, or characterizations the pages do not state"
        in (rules)
    )


def test_the_style_rules_are_wording_only() -> None:
    """Grounding still lives in the prompt; the style block cannot loosen it."""
    assert "third person" in LOCAL_SYSTEM_PROMPT
    assert "Do not infer facts the evidence does not state." in LOCAL_SYSTEM_PROMPT
