import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * The AWS Lambda Web Adapter binary, packaged as this project's own Lambda layer.
 *
 * The project publishes no binaries on GitHub releases. The prebuilt arm64 binary is in the
 * public image public.ecr.aws/awsguru/aws-lambda-adapter, read here anonymously over the OCI
 * registry API (no credentials, no account). Three pins make the download fail closed:
 * the arm64 manifest digest, each layer blob's digest from that manifest, and the SHA-256 of
 * the extracted binary.
 */
export const WEB_ADAPTER_VERSION = "1.1.0";
export const WEB_ADAPTER_REGISTRY = "https://public.ecr.aws";
export const WEB_ADAPTER_REPOSITORY = "awsguru/aws-lambda-adapter";
/** The linux/arm64 manifest that the 1.1.0 index pointed to on October 18, 2026. */
export const WEB_ADAPTER_ARM64_MANIFEST =
  "sha256:98d6d1dc9ad3f18c6af7baaa397fb033a57d82f5bffb58ff33bef1c2e1f4f0fe";
/** SHA-256 of /lambda-adapter inside that image. */
export const WEB_ADAPTER_BINARY_SHA256 =
  "317590a03cf57b695c2075c6f42c01cc22ce50d5eb21d6b7ca844cba0403dedc";

/**
 * The layer's /opt/bootstrap. It is AWS_LAMBDA_EXEC_WRAPPER: the runtime hands it its own
 * start command, and it starts the function's handler script instead, as the adapter's own
 * layer does. The adapter itself runs as the extension in /opt/extensions.
 */
export const WEB_ADAPTER_BOOTSTRAP = '#!/bin/bash\nexec -- "${LAMBDA_TASK_ROOT}/${_HANDLER}"\n';

const MANIFEST_TYPES = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface WebAdapterPins {
  manifestDigest: string;
  binarySha256: string;
}

export const webAdapterPins: WebAdapterPins = {
  manifestDigest: WEB_ADAPTER_ARM64_MANIFEST,
  binarySha256: WEB_ADAPTER_BINARY_SHA256,
};

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The layer directory is ready when the binary matches the pin and the bootstrap is present. */
export function webAdapterLayerReady(layerDirectory: string, pins = webAdapterPins): boolean {
  const binary = join(layerDirectory, "extensions", "lambda-adapter");
  const bootstrap = join(layerDirectory, "bootstrap");
  if (!existsSync(binary) || !existsSync(bootstrap)) {
    return false;
  }
  return (
    sha256Hex(readFileSync(binary)) === pins.binarySha256 &&
    readFileSync(bootstrap, "utf8") === WEB_ADAPTER_BOOTSTRAP
  );
}

/**
 * Download, verify, and write the layer: extensions/lambda-adapter and bootstrap, both
 * executable. Anything that does not match a pin throws, and nothing is written.
 */
export async function prepareWebAdapterLayer(
  layerDirectory: string,
  fetchImpl: Fetch = fetch,
  pins = webAdapterPins,
): Promise<"cached" | "downloaded"> {
  if (webAdapterLayerReady(layerDirectory, pins)) {
    return "cached";
  }
  const binary = await downloadWebAdapter(fetchImpl, pins);
  rmSync(layerDirectory, { recursive: true, force: true });
  mkdirSync(join(layerDirectory, "extensions"), { recursive: true });
  const binaryPath = join(layerDirectory, "extensions", "lambda-adapter");
  writeFileSync(binaryPath, binary);
  chmodSync(binaryPath, 0o755);
  const bootstrapPath = join(layerDirectory, "bootstrap");
  writeFileSync(bootstrapPath, WEB_ADAPTER_BOOTSTRAP);
  chmodSync(bootstrapPath, 0o755);
  return "downloaded";
}

export async function downloadWebAdapter(
  fetchImpl: Fetch,
  pins = webAdapterPins,
): Promise<Uint8Array> {
  const token = await registryToken(fetchImpl);
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${WEB_ADAPTER_REGISTRY}/v2/${WEB_ADAPTER_REPOSITORY}`;

  const manifestBytes = await download(fetchImpl, `${base}/manifests/${pins.manifestDigest}`, {
    ...headers,
    Accept: MANIFEST_TYPES,
  });
  verifyDigest(manifestBytes, pins.manifestDigest, "image manifest");
  const layers = manifestLayers(JSON.parse(new TextDecoder().decode(manifestBytes)));

  for (const layer of layers) {
    const blob = await download(fetchImpl, `${base}/blobs/${layer}`, headers);
    verifyDigest(blob, layer, "image layer");
    const binary = tarEntry(gunzipSync(blob), "lambda-adapter");
    if (binary !== null) {
      const actual = sha256Hex(binary);
      if (actual !== pins.binarySha256) {
        throw new Error(
          `The Lambda Web Adapter binary does not match the pinned SHA-256 (got ${actual}).`,
        );
      }
      return binary;
    }
  }
  throw new Error("The pinned image has no /lambda-adapter file.");
}

async function registryToken(fetchImpl: Fetch): Promise<string> {
  const scope = `repository:${WEB_ADAPTER_REPOSITORY}:pull`;
  const bytes = await download(fetchImpl, `${WEB_ADAPTER_REGISTRY}/token/?scope=${scope}`, {});
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const token = isRecord(parsed) ? parsed.token : undefined;
  if (typeof token !== "string" || token === "") {
    throw new Error("The public registry did not return a pull token.");
  }
  return token;
}

async function download(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    // The URL is public; the token header is never included in the message.
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function verifyDigest(data: Uint8Array, digest: string, what: string): void {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (match === null || sha256Hex(data) !== match[1]) {
    throw new Error(`The ${what} does not match its pinned digest ${digest}.`);
  }
}

function manifestLayers(manifest: unknown): string[] {
  const layers = isRecord(manifest) ? manifest.layers : undefined;
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error("The image manifest lists no layers.");
  }
  return layers.map((layer: unknown) => {
    const digest = isRecord(layer) ? layer.digest : undefined;
    if (typeof digest !== "string") {
      throw new Error("The image manifest has a layer without a digest.");
    }
    return digest;
  });
}

/** The contents of a regular file in a tar archive, matched by its path without "./". */
export function tarEntry(archive: Uint8Array, wanted: string): Uint8Array | null {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      return null;
    }
    const field = (start: number, length: number) =>
      decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const path = (prefix === "" ? name : `${prefix}/${name}`).replace(/^\.\//, "");
    const start = offset + 512;
    if ((type === "0" || type === "") && path === wanted) {
      return archive.slice(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
