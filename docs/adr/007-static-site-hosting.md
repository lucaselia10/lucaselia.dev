# ADR-007: Host the v1 portfolio as a static site on S3 and CloudFront

**Status:** Accepted. Implemented and synthesized; the user deploys it from their own terminal.  
**Date:** October 13, 2026

## Context

The portfolio is static Astro output ([ADR-001](001-astro-react-island.md)). The assistant depended on Bedrock, and Bedrock model capacity was unavailable for this account at the time, so model answers could not launch yet. The production streaming transport is also undecided ([ADR-006](006-model-conversation-and-streaming.md), roadmap Slice 2). The reviewed career record does not depend on either, and it can be published now.

The domain is `lucaselia.dev`, registered with a Route 53 hosted zone in the user's account.

## Decision

Launch v1 as a static site at `https://lucaselia.dev`, without the assistant.

- **Build.** `pnpm build:site` builds with `PORTFOLIO_SITE=production` and no `PUBLIC_ASK_API_URL`. That build renders no assistant, no Ask navigation, and no Ask buttons, and omits test fixtures (Lumen Harbor) and `career-index.json`. Development builds keep both.
- **Stack.** A new `PortfolioSiteStack` in `us-east-1`, the region CloudFront requires for certificates. It holds a private S3 bucket (Block Public Access, SSL only, S3-managed encryption, destroyable because it holds only build output), a CloudFront distribution with Origin Access Control, an ACM certificate for the apex and `www` validated through DNS, and Route 53 A and AAAA aliases for both names.
- **Routing.** A CloudFront Function on viewer request redirects `www` to the apex with a 301 and maps extensionless paths and trailing slashes to `index.html`, matching Astro's `build.format: "directory"` and `trailingSlash: "never"`. Missing objects (403 or 404 from the origin) return `/404.html` with status 404.
- **Headers.** One response headers policy on every behavior: HSTS for two years with subdomains, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a minimal `Permissions-Policy`, and a Content-Security-Policy derived from the production HTML: no scripts, one same-origin stylesheet, same-origin fonts and favicon, style attributes allowed for chart geometry, and `frame-ancestors 'none'`.
- **Caching.** `/_astro/*` hashed assets are uploaded with `max-age=31536000, immutable` and kept across deploys. Pages and other files revalidate in the browser and are cached for five minutes at the edge. Each deploy uploads `apps/web/dist` with `BucketDeployment` and invalidates the distribution.
- **Isolation.** The site has its own CDK app entry, `infrastructure/bin/site.ts`, used through `pnpm run deploy:site`, which passes the hosted zone id from `SITE_HOSTED_ZONE_ID` as `-c siteHostedZoneId`. It imports only `PortfolioSiteStack`, so it cannot synthesize or deploy the ask API stack. The default app (`bin/app.ts`, the ask API) refuses to run when it receives the site's `siteHostedZoneId` context. The site app also refuses a missing or non-production build.
- **Inputs.** The domain is in code. The hosted zone id is passed at deploy time as `-c siteHostedZoneId=…`, read with `HostedZone.fromHostedZoneAttributes`, never looked up, and never stored. `cdk.context.json` is ignored by Git.
- **Out of scope for v1.** Access logging, WAF, and a CI deployment role.

## Why

S3 and CloudFront is the conventional, low-cost host for static output, and it was already the direction in the preliminary design. Origin Access Control keeps the bucket private. Putting the whole site in one `us-east-1` stack avoids cross-region certificate references. A separate app entry makes the ask stack unreachable from the site command, instead of relying on remembering to name the right stack.

Shipping without the assistant lets the reviewed record go live now, and avoids presenting a feature that cannot answer yet.

## Consequences

- The assistant follows once the Slice 1 evaluation passes and Slice 2 selects a production streaming transport. That will need a CSP change (`script-src` and `connect-src`) and an ADR for the ask path.
- Deploys are run by the user with a named deploy profile that requires MFA. Claude does not run CDK or AWS commands.
- The bucket is not versioned; rollback is a rebuild and redeploy of an earlier commit.
- CDK bootstrap in `us-east-1` is a one-time prerequisite and creates the CDK toolkit resources in that region.
