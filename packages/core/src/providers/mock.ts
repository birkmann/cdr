import type { ChatMessage } from "@harness/protocol";
import type { Provider, ProviderCapabilities, ProviderEvent, ProviderRequest } from "./types.js";
import { newId } from "../util.js";

export interface MockReply {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; args: unknown }[];
}

export type MockHandler = (req: ProviderRequest, callIndex: number) => MockReply | Promise<MockReply>;

/**
 * Deterministic provider for tests and offline demos. Either give it a list of replies
 * (consumed in order) or a handler function that inspects the request.
 */
export class MockProvider implements Provider {
  readonly id: string;
  calls: ProviderRequest[] = [];
  private queue: MockReply[] = [];
  private handler?: MockHandler;

  constructor(
    opts: { id?: string; replies?: MockReply[]; handler?: MockHandler; contextWindow?: number } = {},
  ) {
    this.id = opts.id ?? "mock";
    this.queue = [...(opts.replies ?? [])];
    this.handler = opts.handler;
    this.ctx = opts.contextWindow ?? 100_000;
  }
  private ctx: number;

  capabilities(): ProviderCapabilities {
    return { tools: true, json: true, contextWindow: this.ctx };
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const index = this.calls.length;
    this.calls.push({ ...req, messages: structuredClone(req.messages) });
    const reply: MockReply = this.handler
      ? await this.handler(req, index)
      : (this.queue.shift() ?? { text: "Done." });
    if (reply.reasoning) yield { type: "reasoning", text: reply.reasoning };
    if (reply.text) {
      for (const part of reply.text.match(/.{1,16}/gs) ?? []) {
        if (req.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        yield { type: "text", text: part };
      }
    }
    for (const c of reply.toolCalls ?? []) {
      yield {
        type: "tool_call",
        call: { id: newId("call_"), name: c.name, arguments: JSON.stringify(c.args) },
      };
    }
    const input = req.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
    yield { type: "usage", inputTokens: input, outputTokens: Math.ceil((reply.text?.length ?? 0) / 4) + 5 };
    yield { type: "done", finishReason: reply.toolCalls?.length ? "tool_calls" : "stop" };
  }
}

/** Helper for handlers: the last user message content. */
export function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i].content;
  return "";
}
