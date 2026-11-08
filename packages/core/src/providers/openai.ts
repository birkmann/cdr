import type { ChatMessage, ModelCapability, ModelDetail, ModelInfo, ToolCall } from "@harness/protocol";
import {
  ProviderError,
  parseSSE,
  type Provider,
  type ProviderBalance,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderRequest,
} from "./types.js";
import { parseTextToolCalls, toTextProtocolMessages } from "./text-protocol.js";
import { sleep, isAbortError } from "../util.js";
import { hasImages, stripImages } from "./types.js";

export interface OpenAICompatibleOptions {
  id: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Record<string, ModelInfo>;
  maxRetries?: number;
  fetch?: typeof fetch;
}

const KNOWN_CONTEXT: [RegExp, number][] = [
  [/deepseek/i, 128_000],
  [/qwen3/i, 128_000],
  [/kimi/i, 200_000],
  [/gpt-4o|gpt-4\.1|gpt-5/i, 128_000],
  [/llama3|llama-3/i, 128_000],
  [/claude/i, 200_000],
];

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  private readonly noToolModels = new Set<string>();
  private readonly noImageModels = new Set<string>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private isDeepSeek(model: string): boolean {
    return new URL(this.opts.baseURL).hostname === "api.deepseek.com" && /^deepseek-(flash|v4)/i.test(model);
  }

  capabilities(model: string): ProviderCapabilities {
    const info = this.opts.models?.[model] ?? {};
    const ctx = info.contextWindow ?? KNOWN_CONTEXT.find(([re]) => re.test(model))?.[1] ?? 32_000;
    return {
      reasoningEfforts:
        info.reasoningEfforts ?? (this.isDeepSeek(model) ? ["none", "low", "high", "max"] : []),
      tools: info.tools ?? !this.noToolModels.has(model),
      ...(info.vision !== undefined || this.noImageModels.has(model) ? { vision: info.vision ?? false } : {}),
      json: true,
      reasoning: info.reasoning ?? (this.isDeepSeek(model) || /reasoner|r1|thinking/i.test(model)),
      contextWindow: ctx,
    };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    return (await this.listModelDetails(signal)).map((m) => m.id);
  }

  /**
   * Models with their capabilities where the server reports them. Ollama (local or cloud) exposes
   * `capabilities` and `context_length` on its native /api/tags; other servers only list ids.
   * Config overrides (`models.<id>`) always win over what the server reports.
   */
  async listModelDetails(signal?: AbortSignal): Promise<ModelDetail[]> {
    const base = this.opts.baseURL.replace(/\/$/, "");
    const native = await this.ollamaTags(base, signal);
    const details: ModelDetail[] = native ?? (await this.openAIModelIds(base, signal)).map((id) => ({ id }));
    return details
      .map((d) => {
        const override = this.opts.models?.[d.id];
        const caps = new Set<ModelCapability>(d.capabilities ?? []);
        if (override?.tools === true) caps.add("tools");
        if (override?.tools === false) caps.delete("tools");
        if (override?.vision === true) caps.add("vision");
        if (override?.vision === false) caps.delete("vision");
        if (override?.reasoning === true) caps.add("thinking");
        if (override?.reasoning === false) caps.delete("thinking");
        const contextWindow = override?.contextWindow ?? d.contextWindow;
        return {
          id: d.id,
          ...(caps.size ? { capabilities: [...caps].sort() } : {}),
          ...(contextWindow ? { contextWindow } : {}),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async openAIModelIds(base: string, signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${base}/models`, { headers: this.headers(), signal });
    if (!res.ok) throw new ProviderError(`${this.id}: GET /models -> ${res.status}`, res.status);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }

  /** Ollama's native model list with capabilities, or undefined when the server is not Ollama (or does not answer it). */
  private async ollamaTags(base: string, signal?: AbortSignal): Promise<ModelDetail[] | undefined> {
    // Ollama serves its native API next to the OpenAI-compatible /v1 path. Only probe hosts that look like
    // Ollama, so other providers neither pay for a failed request nor receive their key on a guessed URL.
    if (!/\/v1$/.test(base) || !looksLikeOllama(base)) return undefined;
    const root = base.replace(/\/v1$/, "");
    try {
      const res = await this.fetchImpl(`${root}/api/tags`, { headers: this.headers(), signal });
      if (!res.ok) return undefined;
      const json = (await res.json()) as {
        models?: {
          name?: string;
          model?: string;
          capabilities?: string[];
          details?: { context_length?: number };
        }[];
      };
      if (!Array.isArray(json.models)) return undefined;
      const listed = json.models.flatMap((m) => {
        const id = m.model || m.name;
        return id ? [{ id, capabilities: m.capabilities, contextWindow: m.details?.context_length }] : [];
      });
      // /api/tags carries no capabilities on a stock Ollama; /api/show does.
      return await Promise.all(
        listed.map(async (m) => {
          const shown =
            m.capabilities || m.contextWindow ? m : { ...m, ...(await this.ollamaShow(root, m.id, signal)) };
          const caps = toCapabilities(shown.capabilities);
          return {
            id: m.id,
            ...(caps.length ? { capabilities: caps } : {}),
            ...(shown.contextWindow ? { contextWindow: shown.contextWindow } : {}),
          };
        }),
      );
    } catch (e) {
      if (isAbortError(e)) throw e;
      return undefined;
    }
  }

  private async ollamaShow(
    root: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ capabilities?: string[]; contextWindow?: number }> {
    try {
      const res = await this.fetchImpl(`${root}/api/show`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model }),
        signal,
      });
      if (!res.ok) return {};
      const json = (await res.json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
      // The context length is stored under an architecture-specific key such as "llama.context_length".
      const key = Object.keys(json.model_info ?? {}).find((k) => k.endsWith(".context_length"));
      const ctx = key ? Number(json.model_info?.[key]) : undefined;
      return { capabilities: json.capabilities, ...(ctx && ctx > 0 ? { contextWindow: ctx } : {}) };
    } catch (e) {
      if (isAbortError(e)) throw e;
      return {};
    }
  }

  async getBalance(signal?: AbortSignal): Promise<ProviderBalance[] | null> {
    if (new URL(this.opts.baseURL).hostname !== "api.deepseek.com") return null;
    const res = await this.fetchImpl(`${this.opts.baseURL.replace(/\/$/, "")}/user/balance`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new ProviderError(`${this.id}: GET /user/balance -> ${res.status}`, res.status);
    const json = (await res.json()) as {
      balance_infos?: {
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }[];
    };
    const num = (v: string | undefined) => {
      const n = Number(v);
      return v !== undefined && Number.isFinite(n) ? n : undefined;
    };
    return (json.balance_infos ?? []).flatMap((b) => {
      const total = num(b.total_balance);
      if (!b.currency || total === undefined) return [];
      return [
        { currency: b.currency, total, granted: num(b.granted_balance), toppedUp: num(b.topped_up_balance) },
      ];
    });
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const useText = !!req.tools?.length && !this.capabilities(req.model).tools;
    if (this.noImageModels.has(req.model) && hasImages(req.messages))
      req = { ...req, messages: stripImages(req.messages) };
    try {
      yield* this.streamOnce(req, useText);
    } catch (e) {
      // Auto-fallback: the model rejects image input → resend without images (with a note).
      if (
        e instanceof ProviderError &&
        e.status !== undefined &&
        e.status >= 400 &&
        e.status < 500 &&
        hasImages(req.messages) &&
        /image|vision|multimodal|image_url|content.*(type|array)|unknown variant|expected.*string|invalid type/i.test(
          e.message,
        )
      ) {
        this.noImageModels.add(req.model);
        yield* this.stream({ ...req, messages: stripImages(req.messages) });
        return;
      }
      // Auto-fallback: server says the model does not support tools.
      if (
        !useText &&
        e instanceof ProviderError &&
        e.status === 400 &&
        /does not support tools|tool.*not supported|tools.*unsupported/i.test(e.message)
      ) {
        this.noToolModels.add(req.model);
        yield* this.streamOnce(req, true);
        return;
      }
      throw e;
    }
  }

  private async *streamOnce(req: ProviderRequest, textProtocol: boolean): AsyncIterable<ProviderEvent> {
    const tools = req.tools ?? [];
    const messages = textProtocol ? toTextProtocolMessages(req.messages, tools) : req.messages;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    const effort = req.reasoningEffort;
    if (effort && effort !== "auto" && this.capabilities(req.model).reasoningEfforts?.includes(effort)) {
      if (this.isDeepSeek(req.model)) {
        body.thinking = { type: effort === "none" ? "disabled" : "enabled" };
        if (effort !== "none") body.reasoning_effort = effort;
      } else body.reasoning_effort = effort;
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (!textProtocol && tools.length) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await this.request(body, req.signal);
    const partial = new Map<string, { id: string; name: string; args: string }>();
    const order: string[] = [];
    let text = "";
    let finish = "stop";

    for await (const sse of parseSSE(res.body!, req.signal)) {
      if (sse.data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(sse.data);
      } catch {
        continue;
      }
      if (chunk.error)
        throw new ProviderError(`${this.id}: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        yield { type: "text", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const key = tc.index !== undefined ? `i${tc.index}` : (tc.id ?? `p${order.length}`);
        let p = partial.get(key);
        if (!p) {
          p = { id: tc.id ?? "", name: "", args: "" };
          partial.set(key, p);
          order.push(key);
        }
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name += tc.function.name;
        if (tc.function?.arguments !== undefined) {
          p.args +=
            typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments);
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    let n = 0;
    for (const key of order) {
      const p = partial.get(key)!;
      if (!p.name) continue;
      const call: ToolCall = {
        id: p.id || `call_${Date.now()}_${n++}`,
        name: p.name,
        arguments: p.args || "{}",
      };
      yield { type: "tool_call", call };
    }
    if (textProtocol) {
      const calls = parseTextToolCalls(text, new Set(tools.map((t) => t.name)));
      for (const call of calls) yield { type: "tool_call", call };
      if (calls.length) finish = "tool_calls";
    }
    yield { type: "done", finishReason: finish };
  }

  private async request(body: unknown, signal?: AbortSignal): Promise<Response> {
    const max = this.opts.maxRetries ?? 4;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
        });
        if (res.ok && res.body) return res;
        const errText = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        const err = new ProviderError(
          `${this.id}: HTTP ${res.status} ${errText.slice(0, 500)}`.trim(),
          res.status,
          retryable,
        );
        if (!retryable || attempt === max) throw err;
        lastErr = err;
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt), signal);
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        if (e instanceof ProviderError && !e.retryable) throw e;
        if (attempt === max) throw e;
        lastErr = e;
        await sleep(backoff(attempt), signal);
      }
    }
    throw lastErr;
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "assistant": {
      const out: Record<string, unknown> = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }));
        // Some reasoning APIs (DeepSeek thinking mode) require reasoning to be echoed within a tool sub-turn.
        if (m.reasoning) out.reasoning_content = m.reasoning;
      }
      return out;
    }
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "user":
      if (m.images?.length) {
        return {
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...m.images.map((i) => ({
              type: "image_url",
              image_url: { url: `data:${i.mimeType};base64,${i.data}` },
            })),
          ],
        };
      }
      return { role: "user", content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

/** Local Ollama (default port 11434) or Ollama's cloud; other hosts are not asked for the native API. */
function looksLikeOllama(base: string): boolean {
  try {
    const u = new URL(base);
    return u.port === "11434" || /(^|\.)ollama\./i.test(u.hostname);
  } catch {
    return false;
  }
}

function toCapabilities(raw: string[] | undefined): ModelCapability[] {
  const out: ModelCapability[] = [];
  for (const c of raw ?? [])
    if (c === "tools" || c === "vision" || c === "thinking" || c === "embedding") out.push(c);
  return out;
}
