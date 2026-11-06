// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Pure design → export files (no DOM, no store): the in-app HTML export (run.ts) and Node tooling (the export eval,
// through Vite SSR) build the same files from the same inputs. docs/responsive.md "Export API".
import type {
  SceneDesignSystem,
  SceneElement,
  SceneLayout,
  SceneScreen,
  SceneTokens,
} from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { directionOf } from "@harness/scene";
import { fontFamiliesIn, projectFontFiles, type ProjectFont } from "@harness/scene";
import { creditsOf, dslScreenToIr, measuredScreen } from "./fromDsl.js";
import {
  buildHtmlFiles,
  buildReactFiles,
  type BundleOptions,
  type ExportScreen,
  type FileMap,
} from "./bundle.js";
import { tokenVars } from "./tokens.js";

/** A design file (`pnpm import:url` design.json / import.dsl.json, or a project's DSL screens + fonts). */
export interface DesignInput {
  name?: string;
  screens: SceneScreen[];
  /** the page's own webfonts (ProjectFont with `data:` src) */
  fonts?: readonly ProjectFont[];
  /** the design system the screens' instances belong to (the React export draws them with its sets' components) */
  designSystem?: SceneDesignSystem;
}

export interface DesignExportOptions extends Partial<Omit<BundleOptions, "vars" | "fonts">> {
  /** design-system tokens the screens resolve against (default DEFAULT_TOKENS, like the eval renderer) */
  baseTokens?: Partial<SceneTokens>;
  /** bundle the design's fonts (default true) */
  includeFonts?: boolean;
  /** extra font files (e.g. the bundled Inter) added next to the design's own */
  extraFonts?: BundleOptions["fonts"];
  /** responsive by default: reflowed phone / tablet variants for web pages without them (default true) */
  adapt?: boolean;
}

/** One DSL screen ready for the bundlers (`nodeId` / frame size default to the screen's own). */
export function dslExportScreen(
  screen: SceneScreen,
  o: {
    baseTokens?: Partial<SceneTokens>;
    nodeId?: string;
    name?: string;
    size?: { w: number; h: number };
  } = {},
): ExportScreen {
  const w = o.size?.w ?? screen.width,
    h = o.size?.h ?? screen.height;
  const sir = dslScreenToIr(screen, { baseTokens: o.baseTokens, size: { w, h } });
  const out: ExportScreen = {
    nodeId: o.nodeId ?? screen.id,
    dslId: screen.id,
    name: o.name ?? screen.name,
    width: w,
    height: h,
    ir: sir.root,
    vars: sir.vars,
    credits: creditsOf(screen),
    flowStart: screen.root.meta?.flowStart === true,
    platform: screen.platform,
  };
  if (screen.responsive && typeof screen.responsive.group === "string")
    out.responsive = { group: screen.responsive.group, minWidth: Number(screen.responsive.minWidth) || 0 };
  // measured at other widths of its layout range (URL capture): the same tree with the geometry measured there
  const at = (screen.responsive?.measured ?? []).filter(
    (x) => Number.isFinite(x) && x > 0 && Math.round(x) !== Math.round(screen.width),
  );
  if (out.responsive && at.length && screen.platform === "web") {
    const ms = at.map((x) => measuredScreen(screen, x));
    out.measured = ms.map((m) => ({
      width: m.width,
      ir: dslScreenToIr(m, { baseTokens: o.baseTokens, size: { w: m.width, h: m.height } }).root,
    }));
    const spans = openerSpans([screen, ...ms]);
    if (Object.keys(spans).length) out.openerSpans = spans;
  }
  if (screen.lang) out.lang = screen.lang;
  const meta = screen.root.meta;
  if (typeof meta?.overlayOf === "string" && meta.overlayOf) out.overlayOf = meta.overlayOf;
  if (typeof meta?.viewportHeight === "number" && meta.viewportHeight > 0)
    out.viewportHeight = meta.viewportHeight;
  const pinned = pinnedLayers(screen);
  if (Object.keys(pinned).length) out.pinned = pinned;
  return out;
}

/**
 * ExportScreen.openerSpans: the screen and the same tree measured at other widths (`views`, the screen first). For
 * every placed menu opener, each of its ancestors' `[viewport, left, width]` at every width, as far down the chain
 * as the layout fixes their boxes at all of them.
 */
function openerSpans(views: SceneScreen[]): NonNullable<ExportScreen["openerSpans"]> {
  const out: NonNullable<ExportScreen["openerSpans"]> = {};
  const visit = (e: SceneElement, path: number[]) => {
    const i = e.interaction;
    const placed = i?.overlay?.position === "manual" || i?.overlay?.position === "top-left";
    if (
      (i?.onTap === "open-overlay" || i?.onTap === "swap-overlay") &&
      i.target &&
      placed &&
      !out[i.target]
    ) {
      const per = views.map((v) => ancestorSpans(v.root, path, v.width));
      const n = Math.min(...per.map((p) => p.length));
      if (n)
        out[i.target] = Array.from({ length: n }, (_, a) =>
          per.map((p, k): [number, number, number] => [views[k]!.width, p[a]![0], p[a]![1]]),
        );
    }
    e.children?.forEach((c, k) => visit(c, [...path, k]));
  };
  visit(views[0]!.root, []);
  return out;
}

const sides = (v: SceneLayout["padding"] | SceneLayout["margin"]): [number, number, number, number] =>
  v === undefined
    ? [0, 0, 0, 0]
    : typeof v === "number"
      ? [v, v, v, v]
      : v.length === 2
        ? [v[0], v[1], v[0], v[1]]
        : v;

/** `[left, width]` of the root (`W` wide) and of each ancestor on `path` (child indices down to an element). */
function ancestorSpans(root: SceneElement, path: number[], W: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[0, W]];
  let e = root;
  for (const k of path.slice(0, -1)) {
    const c = e.children?.[k];
    const s = c ? childSpan(e, c, out[out.length - 1]!) : null;
    if (!c || !s) break;
    out.push(s);
    e = c;
  }
  return out;
}

/** Where child `c` sits horizontally in `p` (at `left`, `width` wide), when its layout fixes it (null otherwise). */
function childSpan(
  p: SceneElement,
  c: SceneElement,
  [left, width]: [number, number],
): [number, number] | null {
  const l = c.layout ?? {},
    pl = p.layout ?? {};
  const w = typeof l.width === "number" ? l.width : null;
  if (l.position === "absolute") {
    const cw = w ?? (typeof l.x === "number" && typeof l.right === "number" ? width - l.x - l.right : null);
    const x =
      typeof l.x === "number"
        ? l.x
        : typeof l.right === "number" && cw !== null
          ? width - l.right - cw
          : null;
    return x === null || cw === null ? null : [left + x, cw];
  }
  if (pl.grid) return null;
  const pad = sides(pl.padding),
    m = sides(l.margin);
  const x0 = left + pad[3] + m[3],
    room = width - pad[1] - pad[3] - m[1] - m[3];
  let at: string;
  if (directionOf(p) === "row") {
    // along a row only a lone flow child's box follows from its parent's
    if ((p.children ?? []).filter((x) => x.layout?.position !== "absolute").length !== 1) return null;
    if (l.width === "fill") return [x0, typeof l.maxWidth === "number" ? Math.min(room, l.maxWidth) : room];
    at =
      pl.justify === "center" || pl.justify === "around" || pl.justify === "evenly"
        ? "center"
        : pl.justify === "end"
          ? "end"
          : "start";
  } else {
    at = l.alignSelf && l.alignSelf !== "auto" ? l.alignSelf : (pl.align ?? "stretch");
    if (l.width === "fill" || (l.width === undefined && at === "stretch"))
      return [x0, typeof l.maxWidth === "number" ? Math.min(room, l.maxWidth) : room];
  }
  if (w === null) return null;
  return at === "center" ? [x0 + (room - w) / 2, w] : at === "end" ? [x0 + room - w, w] : [x0, w];
}

/** Layers kept in place while the page scrolls (`layout.scrollBehavior`) by DSL id, with their captured box. */
function pinnedLayers(screen: SceneScreen): NonNullable<ExportScreen["pinned"]> {
  const out: NonNullable<ExportScreen["pinned"]> = {};
  const visit = (e: SceneElement) => {
    const l = e.layout;
    if (l?.scrollBehavior === "fixed" || l?.scrollBehavior === "sticky") {
      out[e.id] = {
        behavior: l.scrollBehavior,
        ...(l.position === "absolute"
          ? { y: Number(l.y) || 0, h: typeof l.height === "number" ? l.height : 0 }
          : {}),
      };
    }
    e.children?.forEach(visit);
  };
  screen.root.children?.forEach(visit);
  return out;
}

/**
 * The earlier project reflows web pages without a phone variant (dsl/adapt). A recreation exports only the widths it measured
 * on the live page, so this is a pass-through kept for the callers' signature.
 */
export function withAdaptedScreens(
  screens: ExportScreen[],
  _dslOf: (s: ExportScreen) => SceneScreen | null | undefined,
  _baseTokens?: Partial<SceneTokens>,
): ExportScreen[] {
  return screens;
}

/** Font files for the families a design uses (`fontFamily` anywhere, plus families inside inline SVG: icon fonts). */
export function designFontFiles(
  fonts: readonly ProjectFont[] | undefined,
  used: unknown,
): NonNullable<BundleOptions["fonts"]> {
  if (!fonts?.length) return [];
  const families = fontFamiliesIn(used);
  for (const f of svgFontFamilies(used)) families.add(f);
  return projectFontFiles(fonts, families);
}

/** First family of every `font-family` attribute / declaration in `svg` strings of a value (DSL `el.svg`). */
export function svgFontFamilies(value: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 200) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === "svg" && typeof x === "string")
        for (const m of x.matchAll(/font-family\s*(?:=\s*(?:"([^"]*)"|'([^']*)')|:\s*([^;"}]+))/gi)) {
          const fam = (m[1] ?? m[2] ?? m[3] ?? "")
            .replace(/&quot;|&#39;/g, "")
            .split(",")[0]!
            .trim()
            .replace(/^["']|["']$/g, "");
          if (fam) out.add(fam);
        }
      else visit(x, depth + 1);
    }
  };
  visit(value, 0);
  return out;
}

/** A single-screen file (import.dsl.json: a SceneScreen with `fonts`) or a design file → DesignInput. */
export function designInputOf(json: unknown): DesignInput {
  const j = json as DesignInput & SceneScreen;
  if (Array.isArray(j.screens))
    return {
      name: j.name,
      screens: j.screens,
      fonts: j.fonts,
      ...(j.designSystem ? { designSystem: j.designSystem } : {}),
    };
  const { fonts, ...screen } = j as SceneScreen & { fonts?: ProjectFont[] };
  return { name: screen.name, screens: [screen as SceneScreen], fonts };
}

/** Design → HTML bundle files (pages, styles.css, tokens.css, fonts/, assets/). Pure and synchronous. */
export function exportDesignHtml(design: DesignInput, o: DesignExportOptions = {}): FileMap {
  const { screens, bundle } = designBundle(design, o);
  return buildHtmlFiles(screens, bundle);
}

/** Design → the React + Tailwind project's files; the screens' instances are the design system's components. */
export function exportDesignReact(design: DesignInput, o: DesignExportOptions = {}): FileMap {
  const { screens, bundle } = designBundle(design, o);
  return buildReactFiles(screens, {
    ...bundle,
    ...(design.designSystem ? { designSystem: design.designSystem } : {}),
  });
}

function designBundle(
  design: DesignInput,
  o: DesignExportOptions,
): { screens: ExportScreen[]; bundle: BundleOptions } {
  const baseTokens = o.baseTokens ?? DEFAULT_TOKENS;
  const built = design.screens.map((s, i) => dslExportScreen(s, { baseTokens, nodeId: `${s.id}#${i}` }));
  const byNode = new Map(built.map((s, i) => [s.nodeId, design.screens[i]!]));
  const screens =
    o.adapt === false ? built : withAdaptedScreens(built, (s) => byNode.get(s.nodeId), baseTokens);
  const fonts = [
    ...(o.extraFonts ?? []),
    ...(o.includeFonts === false ? [] : designFontFiles(design.fonts, [design.screens, baseTokens])),
  ];
  return {
    screens,
    bundle: {
      semantic: o.semantic ?? true,
      cssVars: o.cssVars ?? true,
      images: o.images ?? true,
      attribution: o.attribution ?? true,
      vars: tokenVars(baseTokens),
      fonts,
      projectName: o.projectName ?? design.name,
    },
  };
}
