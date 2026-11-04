import { emitKeypressEvents, type Key } from "node:readline";
import { PassThrough } from "node:stream";
import { clean, graphemes, cellWidth } from "./screen.js";

export class Editor {
  text = "";
  cursor = 0; // grapheme offset, not UTF-16 offset
  set(text: string) {
    this.text = clean(text).slice(0, 100_000);
    this.cursor = graphemes(this.text).length;
  }
  insert(text: string) {
    const chars = graphemes(this.text),
      next = graphemes(clean(text));
    if (this.text.length + text.length > 100_000) return;
    chars.splice(this.cursor, 0, ...next);
    this.cursor += next.length;
    this.text = chars.join("");
  }
  move(delta: number) {
    this.cursor = Math.max(0, Math.min(graphemes(this.text).length, this.cursor + delta));
  }
  remove(back = true) {
    const chars = graphemes(this.text);
    if (back && this.cursor > 0) chars.splice(--this.cursor, 1);
    if (!back) chars.splice(this.cursor, 1);
    this.text = chars.join("");
  }
  boundary(end: boolean) {
    const chars = graphemes(this.text);
    if (end) while (this.cursor < chars.length && chars[this.cursor] !== "\n") this.cursor++;
    else while (this.cursor > 0 && chars[this.cursor - 1] !== "\n") this.cursor--;
  }
  kill(before: boolean) {
    const at = this.cursor;
    this.boundary(!before);
    const to = this.cursor;
    const chars = graphemes(this.text);
    chars.splice(Math.min(at, to), Math.abs(at - to));
    this.cursor = Math.min(at, to);
    this.text = chars.join("");
  }
  wordBack() {
    const chars = graphemes(this.text),
      end = this.cursor;
    while (this.cursor > 0 && /\s/.test(chars[this.cursor - 1])) this.cursor--;
    while (this.cursor > 0 && !/\s/.test(chars[this.cursor - 1])) this.cursor--;
    chars.splice(this.cursor, end - this.cursor);
    this.text = chars.join("");
  }
  vertical(delta: -1 | 1): boolean {
    const chars = graphemes(this.text);
    const start = this.cursor === 0 ? 0 : chars.lastIndexOf("\n", this.cursor - 1) + 1;
    const end = chars.indexOf("\n", this.cursor);
    const column = this.cursor - start;
    if (delta === -1 && start > 0) {
      const previous = start < 2 ? 0 : chars.lastIndexOf("\n", start - 2) + 1;
      this.cursor = Math.min(start - 1, previous + column);
      return true;
    }
    if (delta === 1 && end !== -1) {
      const nextEnd = chars.indexOf("\n", end + 1);
      this.cursor = Math.min(nextEnd === -1 ? chars.length : nextEnd, end + 1 + column);
      return true;
    }
    return false;
  }
  layout(columns: number): { lines: string[]; x: number; y: number } {
    const lines = [""];
    let x = 0,
      y = 0,
      cx = 0,
      cy = 0;
    const chars = graphemes(this.text);
    for (let i = 0; i <= chars.length; i++) {
      const char = chars[i];
      if (x >= columns || (char && char !== "\n" && x + cellWidth(char) > columns)) {
        lines.push("");
        y++;
        x = 0;
      }
      if (i === this.cursor) {
        cx = x;
        cy = y;
      }
      if (!char) break;
      if (char === "\n") {
        lines.push("");
        y++;
        x = 0;
      } else {
        lines[y] += char;
        x += cellWidth(char);
      }
    }
    return { lines, x: cx, y: cy };
  }
}

/** Bracketed paste is inserted as one draft, including newlines, never executed. */
export class InputDecoder {
  private stream = new PassThrough();
  private pending = "";
  private paste = "";
  private pasting = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    onKey: (text: string, key: Key) => void,
    private onPaste: (text: string) => void,
  ) {
    emitKeypressEvents(this.stream);
    // Navigation/function keys have no text argument in Node's keypress events.
    this.stream.on("keypress", (text: string | undefined, key: Key) => onKey(text ?? "", key));
  }
  feed(text: string) {
    if (this.timer) clearTimeout(this.timer);
    this.pending += text;
    const start = "\x1b[200~",
      end = "\x1b[201~";
    while (this.pending) {
      const marker = this.pasting ? end : start;
      const found = this.pending.indexOf(marker);
      if (found !== -1) {
        const before = this.pending.slice(0, found);
        if (this.pasting) {
          this.paste = (this.paste + before).slice(0, 100_000);
          this.onPaste(this.paste.replace(/\r\n?/g, "\n"));
          this.paste = "";
        } else if (before) this.stream.write(before);
        this.pasting = !this.pasting;
        this.pending = this.pending.slice(found + marker.length);
        continue;
      }
      let suffix = 0;
      for (let n = 1; n < marker.length; n++) if (this.pending.endsWith(marker.slice(0, n))) suffix = n;
      const ready = this.pending.slice(0, this.pending.length - suffix);
      if (this.pasting) this.paste = (this.paste + ready).slice(0, 100_000);
      else if (ready) this.stream.write(ready);
      this.pending = this.pending.slice(this.pending.length - suffix);
      break;
    }
    // A lone Escape is a key, not an unfinished paste marker.
    if (this.pending && !this.pasting)
      this.timer = setTimeout(() => {
        this.stream.write(this.pending);
        this.pending = "";
      }, 35);
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.stream.removeAllListeners();
    this.stream.destroy();
  }
}
