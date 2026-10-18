# ADR-006: Compose career answers with a grounded model and stream them

**Status:** Accepted. The local slice is implemented with injected clients. Production transport is not selected. Live Bedrock evaluation has not been run.  
**Date:** October 5, 2026

## Context

[ADR-005](005-grounded-career-answering.md) accepted a first grounded version. In that version, four exact fact families stay deterministic, every other career question retrieves at most five approved sections, and Nova submits `submit_grounded_answer` before the service returns one JSON document. That version has no conversation memory and no streaming. The retrieval design in ADR-005 remains the production evidence path.

The working tree now shows a conversation in the React assistant. The browser sends recent answered turns as `history`. The Python handler uses that history only to resolve a follow-up against the packaged career index. The HTTP response is still one JSON document. When grounding is enabled, the model still sees the current question alone, and the service still validates a complete tool result before it responds. Local development leaves grounding off, so an unmatched question returns the unsupported sentence.

That foundation is not the approved product. The assistant should give natural, model-generated answers grounded in approved public career information, carry meaningful follow-ups, and stream the generated content as Bedrock produces it.

## Decision

The model composes ordinary supported career answers, including simple factual questions. Deterministic code may still select or validate authoritative facts. It is no longer the policy that every simple fact must bypass the model.

Prior messages are a bounded set of recent conversation turns. They help interpret a follow-up. They are not authoritative career evidence. Evidence is approved public content with `assistant_retrievable: true`. Private career notes stay out of this repository. Fictional and other non-retrievable documents, including Lumen Harbor, stay out of the evidence given to the model.

Citations stay tied to trusted public documents and the existing allowlisted routes: `/profile/`, `/experience/`, `/background/`, and `/work/`, plus an anchor. The model does not invent citation URLs.

The response streams actual generated content. Playing back a completed answer, or waiting and then revealing it, is not this decision.

Local evaluation may pass the approved retrievable public sections directly to the configured Nova model. That path exists so the conversation can be judged before the application is deployed and before the Bedrock Knowledge Base and S3 Vectors index are provisioned. It still calls Bedrock and can incur model charges. It requires configured server-side credentials and model access. It does not deploy the site, the API, or the retrieval infrastructure, and it does not publish or ingest retrieval content.

Production retrieval stays the Bedrock Knowledge Base and S3 Vectors design in ADR-005 unless a later ADR changes it. Direct local evidence and production retrieval are different paths.

The production transport is not selected here. [ADR-004](004-http-api-and-ask-lambda.md) accepts an API Gateway HTTP API with a Lambda proxy integration. That integration currently returns one buffered response. Changing the Bedrock call to a streaming API does not by itself make the browser response stream. The production slice investigates current AWS capabilities in official documentation, then records the selected transport, integration, and any infrastructure change in a later ADR. This record does not authorize account changes or deployment.

A streamed token is not a completed `submit_grounded_answer` result. The current service validates the whole tool result before it returns JSON. Partial text has not passed that final citation and evidence check. The client may show progressive text, and it must not present that text as already validated. Completion, citations, errors, timeouts, and cancellation are defined with the production stream contract.

Conversations stay in page memory for the visit. The application does not save transcripts. It does not log questions, answers, prompts, or request bodies.

## Why

Hiring visitors ask follow-ups. A template that only recognizes a few index phrases cannot answer an open question such as production reliability, and it cannot treat the previous turn as conversation rather than as another database lookup. The model should write the answer from approved evidence.

Streaming is part of that experience only when the bytes are the model’s own output arriving over time. The local direct-evidence path lets that behavior be evaluated without creating the Knowledge Base, the vector index, or a public endpoint. Production still needs those approved retrieval controls, and it needs a transport that can actually deliver the stream. Those are later decisions because the current HTTP API integration has not been shown to stream.

Keeping validation after the model finishes preserves the citation boundary from ADR-005. Showing partial text before that check is a product behavior that has to be labeled honestly.

## Consequences

ADR-005 still describes the retrieval architecture and the first grounded implementation. Its rules that exact facts always bypass the model, and that the first version does not stream or keep conversation memory, do not govern the work accepted here.

The local slice now exists. `LOCAL_MODEL_CONVERSATION` opts the development server into Nova `ConverseStream` text, or into an in-process fixture stream. The default remains the deterministic JSON handler. Local mode does not force `submit_grounded_answer`, because partial tool JSON is not an answer. The model writes the answer and a final `SOURCES:` line. Citation URLs are copied from the evidence package after the identifiers match. That check does not prove every sentence is supported. Automated tests use injected clients. A paid Nova call has not been run.

Production streaming is still Slice 2. This record still does not choose that transport. Automated tests for that slice will use injected clients. A paid model call remains an explicit evaluation step, not a unit test.

The cases in `tests/evaluation/cases.json` still label some questions as exact. Updating those expectations is part of implementation, not part of this decision.
