// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Pieces shared by the HTML and Figma REST importers: warning counter, design-system hints, height estimate.
import type { SceneElement, SceneLayout, SceneTokens } from "@harness/protocol";
import { isDark } from "../dsl/color.js";
import { isRemoved } from "../dsl/hiddenLayers.js";

export class Warnings {
  private counts = new Map<string, number>();
  add(w: string) {
    this.counts.set(w, (this.counts.get(w) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([w, n]) => (n > 1 ? `${w} (×${n})` : w));
  }
}

/** Frequency counters for design-system hints. */
export class Hints {
  fonts = new Map<string, number>();
  textColors = new Map<string, number>();
  accents = new Map<string, number>();
  backgrounds: string[] = [];
  radii = new Map<number, number>();
  bump<K>(m: Map<K, number>, k: K, n = 1) {
    m.set(k, (m.get(k) ?? 0) + n);
  }
  top<K>(m: Map<K, number>): K | undefined {
    let best: K | undefined,
      n = -1;
    for (const [k, v] of m)
      if (v > n) {
        best = k;
        n = v;
      }
    return best;
  }
  /** Token patch: most used font, text colour, accent (button/fill) colour, first screen background, radius. */
  tokens(): Partial<SceneTokens> {
    const out: Partial<SceneTokens> = {};
    const font = this.top(this.fonts);
    if (font) out.fontFamily = font;
    const bg = this.backgrounds.find((b) => /^#|^rgb/.test(b));
    if (bg) {
      out.background = bg;
      out.theme = isDark(bg) ? "dark" : "light";
    }
    const text = this.top(this.textColors);
    if (text) out.text = text;
    const accent = this.top(this.accents);
    if (accent) out.primary = accent;
    const radius = this.top(this.radii);
    if (radius !== undefined && radius > 0 && radius < 64) out.radius = radius;
    return out;
  }
}

const PRESET_SIZE: Record<string, number> = {
  display: 40,
  headline: 28,
  title: 18,
  body: 15,
  label: 13,
  caption: 12,
};
const pad = (p: SceneLayout["padding"]): [number, number, number, number] => {
  if (p === undefined) return [0, 0, 0, 0];
  if (typeof p === "number") return [p, p, p, p];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return p;
};

/** Rough rendered height of an element at `width` px (used to size imported screens; the DOM decides the real one). */
export function estimateHeight(el: SceneElement, width: number): number {
  const l = el.layout ?? {};
  if (l.position === "absolute") return 0;
  if (typeof l.height === "number") return l.height;
  const w =
    typeof l.width === "number"
      ? l.width
      : typeof l.width === "string" && l.width.endsWith("%")
        ? (width * parseFloat(l.width)) / 100
        : width;
  switch (el.type) {
    case "text": {
      const size = el.style?.fontSize ?? PRESET_SIZE[el.style?.textStyle ?? "body"] ?? 15;
      const lh = el.style?.lineHeight ?? 1.35;
      const chars = (el.text ?? "").length;
      const perLine = Math.max(1, Math.floor(Math.max(w, 40) / (size * 0.52)));
      const lines =
        (el.text ?? "")
          .split("\n")
          .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0) ||
        Math.max(1, Math.ceil(chars / perLine));
      return Math.ceil(lines * size * lh);
    }
    case "button":
    case "input":
      return 44;
    case "divider":
      return 1;
    case "checkbox":
      return 22;
    case "image":
    case "video":
      return el.style?.aspect ? Math.round(w / el.style.aspect) : Math.round(Math.min(w, 600) * 0.6);
    default:
      break;
  }
  const [pt, pr, pb, pl] = pad(l.padding);
  const inner = Math.max(0, w - pl - pr);
  const kids = (el.children ?? []).filter((c) => c.layout?.position !== "absolute" && !isRemoved(c));
  if (!kids.length) return pt + pb;
  const gap = l.gap ?? 0;
  const row = (l.direction ?? "column") === "row";
  if (row && !l.wrap) {
    const each = inner / kids.length;
    return pt + pb + Math.max(...kids.map((k) => estimateHeight(k, each)));
  }
  if (row && l.wrap) {
    // wrapped rows of children: assume they keep their own widths when numeric
    let x = 0,
      rowH = 0,
      total = 0;
    for (const k of kids) {
      const kw = typeof k.layout?.width === "number" ? k.layout.width : inner;
      if (x > 0 && x + kw > inner) {
        total += rowH + gap;
        x = 0;
        rowH = 0;
      }
      x += kw + gap;
      rowH = Math.max(rowH, estimateHeight(k, kw));
    }
    return pt + pb + total + rowH;
  }
  return pt + pb + kids.reduce((s, k) => s + estimateHeight(k, inner), 0) + gap * (kids.length - 1);
}

/** Readable layer name from free text. */
export const nameFromText = (t: string, max = 32) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s || "Text";
};
