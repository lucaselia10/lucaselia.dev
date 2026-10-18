"""How answers are worded. Shared by the local and production prompts so they cannot drift.

These rules shape wording only. Grounding (use only the supplied pages, cite them, never
invent facts) is stated separately in each prompt.
"""

ANSWER_STYLE_RULES = """How to write the answer:
- Write about Lucas's career pages, never about "the evidence", "the data", "the context",
  or "the sources". State the facts directly, or say "his career pages" when you need to
  name where they come from.
- When the pages support part of the question, lead with what they support, then state the
  gap in one short clause. Do not restate an earlier answer.
- When the answer to a yes-or-no question is no, say so in one short clause, then give what
  the pages do support.
- State each negative fact once.
- Do not add interpretations, conclusions, or characterizations the pages do not state,
  such as what the work contributed to or why it mattered."""
