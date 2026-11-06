import { useEffect, useState } from "react";
import type { DiffLine } from "./ipc";

/** One row of a side-by-side diff: the old line on the left, the new one on the right. */
export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/**
 * Pairs a hunk's lines for side-by-side display. Context lines sit on both
 * sides; a run of deletions followed by a run of additions is laid out row by
 * row, so a changed line faces its replacement, and the shorter side is padded.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === "context") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}

// ------------------------------------------------------------------ preference

export type DiffMode = "unified" | "split";
const KEY = "cdr.studio.diff-mode";
const EVENT = "studio:diff-mode";

export function getDiffMode(): DiffMode {
  try {
    return localStorage.getItem(KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

export function setDiffMode(mode: DiffMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage unavailable: the choice lasts for this window */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

/** Current diff layout; every open diff re-renders when it changes. */
export function useDiffMode(): DiffMode {
  const [mode, setMode] = useState(getDiffMode);
  useEffect(() => {
    const h = (e: Event) => setMode((e as CustomEvent<DiffMode>).detail);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return mode;
}
