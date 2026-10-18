/**
 * The production preview for browser tests: serves a production build the way CloudFront does
 * (<path>/index.html, /404.html with status 404) and answers POST /api/ask with the scripted
 * NDJSON stream from mock-ask.ts. GET /__mock/received returns what /api/ask received, so a
 * test can check the body hash the browser sent. Loopback only; run by playwright.config.ts.
 *
 * Usage: node e2e/preview-server.ts <build directory> <port>
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { serveMockAsk, type ReceivedRequest } from "./mock-ask.ts";

const [directoryArg, portArg] = process.argv.slice(2);
const root = resolve(directoryArg ?? "dist-e2e-site");
const port = Number(portArg ?? "4331");
const received: ReceivedRequest[] = [];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

/** The CloudFront viewer-request rewrite (infrastructure/lib/site-viewer-request.js). */
function rewrite(uri: string): string {
  if (uri.endsWith("/")) {
    return `${uri}index.html`;
  }
  const last = uri.slice(uri.lastIndexOf("/") + 1);
  return last.includes(".") ? uri : `${uri}/index.html`;
}

createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  if (path === "/api/ask" && request.method === "POST") {
    serveMockAsk(request, response, received);
    return;
  }
  if (path === "/__mock/received") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(received));
    return;
  }
  const file = normalize(join(root, decodeURIComponent(rewrite(path))));
  const send = async (target: string, status: number) => {
    const body = await readFile(target);
    response.writeHead(status, {
      "Content-Type": TYPES[extname(target)] ?? "application/octet-stream",
    });
    response.end(body);
  };
  const inside = file.startsWith(root);
  (inside ? send(file, 200) : Promise.reject(new Error("outside")))
    .catch(() => send(join(root, "404.html"), 404))
    .catch(() => {
      response.writeHead(500);
      response.end();
    });
}).listen(port, "127.0.0.1");
