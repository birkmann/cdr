import { compactionLine, type SessionState } from "@harness/client";
import { homedir } from "node:os";
import { summarizeArgs } from "../render.js";
import { Canvas, classicTheme as t, truncate, width, wrap, type Style } from "./screen.js";
import { drawOverlays, drawRows, drawSidebar, markdown as md, type Row, type View } from "./widgets.js";

/**
 * The Classic design (`/terminal-design classic`): a wordmark home screen, a title bar, the
 * conversation in a centered column and a composer box with a mode-coloured edge, on a graphite background.
 */

// Keep mode identity stable while idle, thinking, and waiting for approval.
const MODE_COLORS: Record<string, string> = {
  Chat: "#7dd3c8",
  Build: t.accent,
  Plan: "#82b1ff",
  "Quick fix": "#e5c07b",
  Review: "#c4a0ed",
};
const HEADING: Style = { fg: t.accent, bold: true };
const markdown = (text: string, columns: number) => md(text, columns, t, HEADING);

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

const sidebarWidth = (columns: number, sidebar: boolean, home: boolean) =>
  !home && sidebar && columns >= 120 ? 29 : 0;
const boxWidth = (area: number, home: boolean) => Math.min(home ? 78 : 104, area - 6);
/** Columns the conversation wraps to in this design. */
export const contentWidth = (columns: number, sidebar = false) =>
  Math.max(20, boxWidth(columns - sidebarWidth(columns, sidebar, false), false) - 2);

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
        // what the model decided while thinking (summarizer), newest last
        for (const d of (m.decisions ?? []).slice(thinking ? -3 : -6)) add(`    ↳ ${d}`, { fg: t.muted });
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
        case "context.compacted":
          add(`⊜ ${compactionLine(e)}`, { fg: t.faint });
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
        case "recreate.started":
          add(`⧉ Recreate ${e.url} · run ${e.runId}`, { fg: t.accent, bold: true });
          break;
        case "recreate.finished":
          add(`⧉ Recreate ${e.status}${e.summary ? ` · ${e.summary}` : ""}`, {
            fg: e.status === "success" ? t.green : e.status === "failed" ? t.red : t.muted,
          });
          for (const o of e.outputs) add(`  ${o.target}: ${o.path}`, { fg: t.muted });
          if (e.comparePath) add(`  compare: ${e.comparePath}`, { fg: t.muted });
          break;
        case "agent.spawned":
          add(
            `◆ subagent ${e.role} [${e.isolation}${e.branch ? ` · ${e.branch}` : ""}] ${e.task.split("\n")[0]}`,
            { fg: t.accent },
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
export function renderClassic(v: View, columns: number, rows: number): Canvas {
  const c = new Canvas(Math.max(12, columns), Math.max(6, rows), { fg: t.text, bg: t.bg });
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
  const side = sidebarWidth(columns, v.sidebar, home);
  const area = columns - side;
  const boxW = boxWidth(area, home);
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
  if (side) drawSidebar(c, v, t, area, side, rows, [1, rows - 2]);
  drawOverlays(c, v, t, HEADING);
  return c;
}
