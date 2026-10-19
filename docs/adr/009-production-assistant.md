# ADR-009: Serve the production assistant from a streaming Lambda behind the site's CloudFront

**Status:** Accepted (October 2026). Deployed by the owner in Round 4: the assistant is live on `https://lucaselia.dev`. Decisions were locked on October 17, 2026, and WAF on October 18, 2026.  
**Date:** October 17, 2026

The specification, limits, failure modes, cost model, implementation rounds, and user-run steps are in [production assistant](../design/production-assistant.md).

## Context

The static site is live at `https://lucaselia.dev` without the assistant ([ADR-007](007-static-site-hosting.md)). Local model mode is implemented and evaluated on the Anthropic API ([ADR-008](008-anthropic-api-for-model-answers.md)): prompt `local-3`, the full approved evidence package, bounded history, a held-back `SOURCES:` line whose identifiers are checked against the package, the fixed refusal, and the shared `answer_style` rules. It streams NDJSON from the Python development server to the React island.

The synthesized production path does not match that. [ADR-004](004-http-api-and-ask-lambda.md) chose an API Gateway HTTP API with a buffered Lambda proxy integration, and [ADR-005](005-grounded-career-answering.md) chose a Bedrock Knowledge Base with S3 Vectors in `us-west-2`. Neither has been deployed. [ADR-006](006-model-conversation-and-streaming.md) left the production transport to a later ADR.

## Decided by the owner

- **Provider.** The Anthropic API, Claude Haiku 4.5 by default, with the model id as configuration. Bedrock stays behind the provider interface and is not used in production.
- **API key.** Stored in AWS Secrets Manager, created by the owner. The Lambda reads it once per cold start and never logs it. Claude never handles the key.
- **Evidence.** The full approved evidence package, as local mode sends it. No Knowledge Base or vector store.
- **Same origin.** The API is served at `lucaselia.dev/api/…` through the existing CloudFront distribution. No CORS.
- **Streaming.** Required, with the existing NDJSON event contract.
- **Budget.** A $10 monthly limit on a dedicated Anthropic workspace, set by the owner. An AWS budget alarm at $15 a month, created by the owner by hand and not in the stack.
- **Transport, region, and stacks.** The function URL with the Lambda Web Adapter behind CloudFront `/api/*`, with OAC and the `x-amz-content-sha256` body hash (section 1). `us-east-1`, in a new `PortfolioAssistantStack` in the site CDK app (section 4).
- **Server.** The Python standard-library HTTP server. No web framework.
- **Concurrency.** The account's Lambda concurrency limit is 10, and Lambda keeps 100 units unreserved, so no reserved concurrency can be set. The account limit is the concurrency cap. The kill switch is still reserved concurrency 0; Round 2 confirms that is allowed at this limit.
- **Limits.** Questions up to 500 characters, history up to 12,000 characters, `max_tokens` 500, and the existing 31-second deadline.
- **WAF.** Yes (October 18, 2026): a CLOUDFRONT-scope web ACL with one rate-based rule, 20 requests per 10-minute window per IP, scoped to URI paths starting with `/api/`, blocking with a custom JSON 429. No managed rule groups.
- **Packaging.** boto3 is not bundled in the Lambda asset; the function uses the copy in the Python 3.13 runtime. This supersedes ADR-005's choice to ship pinned boto3 with the function.
- **Logs.** The per-request line includes the request id.
- **Privacy.** Unchanged: no logging of questions, answers, prompts, or request bodies, and no transcripts.

## Decision

### 1. Transport: a Lambda function URL in `RESPONSE_STREAM` mode, running a small Python HTTP app behind the AWS Lambda Web Adapter

The ask function stays Python 3.13 on ARM64. Its function URL uses `InvokeMode: RESPONSE_STREAM` and `AuthType: AWS_IAM`. The [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) runs as an extension with `AWS_LWA_INVOKE_MODE=response_stream` and forwards each invocation to a small HTTP server inside the function. That server is the production twin of the development server: same request validation, same answer stream, same NDJSON framing.

Why this option:

- **The managed Python runtime cannot stream on its own.** Lambda supports response streaming natively only on the Node.js managed runtimes. For Python, AWS points to a custom runtime or the Lambda Web Adapter ([Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)).
- **It keeps all the Python answer code and its tests.** The prompt, evidence package, history window, `SOURCES:` holdback, citation validation, provider boundary, and request validation carry over unchanged. Only the HTTP shell is new, and the development server already implements one.
- **It reaches the browser through CloudFront.** A function URL is a documented CloudFront origin ([Use a Lambda function URL](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistS3AndCustomOrigins.html#concept_lambda_function_url)). In `RESPONSE_STREAM` mode Lambda calls `InvokeWithResponseStream` ([Invoking with function URLs](https://docs.aws.amazon.com/lambda/latest/dg/config-rs-invoke-furls.html)).
- **The extension adds little.** The added operational piece is one pinned binary, packaged as the stack's own layer.

Trade-offs accepted:

- **The adapter is not part of Lambda.** It is an awslabs open-source project, not a managed runtime feature, so its version and checksum are pinned and reviewed like a dependency.
- **Cold starts get slower.** They add the extension start and the server's readiness check. The cost has not been measured here and is recorded in Round 4.
- **A broken client connection does not stop the function.** Lambda keeps running a streamed response after the client disconnects and bills the full duration ([Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)). The existing 31-second stream deadline bounds that.
- **The server is the standard library (decided).** An Event Function environment serves one request at a time, so an ASGI server's concurrency would buy nothing and would add two runtime dependencies.

Options considered and rejected:

| Option                                                                | Streams through CloudFront                                        | Cold start                                              | Operational complexity                                                                       | Python code and tests kept                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **(a) Function URL + Lambda Web Adapter + small Python app (chosen)** | Yes                                                               | Managed runtime, plus the extension and readiness check | One pinned extension binary                                                                  | All answer code and tests. New: the HTTP shell.                            |
| (b) Python custom runtime (`provided.al2023`) with streaming          | Yes, through the same function URL                                | Larger package with a bundled interpreter               | We own a runtime client (chunked transfer, error trailers) and lose managed runtime patching | All answer code. New: the runtime loop.                                    |
| (c) API Gateway response streaming                                    | Yes for REST APIs. HTTP APIs, which ADR-004 chose, do not stream. | Same as (a) or (b), which it still needs                | A REST API layer in front of the function as well as CloudFront                              | Same as (a) or (b)                                                         |
| (d1) Node/TypeScript HTTP shell, Python grounding                     | Only if the Python half also streams                              | Two functions per request                               | Two runtimes, two hops                                                                       | Not a simplification; see below                                            |
| (d2) Port everything to Node/TypeScript                               | Yes: native `streamifyResponse`, or Lambda Web Functions          | Node managed runtime                                    | One runtime                                                                                  | None. About 1,500 lines of answer code and 2,600 lines of tests rewritten. |

- **(b) Custom runtime.** The streaming contract for custom runtimes is documented: the `Lambda-Runtime-Function-Response-Mode: streaming` header, chunked transfer encoding, and error trailers ([custom runtime streaming](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html#runtimes-custom-response-streaming)). Choosing it means owning a runtime client and the interpreter's patching. Whether the AWS Python runtime interface client can stream was not verified, so this option assumes a hand-written loop.
- **(c) API Gateway.** API Gateway streaming works only for REST APIs, with `responseTransferMode: STREAM` on a proxy integration ([response transfer mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)). The function must still write the streaming format: metadata JSON, then 8 null bytes, then the payload ([Lambda proxy streaming](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html)). That needs (a) or (b) underneath anyway, adds REST API cost, and puts a second public endpoint behind CloudFront. Edge-optimized endpoints also have a 30-second idle timeout ([response transfer mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)). Rejected.
- **(d1) Node shell over Python.** A Node handler cannot run the Python grounding in its own process. It would invoke a Python function, and a Python function still cannot stream without (a) or (b). The split adds a hop and solves nothing. Not workable as a simplification.
- **(d2) Full TypeScript port.** Node streams natively. [Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html), launched in October 2026, run a Node HTTP server with streaming, an endpoint `rateLimit` (0 blocks all traffic with HTTP 503 and needs no redeploy), and `maxEnvironments` ([scaling](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html)). Their CloudFront OAC signs `POST` bodies as `UNSIGNED-PAYLOAD`, so the browser does not hash the body ([Web Function OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html)). Web Functions currently support Node.js only ([runtimes](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-runtimes.html)). Adopting them means rewriting the tested Python pipeline and losing the code shared with local mode, on a service that is days old. CDK support was not verified. Not now. Revisit if the backend ever moves to TypeScript.

### 2. Evidence: the full approved package, bundled with the function (supersedes the ADR-005 retrieval path)

The function ships the same evidence package local mode builds from `generated/retrieval/` and its manifest. The package is eight short sections, well under the 100,000-character cap. No Bedrock Knowledge Base, S3 Vectors index, source bucket, Titan embeddings, publisher, or ingestion. `assistant_retrievable: false` documents, including Lumen Harbor, stay out as they do today. A content change redeploys the function and the site together, so citations and page anchors stay in step, as [ADR-003](003-bundle-career-index-with-lambda.md) already required for the index.

Production uses prompt `local-3` (`local-4` since Round 5), and the shared `answer_style` rules. The `SOURCES:` validation, refusal wording, and partial-support behavior are the ones evaluated live in Slice 1.

### 3. Same origin through CloudFront, with Origin Access Control

The site distribution gains an `/api/*` behavior whose origin is the function URL:

- **Origin Access Control.** The function URL uses `AWS_IAM`. The OAC uses signing behavior `always` and origin type `lambda`. The function's resource policy allows `cloudfront.amazonaws.com` to call `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, with `aws:SourceArn` limited to this distribution ([OAC for function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)). Direct calls to the function URL fail.
- **Methods and caching.** Allowed methods are the full set, because `POST` needs it ([allowed HTTP methods](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesAllowedHTTPMethods)). CloudFront does not cache `POST` responses (same page). The cache policy is the managed `CachingDisabled`.
- **Forwarded values.** A custom origin request policy forwards only `Content-Type` and `Accept`, and no cookies or query strings. It does not list `x-amz-content-sha256`: CloudFront rejects that header in an origin request policy (see Round 4 below). The managed `AllViewerExceptHostHeader` policy, which AWS intends for function URL origins, forwards all cookies, so it is not used ([managed origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)). The viewer `Host` header is not forwarded, because function URLs expect their own domain (same page).
- **Timeouts.** The origin response timeout is 40 seconds. It covers the wait for the first byte and every gap between packets ([origin settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html#DownloadDistValuesOriginResponseTimeout)), within the 1–120 second quota ([quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)). Connection attempts drop to 1. CloudFront does not retry a `POST` after a read timeout ([origin settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html#DownloadDistValuesOriginResponseTimeout)).
- **Viewer function.** The viewer-request function that maps paths to `index.html` stays on the default behavior only.

**The `POST` payload hash.** With OAC in front of a function URL, `PUT` and `POST` callers must send the SHA-256 of the body in `x-amz-content-sha256`. Lambda does not accept unsigned payloads ([OAC for function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)). The browser therefore serializes the body once, hashes those exact bytes with Web Crypto, and sends the hex digest. The hash is an integrity requirement of SigV4, not authentication. Anyone can compute it.

### 4. Region and stacks: move the ask path to `us-east-1`, beside the site

Bedrock is no longer required, and `us-west-2` existed only for Bedrock. A new `PortfolioAssistantStack` in `us-east-1` holds the function, its URL, its layer, its log group, the secret reference, and its alarms. It joins the site's CDK app (`infrastructure/bin/site.ts`), and the site stack consumes its function URL through an ordinary same-region cross-stack reference. One deploy command updates both stacks, so content, evidence, and pages ship together.

- **No cross-region references.** CDK's `crossRegionReferences` is marked experimental and creates custom resources in both stacks ([Stack props](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.Stack.html)). Keeping both stacks in one region avoids it.
- **The OAC permission lives in the site stack.** It is the Lambda permission naming the distribution ARN, and putting it there avoids a dependency cycle between the two stacks.
- **The CloudFront web ACL must be in `us-east-1`** because its scope is CloudFront.
- **The current ask stack is retired.** `CareerPortfolioStack` (`bin/app.ts`) has never been deployed, so nothing is torn down: its HTTP API, Knowledge Base, S3 Vectors, source bucket, and Bedrock grounding resources are deleted from the code, with `retrieval_publisher` and the Bedrock retriever and generator. The Bedrock model provider stays. The default-app guard and its CI synth step move to the site app, and the region assertion becomes `us-east-1` for the assistant stack.

Rejected: putting the function inside `PortfolioSiteStack`. That needs no cross-stack reference, but it puts unrelated resources in one stack and makes a site-only change touch the function.

### 5. Abuse and cost protection, in layers

| Layer                        | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Edge rate limit              | AWS WAF web ACL on the distribution: one rate-based rule, scoped to URI paths starting with `/api/`, aggregating by IP: 20 requests per 10 minutes, blocked with a JSON 429. Valid windows are 60 to 600 seconds, and the minimum limit is 10 ([rate-based settings](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html)). Sampled requests are off, so WAF keeps no request details.                                                                     |
| Concurrency                  | No reserved concurrency. The account limit of 10 caps concurrent invocations for every function in the account and region. Reserving any would break Lambda's rule that 100 units stay unreserved ([reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)).                                                                                                                                                                                                                 |
| Request size                 | The question is limited to 500 characters (was 8,000), the request body to 16 KB, and history to 6 exchanges and 12,000 characters (was 24,000).                                                                                                                                                                                                                                                                                                                                                                         |
| Output                       | `max_tokens` stays 500.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Model spend                  | The owner sets a $10 limit in a dedicated Anthropic workspace (the default workspace cannot have limits). When it is reached, the API returns HTTP 400 `invalid_request_error` ([spend limits](https://platform.claude.com/docs/en/api/rate-limits#setting-your-own-spend-limit)). That error, the tier spend cap (429 `enforced_spend_limit_reached`), and an overload (529 or `overloaded_error`) all pause the execution environment for 5 minutes, during which requests get 503 `paused` without calling the model. |
| Kill switch without redeploy | Set the function's reserved concurrency to 0, which stops all invocations until the limit is removed ([reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)). Round 2 confirms that 0 is accepted at an account limit of 10. The secondary switch is disabling the key in the Anthropic Console.                                                                                                                                                                           |
| Alarms                       | An AWS Budget of $15 a month with email alerts, created by the owner by hand. Budgets and their notifications are free ([Budgets pricing](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/)). No CloudWatch alarms are in the stack: an alarm needs a notification destination, and the budget already provides one.                                                                                                                                                                                      |

**Rate limiting: WAF over a DynamoDB counter (WAF chosen).**

- **WAF** costs $5 per web ACL per month, $1 per rule per month, and $0.60 per million requests ([WAF pricing](https://aws.amazon.com/waf/pricing/)). It blocks requests before they reach Lambda and needs no code.
- **A DynamoDB on-demand counter** would cost cents: $0.625 per million writes ([DynamoDB on-demand pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/)). It conflicts with the project's no-database rule, it stores an identifier derived from the IP address, it needs the viewer address header forwarded, and it rejects requests only after Lambda has started.

**A cheaper WAF path to check.** CloudFront's flat-rate Free plan includes WAF, up to 5 rules, and IP rate limiting, with no overage charges ([flat-rate plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)). Its feature table lists custom response header rules only on the Business tier, and the site depends on a custom response headers policy for its CSP. Whether the Free plan accepts the existing distribution was not verified. It is an open question for the owner.

### 6. Site changes

- **CSP.** `script-src` moves from `'none'` to `'self'` plus the SHA-256 hashes of Astro's two inline island scripts, which are identical on every page that has the island. `style-src-elem` adds the hash of Astro's one inline island style (Round 3 found it; without it the browser blocks it and logs a violation). `connect-src` moves from `'none'` to `'self'`. Every other directive stays as it is.
- **Build profile.** `pnpm build:site` turns the assistant on with `PUBLIC_ASK_API_URL=/api/ask` and streaming.
- **Hidden fields.** The token and cost lines are development-only. The production function never sends `usage` or `estimatedCostUsd`.
- **Errors.** The UI maps HTTP 429, 503, other 5xx, and non-JSON error bodies to specific messages.

Details are in the [specification](../design/production-assistant.md#site-changes).

## Round 1 implementation

The production app (`ask_api.production_app`) implements section 1 in code. Nothing is deployed.

- **Routes.**
  - `POST /api/ask` streams the NDJSON contract.
  - `GET /ready` answers the adapter's readiness check (Round 2 sets `AWS_LWA_READINESS_CHECK_PATH=/ready`). CloudFront routes only `/api/*` to the function, so `/ready` is not public.
  - Every other route and method gets 400.
  - The server listens on `127.0.0.1` at `AWS_LWA_PORT`, then `PORT`, then 8080.
- **Statuses.**
  - 200 stream.
  - 400 invalid or unsupported.
  - 413 body over 16 KB.
  - 429 `busy`: the model API rate-limited the request, without a spend-limit code.
  - 503 `paused` (spend limit or overload) or `unavailable` (setup or model failure).
  - Never 403, 404, or 405.
- **Configuration.**
  - `ASK_PROVIDER` is `anthropic` by default, or `fixture`.
  - `ANTHROPIC_SECRET_NAME` names the secret.
  - `ANTHROPIC_MODEL_ID` is optional.
  - In Lambda the key must come from Secrets Manager. `ANTHROPIC_API_KEY` is accepted only outside Lambda, for the local Keychain launcher.
- **Evidence.** The package is bundled at `ask_api/data/evidence/` with `ask_api/data/evidence-manifest.json`, staged from the retrieval artifacts.
- **Logs.** One line per request, `ask request=… outcome=… status=… input_tokens=… output_tokens=… latency_ms=…` (the request id was added in Round 2, so a visitor's reported id can be matched), plus a class-name-only `setup_error` line when the key or client cannot be built. No question, answer, prompt, history, body, IP, or key.

## Round 2 implementation

Synthesized only; nothing is deployed.

- **`PortfolioAssistantStack`** (`us-east-1`, in the site app): the function (Python 3.13, ARM64, 256 MB, raised to 512 MB after Round 5, 35-second timeout, handler `run.sh`, no reserved concurrency), its function URL (`AWS_IAM`, `RESPONSE_STREAM`), the adapter layer, a 14-day log group, and environment for the adapter, the model id, and the secret name. The role can read only the named secret (`secret:<name>-??????`). The secret is referenced by name and never created.
- **Web Adapter layer.** The project publishes no binaries on GitHub releases (checked against the releases API), so `pnpm prepare:web-adapter` reads the 1.1.0 linux/arm64 image anonymously from `public.ecr.aws/awsguru/aws-lambda-adapter` over the registry API. Three pins fail it closed: the arm64 manifest digest, each layer's digest from that manifest, and the SHA-256 of the extracted `lambda-adapter` binary. The layer is that binary in `extensions/` plus a two-line `bootstrap` equivalent to the adapter's own. No layer ARN from another account is used. CI does not fetch: public ECR throttles anonymous pulls from shared runners (HTTP 429), so CI synthesizes with a stub layer and `-c webAdapterStub=allow`, and the site app refuses the stub (or any binary not matching the pinned SHA-256) for every other synth, including `diff:site` and `deploy:site`. The owner runs the fetch before deploying; it retries 429, 5xx, and network errors with exponential backoff and `Retry-After`. Unit tests use a fake registry.
- **`PortfolioSiteStack`:** an `/api/*` behavior to the function URL with a Lambda OAC (always sign, SigV4), `CachingDisabled`, all methods, HTTPS only, no compression, no viewer-request function, a 40-second read timeout and one connection attempt, and an origin request policy forwarding only `Content-Type` and `Accept` (Round 4 removed `x-amz-content-sha256`, which CloudFront does not allow there). Two Lambda permissions for `cloudfront.amazonaws.com`, both with `aws:SourceArn` set to this distribution: `lambda:InvokeFunctionUrl` (added by CDK) and `lambda:InvokeFunction` (added here, because CloudFront's OAC guide lists both). The WAF web ACL is attached to the distribution. Page behaviors are unchanged.
- **Asset layout fix.** Staging used to copy the `ask_api` modules to the asset root, where `import ask_api` would fail. The asset is now the task root: `ask_api/`, its dependencies, and `run.sh`. Without boto3 it shrank from 51 MB to 23 MB.
- **Removed:** `CareerPortfolioStack`, its HTTP API, Knowledge Base, S3 Vectors, and source bucket, `bin/app.ts`, the retrieval publisher, and the Bedrock retrieval and grounding modules. The Bedrock model provider stays.

## Round 4 results (deployed)

Both stacks are deployed by the owner, and the assistant is live on `https://lucaselia.dev`.

- **Origin request policy.** The first site deploy failed and rolled back cleanly:

  > AWS::CloudFront::OriginRequestPolicy: The parameter Headers contains x-amz-content-sha256 that is not allowed. (CloudFront, 400)

  The `/api/*` policy now forwards only `Content-Type` and `Accept`, and a synth test keeps `x-amz-content-sha256` out of it. The browser still sends the header. With it absent from the policy, signed `POST`s work: answers stream through CloudFront, confirmed live. The OAC guide for function URLs does not describe how CloudFront uses the viewer's header when signing; the live result is the evidence.

- **OAC lock.** A direct `POST` to the function URL returns `403`.
- **Kill switch.** `put-function-concurrency` with 0 was accepted at the account concurrency limit of 10, and `delete-function-concurrency` restored the function. The open question from Round 2 is answered.
- **Key rotation, learned the hard way.** The first live request failed with `AuthenticationError`: the wrong value had been saved to the secret. The fix was a new key, `put-secret-value`, and a configuration update to force new execution environments, because warm environments keep the key they read at cold start. The procedure is in the [runbook](../design/production-assistant.md#7-rotate-the-anthropic-api-key).
- **Cold start.** About 4 seconds of init. The adapter logged that the app was not ready after 2,000 ms and 4,000 ms before it listened. The causes and proposed fixes are in the [specification](../design/production-assistant.md#cold-start). Fixes 1 and 2 were made after Round 5 (see below).
- **Streaming** was confirmed by eye: answers render gradually.
- **Runtime boto3 and `run.sh`** both work in the real runtime (the function reads its secret and serves requests).
- **Key expiry.** The Anthropic key expires in about a year (around October 2027). Rotate it before then.
- **CDK warning.** `cdk.json` sets `@aws-cdk/core:defaultCrossStackReferences` to `"strong"`, CDK's existing default; templates are byte-identical with and without it.

## Round 5 results

The owner ran the production evaluation on the live site on October 18, 2026, on desktop; the phone pass was not run. The [results table](../tests/evaluation/README.md#production-evaluation-round-5) records each item.

- **All eleven items pass.** Grounded answers with citations, the partial-support answer (it led with the SDE II technologies and stated the gap once), the fixed refusal with no citations for favorite food and Lumen Harbor, the 500-character cap, no CSP errors, the privacy note, and the role-page box.
- **Wording issue: a repeated negative.** The degree answer said "no degree awarded" twice, once per education page, because each page's facts say so. The fix is a sharper rule in `answer_style`, with a short example: state a negative that several pages support once, as one clause for the whole answer. The prompt version is now `local-4`. Local mode and production share this one prompt. Reviewed content is unchanged.
- **WAF rate limit.** A 30-request burst got `400`s throughout: WAF counts requests with a delay, so a short burst can pass before the rule acts. A slower loop afterwards got `429` throughout, and the site showed "Too many questions in a short time. Please wait a few minutes."
- **Streaming** confirmed by eye. **The first answer after idle** took about 4 seconds, the cold start measured in Round 4.

Polish made after Round 5, for the owner to deploy:

- Prompt `local-4` (the rule above).
- **Precompiled bytecode.** Staging compiles the asset with CPython 3.13 in unchecked-hash mode and fails unless every module has matching bytecode.
- **512 MB of memory**, which doubles the CPU share for CPU-bound imports. The saturation worst case in the cost model rises from about $81 to about $167 of Lambda duration a month; the $15 budget alarm and the kill switch still bound it in practice.
- After deploying, the cold start's `Init Duration` in the `REPORT` log line is the measure (about 4,000 ms before; about 1,000–1,500 ms expected).

## What this changes in earlier records

On acceptance:

- **ADR-004** is superseded: no HTTP API, and the ask path is a function URL behind CloudFront.
- **ADR-005's** Knowledge Base, S3 Vectors, publication, and ingestion decisions are superseded. Its citation-trust rule, keeping Lumen Harbor out of evidence, and the distinction between sanitized failures and insufficient evidence still apply.
- **ADR-006's** "production transport not selected" is resolved here.
- **ADR-007's** consequence, a CSP change and an ask-path ADR, is met here.
- **ADR-008's** "Not decided here" items are decided here.

Those records keep their text and receive status notes in the implementation round.

## Consequences

- **The Anthropic SDK ships in production.** `anthropic` moves from the development dependency group into the Lambda asset.
- **Content deploys move together.** A content change rebuilds the site and the function's evidence package, which deploy together.
- **The browser hashes each request body.** The extra step is small, and `crypto.subtle` is available because the site is HTTPS-only.
- **API errors must avoid 403 and 404.** The distribution's custom error responses map 403 and 404 to `/404.html` for the whole distribution, so the API returns 400, 413, 429, and 503 only, and the WAF block action uses a custom 429. That CloudFront custom error responses apply to every behavior is expected from how they are configured, but was not re-verified in documentation for this ADR. Round 4 tests it.
- **WAF is most of the AWS bill.** The expected AWS cost is about $7.60 a month: WAF $6 (one web ACL and one rule), Secrets Manager $0.40, and alarms. Under a sustained flood of requests, CloudFront request fees ($1.00 per million) and WAF's $0.60 per million are not capped by these controls. The $15 budget alarm detects that, and the kill switch is the response. The cost model is in the specification.
- **The concurrency cap is the account limit.** With no reserved concurrency, a flood can occupy all 10 concurrent executions in the account. Lambda duration cost is then bounded only by that limit and the kill switch.
- **The model spend cap protects the bill, not availability.** Within the WAF limit, one IP can still send 2,880 requests a day, enough to exhaust the $10 cap in under a day at worst-case request size, which pauses the assistant until the month resets.

## Not verified, or open

- Resolved in Round 4: progressive streaming through CloudFront, the kill switch at a concurrency limit of 10, the runtime's boto3, `run.sh` under the adapter, and signed `POST`s without `x-amz-content-sha256` in the policy (see Round 4 results). Cold start is measured (about 4 s); the bytecode and 512 MB fixes made after Round 5 are not yet measured live.
- Whether the flat-rate Free plan accepts the distribution's custom response headers policy.
- The Lambda ARM price per GB-second used in the cost model ($0.0000133334) comes from secondary sources. AWS's own pricing page did not render the table.
- Haiku 4.5's minimum cacheable prompt is 4,096 tokens, and the live evaluation averaged about 2,800 input tokens per question, so prompt caching would not apply. It is not proposed.
