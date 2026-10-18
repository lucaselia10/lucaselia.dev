import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import {
  ASSISTANT_REGION,
  ASSISTANT_STACK_NAME,
  DEFAULT_LAMBDA_ASSET,
  DEFAULT_WEB_ADAPTER_LAYER,
  PortfolioAssistantStack,
} from "./portfolio-assistant-stack";
import { PortfolioSiteStack, SITE_REGION, SITE_STACK_NAME } from "./portfolio-site-stack";
import { assertProductionBuild } from "./site-build-check";
import { WEB_ADAPTER_BINARY_SHA256, WEB_ADAPTER_STUB } from "./web-adapter-pin";

export const DEFAULT_SITE_DIRECTORY = join(import.meta.dirname, "..", "..", "apps", "web", "dist");

export interface SiteAppOptions {
  app?: cdk.App;
  siteDirectory?: string;
  lambdaAssetPath?: string;
  webAdapterLayerPath?: string;
  /** Tests that synthesize from a temporary directory may skip the production-build check. */
  skipBuildCheck?: boolean;
}

/**
 * The project's one CDK app: PortfolioAssistantStack (the ask function) and
 * PortfolioSiteStack (the site and its CloudFront distribution, which serves /api/* from that
 * function). Both are in us-east-1, so the function URL is an ordinary cross-stack reference.
 *
 * Context: siteHostedZoneId (required), anthropicSecretName and anthropicModelId (optional),
 * and webAdapterStub=allow, which only the CI synth passes: it accepts the stub adapter layer
 * for a synth that will never be deployed. Without it, the layer must be the pinned binary,
 * so `pnpm run deploy:site`, `diff:site`, and a bare `cdk deploy` all refuse the stub.
 */
export function createSiteApp(options: SiteAppOptions = {}): cdk.App {
  const app = options.app ?? new cdk.App();
  const hostedZoneId: unknown = app.node.tryGetContext("siteHostedZoneId");
  if (typeof hostedZoneId !== "string" || hostedZoneId.trim() === "") {
    throw new Error(
      "Pass the Route 53 hosted zone id at deploy time: -c siteHostedZoneId=Z0123456789ABC",
    );
  }
  const siteDirectory = options.siteDirectory ?? DEFAULT_SITE_DIRECTORY;
  if (!options.skipBuildCheck) {
    assertProductionBuild(siteDirectory);
  }
  const lambdaAssetPath = options.lambdaAssetPath ?? DEFAULT_LAMBDA_ASSET;
  const webAdapterLayerPath = options.webAdapterLayerPath ?? DEFAULT_WEB_ADAPTER_LAYER;
  assertPrepared(lambdaAssetPath, webAdapterLayerPath, {
    allowStub: app.node.tryGetContext("webAdapterStub") === "allow",
  });

  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const assistant = new PortfolioAssistantStack(app, ASSISTANT_STACK_NAME, {
    secretName: optionalContext(app, "anthropicSecretName"),
    modelId: optionalContext(app, "anthropicModelId"),
    lambdaAssetPath,
    webAdapterLayerPath,
    env: { account, region: ASSISTANT_REGION },
    description: "lucaselia.dev career assistant (streaming Lambda function URL)",
  });
  new PortfolioSiteStack(app, SITE_STACK_NAME, {
    hostedZoneId: hostedZoneId.trim(),
    siteDirectory,
    askFunctionUrl: assistant.functionUrl,
    env: { account, region: SITE_REGION },
    description: "lucaselia.dev portfolio (S3, CloudFront, WAF, ACM, Route 53)",
  });
  return app;
}

export interface PreparedOptions {
  /** Accept the CI stub layer. Never set for a deploy. */
  allowStub?: boolean;
  /** The pinned SHA-256 of the adapter binary; tests pass their own. */
  binarySha256?: string;
}

/**
 * Synthesis needs the staged Lambda asset and an adapter layer whose binary is the pinned
 * release (or, only with allowStub, the exact CI stub).
 */
export function assertPrepared(
  lambdaAssetPath: string,
  webAdapterLayerPath: string,
  options: PreparedOptions = {},
): void {
  if (!existsSync(join(lambdaAssetPath, "run.sh"))) {
    throw new Error(`No staged Lambda asset at ${lambdaAssetPath}. Run "pnpm prepare:api".`);
  }
  const binary = join(webAdapterLayerPath, "extensions", "lambda-adapter");
  if (!existsSync(join(webAdapterLayerPath, "bootstrap")) || !existsSync(binary)) {
    throw new Error(
      `The Lambda Web Adapter layer is missing at ${webAdapterLayerPath}. Run "pnpm prepare:web-adapter".`,
    );
  }
  const bytes = readFileSync(binary);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual === (options.binarySha256 ?? WEB_ADAPTER_BINARY_SHA256)) {
    return;
  }
  if (options.allowStub === true && bytes.toString("utf8") === WEB_ADAPTER_STUB) {
    return;
  }
  const what =
    bytes.toString("utf8") === WEB_ADAPTER_STUB ? "the CI stub" : "not the pinned binary";
  throw new Error(
    `The Lambda Web Adapter layer at ${webAdapterLayerPath} is ${what} (SHA-256 ${actual}). Run "pnpm prepare:web-adapter" before diff or deploy.`,
  );
}

function optionalContext(app: cdk.App, key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
