/**
 * The build environment for pages: PORTFOLIO_SITE from the process, PUBLIC_* as Vite exposes
 * them. Only for .astro files; astro.config.mts and tests use site-profile.ts directly.
 */
export function siteEnv(): Readonly<Record<string, string | undefined>> {
  return {
    PORTFOLIO_SITE: process.env.PORTFOLIO_SITE,
    PUBLIC_ASK_API_URL: import.meta.env.PUBLIC_ASK_API_URL,
    PUBLIC_ASK_STREAMING: import.meta.env.PUBLIC_ASK_STREAMING,
  };
}
