import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

/**
 * A stand-in for the production ask function that streams NDJSON with real delays.
 *
 * Playwright's route.fulfill() sends a whole body at once, and Chromium will not continue an
 * intercepted request to another origin, so neither can show progressive rendering. The
 * production preview server (e2e/preview-server.ts) answers the site's own POST /api/ask with
 * this instead: same origin, under the site's CSP, chunks arriving over time. Error states
 * are mocked with route interception in the spec. No real API, no model.
 */
export const STREAM_PARTS = ["Lucas works on backend systems ", "for capacity planning at AWS."];
export const STREAM_CITATION = {
  chunkId: "aws-sde-ii:role-description:0",
  documentId: "aws-sde-ii",
  title: "Software Development Engineer II",
  section: "Role Description",
  url: "/experience/aws-sde-ii#role-description",
};
export const CHUNK_DELAY_MS = 700;

export type ReceivedRequest = {
  headers: IncomingHttpHeaders;
  body: string;
  bodySha256: string;
};

/** Stream the scripted answer: one NDJSON line, then a pause, for each event. */
export function serveMockAsk(
  request: IncomingMessage,
  response: ServerResponse,
  received: ReceivedRequest[],
): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    received.push({
      headers: request.headers,
      body: body.toString("utf8"),
      bodySha256: createHash("sha256").update(body).digest("hex"),
    });
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    });
    const events: object[] = [
      ...STREAM_PARTS.map((text) => ({ type: "delta", text })),
      {
        type: "done",
        answer: STREAM_PARTS.join(""),
        citations: [STREAM_CITATION],
        requestId: "00000000-0000-4000-8000-0000000000e2",
        fixture: false,
      },
    ];
    let index = 0;
    const next = () => {
      const event = events[index];
      if (event === undefined || response.destroyed) {
        response.end();
        return;
      }
      response.write(`${JSON.stringify(event)}\n`);
      index += 1;
      setTimeout(next, CHUNK_DELAY_MS);
    };
    next();
  });
}
