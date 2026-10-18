# Deployment readiness

This checklist is what must be settled before any AWS deployment. It does not authorize deployment or bootstrap. The current synthesized system is [system design](system-design.md); the production assistant's runbook is in [production assistant](design/production-assistant.md#runbook).

No account ID, credential, email address, hosted zone id, secret value, or deployed resource ID belongs in this repository.

## One app, two stacks

`infrastructure/bin/site.ts` is the only CDK app. It holds `PortfolioAssistantStack` (the ask function) and `PortfolioSiteStack` (the site, CloudFront, WAF, and the `/api/*` behavior), both in `us-east-1`. `pnpm run deploy:site` deploys both, assistant first.

- Identity: the owner deploys with a named deploy profile that requires MFA, from their own terminal. Claude does not run CDK or AWS commands.
- Region: `us-east-1`. CDK is already bootstrapped there for the site.
- Hosted zone: passed at deploy time through `SITE_HOSTED_ZONE_ID`, never written to the repository. `cdk.context.json` is ignored.
- Secret: the owner creates the Anthropic key secret by hand in `us-east-1` before deploying ([runbook](design/production-assistant.md#runbook)). The stack references it by name (default `career-portfolio/anthropic-api-key`, or `-c anthropicSecretName=…`) and never creates or reads it at synth or deploy time.
- Build: run `pnpm build:site` immediately before deploying. The app refuses a missing or development build, and (until Round 3) any page with a script.
- Prepared assets: `pnpm prepare:api` and `pnpm prepare:web-adapter` run inside the deploy scripts. The adapter fetch fails closed on any checksum mismatch.

## Before the first deploy with the assistant stack

- Anthropic: a dedicated workspace with a $10 monthly spend limit and a key in that workspace.
- AWS Budget: $15 a month with email alerts, created by hand (not in the stack).
- Run `pnpm run diff:site` and review: the new function, URL, layer, log group, and role; the `/api/*` behavior, the Lambda OAC and two permissions, the origin request policy, and the WAF web ACL on the distribution.
- Know the kill switch and its fallback before going live ([runbook](design/production-assistant.md#runbook)).

## After deploy, verify

- Site: both hostnames load over HTTPS, `www` redirects to the apex, an unknown path returns the 404 page with status 404, and the response headers include HSTS, the CSP, and `X-Frame-Options: DENY`.
- API: the function URL called directly is refused; `POST /api/ask` through the site streams; the 21st request in 10 minutes from one IP gets the JSON 429. The assistant UI stays off until Round 3.

## Rollback

- Code or configuration: redeploy an earlier commit with `pnpm run deploy:site`.
- Assistant only: the kill switch (reserved concurrency 0) stops it without a deploy.
- Teardown: `pnpm run destroy:site` removes both stacks; the site bucket empties itself, and the log group is deleted.

## Identities

- The deploy identity is the owner's MFA profile. [ADR-002](adr/002-github-actions-and-cdk.md) expects a later GitHub OIDC role; it does not exist.
- Do not place long-lived AWS keys in GitHub. CI only verifies and synthesizes.

## Approval

Deployment and bootstrap each require an explicit owner approval at the time they are requested. Completing this checklist does not grant that approval.
