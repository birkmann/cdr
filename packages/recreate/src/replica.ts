// The `replica-nextjs` target: the page rebuilt in Next.js from a design system (see docs/recreate.md). The app itself is
// written by the autopilot; here is what the run's scene needs for it.
import type { SceneElement, SceneScreen } from "@harness/protocol";
import type { PageCapture } from "@harness/scene";
import { walk } from "@harness/scene";

export { decodePng, encodePng, type RgbImage } from "@harness/capture";

type SnapRect = { h: number };
type SnapFont = { lineHeight?: number };
type SnapLine = unknown;

type SnapNode = {
  rect?: SnapRect;
  font?: SnapFont;
  lines?: SnapLine[];
  tag?: string;
  kind?: string;
  text?: string;
  attrs?: Record<string, string>;
  pseudo?: string;
  children?: SnapNode[];
};

const LEVELS: Record<string, "display" | "headline" | "title"> = {
  h1: "display",
  h2: "headline",
  h3: "title",
};

interface Heading {
  text: string;
  style: "display" | "headline" | "title";
  /** the box is as tall as its lines (false: the page stretches it, as a grid row does) */
  contentHeight: boolean;
}

/** Is the heading's box as tall as its text? */
const contentHeight = (n: SnapNode): boolean => {
  const t = n.children?.find((c) => c.kind === "text");
  const lh = t?.font?.lineHeight;
  if (!t || !lh || !t.lines?.length || !n.rect) return false;
  return Math.abs(n.rect.h - lh * t.lines.length) < 2;
};

/** The text of a snapshot element (its text nodes in order). */
const textOf = (n: SnapNode): string => {
  if (n.kind === "text") return n.text ?? "";
  return (n.children ?? []).map(textOf).join(" ");
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The snapshot's h1 to h3 in document order, with their text. */
function headingsOf(root: SnapNode): Heading[] {
  const out: Heading[] = [];
  const visit = (n: SnapNode) => {
    const style = n.tag ? LEVELS[n.tag] : undefined;
    if (style) {
      const text = norm(textOf(n));
      if (text) out.push({ text, style, contentHeight: contentHeight(n) });
      return;
    }
    (n.children ?? []).forEach(visit);
  };
  visit(root);
  return out;
}

/**
 * The scene drops the block a heading's text sat in (`<h1>` with one text is one text element). `textStyle` (`display`,
 * `headline`, `title`) brings it back: the emitters render those as h1, h2 and h3, and the measured size, weight and
 * line height stay as they are. Mutates `screens`; matches each variant's text elements with the same width's snapshot,
 * in document order.
 */
export function markHeadings(screens: SceneScreen[], caps: readonly PageCapture[]): void {
  markLinks(screens, caps);
  for (const screen of screens)
    if (typeof screen.root.meta?.overlayOf !== "string") restoreArrowOrder(screen.root);
  for (const screen of screens) {
    if (typeof screen.root.meta?.overlayOf === "string") continue;
    const cap = caps.find((c) => c.width === screen.width);
    if (!cap) continue;
    const headings = headingsOf((cap.snap as { root: SnapNode }).root);
    if (!headings.length) continue;
    // the elements whose cross axis is vertical: in a column, stretching the cross axis only widens the box
    const rowLike = new Set<SceneElement>();
    walk(screen.root, (e: SceneElement) => {
      if (e.layout?.grid || e.layout?.direction === "row") for (const c of e.children ?? []) rowLike.add(c);
    });
    walk(screen.root, (e: SceneElement) => {
      if (e.type !== "text" || !e.text) return;
      const t = norm(e.text);
      const i = headings.findIndex((h) => h.text === t);
      if (i < 0) return;
      const [{ style, contentHeight: asTall }] = headings.splice(i, 1) as [Heading];
      const s = (e.style ??= {});
      s.textStyle = style;
      // a heading in a stretching row keeps the box of its text, as on the page (it is compared box by box)
      if (asTall && rowLike.has(e)) (e.layout ??= {}).alignSelf ??= "start";
      // a preset's letter spacing and weight are only the defaults of a text that does not have its own
      s.letterSpacing ??= 0;
    });
  }
}

/** Texts the page draws through a pseudo-element (`::before { content: "✓" }`): painted, but no text of the document. */
export function pseudoTexts(snapshots: readonly unknown[]): string[] {
  const out = new Set<string>();
  const visit = (n: SnapNode) => {
    if (n.pseudo)
      for (const c of n.children ?? []) if (c.kind === "text" && c.text?.trim()) out.add(c.text.trim());
    (n.children ?? []).forEach(visit);
  };
  for (const s of snapshots) visit((s as { root: SnapNode }).root);
  return [...out];
}

const textIn = (e: SceneElement): string =>
  e.type === "text" ? (e.text ?? "") : (e.children ?? []).map(textIn).join(" ");

/**
 * A link around more than text (a logo: a mark and a name) is a plain frame in the scene: its address would be lost.
 * The frame's first text carries it as a run, so the markup has the page's link.
 */
function markLinks(screens: SceneScreen[], caps: readonly PageCapture[]): void {
  for (const screen of screens) {
    if (typeof screen.root.meta?.overlayOf === "string") continue;
    const cap = caps.find((c) => c.width === screen.width);
    if (!cap) continue;
    const links = new Map<string, string>();
    const visit = (n: SnapNode) => {
      if (n.tag === "a" && n.attrs?.href) {
        const t = norm(textOf(n));
        if (t && !links.has(t)) links.set(t, n.attrs.href);
      }
      (n.children ?? []).forEach(visit);
    };
    visit((cap.snap as { root: SnapNode }).root);
    walk(screen.root, (e: SceneElement) => {
      if (e.type !== "frame" || e.meta?.tag !== "a" || !e.children?.length) return;
      const href = links.get(norm(textIn(e)));
      if (!href) return;
      const first = firstText(e);
      if (first && !first.runs?.length) first.runs = [{ text: first.text ?? "", href }];
    });
  }
}

function firstText(e: SceneElement): SceneElement | undefined {
  if (e.type === "text" && e.text) return e;
  for (const c of e.children ?? []) {
    const t = firstText(c);
    if (t) return t;
  }
  return undefined;
}

/**
 * The capture moves z-indexed boxes after their subtree (paint order), so a slider's "previous" arrow lands behind its
 * track. It is positioned either way; in document order it comes first, so the page's text reads as on the original.
 */
function restoreArrowOrder(root: SceneElement): void {
  walk(root, (e: SceneElement) => {
    const kids = e.children;
    if (!kids?.length) return;
    for (const prev of kids.filter(
      (c) =>
        c.layout?.position === "absolute" &&
        c.interaction?.onTap === "scroll-by" &&
        c.interaction.direction === "prev",
    )) {
      const track = kids.findIndex((c) => c.id === prev.interaction?.target);
      const at = kids.indexOf(prev);
      if (track >= 0 && at > track) {
        kids.splice(at, 1);
        kids.splice(track, 0, prev);
      }
    }
  });
}
