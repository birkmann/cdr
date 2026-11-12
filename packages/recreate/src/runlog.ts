// The log of a run, in its folder: `logs/run.log` (one line per step, wall clock and time since the start) and
// `logs/events.jsonl` (every progress event as it was sent, timed), appended by every invocation of the run (a resumed
// run adds its own block). Nothing is written before the run folder may exist (a new run before consent): lines wait.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RecreateProgress } from "./pipeline.js";
import type { RunDir, RunManifest } from "./manifest.js";

/** keys whose values never reach a log (provider keys, tokens, passwords) */
const SECRET_KEY = /key|token|secret|password|authorization|cookie/i;

/** a value without its secrets (by key name), for a log line */
export function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : scrub(x)]),
    );
  return v;
}

export const secs = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(1)}s`
    : `${(ms / 1000).toFixed(1)}s`;

export class RunLog {
  readonly t0 = Date.now();
  private pending: string[][] = [];
  private open = false;

  constructor(private readonly dir: RunDir) {}

  /** from now on lines go to the run folder (the ones waiting first) */
  start(): void {
    if (this.open) return;
    this.open = true;
    for (const [file, text] of this.pending) this.append(file!, text!);
    this.pending = [];
  }

  private append(file: string, text: string): void {
    if (!this.open) {
      this.pending.push([file, text]);
      return;
    }
    try {
      const p = this.dir.path(file);
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, text);
    } catch {
      /* a log that cannot be written never breaks the run */
    }
  }

  /** ms since this invocation started */
  elapsed(): number {
    return Date.now() - this.t0;
  }

  line(message: string): void {
    // local wall clock (the header says the zone)
    const d = new Date();
    const at = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    const el = `+${(this.elapsed() / 1000).toFixed(1)}s`.padStart(8);
    const text = message
      .split("\n")
      .map((l, i) => (i ? `${" ".repeat(23)}${l}` : `${at} ${el}  ${l}`))
      .join("\n");
    this.append("logs/run.log", `${text}\n`);
  }

  event(e: RecreateProgress): void {
    this.append(
      "logs/events.jsonl",
      `${JSON.stringify({ at: new Date().toISOString(), ms: this.elapsed(), ...(scrub(e) as object) })}\n`,
    );
    const d = describe(e);
    if (d) this.line(d);
  }

  /** the timing of the run: every stage's time, the invocation's and the run's total, and where the time went */
  summary(m: RunManifest, order: string[]): string {
    const rows = order
      .filter((s) => m.stages[s as keyof typeof m.stages])
      .map((s) => {
        const r = m.stages[s as keyof typeof m.stages]!;
        return `  ${s.padEnd(11)} ${(r.ms !== undefined ? secs(r.ms) : "-").padStart(9)}  ${r.status}${r.detail ? `  ${r.detail.slice(0, 160)}` : ""}`;
      });
    const total = Object.values(m.stages).reduce((n, r) => n + (r?.ms ?? 0), 0);
    return [
      `timing (${m.status ?? "?"}): this invocation ${secs(this.elapsed())}, stages in total ${secs(total)}`,
      ...rows,
    ].join("\n");
  }
}

/** a progress event as one readable line (null: nothing to say beyond the JSON) */
function describe(e: RecreateProgress): string | null {
  switch (e.type) {
    case "recreate.started":
      return `started ${e.url} → ${e.targets.join(", ")}${e.widths.length ? ` at ${e.widths.join("/")} px` : ""} (${e.dir})`;
    case "recreate.consent":
      return `consent: ${e.consent.by} (${e.consent.mode})`;
    case "recreate.stage":
      return e.status === "running"
        ? `▶ ${e.stage}`
        : `${e.status === "done" ? "✓" : e.status === "skipped" ? "–" : "✗"} ${e.stage} ${e.ms !== undefined ? secs(e.ms) : ""}${e.detail ? `  ${e.detail}` : ""}${e.skipped?.length ? `\n  skipped: ${e.skipped.join("; ")}` : ""}`;
    case "recreate.section":
      return `section ${e.index + 1}/${e.total} ${e.id} (${e.kind}) ${e.status}${e.pixel !== undefined ? ` pixel ${(e.pixel * 100).toFixed(2)} %` : ""}${e.text ? ` text ${e.text}` : ""}${e.reason ? ` [${e.reason}]` : ""}${e.reverted ? " reverted" : ""}`;
    case "recreate.shot":
      return `${e.kind} shot ${e.width}×${e.height}  ${e.path}`;
    case "recreate.measured":
      return [
        `measured ${e.target}`,
        ...e.widths.map(
          (w) =>
            `  ${String(w.width).padStart(4)}px  pixel ${(w.pixel * 100).toFixed(2)} %  text ${w.textReal ?? 0} (${w.textDrift ?? 0} drift)  height ${w.height?.out ?? "?"}/${w.height?.live ?? "?"}px${w.hscroll ? "  sideways scroll" : ""}`,
        ),
        ...e.gates.map((g) => `  ${g.pass ? "✓" : "✗"} ${g.name}  ${(g.detail ?? "").slice(0, 300)}`),
      ].join("\n");
    case "recreate.components":
      return `components: ${e.sets.length} set(s), lint ${e.lint.pass ? "ok" : `${e.lint.issues.length} issue(s)`}`;
    case "recreate.finished":
      return `finished ${e.status}: ${e.summary ?? ""}${e.outputs.length ? `\n  outputs: ${e.outputs.map((o) => `${o.target} ${o.path}`).join(", ")}` : ""}`;
    default:
      return null;
  }
}
