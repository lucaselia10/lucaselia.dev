"""Command-line entry for the retrieval publisher."""

from __future__ import annotations

import argparse
import re
import sys
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NoReturn

from retrieval_publisher.clients import IngestionControl, ObjectStorage, default_clients
from retrieval_publisher.corpus import default_artifact_paths, load_corpus
from retrieval_publisher.errors import (
    ARGUMENTS_INVALID,
    BUCKET_INVALID,
    DATA_SOURCE_INVALID,
    KNOWLEDGE_BASE_INVALID,
    POLL_INVALID,
    REGION_INVALID,
    TIMEOUT_INVALID,
    PublisherError,
)
from retrieval_publisher.models import PublishOptions
from retrieval_publisher.workflow import execute, render

_BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9]{1,20}$")
_REGION = re.compile(r"^[a-z]{2}-(?:[a-z]+-)+\d+$")


def main(
    argv: Sequence[str] | None = None,
    *,
    paths: tuple[Path, Path] | None = None,
    client_factory: Callable[[str], tuple[ObjectStorage, IngestionControl]] | None = None,
    sleep: Callable[[float], None] | None = None,
    monotonic: Callable[[], float] | None = None,
    token_factory: Callable[[], str] | None = None,
) -> int:
    """Validate inputs, then plan or apply. Clients are built only after validation."""
    try:
        options = parse_options(sys.argv[1:] if argv is None else argv)
        manifest_path, artifact_directory = default_artifact_paths() if paths is None else paths
        corpus = load_corpus(manifest_path, artifact_directory)
        factory = default_clients if client_factory is None else client_factory
        storage, ingestion = factory(options.region)
        report = execute(
            options,
            corpus,
            storage,
            ingestion,
            sleep=_default_sleep if sleep is None else sleep,
            monotonic=_default_monotonic if monotonic is None else monotonic,
            token_factory=_default_token if token_factory is None else token_factory,
        )
    except PublisherError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(render(report), end="")
    return report.exit_code


class _Parser(argparse.ArgumentParser):
    """Reject unknown arguments without echoing them."""

    def error(self, message: str) -> NoReturn:
        del message
        raise PublisherError(ARGUMENTS_INVALID)


def parse_options(argv: Sequence[str]) -> PublishOptions:
    """Parse publisher arguments and reject credentials or invalid values."""
    parser = _Parser(prog="pnpm publish:retrieval")
    parser.add_argument("--bucket")
    parser.add_argument("--knowledge-base-id")
    parser.add_argument("--data-source-id")
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--poll-interval-seconds", default="5")
    parser.add_argument("--wait-timeout-seconds", default="900")
    try:
        parsed = parser.parse_args(list(argv))
    except SystemExit as error:
        raise PublisherError(ARGUMENTS_INVALID) from error
    bucket = _required_text(parsed.bucket, BUCKET_INVALID)
    knowledge_base_id = _required_text(parsed.knowledge_base_id, KNOWLEDGE_BASE_INVALID)
    data_source_id = _required_text(parsed.data_source_id, DATA_SOURCE_INVALID)
    if _BUCKET.fullmatch(bucket) is None or ".." in bucket or _looks_like_address(bucket):
        raise PublisherError(BUCKET_INVALID)
    if _IDENTIFIER.fullmatch(knowledge_base_id) is None:
        raise PublisherError(KNOWLEDGE_BASE_INVALID)
    if _IDENTIFIER.fullmatch(data_source_id) is None:
        raise PublisherError(DATA_SOURCE_INVALID)
    if not isinstance(parsed.region, str) or _REGION.fullmatch(parsed.region) is None:
        raise PublisherError(REGION_INVALID)
    poll_interval = _positive_int(parsed.poll_interval_seconds, POLL_INVALID)
    wait_timeout = _positive_int(parsed.wait_timeout_seconds, TIMEOUT_INVALID)
    return PublishOptions(
        bucket=bucket,
        knowledge_base_id=knowledge_base_id,
        data_source_id=data_source_id,
        region=parsed.region,
        apply=bool(parsed.apply),
        retry_failed=bool(parsed.retry_failed),
        poll_interval_seconds=poll_interval,
        wait_timeout_seconds=wait_timeout,
    )


def _required_text(value: object, message: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise PublisherError(message)
    return value


def _positive_int(value: object, message: str) -> int:
    if isinstance(value, bool) or not isinstance(value, str) or not value.isdecimal():
        raise PublisherError(message)
    parsed = int(value)
    if parsed < 1:
        raise PublisherError(message)
    return parsed


def _looks_like_address(bucket: str) -> bool:
    parts = bucket.split(".")
    return len(parts) == 4 and all(part.isdecimal() and 0 <= int(part) <= 255 for part in parts)


def _default_sleep(seconds: float) -> None:
    import time

    time.sleep(seconds)


def _default_monotonic() -> float:
    import time

    return time.monotonic()


def _default_token() -> str:
    return str(uuid.uuid4())
