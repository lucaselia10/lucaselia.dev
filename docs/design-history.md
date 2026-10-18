# Design history

The key decisions and turning points behind the portfolio, in order. The current system is [system design](system-design.md), individual decisions are in the [ADR index](adr/README.md), and planned work is the [roadmap](roadmap.md).

## Starting point (September 2026)

The project started from a private discovery document, the preliminary design. It set the shape that still holds: a static site, a stateless ask API, and infrastructure as code, with reviewed public Markdown as the only source of career text.

- **Monorepo and toolchain.** pnpm workspaces for the Astro site, CDK, scripts, and a shared content package, with uv and Python 3.13 for the API. TypeScript stays on 6.0 and ESLint on 9 because the lint and Astro check toolchains did not yet support the newer majors.
- **Astro with one React island** ([ADR-001](adr/001-astro-react-island.md)). Pages are static HTML. React is limited to the assistant, the only part with client-side state.
- **GitHub Actions and CDK** ([ADR-002](adr/002-github-actions-and-cdk.md)). CI verifies; it does not deploy. Terraform, Kubernetes, a database, and authentication were ruled out as more than a portfolio needs.
- **A fictional fixture.** Before any real content existed, a made-up project, Lumen Harbor, exercised validation, routing, and citations. It stayed after real content arrived, as a public page the assistant must never use as evidence.

## Content model

- **Facts in front matter, narrative in H2 sections.** Exact facts (employer, dates, status, skills) live in typed front matter so they can be indexed without reading prose. H2 sections are the citation targets, so every citation is a stable `/{type}/{id}#{heading}` URL.
- **A discriminated schema.** `type` selects the required fields. Education separates `education_status` (completed or attended) from `degree_awarded`, because completing a program is not the same as receiving a degree. An experience `location` may be `null` when the public source does not name one, and the page then omits it instead of guessing.
- **Visibility and retrieval are separate.** `visibility` is `public` or `draft`. `assistant_retrievable` decides whether a public page may ground an answer. Lumen Harbor is public and not retrievable.
- **Reviewed sources only.** Real documents were added only after the author reviewed the wording against the public LinkedIn profile. Private notes never enter the repository, and validation rejects internal hosts, phone numbers, and street addresses.

## Answering questions

- **Exact answers first** ([ADR-003](adr/003-bundle-career-index-with-lambda.md)). A generated career index answered a few fact families (current role, history, education, technologies) from templates. The index ships inside the Lambda, so content and code deploy together.
- **HTTP API and one Lambda** ([ADR-004](adr/004-http-api-and-ask-lambda.md)). `POST /ask` is a public route with throttling, reserved concurrency, tight CORS, and access logs that omit bodies and questions. Timeouts are ordered so the Lambda fails before the gateway, and the gateway before the browser.
- **Grounded retrieval** ([ADR-005](adr/005-grounded-career-answering.md)). Open-ended questions retrieve at most five approved sections from a Bedrock Knowledge Base on S3 Vectors, then generate an answer whose citations come from retrieval metadata, never from model output. Each H2 section is one retrieval document, so chunking is off. Ingestion is an explicit operator command with a dry-run default, not something a build or deploy can trigger.

## From templates to a conversation (October 2026)

- **Model-written, streamed answers** ([ADR-006](adr/006-model-conversation-and-streaming.md)). Templated answers read stiffly, and follow-ups did not work. The decision moved ordinary answers, simple facts included, to a grounded model, with recent turns as context but never as evidence. The answer streams as it is generated.
- **Local slice first.** Before any production work, the conversation runs locally against the whole approved evidence package: the eight retrievable sections, each with a `Facts:` header from front matter. The model ends with a `SOURCES:` line that is held back from the stream and parsed, and any citation that is not in the package fails the answer.
- **A provider interface** ([ADR-008](adr/008-anthropic-api-for-model-answers.md)). Bedrock model capacity was unavailable for this account at the time, so local mode moved to the Anthropic API behind a small provider interface, with Bedrock still one setting away. A `TypeError` that fake clients had hidden led to typing providers against the real SDKs and testing them over mocked transports.
- **Live evaluation.** The first live run answered grounded questions with citations and refused the off-topic and Lumen Harbor probes. It also refused a follow-up the evidence partly supported. The cause was an all-or-nothing prompt, so the prompts now answer the supported part and state the gap. A later pass made the wording rules shared between the local and production prompts.

## The visible site

- **Redesign v2** ([portfolio experience V1](design/portfolio-experience-v1.md)). The first visual direction read as templated. V2 draws the career as a capacity plan: a chart generated from front matter, one variable typeface, and a position strip on each role page.
- **Copy review.** A line-by-line review trimmed the copy to a bare-bones record. The site, the career index, and the evidence package were rebuilt from the trimmed text.
- **Static launch without the assistant** ([ADR-007](adr/007-static-site-hosting.md)). The reviewed record did not need to wait for the assistant. The site went live at `lucaselia.dev` on S3 and CloudFront from its own CDK app, which cannot reach the ask stack. A production build profile leaves out the assistant, the fixture, and the career index. The CSP allows no scripts.

## Working method

Design and decisions are the author's. Claude Code implements each round under repository rules that deny AWS, deploy, model-mode, publish, and git-write commands. A separate Claude chat reviews each round and scopes the next. Live evaluations and deploys are run by the author.

Before the repository went public, a review moved session notes and personal setup into an untracked folder, and added `pnpm check:public` to keep it that way.
