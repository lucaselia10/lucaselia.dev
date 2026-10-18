import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { PortfolioSiteStack, SITE_REGION, SITE_STACK_NAME } from "./portfolio-site-stack";
import { assertProductionBuild } from "./site-build-check";

export const DEFAULT_SITE_DIRECTORY = join(import.meta.dirname, "..", "..", "apps", "web", "dist");

export interface SiteAppOptions {
  app?: cdk.App;
  siteDirectory?: string;
  /** Tests that synthesize from a temporary directory may skip the production-build check. */
  skipBuildCheck?: boolean;
}

/**
 * The site's own CDK app. It can only ever contain PortfolioSiteStack: it does not import
 * the ask API stack, so a site synth or deploy cannot reach the Lambda, Knowledge Base,
 * or S3 Vectors resources.
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
  new PortfolioSiteStack(app, SITE_STACK_NAME, {
    hostedZoneId: hostedZoneId.trim(),
    siteDirectory,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: SITE_REGION },
    description: "lucaselia.dev static portfolio (S3, CloudFront, ACM, Route 53)",
  });
  return app;
}
