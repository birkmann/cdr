/**
 * Shared helpers for handlers: prompt files, the JSON LLM call (validate + schemaId + step "autofix-<handler>"),
 * mapping yaml documents, and content-free message sanitising.
 */
import { firstExistingPath } from "@harness/mirror-core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractJson, type Workspace } from "@harness/mirror-core";
import YAML from "yaml";
import type { AutofixContext } from "../types.js";

const PROMPTS = firstExistingPath(import.meta.url, ["../../prompts/", "./mirror/prompts/"]);

export function loadPrompt(id: string): { text: string; sha: string } {
  const text = readFileSync(`${PROMPTS}${id}.md`, "utf8");
  return { text, sha: createHash("sha256").update(text).digest("hex").slice(0, 12) };
}

/**
 * One JSON proposal from DeepSeek. Returns undefined when there is no client or the call fails for a reason other than
 * the budget (budget errors are rethrown so the loop stops).
 */
export async function llmJson<T>(
  ctx: AutofixContext,
  handler: string,
  req: { system: string; user: unknown; schemaId: string; validate: (x: unknown) => T; model?: string; maxTokens?: number; effort?: "low" | "high" | "max" },
): Promise<T | undefined> {
  if (!ctx.llm) return undefined;
  try {
    const res = await ctx.llm.complete({
      step: `autofix-${handler}`,
      json: true,
      temperature: 0,
      model: req.model,
      maxTokens: req.maxTokens ?? 4000,
      effort: req.effort ?? "low",
      schemaId: req.schemaId,
      validate: req.validate,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: typeof req.user === "string" ? req.user : JSON.stringify(req.user, null, 1) },
      ],
    });
    if (res.parsed !== undefined) return res.parsed as T;
    return req.validate(JSON.parse(extractJson(res.content)));
  } catch (e) {
    const err = e as Error & { code?: string; status?: number };
    if (err.code === "budget" || /budget/i.test(err.message) || err.status === 402) throw e;
    ctx.log.warn(`autofix-${handler}: LLM proposal failed: ${err.message.split("\n")[0]}`);
    return undefined;
  }
}

export interface YamlFile {
  rel: string;
  doc: YAML.Document.Parsed;
  data: any;
}

export async function readYaml(ws: Workspace, rel: string): Promise<YamlFile | undefined> {
  if (!(await ws.exists(rel))) return undefined;
  const doc = YAML.parseDocument(await ws.readText(rel));
  return { rel, doc, data: doc.toJS() };
}

/** the site's main mapping file: mapping/drupal.yaml (drupal source) or mapping/html.yaml */
export async function mainMapping(ws: Workspace, adapter: "drupal" | "html"): Promise<YamlFile | undefined> {
  const order = adapter === "html" ? ["mapping/html.yaml", "mapping/drupal.yaml"] : ["mapping/drupal.yaml", "mapping/html.yaml"];
  for (const rel of order) {
    const y = await readYaml(ws, rel);
    if (y) return y;
  }
  return undefined;
}

/** Issue messages may carry values ("got \"2024-…\""): cut them unless sendContent. */
export function sanitizeMessage(msg: string, sendContent: boolean): string {
  if (sendContent) return msg;
  return msg
    .replace(/\bgot\s+(?!string\b|number\b|boolean\b|object\b|undefined\b)("[^"]*"?|\S+).*$/i, "got <value>")
    .replace(/value "[^"]*"/g, 'value "<value>"')
    .slice(0, 300);
}

/** Drop example markup / quoted values from miner and validator messages (" — e.g. …", "…") unless sendContent. */
export function contentFree(msg: string, sendContent: boolean): string {
  if (sendContent) return msg.slice(0, 600);
  return msg
    .split(" — ")[0]
    .replace(/"[^"]*"/g, '"…"')
    .slice(0, 300);
}

export interface ReviewEntry {
  path: string;
  decision: string;
  reason: string;
  origin: "rule" | "llm";
  value?: unknown;
}

/** mapping/review.yaml content with `add` merged in (same path → replaced) */
export async function reviewYaml(ws: Workspace, add: ReviewEntry[]): Promise<string> {
  let prev: ReviewEntry[] = [];
  try {
    const y = YAML.parse(await ws.readText("mapping/review.yaml")) as { review?: ReviewEntry[] } | null;
    prev = y?.review ?? [];
  } catch {
    /* first review */
  }
  const byPath = new Map(prev.map((r) => [r.path, r]));
  for (const r of add) byPath.set(r.path, r);
  const review = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return (
    "# Mapping review decisions (autofix mapping-review, docs/runbooks/autofix.md). Reviewed + committed like mapping/*.yaml.\n" +
    "# path = yaml path in the mapping file (or the Drupal source for coverage decisions); origin rule = deterministic validator, llm = DeepSeek.\n" +
    YAML.stringify({ version: 1, review })
  );
}
