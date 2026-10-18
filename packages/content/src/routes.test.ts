import { describe, expect, it } from "vitest";
import { citationSlug, citationUrl, documentPath, slugify } from "./index.js";

describe("public document routes", () => {
  it.each([
    ["project", "fictional-lumen-harbor", "/work/fictional-lumen-harbor"],
    ["experience", "fictional-role", "/experience/fictional-role"],
    ["background", "fictional-path", "/background/fictional-path"],
    ["profile", "fictional-profile", "/profile/fictional-profile"],
  ] as const)("maps %s documents to %s", (type, id, path) => {
    expect(documentPath(type, id)).toBe(path);
  });

  it("builds a stable heading anchor", () => {
    expect(slugify("Outcome")).toBe("outcome");
    expect(slugify("My Contribution")).toBe("my-contribution");
    expect(slugify("  Outcome  ")).toBe("outcome");
    expect(citationUrl("project", "fictional-lumen-harbor", "Outcome")).toBe(
      "/work/fictional-lumen-harbor#outcome",
    );
  });

  it("rejects a document type that has no route", () => {
    expect(() => documentPath("skill", "fictional-lumen-harbor")).toThrow(/cannot be resolved/);
  });

  it("rejects a heading that cannot become an anchor", () => {
    expect(() => slugify("???")).toThrow(/cannot be resolved/);
  });

  it("rejects a repeated heading anchor", () => {
    const used = new Set(["outcome"]);

    expect(() => citationSlug("Outcome", used)).toThrow(/cannot be resolved/);
  });
});
