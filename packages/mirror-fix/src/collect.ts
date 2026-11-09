/**
 * Task collection (docs/DEEPSEEK_ONLY_PLAN.md §4): the open work items of a workspace, from the same source TASKS.md is
 * built from (reports/*.json) plus the per-check files verify/<check>.json (a `verify --checks x` run rewrites
 * reports/verify.json with only that check; the other checks' last state stays in verify/*.json).
 */
import type { Issue, StepReport, Workspace } from "@harness/mirror-core";
import { readReports, taskId } from "@harness/mirror-core";
import type { AutofixTask, Handler } from "./types.js";

/** steps whose reports are never task sources (they aggregate others) */
const SKIP_STEPS = new Set(["report", "autofix"]);

export interface RawIssue extends Issue {
  step: string;
  /** "transform", "verify:visual", … */
  source: string;
}

/** gate results of a verify/<check>.json file */
interface CheckFile {
  check?: string;
  ok?: boolean;
  issues?: Issue[];
  gates?: Record<string, { pass: boolean; value?: number | string; threshold?: number | string }>;
}

async function readCheckFiles(ws: Workspace): Promise<CheckFile[]> {
  const out: CheckFile[] = [];
  for (const f of await ws.list("verify", ".json")) {
    if (f.split(/[/\\]/).length !== 2 || /summary\.json$/.test(f)) continue; // only verify/<check>.json
    try {
      const d = await ws.readJson<CheckFile>(f);
      if (d && typeof d === "object" && typeof d.check === "string") out.push(d);
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/** Every issue of the workspace, deduplicated by the TASKS.md task id. */
export async function readAllIssues(ws: Workspace): Promise<RawIssue[]> {
  const out: RawIssue[] = [];
  const seen = new Set<string>();
  const push = (i: Issue, step: string, source: string) => {
    const id = taskId({ ...i, step });
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...i, step, source });
  };
  const reports = (await readReports(ws)).filter((r) => !SKIP_STEPS.has(r.step));
  reports.sort((a, b) => a.step.localeCompare(b.step));
  for (const r of reports) for (const i of r.issues) push(i, r.step, r.step === "verify" ? "verify" : r.step);
  for (const c of await readCheckFiles(ws)) for (const i of c.issues ?? []) push(i, "verify", `verify:${c.check}`);
  return out;
}

export type GateMap = Record<string, boolean>;

/**
 * All gates of the workspace: reports/*.json (except verify, report, autofix) + verify/<check>.json as `<check>.<gate>`.
 * A check that crashed contributes `<check>.run = false`.
 */
export async function readGates(ws: Workspace): Promise<GateMap> {
  const gates: GateMap = {};
  const reports: StepReport[] = await readReports(ws);
  for (const r of reports) {
    if (SKIP_STEPS.has(r.step) || r.step === "verify") continue;
    for (const [k, g] of Object.entries(r.gates ?? {})) gates[k] = !!g.pass;
    gates[`step.${r.step}`] = r.ok;
  }
  const checks = await readCheckFiles(ws);
  for (const c of checks) for (const [k, g] of Object.entries(c.gates ?? {})) gates[`${c.check}.${k}`] = !!g.pass;
  // no verify/*.json yet (verify never ran): fall back to reports/verify.json gates
  if (!checks.length) for (const r of reports.filter((x) => x.step === "verify")) for (const [k, g] of Object.entries(r.gates ?? {})) gates[k] = !!g.pass;
  return gates;
}

/** "mobile /about: parity 0.91 < 0.97" → "mobile" when it is a known viewport name */
export function viewportOf(message: string, viewports: string[]): string | undefined {
  const m = /^([A-Za-z0-9_-]+)\s+\//.exec(message);
  return m && viewports.includes(m[1]) ? m[1] : undefined;
}

export interface CollectOptions {
  handlers: Handler[];
  /** viewport names of the site (to attach a viewport to visual tasks) */
  viewports?: string[];
  /** only these codes */
  codes?: string[];
}

export interface CollectedTask extends AutofixTask {
  handler: string;
  /** info / non-actionable issue a handler listed: no NEEDS_HUMAN when nothing is proposed */
  advisory: boolean;
}

/** Open tasks a registered handler (or the PIPELINE_BUG lane) takes, ordered by handler priority, then id. */
export async function collectTasks(ws: Workspace, opts: CollectOptions): Promise<CollectedTask[]> {
  const byCode = new Map<string, Handler>();
  for (const h of [...opts.handlers].sort((a, b) => a.priority - b.priority)) for (const c of h.codes) if (!byCode.has(c)) byCode.set(c, h);
  const codes = opts.codes?.length ? new Set(opts.codes) : undefined;
  const vps = opts.viewports ?? [];
  const out: CollectedTask[] = [];
  const ids = new Set<string>();
  for (const i of await readAllIssues(ws)) {
    if (codes && !codes.has(i.code)) continue;
    const h = byCode.get(i.code);
    if (!h) continue;
    const actionable = i.actionable ?? i.severity === "error";
    const viewport = viewportOf(i.message, vps);
    let id = `${i.code}:${i.ref ?? ""}${viewport ? `:${viewport}` : ""}`;
    if (ids.has(id)) id = `${id}#${taskId({ ...i, step: i.step })}`; // same code+ref, different message
    ids.add(id);
    out.push({
      id,
      code: i.code,
      ref: i.ref,
      message: i.message,
      severity: i.severity,
      source: i.source,
      data: { step: i.step, ...(viewport ? { viewport } : {}), ...(i.ref?.startsWith("/") ? { url: i.ref } : {}) },
      handler: h.id,
      advisory: !actionable,
    });
  }
  const prio = new Map(opts.handlers.map((h) => [h.id, h.priority]));
  out.sort((a, b) => (prio.get(a.handler) ?? 99) - (prio.get(b.handler) ?? 99) || Number(a.advisory) - Number(b.advisory) || a.id.localeCompare(b.id));
  return out;
}

export interface TaskGroup {
  key: string;
  handler: Handler;
  tasks: CollectedTask[];
  advisory: boolean;
}

/** Group tasks per handler with `handler.groupKey` (default: one task per group), keeping the collection order. */
export function groupTasks(tasks: CollectedTask[], handlers: Handler[]): TaskGroup[] {
  const hs = new Map(handlers.map((h) => [h.id, h]));
  const groups = new Map<string, TaskGroup>();
  for (const t of tasks) {
    const h = hs.get(t.handler);
    if (!h) continue;
    const key = `${h.id}:${h.groupKey ? h.groupKey(t) : t.id}`;
    const g = groups.get(key);
    if (g) {
      g.tasks.push(t);
      g.advisory = g.advisory && t.advisory;
    } else groups.set(key, { key, handler: h, tasks: [t], advisory: t.advisory });
  }
  return [...groups.values()];
}
