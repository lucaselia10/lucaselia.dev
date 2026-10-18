import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { productionBuildProblems } from "../lib/site-build-check";
import { createSiteApp } from "../lib/site-app";

const infrastructureDirectory = join(import.meta.dirname, "..");

function productionBuild(extra: Record<string, string> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "site-prod-"));
  mkdirSync(join(directory, "_astro"));
  const files: Record<string, string> = {
    "index.html": "<!doctype html><title>Lucas Elia</title>",
    "404.html": "<!doctype html><title>Not found</title>",
    "robots.txt": "User-agent: *\n",
    "sitemap-index.xml": "<sitemapindex/>",
    "favicon.svg": "<svg/>",
    "_astro/index.abc.css": "body{}",
    ...extra,
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  return directory;
}

describe("site CDK app", () => {
  it("synthesizes exactly one stack, PortfolioSiteStack", () => {
    const app = createSiteApp({
      app: new App({ context: { siteHostedZoneId: "Z0123456789TESTZONE" } }),
      siteDirectory: productionBuild(),
    });
    const assembly = app.synth();

    expect(assembly.stacks.map((stack) => stack.stackName)).toEqual(["PortfolioSiteStack"]);
    expect(assembly.stacks[0]?.environment.region).toBe("us-east-1");
  });

  it("requires the hosted zone id as deploy-time context", () => {
    expect(() => createSiteApp({ app: new App(), siteDirectory: productionBuild() })).toThrow(
      /-c siteHostedZoneId=/,
    );
  });

  it("refuses a missing or non-production build", () => {
    expect(productionBuildProblems(productionBuild())).toEqual([]);
    expect(productionBuildProblems(join(tmpdir(), "no-such-site-build"))[0]).toMatch(/build:site/);
    const development = productionBuild({
      "career-index.json": "{}",
      "work/fictional-lumen-harbor/index.html": "<p>fixture</p>",
      "experience/aws-sde-ii/index.html":
        '<astro-island></astro-island><script type="module"></script>',
    });
    const problems = productionBuildProblems(development).join("\n");
    expect(problems).toMatch(/career-index\.json/);
    expect(problems).toMatch(/fictional-lumen-harbor/);
    expect(problems).toMatch(/script/);
    expect(() =>
      createSiteApp({
        app: new App({ context: { siteHostedZoneId: "Z0123456789TESTZONE" } }),
        siteDirectory: development,
      }),
    ).toThrow(/Refusing to deploy/);
  });

  it("keeps the ask API app from running with site context", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "bin/app.ts"], {
      cwd: infrastructureDirectory,
      env: {
        ...process.env,
        CDK_CONTEXT_JSON: JSON.stringify({ siteHostedZoneId: "Z0123456789TESTZONE" }),
        CDK_OUTDIR: mkdtempSync(join(tmpdir(), "ask-app-out-")),
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("This is the ask API app");
  });
});
