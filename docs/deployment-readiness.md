# Deployment readiness

This checklist is what must be settled before any AWS deployment. It does not authorize deployment, bootstrap, retrieval publication, or ingestion. The current synthesized system is [system design](system-design.md). Hosting, identity, and cost are [roadmap](roadmap.md) Phases 5 through 7. The first deployed ask path also depends on Slice 2, the production streaming investigation. Accepting the roadmap does not close any item below.

Roadmap Slice 1 can call the configured Nova model from the local Python server when `LOCAL_MODEL_CONVERSATION=true`. That call can incur model charges and needs server-side credentials and model access. It is an evaluation of direct approved public evidence. It is not deployment, and it does not provision the Knowledge Base, the vector index, or a public endpoint. The implementation and its tests use injected clients. A live Nova evaluation has not been run. A paid call is a separate, explicit evaluation.

No account ID, bucket name, credential, email address, domain, or deployed resource ID belongs in this repository.

## Static site (v1)

This section covers `PortfolioSiteStack` only ([ADR-007](adr/007-static-site-hosting.md)). It does not approve the ask API deployment, which still needs every section below.

- Identity: the user deploys with a named deploy profile that requires MFA, from their own terminal. Claude does not run CDK or AWS commands.
- Region: `us-east-1`, required for the CloudFront certificate. Bootstrap CDK once in that region.
- Hosted zone: the Route 53 zone for `lucaselia.dev` exists. Its id is passed at deploy time through `SITE_HOSTED_ZONE_ID` and is not written to the repository. `cdk.context.json` is ignored.
- Build: run `pnpm build:site` immediately before deploying. The site app refuses a missing build, a development build, a build with the fixture or `career-index.json`, or any page with a script.
- Command: `SITE_HOSTED_ZONE_ID=… AWS_PROFILE=<deploy profile> pnpm run deploy:site`. The script passes `-c siteHostedZoneId` to CDK, refuses to run without it, and can only synthesize `PortfolioSiteStack`.
- After deploy, verify: both hostnames load over HTTPS, `www` redirects to the apex, `/experience/aws-sde-ii` and `/experience/aws-sde-ii/` load, an unknown path returns the 404 page with status 404, and the response headers include HSTS, the CSP, and `X-Frame-Options: DENY`.
- Rollback: rebuild and redeploy an earlier commit. Teardown: `pnpm run destroy:site` with the same variables. The bucket empties itself on deletion.
- Cost: CloudFront PriceClass_100, one small bucket, and Route 53 queries. No access logs in v1.

## Account and region

- Confirm which AWS account will own the stack. The CDK app leaves the account as a CloudFormation token so synthesis needs no credentials.
- Confirm the region. The application is written for `us-west-2`. Synthesis fails for an explicit other region.
- Confirm that Bedrock Knowledge Bases, Titan Text Embeddings V2, Nova 2 Lite through the US inference profile, and S3 Vectors are available for that account and region before bootstrap.

## Local credentials

- Use a named AWS profile or the normal credential chain for the human who will run the first commands.
- Do not pass access keys, secret keys, or session tokens as command arguments.
- Do not commit credentials, `.env` files, or account identifiers.
- Keep that profile separate from any future CI role.

## CDK bootstrap

- Bootstrap is a deliberate step, done only after this checklist is approved.
- Bootstrap has not been run.
- Review the bootstrap resources CDK will create in the chosen account and `us-west-2` before running it.
- `pnpm synth` stays the local check. Synthesis does not bootstrap.

## Resources and cost

- Review the synthesized resources: HTTP API, Lambda, log groups, private source bucket, vector bucket, vector index, Knowledge Base, data source, and the Lambda and Knowledge Base roles.
- Estimate monthly cost at expected portfolio traffic, including HTTP API, Lambda, logs, S3, embeddings, ingestion, and Nova.
- Record that estimate outside this repository or in a later decision. This document does not invent a number.
- Confirm log retention. The synthesized groups keep 30 days and use removal policy `DESTROY`. Production retention is unresolved.

## Model availability

- Verify the configured Nova profile `us.amazon.nova-2-lite-v1:0`, or a later profile that matches `us.amazon.nova-2-lite-v<number>:<number>`, can be invoked from `us-west-2`.
- Verify Titan Text Embeddings V2 at 512 dimensions for the Knowledge Base.
- Change the profile only through CDK context `novaInferenceProfileId` and the Lambda `NOVA_MODEL_ID` setting. Do not hard-code a different model in the handler.

## Hosting and CORS

- Decide the production static host and whether a custom domain is in the first launch. That decision needs its own ADR. It is Phase 5.
- Choose the production site origin. The default CORS origins are the local Astro preview origins only.
- Pass that origin with CDK context `askAllowedOrigins` before a deployment synthesis. A wildcard origin is rejected.
- Build the site with `PUBLIC_ASK_API_URL` set to the deployed `POST /ask` URL only after that output exists. The URL is not stored in the web app today.

## Identities

- Deployment identity: the person or pipeline allowed to bootstrap and deploy CDK. [ADR-002](adr/002-github-actions-and-cdk.md) expects a later GitHub OIDC role. That role does not exist. The first deployment procedure may be local and must still be least privilege.
- Publisher identity: a different role for `pnpm publish:retrieval`. It is specified in [ADR-005](adr/005-grounded-career-answering.md). It is not the Lambda role and not the Knowledge Base role.
- Do not place long-lived AWS keys in GitHub.

## Budget notification

- Choose a notification destination for an AWS Budget or equivalent alarm before public exposure.
- Store that destination in the account or in a later secret mechanism. Do not write an email address into the repository.

## Rollback

- Define how to roll back a stack update and how to roll back a bad retrieval publication.
- Stack rollback is a CloudFormation decision made before the first deploy.
- Publication rollback uses the publisher’s managed-object state. It does not delete unmanaged `retrieval/` objects.
- Decide whether log groups and the retained source bucket, vector bucket, and vector index should survive stack deletion. Those data resources are `RETAIN` in the template. Log groups are `DESTROY`.

## Stack outputs

- Capture the HTTP API URL, function name, Knowledge Base id, data source id, source bucket name, vector index ARN, and Nova profile id from stack outputs.
- Keep those values out of Git, out of the website source, and out of documentation.
- Feed the bucket, Knowledge Base id, and data source id into the publisher as command arguments. Feed the ask URL into the site build as `PUBLIC_ASK_API_URL`.

## First publication

- Run `pnpm publish:retrieval` without `--apply` and review uploads, unchanged objects, managed deletes, and unmanaged keys.
- Apply only after that plan is reviewed.
- Stop if unmanaged objects are reported.
- Confirm the ingestion job reaches `COMPLETE` and that publisher state is stored at `_career-portfolio/retrieval-publish-state.json`.

## Streaming transport

The synthesized ask path is an API Gateway HTTP API with a Lambda proxy integration. It returns one JSON document. [ADR-006](adr/006-model-conversation-and-streaming.md) accepts real streaming and does not choose how the browser receives it.

Before Slice 2 changes infrastructure:

- Read current official AWS documentation for the HTTP API and Lambda integration. Do not treat a streaming Bedrock API as proof that the browser response streams.
- Record the selected transport, integration, timeouts, and infrastructure changes in a new ADR.
- Define stream events, completion, citations, errors, cancellation, and client recovery.
- State that partial text has not passed the final `submit_grounded_answer` validation.
- Re-check IAM, CORS, throttling, reserved concurrency, log redaction, and usage controls for that path.
- Keep questions, answers, prompts, and request bodies out of logs.

This section does not select a transport and does not approve a deploy.

## Smoke tests

These checks describe the current complete-JSON contract until Slice 2 replaces the ask path:

- Index questions return HTTP 200 from the packaged career index.
- An open-ended question returns a grounded answer with allowlisted citations, or the supported insufficient-evidence sentence when the corpus has no passage.
- A forced grounding failure returns the sanitized HTTP 503 and a request ID.
- Lumen Harbor is not cited.
- Job comparison still returns the not-implemented sentence.
- The static site remains usable when the API is not configured.

After Slice 2, deployed verification also includes progressive delivery, a contextual follow-up, model-composed answers, and desktop and mobile use. Simple factual questions are not required to bypass the model. Deterministic validation remains where the implementation keeps it.

## Approval

Deployment, bootstrap, upload, and ingestion each require an explicit user approval at the time they are requested. Completing this checklist does not grant that approval. CI remains verification only until a later workflow is added.
