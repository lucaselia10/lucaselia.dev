import { isPublishedVisibility } from "@career-portfolio/content";
import { getCollection, type CollectionEntry } from "astro:content";
import { buildCareerChart, type CareerChart, type ChartSource } from "./career-chart";

export type PublicDocument = CollectionEntry<"public">;
export type ExperienceDocument = PublicDocument & {
  data: Extract<PublicDocument["data"], { type: "experience" }>;
};
export type BackgroundDocument = PublicDocument & {
  data: Extract<PublicDocument["data"], { type: "background" }>;
};
export type ProfileDocument = PublicDocument & {
  data: Extract<PublicDocument["data"], { type: "profile" }>;
};

export function isProfile(document: PublicDocument): document is ProfileDocument {
  return document.data.type === "profile";
}

export function isExperience(document: PublicDocument): document is ExperienceDocument {
  return document.data.type === "experience";
}

export function isBackground(document: PublicDocument): document is BackgroundDocument {
  return document.data.type === "background";
}

/** Newest first, then by id. */
export function byStartDateDescending(
  left: ExperienceDocument | BackgroundDocument,
  right: ExperienceDocument | BackgroundDocument,
): number {
  const byDate = right.data.start_date.localeCompare(left.data.start_date);
  return byDate === 0 ? left.data.id.localeCompare(right.data.id) : byDate;
}

/** Published documents. The fictional fixture keeps its own route and is excluded here. */
export async function careerDocuments(): Promise<PublicDocument[]> {
  return (await getCollection("public")).filter(
    (document) =>
      isPublishedVisibility(document.data.visibility) && !document.data.id.startsWith("fictional-"),
  );
}

export function toChartSource(document: PublicDocument): ChartSource {
  const data = document.data;
  if (data.type === "experience") {
    return {
      id: data.id,
      type: "experience",
      visibility: data.visibility,
      role_title: data.role_title,
      employer: data.employer,
      employment_type: data.employment_type,
      start_date: data.start_date,
      end_date: data.end_date,
    };
  }
  if (data.type === "background") {
    return {
      id: data.id,
      type: "background",
      visibility: data.visibility,
      institution: data.institution,
      program: data.program,
      start_date: data.start_date,
      end_date: data.end_date,
    };
  }
  return { id: data.id, type: data.type, visibility: data.visibility };
}

/** The chart is built once per build, with the build date as Today. */
export async function careerChart(today: Date = BUILD_DATE): Promise<CareerChart> {
  return buildCareerChart((await careerDocuments()).map(toChartSource), today);
}

export const BUILD_DATE = new Date();

export type ContactLinks = { email?: string; linkedin?: string; github?: string };

/** Approved public contact destinations from the profile, or null when there are none. */
export function contactLinks(profile: ProfileDocument): ContactLinks | null {
  const links: ContactLinks = {
    email: profile.data.email,
    linkedin: profile.data.linkedin_url,
    github: profile.data.github_url,
  };
  return links.email || links.linkedin || links.github ? links : null;
}

export async function currentRole(): Promise<ExperienceDocument> {
  const documents = await careerDocuments();
  const profile = documents.find(isProfile);
  const role = documents
    .filter(isExperience)
    .find((document) => document.data.id === profile?.data.current_role);
  if (!profile || !role) {
    throw new Error("The public profile or its current role document is missing.");
  }
  return role;
}
