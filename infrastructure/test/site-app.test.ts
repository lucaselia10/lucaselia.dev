import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { productionBuildProblems } from "../lib/site-build-check";
import { createSiteApp } from "../lib/site-app";
import { preparedAssets } from "./fixtures";

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
  it("synthesizes the assistant and site stacks, both in us-east-1", () => {
    const app = createSiteApp({
      app: new App({ context: { siteHostedZoneId: "Z0123456789TESTZONE" } }),
      siteDirectory: productionBuild(),
      ...preparedAssets(),
    });
    const assembly = app.synth();

    expect(assembly.stacks.map((stack) => stack.stackName).sort()).toEqual([
      "PortfolioAssistantStack",
      "PortfolioSiteStack",
    ]);
    for (const stack of assembly.stacks) {
      expect(stack.environment.region).toBe("us-east-1");
    }
    const site = assembly.getStackByName("PortfolioSiteStack");
    expect(site.dependencies.map((dependency) => dependency.id)).toContain(
      "PortfolioAssistantStack",
    );
  });

  it("refuses to synthesize without the staged asset or the adapter layer", () => {
    const assets = preparedAssets();
    const context = { context: { siteHostedZoneId: "Z0123456789TESTZONE" } };
    expect(() =>
      createSiteApp({
        app: new App(context),
        siteDirectory: productionBuild(),
        lambdaAssetPath: assets.lambdaAssetPath,
        webAdapterLayerPath: join(tmpdir(), "no-such-layer"),
      }),
    ).toThrow(/prepare:web-adapter/);
    expect(() =>
      createSiteApp({
        app: new App(context),
        siteDirectory: productionBuild(),
        lambdaAssetPath: join(tmpdir(), "no-such-asset"),
        webAdapterLayerPath: assets.webAdapterLayerPath,
      }),
    ).toThrow(/prepare:api/);
  });

  it("requires the hosted zone id as deploy-time context", () => {
    expect(() =>
      createSiteApp({ app: new App(), siteDirectory: productionBuild(), ...preparedAssets() }),
    ).toThrow(/-c siteHostedZoneId=/);
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
        ...preparedAssets(),
      }),
    ).toThrow(/Refusing to deploy/);
  });
});
