// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Pure builders: export screens (IR) → file maps for the HTML zip and the React + Tailwind project.
import type { SceneDesignSystem, SceneInteraction } from "@harness/protocol";
import { EASING_PRESETS } from "../prototype/actions.js";
import type { IrElement } from "./ir.js";
import { escAttr, walkIr } from "./ir.js";
import { emitHtml, htmlDocument, BASE_CSS, type HtmlEmitOptions } from "./html.js";
import { buildReactProject } from "./reactProject.js";
import { createNamer, slugify } from "@harness/scene";
import { resolveVars, tokensCss, type FontFace, type VarMap } from "./tokens.js";
import {
  exportPages,
  fitZoomCss,
  capWideCss,
  widestMeasured,
  fluidVariants,
  pwlCss,
  variantMediaCss,
  type ResponsiveInfo,
} from "./responsive.js";
import { INTERACTIONS_CSS, interactionsJs, markInteractions, usesInteractions } from "./interactions.js";

export interface Credit {
  name: string;
  url: string;
  image: string;
}

/** One screen ready for export. Template screens come from the rendered DOM, DSL screens from their element tree. */
export interface ExportScreen {
  nodeId: string;
  /** DSL screen id (navigate targets may use it) */
  dslId?: string;
  name: string;
  width: number;
  height: number;
  ir: IrElement;
  /** custom properties the screen resolves against (design system + overrides) */
  vars: VarMap;
  credits: Credit[];
  flowStart?: boolean;
  /** 'web' pages export full-bleed, 'app' screens as a centred frame (default) */
  platform?: "app" | "web";
  /** breakpoint variant of a responsive page (docs/responsive.md): a group exports as one page */
  responsive?: ResponsiveInfo;
  /** document language (`<html lang>`) */
  lang?: string;
  /**
   * reflowed from a wider design for this width (dsl/adapt, docs/responsive.md "responsive by default"): the page
   * grows with its content instead of keeping the estimated screen height
   */
  adapted?: boolean;
  /** screens this one opens with `open-overlay` (the adapted page's menu), emitted into its page */
  overlays?: ExportScreen[];
  /**
   * only ever an overlay of this variant / screen (an imported page's menu, `root.meta.overlayOf`): the HTML bundle
   * emits it into that page (see withOverlayScreens) instead of as a page of its own
   */
  overlayOf?: string;
  /** height of the viewport the page was captured in (bottom-pinned layers keep their distance to its bottom edge) */
  viewportHeight?: number;
  /**
   * layers kept in place while the page scrolls (DSL `layout.scrollBehavior`) by DSL element id; absolute ones with
   * their captured top / height
   */
  pinned?: Record<string, { behavior: "fixed" | "sticky"; y?: number; h?: number }>;
  /**
   * the same variant measured at other widths of its layout range (URL capture, fromDsl measuredScreen): same tree,
   * the geometry the site has there. fluidVariants interpolates between them; the variant applies from its minWidth.
   */
  measured?: Array<{ width: number; ir: IrElement }>;
  /**
   * measured variants (URL capture): where the layers around each placed menu's opener sit at the design width and
   * every measured width — per overlay id, per ancestor of the opener (outermost first) `[viewport, left, width]`.
   * A menu cut out over one of them (an imported header's menu bar) follows that box (overlayPanelCss).
   */
  openerSpans?: Record<string, Array<Array<[number, number, number]>>>;
}

export type FileMap = Record<string, string | Uint8Array>;

export interface BundleOptions {
  semantic: boolean;
  cssVars: boolean;
  /** bundle data-URL images as files (true) or drop all images to placeholders (false) */
  images: boolean;
  attribution: boolean;
  /** design-system variables written to tokens.css */
  vars: VarMap;
  /** bundled font files (only when "include fonts" is on) */
  fonts?: Array<FontFace & { data: Uint8Array }>;
  projectName?: string;
  /** React: the design system whose component sets the screens' instances use (they become those components) */
  designSystem?: SceneDesignSystem;
}

/** Find the export screen a navigate target refers to (node id, DSL id, exact name or slug). */
export function matchScreen<T extends { nodeId: string; dslId?: string; name: string }>(
  target: string,
  screens: T[],
): T | undefined {
  const want = target.trim();
  const low = want.toLowerCase();
  return (
    screens.find((s) => s.nodeId === want) ??
    screens.find((s) => s.dslId === want) ??
    screens.find((s) => s.name.toLowerCase() === low) ??
    screens.find((s) => slugify(s.name) === slugify(want))
  );
}

/** Unique file slug per screen (`home.html`, `home-2.html`); every variant of a responsive group maps to its page. */
export function screenSlugs(screens: ExportScreen[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of exportPages(screens)) for (const s of p.screens) out.set(s.nodeId, p.slug);
  for (const s of screens)
    if (!out.has(s.nodeId))
      out.set(
        s.nodeId,
        out.get(
          screens.find((x) => x.responsive?.group === s.responsive?.group && out.has(x.nodeId))?.nodeId ?? "",
        ) ?? "screen",
      );
  return out;
}

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] ?? "application/octet-stream";
  const payload = m[3] ?? "";
  if (m[2]) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** Image rewriter: data URLs become files under `dir`, remote URLs stay, `images: false` → placeholder. */
function imageRewriter(files: FileMap, images: boolean, dir: string, publicDir = "", prefix = "") {
  const seen = new Map<string, string>();
  let n = 0;
  return (src: string): string | null => {
    if (!images) return null;
    if (!src.startsWith("data:")) return src;
    const hit = seen.get(src);
    if (hit) return hit;
    const d = decodeDataUrl(src);
    if (!d) return src;
    const path = `${dir}/image-${++n}.${EXT[d.mime] ?? "bin"}`;
    files[publicDir + path] = d.bytes;
    seen.set(src, prefix + path);
    return prefix + path;
  };
}

export function attributionMarkdown(screens: ExportScreen[], projectName = "this project"): string | null {
  const rows = new Map<string, Credit & { screens: string[] }>();
  for (const s of screens)
    for (const c of s.credits) {
      const key = c.url || c.name;
      const row = rows.get(key) ?? { ...c, screens: [] };
      if (!row.screens.includes(s.name)) row.screens.push(s.name);
      rows.set(key, row);
    }
  if (!rows.size) return null;
  const lines = [...rows.values()].map(
    (r) =>
      `- **${r.name}** — ${r.url ? `[${r.url}](${r.url}?utm_source=cdr&utm_medium=referral)` : "Unsplash"} · ${r.image} (${r.screens.join(", ")})`,
  );
  return `# Photo credits\n\nPhotos in ${projectName} are from [Unsplash](https://unsplash.com/?utm_source=cdr&utm_medium=referral).\n\n${lines.join("\n")}\n`;
}

const NAV_JS = `// Follows prototype links between the exported pages.
document.addEventListener('click', function (e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-href],[data-back],[data-url]') : null
  if (!t) return
  e.preventDefault()
  if (t.hasAttribute('data-href')) location.href = t.getAttribute('data-href')
  else if (t.hasAttribute('data-back')) history.back()
  else window.open(t.getAttribute('data-url'), '_blank', 'noopener')
})
`;

const hasInteractions = (ir: IrElement) => {
  let any = false;
  walkIr(ir, (n) => {
    if (n.interaction) any = true;
  });
  return any;
};

const OVERLAY_JS = `// Opens / closes the page's menus (an imported site's menu panel, the menu of a page reflowed for small screens).
document.addEventListener('click', function (e) {
  var t = e.target && e.target.closest ? e.target : null
  if (!t) return
  var open = t.closest('[data-open-overlay],[data-swap-overlay]')
  if (open) {
    // every breakpoint variant carries its own copy of the menu: open the one in the opener's variant
    var swap = open.hasAttribute('data-swap-overlay')
    var o = (open.closest('[data-bp]') || document).querySelector('[data-overlay="' + open.getAttribute(swap ? 'data-swap-overlay' : 'data-open-overlay') + '"]')
    if (o) {
      e.preventDefault()
      // a menu's next level replaces the level it was opened from
      var from = swap ? open.closest('[data-overlay]') : null
      if (from && from !== o) closeOverlay(from, true)
      if (!o.hasAttribute('data-open')) { o.hidden = false; o.offsetWidth; o.setAttribute('data-open', '') }
      return
    }
  }
  var layer = t.closest('[data-overlay]')
  // a tap outside the panel (on the layer around it) closes the menu, unless it asks not to
  if (layer && (t.closest('[data-close-overlay]') || (t === layer && !layer.hasAttribute('data-modal')))) { e.preventDefault(); closeOverlay(layer) }
})
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return
  var open = document.querySelectorAll('[data-overlay][data-open]')
  if (open.length) closeOverlay(open[open.length - 1])
})
function closeOverlay(o, now) {
  o.removeAttribute('data-open')
  if (now) { o.hidden = true; return }
  var ms = parseFloat(getComputedStyle(o).transitionDuration) * 1000
  setTimeout(function () { if (!o.hasAttribute('data-open')) o.hidden = true }, (ms >= 0 ? ms : 300) + 20)
}
`;

/** Enter edge of an overlay → panel placement + the transform it slides in from. */
export const OVERLAY_ENTER: Record<string, { justify: string; align: string; from: string }> = {
  right: { justify: "flex-end", align: "stretch", from: "translateX(100%)" },
  left: { justify: "flex-start", align: "stretch", from: "translateX(-100%)" },
  top: { justify: "center", align: "flex-start", from: "translateY(-100%)" },
  bottom: { justify: "center", align: "flex-end", from: "translateY(100%)" },
  fade: { justify: "center", align: "center", from: "none" },
};

const OVERLAY_CSS = `/* Overlays (the pages' menus) */
[data-overlay] { position: fixed; inset: 0; z-index: 100000; display: flex; background: rgba(0, 0, 0, 0.4); opacity: 0; transition: opacity 300ms ease-out; }
[data-overlay][hidden] { display: none; }
[data-overlay][data-open] { opacity: 1; }
[data-overlay] > [data-overlay-panel] { height: 100%; max-width: 100%; overflow-y: auto; transition: transform 300ms cubic-bezier(0, 0, 0.58, 1); transition-duration: inherit; }
[data-overlay][data-open] > [data-overlay-panel] { transform: none; }
[data-overlay-panel] > main { height: 100%; min-height: 100%; }
[data-overlay][data-placed] > [data-overlay-panel] { position: absolute; height: auto; overflow-x: hidden; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18); }
[data-overlay][data-placed] > [data-overlay-panel] > main { min-height: 0; }
[data-overlay][data-cutout] > [data-overlay-panel] { border-radius: 0; box-shadow: none; }
:where([data-open-overlay], [data-swap-overlay], [data-close-overlay]) { cursor: pointer; }
@media (prefers-reduced-motion: reduce) { [data-overlay], [data-overlay] > [data-overlay-panel] { transition: none; } }`;

/** Edge each bundled overlay of `s` enters from (its opener's `overlay.enter`, default right). */
export function overlayEnters(s: ExportScreen): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, i] of overlayOpeners(s)) out.set(id, i.overlay?.enter ?? "right");
  return out;
}

/** The interaction that opens each bundled overlay of `s` (open- or swap-overlay; the first one found wins). */
export function overlayOpeners(s: ExportScreen): Map<string, SceneInteraction> {
  const list = s.overlays ?? [];
  const ids = new Set(list.map((o) => o.dslId ?? o.nodeId));
  const out = new Map<string, SceneInteraction>();
  const visit = (ir: IrElement) => {
    const parents = new Map<IrElement, IrElement | null>();
    walkIr(ir, (n, parent) => {
      parents.set(n, parent);
      const i = n.interaction;
      if (!(
        (i?.onTap === "open-overlay" || i?.onTap === "swap-overlay") &&
        i.target &&
        ids.has(i.target) &&
        !out.has(i.target)
      ))
        return;
      out.set(i.target, i);
      if (inCentredColumn(n, parents)) centredOpeners.add(i);
    });
  };
  visit(s.ir);
  for (const o of list) visit(o.ir);
  return out;
}

/** Openers (their interaction objects, as overlayOpeners returns them) that sit in a fixed-width centred column. */
const centredOpeners = new WeakSet<SceneInteraction>();

/**
 * The element lies in a content column of fixed width that its parent centres (the max-width column of a full-bleed
 * header): it moves with the viewport's centre, not with an edge.
 */
function inCentredColumn(n: IrElement, parents: Map<IrElement, IrElement | null>): boolean {
  for (let a = parents.get(n); a; a = parents.get(a)) {
    const p = parents.get(a);
    if (!p || p.tag === "main") return false;
    const fixedW = /^\d+(\.\d+)?px$/.test(a.style.width ?? "") && !a.style["flex-grow"];
    const row = (p.style["flex-direction"] ?? "row") === "row";
    if (
      fixedW &&
      p.style.display === "flex" &&
      (row ? p.style["justify-content"] : p.style["align-items"]) === "center"
    )
      return true;
    if (a.style.position === "absolute" && /calc\(50%/.test(a.style.left ?? "")) return true;
  }
  return false;
}

/** CSS easing of an interaction (SceneEasing presets / bezier; `fallback` when it sets none). */
export function easingCss(e: SceneInteraction["easing"], fallback = "ease-out"): string {
  if (!e) return fallback;
  if (typeof e === "string")
    return e === "linear" || e === "ease-in" || e === "ease-out" || e === "ease-in-out"
      ? e
      : `cubic-bezier(${EASING_PRESETS[e].join(", ")})`;
  return `cubic-bezier(${e.bezier.join(", ")})`;
}

/**
 * Where an overlay placed in the page's coordinates sits: the opener's settings + the opening page's design width.
 * `centred`: the opener sits in a centred fixed-width column (default: as overlayOpeners found it).
 */
export interface OverlayPlacement {
  interaction?: SceneInteraction;
  pageWidth: number;
  height: number;
  centred?: boolean;
  /** the page reflows (fluidVariants) down to this width: the panel's content too, scaled only below it */ fluid?: number;
  /** the width the opening variant applies from (a variant that reflows down to it is never scaled) */
  minWidth?: number;
  /** the opener's ancestors measured across the variant's range (ExportScreen.openerSpans of this overlay) */
  spans?: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>;
}

/** A panel at least this share of the page wide (phone / tablet menus) stretches with the page. */
const STRETCH_SHARE = 0.6;

const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;
const vw = (v: number) => `${Math.round(v * 10000) / 100}vw`;
const px = (v: number) => `${Math.round(v * 100) / 100}px`;
/** `d` px at the design width W and wider, scaled down with the page below it */
const scaled = (d: number, W: number) =>
  d === 0 ? "0px" : `${d > 0 ? "min" : "max"}(${px(d)}, ${vw(d / W)})`;

/**
 * Placement, width and entrance of one overlay panel (`sel` selects the overlay layer). With `place`: the opener's
 * background (dim / none), duration and easing; a `manual` / `top-left` overlay (an imported site's dropdown panel) is
 * cut out at its captured box in the page's coordinates and keeps its own height. A wide one (≥ 60 % of the page: a
 * phone / tablet menu) stretches with the page (its share of the width); a narrower one keeps its px width and its
 * distance to what it was captured beside: the viewport's centre when its opener sits in a centred column (a
 * max-width header), else the nearer edge. Below the page's design width everything scales down with the page.
 * One cut out exactly over a layer around its opener that was measured across the variant's range (`spans`: an
 * imported header's menu bar over the header) follows that layer's measured box instead, past the widest variant too.
 */
export function overlayPanelCss(
  sel: string,
  width: number,
  enter: string | undefined,
  place?: OverlayPlacement,
): string {
  const e = OVERLAY_ENTER[enter ?? "right"] ?? OVERLAY_ENTER.right!;
  const i = place?.interaction;
  const set = i?.overlay;
  const lines: string[] = [];
  const layer: string[] = [];
  if (set?.background !== undefined)
    layer.push(`background: ${set.background === "none" ? "transparent" : set.background};`);
  if (set?.blur)
    layer.push(`-webkit-backdrop-filter: blur(${set.blur}px);`, `backdrop-filter: blur(${set.blur}px);`);
  if (i?.duration !== undefined || i?.easing !== undefined)
    layer.push(
      `transition-duration: ${set?.enter === "none" ? 0 : Math.max(0, Math.min(5000, i.duration ?? 300))}ms;`,
      `transition-timing-function: ${easingCss(i.easing)};`,
    );
  const pos = set?.position;
  const W = place?.pageWidth ?? 0;
  if (place && W > 0 && (pos === "manual" || pos === "top-left")) {
    const x = pos === "manual" ? (set?.offset?.x ?? 0) : 0;
    const y = pos === "manual" ? (set?.offset?.y ?? 0) : 0;
    const top = y > 0 ? `min(${Math.round(y * 100) / 100}px, ${vw(y / W)})` : "0px";
    // touching two edges or more (a drawer, a full-width sheet): square corners, no shadow
    const docked = [x <= 0.5, y <= 0.5, x + width >= W - 0.5].filter(Boolean).length >= 2;
    lines.push(`${sel} { ${layer.join(" ")} }`.replace("{  }", "{ }"));
    let box: string;
    // cut out over a layer around its opener (the header's menu bar): that layer's measured box at every width
    const over = place.spans?.find(
      (t) =>
        t.length > 1 && t.some(([v, l, w]) => v === W && Math.abs(l - x) <= 1 && Math.abs(w - width) <= 1),
    );
    if (over) {
      const left = pwlCss(
          over.map(([v, l]) => [v, l]),
          W,
        ),
        w = pwlCss(
          over.map(([v, , b]) => [v, b]),
          W,
        );
      box = `left: ${left ?? px(x)}; width: ${w ?? px(width)};`;
    } else if (width >= W * STRETCH_SHARE)
      box = `left: ${pct(x / W)}; width: ${pct(Math.min(1, width / W))};`;
    else {
      const w = `width: ${scaled(width, W)};`;
      if (place.centred ?? (i ? centredOpeners.has(i) : false))
        box = `left: calc(50% + ${scaled(x - W / 2, W)}); ${w}`;
      else if (x + width / 2 > W / 2)
        box = `left: auto; right: ${scaled(Math.max(0, W - x - width), W)}; ${w}`;
      else box = `left: ${scaled(x, W)}; ${w}`;
    }
    lines.push(
      `${sel} > [data-overlay-panel] { ${box} top: ${top}; max-height: calc(100% - ${top});${docked ? " border-radius: 0; box-shadow: none;" : ""}${e.from === "none" ? "" : ` transform: ${e.from};`} }`,
    );
    lines.push(
      // scaled below the width the page reflows down to; a page that reflows at every width (fluid 0) never is
      `${sel} > [data-overlay-panel] > main { height: ${Math.round(place.height * 100) / 100}px;${(place.fluid ?? W) > 0 && (place.fluid ?? W) > (place.minWidth ?? 0) ? ` zoom: min(1, calc(100vw / ${Math.round(place.fluid ?? W)}px));` : ""} }`,
    );
    lines.push(`${sel}[data-open] > [data-overlay-panel] { transform: none; }`);
    return lines.filter((l) => !l.endsWith("{ }")).join("\n");
  }
  if (layer.length) lines.push(`${sel} { ${layer.join(" ")} }`);
  lines.push(
    `${sel} { justify-content: ${e.justify}; align-items: ${e.align}; }`,
    `${sel} > [data-overlay-panel] { width: ${Math.round(width)}px;${e.from === "none" ? "" : ` transform: ${e.from};`} }`,
    `${sel}[data-open] > [data-overlay-panel] { transform: none; }`,
  );
  return lines.join("\n");
}

/**
 * Overlay screens (`overlayOf`: an imported page's menu and its next levels) join the variant / screen they belong
 * to as its `overlays`, so the page's menu button opens them in place; one whose page is not exported stays a page.
 */
export function withOverlayScreens(screens: ExportScreen[]): ExportScreen[] {
  const ownerOf = (s: ExportScreen) =>
    s.overlayOf
      ? screens.find((x) => !x.overlayOf && (x.dslId === s.overlayOf || x.nodeId === s.overlayOf))
      : undefined;
  const add = new Map<ExportScreen, ExportScreen[]>();
  for (const s of screens) {
    const o = ownerOf(s);
    if (o) add.set(o, [...(add.get(o) ?? []), s]);
  }
  if (!add.size) return screens;
  return screens.flatMap((s) =>
    ownerOf(s) ? [] : add.has(s) ? [{ ...s, overlays: [...(s.overlays ?? []), ...add.get(s)!] }] : [s],
  );
}

/**
 * Marks every screen's IR and its overlays' for the interactions runtime (export/interactions.ts; in place, the IR is
 * built for the export). True when a page needs it: a slider, a region with states, or a menu.
 */
export function withInteractionMarks(screens: ExportScreen[]): boolean {
  let uses = false;
  for (const s of screens) {
    for (const x of [s, ...(s.overlays ?? [])]) {
      markInteractions(x.ir);
      if (x !== s || usesInteractions(x.ir)) uses = true;
    }
    markOverlayTaps(s);
  }
  return uses;
}

/**
 * The menu controls of a page and its menus name the menu they open / swap to (`data-open-overlay`, `data-swap-overlay`
 * = its id) or close (`data-close-overlay`): OVERLAY_JS follows them in the HTML bundle; in the React project the screen
 * component's state does, and they tell which button opens which menu.
 */
function markOverlayTaps(s: ExportScreen) {
  const list = s.overlays ?? [];
  if (!list.length) return;
  const ids = new Set(list.map((o) => o.dslId ?? o.nodeId));
  const mark = (n: IrElement) => {
    const i = n.interaction;
    if ((i?.onTap === "open-overlay" || i?.onTap === "swap-overlay") && i.target && ids.has(i.target))
      n.attrs = {
        ...n.attrs,
        [i.onTap === "swap-overlay" ? "data-swap-overlay" : "data-open-overlay"]: i.target,
      };
    if (i?.onTap === "close-overlay") n.attrs = { ...n.attrs, "data-close-overlay": "" };
  };
  for (const x of [s, ...list]) walkIr(x.ir, mark);
}

/** Height of the viewport a page of this width was captured in when the design does not say (fig-server defaults). */
export const captureViewportHeight = (w: number) => (w < 600 ? 844 : w < 1024 ? 1024 : 1000);

/**
 * The screen's IR with its pinned layers (`pinned`, the header / chat button of an imported page) kept in place while
 * the page scrolls: absolute layers of the page root become `position: fixed` (over the page's content; in the lower
 * half of the captured viewport they keep their distance to its bottom edge instead), flow ones `sticky`. A copy when
 * anything is pinned (the IR may be shared with other bundles).
 */
export function pinnedIr(s: ExportScreen): IrElement {
  const pins = s.pinned;
  if (!pins || !Object.keys(pins).length) return s.ir;
  const ir = structuredClone(s.ir);
  const vh = s.viewportHeight ?? captureViewportHeight(s.width);
  // the screen's `main` wraps the page root
  const root = ir.children.find((c): c is IrElement => c.kind === "el");
  const layers = (root?.children ?? []).filter((c): c is IrElement => c.kind === "el");
  const zOf = (n: IrElement) => Number.parseInt(n.style["z-index"] ?? "", 10) || 0;
  const isFixed = (n: IrElement) =>
    !!n.id && pins[n.id]?.behavior === "fixed" && n.style.position === "absolute";
  // captured paint order, except that a fixed layer comes over content that ties with it (it scrolls under it)
  if (layers.some(isFixed))
    for (const n of layers)
      if (n.style["z-index"] !== undefined && /^-?\d+$/.test(n.style["z-index"]))
        n.style = { ...n.style, "z-index": String(zOf(n) * 2 + (isFixed(n) ? 1 : 0)) };
  let sticky = false;
  // (a pinned layer inside a wrapper of the page root too: a masthead in its container; never inside a pinned one)
  const pinnedLayers: IrElement[] = [];
  const collect = (n: IrElement) => {
    for (const c of n.children) {
      if (c.kind !== "el") continue;
      if (c.id && pins[c.id]) pinnedLayers.push(c);
      else collect(c);
    }
  };
  if (root) collect(root);
  for (const n of pinnedLayers) {
    const p = n.id ? pins[n.id] : undefined;
    if (!p) continue;
    // a pinned layer in the page's flow (a sticky header the import kept in flow) sticks to the top as it scrolls
    if (p.behavior === "sticky" || n.style.position !== "absolute") {
      if (n.style.position !== "absolute") {
        n.style = { ...n.style, position: "sticky", top: n.style.top ?? "0px" };
        sticky = true;
      }
      continue;
    }
    const style: Record<string, string> = { ...n.style, position: "fixed" };
    const bottom = p.y !== undefined && p.h ? vh - p.y - p.h : -1;
    if (p.y !== undefined && p.h && p.y + p.h / 2 > vh / 2 && bottom >= 0) {
      delete style.top;
      style.bottom = `${Math.round(bottom * 100) / 100}px`;
    }
    n.style = style;
  }
  // a sticky layer sticks to the nearest scroll container: the page's clipping boxes clip without being one
  if (sticky)
    for (const box of [ir, root])
      if (box && /^(hidden|auto)$/.test(box.style.overflow ?? ""))
        box.style = { ...box.style, overflow: "clip" };
  return ir;
}

/** Reflowed variants grow with their content (`main` selects the variant's screen root). */
export const adaptedCss = (main: string) =>
  `${main} { height: auto; min-height: 100vh; }\n${main} > * { height: auto; min-height: 100vh; }`;

/**
 * Overlays a variant opens, as layers after it (its openers / close buttons are marked by markOverlayTaps).
 */
function overlayMarkup(
  s: ExportScreen,
  depth: number,
  emit: (o: ExportScreen, depth: number) => string,
  rules: string[],
  scope: string,
): string {
  const list = s.overlays ?? [];
  if (!list.length) return "";
  const openers = overlayOpeners(s);
  const pad = "  ".repeat(depth);
  return list
    .map((o) => {
      const id = o.dslId ?? o.nodeId;
      const i = openers.get(id);
      const placed = i?.overlay?.position === "manual" || i?.overlay?.position === "top-left";
      rules.push(
        overlayPanelCss(
          `${scope} [data-overlay="${id}"]`,
          o.width,
          i?.overlay?.enter ?? "right",
          i
            ? {
                interaction: i,
                pageWidth: s.width,
                height: o.height,
                fluid: s.responsive?.fluid,
                minWidth: s.responsive?.minWidth,
                spans: s.openerSpans?.[id],
              }
            : undefined,
        ),
      );
      // an imported page's menu is cut out of the page with its own card (shadow, corners): no frame of ours around it
      const attrs = `${placed ? " data-placed" : ""}${o.overlayOf ? " data-cutout" : ""}${i?.overlay?.closeOnOutsideClick === false ? " data-modal" : ""}`;
      return `${pad}<div data-overlay="${id}"${attrs} role="dialog" aria-modal="true" aria-label="${escAttr(o.name)}" hidden>\n${pad}  <div data-overlay-panel>\n${emit(o, depth + 2)}\n${pad}  </div>\n${pad}</div>`;
    })
    .join("\n");
}

/**
 * HTML + CSS bundle: one page per screen (one per responsive group: every variant wrapped in `<div data-bp>`, @media
 * rules show one per viewport range), shared tokens.css + styles.css, index.html linking every page.
 */
export function buildHtmlFiles(all: ExportScreen[], o: BundleOptions): FileMap {
  const screens = withOverlayScreens(fluidVariants(all));
  const usesRuntime = withInteractionMarks(screens);
  const files: FileMap = {};
  const namer = createNamer();
  const pages = exportPages(screens);
  const slugs = screenSlugs(screens);
  const rewrite = imageRewriter(files, o.images, "assets");
  const rules: string[] = [];
  const usesNav = screens.some((s) => hasInteractions(s.ir));
  const usesOverlays = screens.some((s) => s.overlays?.length);
  const fonts = o.fonts ?? [];
  for (const f of fonts) files[f.file] = f.data;
  for (const page of pages) {
    // the widest variant (and the menus it opens) never extrapolates past its widest measurement: every viewport
    // term of its rules stops there; capWideCss centres that layout on wider screens
    const widest = page.screens[page.screens.length - 1]!;
    const webPage = page.screens.every((x) => x.platform === "web");
    // (a variant measured across its range — URL capture, flow — continues the page's own lines past its widest
    // measurement: a centred column keeps centring, a full-bleed band keeps spanning; no cap)
    const flows = !!(widest as ExportScreen & { measured?: unknown[] }).measured?.length;
    const capAt = webPage && !flows ? widestMeasured(widest) : 0;
    let current: ExportScreen | null = null;
    const capVw = (r: string) =>
      capAt > 0 && current === widest ? r.replace(/100vw/g, `min(100vw, ${capAt}px)`) : r;
    const emitOne = (s: ExportScreen, depth: number, ir = s.ir) => {
      const out = emitHtml(
        ir,
        {
          semantic: o.semantic,
          cssVars: o.cssVars,
          vars: s.vars,
          namer,
          interactions: "links",
          imageSrc: rewrite,
          resolveTarget: (t) => {
            const m = matchScreen(t, screens);
            return m ? `${slugs.get(m.nodeId)}.html` : null;
          },
        } satisfies HtmlEmitOptions,
        depth,
      );
      rules.push(`/* ${s.name} */`, ...out.rules.map(capVw));
      return out.html;
    };
    const first = page.screens[0]!;
    const variant = (s: ExportScreen, depth: number) => {
      current = s;
      const ir = pinnedIr(s);
      const overlays = overlayMarkup(
        s,
        depth,
        emitOne,
        rules,
        `body[data-page="${page.slug}"]${page.responsive ? ` > [data-bp="${s.responsive!.minWidth}"]` : ""}`,
      );
      return [emitOne(s, depth, ir), overlays].filter(Boolean).join("\n");
    };
    const body = page.responsive
      ? page.screens
          .map((s) => `  <div data-bp="${s.responsive!.minWidth}">\n${variant(s, 2)}\n  </div>`)
          .join("\n")
      : variant(first, 1);
    const scope = `body[data-page="${page.slug}"]`;
    const web = page.screens.every((s) => s.platform === "web");
    if (page.responsive)
      rules.push(`/* ${page.name}: one variant per viewport range */`, variantMediaCss(page, scope));
    // reflowed variants: the page is as tall as its content (the screen height is only an estimate)
    for (const s of page.screens)
      if (s.adapted)
        rules.push(
          `/* ${s.name}: reflowed for this width, grows with its content */\n${adaptedCss(`${scope} > [data-bp="${s.responsive?.minWidth ?? 0}"] > main`)}`,
        );
    if (web)
      rules.push(
        `/* ${page.name}: narrower than designed → scaled to fit */`,
        fitZoomCss(page, (min) =>
          page.responsive ? `${scope} > [data-bp="${min}"] > main` : `${scope} > main`,
        ),
      );
    const widestFlows = !!(page.screens[page.screens.length - 1] as ExportScreen & { measured?: unknown[] })
      .measured?.length;
    if (web && !widestFlows)
      rules.push(
        `/* ${page.name}: wider than ever measured → the widest measured layout, centred */`,
        capWideCss(page, (min) =>
          page.responsive ? `${scope} > [data-bp="${min}"] > main` : `${scope} > main`,
        ),
      );
    files[`${page.slug}.html`] = htmlDocument({
      title: page.name,
      body,
      lang: first.lang,
      stylesheets: ["tokens.css", "styles.css"],
      scripts: usesNav || usesOverlays || usesRuntime ? ["nav.js"] : [],
      bodyAttrs: { "data-page": page.slug, ...(web ? {} : { "data-frame": "" }) },
    });
  }
  files["tokens.css"] = tokensCss(o.vars, fonts);
  if (usesRuntime) rules.unshift(INTERACTIONS_CSS);
  if (usesOverlays) rules.unshift(OVERLAY_CSS);
  files["styles.css"] = `${o.cssVars ? BASE_CSS : resolveVars(BASE_CSS, o.vars)}\n${rules.join("\n\n")}\n`;
  if (usesNav || usesOverlays || usesRuntime)
    files["nav.js"] =
      (usesNav ? NAV_JS : "") +
      (usesOverlays ? OVERLAY_JS : "") +
      (usesRuntime ? `\n${interactionsJs()}` : "");
  const list = pages
    .map(
      (p) =>
        `    <li><a href="${p.slug}.html">${escapeText(p.name)}</a> <small>${p.screens.map((s) => `${s.width} × ${s.height}`).join(", ")}</small></li>`,
    )
    .join("\n");
  files["index.html"] = htmlDocument({
    title: o.projectName ?? "Screens",
    inlineCss:
      "    body { display: block; font: 15px/1.5 system-ui, sans-serif; color: #ededef; background: #0b0b0d; padding: 48px; margin: 0; min-height: 100vh; }\n    a { color: #7cc4ff; }\n    small { color: #888; margin-left: 8px; }",
    stylesheets: ["tokens.css"],
    body: `  <h1>${escapeText(o.projectName ?? "Screens")}</h1>\n  <ul>\n${list}\n  </ul>`,
  });
  if (o.attribution) {
    const md = attributionMarkdown(screens, o.projectName);
    if (md) files["ATTRIBUTION.md"] = md;
  }
  return files;
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** React + Tailwind project (runnable Vite app) — see reactProject.ts. */
export function buildReactFiles(screens: ExportScreen[], o: BundleOptions): FileMap {
  return buildReactProject(fluidVariants(screens), o);
}
