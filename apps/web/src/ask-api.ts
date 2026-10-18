export const ASK_QUESTION_MAX_LENGTH = 8000;
export const ASK_TIMEOUT_MS = 31_000;

const SAFE_CITATION_PREFIXES = ["/profile/", "/experience/", "/background/", "/work/"] as const;

export type AskCitation = {
  chunkId: string;
  documentId: string;
  title: string;
  section: string;
  url: string;
};

export type AskUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type AskSuccess = {
  ok: true;
  answer: string;
  citations: AskCitation[];
  suggestedQuestions: string[];
  requestId: string;
  fixture?: boolean;
  usage?: AskUsage;
  estimatedCostUsd?: string;
};

export type AskFailureKind = "api" | "network" | "timeout" | "malformed" | "cancelled";

export type AskFailure = {
  ok: false;
  kind: AskFailureKind;
  message: string;
  requestId?: string;
};

export type AskResult = AskSuccess | AskFailure;

export type AskHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type AskRequest = {
  url: string;
  question: string;
  history?: AskHistoryMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function safeCitationHref(url: string): string | null {
  if (!url.startsWith("/") || url.startsWith("//")) {
    return null;
  }
  if (/[\s\\]/.test(url) || url.toLowerCase().includes("javascript:")) {
    return null;
  }
  if (!SAFE_CITATION_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return null;
  }
  return url;
}

export async function askCareerQuestion(request: AskRequest): Promise<AskResult> {
  const question = request.question.trim();
  if (question === "") {
    return { ok: false, kind: "api", message: "Enter a question." };
  }
  if (question.length > ASK_QUESTION_MAX_LENGTH) {
    return { ok: false, kind: "api", message: "The question is too long." };
  }

  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? ASK_TIMEOUT_MS;
  let reason: "timeout" | "cancelled" | null = null;
  const stopExternalAbort = bindAbort(request.signal, () => {
    if (reason === null) {
      reason = "cancelled";
    }
    controller.abort();
  });
  const timer = setTimeout(() => {
    reason = "timeout";
    controller.abort();
  }, timeoutMs);

  try {
    const response = await (request.fetchImpl ?? fetch)(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        mode: "career_question",
        ...(request.history && request.history.length > 0 ? { history: request.history } : {}),
      }),
      signal: controller.signal,
      credentials: "omit",
    });
    const parsed = await readJson(response);
    if (!response.ok) {
      return errorResult(parsed);
    }
    const success = parseSuccess(parsed);
    if (success === null) {
      return {
        ok: false,
        kind: "malformed",
        message: "The career assistant returned an unexpected response.",
      };
    }
    return success;
  } catch {
    if (reason === "timeout") {
      return { ok: false, kind: "timeout", message: "The request timed out. Please try again." };
    }
    if (reason === "cancelled") {
      return { ok: false, kind: "cancelled", message: "The request was cancelled." };
    }
    return { ok: false, kind: "network", message: "The career assistant could not be reached." };
  } finally {
    clearTimeout(timer);
    stopExternalAbort();
  }
}

export function consumeNdjson(buffer: string, onEvent: (event: unknown) => void): string {
  let rest = buffer;
  while (rest.includes("\n")) {
    const newline = rest.indexOf("\n");
    const line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (line.trim() === "") {
      continue;
    }
    onEvent(JSON.parse(line));
  }
  return rest;
}

export async function streamCareerQuestion(
  request: AskRequest,
  onDelta: (text: string) => void,
): Promise<AskResult> {
  const question = request.question.trim();
  if (question === "") {
    return { ok: false, kind: "api", message: "Enter a question." };
  }
  if (question.length > ASK_QUESTION_MAX_LENGTH) {
    return { ok: false, kind: "api", message: "The question is too long." };
  }

  const controller = new AbortController();
  const timeoutMs = request.timeoutMs ?? ASK_TIMEOUT_MS;
  let reason: "timeout" | "cancelled" | null = null;
  const stopExternalAbort = bindAbort(request.signal, () => {
    if (reason === null) {
      reason = "cancelled";
    }
    controller.abort();
  });
  const timer = setTimeout(() => {
    reason = "timeout";
    controller.abort();
  }, timeoutMs);

  try {
    const response = await (request.fetchImpl ?? fetch)(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        question,
        mode: "career_question",
        ...(request.history && request.history.length > 0 ? { history: request.history } : {}),
      }),
      signal: controller.signal,
      credentials: "omit",
    });
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json") || !response.ok) {
      return errorResult(await readJson(response));
    }
    return await readEventStream(response, onDelta);
  } catch {
    if (reason === "timeout") {
      return { ok: false, kind: "timeout", message: "The request timed out. Please try again." };
    }
    if (reason === "cancelled") {
      return { ok: false, kind: "cancelled", message: "The request was cancelled." };
    }
    return { ok: false, kind: "network", message: "The career assistant could not be reached." };
  } finally {
    clearTimeout(timer);
    stopExternalAbort();
  }
}

async function readEventStream(
  response: Response,
  onDelta: (text: string) => void,
): Promise<AskResult> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return {
      ok: false,
      kind: "malformed",
      message: "The career assistant returned an unexpected response.",
    };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: AskResult | null = null;
  try {
    while (completed === null) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      try {
        buffer = consumeNdjson(buffer, (event) => {
          const next = applyStreamEvent(event, onDelta);
          if (next !== null) {
            completed = next;
          }
        });
      } catch {
        return {
          ok: false,
          kind: "malformed",
          message: "The career assistant returned an unexpected response.",
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (completed !== null) {
    return completed;
  }
  if (buffer.trim() !== "") {
    return {
      ok: false,
      kind: "malformed",
      message: "The career assistant returned an unexpected response.",
    };
  }
  return {
    ok: false,
    kind: "network",
    message: "The response was interrupted. Please try again.",
  };
}

function applyStreamEvent(event: unknown, onDelta: (text: string) => void): AskResult | null {
  if (!isRecord(event) || typeof event.type !== "string") {
    throw new Error("malformed event");
  }
  if (event.type === "delta") {
    if (typeof event.text !== "string") {
      throw new Error("malformed event");
    }
    onDelta(event.text);
    return null;
  }
  if (event.type === "done") {
    const success = parseStreamDone(event);
    if (success === null) {
      throw new Error("malformed event");
    }
    return success;
  }
  if (event.type === "error") {
    return streamFailure(event);
  }
  throw new Error("malformed event");
}

function parseStreamDone(event: Record<string, unknown>): AskSuccess | null {
  if (typeof event.answer !== "string" || typeof event.requestId !== "string") {
    return null;
  }
  if (!Array.isArray(event.citations)) {
    return null;
  }
  const citations: AskCitation[] = [];
  for (const item of event.citations) {
    const citation = parseCitation(item);
    if (citation === null) {
      return null;
    }
    citations.push(citation);
  }
  const usage = parseUsage(event.usage);
  const estimatedCostUsd =
    typeof event.estimatedCostUsd === "string" ? event.estimatedCostUsd : undefined;
  return {
    ok: true,
    answer: event.answer,
    citations,
    suggestedQuestions: [],
    requestId: event.requestId,
    fixture: event.fixture === true,
    ...(usage ? { usage } : {}),
    ...(estimatedCostUsd ? { estimatedCostUsd } : {}),
  };
}

function parseUsage(value: unknown): AskUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!Number.isInteger(value.inputTokens) || !Number.isInteger(value.outputTokens)) {
    return undefined;
  }
  if (typeof value.inputTokens !== "number" || typeof value.outputTokens !== "number") {
    return undefined;
  }
  if (value.inputTokens < 0 || value.outputTokens < 0) {
    return undefined;
  }
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens };
}

function streamFailure(event: Record<string, unknown>): AskFailure {
  const message =
    typeof event.message === "string" && event.message.trim() !== ""
      ? event.message
      : "The career assistant returned an unexpected response.";
  const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
  if (event.code === "timeout") {
    return { ok: false, kind: "timeout", message, requestId };
  }
  if (event.code === "cancelled") {
    return { ok: false, kind: "cancelled", message, requestId };
  }
  if (event.code === "malformed") {
    return { ok: false, kind: "malformed", message, requestId };
  }
  return { ok: false, kind: "api", message, requestId };
}

function bindAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort);
  return () => signal.removeEventListener("abort", abort);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorResult(value: unknown): AskFailure {
  if (!isRecord(value) || typeof value.message !== "string" || value.message.trim() === "") {
    return {
      ok: false,
      kind: "malformed",
      message: "The career assistant returned an unexpected response.",
    };
  }
  const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
  return { ok: false, kind: "api", message: value.message, requestId };
}

function parseSuccess(value: unknown): AskSuccess | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.answer !== "string" || typeof value.requestId !== "string") {
    return null;
  }
  if (!Array.isArray(value.citations) || !Array.isArray(value.suggestedQuestions)) {
    return null;
  }
  const citations: AskCitation[] = [];
  for (const item of value.citations) {
    const citation = parseCitation(item);
    if (citation === null) {
      return null;
    }
    citations.push(citation);
  }
  const suggestedQuestions: string[] = [];
  for (const item of value.suggestedQuestions) {
    if (typeof item !== "string") {
      return null;
    }
    suggestedQuestions.push(item);
  }
  return {
    ok: true,
    answer: value.answer,
    citations,
    suggestedQuestions,
    requestId: value.requestId,
  };
}

function parseCitation(value: unknown): AskCitation | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.chunkId !== "string" ||
    typeof value.documentId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.section !== "string" ||
    typeof value.url !== "string"
  ) {
    return null;
  }
  return {
    chunkId: value.chunkId,
    documentId: value.documentId,
    title: value.title,
    section: value.section,
    url: value.url,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
