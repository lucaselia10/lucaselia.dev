/**
 * Build profiles. The production site (PORTFOLIO_SITE=production, used by `pnpm build:site`)
 * leaves out test fixtures and always has the assistant: same-origin `/api/ask`, streamed,
 * without development details (ADR-009). Every other build keeps the fixture, and shows the
 * assistant only when PUBLIC_ASK_API_URL is set.
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

/** The production ask API: same origin, served by CloudFront from the function URL. */
export const PRODUCTION_ASK_API_URL = "/api/ask";

export type AssistantConfig = {
  /** Empty when the assistant is off. */
  askApiUrl: string;
  modelStreaming: boolean;
  /** Token counts and cost estimates, for the local server only. */
  developmentDetails: boolean;
};

export function assistantConfig(env: Env, production = isProductionSite(env)): AssistantConfig {
  if (production) {
    return { askApiUrl: PRODUCTION_ASK_API_URL, modelStreaming: true, developmentDetails: false };
  }
  return {
    askApiUrl: (env.PUBLIC_ASK_API_URL ?? "").trim(),
    modelStreaming: env.PUBLIC_ASK_STREAMING === "true",
    developmentDetails: true,
  };
}

/** The assistant renders only when an ask API URL is configured. */
export function assistantEnabled(askApiUrl: string | undefined): boolean {
  return (askApiUrl ?? "").trim() !== "";
}

/** Whether a sitemap URL belongs in the sitemap: never a fixture page. */
export function sitemapIncludes(url: string): boolean {
  return !/\/[a-z]+\/fictional-/.test(new URL(url).pathname);
}
