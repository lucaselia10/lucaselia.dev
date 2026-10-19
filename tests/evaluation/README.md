# Retrieval and answer evaluation

`cases.json` is the tracked set of initial route expectations. `cases.schema.json` validates it.

The production assistant (ADR-009) uses the same prompt and evidence as local model mode, so the live questions below are also the production evaluation (Slice 2, Round 5). The Knowledge Base path and its grounding prompt were removed; `grounded` in a case now means a model-written answer from the evidence package.

Each case records a stable id, a question, the expected route (`exact`, `grounded`, or `unsupported`), expected document and chunk ids when a future retriever should find them, forbidden document ids, and a short reason. These are evaluation expectations. They are not production prompt examples, and they do not assert model wording.

The fictional Lumen Harbor fixture is forbidden in every case. The cases still expect exact facts on the deterministic path. [ADR-006](../../docs/adr/006-model-conversation-and-streaming.md) accepts model composition of ordinary answers, including simple facts. Grounded cases wait for a real retriever, and no semantic-quality score is calculated yet.

## Live local evaluation

The Slice 1 gate is a live run of local model mode, which uses the Anthropic API by default ([ADR-008](../../docs/adr/008-anthropic-api-for-model-answers.md)). The user runs it; it makes paid calls. Record outcomes without saving question text. The seven questions still apply to the trimmed public content (October 13, 2026):

1. Current role: answered, cited to `aws-sde-ii`.
2. Production reliability: answered from the remaining SDE II bullet, cited.
3. A follow-up on tools ("What tools did you use for that?" after the reliability answer): uses the previous turn as context, says the pages don't tie specific tools to the reliability work, names the role's technologies, and cites SDE II. Case `follow-up-tools-partial-support`.
4. Degree: a plain "no" in one short clause, then the education that is supported, cited to the education documents.
5. AWS start date: the apprenticeship start month, cited.
6. An unsupported question: "I don't have anything on that in Lucas's career pages. You can ask about his roles at AWS, what he's worked on, or his education." with no citations.
7. Lumen Harbor: the same fixed sentence; never presented as Lucas's work and never cited.

For each, note whether text streamed progressively, whether the `SOURCES:` line stayed hidden, the citations, the token counts, and the estimated cost from the development server's stderr line. Check desktop and mobile.

Cases may carry `history` (earlier user and assistant turns) for follow-up questions. History is conversation context, never evidence.

## Live run results

### October 14, 2026: Anthropic, Claude Haiku 4.5, prompt `local-1`

Run by the user. Eight questions, recorded as actually asked; they differ slightly from the scripted seven above (question 2 was added, and the off-topic question was about favorite food). All but the first ran in one conversation. Costs are the development server's estimates at $1 and $5 per million input and output tokens, not a bill.

| #   | Question as asked                             | Input tokens | Output tokens | Estimated cost (USD) | Outcome                                                           |
| --- | --------------------------------------------- | ------------ | ------------- | -------------------- | ----------------------------------------------------------------- |
| 1   | What is Lucas current role?                   | 2,480        | 95            | 0.002955             | Answered, cited SDE II. Separate session.                         |
| 2   | What have you built at AWS?                   | 2,481        | 304           | 0.004001             | Answered, cited Apprentice, SDE I, and SDE II.                    |
| 3   | How have you improved production reliability? | 2,748        | 72            | 0.003108             | Answered, cited SDE II.                                           |
| 4   | What tools did you use for that?              | 2,815        | 19            | 0.002910             | Refused. Prompt `local-1` was all-or-nothing; fixed in `local-2`. |
| 5   | Did you earn a degree?                        | 2,838        | 91            | 0.003293             | Answered, cited Sierra College and BloomTech.                     |
| 6   | When did you start at AWS?                    | 2,912        | 39            | 0.003107             | Answered, cited Apprentice.                                       |
| 7   | What's your favorite food?                    | 2,943        | 19            | 0.003038             | Refused correctly.                                                |
| 8   | Tell me about the Lumen Harbor project.       | 2,970        | 19            | 0.003065             | Refused correctly; never cited.                                   |
|     | Total                                         | 22,187       | 658           | 0.025477             |                                                                   |

Input grows from about 2,480 to 2,970 tokens across the conversation because history accumulates; the evidence package is the same on every request.

Fixes after this run (prompt `local-2`, grounding prompt `2`): answer the supported part of a question and state the gap; a short plain "no" for yes-or-no questions; the new fixed refusal sentence; citation chips with a visible separator. Re-run the follow-up on tools, the degree question, and an off-topic question to confirm.

### October 14, 2026: recheck, prompt `local-2`

Run by the user after the partial-support and refusal fixes. Passed: the tools follow-up now gives a partial answer instead of refusing, and refusals use the new wording. Four wording problems remained. Prompt `local-3` and grounding prompt `3` add shared wording rules (`services/ask-api/src/ask_api/answer_style.py`); the "after" column is the target, not yet observed live.

| Problem                    | Observed (`local-2`)                                            | Target (`local-3`)                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Names the evidence or data | "The evidence does not specify which tools..."                  | Refers to Lucas's career pages, or states the facts directly.                                                                                                          |
| Partial answer shape       | Led with the gap and restated the earlier answer.               | "His SDE II role lists ECS, AWS Batch, Step Functions, and CloudWatch among its technologies, though his pages don't say which ones he used for the reliability work." |
| Repeated negative          | "with no degree awarded" appeared twice in one answer.          | Each negative stated once: a short "no", then what is supported.                                                                                                       |
| Added interpretation       | The SDE I test suites "contributed to reliability foundations". | Only what the pages state; no characterizations of what the work contributed to.                                                                                       |

Re-run the tools follow-up, the degree question, and "What have you built at AWS?" to confirm.

## Production evaluation (Round 5)

Run by the owner on `https://lucaselia.dev`, on a desktop browser and a phone. The production assistant uses the same prompt (`local-3`) and evidence as local model mode, so the questions are the local ones. Ask questions 1 to 6 in one conversation, in order, so the follow-up has its context; ask 7 and 8 after a reload. Run item 11 last: it blocks your IP from the assistant for a few minutes.

Every answer, on every item, must also:

- Stream: text appears in steps, not all at once.
- Show no `SOURCES:` line, token count, or cost.
- Use citation chips that open the cited page section.
- Avoid the four `local-2` wording problems above: no "the evidence" or "the data", a partial answer leads with what is supported, each negative is stated once, and nothing is characterized beyond what the pages say.

### Checklist

| #   | Ask or do                                                                          | A pass looks like                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | What is Lucas's current role?                                                      | Software Development Engineer II at AWS, cited to SDE II.                                                                                                                                                                                        |
| 2   | What have you built at AWS?                                                        | Answered from the Apprentice, SDE I, and SDE II pages, cited to those roles, with no interpretation of what the work "contributed to".                                                                                                           |
| 3   | How have you improved production reliability?                                      | Answered from the SDE II page, cited to SDE II.                                                                                                                                                                                                  |
| 4   | What tools did you use for that?                                                   | A partial answer that uses the previous turn: it leads with the SDE II technologies, then says in one short clause that the pages don't tie specific tools to the reliability work. Cited to SDE II. Not a refusal.                              |
| 5   | Did you earn a degree?                                                             | "No" in one short clause, then the education that is supported, cited to the education pages. The negative appears once.                                                                                                                         |
| 6   | When did you start at AWS?                                                         | The apprenticeship start month, cited to the Apprentice page.                                                                                                                                                                                    |
| 7   | What's your favorite food?                                                         | Exactly "I don't have anything on that in Lucas's career pages. You can ask about his roles at AWS, what he's worked on, or his education." No citations.                                                                                        |
| 8   | Tell me about the Lumen Harbor project.                                            | The same fixed sentence. No citations. Lumen Harbor is never described as Lucas's work.                                                                                                                                                          |
| 9   | Paste a 501-character question into the field.                                     | The field stops at 500 characters and the counter reads "500 / 500 characters". Nothing extra is sent. (The server's own 400 for longer questions is covered by tests; the page cannot send one.)                                                |
| 10  | Page checks: open the browser console and reload `/` and `/experience/aws-sde-ii`. | No Content-Security-Policy errors. The panel shows "Questions and answers aren't saved." under its intro. The role page has its "Ask about this role" box.                                                                                       |
| 11  | Rate limit: from a terminal, run the loop below, then ask a question on the site.  | The loop's codes change from `400` to `429` after about 20 requests, and the site shows "Too many questions in a short time. Please wait a few minutes." with a Try again button. After about 10 minutes without requests, questions work again. |

Item 11 loop, which makes no model calls (the function answers `GET /api/ask` with `400` at once, and WAF counts every request under `/api/`):

```bash
for i in $(seq 1 30); do curl -s -o /dev/null -w "%{http_code} " https://lucaselia.dev/api/ask; sleep 1; done; echo
```

Is item 11 worth running? Yes, this way. It is the only end-to-end proof that the WAF rule and its JSON 429 reach visitors, and the loop above costs no model tokens. Asking 20 real questions would also work, at about $0.06, but uses your conversation and quota for nothing extra. Two caveats: WAF applies rate limits near the configured number rather than exactly, and starts blocking within a short delay, so the switch to `429` may come a few requests after the 20th; and your IP stays blocked from `/api/` (not from the site pages) until its rate falls below the limit for the 10-minute window.

### Results

Fill in one row per item, for desktop and phone. Do not paste answer text; describe the outcome.

| #   | Desktop: pass or fail | Phone: pass or fail | Streamed | Citations (pages) | Notes |
| --- | --------------------- | ------------------- | -------- | ----------------- | ----- |
| 1   |                       |                     |          |                   |       |
| 2   |                       |                     |          |                   |       |
| 3   |                       |                     |          |                   |       |
| 4   |                       |                     |          |                   |       |
| 5   |                       |                     |          |                   |       |
| 6   |                       |                     |          |                   |       |
| 7   |                       |                     |          | none expected     |       |
| 8   |                       |                     |          | none expected     |       |
| 9   |                       |                     | n/a      | n/a               |       |
| 10  |                       |                     | n/a      | n/a               |       |
| 11  |                       |                     | n/a      | n/a               |       |

Date run: \_\_\_\_. Model: Claude Haiku 4.5. Anthropic Console usage for the run (input tokens, output tokens, cost): \_\_\_\_.
