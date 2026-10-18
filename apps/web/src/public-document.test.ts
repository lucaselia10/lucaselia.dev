import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { citationUrl } from "@career-portfolio/content";
import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri";
import { beforeAll, describe, expect, it } from "vitest";
import { citationHeadingIds } from "./citation-heading-ids";

// Two builds, one after the other (they share generated files): the development profile
// with an ask URL, and the production site exactly as `pnpm build:site` makes it.
const DEV_OUT = "dist-test";
const SITE_OUT = "dist-site-test";
const dev = (...parts: string[]) => join(process.cwd(), DEV_OUT, ...parts);
const site = (...parts: string[]) => join(process.cwd(), SITE_OUT, ...parts);

const projectPage = dev("work", "fictional-lumen-harbor", "index.html");
const profilePage = dev("profile", "lucas-elia", "index.html");
const experiencePage = dev("experience", "aws-sde-ii", "index.html");
const homePage = dev("index.html");
const careerIndex = dev("career-index.json");

function build(outDir: string, overrides: Record<string, string>): void {
  execFileSync("pnpm", ["run", "build"], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ASTRO_OUT_DIR: outDir, PUBLIC_ASK_STREAMING: "", ...overrides },
  });
}

beforeAll(() => {
  build(DEV_OUT, { PUBLIC_ASK_API_URL: "http://127.0.0.1:9/ask", PORTFOLIO_SITE: "" });
  build(SITE_OUT, { PUBLIC_ASK_API_URL: "", PORTFOLIO_SITE: "production" });
}, 240_000);

describe("public document rendering", () => {
  it("renders the fictional project from the shared public corpus", () => {
    const html = readFileSync(projectPage, "utf8");

    expect(html).toContain("Lumen Harbor Signal Buoy");
    expect(html).toContain(
      "A fictional harbor buoy used only to prove that public document schema validation works.",
    );
    expect(html).toContain("completed");
    expect(html).toContain("Markdown");
    expect(html).toContain(
      "Validation can accept this file and reject documents that break the public schema.",
    );
    expect(html).toMatch(/<h2[^>]*id="outcome"[^>]*>Outcome<\/h2>/);
  });

  it("resolves the outcome citation anchor", () => {
    const html = readFileSync(projectPage, "utf8");
    const citation = citationUrl("project", "fictional-lumen-harbor", "Outcome");

    expect(citation).toBe("/work/fictional-lumen-harbor#outcome");
    expect(html).toContain(`id="${citation.split("#")[1]}"`);
    const index = JSON.parse(readFileSync(careerIndex, "utf8")) as {
      schemaVersion: number;
      documents: Array<{ id: string; visibility: string }>;
      sources: Array<{ url: string }>;
    };
    expect(index.schemaVersion).toBe(1);
    expect(index.documents.map((document) => document.id)).toEqual([
      "aws-sde-apprentice",
      "aws-sde-i",
      "aws-sde-ii",
      "bloomtech-backend-development",
      "expert-assist-consultant",
      "fictional-lumen-harbor",
      "hospitality-businesses-co-founder",
      "lucas-elia",
      "sierra-college-general-studies",
    ]);
    expect(index.documents.every((document) => document.visibility === "public")).toBe(true);
    expect(index.sources.some((source) => source.url === citation)).toBe(true);
    expect(JSON.stringify(index)).not.toContain("draft");
  });

  it("renders the profile and current role without internal metadata rows", () => {
    const profile = readFileSync(profilePage, "utf8");
    const experience = readFileSync(experiencePage, "utf8");
    const visible = experience.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    expect(profile).toContain("Lucas Elia");
    expect(profile).toMatch(/<h2[^>]*id="about"[^>]*>About<\/h2>/);
    expect(visible).toContain("All experience");
    expect(visible).toContain("Amazon Web Services, Seattle, WA");
    expect(visible).toContain("December 2025 to now, full-time");
    expect(experience).toMatch(/<h2[^>]*id="role-description"[^>]*>What I work on<\/h2>/);
    expect(visible).toContain("Technologies");
    expect(visible).toContain(
      "Java, Python, TypeScript, mathematical optimization solvers, AWS CDK, Lambda, Step Functions, ECS, AWS Batch, DynamoDB, S3, and CloudWatch.",
    );
    expect(visible).toContain("Earlier role: Software Development Engineer I");
    expect(visible).toContain("This is my current role.");
    expect(experience).toContain('class="position-strip"');
    expect(experience).toContain("This role, within my career so far");
    expect(experience.match(/id="ask"/g)).toHaveLength(1);
    expect(visible).toContain("Ask about this role");
    // Default build: deterministic suggestions only.
    expect(visible).toContain("What did you do as Software Development Engineer II?");
    expect(visible).not.toContain("What does the capacity-planning platform do?");
    for (const page of [profile, experience]) {
      expect(page).not.toContain("Last reviewed");
      expect(page).not.toContain("Visibility");
      expect(page).not.toContain("<dt>Type</dt>");
    }
  });

  it("renders the remaining employment history and omits an unspecified location", () => {
    const pages = [
      ["aws-sde-i", "Software Development Engineer I", "Amazon Web Services, Seattle, WA"],
      [
        "aws-sde-apprentice",
        "Software Development Engineer Apprentice",
        "Amazon Web Services, Seattle, WA",
      ],
      [
        "hospitality-businesses-co-founder",
        "Co-Founder",
        "Bloom Coffee &amp; Tea, Pause Lounge &amp; Kitchen, and Broadacre Coffee, Sacramento, CA",
      ],
    ] as const;

    for (const [id, title, meta] of pages) {
      const html = readFileSync(dev("experience", id, "index.html"), "utf8");
      expect(html).toContain(title);
      expect(html).toContain(meta);
      expect(html).toMatch(/<h2[^>]*id="role-description"[^>]*>What I worked on<\/h2>/);
    }

    const unspecified = readFileSync(
      dev("experience", "expert-assist-consultant", "index.html"),
      "utf8",
    );
    expect(unspecified).toContain("<p>Expert Assist</p>");
    expect(unspecified).toContain("Java Developer, Office 365 &amp; SharePoint Consultant");
    expect(
      unspecified.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " "),
    ).not.toMatch(/\bnull\b/);
    // The summary is the lead; a bullet that repeats it is not shown twice. The other two
    // copies are the meta description and og:description.
    const visibleText = unspecified.replace(/<head>[\s\S]*<\/head>/, "");
    expect(
      visibleText.match(
        /Contributed to the Java backend of an electric-vehicle charging application/g,
      ),
    ).toHaveLength(1);
    expect(unspecified).not.toContain("Not specified");
    expect(unspecified).toMatch(/<h2[^>]*id="role-description"[^>]*>What I worked on<\/h2>/);
  });

  it("renders education background facts as plain lines", () => {
    const bloomtech = readFileSync(
      dev("background", "bloomtech-backend-development", "index.html"),
      "utf8",
    );
    const sierra = readFileSync(
      dev("background", "sierra-college-general-studies", "index.html"),
      "utf8",
    );

    expect(bloomtech).toContain("<p>BloomTech</p>");
    expect(bloomtech).toContain("Backend Development");
    expect(bloomtech.replace(/\s+/g, " ")).toContain(
      "October 2021 to August 2022. Completed, no degree awarded.",
    );
    expect(bloomtech).toMatch(/<h2[^>]*id="program"[^>]*>Program<\/h2>/);
    expect(bloomtech).toContain("All education");
    expect(bloomtech).toContain("<span>This program, within my career so far</span>");
    expect(bloomtech).toMatch(/aria-label="This program, October 2021 to August 2022, within/);
    expect(bloomtech).not.toContain("This role, within");
    expect(sierra).toContain("<p>Sierra College</p>");
    expect(sierra.replace(/\s+/g, " ")).toContain(
      "August 2006 to May 2008. Attended, no degree awarded.",
    );
    expect(sierra).toMatch(/<h2[^>]*id="coursework"[^>]*>Coursework<\/h2>/);
  });

  it("keeps the fictional fixture free of the assistant and the career chart", () => {
    const html = readFileSync(projectPage, "utf8");

    expect(html).not.toContain('id="ask"');
    expect(html).not.toContain("position-strip");
    expect(html).toContain("Fictional test document.");
  });

  it("renders the redesigned homepage from the reviewed record", () => {
    const html = readFileSync(homePage, "utf8");
    const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    expect(visible).toContain(
      "I build dependable backend systems for complex, high-stakes planning problems.",
    );
    const intro =
      "I’m Lucas Elia, a software engineer at AWS in Seattle. I work on backend systems for capacity planning.";
    expect(visible).toContain(intro);
    expect(html).toContain(`<meta name="description" content="${intro}">`);
    expect(html).toContain(`<meta property="og:description" content="${intro}">`);
    expect(html).toContain(
      '<p class="hero-status">This site is new and I’m building it in the open. More is on the way.</p>',
    );
    expect(html).toContain('href="#ask"');
    expect(html).toContain('href="#career"');
    expect(visible).toContain("See my career");
    expect(html.match(/<section id="ask"/g)).toHaveLength(1);
    expect(visible).toContain("What have you built at AWS?");
    expect(visible).toContain("Your question");

    expect(visible).toContain("How I got here");
    expect(visible).not.toContain("My career as a capacity plan");
    expect(visible).toContain(
      "My path into software wasn’t traditional. Before becoming an engineer, I owned and operated small businesses, then entered technology through an apprenticeship.",
    );
    expect(visible).toContain(
      "Each bar opens that role. The axis skips 2015 to 2020 to give recent roles more room.",
    );
    expect(html).toContain(
      'aria-label="Software Development Engineer II, Amazon Web Services, December 2025 to now"',
    );
    expect(html).toContain('class="today-line"');

    // The What changed section is gone: the chart flows straight into Experience.
    expect(html).not.toContain('id="results"');
    expect(visible).not.toContain("What changed");
    expect(html).not.toContain(">Results</a>");
    expect(html.indexOf('id="experience"')).toBeGreaterThan(html.indexOf('class="chart-caption"'));

    const experienceHrefs = [
      "/experience/aws-sde-ii",
      "/experience/aws-sde-i",
      "/experience/aws-sde-apprentice",
      "/experience/expert-assist-consultant",
      "/experience/hospitality-businesses-co-founder",
    ];
    let previous = html.indexOf('id="experience"');
    expect(previous).toBeGreaterThan(-1);
    for (const href of experienceHrefs) {
      const index = html.indexOf(`href="${href}"`, previous);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(visible).toContain("Dec 2025 to now");
    expect(html).toContain(
      "Bloom Coffee &amp; Tea, Pause Lounge &amp; Kitchen, and Broadacre Coffee",
    );
    const educationSection = html.indexOf('id="education"');
    expect(educationSection).toBeGreaterThan(previous);
    expect(
      html.indexOf('href="/background/bloomtech-backend-development"', educationSection),
    ).toBeGreaterThan(educationSection);
    expect(visible).toContain("Completed. No degree awarded.");
    expect(visible).toContain("Attended. No degree awarded.");
    expect(visible).toContain("Software Development Engineer II at Amazon Web Services");

    // Removed sections and banned patterns.
    expect(html).not.toContain('id="overview"');
    expect(visible).not.toContain("Current role:");
    expect(visible).not.toContain("Software Development Engineer II @ AWS");
    expect(visible).not.toContain(" · ");
    expect(visible).not.toContain(" — ");
    expect(visible).not.toContain("→");
    expect(visible).not.toContain("Career assistant");
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("Lumen Harbor");
    expect(html).not.toContain("fictional-lumen-harbor");
    // Contact is approved public content from the profile front matter.
    expect(html).toContain('href="mailto:alexanderlucaselia@gmail.com"');
    expect(html).toContain('href="https://www.linkedin.com/in/lucaselia" rel="noopener"');
    expect(html).toContain('href="https://github.com/lucaselia10" rel="noopener"');
  });

  it("ships Archivo only, with no monospace or retired fonts", () => {
    const assets = dev("_astro");
    const css = readdirSync(assets)
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(join(assets, name), "utf8"))
      .join("\n");

    expect(css).toContain("Archivo Variable");
    expect(css).toMatch(/font-stretch:\s*62% 125%/);
    expect(css).not.toMatch(/manrope|plex|monospace/i);
    expect(readdirSync(assets).some((name) => /manrope|plex/i.test(name))).toBe(false);
  });
});

describe("production site build", () => {
  const files = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  const text = (path: string) => readFileSync(path, "utf8");
  const pages = () => files(site()).filter((path) => path.endsWith(".html"));

  it("ships no fixture, no career index, and no assistant", () => {
    expect(existsSync(site("work"))).toBe(false);
    expect(existsSync(site("career-index.json"))).toBe(false);
    for (const path of files(site())) {
      if (/\.(html|xml|txt|svg)$/.test(path)) {
        expect(text(path), path).not.toMatch(/fictional|Lumen Harbor/);
      }
    }
    for (const path of pages()) {
      const html = text(path);
      expect(html, path).not.toContain("<script");
      expect(html, path).not.toContain("<astro-island");
      expect(html, path).not.toContain("<style");
      expect(html, path).not.toContain('id="ask"');
      expect(html, path).not.toContain("Ask about");
      expect(html, path).not.toMatch(/<a href="[^"]*#ask">Ask<\/a>/);
      expect(html, path).not.toContain("no API URL is configured");
    }
  });

  it("renders the single-column hero and the contact band", () => {
    const html = text(site("index.html"));
    const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    expect(html).toContain('class="page-width hero hero-solo"');
    expect(html).toMatch(
      /<a class="button button-primary" href="#career">\s*See my career\s*<\/a>/,
    );
    expect(html).toMatch(/<a class="button button-secondary" href="#contact">\s*Contact\s*<\/a>/);
    expect(html).toContain('<section id="contact" class="contact"');
    expect(visible).toContain(
      "The best way to reach me is email. I’m also on LinkedIn and GitHub.",
    );
    expect(html).toContain('href="mailto:alexanderlucaselia@gmail.com"');
    expect(html).toContain('<a href="#contact">Contact</a>');
  });

  it("gives every page its metadata and lists every page in the sitemap", () => {
    const sitemap = text(site("sitemap-0.xml"));
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");

    expect(text(site("sitemap-index.xml"))).toContain("https://lucaselia.dev/sitemap-0.xml");
    expect(text(site("robots.txt"))).toContain("Sitemap: https://lucaselia.dev/sitemap-index.xml");
    expect(locations).toHaveLength(9);
    expect(locations).toContain("https://lucaselia.dev/experience/aws-sde-ii");
    expect(locations.some((url) => url.includes("404"))).toBe(false);
    for (const path of pages()) {
      const html = text(path);
      expect(html, path).toMatch(/<title>[^<]+<\/title>/);
      expect(html, path).toMatch(/<meta name="description" content="[^"]+">/);
      expect(html, path).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
      expect(html, path).toMatch(/<meta property="og:title" content="[^"]+">/);
      if (!path.endsWith("404.html")) {
        expect(html, path).toMatch(/<link rel="canonical" href="https:\/\/lucaselia\.dev\/[^"]*">/);
      }
    }
    expect(text(site("404.html"))).toContain('<meta name="robots" content="noindex">');
    expect(text(site("favicon.svg"))).toContain("#0F1B2D");
  });

  it("serves every sitemap URL through the CloudFront rewrite", () => {
    const source = readFileSync(
      join(process.cwd(), "..", "..", "infrastructure", "lib", "site-viewer-request.js"),
      "utf8",
    );
    const handler = new Function(`${source}\nreturn handler;`)() as (event: {
      request: { uri: string; headers: Record<string, { value: string }>; querystring: object };
    }) => { uri: string };
    const locations = [...text(site("sitemap-0.xml")).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => new URL(match[1] ?? "").pathname,
    );
    for (const path of [...locations, ...locations.filter((p) => p !== "/").map((p) => `${p}/`)]) {
      const { uri } = handler({
        request: { uri: path, headers: { host: { value: "lucaselia.dev" } }, querystring: {} },
      });
      expect(existsSync(site(uri)), `${path} -> ${uri}`).toBe(true);
    }
  });
});

describe("citation heading anchors", () => {
  it("uses the shared slug for headings whose GitHub slug would differ", async () => {
    const processor = await createSatteriMarkdownProcessor({
      hastPlugins: [citationHeadingIds],
    });
    const rendered = await processor.render("## Signal_Buoy\n\nEvidence.\n");

    expect(rendered.code).toContain('id="signal-buoy"');
  });
});
