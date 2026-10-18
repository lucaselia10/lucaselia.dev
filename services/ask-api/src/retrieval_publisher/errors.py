"""Stable operator-facing publication errors."""


class PublisherError(Exception):
    """Failure text safe to print. It contains no credentials, bodies, or local paths."""


SERVICE_UNAVAILABLE = "The retrieval publication service is unavailable."
MANIFEST_MISSING = "The retrieval manifest is missing."
MANIFEST_INVALID = "The retrieval manifest is not valid."
MANIFEST_INCOMPATIBLE = "The retrieval manifest is not compatible."
ARTIFACTS_MISSING = "The retrieval artifacts are missing."
FILENAME_UNSAFE = "A retrieval filename is not safe."
ARTIFACT_MISMATCH = "A retrieval artifact does not match the manifest."
STATE_INVALID = "The publication state is not valid."
STATE_INCOMPATIBLE = "The publication state is not compatible."
STATE_TARGET_MISMATCH = "The publication state does not match this target."
UNMANAGED = "Unmanaged retrieval objects require review."
RETRY_REQUIRED = "A failed ingestion requires --retry-failed."
ACTIVE_JOB = "An ingestion job is already running."
TIMED_OUT = "Ingestion is still running and the wait timed out."
UNKNOWN_STATUS = "Ingestion returned an unrecognized status."
ARGUMENTS_INVALID = "Publication arguments are not valid."
BUCKET_INVALID = "The bucket name is not valid."
KNOWLEDGE_BASE_INVALID = "The Knowledge Base id is not valid."
DATA_SOURCE_INVALID = "The data source id is not valid."
REGION_INVALID = "The region is not valid."
POLL_INVALID = "The poll interval is not valid."
TIMEOUT_INVALID = "The wait timeout is not valid."
