import {
  BACKGROUND_CATEGORIES,
  EDUCATION_STATUSES,
  ID_PATTERN,
  MONTH_PATTERN,
  PROJECT_STATUSES,
  VISIBILITIES,
} from "@career-portfolio/content";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const id = z.string().regex(ID_PATTERN);
const uniqueStrings = z
  .array(z.string().min(1))
  .refine((values) => new Set(values).size === values.length, {
    message: "must contain unique values",
  });
const month = z.string().regex(MONTH_PATTERN);
const monthOrNull = z.union([month, z.null()]);
const lastReviewed = z.union([
  z.date().transform((value) => {
    const year = value.getUTCFullYear();
    const monthNumber = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${monthNumber}-${day}`;
  }),
  z.iso.date(),
]);

const common = {
  id,
  title: z.string().min(1),
  summary: z.string().min(1),
  skills: uniqueStrings,
  topics: uniqueStrings,
  featured: z.boolean(),
  visibility: z.enum(VISIBILITIES),
  assistant_retrievable: z.boolean(),
  last_reviewed: lastReviewed,
};

function datesAreOrdered(start: string | undefined, end: string | null | undefined): boolean {
  return typeof start !== "string" || typeof end !== "string" || end >= start;
}

// Approved public contact content. These fields render the Contact section only; they are
// not part of the career index, the retrieval Facts header, or the evidence package.
const httpsUrl = z.url({ protocol: /^https$/ });

const profile = z
  .object({
    ...common,
    type: z.literal("profile"),
    headline: z.string().min(1),
    location: z.string().min(1),
    current_role: id,
    linkedin_url: httpsUrl.optional(),
    github_url: httpsUrl.optional(),
    email: z.email().optional(),
  })
  .strict();

const experience = z
  .object({
    ...common,
    type: z.literal("experience"),
    employer: z.string().min(1),
    role_title: z.string().min(1),
    start_date: month,
    end_date: monthOrNull,
    employment_type: z.string().min(1),
    location: z.union([z.string().min(1), z.null()]),
  })
  .strict()
  .refine((document) => datesAreOrdered(document.start_date, document.end_date), {
    message: "end_date must not precede start_date",
    path: ["end_date"],
  });

const project = z
  .object({
    ...common,
    type: z.literal("project"),
    status: z.enum(PROJECT_STATUSES),
    roles: z.array(id).refine((values) => new Set(values).size === values.length, {
      message: "must contain unique values",
    }),
  })
  .strict();

const background = z
  .object({
    ...common,
    type: z.literal("background"),
    category: z.enum(BACKGROUND_CATEGORIES),
    institution: z.string().min(1),
    program: z.string().min(1),
    start_date: month,
    end_date: month,
    education_status: z.enum(EDUCATION_STATUSES),
    degree_awarded: z.boolean(),
  })
  .strict()
  .refine((document) => datesAreOrdered(document.start_date, document.end_date), {
    message: "end_date must not precede start_date",
    path: ["end_date"],
  });

const publicDocuments = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    // content.config.ts lives in apps/web/src, so three levels up is the repository root.
    base: new URL("../../../content/public", import.meta.url),
    generateId: ({ data }) => {
      if (typeof data.id !== "string" || data.id.length === 0) {
        throw new Error("Public document is missing a string id.");
      }
      return data.id;
    },
  }),
  schema: z.discriminatedUnion("type", [profile, experience, project, background]),
});

export const collections = {
  public: publicDocuments,
};
