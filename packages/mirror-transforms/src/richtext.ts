/**
 * HTML -> CCM portable rich-text AST (MIGRATION_PLAN.md §3.3).
 *
 * - Block structure: paragraphs, headings, lists, blockquote, hr, embedded assets.
 * - Inline marks: strong/b, em/i, u/ins, code/kbd/samp, sup, sub, s/strike/del.
 * - Links: `resolveLink(href)` turns internal links into `ref`; everything else stays `href`.
 * - Images (`<img>`) and `<drupal-media data-entity-uuid>` become `embeddedAsset` via `resolveAsset`.
 * - Tables, iframes, scripts, forms, embeds and unknown block markup become `rawHtml` (with `reason`).
 * - Whitespace follows the CSS `white-space: normal` rules browsers apply: runs of ASCII whitespace
 *   collapse to one space, a space following another (also across element boundaries) is dropped, and
 *   spaces at the start/end of a line (block edge or `<br>`) are removed. NBSP is preserved.
 *   `<pre>` keeps its whitespace and becomes a code-marked paragraph with `break`s.
 */
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import { toHtml } from "hast-util-to-html";
import { toText } from "hast-util-to-text";
import type { Element, ElementContent, Root, RootContent } from "hast";
import type { Issue, Reference, RichBlock, RichInline, RichTextDoc } from "@harness/mirror-core";

type MarkName = "bold" | "italic" | "underline" | "code" | "superscript" | "subscript" | "strikethrough";
const MARK_ORDER: MarkName[] = ["bold", "italic", "underline", "code", "superscript", "subscript", "strikethrough"];

const MARK_TAGS: Record<string, MarkName> = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  u: "underline",
  ins: "underline",
  code: "code",
  kbd: "code",
  samp: "code",
  tt: "code",
  sup: "superscript",
  sub: "subscript",
  s: "strikethrough",
  strike: "strikethrough",
  del: "strikethrough",
};

/** Inline elements whose children are kept, the element itself carries no semantics we model. */
const TRANSPARENT_INLINE = new Set([
  "span", "font", "small", "big", "abbr", "acronym", "cite", "q", "mark", "time", "var", "dfn", "bdi", "bdo",
  "data", "label", "nobr", "a", "ruby", "rb", "rt", "rp", "output",
]);

/** Block containers that are unwrapped (children are converted in block context). */
const TRANSPARENT_BLOCK = new Set([
  "div", "section", "article", "main", "header", "footer", "aside", "nav", "address", "center", "hgroup",
  "html", "body", "figure", "picture", "template", "dd", "dt",
]);

/** Elements kept verbatim as rawHtml; value = reason. */
const RAW_REASON: Record<string, string> = {
  table: "table",
  iframe: "iframe",
  script: "script",
  noscript: "noscript",
  style: "style",
  object: "embed",
  embed: "embed",
  video: "video",
  audio: "audio",
  form: "form",
  input: "form",
  select: "form",
  textarea: "form",
  button: "form",
  fieldset: "form",
  canvas: "canvas",
  svg: "svg",
  math: "math",
  details: "details",
  dl: "definition list",
  map: "image map",
  dialog: "dialog",
};

const IGNORED = new Set(["head", "title", "meta", "link", "base", "wbr", "colgroup", "source", "track", "param", "area"]);

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "hr", "pre", "figcaption",
  ...TRANSPARENT_BLOCK,
  ...Object.keys(RAW_REASON).filter((t) => !["input", "select", "textarea", "button", "iframe", "svg", "math", "video", "audio", "canvas", "embed", "object", "script", "noscript", "style", "map"].includes(t)),
]);

const KNOWN_INLINE = new Set([...Object.keys(MARK_TAGS), ...TRANSPARENT_INLINE, "br", "img", "drupal-media", "drupal-entity"]);

export interface HtmlToRichTextOptions {
  /** Base URL of the source site; same-origin absolute URLs are turned into paths before resolving. */
  baseUrl?: string;
  /** Resolve an internal link (path, normalised against baseUrl) to an entry/term/asset reference. */
  resolveLink?(href: string): Reference | undefined;
  /** Resolve an image src (kind "img") or a drupal-media uuid (kind "media") to an asset reference. */
  resolveAsset?(srcOrUuid: string, kind: "img" | "media"): Reference | undefined;
  /** Included in issue `ref`s for traceability, e.g. "drupal:node:2:en#body". */
  ref?: string;
}

export interface RichTextStats {
  /** total number of AST nodes produced (blocks + inlines) */
  nodes: number;
  /** number of rawHtml blocks */
  rawHtml: number;
  /** rawHtml bytes / input bytes (0..1) — share of content kept as raw markup */
  rawHtmlShare: number;
  links: number;
  resolvedLinks: number;
  assets: number;
  inputBytes: number;
}

export interface HtmlToRichTextResult {
  doc: RichTextDoc;
  issues: Issue[];
  stats: RichTextStats;
}

interface Sink {
  push(n: RichInline): void;
  escape(b: RichBlock): void;
}

interface Ctx {
  opts: HtmlToRichTextOptions;
  issues: Issue[];
  stats: RichTextStats;
  rawBytes: number;
  origin?: string;
}

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).length;

export function parseHtmlFragment(html: string): Root {
  return unified().use(rehypeParse, { fragment: true }).parse(html) as Root;
}

export function htmlToRichText(html: string, opts: HtmlToRichTextOptions = {}): HtmlToRichTextResult {
  const stats: RichTextStats = { nodes: 0, rawHtml: 0, rawHtmlShare: 0, links: 0, resolvedLinks: 0, assets: 0, inputBytes: byteLen(html ?? "") };
  const ctx: Ctx = { opts, issues: [], stats, rawBytes: 0 };
  if (opts.baseUrl) {
    try {
      ctx.origin = new URL(opts.baseUrl).origin;
    } catch {
      /* ignore invalid baseUrl */
    }
  }
  const tree = parseHtmlFragment(html ?? "");
  const children = convertBlocks(tree.children, ctx);
  const doc: RichTextDoc = { type: "doc", children };
  stats.nodes = countNodes(doc.children);
  stats.rawHtmlShare = stats.inputBytes ? Math.min(1, ctx.rawBytes / stats.inputBytes) : 0;
  return { doc, issues: ctx.issues, stats };
}

// ------------------------------------------------------------------ block context

function convertBlocks(nodes: (RootContent | ElementContent)[], ctx: Ctx): RichBlock[] {
  const out: RichBlock[] = [];
  const para = paragraphSink(out, (children) => ({ type: "paragraph", children }));
  for (const n of nodes) {
    if (n.type === "text") {
      para.push({ type: "text", value: n.value });
      continue;
    }
    if (n.type !== "element") continue; // comments, doctype
    if (isBlockElement(n)) {
      para.flush();
      out.push(...convertBlockElement(n, ctx));
    } else {
      convertInline(n, [], para, ctx);
    }
  }
  para.flush();
  return out;
}

function isBlockElement(el: Element): boolean {
  const tag = el.tagName;
  if (BLOCK_TAGS.has(tag)) return true;
  if (KNOWN_INLINE.has(tag) || IGNORED.has(tag)) return false;
  if (RAW_REASON[tag]) return false; // inline-level raw elements (iframe, script …) escape from inline context
  return true; // unknown element at block level → rawHtml
}

function convertBlockElement(el: Element, ctx: Ctx): RichBlock[] {
  const tag = el.tagName;
  switch (tag) {
    case "p":
    case "figcaption":
      return inlineContainer(el.children, ctx, (children) => ({ type: "paragraph", children }));
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      return inlineContainer(el.children, ctx, (children) => ({ type: "heading", level, children }));
    }
    case "ul":
    case "ol":
      return [convertList(el, ctx)];
    case "li":
      // stray <li> outside a list
      return [{ type: "list", ordered: false, children: [{ type: "listItem", children: ensureBlock(convertBlocks(el.children, ctx)) }] }];
    case "blockquote": {
      const children = convertBlocks(el.children, ctx);
      return children.length ? [{ type: "blockquote", children }] : [];
    }
    case "hr":
      return [{ type: "hr" }];
    case "pre":
      return convertPre(el, ctx);
    case "figure":
      return convertFigure(el, ctx);
    default:
      if (TRANSPARENT_BLOCK.has(tag)) {
        noteStyle(el, ctx);
        return convertBlocks(el.children, ctx);
      }
      if (RAW_REASON[tag]) return [raw(el, RAW_REASON[tag], ctx)];
      return [raw(el, `unknown element <${tag}>`, ctx)];
  }
}

function ensureBlock(blocks: RichBlock[]): RichBlock[] {
  return blocks.length ? blocks : [{ type: "paragraph", children: [{ type: "text", value: "" }] }];
}

function convertList(el: Element, ctx: Ctx): RichBlock {
  const ordered = el.tagName === "ol";
  const items: { type: "listItem"; children: RichBlock[] }[] = [];
  let stray: ElementContent[] = [];
  const flushStray = () => {
    if (stray.some((n) => n.type === "element" || (n.type === "text" && n.value.trim()))) {
      items.push({ type: "listItem", children: ensureBlock(convertBlocks(stray, ctx)) });
    }
    stray = [];
  };
  for (const c of el.children) {
    if (c.type === "element" && c.tagName === "li") {
      flushStray();
      items.push({ type: "listItem", children: ensureBlock(convertBlocks(c.children, ctx)) });
    } else stray.push(c);
  }
  flushStray();
  return { type: "list", ordered, children: items };
}

function convertPre(el: Element, ctx: Ctx): RichBlock[] {
  const out: RichBlock[] = [];
  const sink = paragraphSink(out, (children) => ({ type: "paragraph", children }), true);
  for (const c of el.children) convertInline(c, ["code"], sink, ctx, true);
  sink.flush();
  return out;
}

function convertFigure(el: Element, ctx: Ctx): RichBlock[] {
  const caption = el.children.find((c): c is Element => c.type === "element" && c.tagName === "figcaption");
  const media = findFirst(el, (e) => e.tagName === "img" || e.tagName === "drupal-media");
  if (caption && media) {
    const blocks = convertBlocks(el.children.filter((c) => c !== caption), ctx);
    const text = collapse(toText(caption)).trim();
    const idx = blocks.findIndex((b) => b.type === "embeddedAsset");
    if (idx >= 0 && text) {
      const b = blocks[idx] as Extract<RichBlock, { type: "embeddedAsset" }>;
      blocks[idx] = { ...b, caption: text };
      return blocks;
    }
    return [...blocks, ...convertBlockElement(caption, ctx)];
  }
  return convertBlocks(el.children, ctx);
}

function findFirst(el: Element, pred: (e: Element) => boolean): Element | undefined {
  for (const c of el.children) {
    if (c.type !== "element") continue;
    if (pred(c)) return c;
    const f = findFirst(c, pred);
    if (f) return f;
  }
  return undefined;
}

function inlineContainer(children: ElementContent[], ctx: Ctx, make: (c: RichInline[]) => RichBlock): RichBlock[] {
  const out: RichBlock[] = [];
  const sink = paragraphSink(out, make);
  for (const c of children) convertInline(c, [], sink, ctx);
  sink.flush();
  return out;
}

function paragraphSink(out: RichBlock[], make: (c: RichInline[]) => RichBlock, preserve = false) {
  let buf: RichInline[] = [];
  const flush = () => {
    const cleaned = preserve ? mergeTexts(dropEmpty(buf)) : cleanInlines(buf);
    if (cleaned.length) out.push(make(cleaned));
    buf = [];
  };
  return {
    push: (n: RichInline) => void buf.push(n),
    escape: (b: RichBlock) => {
      flush();
      out.push(b);
    },
    flush,
  };
}

// ------------------------------------------------------------------ inline context

function convertInline(n: ElementContent | RootContent, marks: MarkName[], sink: Sink, ctx: Ctx, pre = false): void {
  if (n.type === "text") {
    if (!pre) {
      sink.push(text(n.value, marks));
      return;
    }
    const lines = n.value.split(/\r\n|\r|\n/);
    lines.forEach((line, i) => {
      if (i > 0) sink.push({ type: "break" });
      if (line) sink.push(text(line, marks));
    });
    return;
  }
  if (n.type !== "element") return;
  const el = n;
  const tag = el.tagName;

  if (IGNORED.has(tag)) return;
  if (tag === "br") {
    sink.push({ type: "break" });
    return;
  }
  if (tag === "img") {
    sink.escape(convertImg(el, ctx));
    return;
  }
  if (tag === "drupal-media" || (tag === "drupal-entity" && prop(el, "dataEntityType") === "media")) {
    sink.escape(convertDrupalMedia(el, ctx));
    return;
  }
  if (RAW_REASON[tag]) {
    sink.escape(raw(el, RAW_REASON[tag], ctx));
    return;
  }
  if (tag === "a" && prop(el, "href") !== undefined) {
    convertLink(el, marks, sink, ctx, pre);
    return;
  }
  const mark = MARK_TAGS[tag];
  if (mark) {
    const next = marks.includes(mark) ? marks : [...marks, mark];
    for (const c of el.children) convertInline(c, next, sink, ctx, pre);
    return;
  }
  if (TRANSPARENT_INLINE.has(tag)) {
    noteStyle(el, ctx);
    for (const c of el.children) convertInline(c, marks, sink, ctx, pre);
    return;
  }
  if (tag === "pre") {
    for (const b of convertPre(el, ctx)) sink.escape(b);
    return;
  }
  // block-level element (or unknown element) inside inline context → escape as blocks
  for (const b of convertBlockElement(el, ctx)) sink.escape(b);
}

function convertLink(el: Element, marks: MarkName[], parent: Sink, ctx: Ctx, pre: boolean): void {
  const rawHref = String(prop(el, "href") ?? "").trim();
  const title = prop(el, "title");
  ctx.stats.links++;
  const base: { type: "link"; href?: string; ref?: Reference; title?: string } = { type: "link" };
  const local = toLocalPath(rawHref, ctx);
  const ref = local !== undefined ? ctx.opts.resolveLink?.(local) : undefined;
  if (ref) {
    base.ref = ref;
    ctx.stats.resolvedLinks++;
  } else {
    base.href = rawHref;
    if (local !== undefined && !local.startsWith("#") && ctx.opts.resolveLink) {
      ctx.issues.push({
        severity: "warning",
        code: "UNRESOLVED_INTERNAL_LINK",
        message: `Internal link "${rawHref}" could not be resolved to an entry; kept as href`,
        ref: ctx.opts.ref,
        actionable: true,
      });
    }
  }
  if (title !== undefined && title !== "") base.title = String(title);

  let buf: RichInline[] = [];
  let emitted = false;
  const sink: Sink = {
    push: (n) => void buf.push(n),
    escape: (b) => {
      if (buf.length) parent.push({ ...base, children: buf });
      emitted = emitted || buf.length > 0;
      buf = [];
      if (b.type === "embeddedAsset") {
        ctx.issues.push({ severity: "info", code: "LINKED_IMAGE", message: `Image inside link "${rawHref}" — link on the image itself is not representable and was dropped`, ref: ctx.opts.ref });
      }
      parent.escape(b);
    },
  };
  for (const c of el.children) convertInline(c, marks, sink, ctx, pre);
  if (buf.length || !emitted) parent.push({ ...base, children: buf });
}

/** Returns a site-local path for internal hrefs ("/node/2", "../x", same-origin absolute URLs), else undefined. */
function toLocalPath(href: string, ctx: Ctx): string | undefined {
  if (!href) return undefined;
  if (href.startsWith("#")) return href;
  if (href.startsWith("//")) {
    try {
      const u = new URL((ctx.origin ? new URL(ctx.origin).protocol : "https:") + href);
      return ctx.origin && u.origin === ctx.origin ? stripOrigin(u) : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (/^(entity|internal|base|route):/i.test(href)) return href; // Drupal link-field URIs
    if (!/^https?:/i.test(href)) return undefined; // mailto:, tel:, javascript: ...
    try {
      const u = new URL(href);
      if (ctx.origin && u.origin === ctx.origin) return stripOrigin(u);
    } catch {
      /* not a URL */
    }
    return undefined;
  }
  if (href.startsWith("/")) return href;
  // relative path
  if (ctx.origin) {
    try {
      return stripOrigin(new URL(href, ctx.opts.baseUrl));
    } catch {
      return href;
    }
  }
  return href;
}

function stripOrigin(u: URL): string {
  return u.pathname + u.search + u.hash;
}

function convertImg(el: Element, ctx: Ctx): RichBlock {
  const src = String(prop(el, "src") ?? "");
  const local = toLocalPath(src, ctx) ?? src;
  const ref = src ? ctx.opts.resolveAsset?.(local, "img") : undefined;
  if (ref) {
    ctx.stats.assets++;
    const caption = prop(el, "title");
    return caption ? { type: "embeddedAsset", ref, caption: String(caption) } : { type: "embeddedAsset", ref };
  }
  ctx.issues.push({ severity: "warning", code: "UNRESOLVED_IMAGE", message: `Inline image "${src}" not resolved to an asset; kept as rawHtml`, ref: ctx.opts.ref, actionable: true });
  return raw(el, "unresolved image", ctx);
}

function convertDrupalMedia(el: Element, ctx: Ctx): RichBlock {
  const uuid = String(prop(el, "dataEntityUuid") ?? "");
  const ref = uuid ? ctx.opts.resolveAsset?.(uuid, "media") : undefined;
  if (ref) {
    ctx.stats.assets++;
    const caption = prop(el, "dataCaption");
    return caption ? { type: "embeddedAsset", ref, caption: String(caption) } : { type: "embeddedAsset", ref };
  }
  ctx.issues.push({ severity: "warning", code: "UNRESOLVED_MEDIA", message: `<${el.tagName}> with uuid "${uuid}" not resolved to an asset; kept as rawHtml`, ref: ctx.opts.ref, actionable: true });
  return raw(el, `unresolved ${el.tagName}`, ctx);
}

function raw(el: Element, reason: string, ctx: Ctx): RichBlock {
  const html = toHtml(el);
  ctx.stats.rawHtml++;
  ctx.rawBytes += byteLen(html);
  const severity = reason === "script" || reason.startsWith("unknown") || reason.startsWith("unresolved") ? "warning" : "info";
  ctx.issues.push({ severity, code: "RAW_HTML", message: `Kept <${el.tagName}> as rawHtml (${reason})`, ref: ctx.opts.ref });
  return { type: "rawHtml", html, reason };
}

function noteStyle(el: Element, ctx: Ctx) {
  if (prop(el, "style")) {
    ctx.issues.push({ severity: "info", code: "INLINE_STYLE_DROPPED", message: `Inline style on <${el.tagName}> dropped`, ref: ctx.opts.ref });
  }
}

function prop(el: Element, name: string): string | undefined {
  const v = el.properties?.[name];
  if (v === undefined || v === null || v === false) return undefined;
  return Array.isArray(v) ? v.join(" ") : String(v);
}

function text(value: string, marks: MarkName[]): RichInline {
  return marks.length ? { type: "text", value, marks: sortMarks(marks) } : { type: "text", value };
}

function sortMarks(m: MarkName[]): MarkName[] {
  return MARK_ORDER.filter((x) => m.includes(x));
}

// ------------------------------------------------------------------ whitespace (CSS white-space: normal)

const collapse = (s: string) => s.replace(/[ \t\n\r\f]+/g, " ");

type TextNode = Extract<RichInline, { type: "text" }>;

function cloneInlines(items: RichInline[]): RichInline[] {
  return items.map((n) => (n.type === "link" ? { ...n, children: cloneInlines(n.children) } : n.type === "text" ? { ...n } : n));
}

/** Flatten into document order; links are traversed. */
function flatten(items: RichInline[], acc: RichInline[] = []): RichInline[] {
  for (const n of items) {
    if (n.type === "link") flatten(n.children, acc);
    else acc.push(n);
  }
  return acc;
}

export function cleanInlines(input: RichInline[]): RichInline[] {
  const items = cloneInlines(input);
  const flat = flatten(items);
  for (const n of flat) if (n.type === "text") n.value = collapse(n.value);
  // forward: drop a space that follows a space or starts a line
  let prevSpace = true;
  for (const n of flat) {
    if (n.type === "break") prevSpace = true;
    else if (n.type === "inlineEntry") prevSpace = false;
    else if (n.type === "text" && n.value) {
      if (prevSpace && n.value.startsWith(" ")) n.value = n.value.slice(1);
      if (n.value) prevSpace = n.value.endsWith(" ");
    }
  }
  // backward: drop spaces at the end of a line
  let lineEnd = true;
  for (let i = flat.length - 1; i >= 0; i--) {
    const n = flat[i];
    if (n.type === "break") lineEnd = true;
    else if (n.type === "inlineEntry") lineEnd = false;
    else if (n.type === "text" && n.value) {
      if (lineEnd) n.value = n.value.replace(/ +$/, "");
      if (n.value) lineEnd = false;
    }
  }
  const cleaned = mergeTexts(dropEmpty(items));
  // a block consisting only of breaks renders as empty lines — keep only if it has visible content
  return flatten(cleaned).some((n) => n.type !== "break") ? trimBreaks(cleaned) : [];
}

function trimBreaks(items: RichInline[]): RichInline[] {
  // a trailing <br> at the end of a block does not create an extra line in browsers
  const out = [...items];
  while (out.length && out[out.length - 1].type === "break") out.pop();
  return out;
}

function dropEmpty(items: RichInline[]): RichInline[] {
  const out: RichInline[] = [];
  for (const n of items) {
    if (n.type === "text" && n.value === "") continue;
    if (n.type === "link") {
      const children = dropEmpty(n.children);
      if (!children.length) continue; // empty anchors are invisible
      out.push({ ...n, children });
      continue;
    }
    out.push(n);
  }
  return out;
}

function sameMarks(a?: string[], b?: string[]) {
  return (a ?? []).join(",") === (b ?? []).join(",");
}

function mergeTexts(items: RichInline[]): RichInline[] {
  const out: RichInline[] = [];
  for (const n of items) {
    const prev = out[out.length - 1];
    if (n.type === "link") {
      out.push({ ...n, children: mergeTexts(n.children) });
    } else if (n.type === "text" && prev?.type === "text" && sameMarks(prev.marks, n.marks)) {
      out[out.length - 1] = { ...(prev as TextNode), value: (prev as TextNode).value + n.value };
    } else out.push(n);
  }
  return out;
}

// ------------------------------------------------------------------ helpers

function countNodes(blocks: RichBlock[]): number {
  let n = 0;
  const inl = (xs: RichInline[]) => {
    for (const x of xs) {
      n++;
      if (x.type === "link") inl(x.children);
    }
  };
  const blk = (xs: RichBlock[]) => {
    for (const b of xs) {
      n++;
      if (b.type === "paragraph" || b.type === "heading") inl(b.children);
      else if (b.type === "blockquote") blk(b.children);
      else if (b.type === "list")
        for (const li of b.children) {
          n++;
          blk(li.children);
        }
    }
  };
  blk(blocks);
  return n;
}

/** Rendered plain text of the doc: blocks separated by blank lines, list items/breaks by newlines. */
export function richTextToPlainText(doc: RichTextDoc): string {
  const inl = (xs: RichInline[]): string =>
    xs.map((x) => (x.type === "text" ? x.value : x.type === "break" ? "\n" : x.type === "link" ? inl(x.children) : "")).join("");
  const blk = (b: RichBlock): string => {
    switch (b.type) {
      case "paragraph":
      case "heading":
        return inl(b.children);
      case "list":
        return b.children.map((li) => li.children.map(blk).filter(Boolean).join("\n")).join("\n");
      case "blockquote":
        return b.children.map(blk).filter(Boolean).join("\n\n");
      case "embeddedAsset":
        return b.caption ?? "";
      case "rawHtml":
        return collapse(toText(parseHtmlFragment(b.html))).trim();
      default:
        return "";
    }
  };
  return doc.children.map(blk).filter((s) => s !== "").join("\n\n");
}

/** Quick quality scan of an HTML fragment (used by analyze: inline styles, scripts, iframes …). */
export interface HtmlQuality {
  bytes: number;
  inlineStyles: number;
  scripts: number;
  iframes: number;
  tables: number;
  embeds: number;
  images: number;
  drupalMedia: number;
  unknownElements: string[];
}

export function inspectHtml(html: string): HtmlQuality {
  const q: HtmlQuality = { bytes: byteLen(html ?? ""), inlineStyles: 0, scripts: 0, iframes: 0, tables: 0, embeds: 0, images: 0, drupalMedia: 0, unknownElements: [] };
  const unknown = new Set<string>();
  const known = new Set([...BLOCK_TAGS, ...KNOWN_INLINE, ...IGNORED, ...Object.keys(RAW_REASON), "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "col", "option", "optgroup", "legend", "summary", "track", "param", "source", "path", "g"]);
  const walk = (nodes: (RootContent | ElementContent)[]) => {
    for (const n of nodes) {
      if (n.type !== "element") continue;
      if (n.properties?.style) q.inlineStyles++;
      const t = n.tagName;
      if (t === "script") q.scripts++;
      else if (t === "iframe") q.iframes++;
      else if (t === "table") q.tables++;
      else if (t === "embed" || t === "object" || t === "video" || t === "audio") q.embeds++;
      else if (t === "img") q.images++;
      else if (t === "drupal-media" || t === "drupal-entity") q.drupalMedia++;
      else if (!known.has(t)) unknown.add(t);
      walk(n.children);
    }
  };
  walk(parseHtmlFragment(html ?? "").children);
  q.unknownElements = [...unknown].sort();
  return q;
}
