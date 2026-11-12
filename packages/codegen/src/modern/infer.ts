// What CSS reproduces a box at every width of a variant's range: read from its walks at those widths (the main walk
// and the alt walks) and written as layout intent — auto widths that fill their container, shares of it, caps,
// flex / grid tracks, fluid spacing and type — never as the boxes' measured coordinates.
import type { SnapElement, SnapFont, SnapNode, SnapText } from "@harness/capture";
import { fitCost, fitCss, fitSamples, isShare, px, tol, type Fit, type Sample } from "./fit.js";
import { inWalk, isEl, isTextNode, type UNode, type Unified, type Walk } from "./unify.js";

export type Decls = Map<string, string>;

interface S {
  w: Walk;
  n: SnapElement;
  p?: SnapElement;
}

const BLOCK_TAGS = new Set([
  "body",
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "figure",
  "figcaption",
  "form",
  "blockquote",
  "address",
  "fieldset",
  "dl",
  "dt",
  "dd",
  "hr",
  "details",
  "summary",
  "img",
  "picture",
  "video",
  "canvas",
  "svg",
  "iframe",
  "table",
]);
const INLINE_BLOCK = new Set(["button", "input", "select", "textarea"]);

/** display after the output's reset (modern reset: media are blocks) */
export function defaultDisplay(tag: string): string {
  if (tag === "li") return "list-item";
  if (BLOCK_TAGS.has(tag)) return "block";
  if (INLINE_BLOCK.has(tag)) return "inline-block";
  if (tag.includes("-")) return "block";
  return "inline";
}

const sides = (v: number[] | undefined) => v ?? [0, 0, 0, 0];

/** the box untransformed (a transformed box's rect is the bounds of its transformed shape) */
function geom(n: SnapElement) {
  if (n.size && n.style?.transform) {
    const cx = n.rect.x + n.rect.w / 2,
      cy = n.rect.y + n.rect.h / 2;
    return { x: cx - n.size.w / 2, y: cy - n.size.h / 2, w: n.size.w, h: n.size.h };
  }
  return n.rect;
}

/** content box of a box */
export function contentBox(n: SnapElement) {
  const g = geom(n);
  const b = sides(n.layout?.borderWidth),
    p = sides(n.layout?.padding);
  return {
    x: g.x + b[3] + p[3],
    y: g.y + b[0] + p[0],
    w: g.w - b[1] - b[3] - p[1] - p[3],
    h: g.h - b[0] - b[2] - p[0] - p[2],
  };
}

/** padding box (the containing block of absolutely positioned children) */
function paddingBox(n: SnapElement) {
  const g = geom(n);
  const b = sides(n.layout?.borderWidth);
  return { x: g.x + b[3], y: g.y + b[0], w: g.w - b[1] - b[3], h: g.h - b[0] - b[2] };
}

const inFlow = (n: SnapElement) => !/^(absolute|fixed)$/.test(n.layout?.position ?? "static");

/** The parent that lays the box out (display: contents parents hand their children to their own parent). */
function layoutParent(w: Walk, n: SnapNode): SnapElement | undefined {
  let p = w.parentOf.get(n);
  while (p?.contents) p = w.parentOf.get(p);
  return p;
}

/** The containing block of an absolutely / fixed positioned box in this walk. */
function containingBlock(w: Walk, n: SnapElement): { x: number; y: number; w: number; h: number } {
  if (n.layout?.position === "fixed") return { x: 0, y: 0, w: w.vw, h: w.vh };
  for (let p = w.parentOf.get(n); p; p = w.parentOf.get(p)) {
    const pos = p.layout?.position ?? "static";
    if (pos !== "static" || p.style?.transform || p.style?.filter) return paddingBox(p);
  }
  return { x: 0, y: 0, w: w.vw, h: Math.max(w.vh, 1) };
}

/** px a box's in-flow content takes (from its content top to the last child's margin edge, plus padding + border). */
function contentExtent(w: Walk, n: SnapElement): number | null {
  const cb = contentBox(n);
  let bottom = cb.y,
    any = false;
  const visit = (c: SnapNode) => {
    if (c.kind === "text") {
      // a line's rect is its glyphs' box: the line box around it is as tall as the line height
      const t = c as SnapText;
      const lh = t.font.lineHeight ?? t.font.size * 1.2;
      for (const l of t.lines) {
        bottom = Math.max(bottom, l.y + l.h + Math.max(0, (lh - l.h) / 2));
        any = true;
      }
      return;
    }
    const e = c as SnapElement;
    if (e.kind === "marker") return;
    if (e.contents) {
      for (const k of e.children ?? []) visit(k);
      return;
    }
    if (!inFlow(e) || (e.layout?.float && e.layout.float !== "none")) return;
    const g = geom(e);
    const mb = sides(e.layout?.margin)[2];
    bottom = Math.max(bottom, g.y + g.h + Math.max(0, mb));
    any = true;
  };
  for (const c of n.children ?? []) if (layoutParent(w, c) === n || w.parentOf.get(c) === n) visit(c);
  if (!any) return null;
  const b = sides(n.layout?.borderWidth),
    p = sides(n.layout?.padding);
  return bottom - geom(n).y + p[2] + b[2];
}

/** right edge of a box's content (its widest line / child): a box this wide is sized by its content */
function contentWidth(n: SnapElement): number | null {
  const cb = contentBox(n);
  let left = Infinity,
    right = -Infinity;
  const visit = (c: SnapNode, depth: number) => {
    if (c.kind === "text") {
      for (const l of (c as SnapText).lines) {
        left = Math.min(left, l.x);
        right = Math.max(right, l.x + l.w);
      }
      return;
    }
    const e = c as SnapElement;
    if (!inFlow(e)) return;
    const g = geom(e);
    const m = sides(e.layout?.margin);
    left = Math.min(left, g.x - Math.max(0, m[3]));
    right = Math.max(right, g.x + g.w + Math.max(0, m[1]));
    if (depth < 0) for (const k of e.children ?? []) visit(k, depth + 1);
  };
  for (const c of n.children ?? []) visit(c, 0);
  if (!Number.isFinite(left)) return null;
  const b = sides(n.layout?.borderWidth),
    p = sides(n.layout?.padding);
  return right - Math.min(left, cb.x) + p[1] + p[3] + b[1] + b[3];
}

const hasText = (n: SnapElement): boolean =>
  (n.children ?? []).some((c) => c.kind === "text" || hasText(c as SnapElement));

const REPLACED = new Set(["img", "video", "canvas", "iframe", "svg", "picture", "object", "embed"]);
export const isMedia = (n: SnapElement) =>
  (!!n.kind && n.kind !== "input" && n.kind !== "br" && n.kind !== "marker") || REPLACED.has(n.tag);

/** The variant's samples of a node: its box and parent in every walk of the range. */
function samplesOf(u: UNode, walks: Walk[]): S[] {
  const out: S[] = [];
  for (const w of walks) {
    const hit = inWalk(w, u.key);
    if (!hit || !isEl(hit.n) || !hit.n.rect) continue;
    out.push({ w, n: hit.n, p: layoutParent(w, hit.n) });
  }
  return out;
}

/** best of a fit against the viewport and one against the container (the cheaper one; ties → `prefer`) */
function bestFit(
  vwPts: Sample[],
  cbPts: Sample[] | null,
  prefer: "vw" | "%" = "vw",
): { f: Fit; unit: "vw" | "%" } | null {
  const a = fitSamples(vwPts);
  const b = cbPts ? fitSamples(cbPts) : null;
  if (!a && !b) return null;
  const ca = fitCost(a),
    cb = fitCost(b);
  if (a && (!b || ca < cb || (ca === cb && prefer === "vw"))) return { f: a, unit: "vw" };
  return { f: b!, unit: "%" };
}

/** A length that may vary with the width: constant, fluid in the viewport, or a share of the container. */
function fluid(samples: S[], value: (s: S) => number | undefined, prefer: "vw" | "%" = "vw"): string | null {
  const vw: Sample[] = [],
    cb: Sample[] = [];
  for (const s of samples) {
    const y = value(s);
    if (y === undefined || !Number.isFinite(y)) continue;
    vw.push({ x: s.w.vw, y });
    if (s.p) cb.push({ x: contentBox(s.p).w, y });
  }
  if (!vw.length) return null;
  const f = bestFit(vw, cb.length === vw.length ? cb : null, prefer);
  if (!f) return px(vw.find((p) => p.x === samples[0]!.w.vw)?.y ?? vw[0]!.y);
  return fitCss(f.f, f.unit);
}

const four = (t: string, r: string, b: string, l: string) =>
  t === b && r === l ? (t === r ? t : `${t} ${r}`) : r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`;

/** CSS of one element over one variant's range (its walks). */
export function elementDecls(u: UNode, vi: number, model: Unified, ctx: InferContext): Decls {
  const walks = model.walks[vi]!;
  const d: Decls = new Map();
  const ss = samplesOf(u, walks);
  if (!ss.length) return d;
  const main = ss[0]!.w === walks[0] ? ss[0]! : ss[0]!;
  const n = main.n;
  const L = n.layout ?? { display: "inline", position: "static" };
  const St = n.style ?? {};
  const tag = ctx.tagOf(u);
  // a line break: shown or not, nothing else
  if (n.kind === "br" || tag === "br") return d;
  const media = isMedia(n);
  // ---- display / position
  let display = n.contents ? "contents" : L.display;
  if (ctx.slider(u, "track")) display = "flex";
  if (display && display !== defaultDisplay(tag)) d.set("display", display);
  if (n.contents) return d;
  const pos = L.position ?? "static";
  if (pos !== "static") d.set("position", pos);
  if (L.z !== undefined && pos !== "static") d.set("z-index", String(L.z));
  if (pos === "sticky") d.set("top", px(Math.max(0, n.scrollShift ? 0 : 0)));
  // ---- flex / grid container
  if (/flex/.test(display ?? "")) {
    if (L.dir && L.dir !== "row") d.set("flex-direction", L.dir);
    if (L.wrap && L.wrap !== "nowrap") d.set("flex-wrap", L.wrap);
    if (L.justify && !/^(normal|flex-start|start)$/.test(L.justify)) d.set("justify-content", L.justify);
    if (L.align && !/^(normal|stretch)$/.test(L.align)) d.set("align-items", L.align);
  }
  if (/grid/.test(display ?? "")) {
    const cols = gridTracks(ss, (s) => s.n.layout?.cols);
    if (cols) d.set("grid-template-columns", cols);
    if (L.justify && !/^(normal|start)$/.test(L.justify)) d.set("justify-content", L.justify);
    if (L.align && !/^(normal|stretch)$/.test(L.align)) d.set("align-items", L.align);
  }
  if (/flex|grid/.test(display ?? "") && L.gap && (L.gap[0] || L.gap[1])) {
    const rg = fluid(ss, (s) => s.n.layout?.gap?.[0] ?? 0) ?? "0";
    const cg = fluid(ss, (s) => s.n.layout?.gap?.[1] ?? 0) ?? "0";
    d.set("gap", rg === cg ? rg : `${rg} ${cg}`);
  }
  if (L.columns) {
    if (L.columns.count) d.set("column-count", String(L.columns.count));
    if (L.columns.width) d.set("column-width", px(L.columns.width));
    d.set("column-gap", px(L.columns.gap));
  }
  // ---- spacing
  if (ss.some((s) => s.n.layout?.padding)) {
    const p = [0, 1, 2, 3].map((k) => fluid(ss, (s) => sides(s.n.layout?.padding)[k], "%") ?? "0");
    if (ctx.slider(u, "track")) p[1] = p[3] = "0";
    if (p.some((x) => x !== "0")) d.set("padding", four(p[0]!, p[1]!, p[2]!, p[3]!));
  }
  const parent = main.p;
  const pDisplay = parent?.layout?.display ?? "block";
  const flexParent = /flex/.test(pDisplay);
  const gridParent = /grid/.test(pDisplay);
  const rowParent = flexParent && !/column/.test(parent?.layout?.dir ?? "row");
  const blockLevel = !/^inline/.test(display ?? "") && display !== "contents";
  // auto margins: a block narrower than its container, as far from both sides
  // (in a row of its own too: the only box of a flex row, its auto margins centre it there as well)
  const alone = (s: S) =>
    (s.p?.children ?? []).filter(
      (c) => c.kind !== "text" && inFlow(c as SnapElement) && geom(c as SnapElement).w > 0,
    ).length === 1;
  const centred =
    inFlow(n) &&
    blockLevel &&
    (!flexParent || (rowParent && ss.every(alone))) &&
    !gridParent &&
    ss.every((s) => {
      if (!s.p) return false;
      const cb = contentBox(s.p);
      const g = geom(s.n);
      const l = g.x - cb.x,
        r = cb.x + cb.w - (g.x + g.w);
      return l > 1 && Math.abs(l - r) <= 1.5;
    });
  if (ss.some((s) => s.n.layout?.margin) || centred) {
    const m = [0, 1, 2, 3].map((k) => fluid(ss, (s) => sides(s.n.layout?.margin)[k], "%") ?? "0");
    if (centred) m[1] = m[3] = "auto";
    if (m.some((x) => x !== "0")) d.set("margin", four(m[0]!, m[1]!, m[2]!, m[3]!));
  }
  // ---- size
  if (inFlow(n)) {
    if (!(display ?? "").startsWith("table"))
      inferFlowSize(u, ss, d, { flexParent, gridParent, rowParent, blockLevel, centred, media, tag, ctx });
  } else inferPlaced(ss, d, media);
  // flex item
  if (flexParent && inFlow(n)) {
    if (L.grow) {
      const basis = L.basis ?? (rowParent && d.has("width") ? d.get("width")! : "0%");
      d.set("flex", `${L.grow} ${L.shrink ?? 1} ${basis}`);
      if (rowParent) d.delete("width");
    } else if (d.has("flex")) {
      // a slide: its own flex
    } else if (L.basis && L.basis !== "auto" && /%$/.test(L.basis)) {
      // the page's own share of the row
      d.set("flex", `0 ${L.shrink ?? 1} ${L.basis}`);
      if (rowParent) d.delete("width");
    } else {
      if (L.shrink !== undefined && L.shrink !== 1) d.set("flex-shrink", String(L.shrink));
      if (L.basis && L.basis !== "auto") d.set("flex-basis", L.basis);
    }
  }
  if (L.alignSelf && L.alignSelf !== "auto" && (flexParent || gridParent)) d.set("align-self", L.alignSelf);
  if (L.order && (flexParent || gridParent)) d.set("order", String(L.order));
  if (gridParent) {
    // placement by names needs the parent's areas; without them, the lines the item spans (from where it sits)
    const named = (v?: string) => !!v && /[a-z]/i.test(v.replace(/\bspan\b|\bauto\b/g, ""));
    const areas = !!parent?.layout?.areas;
    for (const [prop, v, axis] of [
      ["grid-column", L.gridColumn, "x"],
      ["grid-row", L.gridRow, "y"],
    ] as const) {
      if (!v) continue;
      if (!named(v) || areas) d.set(prop, v);
      else {
        const lines = gridLines(main, axis);
        if (lines) d.set(prop, `${lines[0]} / ${lines[1]}`);
      }
    }
  }
  if (/grid/.test(display ?? "") && L.areas) d.set("grid-template-areas", L.areas);
  if (L.float) d.set("float", L.float);
  if (L.minW) d.set("min-width", px(L.minW));
  if (L.minH && !d.has("min-height") && !media) {
    // a minimum that is a share of the viewport's height (55vh): the walk in a taller viewport grew the box by as much
    const VH = main.w.vh;
    const r0 = L.minH / VH,
      r1 = n.vh ? (n.rect.h + n.vh) / (VH + 200) : NaN;
    if (VH > 0 && n.vh && Math.abs(r0 - r1) < 0.01) d.set("min-height", `${Math.round(r0 * 1000) / 10}vh`);
    else d.set("min-height", px(L.minH));
  }
  if (L.aspect && !d.has("aspect-ratio") && !d.has("height"))
    d.set("aspect-ratio", L.aspect.replace(/^auto\s+/, ""));
  if (L.boxSizing === "content-box") d.set("box-sizing", "content-box");
  // ---- paint
  paint(n, St, d, ctx, u, main.p);
  if (ctx.slider(u, "track")) {
    d.delete("transform");
    d.delete("translate");
  }
  return d;
}

interface FlowCtx {
  flexParent: boolean;
  gridParent: boolean;
  rowParent: boolean;
  blockLevel: boolean;
  centred: boolean;
  media: boolean;
  tag: string;
  ctx: InferContext;
}

function inferFlowSize(u: UNode, ss: S[], d: Decls, c: FlowCtx) {
  const n = ss[0]!.n;
  const L = n.layout ?? { display: "inline", position: "static" };
  const avail = (s: S) => {
    const cb = s.p ? contentBox(s.p) : { w: s.w.vw };
    const m = sides(s.n.layout?.margin);
    return cb.w - m[1] - m[3];
  };
  const W = (s: S) => geom(s.n).w;
  const H = (s: S) => geom(s.n).h;
  // a box whose text wraps is as wide as something else makes it, not as its content
  const wraps = (e: SnapElement): boolean => {
    // its inline content (texts and inline boxes) runs over more than one line
    const tops = new Set<number>();
    const inline = (x: SnapElement, top: boolean): boolean => {
      for (const k of x.children ?? []) {
        if (k.kind === "text") for (const l of (k as SnapText).lines) tops.add(Math.round(l.y / 4));
        else if (/^inline/.test((k as SnapElement).layout?.display ?? "inline")) {
          if (inline(k as SnapElement, false)) return true;
        } else if (top && wraps(k as SnapElement)) return true;
      }
      return false;
    };
    return inline(e, true) || tops.size > 1;
  };
  const contentSized =
    !c.media &&
    !ss.some((s) => wraps(s.n)) &&
    ss.every((s) => {
      const cw = contentWidth(s.n);
      return cw !== null && Math.abs(cw - W(s)) <= 1.5;
    });
  // the containing block: the parent's content box, or for a grid item its grid area
  const cbW = (s: S) => (c.gridParent ? gridArea(s) : null) ?? contentBox(s.p!).w;
  const cbPts = ss.filter((s) => s.p).map((s) => ({ x: cbW(s), y: W(s) }));
  const constW = ss.every((s) => Math.abs(W(s) - W(ss[0]!)) <= tol(W(s)));
  const fills = ss.every((s) => Math.abs(W(s) - avail(s)) <= 1.5);
  const slide = c.ctx.slider(u, "slide");
  // ---- width
  if (slide) {
    // a slide: a share of its track (as many at once as the slider shows)
    const f = fitSamples(cbPts);
    d.set("flex", `0 0 ${f ? fitCss(f, "%") : px(W(ss[0]!))}`);
  } else if (L.maxW !== undefined && L.maxW > 0 && c.blockLevel && !c.flexParent) {
    d.set("max-width", px(L.maxW));
    if (!fills && !ss.every((s) => Math.abs(W(s) - Math.min(L.maxW!, avail(s))) <= 1.5)) {
      const f = fitSamples(cbPts);
      if (f) d.set("width", fitCss(f, "%"));
    }
  } else if (c.media) {
    const f = fitSamples(cbPts);
    if (!fills || !c.blockLevel || c.rowParent) {
      if (f && isShare(f)) d.set("width", fitCss(f, "%"));
      else if (constW) d.set("width", px(W(ss[0]!)));
      else if (f) d.set("width", fitCss(f, "%"));
    } else d.set("width", "100%");
  } else if (c.gridParent) {
    // a grid item fills its area unless it is narrower
    if (!contentSized && ss.some((s) => W(s) < cbW(s) - 1.5)) {
      const f = fitSamples(cbPts);
      if (f) d.set(f.kind === "const" && hasText(n) ? "max-width" : "width", fitCss(f, "%"));
    }
  } else if (c.flexParent && c.rowParent && c.centred && constW) {
    // centred alone in its row: as wide as the row up to its measured width
    d.set("width", "100%");
    d.set("max-width", px(W(ss[0]!)));
    d.set("flex-shrink", "1");
  } else if (c.flexParent && c.rowParent) {
    // a width that follows the row's (a share of it, measured at several widths) is a share, whatever its content
    const fr = fitSamples(cbPts);
    const xs = new Set(cbPts.map((p) => Math.round(p.x)));
    if (!L.grow && fr && fr.kind !== "const" && xs.size > 1) d.set("width", fitCss(fr, "%"));
    // as wide as the row at every width: the whole row (content that only happens to be as wide is rare)
    else if (!L.grow && fills) d.set("width", "100%");
    else if (!contentSized && !L.grow) {
      const f = fitSamples(cbPts);
      if (f && isShare(f)) d.set("width", fitCss(f, "%"));
      else if (constW && !hasText(n)) d.set("width", px(W(ss[0]!)));
      else if (f && f.kind !== "const") d.set("width", fitCss(f, "%"));
      else if (constW) d.set("width", px(W(ss[0]!)));
    }
  } else if (c.blockLevel) {
    const stretch = c.flexParent
      ? /^(normal|stretch)$/.test(ss[0]!.p?.layout?.align ?? "normal") && !L.alignSelf
      : true;
    // a form field or button is as wide as its own default, not as its line: one that fills it says so
    if (fills && stretch && /^(input|select|textarea|button)$/.test(c.tag ?? "")) d.set("width", "100%");
    else if (!(fills && stretch) && !contentSized) {
      const f = fitSamples(cbPts);
      if (constW)
        d.set(
          c.centred || hasText(n) ? "max-width" : "width",
          px(hasText(n) ? textCap(W(ss[0]!)) : W(ss[0]!)),
        );
      else if (
        f &&
        f.kind === "clamp" &&
        Math.abs(f.a - 1) < 0.01 &&
        Math.abs(f.b) < 1.5 &&
        f.hi !== undefined &&
        f.lo === undefined
      )
        d.set("max-width", px(f.hi));
      else if (f) d.set("width", fitCss(f, "%"));
      else d.set("max-width", px(textCap(W(ss[0]!))));
    }
  } else if (constW && ((!contentSized && !hasText(n)) || ss.some((s) => wraps(s.n)))) {
    // an inline-level box narrower than its line (a title wrapping its words): its measured width as its cap
    d.set(hasText(n) ? "max-width" : "width", px(hasText(n) ? textCap(W(ss[0]!)) : W(ss[0]!)));
  }
  // ---- height
  if (c.media) {
    mediaHeight(ss, d);
    return;
  }
  const stretched =
    (c.flexParent &&
      c.rowParent &&
      /^(normal|stretch)$/.test(ss[0]!.p?.layout?.align ?? "normal") &&
      !L.alignSelf) ||
    c.gridParent;
  const grows = c.flexParent && !c.rowParent && (L.grow ?? 0) > 0;
  if (stretched || grows) return;
  const ext = ss.map((s) => contentExtent(s.w, s.n));
  const empty = ext.every((e) => e === null) && !hasText(n);
  const padY = (s: S) =>
    sides(s.n.layout?.padding)[0] +
    sides(s.n.layout?.padding)[2] +
    sides(s.n.layout?.borderWidth)[0] +
    sides(s.n.layout?.borderWidth)[2];
  // taller than its content where the content was measured (a walk that missed a text says nothing)
  const taller = ss.every((s, i) => H(s) > (ext[i] ?? padY(s)) + 1.5);
  // no content in flow (only placed layers): as tall as it is, not at least
  const noFlow = ext.every((e) => e === null);
  const clipped =
    /hidden|clip/.test(n.style?.overflow?.[1] ?? "") &&
    ss.some((s, i) => ext[i] !== null && H(s) < ext[i]! - 1.5);
  if (!taller && !clipped) return;
  const prop = empty || noFlow || clipped ? "height" : "min-height";
  // follows the viewport's height (a 100vh stage, a 50vh band)
  const vhGrow = n.vh;
  if (vhGrow && ss[0]!.w.vh) {
    const probe = 200;
    const a = vhGrow / probe;
    const b = H(ss[0]!) - a * ss[0]!.w.vh;
    const k = Math.round(a * 1000) / 10;
    d.set(
      prop,
      Math.abs(b) < 1
        ? `${k}vh`
        : `calc(${k}vh ${b < 0 ? "-" : "+"} ${Math.abs(Math.round(b * 100) / 100)}px)`,
    );
    return;
  }
  // a box as tall as a share of its width (a spacer in vw, a 16:9 band)
  const ratio = ss.map((s) => H(s) / Math.max(1, W(s)));
  if (
    empty &&
    ss.length > 1 &&
    !ss.every((s) => Math.abs(H(s) - H(ss[0]!)) <= tol(H(s))) &&
    ratio.every((r) => Math.abs(r - ratio[0]!) < 0.01)
  ) {
    d.set("aspect-ratio", aspect(W(ss[0]!), H(ss[0]!)));
    return;
  }
  const v = fluid(ss, (s) => H(s), "vw");
  if (v) d.set(prop, v);
}

/** the grid lines an item spans on one axis, from its position against its parent's computed tracks (1-based) */
function gridLines(s: S, axis: "x" | "y"): [number, number] | null {
  const p = s.p;
  const list = axis === "x" ? p?.layout?.cols : p?.layout?.rows;
  const tracks = (list ?? "")
    .split(/\s+/)
    .map((t) => parseFloat(t))
    .filter((n) => Number.isFinite(n));
  if (!p || !tracks.length) return null;
  const gap = (axis === "x" ? p.layout?.gap?.[1] : p.layout?.gap?.[0]) ?? 0;
  const cb = contentBox(p);
  const g = geom(s.n);
  const lo = axis === "x" ? g.x : g.y,
    hi = lo + (axis === "x" ? g.w : g.h);
  let pos = axis === "x" ? cb.x : cb.y,
    start = -1,
    end = -1;
  tracks.forEach((t, k) => {
    const a = pos,
      b = pos + t;
    if (start < 0 && lo < b - 1) start = k;
    if (hi > a + 1) end = k;
    pos += t + gap;
  });
  return start < 0 || end < start ? null : [start + 1, end + 2];
}

/** width of the grid area a grid item sits in (the tracks it spans, from its parent's computed columns) */
function gridArea(s: S): number | null {
  const p = s.p;
  const cols = (p?.layout?.cols ?? "")
    .split(/\s+/)
    .map((t) => parseFloat(t))
    .filter((n) => Number.isFinite(n));
  if (!p || !cols.length) return null;
  const gap = p.layout?.gap?.[1] ?? 0;
  const cb = contentBox(p);
  const g = geom(s.n);
  let x = cb.x,
    start = -1,
    end = -1;
  const edges: [number, number][] = [];
  for (const t of cols) {
    edges.push([x, x + t]);
    x += t + gap;
  }
  edges.forEach(([a, b], k) => {
    if (start < 0 && g.x < b - 1) start = k;
    if (g.x + g.w > a + 1) end = k;
  });
  if (start < 0 || end < start) return null;
  return edges[end]![1] - edges[start]![0];
}

/**
 * A text box's measured width as its cap, with room for glyphs a fraction wider than the live page's (another font
 * renderer): a line that fit there still fits, a word that wrapped there still wraps
 */
const textCap = (w: number) => Math.ceil(w + Math.max(2, w * 0.012));

function aspect(w: number, h: number): string {
  const r = w / h;
  for (const [a, b] of [
    [16, 9],
    [4, 3],
    [3, 2],
    [1, 1],
    [21, 9],
    [3, 4],
    [2, 3],
    [9, 16],
    [5, 4],
    [4, 5],
  ] as const)
    if (Math.abs(r - a / b) < 0.01) return `${a} / ${b}`;
  return `${Math.round(w * 100) / 100} / ${Math.round(h * 100) / 100}`;
}

/** height of a picture / video / svg: its natural proportions, a fixed proportion of its box, or a fitted height */
function mediaHeight(ss: S[], d: Decls) {
  const n = ss[0]!.n;
  const W = (s: S) => geom(s.n).w,
    H = (s: S) => geom(s.n).h;
  const nat = n.natural && n.natural.w > 0 && n.natural.h > 0 ? n.natural.h / n.natural.w : null;
  const ratios = ss.map((s) => H(s) / Math.max(1, W(s)));
  const sameRatio = ratios.every((r) => Math.abs(r - ratios[0]!) < 0.012);
  const constH = ss.every((s) => Math.abs(H(s) - H(ss[0]!)) <= tol(H(s)));
  const constW = ss.every((s) => Math.abs(W(s) - W(ss[0]!)) <= tol(W(s)));
  if (n.tag === "svg" || (constW && constH)) {
    if (!d.has("width")) d.set("width", px(W(ss[0]!)));
    d.set("height", px(H(ss[0]!)));
    return;
  }
  if (sameRatio && nat && Math.abs(nat - ratios[0]!) < 0.012) return;
  // a box in other proportions than its picture: the picture covers it (never stretched)
  if (
    nat &&
    ratios.some((r) => Math.abs(r - nat) / nat > 0.02) &&
    (!n.objectFit || n.objectFit === "fill") &&
    n.tag !== "svg"
  )
    d.set("object-fit", "cover");
  if (sameRatio) {
    d.set("aspect-ratio", aspect(W(ss[0]!), H(ss[0]!)));
    d.set("height", "auto");
    return;
  }
  if (n.vh && ss[0]!.w.vh) {
    const a = n.vh / 200;
    const b = H(ss[0]!) - a * ss[0]!.w.vh;
    const k = Math.round(a * 1000) / 10;
    d.set(
      "height",
      Math.abs(b) < 1 ? `${k}vh` : `calc(${k}vh ${b < 0 ? "-" : "+"} ${Math.abs(Math.round(b))}px)`,
    );
    return;
  }
  const v = fluid(ss, H, "vw");
  if (v) d.set("height", v);
}

/** An absolutely / fixed positioned box: its insets against its containing block, by the edges it keeps. */
function inferPlaced(ss: S[], d: Decls, media: boolean) {
  const rows = ss.map((s) => {
    const cb = containingBlock(s.w, s.n);
    const g = geom(s.n);
    return {
      s,
      cb,
      l: g.x - cb.x,
      r: cb.x + cb.w - (g.x + g.w),
      t: g.y - cb.y,
      b: cb.y + cb.h - (g.y + g.h),
      w: g.w,
      h: g.h,
    };
  });
  const cst = (f: (r: (typeof rows)[0]) => number) =>
    rows.every((r) => Math.abs(f(r) - f(rows[0]!)) <= tol(f(r)));
  const fitAxis = (val: (r: (typeof rows)[0]) => number, ref: (r: (typeof rows)[0]) => number) => {
    const f = fitSamples(rows.map((r) => ({ x: ref(r), y: val(r) })));
    return f ? fitCss(f, "%") : px(val(rows[0]!));
  };
  const cw = (r: (typeof rows)[0]) => r.cb.w,
    ch = (r: (typeof rows)[0]) => r.cb.h;
  // horizontal
  const lC = cst((r) => r.l),
    rC = cst((r) => r.r),
    wC = cst((r) => r.w);
  const wFit = () => {
    const f = fitSamples(rows.map((r) => ({ x: r.cb.w, y: r.w })));
    return f ? fitCss(f, "%") : px(rows[0]!.w);
  };
  const nearRight = rows[0]!.r < rows[0]!.l;
  const fillsX = rows.every((r) => Math.abs(r.l) <= 1 && Math.abs(r.r) <= 1);
  if (fillsX) {
    d.set("left", "0");
    d.set("right", "0");
    if (media) d.set("width", "100%");
  } else if (lC && rC && wC && rows.length > 1 && !(Math.abs(rows[0]!.l - rows[0]!.r) <= 1.5)) {
    // both edges kept only because the box and its container keep their widths: the nearer edge places it
    d.set(nearRight ? "right" : "left", px(nearRight ? rows[0]!.r : rows[0]!.l));
    if (!hasText(rows[0]!.s.n) || media) d.set("width", px(rows[0]!.w));
  } else if (
    lC &&
    rC &&
    (!wC || rows.length === 1) &&
    rows[0]!.l >= -1 &&
    rows[0]!.r >= -1 &&
    !media &&
    !(wC && rows.length === 1 && rows[0]!.w < rows[0]!.cb.w * 0.5)
  ) {
    d.set("left", px(rows[0]!.l));
    d.set("right", px(rows[0]!.r));
  } else if (rows.every((r) => Math.abs(r.l - r.r) <= 1.5) && rows[0]!.l > 1) {
    d.set("left", "0");
    d.set("right", "0");
    d.set("margin-inline", "auto");
    d.set("width", wFit());
  } else if (rC && !lC) {
    d.set("right", px(rows[0]!.r));
    if (!(wC && hasText(rows[0]!.s.n) && !media)) d.set("width", wFit());
  } else {
    d.set("left", lC ? px(rows[0]!.l) : fitAxis((r) => r.l, cw));
    if (!(lC && rC)) {
      if (!hasText(rows[0]!.s.n) || media || !wC) d.set("width", wFit());
    } else d.set("right", px(rows[0]!.r));
  }
  // vertical
  const tC = cst((r) => r.t),
    bC = cst((r) => r.b),
    hC = cst((r) => r.h);
  const text = hasText(rows[0]!.s.n) && !media;
  const hFit = () => {
    const f = fitSamples(rows.map((r) => ({ x: r.s.w.vw, y: r.h })));
    return f ? fitCss(f, "vw") : px(rows[0]!.h);
  };
  const nearBottom = rows[0]!.b < rows[0]!.t;
  // a layer as tall as its container (a background video, an overlay): both edges, whatever the container's height
  const fillsY = rows.every((r) => Math.abs(r.t) <= 1 && Math.abs(r.b) <= 1);
  // hanging under its container (a dropdown, a flyout panel): it grows downwards from the container's bottom edge
  const hangs = rows.every((r) => r.b <= 0.5 && Math.abs(r.t - r.cb.h) <= 1.5);
  if (fillsY) {
    d.set("top", "0");
    d.set("bottom", "0");
    if (media) d.set("height", "100%");
  } else if (hangs) {
    d.set("top", "100%");
    if (!text) d.set("height", hFit());
  } else if (tC && bC && hC && (rows.length > 1 || rows[0]!.h < rows[0]!.cb.h * 0.5)) {
    d.set(nearBottom ? "bottom" : "top", px(nearBottom ? rows[0]!.b : rows[0]!.t));
    if (!text) d.set("height", hFit());
  } else if (tC && bC && !text) {
    d.set("top", px(rows[0]!.t));
    d.set("bottom", px(rows[0]!.b));
  } else if (bC && !tC) {
    d.set("bottom", px(rows[0]!.b));
    if (!text) d.set("height", hFit());
  } else {
    d.set("top", tC ? px(rows[0]!.t) : fitAxis((r) => r.t, ch));
    if (!text || !hC) {
      if (tC && bC) d.set("bottom", px(rows[0]!.b));
      else if (!text) d.set("height", hFit());
    }
  }
  // inset: 0 for a box covering its container
  if (
    d.get("left") === "0" &&
    d.get("right") === "0" &&
    d.get("top") === "0" &&
    d.get("bottom") === "0" &&
    !d.has("margin-inline")
  ) {
    for (const k of ["left", "right", "top", "bottom"]) d.delete(k);
    d.set("inset", "0");
    if (media) {
      d.set("width", "100%");
      d.set("height", "100%");
    }
  }
}

/** grid-template-columns as tracks that hold at every width: equal shares, fixed tracks, the rest shared */
function gridTracks(ss: S[], get: (s: S) => string | undefined): string | null {
  const parsed = ss.map((s) =>
    (get(s) ?? "")
      .split(/\s+/)
      .map((t) => parseFloat(t))
      .filter((n) => Number.isFinite(n)),
  );
  if (!parsed[0]?.length) return null;
  const n = parsed[0]!.length;
  const same = parsed.filter((p) => p.length === n);
  const eq = same.every((p) => p.every((t) => Math.abs(t - p[0]!) <= 1));
  if (eq) return n === 1 ? "minmax(0, 1fr)" : `repeat(${n}, minmax(0, 1fr))`;
  const constant = Array.from({ length: n }, (_, k) =>
    same.every((p) => Math.abs(p[k]! - same[0]![k]!) <= 1),
  );
  if (constant.every(Boolean) && same.length > 1)
    // nothing varies with the width: fixed tracks, the widest flexible
    return parsed[0]!.map((t) => px(t)).join(" ");
  const flexSum = parsed[0]!.reduce((a, t, k) => a + (constant[k] ? 0 : t), 0) || 1;
  return parsed[0]!
    .map((t, k) =>
      constant[k]
        ? px(t)
        : `minmax(0, ${((Math.round((t / flexSum) * 1000) / 1000) * parsed[0]!.length) / parsed[0]!.length}fr)`,
    )
    .join(" ");
}

/** colours, borders, corners, shadows, backgrounds, effects */
function paint(
  n: SnapElement,
  St: NonNullable<SnapElement["style"]>,
  d: Decls,
  ctx: InferContext,
  u: UNode,
  parent?: SnapElement,
) {
  if (St.bg) d.set("background-color", ctx.color(St.bg));
  if (St.bgLayers?.length) {
    const imgs = St.bgLayers.map((l) => (l.url ? `url("${ctx.asset(l.image, n)}")` : l.image));
    d.set("background-image", imgs.join(", "));
    const join = (k: "size" | "position" | "repeat") => St.bgLayers!.map((l) => l[k]).join(", ");
    if (St.bgLayers.some((l) => l.size !== "auto" && l.size !== "auto auto"))
      d.set("background-size", join("size"));
    if (St.bgLayers.some((l) => l.position !== "0% 0%")) d.set("background-position", join("position"));
    if (St.bgLayers.some((l) => l.repeat !== "repeat")) d.set("background-repeat", join("repeat"));
    if (St.bgLayers.some((l) => l.attachment))
      d.set("background-attachment", St.bgLayers.map((l) => l.attachment ?? "scroll").join(", "));
    if (St.bgLayers.some((l) => l.blend))
      d.set("background-blend-mode", St.bgLayers.map((l) => l.blend ?? "normal").join(", "));
    if (St.bgLayers.some((l) => l.clip))
      d.set("background-clip", St.bgLayers.map((l) => l.clip ?? "border-box").join(", "));
    if (St.bgLayers.some((l) => l.origin))
      d.set("background-origin", St.bgLayers.map((l) => l.origin ?? "padding-box").join(", "));
  }
  if (St.bgClipText) {
    d.set("background-clip", "text");
    d.set("-webkit-background-clip", "text");
    d.set("color", "transparent");
  }
  if (St.border) {
    const css = St.border.map((b) => (b && b.w > 0 ? `${px(b.w)} ${b.style} ${ctx.color(b.color)}` : "0"));
    if (css.every((c) => c === css[0])) {
      if (css[0] !== "0") d.set("border", css[0]!);
    } else {
      const names = ["top", "right", "bottom", "left"];
      css.forEach((c, k) => {
        if (c !== "0") d.set(`border-${names[k]}`, c);
      });
    }
  }
  if (St.radius?.some((r) => r > 0)) {
    const g = geom(n);
    const half = Math.min(g.w, g.h) / 2;
    const rs = St.radius.map((r) => (r >= half - 0.5 && half > 0 ? "50%" : px(r)));
    const [a, b, c, e] = rs as [string, string, string, string];
    d.set("border-radius", a === b && b === c && c === e ? a : `${a} ${b} ${c} ${e}`);
  }
  if (St.shadow) d.set("box-shadow", St.shadow);
  if (St.outline && St.outline.w > 0)
    d.set("outline", `${px(St.outline.w)} ${St.outline.style} ${ctx.color(St.outline.color)}`);
  if (St.opacity !== undefined && St.opacity < 1)
    d.set("opacity", String(Math.round(St.opacity * 1000) / 1000));
  if (St.blend) d.set("mix-blend-mode", St.blend);
  if (St.filter) d.set("filter", St.filter);
  if (St.backdrop) {
    d.set("backdrop-filter", St.backdrop);
    d.set("-webkit-backdrop-filter", St.backdrop);
  }
  if (St.overflow && !isMedia(n)) {
    const [x, y] = St.overflow;
    if (!ctx.slider(u, "scroller")) d.set("overflow", x === y ? x : `${x} ${y}`);
  }
  if (St.clipPath) d.set("clip-path", St.clipPath);
  if (St.mask) {
    const img = St.mask.url ? `url("${ctx.asset(St.mask.image, n)}")` : St.mask.image;
    for (const pre of ["", "-webkit-"]) {
      d.set(`${pre}mask-image`, img);
      d.set(`${pre}mask-size`, St.mask.size);
      d.set(`${pre}mask-position`, St.mask.position);
      d.set(`${pre}mask-repeat`, St.mask.repeat);
    }
  }
  if (St.transform) {
    const t = transformCss(St.transform, n);
    if (t) d.set(t[0], t[1]);
  }
  if (St.color && !(n.children ?? []).some((c) => c.kind === "text")) d.set("color", ctx.color(St.color));
  if (n.kind === "img" || n.tag === "video") {
    if (n.objectFit && n.objectFit !== "fill") d.set("object-fit", n.objectFit);
    if (n.objectPosition && n.objectPosition !== "50% 50%") d.set("object-position", n.objectPosition);
  }
  if (n.pointer && !/^(a|button|summary|label|select)$/.test(n.tag)) d.set("cursor", "pointer");
  // the page's own cursor (an icon over a slider's pictures): its image a file of the recreation
  if (n.cursor)
    d.set(
      "cursor",
      cursorCss(n.cursor, (u) => ctx.asset(u, n)),
    );
  // a control smaller than a fingertip target (WCAG 2.5.8): at least 24 × 24 px
  // (the hit area grows by padding the margin takes back; a background stays on the original box: the look is unchanged)
  if (ctx.tagOf(u) === "button" && (n.rect.w < 24 || n.rect.h < 24) && n.rect.w > 0 && !n.style?.border) {
    const p0 = sides(n.layout?.padding),
      m0 = sides(n.layout?.margin);
    // grown into free space only (never over a neighbour): room on each side up to the nearest sibling or the parent's edge
    const r = n.rect;
    const sibs = (parent?.children ?? []).filter(
      (c): c is SnapElement => c !== n && c.kind !== "text" && !!(c as SnapElement).rect,
    );
    const pc = parent ? contentBox(parent) : { x: -1e6, y: -1e6, w: 2e6, h: 2e6 };
    const overlapY = (b: { y: number; h: number }) => b.y < r.y + r.h && b.y + b.h > r.y;
    const overlapX = (b: { x: number; w: number }) => b.x < r.x + r.w && b.x + b.w > r.x;
    const room = {
      l: Math.min(
        r.x - pc.x + sides(parent?.layout?.padding)[3],
        ...sibs
          .filter((b) => overlapY(b.rect) && b.rect.x + b.rect.w <= r.x + 1)
          .map((b) => r.x - (b.rect.x + b.rect.w)),
      ),
      r: Math.min(
        pc.x + pc.w - (r.x + r.w) + sides(parent?.layout?.padding)[1],
        ...sibs
          .filter((b) => overlapY(b.rect) && b.rect.x >= r.x + r.w - 1)
          .map((b) => b.rect.x - (r.x + r.w)),
      ),
      t: Math.min(
        r.y - pc.y + sides(parent?.layout?.padding)[0],
        ...sibs
          .filter((b) => overlapX(b.rect) && b.rect.y + b.rect.h <= r.y + 1)
          .map((b) => r.y - (b.rect.y + b.rect.h)),
      ),
      b: Math.min(
        pc.y + pc.h - (r.y + r.h) + sides(parent?.layout?.padding)[2],
        ...sibs
          .filter((b) => overlapX(b.rect) && b.rect.y >= r.y + r.h - 1)
          .map((b) => b.rect.y - (r.y + r.h)),
      ),
    };
    const split = (need: number, a: number, b: number): [number, number] => {
      a = Math.max(0, Math.floor(a));
      b = Math.max(0, Math.floor(b));
      let x = Math.min(a, Math.ceil(need / 2));
      let y = Math.min(b, need - x);
      x = Math.min(a, need - y);
      return [x, y];
    };
    const [gl, gr] = split(Math.max(0, Math.ceil(24 - r.w)), room.l, room.r);
    const [gt, gb] = split(Math.max(0, Math.ceil(24 - r.h)), room.t, room.b);
    const hasBg = !!(n.style?.bg || n.style?.bgLayers?.length);
    // a background on a padded box would grow with the padding: only boxes without either
    if ((gl || gr || gt || gb) && !(hasBg && (p0[0] || p0[1] || p0[2] || p0[3]))) {
      d.set("padding", four(px(p0[0] + gt), px(p0[1] + gr), px(p0[2] + gb), px(p0[3] + gl)));
      d.set("margin", four(px(m0[0] - gt), px(m0[1] - gr), px(m0[2] - gb), px(m0[3] - gl)));
      if (hasBg) d.set("background-clip", "content-box");
      if (d.has("width")) d.set("width", px(r.w + gl + gr));
      if (d.has("height")) d.set("height", px(r.h + gt + gb));
    }
  }
  // a checkbox / radio drawn by the page: its own box, no platform look
  if (n.kind === "raster" && n.tag === "input") {
    d.set("appearance", "none");
    d.set("margin", "0");
  }
  // a field's placeholder in the page's colour
  if (n.kind === "input" && n.input?.placeholderColor)
    d.set("--placeholder", ctx.color(n.input.placeholderColor));
  if (n.kind === "input" && n.input?.font) {
    const f = n.input.font;
    d.set("font-size", px(f.size));
    d.set("font-weight", String(f.weight));
    d.set("color", ctx.color(f.color));
  }
  if (n.transition && ctx.hovered(u)) d.set("transition", transitionCss(n.transition));
}

/** a computed cursor with its url images as the recreation's files */
export function cursorCss(c: string, file: (url: string) => string): string {
  return c.replace(/url\("?([^")]+)"?\)/g, (_m, u: string) => `url("${file(u)}")`);
}

/** A computed transform as the simplest CSS: a translation by a share of the box (`-50%`), a scale, or the matrix. */
export function transformCss(t: string, n?: SnapElement): [string, string] | null {
  const m = /^matrix\(([^)]+)\)$/.exec(t.trim());
  if (!m) return t === "none" ? null : ["transform", t];
  const [a, b, c, dd, e, f] = m[1]!.split(",").map((x) => parseFloat(x)) as number[];
  const w = n?.size?.w ?? n?.rect.w ?? 0,
    h = n?.size?.h ?? n?.rect.h ?? 0;
  const share = (v: number, len: number) => {
    if (len > 0)
      for (const k of [-100, -50, 50, 100]) if (Math.abs(v - (len * k) / 100) <= 0.75) return `${k}%`;
    return px(v);
  };
  if (b === 0 && c === 0) {
    if (a === 1 && dd === 1) return e || f ? ["translate", `${share(e!, w)} ${share(f!, h)}`] : null;
    if (!e && !f)
      return [
        "scale",
        a === dd
          ? String(Math.round(a! * 1000) / 1000)
          : `${Math.round(a! * 1000) / 1000} ${Math.round(dd! * 1000) / 1000}`,
      ];
  }
  return ["transform", t];
}

export function transitionCss(t: {
  property: string;
  duration: string;
  timing: string;
  delay: string;
}): string {
  const props = t.property.split(/,\s*/);
  const durs = t.duration.split(/,\s*/),
    tims = splitTiming(t.timing),
    dels = t.delay.split(/,\s*/);
  return props
    .map((p, i) => {
      const dur = durs[i % durs.length]!,
        tim = tims[i % tims.length]!,
        del = dels[i % dels.length]!;
      return `${p} ${dur}${tim !== "ease" ? ` ${tim}` : ""}${del !== "0s" ? ` ${del}` : ""}`;
    })
    .join(", ");
}

function splitTiming(v: string): string[] {
  const out: string[] = [];
  let depth = 0,
    cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && !depth) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** What the inference needs from the emitter: tags, assets, colours, the slider and hover roles of nodes. */
export interface InferContext {
  tagOf(u: UNode): string;
  asset(url: string, n: SnapElement): string;
  color(c: string): string;
  slider(u: UNode, role: "scroller" | "track" | "slide"): boolean;
  hovered(u: UNode): boolean;
}

// ------------------------------------------------------------------------------------------------- text

export type TextProps = Map<string, string>;

/** The text properties of an element whose own texts are drawn in `font` (over the variant's walks). */
export function textDecls(u: UNode, vi: number, model: Unified, ctx: InferContext): TextProps | null {
  const walks = model.walks[vi]!;
  const fonts: { vw: number; f: SnapFont; cb?: number }[] = [];
  for (const w of walks) {
    const hit = inWalk(w, u.key);
    if (!hit || !isEl(hit.n)) continue;
    const t = (hit.n.children ?? []).find((c) => isTextNode(c)) as SnapText | undefined;
    if (t) fonts.push({ vw: w.vw, f: t.font });
  }
  if (!fonts.length) return null;
  const f = fonts[0]!.f;
  const d: TextProps = new Map();
  d.set("font-family", ctx.color === undefined ? f.stack : f.stack);
  const size = fitSamples(fonts.map((x) => ({ x: x.vw, y: x.f.size })));
  d.set("font-size", size ? fitCss(size, "vw") : px(f.size));
  d.set("font-weight", String(f.weight));
  d.set("font-style", f.italic ? "italic" : "normal");
  if (f.lineHeight === null) d.set("line-height", "normal");
  else {
    const ratios = fonts.map((x) => (x.f.lineHeight ?? 0) / x.f.size);
    if (ratios.every((r) => Math.abs(r - ratios[0]!) < 0.01))
      d.set("line-height", String(Math.round(ratios[0]! * 1000) / 1000));
    else {
      const lh = fitSamples(fonts.map((x) => ({ x: x.vw, y: x.f.lineHeight ?? x.f.size * 1.2 })));
      d.set("line-height", lh ? fitCss(lh, "vw") : px(f.lineHeight));
    }
  }
  const ls = fonts.map((x) => x.f.letterSpacing / x.f.size);
  d.set(
    "letter-spacing",
    Math.abs(f.letterSpacing) < 0.01
      ? "normal"
      : ls.every((r) => Math.abs(r - ls[0]!) < 0.002)
        ? `${Math.round(ls[0]! * 1000) / 1000}em`
        : px(f.letterSpacing),
  );
  d.set("color", ctx.color(f.color));
  d.set("text-transform", f.transform && f.transform !== "none" ? f.transform : "none");
  const dec = f.decoration;
  d.set(
    "text-decoration",
    dec && dec.line && dec.line !== "none"
      ? `${dec.line} ${dec.style !== "solid" ? `${dec.style} ` : ""}${ctx.color(dec.color)}${dec.thickness && dec.thickness !== "auto" ? ` ${dec.thickness}` : ""}`
      : "none",
  );
  if (dec?.offset && dec.offset !== "auto") d.set("text-underline-offset", dec.offset);
  d.set(
    "text-align",
    /^(start|left)$/.test(f.align) ? "start" : f.align === "-webkit-center" ? "center" : f.align,
  );
  d.set("white-space", f.whiteSpace === "normal" ? "normal" : f.whiteSpace);
  d.set("text-shadow", f.shadow ?? "none");
  if (f.features) d.set("font-feature-settings", f.features);
  if (f.textWrap) d.set("text-wrap", f.textWrap);
  if (f.hyphens) d.set("hyphens", f.hyphens);
  if (f.wordSpacing) d.set("word-spacing", px(f.wordSpacing));
  if (f.variation) d.set("font-variation-settings", f.variation);
  if (f.stretch) d.set("font-stretch", f.stretch);
  if (f.stroke) d.set("-webkit-text-stroke", `${px(f.stroke.w)} ${ctx.color(f.stroke.color)}`);
  if (f.lineClamp) {
    d.set("display", "-webkit-box");
    d.set("-webkit-box-orient", "vertical");
    d.set("-webkit-line-clamp", String(f.lineClamp));
    d.set("overflow", "hidden");
  }
  return d;
}

/** text properties every element inherits (the ones compared with the parent's before they are written) */
export const INHERITED = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "color",
  "text-transform",
  "text-align",
  "white-space",
  "text-shadow",
  "font-feature-settings",
  "text-wrap",
  "hyphens",
  "word-spacing",
  "font-variation-settings",
  "font-stretch",
  "-webkit-text-stroke",
  "text-underline-offset",
]);
