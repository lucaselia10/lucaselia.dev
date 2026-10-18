import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_TIMEOUT_MS } from "../ask-api";
import Assistant, { shouldFollowTranscript } from "./Assistant";

const apiUrl = "http://127.0.0.1:8787/ask";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Assistant", () => {
  it("shows the assistant as unavailable when no API URL is configured", () => {
    const fetchMock = stubFetch();
    render(<Assistant />);

    expect(screen.getByText(/no API URL is configured/)).toBeTruthy();
    expect(disabled("Send")).toBe(true);
    expect(disabled("What have you built at AWS?")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "What have you built at AWS?" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the approved suggested questions and submits one", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(successBody("Built planning systems.")));
    render(<Assistant askApiUrl={apiUrl} />);

    // The default is the deterministic set: every one is answered by the exact-answer handler.
    for (const suggestion of [
      "What have you built at AWS?",
      "Where have you worked?",
      "What is your education?",
      "How did you move into software engineering?",
    ]) {
      expect(screen.getByRole("button", { name: suggestion })).toBeTruthy();
    }
    expect(screen.getByRole("heading", { level: 2, name: "Ask about my work" })).toBeTruthy();
    expect(
      screen.getByText(
        "Answers come from my reviewed career pages, and each one links to its source.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("list", { name: "Suggested questions" })).toBeTruthy();
    expect(screen.queryByText("Career assistant")).toBeNull();
    expect(screen.getByLabelText("Your question")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "What have you built at AWS?" }));

    await screen.findByText("Built planning systems.");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      question: "What have you built at AWS?",
      mode: "career_question",
    });
  });

  it("renders the compact role variant with its own heading and questions", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(successBody("Platform answer.")));
    const { container } = render(
      <Assistant
        askApiUrl={apiUrl}
        variant="compact"
        heading="Ask about this role"
        suggestions={["What does the capacity-planning platform do?"]}
      />,
    );

    expect(container.querySelector("#ask.assistant-compact")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Ask about this role" })).toBeTruthy();
    expect(screen.queryByText(/Answers come from my reviewed career pages/)).toBeNull();
    expect(screen.queryByRole("button", { name: "What have you built at AWS?" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "What does the capacity-planning platform do?" }),
    );

    await screen.findByText("Platform answer.");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      question: "What does the capacity-planning platform do?",
      mode: "career_question",
    });
  });

  it("disables submit until a question is entered", () => {
    stubFetch();
    render(<Assistant askApiUrl={apiUrl} />);

    expect(disabled("Send")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
      target: { value: "   " },
    });
    expect(disabled("Send")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
      target: { value: "What is Lucas's current role?" },
    });
    expect(disabled("Send")).toBe(false);
  });

  it("shows a loading state and then the answer, citations, and suggestions", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchMock = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    render(<Assistant askApiUrl={apiUrl} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
      target: { value: "What is Lucas's current role?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("What is Lucas's current role?")).toBeTruthy();
    expect(screen.getByText("Looking up the public career data.")).toBeTruthy();
    expect(disabled("Send")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      apiUrl,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "What is Lucas's current role?",
          mode: "career_question",
        }),
      }),
    );

    resolveFetch(jsonResponse(successBody("<b>not html</b>")));
    await waitFor(() => {
      expect(screen.getByText("<b>not html</b>")).toBeTruthy();
    });
    expect(document.querySelector("b")).toBeNull();
    const link = screen.getByRole("link", { name: "Software Development Engineer II" });
    expect(link.getAttribute("href")).toBe("/experience/aws-sde-ii#role-description");
    expect(link.textContent).toBe("Software Development Engineer II");
    expect(screen.queryByRole("button", { name: "Where has Lucas worked?" })).toBeNull();
    expect(screen.queryByRole("button", { name: "What have you built at AWS?" })).toBeNull();
  });

  it("formats visible month-precision dates without changing the answer meaning", async () => {
    stubFetch(async () => jsonResponse(successBody("The role started in 2025-12.")));
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");

    expect(await screen.findByText("The role started in December 2025.")).toBeTruthy();
  });

  it("sends a follow-up with the previous exchange as context", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(successBody("Current role.")));
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");
    await screen.findByText("Current role.");

    fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
      target: { value: "How long has he been in that role?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      question: "How long has he been in that role?",
      mode: "career_question",
      history: [
        { role: "user", content: "What is Lucas's current role?" },
        { role: "assistant", content: "Current role." },
      ],
    });
    expect(screen.getByText("What is Lucas's current role?")).toBeTruthy();
    expect(screen.getByText("How long has he been in that role?")).toBeTruthy();
  });

  it("submits the composer with Enter and keeps Shift+Enter for a new line", () => {
    const fetchMock = stubFetch(() => new Promise<Response>(() => undefined));
    render(<Assistant askApiUrl={apiUrl} />);
    const field = screen.getByRole("textbox", { name: "Your question" });
    fireEvent.change(field, { target: { value: "First line" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows an API error and its request id", async () => {
    stubFetch(async () =>
      jsonResponse({ message: "The career index is unavailable.", requestId: "gateway-1" }, 500),
    );
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The career index is unavailable.");
    expect(alert.textContent).toContain("gateway-1");
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveProperty(
      "value",
      "What is Lucas's current role?",
    );
    expect(document.querySelector(".visitor-message")?.textContent).toBe(
      "What is Lucas's current role?",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows a network failure", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The career assistant could not be reached.",
    );
  });

  it("shows a timeout", async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    });

    expect(screen.getByRole("alert").textContent).toBe("The request timed out. Please try again.");
  });

  it("shows a malformed response without rendering it as an answer", async () => {
    stubFetch(async () => jsonResponse({ answer: "<img src=x>" }));
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The career assistant returned an unexpected response.",
    );
    expect(document.querySelector("img")).toBeNull();
  });

  it("separates a citation's title and section in text and in the link name", async () => {
    stubFetch(async () =>
      jsonResponse(
        successBody("Lucas attended Sierra College.", [
          {
            chunkId: "sierra-college-general-studies:coursework:0",
            documentId: "sierra-college-general-studies",
            title: "General Studies",
            section: "Coursework",
            url: "/background/sierra-college-general-studies#coursework",
          },
        ]),
      ),
    );
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is your education?");

    const link = await screen.findByRole("link", { name: "General Studies, Coursework" });
    expect(link.textContent).toBe("General Studies, Coursework");
  });

  it("does not link an unsafe citation url", async () => {
    stubFetch(async () =>
      jsonResponse(
        successBody("Answer.", [
          citation("javascript:alert(1)", "Bad link"),
          citation("https://evil.example/profile/lucas-elia", "External"),
        ]),
      ),
    );
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");

    await screen.findByText("Answer.");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Bad link")).toBeTruthy();
    expect(screen.getByText("External")).toBeTruthy();
  });

  it("ignores a second submit while a request is running", async () => {
    const fetchMock = stubFetch(() => new Promise<Response>(() => undefined));
    render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows the transcript only when the reader is already near the bottom", () => {
    expect(shouldFollowTranscript({ scrollHeight: 400, scrollTop: 300, clientHeight: 80 })).toBe(
      true,
    );
    expect(shouldFollowTranscript({ scrollHeight: 800, scrollTop: 0, clientHeight: 200 })).toBe(
      false,
    );
  });

  it("shows streamed text before citations and does not announce each token", async () => {
    let push: (chunk: string) => void = () => undefined;
    let finish: () => void = () => undefined;
    const encoder = new TextEncoder();
    const fetchMock = stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              push = (chunk) => {
                controller.enqueue(encoder.encode(chunk));
              };
              finish = () => {
                controller.close();
              };
            },
          }),
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
        ),
    );
    render(<Assistant askApiUrl={apiUrl} modelStreaming />);
    submit("What is Lucas's current role?");
    expect(await screen.findByText("Looking up the public career data.")).toBeTruthy();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    await act(async () => {
      push('{"type":"delta","text":"Fixture answer."}\n');
    });

    expect(await screen.findByText("Fixture answer.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Receiving the answer.");
    expect(screen.queryByRole("link")).toBeNull();

    await act(async () => {
      push(
        `${JSON.stringify({
          type: "done",
          answer: "Fixture answer.",
          citations: [
            citation("/experience/aws-sde-ii#role-description", "Software Development Engineer II"),
          ],
          requestId: "request-1",
          fixture: true,
          usage: { inputTokens: 11, outputTokens: 7 },
          estimatedCostUsd: "0.000018",
        })}\n`,
      );
      finish();
    });

    expect(
      await screen.findByRole("link", { name: "Software Development Engineer II" }),
    ).toBeTruthy();
    expect(screen.getByText("Fixture stream. Not a live model answer.")).toBeTruthy();
    expect(screen.queryByText(/Tokens:/)).toBeNull();
    expect(screen.queryByText(/Estimated cost:/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Answer ready.");
    // A live-region announcement only: present for assistive technology, never shown.
    expect(screen.getByRole("status").className).toBe("visually-hidden");
  });

  it("discards an unvalidated streamed answer and retries without that history", async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        ndjsonResponse([
          '{"type":"delta","text":"Unverified claim."}\n',
          `${JSON.stringify({
            type: "error",
            code: "validation",
            message: "The answer could not be verified and was discarded.",
            requestId: "request-2",
          })}\n`,
        ]),
      )
      .mockResolvedValueOnce(
        ndjsonResponse([
          `${JSON.stringify({
            type: "done",
            answer: "Verified answer.",
            citations: [],
            requestId: "request-3",
            fixture: true,
          })}\n`,
        ]),
      );
    render(<Assistant askApiUrl={apiUrl} modelStreaming />);
    submit("What is Lucas's current role?");

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The answer could not be verified and was discarded. Reference: request-2",
    );
    expect(screen.queryByText("Unverified claim.")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Your question" })).toHaveProperty(
      "value",
      "What is Lucas's current role?",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Verified answer.")).toBeTruthy();
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      question: "What is Lucas's current role?",
      mode: "career_question",
    });
  });

  it("ignores a second streaming submit while a request is running", async () => {
    const fetchMock = stubFetch(() => new Promise<Response>(() => undefined));
    render(<Assistant askApiUrl={apiUrl} modelStreaming />);
    submit("What is Lucas's current role?");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the request when the assistant unmounts", async () => {
    let signal: AbortSignal | undefined;
    stubFetch((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const view = render(<Assistant askApiUrl={apiUrl} />);
    submit("What is Lucas's current role?");
    view.unmount();

    await waitFor(() => {
      expect(signal?.aborted).toBe(true);
    });
  });
});

function disabled(name: string): boolean {
  return (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
}

function submit(question: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Your question" }), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

function stubFetch(impl?: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl ?? (async () => jsonResponse(successBody("Answer."))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function successBody(
  answer: string,
  citations = [
    citation("/experience/aws-sde-ii#role-description", "Software Development Engineer II"),
  ],
) {
  return {
    answer,
    citations,
    suggestedQuestions: ["Where has Lucas worked?"],
    requestId: "request-1",
  };
}

function citation(url: string, title: string) {
  return {
    chunkId: "chunk",
    documentId: "doc",
    title,
    section: "Role Description",
    url,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
