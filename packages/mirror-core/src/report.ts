/**
 * Step execution + report writing (MIGRATION_PLAN.md §4: every step writes reports/<step>.json + .md).
 */
import type { Issue, StepContext, StepFn, StepReport } from "./contracts.js";
import { redactSecrets } from "./env.js";
import { safeId, type Workspace } from "./workspace.js";

/** Build an empty report skeleton for a step; step functions can start from this. */
export function emptyReport(step: string, ctx: Pick<StepContext, "site" | "dryRun">): StepReport {
  const now = new Date().toISOString();
  return { step, site: ctx.site.site, startedAt: now, finishedAt: now, ok: true, dryRun: ctx.dryRun, stats: {}, issues: [], outputs: [] };
}

/** True when the report is ok and every gate passes. */
export function reportPassed(r: StepReport): boolean {
  return r.ok && Object.values(r.gates ?? {}).every((g) => g.pass);
}

export function failingGates(r: StepReport): string[] {
  return Object.entries(r.gates ?? {})
    .filter(([, g]) => !g.pass)
    .map(([k]) => k);
}

export function reportFileBase(step: string): string {
  return `reports/${safeId(step)}`;
}

const MAX_MD_ISSUES = 200;

function cell(v: unknown): string {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderReportMarkdown(r: StepReport): string {
  const status = r.ok ? (failingGates(r).length ? "ok, gates failing" : "ok") : "FAILED";
  const dur = typeof r.stats.durationMs === "number" ? `${(r.stats.durationMs / 1000).toFixed(1)} s` : "–";
  const lines: string[] = [
    `# Step \`${r.step}\` — ${r.site}`,
    "",
    `- **Status:** ${status}${r.dryRun ? " (dry-run)" : ""}`,
    `- **Started:** ${r.startedAt}`,
    `- **Finished:** ${r.finishedAt} (${dur})`,
    `- **Issues:** ${countBy(r.issues, "error")} errors, ${countBy(r.issues, "warning")} warnings, ${countBy(r.issues, "info")} info`,
    "",
  ];
  if (r.gates && Object.keys(r.gates).length) {
    lines.push("## Gates", "", "| Gate | Pass | Value | Threshold |", "|---|---|---|---|");
    for (const [k, g] of Object.entries(r.gates)) lines.push(`| ${cell(k)} | ${g.pass ? "yes" : "**NO**"} | ${cell(g.value ?? "")} | ${cell(g.threshold ?? "")} |`);
    lines.push("");
  }
  const stats = Object.entries(r.stats);
  if (stats.length) {
    lines.push("## Stats", "", "| Metric | Value |", "|---|---|");
    for (const [k, v] of stats) lines.push(`| ${cell(k)} | ${cell(v)} |`);
    lines.push("");
  }
  if (r.issues.length) {
    lines.push("## Issues", "");
    const sorted = [...r.issues].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    for (const i of sorted.slice(0, MAX_MD_ISSUES)) {
      lines.push(`- **${i.severity}** \`${i.code}\`${i.ref ? ` (${i.ref})` : ""}: ${i.message}${i.actionable ? " — _actionable_" : ""}`);
    }
    if (sorted.length > MAX_MD_ISSUES) lines.push(`- … ${sorted.length - MAX_MD_ISSUES} more in ${reportFileBase(r.step)}.json`);
    lines.push("");
  }
  if (r.outputs.length) {
    lines.push("## Outputs", "");
    for (const o of r.outputs.slice(0, 100)) lines.push(`- \`${o}\``);
    if (r.outputs.length > 100) lines.push(`- … ${r.outputs.length - 100} more`);
    lines.push("");
  }
  return lines.join("\n");
}

function sevRank(s: Issue["severity"]): number {
  return s === "error" ? 0 : s === "warning" ? 1 : 2;
}
function countBy(issues: Issue[], s: Issue["severity"]): number {
  return issues.filter((i) => i.severity === s).length;
}

/** Write reports/<step>.json + reports/<step>.md. Returns workspace-relative paths. */
export async function writeReport(ws: Workspace, report: StepReport): Promise<{ json: string; md: string }> {
  const base = reportFileBase(report.step);
  await ws.writeJson(`${base}.json`, report);
  await ws.writeText(`${base}.md`, renderReportMarkdown(report) + "\n");
  return { json: `${base}.json`, md: `${base}.md` };
}

/** Read all step reports (reports/*.json). Malformed files are skipped. */
export async function readReports(ws: Workspace): Promise<StepReport[]> {
  const out: StepReport[] = [];
  for (const f of await ws.list("reports", ".json")) {
    try {
      const r = await ws.readJson<StepReport>(f);
      if (r && typeof r === "object" && typeof r.step === "string" && Array.isArray(r.issues)) out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface RunStepOptions {
  /** write reports/<step>.json|md (default true) */
  write?: boolean;
}

function isReport(x: unknown): x is StepReport {
  return !!x && typeof x === "object" && typeof (x as StepReport).ok === "boolean" && Array.isArray((x as StepReport).issues);
}

/**
 * Run a step function with timing and error capture, normalise its report and write it to reports/.
 * Never throws for step failures: an exception becomes `ok: false` with a `STEP_FAILED` issue.
 */
export async function runStep(name: string, fn: StepFn, ctx: StepContext, opts: RunStepOptions = {}): Promise<StepReport> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  ctx.log.info(`start${ctx.dryRun ? " (dry-run)" : ""}`);
  let report: StepReport;
  try {
    const r = await fn(ctx);
    if (!isReport(r)) {
      report = { ...emptyReport(name, ctx), ok: false, issues: [{ severity: "error", code: "STEP_INVALID_REPORT", message: `step ${name} did not return a StepReport` }] };
    } else {
      report = { ...r, stats: { ...(r.stats ?? {}) }, issues: [...r.issues], outputs: [...(r.outputs ?? [])] };
    }
  } catch (e) {
    const err = e as Error;
    ctx.log.error(`failed: ${err?.message ?? String(e)}`);
    if (err?.stack) ctx.log.debug(err.stack);
    report = {
      ...emptyReport(name, ctx),
      ok: false,
      issues: [{ severity: "error", code: "STEP_FAILED", message: redactSecrets(err?.message ?? String(e)), actionable: true, ref: name }],
    };
  }
  const durationMs = Math.round(performance.now() - t0);
  report.step = name;
  report.site = ctx.site.site;
  report.startedAt = startedAt;
  report.finishedAt = new Date().toISOString();
  report.dryRun = ctx.dryRun;
  report.stats.durationMs = durationMs;

  if (opts.write !== false) {
    try {
      await writeReport(ctx.ws, report);
    } catch (e) {
      ctx.log.error(`could not write report: ${(e as Error).message}`);
    }
  }
  const gatesFailing = failingGates(report);
  const summary = `${report.ok ? "done" : "FAILED"} in ${(durationMs / 1000).toFixed(1)}s — ${report.issues.filter((i) => i.severity === "error").length} errors, ${report.issues.filter((i) => i.severity === "warning").length} warnings${gatesFailing.length ? `, failing gates: ${gatesFailing.join(", ")}` : ""}`;
  if (report.ok && !gatesFailing.length) ctx.log.info(summary);
  else ctx.log.warn(summary);
  return report;
}
