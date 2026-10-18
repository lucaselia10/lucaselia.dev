import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { INLINE_SCRIPT_HASHES, INLINE_STYLE_HASHES } from "./site-headers";

/**
 * Refuse to deploy anything but a production build of the site. `pnpm build:site`
 * produces one; a development build (with the fixture or the career index), a page with an
 * inline script the CSP does not allow by hash, a script from anywhere but /_astro/, an
 * inline event handler, or a missing build fails before synthesis.
 */
export function productionBuildProblems(siteDirectory: string): string[] {
  if (!existsSync(join(siteDirectory, "index.html"))) {
    return [`No site build at ${siteDirectory}. Run "pnpm build:site" first.`];
  }
  const problems: string[] = [];
  for (const required of ["404.html", "robots.txt", "sitemap-index.xml", "favicon.svg"]) {
    if (!existsSync(join(siteDirectory, required))) {
      problems.push(`The build is missing ${required}.`);
    }
  }
  if (existsSync(join(siteDirectory, "career-index.json"))) {
    problems.push("The build ships career-index.json, so it is not a production build.");
  }
  for (const file of walk(siteDirectory)) {
    const path = relative(siteDirectory, file);
    if (/(^|\/)fictional-/.test(path)) {
      problems.push(`The build contains the test fixture ${path}.`);
    }
    if (path.endsWith(".html") || path.endsWith(".xml")) {
      const text = readFileSync(file, "utf8");
      if (text.includes("fictional-")) {
        problems.push(`${path} links to a test fixture.`);
      }
      if (path.endsWith(".html")) {
        problems.push(...scriptProblems(path, text));
      }
    }
  }
  return problems;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const ALLOWED_SCRIPT_SOURCE = /^\/_astro\/[A-Za-z0-9._-]+\.js$/;

/** CSP hash source for an inline script: base64 SHA-256 of its exact text. */
export function inlineScriptHash(content: string): string {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("base64")}`;
}

/** Every inline script must be one the CSP allows by hash; external ones only from /_astro/. */
export function scriptProblems(path: string, html: string): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>(INLINE_SCRIPT_HASHES);
  for (const match of html.matchAll(SCRIPT)) {
    const attributes = match[1] ?? "";
    const content = match[2] ?? "";
    const source = /\ssrc\s*=\s*"([^"]*)"/i.exec(attributes)?.[1];
    if (source !== undefined) {
      if (!ALLOWED_SCRIPT_SOURCE.test(source) || content.trim() !== "") {
        problems.push(`${path} loads a script from outside /_astro/: ${source}`);
      }
      continue;
    }
    const hash = inlineScriptHash(content);
    if (!allowed.has(hash)) {
      problems.push(
        `${path} has an inline script the CSP does not allow (${hash}). Update INLINE_SCRIPT_HASHES in site-headers.ts only after reviewing it.`,
      );
    }
  }
  const styles = new Set<string>(INLINE_STYLE_HASHES);
  for (const match of html.matchAll(STYLE)) {
    const hash = inlineScriptHash(match[1] ?? "");
    if (!styles.has(hash)) {
      problems.push(
        `${path} has an inline style the CSP does not allow (${hash}). Update INLINE_STYLE_HASHES in site-headers.ts only after reviewing it.`,
      );
    }
  }
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) {
    problems.push(`${path} has an inline event handler, which the CSP blocks.`);
  }
  if (/javascript:/i.test(html)) {
    problems.push(`${path} has a javascript: URL.`);
  }
  return problems;
}

export function assertProductionBuild(siteDirectory: string): void {
  const problems = productionBuildProblems(siteDirectory);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to deploy this site build:\n- ${problems.join("\n- ")}\nRun "pnpm build:site" and try again.`,
    );
  }
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
