import { describe, expect, it } from "vitest";
import data from "./ask-suggestions.json";
import { DEFAULT_SUGGESTIONS, homeSuggestions, pageSuggestions } from "./ask-suggestions";

describe("suggested questions", () => {
  it("offers only handler-checked questions in the default deterministic mode", () => {
    const indexQuestions = new Set(
      [data.home, data.fallback, ...Object.values(data.pages)].flatMap((set) =>
        set.index.map((entry) => entry.question),
      ),
    );

    expect(homeSuggestions(false)).toEqual([
      "What have you built at AWS?",
      "Where have you worked?",
      "What is your education?",
      "How did you move into software engineering?",
    ]);
    expect(DEFAULT_SUGGESTIONS).toEqual(homeSuggestions(false));
    for (const id of Object.keys(data.pages)) {
      for (const question of pageSuggestions(id, "experience", false)) {
        expect(indexQuestions.has(question)).toBe(true);
      }
    }
    expect(homeSuggestions(false)).not.toContain("How have you improved production reliability?");
  });

  it("offers the full second-person sets in model mode", () => {
    expect(homeSuggestions(true)).toEqual([
      "What have you built at AWS?",
      "How have you improved production reliability?",
      "What distributed-systems work have you done?",
      "How did you move into software engineering?",
    ]);
    expect(pageSuggestions("aws-sde-ii", "experience", true)).toEqual([
      "What does the capacity-planning platform do?",
      "How did you improve reliability here?",
      "What technologies do you use here?",
    ]);
  });

  it("falls back by page type", () => {
    expect(pageSuggestions("lucas-elia", "profile", false)).toEqual(homeSuggestions(false));
    expect(pageSuggestions("unknown-role", "experience", false)).toEqual([
      "Where have you worked?",
    ]);
    expect(pageSuggestions("unknown-role", "experience", true)).toEqual([
      "What did you do in this role?",
    ]);
  });
});
