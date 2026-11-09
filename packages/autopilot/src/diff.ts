/**
 * `autopilot diff` (§3.3), and the reproducibility check of §1, which compares two cycles the same way: gates must be
 * identical and the generated code byte-identical apart from timestamps.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { matrixGates } from "./decide.js";
import { isCoverageGate } from "./ratchet.js";
import { readFindings } from "./fix.js";
import { writeJson } from "./registry.js";
import { readCycleMatrix } from "./verify.js";
import type { AutopilotPaths, FindingsFile, MatrixResult, StageSummary } from "./types.js";

export interface GateChange {
  key: string;
  from: boolean | null;
  to: boolean | null;
}

export interface CycleComparison {
  from: number;
  to: number;
  /** Gates that changed, pass → fail first. */
  flips: GateChange[];
  regressions: string[];
  appeared: string[];
  disappeared: string[];
  wallClockMs: { from: number; to: number };
  costUsd: { from: number; to: number };
}

function totals(matrix: MatrixResult): { wallClockMs: number; costUsd: number } {
  let wallClockMs = 0;
  let costUsd = 0;
  for (const stages of Object.values(matrix.sites)) {
    for (const summary of Object.values(stages) as (StageSummary | undefined)[]) {
      if (!summary) continue;
      wallClockMs += summary.wallClockMs;
      costUsd += summary.usage?.costUsd ?? 0;
    }
  }
  return { wallClockMs, costUsd };
}

/** Sum of the model cost of a matrix result. */
export const matrixCost = (matrix: MatrixResult): number => totals(matrix).costUsd;

const signatures = (file: FindingsFile): Set<string> =>
  new Set(file.findings.filter((f) => f.status !== "fixed").map((f) => f.signature));

export function diffResults(
  from: MatrixResult,
  to: MatrixResult,
  fromFindings: FindingsFile,
  toFindings: FindingsFile,
): CycleComparison {
  const before = matrixGates(from);
  const after = matrixGates(to);
  const flips: GateChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = key in before ? before[key]! : null;
    const b = key in after ? after[key]! : null;
    if (a !== b) flips.push({ key, from: a, to: b });
  }
  flips.sort((x, y) => Number(y.from === true) - Number(x.from === true) || x.key.localeCompare(y.key));
  const fromSet = signatures(fromFindings);
  const toSet = signatures(toFindings);
  const t0 = totals(from);
  const t1 = totals(to);
  return {
    from: from.cycle,
    to: to.cycle,
    flips,
    regressions: flips.filter((f) => f.from === true && f.to === false).map((f) => f.key),
    appeared: [...toSet].filter((s) => !fromSet.has(s)).sort(),
    disappeared: [...fromSet].filter((s) => !toSet.has(s)).sort(),
    wallClockMs: { from: t0.wallClockMs, to: t1.wallClockMs },
    costUsd: { from: t0.costUsd, to: t1.costUsd },
  };
}

export function compareCycles(paths: AutopilotPaths, against: number, cycle: number): CycleComparison {
  const from = readCycleMatrix(paths, against);
  const to = readCycleMatrix(paths, cycle);
  if (!from) throw new Error(`cycle ${against} has no matrix.json`);
  if (!to) throw new Error(`cycle ${cycle} has no matrix.json`);
  return diffResults(from, to, readFindings(paths, against), readFindings(paths, cycle));
}

export function renderDiff(diff: CycleComparison): string {
  const state = (v: boolean | null) => (v === null ? "absent" : v ? "pass" : "fail");
  const lines = [`# Cycle ${diff.to} against cycle ${diff.from}`, ""];
  lines.push(`Gates changed: ${diff.flips.length} (${diff.regressions.length} pass → fail)`);
  for (const flip of diff.flips) lines.push(`  ${flip.key}: ${state(flip.from)} → ${state(flip.to)}`);
  lines.push("", `Findings appeared: ${diff.appeared.length}`, ...diff.appeared.map((s) => `  + ${s}`));
  lines.push(`Findings disappeared: ${diff.disappeared.length}`, ...diff.disappeared.map((s) => `  - ${s}`));
  const minutes = (ms: number) => (ms / 60_000).toFixed(1);
  lines.push(
    "",
    `Wall clock: ${minutes(diff.wallClockMs.from)} → ${minutes(diff.wallClockMs.to)} min`,
    `Cost: $${diff.costUsd.from.toFixed(2)} → $${diff.costUsd.to.toFixed(2)}`,
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------- reproducibility

const SKIPPED_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "dist", "build", "coverage"]);
const SKIPPED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", ".DS_Store", "next-env.d.ts"]);
const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".svg",
  ".xml",
  ".yaml",
  ".yml",
]);

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const EPOCH_MS = /\b1[5-9]\d{11}\b/g;
const LOCAL_PORT = /\b(127\.0\.0\.1|localhost):\d+\b/g;
const CYCLE_PATH = /\/cycles\/\d+\//g;

/** What may differ between two faithful runs. */
export function normaliseGenerated(text: string): string {
  return text
    .replace(ISO_TIMESTAMP, "<timestamp>")
    .replace(EPOCH_MS, "<timestamp>")
    .replace(LOCAL_PORT, "$1:<port>")
    .replace(CYCLE_PATH, "/cycles/<n>/");
}

function digestFile(file: string): string {
  const hash = createHash("sha256");
  if (TEXT_EXTENSIONS.has(extname(file).toLowerCase()))
    hash.update(normaliseGenerated(readFileSync(file, "utf8")));
  else hash.update(readFileSync(file));
  return hash.digest("hex");
}

/** Relative path → digest of every generated source file under `dir`. */
export function digestTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(full);
      } else if (!SKIPPED_FILES.has(name) && extname(name) !== ".tsbuildinfo" && extname(name) !== ".log") {
        out.set(relative(dir, full), digestFile(full));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Files that differ between two generated trees. */
export function diffTrees(a: string, b: string): string[] {
  const left = digestTree(a);
  const right = digestTree(b);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key))
    .sort();
}

const GENERATED_ARTIFACTS = ["mirrorApp", "designSystem", "replicaApp"];

export interface ReproducibilityReport {
  ok: boolean;
  /** Per site, what differs: gates as text, generated files as paths. The collector turns this into findings. */
  differing: Record<string, string[]>;
}

/**
 * Compare a cycle with the green cycle before it (§1). The coverage gate is compared by value, because the ratchet may
 * have raised its threshold between the two cycles.
 */
export function checkReproducibility(previous: MatrixResult, current: MatrixResult): ReproducibilityReport {
  const differing: Record<string, string[]> = {};
  const add = (site: string, what: string) => (differing[site] ??= []).push(what);

  for (const [site, stages] of Object.entries(current.sites)) {
    for (const [stage, summary] of Object.entries(stages) as [string, StageSummary | undefined][]) {
      const before = previous.sites[site]?.[stage as keyof (typeof previous.sites)[string]];
      if (!summary || !before) continue;
      const beforeGates = new Map(before.gates.map((g) => [`${g.id}@${g.viewport ?? ""}`, g]));
      for (const gate of summary.gates) {
        const earlier = beforeGates.get(`${gate.id}@${gate.viewport ?? ""}`);
        const label = `${stage}/${gate.id}${gate.viewport ? `@${gate.viewport}` : ""}`;
        if (!earlier) add(site, `gate ${label}: only in the second run`);
        else if (isCoverageGate(gate.id) ? earlier.value !== gate.value : earlier.pass !== gate.pass)
          add(site, `gate ${label}: ${String(earlier.pass)} -> ${String(gate.pass)}`);
      }
      for (const key of GENERATED_ARTIFACTS) {
        const a = before.artifacts[key];
        const b = summary.artifacts[key];
        if (!a || !b) continue;
        for (const file of diffTrees(a, b)) add(site, `${stage}/${key}/${file}`);
      }
    }
  }
  return { ok: Object.keys(differing).length === 0, differing };
}

/** `<site>/reproducibility.json`, which the collector turns into `NONDETERMINISTIC` findings (§4.2). */
export function writeReproducibility(
  paths: AutopilotPaths,
  cycle: number,
  report: ReproducibilityReport,
): void {
  for (const [site, differing] of Object.entries(report.differing))
    writeJson(join(paths.siteDir(cycle, site), "reproducibility.json"), { differing });
}
