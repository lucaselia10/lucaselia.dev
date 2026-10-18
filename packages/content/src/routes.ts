export const DOCUMENT_TYPES = ["profile", "experience", "project", "background"] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const VISIBILITIES = ["public", "draft"] as const;

export type Visibility = (typeof VISIBILITIES)[number];

export const PROJECT_STATUSES = ["active", "completed", "archived"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const BACKGROUND_CATEGORIES = ["education"] as const;

export type BackgroundCategory = (typeof BACKGROUND_CATEGORIES)[number];

export const EDUCATION_STATUSES = ["completed", "attended"] as const;

export type EducationStatus = (typeof EDUCATION_STATUSES)[number];

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPublishedVisibility(value: string): value is "public" {
  return value === "public";
}

const ROUTE_PREFIX = {
  project: "work",
  experience: "experience",
  background: "background",
  profile: "profile",
} as const satisfies Record<DocumentType, string>;

export function isDocumentType(value: string): value is DocumentType {
  return (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function documentPath(type: string, id: string): string {
  if (!isDocumentType(type) || !ID_PATTERN.test(id)) {
    throw new Error(
      `Citation route cannot be resolved for document type "${type}" and id "${id}".`,
    );
  }
  return `/${ROUTE_PREFIX[type]}/${id}`;
}

export function slugify(heading: string): string {
  const slug = heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new Error(`Citation route cannot be resolved for heading "${heading}".`);
  }
  return slug;
}

export function citationSlug(heading: string, used: ReadonlySet<string>): string {
  const slug = slugify(heading);
  if (used.has(slug)) {
    throw new Error(
      `Citation route cannot be resolved because heading "${heading}" repeats anchor "${slug}".`,
    );
  }
  return slug;
}

export function citationUrl(type: string, id: string, heading: string): string {
  return `${documentPath(type, id)}#${slugify(heading)}`;
}
