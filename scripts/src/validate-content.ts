import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  citationSlug,
  documentPath,
  isDocumentType,
  isPublishedVisibility,
  type DocumentType,
  type EducationStatus,
  type ProjectStatus,
  type Visibility,
} from "@career-portfolio/content";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import {
  canonicalCareerIndexPath,
  careerIndexCopyPaths,
  defaultContentDir,
  documentSchemaPath,
  repoRoot,
} from "./paths.js";
import { findInternalHosts } from "./public-safety.js";

const PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}/;
const ADDRESS_PATTERN =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b/;

export type DocumentSection = {
  heading: string;
  slug: string;
  url: string;
  body: string;
};

export type IndexedSection = {
  heading: string;
  url: string;
};

export type CareerFactKind =
  | "skill"
  | "topic"
  | "last_reviewed"
  | "status"
  | "role_reference"
  | "employer"
  | "role_title"
  | "start_date"
  | "end_date"
  | "employment_type"
  | "location"
  | "headline"
  | "current_role"
  | "category"
  | "institution"
  | "program"
  | "education_status"
  | "degree_awarded";

export type CareerFact = {
  kind: CareerFactKind;
  value: string | boolean | null;
  documentId: string;
  url: string;
};

export type CareerSource = {
  chunkId: string;
  documentId: string;
  title: string;
  section: string;
  type: string;
  roles: string[];
  skills: string[];
  url: string;
};

type DocumentBase = {
  id: string;
  title: string;
  summary: string;
  skills: string[];
  topics: string[];
  featured: boolean;
  visibility: Visibility;
  assistant_retrievable: boolean;
  last_reviewed: string;
  sections: DocumentSection[];
  file: string;
};

export type ProfileDocument = DocumentBase & {
  type: "profile";
  headline: string;
  location: string;
  current_role: string;
};

export type ExperienceDocument = DocumentBase & {
  type: "experience";
  employer: string;
  role_title: string;
  start_date: string;
  end_date: string | null;
  employment_type: string;
  location: string | null;
};

export type ProjectDocument = DocumentBase & {
  type: "project";
  status: ProjectStatus;
  roles: string[];
};

export type BackgroundDocument = DocumentBase & {
  type: "background";
  category: "education";
  institution: string;
  program: string;
  start_date: string;
  end_date: string;
  education_status: EducationStatus;
  degree_awarded: boolean;
};

export type PublicDocument =
  ProfileDocument | ExperienceDocument | ProjectDocument | BackgroundDocument;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type IndexedDocument = DistributiveOmit<PublicDocument, "file" | "sections"> & {
  url: string;
  sections: IndexedSection[];
};

export const CAREER_INDEX_SCHEMA_VERSION = 1;

export type CareerIndex = {
  schemaVersion: typeof CAREER_INDEX_SCHEMA_VERSION;
  documents: IndexedDocument[];
  facts: CareerFact[];
  sources: CareerSource[];
};

export type ValidationResult = {
  documents: PublicDocument[];
  errors: string[];
};

let metadataValidator: ValidateFunction | undefined;

export function validateCorpus(directory = defaultContentDir): ValidationResult {
  const errors: string[] = [];
  let files: string[];
  try {
    files = listMarkdownFiles(directory);
  } catch {
    return { documents: [], errors: [`Content directory not found: ${directory}`] };
  }

  if (files.length === 0) {
    return { documents: [], errors: ["No public Markdown documents were found."] };
  }

  const documents: PublicDocument[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const parsed = parseDocument(file);
    errors.push(...parsed.errors);
    if (!parsed.document) {
      continue;
    }
    const previous = seenIds.get(parsed.document.id);
    if (previous) {
      errors.push(
        `${parsed.document.file} duplicates id "${parsed.document.id}" already used by ${previous}.`,
      );
    } else {
      seenIds.set(parsed.document.id, parsed.document.file);
    }
    documents.push(parsed.document);
  }

  errors.push(...referenceErrors(documents));
  return { documents, errors };
}

export function buildIndex(directory = defaultContentDir): CareerIndex {
  const result = validateCorpus(directory);
  if (result.errors.length > 0) {
    throw new Error(result.errors.join("\n"));
  }

  const documents = result.documents
    .filter((document) => isPublishedVisibility(document.visibility))
    .map((document) => {
      const { file: _file, sections, ...indexed } = document;
      return {
        ...indexed,
        url: documentPath(document.type, document.id),
        sections: sections.map((section) => ({
          heading: section.heading,
          url: section.url,
        })),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    schemaVersion: CAREER_INDEX_SCHEMA_VERSION,
    documents,
    facts: documents.flatMap(careerFacts),
    sources: documents.flatMap(careerSources),
  };
}

export function writeCareerIndex(
  destination = canonicalCareerIndexPath,
  directory = defaultContentDir,
): CareerIndex {
  const index = buildIndex(directory);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

export function synchronizeCareerIndex(
  source = canonicalCareerIndexPath,
  destinations: readonly string[] = careerIndexCopyPaths,
): void {
  const bytes = readFileSync(source);
  for (const destination of destinations) {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

function careerFacts(document: IndexedDocument): CareerFact[] {
  const source = { documentId: document.id, url: document.url };
  const facts: CareerFact[] = [
    { kind: "last_reviewed", value: document.last_reviewed, ...source },
    ...document.skills.map((value) => ({ kind: "skill" as const, value, ...source })),
    ...document.topics.map((value) => ({ kind: "topic" as const, value, ...source })),
  ];
  if (document.type === "project") {
    facts.push({ kind: "status", value: document.status, ...source });
    facts.push(
      ...document.roles.map((value) => ({ kind: "role_reference" as const, value, ...source })),
    );
  } else if (document.type === "experience") {
    facts.push(
      { kind: "employer", value: document.employer, ...source },
      { kind: "role_title", value: document.role_title, ...source },
      { kind: "start_date", value: document.start_date, ...source },
      { kind: "end_date", value: document.end_date, ...source },
      { kind: "employment_type", value: document.employment_type, ...source },
    );
    if (document.location !== null) {
      facts.push({ kind: "location", value: document.location, ...source });
    }
  } else if (document.type === "profile") {
    facts.push(
      { kind: "headline", value: document.headline, ...source },
      { kind: "location", value: document.location, ...source },
      { kind: "current_role", value: document.current_role, ...source },
    );
  } else {
    facts.push(
      { kind: "category", value: document.category, ...source },
      { kind: "institution", value: document.institution, ...source },
      { kind: "program", value: document.program, ...source },
      { kind: "start_date", value: document.start_date, ...source },
      { kind: "end_date", value: document.end_date, ...source },
      { kind: "education_status", value: document.education_status, ...source },
      { kind: "degree_awarded", value: document.degree_awarded, ...source },
    );
  }
  return facts;
}

function careerSources(document: IndexedDocument): CareerSource[] {
  const roles = document.type === "project" ? document.roles : [];
  return document.sections.map((section) => {
    const slug = section.url.split("#")[1] ?? "";
    return {
      chunkId: `${document.id}:${slug}:0`,
      documentId: document.id,
      title: document.title,
      section: section.heading,
      type: document.type,
      roles,
      skills: document.skills,
      url: section.url,
    };
  });
}

function referenceErrors(documents: PublicDocument[]): string[] {
  const byId = new Map<string, PublicDocument>();
  for (const document of documents) {
    if (!byId.has(document.id)) {
      byId.set(document.id, document);
    }
  }

  const errors: string[] = [];
  for (const document of documents) {
    if (document.type === "profile") {
      const problem = referenceProblem(document, "current_role", document.current_role, byId);
      if (problem) {
        errors.push(problem);
      }
    }
    if (document.type === "project") {
      for (const roleId of document.roles) {
        const problem = referenceProblem(document, "roles", roleId, byId);
        if (problem) {
          errors.push(problem);
        }
      }
    }
  }
  return errors;
}

function referenceProblem(
  source: PublicDocument,
  field: string,
  targetId: string,
  byId: Map<string, PublicDocument>,
): string | undefined {
  const target = byId.get(targetId);
  if (!target) {
    return `${source.file} ${field} "${targetId}" does not reference an existing document.`;
  }
  if (target.type !== "experience") {
    return `${source.file} ${field} "${targetId}" must reference an experience document.`;
  }
  if (source.visibility === "public" && target.visibility !== "public") {
    return `${source.file} ${field} "${targetId}" references a draft document, which cannot be published.`;
  }
  return undefined;
}

function parseDocument(file: string): { document?: PublicDocument; errors: string[] } {
  const display = displayPath(file);
  const source = readFileSync(file, "utf8");
  const frontMatter = readFrontMatter(source);
  if (!frontMatter) {
    return { errors: [`${display} is missing YAML front matter.`] };
  }

  let metadata: unknown;
  try {
    metadata = parse(frontMatter.yaml);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    return { errors: [`${display} has invalid front matter: ${message}`] };
  }

  const errors: string[] = [];
  const candidate = isRecord(metadata) ? metadata : undefined;
  const validator = getMetadataValidator();
  if (!validator(metadata)) {
    errors.push(`${display} has invalid metadata: ${formatAjvErrors(validator.errors)}`);
    if (typeof candidate?.type === "string" && !isDocumentType(candidate.type)) {
      errors.push(`${display} uses unsupported document type "${candidate.type}".`);
    }
    if (
      typeof candidate?.visibility === "string" &&
      candidate.visibility !== "public" &&
      candidate.visibility !== "draft"
    ) {
      errors.push(`${display} visibility must be public or draft.`);
    }
    return { errors };
  }

  const record = metadata as Record<string, unknown>;
  const safetyErrors = findSafetyIssues(source);
  if (safetyErrors.length > 0) {
    errors.push(...safetyErrors.map((issue) => `${display} ${issue}`));
  }

  let sections: DocumentSection[] = [];
  let citationFailed = false;
  try {
    sections = citationSections(record, frontMatter.body);
  } catch (error) {
    citationFailed = true;
    const message = error instanceof Error ? error.message : "citation target is invalid";
    errors.push(`${display} ${message}`);
  }

  if (!citationFailed && sections.length === 0) {
    errors.push(`${display} cannot generate a citation target because it has no H2 section.`);
  }

  const dateOrder = dateOrderError(record);
  if (dateOrder) {
    errors.push(`${display} ${dateOrder}`);
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors: [],
    document: toDocument(record, sections, display),
  };
}

function dateOrderError(record: Record<string, unknown>): string | undefined {
  if (record.type !== "experience" && record.type !== "background") {
    return undefined;
  }
  const start = record.start_date;
  const end = record.end_date;
  if (typeof start === "string" && typeof end === "string" && end < start) {
    return `end_date ${end} precedes start_date ${start}.`;
  }
  return undefined;
}

function toDocument(
  record: Record<string, unknown>,
  sections: DocumentSection[],
  file: string,
): PublicDocument {
  const type = record.type as DocumentType;
  const base = {
    id: String(record.id),
    title: String(record.title),
    summary: String(record.summary),
    skills: stringList(record.skills),
    topics: stringList(record.topics),
    featured: record.featured === true,
    visibility: record.visibility === "draft" ? "draft" : "public",
    assistant_retrievable: record.assistant_retrievable === true,
    last_reviewed: String(record.last_reviewed),
    sections,
    file,
  } as const;

  if (type === "profile") {
    return {
      ...base,
      type,
      headline: String(record.headline),
      location: String(record.location),
      current_role: String(record.current_role),
    };
  }
  if (type === "experience") {
    return {
      ...base,
      type,
      employer: String(record.employer),
      role_title: String(record.role_title),
      start_date: String(record.start_date),
      end_date: record.end_date === null ? null : String(record.end_date),
      employment_type: String(record.employment_type),
      location: record.location === null ? null : String(record.location),
    };
  }
  if (type === "project") {
    return {
      ...base,
      type,
      status: record.status as ProjectStatus,
      roles: stringList(record.roles),
    };
  }
  return {
    ...base,
    type: "background",
    category: "education",
    institution: String(record.institution),
    program: String(record.program),
    start_date: String(record.start_date),
    end_date: String(record.end_date),
    education_status: record.education_status === "attended" ? "attended" : "completed",
    degree_awarded: record.degree_awarded === true,
  };
}

function citationSections(record: Record<string, unknown>, body: string): DocumentSection[] {
  const type = String(record.type);
  const id = String(record.id);
  let page: string;
  try {
    page = documentPath(type, id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Citation route cannot be resolved.";
    throw new Error(message);
  }

  const used = new Set<string>();
  return extractSections(body).map((section) => {
    const slug = citationSlug(section.heading, used);
    used.add(slug);
    return {
      heading: section.heading,
      slug,
      url: `${page}#${slug}`,
      body: section.body,
    };
  });
}

export function extractHeadings(body: string): string[] {
  return extractSections(body).map((section) => section.heading);
}

export function extractSections(body: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let inFence = false;
  let current: { heading: string; lines: string[] } | undefined;

  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      current?.lines.push(line);
      continue;
    }
    if (!inFence) {
      const match = /^##\s+(.+?)\s*$/.exec(line);
      const heading = match?.[1]?.trim();
      if (heading) {
        if (current) {
          sections.push(current);
        }
        current = { heading, lines: [] };
        continue;
      }
    }
    current?.lines.push(line);
  }
  if (current) {
    sections.push(current);
  }

  return sections.map((section) => ({
    heading: section.heading,
    body: section.lines.join("\n").trim(),
  }));
}

function findSafetyIssues(source: string): string[] {
  const issues: string[] = [];
  if (findInternalHosts(source).length > 0) {
    issues.push("contains an internal URL or host name.");
  }
  if (PHONE_PATTERN.test(source)) {
    issues.push("contains a phone number.");
  }
  if (ADDRESS_PATTERN.test(source) || /home address/i.test(source)) {
    issues.push("contains a physical address.");
  }
  return issues;
}

function readFrontMatter(source: string): { yaml: string; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match?.[1]) {
    return undefined;
  }
  return { yaml: match[1], body: source.slice(match[0].length) };
}

function listMarkdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function getMetadataValidator(): ValidateFunction {
  if (!metadataValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    // ajv-formats is CommonJS. Node loads the function, while the type
    // declaration is a module namespace under NodeNext.
    (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
    const schema: unknown = JSON.parse(readFileSync(documentSchemaPath, "utf8"));
    metadataValidator = ajv.compile(schema as object);
  }
  return metadataValidator;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "document metadata is invalid";
  }
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function displayPath(filePath: string): string {
  const fromRoot = relative(repoRoot, filePath);
  return fromRoot.startsWith("..") ? filePath : fromRoot;
}
