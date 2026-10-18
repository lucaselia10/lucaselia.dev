import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askApiPackageDir, askApiProjectDir, repoRoot } from "./paths.js";
import {
  copyEvidencePackage,
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
    const evidence = writeEvidence(root);

    stageLambdaAsset(source, index, destination, evidence.directory, evidence.manifest);

    const staged = relativeAssetPaths(destination);
    for (const required of lambdaAssetRequiredPaths) {
      expect(staged).toContain(required);
    }
    expect(readFileSync(join(destination, "data", "career-index.json"))).toEqual(
      readFileSync(index),
    );
    expectStagedEvidence(staged, destination, evidence.manifest);
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
    const evidence = writeEvidence(mkdtempSync(join(tmpdir(), "lambda-evidence-")));
    stageLambdaAsset(askApiPackageDir, index, destination, evidence.directory, evidence.manifest);

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
    expect(staged).toContain("production_app.py");
    expect(staged).toContain("model_providers/anthropic_api.py");
    expect(staged).toContain("anthropic/__init__.py");
    expectStagedEvidence(staged, destination, evidence.manifest);
    expectPinnedRuntimeDependencies(staged);
    expectAbsentFromAsset(staged);
  });

  it("refuses to stage without the evidence package", () => {
    const root = mkdtempSync(join(tmpdir(), "lambda-no-evidence-"));
    const index = join(root, "career-index.json");
    writeFileSync(index, "{}\n");

    expect(() =>
      stageLambdaAsset(
        askApiPackageDir,
        index,
        join(root, "asset"),
        join(root, "missing"),
        join(root, "missing.json"),
      ),
    ).toThrow("Run pnpm build:retrieval");
  });

  it("copies the evidence package into a local package for the production app", () => {
    const root = mkdtempSync(join(tmpdir(), "local-evidence-"));
    const evidence = writeEvidence(root);
    const packageDir = join(root, "ask_api");
    mkdirSync(join(packageDir, "data", "evidence"), { recursive: true });
    writeFileSync(join(packageDir, "data", "evidence", "stale.txt"), "stale\n");

    copyEvidencePackage(evidence.directory, evidence.manifest, packageDir);

    expectStagedEvidence(relativeAssetPaths(packageDir), packageDir, evidence.manifest);
  });
});

function writeEvidence(root: string): { directory: string; manifest: string } {
  const directory = join(root, "retrieval");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "aws-sde-ii--role-description.txt"), "Section text.\n");
  writeFileSync(join(directory, "aws-sde-ii--role-description.txt.metadata.json"), "{}\n");
  writeFileSync(join(directory, "notes.md"), "not part of the package\n");
  const manifest = join(root, "retrieval-manifest.json");
  writeFileSync(manifest, '{"schemaVersion":1,"marker":"evidence"}\n');
  return { directory, manifest };
}

function expectStagedEvidence(staged: string[], destination: string, manifest: string): void {
  const evidence = staged.filter((path) => path.startsWith("data/evidence/"));
  expect(evidence).toEqual([
    "data/evidence/aws-sde-ii--role-description.txt",
    "data/evidence/aws-sde-ii--role-description.txt.metadata.json",
  ]);
  expect(readFileSync(join(destination, "data", "evidence-manifest.json"))).toEqual(
    readFileSync(manifest),
  );
}

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
  return (
    output
      .split("\n")
      .map((line) => line.trim().replace(/\\$/, "").trim())
      .filter((line) => line.includes("=="))
      // Packages marked for the browser (Pyodide) runtime are not installed for Lambda.
      .filter((line) => !line.includes("sys_platform == 'emscripten'"))
      .map((line) => line.split(";")[0]?.trim() ?? "")
      .map((line) => {
        const [name, version] = line.split("==");
        return `${name?.replaceAll("-", "_")}-${version}.dist-info`;
      })
  );
}

function writePythonFile(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, contents);
}
