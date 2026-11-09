/**
 * `migrate autofix` loop (docs/DEEPSEEK_ONLY_PLAN.md §4, principle 2 "gate-verified hill climbing").
 *
 *   collect open tasks → group (handler.groupKey) → order by handler priority
 *   per group: measure before → propose(previous attempts) → per candidate:
 *     back up touched files → write patch → re-run steps (StepRunner) → measure after
 *     accept iff after.primary > before.primary and no gate pass→fail; else restore backups, re-run the producing
 *     steps (+ build) and restore the reports/ + verify/ snapshot
 *   stop: nothing left | maxIterations | patience (consecutive non-accepted attempts) | LLM budget
 *
 * Downstream propagation (W2-I): an accepted candidate whose re-run stopped early in the chain (e.g. a content fix
 * that only re-ran `transform`, or a design-variant fix without build/verify) leaves the downstream steps stale. They
 * are re-run (full `design-extract` from the cached crawl, `frontend-generate`, `build`, full `verify`; only the steps
 * this workspace already has reports for / the loop can run) before the next group whose tasks come from a downstream
 * step is measured, and once at the end, so every gate is re-measured. Then tasks are collected again.
 * Revisits (W2-I): a group that was finished (accepted, NEEDS_HUMAN, advisory) is taken up again when it gets task
 * ids it did not have when it was finished (a later handler created work for an earlier one).
 *
 * Every attempt → autofix/attempts/<seq>-<handler>.json (AttemptRecord). No candidate fixed a task → AUTOFIX_NEEDS_HUMAN
 * + autofix/dossiers/<key>.json. Pipeline crashes → PIPELINE_BUG + autofix/bugs/<n>/. Dry-run: propose only, no writes.
 */
import { createHash } from "node:crypto";
import { emptyReport, readReports, safeId, type Issue, type LlmClient, type Logger, type SiteConfig, type StepReport, type Workspace } from "@harness/mirror-core";
import { resolve } from "node:path";
import { applyPatches, PatchRefused, persistBackups, restoreApp, restoreBackups, restoreState, snapshotApp, snapshotState } from "./apply.js";
import { PIPELINE_BUG_CODES, writeBugBundle, type BugInput } from "./bugs.js";
import { collectTasks, groupTasks, readAllIssues, readGates, type TaskGroup } from "./collect.js";
import { RerunEnvironmentError, type StepRunner } from "./rerun.js";
import { AUTOFIX_CODES, type AttemptRecord, type AutofixContext, type Candidate, type Handler, type Metrics, type RerunStep } from "./types.js";
import { emptyUsage, isBudgetError, MeteredLlm, type Usage } from "./usage.js";

export interface AutofixOptions {
  site: SiteConfig;
  ws: Workspace;
  repoRoot: string;
  log: Logger;
  handlers: Handler[];
  runner: StepRunner;
  llm?: LlmClient;
  dryRun?: boolean;
  newBaseUrl?: string;
  oldBaseUrl?: string;
  appPort?: number;
  maxIterations?: number;
  candidatesPerTask?: number;
  patience?: number;
  budgetUsd?: number;
  /** only tasks with these codes */
  codes?: string[];
  /** skip the PIPELINE_BUG lane for pre-existing crash issues */
  skipBugLane?: boolean;
}

export interface ProposalSummary {
  group: string;
  handler: string;
  taskIds: string[];
  candidates: { title: string; origin: Candidate["origin"]; files: string[]; rerun: RerunStep[] }[];
}

export interface AutofixResult {
  report: StepReport;
  attempts: AttemptRecord[];
  proposals: ProposalSummary[];
  stopReason: string;
}

const ATTEMPT_FILE = /^autofix\/attempts\/(\d+)-([A-Za-z0-9_.-]+)\.json$/;

export async function readAttempts(ws: Workspace): Promise<AttemptRecord[]> {
  const out: AttemptRecord[] = [];
  for (const f of await ws.list("autofix/attempts", ".json")) {
    if (!ATTEMPT_FILE.test(f.split("\\").join("/"))) continue;
    try {
      out.push(await ws.readJson<AttemptRecord>(f));
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export function patchSha(c: Candidate): string {
  const h = createHash("sha256");
  for (const f of [...c.files].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${f.path}\0${f.content === null ? "\u0000null" : f.content}\0`);
  return h.digest("hex").slice(0, 16);
}

/** gate keys that passed before and fail after (gates missing after are ignored) */
export function regressions(before: Metrics, after: Metrics): string[] {
  return Object.keys(before.gates)
    .filter((k) => before.gates[k] === true && after.gates[k] === false)
    .sort();
}

export function decide(before: Metrics, after: Metrics): { accepted: boolean; reason: string } {
  const reg = regressions(before, after);
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
  if (reg.length) return { accepted: false, reason: `gate ${reg.join(", ")} regressed (primary ${fmt(before.primary)} -> ${fmt(after.primary)})` };
  if (!(after.primary > before.primary)) return { accepted: false, reason: `no improvement (primary ${fmt(before.primary)} -> ${fmt(after.primary)})` };
  return { accepted: true, reason: `improved ${fmt(before.primary)} -> ${fmt(after.primary)}` };
}

/** a step report that means "the code crashed", not "the data is not good enough yet" */
function crashOf(step: RerunStep, r: StepReport): { code: string; message: string; check?: string } | undefined {
  const i = r.issues.find((x) => x.code === "STEP_FAILED" || x.code === "BUILD_FAILED" || x.code === "CHECK_CRASHED" || x.code === "STEP_INVALID_REPORT");
  if (!i) return undefined;
  const check = i.code === "CHECK_CRASHED" ? i.message.split(":")[0] : undefined;
  return { code: i.code, message: `${step}: ${i.message}`, check };
}

/** pipeline order of the re-runnable steps the loop propagates through */
export const DOWNSTREAM_ORDER: RerunStep[] = ["transform", "design-extract", "frontend-generate", "build", "verify"];

/**
 * Steps that are stale after an accepted re-run of `steps`: every available step after the earliest chain step in
 * `steps` that the re-run did not execute after it. A scoped verify (checks/urls/viewports) leaves a full verify stale;
 * a `partial` step (design-extract fast path: overrides re-applied, no re-mining, so its report lacks the mined issues)
 * leaves itself stale.
 */
export function staleAfter(steps: RerunStep[], available: Set<RerunStep>, scopedVerify: boolean, partial: RerunStep[] = []): RerunStep[] {
  const idx = steps.map((s) => DOWNSTREAM_ORDER.indexOf(s)).filter((i) => i >= 0);
  if (!idx.length) return [];
  const first = Math.min(...idx);
  return DOWNSTREAM_ORDER.slice(first).filter(
    (s, i) => available.has(s) && (partial.includes(s) || (i > 0 && (!steps.includes(s) || (s === "verify" && scopedVerify)))),
  );
}

/** design-extract re-run on the overrides fast path */
const isFastDesign = (c: Candidate) => {
  const o = c.stepOptions?.["design-extract"];
  return !!o && (o.applyOverridesOnly === true || o.fromCache === "overrides");
};

const usageRec = (u: Usage): AttemptRecord["llm"] => ({ calls: u.calls, promptTokens: u.promptTokens, completionTokens: u.completionTokens, estCostUsd: u.estCostUsd, cached: u.cached });

export async function runAutofix(o: AutofixOptions): Promise<AutofixResult> {
  const { ws, site, log } = o;
  const dry = !!o.dryRun;
  const cfg = site.autofix;
  const maxIterations = o.maxIterations ?? cfg?.maxIterations ?? 40;
  const perTask = o.candidatesPerTask ?? cfg?.candidatesPerTask ?? 3;
  const patience = o.patience ?? cfg?.patience ?? 5;
  const budgetUsd = o.budgetUsd ?? site.llm?.budgetUsd;
  const metered = o.llm ? new MeteredLlm(o.llm, budgetUsd) : undefined;
  const report = emptyReport("autofix", { site, dryRun: dry });
  const issues: Issue[] = [];
  const attempts: AttemptRecord[] = [];
  const proposals: ProposalSummary[] = [];
  const previousAll = await readAttempts(ws);
  let seq = previousAll.reduce((m, a) => Math.max(m, a.seq), 0);
  const viewports = site.crawl.viewports.map((v) => v.name);
  const bugs = new Set<number>();
  const needsHuman: string[] = [];

  const ctxFor = (): AutofixContext => ({
    site,
    ws,
    repoRoot: o.repoRoot,
    llm: metered,
    log,
    newBaseUrl: o.newBaseUrl,
    oldBaseUrl: o.oldBaseUrl ?? site.baseUrl,
    dryRun: dry,
    budgetLeftUsd: metered?.remainingUsd(),
    appPort: o.appPort,
  });

  const fileBug = async (b: BugInput): Promise<void> => {
    if (dry) {
      issues.push({ severity: "error", code: AUTOFIX_CODES.PIPELINE_BUG, message: `${b.code} in ${b.step}: ${b.message.split("\n")[0]} (dry-run: no bundle written)`, ref: b.ref ?? b.step, actionable: true });
      return;
    }
    const bundle = await writeBugBundle(ws, site, o.repoRoot, b);
    if (bugs.has(bundle.n)) return;
    bugs.add(bundle.n);
    issues.push({ severity: "error", code: AUTOFIX_CODES.PIPELINE_BUG, message: `${b.code} in ${b.step}${b.check ? `/${b.check}` : ""}: ${b.message.split("\n")[0].slice(0, 300)} — repro bundle ${bundle.dir}/README.md`, ref: bundle.dir, actionable: true });
  };

  // ---------------------------------------------------------------- P7: crashes already in the reports
  if (!o.skipBugLane) {
    const codes = o.codes?.length ? new Set(o.codes) : undefined;
    for (const i of await readAllIssues(ws)) {
      if (!(PIPELINE_BUG_CODES as readonly string[]).includes(i.code)) continue;
      if (codes && !codes.has(i.code) && !codes.has(AUTOFIX_CODES.PIPELINE_BUG)) continue;
      let stack: string | undefined;
      const check = i.code === "CHECK_CRASHED" ? i.message.split(":")[0] : i.source.startsWith("verify:") ? i.source.slice(7) : undefined;
      if (check) {
        try {
          const d = await ws.readJson<{ details?: { error?: string } }>(`verify/${check}.json`);
          stack = typeof d.details?.error === "string" ? d.details.error : undefined;
        } catch {
          /* no details */
        }
      }
      await fileBug({ code: i.code, step: i.code === "BUILD_FAILED" ? "build" : i.step, check, ref: i.ref, message: i.message, stack });
    }
  }

  // ---------------------------------------------------------------- the loop
  const state = new Map<string, { failed: number; accepted: number; done: boolean; tried: Set<string>; seen: Set<string> }>();
  // ---------------------------------------------------------------- downstream propagation
  const reportsNow = new Map((await readReports(ws)).map((r) => [r.step, r] as const));
  const available = new Set<RerunStep>(["transform"]);
  if (reportsNow.has("design-extract")) available.add("design-extract");
  if (reportsNow.has("frontend-generate")) {
    available.add("frontend-generate");
    if (o.appPort) available.add("build");
  }
  if (reportsNow.has("verify") && o.newBaseUrl) available.add("verify");
  /** downstream steps to re-run; `urgent` = more than a full verify (design/app are stale) */
  const pending = new Set<RerunStep>();
  {
    // a workspace whose transform is newer than a downstream report starts stale
    const t = reportsNow.get("transform")?.finishedAt;
    if (t)
      for (const s of ["design-extract", "frontend-generate", "verify"] as RerunStep[]) {
        const r = reportsNow.get(s);
        if (available.has(s) && r && (s === "verify" ? r.startedAt : r.finishedAt) < t) for (const x of staleAfter(["transform"], available, false)) if (DOWNSTREAM_ORDER.indexOf(x) >= DOWNSTREAM_ORDER.indexOf(s)) pending.add(x);
      }
  }
  const urgent = () => [...pending].some((s) => s !== "verify");
  /** a task is stale when it comes from a pending step or one after it (verify tasks while build is pending, …) */
  const staleTask = (step: string): boolean => {
    const i = DOWNSTREAM_ORDER.indexOf(step as RerunStep);
    if (i < 0) return false;
    const first = Math.min(...[...pending].map((s) => DOWNSTREAM_ORDER.indexOf(s)));
    return i >= first;
  };
  /** re-run the pending steps up to `upTo` (chain order); steps after the last one re-run become pending */
  const propagate = async (upTo: RerunStep = "verify"): Promise<void> => {
    const limit = DOWNSTREAM_ORDER.indexOf(upTo);
    const steps = DOWNSTREAM_ORDER.filter((s, i) => pending.has(s) && i <= limit);
    for (const s of steps) pending.delete(s);
    if (!steps.length || dry) return;
    for (const s of staleAfter(steps, available, false)) pending.add(s);
    log.info(`downstream re-run after accepted fixes: ${steps.join(" → ")}`);
    try {
      const rr = await rerunAll(steps, { title: "downstream re-run", rationale: "", origin: "rule", files: [], rerun: steps }, "apply");
      if (!rr.ok) {
        await fileBug(rr.crash!);
        fatal = true;
        issues.push({ severity: "error", code: "AUTOFIX_DOWNSTREAM_FAILED", message: `downstream re-run (${steps.join(" → ")}) failed: ${rr.crash!.message.split("\n")[0].slice(0, 300)}`, actionable: true });
        return;
      }
      issues.push({ severity: "info", code: "AUTOFIX_DOWNSTREAM_RERUN", message: `re-ran ${steps.join(" → ")} after accepted fixes; gates re-measured` });
    } catch (e) {
      if (!(e instanceof RerunEnvironmentError)) throw e;
      issues.push({ severity: "error", code: e.code, message: e.message, actionable: true });
      fatal = true;
    }
  };

  let iterations = 0;
  let sinceAccept = 0;
  let stopReason = "no open tasks";
  let fatal = false;

  const rerunAll = async (steps: RerunStep[], c: Candidate, phase: "apply" | "rollback"): Promise<{ ok: boolean; crash?: BugInput }> => {
    for (const step of steps) {
      let r: StepReport;
      try {
        r = await o.runner.run(step, { verify: c.verify, options: c.stepOptions?.[step] });
      } catch (e) {
        if (e instanceof RerunEnvironmentError) throw e;
        const err = e as Error;
        return { ok: false, crash: { code: "RERUN_CRASHED", step, message: `${phase}: ${err.message}`, stack: err.stack } };
      }
      const crash = crashOf(step, r);
      if (crash) return { ok: false, crash: { code: crash.code, step: crash.check ? "verify" : step, check: crash.check, message: `${phase}: ${crash.message}`, buildLog: step === "build" ? String(r.stats.buildLog ?? "") || undefined : undefined } };
    }
    return { ok: true };
  };

  const measure = async (h: Handler, g: TaskGroup): Promise<Metrics> => {
    const m = await h.measure(ctxFor(), g.tasks);
    return { ...m, gates: { ...(await readGates(ws)), ...(m.gates ?? {}) } };
  };

  const tryCandidate = async (g: TaskGroup, c: Candidate, before: Metrics, propUsage: Usage): Promise<AttemptRecord> => {
    const h = g.handler;
    seq++;
    const startedAt = new Date().toISOString();
    const sha = patchSha(c);
    const files = c.files.map((f) => ({ path: f.path, bytes: f.content === null ? null : Buffer.byteLength(f.content) }));
    const { files: _f, ...meta } = c;
    const rec: AttemptRecord = {
      seq,
      handler: h.id,
      taskIds: g.tasks.map((t) => t.id),
      candidate: { ...meta, files },
      before,
      accepted: false,
      reason: "",
      llm: usageRec(propUsage),
      patchSha: sha,
      startedAt,
      finishedAt: startedAt,
    };
    const steps: RerunStep[] = [...c.rerun];
    if (c.verify && !steps.includes("verify")) steps.push("verify");
    const snap = await snapshotState(ws);
    const appSnap = steps.some((s) => s === "frontend-generate" || s === "build") ? await snapshotApp(resolve(o.repoRoot, site.frontend.appDir ?? `apps/${site.site}-web`)) : undefined;
    let backups;
    try {
      backups = await applyPatches(c.files, ws, o.repoRoot);
    } catch (e) {
      rec.reason = e instanceof PatchRefused ? `patch refused: ${e.message}` : `patch failed: ${(e as Error).message}`;
      if (e instanceof PatchRefused) issues.push({ severity: "warning", code: AUTOFIX_CODES.PATCH_REFUSED, message: `${h.id}: ${c.title}: ${e.message}`, ref: e.path });
      rec.finishedAt = new Date().toISOString();
      return rec;
    }
    const backupDir = `autofix/attempts/${String(seq).padStart(4, "0")}-backup`;
    await persistBackups(ws, backupDir, backups, o.repoRoot);
    rec.backupDir = backupDir;
    log.info(`attempt ${seq} ${h.id}: ${c.title} → rerun ${steps.join(" → ")}`);

    let after: Metrics | undefined;
    let env: RerunEnvironmentError | undefined;
    try {
      const rr = await rerunAll(steps, c, "apply");
      if (!rr.ok) {
        rec.reason = `rerun failed: ${rr.crash!.message.split("\n")[0].slice(0, 300)}`;
        await fileBug({ ...rr.crash!, candidate: { title: c.title, handler: h.id, files: c.files } });
      } else {
        after = await measure(h, g);
        rec.after = after;
        const d = decide(before, after);
        rec.accepted = d.accepted;
        rec.reason = d.reason;
      }
    } catch (e) {
      if (!(e instanceof RerunEnvironmentError)) throw e;
      env = e;
      rec.reason = `environment: ${e.message}`;
    }
    if (!rec.accepted) {
      // data back, app source back (never half-updated), then rebuild what the candidate changed
      await restoreBackups(backups);
      if (appSnap) await restoreApp(appSnap);
      const producing = steps.filter((s) => s !== "verify");
      try {
        const rb = producing.length ? await rerunAll(producing, c, "rollback") : { ok: true };
        if (!rb.ok) {
          if (appSnap) await restoreApp(appSnap);
          await fileBug(rb.crash!);
          fatal = true;
          rec.reason += ` — ROLLBACK RERUN FAILED (${rb.crash!.step}); data and app source restored to the pre-candidate state${producing.includes("build") ? ", app not rebuilt" : ""}`;
        }
      } catch (e) {
        if (!(e instanceof RerunEnvironmentError)) throw e;
        env ??= e;
      }
      await restoreState(ws, snap);
    }
    if (env) {
      issues.push({ severity: "error", code: env.code, message: env.message, actionable: true });
      fatal = true;
    }
    rec.finishedAt = new Date().toISOString();
    return rec;
  };

  const writeDossier = async (g: TaskGroup, why: string): Promise<string> => {
    const key = safeId(g.key);
    const path = `autofix/dossiers/${key}.json`;
    let extra: unknown;
    try {
      extra = g.handler.dossier ? await g.handler.dossier(ctxFor(), g.tasks) : undefined;
    } catch (e) {
      extra = { error: (e as Error).message };
    }
    const tried = [...previousAll, ...attempts].filter((a) => a.handler === g.handler.id && a.taskIds.some((t) => g.tasks.some((x) => x.id === t)));
    if (!dry)
      await ws.writeJson(path, {
        group: g.key,
        handler: g.handler.id,
        why,
        tasks: g.tasks.map(({ id, code, ref, message, severity, source, data }) => ({ id, code, ref, message, severity, source, data })),
        attempts: tried.map((a) => ({ seq: a.seq, title: a.candidate.title, origin: a.candidate.origin, accepted: a.accepted, reason: a.reason, file: `autofix/attempts/${String(a.seq).padStart(4, "0")}-${a.handler}.json` })),
        dossier: extra,
      });
    return path;
  };

  const finish = (g: TaskGroup) => {
    const st = state.get(g.key)!;
    st.done = true;
    for (const t of g.tasks) st.seen.add(t.id);
  };
  const clearHuman = (key: string) => {
    const at = needsHuman.indexOf(key);
    if (at >= 0) needsHuman.splice(at, 1);
    for (let i = issues.length - 1; i >= 0; i--) if (issues[i].code === AUTOFIX_CODES.NEEDS_HUMAN && issues[i].ref === key) issues.splice(i, 1);
  };
  const markHuman = async (g: TaskGroup, why: string) => {
    finish(g);
    if (g.advisory) return;
    const path = await writeDossier(g, why);
    clearHuman(g.key);
    needsHuman.push(g.key);
    const codes = [...new Set(g.tasks.map((t) => t.code))].join(", ");
    issues.push({ severity: "warning", code: AUTOFIX_CODES.NEEDS_HUMAN, message: `${g.handler.id}: ${g.tasks.length} task(s) [${codes}] not fixed automatically (${why}) — dossier ${path}`, ref: g.key, actionable: true });
  };

  for (;;) {
    if (fatal) {
      stopReason = "fatal (environment or rollback failure)";
      break;
    }
    if (iterations >= maxIterations) {
      stopReason = `maxIterations ${maxIterations} reached`;
      break;
    }
    if (metered?.exhausted()) {
      stopReason = "budget exhausted";
      issues.push({ severity: "warning", code: AUTOFIX_CODES.BUDGET_EXHAUSTED, message: `LLM budget $${budgetUsd ?? "?"} exhausted (spent $${metered.spentUsd().toFixed(4)}); remaining tasks stay open`, actionable: true });
      break;
    }
    if (sinceAccept >= patience) {
      stopReason = `patience ${patience} (attempts without an accepted candidate)`;
      issues.push({ severity: "warning", code: AUTOFIX_CODES.STALLED, message: `${sinceAccept} consecutive attempts without an accepted candidate — stopped (autofix.patience ${patience})`, actionable: true });
      break;
    }
    const tasks = await collectTasks(ws, { handlers: o.handlers, viewports, codes: o.codes });
    const g = groupTasks(tasks, o.handlers).find((x) => {
      const s = state.get(x.key);
      return !s?.done || x.tasks.some((t) => !s.seen.has(t.id));
    });
    if (!g) {
      if (pending.size && !dry) {
        await propagate();
        continue;
      }
      break;
    }
    const staleSteps = g.tasks.map((t) => String(t.data?.step ?? "")).filter(staleTask);
    if (urgent() && staleSteps.length) {
      // bring the state this group is measured on up to date (only as far down the chain as its tasks come from)
      await propagate(DOWNSTREAM_ORDER[Math.max(...staleSteps.map((x) => DOWNSTREAM_ORDER.indexOf(x as RerunStep)))]);
      continue;
    }
    if (!state.has(g.key)) state.set(g.key, { failed: 0, accepted: 0, done: false, tried: new Set(previousAll.filter((a) => a.handler === g.handler.id && a.patchSha).map((a) => a.patchSha!)), seen: new Set() });
    const st = state.get(g.key)!;
    if (!st.done && !st.accepted && !st.failed && !dry) {
      // exhausted in an earlier run: the same tasks already had ≥ candidatesPerTask measured, rejected candidates and
      // nothing was accepted since → do not ask the model again (replays stay at 0 live calls); delete those
      // attempt files to retry
      const lastAccept = previousAll.reduce((m, a) => (a.accepted ? Math.max(m, a.seq) : m), 0);
      const ids = g.tasks.map((t) => t.id).sort().join("\n");
      const same = previousAll.filter((a) => a.handler === g.handler.id && a.seq > lastAccept && [...a.taskIds].sort().join("\n") === ids);
      const measured = same.filter((a) => !a.accepted && a.after);
      if (measured.length >= perTask) {
        log.info(`${g.key}: exhausted in an earlier run (${measured.length} rejected), not re-proposed`);
        await markHuman(g, `exhausted in an earlier run: ${measured.length} candidate(s) rejected (attempts ${same.map((a) => a.seq).join(", ")})`);
        continue;
      }
    }
    if (st.done) {
      // revisit: new work for a finished group
      log.info(`revisiting ${g.key}: ${g.tasks.filter((t) => !st.seen.has(t.id)).length} new task(s)`);
      st.done = false;
      st.failed = 0;
      st.accepted = 0;
    }
    const h = g.handler;

    let before: Metrics;
    let cands: Candidate[];
    try {
      before = await measure(h, g);
      const prev = [...previousAll, ...attempts].filter((a) => a.handler === h.id && a.taskIds.some((t) => g.tasks.some((x) => x.id === t)));
      cands = await h.propose(ctxFor(), g.tasks, prev);
    } catch (e) {
      metered?.take();
      if (isBudgetError(e) || metered?.exhausted()) continue; // budget check at the top of the loop
      issues.push({ severity: "warning", code: "AUTOFIX_HANDLER_FAILED", message: `${h.id} (${g.key}): ${(e as Error).message.split("\n")[0]}` });
      await markHuman(g, `handler failed: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
      continue;
    }
    const propUsage = metered?.take() ?? emptyUsage();
    const seenSha = new Set<string>();
    const fresh = cands.filter((c) => {
      const sha = patchSha(c);
      if (st.tried.has(sha) || seenSha.has(sha)) return false;
      seenSha.add(sha);
      return true;
    });
    if (dry) {
      proposals.push({ group: g.key, handler: h.id, taskIds: g.tasks.map((t) => t.id), candidates: cands.map((c) => ({ title: c.title, origin: c.origin, files: c.files.map((f) => f.path), rerun: c.rerun })) });
      log.info(`dry-run ${g.key}: ${cands.length} candidate(s)${cands.length ? ": " + cands.map((c) => c.title).join(" | ") : ""}`);
      finish(g);
      if (!cands.length) await markHuman(g, "no candidate proposed");
      continue;
    }
    if (!fresh.length) {
      await markHuman(g, cands.length ? `all ${cands.length} proposed candidate(s) were tried before` : "no candidate proposed");
      continue;
    }
    let accepted = false;
    let firstUsage = propUsage;
    for (const c of fresh.slice(0, Math.max(0, perTask - st.failed))) {
      if (iterations >= maxIterations || sinceAccept >= patience || fatal) break;
      iterations++;
      st.tried.add(patchSha(c));
      const rec = await tryCandidate(g, c, before, firstUsage);
      firstUsage = emptyUsage();
      attempts.push(rec);
      await ws.writeJson(`autofix/attempts/${String(rec.seq).padStart(4, "0")}-${safeId(h.id)}.json`, rec);
      log.info(`attempt ${rec.seq} ${rec.accepted ? "ACCEPTED" : "rejected"}: ${rec.reason}`);
      if (rec.accepted) {
        accepted = true;
        sinceAccept = 0;
        st.accepted++;
        issues.push({ severity: "info", code: AUTOFIX_CODES.ACCEPTED, message: `${h.id}: ${c.title} — ${rec.reason}`, ref: `autofix/attempts/${String(rec.seq).padStart(4, "0")}-${safeId(h.id)}.json` });
        clearHuman(g.key);
        const ran: RerunStep[] = [...c.rerun];
        if (c.verify && !ran.includes("verify")) ran.push("verify");
        const scoped = !!(c.verify && (c.verify.checks?.length || c.verify.urls?.length || c.verify.viewports?.length));
        for (const s of staleAfter(ran, available, scoped, isFastDesign(c) ? ["design-extract"] : [])) pending.add(s);
        break;
      }
      st.failed++;
      sinceAccept++;
    }
    if (fatal) continue;
    if (!accepted && st.failed >= perTask) await markHuman(g, `${st.failed} candidate(s) rejected`);
    else if (accepted && st.accepted >= perTask) finish(g);
  }

  // stopped early (maxIterations, patience, budget): still bring the downstream state up to date once
  if (pending.size && !fatal && !dry) await propagate();
  // remaining groups that were never reached are left open (no NEEDS_HUMAN: the loop stopped early)
  const acc = attempts.filter((a) => a.accepted).length;
  const llmTotal = metered?.total ?? emptyUsage();
  const openAfter = await collectTasks(ws, { handlers: o.handlers, viewports, codes: o.codes });
  report.issues = issues;
  report.stats = {
    iterations,
    attempts: attempts.length,
    accepted: acc,
    rejected: attempts.length - acc,
    acceptedPct: attempts.length ? Math.round((acc / attempts.length) * 1000) / 10 : 0,
    needsHuman: needsHuman.length,
    pipelineBugs: dry ? issues.filter((i) => i.code === AUTOFIX_CODES.PIPELINE_BUG).length : bugs.size,
    proposals: proposals.length,
    openTasksAfter: openAfter.filter((t) => !t.advisory).length,
    llmCalls: llmTotal.calls,
    llmCached: llmTotal.cached,
    llmTokens: llmTotal.promptTokens + llmTotal.completionTokens,
    llmEstCostUsd: llmTotal.estCostUsd,
    usdPerAcceptedFix: acc ? Math.round((llmTotal.estCostUsd / acc) * 1e6) / 1e6 : 0,
    stopReason,
  };
  report.outputs = dry ? [] : [...attempts.map((a) => `autofix/attempts/${String(a.seq).padStart(4, "0")}-${safeId(a.handler)}.json`), ...[...bugs].map((n) => `autofix/bugs/${n}/README.md`)];
  report.ok = !fatal;
  if (!dry) await ws.writeJson("autofix/last-run.json", { finishedAt: new Date().toISOString(), stats: report.stats, proposals, needsHuman, bugs: [...bugs].sort((a, b) => a - b) });
  return { report, attempts, proposals, stopReason };
}
