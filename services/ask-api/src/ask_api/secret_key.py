"""The Anthropic API key for the production app.

In Lambda the key comes from AWS Secrets Manager, named by ANTHROPIC_SECRET_NAME, read once
and kept in memory for the life of the execution environment. Outside Lambda, the local
launcher may pass ANTHROPIC_API_KEY instead (read from the macOS Keychain). The key, the
secret's value, and the SDK's error text are never logged or put in an exception message.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Mapping
from typing import Protocol, cast

from ask_api.model_providers import ModelSetupError

SECRET_NAME_VARIABLE = "ANTHROPIC_SECRET_NAME"
LOCAL_KEY_VARIABLE = "ANTHROPIC_API_KEY"
#: A JSON secret (the console's key/value form) holds the key under this name.
SECRET_JSON_FIELD = "ANTHROPIC_API_KEY"
KEY_MESSAGE = "The model credentials are unavailable."


class KeyUnavailable(ModelSetupError):
    """The key could not be read. ``cause`` is an exception class name, safe to log."""

    def __init__(self, cause: str) -> None:
        super().__init__(KEY_MESSAGE)
        self.cause = cause


class SecretsClient(Protocol):
    """The one Secrets Manager call the app makes."""

    def get_secret_value(self, *, SecretId: str) -> Mapping[str, object]: ...


class ApiKeySource:
    """Returns the API key, loading it on first use and caching it after success.

    A failed load is not cached, so the next request in the same environment tries again.
    """

    def __init__(
        self,
        environ: Mapping[str, str],
        *,
        secrets_client_factory: Callable[[], SecretsClient] | None = None,
    ) -> None:
        self._secret_name = environ.get(SECRET_NAME_VARIABLE, "").strip()
        self._local_key = environ.get(LOCAL_KEY_VARIABLE, "").strip()
        self._in_lambda = environ.get("AWS_LAMBDA_FUNCTION_NAME", "").strip() != ""
        self._factory = secrets_client_factory or _secrets_manager_client
        self._lock = threading.Lock()
        self._key: str | None = None

    def check(self) -> None:
        """Refuse a configuration that cannot work, without reading anything."""
        if self._secret_name == "" and (self._in_lambda or self._local_key == ""):
            # In Lambda the key must come from Secrets Manager, never an environment variable.
            raise ModelSetupError(KEY_MESSAGE)

    def key(self) -> str:
        with self._lock:
            if self._key is None:
                self._key = self._load()
            return self._key

    def _load(self) -> str:
        self.check()
        if self._secret_name == "":
            return self._local_key
        try:
            response = self._factory().get_secret_value(SecretId=self._secret_name)
            key = _key_from_secret(response.get("SecretString"))
        except Exception as error:
            # The SDK's message can name the secret or the account; only the class is kept.
            raise KeyUnavailable(type(error).__name__) from None
        return key


def _key_from_secret(value: object) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError("empty secret")
    text = value.strip()
    if text.startswith(("{", "[")):
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            raise ValueError("unexpected secret shape")
        field = cast(dict[str, object], parsed).get(SECRET_JSON_FIELD)
        if not isinstance(field, str) or field.strip() == "":
            raise ValueError("unexpected secret shape")
        return field.strip()
    return text


def _secrets_manager_client() -> SecretsClient:
    """A Secrets Manager client in the function's region: 2-second connect, 5-second read."""
    from botocore.config import Config

    config = Config(connect_timeout=2, read_timeout=5, retries={"total_max_attempts": 2})
    # boto3-stubs is installed without the secretsmanager extra, so the client is reached the
    # way grounding_factory does it; the Protocol above is the one call this module makes.
    module: object = __import__("boto3")
    create = getattr(module, "client")
    return cast(SecretsClient, create("secretsmanager", config=config))
