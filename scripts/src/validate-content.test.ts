import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCUMENT_TYPES,
  EDUCATION_STATUSES,
  PROJECT_STATUSES,
  VISIBILITIES,
  citationUrl,
} from "@career-portfolio/content";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { writeRetrievalArtifacts } from "./build-retrieval.js";
import {
  canonicalCareerIndexPath,
  documentSchemaPath,
  pythonCareerIndexPath,
  webCareerIndexPath,
} from "./paths.js";
import {
  buildIndex,
  synchronizeCareerIndex,
  validateCorpus,
  writeCareerIndex,
} from "./validate-content.js";

const overview = "## Overview\n\nFictional evidence.\n";

const common = {
  title: "Fictional document",
  summary: "Fictional summary used only to test the schema.",
  skills: ["Markdown"],
  topics: ["scaffold"],
  featured: false,
  visibility: "public" as const,
  assistant_retrievable: true,
  last_reviewed: "2026-09-27",
};

const project = {
  ...common,
  id: "fictional-lumen-harbor",
  title: "Lumen Harbor Signal Buoy",
  type: "project" as const,
  status: "completed" as const,
  roles: [] as string[],
};

const experience = {
  ...common,
  id: "fictional-keeper",
  title: "Fictional Keeper",
  type: "experience" as const,
  employer: "Fictional Harbor",
  role_title: "Keeper",
  start_date: "2020-01",
  end_date: null,
  employment_type: "fictional",
  location: "Fictional coast",
};

const profile = {
  ...common,
  id: "fictional-profile",
  type: "profile" as const,
  headline: "Fictional headline",
  location: "Fictional coast",
  current_role: "fictional-keeper",
};

const background = {
  ...common,
  id: "fictional-path",
  type: "background" as const,
  category: "education" as const,
  institution: "Fictional College",
  program: "Fictional Studies",
  start_date: "2010-06",
  end_date: "2019-12",
  education_status: "attended" as const,
  degree_awarded: false,
};

describe("public content validation", () => {
  it("accepts the approved public corpus and its citation targets", () => {
    const result = validateCorpus();
    const byId = new Map(result.documents.map((document) => [document.id, document]));
    const profile = byId.get("lucas-elia");
    const role = byId.get("aws-sde-ii");
    const fixture = byId.get("fictional-lumen-harbor");

    expect(result.errors).toEqual([]);
    expect([...byId.keys()].sort()).toEqual([
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
    expect(byId.get("expert-assist-consultant")).toMatchObject({
      type: "experience",
      location: null,
      visibility: "public",
    });
    expect(profile).toMatchObject({
      type: "profile",
      visibility: "public",
      current_role: "aws-sde-ii",
    });
    expect(byId.get("lucas-elia")).toMatchObject({ assistant_retrievable: true });
    expect(byId.get("fictional-lumen-harbor")).toMatchObject({
      visibility: "public",
      assistant_retrievable: false,
    });
    expect(profile?.sections).toContainEqual(
      expect.objectContaining({
        heading: "About",
        slug: "about",
        url: "/profile/lucas-elia#about",
      }),
    );
    expect(role).toMatchObject({
      type: "experience",
      visibility: "public",
      employer: "Amazon Web Services",
      end_date: null,
    });
    expect(role?.sections).toContainEqual(
      expect.objectContaining({
        heading: "Role Description",
        slug: "role-description",
        url: "/experience/aws-sde-ii#role-description",
      }),
    );
    expect(fixture).toMatchObject({
      type: "project",
      status: "completed",
      roles: [],
      visibility: "public",
    });
    expect(fixture?.sections).toContainEqual(
      expect.objectContaining({
        heading: "Outcome",
        slug: "outcome",
        url: "/work/fictional-lumen-harbor#outcome",
      }),
    );
  });

  it("builds a career index with deterministic facts and source references", () => {
    const index = buildIndex();
    const document = index.documents.find((entry) => entry.id === "fictional-lumen-harbor");

    expect(index.schemaVersion).toBe(1);
    expect(index.documents.map((entry) => entry.id)).toEqual([
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
    expect(index.documents.every((entry) => entry.visibility === "public")).toBe(true);
    expect(
      index.facts.some(
        (fact) => fact.documentId === "expert-assist-consultant" && fact.kind === "location",
      ),
    ).toBe(false);
    expect(document?.url).toBe("/work/fictional-lumen-harbor");
    expect(document).toMatchObject({ visibility: "public", assistant_retrievable: false });
    expect(index.documents.find((entry) => entry.id === "aws-sde-ii")).toMatchObject({
      assistant_retrievable: true,
    });
    expect(document?.sections[0]).toEqual({
      heading: "Overview",
      url: "/work/fictional-lumen-harbor#overview",
    });
    expect(index.facts).toEqual(
      expect.arrayContaining([
        {
          kind: "status",
          value: "completed",
          documentId: "fictional-lumen-harbor",
          url: "/work/fictional-lumen-harbor",
        },
        {
          kind: "skill",
          value: "Markdown",
          documentId: "fictional-lumen-harbor",
          url: "/work/fictional-lumen-harbor",
        },
        {
          kind: "last_reviewed",
          value: "2026-09-27",
          documentId: "fictional-lumen-harbor",
          url: "/work/fictional-lumen-harbor",
        },
      ]),
    );
    expect(index.sources).toContainEqual({
      chunkId: "fictional-lumen-harbor:outcome:0",
      documentId: "fictional-lumen-harbor",
      title: "Lumen Harbor Signal Buoy",
      section: "Outcome",
      type: "project",
      roles: [],
      skills: ["Markdown"],
      url: "/work/fictional-lumen-harbor#outcome",
    });
    expect(index.facts).toEqual(
      expect.arrayContaining([
        {
          kind: "current_role",
          value: "aws-sde-ii",
          documentId: "lucas-elia",
          url: "/profile/lucas-elia",
        },
        {
          kind: "employer",
          value: "Amazon Web Services",
          documentId: "aws-sde-ii",
          url: "/experience/aws-sde-ii",
        },
        {
          kind: "end_date",
          value: null,
          documentId: "aws-sde-ii",
          url: "/experience/aws-sde-ii",
        },
        {
          kind: "location",
          value: "Seattle, WA",
          documentId: "aws-sde-i",
          url: "/experience/aws-sde-i",
        },
        {
          kind: "employment_type",
          value: "Contract",
          documentId: "expert-assist-consultant",
          url: "/experience/expert-assist-consultant",
        },
        {
          kind: "institution",
          value: "BloomTech",
          documentId: "bloomtech-backend-development",
          url: "/background/bloomtech-backend-development",
        },
        {
          kind: "education_status",
          value: "completed",
          documentId: "bloomtech-backend-development",
          url: "/background/bloomtech-backend-development",
        },
        {
          kind: "degree_awarded",
          value: false,
          documentId: "bloomtech-backend-development",
          url: "/background/bloomtech-backend-development",
        },
        {
          kind: "education_status",
          value: "attended",
          documentId: "sierra-college-general-studies",
          url: "/background/sierra-college-general-studies",
        },
        {
          kind: "degree_awarded",
          value: false,
          documentId: "sierra-college-general-studies",
          url: "/background/sierra-college-general-studies",
        },
      ]),
    );
    expect(index.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunkId: "lucas-elia:about:0",
          documentId: "lucas-elia",
          section: "About",
          type: "profile",
          url: "/profile/lucas-elia#about",
        }),
        expect.objectContaining({
          chunkId: "aws-sde-ii:role-description:0",
          documentId: "aws-sde-ii",
          section: "Role Description",
          type: "experience",
          url: "/experience/aws-sde-ii#role-description",
        }),
        expect.objectContaining({
          chunkId: "aws-sde-i:role-description:0",
          url: "/experience/aws-sde-i#role-description",
        }),
        expect.objectContaining({
          chunkId: "aws-sde-apprentice:role-description:0",
          url: "/experience/aws-sde-apprentice#role-description",
        }),
        expect.objectContaining({
          chunkId: "expert-assist-consultant:role-description:0",
          url: "/experience/expert-assist-consultant#role-description",
        }),
        expect.objectContaining({
          chunkId: "hospitality-businesses-co-founder:role-description:0",
          url: "/experience/hospitality-businesses-co-founder#role-description",
        }),
        expect.objectContaining({
          chunkId: "bloomtech-backend-development:program:0",
          section: "Program",
          type: "background",
          url: "/background/bloomtech-backend-development#program",
        }),
        expect.objectContaining({
          chunkId: "sierra-college-general-studies:coursework:0",
          section: "Coursework",
          type: "background",
          url: "/background/sierra-college-general-studies#coursework",
        }),
      ]),
    );
  });

  it("writes the career index as JSON", () => {
    const destination = join(mkdtempSync(join(tmpdir(), "career-index-")), "career-index.json");

    writeCareerIndex(destination);

    const written = JSON.parse(readFileSync(destination, "utf8")) as {
      schemaVersion: number;
      sources: Array<{ url: string }>;
    };
    expect(written.schemaVersion).toBe(1);
    expect(written.sources.some((source) => source.url.endsWith("#outcome"))).toBe(true);
  });

  it("copies the canonical career index byte-for-byte to both consumers", () => {
    const directory = mkdtempSync(join(tmpdir(), "career-index-sync-"));
    const source = join(directory, "canonical.json");
    const webCopy = join(directory, "web", "career-index.json");
    const pythonCopy = join(directory, "python", "career-index.json");
    writeFileSync(source, '{"schemaVersion":1,"marker":"byte-copy"}\n');

    synchronizeCareerIndex(source, [webCopy, pythonCopy]);

    const canonical = readFileSync(source);
    expect(readFileSync(webCopy).equals(canonical)).toBe(true);
    expect(readFileSync(pythonCopy).equals(canonical)).toBe(true);
    expect(canonicalCareerIndexPath.endsWith("generated/career-index.json")).toBe(true);
  });

  it("synchronizes the generated public index to the website and Python package", () => {
    writeCareerIndex();
    synchronizeCareerIndex();

    const canonical = readFileSync(canonicalCareerIndexPath);
    const parsed = JSON.parse(canonical.toString("utf8")) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
    expect(readFileSync(webCareerIndexPath).equals(canonical)).toBe(true);
    expect(readFileSync(pythonCareerIndexPath).equals(canonical)).toBe(true);
  });

  it("accepts one valid document of every type and keeps the citation routes", () => {
    const result = validateCorpus(
      writeCorpus({
        "project.md": markdown(project),
        "experience.md": markdown(experience),
        "background.md": markdown(background),
        "profile.md": markdown(profile),
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.documents.map((document) => document.type).sort()).toEqual([
      "background",
      "experience",
      "profile",
      "project",
    ]);
    expect(sectionUrl(result.documents, "fictional-lumen-harbor")).toBe(
      citationUrl("project", "fictional-lumen-harbor", "Overview"),
    );
    expect(sectionUrl(result.documents, "fictional-keeper")).toBe(
      "/experience/fictional-keeper#overview",
    );
    expect(sectionUrl(result.documents, "fictional-path")).toBe(
      "/background/fictional-path#overview",
    );
    expect(sectionUrl(result.documents, "fictional-profile")).toBe(
      "/profile/fictional-profile#overview",
    );
  });

  it("excludes draft documents from the career index", () => {
    const directory = writeCorpus({
      "project.md": markdown(project),
      "draft.md": markdown({
        ...experience,
        id: "fictional-draft-role",
        visibility: "draft",
      }),
    });

    const result = validateCorpus(directory);
    const index = buildIndex(directory);

    expect(result.errors).toEqual([]);
    expect(result.documents.map((document) => document.id).sort()).toEqual([
      "fictional-draft-role",
      "fictional-lumen-harbor",
    ]);
    expect(index.documents.map((document) => document.id)).toEqual(["fictional-lumen-harbor"]);
    expect(JSON.stringify(index)).not.toContain("fictional-draft-role");
  });

  it("uses the same document types as the public schema", () => {
    const schema = JSON.parse(readFileSync(documentSchemaPath, "utf8")) as {
      oneOf: Array<{ $ref: string }>;
      $defs: Record<
        string,
        {
          enum?: string[];
          properties?: {
            type?: { const: string };
            status?: { enum: string[] };
            education_status?: { enum: string[] };
          };
        }
      >;
    };
    const types = schema.oneOf.map((branch) => {
      const name = branch.$ref.replace("#/$defs/", "");
      return schema.$defs[name]?.properties?.type?.const;
    });

    expect(types).toEqual([...DOCUMENT_TYPES]);
    expect(schema.$defs.visibility?.enum).toEqual([...VISIBILITIES]);
    expect(schema.$defs.project?.properties?.status?.enum).toEqual([...PROJECT_STATUSES]);
    expect(schema.$defs.background?.properties?.education_status?.enum).toEqual([
      ...EDUCATION_STATUSES,
    ]);
  });

  it("requires a boolean assistant_retrievable flag", () => {
    const { assistant_retrievable: _flag, ...missingFlag } = project;
    const missing = validateCorpus(writeCorpus({ "missing.md": markdown(missingFlag) }));
    const invalid = validateCorpus(
      writeCorpus({
        "invalid.md": markdown({ ...project, assistant_retrievable: "yes" }),
      }),
    );

    expect(missing.errors.some((error) => error.includes("assistant_retrievable"))).toBe(true);
    expect(invalid.errors.some((error) => error.includes("assistant_retrievable"))).toBe(true);
  });

  it("rejects missing common required fields", () => {
    const { skills: _skills, ...withoutSkills } = project;
    const result = validateCorpus(writeCorpus({ "missing.md": markdown(withoutSkills) }));

    expect(result.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
    expect(result.errors.some((error) => error.includes("skills"))).toBe(true);
  });

  it("rejects missing type-specific required fields", () => {
    const { status: _status, ...withoutStatus } = project;
    const result = validateCorpus(writeCorpus({ "missing.md": markdown(withoutStatus) }));

    expect(result.errors.some((error) => error.includes("status"))).toBe(true);
  });

  it("rejects an invalid document id", () => {
    const result = validateCorpus(
      writeCorpus({ "bad-id.md": markdown({ ...project, id: "Not A Slug" }) }),
    );

    expect(result.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
  });

  it("rejects an invalid month and an end date that precedes the start date", () => {
    const invalidMonth = validateCorpus(
      writeCorpus({
        "bad-month.md": markdown({ ...experience, start_date: "2020-13" }),
      }),
    );
    const reversed = validateCorpus(
      writeCorpus({
        "reversed.md": markdown({
          ...experience,
          start_date: "2021-05",
          end_date: "2020-01",
        }),
      }),
    );

    expect(invalidMonth.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
    expect(reversed.errors.some((error) => error.includes("precedes"))).toBe(true);
  });

  it("accepts an experience location of null and omits that fact", () => {
    const directory = writeCorpus({
      "unspecified.md": markdown({ ...experience, id: "fictional-unspecified", location: null }),
    });
    const result = validateCorpus(directory);
    const facts = buildIndex(directory).facts.filter(
      (fact) => fact.documentId === "fictional-unspecified",
    );

    expect(result.errors).toEqual([]);
    expect(result.documents[0]).toMatchObject({ location: null });
    expect(facts.some((fact) => fact.kind === "location")).toBe(false);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "employer", value: "Fictional Harbor" }),
      ]),
    );
  });

  it("rejects a missing location key and an empty location string", () => {
    const { location: _location, ...withoutLocation } = experience;
    const missing = validateCorpus(writeCorpus({ "missing.md": markdown(withoutLocation) }));
    const empty = validateCorpus(
      writeCorpus({ "empty.md": markdown({ ...experience, location: "" }) }),
    );

    expect(missing.errors.some((error) => error.includes("location"))).toBe(true);
    expect(empty.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
    expect(empty.errors.some((error) => error.includes("location"))).toBe(true);
  });

  it("accepts an education background document and indexes degree_awarded as a boolean", () => {
    const awarded = writeCorpus({
      "awarded.md": markdown({ ...background, id: "fictional-degree", degree_awarded: true }),
    });
    const facts = buildIndex(awarded).facts.filter((fact) => fact.kind === "degree_awarded");

    expect(validateCorpus(awarded).errors).toEqual([]);
    expect(facts).toEqual([
      expect.objectContaining({ documentId: "fictional-degree", value: true }),
    ]);
    expect(facts[0]?.value).toBe(true);
  });

  it("accepts https contact links and a valid email on the profile, and rejects bad ones", () => {
    const contact = {
      linkedin_url: "https://www.linkedin.com/in/fictional",
      github_url: "https://github.com/fictional",
      email: "fictional@example.com",
    };
    const corpus = (overrides: Record<string, unknown>) =>
      validateCorpus(
        writeCorpus({
          "keeper.md": markdown(experience),
          "profile.md": markdown({ ...profile, ...contact, ...overrides }),
        }),
      );

    expect(corpus({}).errors).toEqual([]);
    expect(corpus({ linkedin_url: "http://www.linkedin.com/in/fictional" }).errors).not.toEqual([]);
    expect(corpus({ github_url: "github.com/fictional" }).errors).not.toEqual([]);
    expect(corpus({ github_url: "https://" }).errors).not.toEqual([]);
    expect(corpus({ email: "not-an-email" }).errors).not.toEqual([]);
    expect(corpus({ email: "fictional@" }).errors).not.toEqual([]);
    expect(
      validateCorpus(writeCorpus({ "keeper.md": markdown({ ...experience, ...contact }) })).errors,
    ).not.toEqual([]);
  });

  it("keeps contact fields out of the career index and the retrieval artifacts", () => {
    const directory = writeCorpus({
      "keeper.md": markdown(experience),
      "profile.md": markdown({
        ...profile,
        linkedin_url: "https://www.linkedin.com/in/fictional-contact",
        github_url: "https://github.com/fictional-contact",
        email: "fictional-contact@example.com",
      }),
    });
    const index = JSON.stringify(buildIndex(directory));
    const output = mkdtempSync(join(tmpdir(), "contact-retrieval-"));
    writeRetrievalArtifacts(directory, join(output, "retrieval"), join(output, "manifest.json"));
    const chunks = readdirSync(join(output, "retrieval"))
      .map((name) => readFileSync(join(output, "retrieval", name), "utf8"))
      .join("\n");

    for (const text of [index, chunks]) {
      expect(text).not.toContain("fictional-contact");
      expect(text).not.toContain("linkedin_url");
      expect(text).not.toContain("@example.com");
    }
  });

  it("rejects invalid education background fields", () => {
    const { institution: _institution, ...withoutInstitution } = background;
    const missing = validateCorpus(writeCorpus({ "missing.md": markdown(withoutInstitution) }));
    const unknown = validateCorpus(
      writeCorpus({ "unknown.md": markdown({ ...background, honors: "none" }) }),
    );
    const category = validateCorpus(
      writeCorpus({ "category.md": markdown({ ...background, category: "business" }) }),
    );
    const status = validateCorpus(
      writeCorpus({ "status.md": markdown({ ...background, education_status: "graduated" }) }),
    );
    const degree = validateCorpus(
      writeCorpus({ "degree.md": markdown({ ...background, degree_awarded: "false" }) }),
    );
    const month = validateCorpus(
      writeCorpus({ "month.md": markdown({ ...background, start_date: "2021-13" }) }),
    );
    const reversed = validateCorpus(
      writeCorpus({
        "reversed.md": markdown({
          ...background,
          start_date: "2022-08",
          end_date: "2021-10",
        }),
      }),
    );

    expect(missing.errors.some((error) => error.includes("institution"))).toBe(true);
    expect(unknown.errors.some((error) => error.includes("additional propert"))).toBe(true);
    expect(category.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
    expect(status.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
    expect(degree.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
    expect(month.errors.some((error) => error.includes("invalid metadata"))).toBe(true);
    expect(reversed.errors.some((error) => error.includes("precedes"))).toBe(true);
  });

  it("rejects duplicate skills", () => {
    const result = validateCorpus(
      writeCorpus({
        "duplicates.md": markdown({ ...project, skills: ["Markdown", "Markdown"] }),
      }),
    );

    expect(result.errors.some((error) => error.includes("duplicate"))).toBe(true);
  });

  it("rejects unknown front-matter fields", () => {
    const result = validateCorpus(
      writeCorpus({
        "unknown.md": markdown({ ...project, nickname: "buoy" }),
      }),
    );

    expect(result.errors.some((error) => error.includes("additional propert"))).toBe(true);
  });

  it("rejects a document without a citation heading", () => {
    const result = validateCorpus(writeCorpus({ "missing-heading.md": markdown(project, "") }));

    expect(result.errors.some((error) => error.includes("no H2 section"))).toBe(true);
  });

  it("rejects a document type outside the approved set", () => {
    const result = validateCorpus(
      writeCorpus({ "bad-type.md": markdown({ ...project, type: "skill" }) }),
    );

    expect(result.errors.some((error) => error.includes("unsupported document type"))).toBe(true);
  });

  it("rejects private visibility", () => {
    const result = validateCorpus(
      writeCorpus({ "private.md": markdown({ ...project, visibility: "private" }) }),
    );

    expect(
      result.errors.some((error) => error.includes("visibility must be public or draft")),
    ).toBe(true);
  });

  it("rejects a citation route that cannot be resolved", () => {
    const result = validateCorpus(
      writeCorpus({
        "unresolved.md": markdown(project, `${overview}\n## ???\n\nNo anchor.\n`),
      }),
    );

    expect(result.errors.some((error) => error.includes("cannot be resolved"))).toBe(true);
  });

  it("rejects two headings that would share one citation anchor", () => {
    const result = validateCorpus(
      writeCorpus({
        "duplicate-anchor.md": markdown(
          project,
          `${overview}\n## Signal\n\nFirst.\n\n## Signal!\n\nSame anchor.\n`,
        ),
      }),
    );

    expect(result.errors.some((error) => error.includes("cannot be resolved"))).toBe(true);
  });

  it("rejects duplicate document ids", () => {
    const result = validateCorpus(
      writeCorpus({
        "one.md": markdown(project),
        "two.md": markdown(project),
      }),
    );

    expect(result.errors.some((error) => error.includes("duplicates id"))).toBe(true);
  });

  it("accepts a profile current_role that names an experience document", () => {
    const result = validateCorpus(
      writeCorpus({
        "experience.md": markdown(experience),
        "profile.md": markdown(profile),
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it("rejects a current_role that is missing or is not experience", () => {
    const missing = validateCorpus(
      writeCorpus({
        "profile.md": markdown({ ...profile, current_role: "missing-role" }),
      }),
    );
    const wrongType = validateCorpus(
      writeCorpus({
        "project.md": markdown(project),
        "profile.md": markdown({ ...profile, current_role: project.id }),
      }),
    );

    expect(missing.errors.some((error) => error.includes("does not reference an existing"))).toBe(
      true,
    );
    expect(wrongType.errors.some((error) => error.includes("must reference an experience"))).toBe(
      true,
    );
  });

  it("accepts empty project roles and a role that names an experience document", () => {
    const empty = validateCorpus(writeCorpus({ "project.md": markdown(project) }));
    const directory = writeCorpus({
      "experience.md": markdown(experience),
      "project.md": markdown({ ...project, roles: [experience.id] }),
    });

    expect(empty.errors).toEqual([]);
    expect(validateCorpus(directory).errors).toEqual([]);
    expect(buildIndex(directory).facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "role_reference", value: experience.id }),
      ]),
    );
  });

  it("rejects a project role that is missing or is not experience", () => {
    const missing = validateCorpus(
      writeCorpus({
        "project.md": markdown({ ...project, roles: ["missing-role"] }),
      }),
    );
    const wrongType = validateCorpus(
      writeCorpus({
        "background.md": markdown(background),
        "project.md": markdown({ ...project, roles: [background.id] }),
      }),
    );

    expect(missing.errors.some((error) => error.includes("does not reference an existing"))).toBe(
      true,
    );
    expect(wrongType.errors.some((error) => error.includes("must reference an experience"))).toBe(
      true,
    );
  });

  it("rejects a public role reference to a draft experience document", () => {
    const result = validateCorpus(
      writeCorpus({
        "draft.md": markdown({ ...experience, visibility: "draft" }),
        "project.md": markdown({ ...project, roles: [experience.id] }),
      }),
    );

    expect(result.errors.some((error) => error.includes("draft document"))).toBe(true);
  });

  it("rejects internal host names and phone numbers", () => {
    // Made-up internal host, assembled at runtime so this file passes check:public.
    const internalHost = ["made-up-wiki", "corp", "amazon", "com"].join(".");
    const result = validateCorpus(
      writeCorpus({
        "unsafe.md": markdown(
          project,
          `${overview}\nSee https://${internalHost}/page and call 206-555-0100.\n`,
        ),
      }),
    );

    expect(result.errors.some((error) => error.includes("internal URL"))).toBe(true);
    expect(result.errors.some((error) => error.includes("phone number"))).toBe(true);
  });
});

function markdown(data: Record<string, unknown>, body = overview): string {
  return `---\n${stringify(data).trimEnd()}\n---\n\n${body}`;
}

function writeCorpus(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "career-content-"));
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return directory;
}

function sectionUrl(
  documents: Array<{ id: string; sections: Array<{ url: string }> }>,
  id: string,
): string | undefined {
  return documents.find((document) => document.id === id)?.sections[0]?.url;
}
