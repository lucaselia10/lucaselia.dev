import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRetrievalArtifacts,
  factsHeader,
  listRetrievalFiles,
  plainSectionText,
  retrievalSourceFilename,
  writeRetrievalArtifacts,
} from "./build-retrieval.js";
import { lambdaAssetPath, webCareerIndexPath } from "./paths.js";
import { findInternalHosts } from "./public-safety.js";
import { validateCorpus, type PublicDocument } from "./validate-content.js";

// Mirrors MAX_CHUNK_CHARS and MAX_EVIDENCE_CHARS in services/ask-api/src/ask_api/local_evidence.py.
const MAX_CHUNK_CHARS = 20_000;
const MAX_EVIDENCE_CHARS = 100_000;
const PHONE_PATTERN = /(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}/;

describe("retrieval artifacts", () => {
  it("builds deterministic artifacts for approved public sections only", () => {
    const first = tempPaths();
    const second = tempPaths();
    const manifest = writeRetrievalArtifacts(undefined, first.directory, first.manifest);
    const again = writeRetrievalArtifacts(undefined, second.directory, second.manifest);

    expect(manifest.chunkCount).toBe(8);
    expect(manifest.chunks.map((chunk) => chunk.documentId)).toEqual([
      "aws-sde-apprentice",
      "aws-sde-i",
      "aws-sde-ii",
      "bloomtech-backend-development",
      "expert-assist-consultant",
      "hospitality-businesses-co-founder",
      "lucas-elia",
      "sierra-college-general-studies",
    ]);
    expect(manifest.chunks.some((chunk) => chunk.documentId === "fictional-lumen-harbor")).toBe(
      false,
    );
    expect(readFileSync(first.manifest).equals(readFileSync(second.manifest))).toBe(true);
    expect(JSON.stringify(manifest)).toBe(JSON.stringify(again));

    const files = listRetrievalFiles(first.directory);
    expect(files).toHaveLength(16);
    for (const chunk of manifest.chunks) {
      expect(files).toContain(chunk.sourceFilename);
      expect(files).toContain(chunk.metadataFilename);
      expect(chunk.metadataFilename).toBe(`${chunk.sourceFilename}.metadata.json`);
      const source = readFileSync(join(first.directory, chunk.sourceFilename));
      const metadata = readFileSync(join(first.directory, chunk.metadataFilename));
      expect(sha256(source)).toBe(chunk.sourceSha256);
      expect(sha256(metadata)).toBe(chunk.metadataSha256);
      expect(source.toString("utf8").endsWith("\n")).toBe(true);
      expect(source.toString("utf8").includes("\r")).toBe(false);
      const sidecar = JSON.parse(metadata.toString("utf8")) as {
        metadataAttributes: Record<
          string,
          { value: { type: string; stringValue: string }; includeForEmbedding: boolean }
        >;
      };
      expect(sidecar.metadataAttributes.chunkId).toEqual({
        value: { type: "STRING", stringValue: chunk.chunkId },
        includeForEmbedding: false,
      });
      expect(sidecar.metadataAttributes.url?.value.stringValue).toBe(chunk.url);
      expect(sidecar.metadataAttributes.type?.includeForEmbedding).toBe(false);
      expect(chunk.url.startsWith("/")).toBe(true);
    }

    const role = readFileSync(join(first.directory, "aws-sde-ii--role-description.txt"), "utf8");
    expect(role).toContain("Title: Software Development Engineer II");
    expect(role).toContain("Type: experience");
    expect(role).toContain("Section: Role Description");
    expect(role).toContain("production reliability");
    expect(role).not.toContain("## ");
    expect(role).not.toContain("- Extended");
    const joined = files
      .map((filename) => readFileSync(join(first.directory, filename), "utf8"))
      .join("\n");
    expect(joined).not.toContain("Lumen Harbor");
    expect(joined).not.toContain("fictional-lumen-harbor");
    expect(joined).not.toContain(first.directory);
    expect(findInternalHosts(joined)).toEqual([]);
    expect(PHONE_PATTERN.test(joined)).toBe(false);
    expect(first.directory.endsWith("retrieval") || first.directory.includes("retrieval-")).toBe(
      true,
    );
    expect(first.directory).not.toBe(lambdaAssetPath);
    expect(first.directory).not.toBe(webCareerIndexPath);
  });

  it("removes stale files and skips drafts", () => {
    const paths = tempPaths();
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(join(paths.directory, "stale.txt"), "old\n");
    const corpus = validateCorpus();
    if (corpus.errors.length > 0) {
      throw new Error(corpus.errors.join("\n"));
    }
    const draft = structuredClone(
      corpus.documents.find((document) => document.id === "aws-sde-ii"),
    );
    if (!draft) {
      throw new Error("missing fixture document");
    }
    draft.id = "draft-only";
    draft.visibility = "draft";
    draft.assistant_retrievable = true;
    draft.file = "draft-only.md";
    draft.sections = draft.sections.map((section) => ({
      ...section,
      url: "/experience/draft-only#role-description",
    }));

    const manifest = buildRetrievalArtifacts(
      [...corpus.documents, draft],
      paths.directory,
      paths.manifest,
    );

    expect(listRetrievalFiles(paths.directory)).not.toContain("stale.txt");
    expect(manifest.chunks.some((chunk) => chunk.documentId === "draft-only")).toBe(false);
    expect(manifest.chunks.some((chunk) => chunk.documentId === "fictional-lumen-harbor")).toBe(
      false,
    );
  });

  it("rejects unsafe filenames, duplicate identities, and empty retrievable documents", () => {
    expect(() => retrievalSourceFilename("../etc", "passwd")).toThrow(/not safe/);
    const document = sampleDocument();
    const duplicate = sampleDocument();
    expect(() =>
      buildRetrievalArtifacts([document, duplicate], tempPaths().directory, tempPaths().manifest),
    ).toThrow(/duplicated/);

    const empty = sampleDocument();
    empty.sections = [];
    expect(() =>
      buildRetrievalArtifacts([empty], tempPaths().directory, tempPaths().manifest),
    ).toThrow(/no usable citation sections/);
  });

  it("writes an experience facts header from front matter only", () => {
    const document = sampleDocument();
    document.skills = ["Java", "AWS CDK"];
    document.topics = ["Distributed Systems"];

    expect(factsHeader(document)).toEqual([
      "Facts:",
      "Employer: Amazon Web Services",
      "Role title: Software Development Engineer II",
      "Start date: 2025-12",
      "End date: present",
      "Location: Seattle, WA",
      "Employment type: Full-time",
      "Skills: Java, AWS CDK",
      "Topics: Distributed Systems",
      "",
    ]);
    const paths = tempPaths();
    buildRetrievalArtifacts([document], paths.directory, paths.manifest);
    const source = readFileSync(join(paths.directory, "aws-sde-ii--role-description.txt"), "utf8");
    expect(source).toBe(
      [
        "Title: Software Development Engineer II",
        "Type: experience",
        "Summary: Summary",
        "Section: Role Description",
        "",
        ...factsHeader(document),
        "Role text.",
        "",
      ].join("\n"),
    );
  });

  it("omits a null location and empty lists", () => {
    const document = sampleDocument();
    if (document.type !== "experience") {
      throw new Error("sample must be an experience document");
    }
    document.location = null;
    document.end_date = "2024-06";

    const header = factsHeader(document);
    expect(header).toContain("End date: 2024-06");
    expect(header.some((line) => line.startsWith("Location:"))).toBe(false);
    expect(header.some((line) => line.startsWith("Skills:"))).toBe(false);
    expect(header.some((line) => line.startsWith("Topics:"))).toBe(false);
  });

  it("writes an education facts header with status and degree kept separate", () => {
    const document: PublicDocument = {
      id: "sample-education",
      type: "background",
      title: "Sample Program",
      summary: "Summary",
      skills: [],
      topics: ["Software Engineering Education"],
      featured: false,
      visibility: "public",
      assistant_retrievable: true,
      last_reviewed: "2026-09-28",
      category: "education",
      institution: "Sample Institute",
      program: "Sample Program",
      start_date: "2021-10",
      end_date: "2022-08",
      education_status: "completed",
      degree_awarded: false,
      sections: [],
      file: "sample-education.md",
    };

    expect(factsHeader(document)).toEqual([
      "Facts:",
      "Institution: Sample Institute",
      "Program: Sample Program",
      "Start date: 2021-10",
      "End date: 2022-08",
      "Education status: completed",
      "Degree awarded: no",
      "Topics: Software Engineering Education",
      "",
    ]);
  });

  it("keeps the real corpus byte-identical across runs and inside the evidence caps", () => {
    const first = tempPaths();
    const second = tempPaths();
    const manifest = writeRetrievalArtifacts(undefined, first.directory, first.manifest);
    writeRetrievalArtifacts(undefined, second.directory, second.manifest);

    let total = 0;
    for (const filename of listRetrievalFiles(first.directory)) {
      const left = readFileSync(join(first.directory, filename));
      expect(left.equals(readFileSync(join(second.directory, filename)))).toBe(true);
    }
    for (const chunk of manifest.chunks) {
      const text = readFileSync(join(first.directory, chunk.sourceFilename), "utf8");
      expect(text).toContain("\nFacts:\n");
      expect(text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      total += text.length;
    }
    expect(total).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
  });

  it("keeps readable wording while removing markdown presentation", () => {
    expect(
      plainSectionText("- Extended the platform.\n\nSee [the role](/experience/aws-sde-ii)."),
    ).toBe("Extended the platform.\n\nSee the role.");
  });
});

function tempPaths(): { directory: string; manifest: string } {
  const root = mkdtempSync(join(tmpdir(), "retrieval-"));
  return {
    directory: join(root, "retrieval"),
    manifest: join(root, "retrieval-manifest.json"),
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sampleDocument(): PublicDocument {
  return {
    id: "aws-sde-ii",
    type: "experience",
    title: "Software Development Engineer II",
    summary: "Summary",
    skills: [],
    topics: [],
    featured: true,
    visibility: "public",
    assistant_retrievable: true,
    last_reviewed: "2026-09-28",
    employer: "Amazon Web Services",
    role_title: "Software Development Engineer II",
    start_date: "2025-12",
    end_date: null,
    employment_type: "Full-time",
    location: "Seattle, WA",
    sections: [
      {
        heading: "Role Description",
        slug: "role-description",
        url: "/experience/aws-sde-ii#role-description",
        body: "Role text.",
      },
    ],
    file: "aws-sde-ii.md",
  };
}
