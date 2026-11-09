/**
 * `migrate report`: aggregate reports/*.json + verify/ + effort.jsonl + llm-log/ into workspace/<site>/REPORT.md
 * and regenerate TASKS.md. Deterministic (no LLM).
 */
import {
  emptyReport,
  failingGates,
  readEffort,
  readReports,
  summarizeEffort,
  summarizeLlmLog,
  writeTasks,
  type Issue,
  type LlmClient,
  type StepContext,
  type StepReport,
  type TaskIssue,
  type Workspace,
} from "@harness/mirror-core";

export const REPORT_PATH = "REPORT.md";
const STEP_ORDER = ["init", "extract", "analyze", "map", "transform", "validate", "load", "design-extract", "frontend-generate", "verify"];

export interface ParityRow {
  file: string;
  url: string;
  viewport?: string;
  score: number;
  pass?: boolean;
}

const SCORE_KEYS = ["score", "parity", "similarity", "ratio", "match"];
const URL_KEYS = ["url", "path", "page"];

/** Find per-page scores in arbitrary verify/*.json shapes: arrays of objects with a url-ish + numeric score-ish field. */
export function extractParityRows(file: string, data: unknown): ParityRow[] {
  const rows: ParityRow[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 5 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === "object" && !Array.isArray(x)) {
          const o = x as Record<string, unknown>;
          const urlKey = URL_KEYS.find((k) => typeof o[k] === "string");
          const scoreKey = SCORE_KEYS.find((k) => typeof o[k] === "number");
          if (urlKey && scoreKey) {
            rows.push({ file, url: o[urlKey] as string, viewport: typeof o.viewport === "string" ? o.viewport : undefined, score: o[scoreKey] as number, pass: typeof o.pass === "boolean" ? o.pass : undefined });
            continue;
          }
        }
        visit(x, depth + 1);
      }
      return;
    }
    for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(data, 0);
  return rows;
}

function cell(v: unknown): string {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function fmtGateValue(g: { value?: number | string; threshold?: number | string }): string {
  return `${g.value ?? ""}${g.threshold !== undefined ? ` / ${g.threshold}` : ""}`;
}

const CRITERIA: { id: string; name: string; gatePrefixes: string[] }[] = [
  { id: "S1", name: "Content completeness", gatePrefixes: ["ccm.valid", "content", "completeness", "media", "load"] },
  { id: "S2", name: "Visual parity", gatePrefixes: ["visual", "parity", "screenshot", "playback"] },
  { id: "S3", name: "URL/SEO parity", gatePrefixes: ["links", "redirects", "seo"] },
];

/**
 * Evidence that content completeness was checked against nothing: transform wrote 0 CCM entries, or the verify content
 * check saw 0 entries / 0 pages. Empty = no such evidence (stats missing count as unknown, not as zero).
 */
export async function nothingCompared(ws: Workspace, reports: StepReport[]): Promise<string[]> {
  const out: string[] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const t = reports.find((r) => r.step === "transform");
  const entries = num(t?.stats["ccm.entries"]) ?? num(t?.stats.entries);
  if (entries === 0) out.push("transform: 0 CCM entries");
  if (await ws.exists("verify/content.json")) {
    try {
      const c = await ws.readJson<{ stats?: Record<string, unknown>; details?: { pages?: unknown[] } }>("verify/content.json");
      const ve = num(c.stats?.entries);
      if (ve === 0 && entries !== 0) out.push("verify content: 0 entries checked");
      if (Array.isArray(c.details?.pages) && c.details!.pages.length === 0 && ve !== 0) out.push("verify content: 0 pages checked");
    } catch {
      /* unreadable → no evidence */
    }
  }
  return out;
}

export async function buildReport(ws: Workspace, site: string, opts: { llm?: LlmClient } = {}): Promise<{ markdown: string; issues: TaskIssue[]; stats: Record<string, number | string | boolean> }> {
  const reports = (await readReports(ws)).filter((r) => r.step !== "report");
  reports.sort((a, b) => (STEP_ORDER.indexOf(a.step) + 1 || 99) - (STEP_ORDER.indexOf(b.step) + 1 || 99) || a.step.localeCompare(b.step));
  const effort = await readEffort(ws);
  const eff = summarizeEffort(effort);
  const llm = await summarizeLlmLog(ws);

  const parity: ParityRow[] = [];
  for (const f of await ws.list("verify", ".json")) {
    try {
      parity.push(...extractParityRows(f, await ws.readJson(f)));
    } catch {
      /* ignore unreadable */
    }
  }

  const issues: TaskIssue[] = reports.flatMap((r) => r.issues.map((i) => ({ ...i, step: r.step })));
  const allGates = reports.flatMap((r) => Object.entries(r.gates ?? {}).map(([k, g]) => ({ step: r.step, gate: k, ...g })));
  const failing = allGates.filter((g) => !g.pass);
  const totalMs = reports.reduce((n, r) => n + (typeof r.stats.durationMs === "number" ? r.stats.durationMs : 0), 0);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const allOk = reports.length > 0 && reports.every((r) => r.ok) && failing.length === 0;

  const L: string[] = [];
  L.push(`# Migration report — ${site}`, "");
  L.push(`_Generated ${new Date().toISOString()} by \`pnpm migrate report ${site}\`. Source data: \`reports/\`, \`verify/\`, \`effort.jsonl\`, \`llm-log/\`._`, "");
  const overallAt = L.length;
  L.push(`**Overall:** ${allOk ? "all steps ok, all gates passing" : reports.length ? `${reports.filter((r) => !r.ok).length} failed steps, ${failing.length} failing gates` : "no step reports yet"} · ${errors} errors · ${warnings} warnings · open tasks in [TASKS.md](TASKS.md)`, "");

  L.push("## POC success criteria", "", "| # | Criterion | Status | Evidence |", "|---|---|---|---|");
  const vacuousS1 = await nothingCompared(ws, reports);
  for (const c of CRITERIA) {
    const gs = allGates.filter((g) => c.gatePrefixes.some((p) => g.gate === p || g.gate.startsWith(`${p}.`) || g.gate.startsWith(p)));
    let status = gs.length ? (gs.every((g) => g.pass) ? "pass" : "**FAIL**") : "n/a (no gate reported)";
    let evidence = gs.map((g) => `${g.gate}=${g.pass ? "pass" : "fail"}`).join(", ");
    // a completeness "pass" over nothing (0 CCM entries / 0 checked pages) is a false green
    if (c.id === "S1" && vacuousS1.length) {
      status = "**FAIL** (nothing compared)";
      evidence = [...vacuousS1, evidence].filter(Boolean).join("; ");
    }
    L.push(`| ${c.id} | ${c.name} | ${status} | ${cell(evidence)} |`);
  }
  L.push(`| S4 | Re-runnability | ${totalMs ? `${(totalMs / 60000).toFixed(1)} min total step time` : "n/a"} | sum of last run per step (target < 60 min) |`);
  L.push(`| S5 | Human effort | ${eff.totalMinutes} min logged | ${eff.count} entries in effort.jsonl |`);
  L.push(`| S6 | LLM cost | ${llm.calls} calls, ${llm.promptTokens + llm.completionTokens} tokens, est. $${llm.estCostUsd.toFixed(4)} | llm-log/ |`, "");

  L.push("## Steps", "", "| Step | Status | Dry-run | Finished | Duration | Errors | Warnings | Report |", "|---|---|---|---|---|---|---|---|");
  for (const r of reports) {
    const fg = failingGates(r);
    const status = !r.ok ? "**FAILED**" : fg.length ? "ok, gates failing" : "ok";
    const dur = typeof r.stats.durationMs === "number" ? `${(r.stats.durationMs / 1000).toFixed(1)} s` : "";
    L.push(`| ${cell(r.step)} | ${status} | ${r.dryRun ? "yes" : ""} | ${cell(r.finishedAt)} | ${dur} | ${r.issues.filter((i) => i.severity === "error").length} | ${r.issues.filter((i) => i.severity === "warning").length} | [md](reports/${r.step}.md) |`);
  }
  if (!reports.length) L.push("| – | no reports | | | | | | |");
  L.push("");

  L.push("## Gates", "");
  if (allGates.length) {
    L.push("| Step | Gate | Pass | Value / threshold |", "|---|---|---|---|");
    for (const g of allGates) L.push(`| ${cell(g.step)} | ${cell(g.gate)} | ${g.pass ? "yes" : "**NO**"} | ${cell(fmtGateValue(g))} |`);
  } else L.push("_no gates reported yet_");
  L.push("");

  L.push("## Parity scores", "");
  if (parity.length) {
    L.push("| URL | Viewport | Score | Pass | Source |", "|---|---|---|---|---|");
    for (const p of parity) L.push(`| ${cell(p.url)} | ${cell(p.viewport ?? "")} | ${p.score.toFixed(4)} | ${p.pass === undefined ? "" : p.pass ? "yes" : "**NO**"} | ${cell(p.file)} |`);
  } else L.push("_no per-page scores found in verify/_");
  L.push("");

  L.push("## Human effort (S5)", "");
  if (eff.count) {
    L.push("| Step | Minutes |", "|---|---|");
    for (const [s, m] of Object.entries(eff.byStep)) L.push(`| ${cell(s)} | ${m} |`);
    L.push(`| **total** | **${eff.totalMinutes}** |`);
  } else L.push("_nothing logged — use `pnpm migrate effort <site> <step> <minutes> [note]`_");
  L.push("");

  L.push("## LLM usage (S6)", "");
  if (llm.calls) {
    L.push("| Step | Calls | Failed | Fallbacks | Prompt tokens | Completion tokens | Est. cost (USD) | Providers | Models |", "|---|---|---|---|---|---|---|---|---|");
    for (const [s, x] of Object.entries(llm.byStep)) L.push(`| ${cell(s)} | ${x.calls} | ${x.failed} | ${x.fallbacks} | ${x.promptTokens} | ${x.completionTokens} | ${x.estCostUsd.toFixed(4)} | ${cell(x.providers.join(", "))} | ${cell(x.models.join(", "))} |`);
    L.push(`| **total** | **${llm.calls}** | ${llm.failed} | ${llm.fallbacks} | ${llm.promptTokens} | ${llm.completionTokens} | **${llm.estCostUsd.toFixed(4)}** | | |`, "");
    L.push("| Provider | Calls | Failed | Served as fallback | Tokens | Est. cost (USD) |", "|---|---|---|---|---|---|");
    for (const [p, x] of Object.entries(llm.byProvider)) L.push(`| ${cell(p)} | ${x.calls} | ${x.failed} | ${x.fallbacks} | ${x.promptTokens + x.completionTokens} | ${x.estCostUsd.toFixed(4)} |`);
  } else L.push("_no LLM calls logged_");
  const af = await loadAutofix();
  const afSummary = af ? await af.summarizeAutofix(ws).catch(() => undefined) : undefined;
  if (llm.calls && af && afSummary) L.push(...af.renderLlmSplit(afSummary));
  L.push("");

  if (af && afSummary) L.push(...af.renderAutofixSection(afSummary));

  L.push("## Open issues", "");
  const open = issues.filter((i) => i.severity === "error" || i.actionable);
  const owner = (code: string) => (af ? af.ownerOf(code) : undefined);
  if (open.length) {
    for (const i of open.slice(0, 100)) L.push(`- [${i.step}] **${i.severity}** \`${i.code}\`${i.ref ? ` (${cell(i.ref)})` : ""}: ${cell(i.message)}${owner(i.code) ? ` · _${owner(i.code)}_` : ""}`);
    if (open.length > 100) L.push(`- … ${open.length - 100} more (see TASKS.md / reports/)`);
  } else L.push("_none_");
  L.push("");

  const stats: Record<string, number | string | boolean> = {
    steps: reports.length,
    failedSteps: reports.filter((r) => !r.ok).length,
    gates: allGates.length,
    failingGates: failing.length,
    errors,
    warnings,
    parityRows: parity.length,
    effortMinutes: eff.totalMinutes,
    llmCalls: llm.calls,
    llmTokens: llm.promptTokens + llm.completionTokens,
    llmEstCostUsd: llm.estCostUsd,
    llmFallbacks: llm.fallbacks,
  };
  if (afSummary) {
    stats.autofixAttempts = afSummary.attempts;
    stats.autofixAccepted = afSummary.accepted;
    stats.autofixNeedsHuman = afSummary.needsHuman.length;
    stats.autofixPipelineBugs = afSummary.pipelineBugs.length;
  }

  // "what is left and why" (P6): DeepSeek from codes + counts only when opts.llm is given, else deterministic
  if (af) {
    const actionable = issues.filter((i) => i.actionable ?? i.severity === "error");
    const openByCode: Record<string, number> = {};
    const openByOwner: Record<string, number> = {};
    for (const i of actionable) {
      openByCode[i.code] = (openByCode[i.code] ?? 0) + 1;
      const o = af.ownerOf(i.code);
      openByOwner[o] = (openByOwner[o] ?? 0) + 1;
    }
    const facts = {
      site,
      failingGates: failing.map((g) => g.gate),
      openByCode,
      openByOwner,
      autofix: { attempts: afSummary?.attempts ?? 0, accepted: afSummary?.accepted ?? 0, needsHuman: afSummary?.needsHuman.length ?? 0, pipelineBugs: afSummary?.pipelineBugs.length ?? 0 },
    };
    const s = await af.humanSummary(opts.llm, facts);
    L.splice(overallAt + 1, 0, "", `**Summary${s.source === "llm" ? " (DeepSeek, from codes and counts)" : ""}:** ${s.text}`);
    stats.summarySource = s.source;
  }
  return { markdown: L.join("\n"), issues, stats };
}

type AutofixModule = typeof import("@harness/mirror-fix");
let autofixMod: Promise<AutofixModule | undefined> | undefined;
/** @cmp/autofix is optional for the report (handler names, Autofix section); load lazily, never fail the report */
function loadAutofix(): Promise<AutofixModule | undefined> {
  autofixMod ??= import("@harness/mirror-fix").catch(() => undefined);
  return autofixMod;
}

export async function reportStep(ctx: StepContext): Promise<StepReport> {
  const { markdown, issues, stats } = await buildReport(ctx.ws, ctx.site.site, { llm: ctx.options.llmSummary ? ctx.llm : undefined });
  const r = emptyReport("report", ctx);
  if (ctx.dryRun) {
    ctx.log.info("dry-run: REPORT.md / TASKS.md not written");
    return { ...r, stats };
  }
  await ctx.ws.writeText(REPORT_PATH, markdown + "\n");
  const af = await loadAutofix();
  const t = await writeTasks(ctx.ws, issues as (Issue & { step?: string })[], af ? { owner: (i) => af.ownerOf(i.code) } : {});
  return { ...r, stats: { ...stats, tasksOpen: t.open, tasksReopened: t.reopened, tasksDone: t.done }, outputs: [REPORT_PATH, t.path] };
}
