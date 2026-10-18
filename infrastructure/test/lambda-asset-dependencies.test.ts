import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The test script stages the asset first (pnpm -w prepare:api).
const assetDirectory = join(import.meta.dirname, "..", "asset", "ask-api");

describe("ask Lambda asset dependencies", () => {
  it("ships the production app, the Anthropic SDK, and the evidence package", () => {
    for (const path of [
      "ask_api/production_app.py",
      "ask_api/stream_http.py",
      "ask_api/secret_key.py",
      join("ask_api", "model_providers", "anthropic_api.py"),
      join("anthropic", "__init__.py"),
      join("httpx2", "__init__.py"),
      join("ask_api", "data", "evidence-manifest.json"),
      "run.sh",
    ]) {
      expect(existsSync(join(assetDirectory, path)), path).toBe(true);
    }
    expect(readdirSync(join(assetDirectory, "ask_api", "data", "evidence")).length).toBeGreaterThan(
      0,
    );
  });

  it("leaves boto3 to the runtime", () => {
    for (const provided of ["boto3", "botocore", "s3transfer"]) {
      expect(existsSync(join(assetDirectory, provided)), provided).toBe(false);
    }
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
