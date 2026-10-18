"""Structured output contract for a future Bedrock Converse tool call.

The orchestration service validates this shape. It does not build the Converse
request. No model is called from this module.
"""

from __future__ import annotations

from typing import cast

from ask_api.grounding_errors import MalformedGeneratedOutput

TOOL_NAME = "submit_grounded_answer"
MAX_ANSWER_LENGTH = 4000
MAX_CITED_CHUNK_IDS = 5
MAX_CHUNK_ID_LENGTH = 200
MAX_SUGGESTED_QUESTIONS = 4
MAX_SUGGESTED_QUESTION_LENGTH = 240

GROUNDED_ANSWER_INPUT_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["answer", "citedChunkIds", "suggestedQuestions"],
    "properties": {
        "answer": {
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_ANSWER_LENGTH,
        },
        "citedChunkIds": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_CITED_CHUNK_IDS,
            "uniqueItems": True,
            "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_CHUNK_ID_LENGTH,
            },
        },
        "suggestedQuestions": {
            "type": "array",
            "minItems": 0,
            "maxItems": MAX_SUGGESTED_QUESTIONS,
            "uniqueItems": True,
            "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_SUGGESTED_QUESTION_LENGTH,
            },
        },
    },
}


def converse_tool_spec() -> dict[str, object]:
    """Return the forced-tool definition a future Converse request can attach."""
    return {
        "toolSpec": {
            "name": TOOL_NAME,
            "description": (
                "Submit a concise third-person answer about Lucas Elia using only "
                "the retrieved public sources."
            ),
            "inputSchema": {"json": GROUNDED_ANSWER_INPUT_SCHEMA},
        }
    }


def validate_grounded_tool_input(value: object) -> tuple[str, tuple[str, ...], tuple[str, ...]]:
    """Accept one tool input object, or reject it without echoing the payload."""
    record = _object(value)
    if set(record) != {"answer", "citedChunkIds", "suggestedQuestions"}:
        raise MalformedGeneratedOutput()
    answer = _bounded_text(record.get("answer"), MAX_ANSWER_LENGTH)
    if answer.strip() == "":
        raise MalformedGeneratedOutput()
    cited = _unique_strings(
        record.get("citedChunkIds"), 1, MAX_CITED_CHUNK_IDS, MAX_CHUNK_ID_LENGTH
    )
    suggestions = _unique_strings(
        record.get("suggestedQuestions"),
        0,
        MAX_SUGGESTED_QUESTIONS,
        MAX_SUGGESTED_QUESTION_LENGTH,
    )
    return answer.strip(), cited, suggestions


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise MalformedGeneratedOutput()
    mapped: dict[str, object] = {}
    for key, item in cast(dict[object, object], value).items():
        if not isinstance(key, str):
            raise MalformedGeneratedOutput()
        mapped[key] = item
    return mapped


def _bounded_text(value: object, limit: int) -> str:
    if not isinstance(value, str) or value == "" or len(value) > limit:
        raise MalformedGeneratedOutput()
    return value


def _unique_strings(value: object, minimum: int, maximum: int, item_limit: int) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise MalformedGeneratedOutput()
    items = cast(list[object], value)
    if len(items) < minimum or len(items) > maximum:
        raise MalformedGeneratedOutput()
    seen: set[str] = set()
    ordered: list[str] = []
    for item in items:
        if not isinstance(item, str) or item.strip() == "" or len(item) > item_limit:
            raise MalformedGeneratedOutput()
        if item in seen:
            raise MalformedGeneratedOutput()
        seen.add(item)
        ordered.append(item)
    return tuple(ordered)
