"""Model providers, exercised with injected fake clients. No network, no paid calls."""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator, Mapping, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

import dev_server
from ask_api.exact_answers import FALLBACK_ANSWER
from ask_api.local_conversation import LOCAL_SYSTEM_PROMPT, build_user_message
from ask_api.local_evidence import EvidencePackage, EvidenceSection
from ask_api.local_stream import VALIDATION_MESSAGE, iter_model_events
from ask_api.model_providers import (
    PROVIDER_MESSAGE,
    ModelProvider,
    ModelSetupError,
    check_provider,
    create_provider,
    provider_name,
    provider_names,
)
from ask_api.model_providers import anthropic_api as anthropic_provider
from ask_api.model_providers import bedrock as bedrock_provider
from ask_api.model_providers.anthropic_api import (
    API_KEY_MESSAGE,
    DEFAULT_MODEL_ID,
    AnthropicProvider,
)
from ask_api.model_providers.base import MODEL_MESSAGE
from ask_api.model_providers.bedrock import BedrockProvider

CHUNK_ID = "aws-sde-ii:role-description:0"
NOVA = "us.amazon.nova-2-lite-v1:0"
# Assembled at runtime so the repository holds no key-shaped literal.
SECRET_KEY = "-".join(["sk", "ant", "test", "0000", "never", "shown"])


def fake(client: object) -> Any:
    """A test double standing in for a typed SDK client (the real types are checked in
    test_model_providers_real_clients.py)."""
    return client


class FakeStream:
    """Iterable like the SDK Stream, and records close()."""

    def __init__(self, events: Sequence[object], fail_after: int | None = None) -> None:
        self.events = events
        self.fail_after = fail_after
        self.closed = False

    def __iter__(self) -> Iterator[object]:
        for index, event in enumerate(self.events):
            if self.fail_after is not None and index == self.fail_after:
                raise RuntimeError(f"connection reset {SECRET_KEY}")
            yield event

    def close(self) -> None:
        self.closed = True


class FakeMessages:
    def __init__(self, stream: FakeStream, error: Exception | None = None) -> None:
        self.stream = stream
        self.error = error
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> Iterable[object]:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.stream


class FakeAnthropic:
    def __init__(self, stream: FakeStream, error: Exception | None = None) -> None:
        self.messages = FakeMessages(stream, error)


class FakeBedrock:
    def __init__(self, events: Sequence[Mapping[str, object]]) -> None:
        self.events = events
        self.calls: list[dict[str, object]] = []

    def converse_stream(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(kwargs)
        return {"stream": iter(self.events)}


def anthropic_events(
    chunks: Sequence[str], *, usage: tuple[int, int] | None = (12, 4), stop: bool = True
) -> list[dict[str, object]]:
    """Raw Messages stream events in the SDK's wire shape."""
    input_tokens, output_tokens = usage if usage is not None else (None, None)
    events: list[dict[str, object]] = [
        {"type": "message_start", "message": {"usage": {"input_tokens": input_tokens}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}},
    ]
    for chunk in chunks:
        delta: dict[str, object] = {"type": "text_delta", "text": chunk}
        events.append({"type": "content_block_delta", "index": 0, "delta": delta})
    events.append({"type": "content_block_stop", "index": 0})
    if usage is not None:
        events.append(
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": output_tokens},
            }
        )
    if stop:
        events.append({"type": "message_stop"})
    return events


def bedrock_events(
    chunks: Sequence[str], *, usage: tuple[int, int] | None = (12, 4), stop: bool = True
) -> list[Mapping[str, object]]:
    """ConverseStream events carrying the same content."""
    events: list[Mapping[str, object]] = [
        {"contentBlockDelta": {"delta": {"text": chunk}}} for chunk in chunks
    ]
    if stop:
        events.append({"messageStop": {"stopReason": "end_turn"}})
    if usage is not None:
        events.append({"metadata": {"usage": {"inputTokens": usage[0], "outputTokens": usage[1]}}})
    return events


def package() -> EvidencePackage:
    return EvidencePackage(
        (
            EvidenceSection(
                chunk_id=CHUNK_ID,
                document_id="aws-sde-ii",
                document_type="experience",
                title="Software Development Engineer II",
                section="Role Description",
                url="/experience/aws-sde-ii#role-description",
                text="Improved production reliability across containerized compute.",
            ),
        )
    )


def run(
    provider: ModelProvider, question: str = "What is your current role?"
) -> list[dict[str, object]]:
    return list(
        iter_model_events(
            question,
            (("user", "Earlier question"), ("assistant", "Earlier answer")),
            "request-1",
            package=package(),
            provider=provider,
            input_usd_per_million="1",
            output_usd_per_million="5",
        )
    )


def anthropic(
    events: Sequence[object], fail_after: int | None = None
) -> tuple[AnthropicProvider, FakeAnthropic]:
    client = FakeAnthropic(FakeStream(events, fail_after))
    return AnthropicProvider(fake(client), DEFAULT_MODEL_ID), client


# The same conversations, delivered by each provider's stream format.
CONVERSATIONS: dict[str, tuple[Sequence[str], tuple[int, int] | None, bool]] = {
    "answer": (("Visible answer.\nSOUR", f"CES: {CHUNK_ID}"), (12, 4), True),
    "trailing_newline": (("Visible answer.\n", f"**SOURCES:** {CHUNK_ID}\n"), (30, 9), True),
    "insufficient": ((f"{FALLBACK_ANSWER}\nSOURCES: none",), (8, 3), True),
    "unknown_citation": (("A claim.\nSOURCES: missing-chunk",), (12, 4), True),
    "interrupted": (("Partial answer",), (12, 4), False),
    "no_usage": ((f"Answer.\nSOURCES: {CHUNK_ID}",), None, True),
}


@pytest.mark.parametrize("name", CONVERSATIONS)
def test_both_providers_produce_identical_events(name: str) -> None:
    chunks, usage, stop = CONVERSATIONS[name]
    via_anthropic, _ = anthropic(anthropic_events(chunks, usage=usage, stop=stop))
    via_bedrock = BedrockProvider(
        fake(FakeBedrock(bedrock_events(chunks, usage=usage, stop=stop))), NOVA
    )

    assert run(via_anthropic) == run(via_bedrock)


def test_both_providers_receive_the_same_request() -> None:
    via_anthropic, anthropic_client = anthropic(anthropic_events((f"A.\nSOURCES: {CHUNK_ID}",)))
    bedrock_client = FakeBedrock(bedrock_events((f"A.\nSOURCES: {CHUNK_ID}",)))
    run(via_anthropic)
    run(BedrockProvider(fake(bedrock_client), NOVA))

    sent = anthropic_client.messages.calls[0]
    expected_user = build_user_message(
        "What is your current role?",
        (("user", "Earlier question"), ("assistant", "Earlier answer")),
        package(),
    )
    assert sent == {
        "model": DEFAULT_MODEL_ID,
        "max_tokens": 500,
        "system": LOCAL_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": expected_user}],
        "stream": True,
        # anthropic 1.x has no temperature keyword; Haiku 4.5 still honors it in the body.
        "extra_body": {"temperature": 0.0},
    }
    bedrock_sent = bedrock_client.calls[0]
    assert bedrock_sent["system"] == [{"text": LOCAL_SYSTEM_PROMPT}]
    assert bedrock_sent["messages"] == [{"role": "user", "content": [{"text": expected_user}]}]


def test_anthropic_streams_deltas_and_reports_usage_and_cost() -> None:
    provider, client = anthropic(
        anthropic_events(("Lucas works on ", "capacity planning.\n", f"SOURCES: {CHUNK_ID}"))
    )
    events = run(provider)

    deltas = [event["text"] for event in events if event["type"] == "delta"]
    assert "".join(str(text) for text in deltas) == "Lucas works on capacity planning."
    done = events[-1]
    assert done["type"] == "done"
    assert done["fixture"] is False
    assert done["usage"] == {"inputTokens": 12, "outputTokens": 4}
    assert done["estimatedCostUsd"] == "0.000032"
    assert [citation["chunkId"] for citation in done["citations"]] == [CHUNK_ID]  # type: ignore[index, union-attr]
    assert client.messages.stream.closed is True


def test_anthropic_hides_a_sources_marker_split_across_chunks() -> None:
    text = f"Visible answer.\nSOURCES: {CHUNK_ID}"
    provider, _ = anthropic(anthropic_events(tuple(text)))  # one character per event
    events = run(provider)

    visible = "".join(str(event["text"]) for event in events if event["type"] == "delta")
    assert visible == "Visible answer."
    assert events[-1]["type"] == "done"


def test_anthropic_reports_usage_on_failure() -> None:
    rejected, _ = anthropic(anthropic_events(("A claim.\nSOURCES: missing-chunk",)))
    interrupted, _ = anthropic(anthropic_events(("Partial",), stop=False))

    assert run(rejected)[-1] == {
        "type": "error",
        "code": "validation",
        "message": VALIDATION_MESSAGE,
        "requestId": "request-1",
        "usage": {"inputTokens": 12, "outputTokens": 4},
    }
    assert run(interrupted)[-1]["usage"] == {"inputTokens": 12, "outputTokens": 4}


def test_anthropic_stream_errors_and_tool_output_are_not_answers() -> None:
    broken, client = anthropic(anthropic_events(("Partial", " more")), fail_after=3)
    events = run(broken)
    assert events[-1]["code"] == "unavailable"
    assert client.messages.stream.closed is True
    assert SECRET_KEY not in json.dumps(events)

    tool_events = anthropic_events(("ignored",))
    tool_events[1] = {
        "type": "content_block_start",
        "index": 0,
        "content_block": {"type": "tool_use"},
    }
    tool, _ = anthropic(tool_events)
    assert run(tool)[-1]["code"] == "validation"

    error_events = anthropic_events(("Partial",), stop=False)
    error_events.append({"type": "error", "error": {}})
    errored, _ = anthropic(error_events)
    assert run(errored)[-1]["code"] == "unavailable"


def test_anthropic_reads_sdk_objects_as_well_as_mappings() -> None:
    def obj(value: object) -> object:
        if isinstance(value, dict):
            fields = cast(dict[str, object], value)
            return SimpleNamespace(**{key: obj(item) for key, item in fields.items()})
        return value

    provider, _ = anthropic(
        [obj(event) for event in anthropic_events((f"A.\nSOURCES: {CHUNK_ID}",))]
    )
    done = run(provider)[-1]
    assert done["type"] == "done"
    assert done["usage"] == {"inputTokens": 12, "outputTokens": 4}


def test_missing_key_and_bad_model_are_refused_without_echoing_values() -> None:
    with pytest.raises(ModelSetupError) as missing:
        check_provider({"LOCAL_MODEL_PROVIDER": "anthropic"})
    assert missing.value.public_message == API_KEY_MESSAGE
    with pytest.raises(ModelSetupError):
        check_provider({"ANTHROPIC_API_KEY": "   "})

    for model_id in ("gpt-4o", "claude haiku", "anthropic.claude-haiku-4-5", "claude-"):
        with pytest.raises(ModelSetupError) as invalid:
            check_provider({"ANTHROPIC_API_KEY": SECRET_KEY, "ANTHROPIC_MODEL_ID": model_id})
        assert invalid.value.public_message == MODEL_MESSAGE
        assert model_id not in str(invalid.value)
        assert SECRET_KEY not in str(invalid.value)
    for model_id in (DEFAULT_MODEL_ID, "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-5-5"):
        assert anthropic_provider.configured_model_id({"ANTHROPIC_MODEL_ID": model_id}) == model_id


def test_live_client_settings_and_no_key_in_output(capsys: pytest.CaptureFixture[str]) -> None:
    created: list[dict[str, object]] = []

    def factory(**kwargs: object) -> FakeAnthropic:
        created.append(kwargs)
        return FakeAnthropic(FakeStream(()))

    anthropic_provider.live_client(SECRET_KEY, client_factory=fake(factory))

    settings = created[0]
    assert settings["api_key"] == SECRET_KEY
    assert settings["max_retries"] == 1
    timeout = settings["timeout"]
    assert getattr(timeout, "connect") == 2
    assert getattr(timeout, "read") == 31
    captured = capsys.readouterr()
    assert SECRET_KEY not in captured.out + captured.err


def test_provider_switch_and_registry() -> None:
    assert provider_names() == ("anthropic", "bedrock")
    assert provider_name({}) == "anthropic"
    assert provider_name({"LOCAL_MODEL_PROVIDER": " Bedrock "}) == "bedrock"
    with pytest.raises(ModelSetupError) as unknown:
        provider_name({"LOCAL_MODEL_PROVIDER": "secret-provider-name"})
    assert unknown.value.public_message == PROVIDER_MESSAGE
    assert "secret-provider-name" not in str(unknown.value)


def test_factory_builds_the_configured_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        anthropic_provider,
        "live_client",
        lambda key: FakeAnthropic(FakeStream(())),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(bedrock_provider, "live_stream_client", lambda profile: FakeBedrock(()))  # type: ignore[arg-type]

    assert isinstance(create_provider({"ANTHROPIC_API_KEY": SECRET_KEY}), AnthropicProvider)
    assert isinstance(
        create_provider(
            {"LOCAL_MODEL_PROVIDER": "bedrock", "LOCAL_AWS_PROFILE": "example-profile"}
        ),
        BedrockProvider,
    )
    with pytest.raises(ModelSetupError):
        create_provider({"LOCAL_MODEL_PROVIDER": "bedrock"})


def _stream(question: str = "What is your current role?") -> dev_server.HttpResult:
    return dev_server.handle_exchange(
        "POST",
        "/ask",
        {"Accept": "application/x-ndjson"},
        json.dumps({"question": question, "mode": "career_question"}).encode("utf-8"),
    )


def _live_anthropic_env(monkeypatch: pytest.MonkeyPatch, key: str | None) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "true")
    monkeypatch.setenv("LOCAL_MODEL_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_MODEL_ID", raising=False)
    if key is None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    else:
        monkeypatch.setenv("ANTHROPIC_API_KEY", key)
    monkeypatch.setattr(dev_server, "load_configured_package", lambda root: package())  # type: ignore[arg-type]


def test_dev_server_refuses_anthropic_mode_without_a_key(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _live_anthropic_env(monkeypatch, None)

    def forbidden(*args: object, **kwargs: object) -> object:
        raise AssertionError("no client may be built without a key")

    monkeypatch.setattr(anthropic_provider, "live_client", forbidden)
    result = _stream()
    assert result.status == 503
    assert json.loads(result.body)["message"] == API_KEY_MESSAGE

    monkeypatch.setattr(dev_server.sys, "argv", ["dev_server.py"])
    monkeypatch.setattr(dev_server, "ThreadingHTTPServer", forbidden)
    with pytest.raises(SystemExit) as exited:
        dev_server.main()
    assert exited.value.code == 2
    assert API_KEY_MESSAGE in capsys.readouterr().err


def test_dev_server_streams_anthropic_answers_and_never_shows_the_key(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _live_anthropic_env(monkeypatch, SECRET_KEY)
    keys: list[str] = []

    def fake_client(key: str) -> FakeAnthropic:
        keys.append(key)
        return FakeAnthropic(FakeStream(anthropic_events((f"Answer.\nSOURCES: {CHUNK_ID}",))))

    monkeypatch.setattr(anthropic_provider, "live_client", fake_client)
    ok = _stream()
    lines = [json.loads(line) for line in ok.body.decode().splitlines()]
    assert lines[-1]["type"] == "done"
    assert keys == [SECRET_KEY]

    class AuthenticationError(Exception):
        pass

    class Rejecting:
        class messages:  # noqa: N801 - mirrors the SDK attribute
            @staticmethod
            def create(**kwargs: object) -> Iterable[object]:
                raise AuthenticationError(f"invalid x-api-key {SECRET_KEY}")

    def rejecting_client(key: str) -> Rejecting:
        return Rejecting()

    monkeypatch.setattr(anthropic_provider, "live_client", rejecting_client)
    failed = _stream("secret-question-token")
    event = json.loads(failed.body.decode().splitlines()[-1])
    assert event["code"] == "unavailable"

    def broken_client(key: str) -> object:
        raise AuthenticationError(f"bad key {key}")

    monkeypatch.setattr(anthropic_provider, "live_client", broken_client)
    refused = _stream()
    assert refused.status == 503

    rendered = (
        capsys.readouterr().err + ok.body.decode() + failed.body.decode() + refused.body.decode()
    )
    assert SECRET_KEY not in rendered
    assert "secret-question-token" not in rendered
    assert f"ask setup_error request={event['requestId']} error=AuthenticationError" in rendered


def test_fixture_mode_needs_no_key_or_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCAL_MODEL_CONVERSATION", "fixture")
    for name in ("ANTHROPIC_API_KEY", "LOCAL_AWS_PROFILE", "LOCAL_MODEL_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(dev_server, "load_configured_package", lambda root: package())  # type: ignore[arg-type]

    lines = [json.loads(line) for line in _stream().body.decode().splitlines()]
    assert lines[-1]["type"] == "done"
    assert lines[-1]["fixture"] is True


def test_providers_are_not_tied_to_the_development_server() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "ask_api" / "model_providers"
    for path in root.glob("*.py"):
        source = path.read_text(encoding="utf-8")
        assert "dev_server" not in source, path.name
        assert "import anthropic\n" not in source.split("def live_client", 1)[0], path.name
