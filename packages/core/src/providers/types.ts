import type { ChatMessage, ToolCall, ReasoningEffort } from "@harness/protocol";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  reasoningEffort?: ReasoningEffort;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; finishReason: string };

export interface ProviderCapabilities {
  reasoningEfforts?: Exclude<ReasoningEffort, "auto">[];
  tools: boolean;
  json: boolean;
  reasoning?: boolean;
  contextWindow: number;
}

export interface Provider {
  id: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>;
  capabilities(model: string): ProviderCapabilities;
  countTokens?(messages: ChatMessage[]): number;
  listModels?(signal?: AbortSignal): Promise<string[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "user" && !!m.images?.length);
}

/** Remove images (for models without vision), leaving a note so the model knows they existed. */
export function stripImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "user" && m.images?.length
      ? {
          role: "user",
          content: `${m.content}\n\n[${m.images.length} image(s) were attached, but the current model cannot view images. Tell the user if the images matter for the task.]`,
        }
      : m,
  );
}

/** Collect a full response (used by summarizer / reviewer helpers and tests). */
export async function collect(stream: AsyncIterable<ProviderEvent>): Promise<{
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
}> {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  const usage = { input: 0, output: 0 };
  for await (const ev of stream) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "reasoning") reasoning += ev.text;
    else if (ev.type === "tool_call") toolCalls.push(ev.call);
    else if (ev.type === "usage") {
      usage.input += ev.inputTokens;
      usage.output += ev.outputTokens;
    }
  }
  return { text, reasoning, toolCalls, usage };
}

/** Parse a fetch Response body as Server-Sent Events, yielding {event, data}. */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<{ event?: string; data: string; id?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n"), id };
          event = undefined;
          id = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const idx = line.indexOf(":");
        const field = idx < 0 ? line : line.slice(0, idx);
        let val = idx < 0 ? "" : line.slice(idx + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "data") data.push(val);
        else if (field === "event") event = val;
        else if (field === "id") id = val;
      }
    }
    if (data.length) yield { event, data: data.join("\n"), id };
  } finally {
    reader.releaseLock();
  }
}
