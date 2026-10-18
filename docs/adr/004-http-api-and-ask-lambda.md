# ADR-004: Expose POST /ask through an HTTP API and one Lambda

**Status:** Accepted  
**Date:** September 28, 2026

## Context

The ask handler already answers a small set of exact career questions from the bundled public index. The portfolio needs a public HTTP boundary for that handler. The stack is synthesized and reviewed before anything is deployed. V1 does not authenticate callers, call a model, or read a database.

## Decision

Use API Gateway HTTP API with one route, `POST /ask`, and a Lambda proxy integration. The Lambda is Python 3.13 on ARM64, with 256 MB of memory, a 10-second timeout, and reserved concurrency of 5. It packages the existing `ask_api` source and the synchronized career index. It does not use a VPC or data-service permissions.

[ADR-005](005-grounded-career-answering.md) later raises the Lambda timeout to 28 seconds and the HTTP API integration timeout to 29 seconds so retrieve-then-generate can finish. Memory and reserved concurrency stay the same.

The stage throttles at 5 requests per second with a burst of 10. CORS defaults to the local Astro preview origins, allows `POST` and `OPTIONS` with `Content-Type`, and does not allow credentials. The production origin is supplied later with the CDK context key `askAllowedOrigins`. There is no authentication in V1.

## Why

HTTP API provides the route, CORS, throttling, access logging, and a place to add authentication later. A Lambda Function URL would be smaller, but it is a weaker API-management boundary. REST API v1 adds features and cost this portfolio does not need yet.

The bundled index keeps the answer path free of S3 and other runtime reads, as [ADR-003](003-bundle-career-index-with-lambda.md) decided. CORS only controls browser behavior. It does not secure a public endpoint. Throttling and reserved concurrency limit accidental or abusive load. They are not complete abuse protection. Authentication, WAF-style controls, alarms, and model-cost controls can be added when the use case requires them.

## Consequences

`cdk synth` now creates application resources in the template. It still does not deploy them. A content change still requires a new deployment because the index is inside the Lambda asset. The default CORS origins are local only, so a production site must pass its origin before deployment. The public endpoint can be called by anyone who knows the URL until authentication is added.
