import { randomBytes } from "node:crypto";
import type { ChatMessage } from "@harness/protocol";

export function newId(prefix = ""): string {
  return prefix + randomBytes(6).toString("hex");
}

export function sessionId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Keep head and tail of a long string; returns whether it was truncated. */
export function truncateMiddle(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Rough token estimate (~4 chars per token) used when the provider can't count. */
export function estimateTokens(messages: ChatMessage[] | string): number {
  if (typeof messages === "string") return Math.ceil(messages.length / 4);
  let n = 0;
  for (const m of messages) {
    n += 4 + Math.ceil(m.content.length / 4);
    if (m.role === "user" && m.images) n += 1000 * m.images.length;
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) n += Math.ceil((c.name.length + c.arguments.length) / 4) + 4;
    }
  }
  return n;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / DeepSeek style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

const knownSecrets = new Set<string>();

/** Register exact secret values (e.g. loaded API keys) so they are always redacted. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of knownSecrets) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out;
}

/** Deep-redact strings in an arbitrary JSON-ish value. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out as T;
  }
  return value;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "task"
  );
}

/** Convert a simple glob (supports **, *, ?, {a,b}) to a RegExp matched against posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let inGroup = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(?:";
      inGroup = true;
    } else if (c === "}" && inGroup) {
      re += ")";
      inGroup = false;
    } else if (c === "," && inGroup) re += "|";
    else if ("\\^$+.()|[]".includes(c)) re += "\\" + c;
    else re += c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** Simple wildcard match for permission rules: "*" matches anything (including spaces). */
export function wildcardMatch(pattern: string, text: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$", "s");
  return re.test(text.trim());
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Deep merge plain objects (arrays are replaced). */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over ?? base) as T;
  if (!base || typeof base !== "object" || Array.isArray(base)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = deepMerge(out[k], v);
  }
  return out as T;
}
