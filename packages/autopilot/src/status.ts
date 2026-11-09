// `autopilot status`: cycle, stage, per-site gates, spent budget and running goals (plan §3.3).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonOr, readMatrix, readSummaries, siteDirsOf } from "./collect.js";
import { STAGE_ORDER, type AutopilotPaths, type LoopState } from "./types.js";

/** The newest cycle number with a folder, 0 when there is none. */
export function latestCycle(paths: Pick<AutopilotPaths, "state">): number {
  const dir = join(paths.state, "cycles");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .reduce((max, n) => Math.max(max, n), 0);
}

export interface StatusReport {
  text: string;
  /** `status` exits 0 only when the newest cycle is green (plan §3.3). */
  green: boolean;
  cycle: number;
}

export function readLoopState(paths: Pick<AutopilotPaths, "state">): LoopState | undefined {
  return readJsonOr<LoopState | undefined>(join(paths.state, "state.json"), undefined);
}

export function autopilotStatus(paths: AutopilotPaths): StatusReport {
  const state = readLoopState(paths);
  const lines: string[] = [];
  if (state) {
    lines.push(`loop: ${state.status} at ${state.step} · cycle ${state.cycle}`);
    lines.push(`spent: $${state.spentUsd.toFixed(2)} · green streak ${state.greenStreak}`);
    if (state.goals.length) lines.push(`goals: ${state.goals.join(", ")}`);
  } else lines.push("loop: not started");
  const cycle = latestCycle(paths);
  if (!cycle) {
    lines.push("cycles: none yet");
    return { text: `${lines.join("\n")}\n`, green: false, cycle: 0 };
  }
  const matrix = readMatrix(paths, cycle);
  let green = !!matrix && Object.keys(matrix.sites).length > 0;
  lines.push(`cycle ${cycle}${matrix ? ` · commit ${matrix.commit}` : " · no matrix result yet"}`);
  for (const site of siteDirsOf(paths, cycle)) {
    const summaries = readSummaries(paths, cycle, site);
    const parts = STAGE_ORDER.flatMap((stage) => {
      const s = summaries[stage];
      if (!s) return [];
      const hard = s.gates.filter((g) => g.hard);
      const failing = hard.filter((g) => !g.pass).length;
      return [`${stage} ${s.status} (${hard.length - failing}/${hard.length} hard gates)`];
    });
    if (Object.values(summaries).some((s) => s?.status !== "passed")) green = false;
    lines.push(`  ${site}: ${parts.join(" · ") || "no stage finished"}`);
  }
  return { text: `${lines.join("\n")}\n`, green, cycle };
}
