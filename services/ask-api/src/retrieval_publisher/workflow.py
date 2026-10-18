"""Plan and apply a retrieval publication without hiding mutations inside dry-run."""

from __future__ import annotations

from collections.abc import Callable, Mapping

from retrieval_publisher.clients import IngestionControl, ObjectStorage
from retrieval_publisher.errors import (
    ACTIVE_JOB,
    RETRY_REQUIRED,
    SERVICE_UNAVAILABLE,
    STATE_TARGET_MISMATCH,
    TIMED_OUT,
    UNKNOWN_STATUS,
    UNMANAGED,
    PublisherError,
)
from retrieval_publisher.models import (
    ACTIVE_STATUSES,
    COMPLETE_STATUS,
    FAILURE_STATUSES,
    KNOWN_STATUSES,
    STATE_KEY,
    Classification,
    Corpus,
    IngestionJob,
    PublicationReport,
    PublicationState,
    PublishOptions,
)
from retrieval_publisher.state import decode_state, encode_state


def execute(
    options: PublishOptions,
    corpus: Corpus,
    storage: ObjectStorage,
    ingestion: IngestionControl,
    *,
    sleep: Callable[[float], None],
    monotonic: Callable[[], float],
    token_factory: Callable[[], str],
) -> PublicationReport:
    """Compare the corpus with remote state, and mutate only when apply is set."""
    state = _read_state(storage, options)
    remote_keys = set(_call(lambda: storage.list_retrieval_keys(options.bucket)))
    if state is not None and state.ingestion_status in ACTIVE_STATUSES:
        saved_job_id = state.ingestion_job_id
        job = _call(
            lambda: ingestion.get_job(
                options.knowledge_base_id,
                options.data_source_id,
                saved_job_id,
            )
        )
        if job.status not in KNOWN_STATUSES:
            raise PublisherError(UNKNOWN_STATUS)
        if job.status in ACTIVE_STATUSES:
            if not options.apply:
                return _report(options, _classify(corpus, state, remote_keys), job, "active", 0, "")
            return _poll(options, state, corpus, ingestion, storage, sleep, monotonic)
        if options.apply:
            state = _store_status(options, storage, state, job.status)
        else:
            state = state.with_status(job.status)

    listed = _call(lambda: ingestion.list_jobs(options.knowledge_base_id, options.data_source_id))
    active = next((job for job in listed if job.status in ACTIVE_STATUSES), None)
    classification = _classify(corpus, state, remote_keys)
    if active is not None:
        if options.apply:
            raise PublisherError(f"{ACTIVE_JOB}: {active.job_id} {active.status}")
        return _report(options, classification, active, "active", 0, ACTIVE_JOB)

    if classification.unmanaged:
        if options.apply:
            raise PublisherError(UNMANAGED + "\n" + "\n".join(classification.unmanaged))
        return _report(options, classification, None, "blocked", 0, UNMANAGED)

    if _current(state, corpus, classification):
        return _report(options, classification, None, "current", 0, "Publication is current.")

    if _retry_required(state, corpus, classification):
        if options.apply and not options.retry_failed:
            raise PublisherError(RETRY_REQUIRED)
        if not options.apply:
            return _report(options, classification, None, "retry-required", 0, RETRY_REQUIRED)

    if not options.apply:
        return _report(options, classification, None, classification.ingestion, 0, "")

    for key in classification.uploads:
        body = corpus.bodies[key]
        _call(lambda key=key, body=body: storage.write_object(options.bucket, key, body))
    for key in classification.deletes:
        _call(lambda key=key: storage.delete_object(options.bucket, key))
    job = _call(
        lambda: ingestion.start_job(
            options.knowledge_base_id,
            options.data_source_id,
            token_factory(),
        )
    )
    if job.status not in KNOWN_STATUSES:
        raise PublisherError(UNKNOWN_STATUS)
    started = PublicationState(
        corpus_digest=corpus.digest,
        managed_objects=dict(corpus.hashes),
        knowledge_base_id=options.knowledge_base_id,
        data_source_id=options.data_source_id,
        ingestion_job_id=job.job_id,
        ingestion_status=job.status,
    )
    _write_state(storage, options, started)
    if job.status == COMPLETE_STATUS:
        return _report(options, classification, job, "complete", 0, "Ingestion completed.")
    if job.status in FAILURE_STATUSES:
        return _report(options, classification, job, "failed", 1, "Ingestion did not complete.")
    return _poll(options, started, corpus, ingestion, storage, sleep, monotonic)


def _key_lines(label: str, keys: tuple[str, ...]) -> list[str]:
    if not keys:
        return [f"{label}: none"]
    return [f"{label}:", *[f"- {key}" for key in keys]]


def render(report: PublicationReport) -> str:
    """Render keys and statuses without document text or local paths."""
    lines = [
        f"mode: {report.mode}",
        f"ingestion: {report.ingestion}",
        *_key_lines("uploads", report.uploads),
        *_key_lines("unchanged", report.unchanged),
        *_key_lines("deletes", report.deletes),
        *_key_lines("unmanaged", report.unmanaged),
    ]
    if report.job_id:
        lines.append(f"ingestion job: {report.job_id}")
        lines.append(f"status: {report.job_status}")
    if report.message:
        lines.append(report.message)
    return "\n".join(lines) + "\n"


def _poll(
    options: PublishOptions,
    state: PublicationState,
    corpus: Corpus,
    ingestion: IngestionControl,
    storage: ObjectStorage,
    sleep: Callable[[float], None],
    monotonic: Callable[[], float],
) -> PublicationReport:
    started = monotonic()
    while True:
        job = _call(
            lambda: ingestion.get_job(
                options.knowledge_base_id,
                options.data_source_id,
                state.ingestion_job_id,
            )
        )
        if job.status == COMPLETE_STATUS:
            _store_status(options, storage, state, job.status)
            if state.corpus_digest == corpus.digest:
                return _finished(options, state, job, "complete", 0, "Ingestion completed.")
            return _finished(
                options,
                state,
                job,
                "required",
                0,
                "The saved ingestion job completed. The local corpus still differs.",
            )
        if job.status in FAILURE_STATUSES:
            _store_status(options, storage, state, job.status)
            return _finished(options, state, job, "failed", 1, "Ingestion did not complete.")
        if job.status not in ACTIVE_STATUSES:
            raise PublisherError(UNKNOWN_STATUS)
        if monotonic() - started >= options.wait_timeout_seconds:
            _store_status(options, storage, state, job.status)
            raise PublisherError(TIMED_OUT)
        sleep(options.poll_interval_seconds)


def _classify(
    corpus: Corpus,
    state: PublicationState | None,
    remote_keys: set[str],
) -> Classification:
    previous: Mapping[str, str] = {} if state is None else state.managed_objects
    uploads: list[str] = []
    unchanged: list[str] = []
    for key in sorted(corpus.hashes):
        if previous.get(key) == corpus.hashes[key] and key in remote_keys:
            unchanged.append(key)
        else:
            uploads.append(key)
    deletes = tuple(sorted(key for key in previous if key not in corpus.hashes))
    desired = set(corpus.hashes)
    unmanaged = tuple(
        sorted(key for key in remote_keys if key not in desired and key not in previous)
    )
    ingestion = _ingestion_label(corpus, state, uploads, deletes, unmanaged)
    return Classification(tuple(uploads), tuple(unchanged), deletes, unmanaged, ingestion)


def _ingestion_label(
    corpus: Corpus,
    state: PublicationState | None,
    uploads: list[str],
    deletes: tuple[str, ...],
    unmanaged: tuple[str, ...],
) -> str:
    if unmanaged:
        return "blocked"
    if state is not None and state.ingestion_status in ACTIVE_STATUSES:
        return "active"
    if _same_corpus(state, corpus) and not uploads and not deletes:
        if state is not None and state.ingestion_status == COMPLETE_STATUS:
            return "current"
        if state is not None and state.ingestion_status in FAILURE_STATUSES:
            return "retry-required"
    return "required"


def _current(
    state: PublicationState | None,
    corpus: Corpus,
    classification: Classification,
) -> bool:
    return (
        state is not None
        and state.ingestion_status == COMPLETE_STATUS
        and _same_corpus(state, corpus)
        and not classification.uploads
        and not classification.deletes
        and not classification.unmanaged
    )


def _retry_required(
    state: PublicationState | None,
    corpus: Corpus,
    classification: Classification,
) -> bool:
    return (
        state is not None
        and state.ingestion_status in FAILURE_STATUSES
        and _same_corpus(state, corpus)
        and not classification.uploads
        and not classification.deletes
    )


def _same_corpus(state: PublicationState | None, corpus: Corpus) -> bool:
    return (
        state is not None
        and state.corpus_digest == corpus.digest
        and dict(state.managed_objects) == dict(corpus.hashes)
    )


def _read_state(storage: ObjectStorage, options: PublishOptions) -> PublicationState | None:
    payload = _call(lambda: storage.read_state(options.bucket))
    if payload is None:
        return None
    state = decode_state(payload)
    if (
        state.knowledge_base_id != options.knowledge_base_id
        or state.data_source_id != options.data_source_id
    ):
        raise PublisherError(STATE_TARGET_MISMATCH)
    return state


def _store_status(
    options: PublishOptions,
    storage: ObjectStorage,
    state: PublicationState,
    status: str,
) -> PublicationState:
    updated = state.with_status(status)
    _write_state(storage, options, updated)
    return updated


def _write_state(storage: ObjectStorage, options: PublishOptions, state: PublicationState) -> None:
    _call(lambda: storage.write_object(options.bucket, STATE_KEY, encode_state(state)))


def _report(
    options: PublishOptions,
    classification: Classification,
    job: IngestionJob | None,
    ingestion: str,
    exit_code: int,
    message: str,
) -> PublicationReport:
    return PublicationReport(
        mode="apply" if options.apply else "plan",
        ingestion=ingestion,
        exit_code=exit_code,
        uploads=classification.uploads,
        unchanged=classification.unchanged,
        deletes=classification.deletes,
        unmanaged=classification.unmanaged,
        job_id="" if job is None else job.job_id,
        job_status="" if job is None else job.status,
        message=message,
    )


def _finished(
    options: PublishOptions,
    state: PublicationState,
    job: IngestionJob,
    ingestion: str,
    exit_code: int,
    message: str,
) -> PublicationReport:
    return PublicationReport(
        mode="apply" if options.apply else "plan",
        ingestion=ingestion,
        exit_code=exit_code,
        uploads=(),
        unchanged=tuple(sorted(state.managed_objects)),
        deletes=(),
        unmanaged=(),
        job_id=job.job_id,
        job_status=job.status,
        message=message,
    )


def _call[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except PublisherError:
        raise
    except Exception:
        raise PublisherError(SERVICE_UNAVAILABLE) from None
