/**
 * Response headers for the static site. Pure values, shared with the web package's
 * browser tests, which load every production page under this exact policy.
 *
 * Derived from the production build (`pnpm build:site`):
 * - no <script> elements and no inline event handlers: script-src 'none'
 * - one same-origin stylesheet and no <style> elements: style-src-elem 'self'
 * - chart geometry in style="" attributes: style-src-attr 'unsafe-inline'
 *   (style-src keeps 'unsafe-inline' only as the fallback for browsers without CSP Level 3)
 * - self-hosted Archivo fonts: font-src 'self'
 * - the SVG favicon: img-src 'self'
 */
export const CONTENT_SECURITY_POLICY_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["default-src", "'none'"],
  ["script-src", "'none'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["style-src-elem", "'self'"],
  ["style-src-attr", "'unsafe-inline'"],
  ["font-src", "'self'"],
  ["img-src", "'self'"],
  ["connect-src", "'none'"],
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
