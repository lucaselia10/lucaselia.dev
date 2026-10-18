"""Validate generated retrieval artifacts before any AWS client is constructed."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import cast

from ask_api.citation_safety import DOCUMENT_TYPES, is_public_citation_url
from retrieval_publisher.errors import (
    ARTIFACT_MISMATCH,
    ARTIFACTS_MISSING,
    FILENAME_UNSAFE,
    MANIFEST_INCOMPATIBLE,
    MANIFEST_INVALID,
    MANIFEST_MISSING,
    PublisherError,
)
from retrieval_publisher.models import (
    RETRIEVAL_GENERATOR_VERSION,
    RETRIEVAL_PREFIX,
    RETRIEVAL_SCHEMA_VERSION,
    Corpus,
)

_SOURCE_FILENAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*\.txt$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_METADATA_FIELDS = ("chunkId", "documentId", "title", "section", "url", "type")
_CHUNK_FIELDS = (
    "sourceFilename",
    "metadataFilename",
    "chunkId",
    "documentId",
    "documentType",
    "title",
    "section",
    "url",
    "sourceSha256",
    "metadataSha256",
)


def default_artifact_paths() -> tuple[Path, Path]:
    """Return the gitignored manifest and artifact directory."""
    root = Path(__file__).resolve().parents[3]
    return root / "generated" / "retrieval-manifest.json", root / "generated" / "retrieval"


def corpus_digest(hashes: dict[str, str]) -> str:
    """Hash the sorted remote keys and content hashes."""
    payload = json.dumps(
        [{"key": key, "sha256": hashes[key]} for key in sorted(hashes)],
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_corpus(manifest_path: Path, artifact_directory: Path) -> Corpus:
    """Read and validate the manifest, source files, and metadata sidecars."""
    manifest = _read_manifest(manifest_path)
    if not artifact_directory.is_dir() or artifact_directory.is_symlink():
        raise PublisherError(ARTIFACTS_MISSING)
    chunks = _chunks(manifest)
    discovered = _directory_entries(artifact_directory)
    expected = {str(chunk["sourceFilename"]) for chunk in chunks} | {
        str(chunk["metadataFilename"]) for chunk in chunks
    }
    if set(discovered) != expected:
        raise PublisherError(ARTIFACT_MISMATCH)

    hashes: dict[str, str] = {}
    bodies: dict[str, bytes] = {}
    seen_chunks: set[str] = set()
    for chunk in chunks:
        source_name = str(chunk["sourceFilename"])
        metadata_name = str(chunk["metadataFilename"])
        chunk_id = str(chunk["chunkId"])
        if chunk_id in seen_chunks or source_name in seen_chunks:
            raise PublisherError(MANIFEST_INVALID)
        seen_chunks.add(chunk_id)
        source_bytes = _read_file(artifact_directory, source_name)
        metadata_bytes = _read_file(artifact_directory, metadata_name)
        if _sha256(source_bytes) != chunk["sourceSha256"]:
            raise PublisherError(ARTIFACT_MISMATCH)
        if _sha256(metadata_bytes) != chunk["metadataSha256"]:
            raise PublisherError(ARTIFACT_MISMATCH)
        _validate_sidecar(metadata_bytes, chunk)
        source_key = f"{RETRIEVAL_PREFIX}{source_name}"
        metadata_key = f"{RETRIEVAL_PREFIX}{metadata_name}"
        hashes[source_key] = str(chunk["sourceSha256"])
        hashes[metadata_key] = str(chunk["metadataSha256"])
        bodies[source_key] = source_bytes
        bodies[metadata_key] = metadata_bytes
    if manifest["chunkCount"] != len(chunks):
        raise PublisherError(MANIFEST_INVALID)
    return Corpus(digest=corpus_digest(hashes), hashes=hashes, bodies=bodies)


def _read_manifest(path: Path) -> dict[str, object]:
    if path.is_symlink() or not path.is_file():
        raise PublisherError(MANIFEST_MISSING)
    try:
        payload = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PublisherError(MANIFEST_INVALID) from error
    if not isinstance(payload, dict):
        raise PublisherError(MANIFEST_INVALID)
    manifest = cast(dict[str, object], payload)
    if set(manifest) != {"schemaVersion", "generatorVersion", "chunkCount", "chunks"}:
        raise PublisherError(MANIFEST_INVALID)
    if manifest["schemaVersion"] != RETRIEVAL_SCHEMA_VERSION:
        raise PublisherError(MANIFEST_INCOMPATIBLE)
    if manifest["generatorVersion"] != RETRIEVAL_GENERATOR_VERSION:
        raise PublisherError(MANIFEST_INCOMPATIBLE)
    if not isinstance(manifest["chunkCount"], int) or isinstance(manifest["chunkCount"], bool):
        raise PublisherError(MANIFEST_INVALID)
    if not isinstance(manifest["chunks"], list):
        raise PublisherError(MANIFEST_INVALID)
    return manifest


def _chunks(manifest: dict[str, object]) -> tuple[dict[str, object], ...]:
    raw_chunks = manifest["chunks"]
    if not isinstance(raw_chunks, list):
        raise PublisherError(MANIFEST_INVALID)
    chunks: list[dict[str, object]] = []
    filenames: set[str] = set()
    chunk_ids: set[str] = set()
    for item in cast(list[object], raw_chunks):
        if not isinstance(item, dict):
            raise PublisherError(MANIFEST_INVALID)
        chunk = cast(dict[str, object], item)
        if set(chunk) != set(_CHUNK_FIELDS):
            raise PublisherError(MANIFEST_INVALID)
        source_name = chunk["sourceFilename"]
        metadata_name = chunk["metadataFilename"]
        chunk_id = chunk["chunkId"]
        document_type = chunk["documentType"]
        if (
            not isinstance(source_name, str)
            or not isinstance(metadata_name, str)
            or not isinstance(chunk_id, str)
            or not isinstance(document_type, str)
            or not _safe_source_name(source_name)
            or metadata_name != f"{source_name}.metadata.json"
        ):
            raise PublisherError(FILENAME_UNSAFE)
        if source_name in filenames or metadata_name in filenames or chunk_id in chunk_ids:
            raise PublisherError(MANIFEST_INVALID)
        if not _sha256_value(chunk["sourceSha256"]) or not _sha256_value(chunk["metadataSha256"]):
            raise PublisherError(MANIFEST_INVALID)
        if document_type not in DOCUMENT_TYPES or not _nonempty_text(chunk, "documentId"):
            raise PublisherError(MANIFEST_INVALID)
        if not _nonempty_text(chunk, "title") or not _nonempty_text(chunk, "section"):
            raise PublisherError(MANIFEST_INVALID)
        url = chunk["url"]
        if not isinstance(url, str) or not is_public_citation_url(url, document_type):
            raise PublisherError(MANIFEST_INVALID)
        if chunk_id != f"{chunk['documentId']}:{_fragment(url)}:0":
            raise PublisherError(MANIFEST_INVALID)
        filenames.add(source_name)
        filenames.add(metadata_name)
        chunk_ids.add(chunk_id)
        chunks.append(chunk)
    return tuple(chunks)


def _directory_entries(directory: Path) -> tuple[str, ...]:
    names: list[str] = []
    try:
        iterator = os.scandir(directory)
    except OSError as error:
        raise PublisherError(ARTIFACTS_MISSING) from error
    with iterator:
        for entry in iterator:
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                raise PublisherError(FILENAME_UNSAFE)
            if not _safe_source_name(entry.name) and not _safe_metadata_name(entry.name):
                raise PublisherError(FILENAME_UNSAFE)
            names.append(entry.name)
    return tuple(names)


def _read_file(directory: Path, name: str) -> bytes:
    if not _safe_source_name(name) and not _safe_metadata_name(name):
        raise PublisherError(FILENAME_UNSAFE)
    path = directory / name
    if path.is_symlink():
        raise PublisherError(FILENAME_UNSAFE)
    try:
        resolved = path.resolve()
        if resolved.parent != directory.resolve() or not resolved.is_file():
            raise PublisherError(FILENAME_UNSAFE)
        return resolved.read_bytes()
    except PublisherError:
        raise
    except OSError as error:
        raise PublisherError(ARTIFACT_MISMATCH) from error


def _validate_sidecar(payload: bytes, chunk: dict[str, object]) -> None:
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PublisherError(ARTIFACT_MISMATCH) from error
    if not isinstance(parsed, dict):
        raise PublisherError(ARTIFACT_MISMATCH)
    document = cast(dict[str, object], parsed)
    attributes = document.get("metadataAttributes")
    if set(document) != {"metadataAttributes"} or not isinstance(attributes, dict):
        raise PublisherError(ARTIFACT_MISMATCH)
    typed_attributes = cast(dict[str, object], attributes)
    if set(typed_attributes) != set(_METADATA_FIELDS):
        raise PublisherError(ARTIFACT_MISMATCH)
    expected = {
        "chunkId": chunk["chunkId"],
        "documentId": chunk["documentId"],
        "title": chunk["title"],
        "section": chunk["section"],
        "url": chunk["url"],
        "type": chunk["documentType"],
    }
    for field, expected_value in expected.items():
        if _string_attribute(typed_attributes.get(field)) != expected_value:
            raise PublisherError(ARTIFACT_MISMATCH)


def _string_attribute(value: object) -> str:
    if not isinstance(value, dict):
        raise PublisherError(ARTIFACT_MISMATCH)
    attribute = cast(dict[str, object], value)
    typed = attribute.get("value")
    if (
        set(attribute) != {"value", "includeForEmbedding"}
        or attribute.get("includeForEmbedding") is not False
    ):
        raise PublisherError(ARTIFACT_MISMATCH)
    if not isinstance(typed, dict):
        raise PublisherError(ARTIFACT_MISMATCH)
    value_object = cast(dict[str, object], typed)
    if set(value_object) != {"type", "stringValue"} or value_object.get("type") != "STRING":
        raise PublisherError(ARTIFACT_MISMATCH)
    string_value = value_object.get("stringValue")
    if not isinstance(string_value, str) or string_value == "":
        raise PublisherError(ARTIFACT_MISMATCH)
    return string_value


def _safe_source_name(name: str) -> bool:
    return (
        name == name.strip()
        and not name.startswith("/")
        and "\\" not in name
        and "/" not in name
        and ".." not in name
        and _SOURCE_FILENAME.fullmatch(name) is not None
    )


def _safe_metadata_name(name: str) -> bool:
    return name.endswith(".txt.metadata.json") and _safe_source_name(
        name.removesuffix(".metadata.json")
    )


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_value(value: object) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def _nonempty_text(chunk: dict[str, object], field: str) -> bool:
    value = chunk[field]
    return isinstance(value, str) and value.strip() != "" and "\n" not in value


def _fragment(url: str) -> str:
    return url.partition("#")[2]
