// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// IR → semantic HTML + class-based CSS. Shared by the HTML zip, the single-file prototype, the clipboard and Dev Mode.
import type { SceneInteraction } from "@harness/protocol";
import {
  VOID_TAGS,
  declarations,
  escAttr,
  escHtml,
  type IrElement,
  type IrNode,
  type StyleMap,
} from "./ir.js";
import { slugify, type Namer } from "@harness/scene";
import { resolveVars, type VarMap } from "./tokens.js";
import { SYSTEM_FACES_CSS } from "@harness/scene";

export interface HtmlEmitOptions {
  /** class names from layer names (`hero-image`) instead of generated ones (`x12`) */
  semantic: boolean;
  /** keep `var(--t-*)` references; false → literal values */
  cssVars: boolean;
  vars: VarMap;
  namer: Namer;
  /**
   * How interactions are expressed:
   *  - 'none'      → dropped
   *  - 'links'     → `data-href` (multi-page export; nav.js follows it)
   *  - 'prototype' → `data-nav` / `data-back` / `data-url` + `data-transition` (single-file router)
   */
  interactions?: "none" | "links" | "prototype";
  /** map a navigate target (screen node id / name) to an href (links) or a screen key (prototype); null drops it */
  resolveTarget?: (target: string) => string | null;
  /** add `data-name` (smart-animate matching in the prototype runtime) */
  dataNames?: boolean;
  /** rewrite an image src (zip asset path / keep); null → drop the <img> and keep the placeholder background */
  imageSrc?: (src: string) => string | null;
  /** indentation unit; '' → compact */
  indent?: string;
}

export interface HtmlEmit {
  html: string;
  rules: string[];
}

/** Mutable counter for non-semantic class names, shared through the namer closure. */
const counters = new WeakMap<Namer, { n: number }>();

export function classNameFor(
  node: IrElement,
  opts: Pick<HtmlEmitOptions, "semantic" | "namer">,
  parentClass?: string | null,
): string {
  if (opts.semantic)
    return opts.namer(
      node.name
        ? slugify(node.name, node.tag)
        : parentClass
          ? `${parentClass.replace(/-\d+$/, "")}-${node.tag}`
          : node.tag,
    );
  let c = counters.get(opts.namer);
  if (!c) {
    c = { n: 0 };
    counters.set(opts.namer, c);
  }
  c.n += 1;
  return opts.namer(`x${c.n}`);
}

export function styleValue(v: string, opts: Pick<HtmlEmitOptions, "cssVars" | "vars">): string {
  return opts.cssVars ? v : resolveVars(v, opts.vars);
}

export function cssRule(
  selector: string,
  style: StyleMap,
  opts: Pick<HtmlEmitOptions, "cssVars" | "vars">,
): string {
  const body = Object.entries(style)
    .map(([k, v]) => `  ${k}: ${styleValue(v, opts)};`)
    .join("\n");
  return `${selector} {\n${body}\n}`;
}

function interactionAttrs(i: SceneInteraction | undefined, opts: HtmlEmitOptions): Record<string, string> {
  const mode = opts.interactions ?? "none";
  if (!i || mode === "none") return {};
  if (i.onTap === "navigate" && i.target) {
    const t = opts.resolveTarget ? opts.resolveTarget(i.target) : i.target;
    if (!t) return {};
    return mode === "links"
      ? { "data-href": t }
      : { "data-nav": t, "data-transition": i.transition ?? "smart" };
  }
  if (i.onTap === "back")
    return mode === "links"
      ? { "data-back": "" }
      : { "data-back": "", ...(i.transition ? { "data-transition": i.transition } : {}) };
  if (i.onTap === "open-url" && i.url) return { "data-url": i.url };
  return {};
}

/** Emit one IR subtree. `rules` collects the CSS for every class created. */
export function emitHtml(node: IrNode, opts: HtmlEmitOptions, depth = 0): HtmlEmit {
  const rules: string[] = [];
  const unit = opts.indent ?? "  ";
  const html = emit(node, depth, null);
  return { html, rules };

  /** recreate: a page section (`data-section`) is framed by markers the repair loop patches between */
  function emit(n: IrNode, d: number, parentClass: string | null): string {
    const out = emitNode(n, d, parentClass);
    if (n.kind !== "el" || n.attrs["data-section"] === undefined || !out) return out;
    const pad = unit ? unit.repeat(d) : "";
    const id = n.attrs["data-section"].replace(/--/g, "-");
    return `${pad}<!-- section:${id} -->\n${out}\n${pad}<!-- /section -->`;
  }

  function emitNode(n: IrNode, d: number, parentClass: string | null): string {
    const pad = unit ? unit.repeat(d) : "";
    if (n.kind === "text") return pad + escHtml(n.text);
    if (n.raw !== undefined) return pad + n.raw;
    let style = n.style;
    const attrs: Record<string, string> = { ...n.attrs };
    // images: rewrite or drop
    if (n.tag === "img" && attrs.src && opts.imageSrc) {
      const src = opts.imageSrc(attrs.src);
      if (src === null) return "";
      attrs.src = src;
    }
    // a <picture>'s other picture (one candidate: export/responsive.ts artDirection)
    if (n.tag === "source" && attrs.srcset && !/\s/.test(attrs.srcset.trim()) && opts.imageSrc) {
      const src = opts.imageSrc(attrs.srcset);
      if (src === null) return "";
      attrs.srcset = src;
    }
    const hasStyle = Object.keys(style).length > 0 || !!n.pseudo;
    let cls: string | null = null;
    if (hasStyle) {
      cls = classNameFor(n, opts, parentClass);
      if (Object.keys(style).length) rules.push(cssRule(`.${cls}`, style, opts));
      if (n.pseudo?.before) rules.push(cssRule(`.${cls}::before`, n.pseudo.before, opts));
      if (n.pseudo?.after) rules.push(cssRule(`.${cls}::after`, n.pseudo.after, opts));
      style = {};
    }
    Object.assign(attrs, interactionAttrs(n.interaction, opts));
    if (opts.dataNames && n.name && !n.svg) attrs["data-name"] = n.name;
    const attrStr =
      (cls ? ` class="${cls}"` : "") +
      Object.entries(attrs)
        .map(([k, v]) =>
          v === "" && (k.startsWith("data-") || k === "hidden") ? ` ${k}` : ` ${k}="${escAttr(v)}"`,
        )
        .join("");
    if (VOID_TAGS.has(n.tag)) return `${pad}<${n.tag}${attrStr}>`;
    if (!n.children.length) return `${pad}<${n.tag}${attrStr}></${n.tag}>`;
    // inline content (text, runs, glyphs) is emitted compactly: indentation would be real whitespace under pre-wrap
    const inline = INLINE_TAGS.has(n.tag) || n.children.some((c) => c.kind === "text");
    if (inline || !unit)
      return `${pad}<${n.tag}${attrStr}>${n.children.map((c) => emit(c, 0, cls ?? parentClass)).join("")}</${n.tag}>`;
    const inner = n.children
      .map((c) => emit(c, d + 1, cls ?? parentClass))
      .filter(Boolean)
      .join("\n");
    return `${pad}<${n.tag}${attrStr}>\n${inner}\n${pad}</${n.tag}>`;
  }
}

const INLINE_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "span",
  "a",
  "button",
  "label",
  "text",
  "tspan",
  "textPath",
]);

/**
 * Reset for exported screens (zero specificity so generated classes always win) + the SceneRenderer.module.css rules
 * the IR cannot carry inline (text trim, inline SVG boxes, icon-font glyphs, placeholders), so exports draw like the canvas.
 */
export const SCREEN_RESET_CSS = `*, *::before, *::after { box-sizing: border-box; }
:where(main[data-screen]) :where(h1, h2, h3, h4, p, figure, ul, ol, li) { margin: 0; padding: 0; list-style: none; }
:where(main[data-screen]) :where(button) { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; text-align: inherit; letter-spacing: inherit; word-spacing: inherit; text-transform: inherit; text-indent: inherit; text-shadow: inherit; }
:where(main[data-screen]) :where(input) { font: inherit; letter-spacing: inherit; margin: 0; }
:where(main[data-screen]) :where(input)::placeholder { color: var(--t-text-muted); opacity: 1; }
:where(main[data-screen]) :where(a) { color: inherit; text-decoration: none; }
:where(main[data-screen]) :where([data-href], [data-back], [data-url], [data-nav]) { cursor: pointer; }
[data-trim] { text-box: trim-both cap alphabetic; }
@supports not (text-box: trim-both cap alphabetic) { [data-trim] { margin-top: var(--trim-top, 0); margin-bottom: var(--trim-bottom, 0); } }
:where([data-svg]) > svg { width: 100%; height: 100%; display: block; overflow: visible; }
:where([data-glyph]) { display: none; text-box: trim-end text alphabetic; pointer-events: none; }
:where([data-glyph-svg]) { position: absolute; inset: 0; display: block; }
:where([data-glyph-svg]) > svg { width: 100%; height: 100%; display: block; overflow: visible; }
@supports (text-box: trim-end text alphabetic) { :where([data-glyph]) { display: block; } :where([data-glyph-svg]) { display: none; } }
`;

/** Page chrome + reset for the multi-page HTML export. App screens sit centred on a dark backdrop (`body[data-frame]`);
 *  web pages are full-bleed (docs/responsive.md). */
export const BASE_CSS = `/* Base */
html, body { margin: 0; }
body[data-frame] { background: #0b0b0d; min-height: 100vh; display: flex; justify-content: center; align-items: flex-start; padding: 24px 0; }
${SYSTEM_FACES_CSS}
${SCREEN_RESET_CSS}`;

export interface DocOptions {
  title: string;
  body: string;
  stylesheets?: string[];
  inlineCss?: string;
  scripts?: string[];
  inlineScript?: string;
  lang?: string;
  bodyAttrs?: Record<string, string>;
}

/** A BCP-47-ish language tag (the captured page's `<html lang>` is untrusted), else "en". */
export const safeLang = (lang: string | null | undefined): string => {
  const v = typeof lang === "string" ? lang.trim() : "";
  return /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(v) ? v : "en";
};

export function htmlDocument(o: DocOptions): string {
  const links = (o.stylesheets ?? []).map((h) => `  <link rel="stylesheet" href="${escAttr(h)}">`).join("\n");
  const scripts = (o.scripts ?? []).map((s) => `  <script src="${escAttr(s)}" defer></script>`).join("\n");
  return `<!doctype html>
<html lang="${escAttr(safeLang(o.lang))}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(o.title)}</title>
${links}${o.inlineCss ? `\n  <style>\n${o.inlineCss}\n  </style>` : ""}
${scripts}
</head>
<body${Object.entries(o.bodyAttrs ?? {})
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escAttr(v)}"`))
    .join("")}>
${o.body}${o.inlineScript ? `\n<script>\n${o.inlineScript}\n</script>` : ""}
</body>
</html>
`;
}

export { declarations };
