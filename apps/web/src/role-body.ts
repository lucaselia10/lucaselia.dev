import { citationSlug } from "@career-portfolio/content";

/**
 * Split a reviewed experience body into the role-page layout: the H2 sections keep their
 * citation anchors, a paragraph or list item that repeats the summary is dropped (it is
 * shown as the lead), list items become "What I work on", and a "Primary technologies:" line becomes
 * the technologies sentence. Bodies that use other Markdown return null so the page can
 * fall back to the regular renderer instead of showing raw syntax.
 */

export type RoleBlock = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

export type RoleSection = {
  heading: string;
  /** Citation anchor, identical to the one the Markdown renderer would give the H2. */
  id: string;
  blocks: RoleBlock[];
};

export type RoleBody = {
  sections: RoleSection[];
  technologies: string | null;
};

const TECHNOLOGIES = /^Primary technologies:\s*(.+)$/;
const UNSUPPORTED = /[[\]*`_<>]|^\s*(#{1,6}(?!#)\s|#{3,}|>|\d+\.\s)/;

export function parseRoleBody(body: string, summary: string): RoleBody | null {
  const used = new Set<string>();
  const sections: RoleSection[] = [];
  let technologies: string | null = null;
  let current: RoleSection | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0 || current === null) {
      paragraph = [];
      return;
    }
    const text = paragraph.join(" ").trim();
    paragraph = [];
    const tech = TECHNOLOGIES.exec(text);
    if (tech?.[1]) {
      technologies = tech[1].trim();
      return;
    }
    if (text === summary.trim()) {
      return;
    }
    current.blocks.push({ kind: "paragraph", text });
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1]) {
      flushParagraph();
      const text = heading[1].trim();
      const id = citationSlug(text, used);
      used.add(id);
      current = { heading: text, id, blocks: [] };
      sections.push(current);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    if (UNSUPPORTED.test(line.replace(/^\s*-\s+/, ""))) {
      return null;
    }
    if (current === null) {
      return null;
    }
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item?.[1]) {
      flushParagraph();
      if (item[1].trim() === summary.trim()) {
        continue;
      }
      const last = current.blocks[current.blocks.length - 1];
      if (last?.kind === "list") {
        last.items.push(item[1].trim());
      } else {
        current.blocks.push({ kind: "list", items: [item[1].trim()] });
      }
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return sections.length === 0 ? null : { sections, technologies };
}

/**
 * The paragraph of a reviewed body that starts with `opening`, cut to its first
 * `sentences` sentences. Missing text fails the build instead of rendering a gap.
 */
export function bodyExcerpt(body: string, opening: string, sentences: number): string {
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .find((block) => block.startsWith(opening));
  if (!paragraph) {
    throw new Error(`The reviewed text starting "${opening}" is missing.`);
  }
  const parts = paragraph.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [paragraph];
  return parts
    .slice(0, sentences)
    .map((part) => part.trim())
    .join(" ");
}
