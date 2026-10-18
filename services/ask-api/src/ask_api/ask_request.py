"""Validation of an ask request body.

The exact-answer Lambda handler, the development server, and the production app share
this. It has no dependency on model code.
"""

from __future__ import annotations

from typing import cast

ALLOWED_MODES = frozenset({"career_question", "job_comparison"})
ALLOWED_ROLES = frozenset({"user", "assistant"})
REQUEST_FIELDS = frozenset({"question", "mode", "history"})
MESSAGE_FIELDS = frozenset({"role", "content"})
MAX_TEXT_LENGTH = 8000
MAX_HISTORY_MESSAGES = 20


class RequestError(Exception):
    """A caller-facing validation failure with an HTTP status code."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def validated_ask_request(
    payload: dict[str, object],
) -> tuple[str, str, tuple[tuple[str, str], ...]]:
    """Validate an ask body and return the question, mode, and history."""
    unsupported = sorted(set(payload) - REQUEST_FIELDS)
    if unsupported:
        names = ", ".join(unsupported)
        raise RequestError(f"Request contains unsupported fields: {names}.")

    question = payload.get("question")
    if not isinstance(question, str) or question.strip() == "":
        raise RequestError("question is required.")
    if len(question) > MAX_TEXT_LENGTH:
        raise RequestError("question is too long.")

    mode = payload.get("mode")
    if not isinstance(mode, str) or mode not in ALLOWED_MODES:
        raise RequestError("mode must be career_question or job_comparison.")

    history: tuple[tuple[str, str], ...] = ()
    if "history" in payload:
        history = _validate_history(payload["history"])

    return question, mode, history


def _validate_history(history: object) -> tuple[tuple[str, str], ...]:
    messages = object_list(history)
    if messages is None:
        raise RequestError("history must be an array.")
    if len(messages) > MAX_HISTORY_MESSAGES:
        raise RequestError("history must contain at most 20 messages.")

    parsed: list[tuple[str, str]] = []
    for index, item in enumerate(messages):
        message = string_key_dict(item)
        if message is None:
            raise RequestError(f"history[{index}] must be an object.")
        unsupported = sorted(set(message) - MESSAGE_FIELDS)
        if unsupported:
            raise RequestError(f"history[{index}] contains unsupported fields.")
        role = message.get("role")
        content = message.get("content")
        if not isinstance(role, str) or role not in ALLOWED_ROLES:
            raise RequestError(f"history[{index}].role must be user or assistant.")
        if not isinstance(content, str):
            raise RequestError(f"history[{index}].content must be a string.")
        if len(content) > MAX_TEXT_LENGTH:
            raise RequestError(f"history[{index}].content is too long.")
        parsed.append((role, content))
    return tuple(parsed)


def string_key_dict(value: object) -> dict[str, object] | None:
    """The value as a dict with string keys, or None."""
    if not isinstance(value, dict):
        return None
    raw = cast(dict[object, object], value)
    mapped: dict[str, object] = {}
    for key, item in raw.items():
        if not isinstance(key, str):
            return None
        mapped[key] = item
    return mapped


def object_list(value: object) -> list[object] | None:
    """The value as a list, or None."""
    if not isinstance(value, list):
        return None
    return cast(list[object], value)
