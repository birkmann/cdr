import { compactionLine, type SessionState } from "@harness/client";
import { homedir } from "node:os";
import { summarizeArgs } from "../render.js";
import { Canvas, theme as t, truncate, width, wrap, type Style } from "./screen.js";
import {
  contentWidth as classicContentWidth,
  renderClassic,
  transcript as classicTranscript,
} from "./classic.js";
import {
  drawOverlays,
  drawRows,
  drawSidebar,
  formatBalance,
  markdown as md,
  row,
  type Part,
  type Row,
  type TerminalDesign,
  type View,
} from "./widgets.js";

export {
  DESIGNS,
  formatBalance,
  isDesign,
  type AccountBalance,
  type Dialog,
  type Part,
  type Picker,
  type PickerItem,
  type Row,
  type TerminalDesign,
  type View,
} from "./widgets.js";
export { WORDMARK } from "./classic.js";

const SPIN = ["·", "✢", "✶", "✻", "✽", "✻", "✶", "✢"];
const spinner = (frame: number) => SPIN[Math.floor(frame / 2) % SPIN.length];
const isThinking = (state: SessionState) =>
  state.status === "running" &&
  Object.values(state.messages).some((m) => m.role === "assistant" && m.streaming && !m.text);
const pascal = (name: string) =>
  name.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());
const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

/** Columns available to the conversation: full width minus the optional sidebar and a margin. */
export const sidebarWidth = (columns: number, sidebar: boolean) => (sidebar && columns >= 120 ? 29 : 0);
export const contentWidth = (columns: number, sidebar = false) =>
  Math.max(20, columns - sidebarWidth(columns, sidebar) - 2);
/** Welcome banner height (box plus a blank row); it is the first thing in the scrollable conversation. */
export const BANNER_ROWS = 6;

const HEADING: Style = { bold: true };
const markdown = (text: string, columns: number) => md(text, columns, t, HEADING);

export function transcript(
  state: SessionState,
  columns: number,
  expanded: boolean,
  animation = { frame: 0, elapsed: 0 },
): Row[] {
  const rows: Row[] = [];
  const add = (text: string, style?: Style) =>
    wrap(text, columns).forEach((text) => rows.push({ text, style }));
  const gap = () => {
    if (rows.length && rows[rows.length - 1].text !== "") rows.push({ text: "" });
  };
  /** "● text" with a hanging indent. */
  const bullet = (text: string, color: string, style?: Style) =>
    wrap(text, Math.max(1, columns - 2)).forEach((line, i) =>
      rows.push(
        i === 0
          ? row([
              { text: "● ", style: { fg: color } },
              { text: line, style },
            ])
          : { text: "  " + line, style },
      ),
    );
  /** "  ⎿  first line" with the remaining lines aligned beneath it. */
  const result = (lines: string[], style?: Style) => {
    let first = true;
    for (const line of lines)
      for (const part of wrap(line, Math.max(1, columns - 5))) {
        rows.push({ text: (first ? "  ⎿  " : "     ") + part, style });
        first = false;
      }
  };
  const indented = (markdownRows: Row[]) =>
    markdownRows.forEach((r) => rows.push({ ...r, text: "  " + r.text }));
  let prev = "";
  for (const item of state.timeline) {
    const before = prev;
    prev = item.kind;
    if (item.kind === "message") {
      const m = state.messages[item.id];
      if (!m) continue;
      const thinking = state.status === "running" && m.role === "assistant" && m.streaming && !m.text;
      if (!m.text && !m.reasoning && !thinking) continue;
      gap();
      if (m.role === "user") {
        wrap(m.text, Math.max(1, columns - 2)).forEach((line, i) =>
          rows.push({ text: (i === 0 ? "> " : "  ") + line, style: { fg: t.text, bg: t.panel } }),
        );
        if (m.attachments?.length) result([m.attachments.map((a) => a.name).join(" · ")], { fg: t.muted });
        continue;
      }
      if (m.agent && !["chat", "executor"].includes(m.agent)) add(`[${m.agent}]`, { fg: t.faint });
      if (thinking || m.reasoning) {
        if (thinking) {
          // Activity stays visible even when the provider pauses between chunks.
          add(`${spinner(animation.frame)} Thinking… (${animation.elapsed}s · esc to interrupt)`, {
            fg: t.accent,
            bold: true,
          });
          result([`ctrl+t to ${expanded ? "collapse" : "show"} thoughts`], { fg: t.muted });
        } else add("∴ Thought process (ctrl+t to expand)", { fg: t.muted });
        // what the model decided while thinking (summarizer), newest last
        for (const d of (m.decisions ?? []).slice(thinking ? -3 : -6)) result([d], { fg: t.muted });
        if (expanded && m.reasoning)
          for (const part of wrap(m.reasoning.slice(-12000), columns - 2)) add("  " + part, { fg: t.muted });
      }
      if (m.text)
        markdown(m.text, Math.max(1, columns - 2)).forEach((r, i) =>
          rows.push({ ...r, text: (i === 0 ? "● " : "  ") + r.text }),
        );
    } else if (item.kind === "tool") {
      const tool = state.tools[item.id];
      if (!tool) continue;
      if (before !== "tool") gap();
      const color = tool.status === "error" ? t.red : tool.status === "ok" ? t.green : t.accent;
      const name = pascal(tool.name);
      rows.push(
        row([
          { text: "● ", style: { fg: color } },
          { text: name, style: { bold: true } },
          {
            text: truncate(
              `(${summarizeArgs(tool.args, Math.max(10, columns - 4 - name.length))})`,
              Math.max(4, columns - 2 - name.length),
            ),
            style: { fg: t.muted },
          },
        ]),
      );
      if (tool.diff) {
        const lines = tool.diff.split("\n");
        const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        result([`Changed +${added} −${removed}`], { fg: t.muted });
        const cap = expanded ? 160 : 8;
        for (const line of lines.slice(0, cap)) {
          const bg = line.startsWith("+") ? t.diffAdd : line.startsWith("-") ? t.diffDel : undefined;
          add("     " + line, { fg: line.startsWith("@@") ? t.blue : t.text, bg });
        }
        if (lines.length > cap)
          add(`     … ${lines.length - cap} more lines (ctrl+t to expand)`, { fg: t.faint });
      } else if (tool.output) {
        const lines = tool.output.split("\n");
        const cap = expanded || tool.status === "error" ? 80 : 1;
        result(lines.slice(0, cap), { fg: tool.status === "error" ? t.red : t.muted });
        if (lines.length > cap)
          add(`     … +${lines.length - cap} lines (ctrl+t to expand)`, { fg: t.faint });
      } else if (tool.status !== "ok" && tool.status !== "error") result(["Running…"], { fg: t.faint });
    } else {
      const e = item.event;
      if (before === "message") gap();
      switch (e.type) {
        case "run.start":
          if (e.continuedFrom) bullet("Continuing saved job · existing work retained", t.accent);
          break;
        case "phase.start":
          break;
        case "error":
          result([e.message], { fg: t.red });
          break;
        case "log":
          result([e.message], { fg: t.accent });
          break;
        case "context.compacted":
          add(`✻ ${compactionLine(e)}`, { fg: t.faint });
          break;
        case "verify.result":
          bullet(`${e.kind}  ${e.command}`, e.exitCode === 0 ? t.green : t.red);
          if (e.exitCode !== 0 || expanded) result(e.output.slice(-6000).split("\n"), { fg: t.muted });
          break;
        case "plan.proposed":
          gap();
          bullet("Plan", t.blue, { fg: t.blue, bold: true });
          indented(markdown(e.markdown, Math.max(1, columns - 2)));
          break;
        case "plan.decision":
          result(
            [
              `Plan ${e.decision === "approve" ? "approved" : e.decision === "edit" ? "edited and approved" : "rejected"}`,
            ],
            { fg: t.muted },
          );
          break;
        case "review.findings":
          gap();
          bullet(e.summary || "Review", t.accent);
          e.findings.forEach((f) =>
            result([`${f.severity} · ${f.file || ""} ${f.issue}`], {
              fg: f.severity === "blocking" ? t.red : t.muted,
            }),
          );
          break;
        case "launch.ready":
          bullet(`${e.title || "Ready to run"} · ${e.cwd ? `cd ${e.cwd} && ` : ""}${e.command}`, t.green);
          break;
        case "branch.merged":
          bullet(
            `Merged ${e.messages} message${e.messages === 1 ? "" : "s"} from branch ${e.branchTitle ?? e.branchSessionId}`,
            t.muted,
          );
          break;
        case "preview.ready":
          bullet(`Preview ready · ${e.title || e.path}`, t.green);
          result(["Open this conversation in CDR web to view it."], { fg: t.muted });
          break;
        case "recreate.started":
          gap();
          bullet(`Recreate ${e.url} · run ${e.runId}`, t.accent, { bold: true });
          break;
        case "recreate.finished":
          bullet(
            `Recreate ${e.status}${e.summary ? ` · ${e.summary}` : ""}`,
            e.status === "success" ? t.green : e.status === "failed" ? t.red : t.muted,
          );
          for (const o of e.outputs) result([`${o.target}: ${o.path}`], { fg: t.muted });
          if (e.comparePath) result([`compare: ${e.comparePath}`], { fg: t.muted });
          break;
        case "agent.spawned":
          bullet(
            `Subagent ${e.role} [${e.isolation}${e.branch ? ` · ${e.branch}` : ""}] ${e.task.split("\n")[0]}`,
            t.accent,
          );
          break;
        case "agent.finished":
          bullet(
            `Subagent ${e.status}${e.summary ? ` · ${e.summary.split("\n")[0]}` : ""}`,
            e.status === "success" ? t.green : e.status === "failed" ? t.red : t.muted,
          );
          if (e.diffStat && expanded) result(e.diffStat.split("\n"), { fg: t.muted });
          break;
        case "goal.started":
          gap();
          bullet(`Goal ${e.title} · round ${e.round} · ${e.branch}`, t.accent, { bold: true });
          break;
        case "goal.checkpoint":
          bullet(`Checkpoint ${e.commit.slice(0, 10)} · ${e.step}`, t.green);
          e.criteria.forEach((x) =>
            result([`${x.met ? "✓" : "✗"} ${x.criterion}`], { fg: x.met ? t.green : t.red }),
          );
          break;
        case "goal.paused":
          bullet(`Goal paused (${e.reason})${e.detail ? ` · ${e.detail}` : ""}`, t.accent);
          break;
        case "goal.finished":
          bullet(`Goal ${e.status} · ${e.branch}`, e.status === "success" ? t.green : t.red);
          break;
        case "done":
          if (e.status === "cancelled")
            result(["Interrupted by user · /continue resumes this job from saved progress"], { fg: t.muted });
          else if (e.status !== "success") {
            gap();
            bullet(`Run ${e.status}`, t.red, { fg: t.red });
            result(["/continue resumes this job from saved progress"], { fg: t.muted });
          }
          break;
      }
    }
  }
  return rows;
}

/** The welcome box: the first rows of the conversation, so it scrolls away like any other output. */
function banner(v: View, columns: number): Row[] {
  const w = Math.min(columns, 64),
    inner = Math.max(1, w - 4),
    b: Style = { fg: t.border };
  let project = v.project;
  const home = homedir();
  if (project.startsWith(home + "/")) project = "~" + project.slice(home.length);
  const model = v.model.split("/").slice(1).join("/") || v.model;
  const line = (parts: Part[]): Row => {
    const used = parts.reduce((n, p) => n + width(p.text), 0);
    return row([
      { text: "│ ", style: b },
      ...parts,
      { text: " ".repeat(Math.max(0, inner - used)) + " │", style: b },
    ]);
  };
  return [
    { text: "╭" + "─".repeat(w - 2) + "╮", style: b },
    line([
      { text: "✻ ", style: { fg: t.accent } },
      { text: "Welcome to CDR", style: { bold: true } },
      { text: truncate(`  ${v.version}`, Math.max(0, inner - 16)), style: { fg: t.faint } },
    ]),
    line([{ text: truncate(`${model} · ${v.mode} mode`, inner), style: { fg: t.muted } }]),
    line([{ text: truncate(project + (v.branch ? ` · ${v.branch}` : ""), inner), style: { fg: t.faint } }]),
    { text: "╰" + "─".repeat(w - 2) + "╯", style: b },
    { text: "" },
  ];
}

/** Draw the screen in the chosen design (the flowing `default` unless `v.design` says `classic`). */
export function renderView(v: View, columns: number, rows: number): Canvas {
  return v.design === "classic" ? renderClassic(v, columns, rows) : renderDefault(v, columns, rows);
}

/** Columns the conversation wraps to in the given design. */
export function designContentWidth(design: TerminalDesign | undefined, columns: number, sidebar = false) {
  return design === "classic" ? classicContentWidth(columns, sidebar) : contentWidth(columns, sidebar);
}
/** Conversation rows before the scrollback limit is applied (the banner only exists in `default`). */
export function designScrollRows(
  design: TerminalDesign | undefined,
  state: SessionState,
  columns: number,
  sidebar: boolean,
  expanded: boolean,
) {
  const width = designContentWidth(design, columns, sidebar);
  return design === "classic"
    ? classicTranscript(state, width, expanded).length
    : BANNER_ROWS + transcript(state, width, expanded).length;
}

function renderDefault(v: View, columns: number, rows: number): Canvas {
  const c = new Canvas(Math.max(12, columns), Math.max(6, rows));
  columns = c.columns;
  rows = c.rows;
  if (columns < 36 || rows < 12) {
    c.center(1, "CDR", { fg: t.accent, bold: true });
    c.center(3, truncate("Resize to 36 × 12 or larger", columns));
    c.center(5, truncate("Ctrl+C / Ctrl+D to exit", columns), { fg: t.muted });
    return c;
  }
  const home = !v.state.timeline.some((i) => i.kind === "message");
  const side = sidebarWidth(columns, v.sidebar);
  const area = columns - side;
  const cw = contentWidth(columns, v.sidebar);
  const x = 1;
  const layout = v.editor.layout(Math.max(1, cw - 2));
  const inputH = Math.max(1, Math.min(layout.lines.length, Math.max(1, Math.min(6, Math.floor(rows / 4)))));
  // Prompt block: rule, input, rule, status line. It sits at the bottom, or under the banner when empty.
  let ruleY = rows - inputH - 3;
  if (home) ruleY = Math.min(ruleY, BANNER_ROWS + 4);
  const thinking = isThinking(v.state);
  const lines: Row[] = banner(v, cw);
  if (home)
    lines.push(
      { text: "Tips for getting started:", style: { fg: t.muted } },
      { text: "  · Describe what you want to build or change, then press enter", style: { fg: t.faint } },
      { text: "  · / for commands · tab switches mode · ctrl+o picks a model", style: { fg: t.faint } },
    );
  else lines.push(...transcript(v.state, cw, v.expanded, { frame: v.frame, elapsed: v.elapsed }));
  drawRows(c, lines, x, 0, cw, Math.max(1, ruleY - 1), v.scroll);
  // One live line above the prompt: notice, attachments or what the agent is doing.
  const indicator = v.scroll ? "↑ scrollback · End latest" : "";
  if (v.notice || v.attachments.length)
    c.text(x, ruleY - 1, truncate(v.notice || `⎿  ${v.attachments.join(" · ")}`, cw - width(indicator) - 1), {
      fg: v.notice ? t.accent : t.blue,
    });
  else if (v.busy && (!thinking || v.scroll)) {
    const working = Object.values(v.state.tools).some(
      (tool) => tool.status !== "ok" && tool.status !== "error",
    );
    const detail = [`${v.elapsed}s`, v.state.phase, "esc to interrupt"].filter(Boolean).join(" · ");
    c.text(
      x,
      ruleY - 1,
      truncate(
        `${spinner(v.frame)} ${working ? "Working" : "Thinking"}… (${detail})`,
        cw - width(indicator) - 1,
      ),
      { fg: t.accent, bold: true },
    );
  }
  if (indicator) c.text(Math.max(x, area - 1 - width(indicator)), ruleY - 1, indicator, { fg: t.accent });
  c.text(0, ruleY, "─".repeat(area), { fg: t.border });
  c.text(0, ruleY + inputH + 1, "─".repeat(area), { fg: t.border });
  const start = Math.max(0, layout.y - inputH + 1);
  layout.lines.slice(start, start + inputH).forEach((line, i) => {
    if (i === 0 && start === 0) c.text(x, ruleY + 1, ">", { fg: t.accent, bold: true });
    c.text(x + 2, ruleY + 1 + i, line, {}, cw - 2);
  });
  if (!v.editor.text && !v.busy)
    c.text(
      x + 2,
      ruleY + 1,
      truncate(home ? "What would you like to build?" : "Continue the conversation…", cw - 2),
      {
        fg: t.faint,
      },
    );
  // Single status line: permission and mode on the left, model and usage on the right.
  const statusY = ruleY + inputH + 2;
  const perm =
    v.permission === "yolo"
      ? "⏵⏵ full access"
      : v.permission === "auto"
        ? "⏵⏵ auto mode on"
        : "ask before changes";
  const left = v.dialog
    ? "Waiting for you"
    : `${perm} · ${v.mode}${!v.busy && !v.editor.text ? " (tab to switch)" : ""}`;
  const usage = v.state.usage;
  const tokens = usage.inputTokens + usage.outputTokens;
  const balance = formatBalance(v.balance)[0]?.text;
  const model = v.model.split("/").slice(1).join("/") || v.model;
  const right = truncate(
    [
      model,
      tokens ? `${compact(tokens)} tokens` : "",
      usage.cost ? `$${usage.cost.toFixed(2)}` : "",
      balance ? `balance ${balance}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    Math.max(10, Math.floor(area / 2)),
  );
  const leftColor = v.dialog
    ? t.accent
    : v.permission === "yolo"
      ? t.red
      : v.mode === "Plan"
        ? t.blue
        : v.permission === "auto"
          ? t.accent
          : t.faint;
  c.text(x, statusY, truncate(left, Math.max(8, area - width(right) - 5)), { fg: leftColor });
  c.text(Math.max(x, area - 1 - width(right)), statusY, right, { fg: t.faint });
  if (!v.busy || v.editor.text) c.cursor = { x: x + 2 + layout.x, y: ruleY + 1 + layout.y - start };
  if (side) drawSidebar(c, v, t, area, side, rows, [0, rows]);
  drawOverlays(c, v, t, HEADING);
  return c;
}
