"""Publication values shared by validation, planning, and apply."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

STATE_SCHEMA_VERSION = 1
RETRIEVAL_SCHEMA_VERSION = 1
RETRIEVAL_GENERATOR_VERSION = "2"
RETRIEVAL_PREFIX = "retrieval/"
STATE_KEY = "_career-portfolio/retrieval-publish-state.json"
ACTIVE_STATUSES = frozenset({"STARTING", "IN_PROGRESS", "STOPPING"})
FAILURE_STATUSES = frozenset({"FAILED", "STOPPED"})
COMPLETE_STATUS = "COMPLETE"
KNOWN_STATUSES = ACTIVE_STATUSES | FAILURE_STATUSES | {COMPLETE_STATUS}


@dataclass(frozen=True)
class PublishOptions:
    """Validated operator arguments. Secrets are not accepted here."""

    bucket: str
    knowledge_base_id: str
    data_source_id: str
    region: str
    apply: bool
    retry_failed: bool
    poll_interval_seconds: int
    wait_timeout_seconds: int


@dataclass(frozen=True)
class Corpus:
    """Validated local artifacts addressed by their remote keys."""

    digest: str
    hashes: Mapping[str, str]
    bodies: Mapping[str, bytes]


@dataclass(frozen=True)
class PublicationState:
    """Versioned private record of the last managed publication."""

    corpus_digest: str
    managed_objects: Mapping[str, str]
    knowledge_base_id: str
    data_source_id: str
    ingestion_job_id: str
    ingestion_status: str

    def with_status(self, status: str) -> PublicationState:
        return PublicationState(
            corpus_digest=self.corpus_digest,
            managed_objects=self.managed_objects,
            knowledge_base_id=self.knowledge_base_id,
            data_source_id=self.data_source_id,
            ingestion_job_id=self.ingestion_job_id,
            ingestion_status=status,
        )


@dataclass(frozen=True)
class IngestionJob:
    """Identifier and status returned by Bedrock Agent."""

    job_id: str
    status: str


@dataclass(frozen=True)
class Classification:
    """Read-only comparison of local artifacts, managed state, and remote keys."""

    uploads: tuple[str, ...]
    unchanged: tuple[str, ...]
    deletes: tuple[str, ...]
    unmanaged: tuple[str, ...]
    ingestion: str


@dataclass(frozen=True)
class PublicationReport:
    """Operator-visible result. It names keys and statuses, not document text."""

    mode: str
    ingestion: str
    exit_code: int
    uploads: tuple[str, ...]
    unchanged: tuple[str, ...]
    deletes: tuple[str, ...]
    unmanaged: tuple[str, ...]
    job_id: str = ""
    job_status: str = ""
    message: str = ""
