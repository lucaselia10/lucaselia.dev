# ADR-005: Answer open-ended career questions by retrieving approved sections

**Status:** Superseded by [ADR-009](009-production-assistant.md) for retrieval, publication, ingestion, and packaging: production passes the full approved evidence package to the model, the Knowledge Base, S3 Vectors, publisher, and Bedrock grounding code were never deployed and were removed in Slice 2, Round 2, and the Lambda asset no longer bundles boto3. The citation-trust rule, Lumen Harbor's exclusion from evidence, and the split between sanitized failures and insufficient evidence still apply. Earlier, [ADR-006](006-model-conversation-and-streaming.md) superseded the rules that every exact fact bypasses the model and that the first grounded version does not stream or keep conversation memory.  
**Date:** September 29, 2026

## Context

Exact career facts already come from the packaged public index. Hiring questions that are not one of those four fact families need a grounded answer. The public site also contains the fictional Lumen Harbor fixture, which must stay renderable and indexed without becoming evidence about Lucas. The portfolio should not call a model for facts the index can already state, and it should not build a second vector database before the approved public corpus is the retrieval source.

## Decision

Keep exact answers deterministic. For every other career question, retrieve at most five pre-chunked public sections and then ask a model to answer from those sections only.

The future AWS path is a private S3 Knowledge Base source bucket, Amazon Bedrock Knowledge Bases, and Amazon S3 Vectors in `us-west-2`. Embeddings are Titan Text Embeddings V2 with 512 dimensions. Generation is Amazon Nova 2 Lite through the Bedrock Converse API. The model ID is configuration. The application calls `Retrieve`, then Converse. It does not call `RetrieveAndGenerate`.

Each approved public H2 citation section is one source object. The Knowledge Base will be configured with no extra chunking. `pnpm build:retrieval` writes those objects and Bedrock metadata sidecars from the same parser and citation routes as the site. Each object's text is title, type, summary, and section lines, then a `Facts:` block of labeled, already-reviewed front matter for that document type (employer, role title, dates with `present` for a null end date, location when not null, employment type, institution, program, education status, degree awarded, skills, and topics, as they apply), then the section body. The block adds no wording beyond field labels and stored values. It was added in generator version `2` on October 7, 2026, before any publication, so the source objects and corpus digest changed with nothing uploaded. `assistant_retrievable: false` and every draft stay out of that output. Uploading the artifacts is the explicit `pnpm publish:retrieval` operator command, not request-time work and not a CloudFormation custom resource.

The model must submit `submit_grounded_answer` with an answer, retrieved chunk IDs, and suggested questions. The service accepts a citation only when its chunk ID was retrieved. Title, section, URL, and document identity come from that trusted chunk. The prompt is versioned. There is no reranker, conversation memory, streaming, agent, or guardrail in the first grounded version.

The AWS path is now synthesized and implemented. CDK defines the private source bucket, the S3 Vectors bucket and index, the Knowledge Base, the S3 data source, and the Knowledge Base service role. The Lambda execution role can retrieve from that Knowledge Base and invoke Nova 2 Lite through its US inference profile. `cdk synth` does not upload `retrieval/` objects or start an ingestion job. A separate synchronization workflow is still required before open-ended answers have any vectors to read.

Unmatched questions still return the existing unsupported sentence when `GROUNDING_ENABLED` is absent or not `true`, which is the local development default.

Insufficient evidence and a dependency failure stay distinct. The successful unsupported answer is used when retrieval succeeds with no chunks, when generation succeeds with the validated insufficient-evidence result, and when no grounding provider is configured. After a provider is injected, retrieval unavailability, generation unavailability, malformed output, an ungrounded answer, and any unexpected grounding exception return HTTP 503 with “The career assistant is temporarily unavailable.” and the invocation request ID. That response does not include exception text, model output, prompts, retrieved passages, AWS identifiers, or paths. Exact answers still return HTTP 200 when that provider is unavailable.

## Why

Bedrock Knowledge Bases with S3 Vectors is the managed retrieve path. It avoids operating OpenSearch or a custom vector index for a small public corpus. Pre-chunking on citation sections keeps every answer tied to a page the site already publishes. `Retrieve` plus Converse keeps the prompt, tool schema, and citation checks in application code. `RetrieveAndGenerate` would hide that control.

512-dimension Titan embeddings are enough for this corpus and cost less than the larger Titan dimensions. Nova 2 Lite is a small configurable generator for short hiring answers. Forced tool output is easier to validate than free-form JSON. Trusting only retrieved metadata stops the model from inventing links.

The retrieval flag is explicit because a public test page is not the same thing as a grounding source. Ingestion stays outside CloudFormation so a content publish does not hide a data-plane upload inside a custom resource.

This is proportionate for V1: four exact facts stay free of model cost, and open-ended answers wait until the source files and contracts exist. A later migration can change the model ID, add a reranker, or replace S3 Vectors without changing the chunk contract.

## Consequences

`generated/retrieval/` and `generated/retrieval-manifest.json` are gitignored build products. They are not in the website or the Lambda asset. Evaluation cases in `tests/evaluation/cases.json` record route expectations and do not score answer quality yet.

## Implementation

The source bucket uses S3-managed encryption, blocks public access, requires SSL, versions objects, and is retained on stack deletion. Noncurrent versions expire after 90 days. Current objects are not deleted automatically. The vector bucket and index also use S3-managed `AES256` encryption and are retained. The index is `float32`, 512 dimensions, and cosine distance. CloudFormation generates their names. The Knowledge Base uses Titan Text Embeddings V2 at 512 `FLOAT32` dimensions and storage type `S3_VECTORS`. The data source includes only `retrieval/` and sets chunking to `NONE`. This CDK version’s data source resource has no tag property; the bucket, vector resources, and Knowledge Base receive the project tags.

The Knowledge Base role trusts only `bedrock.amazonaws.com`, with `aws:SourceAccount` equal to the stack account and `aws:SourceArn` limited to Knowledge Base ARNs in `us-west-2`. The Knowledge Base id segment is `*` because the role must exist before the Knowledge Base ARN does. That role can invoke only `amazon.titan-embed-text-v2:0`, list and read only the source bucket’s `retrieval/` prefix, and call S3 Vectors only on the generated index ARN. It cannot retrieve, invoke Nova, or write source objects.

Nova 2 Lite is called through the geographic inference profile `us.amazon.nova-2-lite-v1:0` in `us-west-2`. The profile id is CDK context `novaInferenceProfileId` and the `NOVA_MODEL_ID` environment variable, and it must match `us.amazon.nova-2-lite-v<number>:<number>`. Cross-region inference may land in another US region, so the Lambda foundation-model ARN uses a region wildcard for that one model id. The statement allows the call only when `bedrock:InferenceProfileArn` is the exact profile ARN in `us-west-2`.

The Lambda packages the production dependencies pinned in `services/ask-api/uv.lock`. Staging exports that lock with hashes, installs the wheels for Python 3.13 on `aarch64-manylinux2014` into the asset, and copies the files instead of linking the uv cache or the local virtual environment. The managed Python 3.13 runtime’s boto3 is not used. Development tools stay out of the asset. Clients are constructed after an exact-answer miss, cached after success, and discarded when construction fails so the next warm invocation can retry.

The retrieval client uses a 2-second connect timeout, a 5-second read timeout, and one total attempt. The Converse client uses a 2-second connect timeout, a 15-second read timeout, and one total attempt. A timed-out or failed SDK call becomes the existing sanitized grounding error, so the handler can return HTTP 503 before the Lambda’s 28-second timeout. The API integration timeout stays 29 seconds, and the browser client waits 31 seconds. Nothing in this change has been deployed.

## Publication

`pnpm publish:retrieval` builds the artifacts and then runs `services/ask-api/src/retrieval_publisher`. The default mode is a read-only plan. `--apply` is required before any S3 write, S3 delete, or ingestion start. The command requires `--bucket`, `--knowledge-base-id`, and `--data-source-id`. `--region` defaults to `us-west-2`. Credentials come from the normal boto3 provider chain and are not command arguments.

Remote source keys are `retrieval/<filename>.txt` and `retrieval/<filename>.txt.metadata.json`. The manifest stays local. Publisher state is `_career-portfolio/retrieval-publish-state.json`. That key is outside the data-source prefix, and the Knowledge Base role’s object read is limited to `retrieval/*`, so the role cannot read the state. The state records schema version, corpus digest, managed keys and SHA-256 hashes, the Knowledge Base id, the data source id, and the latest ingestion job id and status. It has no timestamps, credentials, local paths, or document bodies.

A missing state object means the first publication. Malformed or incompatible state fails closed and is not overwritten. The plan lists uploads, unchanged objects, managed stale deletes, and unmanaged remote keys. `--apply` deletes a key only when the previous valid state managed it. An unmanaged key under `retrieval/` stops apply until it is reviewed. There is no override flag. An active `STARTING`, `IN_PROGRESS`, or `STOPPING` job blocks a second start. A saved active job is polled on apply. A completed unchanged corpus does not upload or ingest again. A failed or stopped job for the same corpus requires `--retry-failed` and a new UUIDv4 client token. A changed corpus may be applied without that flag. Polling uses `GetIngestionJob`, defaults to every 5 seconds, and stops after 900 seconds. A timeout leaves the saved status active and exits nonzero. Unknown statuses are failures.

The publisher package is not copied into the Lambda asset. Its tests inject fake S3 and Bedrock Agent clients. Build, test, synth, and deployment do not publish or ingest.

The operator who runs this command is not the Ask Lambda role, not the Knowledge Base service role, and not a future infrastructure deployment role. The minimum future operator policy is `s3:ListBucket` on the source bucket for `retrieval/*` and the `_career-portfolio/` prefix, `s3:GetObject` and `s3:PutObject` on `retrieval/*` and the state object, `s3:DeleteObject` only on `retrieval/*`, and `bedrock:ListIngestionJobs`, `bedrock:StartIngestionJob`, and `bedrock:GetIngestionJob` on the Knowledge Base where AWS supports resource-level permissions. Publishing an existing data source does not require `iam:PassRole`. The operator policy does not include Lambda, Titan, Nova, S3 Vectors, CloudFormation, or CDK permissions. No operator role is defined in this stack yet.
