import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { CONTENT_SECURITY_POLICY } from "../../../infrastructure/lib/site-headers";

// The production build (`pnpm build:site`): no assistant, no fixture, contact, and the
// exact Content-Security-Policy CloudFront sends.

const HEADLINE = "I build dependable backend systems for complex, high-stakes planning problems.";
const widths = [1440, 1024, 390, 360];

test("the hero is one deliberate column with career and contact actions", async ({ page }) => {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const headline = page.getByRole("heading", { level: 1, name: HEADLINE });
    await expect(headline).toBeVisible();
    await expect(page.locator(".hero-solo")).toHaveCount(1);
    await expect(page.locator("#ask")).toHaveCount(0);
    await expect(page.getByText("Ask about my work")).toHaveCount(0);
    await expect(page.getByText(/no API URL is configured/)).toHaveCount(0);
    const primary = page.locator(".hero .button-primary");
    const secondary = page.locator(".hero .button-secondary");
    await expect(primary).toHaveText("See my career");
    await expect(primary).toHaveAttribute("href", "#career");
    await expect(secondary).toHaveText("Contact");
    await expect(secondary).toHaveAttribute("href", "#contact");
    await expect(secondary).toBeVisible();
    // The headline keeps a reading measure: no wider than the page column.
    const box = await headline.boundingBox();
    expect(box && box.width <= width - 32).toBe(true);
    expect(await headline.locator(".nowrap").evaluate((node) => node.getClientRects().length)).toBe(
      1,
    );
    await expectNoHorizontalOverflow(page);
  }
});

test("navigation has Contact and no Ask", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link")).toHaveText(["Career", "Experience", "Contact"]);
  await page.goto("/experience/aws-sde-ii");
  await expect(nav.getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/#contact");
  await expect(nav.getByRole("link", { name: "Ask" })).toHaveCount(0);
});

test("contact links are real links with visible focus", async ({ page }) => {
  await page.goto("/");
  const contact = page.locator("#contact");
  await expect(contact.getByRole("heading", { level: 2, name: "Contact" })).toBeVisible();
  await expect(
    contact.getByText("The best way to reach me is email. I’m also on LinkedIn and GitHub."),
  ).toBeVisible();
  const email = contact.getByRole("link", { name: "Email" });
  await expect(email).toHaveAttribute("href", "mailto:alexanderlucaselia@gmail.com");
  for (const [name, href] of [
    ["LinkedIn", "https://www.linkedin.com/in/lucaselia"],
    ["GitHub", "https://github.com/lucaselia10"],
  ] as const) {
    const link = contact.getByRole("link", { name });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("rel", "noopener");
  }
  await email.focus();
  const outline = await email.evaluate((node) => getComputedStyle(node).outlineStyle);
  expect(outline).toBe("solid");
});

test("role pages have no Ask box and keep their citation anchors", async ({ page }) => {
  await page.goto("/experience/aws-sde-ii#role-description");
  await expect(page.locator("#role-description")).toBeVisible();
  await expect(page.locator(".position-strip")).toBeVisible();
  await expect(page.locator("#ask")).toHaveCount(0);
  await expect(page.getByText("Ask about this role")).toHaveCount(0);
});

test("the fixture is not part of the site", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText(/Lumen Harbor/)).toHaveCount(0);
  const fixture = await request.get("/work/fictional-lumen-harbor");
  expect(fixture.status()).toBe(404);
  const index = await request.get("/career-index.json");
  expect(index.status()).toBe(404);
  const sitemap = await (await request.get("/sitemap-0.xml")).text();
  expect(sitemap).not.toContain("fictional");
});

test("the 404 page is styled and not indexed", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { level: 1, name: "This page is not on the plan." }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await expect(page.getByRole("link", { name: "Go to the homepage" })).toHaveAttribute("href", "/");
});

test("every page has a title, description, canonical URL, Open Graph tags, and the favicon", async ({
  page,
  request,
}) => {
  for (const path of await sitemapPaths(request)) {
    await page.goto(path);
    const canonical = `https://lucaselia.dev${path === "/" ? "/" : path}`;
    expect(await page.title()).not.toBe("");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /.+/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonical);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /.+/);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  }
  expect((await request.get("/favicon.svg")).status()).toBe(200);
  expect(await (await request.get("/robots.txt")).text()).toContain(
    "Sitemap: https://lucaselia.dev/sitemap-index.xml",
  );
});

test("every page loads under the production Content-Security-Policy", async ({ page, request }) => {
  const violations: string[] = [];
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": CONTENT_SECURITY_POLICY },
    });
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });

  for (const path of [...(await sitemapPaths(request)), "/no-such-page"]) {
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    const reported = await page.evaluate(
      () => (window as unknown as { __csp?: string[] }).__csp ?? [],
    );
    violations.push(...reported.map((entry) => `${path}: ${entry}`));
    // Chart geometry comes from style attributes, which the policy allows.
    if (path === "/") {
      const width = await page
        .locator(".chart-horizontal .chart-bar")
        .first()
        .evaluate((node) => (node as HTMLElement).getBoundingClientRect().width);
      expect(width).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.fonts.check('16px "Archivo Variable"'))).toBe(true);
    }
  }
  expect(violations).toEqual([]);
});

test("production pages pass axe at desktop and phone widths", async ({ page }) => {
  for (const path of ["/", "/experience/aws-sde-ii", "/background/bloomtech-backend-development"]) {
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, `${path} at ${width}px`).toEqual([]);
      await expectNoHorizontalOverflow(page);
    }
  }
});

async function sitemapPaths(request: {
  get: (url: string) => Promise<{ text: () => Promise<string> }>;
}) {
  const xml = await (await request.get("/sitemap-0.xml")).text();
  return [...xml.matchAll(/<loc>https:\/\/lucaselia\.dev([^<]*)<\/loc>/g)].map(
    (match) => match[1] || "/",
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

// Keep the compiled policy and the shipped HTML from drifting apart unnoticed.
test("the policy forbids scripts and inline style elements", () => {
  expect(CONTENT_SECURITY_POLICY).toContain("script-src 'none'");
  expect(CONTENT_SECURITY_POLICY).toContain("style-src-elem 'self'");
  const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "global.css"), "utf8");
  expect(css).not.toMatch(/url\(\s*["']?https?:/);
});
