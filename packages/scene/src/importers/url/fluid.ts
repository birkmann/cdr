// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// A capture's layers measured at other widths of the same layout range (docs/responsive.md "Layout ranges"):
// fig-server walks the page again at the range's ends (`Snapshot.alt`, same DOM: every box names its box of the main
// walk), each walk is converted like the page, and every layer of the page records what its partner there measured
// differently (`layout.fluid`). Exports interpolate between the widths (export/responsive.ts fluidVariants), so a
// width between two captures has the geometry the site has there instead of a capture stretched or scaled.
import type { SceneElement, SceneFluidAt, SceneLayout } from "@harness/protocol";
import type { SnapNode, Snapshot } from "@harness/capture";
import type { UrlImportResult } from "./convert.js";

/** smallest difference worth recording (px) */
const EPS = 0.5;
const NUM_KEYS = [
  "x",
  "y",
  "width",
  "height",
  "right",
  "bottom",
  "minWidth",
  "maxWidth",
  "minHeight",
] as const;
const FLOW_KEYS = ["gap", "crossGap"] as const;
const STYLE_KEYS = ["fontSize", "lineHeightPx", "letterSpacing"] as const;

type Four = [number, number, number, number];
const four = (v: SceneLayout["padding"]): Four | null => {
  if (typeof v === "number") return [v, v, v, v];
  if (Array.isArray(v) && v.length === 2) return [v[0], v[1], v[0], v[1]];
  if (Array.isArray(v) && v.length === 4) return [v[0], v[1], v[2], v[3]];
  return null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** walk ids → nodes of a snapshot tree */
function nodesOf(snap: Snapshot): Map<number, SnapNode> {
  const out = new Map<number, SnapNode>();
  const visit = (n: SnapNode) => {
    out.set(n.id, n);
    if ("children" in n && n.children) for (const c of n.children) visit(c);
  };
  if (snap.root) visit(snap.root);
  return out;
}

/** main walk id → the alt walk's id of the same box */
export function baseIds(alt: Snapshot): Map<number, number> {
  const out = new Map<number, number>();
  for (const n of nodesOf(alt).values())
    if (typeof n.base === "number" && !out.has(n.base)) out.set(n.base, n.id);
  return out;
}

/** The alt walk's ids of the main walk's kept boxes (they stay their own layer there too). */
export function altKeep(alt: Snapshot, keep: Iterable<number>): number[] {
  const ids = baseIds(alt);
  return [...keep].flatMap((k) => (ids.has(k) ? [ids.get(k)!] : []));
}

function index(root: SceneElement): Map<string, SceneElement> {
  const out = new Map<string, SceneElement>();
  const visit = (e: SceneElement) => {
    out.set(e.id, e);
    e.children?.forEach(visit);
  };
  visit(root);
  return out;
}

/**
 * A text narrowed to its longest line (convert `meta.narrowedBy`) as wide as its box in the page: its width, or (auto
 * layout made it stretch) its right margin, by what the narrowing took. The narrowing itself is no geometry of the
 * page (it only keeps the capture width's line breaks): what other widths are compared by.
 */
function unNarrowed(e: SceneElement): SceneLayout {
  const l = e.layout ?? {};
  const d = e.meta?.narrowedBy;
  if (typeof d !== "number" || !(d > 0)) return l;
  if (typeof l.width === "number") return { ...l, width: r2(l.width + d) };
  const m = four(l.margin);
  if (l.width === "fill" && m) return { ...l, margin: [m[0], r2(Math.max(0, m[1] - d)), m[2], m[3]] };
  return l;
}

/** What `b` (the layer at width `at`) measures differently from `a`, when both are laid out the same way; null: nothing. */
export function geometryDiff(a: SceneElement, b: SceneElement, at: number): SceneFluidAt | null {
  if (a.type !== b.type) return null;
  const la = unNarrowed(a),
    lb = unNarrowed(b);
  if ((la.position === "absolute") !== (lb.position === "absolute")) return null;
  const out: SceneFluidAt = { at };
  let any = false;
  const set = <K extends keyof SceneFluidAt>(k: K, v: SceneFluidAt[K]) => {
    out[k] = v;
    any = true;
  };
  for (const k of NUM_KEYS) {
    const x = la[k],
      y = lb[k];
    if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) > EPS) set(k, r2(y));
  }
  // gaps and paddings belong to the same kind of layout only (a row's gap is no column's)
  const sameFlow =
    (la.direction ?? "") === (lb.direction ?? "") && !!la.grid === !!lb.grid && !!la.wrap === !!lb.wrap;
  if (sameFlow) {
    for (const k of FLOW_KEYS) {
      const x = la[k],
        y = lb[k];
      if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) > EPS) set(k, r2(y));
    }
    const pa = four(la.padding),
      pb = four(lb.padding);
    if (pa && pb && pa.some((v, i) => Math.abs(v - pb[i]!) > EPS)) set("padding", pb.map(r2) as Four);
  }
  const ma = four(la.margin),
    mb = four(lb.margin);
  if ((ma || mb) && (ma ?? [0, 0, 0, 0]).some((v, i) => Math.abs(v - (mb ?? [0, 0, 0, 0])[i]!) > EPS))
    set("margin", (mb ?? [0, 0, 0, 0]).map(r2) as Four);
  // the page's art direction: another picture there (the capture keeps only other crops, not other resolutions)
  if (a.type === "image" && b.image?.src && a.image?.src && a.image.src !== b.image.src)
    set("src", b.image.src);
  const sa = a.style ?? {},
    sb = b.style ?? {};
  for (const k of STYLE_KEYS) {
    const x = sa[k],
      y = sb[k];
    if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) > 0.05) set(k, r2(y));
  }
  return any ? out : null;
}

/**
 * Pair the main conversion's layers with an alt conversion's: through the walks (a layer made from a box ↔ the layer
 * made from the same box there), then the layers left over by name and type among their partners' children (groups the
 * conversion made itself). → main layer id → alt layer.
 */
export function pairLayers(
  main: UrlImportResult,
  alt: UrlImportResult,
  ids: Map<number, number>,
): Map<string, SceneElement> {
  const mainEls = index(main.screen.root),
    altEls = index(alt.screen.root);
  const out = new Map<string, SceneElement>();
  const used = new Set<string>();
  const pair = (m: SceneElement, a: SceneElement) => {
    if (out.has(m.id) || used.has(a.id)) return;
    out.set(m.id, a);
    used.add(a.id);
  };
  pair(main.screen.root, alt.screen.root);
  for (const [node, layer] of main.idOf) {
    const altNode = ids.get(node);
    const altLayer = altNode === undefined ? undefined : alt.idOf.get(altNode);
    const m = mainEls.get(layer),
      a = altLayer ? altEls.get(altLayer) : undefined;
    if (m && a) pair(m, a);
  }
  const visit = (m: SceneElement) => {
    const a = out.get(m.id);
    if (a?.children?.length) {
      const nth = new Map<string, number>();
      const keyOf = (e: SceneElement) => `${e.type}|${e.name ?? ""}`;
      const theirs = new Map<string, SceneElement[]>();
      for (const c of a.children) {
        const k = keyOf(c);
        theirs.set(k, [...(theirs.get(k) ?? []), c]);
      }
      for (const c of m.children ?? []) {
        const k = keyOf(c);
        const i = nth.get(k) ?? 0;
        nth.set(k, i + 1);
        const hit = theirs.get(k)?.[i];
        if (hit && !out.has(c.id) && !used.has(hit.id)) pair(c, hit);
      }
    }
    m.children?.forEach(visit);
  };
  visit(main.screen.root);
  return out;
}

/**
 * Record on the main conversion's layers (`layout.fluid`) what each alt conversion measured differently. Returns the
 * widths measured (ascending) — every alt whose page could be paired at all.
 */
export function measureAlts(
  main: UrlImportResult,
  alts: ReadonlyArray<{ width: number; snap: Snapshot; res: UrlImportResult }>,
): number[] {
  const els = index(main.screen.root);
  const parents = parentsOf(main.screen.root);
  const widths: number[] = [];
  for (const alt of [...alts].sort((a, b) => a.width - b.width)) {
    if (alt.width === main.screen.width) continue;
    const pairs = pairLayers(main, alt.res, baseIds(alt.snap));
    if (pairs.size < 2) continue;
    widths.push(alt.width);
    const rects = layerRects(alt.snap, alt.res);
    const altParents = parentsOf(alt.res.screen.root);
    for (const [id, a] of pairs) {
      const m = els.get(id);
      if (!m) continue;
      // a box stretched here, of a fixed (capped, centred) width there: the same box as margins in its parent (only
      // when they differ from its own: an all-zero entry would only tell copies of one card apart)
      const own = four(m.layout?.margin) ?? [0, 0, 0, 0];
      const fill = fillMargins(m, parents.get(m.id), a, altParents.get(a.id), rects);
      const fm = fill && fill.some((v, i) => Math.abs(v - own[i]!) > EPS) ? fill : null;
      const d = geometryDiff(m, a, alt.width) ?? (fm ? { at: alt.width } : null);
      if (!d) continue;
      if (fm) d.margin = fm;
      m.layout = {
        ...(m.layout ?? {}),
        fluid: [...(m.layout?.fluid ?? []).filter((f) => f.at !== alt.width), d],
      };
    }
  }
  return widths;
}

function parentsOf(root: SceneElement): Map<string, SceneElement> {
  const out = new Map<string, SceneElement>();
  const visit = (e: SceneElement) => {
    for (const c of e.children ?? []) {
      out.set(c.id, e);
      visit(c);
    }
  };
  visit(root);
  return out;
}

/** layer id → the page box (border box, page px) of the walk's box it was made from */
function layerRects(
  snap: Snapshot,
  res: UrlImportResult,
): Map<string, { x: number; y: number; w: number; h: number }> {
  const nodes = nodesOf(snap);
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const [node, layer] of res.idOf) {
    const r = nodes.get(node)?.rect;
    if (r && !out.has(layer)) out.set(layer, r);
  }
  return out;
}

/**
 * A layer that stretches across its parent at the capture width (`width: 'fill'`, the parent's only box in flow or a
 * column) but has a width of its own at the other one (a max-width box centred in a wider viewport): its margins
 * there, measured from the walk's boxes ([top, right, bottom, left]; top / bottom as there). Null when not that case.
 */
function fillMargins(
  m: SceneElement,
  mp: SceneElement | undefined,
  a: SceneElement,
  ap: SceneElement | undefined,
  rects: Map<string, { x: number; w: number }>,
): [number, number, number, number] | null {
  if (
    m.layout?.width !== "fill" ||
    typeof a.layout?.width !== "number" ||
    m.layout?.position === "absolute" ||
    !mp ||
    !ap
  )
    return null;
  const inFlow = (mp.children ?? []).filter((c) => c.layout?.position !== "absolute");
  if (mp.layout?.direction !== "column" && inFlow.length !== 1) return null;
  const r = rects.get(a.id),
    pr = rects.get(ap.id);
  if (!r || !pr) return null;
  const pad = four(ap.layout?.padding) ?? [0, 0, 0, 0];
  const own = four(a.layout?.margin) ?? four(m.layout?.margin) ?? [0, 0, 0, 0];
  const left = r.x - (pr.x + pad[3]),
    right = pr.x + pr.w - pad[1] - (r.x + r.w);
  if (left < -0.5 || right < -0.5) return null;
  return [r2(own[0]), r2(right), r2(own[2]), r2(left)];
}

/** The alt walks of a capture (fig-server `alt`), as snapshots the converter reads (the main walk's page assets). */
export function altSnapshots(snap: Snapshot): Array<{ width: number; snap: Snapshot }> {
  return (snap.alt ?? [])
    .filter((a) => a && a.root && typeof a.width === "number")
    .map((a) => ({
      width: Math.round(a.width),
      snap: {
        ...a,
        version: 1,
        url: a.url ?? snap.url,
        title: a.title ?? snap.title,
        assets: snap.assets,
        embeddedFonts: [],
        states: undefined,
        alt: undefined,
        brand: undefined,
      } as Snapshot,
    }));
}

/** a snapshot tree copied, `fn` applied to every node (children first copied) */
function mapTree(n: SnapNode, fn: (n: SnapNode) => SnapNode): SnapNode {
  const c =
    "children" in n && n.children ? { ...n, children: n.children.map((k) => mapTree(k, fn)) } : { ...n };
  return fn(c as SnapNode);
}

/**
 * One variant of a capture session (layoutPlan.ts planSessions): the page as walked at `width` — the capture itself
 * at its own width, else its walk there (`alt`) made a page snapshot: the capture's assets and fonts, raster boxes
 * with the capture's shots, the navigation menu states (their toggle found in the walk), and the walks at `measure`
 * (the variant's range ends) as its own `alt`, re-based onto the walk's ids. Null when the capture has no walk there.
 */
export function sessionSnapshot(main: Snapshot, width: number, measure: readonly number[]): Snapshot | null {
  const walks = main.alt ?? [];
  if (Math.round(main.page.width) === width || Math.round(main.viewport?.width ?? 0) === width) {
    return { ...main, alt: walks.filter((a) => measure.includes(Math.round(a.width))) };
  }
  const walk = walks.find((a) => Math.round(a.width) === width && a.root);
  if (!walk) return null;
  const toWalk = baseIds(walk);
  const mainNodes = nodesOf(main);
  // canvases / videos / iframes: the capture's shot of the same box (its size there may differ)
  const root = mapTree(walk.root!, (n) => {
    if ("kind" in n && n.kind === "raster" && !(n as { src?: string }).src && typeof n.base === "number") {
      const m = mainNodes.get(n.base) as { src?: string } | undefined;
      if (m?.src) return { ...n, src: m.src } as SnapNode;
    }
    return n;
  }) as Snapshot["root"];
  // the menu: opened by the same toggle (its id in this walk); widget states stay the capture's own
  // the menu as it opened at this width (fig-server walks a variant's own menu; `trigger` = the main-walk id), else
  // the capture's menus opened by the same toggle
  const all = walk.menuState ? [walk.menuState] : (main.states ?? []);
  const keep: number[] = [];
  all.forEach((st, i) => {
    if (
      st.kind === "menu"
        ? st.trigger !== undefined && toWalk.has(st.trigger)
        : st.kind === "submenu" && keep.includes(st.parent ?? -1)
    )
      keep.push(i);
  });
  const states = keep.map((i) => {
    const st = all[i]!;
    return st.kind === "menu"
      ? { ...st, trigger: toWalk.get(st.trigger!)! }
      : { ...st, parent: keep.indexOf(st.parent!) };
  });
  const rebased = walks
    .filter((a) => measure.includes(Math.round(a.width)) && a !== walk && a.root)
    .map((a) => ({
      ...a,
      root: mapTree(a.root!, (n) => {
        const b = typeof n.base === "number" ? toWalk.get(n.base) : undefined;
        const { base: _b, ...rest } = n;
        return (b === undefined ? rest : { ...rest, base: b }) as SnapNode;
      }) as Snapshot["root"],
    }));
  return {
    ...walk,
    menuState: undefined,
    version: 1,
    url: walk.url ?? main.url,
    title: walk.title ?? main.title,
    lang: main.lang,
    capturedAt: main.capturedAt,
    root,
    assets: main.assets,
    embeddedFonts: main.embeddedFonts,
    fonts: main.fonts,
    fontFaces: main.fontFaces,
    sheets: main.sheets,
    states: states.length ? states : undefined,
    controls: undefined,
    alt: rebased,
    brand: undefined,
  } as Snapshot;
}
