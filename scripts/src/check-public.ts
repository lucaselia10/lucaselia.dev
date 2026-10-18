import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.js";
import { parseBlocklist, scanText, type PublicFinding } from "./public-safety.js";

// Local-only phrases (removed wording, personal identifiers). The file is gitignored, so CI
// runs without it.
export const privateBlocklistPath = join(repoRoot, "private", "public-blocklist.txt");

// Every file that would be in a public commit: tracked files plus untracked files that are not
// ignored. Deleted files are skipped.
export function listPublicFiles(root = repoRoot): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );
  return [...new Set(output.split("\0").filter((path) => path.length > 0))]
    .filter((path) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile())
    .sort();
}

export function readBlocklist(path = privateBlocklistPath): string[] {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    return [];
  }
  return parseBlocklist(readFileSync(path, "utf8"));
}

export function checkPublicFiles(
  root = repoRoot,
  blocklist = readBlocklist(),
): { files: number; findings: PublicFinding[] } {
  const files = listPublicFiles(root);
  const findings: PublicFinding[] = [];
  for (const path of files) {
    const bytes = readFileSync(join(root, path));
    if (bytes.includes(0)) {
      continue;
    }
    findings.push(...scanText(path, bytes.toString("utf8"), blocklist));
  }
  return { files: files.length, findings };
}
