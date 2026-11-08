// Repair attempts of a recreation, enforced here rather than left to the model's reading of the skill: every
// `recreate_measure` is scored against the best one so far, a version that measures worse is replaced by the best
// one, and measuring stops being useful (then possible) once repairs stop improving the page.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import type { EventBody } from "@harness/protocol";
import type { MeasureReport } from "@harness/measure";
import type { RunDir } from "@harness/recreate";

/** The target repairs touch (recreate_section / patch_file work on out/static). */
const TARGET = "static";
/** Measures in a row without improving on the best one before the agent is told to stop and report. */
export const STOP_AFTER_STALE = 2;
/** ... and before recreate_measure refuses to run again (recreate_build starts over). */
export const REFUSE_AFTER_STALE = 4;
/** These gates are never traded for pixels at the captured widths. */
const NEVER_TRADED = ["responsive", "flow"];

export interface MeasureScore {
  /** failing gate names */
  failing: string[];
  /** failing widths of the responsive sweep / widths checked (the in-between widths rotate per measure) */
  sweepFail: number;
  sweepTotal: number;
  /** sum of the pixel difference at the captured widths */
  pixel: number;
}

interface Entry {
  n: number;
  at: string;
  score: MeasureScore;
  verdict: Verdict;
}
interface History {
  best?: number;
  entries: Entry[];
}
export type Verdict = "first" | "better" | "same" | "worse";

export function scoreOf(rep: MeasureReport): MeasureScore {
  const sweep = rep.sweep ?? [];
  return {
    failing: rep.gates.filter((g) => !g.pass).map((g) => g.name),
    sweepFail: sweep.filter((c) => !c.pass).length,
    sweepTotal: sweep.length,
    pixel: rep.widths.reduce((s, w) => s + w.pixel, 0),
  };
}

const frac = (s: MeasureScore) => (s.sweepTotal ? s.sweepFail / s.sweepTotal : 0);

/** <0: a is better than b, >0: worse, 0: the same within noise. */
export function compareScores(a: MeasureScore, b: MeasureScore): number {
  // a responsive or flow gate that newly fails is worse, whatever the pixels did
  if (NEVER_TRADED.some((g) => a.failing.includes(g) && !b.failing.includes(g))) return 1;
  if (NEVER_TRADED.some((g) => b.failing.includes(g) && !a.failing.includes(g))) return -1;
  if (a.failing.length !== b.failing.length) return a.failing.length - b.failing.length;
  // the in-between widths differ per measure: a few widths either way is noise
  const d = frac(a) - frac(b);
  if (Math.abs(d) > 0.03) return d;
  const p = a.pixel - b.pixel;
  if (Math.abs(p) > Math.max(0.002, 0.05 * b.pixel)) return p;
  return 0;
}

/** beside measure/<target>, so restoring that folder keeps the history */
const historyPath = "measure/history.json";

function readHistory(dir: RunDir): History {
  try {
    if (dir.exists(historyPath)) {
      const h = dir.readJson<History>(historyPath);
      if (Array.isArray(h?.entries)) return h;
    }
  } catch {
    /* a model can write the run folder; an unreadable history starts over */
  }
  return { entries: [] };
}

/** The best version's copy: the output's own files (not the captured assets), its measure folder and compare page. */
const BEST = "best";
function copyVersion(dir: RunDir, to: "best" | "live"): void {
  const pairs: [string, string][] = [
    [`measure/${TARGET}`, `${BEST}/measure`],
    ["compare", `${BEST}/compare`],
  ];
  const outDir = dir.path(`out/${TARGET}`);
  const files =
    to === "best"
      ? existsSync(outDir)
        ? readdirSync(outDir).filter((f) => statSync(`${outDir}/${f}`).isFile())
        : []
      : existsSync(dir.path(`${BEST}/out`))
        ? readdirSync(dir.path(`${BEST}/out`))
        : [];
  for (const f of files) pairs.push([`out/${TARGET}/${f}`, `${BEST}/out/${f}`]);
  if (to === "best") rmSync(dir.path(BEST), { recursive: true, force: true });
  for (const [live, best] of pairs) {
    const [from, dest] = to === "best" ? [live, best] : [best, live];
    if (!dir.exists(from)) continue;
    if (statSync(dir.path(from)).isDirectory()) rmSync(dir.path(dest), { recursive: true, force: true });
    cpSync(dir.path(from), dir.path(dest), { recursive: true });
  }
}

/** recreate_build wrote a new output: earlier measures and the best copy no longer describe it. */
export function resetAttempts(dir: RunDir): void {
  rmSync(dir.path(BEST), { recursive: true, force: true });
  rmSync(dir.path(historyPath), { force: true });
}

/** Whether another measure is allowed, or the text that refuses it. */
export function measureRefusal(dir: RunDir): string | null {
  const h = readHistory(dir);
  const stale = staleCount(h);
  if (stale < REFUSE_AFTER_STALE) return null;
  return (
    `The last ${stale} measures of this run did not improve on measure #${h.best}, which is in place. ` +
    "Stop repairing and give the user the summary (recreate-url skill). Only if the user asks for a fresh attempt: recreate_build rebuilds the page from the capture and starts the measures over."
  );
}

const staleCount = (h: History) => {
  let n = 0;
  for (let i = h.entries.length - 1; i >= 0 && h.entries[i]!.n !== h.best; i--) n++;
  return n;
};

export interface Attempt {
  n: number;
  verdict: Verdict;
  best: number;
  bestScore: MeasureScore;
  stale: number;
  /** the output was put back to the best version */
  restored: boolean;
}

/** Record a measure of the static target; keep a copy of the best version and put it back over a worse one. */
export function recordMeasure(dir: RunDir, rep: MeasureReport): Attempt {
  const h = readHistory(dir);
  const score = scoreOf(rep);
  const n = (h.entries.at(-1)?.n ?? 0) + 1;
  const best = h.entries.find((e) => e.n === h.best);
  const haveCopy = dir.exists(`${BEST}/out`);
  let verdict: Verdict;
  if (!best || !haveCopy) verdict = "first";
  else {
    const c = compareScores(score, best.score);
    verdict = c < 0 ? "better" : c > 0 ? "worse" : "same";
  }
  let restored = false;
  if (verdict === "first" || verdict === "better") {
    copyVersion(dir, "best");
    h.best = n;
  } else if (verdict === "worse") {
    copyVersion(dir, "live");
    restored = true;
  }
  h.entries.push({ n, at: new Date().toISOString(), score, verdict });
  dir.writeJson(historyPath, h);
  const bestEntry = h.entries.find((e) => e.n === h.best)!;
  return { n, verdict, best: h.best!, bestScore: bestEntry.score, stale: staleCount(h), restored };
}

/**
 * After a restore: the best version's report as a `recreate.measured` event, so the conversation shows the numbers
 * of the page that is in place; the manifest's gates follow it.
 */
export function restoredMeasured(dir: RunDir): EventBody | null {
  let rep: MeasureReport;
  try {
    rep = dir.readJson<MeasureReport>(`measure/${TARGET}/report.json`);
  } catch {
    return null;
  }
  const gates = rep.gates.map((g) => ({ name: g.name, pass: g.pass, detail: g.detail }));
  try {
    const m = dir.manifest();
    dir.saveManifest({ ...m, gates });
  } catch {
    /* the event still corrects the conversation */
  }
  return {
    type: "recreate.measured",
    runId: dir.id,
    target: TARGET,
    widths: rep.widths.map((w) => ({
      width: w.width,
      pixel: w.pixel,
      textReal: w.textReal,
      textDrift: w.textDrift,
      height: { live: w.liveHeight, out: w.outHeight },
      hscroll: w.hscroll,
    })),
    gates,
    comparePath: dir.rel("compare/index.html"),
  };
}

const describe = (s: MeasureScore) =>
  `${s.failing.length ? `failing ${s.failing.join(", ")}` : "all gates pass"}; ${s.sweepFail} of ${s.sweepTotal} in-between widths fail; pixel sum ${(s.pixel * 100).toFixed(2)} %`;

/** The lines that tell the agent where the run stands and what to do next. */
export function attemptLines(a: Attempt, pass: boolean): string[] {
  if (pass) return ["Next: every gate passes. Give the user the summary (recreate-url skill)."];
  const lines: string[] = [];
  if (a.verdict === "first")
    return [
      "Next: give the user the summary (recreate-url skill) and stop. Repair only when the user asked for the failing gates to be fixed; " +
        `then recreate_section → patch_file → recreate_measure, at most two attempts per section. A measure that is worse than the best one puts the best one back; after ${STOP_AFTER_STALE} measures without improvement, stop and report.`,
    ];
  if (a.verdict === "better")
    lines.push(`Measure #${a.n} is the best so far (${describe(a.bestScore)}); kept.`);
  if (a.verdict === "same")
    lines.push(`Measure #${a.n} is no better than measure #${a.best} (${describe(a.bestScore)}).`);
  if (a.restored)
    lines.push(
      `Measure #${a.n} is worse than measure #${a.best} (${describe(a.bestScore)}), so its output, measure files and compare page were put back to measure #${a.best}. ` +
        "The numbers above describe the undone patch; do not repeat it.",
    );
  if (a.stale >= STOP_AFTER_STALE)
    lines.push(
      `Next: ${a.stale} measures without improvement. Stop repairing and give the user the summary of measure #${a.best} (recreate-url skill).`,
    );
  else
    lines.push(
      "Next: the next section's repair, or the summary when each failing section had its two attempts.",
    );
  return lines;
}
