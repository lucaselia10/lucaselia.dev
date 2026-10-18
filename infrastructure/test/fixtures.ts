import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PortfolioAssistantStack } from "../lib/portfolio-assistant-stack";
import { PortfolioSiteStack, SITE_REGION } from "../lib/portfolio-site-stack";

export const ZONE_ID = "Z0123456789TESTZONE";
// The AWS documentation placeholder account, never a real one.
export const TEST_ENV = { account: "123456789012", region: SITE_REGION };

/** Offline stand-ins for the staged Lambda asset and the adapter layer. */
export function preparedAssets(): { lambdaAssetPath: string; webAdapterLayerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "assistant-assets-"));
  const lambdaAssetPath = join(root, "ask-api");
  mkdirSync(join(lambdaAssetPath, "ask_api"), { recursive: true });
  writeFileSync(join(lambdaAssetPath, "ask_api", "__init__.py"), "");
  writeFileSync(join(lambdaAssetPath, "run.sh"), "#!/bin/bash\n");
  chmodSync(join(lambdaAssetPath, "run.sh"), 0o755);
  const webAdapterLayerPath = join(root, "layer");
  mkdirSync(join(webAdapterLayerPath, "extensions"), { recursive: true });
  writeFileSync(join(webAdapterLayerPath, "bootstrap"), "#!/bin/bash\n");
  writeFileSync(join(webAdapterLayerPath, "extensions", "lambda-adapter"), "fake");
  return { lambdaAssetPath, webAdapterLayerPath };
}

export function siteDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "site-build-"));
  mkdirSync(join(directory, "_astro"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Site</title>");
  writeFileSync(join(directory, "_astro", "index.abc123.css"), "body{}");
  return directory;
}

export interface Synthesized {
  assistant: PortfolioAssistantStack;
  site: PortfolioSiteStack;
  assistantTemplate: Template;
  siteTemplate: Template;
}

export function synthesizeStacks(secretName?: string): Synthesized {
  const app = new App();
  const assistant = new PortfolioAssistantStack(app, "PortfolioAssistantStack", {
    ...preparedAssets(),
    secretName,
    env: TEST_ENV,
  });
  const site = new PortfolioSiteStack(app, "PortfolioSiteStack", {
    hostedZoneId: ZONE_ID,
    siteDirectory: siteDirectory(),
    askFunctionUrl: assistant.functionUrl,
    env: TEST_ENV,
  });
  return {
    assistant,
    site,
    assistantTemplate: Template.fromStack(assistant),
    siteTemplate: Template.fromStack(site),
  };
}
