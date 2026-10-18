import json
from pathlib import Path

import pytest

from ask_api.index_loader import CareerIndexError, load_index


def test_loads_the_synchronized_package_index() -> None:
    index = load_index()

    assert index.schema_version == 1
    assert any(document.id == "aws-sde-ii" for document in index.documents)
    degree_facts = [fact for fact in index.facts if fact.kind == "degree_awarded"]
    assert degree_facts
    assert all(fact.value is False for fact in degree_facts)
    expert_assist = next(
        document for document in index.documents if document.id == "expert-assist-consultant"
    )
    assert expert_assist.values["location"] is None
    assert not any(
        fact.document_id == "expert-assist-consultant" and fact.kind == "location"
        for fact in index.facts
    )


def test_path_and_bytes_load_the_same_index() -> None:
    packaged = load_index()
    data_file = Path(__file__).parents[1] / "src" / "ask_api" / "data" / "career-index.json"
    from_path = load_index(path=data_file)
    from_bytes = load_index(data=data_file.read_bytes())

    assert from_path == packaged
    assert from_bytes == packaged


def test_missing_package_data_fails_without_a_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    class Missing:
        def joinpath(self, name: str) -> object:
            return self

        def read_bytes(self) -> bytes:
            raise FileNotFoundError("hidden /var/private/career-index.json")

    def files(_package: str) -> Missing:
        return Missing()

    monkeypatch.setattr("ask_api.index_loader.resources.files", files)

    with pytest.raises(CareerIndexError, match="Career index package data is missing.$"):
        load_index()


def test_missing_explicit_path_fails(tmp_path: Path) -> None:
    with pytest.raises(CareerIndexError, match="Career index package data is missing.$"):
        load_index(path=tmp_path / "absent.json")


def test_malformed_json_fails() -> None:
    with pytest.raises(CareerIndexError, match="Career index is malformed.$"):
        load_index(data=b"{")


def test_unsupported_schema_version_fails() -> None:
    payload = json.dumps({"schemaVersion": 2, "documents": [], "facts": [], "sources": []}).encode()
    with pytest.raises(CareerIndexError, match="Career index schema version is unsupported.$"):
        load_index(data=payload)


def test_invalid_shape_fails() -> None:
    payload = json.dumps(
        {
            "schemaVersion": 1,
            "documents": [],
            "facts": [{"kind": "degree_awarded", "value": 0, "documentId": "x", "url": "/x"}],
            "sources": [],
        }
    ).encode()
    with pytest.raises(CareerIndexError, match="Career index shape is invalid.$"):
        load_index(data=payload)
