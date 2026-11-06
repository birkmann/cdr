import type { SessionState } from "@harness/client";
import type { ProviderBalance } from "@harness/core";
import { basename } from "node:path";
import { Canvas, truncate, width, wrap, type Palette, type Style } from "./screen.js";
import type { Editor } from "./input.js";

/** Pieces shared by every terminal design: view types, markdown, the sidebar and the overlays. */

/** `default` is the flowing coding-agent CLI look; `classic` is the earlier centered-composer look. */
export type TerminalDesign = "default" | "classic";
export const DESIGNS: { id: TerminalDesign; label: string; detail: string }[] = [
  { id: "default", label: "Default", detail: "Flowing conversation, prompt between rules, terminal colours" },
  { id: "classic", label: "Classic", detail: "Wordmark, centered composer box, graphite and lime" },
];
export const isDesign = (value: string): value is TerminalDesign => DESIGNS.some((d) => d.id === value);

/** A row is one style, or several coloured runs (`parts`) whose text joins into `text`. */
export type Part = { text: string; style?: Style };
export type Row = { text: string; style?: Style; parts?: Part[] };
export const row = (parts: Part[]): Row => ({ text: parts.map((p) => p.text).join(""), parts });
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
export interface AccountBalance {
  items: ProviderBalance[];
  /** Totals when the app started, used to show what this run has spent. */
  start?: ProviderBalance[];
  error?: boolean;
}
export interface View {
  state: SessionState;
  balance?: AccountBalance;
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
  /** Which terminal design draws the screen (`/terminal-design`); defaults to `default`. */
  design?: TerminalDesign;
  notice?: string;
  attachments: string[];
  picker?: Picker;
  dialog?: Dialog;
  document?: { title: string; text: string; scroll: number };
}

const SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };
const money = (currency: string, n: number) =>
  `${SYMBOLS[currency] ?? ""}${n.toFixed(2)}${SYMBOLS[currency] ? "" : ` ${currency}`}`;
const LOW_BALANCE: Record<string, number> = { USD: 2, CNY: 14 };

/** Sidebar lines for the provider account balance; empty when there is nothing to show. */
export function formatBalance(
  b: AccountBalance | undefined,
): { text: string; fg: "text" | "green" | "red" | "faint" }[] {
  if (!b) return [];
  if (!b.items.length) return b.error ? [{ text: "balance unavailable", fg: "faint" }] : [];
  const lines: { text: string; fg: "text" | "green" | "red" | "faint" }[] = [];
  for (const item of b.items) {
    const low = item.total < (LOW_BALANCE[item.currency] ?? 0);
    lines.push({ text: money(item.currency, item.total), fg: low ? "red" : "green" });
  }
  const spent = b.items.flatMap((item) => {
    const before = b.start?.find((s) => s.currency === item.currency)?.total;
    return before !== undefined && before - item.total >= 0.005
      ? [money(item.currency, before - item.total)]
      : [];
  });
  if (spent.length) lines.push({ text: `spent ${spent.join(" + ")} this run`, fg: "faint" });
  const usd = b.items[0];
  if (usd?.granted !== undefined && usd.toppedUp !== undefined && (usd.granted > 0 || usd.toppedUp > 0)) {
    lines.push({ text: `granted ${money(usd.currency, usd.granted)}`, fg: "faint" });
    lines.push({ text: `topped up ${money(usd.currency, usd.toppedUp)}`, fg: "faint" });
  }
  if (b.error) lines.push({ text: "refresh failed", fg: "faint" });
  return lines;
}

/** Markdown-lite: fenced code on a code background, headings in `heading`, inline marks stripped. */
export function markdown(text: string, columns: number, t: Palette, heading: Style): Row[] {
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
    const isHeading = !code && /^#{1,6}\s/.test(line);
    const content = code
      ? "  " + line
      : line
          .replace(/^#{1,6}\s/, "")
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1");
    const style = code ? { fg: t.blue, bg: t.code } : isHeading ? heading : undefined;
    for (const part of wrap(content, columns)) rows.push({ text: part, style });
  }
  return rows;
}

export function drawRows(
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
    if (!row.parts) c.text(x, y + i, row.text, row.style, w);
    else {
      let px = x;
      for (const part of row.parts) {
        c.text(px, y + i, part.text, part.style, Math.max(0, x + w - px));
        px += width(part.text);
      }
    }
  });
}

function border(c: Canvas, t: Palette, x: number, y: number, w: number, h: number) {
  c.fill(x, y, w, h, t.panel);
  c.text(x, y, "╭" + "─".repeat(Math.max(0, w - 2)) + "╮", { fg: t.border });
  c.text(x, y + h - 1, "╰" + "─".repeat(Math.max(0, w - 2)) + "╯", { fg: t.border });
  for (let row = y + 1; row < y + h - 1; row++) {
    c.text(x, row, "│", { fg: t.border });
    c.text(x + w - 1, row, "│", { fg: t.border });
  }
}

/** Workspace sidebar at column `area` (`side` wide), with its divider drawn on rows [top, bottom). */
export function drawSidebar(
  c: Canvas,
  v: View,
  t: Palette,
  area: number,
  side: number,
  rows: number,
  divider: [top: number, bottom: number],
) {
  for (let y = divider[0]; y < divider[1]; y++) c.text(area, y, "│", { fg: t.border });
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
  let next = 21;
  const account = rows > 25 ? formatBalance(v.balance) : [];
  if (account.length) {
    c.text(sx, 19, "ACCOUNT", { fg: t.muted });
    account
      .slice(0, rows - 24)
      .forEach((line, i) => c.text(sx, 21 + i, truncate(line.text, sw), { fg: t[line.fg] }));
    next = 21 + Math.min(account.length, rows - 24) + 1;
  }
  if (rows > next + 8 && v.state.todos.length) {
    c.text(sx, next, "TASKS", { fg: t.muted });
    v.state.todos
      .slice(0, rows - next - 6)
      .forEach((todo, i) =>
        c.text(
          sx,
          next + 2 + i,
          truncate(
            `${todo.status === "done" ? "✓" : todo.status === "in_progress" ? "›" : "·"} ${todo.text}`,
            sw,
          ),
          { fg: todo.status === "done" ? t.green : t.text },
        ),
      );
  }
}

/** The command/model picker and the approval or document dialog, drawn over either design. */
export function drawOverlays(c: Canvas, v: View, t: Palette, heading: Style) {
  const { columns, rows } = c;
  if (v.picker) {
    const p = v.picker,
      w = Math.min(76, columns - 6),
      h = Math.min(rows - 4, 17),
      left = Math.floor((columns - w) / 2),
      top = Math.max(1, Math.floor((rows - h) / 3));
    border(c, t, left, top, w, h);
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
    const bodyRows = markdown(d.body ?? v.document?.text ?? "", w - 6, t, heading);
    const h = Math.min(rows - 4, Math.max(12, bodyRows.length + 6 + editH + actionRows)),
      left = Math.floor((columns - w) / 2),
      top = Math.max(1, Math.floor((rows - h) / 2));
    border(c, t, left, top, w, h);
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
          fg: i === d.selected ? t.onAccent : t.muted,
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
}
