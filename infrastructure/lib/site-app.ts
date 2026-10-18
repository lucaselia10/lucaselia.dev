import { existsSync } from "node:fs";
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
 * Context: siteHostedZoneId (required), anthropicSecretName and anthropicModelId (optional).
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
  assertPrepared(lambdaAssetPath, webAdapterLayerPath);

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

/** Synthesis needs the staged Lambda asset and the verified adapter layer. */
export function assertPrepared(lambdaAssetPath: string, webAdapterLayerPath: string): void {
  if (!existsSync(join(lambdaAssetPath, "run.sh"))) {
    throw new Error(`No staged Lambda asset at ${lambdaAssetPath}. Run "pnpm prepare:api".`);
  }
  for (const required of ["bootstrap", join("extensions", "lambda-adapter")]) {
    if (!existsSync(join(webAdapterLayerPath, required))) {
      throw new Error(
        `The Lambda Web Adapter layer is missing ${required}. Run "pnpm prepare:web-adapter".`,
      );
    }
  }
}

function optionalContext(app: cdk.App, key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
