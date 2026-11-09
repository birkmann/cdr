/**
 * workspace/<site>/TASKS.md — machine-maintained checklist of actionable issues (MIGRATION_PLAN.md §10).
 *
 * Every item carries a stable id (`<!-- task:<id> -->`) derived from step + code + ref (or message when no ref),
 * so re-running `migrate report` keeps the list stable and agents can tick items (`- [x]`).
 * Rewrite rules:
 *  - reported + not ticked                → Open
 *  - reported + ticked by an agent/human  → Reopened (the last run still reports it: the fix did not verify)
 *  - not reported anymore                 → Done (kept as history, ticked)
 */
import { createHash } from "node:crypto";
import type { Issue } from "./contracts.js";
import type { Workspace } from "./workspace.js";

export const TASKS_PATH = "TASKS.md";

export type TaskIssue = Issue & { step?: string };

export interface TaskItem {
  id: string;
  step?: string;
  code: string;
  ref?: string;
  message: string;
  severity: Issue["severity"];
  count: number;
  /** who works the item: autofix handler id, "pipeline-bug", "deterministic" or "human" (WriteTasksOptions.owner) */
  owner?: string;
}

export function taskId(i: TaskIssue): string {
  const basis = [i.step ?? "", i.code, i.ref ? `ref:${i.ref}` : `msg:${i.message}`].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 12);
}

const LINE = /^- \[( |x|X)\] (.*?)\s*<!-- task:([0-9a-f]{6,64}) -->\s*$/;

/** Parse an existing TASKS.md into id → { checked, line text }. */
export function parseTasks(md: string): Map<string, { checked: boolean; text: string }> {
  const out = new Map<string, { checked: boolean; text: string }>();
  for (const line of md.split("\n")) {
    const m = LINE.exec(line.trim());
    if (m) out.set(m[3], { checked: m[1] !== " ", text: m[2] });
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/<!--/g, "<!_-").trim();
}

function renderItem(t: TaskItem, checked: boolean, suffix = ""): string {
  const where = t.ref ? ` \`${esc(t.ref)}\`` : "";
  const step = t.step ? `[${t.step}] ` : "";
  const count = t.count > 1 ? ` (×${t.count})` : "";
  const owner = t.owner ? ` · _${esc(t.owner)}_` : "";
  return `- [${checked ? "x" : " "}] ${step}**${t.code}**${where} — ${esc(t.message)}${count}${owner}${suffix} <!-- task:${t.id} -->`;
}

export interface WriteTasksResult {
  path: string;
  open: number;
  reopened: number;
  done: number;
}

/**
 * Regenerate TASKS.md from the full current set of issues (only `actionable` ones become tasks; errors are
 * always actionable unless `actionable: false` is set explicitly). Pass ALL steps' issues — items missing from
 * `issues` are moved to Done.
 */
export interface WriteTasksOptions {
  title?: string;
  /** owner per issue code (autofix handler id, "pipeline-bug", "human" …), rendered after the message */
  owner?: (i: TaskIssue) => string | undefined;
}

export async function writeTasks(ws: Workspace, issues: TaskIssue[], opts: WriteTasksOptions = {}): Promise<WriteTasksResult> {
  const items = new Map<string, TaskItem>();
  for (const i of issues) {
    const actionable = i.actionable ?? i.severity === "error";
    if (!actionable) continue;
    const id = taskId(i);
    const existing = items.get(id);
    if (existing) existing.count++;
    else items.set(id, { id, step: i.step, code: i.code, ref: i.ref, message: i.message, severity: i.severity, count: 1, owner: opts.owner?.(i) });
  }

  let previous = new Map<string, { checked: boolean; text: string }>();
  try {
    previous = parseTasks(await ws.readText(TASKS_PATH));
  } catch {
    /* first run */
  }

  const sevRank = (s: Issue["severity"]) => (s === "error" ? 0 : s === "warning" ? 1 : 2);
  const sorted = [...items.values()].sort(
    (a, b) => (a.step ?? "").localeCompare(b.step ?? "") || sevRank(a.severity) - sevRank(b.severity) || a.code.localeCompare(b.code) || (a.ref ?? "").localeCompare(b.ref ?? "") || a.id.localeCompare(b.id),
  );
  const open = sorted.filter((t) => !previous.get(t.id)?.checked);
  const reopened = sorted.filter((t) => previous.get(t.id)?.checked);
  const done = [...previous.entries()].filter(([id]) => !items.has(id));

  const lines = [
    `# TASKS — ${opts.title ?? ws.site}`,
    "",
    "<!-- Machine-maintained by `pnpm migrate report <site>`. Work items top-down, one at a time. -->",
    "<!-- Tick an item (`- [x]`) when fixed, then re-run the step's check + `migrate report`; the ids are stable. -->",
    "",
    `Open: ${open.length} · Reopened: ${reopened.length} · Done: ${done.length}`,
    "",
    "## Open",
    "",
    ...(open.length ? open.map((t) => renderItem(t, false)) : ["_nothing open_"]),
    "",
  ];
  if (reopened.length) {
    lines.push("## Reopened (ticked, but still reported by the last run)", "", ...reopened.map((t) => renderItem(t, false, " _(reopened)_")), "");
  }
  lines.push("## Done", "");
  if (done.length) {
    for (const [id, prev] of done) {
      const text = prev.text.replace(/\s*_\((reopened|resolved)\)_\s*$/, "");
      lines.push(`- [x] ${text} <!-- task:${id} -->`);
    }
  } else lines.push("_none yet_");
  lines.push("");

  await ws.writeText(TASKS_PATH, lines.join("\n"));
  return { path: TASKS_PATH, open: open.length, reopened: reopened.length, done: done.length };
}
