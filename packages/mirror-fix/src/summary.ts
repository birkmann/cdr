/**
 * P6: autofix figures for REPORT.md (attempts, accepted %, $ per accepted fix, per handler, NEEDS_HUMAN, PIPELINE_BUG)
 * and the S6 split of LLM usage by handler and cached vs live. Deterministic; the optional DeepSeek paragraph gets
 * codes and counts only (no content) and falls back to a template sentence.
 */
import type { LlmClient, StepReport, Workspace } from "@harness/mirror-core";
import { readAttempts } from "./loop.js";
import { AUTOFIX_CODES } from "./types.js";

export interface HandlerStats {
  attempts: number;
  accepted: number;
  rejected: number;
  llmCalls: number;
  llmCached: number;
  estCostUsd: number;
}

export interface LlmSplitRow {
  calls: number;
  live: number;
  cached: number;
  failed: number;
  tokens: number;
  estCostUsd: number;
}

export interface AutofixSummary {
  attempts: number;
  accepted: number;
  acceptedPct: number;
  estCostUsd: number;
  usdPerAcceptedFix: number;
  byHandler: Record<string, HandlerStats>;
  needsHuman: { message: string; ref?: string }[];
  pipelineBugs: { message: string; ref?: string }[];
  lastRun?: { finishedAt?: string; stats?: Record<string, unknown> };
  /** llm-log split: key = handler for autofix-<handler> steps, else the step */
  llmByHandler: Record<string, LlmSplitRow>;
  llmCachedCalls: number;
  llmLiveCalls: number;
}

interface LogRec {
  step?: string;
  ok?: boolean;
  cached?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  estCostUsd?: number;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function summarizeAutofix(ws: Workspace): Promise<AutofixSummary> {
  const attempts = await readAttempts(ws);
  const byHandler: Record<string, HandlerStats> = {};
  for (const a of attempts) {
    const h = (byHandler[a.handler] ??= { attempts: 0, accepted: 0, rejected: 0, llmCalls: 0, llmCached: 0, estCostUsd: 0 });
    h.attempts++;
    if (a.accepted) h.accepted++;
    else h.rejected++;
  }
  const llmByHandler: Record<string, LlmSplitRow> = {};
  let cachedCalls = 0;
  let liveCalls = 0;
  for (const f of await ws.list("llm-log", ".json")) {
    let r: LogRec;
    try {
      r = await ws.readJson<LogRec>(f);
    } catch {
      continue;
    }
    if (!r || typeof r.step !== "string") continue;
    const key = r.step.startsWith("autofix-") ? r.step.slice(8) : r.step;
    const row = (llmByHandler[key] ??= { calls: 0, live: 0, cached: 0, failed: 0, tokens: 0, estCostUsd: 0 });
    row.calls++;
    if (r.cached) {
      row.cached++;
      cachedCalls++;
    } else {
      row.live++;
      liveCalls++;
    }
    if (r.ok === false) row.failed++;
    row.tokens += (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
    row.estCostUsd = r6(row.estCostUsd + (r.cached ? 0 : (r.estCostUsd ?? 0)));
    if (r.step.startsWith("autofix-")) {
      const h = (byHandler[key] ??= { attempts: 0, accepted: 0, rejected: 0, llmCalls: 0, llmCached: 0, estCostUsd: 0 });
      h.llmCalls++;
      if (r.cached) h.llmCached++;
      h.estCostUsd = r6(h.estCostUsd + (r.cached ? 0 : (r.estCostUsd ?? 0)));
    }
  }
  let report: StepReport | undefined;
  try {
    report = await ws.readJson<StepReport>("reports/autofix.json");
  } catch {
    report = undefined;
  }
  let lastRun: AutofixSummary["lastRun"];
  try {
    lastRun = await ws.readJson("autofix/last-run.json");
  } catch {
    lastRun = undefined;
  }
  const accepted = attempts.filter((a) => a.accepted).length;
  const estCostUsd = r6(Object.values(byHandler).reduce((n, h) => n + h.estCostUsd, 0));
  return {
    attempts: attempts.length,
    accepted,
    acceptedPct: attempts.length ? Math.round((accepted / attempts.length) * 1000) / 10 : 0,
    estCostUsd,
    usdPerAcceptedFix: accepted ? r6(estCostUsd / accepted) : 0,
    byHandler,
    needsHuman: (report?.issues ?? []).filter((i) => i.code === AUTOFIX_CODES.NEEDS_HUMAN).map((i) => ({ message: i.message, ref: i.ref })),
    pipelineBugs: (report?.issues ?? []).filter((i) => i.code === AUTOFIX_CODES.PIPELINE_BUG).map((i) => ({ message: i.message, ref: i.ref })),
    lastRun,
    llmByHandler,
    llmCachedCalls: cachedCalls,
    llmLiveCalls: liveCalls,
  };
}

const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderAutofixSection(s: AutofixSummary): string[] {
  const L: string[] = ["## Autofix", ""];
  if (!s.attempts && !s.needsHuman.length && !s.pipelineBugs.length && !s.lastRun) {
    L.push("_`migrate autofix` has not run yet_", "");
    return L;
  }
  L.push(
    `**${s.attempts}** attempts · **${s.accepted}** accepted (${s.acceptedPct} %) · est. $${s.estCostUsd.toFixed(4)} LLM · ${s.accepted ? `$${s.usdPerAcceptedFix.toFixed(4)} per accepted fix` : "no accepted fix yet"} · ${s.needsHuman.length} need a human · ${s.pipelineBugs.length} pipeline bugs${s.lastRun?.stats?.stopReason ? ` · last run stopped: ${cell(s.lastRun.stats.stopReason)}` : ""}`,
    "",
    "| Handler | Attempts | Accepted | Rejected | LLM calls | cached | Est. cost (USD) |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [h, x] of Object.entries(s.byHandler).sort(([a], [b]) => a.localeCompare(b))) L.push(`| ${cell(h)} | ${x.attempts} | ${x.accepted} | ${x.rejected} | ${x.llmCalls} | ${x.llmCached} | ${x.estCostUsd.toFixed(4)} |`);
  L.push("", "Attempt log: `autofix/attempts/<seq>-<handler>.json` (patch, metrics before/after, reason). Roll back: docs/runbooks/autofix.md.", "");
  if (s.needsHuman.length) {
    L.push("### Needs a human (AUTOFIX_NEEDS_HUMAN)", "");
    for (const n of s.needsHuman) L.push(`- ${cell(n.message)}`);
    L.push("");
  }
  if (s.pipelineBugs.length) {
    L.push("### Pipeline bugs (PIPELINE_BUG, repro bundles)", "");
    for (const n of s.pipelineBugs) L.push(`- ${cell(n.message)}`);
    L.push("");
  }
  return L;
}

/** S6 table split by handler and cached vs live calls */
export function renderLlmSplit(s: AutofixSummary): string[] {
  const rows = Object.entries(s.llmByHandler).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return [];
  const L = ["", `Calls by step / autofix handler (cached = replayed from llm-cache/, $0): ${s.llmLiveCalls} live, ${s.llmCachedCalls} cached.`, "", "| Step / handler | Calls | Live | Cached | Failed | Tokens | Est. cost (USD) |", "|---|---|---|---|---|---|---|"];
  for (const [k, x] of rows) L.push(`| ${cell(k)} | ${x.calls} | ${x.live} | ${x.cached} | ${x.failed} | ${x.tokens} | ${x.estCostUsd.toFixed(4)} |`);
  return L;
}

export interface SummaryFacts {
  site: string;
  failingGates: string[];
  openByCode: Record<string, number>;
  openByOwner: Record<string, number>;
  autofix: { attempts: number; accepted: number; needsHuman: number; pipelineBugs: number };
}

export function deterministicSummary(f: SummaryFacts): string {
  const open = Object.values(f.openByCode).reduce((a, b) => a + b, 0);
  if (!open && !f.failingGates.length) return `All gates pass for ${f.site}; no open tasks.`;
  const owners = Object.entries(f.openByOwner)
    .sort(([, a], [, b]) => b - a)
    .map(([o, n]) => `${n} ${o}`)
    .join(", ");
  const top = Object.entries(f.openByCode)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([c, n]) => `${c} ×${n}`)
    .join(", ");
  return `${f.failingGates.length} failing gate(s)${f.failingGates.length ? ` (${f.failingGates.slice(0, 6).join(", ")})` : ""} and ${open} open task(s) remain — by owner: ${owners || "none"}; most frequent: ${top || "none"}. Autofix: ${f.autofix.attempts} attempts, ${f.autofix.accepted} accepted, ${f.autofix.needsHuman} handed to a human, ${f.autofix.pipelineBugs} pipeline bug bundle(s).`;
}

/** one paragraph "what is left and why" from codes and counts (no content); deterministic fallback on any failure */
export async function humanSummary(llm: LlmClient | undefined, f: SummaryFacts): Promise<{ text: string; source: "llm" | "rules" }> {
  const fallback = deterministicSummary(f);
  if (!llm) return { text: fallback, source: "rules" };
  try {
    const res = await llm.complete({
      step: "report-summary",
      json: true,
      temperature: 0,
      maxTokens: 800,
      effort: "low",
      schemaId: "report-summary@1",
      messages: [
        { role: "system", content: "You write the one-paragraph status summary of a website migration report for a project lead: what is left and why, which owner acts next. Use only the codes and counts given. 2-4 sentences, no lists. Answer as JSON {\"summary\": \"…\"}." },
        { role: "user", content: JSON.stringify(f) },
      ],
      validate: (x) => {
        const s = (x as { summary?: unknown })?.summary;
        if (typeof s !== "string" || s.length < 20 || s.length > 1200) throw new Error("summary must be a string of 20-1200 chars");
        return { summary: s };
      },
    });
    const s = ((res.parsed as { summary?: string } | undefined)?.summary ?? JSON.parse(res.content).summary) as string;
    return typeof s === "string" && s.length >= 20 ? { text: s.trim(), source: "llm" } : { text: fallback, source: "rules" };
  } catch {
    return { text: fallback, source: "rules" };
  }
}
