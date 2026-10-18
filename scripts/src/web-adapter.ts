import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  WEB_ADAPTER_ARM64_MANIFEST,
  WEB_ADAPTER_BINARY_SHA256,
  WEB_ADAPTER_BOOTSTRAP,
  WEB_ADAPTER_REGISTRY,
  WEB_ADAPTER_REPOSITORY,
  WEB_ADAPTER_STUB,
} from "../../infrastructure/lib/web-adapter-pin.js";

/**
 * The AWS Lambda Web Adapter binary, packaged as this project's own Lambda layer.
 *
 * The project publishes no binaries on GitHub releases. The prebuilt arm64 binary is in the
 * public image public.ecr.aws/awsguru/aws-lambda-adapter, read here anonymously over the OCI
 * registry API (an anonymous pull token, no credentials, no account). Three pins make the
 * download fail closed: the arm64 manifest digest, each layer blob's digest from that
 * manifest, and the SHA-256 of the extracted binary. The pins live in
 * infrastructure/lib/web-adapter-pin.ts, where the site app's deploy guard reads them too.
 *
 * The registry throttles anonymous pulls (shared CI runners see HTTP 429), so every request
 * is retried on 429, 5xx, or a network error, honoring Retry-After. CI does not fetch at all:
 * it synthesizes with a stub layer (prepareWebAdapterStub) that the deploy guard refuses.
 */
export {
  WEB_ADAPTER_ARM64_MANIFEST,
  WEB_ADAPTER_BINARY_SHA256,
  WEB_ADAPTER_BOOTSTRAP,
  WEB_ADAPTER_REGISTRY,
  WEB_ADAPTER_REPOSITORY,
  WEB_ADAPTER_STUB,
};
export { WEB_ADAPTER_VERSION } from "../../infrastructure/lib/web-adapter-pin.js";

export const RETRY_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 60_000;

export interface DownloadOptions {
  /** The registry base URL. Tests and the CI rehearsal point it elsewhere. */
  registry?: string;
  attempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
}

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
  options: DownloadOptions = {},
): Promise<"cached" | "downloaded"> {
  if (webAdapterLayerReady(layerDirectory, pins)) {
    return "cached";
  }
  const binary = await downloadWebAdapter(fetchImpl, pins, options);
  writeLayer(layerDirectory, binary);
  return "downloaded";
}

/**
 * Write a stub layer for synthesis without the network (CI). The stub is a script that fails
 * if it ever runs, and the site app refuses to synthesize it unless told the synth is not for
 * deploying. A verified real binary already in place is kept.
 */
export function prepareWebAdapterStub(
  layerDirectory: string,
  pins = webAdapterPins,
): "real" | "stub" {
  if (webAdapterLayerReady(layerDirectory, pins)) {
    return "real";
  }
  writeLayer(layerDirectory, new TextEncoder().encode(WEB_ADAPTER_STUB));
  return "stub";
}

function writeLayer(layerDirectory: string, binary: Uint8Array): void {
  rmSync(layerDirectory, { recursive: true, force: true });
  mkdirSync(join(layerDirectory, "extensions"), { recursive: true });
  const binaryPath = join(layerDirectory, "extensions", "lambda-adapter");
  writeFileSync(binaryPath, binary);
  chmodSync(binaryPath, 0o755);
  const bootstrapPath = join(layerDirectory, "bootstrap");
  writeFileSync(bootstrapPath, WEB_ADAPTER_BOOTSTRAP);
  chmodSync(bootstrapPath, 0o755);
}

export async function downloadWebAdapter(
  fetchImpl: Fetch,
  pins = webAdapterPins,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const registry = options.registry ?? WEB_ADAPTER_REGISTRY;
  const get = (url: string, headers: Record<string, string>) =>
    download(fetchImpl, url, headers, options);
  const token = await registryToken(registry, get);
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${registry}/v2/${WEB_ADAPTER_REPOSITORY}`;

  const manifestBytes = await get(`${base}/manifests/${pins.manifestDigest}`, {
    ...headers,
    Accept: MANIFEST_TYPES,
  });
  verifyDigest(manifestBytes, pins.manifestDigest, "image manifest");
  const layers = manifestLayers(JSON.parse(new TextDecoder().decode(manifestBytes)));

  for (const layer of layers) {
    const blob = await get(`${base}/blobs/${layer}`, headers);
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

/** Public ECR wants an anonymous bearer token, even for public images. */
async function registryToken(
  registry: string,
  get: (url: string, headers: Record<string, string>) => Promise<Uint8Array>,
): Promise<string> {
  const scope = `repository:${WEB_ADAPTER_REPOSITORY}:pull`;
  const bytes = await get(`${registry}/token/?scope=${scope}`, {});
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const token = isRecord(parsed) ? parsed.token : undefined;
  if (typeof token !== "string" || token === "") {
    throw new Error("The public registry did not return a pull token.");
  }
  return token;
}

/** GET with retries on 429, 5xx, and network errors. Other statuses fail at once. */
async function download(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  options: DownloadOptions,
): Promise<Uint8Array> {
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers });
    } catch (error) {
      if (attempt >= attempts) {
        const reason = error instanceof Error ? error.message : "network error";
        throw new Error(`Download failed after ${attempt} attempts (${reason}): ${url}`);
      }
      const wait = backoff(attempt, null);
      options.log?.(`Network error; retrying in ${wait} ms (attempt ${attempt} of ${attempts}).`);
      await sleep(wait);
      continue;
    }
    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= attempts) {
      // The URL is public; the token header is never included in the message.
      const tries = retryable ? ` after ${attempt} attempts` : "";
      throw new Error(`Download failed with HTTP ${response.status}${tries}: ${url}`);
    }
    const wait = backoff(attempt, response.headers.get("retry-after"));
    options.log?.(
      `HTTP ${response.status}; retrying in ${wait} ms (attempt ${attempt} of ${attempts}).`,
    );
    await sleep(wait);
  }
}

/** Retry-After (seconds or an HTTP date) when present, else 1 s, 2 s, 4 s, …; at most 60 s. */
export function backoff(attempt: number, retryAfter: string | null, now = Date.now()): number {
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    const fromHeader = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(fromHeader) && fromHeader >= 0) {
      return Math.min(Math.ceil(fromHeader), RETRY_MAX_DELAY_MS);
    }
  }
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
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
