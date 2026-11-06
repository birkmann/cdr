// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Named icons as IR (SVG); the node lists come from @harness/scene's icon table (lucide glyphs).
import { iconNodesOrFallback, type IconNode } from "@harness/scene";
import { el, text, type IrElement, type IrNode } from "./ir.js";

export function iconNodesOf(name: string | undefined): IconNode {
  return iconNodesOrFallback(name);
}

/** `<svg>` IR for a lucide icon (stroke follows `currentColor`, like lucide-react). */
export function iconIr(
  name: string | undefined,
  size: number,
  strokeWidth = 2,
  extra: Record<string, string> = {},
): IrElement {
  const children = iconNodesOf(name).map(([tag, attrs]) => {
    const a: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) if (k !== "key") a[k] = String(v);
    return el(tag, { attrs: a, svg: true });
  });
  return el("svg", {
    svg: true,
    attrs: {
      xmlns: "http://www.w3.org/2000/svg",
      width: String(size),
      height: String(size),
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": String(strokeWidth),
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      ...extra,
    },
    children,
  });
}

/**
 * Inline SVG markup (DSL `el.svg`, already sanitised) as IR (+ `raw` for the HTML emitter). SVGs styled through `<style>` / classes (which the React
 * emitter cannot carry) and environments without a DOM parser become an `<img>` with a data URL instead.
 */
export function svgIr(markup: string, label?: string): IrElement {
  markup = ownIds(markup);
  const out = svgTree(markup, label);
  out.raw = markup; // the HTML emitter writes the markup itself (same DOM as the renderer, also without a DOM parser)
  return out;
}

let svgSeq = 0;
const OWN_ID = "sx";
/** The markup with `ownIds` prefixes taken out again: copies of one drawing compare equal (component detection). */
export const withoutOwnIds = (markup: string) => markup.replace(/(\sid="|#)sx[0-9a-z]+-/g, "$1");
/**
 * The SVG's own ids (gradients, clip paths, symbols) made unique on the page: copies of one drawing — a pictogram at
 * each breakpoint, several pictograms all defining `g1` — would otherwise share them, and `url(#g1)` resolves to the
 * first one in the document, which may sit in a hidden variant (display: none): the fill then draws nothing.
 */
export function ownIds(markup: string): string {
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  if (!ids.length) return markup;
  const p = `${OWN_ID}${(++svgSeq).toString(36)}-`;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = markup;
  for (const id of new Set(ids)) {
    const e = esc(id);
    out = out
      .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${p}${id}$2`)
      .replace(new RegExp(`url\\(\\s*(['"]?)#${e}\\1\\s*\\)`, "g"), `url(#${p}${id})`)
      .replace(new RegExp(`((?:xlink:)?href=")#${e}(")`, "g"), `$1#${p}${id}$2`);
  }
  return out;
}

function svgTree(markup: string, label?: string): IrElement {
  const img = () =>
    el("img", {
      attrs: { src: `data:image/svg+xml,${encodeURIComponent(markup)}`, alt: label ?? "" },
      style: { width: "100%", height: "100%", display: "block" },
    });
  if (typeof DOMParser === "undefined" || /<style[\s>]|\sclass\s*=/i.test(markup)) return img();
  const root = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return img();
  const conv = (n: Element): IrElement => {
    const attrs: Record<string, string> = {};
    const style: Record<string, string> = {};
    for (const a of Array.from(n.attributes)) {
      if (a.name === "style")
        for (const d of a.value.split(";")) {
          const i = d.indexOf(":");
          if (i > 0) style[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
      else attrs[a.name] = a.value;
    }
    const children: IrNode[] = [];
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 1) children.push(conv(c as Element));
      else if (c.nodeType === 3 && c.textContent?.trim()) children.push(text(c.textContent));
    }
    return el(n.nodeName, { attrs, style, children, svg: true });
  };
  const out = conv(root);
  out.style = { ...out.style, width: "100%", height: "100%", display: "block", overflow: "visible" };
  return out;
}
