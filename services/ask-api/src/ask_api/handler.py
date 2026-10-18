"""Lambda entry point for the career portfolio POST /ask route.

Career questions are answered from the packaged career index when they match a
supported fact or a follow-up to one. History is validated and then used only
for that follow-up. It is not sent to a model, and the response is one JSON
document. Job comparison is accepted and left unimplemented. Exact facts are
resolved before any grounding provider is constructed. Each invocation receives
its own request ID.
"""

from __future__ import annotations

import base64
import json
import uuid
from typing import cast

from ask_api.exact_answers import FALLBACK_ANSWER, answer_career_question, suggested_questions
from ask_api.grounding import CareerAnswerer, PublicCareerAnswer
from ask_api.grounding_factory import configured_grounding_service
from ask_api.index_loader import CareerIndexError

ALLOWED_MODES = frozenset({"career_question", "job_comparison"})
ALLOWED_ROLES = frozenset({"user", "assistant"})
REQUEST_FIELDS = frozenset({"question", "mode", "history"})
MESSAGE_FIELDS = frozenset({"role", "content"})
MAX_TEXT_LENGTH = 8000
MAX_HISTORY_MESSAGES = 20
JOB_COMPARISON_ANSWER = (
    "Job comparison is not implemented. No model was called and no career material was compared."
)
INDEX_UNAVAILABLE = "The career index is unavailable."
ASSISTANT_UNAVAILABLE = "The career assistant is temporarily unavailable."


class RequestError(Exception):
    """A caller-facing validation failure with an HTTP status code."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def handler(
    event: dict[str, object],
    context: object,
    *,
    grounded_service: CareerAnswerer | None = None,
) -> dict[str, object]:
    """Validate a POST /ask event and answer supported career questions.

    Production calls omit ``grounded_service``. Exact facts are returned before
    any retriever or model runs. With grounding disabled, an unmatched question
    keeps today's unsupported answer. A configured provider returns that answer
    when retrieval or generation succeeds without supporting evidence. Provider
    and configuration failures return HTTP 503 and do not describe the failure.
    """
    del context
    request_id = _request_id(event)
    try:
        payload = _payload_from_event(event)
        question, mode, history = _validate_payload(payload)
    except RequestError as error:
        return _json_response(
            error.status_code,
            {"message": str(error), "requestId": request_id},
        )

    if mode == "job_comparison":
        return _json_response(
            200,
            {
                "answer": JOB_COMPARISON_ANSWER,
                "citations": [],
                "suggestedQuestions": [],
                "requestId": request_id,
            },
        )

    try:
        exact = answer_career_question(question, history=history)
    except CareerIndexError:
        return _json_response(
            500,
            {"message": INDEX_UNAVAILABLE, "requestId": request_id},
        )

    if exact is None:
        if grounded_service is None:
            try:
                grounded_service = configured_grounding_service()
            except Exception:
                return _json_response(
                    503,
                    {"message": ASSISTANT_UNAVAILABLE, "requestId": request_id},
                )
        return _answer_without_exact_match(question, grounded_service, request_id)

    return _json_response(
        200,
        {
            "answer": exact.answer,
            "citations": [citation.as_dict() for citation in exact.citations],
            "suggestedQuestions": list(exact.suggested_questions),
            "requestId": request_id,
        },
    )


def _answer_without_exact_match(
    question: str,
    grounded_service: CareerAnswerer | None,
    request_id: str,
) -> dict[str, object]:
    """Answer an unmatched question without confusing failure and missing evidence.

    No configured provider preserves the current unsupported answer. A provider
    that returns an answer, including the validated insufficient-evidence
    sentence, is HTTP 200. Any exception from that provider is HTTP 503.
    """
    if grounded_service is None:
        return _json_response(
            200,
            {
                "answer": FALLBACK_ANSWER,
                "citations": [],
                "suggestedQuestions": list(suggested_questions(None)),
                "requestId": request_id,
            },
        )
    try:
        grounded = grounded_service.answer(question)
    except Exception:
        return _json_response(
            503,
            {"message": ASSISTANT_UNAVAILABLE, "requestId": request_id},
        )
    return _career_answer_response(grounded, request_id)


def _career_answer_response(answer: PublicCareerAnswer, request_id: str) -> dict[str, object]:
    return _json_response(
        200,
        {
            "answer": answer.answer,
            "citations": [citation.as_dict() for citation in answer.citations],
            "suggestedQuestions": list(answer.suggested_questions),
            "requestId": request_id,
        },
    )


def _request_id(event: dict[str, object]) -> str:
    """Use the API Gateway request ID when the event supplies one.

    Local and direct invocations have no gateway ID, so they receive a new
    UUIDv4 for that invocation.
    """
    request_context = _string_key_dict(event.get("requestContext"))
    if request_context is not None:
        supplied = request_context.get("requestId")
        if isinstance(supplied, str) and supplied.strip() != "":
            return supplied
    return str(uuid.uuid4())


def _payload_from_event(event: dict[str, object]) -> dict[str, object]:
    if "body" in event and "question" not in event:
        method = _http_method(event)
        if method is not None and method.upper() != "POST":
            raise RequestError("Only POST is supported.", status_code=405)
        return _parse_body(event.get("body"), event.get("isBase64Encoded") is True)
    if "question" in event:
        return event
    raise RequestError("Request body is required.")


def _http_method(event: dict[str, object]) -> str | None:
    request_context = _string_key_dict(event.get("requestContext"))
    if request_context is not None:
        http = _string_key_dict(request_context.get("http"))
        if http is not None:
            method = http.get("method")
            if isinstance(method, str):
                return method
    method = event.get("httpMethod")
    if isinstance(method, str):
        return method
    return None


def _parse_body(body: object, is_base64_encoded: bool) -> dict[str, object]:
    if body is None or body == "":
        raise RequestError("Request body is required.")
    if not isinstance(body, str):
        raise RequestError("Request body must be a JSON object.")

    raw_body = body
    if is_base64_encoded:
        try:
            raw_body = base64.b64decode(body, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as error:
            raise RequestError("Request body must be valid JSON.") from error

    try:
        parsed: object = json.loads(raw_body)
    except json.JSONDecodeError as error:
        raise RequestError("Request body must be valid JSON.") from error

    payload = _string_key_dict(parsed)
    if payload is None:
        raise RequestError("Request body must be a JSON object.")
    return payload


def validated_ask_request(
    payload: dict[str, object],
) -> tuple[str, str, tuple[tuple[str, str], ...]]:
    """Validate an ask body. The Lambda handler and the local stream share this."""
    return _validate_payload(payload)


def _validate_payload(payload: dict[str, object]) -> tuple[str, str, tuple[tuple[str, str], ...]]:
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
    messages = _object_list(history)
    if messages is None:
        raise RequestError("history must be an array.")
    if len(messages) > MAX_HISTORY_MESSAGES:
        raise RequestError("history must contain at most 20 messages.")

    parsed: list[tuple[str, str]] = []
    for index, item in enumerate(messages):
        message = _string_key_dict(item)
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


def _json_response(status_code: int, body: object) -> dict[str, object]:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _string_key_dict(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    raw = cast(dict[object, object], value)
    mapped: dict[str, object] = {}
    for key, item in raw.items():
        if not isinstance(key, str):
            return None
        mapped[key] = item
    return mapped


def _object_list(value: object) -> list[object] | None:
    if not isinstance(value, list):
        return None
    return cast(list[object], value)
