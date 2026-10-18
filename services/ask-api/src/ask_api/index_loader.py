"""Load the packaged career index.

The loader reads the generated index that was copied into this package. It does
not fetch private career notes, the website, S3, or any other file.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import cast

type JsonValue = str | bool | None | int | float | list[JsonValue] | dict[str, JsonValue]
SUPPORTED_SCHEMA_VERSION = 1
_INDEX_FILE = "career-index.json"


class CareerIndexError(Exception):
    """The packaged career index cannot be used.

    The message is for logs and tests. API responses must not return it.
    """


@dataclass(frozen=True)
class IndexedDocument:
    """One public document from the generated index."""

    id: str
    document_type: str
    title: str
    summary: str
    skills: tuple[str, ...]
    url: str
    visibility: str
    values: Mapping[str, JsonValue]


@dataclass(frozen=True)
class CareerFact:
    """One structured fact from the generated index."""

    kind: str
    value: str | bool | None
    document_id: str
    url: str


@dataclass(frozen=True)
class CareerSource:
    """One citation source from the generated index."""

    chunk_id: str
    document_id: str
    title: str
    section: str
    url: str
    document_type: str | None
    roles: tuple[str, ...]
    skills: tuple[str, ...]


@dataclass(frozen=True)
class CareerIndex:
    """The generated public career index."""

    schema_version: int
    documents: tuple[IndexedDocument, ...]
    facts: tuple[CareerFact, ...]
    sources: tuple[CareerSource, ...]


def load_index(*, path: Path | None = None, data: bytes | None = None) -> CareerIndex:
    """Load and validate a career index.

    With no arguments, this reads the packaged copy. Tests can pass ``path`` or
    ``data`` instead. Passing both is rejected.
    """
    if path is not None and data is not None:
        raise CareerIndexError("Career index shape is invalid.")
    raw = data if data is not None else _read_bytes(path)
    return _parse_index(raw)


def _read_bytes(path: Path | None) -> bytes:
    try:
        if path is None:
            return resources.files("ask_api.data").joinpath(_INDEX_FILE).read_bytes()
        return path.read_bytes()
    except FileNotFoundError as error:
        raise CareerIndexError("Career index package data is missing.") from error
    except OSError as error:
        raise CareerIndexError("Career index package data is missing.") from error


def _parse_index(raw: bytes) -> CareerIndex:
    try:
        parsed: object = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise CareerIndexError("Career index is malformed.") from error

    document = _object(parsed)
    if document is None:
        raise CareerIndexError("Career index shape is invalid.")
    version = document.get("schemaVersion")
    if (
        isinstance(version, bool)
        or not isinstance(version, int)
        or version != SUPPORTED_SCHEMA_VERSION
    ):
        raise CareerIndexError("Career index schema version is unsupported.")

    documents = _list(document.get("documents"))
    facts = _list(document.get("facts"))
    sources = _list(document.get("sources"))
    if documents is None or facts is None or sources is None:
        raise CareerIndexError("Career index shape is invalid.")

    return CareerIndex(
        schema_version=SUPPORTED_SCHEMA_VERSION,
        documents=tuple(_document(item) for item in documents),
        facts=tuple(_fact(item) for item in facts),
        sources=tuple(_source(item) for item in sources),
    )


def _document(value: object) -> IndexedDocument:
    record = _object(value)
    if record is None:
        raise CareerIndexError("Career index shape is invalid.")
    document_id = _required_string(record, "id")
    document_type = _required_string(record, "type")
    title = _required_string(record, "title")
    summary = _required_string(record, "summary")
    url = _required_string(record, "url")
    visibility = _required_string(record, "visibility")
    skills = _string_tuple(record.get("skills"))
    if skills is None:
        raise CareerIndexError("Career index shape is invalid.")
    values = _json_object(record)
    return IndexedDocument(
        id=document_id,
        document_type=document_type,
        title=title,
        summary=summary,
        skills=skills,
        url=url,
        visibility=visibility,
        values=values,
    )


def _fact(value: object) -> CareerFact:
    record = _object(value)
    if record is None:
        raise CareerIndexError("Career index shape is invalid.")
    kind = _required_string(record, "kind")
    document_id = _required_string(record, "documentId")
    url = _required_string(record, "url")
    fact_value = record.get("value")
    if isinstance(fact_value, bool) or fact_value is None:
        return CareerFact(kind=kind, value=fact_value, document_id=document_id, url=url)
    if not isinstance(fact_value, str):
        raise CareerIndexError("Career index shape is invalid.")
    return CareerFact(kind=kind, value=fact_value, document_id=document_id, url=url)


def _source(value: object) -> CareerSource:
    record = _object(value)
    if record is None:
        raise CareerIndexError("Career index shape is invalid.")
    document_type = record.get("type")
    if document_type is not None and not isinstance(document_type, str):
        raise CareerIndexError("Career index shape is invalid.")
    roles = record.get("roles", [])
    skills = record.get("skills", [])
    role_values = _string_tuple(roles)
    skill_values = _string_tuple(skills)
    if role_values is None or skill_values is None:
        raise CareerIndexError("Career index shape is invalid.")
    return CareerSource(
        chunk_id=_required_string(record, "chunkId"),
        document_id=_required_string(record, "documentId"),
        title=_required_string(record, "title"),
        section=_required_string(record, "section"),
        url=_required_string(record, "url"),
        document_type=document_type,
        roles=role_values,
        skills=skill_values,
    )


def _json_object(record: dict[str, object]) -> dict[str, JsonValue]:
    values: dict[str, JsonValue] = {}
    for key, item in record.items():
        values[key] = _json_value(item)
    return values


def _json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value
    if isinstance(value, list):
        return [_json_value(item) for item in cast(list[object], value)]
    mapped = _object(value)
    if mapped is None:
        raise CareerIndexError("Career index shape is invalid.")
    return {key: _json_value(item) for key, item in mapped.items()}


def _required_string(record: dict[str, object], key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or value == "":
        raise CareerIndexError("Career index shape is invalid.")
    return value


def _string_tuple(value: object) -> tuple[str, ...] | None:
    items = _list(value)
    if items is None or any(not isinstance(item, str) for item in items):
        return None
    return tuple(cast(list[str], items))


def _object(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    raw = cast(dict[object, object], value)
    mapped: dict[str, object] = {}
    for key, item in raw.items():
        if not isinstance(key, str):
            return None
        mapped[key] = item
    return mapped


def _list(value: object) -> list[object] | None:
    if not isinstance(value, list):
        return None
    return cast(list[object], value)
