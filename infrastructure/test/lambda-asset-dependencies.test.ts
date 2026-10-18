import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The test script stages the asset first (pnpm -w prepare:api).
const assetDirectory = join(import.meta.dirname, "..", "asset", "ask-api");

describe("ask Lambda asset dependencies", () => {
  it("ships the provider modules but not the Anthropic SDK, a development-only dependency", () => {
    const entries = readdirSync(assetDirectory);

    expect(existsSync(join(assetDirectory, "model_providers", "base.py"))).toBe(true);
    expect(entries.filter((name) => /^(anthropic|httpx2?)([-_.]|$)/i.test(name))).toEqual([]);
  });
});
