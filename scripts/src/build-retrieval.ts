import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultContentDir, retrievalDirectory, retrievalManifestPath } from "./paths.js";
import { validateCorpus, type PublicDocument } from "./validate-content.js";

export const RETRIEVAL_SCHEMA_VERSION = 1;
export const RETRIEVAL_GENERATOR_VERSION = "2";

const SOURCE_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*\.txt$/;

export type RetrievalChunkRecord = {
  sourceFilename: string;
  metadataFilename: string;
  chunkId: string;
  documentId: string;
  documentType: string;
  title: string;
  section: string;
  url: string;
  sourceSha256: string;
  metadataSha256: string;
};

export type RetrievalManifest = {
  schemaVersion: typeof RETRIEVAL_SCHEMA_VERSION;
  generatorVersion: typeof RETRIEVAL_GENERATOR_VERSION;
  chunkCount: number;
  chunks: RetrievalChunkRecord[];
};

type PreparedChunk = {
  sourceFilename: string;
  metadataFilename: string;
  chunkId: string;
  documentId: string;
  documentType: string;
  title: string;
  section: string;
  url: string;
  sourceText: string;
  metadataText: string;
};

export function writeRetrievalArtifacts(
  directory = defaultContentDir,
  outputDirectory = retrievalDirectory,
  manifestPath = retrievalManifestPath,
): RetrievalManifest {
  const result = validateCorpus(directory);
  if (result.errors.length > 0) {
    throw new Error(result.errors.join("\n"));
  }
  return buildRetrievalArtifacts(result.documents, outputDirectory, manifestPath);
}

export function buildRetrievalArtifacts(
  documents: readonly PublicDocument[],
  outputDirectory: string,
  manifestPath: string,
): RetrievalManifest {
  const prepared = prepareChunks(documents);
  resetDirectory(outputDirectory);
  for (const chunk of prepared) {
    writeInside(outputDirectory, chunk.sourceFilename, chunk.sourceText);
    writeInside(outputDirectory, chunk.metadataFilename, chunk.metadataText);
  }

  const manifest: RetrievalManifest = {
    schemaVersion: RETRIEVAL_SCHEMA_VERSION,
    generatorVersion: RETRIEVAL_GENERATOR_VERSION,
    chunkCount: prepared.length,
    chunks: prepared.map((chunk) => ({
      sourceFilename: chunk.sourceFilename,
      metadataFilename: chunk.metadataFilename,
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentType: chunk.documentType,
      title: chunk.title,
      section: chunk.section,
      url: chunk.url,
      sourceSha256: sha256(chunk.sourceText),
      metadataSha256: sha256(chunk.metadataText),
    })),
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function prepareChunks(documents: readonly PublicDocument[]): PreparedChunk[] {
  const prepared: PreparedChunk[] = [];
  const filenames = new Set<string>();
  const chunkIds = new Set<string>();
  const urls = new Set<string>();

  const eligible = documents
    .filter(isAssistantRetrievable)
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const document of eligible) {
    const sections = document.sections.filter(
      (section) => section.heading !== "" && section.slug !== "",
    );
    if (sections.length === 0) {
      throw new Error(`Retrievable document "${document.id}" has no usable citation sections.`);
    }
    for (const section of sections) {
      const sourceFilename = retrievalSourceFilename(document.id, section.slug);
      const metadataFilename = `${sourceFilename}.metadata.json`;
      const chunkId = `${document.id}:${section.slug}:0`;
      if (filenames.has(sourceFilename) || chunkIds.has(chunkId) || urls.has(section.url)) {
        throw new Error(`Retrieval identity "${chunkId}" is duplicated.`);
      }
      filenames.add(sourceFilename);
      chunkIds.add(chunkId);
      urls.add(section.url);
      const sourceText = sourceDocument(document, section.heading, section.body);
      const metadataText = metadataDocument({
        chunkId,
        documentId: document.id,
        title: document.title,
        section: section.heading,
        url: section.url,
        type: document.type,
      });
      prepared.push({
        sourceFilename,
        metadataFilename,
        chunkId,
        documentId: document.id,
        documentType: document.type,
        title: document.title,
        section: section.heading,
        url: section.url,
        sourceText,
        metadataText,
      });
    }
  }

  return prepared.sort((left, right) => {
    const byDocument = left.documentId.localeCompare(right.documentId);
    return byDocument === 0 ? left.chunkId.localeCompare(right.chunkId) : byDocument;
  });
}

export function isAssistantRetrievable(document: PublicDocument): boolean {
  return document.visibility === "public" && document.assistant_retrievable === true;
}

export function retrievalSourceFilename(documentId: string, slug: string): string {
  const filename = `${documentId}--${slug}.txt`;
  if (
    !SOURCE_FILENAME.test(filename) ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    throw new Error("Retrieval artifact filename is not safe.");
  }
  return filename;
}

export function plainSectionText(value: string): string {
  const withoutFences = value
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n");
  const withoutHtml = withoutFences.replace(/<[^>\n]+>/g, "");
  const withoutImages = withoutHtml.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  const withoutLinks = withoutImages.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const withoutEmphasis = withoutLinks
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1");
  const lines = withoutEmphasis.split("\n").map((line) => {
    let next = line.replace(/[ \t]+$/g, "");
    next = next.replace(/^ {0,3}#{1,6}\s+/, "");
    next = next.replace(/^>\s?/, "");
    next = next.replace(/^(\s*)(?:[-*+]|\d+\.)\s+/, "$1");
    return next;
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sourceDocument(document: PublicDocument, section: string, body: string): string {
  const text = [
    `Title: ${oneLine(document.title)}`,
    `Type: ${document.type}`,
    `Summary: ${oneLine(plainSectionText(document.summary))}`,
    `Section: ${oneLine(section)}`,
    "",
    ...factsHeader(document),
    plainSectionText(body),
  ].join("\n");
  return `${text.replace(/\s+$/g, "")}\n`;
}

/**
 * Reviewed front matter written as labeled lines. Only field labels and the
 * stored values appear; a null location and empty lists are omitted.
 */
export function factsHeader(document: PublicDocument): string[] {
  const facts: Array<[string, string | null]> = [];
  switch (document.type) {
    case "experience":
      facts.push(
        ["Employer", document.employer],
        ["Role title", document.role_title],
        ["Start date", document.start_date],
        ["End date", document.end_date ?? "present"],
        ["Location", document.location],
        ["Employment type", document.employment_type],
      );
      break;
    case "background":
      facts.push(
        ["Institution", document.institution],
        ["Program", document.program],
        ["Start date", document.start_date],
        ["End date", document.end_date],
        ["Education status", document.education_status],
        ["Degree awarded", document.degree_awarded ? "yes" : "no"],
      );
      break;
    case "profile":
      facts.push(["Location", document.location]);
      break;
    case "project":
      break;
  }
  facts.push(["Skills", listValue(document.skills)], ["Topics", listValue(document.topics)]);
  const lines = facts
    .filter((fact): fact is [string, string] => fact[1] !== null && oneLine(fact[1]) !== "")
    .map(([label, value]) => `${label}: ${oneLine(value)}`);
  return lines.length === 0 ? [] : ["Facts:", ...lines, ""];
}

function listValue(values: readonly string[]): string | null {
  const kept = values.map(oneLine).filter((value) => value !== "");
  return kept.length === 0 ? null : kept.join(", ");
}

function metadataDocument(attributes: Record<string, string>): string {
  const metadataAttributes: Record<string, unknown> = {};
  for (const [key, stringValue] of Object.entries(attributes)) {
    metadataAttributes[key] = {
      value: {
        type: "STRING",
        stringValue,
      },
      includeForEmbedding: false,
    };
  }
  return `${JSON.stringify({ metadataAttributes }, null, 2)}\n`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resetDirectory(directory: string): void {
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink()) {
      throw new Error("Refusing to replace a symlinked retrieval directory.");
    }
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  mkdirSync(directory, { recursive: true });
}

function writeInside(directory: string, filename: string, contents: string): void {
  if (
    filename !== filename.trim() ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    throw new Error("Retrieval artifact filename is not safe.");
  }
  const destination = resolve(directory, filename);
  const root = resolve(directory);
  if (destination !== join(root, filename)) {
    throw new Error("Retrieval artifact path is not safe.");
  }
  writeFileSync(destination, contents);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function listRetrievalFiles(directory: string): string[] {
  return readdirSync(directory).sort();
}

export function readRetrievalFile(directory: string, filename: string): Buffer {
  return readFileSync(join(directory, filename));
}
