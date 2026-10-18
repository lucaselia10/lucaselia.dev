import { citationSlug } from "@career-portfolio/content";

type HeadingNode = {
  properties?: Record<string, unknown>;
};

type HeadingContext = {
  setProperty: (node: HeadingNode, key: string, value: string) => void;
  textContent: (node: HeadingNode) => string;
};

export function citationHeadingIds(): {
  name: string;
  before: () => void;
  element: {
    filter: string[];
    visit: (node: HeadingNode, ctx: HeadingContext) => void;
  };
} {
  const used = new Set<string>();
  return {
    name: "citation-heading-ids",
    before: () => {
      used.clear();
    },
    element: {
      filter: ["h2"],
      visit: (node, ctx) => {
        const slug = citationSlug(ctx.textContent(node), used);
        used.add(slug);
        ctx.setProperty(node, "id", slug);
      },
    },
  };
}
