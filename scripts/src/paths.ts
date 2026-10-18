import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export const repoRoot = join(sourceDirectory, "..", "..");
export const defaultContentDir = join(repoRoot, "content", "public");
export const documentSchemaPath = join(repoRoot, "schemas", "public-document.schema.json");
export const canonicalCareerIndexPath = join(repoRoot, "generated", "career-index.json");
export const retrievalDirectory = join(repoRoot, "generated", "retrieval");
export const retrievalManifestPath = join(repoRoot, "generated", "retrieval-manifest.json");
export const webCareerIndexPath = join(repoRoot, "apps", "web", "public", "career-index.json");
export const pythonCareerIndexPath = join(
  repoRoot,
  "services",
  "ask-api",
  "src",
  "ask_api",
  "data",
  "career-index.json",
);
export const careerIndexCopyPaths = [webCareerIndexPath, pythonCareerIndexPath] as const;
export const openApiPath = join(repoRoot, "schemas", "ask-api.openapi.yaml");
export const askApiProjectDir = join(repoRoot, "services", "ask-api");
export const askApiPackageDir = join(askApiProjectDir, "src", "ask_api");
export const lambdaAssetPath = join(repoRoot, "infrastructure", "asset", "ask-api");
