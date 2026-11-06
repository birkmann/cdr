import type { ReasoningEffort } from "@harness/protocol";
import { collect, type Provider } from "./providers/types.js";

/** Reasoning characters to collect before asking for a summary while the model is still thinking. */
const CHUNK_CHARS = 1800;
/** Leftover reasoning worth summarising once thinking ends. */
const MIN_TAIL_CHARS = 400;
/** Minimum gap between two summary requests. */
const MIN_INTERVAL_MS = 10_000;

const SYSTEM = [
  "You watch a coding agent think and tell its user, in a status line, which decisions it just made.",
  "You get the user's request, the decisions already reported, and a new fragment of the agent's private reasoning.",
  "Reply with at most 2 lines, one decision per line, each at most 14 words, present tense, no leading bullet,",
  'e.g. "Uses localStorage to keep saved journeys" or "Splits the layout into a map and a timetable panel".',
  "Report only concrete choices (what it builds, uses, changes, skips, or concludes), not that it is thinking or reading.",
  "Never repeat a decision already reported. Write in the language of the user's request.",
  "If the fragment contains no new decision, reply exactly NONE.",
].join(" ");

export interface ReasoningSummaryOptions {
  provider: Provider;
  model: string;
  /** Model reference for usage events (provider/model). */
  modelRef?: string;
  /** The user's request, so summaries are relevant and in the user's language. */
  request: string;
  signal: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  /** Called with each new decision line. */
  onSummary(text: string): void;
  /** Token usage of the summary calls. */
  onUsage?(inputTokens: number, outputTokens: number, model?: string): void;
}

/**
 * Turns a model's streamed reasoning into short "decision" lines while it is still thinking,
 * using a (cheap) summarizer model in the background. One request at a time; failures are ignored
 * because the summaries are a convenience, never part of the agent's work.
 */
export class ReasoningSummarizer {
  private pending = "";
  private reported: string[] = [];
  private inFlight?: Promise<void>;
  private last = 0;
  private closed = false;

  constructor(private readonly o: ReasoningSummaryOptions) {}

  /** Feed a reasoning delta. */
  push(text: string): void {
    if (this.closed) return;
    this.pending += text;
    if (this.pending.length >= CHUNK_CHARS && !this.inFlight && Date.now() - this.last >= MIN_INTERVAL_MS)
      this.request();
  }

  /** Thinking ended (text, tool calls or end of stream): summarise what is left, in the background. */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    const tail = () => {
      if (this.pending.length >= MIN_TAIL_CHARS) this.request();
    };
    if (this.inFlight) void this.inFlight.then(tail);
    else tail();
  }

  /** Resolves when the current request (if any) has settled. For tests. */
  async idle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  private request(): void {
    const fragment = this.pending.slice(-12_000);
    this.pending = "";
    this.last = Date.now();
    this.inFlight = this.summarise(fragment)
      .catch(() => {})
      .finally(() => {
        this.inFlight = undefined; // the next reasoning delta (or finish) starts the next request
      });
  }

  private async summarise(fragment: string): Promise<void> {
    if (this.o.signal.aborted) return;
    const res = await collect(
      this.o.provider.stream({
        model: this.o.model,
        reasoningEffort: this.o.reasoningEffort,
        signal: this.o.signal,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              `User's request:\n${this.o.request.slice(0, 1500)}`,
              `Already reported:\n${this.reported.slice(-8).join("\n") || "(nothing yet)"}`,
              `New reasoning fragment:\n${fragment}`,
            ].join("\n\n"),
          },
        ],
      }),
    );
    this.o.onUsage?.(res.usage.input, res.usage.output, this.o.modelRef);
    if (this.o.signal.aborted) return;
    for (const line of parseSummary(res.text)) {
      this.reported.push(line);
      this.o.onSummary(line);
    }
  }
}

/** Decision lines from a summarizer reply ("NONE" → none). */
export function parseSummary(text: string): string[] {
  return text
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
        .replace(/^["“]|["”]$/g, "")
        .trim(),
    )
    .filter((l) => l && !/^none\.?$/i.test(l))
    .slice(0, 2)
    .map((l) => (l.length > 140 ? l.slice(0, 139) + "…" : l));
}
