import type { SessionState } from "@harness/client";
import { basename } from "node:path";
import { homedir } from "node:os";
import { summarizeArgs } from "../render.js";
import { Canvas, theme as t, truncate, width, wrap, type Style } from "./screen.js";
import type { Editor } from "./input.js";

// Keep mode identity stable while idle, thinking, and waiting for approval.
const MODE_COLORS: Record<string, string> = {
  Chat: "#7dd3c8",
  Build: t.accent,
  Plan: "#82b1ff",
  "Quick fix": "#e5c07b",
  Review: "#c4a0ed",
};

export type Row = { text: string; style?: Style };
export interface PickerItem {
  label: string;
  detail?: string;
  value: string;
  disabled?: boolean;
}
export interface Picker {
  title: string;
  query: Editor;
  items: PickerItem[];
  selected: number;
  hint?: string;
}
export interface Dialog {
  title: string;
  body: string;
  actions: string[];
  selected: number;
  scroll: number;
  editor?: Editor;
  warning?: boolean;
  hint?: string;
}
export interface View {
  state: SessionState;
  editor: Editor;
  project: string;
  branch?: string | null;
  model: string;
  permission: string;
  mode: string;
  version: string;
  sessionId: string;
  busy: boolean;
  elapsed: number;
  frame: number;
  scroll: number;
  expanded: boolean;
  sidebar: boolean;
  notice?: string;
  attachments: string[];
  picker?: Picker;
  dialog?: Dialog;
  document?: { title: string; text: string; scroll: number };
}

const GLYPHS: Record<string, string[]> = {
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
};
export const WORDMARK = Array.from({ length: 5 }, (_, row) =>
  [..."CDR"].map((c) => GLYPHS[c][row]).join("  "),
);
const spin = ["◐", "◓", "◑", "◒"];
const thinkingFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const thinkingSpinner = (frame: number) => thinkingFrames[frame % thinkingFrames.length];

function markdown(text: string, columns: number): Row[] {
  const rows: Row[] = [];
  let code = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      code = !code;
      rows.push({
        text: code ? `  ${line.replace(/^\s*```/, "") || "code"}` : "",
        style: { fg: t.muted, bg: t.code },
      });
      continue;
    }
    const heading = !code && /^#{1,6}\s/.test(line);
    const content = code
      ? "  " + line
      : line
          .replace(/^#{1,6}\s/, "")
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1");
    const style = code ? { fg: t.blue, bg: t.code } : heading ? { fg: t.accent, bold: true } : undefined;
    for (const part of wrap(content, columns)) rows.push({ text: part, style });
  }
  return rows;
}

export function transcript(
  state: SessionState,
  columns: number,
  expanded: boolean,
  animation = { frame: 0, elapsed: 0 },
): Row[] {
  const rows: Row[] = [];
  const add = (text: string, style?: Style) =>
    wrap(text, columns).forEach((text) => rows.push({ text, style }));
  for (const item of state.timeline) {
    if (item.kind === "message") {
      const m = state.messages[item.id];
      if (!m) continue;
      const thinking = state.status === "running" && m.role === "assistant" && m.streaming && !m.text;
      if (!m.text && !m.reasoning && !thinking) continue;
      add("");
      add(
        m.role === "user"
          ? "  YOU"
          : `▸  CDR${m.agent && !["chat", "executor"].includes(m.agent) ? ` · ${m.agent}` : ""}`,
        { fg: m.role === "user" ? t.blue : t.accent, bold: true },
      );
      if (m.attachments?.length) add("  ↳ " + m.attachments.map((a) => a.name).join(" · "), { fg: t.muted });
      if (thinking || m.reasoning) {
        if (thinking) {
          // Fixed-width activity stays visible even when the provider pauses between chunks.
          const position = Math.floor(animation.frame / 2) % 10;
          const sweep = position < 6 ? position : 10 - position;
          const pulse = Array.from({ length: 6 }, (_, i) => (i === sweep ? "●" : "·")).join("");
          add(
            `  ${thinkingSpinner(animation.frame)} Thinking  ${pulse}  ·  ${animation.elapsed}s this turn`,
            { fg: t.accent, bold: true },
          );
          add(`    ctrl+t to ${expanded ? "collapse" : "show"} thoughts`, { fg: t.muted });
        } else add("  Thought process  ·  ctrl+t to expand", { fg: t.muted });
        if (expanded && m.reasoning)
          for (const part of wrap(m.reasoning.slice(-12000), columns - 2)) add("  " + part, { fg: t.muted });
      }
      if (m.role === "user") add(m.text, { fg: t.text, bg: t.panel });
      else rows.push(...markdown(m.text, columns));
      add("");
    } else if (item.kind === "tool") {
      const tool = state.tools[item.id];
      if (!tool) continue;
      const color = tool.status === "error" ? t.red : tool.status === "ok" ? t.green : t.accent;
      add(
        `${tool.status === "ok" ? "✓" : tool.status === "error" ? "✗" : "◌"} ${tool.name}  ${summarizeArgs(tool.args, Math.max(20, columns - 20))}`,
        { fg: color },
      );
      if (tool.diff) {
        const lines = tool.diff.split("\n");
        for (const line of lines.slice(0, expanded ? 160 : 8))
          add("  " + line, {
            fg: line.startsWith("+") ? t.green : line.startsWith("-") ? t.red : t.muted,
            bg: t.code,
          });
        if (lines.length > (expanded ? 160 : 8))
          add(`  … ${lines.length - (expanded ? 160 : 8)} more lines · ctrl+t details`, { fg: t.faint });
      } else if (tool.output) {
        const lines = tool.output.split("\n");
        for (const line of lines.slice(0, expanded || tool.status === "error" ? 80 : 1))
          add("  " + line, { fg: tool.status === "error" ? t.red : t.muted });
        if (!expanded && lines.length > 1)
          add(`  +${lines.length - 1} lines · ctrl+t details`, { fg: t.faint });
      }
    } else {
      const e = item.event;
      switch (e.type) {
        case "run.start":
          if (e.continuedFrom) add("↻ Continuing saved job · existing work retained", { fg: t.accent });
          break;
        case "phase.start":
          add(`\n── ${e.phase.toUpperCase()} ${"─".repeat(Math.max(0, columns - e.phase.length - 5))}`, {
            fg: t.faint,
          });
          break;
        case "error":
          add(`✗ ${e.message}`, { fg: t.red });
          break;
        case "log":
          add(`! ${e.message}`, { fg: t.accent });
          break;
        case "verify.result":
          add(`${e.exitCode === 0 ? "✓" : "✗"} ${e.kind}  ${e.command}`, {
            fg: e.exitCode === 0 ? t.green : t.red,
          });
          if (e.exitCode !== 0 || expanded) add(e.output.slice(-6000), { fg: t.muted });
          break;
        case "plan.proposed":
          add("\nPLAN", { fg: MODE_COLORS.Plan, bold: true });
          rows.push(...markdown(e.markdown, columns));
          break;
        case "plan.decision":
          add(
            `Plan ${e.decision === "approve" ? "approved" : e.decision === "edit" ? "edited and approved" : "rejected"}`,
            { fg: t.muted },
          );
          break;
        case "review.findings":
          add(e.summary || "Review", { fg: MODE_COLORS.Review });
          e.findings.forEach((f) =>
            add(`${f.severity} · ${f.file || ""} ${f.issue}`, {
              fg: f.severity === "blocking" ? t.red : t.muted,
            }),
          );
          break;
        case "preview.ready":
          add(`↗ Preview ready · ${e.title || e.path}\n  Open this conversation in CDR web to view it.`, {
            fg: t.green,
          });
          break;
        case "agent.spawned":
          add(
            `◆ subagent ${e.role} [${e.isolation}${e.branch ? ` · ${e.branch}` : ""}] ${e.task.split("\n")[0]}`,
            {
              fg: t.accent,
            },
          );
          break;
        case "agent.finished":
          add(`◆ subagent ${e.status}${e.summary ? ` · ${e.summary.split("\n")[0]}` : ""}`, {
            fg: e.status === "success" ? t.green : e.status === "failed" ? t.red : t.muted,
          });
          if (e.diffStat && expanded) add(e.diffStat, { fg: t.muted });
          break;
        case "goal.started":
          add(`◎ Goal ${e.title} · round ${e.round} · ${e.branch}`, { fg: t.accent, bold: true });
          break;
        case "goal.checkpoint":
          add(`◎ Checkpoint ${e.commit.slice(0, 10)} · ${e.step}`, { fg: t.green });
          e.criteria.forEach((x) =>
            add(`  ${x.met ? "✓" : "✗"} ${x.criterion}`, { fg: x.met ? t.green : t.red }),
          );
          break;
        case "goal.paused":
          add(`◎ Goal paused (${e.reason})${e.detail ? ` · ${e.detail}` : ""}`, { fg: t.accent });
          break;
        case "goal.finished":
          add(`◎ Goal ${e.status} · ${e.branch}`, { fg: e.status === "success" ? t.green : t.red });
          break;
        case "done":
          add(`\n${e.status === "success" ? "✓" : e.status === "cancelled" ? "■" : "✗"} ${e.status}`, {
            fg: e.status === "success" ? t.green : e.status === "failed" ? t.red : t.muted,
          });
          if (e.status !== "success")
            add("  /continue resumes this job from saved progress", { fg: t.muted });
          break;
      }
    }
  }
  return rows;
}

function drawRows(
  c: Canvas,
  rows: Row[],
  x: number,
  y: number,
  w: number,
  h: number,
  offset: number,
  bottom = true,
) {
  const start = bottom
    ? Math.max(0, rows.length - h - offset)
    : Math.min(offset, Math.max(0, rows.length - h));
  rows.slice(start, start + h).forEach((row, i) => {
    if (row.style?.bg) c.fill(x, y + i, w, 1, row.style.bg);
    c.text(x, y + i, row.text, row.style, w);
  });
}
function border(c: Canvas, x: number, y: number, w: number, h: number) {
  c.fill(x, y, w, h, t.panel);
  c.text(x, y, "╭" + "─".repeat(Math.max(0, w - 2)) + "╮", { fg: t.border });
  c.text(x, y + h - 1, "╰" + "─".repeat(Math.max(0, w - 2)) + "╯", { fg: t.border });
  for (let row = y + 1; row < y + h - 1; row++) {
    c.text(x, row, "│", { fg: t.border });
    c.text(x + w - 1, row, "│", { fg: t.border });
  }
}

export function renderView(v: View, columns: number, rows: number): Canvas {
  const c = new Canvas(Math.max(12, columns), Math.max(6, rows));
  const modeColor = MODE_COLORS[v.mode] ?? t.accent;
  columns = c.columns;
  rows = c.rows;
  if (columns < 36 || rows < 12) {
    c.center(1, "CDR", { fg: modeColor, bold: true });
    c.center(3, truncate("Resize to 36 × 12 or larger", columns));
    c.center(5, truncate("Ctrl+C / Ctrl+D to exit", columns), { fg: t.muted });
    return c;
  }
  const home = !v.state.timeline.some((i) => i.kind === "message");
  const side = !home && v.sidebar && columns >= 120 ? 29 : 0;
  const area = columns - side;
  const boxW = Math.min(home ? 78 : 104, area - 6);
  const x = Math.floor((area - boxW) / 2);
  const layout = v.editor.layout(boxW - 5);
  const inputH = Math.max(2, Math.min(layout.lines.length, Math.max(2, Math.min(6, Math.floor(rows / 4)))));
  const boxH = inputH + 3;
  let inputY = rows - boxH - 3;
  if (home && rows >= 24) {
    const logoY = Math.max(2, Math.floor((rows - 17) / 2));
    if (columns >= 48)
      WORDMARK.forEach((line, i) => c.center(logoY + i, line, { fg: i < 2 ? t.text : modeColor }));
    else c.center(logoY + 2, "C D R", { fg: modeColor, bold: true });
    c.center(logoY + 7, truncate("Code. Build. Ship.", columns - 4), { fg: t.muted });
    inputY = Math.min(rows - boxH - 4, logoY + 10);
  } else if (home) c.center(1, "▸  CDR", { fg: modeColor, bold: true });
  else {
    c.text(2, 1, "▸  CDR", { fg: modeColor, bold: true });
    c.text(
      15,
      1,
      truncate(
        v.state.title ||
          Object.values(v.state.messages).find((m) => m.role === "user")?.text ||
          "A new conversation",
        area - 37,
      ),
      { fg: t.text },
    );
    const status = v.dialog
      ? "Waiting for you"
      : v.busy
        ? `${spin[v.frame % spin.length]} ${v.state.phase || "working"} ${v.elapsed}s`
        : "ready";
    c.text(Math.max(16, area - width(status) - 2), 1, status, { fg: v.busy ? modeColor : t.muted });
    c.text(2, 2, "─".repeat(area - 4), { fg: t.border });
    const lines = transcript(v.state, boxW - 2, v.expanded, { frame: v.frame, elapsed: v.elapsed });
    drawRows(c, lines, x + 1, 3, boxW - 2, Math.max(1, inputY - 4), v.scroll);
    if (v.scroll) c.text(x + boxW - 24, inputY - 1, "↑ scrollback · End latest", { fg: modeColor });
  }
  c.fill(x, inputY, boxW, boxH, t.panel);
  for (let y = inputY; y < inputY + boxH; y++) c.text(x, y, "▎", { fg: modeColor });
  const start = Math.max(0, layout.y - inputH + 1);
  if (v.editor.text)
    layout.lines
      .slice(start, start + inputH)
      .forEach((line, i) => c.text(x + 2, inputY + 1 + i, line, {}, boxW - 4));
  else
    c.text(
      x + 2,
      inputY + 1,
      truncate(
        v.busy
          ? `${thinkingSpinner(v.frame)} ${Object.values(v.state.messages).some((m) => m.role === "assistant" && m.streaming && !m.text) ? "Thinking" : "Working"}…  ${v.elapsed}s · Esc to cancel`
          : home
            ? "What would you like to build?"
            : "Continue the conversation…",
        boxW - 4,
      ),
      { fg: v.busy ? modeColor : t.faint },
    );
  const model = v.model.split("/").slice(1).join("/") || v.model;
  const label = `${v.mode}  ·  ${model}`;
  c.text(x + 2, inputY + boxH - 1, truncate(label, boxW - 20), { fg: modeColor });
  const perm = v.permission === "yolo" ? "Full access" : v.permission === "auto" ? "Auto" : "Ask";
  c.text(x + boxW - width(perm) - 2, inputY + boxH - 1, perm, {
    fg: v.permission === "yolo" ? t.red : t.muted,
  });
  const hints = home
    ? "tab mode   ctrl+p commands   ctrl+o models"
    : "enter send   ctrl+j newline   pgup scroll   ctrl+p commands";
  c.text(x + Math.max(0, boxW - width(hints)), inputY + boxH + 1, truncate(hints, boxW), { fg: t.muted });
  if (v.attachments.length || v.notice)
    c.text(x, inputY - 1, truncate(v.notice || `↳ ${v.attachments.join(" · ")}`, boxW), {
      fg: v.notice ? t.accent : t.blue,
    });
  let project = v.project;
  const homeDir = homedir();
  if (project.startsWith(homeDir + "/")) project = "~" + project.slice(homeDir.length);
  c.text(2, rows - 1, truncate(project + (v.branch ? `  : ${v.branch}` : ""), columns - 24), { fg: t.faint });
  c.text(columns - width(`CDR ${v.version}`) - 2, rows - 1, `CDR ${v.version}`, { fg: t.faint });
  if (!v.busy || v.editor.text) c.cursor = { x: x + 2 + layout.x, y: inputY + 1 + layout.y - start };
  if (side) {
    for (let y = 1; y < rows - 2; y++) c.text(area, y, "│", { fg: t.border });
    const sx = area + 3,
      sw = side - 5;
    c.text(sx, 2, "WORKSPACE", { fg: t.muted, bold: true });
    c.text(sx, 4, truncate(basename(v.project), sw));
    c.text(sx, 5, truncate(v.branch || "No Git branch", sw), { fg: t.faint });
    c.text(sx, 8, "MODEL", { fg: t.muted });
    wrap(v.model, sw)
      .slice(0, 2)
      .forEach((line, i) => c.text(sx, 10 + i, line, { fg: t.accent }));
    c.text(sx, 14, "SESSION", { fg: t.muted });
    c.text(
      sx,
      16,
      `${v.state.usage.inputTokens.toLocaleString()} in · ${v.state.usage.outputTokens.toLocaleString()} out`,
      { fg: t.text },
      sw,
    );
    c.text(sx, 17, v.state.usage.cost ? `$${v.state.usage.cost.toFixed(4)}` : "ctrl+r switch session", {
      fg: t.faint,
    });
    if (rows > 29 && v.state.todos.length) {
      c.text(sx, 21, "TASKS", { fg: t.muted });
      v.state.todos
        .slice(0, rows - 27)
        .forEach((todo, i) =>
          c.text(
            sx,
            23 + i,
            truncate(
              `${todo.status === "done" ? "✓" : todo.status === "in_progress" ? "›" : "·"} ${todo.text}`,
              sw,
            ),
            { fg: todo.status === "done" ? t.green : t.text },
          ),
        );
    }
  }
  if (v.picker) {
    const p = v.picker,
      w = Math.min(76, columns - 6),
      h = Math.min(rows - 4, 17),
      left = Math.floor((columns - w) / 2),
      top = Math.max(1, Math.floor((rows - h) / 3));
    border(c, left, top, w, h);
    c.text(left + 2, top + 1, p.title, { fg: t.accent, bold: true });
    c.text(left + 2, top + 3, truncate(p.query.text || "Search…", w - 4), {
      fg: p.query.text ? t.text : t.faint,
    });
    const count = h - 7,
      offset = Math.max(0, p.selected - count + 1);
    p.items.slice(offset, offset + count).forEach((item, i) => {
      const selected = i + offset === p.selected;
      if (selected) c.fill(left + 1, top + 5 + i, w - 2, 1, t.selected);
      c.text(
        left + 2,
        top + 5 + i,
        truncate(`${selected ? "›" : " "} ${item.label}`, Math.floor((w - 4) * 0.6)),
        { fg: item.disabled ? t.faint : selected ? t.accent : t.text },
      );
      if (w > 55 && item.detail)
        c.text(left + Math.floor(w * 0.62), top + 5 + i, truncate(item.detail, Math.floor(w * 0.35)), {
          fg: t.muted,
        });
    });
    if (!p.items.length) c.text(left + 2, top + 5, "No matches", { fg: t.muted });
    c.text(left + 2, top + h - 2, truncate(p.hint || "↑↓ choose   enter select   esc close", w - 4), {
      fg: t.faint,
    });
    c.cursor = { x: left + 2 + Math.min(width(p.query.text), w - 5), y: top + 3 };
  }
  if (v.document || v.dialog) {
    const d: Dialog = v.dialog || {
      title: v.document!.title,
      body: v.document!.text,
      scroll: v.document!.scroll,
      actions: [],
      selected: 0,
    };
    const w = Math.min(100, columns - 4);
    const stacked = w < 70 && d.actions.length > 1;
    const actionRows = stacked ? d.actions.length : 1;
    const editH = d.editor ? Math.min(6, Math.max(2, d.editor.layout(w - 6).lines.length)) : 0;
    const bodyRows = markdown(d.body ?? v.document?.text ?? "", w - 6);
    const h = Math.min(rows - 4, Math.max(12, bodyRows.length + 6 + editH + actionRows)),
      left = Math.floor((columns - w) / 2),
      top = Math.max(1, Math.floor((rows - h) / 2));
    border(c, left, top, w, h);
    c.text(left + 2, top + 1, truncate(d.title, w - 4), {
      fg: v.dialog?.warning ? t.red : t.accent,
      bold: true,
    });
    drawRows(c, bodyRows, left + 3, top + 3, w - 6, Math.max(1, h - 6 - editH - actionRows), d.scroll, false);
    c.cursor = undefined;
    if (d.editor) {
      const el = d.editor.layout(w - 6),
        ey = top + h - editH - 3 - actionRows,
        start = Math.max(0, el.y - editH + 1);
      c.fill(left + 2, ey, w - 4, editH, t.bg);
      el.lines.slice(start, start + editH).forEach((line, i) => c.text(left + 3, ey + i, line));
      c.cursor = { x: left + 3 + el.x, y: ey + el.y - start };
    }
    let ax = left + 3;
    d.actions.forEach((action, i) => {
      const label = `${i + 1} ${action}`;
      c.text(
        stacked ? left + 3 : ax,
        top + h - 2 - actionRows + (stacked ? i : 0),
        label,
        {
          fg: i === d.selected ? t.bg : t.muted,
          bg: i === d.selected ? t.accent : t.panel,
          bold: i === d.selected,
        },
        stacked ? w - 6 : left + w - 2 - ax,
      );
      ax += width(label) + 3;
    });
    c.text(
      left + 3,
      top + h - 2,
      truncate(
        v.dialog?.hint ||
          (v.dialog
            ? "←→ select · Enter confirm · PgUp/PgDn read · Esc cancel"
            : "PgUp/PgDn scroll · Esc close"),
        w - 6,
      ),
      { fg: t.faint },
    );
  }
  return c;
}
