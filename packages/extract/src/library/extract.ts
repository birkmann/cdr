// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// "Create components from screens": parts that repeat across a set of screens (the card on every page, the footer
// link, the same teaser at each breakpoint) become component sets, and every copy becomes an instance of its set —
// its own copy, images, icons, links and hidden layers as properties or overrides. A part designed at several
// breakpoints of a responsive page with a few layers changed is one set with a `breakpoint` variant axis. Smaller parts
// are made first, so a card's main holds instances of the button inside it.
//
// With `sections`, the pages themselves are converted too: every top-level section of a web page (header, hero, the
// content sections, footer: the stacked full-width blocks of the page) becomes a set even when it occurs once per
// breakpoint — the same section at each breakpoint of a responsive page is one set with `breakpoint` variants whose
// trees may differ. Every set is classified (kind / category, catalog.ts) and named after what it is.
//
// Pure (the store action is createComponentsFromScreens in componentSets.ts); lossless: a copy only becomes an instance
// when that instance rebuilds into exactly the copy.
import type {
  SceneComponentDef,
  SceneComponentKind,
  SceneDesignSystem,
  SceneElement,
  SceneScreen,
} from "@harness/protocol";
import { classPrefixes, meaningfulLayerName } from "@harness/scene";
import {
  ID_SEP,
  PLACEMENT_KEYS,
  ROOT_KEY,
  buildInstance,
  captureInstance,
  deepEqual,
  derivedId,
  linkedText,
  parseVariantKey,
} from "./instances.js";
import {
  KIND_CATEGORY,
  KIND_LABELS,
  classifyTree,
  propertyNames,
  type ClassifyContext,
  type PropertyTargets,
} from "./catalog.js";
import { itemPlaces, repeatedItems } from "./repeatedItems.js";

export interface ExtractScreen {
  nodeId: string;
  screen: SceneScreen;
}

export interface ExtractedComponent {
  id: string;
  name: string;
  instances: number;
  variants: string[];
  kind?: SceneComponentKind;
  /** a page section (header, hero, section, footer, menu) rather than a repeated part */
  section?: boolean;
  /** a section found once (one page, a copy per breakpoint) that no other section was alike enough to join (ExtractionNotes) */
  single?: boolean;
  /** the built-in name it shares with other sets (ExtractionNotes.nameClash) */
  nameClash?: string;
  /** its name got a number ("… 2") because nothing else told it apart: a defect the naming step must fix */
  numbered?: boolean;
}

/**
 * What extraction knows about a set beyond its definition, stored on the def as `extraction` (read with
 * `extractionOf`): for the naming catalog, the library and the flow's checks.
 */
export interface ExtractionNotes {
  /** a page section found once that matched no other section: a unique section, not a failed merge (see `nearest`) */
  single?: boolean;
  /** the best similarity (0–1) of a single section to another of its kind, below the merge threshold: high = near-miss twin */
  nearest?: number;
  /**
   * the built-in name this set shares with other sets (resolveNames found nothing else to tell them apart, so they were
   * numbered "… 2", "… 3"): the naming step must give all sets with this `nameClash` distinct semantic names
   */
  nameClash?: string;
}
/** A component set with its extraction notes. */
export type ExtractedDef = SceneComponentDef & { extraction?: ExtractionNotes };
/** The extraction notes of a set (undefined: none, or not extracted). */
export const extractionOf = (def: SceneComponentDef): ExtractionNotes | undefined =>
  (def as ExtractedDef).extraction;

export interface ExtractResult {
  ds: SceneDesignSystem;
  /** screens that now hold instances, by node id */
  screens: Map<string, SceneScreen>;
  components: ExtractedComponent[];
}

export interface ExtractOptions {
  /** id of a new component set */
  newId: () => string;
  /** a part needs this many copies (default 2) */
  min?: number;
  /** every top-level section of a web page becomes a set too, once per page is enough (default false) */
  sections?: boolean;
  /** component properties from how the copies differ: texts, images, hidden layers, swapped instances (default true) */
  props?: boolean;
}

/** Variant names of the `breakpoint` axis: the screens' breakpoints, smallest first (as the React export names them). */
const BREAKPOINTS: Record<number, string[]> = {
  2: ["sm", "lg"],
  3: ["sm", "md", "lg"],
  4: ["sm", "md", "lg", "xl"],
  5: ["xs", "sm", "md", "lg", "xl"],
  6: ["xs", "sm", "md", "lg", "xl", "2xl"],
};
/** more breakpoints than the table names: xs, sm, md, lg, xl, 2xl, 3xl… (smallest first) */
const moreBreakpointNames = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => ["xs", "sm", "md", "lg", "xl"][i] ?? `${i - 3}xl`);
export const BREAKPOINT_AXIS = "breakpoint";

/** A set's looks as values of one variant axis: `tone` (they differ only in colour) or `size` (only in size). */
export interface LookAxis {
  name: "tone" | "size";
  values: string[];
}
/** A set's variant axes, each with the value of every look (in the looks' order); [] for one look. */
export type LookAxes = Array<{ name: string; values: string[] }>;

/** A picture's crop (`objectPosition`: where its focus sits) belongs to the picture, like its source: content. */
const withoutCrop = (st: SceneElement["style"]) => {
  if (!st || st.objectPosition === undefined) return st;
  const { objectPosition: _crop, ...rest } = st;
  return rest;
};

/** An inline SVG without the size its root element states (`width` / `height`) and its namespace declarations. */
const svgAtAnySize = (svg: string) =>
  svgSame(svg)
    .replace(/^(<svg\b[^>]*?)\s(?:width|height)="[^"]*"/, "$1")
    .replace(/^(<svg\b[^>]*?)\s(?:width|height)="[^"]*"/, "$1");
/** An inline SVG without namespace declarations (one capture writes them, another not: the same drawing in a page). */
const svgSame = (svg: string) => svg.replace(/\s+xmlns(?::xlink)?="[^"]*"/g, "");

const GEOMETRY_LAYOUT = new Set([
  "x",
  "y",
  "width",
  "height",
  "right",
  "bottom",
  "padding",
  "margin",
  "gap",
  "crossGap",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "fluid",
  "grow",
  "aspectRatio",
]);
const GEOMETRY_STYLE = new Set([
  "fontSize",
  "lineHeight",
  "lineHeightPx",
  "letterSpacing",
  "radius",
  "objectPosition",
]);
/**
 * Looks that differ only in geometry — places, sizes, spacing, type sizes, an icon's drawn size: the same design laid
 * out for another width. Such a part needs no variants: one main, each copy's geometry its own (an export draws it per
 * width), not a variant per captured width.
 */
/**
 * Editor meta a capture measured per copy (how far a text was narrowed to its longest line): geometry, like a width —
 * each copy's own, carried as an override (convert adds them, see metaOverrides).
 */
const GEOMETRY_META = new Set(["narrowedBy"]);
/** A layer's editor meta as it tells layers apart below an instance's root: all of it but visibility and geometry. */
const metaBelowRoot = (el: SceneElement) => {
  if (!el.meta) return null;
  const rest = Object.fromEntries(
    Object.entries(el.meta).filter(([k]) => k !== "hidden" && !GEOMETRY_META.has(k)),
  );
  return Object.keys(rest).length ? rest : null;
};

export function geometryOnly(looks: SceneElement[][]): boolean {
  const reps = looks.map((l) => l[0]!);
  let ok = true;
  const pair = (nodes: SceneElement[], root: boolean) => {
    if (!ok) return;
    const a = nodes[0]!;
    for (const b of nodes.slice(1)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (CONTENT_KEYS.has(k) || k === "style" || k === "layout") continue;
        const va = (a as unknown as Record<string, unknown>)[k],
          vb = (b as unknown as Record<string, unknown>)[k];
        if (stable(va) === stable(vb)) continue;
        if (!(
          k === "svg" &&
          typeof va === "string" &&
          typeof vb === "string" &&
          svgAtAnySize(va) === svgAtAnySize(vb)
        )) {
          ok = false;
          return;
        }
      }
      // the same layers (the same nested components, shown or hidden alike); below the root, the same editor meta
      // (other than what a capture measured: a text's `narrowedBy` is geometry)
      if (!root && stable(metaBelowRoot(a)) !== stable(metaBelowRoot(b))) {
        ok = false;
        return;
      }
      if (
        (a.meta?.tag ?? "") !== (b.meta?.tag ?? "") ||
        (a.instance?.componentId ?? "") !== (b.instance?.componentId ?? "") ||
        !!a.meta?.hidden !== !!b.meta?.hidden ||
        (a.children?.length ?? 0) !== (b.children?.length ?? 0) ||
        stable(a.instance?.variant ?? null) !== stable(b.instance?.variant ?? null)
      ) {
        ok = false;
        return;
      }
      const sa = a.style ?? {},
        sb = b.style ?? {};
      for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)]) as Set<keyof typeof sa>)
        if (!GEOMETRY_STYLE.has(k) && stable(sa[k]) !== stable(sb[k])) {
          ok = false;
          return;
        }
      if (!root) {
        const la = a.layout ?? {},
          lb = b.layout ?? {};
        for (const k of new Set([...Object.keys(la), ...Object.keys(lb)]) as Set<keyof typeof la>)
          if (!GEOMETRY_LAYOUT.has(k) && stable(la[k]) !== stable(lb[k])) {
            ok = false;
            return;
          }
      }
    }
    a.children?.forEach((_, i) =>
      pair(
        nodes.map((x) => x.children![i]!),
        false,
      ),
    );
  };
  pair(reps, true);
  return ok;
}

/** Box keys whose values follow a layer's copy: a text's measures and place, a frame's height, where a picture sits. */
const FOLLOWS_COPY: Record<"text" | "frame" | "other", ReadonlySet<string>> = {
  text: new Set([
    "width",
    "height",
    "minWidth",
    "maxWidth",
    "x",
    "y",
    "right",
    "bottom",
    "margin",
    "fluid",
    "constraints",
  ]),
  // (a frame's gap: what space-between leaves beside copy of another length)
  frame: new Set([
    "height",
    "minHeight",
    "maxHeight",
    "x",
    "y",
    "right",
    "bottom",
    "fluid",
    "constraints",
    "gap",
    "crossGap",
  ]),
  other: new Set(["x", "y", "right", "bottom", "fluid", "constraints"]),
};
/** Text style a capture sets by how the copy fits (a one-line label kept on its line). */
const COPY_STYLE = new Set(["whiteSpace", "noWrap"]);
/** Box values equal but for a capture's rounding (28.79 vs 28.8). */
const nearly = (a: unknown, b: unknown): boolean => {
  const n = (v: unknown) =>
    typeof v === "number"
      ? [v]
      : Array.isArray(v) && v.every((x) => typeof x === "number")
        ? (v as number[])
        : null;
  const x = n(a),
    y = n(b);
  return x && y
    ? x.length === y.length && x.every((v, i) => Math.abs(v - y[i]!) <= 0.1)
    : stable(a) === stable(b);
};
const styleBesidesCopy = (el: SceneElement) =>
  Object.fromEntries(Object.entries(withoutCrop(el.style) ?? {}).filter(([k]) => !COPY_STYLE.has(k)));
/**
 * Looks of alike items that differ only where their copy differs (a longer title wraps: the text is taller, the card
 * under it too, the arrow moves down): the same design, not looks. Pictures and icons keep their size (a taller photo
 * is another design), type and colours are the same; what an icon draws is content.
 */
export function copyGeometryOnly(reps: SceneElement[]): boolean {
  let ok = true;
  const pair = (nodes: SceneElement[], root: boolean) => {
    if (!ok) return;
    const a = nodes[0]!;
    for (const b of nodes.slice(1)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (CONTENT_KEYS.has(k) || k === "style" || k === "layout" || (!root && k === "svg")) continue;
        if (
          stable((a as unknown as Record<string, unknown>)[k]) !==
          stable((b as unknown as Record<string, unknown>)[k])
        ) {
          ok = false;
          return;
        }
      }
      if (
        a.type !== b.type ||
        (a.meta?.tag ?? "") !== (b.meta?.tag ?? "") ||
        (a.instance?.componentId ?? "") !== (b.instance?.componentId ?? "") ||
        !!a.meta?.hidden !== !!b.meta?.hidden ||
        (a.children?.length ?? 0) !== (b.children?.length ?? 0) ||
        (!root && stable(metaBelowRoot(a)) !== stable(metaBelowRoot(b)))
      ) {
        ok = false;
        return;
      }
      if (stable(styleBesidesCopy(a)) !== stable(styleBesidesCopy(b))) {
        ok = false;
        return;
      }
      if (!root) {
        const free =
          FOLLOWS_COPY[a.type === "text" ? "text" : a.type === "frame" && !a.image ? "frame" : "other"];
        const la = a.layout ?? {},
          lb = b.layout ?? {};
        for (const k of new Set([...Object.keys(la), ...Object.keys(lb)]) as Set<keyof typeof la>)
          if (!free.has(k) && !nearly(la[k], lb[k])) {
            ok = false;
            return;
          }
      }
    }
    a.children?.forEach((_, i) =>
      pair(
        nodes.map((x) => x.children![i]!),
        false,
      ),
    );
  };
  pair(reps, true);
  return ok;
}

/** A tree's markup without its colours (and the root's own box): looks with the same one differ only in colour. */
function shapeSig(el: SceneElement, root: boolean): string {
  const rec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (CONTENT_KEYS.has(k) || v === undefined || (root && k === "layout") || (!root && k === "svg"))
      continue;
    if (k === "style") {
      const st: Record<string, unknown> = { ...(v as object) };
      for (const c of ["background", "color", "fills", "gradient", "objectPosition"]) delete st[c];
      if (st.border) st.border = { ...(st.border as object), color: undefined };
      if (st.borders)
        st.borders = Object.fromEntries(
          Object.entries(st.borders as Record<string, object>).map(([side, b]) => [
            side,
            { ...b, color: undefined },
          ]),
        );
      rec.style = st;
    } else rec[k] = v;
  }
  if (!root && el.meta) {
    const { hidden: _hidden, ...rest } = el.meta;
    if (Object.keys(rest).length) rec.meta = rest;
  }
  return `${stable(rec)}[${(el.children ?? []).map((c) => shapeSig(c, false)).join(",")}]`;
}
/** A tree's colours in reading order (fills, borders, text). */
function colourSig(el: SceneElement): string {
  const out: unknown[] = [];
  const walk = (x: SceneElement) => {
    const st = x.style ?? {};
    out.push([
      st.background ?? null,
      st.color ?? null,
      st.fills ?? null,
      st.gradient ?? null,
      st.border?.color ?? null,
      st.borders ? Object.values(st.borders).map((b) => b?.color ?? null) : null,
    ]);
    x.children?.forEach(walk);
  };
  walk(el);
  return stable(out);
}

/** The colour a look is known by: its fill, else its outline ("outline"), else its first text's colour. */
function toneColour(el: SceneElement): string | null {
  const bg = el.style?.background;
  if (bg && !/^(transparent|none)$/i.test(bg) && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
  if (el.style?.border && el.style.border.width > 0) return "outline";
  let c: string | null = null;
  const walk = (x: SceneElement) => {
    if (c) return;
    if (x.type === "text" && x.style?.color) c = x.style.color;
    else x.children?.forEach(walk);
  };
  walk(el);
  return c;
}
const HUES = [
  "red",
  "orange",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "sky",
  "blue",
  "violet",
  "purple",
  "pink",
];
/** A tone's word: its hue (pale colours too), else light / grey / dark; with `fine`, lightness in front of the hue. */
function toneWord(c: string, fine = false): string | null {
  if (c === "outline") return "outline";
  const m = c.match(/^#([0-9a-f]{6})/i);
  const rgb = m
    ? [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16))
    : (c
        .match(/rgba?\(([^)]+)\)/)?.[1]
        ?.split(",")
        .slice(0, 3)
        .map((x) => parseFloat(x)) ?? null);
  if (!rgb || rgb.some((x) => Number.isNaN(x))) return null;
  const [r, g, b] = rgb as [number, number, number];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max - min < 12) return max > 200 ? "light" : max < 80 ? "dark" : "grey";
  const h =
    (max === r
      ? ((g - b) / (max - min) + 6) % 6
      : max === g
        ? (b - r) / (max - min) + 2
        : (r - g) / (max - min) + 4) * 60;
  const hue = HUES[Math.round(h / 30) % 12]!;
  const l = (max + min) / 2;
  return fine ? `${l > 190 ? "light" : l < 90 ? "dark" : "mid"}-${hue}` : hue;
}
/** Unique tone words for looks (null: two of them read the same). */
function toneWords(reps: SceneElement[]): string[] | null {
  for (const fine of [false, true]) {
    const words = reps.map((r) => {
      const c = toneColour(r);
      return c ? toneWord(c, fine) : null;
    });
    if (words.every(Boolean) && new Set(words).size === words.length) return words as string[];
  }
  return null;
}

const TONE_STYLE = new Set(["background", "color", "fills", "gradient", "opacity"]);
const SIZE_STYLE = new Set(["fontSize", "lineHeight", "lineHeightPx", "letterSpacing", "radius"]);
const SIZE_LAYOUT = new Set([
  "width",
  "height",
  "padding",
  "gap",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "margin",
  "x",
  "y",
  "right",
  "bottom",
  "fluid",
  "crossGap",
  "grow",
  "aspectRatio",
]);
const SIZE_NAMES: Record<number, string[]> = {
  2: ["sm", "md"],
  3: ["sm", "md", "lg"],
  4: ["xs", "sm", "md", "lg"],
  5: ["xs", "sm", "md", "lg", "xl"],
};

/**
 * Looks of one part (same layers, same markup) that differ only in colour (→ a `tone` axis: "red", "light") or only in
 * size (→ a `size` axis: "sm", "md", by area): one set with those variants. Anything else (another radius with the
 * same size, other shadows, another layout, another icon) is another component: null.
 */
export function lookAxis(looks: SceneElement[][]): LookAxis | null {
  if (looks.length < 2 || looks.length > 5) return null;
  const firsts = looks.map((l) => l[0]!);
  let tone = false,
    size = false,
    other = false;
  // the first colour that tells the looks apart (root first, then reading order)
  let toneOf: string[] | null = null;
  const pair = (nodes: SceneElement[], root: boolean) => {
    const a = nodes[0]!;
    for (const b of nodes.slice(1)) {
      // own keys other than style / layout (svg of the root, a button's variant), the HTML element
      if ((a.meta?.tag ?? "") !== (b.meta?.tag ?? "")) other = true;
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (
          [
            "id",
            "name",
            "text",
            "runs",
            "icon",
            "image",
            "placeholder",
            "value",
            "interaction",
            "children",
            "meta",
            "instance",
            "style",
            "layout",
          ].includes(k)
        )
          continue;
        const va = (a as unknown as Record<string, unknown>)[k],
          vb = (b as unknown as Record<string, unknown>)[k];
        if (stable(va) === stable(vb)) continue;
        // the same drawing at another size
        if (k === "svg" && typeof va === "string" && typeof vb === "string" && svgSame(va) === svgSame(vb))
          continue;
        if (
          k === "svg" &&
          typeof va === "string" &&
          typeof vb === "string" &&
          svgAtAnySize(va) === svgAtAnySize(vb)
        )
          size = true;
        else other = true;
      }
      const sa = a.style ?? {},
        sb = b.style ?? {};
      for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)]) as Set<keyof typeof sa>) {
        const va = sa[k],
          vb = sb[k];
        if (stable(va) === stable(vb) || k === "objectPosition") continue;
        if (k === "border") {
          const ba = (va ?? {}) as { width?: number; color?: string; style?: string },
            bb = (vb ?? {}) as typeof ba;
          if (ba.color !== bb.color) {
            tone = true;
            toneOf ??= nodes.map((x) => x.style?.border?.color ?? "");
          }
          if (ba.width !== bb.width) size = true;
          if (ba.style !== bb.style) other = true;
        } else if (TONE_STYLE.has(k)) {
          tone = true;
          if (k === "background" || k === "color") toneOf ??= nodes.map((x) => String(x.style?.[k] ?? ""));
        } else if (SIZE_STYLE.has(k)) size = true;
        else other = true;
      }
      // (the root's box is the instance's own: a tag as wide as its label)
      const la = root ? {} : (a.layout ?? {}),
        lb = root ? {} : (b.layout ?? {});
      for (const k of new Set([...Object.keys(la), ...Object.keys(lb)]) as Set<keyof typeof la>) {
        if (stable(la[k]) === stable(lb[k])) continue;
        if (SIZE_LAYOUT.has(k)) size = true;
        else other = true;
      }
    }
    a.children?.forEach((_, i) =>
      pair(
        nodes.map((x) => x.children![i]!),
        false,
      ),
    );
  };
  pair(firsts, true);
  if (other || tone === size) return null;
  if (tone) {
    const words =
      toneWords(firsts) ??
      (() => {
        const w = (toneOf ?? []).map((c) => (c ? colorWord(c) : null));
        return w.every(Boolean) && new Set(w).size === w.length ? (w as string[]) : null;
      })();
    return words ? { name: "tone", values: words } : null;
  }
  // sizes by their first text's size, else the root's box, smallest first
  const area = (el: SceneElement) =>
    typeof el.layout?.width === "number" && typeof el.layout?.height === "number"
      ? el.layout.width * el.layout.height
      : 0;
  const font = (el: SceneElement): number =>
    el.style?.fontSize ?? (el.children ?? []).map(font).find((x) => x > 0) ?? 0;
  const measure = firsts.map((el) => font(el) || area(el));
  if (new Set(measure).size !== measure.length || measure.some((m) => !m)) return null;
  const order = [...measure].sort((x, y) => x - y);
  const names = SIZE_NAMES[looks.length]!;
  return { name: "size", values: measure.map((m) => names[order.indexOf(m)]!) };
}

/** What an instance carries per copy (captured as overrides); everything else must match for copies to be one part. */
// `runs` is a text's copy too (links, footnote marks): copies that only differ in it are one part
const CONTENT_KEYS = new Set([
  "id",
  "name",
  "text",
  "runs",
  "icon",
  "image",
  "placeholder",
  "value",
  "interaction",
  "children",
  "meta",
]);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** JSON with sorted object keys (copies made by different tools list keys in different orders). */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/**
 * An element's own part of a key: as a component's root its size / place are the instance's; `loose` ignores looks.
 * Below the root an inline SVG is content (the icon a button shows): buttons that only differ in it are one part.
 */
function ownKey(el: SceneElement, root: boolean, loose: boolean): string {
  const rec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (CONTENT_KEYS.has(k) || v === undefined) continue;
    if (loose && (k === "style" || k === "layout")) continue;
    if (root && k === "layout") continue;
    if (!root && k === "svg") continue;
    // an icon's drawing at another size is the same part (its looks: the sizes)
    rec[k] =
      k === "svg"
        ? loose
          ? svgAtAnySize(v as string)
          : svgSame(v as string)
        : k === "style"
          ? withoutCrop(v as SceneElement["style"])
          : v;
  }
  // descendants: editor meta other than visibility is not an override (an instance root keeps its own); what a capture
  // measured (`narrowedBy`) is geometry: a look's, not the part's
  if (!root && el.meta) {
    const rest = loose
      ? metaBelowRoot(el)
      : (({ hidden: _hidden, ...r }) => (Object.keys(r).length ? r : null))(el.meta);
    if (rest) rec.meta = rest;
  }
  // a text's runs are its copy, but whether (and where) it holds a link is its markup: a linked heading and a plain one
  // are different parts (an export draws an <a> for one of them)
  if (el.runs?.length)
    rec.runs = el.runs.map((r) => {
      const { text: _t, href, ...look } = r as typeof r & { href?: string };
      return { ...look, ...(href ? { link: 1 } : {}) };
    });
  return stable(rec);
}

/** Kinds that are lists themselves: their bare entries are items too (repeatedItems `list`, as catalog.ts reads them). */
const ITEM_LIST_KINDS = new Set<SceneComponentKind>([
  "list",
  "navigation",
  "menu",
  "breadcrumb",
  "pagination",
  "tabs",
]);
/** Kinds whose own copy (and main picture) become props even when all copies read the same (deriveProperties promote). */
const CONTENT_PROP_KINDS = new Set<SceneComponentKind>([
  "button",
  "link",
  "badge",
  "tag",
  "card",
  "teaser",
  "list-item",
  "stat",
  "quote",
  "alert",
]);
const isMain = (el: SceneElement) => el.meta?.componentMain === true;
const isControl = (el: SceneElement) => el.type === "button" && !!el.text?.trim();

interface Info {
  root: string | null;
  strict: string | null;
  loose: string | null;
  size: number;
  parent: SceneElement | null;
  index: number;
  rank: number;
  tree: SceneElement;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A page section found on one screen. */
interface SectionCopy {
  el: SceneElement;
  screen: number;
  box: Box;
  kind: SceneComponentKind;
  words: Set<string>;
  own: string;
  index: number;
  count: number;
  over: boolean;
}
/**
 * One section of a page across its breakpoints (its copies, smallest breakpoint first). `layer`: the name its layer
 * gives it; `heading`: its heading (page copy: a qualifier only); `title`: what the parts inside are told apart by.
 */
interface SectionIdentity {
  copies: SectionCopy[];
  page: string;
  overlay: boolean;
  title: string | null;
  layer: string | null;
  heading: string | null;
}
/** Sections alike enough to be one set (a row of teasers, six card sections), and how near a lone one came to another. */
interface SectionCluster {
  ids: SectionIdentity[];
  nearest: number;
}
/** Sections at least this alike (treeMatcher similarity at every breakpoint) are one set; the rest are content differences. */
const SECTION_MERGE = 0.85;

export function extractComponents(
  input: ExtractScreen[],
  ds: SceneDesignSystem,
  o: ExtractOptions,
): ExtractResult {
  let cur = input;
  let curDs = ds;
  const screens = new Map<string, SceneScreen>();
  const components: ExtractedComponent[] = [];
  // the capture's own CSS-class prefixes ("Cds card content"): a layer name made of one is no name
  const names: string[] = [];
  const collect = (el: SceneElement) => {
    if (el.name) names.push(el.name);
    el.children?.forEach(collect);
  };
  input.forEach((s) => collect(s.screen.root));
  const prefixes = classPrefixes(names);
  // another pass takes what this one could not (copies of a part counted inside a bigger part that then did not
  // convert): one call leaves nothing for the next one to find
  for (let round = 0; round < 3; round++) {
    const r = extractOnce(cur, curDs, o, prefixes);
    if (!r.components.length) break;
    components.push(...r.components);
    for (const [k, v] of r.screens) screens.set(k, v);
    curDs = r.ds;
    cur = cur.map((s) => ({ nodeId: s.nodeId, screen: screens.get(s.nodeId) ?? s.screen }));
  }
  return { ds: curDs, screens, components };
}

function extractOnce(
  input: ExtractScreen[],
  ds: SceneDesignSystem,
  o: ExtractOptions,
  prefixes: ReadonlySet<string>,
): ExtractResult {
  const min = o.min ?? 2;
  const props = o.props !== false;
  // work on copies: copies are turned into instances in place, so the parts found keep pointing at them
  const screens = input.map((s) => ({
    nodeId: s.nodeId,
    screen: { ...s.screen, root: clone(s.screen.root) },
  }));
  const info = new Map<SceneElement, Info>();
  const interned = new Map<string, string>();
  const intern = (k: string) => {
    let id = interned.get(k);
    if (id === undefined) {
      id = `#${interned.size}`;
      interned.set(k, id);
    }
    return id;
  };

  type Keys = { strict: string | null; loose: string | null; size: number };
  const keyOf = (
    el: SceneElement,
    parent: SceneElement | null,
    index: number,
    rank: number,
    tree: SceneElement,
    inside = false,
  ): Keys => {
    // existing instances and mains stay what they are: nothing in them or around them becomes a part
    const own = !!el.instance || isMain(el);
    let poisoned = own || inside;
    let size = 1;
    const strict: string[] = [],
      loose: string[] = [];
    el.children?.forEach((c, i) => {
      const k = keyOf(c, el, i, rank, tree, inside || own);
      if (k.strict === null) poisoned = true;
      size += k.size;
      strict.push(k.strict ?? "");
      loose.push(k.loose ?? "");
    });
    if (poisoned) {
      info.set(el, { root: null, strict: null, loose: null, size, parent, index, rank, tree });
      return { strict: null, loose: null, size };
    }
    const rootStrict = intern(`${ownKey(el, true, false)}[${strict.join(",")}]`);
    const rootLoose = intern(`${ownKey(el, true, true)}[${loose.join(",")}]`);
    info.set(el, { root: rootStrict, strict: rootStrict, loose: rootLoose, size, parent, index, rank, tree });
    return {
      strict: intern(`${ownKey(el, false, false)}[${strict.join(",")}]`),
      loose: intern(`${ownKey(el, false, true)}[${loose.join(",")}]`),
      size,
    };
  };
  const hostOf = (s: SceneScreen) =>
    typeof s.root.meta?.overlayOf === "string"
      ? screens.find((x) => x.screen.id === s.root.meta!.overlayOf)?.screen
      : undefined;
  // a screen's breakpoint: its own, else (a menu overlay) the one of the page it opens over — never the smallest
  const rankOf_ = (s: SceneScreen): number => {
    if (s.responsive) return Number(s.responsive.minWidth) || 0;
    return Number(hostOf(s)?.responsive?.minWidth) || 0;
  };
  for (const s of screens) keyOf(s.screen.root, null, -1, rankOf_(s.screen), s.screen.root);

  const order = new Map<SceneElement, number>();
  let seq = 0;
  const number = (el: SceneElement) => {
    order.set(el, seq++);
    el.children?.forEach(number);
  };
  screens.forEach((s) => number(s.screen.root));

  // where everything sits on its page (a rough layout: enough to tell top from bottom and wide from narrow)
  const boxes = new Map<SceneElement, Box>();
  const pageOf = new Map<SceneElement, number>();
  screens.forEach((s, i) => {
    layoutBoxes(s.screen.root, s.screen.width, boxes);
    const mark = (el: SceneElement) => {
      pageOf.set(el, i);
      el.children?.forEach(mark);
    };
    mark(s.screen.root);
  });
  const boxOf = (el: SceneElement): Box => boxes.get(el) ?? { x: 0, y: 0, w: 0, h: 0 };
  const pageHeight = (i: number) => Math.max(screens[i]!.screen.height, boxOf(screens[i]!.screen.root).h, 1);
  const viewportOf = (i: number) =>
    Number(
      screens[i]!.screen.root.meta?.viewportHeight ?? hostOf(screens[i]!.screen)?.root.meta?.viewportHeight,
    ) || Math.min(1000, screens[i]!.screen.height);

  const ranks = [...new Set(screens.map((s) => rankOf_(s.screen)))].sort((a, b) => a - b);
  const labels = new Map(
    ranks.map((r, i) => [r, (BREAKPOINTS[ranks.length] ?? moreBreakpointNames(ranks.length))[i]!]),
  );

  /* ---------------------------------------------------------------- sections */

  const wrapperCache = new Map<SceneElement, "stack" | "pass" | null>();
  const kindOfIdentity = (id: SectionIdentity): SceneComponentKind => {
    const n = new Map<SceneComponentKind, number>();
    for (const c of id.copies) n.set(c.kind, (n.get(c.kind) ?? 0) + 1);
    const best = Math.max(...n.values());
    // a tie: the biggest breakpoint's view (the desktop header shows what the mobile one hides)
    return [...id.copies].reverse().find((c) => n.get(c.kind) === best)!.kind;
  };
  const found = o.sections ? findSections() : [];
  // alike sections are one set: decided on the captured trees, before repeated parts change them
  const allClusters = found.length ? mergeIdentities(found) : [];
  // alike blocks side by side in one parent, found at one width of a page captured at several (a grid of cards that
  // the phone stacks full width): the items of a grid — a repeated part, not sections; the grid is the section
  const pageRanks = new Map<string, Set<number>>();
  for (const id of found)
    for (const c of id.copies) {
      const r = pageRanks.get(id.page) ?? new Set<number>();
      r.add(rankOf_(screens[c.screen]!.screen));
      pageRanks.set(id.page, r);
    }
  const soleWrapped = (el: SceneElement) => {
    let x = el;
    for (
      let p = info.get(x)?.parent;
      p && p.children?.length === 1 && info.get(p)?.parent;
      p = info.get(p)?.parent
    )
      x = p;
    return info.get(x)?.parent ?? null;
  };
  const gridItemIds = new Set<SectionIdentity>();
  for (const cl of allClusters) {
    if (
      cl.ids.length < 2 ||
      new Set(cl.ids.map((id) => id.page)).size !== 1 ||
      (pageRanks.get(cl.ids[0]!.page)?.size ?? 0) < 2
    )
      continue;
    if (!cl.ids.every((id) => new Set(id.copies.map((c) => rankOf_(screens[c.screen]!.screen))).size === 1))
      continue;
    const parents = new Set(cl.ids.flatMap((id) => id.copies.map((c) => soleWrapped(c.el))));
    if (parents.size === 1 && !parents.has(null)) cl.ids.forEach((id) => gridItemIds.add(id));
  }
  const identities = found.filter((id) => !gridItemIds.has(id));
  let clusters = allClusters.filter((cl) => !cl.ids.some((id) => gridItemIds.has(id)));
  // section copies (and the wrappers around them) are converted as sections, never as repeated parts
  const excluded = new Set<SceneElement>();
  const sectionOf = new Map<SceneElement, SectionIdentity>();
  for (const id of identities) {
    for (const c of id.copies) {
      for (let x: SceneElement | null = c.el; x; x = info.get(x)?.parent ?? null) excluded.add(x);
      const mark = (el: SceneElement) => {
        sectionOf.set(el, id);
        el.children?.forEach(mark);
      };
      mark(c.el);
    }
  }
  // a card stack: alike sibling sections of one page (one set) hold alike items — the layers inside them are items
  // first (a part even when the items differ only in geometry: a longer title, a taller picture), so the section's main
  // holds item instances and the sections differ only in how many
  const inStack = new Set<SceneElement>();
  for (const cl of clusters) {
    const pages = new Map<string, number>();
    for (const id of cl.ids) pages.set(id.page, (pages.get(id.page) ?? 0) + 1);
    for (const id of cl.ids) {
      if ((pages.get(id.page) ?? 0) < 2) continue;
      const mark = (el: SceneElement) =>
        el.children?.forEach((c) => {
          inStack.add(c);
          mark(c);
        });
      id.copies.forEach((c) => mark(c.el));
    }
  }
  const stacked = new Set<SceneElement[]>();
  /** The page section a layer sits in, else what its ancestors' tags say (a header, a footer, a nav). */
  const withinOf = (el: SceneElement): SceneComponentKind | undefined => {
    const id = sectionOf.get(el);
    if (id) return kindOfIdentity(id);
    for (let x = info.get(el)?.parent ?? null; x; x = info.get(x)?.parent ?? null) {
      const tag = x.meta?.tag;
      if (tag === "header") return "header";
      if (tag === "footer") return "footer";
      if (tag === "nav") return "navigation";
    }
    return undefined;
  };

  /* ---------------------------------------------------------------- repeated parts */

  // candidates: same structure (loose), screen roots and whole page sections excluded
  const groups = new Map<string, SceneElement[]>();
  for (const [el, i] of info) {
    if (i.loose === null || !i.parent || excluded.has(el)) continue;
    if (!(i.size >= 2 || el.svg || isControl(el))) continue;
    if (i.size > Math.max(40, info.get(i.tree)!.size / 4)) continue;
    const g = groups.get(i.loose);
    if (g) g.push(el);
    else groups.set(i.loose, [el]);
  }
  /**
   * Looks of the items of a grid — every copy has an alike sibling — merged where they differ only where their copy
   * does (copyGeometryOnly): when that leaves one look, or one per breakpoint, those are the part's looks; else null.
   */
  const gridLooks = (g: SceneElement[], looks: SceneElement[][]): SceneElement[][] | null => {
    if (!gridItems(g)) return null;
    const ranksKey = (l: SceneElement[]) => [...new Set(l.map(rankOf))].sort((a, b) => a - b).join();
    const fams: SceneElement[][][] = [];
    for (const l of looks) {
      const f = fams.find((x) => ranksKey(x[0]!) === ranksKey(l) && copyGeometryOnly([x[0]![0]!, l[0]!]));
      if (f) f.push(l);
      else fams.push([l]);
    }
    if (fams.length === looks.length) return null;
    const merged = fams.map((f) => f.flat());
    return lookAxes(merged) ? merged : null;
  };
  const preset = new Map<SceneElement[], SceneElement[][]>();
  /** The item a layer is: itself, or the frame it is the only layer of (a tile around its card content). */
  const itemOf = (el: SceneElement) => {
    let x = el;
    for (
      let p = info.get(x)?.parent;
      p && p.children?.length === 1 && info.get(p)?.parent;
      p = info.get(p)?.parent
    )
      x = p;
    return x;
  };
  /** Every copy is (in) an item with an alike sibling: the cards of a grid, the entries of a list. */
  const gridItems = (g: SceneElement[]) => {
    const items = new Map(g.map((el) => [el, itemOf(el)]));
    const parents = new Map<SceneElement | null, number>();
    for (const it of items.values()) {
      const p = info.get(it)?.parent ?? null;
      parents.set(p, (parents.get(p) ?? 0) + 1);
    }
    return [...items.values()].every((it) => (parents.get(info.get(it)?.parent ?? null) ?? 0) >= 2);
  };
  const looksOf = (g: SceneElement[]) => {
    const m = new Map<string, SceneElement[]>();
    for (const el of g) {
      const k = info.get(el)!.root!;
      m.set(k, [...(m.get(k) ?? []), el]);
    }
    return [...m.values()];
  };
  const rankOf = (el: SceneElement) => info.get(el)!.rank;
  // looks are breakpoints: each look shows at breakpoints of its own (the same layers laid out otherwise at other
  // widths: one part, however many boxes move — an export draws its looks as one markup with per-width geometry)
  const breakpointLooks = (looks: SceneElement[][]) => {
    const seen = new Set<number>();
    for (const l of looks)
      for (const r of new Set(l.map(rankOf))) {
        if (seen.has(r)) return false;
        seen.add(r);
      }
    return true;
  };
  /**
   * Looks that differ in colour AND in their layout (a line badge in green, violet and outlined, each smaller on the
   * phone): a `tone` axis by colour and a `breakpoint` axis (each layout at breakpoints of its own) or a `size` axis.
   */
  const toneAndShape = (looks: SceneElement[][]): LookAxes | null => {
    if (looks.length < 3) return null;
    const reps = looks.map((l) => l[0]!);
    const shapeKeys = reps.map((r) => shapeSig(r, true)),
      toneKeys = reps.map(colourSig);
    const shapes = [...new Set(shapeKeys)],
      tones = [...new Set(toneKeys)];
    if (shapes.length < 2 || tones.length < 2 || shapes.length > 6 || tones.length > 8) return null;
    const ranks = shapes.map(
      (sk) => new Set(looks.filter((_, i) => shapeKeys[i] === sk).flatMap((l) => l.map(rankOf))),
    );
    const disjoint = ranks.every((a, i) => ranks.every((b, j) => j <= i || [...a].every((x) => !b.has(x))));
    let shapeValues: string[];
    if (disjoint) shapeValues = shapes.map((_, i) => labels.get(Math.min(...ranks[i]!))!);
    else {
      // the layouts differ only in size (compared without their colours)
      const plain = (el: SceneElement): SceneElement => ({
        ...el,
        style: el.style
          ? {
              ...el.style,
              background: undefined,
              color: undefined,
              fills: undefined,
              gradient: undefined,
              border: el.style.border ? { ...el.style.border, color: "" } : undefined,
            }
          : undefined,
        children: el.children?.map(plain),
      });
      const size = lookAxis(shapes.map((sk) => [plain(reps[shapeKeys.indexOf(sk)]!)]));
      if (size?.name !== "size") return null;
      shapeValues = size.values;
    }
    const words = toneWords(tones.map((tk) => reps[toneKeys.indexOf(tk)]!));
    if (!words || new Set(shapeValues).size !== shapes.length) return null;
    return [
      { name: "tone", values: toneKeys.map((tk) => words[tones.indexOf(tk)]!) },
      {
        name: disjoint ? BREAKPOINT_AXIS : "size",
        values: shapeKeys.map((sk) => shapeValues[shapes.indexOf(sk)]!),
      },
    ];
  };
  /** The axes of a part's looks: none (one look), the breakpoints, a tone or a size, or a tone and a layout axis. */
  const lookAxes = (looks: SceneElement[][]): LookAxes | null => {
    if (looks.length === 1) return [];
    if (breakpointLooks(looks))
      return [{ name: BREAKPOINT_AXIS, values: looks.map((l) => labels.get(Math.min(...l.map(rankOf)))!) }];
    const one = lookAxis(looks);
    return one ? [one] : toneAndShape(looks);
  };

  const candidates = [...groups.values()]
    .filter((g) => g.length >= min)
    .flatMap((g) => {
      const looks = looksOf(g);
      // one look, a look per breakpoint, or looks that differ only in colour or only in size (a tag in red and in grey,
      // a line badge in two sizes): one set, its looks are variants
      if (lookAxes(looks)) return [g];
      // the items of a card stack whose looks differ only in geometry: one design, each copy keeps its geometry
      if (g.every((el) => inStack.has(el)) && geometryOnly(looks)) {
        stacked.add(g);
        return [g];
      }
      // the items of a grid (alike siblings) whose looks differ only where their copy does: one look per breakpoint
      const items = gridLooks(g, looks);
      if (items) {
        preset.set(g, items);
        return [g];
      }
      // else families of looks that are one set's tones / sizes (a red and a grey tag; the date badge of the same
      // structure is another set); looks repeated often enough are sets of their own; the one-off looks left over may
      // still be one part at several breakpoints (else a second run, with the others now instances, would find it)
      const fams: SceneElement[][][] = [];
      for (const l of [...looks].sort((a, b) => b.length - a.length)) {
        // (a look shown at breakpoints of its own joins the family it continues: the same part at other widths)
        const f = fams.find(
          (x) => lookAxis([...x, l]) || toneAndShape([...x, l]) || breakpointLooks([...x, l]),
        );
        if (f) f.push(l);
        else fams.push([l]);
      }
      const rest = fams.filter((f) => f.length === 1 && f[0]!.length < min).map((f) => f[0]!);
      return [
        ...fams.filter((f) => f.length > 1 || f[0]!.length >= min).map((f) => f.flat()),
        ...(rest.length > 1 && breakpointLooks(rest) ? [rest.flat()] : []),
      ];
    });
  // the items of one grid at other widths (another markup there: other groups) are one part with a look per breakpoint
  // — the same item, by its name and place, alike in its layers however laid out there (desktop's row of icons, the
  // phone's placed ones; a layer the desktop leaves out)
  {
    const tm = treeMatcher(true, undefined, false);
    const slot = (el: SceneElement) => {
      const it = itemOf(el);
      return `${ownName(el)}<${ownName(info.get(it)?.parent ?? it)}`;
    };
    const ranksOf = (g: SceneElement[]) => new Set(g.map(rankOf));
    const lookCount = (g: SceneElement[]) => (preset.get(g) ?? looksOf(g)).length;
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i]!;
      if (!gridItems(a) || lookCount(a) !== ranksOf(a).size) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j]!;
        const ra = ranksOf(a);
        if (!gridItems(b) || lookCount(b) !== ranksOf(b).size || [...ranksOf(b)].some((r) => ra.has(r)))
          continue;
        if (new Set([...a, ...b].map(slot)).size !== 1 || tm.similarity(a[0]!, b[0]!) < SECTION_MERGE)
          continue;
        const looks = [...(preset.get(a) ?? looksOf(a)), ...(preset.get(b) ?? looksOf(b))];
        if (!breakpointLooks(looks)) continue;
        a.push(...b);
        preset.set(a, looks);
        candidates.splice(j--, 1);
      }
    }
  }
  // a layer that is all of an item's content (the card content in each tile) is the item: one set, not two nested
  {
    const groupOf = new Map<SceneElement, SceneElement[]>();
    for (const g of candidates) for (const el of g) groupOf.set(el, g);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const g = candidates[i]!;
      const outer = g.map((el) => {
        const p = info.get(el)?.parent;
        return p && p.children?.length === 1 ? groupOf.get(p) : undefined;
      });
      if (outer[0] && outer[0] !== g && outer.every((x) => x === outer[0]) && outer[0].length === g.length)
        candidates.splice(i, 1);
    }
  }
  candidates.sort((a, b) => info.get(b[0]!)!.size - info.get(a[0]!)!.size || b.length - a.length);

  // biggest first: a part counts when its copies sit in at least `min` places of the result (copies at the same spot
  // of a bigger part are one: they live in its main — unless the bigger part's copies show different things there, the
  // icon of a menu row: then each is a place of its own, and the row swaps between the sets)
  type Part = {
    copies: SceneElement[];
    looks: SceneElement[][];
    size: number;
    kind: SceneComponentKind;
    within?: SceneComponentKind;
    sectionTitle?: string | null;
    axes: LookAxes;
  };
  const partOf = new Map<SceneElement, Part>();
  const parts: Part[] = [];
  const pathFrom = (anc: SceneElement, el: SceneElement) => {
    const p: number[] = [];
    for (let x: SceneElement | null = el; x && x !== anc; x = info.get(x)!.parent)
      p.unshift(info.get(x)!.index);
    return p;
  };
  const nearest = (el: SceneElement) => {
    for (let x = info.get(el)!.parent; x; x = info.get(x)!.parent) if (partOf.has(x)) return x;
    return null;
  };
  for (const g of candidates) {
    const spots = new Set(
      g.map((el) => {
        const a = nearest(el);
        if (!a) return `own:${order.get(el)}`;
        const p = partOf.get(a)!,
          path = pathFrom(a, el);
        const there = new Set(
          p.copies.map((c) => {
            let x: SceneElement | undefined = c;
            for (const i of path) x = x?.children?.[i];
            return x ? (info.get(x)?.root ?? "?") : "?";
          }),
        );
        return there.size > 1 ? `own:${order.get(el)}` : `${parts.indexOf(p)}:${path.join(".")}`;
      }),
    );
    if (spots.size < min) continue;
    const copies = [...g].sort((a, b) => order.get(a)! - order.get(b)!);
    const looks = (
      preset.get(g)?.map((l) => [...l].sort((a, b) => order.get(a)! - order.get(b)!)) ?? looksOf(copies)
    ).sort(
      (a, b) =>
        Math.min(...a.map(rankOf)) - Math.min(...b.map(rankOf)) || order.get(a[0]!)! - order.get(b[0]!)!,
    );
    const first = copies[0]!;
    const page = pageOf.get(first)!;
    const box = boxOf(first);
    // where the copies sit: the page section (and its kind) they all share, else the first one's
    const withins = new Set(copies.map(withinOf));
    const within = withinOf(first);
    const homes = new Set(copies.map((el) => sectionOf.get(el)?.title ?? null));
    const ctx: ClassifyContext = {
      within,
      size: { w: box.w, h: box.h },
      widthShare: box.w / Math.max(1, screens[page]!.screen.width),
      atTop: within === "header" || box.y < pageHeight(page) * 0.08,
      atBottom: within === "footer" || box.y + box.h > pageHeight(page) * 0.92,
    };
    // (a group of leftover one-off looks: one look per breakpoint)
    let axes =
      lookAxes(looks) ??
      (stacked.has(g)
        ? []
        : [{ name: BREAKPOINT_AXIS, values: looks.map((l) => labels.get(Math.min(...l.map(rankOf)))!) }]);
    // breakpoint looks that are only the geometry of other widths: one design, no variants (each copy keeps its geometry)
    const collapse =
      (axes.length === 1 && axes[0]!.name === BREAKPOINT_AXIS && geometryOnly(looks)) ||
      (stacked.has(g) && !axes.length && looks.length > 1);
    if (collapse) axes = [];
    const part: Part = {
      copies,
      looks: collapse ? [copies] : looks,
      size: info.get(g[0]!)!.size,
      kind: classifyTree(first, ctx),
      within: withins.size === 1 ? within : undefined,
      sectionTitle: homes.size === 1 ? [...homes][0] : null,
      axes,
    };
    parts.push(part);
    for (const el of copies) partOf.set(el, part);
  }

  const taken = new Set((ds.componentSets ?? []).map((d) => d.name));
  const { names, clash: partClash } = nameParts(parts, (el) => info.get(el)?.parent ?? null, taken, prefixes);
  let next = ds;
  const made: ExtractedComponent[] = [];
  const touched = new Set<SceneElement>();

  /** Copies → instances of `def` (one variant key per copy); with properties derived when that converts as many. */
  const convert = (
    def: SceneComponentDef,
    prepared: Array<{ el: SceneElement; key: string }>,
    promote: boolean,
  ) => {
    const multi = !!def.variantAxes;
    const linked = prepared.map(({ el, key }) => {
      // (a section's copy may hold layers its main does not, one more card: they keep their ids and become additions)
      const main = def.variants[key]!;
      const copy = (sameLayers(el, main) ? reId : reIdAligned)(
        el,
        main,
        (m) => derivedId(el.id, m.id),
        el.id,
      );
      copy.instance = { componentId: def.id, ...(multi ? { variant: parseVariantKey(key) } : {}) };
      return { el, copy };
    });
    const attempt = (d: SceneComponentDef) => {
      const trial = withDef(next, d);
      const converted: Array<{ el: SceneElement; inst: SceneElement }> = [];
      for (const { el, copy } of linked) {
        let inst = buildInstance(captureInstance(copy, trial), trial);
        // (measured meta a copy has of its own: overrides of their own, which capture leaves out)
        if (!sameTree(inst, copy)) {
          const withMeta = metaOverrides(captureInstance(copy, trial), copy, trial);
          if (withMeta) inst = buildInstance(withMeta, trial);
        }
        if (sameTree(inst, copy)) converted.push({ el, inst });
      }
      return { def: d, trial, converted };
    };
    let best = attempt(def);
    if (props) {
      const properties = deriveProperties(
        def,
        best.trial,
        linked.map((x) => x.copy),
        promote,
      );
      if (properties.length) {
        const withProps = attempt({ ...def, properties });
        if (withProps.converted.length >= best.converted.length) best = withProps;
      }
    }
    return best;
  };

  // smallest first: the button's set exists (and its copies are instances) before the card's main is taken
  for (const part of [...parts].sort((a, b) => a.size - b.size)) {
    const id = o.newId();
    const multi = part.looks.length > 1;
    // the looks' axes (lookAxes): their breakpoints, colour, size
    const keyOfLook = (l: SceneElement[]) =>
      multi ? part.axes.map((a) => `${a.name}=${a.values[part.looks.indexOf(l)]}`).join(",") : "default";
    const axisValues = (a: LookAxes[number]) => {
      const vals = [...new Set(a.values)];
      // breakpoints smallest first
      return a.name === BREAKPOINT_AXIS
        ? vals.sort((x, y) => [...labels.values()].indexOf(x) - [...labels.values()].indexOf(y))
        : vals;
    };
    // every look's main shares the first look's layer ids, so overrides carry over between variants
    const base = mainTree(part.looks[0]![0]!);
    const variants: Record<string, SceneElement> = {};
    // (looks of other markup at other widths, one grid's items: their layers align by structure, the rest are their own)
    const usedIds = new Set(idsOf(base));
    const fresh = (old: string) => {
      let n = `v-${old}`;
      for (let i = 2; usedIds.has(n); i++) n = `v-${old}-${i}`;
      usedIds.add(n);
      return n;
    };
    for (const l of part.looks) {
      const t = mainTree(l[0]!);
      variants[keyOfLook(l)] = sameLayers(t, base) ? reId(t, base, (m) => m.id) : alignIds(t, base, fresh);
    }
    const nameClash = partClash.get(part);
    const def: ExtractedDef = {
      id,
      name: names.get(part)!,
      kind: part.kind,
      category: KIND_CATEGORY[part.kind],
      origin: "extracted",
      variants,
      defaultVariant: keyOfLook(part.looks[0]!),
      ...(multi ? { variantAxes: Object.fromEntries(part.axes.map((a) => [a.name, axisValues(a)])) } : {}),
      ...previewWidthsOf(part.looks.map((l) => [keyOfLook(l), l[0]!] as const)),
      ...(nameClash ? { extraction: { nameClash } } : {}),
    };
    // content parts (a button's label, a card's title / text / picture) get their copy as props even when every copy
    // reads the same: a page built from the system sets them
    const r = convert(
      def,
      part.looks.flatMap((l) => l.map((el) => ({ el, key: keyOfLook(l) }))),
      CONTENT_PROP_KINDS.has(part.kind),
    );
    if (r.converted.length < min) continue;
    taken.add(def.name);
    next = r.trial;
    for (const { el, inst } of r.converted) {
      replaceInPlace(el, inst);
      touched.add(el);
    }
    made.push({
      id,
      name: def.name,
      instances: r.converted.length,
      variants: Object.keys(variants),
      kind: part.kind,
      ...clashFlags(def.name, nameClash),
    });
  }

  /* ---------------------------------------------------------------- sections → sets */

  // grid items that did not become a part stay sections (this round, as before: nothing is left for a later one)
  clusters = allClusters.flatMap((cl) => {
    if (!cl.ids.some((id) => gridItemIds.has(id))) return [cl];
    // (a copy inside an item that became an instance — the card content of a tile — is part of it)
    const inPart = (el: SceneElement) => {
      for (let x: SceneElement | null = el; x; x = info.get(x)?.parent ?? null) if (x.instance) return true;
      return false;
    };
    const left = cl.ids.filter((id) => id.copies.every((c) => !inPart(c.el)));
    return left.length ? [{ ...cl, ids: left }] : [];
  });
  if (clusters.length) {
    const named = nameSections(
      clusters.map((cl) => ({ kind: kindOfIdentity(cl.ids[0]!), ids: cl.ids })),
      next,
      taken,
      prefixes,
    );
    clusters.forEach((cl, si) => {
      const ids = cl.ids;
      const kind = kindOfIdentity(ids[0]!);
      const copies = ids
        .flatMap((id) => id.copies)
        .filter((c) => !isMain(c.el) && !c.el.instance && !containsMain(c.el));
      if (!copies.length) return;
      // one look per breakpoint (copies of one breakpoint that look alike share it); the trees as they are now, with
      // the parts inside them instances
      const m = treeMatcher(false);
      const covers = (a: SectionCopy, b: SectionCopy) => a === b || m.matched(a.el, b.el) === m.size(a.el);
      const byRank = new Map<number, SectionCopy[]>();
      for (const c of copies) {
        const r = rankOf_(screens[c.screen]!.screen);
        byRank.set(r, [...(byRank.get(r) ?? []), c]);
      }
      const id = o.newId();
      const nameClash = named.clash[si];
      // a section no other section was alike enough to join: a one-off (its nearest miss tells a failed merge apart)
      const single = ids.length === 1;
      const notes: ExtractionNotes = {
        ...(single
          ? { single, ...(cl.nearest > 0 ? { nearest: Math.round(cl.nearest * 100) / 100 } : {}) }
          : {}),
        ...(nameClash ? { nameClash } : {}),
      };
      /** The set from its looks; `join`: a breakpoint whose look is the previous one's in other geometry shares it. */
      const build = (join: boolean) => {
        const looks: SectionCopy[][] = [];
        const lookKey = new Map<SectionCopy[], string>();
        for (const [, cs] of [...byRank].sort((a, b) => a[0] - b[0])) {
          // the main: the copy the most others hold all of (their extra layers, one more card, are additions), smallest
          // on a tie; copies of one breakpoint that it does not fit are left alone (a later round takes them)
          const held = new Map(cs.map((c) => [c, cs.filter((d) => covers(c, d)).length]));
          const rep = [...cs].sort((a, b) => held.get(b)! - held.get(a)! || m.size(a.el) - m.size(b.el))[0]!;
          const fit = [rep, ...cs.filter((c) => c !== rep && covers(rep, c))];
          const k = shapeKey(rep.el, false);
          // (the previous breakpoint's look in other geometry only: the same look)
          const last = looks[looks.length - 1];
          const same =
            looks.find((l) => lookKey.get(l) === k) ??
            (join && last && geometryOnly([[last[0]!.el], [rep.el]]) ? last : undefined);
          if (same) same.push(...fit);
          else {
            looks.push(fit);
            lookKey.set(fit, k);
          }
        }
        if (!looks.length) return null;
        const multi = looks.length > 1;
        const keyOfLook = (l: SectionCopy[]) =>
          multi
            ? `${BREAKPOINT_AXIS}=${labels.get(Math.min(...l.map((c) => rankOf_(screens[c.screen]!.screen))))}`
            : "default";
        // the looks' trees may differ: layers that correspond keep the previous look's ids (overrides carry over)
        const variants: Record<string, SceneElement> = {};
        const used = new Set<string>();
        let prev: SceneElement | null = null;
        for (const l of looks) {
          const key = keyOfLook(l);
          const tree = mainTree(l[0]!.el);
          const label = key.split("=")[1] ?? "v";
          const fresh = (old: string) => {
            let n = `${label}-${old}`;
            for (let i = 2; used.has(n); i++) n = `${label}-${old}-${i}`;
            used.add(n);
            return n;
          };
          const aligned: SceneElement = prev ? alignIds(tree, prev, fresh) : tree;
          idsOf(aligned).forEach((x) => used.add(x));
          variants[key] = aligned;
          prev = aligned;
        }
        const def: ExtractedDef = {
          id,
          name: named.names[si]!,
          kind,
          category: KIND_CATEGORY[kind],
          origin: "extracted",
          variants,
          defaultVariant: keyOfLook(looks[0]!),
          ...(multi
            ? { variantAxes: { [BREAKPOINT_AXIS]: looks.map((l) => keyOfLook(l).split("=")[1]!) } }
            : {}),
          ...previewWidthsOf(looks.map((l) => [keyOfLook(l), l[0]!.el] as const)),
          ...(Object.keys(notes).length ? { extraction: notes } : {}),
        };
        const r = convert(
          def,
          looks.flatMap((l) => l.map((c) => ({ el: c.el, key: keyOfLook(l) }))),
          kind === "hero" || kind === "section",
        );
        return { def, variants, r, copies: looks.flat().length };
      };
      let built = build(true);
      // a breakpoint that shared a look but does not rebuild from it (what differs is more than geometry): every
      // breakpoint its own variant, rather than a set of its own later (the same page slot at two widths)
      if (built && built.r.converted.length < built.copies) {
        const apart = build(false);
        if (apart && apart.r.converted.length > built.r.converted.length) built = apart;
      }
      if (!built) return;
      const { def, variants, r } = built;
      if (!r.converted.length) return;
      taken.add(def.name);
      next = r.trial;
      for (const { el, inst } of r.converted) {
        replaceInPlace(el, inst);
        touched.add(el);
      }
      made.push({
        id,
        name: def.name,
        instances: r.converted.length,
        variants: Object.keys(variants),
        kind,
        section: true,
        ...(single ? { single } : {}),
        ...clashFlags(def.name, nameClash),
      });
    });
  }

  // a set named before (an earlier round, the system's own) whose name a new one had to be numbered against shares
  // the clash: all of them need distinct names
  const clashes = new Set(made.flatMap((c) => (c.nameClash ? [c.nameClash.toLowerCase()] : [])));
  if (
    clashes.size &&
    next.componentSets?.some(
      (d) => d.origin === "extracted" && clashes.has(d.name.toLowerCase()) && !extractionOf(d)?.nameClash,
    )
  ) {
    next = {
      ...next,
      componentSets: next.componentSets.map((d) =>
        d.origin === "extracted" && clashes.has(d.name.toLowerCase()) && !extractionOf(d)?.nameClash
          ? ({ ...d, extraction: { ...extractionOf(d), nameClash: d.name } } as ExtractedDef)
          : d,
      ),
    };
  }

  /** Width of the box a layer sits in: its parent's content width (layers between with a relative width: their insets off). */
  function availableWidth(el: SceneElement): number {
    let inset = 0;
    for (let p = info.get(el)!.parent; p; p = info.get(p)!.parent) {
      const [, pr, , pl] = sides(p.layout?.padding);
      if (typeof p.layout?.width === "number") return Math.max(1, p.layout.width - pl - pr - inset);
      const [, mr, , ml] = sides(p.layout?.margin);
      inset += pl + pr + ml + mr;
    }
    const s = screens.find((x) => x.screen.root === info.get(el)!.tree);
    return Math.max(1, (s?.screen.width ?? 390) - inset);
  }
  /** a main as wide as its parent ('fill') is shown at the width it had in its screen */
  function previewWidthsOf(looks: ReadonlyArray<readonly [string, SceneElement]>): {
    previewWidths?: Record<string, number>;
  } {
    const previewWidths: Record<string, number> = {};
    for (const [key, el] of looks)
      if (typeof el.layout?.width !== "number") previewWidths[key] = Math.round(availableWidth(el));
    return Object.keys(previewWidths).length ? { previewWidths } : {};
  }

  /**
   * The sections of every web page: the stacked full-width blocks of its content (descending through wrappers —
   * a wrapper on one breakpoint of a page must be one on all of them, else the columns of a desktop section would be
   * sections of their own on the phone), matched across the breakpoints of a responsive page.
   */
  function findSections(): SectionIdentity[] {
    const pages = new Map<string, number[]>();
    screens.forEach((s, i) => {
      if (s.screen.platform !== "web" || s.screen.root.meta?.role === "components-page") return;
      const key = pageKey(s.screen);
      pages.set(key, [...(pages.get(key) ?? []), i]);
    });
    const out: SectionIdentity[] = [];
    for (const [page, idx] of pages) {
      // wrappers: a layer path is one when it qualifies on every screen of the page that has it (instances and mains,
      // converted before, have no say: a second run decides as the first did)
      const votes = new Map<string, boolean>();
      for (const i of idx) {
        const walk = (el: SceneElement, path: string, depth: number) => {
          for (const c of el.children ?? []) {
            if (c.instance || isMain(c)) continue;
            const p = `${path}/${ownName(c)}`;
            votes.set(p, (votes.get(p) ?? true) && qualifies(c));
            if (depth < 8) walk(c, p, depth + 1);
          }
        };
        walk(screens[i]!.screen.root, "", 0);
      }
      const overlay = typeof screens[idx[0]!]!.screen.root.meta?.overlayOf === "string";
      const lists = idx
        .sort((a, b) => rankOf_(screens[a]!.screen) - rankOf_(screens[b]!.screen))
        .map((i) => {
          const found: SceneElement[] = [];
          const visit = (container: SceneElement, path: string, depth: number) => {
            const W = boxOf(container).w;
            // (a state wrapper: the state shown, not its other states' copies of the page)
            const kids = container.states?.active
              ? contentKids(container).filter((c) => c.id === container.states!.active)
              : contentKids(container);
            for (const c of kids) {
              const b = boxOf(c);
              if (b.w < W * 0.6 || b.h < 24) continue;
              const p = `${path}/${ownName(c)}`;
              if (!c.instance && !isMain(c) && votes.get(p) && depth < 8) visit(c, p, depth + 1);
              else found.push(c);
            }
          };
          visit(screens[i]!.screen.root, "", 0);
          // a block placed over another section (a sticky sidebar, the copy laid over a stage teaser): no section of its
          // own when it is one on every breakpoint — except a bar at the top (a header over the stage)
          const inside = (a: Box, b: Box) =>
            (Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
              Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))) /
            Math.max(1, a.w * a.h);
          const overlays = new Set(
            found.filter(
              (f) =>
                !(boxOf(f).y < viewportOf(i) * 0.15 && boxOf(f).h <= 200) &&
                found.some(
                  (g) =>
                    g !== f &&
                    boxOf(g).w * boxOf(g).h > boxOf(f).w * boxOf(f).h &&
                    inside(boxOf(f), boxOf(g)) >= 0.6,
                ),
            ),
          );
          // a section that holds a main (or is an instance already) stays what it is; sections that start together:
          // the shorter first (the header over the stage)
          const list = found
            .filter((el) => !isMain(el) && !el.instance && !containsMain(el))
            .sort((a, b) => boxOf(a).y - boxOf(b).y || boxOf(a).h - boxOf(b).h || boxOf(a).x - boxOf(b).x);
          return list.map((el, n): SectionCopy => {
            const box = boxOf(el);
            const kind = classifyTree(el, {
              section: true,
              sectionIndex: n,
              sectionCount: list.length,
              overlay,
              size: { w: box.w, h: box.h },
              viewportHeight: viewportOf(i),
              atTop: n === 0 || box.y < viewportOf(i) * 0.15,
              atBottom: box.y + box.h >= pageHeight(i) - 4,
            });
            return {
              el,
              screen: i,
              box,
              kind,
              words: wordsOf(el),
              own: ownName(el),
              index: n,
              count: list.length,
              over: overlays.has(el),
            };
          });
        });
      // match each breakpoint's sections to the ones found so far (order kept: a weighted longest common subsequence)
      const ids: SectionIdentity[] = [];
      for (const list of lists) {
        const pairs = lcs(
          ids.map((id) => id.copies[id.copies.length - 1]!),
          list,
          sectionSimilarity,
          0.4,
        );
        let at = 0;
        const merged: SectionIdentity[] = [];
        // walk both lists in order: matched copies join their identity, the others start one where they sit
        const byB = new Map([...pairs].map(([a, b]) => [b, a]));
        list.forEach((c, j) => {
          const a = byB.get(j);
          if (a !== undefined) {
            while (at <= a) merged.push(ids[at++]!);
            ids[a]!.copies.push(c);
          } else {
            merged.push({ copies: [c], page, overlay, title: null, layer: null, heading: null });
          }
        });
        while (at < ids.length) merged.push(ids[at++]!);
        ids.splice(0, ids.length, ...merged);
      }
      for (const id of ids) Object.assign(id, sectionTitle(id.copies[id.copies.length - 1]!.el, prefixes));
      out.push(...ids.filter((id) => !id.copies.every((c) => c.over)));
    }
    return out;
  }

  /**
   * Is this layer a wrapper of sections: full-width blocks stacked one under the other (not layered: a stage whose
   * copy lies over its picture is one block), or one block with only trimmings beside it?
   */
  function qualifies(el: SceneElement): boolean {
    return wrapperOf(el) !== null;
  }
  /**
   * 'stack': full-width blocks one under the other; 'pass': one block with only trimmings beside it; null: a block.
   * Blocks that lie over each other (a stage's copy over its picture) are one block, unless one of them is itself a
   * stack of sections (sections with overlays placed over them).
   */
  function wrapperOf(el: SceneElement): "stack" | "pass" | null {
    if (wrapperCache.has(el)) return wrapperCache.get(el)!;
    const tag = typeof el.meta?.tag === "string" ? el.meta.tag : "";
    let q: "stack" | "pass" | null = null;
    // (a state wrapper around the whole page — nestle.com's dark-mode toggle switches the page — passes through to the
    // page it shows: its sections are the page's sections, not one page-sized "hero")
    const pageStates =
      !!el.states &&
      (() => {
        const k = contentKids(el);
        const shown = k.find((c) => c.id === el.states!.active) ?? (k.length === 1 ? k[0] : undefined);
        return !!shown && stacks(shown);
      })();
    if (pageStates) q = "pass";
    else if (!LANDMARKS.has(tag) && !el.instance && !isMain(el) && !el.states) {
      const b = boxOf(el);
      const kids = contentKids(el);
      const wide = kids.filter((k) => boxOf(k).w >= b.w * 0.6 && boxOf(k).h >= 24);
      const blocks = wide.filter((k) => boxOf(k).h >= 100);
      const overlap = (x: Box, y: Box) =>
        Math.max(0, Math.min(x.y + x.h, y.y + y.h) - Math.max(x.y, y.y)) / Math.max(1, Math.min(x.h, y.h));
      const layered = blocks.some((a, i) =>
        blocks.some((c, j) => j > i && overlap(boxOf(a), boxOf(c)) > 0.3 && !stacks(a) && !stacks(c)),
      );
      if (blocks.length >= 2) q = layered ? null : "stack";
      else if (wide.length === 1) {
        const others = kids.filter((k) => k !== wide[0]);
        const area = (k: SceneElement) => boxOf(k).w * boxOf(k).h;
        // (layers the page stacks over the block — a header logo, social buttons lifted out of their section into the
        // wrapper's stacking context — lie inside it: trimmings too)
        const w0 = boxOf(wide[0]!);
        const within = (k: SceneElement) => {
          const x = boxOf(k);
          return (
            x.x >= w0.x - 1 && x.y >= w0.y - 1 && x.x + x.w <= w0.x + w0.w + 1 && x.y + x.h <= w0.y + w0.h + 1
          );
        };
        q =
          others.reduce((s, k) => s + area(k), 0) <= area(el) * 0.03 ||
          others.every(
            (k) =>
              (boxOf(k).w < b.w * 0.3 && boxOf(k).h < 80) || (within(k) && area(k) <= area(wide[0]!) * 0.1),
          )
            ? "pass"
            : null;
      }
    }
    wrapperCache.set(el, q);
    return q;
  }
  /** Does this layer hold several sections (a stack, maybe below wrappers that pass through)? */
  function stacks(el: SceneElement): boolean {
    const w = wrapperOf(el);
    if (w === "stack") return true;
    if (w !== "pass") return false;
    const b = boxOf(el);
    const wide = contentKids(el).find((k) => boxOf(k).w >= b.w * 0.6 && boxOf(k).h >= 24);
    return !!wide && stacks(wide);
  }

  /**
   * Sections that are one component become one set: of one kind, at the same breakpoints, and alike at each of them
   * (treeMatcher: the same layers, looks and copy aside, any number of alike items) — a row of stage teasers, six card
   * sections that differ in their heights, pictures, copy or how many cards they hold; the same header on every page.
   * Each lone section notes how near it came to another (a near-miss twin vs a unique section).
   */
  function mergeIdentities(ids: SectionIdentity[]): SectionCluster[] {
    // (instances of other sets of one kind — another icon, another card — are the same structure: a swap)
    const kindOf = new Map((ds.componentSets ?? []).map((d) => [d.id, d.kind ?? ""]));
    const m = treeMatcher(true, (id) => kindOf.get(id) ?? "");
    const rankOfCopy = (c: SectionCopy) => rankOf_(screens[c.screen]!.screen);
    const ranksOf = (id: SectionIdentity) => [...new Set(id.copies.map(rankOfCopy))].sort((a, b) => a - b);
    const ranks = new Map(ids.map((id) => [id, ranksOf(id)]));
    const kinds = new Map(ids.map((id) => [id, kindOfIdentity(id)]));
    const alike = (a: SectionIdentity, b: SectionIdentity): number => {
      const ra = ranks.get(a)!,
        rb = ranks.get(b)!;
      if (kinds.get(a) !== kinds.get(b) || a.overlay !== b.overlay || ra.join() !== rb.join()) return 0;
      let s = 1;
      for (const r of ra) {
        const x = a.copies.find((c) => rankOfCopy(c) === r)!.el,
          y = b.copies.find((c) => rankOfCopy(c) === r)!.el;
        // (sizes too far apart cannot reach the threshold: not worth aligning)
        const na = m.size(x),
          nb = m.size(y);
        if ((2 * Math.min(na, nb)) / (na + nb) < 0.5) return 0;
        s = Math.min(s, m.similarity(x, y));
        if (s < 0.5) return 0;
      }
      return s;
    };
    const out: SectionCluster[] = [];
    const near = new Map<SectionIdentity, number>();
    for (const id of ids) {
      let home: SectionCluster | undefined;
      for (const cl of out) {
        const v = alike(cl.ids[0]!, id);
        if (v >= SECTION_MERGE && !home) home = cl;
        else if (v < SECTION_MERGE) {
          near.set(id, Math.max(near.get(id) ?? 0, v));
          near.set(cl.ids[0]!, Math.max(near.get(cl.ids[0]!) ?? 0, v));
        }
      }
      if (home) home.ids.push(id);
      else out.push({ ids: [id], nearest: 0 });
    }
    for (const cl of out) cl.nearest = near.get(cl.ids[0]!) ?? 0;
    return out;
  }

  const out = new Map<string, SceneScreen>();
  for (const s of screens) {
    let hit = false;
    const walk = (el: SceneElement) => {
      if (touched.has(el)) hit = true;
      else el.children?.forEach(walk);
    };
    walk(s.screen.root);
    if (hit) out.set(s.nodeId, s.screen);
  }
  return { ds: next, screens: out, components: made };
}

/* ------------------------------------------------------------------ sections: helpers */

/** Tags whose element is one block of a page, never a wrapper of sections. */
const LANDMARKS = new Set([
  "header",
  "footer",
  "nav",
  "form",
  "figure",
  "article",
  "aside",
  "li",
  "ul",
  "ol",
  "a",
  "button",
  "table",
  "dialog",
]);

/** The layer's own word for itself (before the "·"), lower case. */
const ownName = (el: SceneElement) => (el.name ?? el.type).split("·")[0]!.trim().toLowerCase();

/** Children that show something (text, a picture, an icon, a control) and are not hidden. */
function contentKids(el: SceneElement): SceneElement[] {
  return (el.children ?? []).filter((c) => !c.meta?.hidden && hasContent(c));
}
function hasContent(el: SceneElement): boolean {
  if (el.meta?.hidden) return false;
  if (
    el.text?.trim() ||
    el.image?.src ||
    el.svg ||
    el.icon ||
    el.vector ||
    el.instance ||
    ["image", "video", "icon", "input", "avatar", "vector"].includes(el.type) ||
    el.meta?.role === "input"
  )
    return true;
  return (el.children ?? []).some(hasContent);
}
const containsMain = (el: SceneElement): boolean =>
  (el.children ?? []).some((c) => isMain(c) || containsMain(c));

/** Pages: the screens of one responsive group; a menu overlay with the page it opens over (one per overlay name). */
function pageKey(s: SceneScreen): string {
  if (s.responsive) return `page:${s.responsive.group}`;
  if (typeof s.root.meta?.overlayOf === "string")
    return `overlay:${s.name
      .split(" · ")
      .filter((p) => !/^\d+$/.test(p.trim()))
      .join(" · ")}`;
  return `screen:${s.id}`;
}

const textOf = (el: SceneElement): string =>
  [el.text ?? "", ...(el.children ?? []).map(textOf)].join(" ").trim();
function wordsOf(el: SceneElement): Set<string> {
  const out = new Set<string>();
  const walk = (x: SceneElement) => {
    for (const w of `${x.text ?? ""} ${x.image?.alt ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u))
      if (w.length >= 3) out.add(w);
    x.children?.forEach(walk);
  };
  walk(el);
  return out;
}

function sectionSimilarity(a: SectionCopy, b: SectionCopy): number {
  const inter = [...a.words].filter((w) => b.words.has(w)).length;
  const union = a.words.size + b.words.size - inter;
  const words = union ? inter / union : 0;
  const kind = a.kind === b.kind ? 1 : 0;
  const shell = (k: SceneComponentKind) => k === "header" || k === "footer" || k === "menu";
  if (shell(a.kind) && a.kind === b.kind) return 1;
  const name = a.own === b.own ? 1 : 0;
  const pos = 1 - Math.abs(a.index / Math.max(1, a.count - 1) - b.index / Math.max(1, b.count - 1));
  // without copy to compare (a picture, a map): the same layer at about the same place
  if (!a.words.size && !b.words.size) return 0.3 * name + 0.3 * kind + 0.4 * pos;
  return 0.6 * words + 0.15 * name + 0.15 * kind + 0.1 * pos;
}

/**
 * Weighted longest common subsequence of two lists: index pairs (a → b) in order whose score reaches `min`, with the
 * highest total score.
 */
function lcs<A, B>(as: A[], bs: B[], score: (a: A, b: B) => number, min: number): Map<number, number> {
  const n = as.length,
    m = bs.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const s: number[][] = as.map((a) =>
    bs.map((b) => {
      const v = score(a, b);
      return v >= min ? v : -1;
    }),
  );
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = Math.max(
        dp[i - 1]![j]!,
        dp[i]![j - 1]!,
        s[i - 1]![j - 1]! >= 0 ? dp[i - 1]![j - 1]! + s[i - 1]![j - 1]! : -1,
      );
    }
  const out = new Map<number, number>();
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (s[i - 1]![j - 1]! >= 0 && dp[i]![j] === dp[i - 1]![j - 1]! + s[i - 1]![j - 1]!) {
      out.set(i - 1, j - 1);
      i--;
      j--;
    } else if (dp[i]![j] === dp[i - 1]![j]) i--;
    else j--;
  }
  return out;
}

/** A structural key of a whole tree (any instances inside included): equal keys = copies that differ only in content. */
function shapeKey(el: SceneElement, root = true): string {
  return `${ownKey(el, root, false)}[${(el.children ?? []).map((c) => shapeKey(c, false)).join(",")}]`;
}

/**
 * A layer's structural word, looks and copy aside: its type, element, role, flow and what it does when tapped; an
 * instance: `inst` of its set (one layer: what it holds is the set's) — any instance by default, as an instance of
 * another set is a swap (one card's pictogram, another's).
 */
function layerWord(el: SceneElement, inst: (componentId: string) => string = () => "", flow = true): string {
  if (el.instance) return `@${inst(el.instance.componentId)}`;
  const l = flow ? (el.layout ?? {}) : {};
  return [
    el.type,
    el.meta?.tag ?? "",
    el.meta?.role ?? "",
    l.direction ?? "",
    l.scroll ?? "",
    l.position === "absolute" ? "abs" : "",
    el.states ? "states" : "",
    el.interaction?.onTap ?? "",
  ].join("|");
}

/**
 * Structural matching of layer trees (looks and copy aside): two layers match when their words do (layerWord); their
 * children align in order, most matched layers first. `matched(a, b)`: how many layers of `a` find their counterpart
 * in `b` (all of `a`'s: `b` holds all of it); `similarity`: matched layers over both sizes (1: the same structure).
 * With `items`, alike sibling items (a card ×3 and ×6, the items of a list) count once: their number is content.
 * Without `flow`, how layers are laid out (a row, placed absolutely) does not count: the same part at another width.
 * Caches by layer: make a new matcher once the trees change.
 */
function treeMatcher(items: boolean, inst?: (componentId: string) => string, flow = true) {
  const sigs = new Map<SceneElement, string>(),
    sizes = new Map<SceneElement, number>(),
    kidsOf = new Map<SceneElement, SceneElement[]>();
  const memo = new Map<SceneElement, Map<SceneElement, number>>();
  const kids = (el: SceneElement): SceneElement[] => {
    let k = kidsOf.get(el);
    if (k) return k;
    const all = el.instance ? [] : (el.children ?? []);
    // (an item: a block of layers or an instance; plain texts in a row — a title and its text — stay apart)
    k = items
      ? all.filter((c, i) => i === 0 || sig(c) !== sig(all[i - 1]!) || !(c.instance || c.children?.length))
      : all;
    kidsOf.set(el, k);
    return k;
  };
  const sig = (el: SceneElement): string => {
    let s = sigs.get(el);
    if (s === undefined) {
      s = `${layerWord(el, inst, flow)}[${kids(el).map(sig).join(",")}]`;
      sigs.set(el, s);
    }
    return s;
  };
  const size = (el: SceneElement): number => {
    let n = sizes.get(el);
    if (n === undefined) {
      n = 1 + kids(el).reduce((t, c) => t + size(c), 0);
      sizes.set(el, n);
    }
    return n;
  };
  const matched = (a: SceneElement, b: SceneElement): number => {
    if (layerWord(a, inst, flow) !== layerWord(b, inst, flow)) return 0;
    if (sig(a) === sig(b)) return size(a);
    let row = memo.get(a);
    const hit = row?.get(b);
    if (hit !== undefined) return hit;
    const ka = kids(a),
      kb = kids(b);
    let n = 1;
    for (const [i, j] of lcs(ka, kb, matched, 1)) n += matched(ka[i]!, kb[j]!);
    if (!row) memo.set(a, (row = new Map()));
    row.set(b, n);
    return n;
  };
  const similarity = (a: SceneElement, b: SceneElement) => (2 * matched(a, b)) / (size(a) + size(b));
  return { size, matched, similarity };
}

/** The same layers in the same places (types and child counts): a copy positional reId can map onto its main. */
function sameLayers(a: SceneElement, b: SceneElement): boolean {
  if (a.type !== b.type || (a.children?.length ?? 0) !== (b.children?.length ?? 0)) return false;
  return (a.children ?? []).every((c, i) => sameLayers(c, b.children![i]!));
}

/**
 * reId for a copy whose layers differ from its main's (a section with one more card): its layers align with the main's
 * by structure (treeMatcher) and take their ids; layers the main has no counterpart for keep their own (an instance
 * captures them as additions). Lossless conversion still decides whether the copy becomes an instance.
 */
function reIdAligned(
  el: SceneElement,
  like: SceneElement,
  idOf: (m: SceneElement) => string,
  rootId?: string,
): SceneElement {
  const m = treeMatcher(false);
  const ids = new Map<string, string>();
  const keep = (a: SceneElement) => {
    ids.set(a.id, a.id);
    a.children?.forEach(keep);
  };
  const go = (a: SceneElement, l: SceneElement, root: boolean): SceneElement => {
    const { children, ...rest } = a;
    const out = clone(rest) as SceneElement;
    out.id = root ? (rootId ?? l.id) : idOf(l);
    ids.set(a.id, out.id);
    if (children) {
      const lk = l.children ?? [];
      const pairs = lcs(children, lk, m.matched, 1);
      out.children = children.map((c, i) => {
        const j = pairs.get(i);
        if (j === undefined) {
          keep(c);
          return clone(c);
        }
        return go(c, lk[j]!, false);
      });
    }
    return out;
  };
  return withRefs(go(el, like, true), ids);
}

/** The ExtractedComponent flags of a set whose built-in name clashed (`base`): numbered when it got a number. */
const clashFlags = (
  name: string,
  base: string | undefined,
): Pick<ExtractedComponent, "nameClash" | "numbered"> =>
  base ? { nameClash: base, ...(name.toLowerCase() !== base.toLowerCase() ? { numbered: true } : {}) } : {};

/**
 * What a section is called besides its structure: `layer`, the name its layer gives it (a class-ish name, the words
 * after the tag: "Section · Tiles"); `heading`, its heading (the biggest short text, when it reads as one, else its first
 * words) — page copy, so only ever a qualifier; `title`, what the parts inside it are told apart by (the heading first).
 */
function sectionTitle(
  el: SceneElement,
  prefixes: ReadonlySet<string>,
): { title: string | null; layer: string | null; heading: string | null } {
  let best: { t: string; size: number } | null = null;
  let first: string | null = null;
  const sizes: number[] = [];
  const walk = (x: SceneElement) => {
    if (x.meta?.hidden) return;
    const t = x.type === "text" ? (x.text ?? "").replace(/\s+/g, " ").trim() : "";
    const size = x.style?.fontSize ?? 16;
    // not an icon font's ligature ("arrow_chevron_down")
    if (t && /\p{L}/u.test(t) && !/^[\p{L}\d]+(_[\p{L}\d]+)+$/u.test(t)) {
      first ??= t;
      sizes.push(size);
      if (t.length <= 60 && (!best || size > best.size)) best = { t, size };
    }
    x.children?.forEach(walk);
  };
  walk(el);
  // "BMW 120: Energieverbrauch kombiniert …" → "BMW 120"; else the first four words
  const short = (t: string) => {
    const head = t.split(/:\s|\s[–-]\s|\.\s|,\s/)[0]!.trim();
    const u = head.length >= 3 ? head : t;
    const w = u.split(" ");
    return w.length > 4 ? `${w.slice(0, 4).join(" ")}…` : u;
  };
  const heading = best as { t: string; size: number } | null;
  const own = meaningfulLayerName(el.name, textOf(el), prefixes);
  // the class-ish name, else the words after the tag ("Section · Highlights")
  const layer = own && own.length > 3 && !GENERIC_SECTION_NAMES.test(own) ? own : detailOf([el]);
  // a heading: the one biggest text (several of one size are the titles of a list)
  const lead =
    heading && heading.size >= 20 && sizes.filter((s) => s === heading.size).length === 1
      ? short(heading.t)
      : null;
  const words = heading ? short(heading.t) : first ? short(first) : null;
  return { title: lead ?? layer ?? words, layer: layer || null, heading: words };
}
const GENERIC_SECTION_NAMES =
  /^(section|main|aside|article|div|group|relative|absolute|anchor link|wrapper|container|content|inner|stage wrapper|page|root|header|footer|nav|figure|text|list)\b/i;

/** Rough boxes of a screen's layers (page coordinates): sizes as designed, auto sizes from the content. */
function layoutBoxes(root: SceneElement, width: number, out: Map<SceneElement, Box>) {
  const size = new Map<SceneElement, { w: number; h: number }>();
  const len = (v: unknown, of: number): number | undefined =>
    typeof v === "number"
      ? v
      : typeof v === "string" && v.endsWith("%")
        ? (of * parseFloat(v)) / 100
        : v === "fill"
          ? of
          : undefined;
  const measure = (el: SceneElement, avail: number): { w: number; h: number } => {
    const l = el.layout ?? {};
    const [pt, pr, pb, pl] = sides(l.padding);
    const w =
      len(l.width, avail) ??
      (el.type === "text"
        ? Math.min(avail, (el.text?.length ?? 0) * (el.style?.fontSize ?? 16) * 0.5)
        : avail);
    const kids = (el.children ?? []).filter((c) => !c.meta?.hidden);
    const row = l.direction === "row";
    const gap = l.gap ?? 0;
    let flowH = 0,
      placedH = 0;
    let n = 0;
    for (const c of kids) {
      const abs = c.layout?.position === "absolute";
      const s = measure(c, abs ? w : Math.max(0, w - pl - pr));
      if (abs) {
        placedH = Math.max(placedH, (typeof c.layout?.y === "number" ? c.layout.y : 0) + s.h);
        continue;
      }
      n++;
      if (row) flowH = Math.max(flowH, s.h);
      else flowH += s.h;
    }
    if (!row && n > 1) flowH += gap * (n - 1);
    const fs = el.style?.fontSize ?? 16;
    const textH =
      el.type === "text"
        ? Math.max(1, Math.ceil(((el.text?.length ?? 0) * fs * 0.5) / Math.max(1, w))) *
          fs *
          (el.style?.lineHeight ?? 1.25)
        : 0;
    const h = len(l.height, 0) || Math.max(textH, n ? flowH + pt + pb : 0, placedH);
    const r = { w, h };
    size.set(el, r);
    return r;
  };
  const place = (el: SceneElement, x: number, y: number) => {
    const s = size.get(el) ?? { w: 0, h: 0 };
    out.set(el, { x, y, w: s.w, h: s.h });
    const l = el.layout ?? {};
    const [pt, , , pl] = sides(l.padding);
    const row = l.direction === "row";
    let cx = x + pl,
      cy = y + pt;
    for (const c of el.children ?? []) {
      if (c.meta?.hidden) {
        place(c, x, y);
        continue;
      }
      if (c.layout?.position === "absolute") {
        place(
          c,
          x + (typeof c.layout.x === "number" ? c.layout.x : 0),
          y + (typeof c.layout.y === "number" ? c.layout.y : 0),
        );
        continue;
      }
      place(c, cx, cy);
      const cs = size.get(c) ?? { w: 0, h: 0 };
      if (row) cx += cs.w + (l.gap ?? 0);
      else cy += cs.h + (l.gap ?? 0);
    }
  };
  measure(root, width);
  place(root, 0, 0);
}

/* ------------------------------------------------------------------ trees */

type Sides = number | [number, number] | [number, number, number, number] | undefined;
const sides = (p: Sides): [number, number, number, number] =>
  p === undefined
    ? [0, 0, 0, 0]
    : typeof p === "number"
      ? [p, p, p, p]
      : p.length === 2
        ? [p[0], p[1], p[0], p[1]]
        : p;

function withDef(ds: SceneDesignSystem, def: SceneComponentDef): SceneDesignSystem {
  return { ...ds, componentSets: [...(ds.componentSets ?? []), def] };
}

/** A copy as a main stores it: no placement, no editor meta, no instance link of its own. */
function mainTree(el: SceneElement): SceneElement {
  const out = clone(el);
  if (out.layout) {
    for (const k of PLACEMENT_KEYS) delete out.layout[k];
    if (!Object.keys(out.layout).length) delete out.layout;
  }
  delete out.meta;
  delete out.instance;
  return out;
}

/**
 * `el` with the layer ids of `like` (same structure, matched by position): `idOf(likeLayer)` for every layer below
 * the root, `rootId` (else `like`'s id) for the root. A nested instance's materialized layers follow its new id.
 */
function reId(
  el: SceneElement,
  like: SceneElement,
  idOf: (m: SceneElement) => string,
  rootId?: string,
): SceneElement {
  const ids = new Map<string, string>();
  const go = (a: SceneElement, m: SceneElement, root: boolean): SceneElement => {
    const { children, ...rest } = a;
    const out = clone(rest) as SceneElement;
    out.id = root ? (rootId ?? m.id) : idOf(m);
    ids.set(a.id, out.id);
    if (children) out.children = children.map((c, i) => go(c, m.children![i]!, false));
    return out;
  };
  return withRefs(go(el, like, true), ids);
}

/** Interactions inside `tree` that point at its own layers (a slider's arrows → its track) and a state frame's shown state follow their new ids. */
function withRefs(tree: SceneElement, ids: Map<string, string>): SceneElement {
  const to = (id: string | undefined) => (id !== undefined ? (ids.get(id) ?? id) : id);
  const go = (el: SceneElement) => {
    const i = el.interaction;
    if (
      i &&
      ((i.target && ids.has(i.target)) ||
        (i.state && ids.has(i.state)) ||
        i.options?.some((o) => ids.has(o.state)))
    ) {
      el.interaction = {
        ...i,
        ...(i.target !== undefined ? { target: to(i.target) } : {}),
        ...(i.state !== undefined ? { state: to(i.state) } : {}),
        ...(i.options ? { options: i.options.map((o) => ({ ...o, state: to(o.state)! })) } : {}),
      };
    }
    if (el.states?.active && ids.has(el.states.active))
      el.states = { ...el.states, active: to(el.states.active) };
    el.children?.forEach(go);
  };
  go(tree);
  return tree;
}

/**
 * `tree` (another breakpoint's look of a section) with the layer ids of `base` where its layers correspond — the same
 * type (and component) in the same order, best by name / copy / picture — so overrides carry over between the
 * variants; the other layers get `fresh` ids. Nested instances keep their materialized layers under their new id.
 */
function alignIds(tree: SceneElement, base: SceneElement, fresh: (old: string) => string): SceneElement {
  const sig = (e: SceneElement) => `${e.type}|${e.instance?.componentId ?? ""}`;
  const score = (a: SceneElement, b: SceneElement) =>
    sig(a) !== sig(b)
      ? 0
      : 1 +
        (a.name === b.name ? 1 : 0) +
        (a.text && a.text === b.text ? 2 : 0) +
        (a.image?.src && a.image.src === b.image?.src ? 2 : 0) +
        (a.svg && a.svg === b.svg ? 1 : 0) +
        (a.meta?.tag === b.meta?.tag ? 0.5 : 0);
  const ids = new Map<string, string>();
  const rename = (el: SceneElement, from: string, to: string): SceneElement => {
    const { children, ...rest } = el;
    const out = clone(rest) as SceneElement;
    if (out.id.startsWith(from + ID_SEP)) out.id = to + out.id.slice(from.length);
    ids.set(el.id, out.id);
    if (children) out.children = children.map((c) => rename(c, from, to));
    return out;
  };
  const go = (o: SceneElement, b: SceneElement | null, id: string): SceneElement => {
    const { children, ...rest } = o;
    const out = { ...clone(rest), id } as SceneElement;
    ids.set(o.id, id);
    if (!children) return out;
    if (o.instance) {
      out.children = children.map((c) => rename(c, o.id, id));
      return out;
    }
    const bk = b?.children ?? [];
    const pairs = b ? lcs(children, bk, score, 1) : new Map<number, number>();
    out.children = children.map((c, i) => {
      const j = pairs.get(i);
      return j === undefined ? go(c, null, fresh(c.id)) : go(c, bk[j]!, bk[j]!.id);
    });
    return out;
  };
  return withRefs(go(tree, base, base.id), ids);
}

const idsOf = (el: SceneElement): string[] => [el.id, ...(el.children ?? []).flatMap(idsOf)];

/** The instance rebuilds into the copy (its link aside; a root without a name takes the main's). */
function sameTree(inst: SceneElement, copy: SceneElement): boolean {
  const a: SceneElement = { ...inst, instance: undefined },
    b: SceneElement = { ...copy, instance: undefined };
  if (b.name === undefined) a.name = undefined;
  return deepEqual(a, b);
}

/**
 * `inst` (a captured instance of `copy`) with overrides for the measured editor meta (GEOMETRY_META) its layers have
 * otherwise than the main's — what captureInstance does not record; null when there is none.
 */
function metaOverrides(inst: SceneElement, copy: SceneElement, ds: SceneDesignSystem): SceneElement | null {
  const link = inst.instance;
  if (!link) return null;
  const built = new Map<string, SceneElement>();
  const index = (el: SceneElement) => {
    built.set(el.id, el);
    el.children?.forEach(index);
  };
  index(buildInstance(inst, ds));
  const prefix = copy.id + ID_SEP;
  const ov = { ...(link.overrides ?? {}) };
  let any = false;
  const walk = (el: SceneElement) => {
    const b = built.get(el.id);
    if (b && el.id.startsWith(prefix)) {
      const patch: Record<string, string | number | boolean | null> = {};
      for (const k of GEOMETRY_META) {
        const mine = (el.meta as Record<string, unknown> | undefined)?.[k],
          theirs = (b.meta as Record<string, unknown> | undefined)?.[k];
        if (!deepEqual(mine, theirs))
          patch[k] = mine === undefined ? null : (mine as string | number | boolean);
      }
      if (Object.keys(patch).length) {
        const rel = el.id.slice(prefix.length);
        ov[rel] = { ...(ov[rel] ?? {}), meta: { ...(ov[rel]?.meta ?? {}), ...patch } };
        any = true;
      }
    }
    el.children?.forEach(walk);
  };
  walk(copy);
  return any ? { ...inst, instance: { ...link, overrides: ov } } : null;
}

/** Replace an element's content in place (bigger parts found earlier keep pointing at it). */
function replaceInPlace(el: SceneElement, next: SceneElement) {
  const target = el as unknown as Record<string, unknown>;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
}

/* ------------------------------------------------------------------ properties */

/**
 * Component properties from how the copies differ: a text that differs → text property, a layer hidden in some copies →
 * boolean, nested instances of different sets at one spot → instance swap, different pictures → image. `promote` (page
 * sections, one copy per breakpoint) also makes the section's prominent texts and its main picture properties, so a
 * page composed of it sets them. Names say what each is (catalog.ts propertyNames).
 */
function deriveProperties(
  def: SceneComponentDef,
  ds: SceneDesignSystem,
  copies: SceneElement[],
  promote: boolean,
): NonNullable<SceneComponentDef["properties"]> {
  const main = def.variants[def.defaultVariant]!;
  // targets: layers of the main itself (not inside a nested instance), present in every variant
  const own = new Map<string, SceneElement>();
  // (the root too: a button's label is its own text)
  const index = (el: SceneElement, root: boolean) => {
    own.set(el.id, el);
    if (!el.instance || root) el.children?.forEach((c) => index(c, false));
  };
  index(main, true);
  const everywhere = (id: string) => Object.values(def.variants).every((v) => idsOf(v).includes(id));
  const t: PropertyTargets = { text: [], boolean: [], swap: [], image: [] };
  const add = (list: string[], id: string) => {
    if (!list.includes(id) && own.has(id) && everywhere(id)) list.push(id);
  };
  // copy and pictures inside alike sibling items (the cards of a grid, the links of a column) are the items' content:
  // they stay overrides here, and the set's API lists them per item (catalog.ts itemFields), never as flat "Title 2…6"
  const items = itemPlaces(main, repeatedItems(main, { list: ITEM_LIST_KINDS.has(def.kind ?? "other") }));
  for (const c of copies) {
    const ov = captureInstance(c, ds).instance?.overrides ?? {};
    for (const [key, d] of Object.entries(ov)) {
      const k = key === ROOT_KEY ? main.id : key;
      const m = own.get(k);
      if (!m) continue;
      // (separators that differ stay overrides: "|" is no prop)
      if (
        d.text !== undefined &&
        d.text !== null &&
        typeof m.text === "string" &&
        !items.has(k) &&
        (!m.runs || linkedText(m)) &&
        (!d.runs || (Array.isArray(d.runs) && d.runs.length === 1)) &&
        /[\p{L}\p{N}]{2}/u.test(m.text)
      )
        add(t.text, k);
      if (k !== main.id && d.meta && "hidden" in d.meta) add(t.boolean, k);
      if (k !== main.id && d.instance && m.instance && d.instance.componentId !== m.instance.componentId)
        add(t.swap, k);
      if (
        d.image &&
        m.image?.src &&
        typeof d.image.src === "string" &&
        d.image.src !== m.image.src &&
        !items.has(k)
      )
        add(t.image, k);
    }
  }
  if (promote) {
    // (copy inside one of several alike items, the cards of a list, is the items' content, not the section's own)
    const parentOf = new Map<string, SceneElement>();
    const link = (el: SceneElement) =>
      el.children?.forEach((c) => {
        parentOf.set(c.id, el);
        link(c);
      });
    link(main);
    const inItem = (el: SceneElement) => {
      for (let x: SceneElement | undefined = el; x && x !== main; x = parentOf.get(x.id)) {
        const p = parentOf.get(x.id),
          k = shapeKey(x, false);
        if (p?.children?.some((c) => c !== x && shapeKey(c, false) === k)) return true;
      }
      return false;
    };
    const texts: SceneElement[] = [],
      media: SceneElement[] = [];
    for (const el of own.values()) {
      if (el.meta?.hidden || (el.runs && !linkedText(el)) || inItem(el) || items.has(el.id)) continue;
      // copy, not separators or glyphs ("|", "·", "→")
      // (a button's label is its own text)
      if (
        (el.type === "text" || (el === main && typeof el.text === "string")) &&
        /[\p{L}\p{N}]{2}/u.test(el.text ?? "") &&
        el.text!.length <= 240
      )
        texts.push(el);
      if (el.image?.src && el.type !== "icon") media.push(el);
    }
    const order = idsOf(main);
    const size = (el: SceneElement) => el.style?.fontSize ?? 16;
    texts
      .sort((a, b) => size(b) - size(a) || order.indexOf(a.id) - order.indexOf(b.id))
      .slice(0, 4)
      .forEach((el) => add(t.text, el.id));
    const area = (el: SceneElement) =>
      (typeof el.layout?.width === "number" ? el.layout.width : 0) *
      (typeof el.layout?.height === "number" ? el.layout.height : 0);
    media
      .sort((a, b) => area(b) - area(a))
      .slice(0, 1)
      .forEach((el) => add(t.image, el.id));
  }
  if (!t.text.length && !t.boolean.length && !t.swap.length && !t.image.length) return [];
  return propertyNames(main, def.kind ?? "other", t, ds).map(({ name, type, target }) => {
    const m = own.get(target)!;
    const value =
      type === "text"
        ? (m.text ?? "")
        : type === "boolean"
          ? !m.meta?.hidden
          : type === "image"
            ? (m.image?.src ?? "")
            : (m.instance?.componentId ?? "");
    return { name, type, target, default: value };
  });
}

/* ------------------------------------------------------------------ naming */

/** The name a role gives a part when its layer names say nothing. */
function roleName(el: SceneElement): string {
  let img = false,
    txt = false,
    icon = false;
  const walk = (x: SceneElement) => {
    if (x.text?.trim()) txt = true;
    if (x.type === "image" || x.type === "video" || x.type === "avatar" || x.image) img = true;
    if (x.type === "icon" || x.svg || x.type === "vector") icon = true;
    x.children?.forEach(walk);
  };
  walk(el);
  const kids = el.children ?? [];
  if (
    kids.length >= 2 &&
    kids.every(
      (c) =>
        c.type === "button" || c.meta?.tag === "button" || (c.meta?.tag === "a" && c.instance) || c.instance,
    )
  )
    return "Button group";
  if (el.type === "button") return "Button";
  if (el.type === "badge") return "Badge";
  if (el.type === "input") return "Input";
  if (el.type === "avatar") return "Avatar";
  if (img && txt) return "Card";
  if (img) return "Picture";
  if (icon && !txt) return "Icon";
  if (icon && txt) return "Icon label";
  if (el.interaction && txt) return "Link";
  if (txt) return "Text block";
  return "Shape";
}

/** Layer names that only repeat the HTML element or the kind ("List item", "Article", "Figure", "Bds Icon"): no name. */
const WEAK_NAMES =
  /^(page|body|root|video|media|list item|list|article|figure|picture|image|img|button|btn|link|time|nav|navigation|main|header|footer|section|aside|form|text|span|label|group|icon|bds icon|lucide|svg|strong|em|h[1-6]|p|div|ul|li|figcaption|blockquote|state|states|center|left|right|top|bottom|inner|outer|item|items)$/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A layer name every copy shares, when it says more than the kind does. */
function sharedLayerName(copies: SceneElement[], prefixes: ReadonlySet<string>): string | null {
  const names = new Set(copies.map((el) => meaningfulLayerName(el.name, textOf(el), prefixes)));
  const n = names.size === 1 ? [...names][0] : null;
  return n && !WEAK_NAMES.test(n) ? n : null;
}

/** The glyph an SVG names: the symbol it uses from a sprite (`<use href="…/bds-magnify-line.svg#bds-magnify-line">` → "magnify"). */
export function svgGlyph(svg: string): string | null {
  // the symbol it uses, the name a capture kept for an inlined symbol, a symbol's own id
  const m =
    /<use\b[^>]*?(?:xlink:)?href="[^"#]*#([\w-]+)"/.exec(svg) ??
    /^<svg\b[^>]*?\sdata-(?:icon|symbol|glyph)="(?:[^"#]*#)?([\w-]+)"/.exec(svg) ??
    /<symbol\b[^>]*?\sid="([\w-]+)"/.exec(svg);
  if (!m) return null;
  const w = m[1]!
    .replace(/^(bds|icon|icons|ico|i|svg|sprite)[-_]/i, "")
    .replace(/[-_](line|fill|filled|outline|outlined|solid|regular|bold|light|thin|\d+)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  return /^[a-z][a-z0-9 ]{1,30}$/.test(w) ? w : null;
}

/** Icon names: the glyph of an icon font, the lucide name, the sprite symbol it uses, else the words after "Icon ·" in the layer name. */
function iconName(copies: SceneElement[]): string | null {
  const glyphs = new Set(
    copies.map((el) => {
      let g: string | null = null;
      const walk = (x: SceneElement) => {
        if (g) return;
        if (typeof x.meta?.glyph === "string") g = x.meta.glyph;
        else if (x.icon) g = x.icon;
        else if (x.svg && svgGlyph(x.svg)) g = svgGlyph(x.svg);
        else x.children?.forEach(walk);
      };
      walk(el);
      return g ? String(g).replace(/[_-]+/g, " ").trim() : null;
    }),
  );
  const g = glyphs.size === 1 ? [...glyphs][0] : null;
  return g ?? detailOf(copies);
}

/** The first text of a block when every copy starts with it and it is short (a heading, a label). */
function sharedHeading(copies: SceneElement[]): string | null {
  const first = (el: SceneElement): string => {
    if (el.text?.trim()) return el.text.trim();
    for (const c of el.children ?? []) {
      const t = first(c);
      if (t) return t;
    }
    return "";
  };
  const hs = new Set(copies.map((el) => first(el).replace(/\s+/g, " ")));
  const h = hs.size === 1 ? [...hs][0]! : "";
  return h && h.length <= 24 && /\p{L}{2}/u.test(h) && h.split(" ").length <= 4 ? h : null;
}

/** What a part holds besides copy: "with icon", "with image", else "text only". */
function holds(el: SceneElement): string {
  let icon = false,
    img = false;
  const walk = (x: SceneElement) => {
    if (x.type === "icon" || x.type === "vector" || (x.svg && x.type !== "image")) icon = true;
    else if (x.type === "image" || x.type === "video" || x.image?.src) img = true;
    x.children?.forEach(walk);
  };
  walk(el);
  return img ? "with image" : icon ? "with icon" : "text only";
}

/**
 * The label of the control (button, link) an icon sits in, when every copy sits in a control with that label: its
 * text when short, else the words of its layer name ("Startseite" for the icon of the "Startseite" menu button).
 */
function parentLabel(
  copies: SceneElement[],
  parentOf: (el: SceneElement) => SceneElement | null,
): string | null {
  const labelOf = (el: SceneElement): string => {
    for (let p = parentOf(el), up = 0; p && up < 2; p = parentOf(p), up++) {
      if (p.type !== "button" && p.meta?.tag !== "button" && p.meta?.tag !== "a") continue;
      const t = textOf(p).replace(/\s+/g, " ").trim();
      const named =
        p.name?.includes("·") && !p.name.includes("…") ? p.name.split("·").slice(1).join(" ").trim() : "";
      const label = t && t.split(" ").length <= 3 ? t : named;
      // a whole label, not the start of a sentence
      return label.split(" ").length <= 3 ? label : "";
    }
    return "";
  };
  const labels = new Set(copies.map(labelOf));
  const l = labels.size === 1 ? [...labels][0]! : "";
  return l && l.length <= 28 && /\p{L}{2}/u.test(l) ? l : null;
}

/** Buttons by their look: filled, outlined, or plain text; and their size. */
function buttonFlavor(el: SceneElement, withTone = true): string {
  const s = el.style ?? {};
  const tone = (c: string | undefined) => {
    const w = c && withTone ? colorWord(c) : null;
    return w ? ` ${w}` : "";
  };
  if ((s.background && !/^(transparent|none)$/i.test(s.background)) || s.gradient || s.fills?.length)
    return `Filled${tone(s.background)}`;
  if ((s.border && s.border.width > 0) || s.borders) return `Outline${tone(s.border?.color)}`;
  return `Text${tone(s.color ?? el.children?.find((c) => c.style?.color)?.style?.color)}`;
}
function sizeWord(el: SceneElement): string | null {
  const h = typeof el.layout?.height === "number" ? el.layout.height : null;
  return h === null ? null : h <= 32 ? "small" : h >= 52 ? "large" : "medium";
}

/** The text every copy shows, when short (a button's label): what tells two otherwise unnamed sets apart. */
function sharedText(copies: SceneElement[]): string | null {
  const texts = new Set(copies.map((el) => textOf(el).replace(/\s+/g, " ").trim()));
  const t = texts.size === 1 ? [...texts][0]! : "";
  return t && t.length <= 24 && /\p{L}/u.test(t) ? t : null;
}

/** The words after the role in the layer name every copy's parent shares ("Button · Open chat" over an icon). */
function parentDetail(
  copies: SceneElement[],
  parentOf: (el: SceneElement) => SceneElement | null,
): string | null {
  let ps: Array<SceneElement | null> = copies;
  // up to three layers up (an icon in a frame in a button)
  for (let up = 0; up < 3; up++) {
    ps = ps.map((p) => (p ? parentOf(p) : null));
    if (!ps.every((p): p is SceneElement => !!p)) return null;
    const d = detailOf(ps as SceneElement[]);
    if (d) return d;
  }
  return null;
}

/** An icon's size and colour ("20 white"), for two sets of one glyph. */
function iconLook(el: SceneElement): string | null {
  const w = typeof el.layout?.width === "number" ? Math.round(el.layout.width) : null;
  const color = el.style?.color ?? el.children?.find((c) => c.style?.color)?.style?.color;
  const tone = color ? colorWord(color) : null;
  return [w ? `${w}` : null, tone].filter(Boolean).join(" ") || null;
}
/** A block's orientation and size ("horizontal", "large vertical"). */
function blockLook(el: SceneElement): string | null {
  const w = typeof el.layout?.width === "number" ? el.layout.width : null;
  const dir =
    el.layout?.direction === "row" ? "horizontal" : el.layout?.direction === "column" ? "vertical" : null;
  const size = w === null ? null : w < 200 ? "small" : w > 520 ? "large" : null;
  return [size, dir].filter(Boolean).join(" ") || null;
}
/** Dark / light / a hue word for a CSS colour. */
function colorWord(c: string): string | null {
  const m = c.match(/^#([0-9a-f]{6})/i) ?? null;
  const rgb = m
    ? [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16))
    : (c
        .match(/rgba?\(([^)]+)\)/)?.[1]
        ?.split(",")
        .slice(0, 3)
        .map((x) => parseFloat(x)) ?? null);
  if (!rgb || rgb.some((x) => Number.isNaN(x))) return null;
  const [r, g, b] = rgb as [number, number, number];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max - min < 30) return max > 200 ? "light" : max < 80 ? "dark" : "grey";
  const hue =
    max === r
      ? ((g - b) / (max - min) + 6) % 6
      : max === g
        ? (b - r) / (max - min) + 2
        : (r - g) / (max - min) + 4;
  return ["red", "yellow", "green", "cyan", "blue", "magenta"][Math.round(hue) % 6]!;
}

interface NamedPart {
  copies: SceneElement[];
  kind: SceneComponentKind;
  within?: SceneComponentKind;
  sectionTitle?: string | null;
  axes?: LookAxes;
}

/**
 * Set names from what each part is ("Card", "Teaser", "Icon / arrow right"), or the layer name every copy shares when
 * it says more ("Highlight Teaser"). Sets that would share a name get what tells them apart, in this order: the words
 * after the role in their layer name ("Button / Open chat"), their look ("Button / Outline"), the page section they
 * sit in ("Footer link", "Teaser / NIVEA ESSENTIALS"), the layer above ("Seitenmenü / Button"), their label; numbers
 * only after that (flagged in `clash`, see resolveNames).
 */
function nameParts(
  parts: NamedPart[],
  parentOf: (el: SceneElement) => SceneElement | null,
  taken: Set<string>,
  prefixes: ReadonlySet<string>,
): { names: Map<object, string>; clash: Map<object, string> } {
  const entries = parts.map((p) => {
    const first = p.copies[0]!;
    const layer = sharedLayerName(p.copies, prefixes);
    const label = KIND_LABELS[p.kind];
    let base: string;
    if (p.kind === "other") base = layer ?? roleName(first);
    else if (p.kind === "icon" || p.kind === "icon-button") {
      const g = iconName(p.copies);
      base = g ? `${label} / ${g}` : label;
    } else {
      // a layer name that says what kind it is ("Highlight Teaser"), not a design system's class prefix ("Bds Tag")
      const words = (layer ?? "")
        .split(/\s+/)
        .filter(
          (w) => !(w.length <= 3 && w.toLowerCase() !== p.kind && w.toLowerCase() !== label.toLowerCase()),
        );
      const says =
        layer &&
        words.some(
          (w) =>
            w.toLowerCase() === label.toLowerCase() ||
            w.toLowerCase() === p.kind ||
            w.toLowerCase() === `${p.kind}s`,
        );
      // a name someone gave it ("Plant row", "Highlight Teaser"): words, not a class prefix or an abbreviation
      const lw = (layer ?? "").split(/\s+/);
      const given =
        layer && lw.length >= 2 && lw[0]!.length >= 4 && lw.every((w) => w.length >= 3 || /^\d+$/.test(w));
      base = given ? cap(layer!) : says && words.length > 1 ? cap(words.join(" ")) : label;
    }
    const plain = base === label;
    const cands = [base];
    const q = (s: string | null | undefined) => {
      if (s && !cands.includes(s)) cands.push(s);
    };
    const detail = detailOf(p.copies);
    if (detail && !base.toLowerCase().includes(detail.toLowerCase())) q(`${base} / ${detail}`);
    if (layer && plain && p.kind !== "other" && layer.toLowerCase() !== label.toLowerCase())
      q(`${label} / ${layer}`);
    const icon = p.kind === "icon" || p.kind === "icon-button";
    // (a set whose looks are its tone / size variants is not named after one of them)
    const toned = !!p.axes?.some((a) => a.name === "tone"),
      sized = !!p.axes?.some((a) => a.name === "size");
    if (p.kind === "button" || p.kind === "tag" || p.kind === "badge") {
      q(`${base} / ${buttonFlavor(first, !toned)}`);
      const sz = sized ? null : sizeWord(first);
      if (sz) q(`${base} / ${buttonFlavor(first, !toned)} ${sz}`);
    }
    if (icon) {
      const pd = parentDetail(p.copies, parentOf);
      if (pd) q(base === label ? `${label} / ${pd}` : `${base} / ${pd}`);
      // the same glyph drawn at another size or in another colour
      const look = p.axes?.some((a) => a.name !== BREAKPOINT_AXIS) ? null : iconLook(first);
      if (look) q(`${base} / ${look}`);
    }
    if (["card", "teaser", "list-item", "image", "text", "list"].includes(p.kind) && !sized) {
      const l = blockLook(first);
      if (l) q(`${base} / ${l}`);
    }
    if (p.within && p.within !== p.kind && plain)
      q(`${KIND_LABELS[p.within]} ${base.charAt(0).toLowerCase()}${base.slice(1)}`);
    if (p.sectionTitle) q(`${base} / ${p.sectionTitle}`);
    for (let x = parentOf(first); x; x = parentOf(x)) {
      const ctx = meaningfulLayerName(x.name, textOf(x), prefixes);
      if (ctx && ctx !== base && !WEAK_NAMES.test(ctx)) {
        q(`${ctx} / ${base}`);
        break;
      }
    }
    const text = sharedText(p.copies);
    if (
      text &&
      [
        "button",
        "link",
        "tag",
        "badge",
        "other",
        "search",
        "input",
        "select",
        "textarea",
        "checkbox",
        "radio",
        "toggle",
        "tabs",
      ].includes(p.kind)
    )
      q(`${base} / ${text}`);
    // a block by its heading: the first text every copy starts with ("List item / Tickets & Tarife")
    if (["list-item", "list", "card", "teaser", "navigation", "text"].includes(p.kind)) {
      const h = sharedHeading(p.copies);
      if (h) q(`${base} / ${h}`);
    }
    // what it holds, when twins differ in that ("Button / with icon", "List item / text only")
    const has = holds(first);
    if (!icon && p.kind !== "image") q(`${base} / ${has}`);
    // last resort before numbers: what the first copy's parent says it is ("Icon / Tickets & Tarife"), else the label
    // of the control it sits in ("Icon / Startseite" for the icon in the "Startseite" menu button)
    if (icon) {
      const d = parentDetail([first], parentOf) ?? parentLabel(p.copies, parentOf);
      if (d) q(`${base} / ${d}`);
    }
    return { key: p as object, cands };
  });
  return resolveNames(entries, taken);
}

/**
 * What a section is, from its structure: what it repeats and how ("Card grid", "Teaser slider", "Link list"), key
 * figures ("Stats band"), a form, a picture with copy ("Media"), a call to action, else plain "Text" / "Content".
 */
function sectionShape(el: SceneElement, ds: SceneDesignSystem): string {
  const sets = new Map<string, { n: number; holder: SceneElement }>();
  let media = 0,
    texts = 0,
    inputs = 0,
    controls = 0,
    figures = 0,
    scroll = false;
  const walk = (x: SceneElement, parent: SceneElement | null) => {
    if (x.meta?.hidden) return;
    if (parent && x.instance) {
      const s = sets.get(x.instance.componentId);
      sets.set(x.instance.componentId, { n: (s?.n ?? 0) + 1, holder: s?.holder ?? parent });
      const k = ds.componentSets?.find((d) => d.id === x.instance!.componentId)?.kind;
      if (k === "button" || k === "link") controls++;
      return;
    }
    if (x.layout?.scroll === "horizontal") scroll = true;
    if (x.type === "image" || x.type === "video" || x.image?.src)
      media +=
        (typeof x.layout?.width === "number" ? x.layout.width : 0) *
        (typeof x.layout?.height === "number" ? x.layout.height : 0);
    if (x.type === "text") {
      texts++;
      // a key figure: a short, big number ("4,5 Milliarden USD", "98 %")
      const t = (x.text ?? "").trim();
      if (t.length <= 24 && (x.style?.fontSize ?? 16) >= 28 && /^[^\p{L}\p{N}]{0,2}\d/u.test(t)) figures++;
    }
    if (x.type === "button") controls++;
    if (x.meta?.role === "input" || x.type === "input") inputs++;
    x.children?.forEach((c) => walk(c, x));
  };
  walk(el, null);
  const [topSet, top] = [...sets].sort((a, b) => b[1].n - a[1].n)[0] ?? ["", { n: 0, holder: el }];
  const kind = ds.componentSets?.find((d) => d.id === topSet)?.kind;
  if (top.n >= 2 && kind && kind !== "other" && kind !== "icon" && kind !== "button") {
    const h = top.holder.layout;
    return `${KIND_LABELS[kind]} ${scroll || h?.scroll === "horizontal" ? "slider" : h?.direction === "row" || h?.wrap ? "grid" : "list"}`;
  }
  if (figures >= 2) return "Stats band";
  if (inputs) return "Form";
  const w = typeof el.layout?.width === "number" ? el.layout.width : 0,
    h = typeof el.layout?.height === "number" ? el.layout.height : 0;
  if (media && (!w || media >= w * h * 0.3)) return texts ? "Media" : "Picture";
  if (figures) return "Key figure";
  if (controls && texts && texts <= 4) return "Call to action";
  return texts ? "Text" : "Content";
}

/** The colour word of a section's own band ("dark", "light", a hue), when it has one. */
function bandTone(el: SceneElement): string | null {
  const bg = el.style?.background;
  return bg && !/^(transparent|none)$/i.test(bg) && !/rgba\([^)]*,\s*0\)$/.test(bg) ? colorWord(bg) : null;
}

/**
 * Section names: Header, Footer, Hero, Menu; a content section by the name its layer gives it, else by what it is
 * ("Section / Card grid"). Sections that would share a name are told apart by their band's colour, then their heading
 * — page copy only ever as such a qualifier, never the name itself. `clash`: the name each one had to share (numbered).
 */
function nameSections(
  sets: Array<{ kind: SceneComponentKind; ids: SectionIdentity[] }>,
  ds: SceneDesignSystem,
  taken: Set<string>,
  prefixes: ReadonlySet<string>,
): { names: string[]; clash: Array<string | undefined> } {
  const entries = sets.map((s, i) => {
    const label = KIND_LABELS[s.kind];
    const el = s.ids[0]!.copies[s.ids[0]!.copies.length - 1]!.el;
    const lone = s.ids.length === 1;
    const shared = lone
      ? null
      : sharedLayerName(
          s.ids.flatMap((id) => id.copies.map((c) => c.el)),
          prefixes,
        );
    const layer = lone ? s.ids[0]!.layer : shared && !GENERIC_SECTION_NAMES.test(shared) ? shared : null;
    const heading = lone ? s.ids[0]!.heading : null;
    const shape = sectionShape(el, ds);
    const tone = bandTone(el);
    const overlayName =
      s.ids[0]!.overlay && s.ids.every((id) => id.page === s.ids[0]!.page)
        ? s.ids[0]!.page.split(" · ")
            .slice(1)
            .join(" · ")
            .replace(/^menu\s*›\s*/i, "")
            .trim()
        : "";
    const cands: string[] = [];
    const q = (c: string) => {
      if (!cands.includes(c)) cands.push(c);
    };
    // (alike sections made one set: what they show first; a lone one: the name its layer gives it)
    if (s.kind === "section") q(lone && layer ? `${label} / ${layer}` : `${label} / ${shape}`);
    else if (s.kind === "menu")
      q(overlayName && !/^menu$/i.test(overlayName) ? `${label} / ${overlayName}` : label);
    else q(label);
    if (layer) q(`${label} / ${layer}`);
    q(`${label} / ${shape}`);
    if (tone) q(`${label} / ${shape} / ${tone}`);
    if (heading) q(`${label} / ${shape} / ${heading}`);
    return { key: { i }, cands };
  });
  const { names, clash } = resolveNames(entries, taken);
  return { names: entries.map((e) => names.get(e.key)!), clash: entries.map((e) => clash.get(e.key)) };
}

/**
 * Pick names: every entry starts with its first candidate; entries whose name another one shares (or that is taken)
 * move on to their next candidate until nothing moves; names still shared are numbered — a defect, not a resolution:
 * `clash` has the shared name of every entry it applies to (the numbered ones and the one that kept it), so the naming
 * step knows they must get distinct semantic names.
 */
function resolveNames(
  entries: Array<{ key: object; cands: string[] }>,
  taken: Set<string>,
): { names: Map<object, string>; clash: Map<object, string> } {
  const norm = (s: string) => s.toLowerCase();
  const takenN = new Set([...taken].map(norm));
  const at = entries.map(() => 0);
  const nameOf = (i: number) => entries[i]!.cands[at[i]!]!;
  for (let round = 0; round < 12; round++) {
    const groups = new Map<string, number[]>();
    entries.forEach((_, i) => {
      const n = norm(nameOf(i));
      groups.set(n, [...(groups.get(n) ?? []), i]);
    });
    let moved = false;
    for (const [n, members] of groups) {
      if (members.length < 2 && !takenN.has(n)) continue;
      for (const i of members) {
        // the next candidate that tells this one apart: not one every other member of the clash offers too
        const others = members.filter((j) => j !== i).map((j) => new Set(entries[j]!.cands.map(norm)));
        let k = at[i]! + 1;
        while (
          k < entries[i]!.cands.length &&
          others.length &&
          others.every((o) => o.has(norm(entries[i]!.cands[k]!)))
        )
          k++;
        if (k < entries[i]!.cands.length) {
          at[i] = k;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  const out = new Map<object, string>(),
    clash = new Map<object, string>();
  const used = new Set(taken);
  const count = new Map<string, number>();
  entries.forEach((_, i) => count.set(norm(nameOf(i)), (count.get(norm(nameOf(i))) ?? 0) + 1));
  entries.forEach((e, i) => {
    const base = nameOf(i);
    const n = uniqueName(base, used);
    used.add(n);
    out.set(e.key, n);
    if (count.get(norm(base))! > 1 || takenN.has(norm(base))) clash.set(e.key, base);
  });
  return { names: out, clash };
}

/** The words after the role in a layer name every copy shares ("Icon · location pin" → "location pin"), else null. */
function detailOf(copies: SceneElement[]): string | null {
  const details = new Set(
    copies.map((el) =>
      el.name?.includes("·") ? el.name.split("·").slice(1).join("·").replace(/[_-]+/g, " ").trim() : "",
    ),
  );
  const d = details.size === 1 ? [...details][0]! : "";
  // not the layer's own text (an icon font's ligature), not a code key ("WCAG.ariaLabel.Close")
  const letters = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const own = letters(textOf(copies[0]!));
  if (
    !letters(d) ||
    /\S\.\S/.test(d) ||
    (own && (own.includes(letters(d)) || [...own].reverse().join("").includes(letters(d))))
  )
    return null;
  return !d.includes("…") && d.length <= 28 && d.split(/\s+/).length <= 4 ? d : null;
}

function uniqueName(base: string, taken: Set<string>): string {
  let n = base;
  for (let i = 2; [...taken].some((t) => t.toLowerCase() === n.toLowerCase()); i++) n = `${base} ${i}`;
  return n;
}
