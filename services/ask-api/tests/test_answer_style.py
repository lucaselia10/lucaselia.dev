"""Answer-wording rules, shared by the local and production prompts.

Each rule comes from an answer observed in the October 14, 2026 live recheck; the observed
wording is recorded in tests/evaluation/README.md. These tests check the prompts, not model
output: wording is judged in live runs.
"""

from __future__ import annotations

import pytest

from ask_api.answer_style import ANSWER_STYLE_RULES
from ask_api.grounding_prompt import GROUNDING_SYSTEM_PROMPT
from ask_api.local_conversation import LOCAL_SYSTEM_PROMPT

PROMPTS = {"local": LOCAL_SYSTEM_PROMPT, "production": GROUNDING_SYSTEM_PROMPT}


@pytest.mark.parametrize("name", PROMPTS)
def test_both_prompts_carry_the_shared_style_rules(name: str) -> None:
    assert ANSWER_STYLE_RULES in PROMPTS[name]


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


def test_negatives_are_stated_once() -> None:
    # Observed: "with no degree awarded" twice in one answer.
    assert "State each negative fact once." in ANSWER_STYLE_RULES
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
    """Grounding still lives in each prompt; the style block cannot loosen it."""
    for prompt in PROMPTS.values():
        assert "third person" in prompt
    assert "Do not infer facts the evidence does not state." in LOCAL_SYSTEM_PROMPT
    assert "Do not infer facts the supplied sources do not support." in GROUNDING_SYSTEM_PROMPT
