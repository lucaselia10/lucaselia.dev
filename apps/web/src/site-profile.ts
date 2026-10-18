/**
 * Build profiles. The production site (PORTFOLIO_SITE=production, used by `pnpm build:site`)
 * leaves out test fixtures, and the assistant is shown only when PUBLIC_ASK_API_URL is set.
 * Every other build keeps the fixture so tests and development can reach it.
 */

export const SITE_URL = "https://lucaselia.dev";

type Env = Readonly<Record<string, string | undefined>>;

export function isProductionSite(env: Env = process.env): boolean {
  return env.PORTFOLIO_SITE === "production";
}

/** Test fixtures use the "fictional-" id prefix (for example, Lumen Harbor). */
export function isFixtureDocumentId(id: string): boolean {
  return id.startsWith("fictional-");
}

/** Whether a document gets a page in this build. */
export function shipsDocument(id: string, production: boolean): boolean {
  return !(production && isFixtureDocumentId(id));
}

/** The assistant renders only when an ask API URL is configured. */
export function assistantEnabled(askApiUrl: string | undefined): boolean {
  return (askApiUrl ?? "").trim() !== "";
}

/** Whether a sitemap URL belongs in the sitemap: never a fixture page. */
export function sitemapIncludes(url: string): boolean {
  return !/\/[a-z]+\/fictional-/.test(new URL(url).pathname);
}
