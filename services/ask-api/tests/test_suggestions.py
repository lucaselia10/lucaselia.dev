"""Every deterministic suggested question on the site gets a real index answer."""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest

from ask_api.exact_answers import FALLBACK_ANSWER
from ask_api.handler import handler

SUGGESTIONS = Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "ask-suggestions.json"


def _index_entries() -> list[tuple[str, str, str]]:
    data = cast(dict[str, object], json.loads(SUGGESTIONS.read_text(encoding="utf-8")))
    sets: dict[str, object] = {"home": data["home"], "fallback": data["fallback"]}
    sets.update(cast(dict[str, object], data["pages"]))
    entries: list[tuple[str, str, str]] = []
    for name, value in sets.items():
        index = cast(list[dict[str, str]], cast(dict[str, object], value)["index"])
        assert index, f"{name} has no deterministic suggestions"
        for entry in index:
            entries.append((name, entry["question"], entry["mentions"]))
    return entries


@pytest.mark.parametrize(("page", "question", "mentions"), _index_entries())
def test_deterministic_suggestion_gets_a_real_answer(
    page: str, question: str, mentions: str
) -> None:
    result = handler(
        {
            "requestContext": {
                "requestId": "request-1",
                "http": {"method": "POST", "path": "/ask"},
            },
            "body": json.dumps({"question": question, "mode": "career_question"}),
            "isBase64Encoded": False,
        },
        None,
    )
    body = json.loads(str(result["body"]))

    assert result["statusCode"] == 200, page
    assert body["answer"] != FALLBACK_ANSWER, f"{page}: {question}"
    assert mentions in body["answer"], f"{page}: {question}"
    assert body["citations"], f"{page}: {question}"
