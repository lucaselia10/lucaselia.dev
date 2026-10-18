"""The exact-answer JSON handler for the local development server's default mode.

Career questions are answered from the packaged career index when they match a
supported fact or a follow-up to one. Anything else gets the fixed unsupported
answer. History is validated and used only for that follow-up. Nothing here calls
a model; model answers stream from ask_api.production_app and local model mode.
Job comparison is accepted and left unimplemented. Each call gets its own request ID.
"""

from __future__ import annotations

import base64
import json
import uuid

from ask_api.ask_request import RequestError, string_key_dict, validated_ask_request
from ask_api.exact_answers import FALLBACK_ANSWER, answer_career_question, suggested_questions
from ask_api.index_loader import CareerIndexError

JOB_COMPARISON_ANSWER = (
    "Job comparison is not implemented. No model was called and no career material was compared."
)
INDEX_UNAVAILABLE = "The career index is unavailable."


def handler(event: dict[str, object], context: object) -> dict[str, object]:
    """Validate a POST /ask event and answer supported career questions from the index."""
    del context
    request_id = _request_id(event)
    try:
        payload = _payload_from_event(event)
        question, mode, history = validated_ask_request(payload)
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
        return _json_response(
            200,
            {
                "answer": FALLBACK_ANSWER,
                "citations": [],
                "suggestedQuestions": list(suggested_questions(None)),
                "requestId": request_id,
            },
        )

    return _json_response(
        200,
        {
            "answer": exact.answer,
            "citations": [citation.as_dict() for citation in exact.citations],
            "suggestedQuestions": list(exact.suggested_questions),
            "requestId": request_id,
        },
    )


def _request_id(event: dict[str, object]) -> str:
    """Use the API Gateway request ID when the event supplies one.

    Local and direct invocations have no gateway ID, so they receive a new
    UUIDv4 for that invocation.
    """
    request_context = string_key_dict(event.get("requestContext"))
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
    request_context = string_key_dict(event.get("requestContext"))
    if request_context is not None:
        http = string_key_dict(request_context.get("http"))
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

    payload = string_key_dict(parsed)
    if payload is None:
        raise RequestError("Request body must be a JSON object.")
    return payload


def _json_response(status_code: int, body: object) -> dict[str, object]:
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }
