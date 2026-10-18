# ADR-008: Use the Anthropic API for model answers

**Status:** Accepted for local model mode. Implemented and tested with injected clients; the user ran the live local evaluation in October 2026 ([results](../../tests/evaluation/README.md#live-run-results)). The production provider, retrieval, and transport stay open for Slice 2.  
**Date:** October 13, 2026

## Context

[ADR-006](006-model-conversation-and-streaming.md) accepted model-written, streamed answers grounded in approved public evidence, and the local slice was built against Amazon Nova 2 Lite through Bedrock `ConverseStream`. The live evaluation that closes roadmap Slice 1 could not run on Nova: Bedrock model capacity was unavailable for this account at the time.

The answer pipeline does not depend on Bedrock. The prompt, the evidence package, bounded history, the `SOURCES:` holdback and parsing, citation validation, usage reporting, and the stream events are all application code. Only the client and the shape of its stream events are provider-specific.

## Decision

Local model mode uses the Anthropic API by default, through the official Python SDK and streaming Messages. Bedrock stays available behind the same interface.

- **Provider boundary.** `ask_api.model_providers` defines one request type (`ModelRequest`), one event type (`TextDelta`, `UsageReport`, `StreamStop`, `StreamFailure`), and a `ModelProvider` protocol with `open_stream()`. Each provider is one module (`anthropic_api`, `bedrock`, plus the in-process `fixture`) that exposes `check_environment()` and `from_environment()`. A registry chooses the provider from `LOCAL_MODEL_PROVIDER` (`anthropic` by default, or `bedrock`). Adding a provider is one module and one registry entry. The boundary lives in the `ask_api` package and has no dependency on the development server, so the Lambda can use it in Slice 2.
- **Same contract.** Every provider gets the same system prompt, user message, `max_tokens` 500, and temperature 0, and its events pass through the same stream loop. A test runs identical conversations through fake Anthropic and Bedrock clients and requires identical output events.
- **Anthropic settings.** The model id is configuration (`ANTHROPIC_MODEL_ID`), defaulting to `claude-haiku-4-5-20251001` and validated as a Claude model id. The client has a 2-second connect timeout, a 31-second read timeout, and at most one retry. A tool-use block or an `error` stream event is not an answer. The `anthropic` 1.x SDK removed `temperature` from `messages.create()` (passing it raises `TypeError`), so temperature 0 is sent in `extra_body` for the model families that still honor it (Claude 4 through 4.6, including Haiku 4.5) and omitted for later models, which reject sampling parameters.
- **Credentials.** Live Anthropic mode requires `ANTHROPIC_API_KEY` in the process environment and refuses to start without it. `pnpm dev:api:model` reads the key from a macOS Keychain item named in local configuration and passes it only to the server process (not exported, not on the command line, never printed). Setup failures log only the exception class name. Questions, answers, prompts, and the key are never logged.
- **Bedrock.** `pnpm dev:api:model:bedrock` keeps the Nova path exactly as before, with `LOCAL_AWS_PROFILE` and the refusal of raw AWS keys.
- **Dependency.** The `anthropic` SDK is in the ask-api development dependency group only. The Lambda asset does not contain it.
- **Real-library tests.** Fake clients accept any call shape, which once hid that `TypeError`. The providers are typed against the real SDK and the boto3 stubs (imported only for type checking), so pyright rejects an unsupported argument, and `tests/test_model_providers_real_clients.py` drives the real `anthropic.Anthropic` over an `httpx2` mock transport and a real boto3 client over a locally encoded event stream.
- **Debugging.** `LOCAL_DEBUG_TRACEBACK=1` adds the stack (files, lines, functions, source lines, exception classes) after the setup-error line. Exception messages, locals, and argument values are never printed.
- **Cost reporting.** `pnpm dev:api:model` defaults the estimate to Haiku 4.5 list prices, $1 and $5 per million input and output tokens, and either value can be overridden.

## Not decided here

- **Production provider.** Whether the deployed Lambda calls the Anthropic API, Bedrock, or both is Slice 2. The provider interface is ready for it, and a production secret would need its own decision; the Keychain launcher is for local use only.
- **Production retrieval.** [ADR-005](005-grounded-career-answering.md) chose a Bedrock Knowledge Base with S3 Vectors. The approved corpus is now eight short sections, well under the 100,000-character evidence cap, so passing the whole evidence package directly, as local mode does, may replace the Knowledge Base in production. Slice 2 decides that and records it.
- **Transport.** How the deployed site receives a stream is still the Slice 2 transport ADR.

## Why

The capacity constraint was outside the project's control, and the pipeline is already provider-neutral apart from one client. A small explicit interface keeps that true, lets the Slice 1 evaluation run now, and keeps Bedrock one setting away. Haiku 4.5 is inexpensive for short grounded answers, and the evaluation will show whether it holds the citation contract.

## Consequences

- The Slice 1 completion gate can be met with the Anthropic provider.
- The evaluation questions in [tests/evaluation](../../tests/evaluation/README.md) apply unchanged to the trimmed public content.
- `.claude/settings.json` denies Keychain reads, environment dumps, `.env` reads, and any command that names `ANTHROPIC_API_KEY`.
