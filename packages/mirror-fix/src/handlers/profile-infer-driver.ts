/**
 * Small driver for profile-infer (W1-A): copy a site workspace's inputs into a temp workspace (raw/ symlinked, mapping/
 * copied), measure, apply a candidate, re-run transform + validate exactly like the CLI (reports/transform.json with the
 * ccm.valid gate), measure again. Never touches the source workspace. Not the loop (W1-C owns loop.ts).
 */
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger, validateCcm, Workspace, type SiteConfig, type StepReport } from "@harness/mirror-core";
import { htmlToCcmStep } from "@harness/mirror-capture";
import type { AutofixContext, AutofixTask, Candidate, Metrics } from "../types.js";
import { measureProfileCoverage, proposeProfiles } from "./profile-infer.js";

export interface ScratchWorkspace {
  ws: Workspace;
  cleanup(): Promise<void>;
}

/** temp workspace for `src`: raw/ as a symlink (read-only use), mapping/ copied, optional site profiles override */
export async function scratchCopy(src: Workspace, opts: { dropSiteProfiles?: boolean } = {}): Promise<ScratchWorkspace> {
  const base = await mkdtemp(join(tmpdir(), "cmp-profile-infer-"));
  const ws = new Workspace(src.site, base);
  await ws.init();
  await rm(ws.path("raw"), { recursive: true, force: true });
  await symlink(src.path("raw"), ws.path("raw"), "dir");
  if (existsSync(src.path("mapping"))) await cp(src.path("mapping"), ws.path("mapping"), { recursive: true });
  if (opts.dropSiteProfiles) await rm(ws.path("mapping/profiles.yaml"), { force: true });
  return { ws, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** transform + validate, report written like `pnpm migrate transform` */
export async function runTransform(ws: Workspace, site: SiteConfig, options: Record<string, unknown> = {}): Promise<StepReport> {
  const report = await htmlToCcmStep({ site, ws, dryRun: false, log: silentLogger, options });
  const v = await validateCcm(ws);
  const merged: StepReport = { ...report, issues: [...report.issues, ...v.issues], gates: { ...(report.gates ?? {}), "ccm.valid": { pass: v.ok, value: v.stats.errors, threshold: 0 } } };
  await ws.writeJson("reports/transform.json", merged);
  return merged;
}

export async function applyCandidate(ws: Workspace, c: Candidate): Promise<void> {
  for (const f of c.files) {
    if (/^(sites|packages)\//.test(f.path)) throw new Error(`driver only applies workspace files, got ${f.path}`);
    if (f.content === null) await rm(ws.path(f.path), { force: true });
    else await ws.writeText(f.path, f.content);
  }
}

export interface DriverResult {
  before: Metrics;
  after: Metrics;
  improved: boolean;
  candidate: Candidate;
  transform: StepReport;
}

/** measure → apply → transform → measure, in `ws` (a scratch workspace) */
export async function applyAndMeasure(ws: Workspace, site: SiteConfig, tasks: AutofixTask[], c: Candidate, options: Record<string, unknown> = {}): Promise<DriverResult> {
  if (!(await ws.exists("reports/transform.json"))) await runTransform(ws, site, options);
  const before = await measureProfileCoverage({ ws, site }, tasks);
  await applyCandidate(ws, c);
  const transform = await runTransform(ws, site, options);
  const after = await measureProfileCoverage({ ws, site }, tasks);
  const regressed = Object.entries(before.gates).some(([k, v]) => v && after.gates[k] === false);
  return { before, after, improved: after.primary > before.primary && !regressed, candidate: c, transform };
}

/** one-shot: scratch copy → transform → collect SECTION_TEXT_UNMAPPED tasks → propose → apply the first candidate → measure */
export async function driveProfileInfer(
  src: Workspace,
  site: SiteConfig,
  ctx: Partial<Pick<AutofixContext, "llm" | "log">> = {},
  opts: { dropSiteProfiles?: boolean; keep?: boolean } = {},
): Promise<{ tasks: AutofixTask[]; candidates: Candidate[]; result?: DriverResult; ws: Workspace; cleanup(): Promise<void> }> {
  const scratch = await scratchCopy(src, opts);
  const t = await runTransform(scratch.ws, site);
  const tasks: AutofixTask[] = t.issues
    .filter((i) => i.code === "SECTION_TEXT_UNMAPPED")
    .map((i) => ({ id: `${i.code}:${i.ref ?? ""}`, code: i.code, ref: i.ref, message: i.message, severity: i.severity, source: "transform" }));
  const actx: AutofixContext = { site, ws: scratch.ws, repoRoot: process.cwd(), llm: ctx.llm, log: ctx.log ?? silentLogger, oldBaseUrl: site.baseUrl, dryRun: false };
  const candidates = await proposeProfiles(actx, tasks.length ? tasks : [{ id: "all", code: "SECTION_TEXT_UNMAPPED", message: "", severity: "warning", source: "driver" }]);
  const result = candidates[0] ? await applyAndMeasure(scratch.ws, site, tasks, candidates[0]) : undefined;
  return { tasks, candidates, result, ws: scratch.ws, cleanup: opts.keep ? async () => {} : scratch.cleanup };
}
