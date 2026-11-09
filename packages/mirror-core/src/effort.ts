/**
 * S5 human-effort log: `effort.jsonl`, one JSON object per manual intervention.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Workspace } from "./workspace.js";

export const EFFORT_PATH = "effort.jsonl";

export interface EffortInput {
  step: string;
  minutes: number;
  note?: string;
  who?: string;
}
export interface EffortEntry extends EffortInput {
  ts: string;
}

export async function logEffort(ws: Workspace, e: EffortInput): Promise<EffortEntry> {
  if (!e.step) throw new Error("logEffort: step is required");
  if (!Number.isFinite(e.minutes) || e.minutes < 0) throw new Error(`logEffort: minutes must be a non-negative number (got ${e.minutes})`);
  const entry: EffortEntry = { ts: new Date().toISOString(), step: e.step, minutes: e.minutes, ...(e.note ? { note: e.note } : {}), ...(e.who ? { who: e.who } : {}) };
  const p = ws.path(EFFORT_PATH);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

export async function readEffort(ws: Workspace): Promise<EffortEntry[]> {
  let text: string;
  try {
    text = await readFile(ws.path(EFFORT_PATH), "utf8");
  } catch {
    return [];
  }
  const out: EffortEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as EffortEntry;
      if (typeof e.step === "string" && typeof e.minutes === "number") out.push(e);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Minutes per step + total. */
export function summarizeEffort(entries: EffortEntry[]): { byStep: Record<string, number>; totalMinutes: number; count: number } {
  const byStep: Record<string, number> = {};
  for (const e of entries) byStep[e.step] = (byStep[e.step] ?? 0) + e.minutes;
  return { byStep, totalMinutes: entries.reduce((n, e) => n + e.minutes, 0), count: entries.length };
}
