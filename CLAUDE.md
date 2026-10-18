# Career portfolio — orientation for Claude

This repository is public. Personal setup (profile names, Keychain item, account status) lives in
the untracked `CLAUDE.local.md`, which Claude Code loads alongside this file when it exists.

## Read first (in order)

1. private/session-handoff.md, if present (untracked) — "Current position" wins over older sections
2. docs/roadmap.md — phases, Slice 1/2 gates
3. docs/system-design.md — the implemented system
4. docs/design/portfolio-experience-v1.md — product spec (redesign v2)
5. docs/adr/README.md, ADR-005, ADR-006, ADR-008 — accepted decisions
6. docs/deployment-readiness.md — gate before any AWS work

README.md and docs/design-history.md are reference; read the parts you need.

## Working agreement

- Discuss meaningful or architectural decisions with the user before making them.
- Do not commit, add a remote, or push unless the user explicitly asks.
- Rounds are reviewed by a separate planning assistant; follow the round's stated scope.
- The repository is public. Before the user commits, flag any new career wording, internal or
  employer-internal names, metrics, or personal identifiers you added or noticed, and run
  `pnpm check:public`.

## Hard guardrails

- Never bootstrap CDK, deploy, upload, start ingestion,
  or make any AWS/Bedrock call.
- Never start `pnpm dev:api:model`, `pnpm dev:api:model:bedrock`, or `pnpm dev:web:model`.
  Fixture mode (`LOCAL_MODEL_CONVERSATION=fixture`) calls no model.
- Never make a paid model call (Anthropic or Bedrock). Never read, print, or log an API key,
  a Keychain item, or any `.env` file.
- Never read credential files, the AWS login cache, or secrets; never ask for credentials.
  Do not modify the user's AWS profiles.
- Do not read private career notes. Add no new career claims; content/public is
  user-reviewed only.
- Files under private/ are local-only. Never move their content into tracked files.
- Lumen Harbor is a fictional fixture: public and indexed, never evidence
  (`assistant_retrievable: false`).
- No Terraform/Kubernetes/Helm/Argo, no database, no auth, no saved transcripts,
  no logging of questions, answers, prompts, or request bodies.
- Never write an AWS account ID, ARN with an account, profile name, hosted zone id, or other
  account identifier into a tracked file.

## Deploys

Deploys are user-run. The one CDK app (`infrastructure/bin/site.ts`) has two stacks in us-east-1,
`PortfolioAssistantStack` and `PortfolioSiteStack` (ADR-007, ADR-009). They deploy together with
`pnpm build:site` and then `SITE_HOSTED_ZONE_ID=… AWS_PROFILE=<deploy profile> pnpm run deploy:site`
from the user's terminal (the script passes `-c siteHostedZoneId`). Claude never runs `cdk`, `aws`,
`pnpm deploy:site`, `pnpm bootstrap:site`, `pnpm diff:site`, `pnpm destroy:site`, or `pnpm synth`.
Tests synthesize in-process. The Anthropic key secret is created by the user; the stack only names it.

## Model providers

Local model mode uses the Anthropic API by default (ADR-008) through `ask_api.model_providers`
(one module per provider, a shared request and event type, a registry keyed by
`LOCAL_MODEL_PROVIDER`). `pnpm dev:api:model` reads the key from a macOS Keychain item named by
`ANTHROPIC_KEYCHAIN_ITEM` or `private/anthropic-keychain-item`, for that one process.
`pnpm dev:api:model:bedrock` keeps the Nova path and needs `LOCAL_AWS_PROFILE` from the caller.
Tests inject fake clients only. The `anthropic` SDK is a dev dependency and is not in the Lambda
asset.

## Toolchain

- Node 24 is keg-only on the author's machine. Before any pnpm command:
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` (pnpm 12.7.0).
- Python 3.13 via uv in services/ask-api.
- TypeScript ~6.0.3 and ESLint 9.39.5 are pinned on purpose.
- `.claude/settings.json` allows the no-network checks and denies AWS, CDK, model-mode,
  publish, and git write commands. Those rules match command text; they are not a sandbox.
  Personal additions go in the untracked `.claude/settings.local.json`.

## Checks (no network)

pnpm format:check · pnpm lint · pnpm typecheck · pnpm test (builds retrieval, then runs pytest)
pnpm test:browser — Playwright + axe; builds a development-profile preview on 127.0.0.1:4329
and the production site on 127.0.0.1:4331, so both ports must be free. 4321 is left for `pnpm dev:web`.
pnpm build:site — the production web build (no assistant, no fixture) into apps/web/dist.
pnpm check:public — scans every file that would be committed for account IDs, home paths,
internal hosts, private keys, key-shaped strings, and the phrases in the untracked
private/public-blocklist.txt.

## Layout

apps/web (Astro + React assistant island) · services/ask-api (Python Lambda, dev_server.py,
local\_\* model-mode modules, production_app) · infrastructure (CDK: assistant and site stacks) · content/public
(reviewed Markdown) · scripts (validate, index, build-retrieval, stage-lambda, check-public) ·
schemas · tests/evaluation
