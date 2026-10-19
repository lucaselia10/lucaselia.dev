import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  askApiHandlerScriptPath,
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

/** Files the function needs, relative to the ask_api package directory inside the asset. */
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
  "citation_safety.py",
  "index_loader.py",
  "exact_answers.py",
  "model_providers/__init__.py",
  "model_providers/base.py",
  "model_providers/anthropic_api.py",
  "model_providers/fixture.py",
  "data/__init__.py",
  "data/career-index.json",
] as const;

/** The asset is the function's task root: the package, its dependencies, and run.sh. */
export const lambdaPackageDirectoryName = "ask_api";
export const lambdaHandlerScriptName = "run.sh";
/** The Python 3.13 runtime provides boto3 (ADR-009), so the asset must not carry a copy. */
export const lambdaForbiddenTopLevel = ["boto3", "botocore", "s3transfer"] as const;

/** Where the evidence package sits inside the ask_api package, in the asset and locally. */
export const evidenceDirectoryName = join("data", "evidence");
export const evidenceManifestName = join("data", "evidence-manifest.json");

export function stageLambdaAsset(
  sourceDir = askApiPackageDir,
  indexPath = pythonCareerIndexPath,
  destination = lambdaAssetPath,
  evidenceDir = retrievalDirectory,
  evidenceManifest = retrievalManifestPath,
  handlerScript = askApiHandlerScriptPath,
): void {
  if (!statSync(indexPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "The synchronized career index is missing. Run pnpm sync:content before staging the Lambda asset.",
    );
  }
  assertEvidencePresent(evidenceDir, evidenceManifest);

  rmSync(destination, { recursive: true, force: true });
  const packageDir = join(destination, lambdaPackageDirectoryName);
  mkdirSync(packageDir, { recursive: true });
  copyPythonPackage(sourceDir, packageDir);
  const indexDestination = join(packageDir, "data", "career-index.json");
  mkdirSync(dirname(indexDestination), { recursive: true });
  cpSync(indexPath, indexDestination);
  copyEvidencePackage(evidenceDir, evidenceManifest, packageDir);
  const handlerDestination = join(destination, lambdaHandlerScriptName);
  cpSync(handlerScript, handlerDestination);
  chmodSync(handlerDestination, 0o755);
  installPinnedRuntimeDependencies(destination);
  removeInstallMetadata(destination);
  compileBytecode(destination);

  for (const required of [
    ...lambdaAssetRequiredPaths.map((path) => join(lambdaPackageDirectoryName, path)),
    join(lambdaPackageDirectoryName, evidenceManifestName),
    lambdaHandlerScriptName,
    "anthropic/__init__.py",
  ]) {
    if (!statSync(join(destination, required), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Lambda asset is missing ${required}.`);
    }
  }
  for (const forbidden of lambdaForbiddenTopLevel) {
    if (existsSync(join(destination, forbidden))) {
      throw new Error(`Lambda asset must not include ${forbidden}; the runtime provides it.`);
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

/**
 * Precompiled bytecode for the Lambda's Python 3.13 runtime. /var/task is read-only, so without
 * it every cold start compiles every imported module from source (ADR-009, cold start).
 * Bytecode does not depend on the CPU architecture, only on the Python minor version, so it is
 * built here with uv's CPython 3.13 and checked: each module gets a cpython-313 .pyc whose
 * magic number is 3.13's, in unchecked-hash mode (never revalidated against source mtimes,
 * which a deployment zip does not preserve meaningfully).
 */
export const lambdaBytecodeTag = "cpython-313";
const UNCHECKED_HASH_FLAGS = 0b01;

export function compileBytecode(destination: string): void {
  const python = findPython313();
  const magic = execFileSync(
    python,
    [
      "-c",
      "import importlib.util, sys; assert sys.version_info[:2] == (3, 13); print(importlib.util.MAGIC_NUMBER.hex())",
    ],
    { encoding: "utf8" },
  ).trim();
  execFileSync(
    python,
    [
      "-m",
      "compileall",
      "-q",
      "-j",
      "0",
      "--invalidation-mode",
      "unchecked-hash",
      // Tracebacks name the Lambda path, not this machine's.
      "-s",
      destination,
      "-p",
      "/var/task",
      destination,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const problems = bytecodeProblems(destination, magic);
  if (problems.length > 0) {
    throw new Error(`Lambda bytecode check failed:\n- ${problems.slice(0, 10).join("\n- ")}`);
  }
}

/** Every .py has a matching cpython-313 .pyc with the expected magic and unchecked-hash flags. */
export function bytecodeProblems(destination: string, magicHex: string): string[] {
  const problems: string[] = [];
  for (const path of relativeAssetPaths(destination)) {
    if (!path.endsWith(".py")) {
      continue;
    }
    const directory = dirname(path);
    const name = basename(path, ".py");
    const compiled = join(
      destination,
      directory,
      "__pycache__",
      `${name}.${lambdaBytecodeTag}.pyc`,
    );
    if (!existsSync(compiled)) {
      problems.push(`${path} has no ${lambdaBytecodeTag} bytecode`);
      continue;
    }
    const header = readFileSync(compiled).subarray(0, 8);
    if (header.subarray(0, 4).toString("hex") !== magicHex) {
      problems.push(
        `${path}: bytecode magic ${header.subarray(0, 4).toString("hex")} is not ${magicHex}`,
      );
    }
    if (header.readUInt32LE(4) !== UNCHECKED_HASH_FLAGS) {
      problems.push(`${path}: bytecode is not in unchecked-hash mode`);
    }
  }
  return problems;
}

function findPython313(): string {
  try {
    return execFileSync("uv", ["python", "find", lambdaPythonVersion], {
      cwd: askApiProjectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "Python 3.13 is required to compile the Lambda bytecode: run uv python install 3.13.",
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
