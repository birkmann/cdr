import { stripVTControlCharacters } from "node:util";

export const theme = {
  bg: "#1c1c1c",
  panel: "#2b2c2e",
  selected: "#44464b",
  text: "#f4f4f5",
  muted: "#b8bbc2",
  faint: "#92969e",
  border: "#4c4d50",
  accent: "#c8f56b",
  green: "#a6c998",
  red: "#e59595",
  blue: "#a5bed3",
  code: "#242527",
};
export type Style = { fg?: string; bg?: string; bold?: boolean };
type Cell = { char: string; fg: string; bg: string; bold: boolean };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string): string[] => [...segmenter.segment(text)].map((s) => s.segment);
/** Treat model/tool text as data, never terminal escape sequences. */
export function clean(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "  ");
}
export function cellWidth(char: string): number {
  if (!char || /^\p{Mark}+$/u.test(char)) return 0;
  const n = char.codePointAt(0)!;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F/u.test(char) ||
    (n >= 0x1100 &&
      (n <= 0x115f ||
        n === 0x2329 ||
        n === 0x232a ||
        (n >= 0x2e80 && n <= 0xa4cf) ||
        (n >= 0xac00 && n <= 0xd7a3) ||
        (n >= 0xf900 && n <= 0xfaff) ||
        (n >= 0xfe10 && n <= 0xfe6f) ||
        (n >= 0xff00 && n <= 0xff60) ||
        (n >= 0xffe0 && n <= 0xffe6) ||
        n >= 0x20000))
    ? 2
    : 1;
}
export const width = (text: string) => graphemes(clean(text)).reduce((n, c) => n + cellWidth(c), 0);
export function truncate(text: string, columns: number): string {
  const s = clean(text).replace(/\n/g, " ");
  if (width(s) <= columns) return s;
  let result = "",
    used = 0;
  for (const c of graphemes(s)) {
    if (used + cellWidth(c) > columns - 1) break;
    result += c;
    used += cellWidth(c);
  }
  return columns > 0 ? result + "…" : "";
}
export function wrap(text: string, columns: number): string[] {
  const out: string[] = [];
  const limit = Math.max(1, columns);
  for (const line of clean(text).split("\n")) {
    let row = "",
      used = 0;
    for (const c of graphemes(line)) {
      const w = cellWidth(c);
      if (used + w > limit && row) {
        out.push(row);
        row = "";
        used = 0;
      }
      row += c;
      used += w;
    }
    out.push(row);
  }
  return out;
}

export class Canvas {
  readonly cells: Cell[][];
  cursor?: { x: number; y: number };
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => ({ char: " ", fg: theme.text, bg: theme.bg, bold: false })),
    );
  }
  fill(x: number, y: number, w: number, h: number, bg = theme.panel) {
    for (let row = Math.max(0, y); row < Math.min(this.rows, y + h); row++)
      for (let col = Math.max(0, x); col < Math.min(this.columns, x + w); col++)
        this.cells[row][col] = { char: " ", fg: theme.text, bg, bold: false };
  }
  text(x: number, y: number, text: string, style: Style = {}, max = this.columns - x) {
    if (y < 0 || y >= this.rows) return;
    let col = x;
    for (const c of graphemes(clean(text).replace(/\n/g, " "))) {
      const w = cellWidth(c);
      if (!w) continue;
      if (col + w > this.columns || col + w > x + max) break;
      if (col >= 0) {
        this.cells[y][col] = {
          char: c,
          fg: style.fg ?? theme.text,
          bg: style.bg ?? this.cells[y][col].bg,
          bold: style.bold ?? false,
        };
        if (w === 2) this.cells[y][col + 1] = { ...this.cells[y][col], char: "" };
      }
      col += w;
    }
  }
  center(y: number, text: string, style: Style = {}) {
    this.text(Math.max(0, Math.floor((this.columns - width(text)) / 2)), y, text, style);
  }
  plain(): string[] {
    return this.cells.map((row) => row.map((c) => c.char).join(""));
  }
  lines(color = true): string[] {
    return this.cells.map((row) => {
      let last = "",
        out = "";
      for (const c of row) {
        if (!c.char) continue;
        const key = `${c.fg}:${c.bg}:${c.bold}`;
        if (key !== last) {
          out += color
            ? `\x1b[0;${c.bold ? "1;" : ""}38;2;${rgb(c.fg)};48;2;${rgb(c.bg)}m`
            : c.bold
              ? "\x1b[1m"
              : "\x1b[0m";
          last = key;
        }
        out += c.char;
      }
      return out + "\x1b[0m";
    });
  }
}
function rgb(hex: string) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
}

/** Paint changed rows only; preserve shell scrollback in the alternate screen. */
export class Screen {
  private previous: string[] = [];
  constructor(private out: NodeJS.WriteStream) {}
  open() {
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J");
  }
  reset() {
    this.previous = [];
    this.out.write("\x1b[2J");
  }
  draw(canvas: Canvas) {
    const lines = canvas.lines(!process.env.NO_COLOR);
    let out = "\x1b[?25l";
    lines.forEach((line, i) => {
      if (line !== this.previous[i]) out += `\x1b[${i + 1};1H${line}`;
    });
    this.previous = lines;
    if (canvas.cursor) out += `\x1b[${canvas.cursor.y + 1};${canvas.cursor.x + 1}H\x1b[?25h`;
    this.out.write(out);
  }
  close() {
    this.out.write("\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l");
    this.previous = [];
  }
}
