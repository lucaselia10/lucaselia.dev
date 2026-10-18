import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./paths.js";
import { findInternalHosts } from "./public-safety.js";

const casesPath = join(repoRoot, "tests", "evaluation", "cases.json");
const schemaPath = join(repoRoot, "tests", "evaluation", "cases.schema.json");

describe("evaluation cases", () => {
  it("matches the evaluation schema and forbids the fictional fixture", () => {
    const cases = JSON.parse(readFileSync(casesPath, "utf8")) as {
      schemaVersion: number;
      cases: Array<{
        id: string;
        route: string;
        forbiddenDocumentIds: string[];
        question: string;
        history?: Array<{ role: string; content: string }>;
      }>;
    };
    const validator = compile();

    expect(validator(cases)).toBe(true);
    expect(cases.schemaVersion).toBe(1);
    expect(new Set(cases.cases.map((item) => item.id)).size).toBe(cases.cases.length);
    expect(cases.cases.map((item) => item.id)).toEqual(
      [...cases.cases.map((item) => item.id)].sort(),
    );
    for (const item of cases.cases) {
      expect(item.forbiddenDocumentIds).toContain("fictional-lumen-harbor");
      expect(findInternalHosts(item.question)).toEqual([]);
    }
    expect(cases.cases.some((item) => item.route === "exact")).toBe(true);
    expect(cases.cases.some((item) => item.route === "grounded")).toBe(true);
    expect(cases.cases.some((item) => item.route === "unsupported")).toBe(true);
    const followUp = cases.cases.find((item) => item.id === "follow-up-tools-partial-support");
    expect(followUp?.route).toBe("grounded");
    expect(followUp?.history?.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });
});

function compile(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  return ajv.compile(schema as object);
}
