# ADR-001: Use Astro with a React assistant island

**Status:** Accepted  
**Date:** September 27, 2026

## Context

The application is a public personal portfolio with an assistant grounded in approved career content. Most user-facing material is static Markdown. The assistant is the primary stateful feature.

The frontend needs durable content routes, citation URLs, typed front matter, static hosting, and a React implementation for the assistant. The authoritative write-up at the time was the preliminary design, a private discovery document; [design history](../design-history.md) summarizes it.

## Decision

Use Astro and TypeScript to generate the public portfolio as static HTML. Implement the interactive assistant as a React client island. Do not run an Astro or Node server in production.

## Why

The product is content-heavy, with one interactive feature. Astro can validate Markdown, generate citation routes, and ship static HTML. React stays at the boundary of the assistant.

## Consequences

The site can be hosted as static files. Shared client state across many page regions would be a weaker fit than a single React application. Reconsider this decision if the product later needs accounts, personalized dashboards, or request-time rendering for most pages.
