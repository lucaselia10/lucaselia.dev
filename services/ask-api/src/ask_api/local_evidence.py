"""Load the local direct-evidence package from retrieval artifacts.

The package is the full text of every assistant-retrievable public section.
It is not a Knowledge Base retrieval, and it does not truncate a section into
a shorter fragment. Every section's document must be public and
assistant-retrievable in the career index, or the package is refused.
Private career notes are not read.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from ask_api.citation_safety import is_public_citation_url
from ask_api.index_loader import CareerIndex, load_index

MAX_CHUNK_CHARS = 20_000
MAX_EVIDENCE_CHARS = 100_000
_FORBIDDEN_DOCUMENT_IDS = frozenset({"fictional-lumen-harbor"})


class LocalEvidenceError(Exception):
    """The local evidence package cannot be used."""

    def __init__(self) -> None:
        super().__init__("The local evidence package is unavailable.")


@dataclass(frozen=True)
class EvidenceSection:
    """One trusted public section. URLs come from the artifact metadata."""

    chunk_id: str
    document_id: str
    document_type: str
    title: str
    section: str
    url: str
    text: str


@dataclass(frozen=True)
class EvidencePackage:
    """Every approved section supplied to the local model."""

    sections: tuple[EvidenceSection, ...]

    def by_id(self) -> dict[str, EvidenceSection]:
        return {section.chunk_id: section for section in self.sections}


def load_evidence_package(
    directory: Path, manifest_path: Path, *, index: CareerIndex | None = None
) -> EvidencePackage:
    """Read a retrieval manifest and the full text of each listed section.

    ``index`` defaults to the packaged career index. Tests may inject one.
    """
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        records = _manifest_records(manifest)
        sections = tuple(_read_section(directory, record) for record in records)
        retrievable = _retrievable_document_ids(load_index() if index is None else index)
    except LocalEvidenceError:
        raise
    except Exception:
        raise LocalEvidenceError() from None
    _reject_package(sections, retrievable)
    return EvidencePackage(sections)


def _retrievable_document_ids(index: CareerIndex) -> frozenset[str]:
    return frozenset(
        document.id
        for document in index.documents
        if document.visibility == "public" and document.values.get("assistant_retrievable") is True
    )


def _manifest_records(manifest: object) -> list[dict[str, object]]:
    chunks = _object_dict(manifest).get("chunks")
    if not isinstance(chunks, list):
        raise LocalEvidenceError()
    items = cast(list[object], chunks)
    if len(items) == 0:
        raise LocalEvidenceError()
    return [_object_dict(item) for item in items]


def _read_section(directory: Path, record: dict[str, object]) -> EvidenceSection:
    source_name = _filename(record.get("sourceFilename"))
    metadata_name = _filename(record.get("metadataFilename"))
    source_text = _read_inside(directory, source_name)
    metadata = json.loads(_read_inside(directory, metadata_name))
    attributes = _attributes(metadata)
    chunk_id = attributes.get("chunkId")
    document_id = attributes.get("documentId")
    document_type = attributes.get("type")
    title = attributes.get("title")
    section = attributes.get("section")
    url = attributes.get("url")
    if record.get("chunkId") != chunk_id or record.get("documentId") != document_id:
        raise LocalEvidenceError()
    if record.get("url") != url or record.get("title") != title or record.get("section") != section:
        raise LocalEvidenceError()
    if (
        not isinstance(chunk_id, str)
        or not isinstance(document_id, str)
        or not isinstance(document_type, str)
        or not isinstance(title, str)
        or not isinstance(section, str)
        or not isinstance(url, str)
    ):
        raise LocalEvidenceError()
    if not is_public_citation_url(url, document_type):
        raise LocalEvidenceError()
    if document_id in _FORBIDDEN_DOCUMENT_IDS or "lumen-harbor" in document_id:
        raise LocalEvidenceError()
    if source_text.strip() == "" or len(source_text) > MAX_CHUNK_CHARS:
        raise LocalEvidenceError()
    return EvidenceSection(
        chunk_id=chunk_id,
        document_id=document_id,
        document_type=document_type,
        title=title,
        section=section,
        url=url,
        text=source_text,
    )


def _reject_package(sections: tuple[EvidenceSection, ...], retrievable: frozenset[str]) -> None:
    if any(section.document_id not in retrievable for section in sections):
        raise LocalEvidenceError()
    ids = [section.chunk_id for section in sections]
    if len(ids) != len(set(ids)):
        raise LocalEvidenceError()
    total = sum(len(section.text) for section in sections)
    if total > MAX_EVIDENCE_CHARS:
        raise LocalEvidenceError()


def _attributes(metadata: object) -> dict[str, str]:
    raw = _object_dict(metadata).get("metadataAttributes")
    found: dict[str, str] = {}
    for key, value in _object_dict(raw).items():
        held = _object_dict(value).get("value")
        text = _object_dict(held).get("stringValue")
        if not isinstance(text, str) or text.strip() == "":
            raise LocalEvidenceError()
        found[key] = text
    return found


def _object_dict(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise LocalEvidenceError()
    return cast(dict[str, object], value)


def _filename(value: object) -> str:
    if not isinstance(value, str) or value != value.strip():
        raise LocalEvidenceError()
    if "/" in value or "\\" in value or ".." in value or value == "":
        raise LocalEvidenceError()
    return value


def _read_inside(directory: Path, filename: str) -> str:
    root = directory.resolve()
    path = (root / filename).resolve()
    if path.parent != root:
        raise LocalEvidenceError()
    return path.read_text(encoding="utf-8")
