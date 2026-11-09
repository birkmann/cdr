/**
 * Model client of mirror mode. Every call goes through the host's configured models, so mirror mode needs no provider
 * keys of its own and the session counts the usage. What the pipeline relies on is kept from the original client:
 *  - JSON mode: strict extraction, then `req.validate`; a validator error gets one retry with the error appended.
 *  - Response cache `llm-cache/<sha256>.json`, read before calling and written only for validated answers.
 *  - Images are sent only with `site.llm.sendContent` (screenshots contain page text).
 *  - Every call is logged to `llm-log/` with hashes and token counts, never the prompt text.
 * No host model means `createHostLlmClient` returns undefined and callers take their deterministic path.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse, SiteConfig } from "./contracts.js";
import type { Workspace } from "./workspace.js";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly attempts?: number,
    readonly provider?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface HostMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** PNG/JPEG data URLs */
  images?: string[];
}
export interface HostCompletion {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model?: string;
}
export type HostComplete = (messages: HostMessage[], opts: { maxTokens?: number }) => Promise<HostCompletion>;

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
let seq = 0;

/** For a client that reports no cost of its own: a low list price per million tokens, so a budget still stops the loop. */
export function estimateCostUsd(_provider: string, promptTokens: number, completionTokens: number): number {
  return Math.round(((promptTokens * 0.3 + completionTokens * 1.2) / 1_000_000) * 1e9) / 1e9;
}

/** End index (inclusive) of the balanced `{…}` / `[…]` starting at `i`, honouring JSON strings; -1 if unbalanced. */
function balancedEnd(t: string, i: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return j;
    }
  }
  return -1;
}

/**
 * Strict JSON extraction from a model reply: the whole reply when it parses (``` fences stripped), otherwise the LAST
 * complete top-level JSON object in it (models sometimes emit a stray prefix such as `{"ok":## Confirming…\n{"ok":true}`).
 * Returns the trimmed input when nothing parses (the caller's JSON.parse then fails).
 */
export function extractJson(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fence ? fence[1] : t;
  try {
    JSON.parse(body);
    return body;
  } catch {
    /* scan */
  }
  let last: string | undefined;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{") continue;
    const end = balancedEnd(body, i);
    if (end < 0) continue;
    const cand = body.slice(i, end + 1);
    try {
      JSON.parse(cand);
      last = cand;
      i = end; // nested objects of an accepted object are not top-level
    } catch {
      /* try the next "{" */
    }
  }
  return last ?? body;
}


const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

async function imageDataUrl(ws: Workspace, ref: string): Promise<string> {
  if (ref.startsWith("data:")) return ref;
  const mime = MIME[/\.([a-z0-9]+)$/i.exec(ref)?.[1]?.toLowerCase() ?? ""];
  if (!mime) throw new LlmError(`unsupported image type: ${ref}`, undefined, 0, undefined, "bad_request");
  const bytes = await readFile(ws.path(ref)).catch((e: Error) => {
    throw new LlmError(`image not readable: ${ref} (${e.message})`, undefined, 0, undefined, "bad_request");
  });
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function llmCacheKey(req: Pick<LlmRequest, "json" | "schemaId" | "effort" | "maxTokens" | "temperature">, messages: HostMessage[]): string {
  const keyed = messages.map((m) => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images.map(sha256) } : {}) }));
  return sha256(JSON.stringify({ v: 2, messages: keyed, json: !!req.json, schemaId: req.schemaId ?? null, effort: req.effort ?? null, maxTokens: req.maxTokens ?? null, temperature: req.temperature ?? null }));
}

interface CacheRecord {
  content: string;
  model: string;
}

export function createHostLlmClient(ws: Workspace, site: SiteConfig | undefined, complete: HostComplete | undefined): LlmClient | undefined {
  if (!complete) return undefined;
  const sendContent = !!site?.llm?.sendContent;
  const validated = (req: LlmRequest, content: string): unknown => {
    const parsed: unknown = JSON.parse(extractJson(content));
    return req.validate ? req.validate(parsed) : parsed;
  };
  const log = async (req: LlmRequest, messages: HostMessage[], rec: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    let name = `llm-log/${ts.replace(/[:.]/g, "-")}-${req.step.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
    while (await ws.exists(name)) name = name.replace(/(-\d+)?\.json$/, `-${++seq}.json`);
    await ws.writeJson(name, { ts, step: req.step, promptSha256: sha256(JSON.stringify(messages.map((m) => m.content))), ...rec }).catch(() => undefined);
  };
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const t0 = performance.now();
      const messages: HostMessage[] = [];
      for (const m of req.messages as LlmMessage[]) {
        const images = sendContent && m.images?.length ? await Promise.all(m.images.map((i) => imageDataUrl(ws, i))) : undefined;
        messages.push({ role: m.role, content: m.content, ...(images ? { images } : {}) });
      }
      const useCache = req.cache !== false;
      const cachePath = `llm-cache/${llmCacheKey(req, messages)}.json`;
      if (useCache && (await ws.exists(cachePath))) {
        try {
          const c = await ws.readJson<CacheRecord>(cachePath);
          const parsed = req.json ? validated(req, c.content) : undefined;
          await log(req, messages, { cached: true, ok: true, model: c.model, estCostUsd: 0 });
          return { content: c.content, model: c.model, promptTokens: 0, completionTokens: 0, durationMs: Math.round(performance.now() - t0), provider: "host", fallback: false, cached: true, ...(req.json ? { parsed } : {}) };
        } catch {
          /* a stale entry (validator changed) falls through to the model */
        }
      }
      let convo = messages;
      let lastError = "";
      const rounds = req.json && req.validate ? 2 : 1;
      for (let round = 0; round < rounds; round++) {
        const r = await complete(convo, { maxTokens: req.maxTokens });
        let parsed: unknown;
        let invalid: string | undefined;
        if (req.json) {
          try {
            parsed = validated(req, r.text);
          } catch (e) {
            invalid = (e as Error).message;
          }
        }
        const model = r.model ?? "host";
        await log(req, messages, { cached: false, ok: invalid === undefined, model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, estCostUsd: r.costUsd, ...(invalid ? { validationError: invalid } : {}) });
        if (invalid !== undefined) {
          lastError = invalid;
          convo = [...messages, { role: "assistant", content: r.text }, { role: "user", content: `Your JSON did not pass validation:\n${invalid}\nReply with ONLY the corrected JSON object.` }];
          continue;
        }
        if (useCache) await ws.writeJson(cachePath, { content: r.text, model } satisfies CacheRecord).catch(() => undefined);
        const res: LlmResponse & { estCostUsd: number } = { content: r.text, model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, durationMs: Math.round(performance.now() - t0), provider: "host", fallback: false, cached: false, estCostUsd: r.costUsd, ...(req.json ? { parsed } : {}) };
        return res;
      }
      throw new LlmError(`response failed validation twice (${req.schemaId ?? req.step}): ${lastError}`, undefined, rounds, undefined, "invalid_response");
    },
  };
}

/**
 * Convenience for LLM-assisted steps: ask for JSON, validate it (the client retries once on a validator error), return
 * `undefined` on ANY failure (no client, network, model error, invalid JSON, validator rejects, budget) so the caller
 * falls through to its deterministic path. A validator returning `undefined` counts as a rejection. Default
 * `effort: "none"` (DeepSeek thinking off; cheapest) unless the request sets one.
 */
export async function tryLlmJson<T = unknown>(
  llm: LlmClient | undefined,
  req: Omit<LlmRequest, "json" | "validate">,
  validate?: (x: unknown) => T | undefined,
  onError?: (e: Error) => void,
): Promise<T | undefined> {
  if (!llm) return undefined;
  const strict = validate
    ? (x: unknown): T => {
        const v = validate(x);
        if (v === undefined) throw new Error("response rejected by validator");
        return v;
      }
    : undefined;
  try {
    // small JSON answers (names, summaries) need no reasoning: thinking off unless the caller asks for it
    const res = await llm.complete({ effort: "none", ...req, json: true, ...(strict ? { validate: strict } : {}) });
    if (res.parsed !== undefined) return res.parsed as T;
    const parsed = JSON.parse(extractJson(res.content)) as unknown;
    return strict ? strict(parsed) : (parsed as T);
  } catch (e) {
    onError?.(e as Error);
    return undefined;
  }
}

interface UsageAgg {
  calls: number;
  failed: number;
  fallbacks: number;
  cached: number;
  promptTokens: number;
  completionTokens: number;
  estCostUsd: number;
}
const emptyAgg = (): UsageAgg => ({ calls: 0, failed: 0, fallbacks: 0, cached: 0, promptTokens: 0, completionTokens: 0, estCostUsd: 0 });
interface LogRecord {
  step: string;
  ok?: boolean;
  cached?: boolean;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  estCostUsd?: number;
}

/** Tokens and cost per step and per provider, from llm-log/. */
export async function summarizeLlmLog(ws: Workspace): Promise<UsageAgg & { byStep: Record<string, UsageAgg & { models: string[]; providers: string[] }>; byProvider: Record<string, UsageAgg> }> {
  const out = { ...emptyAgg(), byStep: {} as Record<string, UsageAgg & { models: string[]; providers: string[] }>, byProvider: {} as Record<string, UsageAgg> };
  for (const f of await ws.list("llm-log", ".json")) {
    const r = await ws.readJson<LogRecord>(f).catch(() => undefined);
    if (!r || typeof r.step !== "string") continue;
    const s = (out.byStep[r.step] ??= { ...emptyAgg(), models: [], providers: [] });
    const provider = r.provider ?? "host";
    const prov = (out.byProvider[provider] ??= emptyAgg());
    for (const agg of [out, s, prov]) {
      agg.calls++;
      if (!r.ok) agg.failed++;
      if (r.cached) agg.cached++;
      agg.promptTokens += r.promptTokens ?? 0;
      agg.completionTokens += r.completionTokens ?? 0;
      agg.estCostUsd = Math.round((agg.estCostUsd + (r.estCostUsd ?? 0)) * 1e9) / 1e9;
    }
    if (r.model && !s.models.includes(r.model)) s.models.push(r.model);
    if (!s.providers.includes(provider)) s.providers.push(provider);
  }
  return out;
}
