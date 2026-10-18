import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  askApiPackageDir,
  askApiProjectDir,
  lambdaAssetPath,
  pythonCareerIndexPath,
  retrievalDirectory,
  retrievalManifestPath,
} from "./paths.js";

const skippedDirectories = new Set([
  "__pycache__",
  ".venv",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  "node_modules",
  "dist",
  "tests",
]);

export const lambdaAssetRequiredPaths = [
  "__init__.py",
  "production_app.py",
  "stream_http.py",
  "secret_key.py",
  "ask_request.py",
  "local_stream.py",
  "local_conversation.py",
  "local_evidence.py",
  "answer_style.py",
  "model_providers/__init__.py",
  "model_providers/base.py",
  "model_providers/anthropic_api.py",
  "model_providers/fixture.py",
  "handler.py",
  "exact_answers.py",
  "index_loader.py",
  "grounding.py",
  "grounding_errors.py",
  "grounding_prompt.py",
  "grounding_config.py",
  "grounding_factory.py",
  "model_output.py",
  "citation_safety.py",
  "bedrock_retriever.py",
  "bedrock_generator.py",
  "data/__init__.py",
  "data/career-index.json",
] as const;

/** Where the evidence package sits inside the ask_api package, in the asset and locally. */
export const evidenceDirectoryName = join("data", "evidence");
export const evidenceManifestName = join("data", "evidence-manifest.json");

export function stageLambdaAsset(
  sourceDir = askApiPackageDir,
  indexPath = pythonCareerIndexPath,
  destination = lambdaAssetPath,
  evidenceDir = retrievalDirectory,
  evidenceManifest = retrievalManifestPath,
): void {
  if (!statSync(indexPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "The synchronized career index is missing. Run pnpm sync:content before staging the Lambda asset.",
    );
  }
  assertEvidencePresent(evidenceDir, evidenceManifest);

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  copyPythonPackage(sourceDir, destination);
  const indexDestination = join(destination, "data", "career-index.json");
  mkdirSync(dirname(indexDestination), { recursive: true });
  cpSync(indexPath, indexDestination);
  copyEvidencePackage(evidenceDir, evidenceManifest, destination);
  installPinnedRuntimeDependencies(destination);
  removeInstallMetadata(destination);

  for (const required of [
    ...lambdaAssetRequiredPaths,
    evidenceManifestName,
    "anthropic/__init__.py",
    "boto3/__init__.py",
    "botocore/__init__.py",
  ]) {
    if (!statSync(join(destination, required), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Lambda asset is missing ${required}.`);
    }
  }
}

/**
 * Copy the evidence package (the retrieval artifacts: section text and metadata, plus the
 * manifest) into an ask_api package directory. The production app loads it from there.
 */
export function copyEvidencePackage(
  evidenceDir: string,
  evidenceManifest: string,
  packageDir: string,
): void {
  assertEvidencePresent(evidenceDir, evidenceManifest);
  const target = join(packageDir, evidenceDirectoryName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".txt") || entry.name.endsWith(".metadata.json"))) {
      cpSync(join(evidenceDir, entry.name), join(target, entry.name));
    }
  }
  cpSync(evidenceManifest, join(packageDir, evidenceManifestName));
}

function assertEvidencePresent(evidenceDir: string, evidenceManifest: string): void {
  if (
    !statSync(evidenceDir, { throwIfNoEntry: false })?.isDirectory() ||
    !statSync(evidenceManifest, { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error(
      "The evidence package is missing. Run pnpm build:retrieval before staging the Lambda asset.",
    );
  }
}

const lambdaPythonPlatform = "aarch64-manylinux2014";
const lambdaPythonVersion = "3.13";

function installPinnedRuntimeDependencies(destination: string): void {
  const requirementsDirectory = mkdtempSync(join(tmpdir(), "lambda-requirements-"));
  const requirementsPath = join(requirementsDirectory, "requirements.txt");
  try {
    runUv([
      "export",
      "--frozen",
      "--no-dev",
      "--no-emit-project",
      "--no-header",
      "--no-annotate",
      "--format",
      "requirements.txt",
      "--output-file",
      requirementsPath,
    ]);
    runUv([
      "pip",
      "install",
      "--requirements",
      requirementsPath,
      "--require-hashes",
      "--target",
      destination,
      "--python",
      lambdaPythonVersion,
      "--python-platform",
      lambdaPythonPlatform,
      "--python-version",
      lambdaPythonVersion,
      "--link-mode",
      "copy",
      "--no-build",
    ]);
  } finally {
    rmSync(requirementsDirectory, { recursive: true, force: true });
  }
}

function runUv(args: readonly string[]): void {
  try {
    execFileSync("uv", args, {
      cwd: askApiProjectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stderr?: string };
    throw new Error(
      `Unable to stage the pinned Python dependencies from services/ask-api/uv.lock.\n${failure.stderr ?? ""}`,
    );
  }
}

function removeInstallMetadata(directory: string): void {
  rmSync(join(directory, ".lock"), { force: true });
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        rmSync(fullPath, { recursive: true, force: true });
        continue;
      }
      removeInstallMetadata(fullPath);
      continue;
    }
    if (entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) {
      rmSync(fullPath, { force: true });
    }
  }
}

function copyPythonPackage(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (skippedDirectories.has(entry.name)) {
      continue;
    }
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyPythonPackage(from, to);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".py")) {
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}

export function relativeAssetPaths(directory: string): string[] {
  const paths: string[] = [];
  collectRelativePaths(directory, directory, paths);
  return paths.sort();
}

function collectRelativePaths(root: string, directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(relative(root, fullPath));
      collectRelativePaths(root, fullPath, paths);
      continue;
    }
    if (entry.isFile()) {
      paths.push(relative(root, fullPath));
    }
  }
}
