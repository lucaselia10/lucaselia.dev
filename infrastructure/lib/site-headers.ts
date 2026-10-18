/**
 * Response headers for the static site. Pure values, shared with the web package's
 * browser tests, which load every production page under this exact policy.
 *
 * Derived from the production build (`pnpm build:site`):
 * - the assistant island: Astro's two inline bootstrap scripts, allowed by exact hash, which
 *   load the island's modules from /_astro/ ('self'). No inline event handlers, no eval.
 *   The site build check refuses a build whose inline scripts are not in this list, so an
 *   Astro upgrade that changes them fails loudly instead of being blocked in browsers.
 * - the assistant posts to the same origin (/api/ask): connect-src 'self'
 * - one same-origin stylesheet, plus Astro's one inline island style
 *   (astro-island{display:contents}) by exact hash: style-src-elem 'self' 'sha256-…'
 * - chart geometry in style="" attributes: style-src-attr 'unsafe-inline'
 *   (style-src keeps 'unsafe-inline' only as the fallback for browsers without CSP Level 3)
 * - self-hosted Archivo fonts: font-src 'self'
 * - the SVG favicon: img-src 'self'
 */

/** SHA-256 (base64) of each inline script the production build may contain. */
export const INLINE_SCRIPT_HASHES = [
  "sha256-QzWFZi+FLIx23tnm9SBU4aEgx4x8DsuASP07mfqol/c=",
  "sha256-Ya0pUYrC7nM5Cn/056TyVuEiz6dFGrzmkWzgON0pF0U=",
] as const;

/** SHA-256 (base64) of each inline <style> element the production build may contain. */
export const INLINE_STYLE_HASHES = ["sha256-vv9IoKo7BSLbWcUHr3tNmfNVmm5L/9Cfn2H6LMk7/ow="] as const;

export const CONTENT_SECURITY_POLICY_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["default-src", "'none'"],
  ["script-src", ["'self'", ...INLINE_SCRIPT_HASHES.map((hash) => `'${hash}'`)].join(" ")],
  ["style-src", "'self' 'unsafe-inline'"],
  ["style-src-elem", ["'self'", ...INLINE_STYLE_HASHES.map((hash) => `'${hash}'`)].join(" ")],
  ["style-src-attr", "'unsafe-inline'"],
  ["font-src", "'self'"],
  ["img-src", "'self'"],
  ["connect-src", "'self'"],
  ["manifest-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
  ["frame-ancestors", "'none'"],
  ["upgrade-insecure-requests", ""],
];

export const CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY_DIRECTIVES.map(([name, value]) =>
  value === "" ? name : `${name} ${value}`,
).join("; ");

/** Denies powerful features the site never uses. */
export const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), browsing-topics=()";

/** Two years, in seconds. */
export const HSTS_MAX_AGE_SECONDS = 2 * 365 * 24 * 60 * 60;
