import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askApiPackageDir, askApiProjectDir, repoRoot } from "./paths.js";
import {
  lambdaAssetRequiredPaths,
  relativeAssetPaths,
  stageLambdaAsset,
} from "./stage-lambda-asset.js";

describe("Lambda asset staging", () => {
  it("copies the package and index and leaves prohibited paths behind", () => {
    const root = mkdtempSync(join(tmpdir(), "lambda-asset-"));
    const source = join(root, "ask_api");
    const index = join(root, "career-index.json");
    const destination = join(root, "asset");
    for (const required of lambdaAssetRequiredPaths) {
      if (required.endsWith(".py")) {
        writePythonFile(source, required, "value = True\n");
      }
    }
    writeFileSync(index, '{"schemaVersion":1,"marker":"staged"}\n');
    writeFileSync(join(source, "data", "career-index.json"), '{"schemaVersion":0}\n');
    writeFileSync(join(source, ".env"), "AWS_SECRET_ACCESS_KEY=local\n");
    writeFileSync(join(source, "credentials.json"), "{}\n");
    writePythonFile(source, "tests/test_handler.py", "def test_handler():\n    pass\n");
    writePythonFile(source, "__pycache__/handler.cpython-313.pyc", "cache");
    writePythonFile(source, ".venv/lib/python.py", "venv");
    mkdirSync(join(source, "private-notes"), { recursive: true });
    writeFileSync(join(source, "private-notes", "note.md"), "private");
    mkdirSync(join(source, "dist"), { recursive: true });
    writeFileSync(join(source, "dist", "index.html"), "web");
    writeFileSync(join(source, "upload.pdf"), "upload");
    mkdirSync(join(destination, "stale_sdk"), { recursive: true });
    writeFileSync(join(destination, "stale_sdk", "__init__.py"), "stale = True\n");
    writeFileSync(join(destination, "pytest.py"), "def test_stale():\n    pass\n");

    stageLambdaAsset(source, index, destination);

    const staged = relativeAssetPaths(destination);
    for (const required of lambdaAssetRequiredPaths) {
      expect(staged).toContain(required);
    }
    expect(readFileSync(join(destination, "data", "career-index.json"))).toEqual(
      readFileSync(index),
    );
    expectPinnedRuntimeDependencies(staged);
    expect(staged.join("\n")).not.toContain("stale_sdk");
    expect(staged).not.toContain("pytest.py");
    expect(staged).not.toContain("upload.pdf");
    expectAbsentFromAsset(staged);
  });

  it("does not include the development server in the Lambda asset", () => {
    const destination = join(mkdtempSync(join(tmpdir(), "lambda-asset-real-")), "ask-api");
    const index = join(mkdtempSync(join(tmpdir(), "lambda-index-")), "career-index.json");
    writeFileSync(index, "{}\n");
    stageLambdaAsset(askApiPackageDir, index, destination);

    const staged = relativeAssetPaths(destination);
    const joined = staged.join("\n");
    expect(existsSync(join(repoRoot, "services", "ask-api", "dev_server.py"))).toBe(true);
    expect(joined).not.toContain("dev_server.py");
    expect(joined).not.toContain("retrieval/");
    expect(joined).not.toContain("retrieval_publisher");
    expect(
      existsSync(join(repoRoot, "services", "ask-api", "src", "retrieval_publisher", "cli.py")),
    ).toBe(true);
    expect(staged).toContain("handler.py");
    expect(staged).toContain("bedrock_retriever.py");
    expect(staged).toContain("bedrock_generator.py");
    expect(staged).toContain("grounding_factory.py");
    expect(staged).toContain("data/career-index.json");
    expectPinnedRuntimeDependencies(staged);
    expectAbsentFromAsset(staged);
  });
});

function expectPinnedRuntimeDependencies(staged: string[]): void {
  expect(staged).toContain("boto3/__init__.py");
  expect(staged).toContain("botocore/__init__.py");
  for (const distribution of lockedRuntimeDistributions()) {
    expect(staged).toContain(distribution);
  }
}

function expectAbsentFromAsset(staged: string[]): void {
  const segments = staged.flatMap((path) => path.split("/"));
  for (const prohibited of [
    "__pycache__",
    ".venv",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    "tests",
    "private-notes",
    "dist",
    "site-packages",
    "node_modules",
    "retrieval_publisher",
  ]) {
    expect(segments).not.toContain(prohibited);
  }
  expect(staged.some((path) => path === ".lock" || path.endsWith("/.lock"))).toBe(false);
  expect(
    staged.some(
      (path) =>
        path.endsWith(".pyc") ||
        path.endsWith(".pyo") ||
        path.endsWith(".env") ||
        path.endsWith("credentials.json") ||
        path.endsWith("dev_server.py"),
    ),
  ).toBe(false);
  for (const developmentPackage of [
    "pytest",
    "ruff",
    "pyright",
    "boto3_stubs",
    "botocore_stubs",
    "mypy",
    "nodeenv",
    "iniconfig",
    "pluggy",
    "pygments",
    "packaging",
  ]) {
    expect(staged.some((path) => path.split("/")[0]?.startsWith(developmentPackage))).toBe(false);
  }
}

function lockedRuntimeDistributions(): string[] {
  const output = execFileSync(
    "uv",
    [
      "export",
      "--frozen",
      "--no-dev",
      "--no-emit-project",
      "--no-header",
      "--no-annotate",
      "--format",
      "requirements.txt",
    ],
    { cwd: askApiProjectDir, encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((line) => line.trim().replace(/\\$/, "").trim())
    .filter((line) => line.includes("=="))
    .map((line) => {
      const [name, version] = line.split("==");
      return `${name?.replaceAll("-", "_")}-${version}.dist-info`;
    });
}

function writePythonFile(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, contents);
}
