import { describe, expect, it } from "vitest";
import { bodyExcerpt, parseRoleBody } from "./role-body";

const SUMMARY = "Build and own core architecture.";

describe("role body", () => {
  it("drops the repeated summary, keeps bullets, and lifts the technologies line", () => {
    const parsed = parseRoleBody(
      [
        "## Role Description",
        "",
        SUMMARY,
        "",
        "- Extended the platform.",
        "- Improved production reliability.",
        "",
        "Completed the apprenticeship.",
        "",
        "Primary technologies: Java, Python, and S3.",
      ].join("\n"),
      SUMMARY,
    );

    expect(parsed).toEqual({
      sections: [
        {
          heading: "Role Description",
          id: "role-description",
          blocks: [
            { kind: "list", items: ["Extended the platform.", "Improved production reliability."] },
            { kind: "paragraph", text: "Completed the apprenticeship." },
          ],
        },
      ],
      technologies: "Java, Python, and S3.",
    });
  });

  it("drops a bullet that repeats the summary", () => {
    const parsed = parseRoleBody(
      `## Role Description\n\n- ${SUMMARY}\n- Configured tenants.\n`,
      SUMMARY,
    );

    expect(parsed?.sections[0]?.blocks).toEqual([{ kind: "list", items: ["Configured tenants."] }]);
  });

  it("keeps the citation anchor for every H2", () => {
    const parsed = parseRoleBody(
      "## Role Description\n\n- One.\n\n## Signal_Buoy Notes\n\nText.\n",
      SUMMARY,
    );

    expect(parsed?.sections.map((section) => section.id)).toEqual([
      "role-description",
      "signal-buoy-notes",
    ]);
  });

  it("falls back for Markdown it does not render", () => {
    expect(parseRoleBody("## Role\n\nSee [the role](/experience/x).", SUMMARY)).toBeNull();
    expect(parseRoleBody("## Role\n\n- **Bold** claim.", SUMMARY)).toBeNull();
    expect(parseRoleBody("## Role\n\n### Sub\n\nText.", SUMMARY)).toBeNull();
    expect(parseRoleBody("Text before any heading.", SUMMARY)).toBeNull();
  });

  it("cuts a reviewed paragraph to its first sentences", () => {
    const body =
      "## About\n\nFirst paragraph.\n\nMy path into software wasn’t traditional. Before becoming an engineer, I ran shops. That shaped me.";

    expect(bodyExcerpt(body, "My path into software wasn’t traditional.", 2)).toBe(
      "My path into software wasn’t traditional. Before becoming an engineer, I ran shops.",
    );
    expect(() => bodyExcerpt(body, "Missing opening", 1)).toThrow(/is missing/);
  });
});
