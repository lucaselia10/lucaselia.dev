"""The production API key: Secrets Manager, cached, never echoed. Fake clients only."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import pytest

from ask_api import production_app
from ask_api.local_evidence import EvidencePackage
from ask_api.model_providers import ModelSetupError, anthropic_api
from ask_api.secret_key import KEY_MESSAGE, ApiKeySource, KeyUnavailable

# Assembled at runtime so the repository holds no key-shaped literal.
SECRET_VALUE = "-".join(["sk", "ant", "dummy", "secret", "value"])
SECRET_NAME = "portfolio/anthropic-api-key"


class FakeSecrets:
    def __init__(self, responses: list[Mapping[str, object] | Exception]) -> None:
        self.responses = responses
        self.calls: list[str] = []

    def get_secret_value(self, *, SecretId: str) -> Mapping[str, object]:
        self.calls.append(SecretId)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def source(fake: FakeSecrets, **environ: str) -> ApiKeySource:
    values = {"ANTHROPIC_SECRET_NAME": SECRET_NAME, "AWS_LAMBDA_FUNCTION_NAME": "ask", **environ}
    return ApiKeySource(values, secrets_client_factory=lambda: fake)


def test_key_is_read_once_and_cached() -> None:
    fake = FakeSecrets([{"SecretString": SECRET_VALUE}])
    keys = source(fake)

    assert keys.key() == SECRET_VALUE
    assert keys.key() == SECRET_VALUE
    assert fake.calls == [SECRET_NAME]


def test_json_secret_form_is_accepted() -> None:
    fake = FakeSecrets([{"SecretString": json.dumps({"ANTHROPIC_API_KEY": SECRET_VALUE})}])

    assert source(fake).key() == SECRET_VALUE


def test_a_failed_read_is_not_cached_and_never_echoes_anything() -> None:
    class ResourceNotFoundException(Exception):
        pass

    fake = FakeSecrets(
        [
            ResourceNotFoundException(f"Secrets Manager can't find {SECRET_NAME} {SECRET_VALUE}"),
            {"SecretString": SECRET_VALUE},
        ]
    )
    keys = source(fake)

    with pytest.raises(KeyUnavailable) as raised:
        keys.key()
    assert str(raised.value) == KEY_MESSAGE
    assert raised.value.cause == "ResourceNotFoundException"
    assert raised.value.__cause__ is None
    assert raised.value.__suppress_context__

    assert keys.key() == SECRET_VALUE
    assert len(fake.calls) == 2


@pytest.mark.parametrize(
    "response",
    [{}, {"SecretString": ""}, {"SecretString": "{}"}, {"SecretString": "[1]"}],
)
def test_empty_or_unexpected_secrets_are_refused(response: Mapping[str, object]) -> None:
    with pytest.raises(KeyUnavailable) as raised:
        source(FakeSecrets([response])).key()
    assert str(raised.value) == KEY_MESSAGE


def test_lambda_refuses_a_key_from_the_environment() -> None:
    keys = ApiKeySource({"AWS_LAMBDA_FUNCTION_NAME": "ask", "ANTHROPIC_API_KEY": SECRET_VALUE})

    with pytest.raises(ModelSetupError) as raised:
        keys.check()
    assert SECRET_VALUE not in str(raised.value)


def test_local_runs_may_use_the_keychain_key_from_the_environment() -> None:
    keys = ApiKeySource({"ANTHROPIC_API_KEY": SECRET_VALUE})

    assert keys.key() == SECRET_VALUE


def test_the_provider_is_built_once_from_the_cached_key() -> None:
    fake = FakeSecrets([{"SecretString": SECRET_VALUE}])
    built: list[dict[str, Any]] = []

    def client_factory(**kwargs: Any) -> anthropic_api.MessagesClient:
        built.append(kwargs)
        return object()  # type: ignore[return-value]

    app = production_app.create_app(
        {"ANTHROPIC_SECRET_NAME": SECRET_NAME, "AWS_LAMBDA_FUNCTION_NAME": "ask"},
        package=EvidencePackage(()),
        secrets_client_factory=lambda: fake,
        anthropic_client_factory=client_factory,
    )
    app.warm()
    first = app.provider()
    second = app.provider()

    assert first is second
    assert len(fake.calls) == 1
    assert len(built) == 1
    assert built[0]["api_key"] == SECRET_VALUE
    assert built[0]["max_retries"] == 1


def test_warm_logs_a_setup_failure_without_details() -> None:
    lines: list[str] = []
    fake = FakeSecrets([RuntimeError(SECRET_VALUE)])
    app = production_app.create_app(
        {"ANTHROPIC_SECRET_NAME": SECRET_NAME, "AWS_LAMBDA_FUNCTION_NAME": "ask"},
        package=EvidencePackage(()),
        log=lines.append,
        secrets_client_factory=lambda: fake,
    )
    app.warm()

    assert lines == ["ask setup_error error=RuntimeError"]
