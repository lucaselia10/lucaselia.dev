import { writeRetrievalArtifacts } from "./build-retrieval.js";
import { checkPublicFiles, readBlocklist } from "./check-public.js";
import {
  askApiPackageDir,
  webAdapterLayerPath,
  canonicalCareerIndexPath,
  careerIndexCopyPaths,
  lambdaAssetPath,
  retrievalDirectory,
  retrievalManifestPath,
} from "./paths.js";
import { copyEvidencePackage, stageLambdaAsset } from "./stage-lambda-asset.js";
import {
  WEB_ADAPTER_VERSION,
  prepareWebAdapterLayer,
  prepareWebAdapterStub,
  webAdapterPins,
} from "./web-adapter.js";
import { synchronizeCareerIndex, validateCorpus, writeCareerIndex } from "./validate-content.js";

const command = process.argv[2];
const directory = process.argv[3];

if (command === "validate") {
  const result = directory ? validateCorpus(directory) : validateCorpus();
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(`Validated ${result.documents.length} public document(s).`);
} else if (command === "index") {
  try {
    const index = directory
      ? writeCareerIndex(canonicalCareerIndexPath, directory)
      : writeCareerIndex();
    console.log(JSON.stringify(index, null, 2));
    console.error(`Wrote ${canonicalCareerIndexPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Content indexing failed.";
    console.error(message);
    process.exit(1);
  }
} else if (command === "stage-lambda") {
  try {
    stageLambdaAsset();
    console.error(`Staged Lambda asset at ${lambdaAssetPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lambda asset staging failed.";
    console.error(message);
    process.exit(1);
  }
} else if (command === "sync-evidence") {
  try {
    copyEvidencePackage(retrievalDirectory, retrievalManifestPath, askApiPackageDir);
    console.error(`Copied the evidence package into ${askApiPackageDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evidence sync failed.";
    console.error(message);
    process.exit(1);
  }
} else if (command === "fetch-web-adapter") {
  try {
    if (process.argv.includes("--stub")) {
      // CI: no network. The site app refuses this layer unless the synth says it will not
      // deploy (-c webAdapterStub=allow).
      const result = prepareWebAdapterStub(webAdapterLayerPath);
      console.error(
        result === "stub"
          ? `Wrote a STUB Lambda Web Adapter layer at ${webAdapterLayerPath} (not deployable).`
          : `Kept the verified Lambda Web Adapter ${WEB_ADAPTER_VERSION} at ${webAdapterLayerPath}.`,
      );
    } else {
      // WEB_ADAPTER_REGISTRY_URL only redirects the download (the CI rehearsal points it at an
      // unreachable host); the digest and checksum pins still decide what is accepted.
      const registry = process.env.WEB_ADAPTER_REGISTRY_URL?.trim() || undefined;
      const result = await prepareWebAdapterLayer(webAdapterLayerPath, fetch, webAdapterPins, {
        ...(registry ? { registry } : {}),
        log: (line) => console.error(line),
      });
      console.error(
        `Lambda Web Adapter ${WEB_ADAPTER_VERSION} layer ${result} at ${webAdapterLayerPath}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lambda Web Adapter fetch failed.";
    console.error(message);
    process.exit(1);
  }
} else if (command === "build-retrieval") {
  try {
    const manifest = directory ? writeRetrievalArtifacts(directory) : writeRetrievalArtifacts();
    console.error(
      `Wrote ${manifest.chunkCount} retrieval chunk(s) to ${retrievalDirectory} and ${retrievalManifestPath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retrieval artifact build failed.";
    console.error(message);
    process.exit(1);
  }
} else if (command === "sync") {
  try {
    synchronizeCareerIndex();
    for (const destination of careerIndexCopyPaths) {
      console.error(`Copied ${canonicalCareerIndexPath} to ${destination}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Content index sync failed.";
    console.error(message);
    process.exit(1);
  }
} else if (command === "check-public") {
  const blocklist = readBlocklist();
  const result = checkPublicFiles(undefined, blocklist);
  for (const finding of result.findings) {
    console.error(`${finding.path}:${finding.line}: ${finding.rule}`);
  }
  const source = blocklist.length > 0 ? `${blocklist.length} private phrase(s)` : "no private list";
  if (result.findings.length > 0) {
    console.error(
      `check:public found ${result.findings.length} issue(s) in ${result.files} file(s).`,
    );
    process.exit(1);
  }
  console.log(`check:public passed: ${result.files} file(s), ${source}.`);
} else {
  console.error(
    "Usage: tsx src/cli.ts <validate|index|sync|stage-lambda|build-retrieval|check-public> [content-directory]",
  );
  process.exit(1);
}
