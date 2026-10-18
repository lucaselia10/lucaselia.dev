import { rm } from "node:fs/promises";
import react from "@astrojs/react";
import { satteri } from "@astrojs/markdown-satteri";
import sitemap from "@astrojs/sitemap";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";
import { citationHeadingIds } from "./src/citation-heading-ids.ts";
import { SITE_URL, isProductionSite, sitemapIncludes } from "./src/site-profile.ts";

const production = isProductionSite();

/**
 * The production build does not ship the full career index (it lists the fictional
 * fixture and is only used by the ask API and tests).
 */
function productionOutput(): AstroIntegration {
  return {
    name: "portfolio-production-output",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        if (production) {
          await rm(new URL("career-index.json", dir), { force: true });
        }
      },
    },
  };
}

export default defineConfig({
  output: "static",
  site: SITE_URL,
  // Links and canonical URLs have no trailing slash. Pages are emitted as
  // <path>/index.html, which the CloudFront viewer-request function serves.
  trailingSlash: "never",
  build: {
    format: "directory",
    // External stylesheets only, so the Content-Security-Policy needs no inline <style>.
    inlineStylesheets: "never",
  },
  outDir: process.env.ASTRO_OUT_DIR ?? "./dist",
  integrations: [react(), sitemap({ filter: sitemapIncludes }), productionOutput()],
  markdown: {
    processor: satteri({
      hastPlugins: [citationHeadingIds],
    }),
  },
});
