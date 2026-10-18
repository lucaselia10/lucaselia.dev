import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The test script stages the asset first (pnpm -w prepare:api).
const assetDirectory = join(import.meta.dirname, "..", "asset", "ask-api");

describe("ask Lambda asset dependencies", () => {
  it("ships the production app, the Anthropic SDK, and the evidence package", () => {
    for (const path of [
      "production_app.py",
      "stream_http.py",
      "secret_key.py",
      join("model_providers", "anthropic_api.py"),
      join("anthropic", "__init__.py"),
      join("httpx2", "__init__.py"),
      join("data", "evidence-manifest.json"),
    ]) {
      expect(existsSync(join(assetDirectory, path)), path).toBe(true);
    }
    expect(readdirSync(join(assetDirectory, "data", "evidence")).length).toBeGreaterThan(0);
  });

  it("leaves development tools out", () => {
    const entries = readdirSync(assetDirectory);

    expect(
      entries.filter((name) =>
        /^(_?pytest|pyright|ruff|boto3_stubs|botocore_stubs|mypy|nodeenv)([-_.]|$)/i.test(name),
      ),
    ).toEqual([]);
  });
});
