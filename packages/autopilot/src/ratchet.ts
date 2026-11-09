/** Raising the bar (§6.4): the design-system coverage target climbs after every cycle in which every site passes it. */
import type { AutopilotConfig, MatrixResult, StageSummary } from "./types.js";

export const isCoverageGate = (id: string): boolean => /\bcoverage\b/i.test(id);

/** Whether `site` passed the coverage gate; `null` when the stage that reports it did not run. */
function siteCoverage(matrix: MatrixResult, site: string): boolean | null {
  const stages = Object.values(matrix.sites[site] ?? {}) as (StageSummary | undefined)[];
  const gates = stages.flatMap((summary) => summary?.gates ?? []).filter((gate) => isCoverageGate(gate.id));
  return gates.length ? gates.every((gate) => gate.pass) : null;
}

export interface RatchetResult {
  target: number;
  raised: boolean;
}

/**
 * The next target. Raised by `step`, capped at `max`, only when every matrix site reported the gate and passed it: a
 * cycle that ran `--stages mirror` says nothing about coverage.
 */
export function ratchetCoverage(
  current: number,
  coverage: AutopilotConfig["coverage"],
  matrix: MatrixResult,
  siteIds: string[],
): RatchetResult {
  if (current >= coverage.max || !siteIds.length)
    return { target: Math.min(current, coverage.max), raised: false };
  const allPass = siteIds.every((site) => siteCoverage(matrix, site) === true);
  if (!allPass) return { target: current, raised: false };
  // Rounded so repeated steps of 0.1 stay readable in state.json and report tables.
  const target = Math.min(coverage.max, Math.round((current + coverage.step) * 1000) / 1000);
  return { target, raised: target > current };
}
