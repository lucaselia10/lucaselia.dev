import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  it("ships Python 3.13 bytecode for the app, so cold starts skip compiling", () => {
    // Header: CPython 3.13's magic number, then flags 1 (hash-based, unchecked).
    for (const module of ["production_app", "local_stream", "stream_http"]) {
      const header = readFileSync(
        join(assetDirectory, "ask_api", "__pycache__", `${module}.cpython-313.pyc`),
      ).subarray(0, 8);
      expect(header.subarray(0, 4).toString("hex"), module).toBe("f30d0d0a");
      expect(header.readUInt32LE(4), module).toBe(1);
    }
    expect(
      existsSync(join(assetDirectory, "anthropic", "__pycache__", "__init__.cpython-313.pyc")),
    ).toBe(true);
  });
});
