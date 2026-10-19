# ADR-009: Serve the production assistant from a streaming Lambda behind the site's CloudFront

**Status:** Proposed. The owner locked the transport, region, stacks, server, limits, and budgets on October 17, 2026, and WAF on October 18, 2026. Rounds 1 and 2 (the app and the infrastructure) are built and synthesized. The record becomes Accepted after deployment.  
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

Production uses prompt `local-3`, which a later round renames without changing its wording, and the shared `answer_style` rules. The `SOURCES:` validation, refusal wording, and partial-support behavior are the ones evaluated live in Slice 1.

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

- **`PortfolioAssistantStack`** (`us-east-1`, in the site app): the function (Python 3.13, ARM64, 256 MB, 35-second timeout, handler `run.sh`, no reserved concurrency), its function URL (`AWS_IAM`, `RESPONSE_STREAM`), the adapter layer, a 14-day log group, and environment for the adapter, the model id, and the secret name. The role can read only the named secret (`secret:<name>-??????`). The secret is referenced by name and never created.
- **Web Adapter layer.** The project publishes no binaries on GitHub releases (checked against the releases API), so `pnpm prepare:web-adapter` reads the 1.1.0 linux/arm64 image anonymously from `public.ecr.aws/awsguru/aws-lambda-adapter` over the registry API. Three pins fail it closed: the arm64 manifest digest, each layer's digest from that manifest, and the SHA-256 of the extracted `lambda-adapter` binary. The layer is that binary in `extensions/` plus a two-line `bootstrap` equivalent to the adapter's own. No layer ARN from another account is used. CI does not fetch: public ECR throttles anonymous pulls from shared runners (HTTP 429), so CI synthesizes with a stub layer and `-c webAdapterStub=allow`, and the site app refuses the stub (or any binary not matching the pinned SHA-256) for every other synth, including `diff:site` and `deploy:site`. The owner runs the fetch before deploying; it retries 429, 5xx, and network errors with exponential backoff and `Retry-After`. Unit tests use a fake registry.
- **`PortfolioSiteStack`:** an `/api/*` behavior to the function URL with a Lambda OAC (always sign, SigV4), `CachingDisabled`, all methods, HTTPS only, no compression, no viewer-request function, a 40-second read timeout and one connection attempt, and an origin request policy forwarding only `Content-Type` and `Accept` (Round 4 removed `x-amz-content-sha256`, which CloudFront does not allow there). Two Lambda permissions for `cloudfront.amazonaws.com`, both with `aws:SourceArn` set to this distribution: `lambda:InvokeFunctionUrl` (added by CDK) and `lambda:InvokeFunction` (added here, because CloudFront's OAC guide lists both). The WAF web ACL is attached to the distribution. Page behaviors are unchanged.
- **Asset layout fix.** Staging used to copy the `ask_api` modules to the asset root, where `import ask_api` would fail. The asset is now the task root: `ask_api/`, its dependencies, and `run.sh`. Without boto3 it shrank from 51 MB to 23 MB.
- **Removed:** `CareerPortfolioStack`, its HTTP API, Knowledge Base, S3 Vectors, and source bucket, `bin/app.ts`, the retrieval publisher, and the Bedrock retrieval and grounding modules. The Bedrock model provider stays.

## Round 4 deploy finding

The first deploy (owner-run) created `PortfolioAssistantStack`. `PortfolioSiteStack` failed and rolled back cleanly, leaving the live site unchanged:

> AWS::CloudFront::OriginRequestPolicy: The parameter Headers contains x-amz-content-sha256 that is not allowed. (CloudFront, 400)

- **Fix.** The `/api/*` origin request policy now lists only `Content-Type` and `Accept`, and a synth test asserts `x-amz-content-sha256` is never listed. The browser still computes and sends the header, because the OAC guide requires callers to send it to CloudFront.
- **Documentation.** The OAC guide for function URLs and CloudFront's request header reference are silent on how the viewer's `x-amz-content-sha256` is used when CloudFront signs, and neither lists it as disallowed in a policy. The deploy error is the only evidence for the second point. The smoke test is the check for the first: a browser `POST /api/ask` that streams an answer proves the signed request was accepted. A `403` with a signature error from the function URL would mean the hash is not reaching the signature, and needs a follow-up.
- **CDK warning.** The deploy also warned that no cross-stack reference strength was configured. `cdk.json` now sets `@aws-cdk/core:defaultCrossStackReferences` to `"strong"`, CDK's existing default; synthesized templates are byte-identical with and without it, so nothing already deployed changes.

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

- Cold-start time with the adapter, and that CloudFront delivers NDJSON chunks progressively in this exact configuration. Both are Round 4 smoke-test gates.
- How CloudFront uses the viewer's `x-amz-content-sha256` when it signs the origin request. The [OAC guide for function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html) says only that `PUT` and `POST` callers must send it to CloudFront, and that Lambda does not support unsigned payloads; CloudFront's [request header reference](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html#request-custom-headers-behavior) does not list the header, and neither page says it is forwarded or used for SigV4. The origin request policy cannot carry it (Round 4). The smoke test verifies that a signed `POST /api/ask` from the browser reaches the function.
- Whether reserved concurrency 0, the kill switch, is accepted at an account concurrency limit of 10. Round 2 checked the documentation and could not confirm it either way: `PutFunctionConcurrency` accepts a minimum value of 0, and the rule is to leave at least 100 executions unreserved ([PutFunctionConcurrency](https://docs.aws.amazon.com/lambda/latest/api/API_PutFunctionConcurrency.html), [concurrency quotas](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html#concurrency-quotas)). Setting 0 reserves nothing, so it should not shrink the unreserved pool, but no page covers an account whose total limit is below 100. The runbook has a fallback that does not depend on it.
- Whether the flat-rate Free plan accepts the distribution's custom response headers policy.
- The Lambda ARM price per GB-second used in the cost model ($0.0000133334) comes from secondary sources. AWS's own pricing page did not render the table.
- That the Python 3.13 runtime's boto3 works with the function. AWS documents that the Python runtimes include the SDK for Python and that the version depends on the runtime and Region ([Python runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-python.html#python-sdk-included)); the app makes one Secrets Manager call. Round 4 confirms it.
- That `run.sh` starts the app under the adapter's bootstrap in the real runtime (`PYTHONPATH`, `python3` on the path). It follows the adapter's own layer script, but it has not run in Lambda. Round 4 confirms it.
- Haiku 4.5's minimum cacheable prompt is 4,096 tokens, and the live evaluation averaged about 2,800 input tokens per question, so prompt caching would not apply. It is not proposed.
