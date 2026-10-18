# ADR-002: Use GitHub Actions for CI/CD and CDK for AWS resources

**Status:** Accepted  
**Date:** September 27, 2026

## Context

The source will be hosted in GitHub and the application is expected to run on AWS. The repository needs automated checks for TypeScript, Python, content, and infrastructure before any deployment exists.

## Decision

Use GitHub Actions as the CI orchestrator. Pull requests and pushes run formatting, linting, type checking, tests, content validation, the Astro production build, and CDK synthesis.

AWS CDK and CloudFormation remain the source of truth for AWS resources. A later deployment workflow may assume a narrowly scoped IAM role through GitHub OIDC. That workflow is not part of the scaffold.

## Why

One workflow can verify the TypeScript, Python, content, and CDK portions of the monorepo. CI stays separate from deployment so an unreviewed scaffold cannot create AWS resources.

## Consequences

GitHub becomes part of the delivery control plane once deployment is added. Deployment roles must use least privilege. The initial workflow has read-only repository permissions and no deploy step.
