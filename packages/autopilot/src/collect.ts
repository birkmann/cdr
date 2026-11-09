// The collector (plan §4.2): everything a cycle's stages left on disk, turned into findings with one signature per
// code path. Mirror runs are read here too, so the mirror stage and the tests share one reading of those files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { signatureOf } from "./signature.js";
import {
  STAGE_ORDER,
  type AutopilotPaths,
  type Finding,
  type FindingRank,
  type Gate,
  type MatrixResult,
  type ModelUsage,
  type StageIssue,
  type StageName,
  type StageStatus,
  type StageSummary,
} from "./types.js";

// ---------------------------------------------------------------- small readers

export function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------- a mirror run on disk

type RawGate = { pass: boolean; value?: number | string; threshold?: number | string };
type RawIssue = { severity: string; code: string; message: string; ref?: string };

interface VisualRow {
  viewport: string;
  path: string;
  parity?: number;
  pass?: boolean;
  parityPass?: boolean;
  bboxPass?: boolean;
  heightPass?: boolean;
  baseline?: string;
  current?: string;
  diff?: string;
  height?: { delta?: number };
  bbox?: { maxDelta?: number | string };
  diagnosis?: { file: string; cause: string; subtype?: string; element?: string };
}

interface StageRecord {
  status?: string;
  ms?: number;
  detail?: string;
  skipped?: string[];
}

/** Reported, never a reason to fail (plan §1); the same list as the pipeline's own. */
export const ADVISORY_GATE = /^(seo|a11y|performance|cleanliness)\./;

/** Visual issues the gates already carry (with their cause and crops); repeating them adds no information. */
const COVERED_BY_GATES = new Set(["VISUAL_DIFF", "BBOX_DIFF", "HEIGHT_DIFF"]);

export interface MirrorRunDigest {
  status: StageStatus;
  gates: Gate[];
  issues: StageIssue[];
  usage: ModelUsage;
  /** Wall clock per pipeline stage (`appbuild`, `verify`, …) for the health check. */
  stageMs: Record<string, number>;
}

function viewportGates(rows: VisualRow[], summary: Record<string, RawGate>): Gate[] {
  const out: Gate[] = [];
  for (const vp of [...new Set(rows.map((r) => r.viewport))]) {
    const inVp = rows.filter((r) => r.viewport === vp);
    const passOf = (f: (r: VisualRow) => boolean | undefined) => inVp.every((r) => f(r) ?? r.pass ?? true);
    const parities = inVp.map((r) => r.parity).filter((p): p is number => typeof p === "number");
    const deltas = inVp.map((r) => r.height?.delta).filter((d): d is number => typeof d === "number");
    const bboxes = inVp.map((r) => r.bbox?.maxDelta);
    const bboxMissing = bboxes.some((b) => typeof b === "string");
    const parity = summary["visual.parity"];
    out.push({
      id: "visual.parity",
      viewport: vp,
      pass: passOf((r) => r.parityPass),
      hard: true,
      ...(parities.length ? { value: Math.min(...parities) } : {}),
      ...(parity?.threshold !== undefined ? { threshold: parity.threshold } : {}),
    });
    const bbox = summary["visual.bbox"];
    const maxBbox = bboxes.filter((b): b is number => typeof b === "number");
    out.push({
      id: "visual.bbox",
      viewport: vp,
      pass: passOf((r) => r.bboxPass),
      hard: true,
      ...(bboxMissing ? { value: "missing" } : maxBbox.length ? { value: Math.max(...maxBbox) } : {}),
      ...(bbox?.threshold !== undefined ? { threshold: bbox.threshold } : {}),
    });
    const height = summary["visual.height"];
    out.push({
      id: "visual.height",
      viewport: vp,
      pass: passOf((r) => r.heightPass),
      hard: true,
      ...(deltas.length ? { value: Math.max(...deltas.map(Math.abs)) } : {}),
      ...(height?.threshold !== undefined ? { threshold: height.threshold } : {}),
    });
  }
  return out;
}

function evidenceOf(runDir: string, rels: (string | undefined)[]): string[] {
  return rels.filter((r): r is string => !!r).map((r) => join(runDir, r));
}

const dossierCauses = (runDir: string, row: VisualRow): { cause?: string; lines: string[] } => {
  if (row.diagnosis?.cause) {
    const dossier = readJsonOr<{ classification?: { evidence?: string[] } }>(
      join(runDir, row.diagnosis.file),
      {},
    );
    return { cause: row.diagnosis.cause, lines: dossier.classification?.evidence?.slice(0, 3) ?? [] };
  }
  return { lines: [] };
};

/** The verify suite's visual gates per failing shot, with the dossier's cause and its evidence lines. */
function visualIssues(runDir: string, rows: VisualRow[]): StageIssue[] {
  const issues: StageIssue[] = [];
  for (const row of rows) {
    const dossier = dossierCauses(runDir, row);
    const fails: [string, boolean | undefined, string][] = [
      ["visual.parity", row.parityPass, `parity ${String(row.parity ?? "?")}`],
      ["visual.bbox", row.bboxPass, `box delta ${String(row.bbox?.maxDelta ?? "?")}`],
      ["visual.height", row.heightPass, `height delta ${String(row.height?.delta ?? "?")}`],
    ];
    for (const [code, pass, what] of fails) {
      if (pass !== false) continue;
      const parts = [`${row.viewport} ${row.path}: ${code} failed, ${what}`];
      if (dossier.cause)
        parts.push(`cause ${dossier.cause}${row.diagnosis?.element ? ` at ${row.diagnosis.element}` : ""}`);
      if (dossier.lines.length) parts.push(dossier.lines.join(" · "));
      issues.push({
        code,
        ...(dossier.cause ? { cause: dossier.cause } : {}),
        message: parts.join(": "),
        severity: "error",
        evidence: evidenceOf(runDir, [row.diagnosis?.file, row.diff, row.current, row.baseline]),
      });
    }
  }
  return issues;
}

/** Browser-side problems of the new page only (the dossier compares both sides), plan §4.2 "browser". */
function browserIssues(runDir: string, rows: VisualRow[]): StageIssue[] {
  const issues: StageIssue[] = [];
  for (const row of rows) {
    if (!row.diagnosis?.file) continue;
    const file = join(runDir, row.diagnosis.file);
    const d = readJsonOr<{
      assets?: {
        consoleErrors?: { onlyNew?: string[] };
        failedRequests?: { onlyNew?: { url: string; status?: number | string; type?: string }[] };
      };
    }>(file, {});
    for (const message of d.assets?.consoleErrors?.onlyNew ?? [])
      issues.push({
        code: "NEW_PAGE_ERROR",
        cause: "console",
        message: `${row.viewport} ${row.path}: console error on the new page only: ${message}`,
        severity: "warning",
        evidence: [file],
      });
    for (const req of d.assets?.failedRequests?.onlyNew ?? [])
      issues.push({
        code: "REQUEST_FAILED",
        ...(req.type ? { cause: req.type } : {}),
        message: `${row.viewport} ${row.path}: ${req.url} failed on the new page (${String(req.status ?? "?")})`,
        severity: "warning",
        evidence: [file],
      });
  }
  return issues;
}

function usageOf(runDir: string): { usage: ModelUsage; issues: StageIssue[] } {
  const dir = join(runDir, "llm-log");
  const usage: ModelUsage = { calls: 0, cachedCalls: 0, costUsd: 0 };
  const issues: StageIssue[] = [];
  for (const name of listDir(dir)) {
    if (!name.endsWith(".json")) continue;
    const r = readJsonOr<{
      step?: string;
      cached?: boolean;
      ok?: boolean;
      estCostUsd?: number;
      validationError?: string;
      error?: string;
    }>(join(dir, name), {});
    usage.calls++;
    if (r.cached) usage.cachedCalls++;
    usage.costUsd += r.estCostUsd ?? 0;
    if (r.ok === false)
      issues.push({
        code: "LLM_FAILED",
        ...(r.step ? { cause: r.step } : {}),
        message: `${r.step ?? "model call"}: ${r.validationError ?? r.error ?? "failed"}`,
        severity: "warning",
        evidence: [join(dir, name)],
      });
  }
  return { usage, issues };
}

function verifyFileIssues(runDir: string): StageIssue[] {
  const dir = join(runDir, "verify");
  const issues: StageIssue[] = [];
  for (const name of listDir(dir)) {
    if (!name.endsWith(".json") || name === "summary.json") continue;
    const file = join(dir, name);
    const check = name.replace(/\.json$/, "");
    const parsed = readJsonOr<{ issues?: RawIssue[] }>(file, {});
    for (const i of parsed.issues ?? []) {
      if (COVERED_BY_GATES.has(i.code)) continue;
      if (i.code === "CHECK_CRASHED") {
        issues.push({
          code: "PIPELINE_BUG",
          cause: `CHECK_CRASHED:${check}`,
          message: i.message,
          severity: "error",
          evidence: [file],
        });
        continue;
      }
      if (i.severity === "info" && i.code !== "SOURCE_DRIFT") continue;
      issues.push({
        code: i.code,
        message: i.message,
        severity: i.severity === "error" ? "error" : i.severity === "info" ? "info" : "warning",
        evidence: [file],
      });
    }
  }
  return issues;
}

function autofixIssues(runDir: string): StageIssue[] {
  const issues: StageIssue[] = [];
  // the fix loop's own report: what it could not fix, and budget stops
  const report = readJsonOr<{ issues?: RawIssue[] }>(join(runDir, "reports/autofix.json"), {});
  const dossierDir = join(runDir, "autofix/dossiers");
  for (const i of report.issues ?? []) {
    if (i.code === "AUTOFIX_NEEDS_HUMAN") {
      const m = /dossier (\S+)/.exec(i.message);
      issues.push({
        code: "AUTOFIX_NEEDS_HUMAN",
        message: i.message,
        severity: "warning",
        evidence: m ? [join(runDir, m[1]!)] : [dossierDir],
      });
    } else if (i.code === "AUTOFIX_BUDGET_EXHAUSTED") {
      issues.push({
        code: "BUDGET_EXCEEDED",
        cause: "autofix",
        message: i.message,
        severity: "warning",
        evidence: [join(runDir, "reports/autofix.json")],
      });
    } else if (i.code === "NEW_PAGE_ERROR") {
      issues.push({ code: "NEW_PAGE_ERROR", message: i.message, severity: "warning" });
    }
  }
  // bug bundles written during the run: the pipeline's own code failed
  const bugsDir = join(runDir, "autofix/bugs");
  for (const n of listDir(bugsDir)) {
    const bundle = join(bugsDir, n);
    if (!isDir(bundle)) continue;
    const bug = readJsonOr<{ code?: string; step?: string; check?: string; message?: string; n?: number }>(
      join(bundle, "bug.json"),
      {},
    );
    if (!bug.code) continue;
    const what = bug.check ?? bug.step;
    issues.push({
      code: "PIPELINE_BUG",
      cause: what ? `${bug.code}:${what}` : bug.code,
      message: bug.message ?? `${bug.code} in ${bug.step ?? "the pipeline"}`,
      severity: "error",
      evidence: [join(bundle, "README.md"), join(bundle, "inputs")],
    });
  }
  return issues;
}

/**
 * Everything one finished mirror run says about itself: `manifest.json`, `reports/`, `verify/*`, dossiers, autofix
 * attempts and bug bundles, as gates and issues (plan §1 and §4.2).
 */
export function readMirrorRun(runDir: string): MirrorRunDigest {
  const manifest = readJsonOr<{
    status?: string;
    stages?: Record<string, StageRecord>;
    summary?: string;
    gates?: { name: string; pass: boolean; detail?: string }[];
  }>(join(runDir, "manifest.json"), {});
  const verifySummary = readJsonOr<{ gates?: Record<string, RawGate> }>(
    join(runDir, "verify/summary.json"),
    {},
  );
  const extract = readJsonOr<{ gates?: Record<string, RawGate> }>(join(runDir, "reports/extract.json"), {});
  const transform = readJsonOr<{ gates?: Record<string, RawGate> }>(
    join(runDir, "reports/transform.json"),
    {},
  );
  const verifyGates = verifySummary.gates ?? {};
  const all: Record<string, RawGate> = {
    ...(extract.gates ?? {}),
    ...(transform.gates ?? {}),
    ...verifyGates,
  };
  const rows = readJsonOr<{ details?: { results?: VisualRow[] } }>(join(runDir, "verify/visual.json"), {})
    .details?.results;
  const compared = (rows ?? []).filter((r) => typeof r.parity === "number");

  const gates: Gate[] = [];
  for (const [id, g] of Object.entries(all)) {
    if (compared.length && id.startsWith("visual.")) continue;
    gates.push({
      id,
      pass: g.pass,
      hard: !ADVISORY_GATE.test(id),
      ...(g.value !== undefined ? { value: g.value } : {}),
      ...(g.threshold !== undefined ? { threshold: g.threshold } : {}),
    });
  }
  if (compared.length) gates.push(...viewportGates(compared, verifyGates));
  const appbuild = manifest.stages?.appbuild;
  if (appbuild)
    gates.push({
      id: "appbuild",
      pass: appbuild.status === "done",
      hard: true,
      value: appbuild.status ?? "unknown",
    });

  const issues: StageIssue[] = [];
  const stageMs: Record<string, number> = {};
  const manifestFile = join(runDir, "manifest.json");
  for (const [name, rec] of Object.entries(manifest.stages ?? {})) {
    if (typeof rec.ms === "number") stageMs[name] = rec.ms;
    if (rec.status === "failed")
      issues.push({
        code: "STAGE_FAILED",
        cause: name,
        message: `${name}: ${rec.detail ?? "failed"}`,
        severity: "error",
        evidence: [manifestFile],
      });
    if (rec.skipped?.length)
      issues.push({
        code: "STAGE_SKIPPED_PARTS",
        cause: name,
        message: `${name}: ${rec.skipped.join("; ")}`,
        severity: "warning",
        evidence: [manifestFile],
      });
  }

  issues.push(...verifyFileIssues(runDir));
  // failing gates with their cause; `visual.*` come per shot with the dossier's cause
  if (rows) issues.push(...visualIssues(runDir, rows), ...browserIssues(runDir, rows));
  const visualFromRows = !!rows && compared.length > 0;
  for (const g of gates) {
    if (g.pass || (visualFromRows && g.id.startsWith("visual."))) continue;
    issues.push({
      code: g.id,
      message: `${g.id}: ${formatGateValue(g)}`,
      severity: g.hard ? "error" : "warning",
      evidence: [join(runDir, "verify/summary.json")],
    });
  }
  issues.push(...autofixIssues(runDir));
  const llm = usageOf(runDir);
  issues.push(...llm.issues);

  const failedStage = Object.values(manifest.stages ?? {}).some((s) => s.status === "failed");
  const hardFail = gates.some((g) => g.hard && !g.pass);
  const noVerify = !existsSync(join(runDir, "verify/summary.json"));
  const status: StageStatus = failedStage || hardFail || noVerify ? "failed" : "passed";
  return { status, gates, issues, usage: llm.usage, stageMs };
}

export function formatGateValue(g: Pick<Gate, "value" | "threshold">): string {
  const value = g.value === undefined ? "no value" : String(g.value);
  return g.threshold === undefined ? value : `${value} (limit ${String(g.threshold)})`;
}

// ---------------------------------------------------------------- the cycle

/** Blocks the chain (§4.4 rank 0): a crash or a failed build means nothing after it ran. */
const CHAIN_BLOCKING = new Set([
  "CRASHED",
  "STAGE_FAILED",
  "STEP_FAILED",
  "PIPELINE_BUG",
  "BUILD_FAILED",
  "CHECK_CRASHED",
  "APP_NOT_BUILT",
  "BOT_BLOCKED",
  "SNAPSHOT_INCOMPLETE",
  "TIMEOUT",
  "OUT_OF_MEMORY",
  "UNHANDLED_REJECTION",
  "BROWSER_LAUNCH_FAILED",
  "PROCESS_EXIT",
]);
const HEALTH = new Set(["STAGE_SLOW", "BUDGET_EXCEEDED", "LLM_FAILED"]);

/** A collected problem before findings are labelled against the registry and earlier cycles. */
export type CollectedFinding = Omit<Finding, "status">;

/** Verify names the issues of its advisory checks differently from their gates (`SEO_DIFF` under `seo.diffs`). */
const ADVISORY_ISSUE = /^(SEO|A11Y|PERF|LIGHTHOUSE|RAWHTML)_/;

export function rankOf(
  issue: StageIssue,
  gateByCode: Map<string, Gate>,
  stage: Finding["stage"],
): FindingRank {
  if (CHAIN_BLOCKING.has(issue.code)) return 0;
  const gate = gateByCode.get(issue.code);
  if (gate) return gate.hard ? 1 : 3;
  if (ADVISORY_ISSUE.test(issue.code)) return 3;
  if (HEALTH.has(issue.code) || stage === "health") return 2;
  if (issue.code === "REPLAY_404") return 2;
  return issue.severity === "error" ? 1 : 3;
}

const PROCESS_PATTERNS: [RegExp, string, string?][] = [
  [/out of memory|ENOMEM/i, "OUT_OF_MEMORY"],
  [/unhandled ?(promise )?rejection/i, "UNHANDLED_REJECTION"],
  [/failed to launch|Executable doesn't exist|browserType\.launch/i, "BROWSER_LAUNCH_FAILED"],
  [/exited with (?!0\b)\d+|exit code (?!0\b)\d+/i, "PROCESS_EXIT"],
];

/** Process-level failures that only show in a stage's log (plan §4.2 "process"). */
export function processIssues(logText: string, logFile: string): StageIssue[] {
  const out: StageIssue[] = [];
  const seen = new Set<string>();
  for (const line of logText.split("\n")) {
    for (const [re, code] of PROCESS_PATTERNS) {
      if (seen.has(code) || !re.test(line)) continue;
      seen.add(code);
      out.push({
        code,
        message: line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 400),
        severity: "error",
        evidence: [logFile],
      });
    }
  }
  return out;
}

export interface ReplayMissLine {
  url: string;
  kind: string;
  method?: string;
}

/** `freeze/replay-misses.jsonl`, written by the replay server: page requests the snapshot cannot answer. */
export function replayMissIssues(file: string): StageIssue[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const byKind = new Map<string, string[]>();
  for (const line of lines) {
    let m: ReplayMissLine;
    try {
      m = JSON.parse(line) as ReplayMissLine;
    } catch {
      continue;
    }
    if (m.kind === "probe") continue;
    byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m.url]);
  }
  return [...byKind].map(([kind, urls]) => ({
    code: "REPLAY_404",
    cause: kind,
    message: `${urls.length} ${kind} request(s) the snapshot cannot answer, for example ${urls[0]}`,
    severity: "warning" as const,
    evidence: [file],
  }));
}

export function readSummaries(
  paths: Pick<AutopilotPaths, "stageDir">,
  cycle: number,
  site: string,
): Partial<Record<StageName, StageSummary>> {
  const out: Partial<Record<StageName, StageSummary>> = {};
  for (const stage of STAGE_ORDER) {
    const s = readJsonOr<StageSummary | undefined>(
      join(paths.stageDir(cycle, site, stage), "summary.json"),
      undefined,
    );
    if (s) out[stage] = s;
  }
  return out;
}

export function siteDirsOf(paths: Pick<AutopilotPaths, "cycleDir">, cycle: number): string[] {
  const dir = paths.cycleDir(cycle);
  return listDir(dir).filter((name) => isDir(join(dir, name)));
}

interface SlowSample {
  site: string;
  stage: string;
  ms: number;
  cycle: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const SLOW_FACTOR = 1.5;
const SLOW_MIN_SAMPLES = 3;
const SLOW_MIN_MS = 30_000;

/** The wall clocks of every stage and pipeline step of every cycle so far, for §1's "over 1.5× its median". */
function collectSamples(
  paths: Pick<AutopilotPaths, "cycleDir" | "stageDir">,
  upToCycle: number,
): SlowSample[] {
  const samples: SlowSample[] = [];
  for (let cycle = 1; cycle <= upToCycle; cycle++) {
    for (const site of siteDirsOf(paths, cycle)) {
      const summaries = readSummaries(paths, cycle, site);
      for (const s of Object.values(summaries)) {
        if (!s || s.status === "skipped" || s.status === "crashed") continue;
        samples.push({ site, stage: s.stage, ms: s.wallClockMs, cycle });
        const runDir = s.artifacts?.runDir;
        if (runDir) {
          const stages = readJsonOr<{ stages?: Record<string, StageRecord> }>(
            join(runDir, "manifest.json"),
            {},
          ).stages;
          for (const [step, rec] of Object.entries(stages ?? {}))
            if (typeof rec.ms === "number") samples.push({ site, stage: step, ms: rec.ms, cycle });
        }
      }
    }
  }
  return samples;
}

function slowIssues(samples: SlowSample[], cycle: number, site: string, evidence: string): StageIssue[] {
  const out: StageIssue[] = [];
  const byStage = new Map<string, number[]>();
  for (const s of samples) byStage.set(s.stage, [...(byStage.get(s.stage) ?? []), s.ms]);
  for (const s of samples.filter((x) => x.cycle === cycle && x.site === site)) {
    const values = byStage.get(s.stage)!;
    if (values.length < SLOW_MIN_SAMPLES) continue;
    const m = median(values);
    if (s.ms <= m * SLOW_FACTOR || s.ms - m < SLOW_MIN_MS) continue;
    out.push({
      code: "STAGE_SLOW",
      cause: s.stage,
      message: `${s.stage} took ${Math.round(s.ms / 1000)} s, its median is ${Math.round(m / 1000)} s`,
      severity: "warning",
      evidence: [evidence],
    });
  }
  return out;
}

interface Sink {
  add(stage: Finding["stage"], site: string, issue: StageIssue, rank: FindingRank): void;
}

function collectStage(sink: Sink, summary: StageSummary, stageDir: string): void {
  const gateByCode = new Map(summary.gates.map((g) => [g.id, g]));
  // a gate that fails without an issue of its own still keeps the site from green
  const covered = new Set(summary.issues.map((i) => i.code));
  const issues: StageIssue[] = [...summary.issues];
  for (const g of summary.gates)
    if (!g.pass && !covered.has(g.id))
      issues.push({
        code: g.id,
        message: `${g.id}${g.viewport ? ` at ${g.viewport}` : ""}: ${formatGateValue(g)}`,
        severity: g.hard ? "error" : "warning",
        evidence: [join(stageDir, "summary.json")],
      });
  for (const issue of issues) {
    if (issue.severity === "info" || issue.code === "SOURCE_DRIFT") continue;
    const stage: Finding["stage"] = HEALTH.has(issue.code) ? "health" : summary.stage;
    let rank = rankOf(issue, gateByCode, stage);
    if (summary.status === "crashed") rank = 0;
    sink.add(stage, summary.site, issue, rank);
  }
}

/** Every problem of a cycle, one entry per signature: which sites it hit and where its evidence is. */
export function collectCycle(
  paths: Pick<AutopilotPaths, "cycleDir" | "siteDir" | "stageDir">,
  cycle: number,
): CollectedFinding[] {
  const sites = siteDirsOf(paths, cycle);
  const bySignature = new Map<string, CollectedFinding>();
  const sink: Sink = {
    add(stage, site, issue, rank) {
      const signature = signatureOf(stage, issue, sites);
      let f = bySignature.get(signature);
      if (!f) {
        f = {
          signature,
          stage,
          code: issue.code,
          ...(issue.cause ? { cause: issue.cause } : {}),
          message: issue.message,
          sites: [],
          rank,
          evidence: [],
        };
        bySignature.set(signature, f);
      }
      if (!f.sites.includes(site)) f.sites.push(site);
      f.rank = Math.min(f.rank, rank) as FindingRank;
      for (const e of issue.evidence ?? []) if (!f.evidence.includes(e)) f.evidence.push(e);
    },
  };
  const samples = collectSamples(paths, cycle);
  for (const site of sites) {
    const siteDir = paths.siteDir(cycle, site);
    for (const stage of STAGE_ORDER) {
      const stageDir = paths.stageDir(cycle, site, stage);
      if (!isDir(stageDir)) continue;
      const summary = readJsonOr<StageSummary | undefined>(join(stageDir, "summary.json"), undefined);
      if (summary) collectStage(sink, summary, stageDir);
      const logFile = join(stageDir, "log.txt");
      if (existsSync(logFile))
        for (const issue of processIssues(readFileSync(logFile, "utf8"), logFile))
          sink.add(stage, site, issue, rankOf(issue, new Map(), stage));
      for (const issue of replayMissIssues(join(stageDir, "replay-misses.jsonl")))
        sink.add(stage, site, issue, rankOf(issue, new Map(), stage));
    }
    const repro = readJsonOr<{ differing?: string[] } | undefined>(
      join(siteDir, "reproducibility.json"),
      undefined,
    );
    if (repro?.differing?.length)
      sink.add(
        "reproducibility",
        site,
        {
          code: "NONDETERMINISTIC",
          message: `${repro.differing.length} generated file(s) differ between two runs from one snapshot: ${repro.differing.slice(0, 5).join(", ")}`,
          severity: "error",
          evidence: [join(siteDir, "reproducibility.json")],
        },
        1,
      );
    for (const issue of slowIssues(samples, cycle, site, join(siteDir, "report.json")))
      sink.add("health", site, issue, 2);
  }
  for (const f of bySignature.values()) f.sites.sort();
  return [...bySignature.values()];
}

/** Summaries of a `matrix.json`, or an empty result when the cycle has none. */
export function readMatrix(paths: Pick<AutopilotPaths, "cycleDir">, cycle: number): MatrixResult | undefined {
  return readJsonOr<MatrixResult | undefined>(join(paths.cycleDir(cycle), "matrix.json"), undefined);
}
