import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from types import SimpleNamespace
from typing import cast

import pytest

from ask_api.bedrock_generator import (
    MAX_GENERATION_TOKENS,
    BedrockNovaAnswerGenerator,
    ConverseClient,
)
from ask_api.bedrock_retriever import BedrockKnowledgeBaseRetriever, KnowledgeBaseRetrieveClient
from ask_api.exact_answers import FALLBACK_ANSWER
from ask_api.grounding import RetrievedChunk
from ask_api.grounding_config import (
    APPLICATION_REGION,
    GroundingConfigurationError,
    load_grounding_config,
)
from ask_api.grounding_errors import (
    GenerationUnavailable,
    MalformedGeneratedOutput,
    RetrievalUnavailable,
)
from ask_api.grounding_factory import (
    agent_runtime_client,
    clear_grounding_cache,
    configured_grounding_service,
    runtime_client,
)
from ask_api.grounding_prompt import GROUNDING_SYSTEM_PROMPT
from ask_api.handler import ASSISTANT_UNAVAILABLE, JOB_COMPARISON_ANSWER, handler
from ask_api.model_output import TOOL_NAME

_CHUNK_ID = "aws-sde-ii:role-description:0"
_TOOL_INPUT: dict[str, object] = {
    "answer": "Lucas improves production reliability.",
    "citedChunkIds": [_CHUNK_ID],
    "suggestedQuestions": ["What is Lucas's current role?"],
}


@pytest.fixture(autouse=True)
def _reset_grounding(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "GROUNDING_ENABLED",
        "KNOWLEDGE_BASE_ID",
        "NOVA_MODEL_ID",
        "GROUNDING_RETRIEVAL_LIMIT",
    ):
        monkeypatch.delenv(name, raising=False)
    clear_grounding_cache()


def test_retriever_requests_five_results_and_keeps_trusted_metadata() -> None:
    client = _RetrieveClient([_result()])
    retriever = BedrockKnowledgeBaseRetriever(client, "KB1234567890", 5)
    chunks = retriever.retrieve("How does Lucas improve reliability?", 9)

    assert client.calls == [
        {
            "knowledgeBaseId": "KB1234567890",
            "retrievalQuery": {"text": "How does Lucas improve reliability?"},
            "retrievalConfiguration": {"vectorSearchConfiguration": {"numberOfResults": 5}},
        }
    ]
    assert len(chunks) == 1
    assert chunks[0].chunk_id == _CHUNK_ID
    assert chunks[0].url == "/experience/aws-sde-ii#role-description"
    assert chunks[0].score == 0.42
    assert "s3://" not in json.dumps(asdict(chunks[0]))


def test_retriever_returns_an_empty_result() -> None:
    chunks = BedrockKnowledgeBaseRetriever(_RetrieveClient([]), "KB1234567890", 5).retrieve(
        "question", 5
    )
    assert chunks == ()


def test_retriever_rejects_unsafe_or_incomplete_results() -> None:
    cases = [
        _result(metadata={}),
        _result(url="s3://private-bucket/retrieval/aws-sde-ii.txt"),
        _result(url="https://example.com/experience/aws-sde-ii#role-description"),
        _result(text=" "),
        [_result(), _result()],
        {"retrievalResults": "nope"},
    ]
    for payload in cases:
        if isinstance(payload, list):
            client = _RetrieveClient(payload)
        elif "retrievalResults" in payload:
            client = _RetrieveClient([], response=payload)
        else:
            client = _RetrieveClient([payload])
        with pytest.raises(RetrievalUnavailable, match="^Retrieval is unavailable.$"):
            BedrockKnowledgeBaseRetriever(client, "KB1234567890", 5).retrieve("question", 5)


def test_retriever_hides_sdk_exception_text() -> None:
    class Broken:
        def retrieve(self, **_kwargs: object) -> Mapping[str, object]:
            raise RuntimeError("s3://secret-bucket arn:aws:iam::123:role/private")

    with pytest.raises(RetrievalUnavailable, match="^Retrieval is unavailable.$") as caught:
        BedrockKnowledgeBaseRetriever(
            cast(KnowledgeBaseRetrieveClient, Broken()), "KB1234567890", 5
        ).retrieve("question", 5)
    assert caught.value.__cause__ is None
    assert "secret-bucket" not in str(caught.value)


def test_generator_sends_a_forced_tool_request_without_scores_or_aws_ids() -> None:
    client = _ConverseClient(_tool_response())
    chunk = _chunk(score=0.91)
    draft = BedrockNovaAnswerGenerator(client, "us.amazon.nova-2-lite-v1:0").generate(
        "How does Lucas improve reliability?",
        (chunk,),
    )

    request = client.calls[0]
    encoded = json.dumps(request)
    tool_config = cast(dict[str, object], request["toolConfig"])
    tools = cast(tuple[dict[str, object], ...], tool_config["tools"])
    tool_spec = cast(dict[str, object], tools[0]["toolSpec"])
    assert request["modelId"] == "us.amazon.nova-2-lite-v1:0"
    assert request["system"] == ({"text": GROUNDING_SYSTEM_PROMPT},)
    assert tool_config["toolChoice"] == {"tool": {"name": TOOL_NAME}}
    assert tool_spec["name"] == TOOL_NAME
    assert request["inferenceConfig"] == {"temperature": 0.0, "maxTokens": MAX_GENERATION_TOKENS}
    assert request["additionalModelRequestFields"] == {"reasoningConfig": {"type": "disabled"}}
    assert "0.91" not in encoded
    assert "s3://" not in encoded
    assert "arn:aws" not in encoded
    assert "KB123" not in encoded
    assert _CHUNK_ID in encoded
    assert chunk.text in encoded
    assert draft.answer == "Lucas improves production reliability."
    assert draft.cited_chunk_ids == (_CHUNK_ID,)


def _malformed_responses() -> list[dict[str, object]]:
    return [
        {"output": {"message": {"content": [{"text": "plain answer"}]}}},
        {
            "output": {
                "message": {
                    "content": [
                        {"toolUse": {"name": "other_tool", "input": _TOOL_INPUT}},
                    ]
                }
            }
        },
        {
            "output": {
                "message": {
                    "content": [
                        {"toolUse": {"name": TOOL_NAME, "input": _TOOL_INPUT}},
                        {"toolUse": {"name": TOOL_NAME, "input": _TOOL_INPUT}},
                    ]
                }
            }
        },
        {
            "output": {
                "message": {
                    "content": [
                        {
                            "toolUse": {
                                "name": TOOL_NAME,
                                "input": {**_TOOL_INPUT, "url": "/experience/aws-sde-ii"},
                            }
                        }
                    ]
                }
            }
        },
        {
            "output": {
                "message": {
                    "content": [
                        {
                            "toolUse": {
                                "name": TOOL_NAME,
                                "input": {**_TOOL_INPUT, "citedChunkIds": []},
                            }
                        }
                    ]
                }
            }
        },
    ]


@pytest.mark.parametrize("response", _malformed_responses())
def test_generator_rejects_malformed_tool_output(response: dict[str, object]) -> None:
    with pytest.raises(MalformedGeneratedOutput, match="^Generated output is malformed.$"):
        BedrockNovaAnswerGenerator(
            _ConverseClient(response), "us.amazon.nova-2-lite-v1:0"
        ).generate(
            "question",
            (_chunk(),),
        )


def test_generator_hides_sdk_exception_text() -> None:
    class Broken:
        def converse(self, **_kwargs: object) -> Mapping[str, object]:
            raise RuntimeError("prompt leaked arn:aws:bedrock:us-west-2:123:knowledge-base/secret")

    with pytest.raises(GenerationUnavailable, match="^Generation is unavailable.$") as caught:
        BedrockNovaAnswerGenerator(
            cast(ConverseClient, Broken()), "us.amazon.nova-2-lite-v1:0"
        ).generate(
            "question",
            (_chunk(),),
        )
    assert caught.value.__cause__ is None
    assert "prompt leaked" not in str(caught.value)


def test_disabled_grounding_preserves_the_unsupported_answer() -> None:
    response = handler(_event("What is Lucas's favorite color?"), None)
    body = _body(response)
    assert _status(response) == 200
    assert body["answer"] == FALLBACK_ANSWER


def test_incomplete_grounding_configuration_returns_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROUNDING_ENABLED", "true")
    monkeypatch.setenv("NOVA_MODEL_ID", "us.amazon.nova-2-lite-v1:0")
    with pytest.raises(
        GroundingConfigurationError, match="^Grounding configuration is unavailable.$"
    ):
        load_grounding_config()
    response = handler(_event("What is Lucas's favorite color?"), None)
    encoded = json.dumps(_body(response))
    assert _status(response) == 503
    assert ASSISTANT_UNAVAILABLE in encoded
    assert "NOVA_MODEL_ID" not in encoded
    assert "nova" not in encoded


def test_successful_aws_grounding_reuses_clients_and_can_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    retrieve_client = _RetrieveClient([_result()])
    converse_client = _ConverseClient(_tool_response())
    builds = {"agent": 0, "runtime": 0}

    def agent_client() -> _RetrieveClient:
        builds["agent"] += 1
        if builds["agent"] == 1:
            raise RuntimeError("temporary secret endpoint")
        return retrieve_client

    def runtime_client() -> _ConverseClient:
        builds["runtime"] += 1
        return converse_client

    monkeypatch.setenv("GROUNDING_ENABLED", "true")
    monkeypatch.setenv("KNOWLEDGE_BASE_ID", "KB1234567890")
    monkeypatch.setenv("NOVA_MODEL_ID", "us.amazon.nova-2-lite-v1:0")
    monkeypatch.setenv("GROUNDING_RETRIEVAL_LIMIT", "5")
    monkeypatch.setattr("ask_api.grounding_factory.agent_runtime_client", agent_client)
    monkeypatch.setattr("ask_api.grounding_factory.runtime_client", runtime_client)

    failed = handler(_event("What is Lucas's favorite color?"), None)
    assert _status(failed) == 503
    assert "secret endpoint" not in json.dumps(_body(failed))

    first = handler(_event("What is Lucas's favorite color?"), None)
    second = handler(_event("What is Lucas's favorite color?"), None)
    assert _status(first) == 200
    assert _body(first)["answer"] == "Lucas improves production reliability."
    assert _body(second)["answer"] == "Lucas improves production reliability."
    assert builds == {"agent": 2, "runtime": 1}
    assert configured_grounding_service() is configured_grounding_service()


def test_bedrock_clients_receive_separate_timeout_budgets(monkeypatch: pytest.MonkeyPatch) -> None:
    constructed: list[tuple[str, dict[str, object]]] = []

    def client(service_name: str, **kwargs: object) -> object:
        constructed.append((service_name, dict(kwargs)))
        return object()

    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=client))
    agent_runtime_client()
    runtime_client()

    assert [service for service, _kwargs in constructed] == [
        "bedrock-agent-runtime",
        "bedrock-runtime",
    ]
    retrieval = constructed[0][1]
    generation = constructed[1][1]
    assert retrieval["region_name"] == APPLICATION_REGION
    assert generation["region_name"] == APPLICATION_REGION
    assert getattr(retrieval["config"], "connect_timeout") == 2
    assert getattr(retrieval["config"], "read_timeout") == 5
    assert getattr(retrieval["config"], "retries") == {"total_max_attempts": 1}
    assert getattr(generation["config"], "connect_timeout") == 2
    assert getattr(generation["config"], "read_timeout") == 15
    assert getattr(generation["config"], "retries") == {"total_max_attempts": 1}


def test_exact_answer_and_job_comparison_do_not_construct_aws_clients(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    constructed: list[str] = []

    def client(service_name: str, **_kwargs: object) -> object:
        constructed.append(service_name)
        raise AssertionError(service_name)

    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=client))
    monkeypatch.setenv("GROUNDING_ENABLED", "true")
    monkeypatch.setenv("KNOWLEDGE_BASE_ID", "KB1234567890")
    monkeypatch.setenv("NOVA_MODEL_ID", "us.amazon.nova-2-lite-v1:0")
    monkeypatch.setenv("GROUNDING_RETRIEVAL_LIMIT", "5")

    exact = handler(_event("What is Lucas's current role?"), None)
    comparison = handler(_event("Compare this role", mode="job_comparison"), None)
    assert constructed == []
    assert _status(exact) == 200
    assert "Software Development Engineer II" in str(_body(exact)["answer"])
    assert _status(comparison) == 200
    assert _body(comparison)["answer"] == JOB_COMPARISON_ANSWER


def test_retrieval_and_generation_failures_return_safe_503(monkeypatch: pytest.MonkeyPatch) -> None:
    class BrokenRetrieve:
        def retrieve(self, **_kwargs: object) -> Mapping[str, object]:
            raise RuntimeError("hidden retrieve prompt")

    class BrokenConverse:
        def converse(self, **_kwargs: object) -> Mapping[str, object]:
            raise RuntimeError("hidden converse prompt")

    monkeypatch.setenv("GROUNDING_ENABLED", "true")
    monkeypatch.setenv("KNOWLEDGE_BASE_ID", "KB1234567890")
    monkeypatch.setenv("NOVA_MODEL_ID", "us.amazon.nova-2-lite-v1:0")
    monkeypatch.setenv("GROUNDING_RETRIEVAL_LIMIT", "5")
    monkeypatch.setattr(
        "ask_api.grounding_factory.agent_runtime_client",
        lambda: BrokenRetrieve(),
    )
    monkeypatch.setattr(
        "ask_api.grounding_factory.runtime_client",
        lambda: BrokenConverse(),
    )

    retrieval_failure = handler(_event("What is Lucas's favorite color?"), None)
    clear_grounding_cache()
    monkeypatch.setattr(
        "ask_api.grounding_factory.agent_runtime_client",
        lambda: _RetrieveClient([_result()]),
    )
    generation_failure = handler(_event("What is Lucas's favorite color?"), None)
    for response in (retrieval_failure, generation_failure):
        encoded = json.dumps(_body(response))
        assert _status(response) == 503
        assert encoded == json.dumps(
            {"message": ASSISTANT_UNAVAILABLE, "requestId": _body(response)["requestId"]}
        )
        assert "hidden" not in encoded
        assert "prompt" not in encoded


class _RetrieveClient:
    def __init__(
        self,
        results: Sequence[Mapping[str, object]],
        response: Mapping[str, object] | None = None,
    ) -> None:
        self.results = list(results)
        self.response = response
        self.calls: list[dict[str, object]] = []

    def retrieve(
        self,
        *,
        knowledgeBaseId: str,
        retrievalQuery: Mapping[str, str],
        retrievalConfiguration: Mapping[str, object],
    ) -> Mapping[str, object]:
        self.calls.append(
            {
                "knowledgeBaseId": knowledgeBaseId,
                "retrievalQuery": dict(retrievalQuery),
                "retrievalConfiguration": dict(retrievalConfiguration),
            }
        )
        if self.response is not None:
            return self.response
        return {"retrievalResults": self.results}


class _ConverseClient:
    def __init__(self, response: Mapping[str, object]) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def converse(
        self,
        *,
        modelId: str,
        system: Sequence[Mapping[str, str]],
        messages: Sequence[Mapping[str, object]],
        toolConfig: Mapping[str, object],
        inferenceConfig: Mapping[str, object],
        additionalModelRequestFields: Mapping[str, object],
    ) -> Mapping[str, object]:
        self.calls.append(
            {
                "modelId": modelId,
                "system": system,
                "messages": messages,
                "toolConfig": {
                    "tools": toolConfig["tools"],
                    "toolChoice": toolConfig["toolChoice"],
                },
                "inferenceConfig": dict(inferenceConfig),
                "additionalModelRequestFields": dict(additionalModelRequestFields),
            }
        )
        return self.response


def _result(
    *,
    metadata: Mapping[str, object] | None = None,
    url: str = "/experience/aws-sde-ii#role-description",
    text: str = "Improved production reliability.",
) -> dict[str, object]:
    attributes = {
        "chunkId": _CHUNK_ID,
        "documentId": "aws-sde-ii",
        "title": "Software Development Engineer II",
        "section": "Role Description",
        "url": url,
        "type": "experience",
    }
    if metadata is not None:
        attributes = dict(metadata)
    return {
        "content": {"text": text},
        "score": 0.42,
        "location": {
            "type": "S3",
            "s3Location": {"uri": "s3://private-source/retrieval/secret.txt"},
        },
        "metadata": attributes,
    }


def _chunk(*, score: float = 0.42) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=_CHUNK_ID,
        document_id="aws-sde-ii",
        title="Software Development Engineer II",
        section="Role Description",
        url="/experience/aws-sde-ii#role-description",
        document_type="experience",
        text="Improved production reliability.",
        score=score,
    )


def _tool_response() -> dict[str, object]:
    return {
        "output": {"message": {"content": [{"toolUse": {"name": TOOL_NAME, "input": _TOOL_INPUT}}]}}
    }


def _event(question: str, mode: str = "career_question") -> dict[str, object]:
    return {"question": question, "mode": mode}


def _status(response: dict[str, object]) -> int:
    status = response["statusCode"]
    assert isinstance(status, int)
    return status


def _body(response: dict[str, object]) -> dict[str, object]:
    raw = response["body"]
    assert isinstance(raw, str)
    parsed = cast(object, json.loads(raw))
    assert isinstance(parsed, dict)
    return cast(dict[str, object], parsed)
