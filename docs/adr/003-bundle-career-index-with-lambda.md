# ADR-003: Bundle the career index with the Lambda

**Status:** Accepted  
**Date:** September 28, 2026

## Context

The public career corpus is small, version-controlled, and changes only through a reviewed repository deployment. The website and `POST /ask` both need the same generated facts. A runtime fetch from S3 would add a network call, a cache, and an IAM permission for an index that already ships with the code.

## Decision

Generate one `generated/career-index.json` artifact and copy that file byte-for-byte into the Astro site and the Python package. The Lambda loads the packaged copy with `importlib.resources`. It does not read S3, a database, or the network at request time.

Content and code deploy together. A later implementation can move the index to S3 behind the same loader interface if content must update independently of the Lambda.

## Why

One generator keeps the website and the API on the same facts. Bundling fits V1: the corpus is manually reviewed and small, and an answer does not need extra permissions or a runtime dependency. The loader interface stays the place where a future S3 read would plug in.

## Consequences

A content change requires a new deployment. The Lambda does not see an index update until that deployment. The generated copies stay gitignored. The packaged file is the only index the API will load.
