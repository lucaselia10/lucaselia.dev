import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const widths = [1440, 1024, 768, 390, 360];
const HEADLINE = "I build dependable backend systems for complex, high-stakes planning problems.";

test("homepage desktop puts the assistant beside the hero and draws the career chart", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const headline = page.getByRole("heading", { level: 1, name: HEADLINE });
  await expect(headline).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask about my work" })).toBeVisible();
  await expect(page.getByRole("link", { name: "See my career" })).toBeVisible();
  const ask = page.locator("#ask");
  await expect(ask).toBeVisible();
  const headlineBox = await headline.boundingBox();
  const askBox = await ask.boundingBox();
  expect(askBox && headlineBox && askBox.x > headlineBox.x + headlineBox.width / 2).toBe(true);

  await expect(page.getByRole("heading", { level: 2, name: "How I got here" })).toBeVisible();
  await expect(page.locator(".chart-horizontal")).toBeVisible();
  await expect(page.locator(".chart-vertical")).toBeHidden();
  await expect(page.locator("#results")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "What changed" })).toHaveCount(0);
  await expect(page.getByText("Lumen Harbor")).toHaveCount(0);
  await expect(page.locator("#overview")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
});

test("homepage phone stacks the assistant under the introduction and turns the chart vertical", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const intro = page.locator(".hero-copy");
  const ask = page.locator("#ask");
  const career = page.locator("#career");
  const introBox = await intro.boundingBox();
  const askBox = await ask.boundingBox();
  const careerBox = await career.boundingBox();
  if (!introBox || !askBox || !careerBox) {
    throw new Error("The introduction, assistant, or career section is missing.");
  }
  expect(askBox.y).toBeGreaterThan(introBox.y + introBox.height - 1);
  expect(careerBox.y).toBeGreaterThan(askBox.y);
  await expect(page.getByRole("link", { name: "See my career" })).toBeHidden();
  await expect(page.locator(".chart-vertical")).toBeVisible();
  await expect(page.locator(".chart-horizontal")).toBeHidden();
  await expect(page.getByRole("list", { name: "Lanes" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
});

test("chart bars are links with a visible focus ring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const bar = page.locator(".chart-horizontal").getByRole("link", {
    name: "Software Development Engineer II, Amazon Web Services, December 2025 to now",
  });
  await bar.focus();
  await expect(bar).toBeFocused();
  const outline = await bar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline).toEqual({ style: "solid", width: "2px" });
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: "Software Development Engineer II" }),
  ).toBeVisible();
});

test("the hero action moves to the assistant", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const ask = page.getByRole("link", { name: "Ask about my work" });
  await ask.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#ask$/);
  await expect(page.locator("#ask")).toBeInViewport();
});

test("assistant renders when an ask API URL is configured", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/no API URL is configured/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "What have you built at AWS?" })).toBeEnabled();
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Ask" }),
  ).toBeVisible();
  // Default build: no model-only suggestion is offered.
  await expect(
    page.getByRole("button", { name: "How have you improved production reliability?" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(page.getByLabel("Your question")).toBeVisible();
  await expect(page.locator("#ask")).toHaveCount(1);
});

test("anchor navigation reaches experience without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("link", { name: "Experience", exact: true }).click();
  await expect(page.locator("#experience")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test("checked widths do not overflow, down to 360px", async ({ page }) => {
  for (const path of ["/", "/experience/aws-sde-ii", "/background/bloomtech-backend-development"]) {
    await page.goto(path);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("role page keeps its citation anchor, position strip, and compact assistant", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/experience/aws-sde-ii#role-description");
  await expect(page.locator("#role-description")).toBeVisible();
  await expect(page.locator("#role-description")).toHaveText("What I work on");
  await expect(
    page.getByRole("heading", { level: 1, name: "Software Development Engineer II" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "All experience" })).toBeVisible();
  await expect(page.locator(".position-strip")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Ask about this role" })).toBeVisible();
  await expect(page.locator("#ask")).toHaveCount(1);
  await expect(page.getByText("Last reviewed")).toHaveCount(0);
  await expectNoAxeViolations(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoAxeViolations(page);
});

test("the fictional fixture route remains available and off the homepage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Lumen Harbor")).toHaveCount(0);
  await page.goto("/work/fictional-lumen-harbor");
  await expect(
    page.getByRole("heading", { level: 1, name: "Lumen Harbor Signal Buoy" }),
  ).toBeVisible();
  await expect(page.getByText(/Fictional test document/)).toBeVisible();
  await expect(page.locator("#outcome")).toBeVisible();
  await expect(page.locator("#ask")).toHaveCount(0);
});

test("reduced motion leaves nothing animated", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const animated = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("*")).filter((element) => {
        const style = getComputedStyle(element);
        return style.animationName !== "none" || parseFloat(style.transitionDuration) > 0;
      }).length,
  );
  expect(animated).toBe(0);
});

test("the headline never breaks inside high-stakes", async ({ page }) => {
  for (const width of [1440, 1024, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const lines = await page
      .locator("h1 .nowrap")
      .evaluate((element) => element.getClientRects().length);
    expect(lines, `${width}px`).toBe(1);
    await expect(page.locator("h1 .nowrap")).toHaveText("high-stakes");
  }
});

test("a narrow chart box opens scrolled to Today", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/");
  const box = page.locator(".chart-horizontal");
  const overflows = await box.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflows).toBe(true);
  const boxRect = await box.boundingBox();
  const today = await page.locator(".chart-horizontal .axis-today").boundingBox();
  const recent = await page
    .locator(".chart-horizontal")
    .getByRole("link", { name: /Software Development Engineer II,/ })
    .boundingBox();
  if (!boxRect || !today || !recent) {
    throw new Error("chart geometry missing");
  }
  for (const rect of [today, recent]) {
    expect(rect.x).toBeGreaterThanOrEqual(boxRect.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(boxRect.x + boxRect.width + 1);
  }
});

test("wide bars carry their label inside in the surface color", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const inside = page.locator(".chart-horizontal .chart-label-inside");
  await expect(inside).toHaveText(["Engineer I, 2023–2025", "Co-Founder, 2008–2014"]);
  const color = await inside.first().evaluate((element) => getComputedStyle(element).color);
  expect(color).toBe("rgb(245, 247, 249)");
  // Below-bar labels stay on a single row in every lane.
  const tops = await page
    .locator(".chart-horizontal .chart-label:not(.chart-label-inside)")
    .evaluateAll((elements) => [
      ...new Set(elements.map((element) => (element as HTMLElement).style.top)),
    ]);
  expect(tops).toEqual(["39px"]);
});

test("the question field border meets 3:1 against the panel", async ({ page }) => {
  await page.goto("/");
  const colors = await page.evaluate(() => {
    const field = document.querySelector("#question");
    const panel = document.querySelector("#ask");
    if (!field || !panel) {
      return null;
    }
    return {
      border: getComputedStyle(field).borderTopColor,
      panel: getComputedStyle(panel).backgroundColor,
    };
  });
  if (!colors) {
    throw new Error("assistant missing");
  }
  expect(contrast(colors.border, colors.panel)).toBeGreaterThanOrEqual(3);
});

function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const channels = (color.match(/\d+/g) ?? []).slice(0, 3).map((value) => Number(value) / 255);
    const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}
