/**
 * `autopilot clean --keep N` (§3.3): drop old cycle folders, keep snapshots and reports. The files of an older cycle
 * that remain are the ones a person reads afterwards; everything regenerable (apps, screenshots, logs) goes.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AutopilotPaths } from "./types.js";

/** Kept in every cycle, at the cycle level and in the site and stage folders. */
const KEPT_FILES = new Set([
  "REPORT.md",
  "report.json",
  "index.html",
  "FINDINGS.md",
  "findings.json",
  "matrix.json",
  "summary.json",
]);
/** Removed whole: an app's own index.html is not a report. */
const REMOVED_DIRS = new Set(["project", "screens", "out"]);

export interface CleanResult {
  kept: number[];
  cleaned: number[];
  bytesFreed: number;
}

function sizeOf(path: string): number {
  const info = statSync(path);
  if (!info.isDirectory()) return info.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}

function clean(dir: string): number {
  let freed = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (REMOVED_DIRS.has(name)) {
        freed += sizeOf(full);
        rmSync(full, { recursive: true, force: true });
      } else {
        freed += clean(full);
        if (!readdirSync(full).length) rmSync(full, { recursive: true, force: true });
      }
    } else if (!KEPT_FILES.has(name)) {
      freed += info.size;
      rmSync(full, { force: true });
    }
  }
  return freed;
}

export function cleanCycles(paths: AutopilotPaths, keep: number): CleanResult {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a positive whole number");
  const root = join(paths.state, "cycles");
  if (!existsSync(root)) return { kept: [], cleaned: [], bytesFreed: 0 };
  const cycles = readdirSync(root)
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
  const kept = cycles.slice(-keep);
  const cleaned = cycles.slice(0, -keep);
  let bytesFreed = 0;
  for (const cycle of cleaned) bytesFreed += clean(join(root, String(cycle)));
  return { kept, cleaned, bytesFreed };
}
