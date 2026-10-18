import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Refuse to deploy anything but a production build of the site. `pnpm build:site`
 * produces one; a development build (with the fixture, the career index, or the
 * assistant island) or a missing build fails before synthesis.
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
      if (text.includes("<astro-island") || text.includes("<script")) {
        problems.push(`${path} contains a script; the v1 site ships without the assistant.`);
      }
    }
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
