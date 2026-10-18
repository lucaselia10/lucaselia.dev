# Public content

The career text in this directory is © Lucas Elia, all rights reserved. It is not covered by the repository's MIT License; see [LICENSE](../LICENSE).

Lumen Harbor (`public/fictional-lumen-harbor.md`) is a fictional test fixture, not real work.

`content/public/` is the only copy of portfolio Markdown. Astro loads it from here; do not copy it into an Astro content directory. A document here may be `public` or `draft`. Only `public` documents are rendered and indexed. Drafts stay in the repository for validation and review.

Every document also requires `assistant_retrievable`. `true` means a public H2 section may ground an answer. `false` keeps the page public and indexed, but leaves it out of retrieval artifacts and the evidence package. Drafts are never retrieval sources, even when the flag is `true`. The Lumen Harbor fixture is public and `assistant_retrievable: false`, so it can never ground an answer about Lucas. Do not infer that status from the filename or the `fictional-` id.

Approved public documents live here after manual review. The reviewed set is Lucas Elia’s public profile (including the approved contact links), his employment history, and two education records. The wording comes from the author-reviewed public LinkedIn profile. Expert Assist has `location: null` because that source does not specify a location. Private notes stay outside this repository. Add further real career material only after the same review.

## Document contract

Front matter is validated by `schemas/public-document.schema.json`, and `type` selects the allowed fields. Front matter holds the exact facts used for indexing. Markdown H2 sections hold the narrative used for citations.

- Shared required fields: `id` (lowercase kebab-case), `type`, `title`, `summary`, `skills`, `topics`, `featured`, `visibility` (`public` or `draft`), `assistant_retrievable`, and `last_reviewed` (`YYYY-MM-DD`).
- `profile` also requires `headline`, `location`, and `current_role`, the id of an experience document. It may carry `email`, `linkedin_url`, and `github_url` for the Contact section; those stay out of the career index and the evidence package.
- `experience` also requires `employer`, `role_title`, `start_date`, `end_date` (`null` for a current role), `employment_type`, and `location` (a non-empty string, or `null` when the public source does not name one). Months use `YYYY-MM`, and the end cannot precede the start.
- `project` also requires `status` (`active`, `completed`, or `archived`) and `roles`, a list of experience ids that may be empty.
- `background` is an education record: `category: education`, `institution`, `program`, `start_date`, `end_date`, `education_status` (`completed` or `attended`), and `degree_awarded`. Completing a program is not the same as receiving a degree.

Citation URLs are `/profile/{id}#{slug}`, `/experience/{id}#{slug}`, `/background/{id}#{slug}`, or `/work/{id}#{slug}`, with the slug taken from the H2 heading.

Validation fails on a duplicated id, an unresolved reference, a public document that references a draft, a heading that cannot become an anchor, an internal URL or host name, a phone number, or a street address.
