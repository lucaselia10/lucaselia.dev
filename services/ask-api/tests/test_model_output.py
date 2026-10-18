import pytest

from ask_api.grounding_errors import MalformedGeneratedOutput
from ask_api.model_output import (
    MAX_ANSWER_LENGTH,
    MAX_SUGGESTED_QUESTIONS,
    TOOL_NAME,
    converse_tool_spec,
    validate_grounded_tool_input,
)


def test_valid_tool_input_is_accepted() -> None:
    answer, cited, suggestions = validate_grounded_tool_input(
        {
            "answer": "Lucas builds public backend systems.",
            "citedChunkIds": ["aws-sde-ii:role-description:0"],
            "suggestedQuestions": ["Where has Lucas worked?"],
        }
    )

    assert answer == "Lucas builds public backend systems."
    assert cited == ("aws-sde-ii:role-description:0",)
    assert suggestions == ("Where has Lucas worked?",)
    spec = converse_tool_spec()
    tool = spec["toolSpec"]
    assert isinstance(tool, dict)
    assert tool["name"] == TOOL_NAME


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"answer": "x", "citedChunkIds": ["a"], "suggestedQuestions": [], "extra": True},
        {"answer": "   ", "citedChunkIds": ["a"], "suggestedQuestions": []},
        {"answer": "", "citedChunkIds": ["a"], "suggestedQuestions": []},
        {"answer": "x", "citedChunkIds": [], "suggestedQuestions": []},
        {"answer": "x", "citedChunkIds": ["a", "a"], "suggestedQuestions": []},
        {"answer": "x", "citedChunkIds": [""], "suggestedQuestions": []},
        {"answer": "x" * (MAX_ANSWER_LENGTH + 1), "citedChunkIds": ["a"], "suggestedQuestions": []},
        {
            "answer": "x",
            "citedChunkIds": ["a"],
            "suggestedQuestions": ["q"] * (MAX_SUGGESTED_QUESTIONS + 1),
        },
        {"answer": 1, "citedChunkIds": ["a"], "suggestedQuestions": []},
    ],
)
def test_malformed_tool_input_is_rejected(payload: object) -> None:
    with pytest.raises(MalformedGeneratedOutput) as caught:
        validate_grounded_tool_input(payload)
    assert str(caught.value) == "Generated output is malformed."
