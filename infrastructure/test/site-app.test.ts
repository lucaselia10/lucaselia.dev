import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { inlineScriptHash, productionBuildProblems, scriptProblems } from "../lib/site-build-check";
import { CONTENT_SECURITY_POLICY, INLINE_SCRIPT_HASHES } from "../lib/site-headers";
import { assertPrepared, createSiteApp } from "../lib/site-app";
import { WEB_ADAPTER_BINARY_SHA256, WEB_ADAPTER_STUB } from "../lib/web-adapter-pin";
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
      app: new App({
        context: { siteHostedZoneId: "Z0123456789TESTZONE", webAdapterStub: "allow" },
      }),
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
    const context = {
      context: { siteHostedZoneId: "Z0123456789TESTZONE", webAdapterStub: "allow" },
    };
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
        app: new App({
          context: { siteHostedZoneId: "Z0123456789TESTZONE", webAdapterStub: "allow" },
        }),
        siteDirectory: development,
        ...preparedAssets(),
      }),
    ).toThrow(/Refusing to deploy/);
  });

  it("allows exactly the island scripts the CSP pins, and nothing else", () => {
    // Two inline scripts whose text hashes to the pinned values cannot be written here, so the
    // pinned set is checked against the CSP and the rule against synthetic scripts.
    expect(INLINE_SCRIPT_HASHES).toHaveLength(2);
    for (const hash of INLINE_SCRIPT_HASHES) {
      expect(hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
      expect(CONTENT_SECURITY_POLICY).toContain(`'${hash}'`);
    }
    expect(inlineScriptHash("")).toBe("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");

    const island =
      '<astro-island></astro-island><script type="module" src="/_astro/a.B1.js"></script>';
    expect(scriptProblems("index.html", island)).toEqual([]);
    expect(scriptProblems("a.html", "<script>alert(1)</script>").join()).toMatch(
      /inline script the CSP does not allow \(sha256-/,
    );
    expect(
      scriptProblems("b.html", '<script src="https://cdn.example/x.js"></script>').join(),
    ).toMatch(/outside \/_astro\//);
    expect(scriptProblems("c.html", '<script src="/_astro/x.js">inline()</script>').join()).toMatch(
      /outside \/_astro\//,
    );
    expect(scriptProblems("d.html", '<button onclick="go()">Go</button>').join()).toMatch(
      /inline event handler/,
    );
    expect(scriptProblems("e.html", '<a href="javascript:void(0)">x</a>').join()).toMatch(
      /javascript: URL/,
    );
  });

  it("refuses the stub adapter layer for any synth that may deploy", () => {
    const assets = preparedAssets(); // holds the CI stub
    expect(() => assertPrepared(assets.lambdaAssetPath, assets.webAdapterLayerPath)).toThrow(
      /is the CI stub .*Run "pnpm prepare:web-adapter" before diff or deploy/,
    );
    expect(() =>
      createSiteApp({
        app: new App({ context: { siteHostedZoneId: "Z0123456789TESTZONE" } }),
        siteDirectory: productionBuild(),
        ...assets,
      }),
    ).toThrow(/CI stub/);
    // Only an explicit, CI-only context accepts it.
    expect(() =>
      assertPrepared(assets.lambdaAssetPath, assets.webAdapterLayerPath, { allowStub: true }),
    ).not.toThrow();
  });

  it("accepts the pinned binary, and refuses any other binary even when the stub is allowed", () => {
    const assets = preparedAssets();
    const binary = join(assets.webAdapterLayerPath, "extensions", "lambda-adapter");
    writeFileSync(binary, "a release binary stand-in");
    const pinned = createHash("sha256").update(readFileSync(binary)).digest("hex");

    expect(() =>
      assertPrepared(assets.lambdaAssetPath, assets.webAdapterLayerPath, { binarySha256: pinned }),
    ).not.toThrow();
    expect(() =>
      assertPrepared(assets.lambdaAssetPath, assets.webAdapterLayerPath, { allowStub: true }),
    ).toThrow(/not the pinned binary/);
    expect(WEB_ADAPTER_BINARY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(WEB_ADAPTER_STUB).toContain("STUB-NOT-DEPLOYABLE");
    expect(WEB_ADAPTER_STUB).toContain("exit 1");
  });

  it("lets only the CI synth script allow the stub; diff and deploy never do", () => {
    const scripts = (
      JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.synth).toContain("prepare:web-adapter --stub");
    expect(scripts.synth).toContain("-c webAdapterStub=allow");
    for (const name of ["deploy:site", "diff:site", "synth:site"]) {
      expect(scripts[name], name).toContain("pnpm -w prepare:web-adapter &&");
      expect(scripts[name], name).not.toContain("webAdapterStub");
      expect(scripts[name], name).not.toContain("--stub");
    }
  });

  it("pins cross-stack references to strong, the behavior already deployed", () => {
    // cdk.json is what the CLI reads for deploy, diff, and synth. "strong" is CDK's default;
    // setting it explicitly only silences the default-strength warning (same templates).
    const cdkJson = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "cdk.json"), "utf8"),
    ) as {
      context?: Record<string, unknown>;
    };
    expect(cdkJson.context?.["@aws-cdk/core:defaultCrossStackReferences"]).toBe("strong");
  });
});
