import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  CONTENT_SECURITY_POLICY,
  INLINE_SCRIPT_HASHES,
  INLINE_STYLE_HASHES,
} from "../../../infrastructure/lib/site-headers";
import { STREAM_CITATION, STREAM_PARTS, type ReceivedRequest } from "./mock-ask";

// The production build (`pnpm build:site`): the assistant on /api/ask, no fixture, contact,
// and the exact Content-Security-Policy CloudFront sends.

const HEADLINE = "I build dependable backend systems for complex, high-stakes planning problems.";
const widths = [1440, 1024, 390, 360];

test("the hero carries the assistant with ask and career actions", async ({ page }) => {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const headline = page.getByRole("heading", { level: 1, name: HEADLINE });
    await expect(headline).toBeVisible();
    await expect(page.locator(".hero-solo")).toHaveCount(0);
    await expect(page.locator("#ask")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 2, name: "Ask about my work" })).toBeVisible();
    await expect(
      page.locator("#ask").getByText("Questions and answers aren't saved."),
    ).toBeVisible();
    await expect(page.getByText(/no API URL is configured/)).toHaveCount(0);
    const primary = page.locator(".hero .button-primary");
    const secondary = page.locator(".hero .button-secondary");
    await expect(primary).toHaveText("Ask about my work");
    await expect(primary).toHaveAttribute("href", "#ask");
    await expect(secondary).toHaveText("See my career");
    await expect(secondary).toHaveAttribute("href", "#career");
    const box = await headline.boundingBox();
    expect(box && box.width <= width - 32).toBe(true);
    expect(await headline.locator(".nowrap").evaluate((node) => node.getClientRects().length)).toBe(
      1,
    );
    await expectNoHorizontalOverflow(page);
  }
});

test("navigation has Ask and Contact", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link")).toHaveText(["Career", "Experience", "Ask", "Contact"]);
  await expect(nav.getByRole("link", { name: "Ask" })).toHaveAttribute("href", "#ask");
  await page.goto("/experience/aws-sde-ii");
  await expect(nav.getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/#contact");
  await expect(nav.getByRole("link", { name: "Ask" })).toHaveAttribute("href", "#ask");
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

test("role pages have an Ask box and keep their citation anchors", async ({ page }) => {
  await page.goto("/experience/aws-sde-ii#role-description");
  await expect(page.locator("#role-description")).toBeVisible();
  await expect(page.locator(".position-strip")).toBeVisible();
  await expect(page.locator("#ask")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Ask about this role" })).toBeVisible();
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
  const violations = await enforceProductionPolicy(page);

  for (const path of [...(await sitemapPaths(request)), "/no-such-page"]) {
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    // The island hydrated: its inline bootstrap ran and its module loaded under the policy.
    if (path !== "/no-such-page") {
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
      await expect(page.locator("astro-island[ssr]")).toHaveCount(0);
    }
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

test.describe("the assistant against a mocked /api/ask", () => {
  test("streams the answer progressively, then links its citation, with no CSP violation", async ({
    page,
    request,
  }) => {
    // The preview server's own /api/ask streams with delays (e2e/preview-server.ts).
    const violations = await enforceProductionPolicy(page);
    await page.goto("/");
    await ask(page, "What does Lucas work on?");

    const panel = page.locator("#ask");
    const answer = panel.locator(".answer-copy");
    await expect(answer).toHaveText(STREAM_PARTS[0]?.trim() ?? "");
    // The second chunk is still on its way: text appears in steps, not all at once.
    await expect(answer).not.toContainText(STREAM_PARTS[1] ?? "");
    await expect(panel.locator(".citation-card")).toHaveCount(0);
    await expect(answer).toHaveText(STREAM_PARTS.join(""));

    const citation = panel.getByRole("link", { name: STREAM_CITATION.title });
    await expect(citation).toHaveAttribute("href", STREAM_CITATION.url);
    await expect(panel.getByText(/Tokens:|Estimated cost/)).toHaveCount(0);
    await expect(panel.getByRole("status")).toHaveText("Answer ready.");

    const received = (await (await request.get("/__mock/received")).json()) as ReceivedRequest[];
    const sent = received.at(-1);
    expect(sent?.headers["x-amz-content-sha256"]).toBe(sent?.bodySha256);
    expect(sent?.headers.accept).toBe("application/x-ndjson");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      question: "What does Lucas work on?",
      mode: "career_question",
    });

    await citation.click();
    await expect(page).toHaveURL(/\/experience\/aws-sde-ii#role-description$/);
    expect(violations).toEqual([]);
  });

  const failures = [
    {
      name: "an invalid request (400)",
      status: 400,
      body: {},
      message: "The question couldn't be sent. Please rephrase it and try again.",
      retry: true,
    },
    {
      name: "a body over the limit (413)",
      status: 413,
      body: {},
      message: "The question is too long.",
      retry: true,
    },
    {
      name: "the WAF rate limit (429 rate_limited)",
      status: 429,
      body: {
        message: "Too many questions in a short time. Please wait a few minutes.",
        code: "rate_limited",
      },
      message: "Too many questions in a short time. Please wait a few minutes.",
      retry: true,
    },
    {
      name: "a busy model (429 busy)",
      status: 429,
      body: { code: "busy" },
      message: "The career assistant is busy. Please try again in a minute.",
      retry: true,
    },
    {
      name: "a paused assistant (503 paused)",
      status: 503,
      body: { code: "paused" },
      message: "The career assistant is paused for now. The career pages are still here.",
      retry: false,
    },
    {
      name: "a CloudFront error page (502)",
      status: 502,
      body: null,
      message: "The career assistant is temporarily unavailable.",
      retry: true,
    },
  ];
  for (const failure of failures) {
    test(`shows its own message for ${failure.name}`, async ({ page }) => {
      const violations = await enforceProductionPolicy(page);
      await page.route("**/api/ask", (route) =>
        route.fulfill(
          failure.body === null
            ? { status: failure.status, contentType: "text/html", body: "<h1>502 Bad Gateway</h1>" }
            : {
                status: failure.status,
                contentType: "application/json",
                body: JSON.stringify({ ...failure.body, requestId: "req-1" }),
              },
        ),
      );
      await page.goto("/");
      await ask(page, "What does Lucas work on?");

      const alert = page.getByRole("alert");
      await expect(alert).toContainText(failure.message);
      await expect(alert).not.toContainText("Bad Gateway");
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
        failure.retry ? 1 : 0,
      );
      if (!failure.retry) {
        await expect(page.getByLabel("Your question")).toBeDisabled();
        await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
      }
      expect(violations).toEqual([]);
    });
  }

  test("shows the network message when the request cannot reach the API", async ({ page }) => {
    await page.route("**/api/ask", (route) => route.abort("internetdisconnected"));
    await page.goto("/");
    await ask(page, "What does Lucas work on?");
    await expect(page.getByRole("alert")).toHaveText("The career assistant could not be reached.");
  });

  test("counts characters and stops at 500", async ({ page }) => {
    await page.goto("/");
    const field = page.getByLabel("Your question");
    await expect(page.getByText("0 / 500 characters")).toBeVisible();
    await field.fill("x".repeat(600));
    await expect(field).toHaveValue("x".repeat(500));
    await expect(page.getByText("500 / 500 characters")).toBeVisible();
  });

  test("an answered conversation passes axe at desktop and phone widths", async ({ page }) => {
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await ask(page, "What does Lucas work on?");
      await expect(
        page.locator("#ask").getByRole("link", { name: STREAM_CITATION.title }),
      ).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, `answer at ${width}px`).toEqual([]);
      await expectNoHorizontalOverflow(page);
    }
  });
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

async function ask(page: Page, question: string) {
  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
}

/** Serve every page with the exact production CSP and collect any violation. */
async function enforceProductionPolicy(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": CONTENT_SECURITY_POLICY },
    });
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
  return violations;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

// Keep the compiled policy and the shipped HTML from drifting apart unnoticed.
test("the policy allows only same-origin scripts, the pinned inline ones, and same-origin fetches", () => {
  const scripts = INLINE_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ");
  const styles = INLINE_STYLE_HASHES.map((hash) => `'${hash}'`).join(" ");
  expect(CONTENT_SECURITY_POLICY).toContain(`script-src 'self' ${scripts};`);
  expect(CONTENT_SECURITY_POLICY).toContain(`style-src-elem 'self' ${styles};`);
  expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self';");
  expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "global.css"), "utf8");
  expect(css).not.toMatch(/url\(\s*["']?https?:/);
});
