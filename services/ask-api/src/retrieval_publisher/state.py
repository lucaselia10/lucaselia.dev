"""Encode and validate the private publication-state document."""

from __future__ import annotations

import json
import re
from typing import cast

from retrieval_publisher.corpus import corpus_digest
from retrieval_publisher.errors import STATE_INCOMPATIBLE, STATE_INVALID, PublisherError
from retrieval_publisher.models import (
    KNOWN_STATUSES,
    RETRIEVAL_PREFIX,
    STATE_SCHEMA_VERSION,
    PublicationState,
)

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ID = re.compile(r"^[A-Za-z0-9]{1,20}$")
_JOB_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_SOURCE_KEY = re.compile(
    rf"^{RETRIEVAL_PREFIX}[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*\.txt$"
)
_METADATA_KEY = re.compile(
    rf"^{RETRIEVAL_PREFIX}[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+"
    r"(?:-[a-z0-9]+)*\.txt\.metadata\.json$"
)
_STATE_FIELDS = (
    "schemaVersion",
    "corpusDigest",
    "managedObjects",
    "knowledgeBaseId",
    "dataSourceId",
    "ingestionJobId",
    "ingestionStatus",
)


def encode_state(state: PublicationState) -> bytes:
    """Serialize state without timestamps, paths, credentials, or document text."""
    payload = {
        "schemaVersion": STATE_SCHEMA_VERSION,
        "corpusDigest": state.corpus_digest,
        "managedObjects": {
            key: state.managed_objects[key] for key in sorted(state.managed_objects)
        },
        "knowledgeBaseId": state.knowledge_base_id,
        "dataSourceId": state.data_source_id,
        "ingestionJobId": state.ingestion_job_id,
        "ingestionStatus": state.ingestion_status,
    }
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


def decode_state(payload: bytes) -> PublicationState:
    """Accept only the current schema. Malformed or incompatible state fails closed."""
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PublisherError(STATE_INVALID) from error
    if not isinstance(parsed, dict):
        raise PublisherError(STATE_INVALID)
    document = cast(dict[str, object], parsed)
    if set(document) != set(_STATE_FIELDS):
        raise PublisherError(STATE_INVALID)
    if document["schemaVersion"] != STATE_SCHEMA_VERSION:
        raise PublisherError(STATE_INCOMPATIBLE)
    digest = document["corpusDigest"]
    job_id = document["ingestionJobId"]
    status = document["ingestionStatus"]
    knowledge_base_id = document["knowledgeBaseId"]
    data_source_id = document["dataSourceId"]
    raw_objects = document["managedObjects"]
    if (
        not isinstance(digest, str)
        or _SHA256.fullmatch(digest) is None
        or not isinstance(job_id, str)
        or _JOB_ID.fullmatch(job_id) is None
        or not isinstance(status, str)
        or status not in KNOWN_STATUSES
        or not isinstance(knowledge_base_id, str)
        or _ID.fullmatch(knowledge_base_id) is None
        or not isinstance(data_source_id, str)
        or _ID.fullmatch(data_source_id) is None
        or not isinstance(raw_objects, dict)
    ):
        raise PublisherError(STATE_INVALID)
    managed = _managed_objects(cast(dict[str, object], raw_objects))
    if digest != corpus_digest(managed):
        raise PublisherError(STATE_INVALID)
    return PublicationState(
        corpus_digest=digest,
        managed_objects=managed,
        knowledge_base_id=knowledge_base_id,
        data_source_id=data_source_id,
        ingestion_job_id=job_id,
        ingestion_status=status,
    )


def _managed_objects(raw_objects: dict[str, object]) -> dict[str, str]:
    managed: dict[str, str] = {}
    for key, value in raw_objects.items():
        if not isinstance(value, str) or _SHA256.fullmatch(value) is None or not _managed_key(key):
            raise PublisherError(STATE_INVALID)
        managed[key] = value
    return managed


def _managed_key(key: str) -> bool:
    return ".." not in key and (
        _SOURCE_KEY.fullmatch(key) is not None or _METADATA_KEY.fullmatch(key) is not None
    )
