// Rules for text that may appear in a public repository or on the public site.
// validate-content uses the host rule for reviewed Markdown; check-public applies every rule
// to the files in the working tree.

const HOST_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

// Public Amazon and AWS hosts that may be linked. Every other amazon.com subdomain is treated
// as internal.
const PUBLIC_AMAZON_HOSTS = new Set([
  "amazon.com",
  "www.amazon.com",
  "aws.amazon.com",
  "docs.aws.amazon.com",
  "console.aws.amazon.com",
]);

const GENERIC_TOP_LEVEL = new Set(["com", "net", "org", "dev", "io"]);

export function isInternalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  const labels = name.split(".");
  const last = labels.at(-1) ?? "";
  if (name.endsWith(".amazon.com") || name === "amazon.com") {
    return !PUBLIC_AMAZON_HOSTS.has(name);
  }
  if (/-amazon\.com$/.test(name)) {
    return true;
  }
  if (/(?:^|\.)a2z\.com$/.test(name) || /(?:^|\.)amazon\.dev$/.test(name)) {
    return true;
  }
  if (last === "corp") {
    return true;
  }
  return labels.length > 2 && labels.slice(0, -1).includes("corp") && GENERIC_TOP_LEVEL.has(last);
}

export function findInternalHosts(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(HOST_PATTERN)) {
    if (isInternalHost(match[0])) {
      found.push(match[0]);
    }
  }
  return found;
}

// The AWS documentation placeholder account ID and example access key pair. They are safe to
// keep in tests and docs because AWS publishes them as examples.
export const PLACEHOLDER_ACCOUNT_ID = "123456789012";
export const EXAMPLE_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
export const EXAMPLE_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

export type PublicRule = {
  name: string;
  test: (line: string) => boolean;
};

const ACCOUNT_ID_PATTERN = /(?<![\w.-])\d{12}(?![\w-])/g;
const HOME_PATH_PATTERN = new RegExp(["", "Users", ""].join("/"));
const PRIVATE_KEY_PATTERN = new RegExp(["-----BEGIN", "[A-Z ]*PRIVATE KEY-----"].join(" ?"));
const KEY_PATTERNS = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
];
const KNOWN_EXAMPLE_KEYS = new Set([EXAMPLE_ACCESS_KEY_ID, EXAMPLE_SECRET_ACCESS_KEY]);

function hasMatch(line: string, pattern: RegExp, allowed: (value: string) => boolean): boolean {
  for (const match of line.matchAll(pattern)) {
    if (!allowed(match[0])) {
      return true;
    }
  }
  return false;
}

// A 40-character run is only key-shaped when it mixes cases and digits, which a git SHA
// (lowercase hex) or a word does not.
function looksLikeSecretKey(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

export const PUBLIC_RULES: readonly PublicRule[] = [
  {
    name: "AWS account ID",
    test: (line) => hasMatch(line, ACCOUNT_ID_PATTERN, (value) => value === PLACEHOLDER_ACCOUNT_ID),
  },
  { name: "local home path", test: (line) => HOME_PATH_PATTERN.test(line) },
  { name: "internal host", test: (line) => findInternalHosts(line).length > 0 },
  { name: "private key header", test: (line) => PRIVATE_KEY_PATTERN.test(line) },
  {
    name: "key-shaped string",
    test: (line) =>
      KEY_PATTERNS.some((pattern, index) =>
        hasMatch(
          line,
          pattern,
          (value) =>
            KNOWN_EXAMPLE_KEYS.has(value) ||
            (index === KEY_PATTERNS.length - 1 && !looksLikeSecretKey(value)),
        ),
      ),
  },
];

export function parseBlocklist(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export type PublicFinding = { path: string; line: number; rule: string };

// Findings name the file, line, and rule only. The matched text is never echoed, so a real
// secret does not end up in CI logs.
export function scanText(
  path: string,
  text: string,
  blocklist: readonly string[] = [],
): PublicFinding[] {
  const findings: PublicFinding[] = [];
  const phrases = blocklist.map((phrase) => phrase.toLowerCase());
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of PUBLIC_RULES) {
      if (rule.test(line)) {
        findings.push({ path, line: index + 1, rule: rule.name });
      }
    }
    const lower = line.toLowerCase();
    if (phrases.some((phrase) => lower.includes(phrase))) {
      findings.push({ path, line: index + 1, rule: "private blocklist phrase" });
    }
  });
  return findings;
}
