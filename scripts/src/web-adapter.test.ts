import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type Fetch,
  WEB_ADAPTER_BOOTSTRAP,
  WEB_ADAPTER_STUB,
  backoff,
  prepareWebAdapterLayer,
  prepareWebAdapterStub,
  sha256Hex,
  tarEntry,
  webAdapterPins,
} from "./web-adapter.js";

// Offline: a fake registry serves a tiny image built here. No network.
const BINARY = new TextEncoder().encode("\x7fELF fake lambda-adapter binary");

function tar(entries: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(name), 0);
    header.set(new TextEncoder().encode(data.length.toString(8).padStart(11, "0")), 124);
    header.set(new TextEncoder().encode("0"), 156);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return Uint8Array.from(blocks.flatMap((block) => Array.from(block)));
}

function registry(binary = BINARY) {
  const layer = gzipSync(tar({ "etc/other": new Uint8Array([1]), "./lambda-adapter": binary }));
  const layerDigest = `sha256:${sha256Hex(layer)}`;
  const manifest = new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 2, layers: [{ digest: layerDigest }] }),
  );
  const manifestDigest = `sha256:${sha256Hex(manifest)}`;
  const requests: string[] = [];
  const fetchImpl: Fetch = async (url) => {
    requests.push(url);
    if (url.includes("/token/")) {
      return new Response(JSON.stringify({ token: "anonymous" }));
    }
    if (url.endsWith(`/manifests/${manifestDigest}`)) {
      return new Response(manifest);
    }
    if (url.endsWith(`/blobs/${layerDigest}`)) {
      return new Response(layer);
    }
    return new Response("missing", { status: 404 });
  };
  return { fetchImpl, manifestDigest, requests };
}

describe("Lambda Web Adapter layer", () => {
  it("pins the published arm64 manifest and binary", () => {
    expect(webAdapterPins.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(webAdapterPins.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(webAdapterPins.binarySha256).not.toMatch(/^0+$/);
  });

  it("writes the verified binary and bootstrap, executable, then reuses them offline", async () => {
    const { fetchImpl, manifestDigest, requests } = registry();
    const pins = { manifestDigest, binarySha256: sha256Hex(BINARY) };
    const layer = join(mkdtempSync(join(tmpdir(), "lwa-")), "layer");

    expect(await prepareWebAdapterLayer(layer, fetchImpl, pins)).toBe("downloaded");
    const binary = join(layer, "extensions", "lambda-adapter");
    expect(readFileSync(binary)).toEqual(Buffer.from(BINARY));
    expect(readFileSync(join(layer, "bootstrap"), "utf8")).toBe(WEB_ADAPTER_BOOTSTRAP);
    expect(statSync(binary).mode & 0o111).toBe(0o111);
    expect(statSync(join(layer, "bootstrap")).mode & 0o111).toBe(0o111);

    const before = requests.length;
    expect(await prepareWebAdapterLayer(layer, fetchImpl, pins)).toBe("cached");
    expect(requests.length).toBe(before);
  });

  it("fails closed on a binary that does not match the pin, writing nothing", async () => {
    const { fetchImpl, manifestDigest } = registry();
    const layer = join(mkdtempSync(join(tmpdir(), "lwa-")), "layer");

    await expect(
      prepareWebAdapterLayer(layer, fetchImpl, { manifestDigest, binarySha256: "0".repeat(64) }),
    ).rejects.toThrow(/does not match the pinned SHA-256/);
    expect(existsSync(layer)).toBe(false);
  });

  it("fails closed on a manifest or layer that does not match its digest", async () => {
    const { fetchImpl } = registry();
    const pins = { manifestDigest: `sha256:${"1".repeat(64)}`, binarySha256: sha256Hex(BINARY) };
    await expect(
      prepareWebAdapterLayer(join(mkdtempSync(join(tmpdir(), "lwa-")), "l"), fetchImpl, pins),
    ).rejects.toThrow(/Download failed with HTTP 404|does not match its pinned digest/);

    const tampered: Fetch = async (url, init) => {
      const response = await registry().fetchImpl(url, init);
      return url.includes("/blobs/") ? new Response(gzipSync(new Uint8Array([9]))) : response;
    };
    const good = registry();
    await expect(
      prepareWebAdapterLayer(
        join(mkdtempSync(join(tmpdir(), "lwa-")), "l"),
        async (url, init) =>
          url.includes("/blobs/") ? tampered(url, init) : good.fetchImpl(url, init),
        { manifestDigest: good.manifestDigest, binarySha256: sha256Hex(BINARY) },
      ),
    ).rejects.toThrow(/does not match its pinned digest/);
  });

  it("replaces a layer folder whose binary was altered", async () => {
    const { fetchImpl, manifestDigest } = registry();
    const pins = { manifestDigest, binarySha256: sha256Hex(BINARY) };
    const layer = join(mkdtempSync(join(tmpdir(), "lwa-")), "layer");
    await prepareWebAdapterLayer(layer, fetchImpl, pins);
    writeFileSync(join(layer, "extensions", "lambda-adapter"), "tampered");

    expect(await prepareWebAdapterLayer(layer, fetchImpl, pins)).toBe("downloaded");
    expect(readFileSync(join(layer, "extensions", "lambda-adapter"))).toEqual(Buffer.from(BINARY));
  });

  it("reads regular files from a tar archive by path", () => {
    const archive = tar({ "a/b.txt": new Uint8Array([1, 2]), "./c": new Uint8Array([3]) });
    expect(tarEntry(archive, "c")).toEqual(new Uint8Array([3]));
    expect(tarEntry(archive, "a/b.txt")).toEqual(new Uint8Array([1, 2]));
    expect(tarEntry(archive, "missing")).toBeNull();
  });

  it("asks for an anonymous token first, then retries 429 and 5xx, honoring Retry-After", async () => {
    const good = registry();
    const pins = { manifestDigest: good.manifestDigest, binarySha256: sha256Hex(BINARY) };
    const throttled = new Map<string, number>();
    const order: string[] = [];
    const flaky: Fetch = async (url, init) => {
      order.push(
        url.includes("/token/") ? "token" : url.includes("/manifests/") ? "manifest" : "blob",
      );
      const seen = throttled.get(url) ?? 0;
      throttled.set(url, seen + 1);
      if (url.includes("/manifests/") && seen === 0) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "7" } });
      }
      if (url.includes("/blobs/") && seen < 2) {
        return new Response("oops", { status: 503 });
      }
      return good.fetchImpl(url, init);
    };
    const waits: number[] = [];
    const layer = join(mkdtempSync(join(tmpdir(), "lwa-")), "layer");

    const result = await prepareWebAdapterLayer(layer, flaky, pins, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(result).toBe("downloaded");
    expect(order[0]).toBe("token");
    expect(waits).toEqual([7000, 1000, 2000]);
    expect(readFileSync(join(layer, "extensions", "lambda-adapter"))).toEqual(Buffer.from(BINARY));
  });

  it("retries network errors, gives up after the last attempt, and never retries a 404", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const offline: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const layer = join(mkdtempSync(join(tmpdir(), "lwa-")), "layer");
    await expect(
      prepareWebAdapterLayer(layer, offline, webAdapterPins, { attempts: 3, sleep }),
    ).rejects.toThrow(/after 3 attempts \(fetch failed\)/);
    expect(waits).toEqual([1000, 2000]);
    expect(existsSync(layer)).toBe(false);

    let calls = 0;
    const missing: Fetch = async () => {
      calls += 1;
      return new Response("no", { status: 404 });
    };
    await expect(prepareWebAdapterLayer(layer, missing, webAdapterPins, { sleep })).rejects.toThrow(
      /HTTP 404:/,
    );
    expect(calls).toBe(1);

    const alwaysThrottled: Fetch = async () => new Response("", { status: 429 });
    await expect(
      prepareWebAdapterLayer(layer, alwaysThrottled, webAdapterPins, { attempts: 2, sleep }),
    ).rejects.toThrow(/HTTP 429 after 2 attempts/);
  });

  it("computes backoff from Retry-After seconds or dates, else doubling, capped at 60 s", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(backoff(1, null)).toBe(1000);
    expect(backoff(3, null)).toBe(4000);
    expect(backoff(10, null)).toBe(60_000);
    expect(backoff(1, "3")).toBe(3000);
    expect(backoff(1, "600")).toBe(60_000);
    expect(backoff(1, "Sun, 18 Oct 2026 12:00:05 GMT", now)).toBe(5000);
    expect(backoff(2, "not a date")).toBe(2000);
  });

  it("writes a non-deployable stub for CI, and keeps a verified binary", async () => {
    const layer = join(mkdtempSync(join(tmpdir(), "lwa-")), "layer");
    expect(prepareWebAdapterStub(layer)).toBe("stub");
    const stub = readFileSync(join(layer, "extensions", "lambda-adapter"), "utf8");
    expect(stub).toBe(WEB_ADAPTER_STUB);
    expect(stub).toContain("STUB-NOT-DEPLOYABLE");
    expect(statSync(join(layer, "extensions", "lambda-adapter")).mode & 0o111).toBe(0o111);

    const { fetchImpl, manifestDigest } = registry();
    const pins = { manifestDigest, binarySha256: sha256Hex(BINARY) };
    expect(await prepareWebAdapterLayer(layer, fetchImpl, pins)).toBe("downloaded");
    expect(prepareWebAdapterStub(layer, pins)).toBe("real");
    expect(readFileSync(join(layer, "extensions", "lambda-adapter"))).toEqual(Buffer.from(BINARY));
  });
});
