import json
from pathlib import Path
from typing import cast

from ask_api.exact_answers import recognize_intent

CASES_PATH = Path(__file__).resolve().parents[3] / "tests" / "evaluation" / "cases.json"


def test_evaluation_routes_match_exact_recognition() -> None:
    parsed = cast(object, json.loads(CASES_PATH.read_text(encoding="utf-8")))
    assert isinstance(parsed, dict)
    document = cast(dict[str, object], parsed)
    assert document["schemaVersion"] == 1
    cases = document["cases"]
    assert isinstance(cases, list)
    assert cases
    for item in cast(list[object], cases):
        assert isinstance(item, dict)
        case = cast(dict[str, object], item)
        question = case["question"]
        route = case["route"]
        assert isinstance(question, str)
        assert isinstance(route, str)
        intent = recognize_intent(question)
        if route == "exact":
            assert intent is not None
        else:
            assert intent is None
            assert route in {"grounded", "unsupported"}
        forbidden = case["forbiddenDocumentIds"]
        assert isinstance(forbidden, list)
        assert "fictional-lumen-harbor" in cast(list[object], forbidden)
