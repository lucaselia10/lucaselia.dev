"""Publisher tests use injected clients and never contact AWS."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import cast

import pytest

from retrieval_publisher.cli import main, parse_options
from retrieval_publisher.clients import BedrockIngestion, S3ObjectStorage, default_clients
from retrieval_publisher.corpus import load_corpus
from retrieval_publisher.errors import (
    ACTIVE_JOB,
    ARTIFACT_MISMATCH,
    BUCKET_INVALID,
    FILENAME_UNSAFE,
    MANIFEST_INCOMPATIBLE,
    RETRY_REQUIRED,
    SERVICE_UNAVAILABLE,
    STATE_INCOMPATIBLE,
    STATE_INVALID,
    TIMED_OUT,
    UNMANAGED,
    PublisherError,
)
from retrieval_publisher.models import (
    RETRIEVAL_GENERATOR_VERSION,
    STATE_KEY,
    Corpus,
    IngestionJob,
    PublicationReport,
    PublishOptions,
)
from retrieval_publisher.state import decode_state, encode_state
from retrieval_publisher.workflow import execute

_BUCKET = "career-source-bucket"
_KB = "KB1234567890"
_SOURCE = "DS1234567890"
_TEXT = "Title: Software Development Engineer II\n"
_OTHER = "Title: Backend Development\n"


class Clock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.events: list[tuple[str, str]] = []
        self.fail: Exception | None = None

    def list_retrieval_keys(self, bucket: str) -> tuple[str, ...]:
        self._guard()
        self.events.append(("list", bucket))
        return tuple(sorted(key for key in self.objects if key.startswith("retrieval/")))

    def read_state(self, bucket: str) -> bytes | None:
        self._guard()
        self.events.append(("read-state", bucket))
        return self.objects.get(STATE_KEY)

    def write_object(self, bucket: str, key: str, body: bytes) -> None:
        self._guard()
        self.events.append(("write", key))
        self.objects[key] = body

    def delete_object(self, bucket: str, key: str) -> None:
        self._guard()
        self.events.append(("delete", key))
        self.objects.pop(key, None)

    def _guard(self) -> None:
        if self.fail is not None:
            raise self.fail


class FakeIngestion:
    def __init__(self) -> None:
        self.jobs: list[IngestionJob] = []
        self.start_status = "STARTING"
        self.get_statuses = ["COMPLETE"]
        self.events: list[tuple[str, str]] = []
        self.fail: Exception | None = None

    def list_jobs(self, knowledge_base_id: str, data_source_id: str) -> tuple[IngestionJob, ...]:
        self._guard()
        self.events.append(("list", knowledge_base_id))
        assert data_source_id == _SOURCE
        return tuple(self.jobs)

    def start_job(
        self, knowledge_base_id: str, data_source_id: str, client_token: str
    ) -> IngestionJob:
        self._guard()
        self.events.append(("start", client_token))
        assert knowledge_base_id == _KB
        assert data_source_id == _SOURCE
        return IngestionJob("job-1", self.start_status)

    def get_job(self, knowledge_base_id: str, data_source_id: str, job_id: str) -> IngestionJob:
        self._guard()
        self.events.append(("get", job_id))
        assert knowledge_base_id == _KB
        status = self.get_statuses.pop(0)
        return IngestionJob(job_id, status)

    def _guard(self) -> None:
        if self.fail is not None:
            raise self.fail


def test_first_publication_plan_reports_uploads_without_mutations(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path)
    storage, ingestion = FakeStorage(), FakeIngestion()
    report = _run(tmp_path, storage, ingestion, apply=False)
    assert report.exit_code == 0
    assert report.ingestion == "required"
    assert report.uploads == tuple(sorted(corpus.hashes))
    assert report.unchanged == ()
    assert report.deletes == ()
    assert report.unmanaged == ()
    assert storage.events == [("read-state", _BUCKET), ("list", _BUCKET)]
    assert [name for name, _value in ingestion.events] == ["list"]
    assert _TEXT not in _rendered(report)


def test_classifies_changed_unchanged_and_managed_stale_objects(tmp_path: Path) -> None:
    current = _corpus(tmp_path)
    previous = _corpus_with_extra_stale()
    storage = FakeStorage()
    storage.objects = {**_remote_bodies(previous), STATE_KEY: _state_bytes(previous, "COMPLETE")}
    source = tmp_path / "retrieval" / _SOURCE_NAME
    source.write_bytes(b"Title: Updated role\n")
    _rewrite_hash(tmp_path)
    report = _run(tmp_path, storage, FakeIngestion(), apply=False)
    assert _key(_SOURCE_NAME) in report.uploads
    assert _key(_METADATA_NAME) in report.unchanged
    assert report.deletes == (
        _key("old-role--description.txt"),
        _key("old-role--description.txt.metadata.json"),
    )
    assert report.unmanaged == ()
    assert current.digest != ""


def test_apply_refuses_unmanaged_objects_before_any_mutation(tmp_path: Path) -> None:
    _corpus(tmp_path)
    storage = FakeStorage()
    storage.objects["retrieval/stray.txt"] = b"stray"
    with pytest.raises(PublisherError, match=f"^{UNMANAGED}\nretrieval/stray.txt$") as caught:
        _run(tmp_path, storage, FakeIngestion(), apply=True)
    assert caught.value.__cause__ is None
    assert [name for name, _value in storage.events if name in {"write", "delete"}] == []


def test_apply_deletes_only_previously_managed_keys(tmp_path: Path) -> None:
    _corpus(tmp_path)
    previous = _corpus_with_extra_stale()
    storage = FakeStorage()
    storage.objects = {**_remote_bodies(previous), STATE_KEY: _state_bytes(previous, "COMPLETE")}
    report = _run(tmp_path, storage, FakeIngestion(), apply=True)
    deleted = [key for name, key in storage.events if name == "delete"]
    assert report.exit_code == 0
    assert deleted == [
        _key("old-role--description.txt"),
        _key("old-role--description.txt.metadata.json"),
    ]


def test_desired_remote_object_absent_from_state_is_uploaded(tmp_path: Path) -> None:
    _corpus(tmp_path)
    storage = FakeStorage()
    storage.objects[_key(_SOURCE_NAME)] = b"already there"
    report = _run(tmp_path, storage, FakeIngestion(), apply=False)
    assert _key(_SOURCE_NAME) in report.uploads
    assert report.unmanaged == ()
    assert "write" not in [name for name, _value in storage.events]


def test_missing_state_is_a_first_publication(tmp_path: Path) -> None:
    _corpus(tmp_path)
    report = _run(tmp_path, FakeStorage(), FakeIngestion(), apply=False)
    assert report.ingestion == "required"
    assert report.uploads


def test_malformed_remote_state_fails_closed(tmp_path: Path) -> None:
    _corpus(tmp_path)
    storage = FakeStorage()
    storage.objects[STATE_KEY] = b"{not json"
    with pytest.raises(PublisherError, match=f"^{STATE_INVALID}$"):
        _run(tmp_path, storage, FakeIngestion(), apply=True)
    assert "write" not in [name for name, _value in storage.events]


def test_incompatible_state_version_fails_closed(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path)
    storage = FakeStorage()
    payload = json.loads(_state_bytes(corpus, "COMPLETE"))
    payload["schemaVersion"] = 2
    storage.objects[STATE_KEY] = (json.dumps(payload) + "\n").encode()
    with pytest.raises(PublisherError, match=f"^{STATE_INCOMPATIBLE}$"):
        _run(tmp_path, storage, FakeIngestion(), apply=True)
    assert storage.objects[STATE_KEY].startswith(b"{")


def test_unsafe_filenames_and_symlinks_are_rejected(tmp_path: Path) -> None:
    directory = tmp_path / "retrieval"
    directory.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")
    link = directory / "aws-sde-ii--role-description.txt"
    os.symlink(outside, link)
    _write_manifest(tmp_path, [_chunk(_SOURCE_NAME, b"outside\n", _sidecar(_SOURCE_NAME))])
    with pytest.raises(PublisherError, match=f"^{FILENAME_UNSAFE}$"):
        load_corpus(tmp_path / "retrieval-manifest.json", directory)
    manifest = tmp_path / "retrieval-manifest.json"
    document = json.loads(manifest.read_text(encoding="utf-8"))
    document["chunks"][0]["sourceFilename"] = "../escape.txt"
    manifest.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(PublisherError, match=f"^{FILENAME_UNSAFE}$"):
        load_corpus(manifest, directory)


def test_hash_mismatch_and_missing_or_extra_files_are_rejected(tmp_path: Path) -> None:
    corpus_root = _write_corpus(
        tmp_path, [_chunk(_SOURCE_NAME, _TEXT.encode(), _sidecar(_SOURCE_NAME))]
    )
    source = corpus_root / "retrieval" / _SOURCE_NAME
    source.write_bytes(b"changed\n")
    with pytest.raises(PublisherError, match=f"^{ARTIFACT_MISMATCH}$"):
        load_corpus(corpus_root / "retrieval-manifest.json", corpus_root / "retrieval")
    source.write_bytes(_TEXT.encode())
    (corpus_root / "retrieval" / "extra--note.txt").write_text("extra\n", encoding="utf-8")
    with pytest.raises(PublisherError, match=f"^{ARTIFACT_MISMATCH}$"):
        load_corpus(corpus_root / "retrieval-manifest.json", corpus_root / "retrieval")
    (corpus_root / "retrieval" / "extra--note.txt").unlink()
    (corpus_root / "retrieval" / _METADATA_NAME).unlink()
    with pytest.raises(PublisherError, match=f"^{ARTIFACT_MISMATCH}$"):
        load_corpus(corpus_root / "retrieval-manifest.json", corpus_root / "retrieval")


def test_invalid_sidecar_metadata_is_rejected(tmp_path: Path) -> None:
    sidecar = json.loads(_sidecar(_SOURCE_NAME).decode())
    sidecar["metadataAttributes"]["url"]["value"]["stringValue"] = "https://example.com"
    body = (json.dumps(sidecar, indent=2) + "\n").encode()
    root = _write_corpus(tmp_path, [_chunk(_SOURCE_NAME, _TEXT.encode(), body)])
    with pytest.raises(PublisherError, match=f"^{ARTIFACT_MISMATCH}$"):
        load_corpus(root / "retrieval-manifest.json", root / "retrieval")


def test_plan_mode_performs_no_mutations(tmp_path: Path) -> None:
    _corpus(tmp_path)
    storage, ingestion = FakeStorage(), FakeIngestion()
    report = _run(tmp_path, storage, ingestion, apply=False)
    assert report.mode == "plan"
    assert "write" not in [name for name, _value in storage.events]
    assert "delete" not in [name for name, _value in storage.events]
    assert "start" not in [name for name, _value in ingestion.events]


def test_apply_uploads_before_starting_ingestion(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path)
    storage, ingestion = FakeStorage(), FakeIngestion()
    ingestion.get_statuses = ["COMPLETE"]
    report = _run(tmp_path, storage, ingestion, apply=True, tokens=["token-1"])
    names = [name for name, _value in storage.events]
    assert names.index("write") < len(names)
    assert ingestion.events[0] == ("list", _KB)
    assert ingestion.events[1] == ("start", "token-1")
    assert [key for name, key in storage.events if name == "write" and key != STATE_KEY] == list(
        sorted(corpus.hashes)
    )
    assert report.exit_code == 0
    assert report.job_status == "COMPLETE"
    saved = decode_state(storage.objects[STATE_KEY])
    assert saved.ingestion_status == "COMPLETE"
    assert saved.corpus_digest == corpus.digest


def test_unchanged_apply_does_not_upload_delete_or_ingest(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path)
    storage = FakeStorage()
    storage.objects = {**_remote_bodies(corpus), STATE_KEY: _state_bytes(corpus, "COMPLETE")}
    ingestion = FakeIngestion()
    report = _run(tmp_path, storage, ingestion, apply=True)
    assert report.exit_code == 0
    assert report.ingestion == "current"
    assert "write" not in [name for name, _value in storage.events]
    assert "delete" not in [name for name, _value in storage.events]
    assert "start" not in [name for name, _value in ingestion.events]


def test_active_ingestion_prevents_mutation_and_duplicate_start(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path)
    storage = FakeStorage()
    storage.objects[STATE_KEY] = _state_bytes(corpus, "IN_PROGRESS", "job-9")
    ingestion = FakeIngestion()
    ingestion.get_statuses = ["IN_PROGRESS", "COMPLETE"]
    report = _run(tmp_path, storage, ingestion, apply=True)
    assert report.exit_code == 0
    assert report.job_id == "job-9"
    assert "start" not in [name for name, _value in ingestion.events]
    assert [key for name, key in storage.events if name == "write"] == [STATE_KEY]
    assert decode_state(storage.objects[STATE_KEY]).ingestion_status == "COMPLETE"


def test_failed_and_stopped_ingestion_update_state(tmp_path: Path) -> None:
    _corpus(tmp_path)
    for status in ("FAILED", "STOPPED"):
        storage, ingestion = FakeStorage(), FakeIngestion()
        ingestion.get_statuses = [status]
        report = _run(tmp_path, storage, ingestion, apply=True)
        assert report.exit_code == 1
        assert report.job_status == status
        assert decode_state(storage.objects[STATE_KEY]).ingestion_status == status


def test_timeout_leaves_the_job_active(tmp_path: Path) -> None:
    _corpus(tmp_path)
    storage, ingestion = FakeStorage(), FakeIngestion()
    ingestion.get_statuses = ["IN_PROGRESS", "IN_PROGRESS"]
    clock = Clock()
    with pytest.raises(PublisherError, match=f"^{TIMED_OUT}$"):
        _run(tmp_path, storage, ingestion, apply=True, clock=clock, timeout=5, interval=5)
    assert clock.sleeps == [5]
    assert decode_state(storage.objects[STATE_KEY]).ingestion_status == "IN_PROGRESS"


def test_retry_requires_the_flag_and_uses_a_new_client_token(tmp_path: Path) -> None:
    corpus = _corpus(tmp_path)
    storage = FakeStorage()
    storage.objects = {
        **_remote_bodies(corpus),
        STATE_KEY: _state_bytes(corpus, "FAILED", "job-old"),
    }
    ingestion = FakeIngestion()
    with pytest.raises(PublisherError, match=f"^{RETRY_REQUIRED}$"):
        _run(tmp_path, storage, ingestion, apply=True)
    assert "start" not in [name for name, _value in ingestion.events]
    ingestion.get_statuses = ["COMPLETE"]
    report = _run(tmp_path, storage, ingestion, apply=True, retry=True, tokens=["token-2"])
    assert report.exit_code == 0
    assert ("start", "token-2") in ingestion.events


def test_changed_corpus_after_failure_does_not_require_retry_flag(tmp_path: Path) -> None:
    previous = _corpus(tmp_path)
    storage = FakeStorage()
    storage.objects = {**_remote_bodies(previous), STATE_KEY: _state_bytes(previous, "FAILED")}
    source = tmp_path / "retrieval" / _SOURCE_NAME
    source.write_bytes(b"Title: Updated role\n")
    _rewrite_hash(tmp_path)
    ingestion = FakeIngestion()
    ingestion.get_statuses = ["COMPLETE"]
    report = _run(tmp_path, storage, ingestion, apply=True, tokens=["token-3"])
    assert report.exit_code == 0
    assert ("start", "token-3") in ingestion.events


def test_untracked_active_job_refuses_a_duplicate(tmp_path: Path) -> None:
    _corpus(tmp_path)
    ingestion = FakeIngestion()
    ingestion.jobs = [IngestionJob("job-orphan", "IN_PROGRESS")]
    storage = FakeStorage()
    with pytest.raises(PublisherError, match=f"^{ACTIVE_JOB}: job-orphan IN_PROGRESS$"):
        _run(tmp_path, storage, ingestion, apply=True)
    assert "start" not in [name for name, _value in ingestion.events]
    assert "write" not in [name for name, _value in storage.events]


def test_aws_errors_are_sanitized(tmp_path: Path) -> None:
    _corpus(tmp_path)
    storage = FakeStorage()
    storage.fail = RuntimeError("secret AKIAIOSFODNN7EXAMPLE and /home/example/private")
    with pytest.raises(PublisherError, match=f"^{SERVICE_UNAVAILABLE}$") as caught:
        _run(tmp_path, storage, FakeIngestion(), apply=True)
    assert caught.value.__cause__ is None
    assert "AKIA" not in str(caught.value)
    assert "/home/example" not in str(caught.value)


def test_clients_use_the_requested_region_and_validation_precedes_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    constructed: list[tuple[str, str]] = []

    def client(service_name: str, **kwargs: object) -> object:
        region = kwargs.get("region_name")
        assert isinstance(region, str)
        constructed.append((service_name, region))
        return object()

    monkeypatch.setitem(
        __import__("sys").modules, "boto3", type("Boto", (), {"client": staticmethod(client)})
    )
    default_clients("us-west-2")
    assert constructed == [("s3", "us-west-2"), ("bedrock-agent", "us-west-2")]

    def forbidden(region: str) -> tuple[FakeStorage, FakeIngestion]:
        raise AssertionError(region)

    assert main(["--bucket", "BAD"], client_factory=forbidden) == 1


def test_s3_adapter_lists_only_the_retrieval_prefix_and_treats_missing_state_as_absent() -> None:
    class Client:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, object]]] = []

        def list_objects_v2(self, **kwargs: object) -> dict[str, object]:
            self.calls.append(("list_objects_v2", dict(kwargs)))
            if kwargs.get("ContinuationToken") is None:
                return {
                    "IsTruncated": True,
                    "NextContinuationToken": "next",
                    "Contents": [{"Key": "retrieval/one.txt"}],
                }
            return {"IsTruncated": False, "Contents": [{"Key": "retrieval/two.txt"}]}

        def get_object(self, **_kwargs: object) -> dict[str, object]:
            raise MissingState()

    client = Client()
    storage = S3ObjectStorage(client)
    assert storage.list_retrieval_keys(_BUCKET) == ("retrieval/one.txt", "retrieval/two.txt")
    assert client.calls[0][1]["Prefix"] == "retrieval/"
    assert storage.read_state(_BUCKET) is None


def test_ingestion_adapter_uses_only_list_start_and_get() -> None:
    class Client:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def list_ingestion_jobs(self, **_kwargs: object) -> dict[str, object]:
            self.calls.append("list_ingestion_jobs")
            return {"ingestionJobSummaries": [{"ingestionJobId": "job-1", "status": "COMPLETE"}]}

        def start_ingestion_job(self, **kwargs: object) -> dict[str, object]:
            self.calls.append("start_ingestion_job")
            assert kwargs["clientToken"] == "token-1"
            return {"ingestionJob": {"ingestionJobId": "job-2", "status": "STARTING"}}

        def get_ingestion_job(self, **_kwargs: object) -> dict[str, object]:
            self.calls.append("get_ingestion_job")
            return {"ingestionJob": {"ingestionJobId": "job-2", "status": "COMPLETE"}}

    client = Client()
    ingestion = BedrockIngestion(client)
    assert ingestion.list_jobs(_KB, _SOURCE)[0].status == "COMPLETE"
    assert ingestion.start_job(_KB, _SOURCE, "token-1").job_id == "job-2"
    assert ingestion.get_job(_KB, _SOURCE, "job-2").status == "COMPLETE"
    assert client.calls == ["list_ingestion_jobs", "start_ingestion_job", "get_ingestion_job"]


def test_publisher_package_is_outside_the_lambda_package() -> None:
    source = Path(__file__).resolve().parents[1] / "src"
    assert (source / "retrieval_publisher" / "cli.py").is_file()
    assert not (source / "ask_api" / "retrieval_publisher").exists()
    publisher_source = "\n".join(
        path.read_text() for path in (source / "retrieval_publisher").glob("*.py")
    )
    assert "subprocess" not in publisher_source
    assert "os.system" not in publisher_source


def test_argument_validation_rejects_credentials_and_bad_values() -> None:
    with pytest.raises(PublisherError, match=f"^{BUCKET_INVALID}$"):
        parse_options(
            ["--bucket", "Bad_Bucket", "--knowledge-base-id", _KB, "--data-source-id", _SOURCE]
        )
    with pytest.raises(PublisherError) as caught:
        parse_options(["--access-key", "secret", "--bucket", _BUCKET])
    assert "secret" not in str(caught.value)
    options = parse_options(
        ["--bucket", _BUCKET, "--knowledge-base-id", _KB, "--data-source-id", _SOURCE]
    )
    assert options.region == "us-west-2"
    assert options.apply is False
    assert options.poll_interval_seconds == 5
    assert options.wait_timeout_seconds == 900


def test_manifest_schema_is_rejected_when_incompatible(tmp_path: Path) -> None:
    root = _write_corpus(tmp_path, [_chunk(_SOURCE_NAME, _TEXT.encode(), _sidecar(_SOURCE_NAME))])
    manifest = root / "retrieval-manifest.json"
    document = json.loads(manifest.read_text(encoding="utf-8"))
    document["schemaVersion"] = 2
    manifest.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(PublisherError, match=f"^{MANIFEST_INCOMPATIBLE}$"):
        load_corpus(manifest, root / "retrieval")


_SOURCE_NAME = "aws-sde-ii--role-description.txt"
_METADATA_NAME = f"{_SOURCE_NAME}.metadata.json"


def _run(
    root: Path,
    storage: FakeStorage,
    ingestion: FakeIngestion,
    *,
    apply: bool,
    retry: bool = False,
    tokens: list[str] | None = None,
    clock: Clock | None = None,
    timeout: int = 30,
    interval: int = 5,
):
    options = PublishOptions(
        bucket=_BUCKET,
        knowledge_base_id=_KB,
        data_source_id=_SOURCE,
        region="us-west-2",
        apply=apply,
        retry_failed=retry,
        poll_interval_seconds=interval,
        wait_timeout_seconds=timeout,
    )
    corpus = load_corpus(root / "retrieval-manifest.json", root / "retrieval")
    timer = Clock() if clock is None else clock
    remaining = list(tokens or ["token-1"])

    def token_factory() -> str:
        return remaining.pop(0)

    return execute(
        options,
        corpus,
        storage,
        ingestion,
        sleep=timer.sleep,
        monotonic=timer.monotonic,
        token_factory=token_factory,
    )


def _corpus(root: Path):
    written = _write_corpus(root, [_chunk(_SOURCE_NAME, _TEXT.encode(), _sidecar(_SOURCE_NAME))])
    return load_corpus(written / "retrieval-manifest.json", written / "retrieval")


def _corpus_with_extra_stale():
    text = _TEXT.encode()
    sidecar = _sidecar(_SOURCE_NAME)
    other_name = "old-role--description.txt"
    other_text = _OTHER.encode()
    other_sidecar = _sidecar(
        other_name, "/background/bloomtech-backend-development#program", "background"
    )
    root = Path(__import__("tempfile").mkdtemp())
    _write_corpus(
        root,
        [
            _chunk(_SOURCE_NAME, text, sidecar),
            _chunk(
                other_name, other_text, other_sidecar, "bloomtech-backend-development", "background"
            ),
        ],
    )
    return load_corpus(root / "retrieval-manifest.json", root / "retrieval")


def _write_corpus(root: Path, chunks: list[dict[str, object]]) -> Path:
    directory = root / "retrieval"
    directory.mkdir(parents=True, exist_ok=True)
    for chunk in chunks:
        (directory / str(chunk["sourceFilename"])).write_bytes(cast(bytes, chunk["sourceBytes"]))
        (directory / str(chunk["metadataFilename"])).write_bytes(
            cast(bytes, chunk["metadataBytes"])
        )
    _write_manifest(root, chunks)
    return root


def _write_manifest(root: Path, chunks: list[dict[str, object]]) -> None:
    manifest = {
        "schemaVersion": 1,
        "generatorVersion": RETRIEVAL_GENERATOR_VERSION,
        "chunkCount": len(chunks),
        "chunks": [
            {
                key: value
                for key, value in chunk.items()
                if key not in {"sourceBytes", "metadataBytes"}
            }
            for chunk in chunks
        ],
    }
    (root / "retrieval-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def _chunk(
    source_name: str,
    source: bytes,
    metadata: bytes,
    document_id: str = "aws-sde-ii",
    document_type: str = "experience",
) -> dict[str, object]:
    import hashlib

    url = "/experience/aws-sde-ii#role-description"
    title = "Software Development Engineer II"
    section = "Role Description"
    if document_type == "background":
        url = "/background/bloomtech-backend-development#program"
        title = "Backend Development"
        section = "Program"
    return {
        "sourceFilename": source_name,
        "metadataFilename": f"{source_name}.metadata.json",
        "chunkId": f"{document_id}:{url.partition('#')[2]}:0",
        "documentId": document_id,
        "documentType": document_type,
        "title": title,
        "section": section,
        "url": url,
        "sourceSha256": hashlib.sha256(source).hexdigest(),
        "metadataSha256": hashlib.sha256(metadata).hexdigest(),
        "sourceBytes": source,
        "metadataBytes": metadata,
    }


def _sidecar(
    source_name: str,
    url: str = "/experience/aws-sde-ii#role-description",
    document_type: str = "experience",
) -> bytes:
    document_id = "aws-sde-ii" if document_type == "experience" else "bloomtech-backend-development"
    title = (
        "Software Development Engineer II"
        if document_type == "experience"
        else "Backend Development"
    )
    section = "Role Description" if document_type == "experience" else "Program"
    attributes = {
        "chunkId": f"{document_id}:{url.partition('#')[2]}:0",
        "documentId": document_id,
        "title": title,
        "section": section,
        "url": url,
        "type": document_type,
    }
    metadata_attributes = {
        field: {"value": {"type": "STRING", "stringValue": value}, "includeForEmbedding": False}
        for field, value in attributes.items()
    }
    return (json.dumps({"metadataAttributes": metadata_attributes}, indent=2) + "\n").encode()


def _state_bytes(corpus: Corpus, status: str, job_id: str = "job-1") -> bytes:
    from retrieval_publisher.models import PublicationState

    return encode_state(
        PublicationState(
            corpus_digest=corpus.digest,
            managed_objects=dict(corpus.hashes),
            knowledge_base_id=_KB,
            data_source_id=_SOURCE,
            ingestion_job_id=job_id,
            ingestion_status=status,
        )
    )


def _remote_bodies(corpus: Corpus) -> dict[str, bytes]:
    return dict(corpus.bodies)


def _key(filename: str) -> str:
    return f"retrieval/{filename}"


def _rewrite_hash(root: Path) -> None:
    directory = root / "retrieval"
    source = (directory / _SOURCE_NAME).read_bytes()
    metadata = (directory / _METADATA_NAME).read_bytes()
    manifest = json.loads((root / "retrieval-manifest.json").read_text(encoding="utf-8"))
    import hashlib

    manifest["chunks"][0]["sourceSha256"] = hashlib.sha256(source).hexdigest()
    manifest["chunks"][0]["metadataSha256"] = hashlib.sha256(metadata).hexdigest()
    (root / "retrieval-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _rendered(report: PublicationReport) -> str:
    from retrieval_publisher.workflow import render

    return render(report)


class MissingState(Exception):
    def __init__(self) -> None:
        super().__init__("hidden NoSuchKey detail")
        self.response = {"Error": {"Code": "NoSuchKey", "Message": "secret bucket detail"}}
