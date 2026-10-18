#!/usr/bin/env node
// The project's CDK app: PortfolioAssistantStack and PortfolioSiteStack. Deploys are user-run
// (`pnpm run deploy:site`), which pass -c siteHostedZoneId.
import { createSiteApp } from "../lib/site-app";

createSiteApp();
