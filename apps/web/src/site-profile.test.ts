import { describe, expect, it } from "vitest";
import {
  assistantEnabled,
  isFixtureDocumentId,
  isProductionSite,
  shipsDocument,
  sitemapIncludes,
} from "./site-profile";

describe("build profile", () => {
  it("recognizes only the explicit production profile", () => {
    expect(isProductionSite({ PORTFOLIO_SITE: "production" })).toBe(true);
    expect(isProductionSite({})).toBe(false);
    expect(isProductionSite({ PORTFOLIO_SITE: "" })).toBe(false);
  });

  it("drops fixtures from the production site only", () => {
    expect(isFixtureDocumentId("fictional-lumen-harbor")).toBe(true);
    expect(isFixtureDocumentId("aws-sde-ii")).toBe(false);
    expect(shipsDocument("fictional-lumen-harbor", true)).toBe(false);
    expect(shipsDocument("fictional-lumen-harbor", false)).toBe(true);
    expect(shipsDocument("aws-sde-ii", true)).toBe(true);
    expect(sitemapIncludes("https://lucaselia.dev/work/fictional-lumen-harbor")).toBe(false);
    expect(sitemapIncludes("https://lucaselia.dev/experience/aws-sde-ii")).toBe(true);
  });

  it("enables the assistant only for a configured URL", () => {
    expect(assistantEnabled(undefined)).toBe(false);
    expect(assistantEnabled("")).toBe(false);
    expect(assistantEnabled("   ")).toBe(false);
    expect(assistantEnabled("http://127.0.0.1:8787/ask")).toBe(true);
  });
});
