/**
 * The accept rule of §5.2, over a whole matrix: `decide` from `@harness/mirror-fix` (regressions first, then
 * improvement), with "primary metric" = hard gates passing minus the occurrences of the signature being fixed, and
 * "regression" = any gate going pass → fail against the baseline.
 *
 * A gate or stage that no longer reports counts as a failure here. In the one-run loop of mirror-fix a missing gate is
 * ignored; across a matrix, a fix that crashes a stage would otherwise look clean.
 */
import { decide, regressions, type Metrics } from "@harness/mirror-fix";
import type { Finding, FindingsFile, MatrixResult, StageSummary } from "./types.js";

export interface DecideScope {
  /** Compare only the site/stage pairs the candidate ran (the fast lane); default is the whole baseline. */
  candidateOnly?: boolean;
}

export const gateKey = (site: string, stage: string, gate: { id: string; viewport?: string }): string =>
  `${site}/${stage}/${gate.id}${gate.viewport ? `@${gate.viewport}` : ""}`;

const stageKey = (site: string, stage: string): string => `${site}/${stage}/stage.ok`;

/** Every gate of the matrix, plus one per stage for whether it ran to the end. */
export function matrixGates(matrix: MatrixResult): Record<string, boolean> {
  const gates: Record<string, boolean> = {};
  for (const [site, stages] of Object.entries(matrix.sites)) {
    for (const [stage, summary] of Object.entries(stages) as [string, StageSummary | undefined][]) {
      if (!summary || summary.status === "skipped") continue;
      gates[stageKey(site, stage)] = summary.status === "passed";
      for (const gate of summary.gates) gates[gateKey(site, stage, gate)] = gate.pass;
    }
  }
  return gates;
}

export function hardGatesPassing(matrix: MatrixResult): number {
  let passing = 0;
  for (const stages of Object.values(matrix.sites))
    for (const summary of Object.values(stages))
      for (const gate of summary?.gates ?? []) if (gate.hard && gate.pass) passing++;
  return passing;
}

/** A copy of `matrix` with only the site/stage pairs `scope` ran. */
function restrictedTo(matrix: MatrixResult, scope: MatrixResult): MatrixResult {
  const sites: MatrixResult["sites"] = {};
  for (const [site, stages] of Object.entries(matrix.sites)) {
    const ran = scope.sites[site];
    if (!ran) continue;
    sites[site] = Object.fromEntries(Object.entries(stages).filter(([stage]) => stage in ran));
  }
  return { ...matrix, sites };
}

function occurrences(findings: FindingsFile, signature: string, sites: string[]): string[] {
  const hit = findings.findings.filter((f) => f.signature === signature && f.status !== "fixed");
  const where = new Set(hit.flatMap((f) => f.sites));
  return sites.filter((site) => where.has(site));
}

const pipelineBugs = (findings: FindingsFile): Finding[] =>
  findings.findings.filter((f) => f.code === "PIPELINE_BUG" && f.status !== "fixed");

export interface CandidateInput {
  baseline: MatrixResult;
  candidate: MatrixResult;
  /** The findings of the candidate's run. */
  findings: FindingsFile;
  /** The findings the baseline already had, so only new `PIPELINE_BUG`s count. */
  baselineFindings?: FindingsFile;
  target: { signature: string; sites: string[] };
  scope?: DecideScope;
}

export interface CandidateDecision {
  accepted: boolean;
  reason: string;
  regressions: string[];
}

/** Accept iff no gate went pass → fail, the signature is gone where it appeared, and no new `PIPELINE_BUG` showed up. */
export function decideCandidate(input: CandidateInput): CandidateDecision {
  const { candidate, findings, target, scope } = input;
  const baseline = scope?.candidateOnly ? restrictedTo(input.baseline, candidate) : input.baseline;
  const sites = scope?.candidateOnly ? target.sites.filter((site) => site in candidate.sites) : target.sites;

  const beforeGates = matrixGates(baseline);
  const reported = matrixGates(candidate);
  const afterGates = { ...reported };
  for (const key of Object.keys(beforeGates)) if (!(key in reported)) afterGates[key] = false;

  const still = occurrences(findings, target.signature, sites);
  const before: Metrics = { primary: hardGatesPassing(baseline) - sites.length, gates: beforeGates };
  const after: Metrics = { primary: hardGatesPassing(candidate) - still.length, gates: afterGates };
  const regressed = regressions(before, after);
  if (regressed.length)
    return { accepted: false, reason: decide(before, after).reason, regressions: regressed };

  if (still.length)
    return {
      accepted: false,
      reason: `signature ${target.signature} still present on ${still.join(", ")}`,
      regressions: [],
    };

  const known = new Set(
    pipelineBugs(input.baselineFindings ?? { cycle: 0, findings: [] }).map((f) => f.signature),
  );
  const bugs = pipelineBugs(findings).filter((f) => !known.has(f.signature));
  if (bugs.length)
    return {
      accepted: false,
      reason: `new PIPELINE_BUG: ${bugs.map((f) => f.signature).join(", ")}`,
      regressions: [],
    };

  const verdict = decide(before, after);
  return { ...verdict, regressions: [] };
}

/** Hard gates that fail in a matrix: `green` needs none. */
export function failingHardGates(matrix: MatrixResult): string[] {
  const failing: string[] = [];
  for (const [site, stages] of Object.entries(matrix.sites)) {
    for (const [stage, summary] of Object.entries(stages) as [string, StageSummary | undefined][]) {
      if (!summary || summary.status === "skipped") continue;
      if (summary.status !== "passed") failing.push(`${stageKey(site, stage)}=${summary.status}`);
      for (const gate of summary.gates) if (gate.hard && !gate.pass) failing.push(gateKey(site, stage, gate));
    }
  }
  return failing.sort();
}
