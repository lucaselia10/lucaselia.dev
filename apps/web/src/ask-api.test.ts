import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASK_QUESTION_MAX_LENGTH,
  ASK_TIMEOUT_MS,
  askCareerQuestion,
  consumeNdjson,
  safeCitationHref,
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

    expect(result).toMatchObject({
      ok: false,
      kind: "api",
      message: "Model answers are not configured.",
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
