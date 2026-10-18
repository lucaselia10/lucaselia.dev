import data from "./ask-suggestions.json";

/**
 * Suggested questions for the assistant. These are prompts, not career claims.
 *
 * Every question a visitor can click must produce a real answer in the mode that is
 * running. In the default deterministic mode only "index" questions are offered, and
 * services/ask-api/tests/test_suggestions.py runs each one through the exact-answer
 * handler. The second-person "model" sets are offered only when model streaming is on.
 */

type IndexSuggestion = { question: string; mentions: string };
type SuggestionSet = { index: IndexSuggestion[]; model: string[] };

const HOME: SuggestionSet = data.home;
const PAGES: Readonly<Record<string, SuggestionSet>> = data.pages;
const FALLBACK: SuggestionSet = data.fallback;

function pick(set: SuggestionSet, modelStreaming: boolean): readonly string[] {
  return modelStreaming ? set.model : set.index.map((entry) => entry.question);
}

export function homeSuggestions(modelStreaming: boolean): readonly string[] {
  return pick(HOME, modelStreaming);
}

export function pageSuggestions(
  documentId: string,
  type: string,
  modelStreaming: boolean,
): readonly string[] {
  const set = PAGES[documentId] ?? (type === "profile" ? HOME : FALLBACK);
  return pick(set, modelStreaming);
}

/** The Assistant's default when a page passes no list: the deterministic home set. */
export const DEFAULT_SUGGESTIONS = homeSuggestions(false);
