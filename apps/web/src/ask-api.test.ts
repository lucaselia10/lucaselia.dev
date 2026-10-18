import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_QUESTION_MAX_LENGTH,
  ASK_STREAM_TIMEOUT_MS,
  ASK_TIMEOUT_MS,
  CONTENT_SHA256_HEADER,
  askCareerQuestion,
  consumeNdjson,
  safeCitationHref,
  sha256Hex,
  streamCareerQuestion,
} from "./ask-api";

const url = "http://127.0.0.1:8787/ask";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("askCareerQuestion", () => {
  it("posts the career question without history", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody()));

    const result = await askCareerQuestion({
      url,
      question: "  What is Lucas's current role?  ",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What is Lucas's current role?",
        mode: "career_question",
      }),
      signal: expect.any(AbortSignal),
      credentials: "omit",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer).toBe("An answer.");
      expect(result.requestId).toBe("request-1");
    }
  });

  it("posts prior turns when the conversation has history", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(successBody()));
    const history = [
      { role: "user" as const, content: "What is Lucas's current role?" },
      { role: "assistant" as const, content: "He is a software engineer." },
    ];

    await askCareerQuestion({
      url,
      question: "How long has he been in that role?",
      history,
      fetchImpl,
    });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      question: "How long has he been in that role?",
      mode: "career_question",
      history,
    });
  });

  it("returns a structured API error and its request id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "question is required.", requestId: "request-2" }, 400),
    );

    const result = await askCareerQuestion({ url, question: "Hello", fetchImpl });

    expect(result).toMatchObject({
      ok: false,
      kind: "api",
      message: "question is required.",
      requestId: "request-2",
    });
  });

  it("returns a network failure without the thrown message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch secret question");
    });

    const result = await askCareerQuestion({ url, question: "Hello", fetchImpl });

    expect(result).toMatchObject({ ok: false, kind: "network" });
    if (!result.ok) {
      expect(result.message).not.toContain("secret question");
    }
  });

  it("returns a timeout when the request is aborted by the timer", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = askCareerQuestion({ url, question: "Hello", fetchImpl });
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      kind: "timeout",
      message: "The request timed out. Please try again.",
    });
  });

  it("rejects a malformed success body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ answer: 5 }));

    const result = await askCareerQuestion({ url, question: "Hello", fetchImpl });

    expect(result).toMatchObject({ ok: false, kind: "malformed" });
  });

  it("uses the OpenAPI question length limit", async () => {
    const fetchImpl = vi.fn();
    const result = await askCareerQuestion({
      url,
      question: "a".repeat(ASK_QUESTION_MAX_LENGTH + 1),
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, message: "The question is too long." });
  });
});

describe("safeCitationHref", () => {
  it("allows public career routes and rejects unsafe urls", () => {
    expect(safeCitationHref("/profile/lucas-elia#about")).toBe("/profile/lucas-elia#about");
    expect(safeCitationHref("/experience/aws-sde-ii#role-description")).toBe(
      "/experience/aws-sde-ii#role-description",
    );
    expect(safeCitationHref("/background/bloomtech-backend-development#program")).toBe(
      "/background/bloomtech-backend-development#program",
    );
    expect(safeCitationHref("/work/fictional-lumen-harbor#outcome")).toBe(
      "/work/fictional-lumen-harbor#outcome",
    );
    expect(safeCitationHref("javascript:alert(1)")).toBeNull();
    expect(safeCitationHref("https://evil.example/profile/lucas-elia")).toBeNull();
    expect(safeCitationHref("//evil.example/profile/lucas-elia")).toBeNull();
    expect(safeCitationHref("/secret")).toBeNull();
  });
});

describe("streamCareerQuestion", () => {
  it("assembles events split across arbitrary chunk boundaries", () => {
    const seen: unknown[] = [];
    let buffer = "";
    const chunks = [
      '{"type":"del',
      'ta","text":"Hi"}\n{"type":"done","answer":"Hi","citations":[],"requestId":"r1"}\n',
    ];
    for (const chunk of chunks) {
      buffer = consumeNdjson(buffer + chunk, (event) => {
        seen.push(event);
      });
    }

    expect(buffer).toBe("");
    expect(seen).toEqual([
      { type: "delta", text: "Hi" },
      { type: "done", answer: "Hi", citations: [], requestId: "r1" },
    ]);
  });

  it("emits deltas before the stream completes", async () => {
    const deltas: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ndjsonResponse([
        '{"type":"delta","text":"Hel"}\n',
        '{"type":"delta","text":"lo"}\n',
        doneLine("Hello"),
      ]),
    );

    const result = await streamCareerQuestion(
      { url, question: "What is Lucas's current role?", fetchImpl },
      (text) => {
        deltas.push(text);
      },
    );

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(result).toMatchObject({ ok: true, answer: "Hello", fixture: true });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: "application/x-ndjson",
    });
  });

  it("treats a setup JSON response as a failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "Model answers are not configured.", requestId: "request-9" }, 503),
    );

    const result = await streamCareerQuestion(
      { url, question: "Hello", fetchImpl },
      () => undefined,
    );

    // The server's own text is never shown; the client maps the status.
    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      message: "The career assistant is temporarily unavailable.",
      requestId: "request-9",
    });
  });

  it("rejects a malformed event without keeping a success", async () => {
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse(['{"type":"delta","text":"Partial"}\n', "not-json\n"]),
    );

    const result = await streamCareerQuestion(
      { url, question: "Hello", fetchImpl },
      () => undefined,
    );

    expect(result).toMatchObject({
      ok: false,
      kind: "malformed",
    });
  });
});

describe("production stream requests", () => {
  it("hashes text to lowercase hex SHA-256", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("sends the exact body bytes with their SHA-256 for OAC", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      ndjsonResponse([doneLine("Answer.")]),
    );
    const history = [
      { role: "user" as const, content: "Earlier question, with “quotes” and é." },
      { role: "assistant" as const, content: "Earlier answer." },
    ];

    await streamCareerQuestion(
      { url: "/api/ask", question: "Next question?", history, fetchImpl },
      () => undefined,
    );

    const [target, init] = fetchImpl.mock.calls[0] ?? [];
    expect(target).toBe("/api/ask");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    const body = init?.body;
    // jsdom and Node have different Uint8Array classes, so check for a byte view.
    expect(ArrayBuffer.isView(body)).toBe(true);
    const bytes = body as Uint8Array;
    const headers = init?.headers as Record<string, string>;
    expect(headers[CONTENT_SHA256_HEADER]).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(headers.Accept).toBe("application/x-ndjson");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      question: "Next question?",
      mode: "career_question",
      history,
    });
  });

  it.each([
    [400, {}, "invalid", "The question couldn't be sent. Please rephrase it and try again."],
    [413, {}, "too_long", "The question is too long."],
    [
      429,
      { code: "rate_limited" },
      "rate_limited",
      "Too many questions in a short time. Please wait a few minutes.",
    ],
    [429, { code: "busy" }, "busy", "The career assistant is busy. Please try again in a minute."],
    [429, null, "busy", "The career assistant is busy. Please try again in a minute."],
    [
      503,
      { code: "paused" },
      "paused",
      "The career assistant is paused for now. The career pages are still here.",
    ],
    [
      503,
      { code: "unavailable" },
      "unavailable",
      "The career assistant is temporarily unavailable.",
    ],
    [502, null, "unavailable", "The career assistant is temporarily unavailable."],
    [504, null, "unavailable", "The career assistant is temporarily unavailable."],
    [403, null, "unavailable", "The career assistant is temporarily unavailable."],
    [404, null, "unavailable", "The career assistant is temporarily unavailable."],
  ] as const)(
    "maps HTTP %i %j to %s without showing server text",
    async (status, body, kind, message) => {
      const raw =
        body === null
          ? new Response("<html>CloudFront error</html>", {
              status,
              headers: { "Content-Type": "text/html" },
            })
          : jsonResponse({ ...body, message: "server wording", requestId: "req-1" }, status);
      const result = await streamCareerQuestion(
        { url: "/api/ask", question: "Hello", fetchImpl: vi.fn(async () => raw) },
        () => undefined,
      );

      expect(result).toMatchObject({ ok: false, kind, message });
      expect(JSON.stringify(result)).not.toContain("server wording");
      expect(JSON.stringify(result)).not.toContain("CloudFront");
    },
  );

  it.each([
    ["validation", "validation", "The answer could not be verified and was discarded."],
    ["interrupted", "interrupted", "The response was interrupted. Please try again."],
    ["timeout", "timeout", "The request timed out. Please try again."],
    [
      "paused",
      "paused",
      "The career assistant is paused for now. The career pages are still here.",
    ],
    ["busy", "busy", "The career assistant is busy. Please try again in a minute."],
    ["unavailable", "unavailable", "The career assistant is temporarily unavailable."],
    ["something-new", "unavailable", "The career assistant is temporarily unavailable."],
  ] as const)("maps a stream error %s to its own message", async (code, kind, message) => {
    const event = { type: "error", code, message: "server wording", requestId: "req-2" };
    const result = await streamCareerQuestion(
      {
        url: "/api/ask",
        question: "Hello",
        fetchImpl: vi.fn(async () =>
          ndjsonResponse(['{"type":"delta","text":"Part"}\n', `${JSON.stringify(event)}\n`]),
        ),
      },
      () => undefined,
    );

    expect(result).toEqual({ ok: false, kind, message, requestId: "req-2" });
  });

  it("treats a 200 that is not NDJSON as malformed, and a dropped connection as network", async () => {
    const html = await streamCareerQuestion(
      {
        url: "/api/ask",
        question: "Hello",
        fetchImpl: vi.fn(
          async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
        ),
      },
      () => undefined,
    );
    expect(html).toMatchObject({ kind: "malformed" });

    const offline = await streamCareerQuestion(
      {
        url: "/api/ask",
        question: "Hello",
        fetchImpl: vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      },
      () => undefined,
    );
    expect(offline).toEqual({
      ok: false,
      kind: "network",
      message: "The career assistant could not be reached.",
    });
  });

  it("refuses a question over 500 characters before sending anything", async () => {
    const fetchImpl = vi.fn();
    const result = await streamCareerQuestion(
      { url: "/api/ask", question: "x".repeat(501), fetchImpl },
      () => undefined,
    );
    expect(result).toMatchObject({ kind: "too_long" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ASK_QUESTION_MAX_LENGTH).toBe(500);
  });

  it("aborts an in-flight stream when the caller's signal aborts, and times out at 45 s", async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const pending = streamCareerQuestion(
      {
        url: "/api/ask",
        question: "Hello",
        signal: controller.signal,
        fetchImpl: vi.fn(
          (_url: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              seen = init?.signal ?? undefined;
              seen?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        ),
      },
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    controller.abort();

    expect(await pending).toMatchObject({ kind: "cancelled" });
    expect(seen?.aborted).toBe(true);
    expect(ASK_STREAM_TIMEOUT_MS).toBe(45_000);
  });
});

function successBody() {
  return {
    answer: "An answer.",
    citations: [
      {
        chunkId: "aws-sde-ii:role-description:0",
        documentId: "aws-sde-ii",
        title: "Software Development Engineer II",
        section: "Role Description",
        url: "/experience/aws-sde-ii#role-description",
      },
    ],
    suggestedQuestions: ["Where has Lucas worked?"],
    requestId: "request-1",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function doneLine(answer: string): string {
  return `${JSON.stringify({
    type: "done",
    answer,
    citations: [],
    requestId: "request-1",
    fixture: true,
  })}\n`;
}

function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}
