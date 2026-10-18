#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CareerPortfolioStack } from "../lib/career-portfolio-stack";
import { APPLICATION_REGION, assertTargetRegion } from "../lib/grounding-resources";

const app = new cdk.App();
// Hard gate: the site deploy passes siteHostedZoneId. If that context reaches this app (the
// ask API), the command was pointed at the wrong app, so stop before synthesizing anything.
if (app.node.tryGetContext("siteHostedZoneId") !== undefined) {
  throw new Error(
    "This is the ask API app. Deploy the static site with `pnpm run deploy:site`, which uses bin/site.ts.",
  );
}
assertTargetRegion(process.env.CDK_DEFAULT_REGION);
const contextRegion: unknown = app.node.tryGetContext("targetRegion");
if (typeof contextRegion === "string") {
  assertTargetRegion(contextRegion);
}
new CareerPortfolioStack(app, "CareerPortfolioStack", {
  env: {
    region: APPLICATION_REGION,
  },
});
