#!/usr/bin/env node
// Entry for the static site only. Used by `pnpm run deploy:site` through --app; the default
// cdk.json app (bin/app.ts) is the ask API and refuses site context.
import { createSiteApp } from "../lib/site-app";

createSiteApp();
