# Roadmap

This is the forward-looking plan. It has no calendar dates. The system that exists today is [system design](system-design.md). Product details for the portfolio are [portfolio experience V1](design/portfolio-experience-v1.md). Conditions that must be true before AWS deployment are [deployment readiness](deployment-readiness.md).

Where things stand: the static site is live at `https://lucaselia.dev` without the assistant ([ADR-007](adr/007-static-site-hosting.md)). The code is in a private GitHub repository, and the GitHub Actions workflow verifies every push. The assistant runs locally only. A production assistant is planned and has not been built or deployed.

The next two implementation slices are ordered. Slice 1 is implemented locally and has had a live evaluation on the Anthropic API. Slice 2 carries that experience into the production request path only after an architecture investigation and has not started. Accepting them does not authorize deployment, bootstrap, retrieval publication, or ingestion. [ADR-006](adr/006-model-conversation-and-streaming.md) records the answer-policy change. It does not select the production streaming transport.

## Completed foundations

**Status:** completed

**Objective:** Keep a reviewed public corpus, a static site, deterministic exact answers, a grounded answering path, and a controlled publication workflow in source control, without creating a remote or AWS resources.

**Work included:**

- The monorepo, toolchain, and GitHub Actions verification workflow.
- The public-document schema, citation routes, and the current reviewed corpus.
- The scaffold site, React assistant island, and local handler wiring.
- Exact answers from the bundled career index.
- The synthesized HTTP API, Lambda, Knowledge Base, S3 Vectors index, private source bucket, and split IAM roles.
- Retrieve-then-generate behavior, sanitized failures, and retrieval artifact generation.
- `pnpm publish:retrieval`, with a read-only default and injected-client tests.
- ADRs 001 through 005 and the evaluation case file.

**Exclusions:** no Git remote, no push, no CDK bootstrap, no deployment, no upload, no ingestion, and no production visual design.

**Completion gate:** met. The local `main` branch contains that foundation. AWS resources remain synthesized definitions only.

## Phase 1 — Portfolio product design

**Status:** mostly complete. Redesign v2 and the contact content are approved and live on the static site. The headshot and case-study diagrams are still open.

**Objective:** Finish the V1 visitor experience before treating the visual design as approved.

The homepage direction is accepted and shipped. The headshot and case-study diagrams remain open, so this phase is not closed.

**Already approved:**

- Redesign v2 (October 2026) replaces the first direction: a cool grey ground, ink panels, lane colors, one Archivo family with width and weight axes, and the career drawn as a capacity plan. The first direction read as templated.
- Desktop layout with the assistant beside the hero, and the single-column mobile order with one assistant instance.
- Frontend boundaries: Astro for static pages, React only for the assistant, custom CSS design tokens, and no large component or animation framework.
- Assistant placement in the hero on desktop and directly under the introduction on mobile.
- The future portfolio case study and the exclusion of Lumen Harbor from the primary homepage. The What changed section was removed on October 13, 2026.

**Still required before this phase is complete:**

- Visually review the rendered homepage and detail pages.
- Decide whether the hero includes a professional headshot.
- Decide whether a résumé is linked.
- Decide whether case-study architecture diagrams belong in V1.

Hero copy, primary actions, design tokens, and the Archivo setup are recorded in [portfolio experience V1](design/portfolio-experience-v1.md).

**Exclusions:** no application code in the design document. Hosting, domain, CORS, deployment identities, and budget destinations stay deployment decisions.

**Completion gate:** an approved V1 product-design document with no unresolved structural UX questions. The specification is [portfolio experience V1](design/portfolio-experience-v1.md). The approvals above do not close this gate.

## Phase 2 — Portfolio UI implementation

**Status:** shipped for the static site. Selected work is not built, because no reviewed project document exists yet.

**Objective:** Replace the scaffold homepage with the approved V1 layout.

Redesign v2 is implemented and live: the visual system, hero, assistant, career chart, experience and education rows, and role pages with a position strip and a compact assistant. The assistant is a conversation over complete JSON responses, with follow-ups resolved from the career index. That is not the model-backed conversation in Slice 1. Selected work, contact links, and a headshot are not part of this slice. The phase is not complete until the rendered pages are reviewed and the remaining homepage sections from the product spec are either built or explicitly deferred.

**Work included:**

- Build navigation, hero, profile summary, experience, education, and selected-work sections.
- Integrate the assistant into the finished layout.
- Preserve citation routes.
- Implement loading, success, unsupported, timeout, unavailable, and citation states.
- Verify desktop and mobile layouts.
- Keep content sourced from validated public documents.

**Exclusions:** no new career claims during layout work. The fictional fixture is not presented as real work.

**Completion gate:** a locally approved responsive portfolio with passing accessibility, type, lint, test, and build checks.

## Slice 1 — Local model-backed conversation and streaming

**Status:** implemented locally. Bedrock model capacity was unavailable for this account at the time, so the evaluation runs on the Anthropic API ([ADR-008](adr/008-anthropic-api-for-model-answers.md)); Bedrock stays selectable. The user ran the live evaluation and a recheck in October 2026 ([results](../tests/evaluation/README.md#live-run-results)). The gate stays open until the latest wording fixes are confirmed live.

**Objective:** Evaluate the real conversational experience before deploying the application or provisioning the Bedrock Knowledge Base and vector infrastructure.

The deterministic JSON path remains the default. Opt in with `LOCAL_MODEL_CONVERSATION` on the API and `PUBLIC_ASK_STREAMING=true` on the site. `LOCAL_MODEL_CONVERSATION=fixture` streams an in-process fixture and does not call AWS. A model failure does not fall back to an index template.

**Work included:**

- Keep Astro, the React assistant island, and the Python API running locally.
- Call the configured model provider through server-side credentials: the Anthropic API by default, or Bedrock Nova.
- Supply approved, assistant-retrievable public content directly as evidence for this local evaluation. Exclude private career notes and fictional or other non-retrievable documents, including Lumen Harbor.
- Use a bounded set of recent conversation turns to interpret follow-ups. Prior messages are conversation context, not authoritative career evidence.
- Have the model compose ordinary supported career answers, including simple factual questions. Keep deterministic code for authoritative fact selection and validation where it still helps.
- Keep citations tied to trusted public documents and the allowlisted routes.
- Stream actual generated content from Bedrock through the local Python server to React. Do not animate a completed response or add an artificial delay.
- Handle loading, cancellation, interrupted streams, failures, retry, and accessible status updates.
- Keep the conversation in page memory only. Do not save transcripts or log questions, answers, prompts, or request bodies.
- State in the operator notes that this local run makes paid AWS model calls and needs configured credentials and model access. The site, the API, and the retrieval infrastructure stay undeployed.

Direct local evidence is not Knowledge Base retrieval. Production retrieval stays the design in [ADR-005](adr/005-grounded-career-answering.md) unless a later ADR changes it.

**Exclusions:** no CDK bootstrap, no deployment, no upload, no ingestion, and no provisioning of the Knowledge Base or vector index. Unit and integration tests inject clients and do not make paid calls. A paid call happens only as an explicit evaluation.

**Completion gate:** a real-model evaluation, recorded without saving question text, of a simple fact, an open-ended question about production reliability, a contextual follow-up, an unsupported question, citations, and streaming behavior on desktop and mobile. Automated tests pass with injected clients.

## v1 static launch

**Status:** live at `https://lucaselia.dev`. The user deploys it from their own terminal.

**Objective:** Publish the reviewed portfolio at `https://lucaselia.dev` as a static site, without the assistant, while the assistant waits on Slice 1 and Slice 2.

**Work included:**

- A production build profile (`pnpm build:site`) with no assistant, no Ask navigation or buttons, no test fixture, and no published career index.
- Approved public contact content (email, LinkedIn, GitHub) and a Contact section.
- `site`, canonical URLs, Open Graph tags, `robots.txt`, a sitemap, an LE favicon, and a 404 page.
- `PortfolioSiteStack` in `us-east-1`: private S3 with OAC, CloudFront, ACM, Route 53, a viewer-request function, security headers, and a deployment that invalidates the distribution. See [ADR-007](adr/007-static-site-hosting.md).
- A separate CDK app entry, so the site command cannot reach the ask stack.

**Exclusions:** no assistant, no ask API deployment, no access logging, no CI deployment.

**Completion gate:** the user deploys, `https://lucaselia.dev` and `https://www.lucaselia.dev` serve the site over HTTPS, the headers and 404 behavior are verified in a browser, and the result is recorded in the handoff.

## Slice 2 — Production streaming architecture and deployment integration

**Status:** not started. It starts only after Slice 1 is accepted.

**Objective:** Carry the validated conversational experience through the production AWS request path and the approved retrieval pipeline.

This slice begins with architecture investigation, then implementation. Its deployment step is the ask-path portion of Phase 8. Phases 5 through 7 still settle hosting, identity, and cost before that deployment. Writing this milestone does not authorize account changes, bootstrap, deployment, publication, or ingestion. The checks in [deployment readiness](deployment-readiness.md) still apply.

Slice 2 also decides the production model provider (the Anthropic API, Bedrock, or both, behind the `ask_api.model_providers` interface) and whether the small approved corpus is passed directly as evidence instead of retrieved from the Knowledge Base ([ADR-008](adr/008-anthropic-api-for-model-answers.md)).

**Work included:**

- Assess the current API Gateway HTTP API and Python Lambda integration for end-to-end streaming. Do not assume that a streaming Bedrock call makes the browser response stream. The current proxy integration returns one buffered JSON document.
- Verify current AWS capabilities in official documentation during that investigation. Record the selected transport, integration, and any required infrastructure change in a new ADR. [ADR-006](adr/006-model-conversation-and-streaming.md) deliberately does not choose that transport.
- Preserve the static Astro site and the single React assistant island.
- Integrate approved evidence retrieval through the existing Bedrock Knowledge Base and S3 Vectors design, unless that new ADR changes it.
- Support the same bounded conversation context and model-generated answers as Slice 1.
- Define stream events, completion, citations, errors, timeouts, cancellation, and how the client recovers.
- Resolve how streaming interacts with `submit_grounded_answer` and the current validation step. The current API validates a complete model result before it returns JSON. Partial streamed text has not passed that final check, and the product must not say that it has.
- Review IAM, CORS, throttling, concurrency, logging, usage controls, and deployment configuration for the selected path. Logging still omits questions, answers, prompts, and request bodies.
- Verify the deployed system for progressive delivery, contextual follow-ups, grounded citations, failure handling, and desktop and mobile usability.

**Exclusions:** no implementation before the transport ADR. No deployment before the readiness checklist and an explicit approval at the time deployment is requested. Tests that can run without AWS use injected clients.

**Completion gate:** an accepted transport ADR, a deployed path that streams generated content end to end, and recorded verification of the behaviors above. Existing hosting, identity, budget, and rollback decisions stay open until their own phases close them.

## Phase 3 — Public content expansion and review

**Status:** pending

**Objective:** Add only reviewed public material that helps visitors and grounded answers.

**Work included:**

- Add carefully reviewed project or work documents.
- Exclude confidential, proprietary, internal, or unverifiable claims.
- Add only material useful to visitors and grounded answers.
- Run the retrieval evaluation set and expand it where needed.
- Confirm the fictional fixture cannot appear in assistant retrieval.

**Exclusions:** no automatic copy from private career notes. No unreviewed narrative.

**Completion gate:** an approved public corpus and passing deterministic and evaluation checks.

## Phase 4 — GitHub repository and CI

**Status:** in progress. The private repository and CI exist. The public repository is next: a fresh single-commit history from reviewed files, with `pnpm check:public` passing. The private repository keeps the full history and stays private.

**Objective:** Keep the code in a remote, run the verification workflow on every push, and publish a clean public copy.

**Work included:**

- Create the private repository remote.
- Run the existing GitHub Actions CI.
- Review every tracked file for public release and add `pnpm check:public` to CI.
- Create the public repository from a fresh history.
- Add branch protections if useful.
- Keep deployment disabled initially.

**Exclusions:** no AWS credentials in GitHub. No deploy job in this phase.

**Completion gate:** a clean remote repository with passing CI and no credentials or private career material.

## Phase 5 — Production hosting design

**Status:** complete for the static site ([ADR-007](adr/007-static-site-hosting.md)). The production API origin and CORS wait for Slice 2.

**Objective:** Choose how the static site is hosted before any hosting resources are synthesized.

**Work included:**

- Decide the static-site hosting architecture.
- Decide whether and when to add a custom domain.
- Define HTTPS, caching, invalidation, security headers, and deployment behavior.
- Establish the production API origin and CORS configuration.
- Record the decision in an ADR.

**Completion gate:** an approved hosting ADR and synthesized hosting infrastructure.

## Phase 6 — Deployment identity and delivery pipeline

**Status:** partly done. The user deploys the static site locally with a named deploy profile that requires MFA. GitHub OIDC, a retrieval-publishing identity, and CI deployment are not built.

**Objective:** Separate the people and roles that deploy infrastructure from the role that publishes retrieval objects.

**Work included:**

- Define the local first-deployment procedure.
- Create a GitHub OIDC deployment role later.
- Separate infrastructure deployment permissions from retrieval publishing permissions.
- Avoid long-lived GitHub AWS credentials.
- Define environment and configuration handling.
- Define rollback behavior.

**Exclusions:** no operator role and no deployment role exist in the stack today.

**Completion gate:** reviewed least-privilege policies and a non-production deployment plan. The checklist is [deployment readiness](deployment-readiness.md).

## Phase 7 — Cost and operational guardrails

**Status:** pending

**Objective:** Put a cost ceiling and an operational checklist in place before the site is public.

**Work included:**

- Add an AWS Budget or an equivalent cost notification.
- Add useful API and Lambda alarms without logging visitor questions.
- Confirm log retention.
- Confirm throttling and reserved concurrency.
- Estimate expected monthly cost.
- Document incident and rollback steps.

**Exclusions:** no cost figure is claimed in the current documentation. Alarms must not record question text.

**Completion gate:** an approved cost ceiling and an operational checklist before public exposure.

## Phase 8 — First AWS deployment

**Status:** pending

**Objective:** Deploy the synthesized backend only after the readiness checklist is approved, then prove the ask paths.

**Work included:**

- Bootstrap CDK deliberately.
- Deploy infrastructure.
- Capture outputs.
- Run the publisher in plan mode.
- Review the plan.
- Apply retrieval publication and ingestion.
- Verify Knowledge Base retrieval.
- Verify Nova grounded answers.
- Verify the accepted conversation from Slice 2: model-composed answers, deterministic validation where the implementation keeps it, grounded citations, and progressive delivery. Do not require every simple fact to bypass Bedrock.
- Keep production website traffic off until smoke tests pass.

Slice 2 is part of the ask-path work this phase deploys. Phases 5 through 7 still settle hosting, identity, and cost before that deployment. This phase does not override those gates.

**Exclusions:** no upload or ingestion during synthesis. Deployment still requires an explicit approval at the time it is requested.

**Completion gate:** a validated AWS backend with recorded smoke-test results.

## Phase 9 — Website deployment and launch

**Status:** pending for the assistant. The static site itself launched in v1.

**Objective:** Serve the approved static site against the verified API.

**Work included:**

- Deploy the static site.
- Configure `PUBLIC_ASK_API_URL`.
- Set production CORS.
- Run browser tests against production.
- Validate citations and mobile behavior.
- Confirm budget notifications and alarms.
- Publish the portfolio URL.

**Completion gate:** a public V1 launch with passing production verification.

## Phase 10 — Post-launch improvements

**Status:** pending

**Objective:** Hold later improvements until a real visitor or evaluation need justifies them.

**Work included, and intentionally deferred:**

- Richer projects.
- Automated content deployment.
- Evaluation automation against live Bedrock.
- Optional authentication or abuse controls if traffic requires them.
- Analytics that do not collect question content.
- Reranking only if evaluation demonstrates a need.
- Terraform, Kubernetes, or other tooling only when a real requirement justifies it.

**Completion gate:** each item waits for its own decision. None of them is required for the V1 launch gate in Phase 9.
