import { useEffect, useRef, useState, type KeyboardEvent, type SubmitEvent } from "react";
import {
  ASK_QUESTION_MAX_LENGTH,
  askCareerQuestion,
  safeCitationHref,
  streamCareerQuestion,
  type AskCitation,
  type AskHistoryMessage,
  type AskUsage,
} from "../ask-api";
import { DEFAULT_SUGGESTIONS } from "../ask-suggestions";
import { formatVisibleDates } from "../format-dates";

export const DEFAULT_INTRO =
  "Answers come from my reviewed career pages, and each one links to its source.";

type AssistantProps = {
  askApiUrl?: string;
  modelStreaming?: boolean;
  /** "compact" is the role-page variant: smaller panel, no intro line by default. */
  variant?: "full" | "compact";
  heading?: string;
  intro?: string | null;
  suggestions?: readonly string[];
};

type ExchangeStatus = "pending" | "streaming" | "answered" | "failed";

type Exchange = {
  id: string;
  question: string;
  status: ExchangeStatus;
  answer?: string;
  citations?: AskCitation[];
  errorMessage?: string;
  requestId?: string;
  fixture?: boolean;
  usage?: AskUsage;
  estimatedCostUsd?: string;
};

const PENDING_TEXT = "Looking up the public career data.";
const RECEIVING_TEXT = "Receiving the answer.";
const READY_TEXT = "Answer ready.";
const JSON_HISTORY_MESSAGES = 20;
const STREAM_HISTORY_MESSAGES = 12;

export function shouldFollowTranscript(metrics: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 48;
}

export default function Assistant({
  askApiUrl,
  modelStreaming = false,
  variant = "full",
  heading = "Ask about my work",
  intro,
  suggestions = DEFAULT_SUGGESTIONS,
}: AssistantProps) {
  const introText = intro === undefined ? (variant === "full" ? DEFAULT_INTRO : null) : intro;
  const url = askApiUrl?.trim() ?? "";
  const configured = url !== "";
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const idRef = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followRef.current) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [exchanges]);

  async function submitQuestion(nextQuestion: string, replaceId?: string) {
    const trimmed = nextQuestion.trim();
    if (!configured || trimmed === "" || pending) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const history = historyFrom(
      exchanges.filter((exchange) => exchange.id !== replaceId),
      modelStreaming ? STREAM_HISTORY_MESSAGES : JSON_HISTORY_MESSAGES,
    );
    const id = replaceId ?? nextExchangeId(idRef);
    setPending(true);
    setExchanges((current) => {
      const next = current.filter((exchange) => exchange.id !== id);
      return [...next, { id, question: trimmed, status: "pending" }];
    });
    if (!replaceId) {
      setDraft("");
    }
    const response = modelStreaming
      ? await streamCareerQuestion(
          {
            url,
            question: trimmed,
            history,
            signal: controller.signal,
          },
          (text) => {
            if (!mountedRef.current || abortRef.current !== controller) {
              return;
            }
            setExchanges((current) =>
              current.map((exchange) =>
                exchange.id === id
                  ? {
                      ...exchange,
                      status: "streaming",
                      answer: `${exchange.answer ?? ""}${text}`,
                    }
                  : exchange,
              ),
            );
          },
        )
      : await askCareerQuestion({
          url,
          question: trimmed,
          history,
          signal: controller.signal,
        });
    if (!mountedRef.current || abortRef.current !== controller) {
      return;
    }
    if (!response.ok && response.kind === "cancelled") {
      return;
    }
    if (!response.ok) {
      setDraft(trimmed);
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id
            ? {
                ...exchange,
                status: "failed",
                answer: undefined,
                citations: undefined,
                errorMessage: response.message,
                requestId: response.requestId,
              }
            : exchange,
        ),
      );
    } else {
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id
            ? {
                ...exchange,
                status: "answered",
                answer: response.answer,
                citations: response.citations,
                fixture: response.fixture,
                usage: response.usage,
                estimatedCostUsd: response.estimatedCostUsd,
              }
            : exchange,
        ),
      );
    }
    setPending(false);
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(draft);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const submitDisabled = !configured || pending || draft.trim() === "";
  const showSuggestions = exchanges.length === 0 && !pending;

  return (
    <section id="ask" className={`assistant assistant-${variant}`} aria-labelledby="ask-title">
      <h2 id="ask-title">{heading}</h2>
      {introText ? <p className="assistant-note">{introText}</p> : null}
      {configured ? null : (
        <p className="assistant-status" role="status">
          The career assistant is unavailable because no API URL is configured.
        </p>
      )}
      {exchanges.length > 0 ? (
        <div
          className="transcript"
          ref={transcriptRef}
          tabIndex={0}
          aria-label="Conversation"
          onScroll={() => {
            const transcript = transcriptRef.current;
            if (transcript) {
              followRef.current = shouldFollowTranscript(transcript);
            }
          }}
        >
          {exchanges.map((exchange, index) => (
            <ExchangeView
              key={exchange.id}
              exchange={exchange}
              live={index === exchanges.length - 1}
              onRetry={() => {
                void submitQuestion(exchange.question, exchange.id);
              }}
            />
          ))}
        </div>
      ) : null}
      {showSuggestions && suggestions.length > 0 ? (
        <div className="assistant-group">
          <ul className="suggestions" aria-label="Suggested questions">
            {suggestions.map((suggestion) => (
              <li key={suggestion}>
                <button
                  className="suggestion"
                  type="button"
                  disabled={!configured || pending}
                  onClick={() => {
                    void submitQuestion(suggestion);
                  }}
                >
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form className="composer" onSubmit={handleSubmit}>
        <label htmlFor="question">Your question</label>
        <div className="composer-row">
          <textarea
            id="question"
            name="question"
            rows={2}
            value={draft}
            maxLength={ASK_QUESTION_MAX_LENGTH}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={handleComposerKeyDown}
          />
          <button type="submit" disabled={submitDisabled}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

function ExchangeView({
  exchange,
  live,
  onRetry,
}: {
  exchange: Exchange;
  live: boolean;
  onRetry: () => void;
}) {
  const announcement =
    exchange.status === "pending"
      ? PENDING_TEXT
      : exchange.status === "streaming"
        ? RECEIVING_TEXT
        : exchange.status === "answered"
          ? READY_TEXT
          : "";
  return (
    <article className="exchange">
      <p className="visitor-message">{exchange.question}</p>
      {live && announcement !== "" ? (
        <p
          className={exchange.status === "pending" ? "assistant-status" : "visually-hidden"}
          role="status"
        >
          {announcement}
        </p>
      ) : null}
      {exchange.status === "failed" ? (
        <div className="assistant-alert">
          <p role="alert">
            {exchange.errorMessage}
            {exchange.requestId ? ` Reference: ${exchange.requestId}` : ""}
          </p>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
      {(exchange.status === "streaming" || exchange.status === "answered") && exchange.answer ? (
        <div className="assistant-message">
          <p className="answer-copy">{formatVisibleDates(exchange.answer)}</p>
          {exchange.status === "answered" && exchange.citations && exchange.citations.length > 0 ? (
            <ul className="citation-list">
              {exchange.citations.map((citation) => (
                <li key={`${citation.chunkId}-${citation.url}`}>
                  <Citation citation={citation} />
                </li>
              ))}
            </ul>
          ) : null}
          {exchange.status === "answered" && exchange.fixture ? (
            <p className="stream-note">Fixture stream. Not a live model answer.</p>
          ) : null}
          {exchange.status === "answered" && exchange.usage && !exchange.fixture ? (
            <p className="stream-note">
              Tokens: {exchange.usage.inputTokens} in, {exchange.usage.outputTokens} out
            </p>
          ) : null}
          {exchange.status === "answered" && exchange.estimatedCostUsd && !exchange.fixture ? (
            <p className="stream-note">Estimated cost: ${exchange.estimatedCostUsd}</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function historyFrom(exchanges: Exchange[], limit: number): AskHistoryMessage[] {
  const messages: AskHistoryMessage[] = [];
  for (const exchange of exchanges) {
    if (exchange.status !== "answered" || !exchange.answer) {
      continue;
    }
    messages.push({ role: "user", content: exchange.question });
    messages.push({ role: "assistant", content: exchange.answer });
  }
  return messages.slice(-limit);
}

function nextExchangeId(idRef: { current: number }): string {
  idRef.current += 1;
  return `exchange-${idRef.current}`;
}

function showSection(citation: AskCitation): boolean {
  const section = citation.section.trim();
  const title = citation.title.trim();
  if (section === "" || section === title) {
    return false;
  }
  return section.toLowerCase() !== "role description";
}

function Citation({ citation }: { citation: AskCitation }) {
  const href = safeCitationHref(citation.url);
  // The separator is real text, so copied text and the link's accessible name read
  // "General Studies, Coursework" rather than "General StudiesCoursework".
  const body = (
    <>
      <span className="citation-title">{citation.title}</span>
      {showSection(citation) ? (
        <>
          {", "}
          <span className="citation-section">{citation.section}</span>
        </>
      ) : null}
    </>
  );
  if (!href) {
    return <p className="citation-card">{body}</p>;
  }
  return (
    <a className="citation-card" href={href}>
      {body}
    </a>
  );
}
