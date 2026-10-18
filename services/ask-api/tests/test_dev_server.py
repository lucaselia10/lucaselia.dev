import json
import threading
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from typing import cast

import pytest

import dev_server
from dev_server import MAX_BODY_BYTES, AskDevHandler, handle_exchange

CURRENT_ROLE = "What is Lucas's current role?"


def test_current_role_uses_the_lambda_handler() -> None:
    result = _post({"question": CURRENT_ROLE, "mode": "career_question"})
    payload = _payload(result.body)

    assert result.status == 200
    assert "Software Development Engineer II" in str(payload["answer"])
    citations = payload["citations"]
    assert isinstance(citations, list)
    first = cast(object, citations[0])
    assert isinstance(first, dict)
    url = cast(dict[object, object], first).get("url")
    assert url == "/experience/aws-sde-ii#role-description"
    _assert_uuid4(payload["requestId"])


def test_generated_request_id_is_the_response_request_id(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed = uuid.UUID("12345678-1234-4234-8234-123456789abc")
    monkeypatch.setattr(dev_server.uuid, "uuid4", lambda: fixed)

    result = _post({"question": CURRENT_ROLE, "mode": "career_question"})

    assert _payload(result.body)["requestId"] == str(fixed)


def test_options_allows_the_local_origins() -> None:
    for origin in ("http://localhost:4321", "http://127.0.0.1:4321"):
        result = handle_exchange("OPTIONS", "/ask", {"Origin": origin}, b"")

        assert result.status == 204
        assert result.headers["Access-Control-Allow-Origin"] == origin
        assert result.headers["Access-Control-Allow-Methods"] == "POST, OPTIONS"
        assert result.headers["Access-Control-Allow-Headers"] == (
            "Content-Type, x-amz-content-sha256"
        )
        assert "Access-Control-Allow-Credentials" not in result.headers
        assert "*" not in result.headers["Access-Control-Allow-Origin"]


def test_disallowed_origin_is_rejected() -> None:
    result = handle_exchange(
        "POST",
        "/ask",
        {"Origin": "https://evil.example"},
        _body({"question": CURRENT_ROLE, "mode": "career_question"}),
    )

    assert result.status == 403
    assert "Access-Control-Allow-Origin" not in result.headers
    assert _payload(result.body)["message"] == "Origin is not allowed."


def test_missing_origin_still_answers() -> None:
    result = _post({"question": CURRENT_ROLE, "mode": "career_question"})

    assert result.status == 200
    assert "Access-Control-Allow-Origin" not in result.headers


def test_malformed_json_is_a_safe_handler_error() -> None:
    result = handle_exchange("POST", "/ask", {}, b"{")
    payload = _payload(result.body)

    assert result.status == 400
    assert payload["message"] == "Request body must be valid JSON."
    _assert_uuid4(payload["requestId"])


def test_oversized_body_is_rejected() -> None:
    result = handle_exchange("POST", "/ask", {}, b"x" * (MAX_BODY_BYTES + 1))

    assert result.status == 413
    assert _payload(result.body)["message"] == "Request body is too large."


def test_unknown_path_is_not_found() -> None:
    result = handle_exchange(
        "POST", "/other", {}, _body({"question": "Hi", "mode": "career_question"})
    )

    assert result.status == 404
    assert _payload(result.body)["message"] == "Not found."


def test_unsupported_method_is_rejected() -> None:
    result = handle_exchange("GET", "/ask", {}, b"")

    assert result.status == 405
    assert result.headers["Allow"] == "POST, OPTIONS"
    assert _payload(result.body)["message"] == "Only POST is supported."


def test_http_server_rejects_an_unsupported_method() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), AskDevHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    request = urllib.request.Request(f"http://127.0.0.1:{port}/ask", method="PUT")
    try:
        with pytest.raises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        assert caught.value.code == 405
    finally:
        server.shutdown()
        server.server_close()


def test_http_server_returns_the_handler_answer() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), AskDevHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/ask",
        data=_body({"question": CURRENT_ROLE, "mode": "career_question"}),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            payload = json.loads(response.read().decode("utf-8"))
            assert response.status == 200
        assert "Amazon Web Services" in str(payload["answer"])
    finally:
        server.shutdown()
        server.server_close()


def test_http_server_rejects_an_unknown_path() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), AskDevHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    request = urllib.request.Request(f"http://127.0.0.1:{port}/missing", method="GET")
    try:
        with pytest.raises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        assert caught.value.code == 404
    finally:
        server.shutdown()
        server.server_close()


def _post(payload: dict[str, str]) -> dev_server.HttpResult:
    return handle_exchange("POST", "/ask", {}, _body(payload))


def _body(payload: dict[str, str]) -> bytes:
    return json.dumps(payload).encode("utf-8")


def _payload(body: bytes) -> dict[str, object]:
    parsed = cast(object, json.loads(body.decode("utf-8")))
    assert isinstance(parsed, dict)
    mapped: dict[str, object] = {}
    for key, item in cast(dict[object, object], parsed).items():
        assert isinstance(key, str)
        mapped[key] = item
    return mapped


def _assert_uuid4(value: object) -> None:
    assert isinstance(value, str)
    parsed = uuid.UUID(value)
    assert str(parsed) == value
    assert parsed.version == 4
