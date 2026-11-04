import type { ChatMessage, ModelInfo } from "@harness/protocol";
import {
  ProviderError,
  parseSSE,
  type Provider,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderRequest,
} from "./types.js";
import { sleep, isAbortError } from "../util.js";

export interface AnthropicOptions {
  id: string;
  baseURL?: string;
  apiKey?: string;
  models?: Record<string, ModelInfo>;
  maxRetries?: number;
  fetch?: typeof fetch;
}

/** Anthropic Messages API adapter with native tool use and prompt caching. */
export class AnthropicProvider implements Provider {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: AnthropicOptions) {
    this.id = opts.id;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  capabilities(model: string): ProviderCapabilities {
    const info = this.opts.models?.[model] ?? {};
    return {
      tools: true,
      json: true,
      reasoning: info.reasoning,
      contextWindow: info.contextWindow ?? 200_000,
    };
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const tools = (req.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    if (tools.length)
      (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? this.opts.models?.[req.model]?.maxTokens ?? 16_000,
      stream: true,
      messages,
    };
    if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    if (tools.length) body.tools = tools;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const res = await this.request(body, req.signal);
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    for await (const sse of parseSSE(res.body!, req.signal)) {
      let ev: any;
      try {
        ev = JSON.parse(sse.data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "message_start": {
          const u = ev.message?.usage ?? {};
          const input =
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          yield { type: "usage", inputTokens: input, outputTokens: u.output_tokens ?? 0 };
          break;
        }
        case "content_block_start":
          blocks.set(ev.index, {
            type: ev.content_block.type,
            id: ev.content_block.id,
            name: ev.content_block.name,
            json: "",
          });
          break;
        case "content_block_delta": {
          const d = ev.delta;
          if (d.type === "text_delta") yield { type: "text", text: d.text };
          else if (d.type === "thinking_delta") yield { type: "reasoning", text: d.thinking };
          else if (d.type === "input_json_delta") {
            const b = blocks.get(ev.index);
            if (b) b.json += d.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(ev.index);
          if (b?.type === "tool_use") {
            yield { type: "tool_call", call: { id: b.id!, name: b.name!, arguments: b.json || "{}" } };
          }
          break;
        }
        case "message_delta":
          if (ev.usage) yield { type: "usage", inputTokens: 0, outputTokens: ev.usage.output_tokens ?? 0 };
          if (ev.delta?.stop_reason) yield { type: "done", finishReason: ev.delta.stop_reason };
          break;
        case "error":
          throw new ProviderError(`${this.id}: ${ev.error?.message ?? "stream error"}`);
      }
    }
  }

  private async request(body: unknown, signal?: AbortSignal): Promise<Response> {
    const max = this.opts.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchImpl(
          `${(this.opts.baseURL ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
            },
            body: JSON.stringify(body),
            signal,
          },
        );
        if (res.ok && res.body) return res;
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        if (!retryable || attempt >= max)
          throw new ProviderError(
            `${this.id}: HTTP ${res.status} ${text.slice(0, 500)}`,
            res.status,
            retryable,
          );
        await sleep(Math.min(30_000, 500 * 2 ** attempt), signal);
      } catch (e) {
        if (isAbortError(e) || e instanceof ProviderError || attempt >= max) throw e;
        await sleep(Math.min(30_000, 500 * 2 ** attempt), signal);
      }
    }
  }
}

export function toAnthropicMessages(input: ChatMessage[]): { system: string; messages: any[] } {
  const system = input
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const messages: any[] = [];
  const push = (role: "user" | "assistant", block: any) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const m of input) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      for (const img of m.images ?? [])
        push("user", { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
      push("user", { type: "text", text: m.content || "(empty)" });
    } else if (m.role === "tool")
      push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
    else {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments || "{}");
        } catch {
          input = { _raw: c.arguments };
        }
        push("assistant", { type: "tool_use", id: c.id, name: c.name, input });
      }
      if (!m.content && !m.toolCalls?.length) push("assistant", { type: "text", text: "(empty)" });
    }
  }
  return { system, messages };
}
