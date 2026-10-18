"""S3 and Bedrock Agent adapters. Tests inject fakes that implement the same methods."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol, cast

from retrieval_publisher.errors import SERVICE_UNAVAILABLE, PublisherError
from retrieval_publisher.models import RETRIEVAL_PREFIX, STATE_KEY, IngestionJob


class ObjectStorage(Protocol):
    """The four S3 operations the publisher is allowed to use."""

    def list_retrieval_keys(self, bucket: str) -> tuple[str, ...]:
        """Return object keys under the retrieval prefix."""
        ...

    def read_state(self, bucket: str) -> bytes | None:
        """Return the private state object, or None when this is the first publication."""
        ...

    def write_object(self, bucket: str, key: str, body: bytes) -> None:
        """Upload one validated object or the private state document."""
        ...

    def delete_object(self, bucket: str, key: str) -> None:
        """Delete one previously managed retrieval object."""
        ...


class IngestionControl(Protocol):
    """The three Bedrock Agent ingestion operations the publisher is allowed to use."""

    def list_jobs(self, knowledge_base_id: str, data_source_id: str) -> tuple[IngestionJob, ...]:
        """List ingestion jobs for one data source."""
        ...

    def start_job(
        self,
        knowledge_base_id: str,
        data_source_id: str,
        client_token: str,
    ) -> IngestionJob:
        """Start one ingestion job."""
        ...

    def get_job(
        self,
        knowledge_base_id: str,
        data_source_id: str,
        job_id: str,
    ) -> IngestionJob:
        """Read one ingestion job."""
        ...


class S3ObjectStorage:
    """Boto3 S3 adapter limited to list, get, put, and delete."""

    def __init__(self, client: object) -> None:
        self._client = client

    def list_retrieval_keys(self, bucket: str) -> tuple[str, ...]:
        keys: list[str] = []
        token: str | None = None
        while True:
            kwargs: dict[str, str] = {"Bucket": bucket, "Prefix": RETRIEVAL_PREFIX}
            if token is not None:
                kwargs["ContinuationToken"] = token
            response = _mapping(_invoke(self._client, "list_objects_v2", kwargs))
            for item in _dict_items(response.get("Contents", [])):
                key = item.get("Key")
                if isinstance(key, str):
                    keys.append(key)
            if response.get("IsTruncated") is not True:
                return tuple(keys)
            next_token = response.get("NextContinuationToken")
            if not isinstance(next_token, str) or next_token == "":
                return tuple(keys)
            token = next_token

    def read_state(self, bucket: str) -> bytes | None:
        method = getattr(self._client, "get_object")
        if not callable(method):
            raise PublisherError(SERVICE_UNAVAILABLE)
        try:
            response = _mapping(method(Bucket=bucket, Key=STATE_KEY))
        except PublisherError:
            raise
        except Exception as error:
            if _missing(error):
                return None
            raise PublisherError(SERVICE_UNAVAILABLE) from None
        body = response.get("Body")
        read = getattr(body, "read", None)
        if not callable(read):
            raise PublisherError(SERVICE_UNAVAILABLE)
        try:
            payload = read()
        except Exception:
            raise PublisherError(SERVICE_UNAVAILABLE) from None
        if not isinstance(payload, bytes):
            raise PublisherError(SERVICE_UNAVAILABLE)
        return payload

    def write_object(self, bucket: str, key: str, body: bytes) -> None:
        _invoke(self._client, "put_object", {"Bucket": bucket, "Key": key, "Body": body})

    def delete_object(self, bucket: str, key: str) -> None:
        _invoke(self._client, "delete_object", {"Bucket": bucket, "Key": key})


class BedrockIngestion:
    """Boto3 Bedrock Agent adapter limited to list, start, and get ingestion jobs."""

    def __init__(self, client: object) -> None:
        self._client = client

    def list_jobs(self, knowledge_base_id: str, data_source_id: str) -> tuple[IngestionJob, ...]:
        jobs: list[IngestionJob] = []
        token: str | None = None
        while True:
            kwargs: dict[str, str] = {
                "knowledgeBaseId": knowledge_base_id,
                "dataSourceId": data_source_id,
            }
            if token is not None:
                kwargs["nextToken"] = token
            response = _mapping(_invoke(self._client, "list_ingestion_jobs", kwargs))
            for item in _dict_items(response.get("ingestionJobSummaries", [])):
                jobs.append(_job(item))
            next_token = response.get("nextToken")
            if not isinstance(next_token, str) or next_token == "":
                return tuple(jobs)
            token = next_token

    def start_job(
        self,
        knowledge_base_id: str,
        data_source_id: str,
        client_token: str,
    ) -> IngestionJob:
        response = _mapping(
            _invoke(
                self._client,
                "start_ingestion_job",
                {
                    "knowledgeBaseId": knowledge_base_id,
                    "dataSourceId": data_source_id,
                    "clientToken": client_token,
                },
            )
        )
        job = response.get("ingestionJob")
        if not isinstance(job, dict):
            raise PublisherError(SERVICE_UNAVAILABLE)
        return _job(cast(dict[str, object], job))

    def get_job(self, knowledge_base_id: str, data_source_id: str, job_id: str) -> IngestionJob:
        response = _mapping(
            _invoke(
                self._client,
                "get_ingestion_job",
                {
                    "knowledgeBaseId": knowledge_base_id,
                    "dataSourceId": data_source_id,
                    "ingestionJobId": job_id,
                },
            )
        )
        job = response.get("ingestionJob")
        if not isinstance(job, dict):
            raise PublisherError(SERVICE_UNAVAILABLE)
        return _job(cast(dict[str, object], job))


def default_clients(region: str) -> tuple[ObjectStorage, IngestionControl]:
    """Construct regional clients after argument and corpus validation have passed."""
    return S3ObjectStorage(_boto3_client("s3", region)), BedrockIngestion(
        _boto3_client("bedrock-agent", region)
    )


def _boto3_client(service_name: str, region: str) -> object:
    module: object = __import__("boto3")
    create = getattr(module, "client")
    if not callable(create):
        raise PublisherError(SERVICE_UNAVAILABLE)
    try:
        return create(service_name, region_name=region)
    except Exception:
        raise PublisherError(SERVICE_UNAVAILABLE) from None


def _invoke(client: object, method_name: str, kwargs: Mapping[str, object]) -> object:
    method = getattr(client, method_name)
    if not callable(method):
        raise PublisherError(SERVICE_UNAVAILABLE)
    try:
        return method(**kwargs)
    except PublisherError:
        raise
    except Exception:
        raise PublisherError(SERVICE_UNAVAILABLE) from None


def _dict_items(value: object) -> tuple[dict[str, object], ...]:
    if not isinstance(value, list):
        return ()
    items: list[dict[str, object]] = []
    for item in cast(list[object], value):
        if isinstance(item, dict):
            items.append(cast(dict[str, object], item))
    return tuple(items)


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise PublisherError(SERVICE_UNAVAILABLE)
    return cast(dict[str, object], value)


def _job(payload: dict[str, object]) -> IngestionJob:
    job_id = payload.get("ingestionJobId")
    status = payload.get("status")
    if not isinstance(job_id, str) or job_id == "" or not isinstance(status, str) or status == "":
        raise PublisherError(SERVICE_UNAVAILABLE)
    return IngestionJob(job_id=job_id, status=status)


def _missing(error: Exception) -> bool:
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return False
    details = cast(dict[str, object], response).get("Error")
    if not isinstance(details, dict):
        return False
    code = cast(dict[str, object], details).get("Code")
    return code in {"NoSuchKey", "404", "NotFound"}
