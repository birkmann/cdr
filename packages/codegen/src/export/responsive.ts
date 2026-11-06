// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Responsive pages (docs/responsive.md): screens sharing `responsive.group` are one page captured / designed at several
// widths. Exporters emit every variant once and let @media rules show exactly one per viewport range.
import { createNamer, slugify } from "@harness/scene";
import { el, type IrElement } from "./ir.js";

export interface ResponsiveInfo {
  group: string;
  minWidth: number;
  /** reflows below its design width (fluidVariants) down to this width; scaled to fit only below it */
  fluid?: number;
}
interface PageScreen {
  nodeId: string;
  name: string;
  width: number;
  responsive?: ResponsiveInfo;
}

export interface ExportPage<T extends PageScreen = PageScreen> {
  /** unique file / component slug */
  slug: string;
  /** page name without the breakpoint suffix (`Startseite · 390` → `Startseite`) */
  name: string;
  /** variants by ascending minWidth (one screen for a non-responsive page) */
  screens: T[];
  responsive: boolean;
}

/** `Startseite · 390` → `Startseite` */
export const pageNameOf = (name: string) => name.replace(/\s*[·|–-]\s*\d+\s*(px)?\s*$/, "").trim() || name;

/** Screens → pages, in order of first appearance; a group's variants sorted by minWidth (duplicates keep the first). */
export function exportPages<T extends PageScreen>(screens: T[]): Array<ExportPage<T>> {
  const namer = createNamer();
  const pages: Array<ExportPage<T>> = [];
  const groups = new Map<string, ExportPage<T>>();
  for (const s of screens) {
    const g =
      s.responsive && typeof s.responsive.group === "string" && s.responsive.group
        ? s.responsive.group
        : null;
    if (!g) {
      pages.push({ slug: namer(slugify(s.name, "screen")), name: s.name, screens: [s], responsive: false });
      continue;
    }
    const hit = groups.get(g);
    if (hit) {
      if (!hit.screens.some((x) => x.responsive!.minWidth === s.responsive!.minWidth)) hit.screens.push(s);
      continue;
    }
    const page: ExportPage<T> = {
      slug: namer(slugify(g, "page")),
      name: pageNameOf(s.name),
      screens: [s],
      responsive: true,
    };
    groups.set(g, page);
    pages.push(page);
  }
  for (const p of groups.values()) {
    p.screens.sort((a, b) => a.responsive!.minWidth - b.responsive!.minWidth);
    // the narrowest variant covers everything below the next breakpoint
    if (p.screens[0])
      p.screens[0] = { ...p.screens[0], responsive: { ...p.screens[0].responsive!, minWidth: 0 } };
  }
  return pages;
}

/** Viewport range [min, max) per variant (max null = open). */
export function variantRanges<T extends PageScreen>(
  page: ExportPage<T>,
): Array<{ screen: T; min: number; max: number | null }> {
  return page.screens.map((s, i) => ({
    screen: s,
    min: page.responsive ? s.responsive!.minWidth : 0,
    max: page.responsive ? (page.screens[i + 1]?.responsive?.minWidth ?? null) : null,
  }));
}

/** `@media` query for a [min, max) range ('' = always). */
export function mediaQuery(min: number, max: number | null): string {
  const parts: string[] = [];
  if (min > 0) parts.push(`(min-width: ${min}px)`);
  if (max !== null) parts.push(`(max-width: ${max - 0.02}px)`);
  return parts.join(" and ");
}

/**
 * Viewports narrower than a variant's design width (below the narrowest breakpoint, or a single desktop screen on a
 * phone) scale the variant down (CSS zoom = viewport / design width) instead of clipping or scrolling sideways.
 * `select(minWidth)` is the variant root's selector.
 */
export function fitZoomCss<T extends PageScreen>(
  page: ExportPage<T>,
  select: (min: number) => string,
): string {
  const out: string[] = [];
  for (const r of variantRanges(page)) {
    const w = Math.round(r.screen.width);
    const fit = r.screen.responsive?.fluid;
    if (fit !== undefined) {
      // a fluid variant reflows down to `fit`; narrower, its layout at `fit` is scaled
      if (r.min >= fit) continue;
      out.push(
        `@media ${mediaQuery(r.min, r.max === null ? fit : Math.min(r.max, fit))} { ${select(r.min)} { zoom: ${Math.floor((Math.min(320, fit) / fit) * 1000) / 1000}; zoom: min(1, calc(100vw / ${fit}px)); } }`,
      );
      continue;
    }
    if (!(w > 0) || r.min >= w) continue;
    const q = mediaQuery(r.min, r.max === null ? w : Math.min(r.max, w));
    // the first declaration is the fallback where `length / length` is unsupported (fits a 320 px phone)
    out.push(
      `@media ${q || "all"} { ${select(r.min)} { zoom: ${Math.floor((Math.min(320, w) / w) * 1000) / 1000}; zoom: min(1, calc(100vw / ${w}px)); } }`,
    );
  }
  return out.join("\n");
}

/** The widest width a screen was measured at (its design width or one of its alt walks). */
export const widestMeasured = (s: PageScreen & { measured?: Array<{ width: number }> }) =>
  Math.max(Math.round(s.width), ...(s.measured ?? []).map((m) => Math.round(m.width)));

/**
 * Viewports wider than the widest variant was ever measured at keep that measured layout, centred, instead of a
 * stretched guess (boxes that fill would widen while measured positions stay: text off-screen, overlaps). The page
 * background still spans the window.
 */
export function capWideCss<T extends PageScreen>(
  page: ExportPage<T>,
  select: (min: number) => string,
): string {
  const ranges = variantRanges(page);
  const last = ranges[ranges.length - 1];
  if (!last || last.max !== null) return "";
  const M = widestMeasured(last.screen as T & { measured?: Array<{ width: number }> });
  if (!(M > 0)) return "";
  return `@media (min-width: ${M + 1}px) { ${select(last.min)} { max-width: ${M}px; margin-left: auto; margin-right: auto; } }`;
}

/** CSS showing exactly one variant per viewport range: `scope` selects the page, variants carry `data-bp="<minWidth>"`. */
export function variantMediaCss<T extends PageScreen>(page: ExportPage<T>, scope: string): string {
  const lines = [`${scope} > [data-bp] { display: none; }`];
  for (const r of variantRanges(page)) {
    const rule = `${scope} > [data-bp="${r.min}"] { display: block; }`;
    const q = mediaQuery(r.min, r.max);
    lines.push(q ? `@media ${q} { ${rule} }` : rule);
  }
  return lines.join("\n");
}

/** One adapted variant a responsive-by-default export asks for (see withAdaptedVariants). */
export interface AdaptRequest<T> {
  source: T;
  width: number;
  minWidth: number;
  group: string;
}

/** Phone / tablet widths adapted variants are laid out at (docs/responsive.md breakpoints). */
export const ADAPT_PHONE = 390;
export const ADAPT_TABLET = 768;

/**
 * Responsive by default: a web page with no phone variant (a single desktop screen, or a group whose narrowest
 * variant is ≥ 600 px wide) gets an adapted phone variant (minWidth 0) and, when that narrowest design is ≥ 1200 px
 * wide, a tablet one (minWidth 768); the narrowest design then applies from 1024 (768 without the tablet). `adapt`
 * builds a variant from the page's narrowest screen, or returns null when the reflow changes nothing or still
 * overflows (the page keeps the zoom fallback). Returns `screens` with each page's narrowest screen joined to its
 * group (`responsive` set) and the variants right after it; pages it cannot extend come back as they were.
 */
export function withAdaptedVariants<T extends PageScreen & { platform?: "app" | "web" }>(
  screens: T[],
  adapt: (r: AdaptRequest<T>) => T | null,
): T[] {
  const groups = new Set(screens.map((s) => s.responsive?.group).filter((g): g is string => !!g));
  const replaced = new Map<T, T[]>();
  for (const p of exportPages(screens)) {
    // exportPages hands out copies for groups (minWidth 0): find the screen itself
    const first = p.screens[0];
    const narrow = first && screens.find((s) => s.nodeId === first.nodeId);
    if (!narrow || !p.screens.every((s) => s.platform === "web") || narrow.width < 600) continue;
    const next = p.screens[1]?.responsive?.minWidth ?? Infinity;
    let group = narrow.responsive?.group;
    if (!group) {
      group = p.name;
      for (let n = 2; groups.has(group); n++) group = `${p.name} ${n}`;
    }
    const phone = adapt({ source: narrow, width: ADAPT_PHONE, minWidth: 0, group });
    if (!phone) continue;
    const tablet =
      narrow.width >= 1200 && next > 1024
        ? adapt({ source: narrow, width: ADAPT_TABLET, minWidth: ADAPT_TABLET, group })
        : null;
    const from = Math.max(
      narrow.responsive?.minWidth ?? 0,
      tablet ? 1024 : Math.min(ADAPT_TABLET, Math.round(narrow.width)),
    );
    if (from >= next) continue;
    groups.add(group);
    replaced.set(narrow, [
      { ...narrow, responsive: { group, minWidth: from } },
      phone,
      ...(tablet ? [tablet] : []),
    ]);
  }
  return replaced.size ? screens.flatMap((s) => replaced.get(s) ?? [s]) : screens;
}

/* ------------------------------------------------------------------ fluid variants */

/** A variant as the fluid pass reads it (ExportScreen): its IR and how it is used. */
export interface FluidScreen extends PageScreen {
  ir: IrElement;
  dslId?: string;
  platform?: "app" | "web";
  adapted?: boolean;
  overlayOf?: string;
  /** the same variant measured at other widths of its layout range (URL capture): same tree, the site's geometry there */
  measured?: ReadonlyArray<{ width: number; ir: IrElement }>;
}

/** Geometry the fluid pass carries from one variant's design width towards its neighbours'. */
const FLUID_PROPS = [
  "width",
  "height",
  "left",
  "top",
  "right",
  "bottom",
  "min-height",
  "gap",
  "row-gap",
  "column-gap",
  "padding",
] as const;
const PX_RE = /^(-?\d+(?:\.\d+)?)px$/;
const pxOf = (v: string | undefined): number | null => {
  const m = v === undefined ? null : PX_RE.exec(v.trim());
  return m ? Number(m[1]) : null;
};
const num = (n: number, d = 4) => String(Math.round(n * 10 ** d) / 10 ** d);

/** Path key of every element of a variant tree (layer name + tag, nth among same-named siblings), with its parent. */
export function irPaths(root: IrElement): Map<string, { el: IrElement; parent: IrElement | null }> {
  const out = new Map<string, { el: IrElement; parent: IrElement | null }>();
  const walk = (n: IrElement, key: string, parent: IrElement | null) => {
    out.set(key, { el: n, parent });
    const seen = new Map<string, number>();
    for (const c of n.children) {
      if (c.kind !== "el") continue;
      const label = `${c.tag}:${c.name ?? ""}`;
      const i = seen.get(label) ?? 0;
      seen.set(label, i + 1);
      walk(c, `${key}/${label}#${i}`, n);
    }
  };
  walk(root, "main", null);
  return out;
}

const flowCount = (p: IrElement | null) =>
  p
    ? p.children.filter(
        (c) => c.kind === "el" && c.style.position !== "absolute" && c.style.position !== "fixed",
      ).length
    : 0;

/** Same element in the same layout context (so its geometry between the two variants is one continuous layout). */
function sameContext(
  a: { el: IrElement; parent: IrElement | null },
  b: { el: IrElement; parent: IrElement | null },
): boolean {
  if (a.el.tag !== b.el.tag || (a.el.style.position === "absolute") !== (b.el.style.position === "absolute"))
    return false;
  if (!a.parent || !b.parent) return !a.parent && !b.parent;
  const ps = a.parent.style,
    qs = b.parent.style;
  if (
    (ps.display ?? "") !== (qs.display ?? "") ||
    (ps["flex-direction"] ?? "row") !== (qs["flex-direction"] ?? "row") ||
    (ps["flex-wrap"] ?? "") !== (qs["flex-wrap"] ?? "")
  )
    return false;
  if ((ps["grid-template-columns"] ?? "") !== (qs["grid-template-columns"] ?? "")) return false;
  return a.el.style.position === "absolute" || flowCount(a.parent) === flowCount(b.parent);
}

/** `v` px at the design width `W`, changing by `up` px per px of viewport above it and by `down` below it. */
export function lerpCss(v: number, W: number, up: number, down: number, vw = "100vw", digits = 4): string {
  const u = Math.abs(up) < 1e-4 ? 0 : up,
    d = Math.abs(down) < 1e-4 ? 0 : down;
  if (!u && !d) return `${num(v, 3)}px`;
  const terms = [`${num(v, 3)}px`];
  if (u === d) terms.push(`${num(u, digits)} * (${vw} - ${num(W, 3)}px)`);
  else {
    if (u) terms.push(`${num(u, digits)} * max(0px, ${vw} - ${num(W, 3)}px)`);
    if (d) terms.push(`${num(d, digits)} * min(0px, ${vw} - ${num(W, 3)}px)`);
  }
  return `calc(${terms.join(" + ")})`;
}

/**
 * Where a variant starts (docs/responsive.md "Between the breakpoints"). A variant captured at a width with
 * `minWidth` = that width (as `--breakpoints` captures store it) is one layout of the site, and sites switch layouts
 * at common breakpoints below the widths they are captured at (1024 for a 1280 capture, 1366–1440 for 1728): their
 * page at 1024 is the 1280 layout narrowed, not the 768 one widened. So when the variant below is another layout
 * (fewer than FLUID_SAME of either tree's layers match), the variant applies from FLUID_FIT of its width and reflows
 * down to it; when both are the same layout (the narrower one only stretched), the narrower one morphs into it up to
 * its captured width. An explicit `minWidth` below the design width is kept.
 */
export const FLUID_FIT = 0.8;
export const FLUID_SAME = 0.95;
/** share of a box's layers its partner must have in the same context for its height to follow the partner's */
export const FLUID_DEEP = 0.9;

/** `minWidth` of variant `i` (ascending); `same`: variant i − 1 is the same layout (see FLUID_SAME). */
export function fitMinWidth(
  vs: ReadonlyArray<{ width: number; responsive?: ResponsiveInfo }>,
  i: number,
  same = false,
): number {
  const v = vs[i]!;
  const min = v.responsive?.minWidth ?? 0;
  if (i === 0) return 0;
  if (min < Math.round(v.width) || same) return min;
  return Math.max(Math.round(vs[i - 1]!.width) + 1, Math.round(v.width * FLUID_FIT));
}

/** Share of the layers of two variant trees (path keys) that the other one has too, the smaller of both. */
export function layerOverlap(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const k of a.keys()) if (b.has(k)) n++;
  return Math.min(n / a.size, n / b.size);
}

/** `share` of the parent's width plus `px` (exact to 1e-3 px at the design width). */
export function shareCss(share: number, px: number): string {
  const p = `${num(share * 100, 4)}%`;
  const k = Math.round(px * 1000) / 1000;
  return k === 0 ? p : `calc(${p} ${k < 0 ? "-" : "+"} ${num(Math.abs(k), 3)}px)`;
}

/** Values that never grow as the viewport narrows below the design width. */
const WIDTHISH = new Set<string>(["width", "left", "right", "gap", "column-gap", "padding"]);

type Partner = { o: { el: IrElement; parent: IrElement | null }; W: number; j: number } | null;

/**
 * Fluid variants (docs/responsive.md "Between the breakpoints"): every element of a responsive web page that its
 * neighbouring variant also has, in the same layout context, follows the line through its two captured boxes as the
 * viewport changes, so at a width between two breakpoints the page has the geometry the site has there (full-bleed
 * bands stretch, max-width columns keep their width, fluid rows and media grow, the page's height follows) instead of
 * one variant frozen at its design width. At each captured width every value is exactly the captured px. Below its
 * design width (down to its breakpoint, fitMinWidth) a variant continues the same trend, a width never growing as
 * the viewport narrows; past the widest variant the page keeps its geometry. reflowIr then makes the rest
 * reflow; below FLUID_FIT of the design width the layout there is scaled (fitZoomCss). The variants' menus reflow
 * with them. Returns the screens with the changed variants and menus replaced (IR copied).
 */
export function fluidVariants<T extends FluidScreen>(screens: T[]): T[] {
  const changed = new Map<string, T>();
  const vwOf = new Map<string, string>();
  for (const p of exportPages(screens.filter((s) => !s.overlayOf))) {
    if (!p.responsive || p.screens.length < 2 || !p.screens.every((s) => s.platform === "web" && !s.adapted))
      continue;
    const vs = p.screens.map((s) => screens.find((x) => x.nodeId === s.nodeId)!);
    // read the captured values, write into copies
    const orig = vs.map((s) => irPaths(s.ir));
    const boxes = vs.map((s) => designBoxes(s.ir, s.width));
    const irs = vs.map((s) => structuredClone(s.ir));
    const out = irs.map(irPaths);
    const memo = new Map<string, [number, number]>();
    /** [layers in the subtree, of which variant j has the same one in the same layout context] */
    const tally = (i: number, j: number, key: string): [number, number] => {
      const m = `${i}>${j}>${key}`;
      const hit = memo.get(m);
      if (hit) return hit;
      const a = orig[i]!.get(key)!,
        b = orig[j]!.get(key);
      const t: [number, number] = [1, b && sameContext(a, b) ? 1 : 0];
      const seen = new Map<string, number>();
      for (const c of a.el.children) {
        if (c.kind !== "el") continue;
        const l = `${c.tag}:${c.name ?? ""}`;
        const n = seen.get(l) ?? 0;
        seen.set(l, n + 1);
        const [x, y] = tally(i, j, `${key}/${l}#${n}`);
        t[0] += x;
        t[1] += y;
      }
      memo.set(m, t);
      return t;
    };
    /**
     * The element's content has the same structure in variant j (its height is the same layout's): it and its
     * direct children are there in the same context, and nearly all of its subtree (FLUID_DEEP).
     */
    const deep = (i: number, j: number, key: string): boolean => {
      const a = orig[i]!.get(key),
        b = orig[j]!.get(key);
      if (!a || !b || !sameContext(a, b)) return false;
      const names = (e: IrElement) =>
        e.children
          .flatMap((c) => (c.kind === "el" ? [`${c.tag}:${c.name ?? ""}`] : []))
          .sort()
          .join("|");
      if (names(a.el) !== names(b.el)) return false;
      const [all, same] = tally(i, j, key);
      return same >= all * FLUID_DEEP;
    };
    vs.forEach((s, i) => {
      const W = s.width;
      // the widest variant never extrapolates past its widest measurement: its fluid values stop there (capWideCss
      // keeps the layout at that width, centred, on wider screens)
      const top = (vw: string) =>
        i === vs.length - 1
          ? `min(${vw}, ${num(Math.max(W, ...(s.measured ?? []).map((m) => m.width)), 3)}px)`
          : vw;
      if (s.measured?.length) {
        const m = measuredFluid(s, i, irs[i]!);
        vwOf.set(s.nodeId, top(m.vw));
        changed.set(s.nodeId, {
          ...s,
          ir: irs[i]!,
          responsive: { ...s.responsive!, minWidth: m.min, fluid: m.fit },
        });
        return;
      }
      const hi = i + 1 < vs.length ? i + 1 : null;
      // the copy's boxes before anything is rewritten (reflowIr reads them)
      const own = designBoxes(irs[i]!, W);
      const same = i > 0 && layerOverlap(orig[i - 1]!, orig[i]!) >= FLUID_SAME;
      const min = fitMinWidth(vs, i, same);
      // reflows down to FLUID_FIT of its width (or its breakpoint); narrower (an explicit breakpoint far below the
      // design, the narrowest variant on a tiny screen) it keeps that layout, scaled (fitZoomCss)
      const fit = Math.max(min, Math.round(W * FLUID_FIT));
      const vw = top(min < fit ? `max(100vw, ${fit}px)` : "100vw");
      vwOf.set(s.nodeId, vw);
      for (const [key, me] of orig[i]!) {
        const o = hi === null ? undefined : orig[hi]!.get(key);
        const up: Partner = o && sameContext(me, o) ? { o, W: vs[hi!]!.width, j: hi! } : null;
        if (!up) continue;
        const parentKey = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
        const column = (me.el.style["flex-direction"] ?? "row").startsWith("column");
        const style = { ...me.el.style };
        let any = false;
        // media (an image, a video box) keeping its proportions at both widths: its height follows its own width
        const wa = pxOf(me.el.style.width),
          ha = pxOf(me.el.style.height),
          wb = pxOf(up.o.el.style.width),
          hb = pxOf(up.o.el.style.height);
        const aspect =
          wa &&
          ha &&
          wb &&
          hb &&
          Math.abs(wb - wa) > 1 &&
          Math.abs(hb / wb - ha / wa) <= 0.015 * (ha / wa) &&
          !wraps(me.el) &&
          !me.el.style["min-height"] &&
          !me.el.style["max-height"];
        if (aspect) {
          style["aspect-ratio"] = `${num(wa, 3)} / ${num(ha, 3)}`;
          any = true;
        }
        for (const prop of FLUID_PROPS) {
          const mine = me.el.style[prop];
          if (mine === undefined) continue;
          if (prop === "height" && aspect) {
            style.height = "auto";
            continue;
          }
          const parts = prop === "padding" ? mine.trim().split(/\s+/) : [mine];
          /** vertical geometry follows the other variant only where the content it wraps has the same structure */
          const vertical = (k: number) =>
            prop === "height" ||
            prop === "min-height" ||
            prop === "row-gap" ||
            (prop === "gap" && column) ||
            (prop === "padding" && parts.length === 4 && (k === 0 || k === 2));
          const slopeOf = (n: Partner, k: number): number | null => {
            const theirs = n && n.W !== W ? n.o.el.style[prop] : undefined;
            if (!n || theirs === undefined) return null;
            if (vertical(k) && !deep(i, n.j, key)) return null;
            if ((prop === "top" || prop === "bottom") && parentKey && !deep(i, n.j, parentKey)) return null;
            const tp = prop === "padding" ? theirs.trim().split(/\s+/) : [theirs];
            const a = pxOf(parts[k]),
              b = tp.length === parts.length ? pxOf(tp[k]) : null;
            return a === null || b === null ? null : (b - a) / (n.W - W);
          };
          style[prop] = parts
            .map((part, k) => {
              const v = pxOf(part);
              if (v === null) return part;
              // a horizontal box both variants place inside a parent of known width: a share of the parent plus a
              // constant (a max-width column: 0 % + its width; a band inside gutters: 100 % − the gutters; a grid
              // cell: its share), so it keeps following its parent wherever the parent's width comes from
              if (prop === "width" || prop === "left" || prop === "right") {
                const theirs = pxOf(up.o.el.style[prop]);
                const abs = isAbs(me.el.style);
                const Pa = me.parent
                  ? abs
                    ? boxes[i]!.get(me.parent)?.pad
                    : boxes[i]!.get(me.parent)?.content
                  : null;
                const Pb = up.o.parent
                  ? abs
                    ? boxes[up.j]!.get(up.o.parent)?.pad
                    : boxes[up.j]!.get(up.o.parent)?.content
                  : null;
                if (theirs !== null && Pa != null && Pb != null && Math.abs(Pb - Pa) > 1) {
                  const share = Number(num(Math.max(0, Math.min(1, (theirs - v) / (Pb - Pa))), 6));
                  if (share < 1e-4) return part;
                  any = true;
                  return shareCss(share, v - share * Pa);
                }
              }
              // wider: the line towards the next variant's box; narrower (down to the variant's breakpoint): the same
              // trend continued (the narrower variant is another layout), a width never growing as the viewport
              // narrows. Past the widest variant the page keeps its geometry (sites cap their content columns);
              // boxes without a partner are left to reflowIr's shrink rules.
              const u = slopeOf(up, k);
              if (u === null || Math.abs(u) < 1e-4) return part;
              // narrower: a width never grows (heights keep their trend: text boxes get taller, media shorter)
              const d = WIDTHISH.has(prop) ? Math.max(0, Math.min(1, u)) : u;
              any = true;
              return lerpCss(v, W, u, d, vw);
            })
            .join(" ");
        }
        if (any) out[i]!.get(key)!.el.style = style;
      }
      reflowIr(irs[i]!, W, own, vw);
      changed.set(s.nodeId, {
        ...s,
        ir: irs[i]!,
        responsive: { ...s.responsive!, minWidth: min, fluid: fit },
      });
    });
  }
  // a fluid variant's menus reflow with it (their panel narrows with the page instead of being scaled)
  for (const s of screens) {
    const owner = s.overlayOf
      ? [...changed.values()].find((x) => x.dslId === s.overlayOf || x.nodeId === s.overlayOf)
      : undefined;
    if (!owner || s.platform !== "web") continue;
    const ir = structuredClone(s.ir);
    reflowIr(ir, owner.width, undefined, vwOf.get(owner.nodeId));
    changed.set(s.nodeId, { ...s, ir });
  }
  const out = changed.size ? screens.map((s) => changed.get(s.nodeId) ?? s) : screens;
  // how much texts were narrowed (`data-narrowed`) is for measuredFluid only
  return out.map((s) => {
    if (!hasFitWidth(s.ir)) return s;
    const ir = structuredClone(s.ir);
    stripFitWidths(ir);
    return { ...s, ir };
  });
}

function hasFitWidth(ir: IrElement): boolean {
  if ("data-narrowed" in ir.attrs) return true;
  return ir.children.some((c) => c.kind === "el" && hasFitWidth(c));
}

/** Geometry a measured variant follows between the widths it was measured at (FLUID_PROPS plus margins and type). */
const MEASURED_PROPS = [
  ...FLUID_PROPS,
  "max-width",
  "min-width",
  "margin",
  "font-size",
  "line-height",
  "letter-spacing",
] as const;

/**
 * A variant measured at other widths of its layout range (URL capture, `measured`: the same tree with the site's
 * geometry there, docs/responsive.md "Layout ranges"). Every px value follows the line through its measured values:
 * above the design width towards the next wider measurement, below it towards the next narrower one (one of them
 * missing: the other one's trend, continued). The variant applies from its range's start exactly (`minWidth`, the
 * page's own breakpoint); the narrowest variant is scaled only below the narrowest width it was measured at. Text
 * boxes still grow with their content (reflowIr, without its width rules: the measured widths are the site's).
 * Rewrites `ir` (a copy). → the variant's breakpoint, the width it reflows down to and the viewport term.
 */
function measuredFluid(s: FluidScreen, i: number, ir: IrElement): { min: number; fit: number; vw: string } {
  const W = s.width;
  const ms = [...s.measured!].filter((m) => Math.abs(m.width - W) >= 1).sort((a, b) => a.width - b.width);
  const lowest = ms[0] && ms[0].width < W ? ms[0] : null;
  const min = i === 0 ? 0 : Math.round(s.responsive?.minWidth ?? 0);
  const fit =
    i === 0
      ? Math.min(Math.round(W), lowest ? Math.round(lowest.width) : Math.round(W * FLUID_FIT))
      : Math.min(Math.round(W), Math.max(min, lowest ? Math.round(lowest.width) : min));
  const vw = min < fit ? `max(100vw, ${fit}px)` : "100vw";
  const own = designBoxes(ir, W);
  const mine = irPaths(ir);
  const theirs = ms.map((m) => ({ W: m.width, paths: irPaths(m.ir) }));
  for (const [key, me] of mine) {
    const partners = theirs.flatMap((t) => {
      const o = t.paths.get(key);
      return o && sameContext(me, o) ? [{ st: o.el.style, W: t.W }] : [];
    });
    if (!partners.length) continue;
    const style = { ...me.el.style };
    let any = false;
    const wa = pxOf(me.el.style.width),
      ha = pxOf(me.el.style.height);
    // media keeping its proportions at every measured width: its height follows its own width
    const aspect =
      !!wa &&
      !!ha &&
      !wraps(me.el) &&
      !me.el.style["min-height"] &&
      !me.el.style["max-height"] &&
      partners.some((p) => {
        const wb = pxOf(p.st.width);
        return wb !== null && Math.abs(wb - wa) > 1;
      }) &&
      partners.every((p) => {
        const wb = pxOf(p.st.width),
          hb = pxOf(p.st.height);
        return wb !== null && hb !== null && wb > 0 && Math.abs(hb / wb - ha / wa) <= 0.015 * (ha / wa);
      });
    if (aspect) {
      style["aspect-ratio"] = `${num(wa!, 3)} / ${num(ha!, 3)}`;
      any = true;
    }
    for (const prop of MEASURED_PROPS) {
      const v0 = me.el.style[prop];
      if (v0 === undefined) continue;
      if (prop === "height" && aspect) {
        style.height = "auto";
        continue;
      }
      const parts = v0.trim().split(/\s+/);
      // a text narrowed to its longest line here (`data-narrowed`: by how much): the line runs through its box in the
      // page (its width that much wider, or its right margin that much smaller), the narrowed value holds at the
      // design width only (where 1000 × |viewport − W| is 0)
      const nb = Number(me.el.attrs["data-narrowed"]);
      const narrowed = (k: number) =>
        Number.isFinite(nb) &&
        nb > 0 &&
        ((prop === "width" && parts.length === 1) || (prop === "margin" && parts.length === 4 && k === 1))
          ? prop === "width"
            ? nb
            : -nb
          : 0;
      const off = `1000 * max(${vw} - ${num(W, 3)}px, ${num(W, 3)}px - ${vw})`;
      const next = parts.map((part, k) => {
        const v = pxOf(part);
        if (v === null) return part;
        const n = narrowed(k);
        const pts: Array<[number, number]> = [[W, v + n]];
        for (const p of partners) {
          const t = p.st[prop];
          const tp = t === undefined ? null : t.trim().split(/\s+/);
          const y = tp && tp.length === parts.length ? pxOf(tp[k]) : null;
          if (y !== null) pts.push([p.W, y]);
        }
        // vertical geometry that does not follow the viewport along a line (it changes where text wraps onto another
        // line: a step function) keeps the value of the nearest measured width instead of blending neighbours
        const vertical =
          prop === "height" ||
          prop === "min-height" ||
          prop === "top" ||
          prop === "bottom" ||
          prop === "row-gap" ||
          ((prop === "padding" || prop === "margin") && parts.length === 4 && (k === 0 || k === 2));
        const css = vertical && !linear(pts) ? stepCss(pts, W, vw) : pwlCss(pts, W, vw);
        if (n) {
          any = true;
          const line = css ?? `${num(v + n, 3)}px`;
          return n > 0
            ? `min(${line}, calc(${num(v, 3)}px + ${off}))`
            : `max(${line}, calc(${num(v, 3)}px - ${off}))`;
        }
        if (css === null) return part;
        any = true;
        return css;
      });
      style[prop] = next.join(" ");
    }
    if (any) me.el.style = style;
    if (me.el.tag === "img" && me.parent)
      artDirection(
        me.el,
        me.parent,
        W,
        theirs.flatMap((t) => {
          const o = t.paths.get(key);
          return o?.el.tag === "img" ? [{ W: t.W, src: o.el.attrs.src ?? "" }] : [];
        }),
      );
  }
  reflowIr(ir, W, own, vw, { widths: false });
  stripFitWidths(ir);
  return { min, fit, vw };
}

/**
 * An image the page shows as another picture at some measured widths (art direction: `<picture>` sources): wrapped in
 * a `<picture>` (`display: contents`, the layout is the image's) whose `<source>`s show the other pictures in their
 * ranges — between two measured widths showing different pictures the switch is put halfway.
 */
function artDirection(
  img: IrElement,
  parent: IrElement,
  W: number,
  others: ReadonlyArray<{ W: number; src: string }>,
): void {
  const mine = img.attrs.src ?? "";
  if (!mine || !others.some((o) => o.src && o.src !== mine)) return;
  const pts = [{ W, src: mine }, ...others.filter((o) => o.src)].sort((a, b) => a.W - b.W);
  // runs of one picture: [from, to) in viewport px
  const runs: Array<{ from: number; to: number | null; src: string }> = [];
  pts.forEach((p, k) => {
    const last = runs[runs.length - 1];
    if (last && last.src === p.src) return;
    const from = k === 0 ? 0 : Math.round((pts[k - 1]!.W + p.W) / 2);
    if (last) last.to = from;
    runs.push({ from, to: null, src: p.src });
  });
  const sources = runs
    .filter((r) => r.src !== mine)
    .map((r) =>
      el("source", {
        attrs: {
          media: [
            r.from > 0 ? `(min-width: ${r.from}px)` : "",
            r.to !== null ? `(max-width: ${r.to - 0.02}px)` : "",
          ]
            .filter(Boolean)
            .join(" and "),
          srcset: r.src,
        },
      }),
    );
  const i = parent.children.indexOf(img);
  if (i < 0 || !sources.length) return;
  parent.children[i] = el("picture", { style: { display: "contents" }, children: [...sources, img] });
}

/** `data-narrowed` (fromDsl: how much a text was narrowed to its longest line) is read by measuredFluid only: never exported. */
function stripFitWidths(ir: IrElement): void {
  const visit = (e: IrElement) => {
    if ("data-narrowed" in e.attrs) {
      const { "data-narrowed": _n, ...rest } = e.attrs;
      e.attrs = rest;
    }
    elKids(e).forEach(visit);
  };
  visit(ir);
}

/** Do the measured `[width, px]` points (three or more) lie on one straight line (±1 px)? Two points always do. */
export function linear(points: ReadonlyArray<[number, number]>): boolean {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length < 3) return true;
  const [a, b] = [pts[0]!, pts[pts.length - 1]!];
  if (b[0] === a[0]) return true;
  return pts.every(([x, y]) => Math.abs(a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]) - y) <= 1);
}

/**
 * The value of the nearest measured width (a step halfway between two measured widths), anchored at the design width
 * `W` (exactly its px there): a box whose height changes where its text wraps onto another line. Null when constant.
 * `clamp(0px, (vw − m) × 1000, 1px) × Δ` switches by Δ px within a thousandth of a px past the midpoint m.
 */
export function stepCss(points: ReadonlyArray<[number, number]>, W: number, vw = "100vw"): string | null {
  const pts = [...new Map(points.map((p) => [p[0], p] as const)).values()].sort((a, b) => a[0] - b[0]);
  const at = pts.findIndex((p) => p[0] === W);
  if (at < 0 || pts.length < 2) return null;
  const terms = [`${num(pts[at]![1], 3)}px`];
  for (let j = at + 1; j < pts.length; j++) {
    const d = pts[j]![1] - pts[j - 1]![1];
    if (Math.abs(d) >= 0.01)
      terms.push(
        `clamp(0px, (${vw} - ${num((pts[j - 1]![0] + pts[j]![0]) / 2, 3)}px) * 1000, 1px) * ${num(d, 3)}`,
      );
  }
  for (let j = at - 1; j >= 0; j--) {
    const d = pts[j]![1] - pts[j + 1]![1];
    if (Math.abs(d) >= 0.01)
      terms.push(
        `clamp(0px, (${num((pts[j]![0] + pts[j + 1]![0]) / 2, 3)}px - ${vw}) * 1000, 1px) * ${num(d, 3)}`,
      );
  }
  return terms.length === 1 ? null : `calc(${terms.join(" + ")})`;
}

/**
 * The continuous piecewise-linear value through measured `[viewport width, px]` points (straight lines between them,
 * the end segments continued outside), anchored at the design width `W` so the value there is exactly its px: its
 * slope above and below W plus a slope change at every other measured width. Null when it is constant.
 */
export function pwlCss(points: ReadonlyArray<[number, number]>, W: number, vw = "100vw"): string | null {
  const pts = [...new Map(points.map((p) => [p[0], p] as const)).values()].sort((a, b) => a[0] - b[0]);
  const at = pts.findIndex((p) => p[0] === W);
  if (at < 0 || pts.length < 2) return null;
  const v = pts[at]![1];
  const slope = (j: number) => (pts[j + 1]![1] - pts[j]![1]) / (pts[j + 1]![0] - pts[j]![0]);
  const n = pts.length - 1;
  const segs = Array.from({ length: n }, (_, j) => slope(j));
  if (segs.every((x) => Math.abs(x) < 1e-5)) return null;
  const up = at < n ? segs[at]! : segs[n - 1]!;
  const down = at > 0 ? segs[at - 1]! : segs[0]!;
  const f = (x: number) => num(x, 6);
  const terms = [`${num(v, 3)}px`];
  if (Math.abs(up - down) < 1e-6) {
    if (Math.abs(up) >= 1e-6) terms.push(`${f(up)} * (${vw} - ${num(W, 3)}px)`);
  } else {
    if (Math.abs(up) >= 1e-6) terms.push(`${f(up)} * max(0px, ${vw} - ${num(W, 3)}px)`);
    if (Math.abs(down) >= 1e-6) terms.push(`${f(down)} * min(0px, ${vw} - ${num(W, 3)}px)`);
  }
  // knots above W: the slope changes from segs[j - 1] to segs[j] at pts[j]; below W from segs[j] (right) to segs[j - 1] (left)
  for (let j = at + 1; j < n; j++) {
    const d = segs[j]! - segs[j - 1]!;
    if (Math.abs(d) >= 1e-6) terms.push(`${f(d)} * max(0px, ${vw} - ${num(pts[j]![0], 3)}px)`);
  }
  for (let j = at - 1; j > 0; j--) {
    const d = segs[j - 1]! - segs[j]!;
    if (Math.abs(d) >= 1e-6) terms.push(`${f(d)} * min(0px, ${vw} - ${num(pts[j]![0], 3)}px)`);
  }
  return terms.length === 1 ? null : `calc(${terms.join(" + ")})`;
}

/** Width of one side's border (`border` / `border-left` / `border-right` shorthands; 0 when none). */
function borderSide(st: Record<string, string>, side: "left" | "right"): number {
  const v = st[`border-${side}`] ?? st.border;
  if (!v || /^(none|0)/.test(v.trim())) return 0;
  const m = /(\d+(?:\.\d+)?)px/.exec(v);
  return m ? Number(m[1]) : 0;
}

/** Boxes at the design width (null where the width comes from content / flex distribution). */
export interface DesignBox {
  box: number | null;
  pad: number | null;
  content: number | null;
}

/**
 * Border-box / padding-box / content-box width of every element of a variant at its design width `D`, as far as
 * the captured styles fix them: px widths, the page root, absolute layers between two insets, flow children
 * stretched across a column, `100%`.
 */
export function designBoxes(main: IrElement, D: number): Map<IrElement, DesignBox> {
  const out = new Map<IrElement, DesignBox>();
  const boxOf = (st: Record<string, string>, box: number | null): DesignBox => {
    if (box === null) return { box: null, pad: null, content: null };
    const pad = box - borderSide(st, "left") - borderSide(st, "right");
    const p = pad4(st.padding);
    return { box, pad, content: pad - p[1] - p[3] };
  };
  const visit = (e: IrElement, parent: IrElement | null) => {
    const st = e.style;
    let w: number | null = null;
    if (!parent) w = D;
    else {
      const pb = out.get(parent)!;
      const px = pxOf(st.width);
      const m = pad4(st.margin);
      if (px !== null) w = px;
      else if (st.width === "100%") w = isAbs(st) ? pb.pad : pb.content;
      else if (st.width === undefined || st.width === "auto") {
        if (isAbs(st)) {
          const l = pxOf(st.left),
            r = pxOf(st.right);
          w = l !== null && r !== null && pb.pad !== null ? pb.pad - l - r : null;
        } else if (pb.content !== null) {
          const ps = parent.style;
          const flex = /flex/.test(ps.display ?? "");
          const col = flex && (ps["flex-direction"] ?? "row").startsWith("column");
          const self =
            st["align-self"] && st["align-self"] !== "auto"
              ? st["align-self"]
              : (ps["align-items"] ?? "normal");
          if (
            (col && (self === "stretch" || self === "normal")) ||
            (!flex && !/inline/.test(st.display ?? "") && ps.display !== "grid")
          )
            w = pb.content - m[1] - m[3];
        }
      }
    }
    out.set(e, boxOf(st, w));
    for (const c of elKids(e)) visit(c, e);
  };
  visit(main, null);
  return out;
}

const CLIPS = /^(hidden|clip|auto|scroll)$/;
const clips = (st: Record<string, string>) =>
  CLIPS.test(st.overflow ?? "") || CLIPS.test(st["overflow-x"] ?? "") || CLIPS.test(st["overflow-y"] ?? "");
const isFlex = (st: Record<string, string>) => /^(inline-)?(flex|grid)$/.test(st.display ?? "");
const isRow = (st: Record<string, string>) =>
  /^(inline-)?flex$/.test(st.display ?? "") && !(st["flex-direction"] ?? "row").startsWith("column");
const isAbs = (st: Record<string, string>) => st.position === "absolute" || st.position === "fixed";
/** a length the fluid pass may rewrite: captured px or its own interpolation */
const ownLength = (v: string | undefined): v is string =>
  v !== undefined && (PX_RE.test(v.trim()) || v.startsWith("calc("));
const elKids = (e: IrElement) => e.children.filter((c): c is IrElement => c.kind === "el");
const TEXT_TAGS = /^(p|h[1-6]|li|blockquote|figcaption)$/;
/** holds text that wraps when its box narrows (not single-line `pre` / `nowrap` labels) */
function wraps(e: IrElement): boolean {
  const ws = e.style["white-space"];
  if (TEXT_TAGS.test(e.tag) && ws !== "pre" && ws !== "nowrap") return true;
  return elKids(e).some((c) => c.style.position !== "absolute" && wraps(c));
}

const pad4 = (v: string | undefined): [number, number, number, number] => {
  const p = (v ?? "")
    .trim()
    .split(/\s+/)
    .map((x) => pxOf(x) ?? 0);
  return p.length === 4
    ? [p[0]!, p[1]!, p[2]!, p[3]!]
    : p.length === 2
      ? [p[0]!, p[1]!, p[0]!, p[1]!]
      : p.length === 3
        ? [p[0]!, p[1]!, p[2]!, p[1]!]
        : [p[0] ?? 0, p[0] ?? 0, p[0] ?? 0, p[0] ?? 0];
};

/** Captured height of a layer: its px height, or a single-line label's line height. */
function heightOf(e: IrElement): number | null {
  const h = pxOf(e.style.height);
  if (h !== null) return h;
  const ws = e.style["white-space"],
    lh = pxOf(e.style["line-height"]);
  return lh !== null && (ws === "pre" || ws === "nowrap") ? lh : null;
}

/**
 * The layer at the bottom of a box whose layers are all placed (absolute): when it holds text that wraps, it joins
 * the box's flow at its captured offset (margins), so the box grows when the text needs more lines instead of the
 * text spilling out. Layers above it stay placed; a backdrop spanning the box is pinned to both its edges. Only when
 * nothing else sits below the layer's top.
 */
function promoteTrailing(c: IrElement): void {
  if (c.style.display === "none") return;
  // layers not drawn (a component's other states) neither move nor count
  const kids = elKids(c).filter((k) => k.style.display !== "none");
  if (!kids.length || !ownLength(c.style.height) || clips(c.style) || kids.some((k) => !isAbs(k.style)))
    return;
  const H = pxOf(c.style.height);
  if (H === null) return;
  const placed = kids.filter(
    (k) => k.style.position === "absolute" && pxOf(k.style.top) !== null && k.style.bottom === undefined,
  );
  const x = placed
    .filter((k) => wraps(k) && pxOf(k.style.left) !== null && !k.style.margin && !k.style.transform)
    .sort((a, b) => pxOf(b.style.top)! - pxOf(a.style.top)!)[0];
  if (!x) return;
  const top = pxOf(x.style.top)!;
  const backdrops: IrElement[] = [];
  for (const k of kids) {
    if (k === x) continue;
    const t = pxOf(k.style.top),
      h = heightOf(k);
    if (t === null) return;
    if (t <= 1 && h !== null && t + h >= H - 1) {
      backdrops.push(k);
      continue;
    }
    if (t > top + 1) return;
  }
  const [pt, pr, , pl] = pad4(c.style.padding);
  const left = pxOf(x.style.left)!,
    right = pxOf(x.style.right);
  const xs: Record<string, string> = {
    ...x.style,
    position: "relative",
    margin: `${num(top - pt, 3)}px ${num(right === null ? 0 : right - pr, 3)}px 0px ${num(left - pl, 3)}px`,
    "align-self": right === null ? "flex-start" : "stretch",
    "flex-shrink": "0",
  };
  delete xs.top;
  delete xs.left;
  delete xs.right;
  if (right !== null) xs.width = "auto";
  x.style = xs;
  for (const b of backdrops) {
    const bs: Record<string, string> = {
      ...b.style,
      bottom: `${num(H - pxOf(b.style.top)! - heightOf(b)!, 3)}px`,
      height: "auto",
    };
    b.style = bs;
  }
  c.style = {
    ...c.style,
    display: c.style.display?.includes("flex") ? c.style.display : "flex",
    "flex-direction": "column",
    "justify-content": "flex-start",
    gap: "0px",
  };
}

/**
 * A grid of equal px tracks that fills its box at the design width becomes `repeat(n, minmax(0, 1fr))` (identical
 * there): its columns share the width it has at any viewport, and cells as wide as their track fill it.
 */
function fluidGrid(e: IrElement, st: Record<string, string>, box: DesignBox | undefined): void {
  const cols = st["grid-template-columns"];
  if (st.display !== "grid" || !cols || box?.content == null) return;
  const tracks = cols.trim().split(/\s+/).map(pxOf);
  if (tracks.length < 2 || tracks.some((t) => t === null || Math.abs(t - tracks[0]!) > 0.5)) return;
  const gap = pxOf(st["column-gap"] ?? st.gap?.trim().split(/\s+/).pop()) ?? 0;
  const T = tracks[0]!;
  if (Math.abs(T * tracks.length + gap * (tracks.length - 1) - box.content) > 1) return;
  st["grid-template-columns"] = `repeat(${tracks.length}, minmax(0, 1fr))`;
  for (const c of elKids(e)) {
    const cs = c.style;
    if (
      isAbs(cs) ||
      Math.abs((pxOf(cs.width) ?? -1) - T) > 0.5 ||
      cs.margin ||
      cs["justify-self"] ||
      st["justify-items"]
    )
      continue;
    c.style = { ...cs, width: "auto", "min-width": "0px" };
  }
}

/**
 * Reflow below the design width `D` (docs/responsive.md "Between the breakpoints"): boxes give up as much width as
 * the viewport lost (`Δ = D − 100vw`) and no more, so content fits and text wraps instead of overflowing or being
 * scaled; boxes that hold wrapping text grow with it away from the design width (their captured height a minimum,
 * pinned to it at the design width) and the page's main layer joins the flow so the page is as tall as its content.
 * At the design width every box keeps its captured geometry. `vw`: the viewport as the formulas read it (floored at
 * the width the variant reflows down to, below which it is scaled).
 */
/** px: boxes this narrow (icons, icon buttons) keep their width when the viewport narrows */
const SMALL_BOX = 48;

export function reflowIr(
  main: IrElement,
  D: number,
  boxes: ReadonlyMap<IrElement, DesignBox> = designBoxes(main, D),
  vw = "100vw",
  o: { widths?: boolean } = {},
): void {
  const delta = `max(0px, ${num(D, 3)}px - ${vw})`;
  /** |viewport − D|: 0 only at the design width, where a growing box is pinned to its captured height */
  const off = `max(${vw} - ${num(D, 3)}px, ${num(D, 3)}px - ${vw})`;
  const visit = (e: IrElement, parent: IrElement | null) => {
    const st = { ...e.style };
    // a full-bleed band (`max(<design width>, 100vw)`, dsl/fluid.ts) spans the viewport below the design width too
    for (const [k, v] of Object.entries(st))
      if (v.includes("100vw)"))
        st[k] = v.replace(/max\((\d+(?:\.\d+)?)px, 100vw\)/g, (m, n: string) =>
          Math.abs(Number(n) - D) <= 1 ? vw : m,
        );
    fluidGrid(e, st, boxes.get(e));
    const w = st.width;
    // wrapping text narrows down to its longest word, never breaking inside one (`anywhere` would let it)
    const text = TEXT_TAGS.test(e.tag) && st["white-space"] !== "pre" && st["white-space"] !== "nowrap";
    if (parent && ownLength(w) && !e.raw && text)
      Object.assign(st, { "min-width": "min-content", "overflow-wrap": "break-word" });
    // icons and icon-sized controls keep their size (sites never squeeze them): no per-variant shrink rule either
    const small = !text && (pxOf(w) ?? Infinity) <= SMALL_BOX;
    if (o.widths !== false && parent && ownLength(w) && !e.raw && !st["max-width"] && !small) {
      const min = text ? undefined : st["min-width"];
      if (text && isRow(parent.style) && !isAbs(st)) st["flex-shrink"] = "1";
      else if (isRow(parent.style) && !isAbs(st) && parent.style["flex-wrap"] !== "wrap") {
        // a row's fixed boxes share the width it loses (in proportion), none below its width − Δ; rows that scroll /
        // clip (sliders) keep their items
        if (!clips(parent.style) && (min === undefined || min === "0px")) {
          st["flex-shrink"] = "1";
          st["min-width"] = `calc(${w} - ${delta})`;
        }
      } else if (isAbs(st) && PX_RE.test(w) && (pxOf(st.left) ?? -1) > 0 && st.right === undefined) {
        // a layer placed at a fixed offset (a captured grid of cards): offset and width narrow with the viewport, so
        // neighbours keep their gaps instead of running into each other
        const x = pxOf(st.left)!,
          wv = pxOf(w)!;
        st.left = `min(${num(x, 3)}px, ${num(x / D, 6)} * ${vw})`;
        st.width = `min(${num(wv, 3)}px, ${num(wv / D, 6)} * ${vw})`;
      } else if (min === undefined || min === "0px") {
        const left = isAbs(st) ? pxOf(st.left) : 0;
        const room = left && left > 0 ? `calc(100% - ${num(left, 3)}px)` : "100%";
        st["max-width"] = `max(${room}, calc(${w} - ${delta}))`;
      }
    }
    const h = st.height;
    const flow = elKids(e).filter((c) => !isAbs(c.style));
    if (
      ownLength(h) &&
      isFlex(st) &&
      flow.length &&
      !clips(st) &&
      !st["min-height"] &&
      !e.raw &&
      !flow.some((c) => /%/.test(c.style.height ?? ""))
    ) {
      // content taller than the box at the design width (overflowing by design) keeps the box as it is
      const H = pxOf(h);
      const col = !isRow(st) && (st.display ?? "").includes("flex");
      const gap = pxOf(st["row-gap"] ?? st.gap) ?? 0;
      const pad = (st.padding ?? "")
        .trim()
        .split(/\s+/)
        .map((x) => pxOf(x) ?? 0);
      const padV = pad.length === 4 ? pad[0]! + pad[2]! : pad.length >= 1 ? 2 * pad[0]! : 0;
      const sum = col
        ? flow.reduce((a, c) => a + (pxOf(c.style.height) ?? 0), 0) +
          gap * Math.max(0, flow.length - 1) +
          padV
        : 0;
      // grows away from the design width only (max-height pins it there), and only around text that wraps
      if ((H === null || sum <= H + 1) && wraps(e))
        Object.assign(st, { height: "auto", "min-height": h, "max-height": `calc(${h} + 1000 * ${off})` });
    }
    e.style = st;
    for (const c of elKids(e)) visit(c, e);
  };
  const promote = (e: IrElement) => {
    elKids(e).forEach(promote);
    promoteTrailing(e);
  };
  promote(main);
  visit(main, null);
  // the page grows with its main layer: the layer holding the page's flow (absolute at the top, spanning the page)
  const root = elKids(main)[0];
  const H = pxOf(main.style["min-height"] ?? main.style.height);
  if (!root || H === null) return;
  const layer = elKids(root).find(
    (c) =>
      c.style.position === "absolute" &&
      c.style.height === "auto" &&
      pxOf(c.style.top) === 0 &&
      pxOf(c.style.left) === 0 &&
      (c.style.right === "0px" || c.style.width === "100%") &&
      (pxOf(c.style["min-height"]) ?? 0) >= H * 0.9,
  );
  if (!layer) return;
  const ls: Record<string, string> = { ...layer.style, position: "relative", width: "auto" };
  delete ls.top;
  delete ls.left;
  delete ls.right;
  delete ls.bottom;
  layer.style = ls;
  main.style = {
    ...main.style,
    height: "auto",
    "min-height": main.style.height!,
    "max-height": `calc(${main.style.height!} + 1000 * ${off})`,
  };
  root.style = { ...root.style, height: "auto" };
}
