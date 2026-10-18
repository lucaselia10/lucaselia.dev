import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPublicFiles, listPublicFiles, readBlocklist } from "./check-public.js";
import {
  EXAMPLE_ACCESS_KEY_ID,
  EXAMPLE_SECRET_ACCESS_KEY,
  PLACEHOLDER_ACCOUNT_ID,
  findInternalHosts,
  isInternalHost,
  parseBlocklist,
  scanText,
} from "./public-safety.js";

// Every unsafe value below is assembled at runtime from made-up parts, so this file itself
// passes check:public.
const host = (...labels: string[]) => labels.join(".");

function rulesFor(text: string, blocklist: string[] = []): string[] {
  return scanText("sample.txt", text, blocklist).map((finding) => finding.rule);
}

describe("internal host rule", () => {
  it("blocks made-up internal hosts", () => {
    for (const name of [
      host("made-up-tool", "amazon", "com"),
      host("wiki", "corp", "amazon", "com"),
      host("example-quip-amazon", "com"),
      host("made-up", "a2z", "com"),
      host("tool", "amazon", "dev"),
      host("wiki", "corp", "example", "com"),
      host("intranet", "corp"),
    ]) {
      expect(isInternalHost(name), name).toBe(true);
    }
  });

  it("allows public Amazon and AWS hosts and ordinary domains", () => {
    for (const name of [
      "amazon.com",
      "www.amazon.com",
      "aws.amazon.com",
      "docs.aws.amazon.com",
      "bedrock.amazonaws.com",
      "lucaselia.dev",
      "example.com",
      "corp.example",
    ]) {
      expect(isInternalHost(name), name).toBe(false);
    }
  });

  it("finds hosts inside URLs and prose", () => {
    const internal = host("made-up-tool", "amazon", "com");
    expect(
      findInternalHosts(`See https://${internal}/page and https://docs.aws.amazon.com/x.`),
    ).toEqual([internal]);
    expect(findInternalHosts("See https://aws.amazon.com/bedrock/ for pricing.")).toEqual([]);
  });
});

describe("scanText", () => {
  it("flags account IDs but not the placeholder or longer identifiers", () => {
    const realLooking = ["4321", "8765", "2109"].join("");
    expect(rulesFor(`arn:aws:iam::${realLooking}:role/x`)).toContain("AWS account ID");
    expect(rulesFor(`account ${PLACEHOLDER_ACCOUNT_ID}`)).toEqual([]);
    expect(rulesFor(`request req-${realLooking}`)).toEqual([]);
    expect(rulesFor(`timestamp ${realLooking}5`)).toEqual([]);
  });

  it("flags home paths and private key headers", () => {
    expect(rulesFor(`${["", "Users", "someone", "notes"].join("/")}`)).toEqual(["local home path"]);
    expect(rulesFor("/home/example/private")).toEqual([]);
    const header = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
    expect(rulesFor(header)).toEqual(["private key header"]);
  });

  it("flags key-shaped strings except the documented examples", () => {
    const accessKey = ["AKIA", "Z".repeat(4), "7".repeat(12)].join("");
    const anthropicKey = ["sk", "ant", "api03", "x".repeat(20)].join("-");
    const secret = ["Ab3", "x".repeat(37)].join("");
    expect(rulesFor(`key=${accessKey}`)).toEqual(["key-shaped string"]);
    expect(rulesFor(`key=${anthropicKey}`)).toEqual(["key-shaped string"]);
    expect(rulesFor(`secret=${secret}`)).toEqual(["key-shaped string"]);
    expect(rulesFor(`${EXAMPLE_ACCESS_KEY_ID} ${EXAMPLE_SECRET_ACCESS_KEY}`)).toEqual([]);
    expect(rulesFor(`commit ${"a1b2c3d4".repeat(5)}`)).toEqual([]);
  });

  it("applies private blocklist phrases case-insensitively", () => {
    const phrases = parseBlocklist("# comment\n\nSecret Project Name\n");
    expect(phrases).toEqual(["Secret Project Name"]);
    expect(rulesFor("about the secret project name here", phrases)).toEqual([
      "private blocklist phrase",
    ]);
    expect(rulesFor("an ordinary line", phrases)).toEqual([]);
  });

  it("reports line numbers without echoing the match", () => {
    const findings = scanText("a.md", `ok\n${host("made-up-tool", "amazon", "com")}\n`);
    expect(findings).toEqual([{ path: "a.md", line: 2, rule: "internal host" }]);
  });
});

describe("checkPublicFiles", () => {
  it("scans tracked and unignored files, skips ignored and deleted ones", () => {
    const root = mkdtempSync(join(tmpdir(), "check-public-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "private"));
      writeFileSync(join(root, ".gitignore"), "private/\n");
      writeFileSync(join(root, "clean.md"), "Nothing to see.\n");
      writeFileSync(join(root, "leak.md"), `See ${host("made-up-tool", "amazon", "com")}.\n`);
      writeFileSync(join(root, "phrase.md"), "Mentions Secret Project Name.\n");
      writeFileSync(join(root, "private", "notes.md"), host("made-up-tool", "amazon", "com"));
      writeFileSync(join(root, "private", "public-blocklist.txt"), "secret project name\n");

      expect(listPublicFiles(root)).toEqual([".gitignore", "clean.md", "leak.md", "phrase.md"]);
      const blocklist = readBlocklist(join(root, "private", "public-blocklist.txt"));
      const result = checkPublicFiles(root, blocklist);
      expect(result.files).toBe(4);
      expect(result.findings).toEqual([
        { path: "leak.md", line: 1, rule: "internal host" },
        { path: "phrase.md", line: 1, rule: "private blocklist phrase" },
      ]);
      expect(readBlocklist(join(root, "missing.txt"))).toEqual([]);
      expect(checkPublicFiles(root, []).findings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
