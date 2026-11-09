// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// SceneScreen → export IR. Mirrors dsl/SceneRenderer.tsx (same style mapping via dsl/styles) but produces plain
// framework-neutral elements: icons become inline SVG, component chrome from SceneRenderer.module.css is inlined.
import type { CSSProperties } from "@harness/scene";
import type { SceneElement, SceneScreen, SceneTokens } from "@harness/protocol";
import { resolveTokens, tokensToCssVars, cssColor, concreteColor, textPreset } from "@harness/scene";
import {
  elementStyle,
  directionOf,
  hasLeadingTrim,
  maskTargets,
  staticMaskStyle,
  rootStyle,
  activeRuns,
  runStyle,
  safeHref,
  lenCss,
  type Dir,
  type StyleCtx,
} from "@harness/scene";
import { clippedOut, fluidLayout, isFluidScreen, NO_BOX, type FluidBox as Box } from "@harness/scene";
import { sanitizeSvg, svgGlyphStyle, svgGlyphText } from "@harness/scene";
import { elementToSvg, vectorAttrs } from "@harness/scene";
import { regionFillPath } from "@harness/scene";
import { booleanGroupAsVector } from "@harness/scene";
import { alpha, mix, onColor, rotateHue } from "@harness/scene";
import { activeState, findElement, findParent } from "@harness/scene";
import { el, text, styleMapOf, type IrElement, type IrNode, type StyleMap } from "./ir.js";
import { iconIr, svgIr } from "./icons.js";
import { hiddenKeepsSpace } from "@harness/scene";
import { meaningfulLayerName } from "@harness/scene";
import { controlMotion, motionAttrs } from "@harness/scene";

export interface ScreenIr {
  /** screen wrapper (`<main>`) holding the root element */
  root: IrElement;
  tokens: SceneTokens;
  /** every CSS custom property the screen uses (design system + screen overrides) */
  vars: Record<string, string>;
}

export interface SceneIrOptions {
  /** project design-system tokens; screen overrides are merged on top */
  baseTokens?: Partial<SceneTokens>;
  /** frame size on the canvas (defaults to the DSL screen size) */
  size?: { w: number; h: number };
}

const truthy = (v: SceneElement["value"]) =>
  v === true || v === "true" || v === "on" || v === 1 || v === "checked";
const clampPct = (v: SceneElement["value"], fb = 40) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return fb;
  return Math.max(0, Math.min(100, n <= 1 && n > 0 ? n * 100 : n));
};
const initialsOf = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
const S = (style: CSSProperties): StyleMap => styleMapOf(style);

interface Ctx {
  tokens: SceneTokens;
  platform: "app" | "web";
  /** web pages: layout constraints stretch / centre / right-pin absolute layers with the viewport (dsl/fluid.ts) */
  fluid?: boolean;
  /** design width of the screen (the root's box) */
  width?: number;
  height?: number;
  /** (agent 2) an app built from a Brief (root meta.appVars): links that leave the app open in a new tab */
  app?: boolean;
}

export function dslScreenToIr(screen: SceneScreen, opts: SceneIrOptions = {}): ScreenIr {
  const tokens = resolveTokens(opts.baseTokens, screen.tokens);
  const vars = tokensToCssVars(tokens);
  const baseVars = tokensToCssVars(resolveTokens(opts.baseTokens));
  const w = opts.size?.w ?? screen.width,
    h = opts.size?.h ?? screen.height;
  const ctx: Ctx = {
    tokens,
    platform: screen.platform,
    fluid: isFluidScreen(screen),
    width: w,
    height: h,
    ...(typeof screen.root.meta?.appVars === "string" ? { app: true } : {}),
  };
  // SceneRenderer.module.css .root
  const wrapperStyle: StyleMap = {
    ...S(rootStyle(w, h, tokens)),
    "font-size": `${textPreset("body", screen.platform).size}px`,
    "letter-spacing": "-0.005em",
    "-webkit-font-smoothing": "antialiased",
    "text-rendering": "optimizeLegibility",
  };
  // web pages are full-bleed: the viewport is the frame (docs/responsive.md); the design width stays the layout basis
  if (screen.platform === "web") Object.assign(wrapperStyle, { width: "100%", "min-width": "0" });
  // (agent 2) an app page hugs what it shows: a flow's current step, not the tallest state the canvas was sized to —
  // no white stretch under the footer; at least the viewport
  if (ctx.app) Object.assign(wrapperStyle, { height: "auto", "min-height": "100vh" });
  // screen-level token overrides travel on the wrapper (the design system ones live in tokens.css)
  for (const [k, v] of Object.entries(vars)) if (baseVars[k] !== v) wrapperStyle[k] = v;
  const rootEl = renderElement(screen.root, "column", ctx, true);
  const root = el("main", {
    name: screen.name,
    attrs: { "data-screen": screen.name, ...(screen.lang ? { lang: screen.lang } : {}) },
    style: wrapperStyle,
    children: rootEl ? [rootEl] : [],
  });
  return { root, tokens, vars };
}

/** IR for one element subtree of a screen (Dev Mode, "code for selection"). */
export function dslElementToIr(
  screen: SceneScreen,
  elementId: string,
  opts: SceneIrOptions = {},
): IrElement | null {
  const found = findElement(screen.root, elementId);
  if (!found) return null;
  const tokens = resolveTokens(opts.baseTokens, screen.tokens);
  const parent = findParent(screen.root, elementId);
  const isRoot = found.id === screen.root.id;
  return renderElement(
    found,
    parent ? directionOf(parent) : "column",
    { tokens, platform: screen.platform },
    isRoot,
  );
}

/** `meta.vhShare` / `meta.vhPx` (scene convert viewportShare) → height (min-height for a box hugging its content) in vh. */
function viewportHeight(style: Record<string, string>, dsl: SceneElement): Record<string, string> {
  const share = Number(dsl.meta!.vhShare),
    px = Number(dsl.meta!.vhPx ?? 0) || 0;
  const vh = `${Math.round(share * 100000) / 1000}vh`;
  const css = px ? `calc(${vh} ${px < 0 ? "-" : "+"} ${Math.round(Math.abs(px) * 100) / 100}px)` : vh;
  // (a box its content overflows on the page has its height set: `meta.vhFixed`)
  const hugs =
    dsl.meta!.vhFixed !== true &&
    (dsl.layout?.height === "hug" || style.height === "auto" || style.height === "fit-content");
  return hugs ? { ...style, "min-height": css } : { ...style, height: css };
}

const FLEX_KEYS = [
  "flex-direction",
  "gap",
  "row-gap",
  "column-gap",
  "align-items",
  "justify-content",
  "flex-wrap",
];
const PLACE_KEYS = ["position", "left", "top", "right", "bottom"];
/**
 * `meta.inline`: the block's lines hold its children (a text, then small boxes after its last line), as on the page:
 * the text is an inline run, the boxes inline-flex boxes on its last line, wherever it wraps.
 */
function inlineContent(out: IrElement, dsl: SceneElement): void {
  // the page's line height (the measured pitch includes what the icon pushes apart, which it does here again)
  const css = Number(dsl.children?.[0]?.meta?.cssLineHeight);
  const st: Record<string, string> = { ...out.style, display: "block" };
  for (const k of FLEX_KEYS) delete st[k];
  out.style = st;
  out.children.forEach((c, i) => {
    if (c.kind !== "el") return;
    const s = { ...c.style };
    for (const k of PLACE_KEYS) delete s[k];
    for (const k of ["flex", "flex-grow", "flex-shrink", "flex-basis", "align-self"]) delete s[k];
    if (i === 0) {
      for (const k of ["width", "height", "min-width", "max-width", "min-height", "max-height"]) delete s[k];
      s.display = "inline";
      if (css > 0) s["line-height"] = `${css}px`;
      // the block's own line (its strut) is the text's, as on the page where the text inherits it: lines as tall
      for (const k of ["font-family", "font-size", "line-height", "text-align"])
        if (s[k]) out.style[k] = s[k]!;
    } else {
      s.display = "inline-flex";
      s["vertical-align"] = "middle";
      s.position = "relative";
    }
    c.style = s;
  });
}

/** `meta.columnWidth` / `columnCount` / `columnGap`: a block with the page's columns, its children unbroken in them. */
function multiColumn(out: IrElement, dsl: SceneElement): void {
  const st: Record<string, string> = { ...out.style, display: "block" };
  for (const k of FLEX_KEYS) delete st[k];
  const w = dsl.meta!.columnWidth,
    n = dsl.meta!.columnCount;
  st.columns = [typeof w === "number" ? `${w}px` : "", typeof n === "number" ? String(n) : ""]
    .join(" ")
    .trim();
  st["column-gap"] = `${Number(dsl.meta!.columnGap) || 0}px`;
  out.style = st;
  for (const c of out.children) {
    if (c.kind !== "el" || c.style.position === "absolute") continue;
    // (as the page's inline-block items: each in a line box of its own, which the columns balance as the page's)
    const s: Record<string, string> = {
      ...c.style,
      "break-inside": "avoid",
      width: "100%",
      display: c.style.display === "flex" ? "inline-flex" : "inline-block",
      "vertical-align": "top",
    };
    for (const k of ["flex", "flex-grow", "flex-shrink", "flex-basis", "align-self", "min-width"])
      delete s[k];
    c.style = s;
  }
}

function renderElement(
  dsl: SceneElement,
  parentDir: Dir,
  ctx: Ctx,
  isRoot = false,
  parent: Box = NO_BOX,
): IrElement | null {
  const out = renderElementInner(dsl, parentDir, ctx, isRoot, parent);
  if (out && dsl.lang) out.attrs = { ...out.attrs, lang: dsl.lang };
  // a slider arrow captured disabled (export/interactions.ts: its look is the "disabled" one as the slider moves)
  if (out && dsl.meta?.carouselDisabled === true) out.attrs = { ...out.attrs, "data-scroll-off": "" };
  // a text narrowed to its longest line at the capture width: its width in the page (measuredFluid follows it elsewhere)
  if (out && typeof dsl.meta?.narrowedBy === "number" && dsl.layout?.fluid?.length)
    out.attrs = { ...out.attrs, "data-narrowed": String(dsl.meta.narrowedBy) };
  // the page breaks this text inside words to fit its box (read by responsive.ts reflowIr, never exported)
  if (out && dsl.meta?.breaksWords === true) out.attrs = { ...out.attrs, "data-breaks-words": "" };
  // room below a column's flow (read by responsive.ts measuredFluid when the box follows its content, never exported)
  if (out && typeof dsl.meta?.below === "number" && dsl.meta.below > 0)
    out.attrs = { ...out.attrs, "data-below": String(dsl.meta.below) };
  // a box as tall as the viewport, or a share of it (URL capture): sized by the viewport as on the page; one that
  // grows with its content keeps that as its minimum
  if (out && typeof dsl.meta?.vhShare === "number" && dsl.meta.vhShare > 0)
    out.style = viewportHeight(out.style, dsl);
  // a text and the small boxes after its last line (URL capture, scene convert inlineRun): inline content of one block
  if (out && dsl.meta?.inline === true) inlineContent(out, dsl);
  // its place in the page's CSS grid (URL capture, scene convert cssGrid)
  if (out && typeof dsl.meta?.gridColumn === "string")
    out.style = { ...out.style, "grid-column": dsl.meta.gridColumn };
  if (out && typeof dsl.meta?.gridRow === "string")
    out.style = { ...out.style, "grid-row": dsl.meta.gridRow };
  // CSS columns (URL capture, scene convert multiColumn): the browser flows the children down the columns
  if (out && (typeof dsl.meta?.columnWidth === "number" || typeof dsl.meta?.columnCount === "number"))
    multiColumn(out, dsl);
  // a pinned box the page moves once it scrolls (URL capture): the interactions runtime moves it the same way
  if (out && typeof dsl.meta?.scrollShift === "number" && dsl.meta.scrollShift)
    out.attrs = {
      ...out.attrs,
      "data-scroll-shift": String(dsl.meta.scrollShift),
      ...(dsl.meta.scrollShiftMode === "scroll" ? { "data-scroll-shift-mode": "scroll" } : {}),
      ...(typeof dsl.meta.scrollShiftAfter === "number"
        ? { "data-scroll-shift-after": String(dsl.meta.scrollShiftAfter) }
        : {}),
    };
  if (out && dsl.instance?.componentId)
    out.instance = {
      componentId: dsl.instance.componentId,
      ...(dsl.instance.variant ? { variant: dsl.instance.variant } : {}),
    };
  if (out) appMarks(dsl, out);
  // (agent 2) a landmark the composed page names (the site's bar / footer: meta.tag) is that element in the markup
  if (
    out &&
    out.tag === "div" &&
    typeof dsl.meta?.tag === "string" &&
    /^(header|footer|nav|main|aside)$/.test(dsl.meta.tag)
  )
    out.tag = dsl.meta.tag;
  return out;
}

/** App state and motion of a layer (apps built from a Brief): what the interactions runtime reads (export/interactions.ts). */
function appMarks(dsl: SceneElement, out: IrElement) {
  const attrs: Record<string, string> = {};
  // recreate: a page section: the build stage grows and checks the page by it
  if (typeof dsl.meta?.section === "string") attrs["data-section"] = dsl.meta.section;
  // a layer placed over a section from outside it (a slider's arrows at page level) belongs to that section
  if (typeof dsl.meta?.sectionOf === "string") attrs["data-section-of"] = dsl.meta.sectionOf;
  // app regions, and the anchors a chapter nav jumps to (scroll-to)
  if (dsl.meta?.app === "region" || dsl.meta?.app === "anchor") attrs["data-app-id"] = dsl.id;
  // a form whose required fields are checked before it confirms
  if (dsl.meta?.app === "form") attrs["data-app-form"] = "";
  if (dsl.meta?.required === true) attrs["data-app-required"] = "";
  if (dsl.meta?.appSubmit === true) attrs["data-app-submit"] = "";
  // a form field that keeps what is typed (a confirmation greets with it); a button that copies its code
  if (typeof dsl.meta?.appInput === "string") attrs["data-app-input"] = dsl.meta.appInput;
  if (typeof dsl.meta?.appCopy === "string") attrs["data-app-copy"] = dsl.meta.appCopy;
  if (dsl.meta?.appError === true) {
    attrs["data-app-error"] = "";
    delete out.style.visibility;
    delete out.style["pointer-events"];
    out.style.display = "none";
  }
  if (typeof dsl.meta?.appVars === "string") attrs["data-app-vars"] = dsl.meta.appVars;
  if (dsl.bindings?.text) attrs["data-app-text"] = dsl.bindings.text;
  if (dsl.showIf) {
    attrs["data-app-show"] = JSON.stringify({
      variableId: dsl.showIf.variableId,
      op: dsl.showIf.op ?? "eq",
      value: dsl.showIf.value,
    });
    // hidden for the defaults: out of the layout until the runtime shows it
    if (dsl.meta?.hidden === true) {
      delete out.style.visibility;
      delete out.style["pointer-events"];
      attrs["data-app-display"] = out.style.display ?? "block";
      out.style.display = "none";
    }
  }
  const m = motionAttrs(controlMotion(dsl));
  Object.assign(attrs, m.attrs);
  if (Object.keys(m.vars).length) out.style = { ...out.style, ...m.vars };
  if (Object.keys(attrs).length) out.attrs = { ...out.attrs, ...attrs };
}

function renderElementInner(
  dsl: SceneElement,
  parentDir: Dir,
  ctx: Ctx,
  isRoot = false,
  parent: Box = NO_BOX,
): IrElement | null {
  if (
    dsl.meta?.hidden === true &&
    !isRoot &&
    !hiddenKeepsSpace() &&
    !dsl.showIf &&
    dsl.meta?.appError !== true
  )
    return null;
  if (dsl.boolean) return renderElement(booleanGroupAsVector(dsl), parentDir, ctx, isRoot, parent); // live boolean group → its result (PLAN 7.3)
  const sctx: StyleCtx = { tokens: ctx.tokens, platform: ctx.platform, parentDir, interactive: true };
  let css = elementStyle(dsl, sctx);
  if (isRoot)
    css = {
      ...css,
      position: "relative",
      width: "100%",
      height: ctx.app ? "auto" : "100%",
      ...(ctx.app ? { minHeight: "100vh" } : {}),
      flex: "1 1 auto",
      display: "flex",
      flexDirection: directionOf(dsl),
      overflow: ctx.app ? "visible" : "hidden",
      background: css.background ?? "var(--t-background)",
    };
  const style = S(css);
  if (!style.position) style.position = "relative";
  // hidden, keeping its space (same as the canvas)
  if (dsl.meta?.hidden === true && !isRoot) {
    style.visibility = "hidden";
    style["pointer-events"] = "none";
  }
  let box = NO_BOX;
  // docs/responsive.md: shared with the renderer (SceneRenderer), which reflows the same way at any width
  if (ctx.fluid) {
    const f = fluidLayout(dsl, parentDir, parent, ctx, isRoot);
    Object.assign(style, f.style);
    box = f.box;
  }
  const tap = dsl.interaction?.onTap && dsl.interaction.onTap !== "none" ? dsl.interaction : undefined;
  const base = { name: dsl.name ?? dsl.type, id: dsl.id, interaction: tap };
  const dir = directionOf(dsl);
  const own = dsl.children ?? NONE;
  const kids = (children: SceneElement[] = own): IrNode[] => {
    const out =
      dsl.states && children === own
        ? stateChildren(dsl, dir, ctx, box)
        : renderChildren(children, dir, ctx, box);
    const choice = children === own ? choiceIr(dsl) : null;
    return choice ? [...out, choice] : out;
  };
  const t = ctx.tokens;

  // content the page has but does not draw (screen-reader text, a crawler's menu), as the importer built it
  if (typeof dsl.meta?.hiddenMarkup === "string") return el("div", { ...base, raw: dsl.meta.hiddenMarkup });
  switch (dsl.type) {
    case "frame":
      return el("div", { ...base, style, children: kids() });
    case "card":
      return el("section", { ...base, style, children: kids() });
    case "list": {
      const plain = (dsl.variant ?? "").includes("plain");
      const children = kids().map((c, i) =>
        i > 0 && !plain && c.kind === "el" && !c.style.border && !c.style["border-top"]
          ? { ...c, style: { ...c.style, "border-top": "1px solid var(--t-border)" } }
          : c,
      );
      return el("div", { ...base, style, attrs: { role: "list" }, children });
    }
    case "text": {
      const ts = dsl.style?.textStyle;
      // a captured page says which element a text is in; a designed one says it through the text style
      const written = typeof dsl.meta?.textTag === "string" ? dsl.meta.textTag : undefined;
      const tag = written
        ? /^h[1-6]$/.test(written)
          ? written
          : "p"
        : ts === "display"
          ? "h1"
          : ts === "headline"
            ? "h2"
            : ts === "title"
              ? "h3"
              : "p";
      const runs = activeRuns(dsl);
      // a line of a word broken at a hyphenation point (URL capture `meta.softHyphen`): the hyphen is drawn, not text
      // (the page's text has a soft hyphen there, no "-")
      const soft =
        dsl.meta?.softHyphen === true &&
        /-$/.test(runs ? (runs[runs.length - 1]?.text ?? "") : (dsl.text ?? ""));
      const cut = (s: string, last: boolean) => (soft && last ? `${s.slice(0, -1)}\u00ad` : s);
      const children: IrNode[] = runs
        ? runs.map((r, i) => {
            const href = safeHref(r.href);
            return el(href ? "a" : "span", {
              attrs: href
                ? {
                    href,
                    ...(ctx.app && /^https?:/i.test(href) ? { target: "_blank", rel: "noopener" } : {}),
                  }
                : {},
              style: S(runStyle(r, t)),
              children: [text(cut(r.text, i === runs.length - 1))],
            });
          })
        : [text(cut(dsl.text ?? "", true))];
      return el(tag, {
        ...base,
        // (the exported reset stops at h4: a captured h5 / h6 would keep the browser's margins)
        style: tag === "h5" || tag === "h6" ? { margin: "0", ...style } : style,
        attrs: hasLeadingTrim(dsl) ? { "data-trim": "" } : {},
        children,
        ...(soft ? { pseudo: { after: { content: '"-"' } } } : {}),
      });
    }
    case "button": {
      const small = (dsl.variant ?? "").includes("sm");
      const children: IrNode[] = [];
      if (dsl.icon) children.push(iconIr(dsl.icon, small ? 16 : 18, 2));
      if (dsl.text) children.push(el("span", { children: [text(dsl.text)] }));
      children.push(...kids());
      // a <button> cannot nest interactive content (the parser would split it): a div with the button role then
      const nested = (dsl.children ?? []).some(function has(c: SceneElement): boolean {
        return (
          c.type === "button" ||
          c.type === "input" ||
          !!c.runs?.some((r) => r.href) ||
          !!c.children?.some(has)
        );
      });
      // a button that goes to a URL is a link: crawlers, assistive tech and "open in new tab" need the href in the markup
      const url = base.interaction?.onTap === "open-url" ? base.interaction.url : undefined;
      if (url && !nested)
        return el("a", {
          ...base,
          interaction: undefined,
          attrs: { href: url },
          style: {
            display: "inline-block",
            "text-align": "center",
            color: "inherit",
            border: "0",
            "text-decoration": "none",
            cursor: "pointer",
            ...style,
          },
          children,
        });
      return el(nested ? "div" : "button", {
        ...base,
        attrs: nested ? { role: "button" } : { type: "button" },
        style: { border: "0", "text-decoration": "none", cursor: "pointer", ...style },
        children,
      });
    }
    case "input": {
      const search = (dsl.variant ?? "").includes("search");
      const iconName = dsl.icon ?? (search ? "search" : undefined);
      const children: IrNode[] = [];
      if (iconName)
        children.push(
          el("span", {
            style: { color: "var(--t-text-muted)", display: "inline-flex", flex: "none" },
            children: [iconIr(iconName, 18, 2)],
          }),
        );
      const attrs: Record<string, string> = {
        type: search ? "search" : "text",
        placeholder: dsl.placeholder ?? dsl.text ?? "",
      };
      if (typeof dsl.value === "string" && dsl.value) attrs.value = dsl.value;
      children.push(
        el("input", {
          attrs,
          style: {
            flex: "1",
            "min-width": "0",
            border: "0",
            outline: "0",
            background: "transparent",
            font: "inherit",
            color: "inherit",
            padding: "0",
          },
        }),
      );
      children.push(
        ...(dsl.children?.map((c) => renderElement(c, "row", ctx)).filter((c): c is IrElement => !!c) ?? []),
      );
      return el("label", { ...base, style, children });
    }
    case "icon": {
      const svg = sanitizeSvg(dsl.svg);
      if (svg) return svgBoxIr(dsl, svg, { ...style, color: style.color ?? "var(--t-text)" }, base);
      const size = typeof dsl.layout?.width === "number" ? dsl.layout.width : 22;
      return el("span", {
        ...base,
        style: { ...style, color: style.color ?? "var(--t-text)" },
        children: [iconIr(dsl.icon ?? dsl.name, size, size >= 28 ? 1.6 : 1.9)],
      });
    }
    case "divider":
    case "spacer":
      return el("div", { ...base, style, attrs: { "aria-hidden": "true" } });
    case "image":
    case "video":
      return imageIr(dsl, style, base, ctx);
    case "avatar": {
      const bg =
        cssColor(dsl.style?.background, t) ??
        `linear-gradient(135deg, ${t.primary}, ${rotateHue(t.primary, 40, 0.9)})`;
      const st = { ...style, background: bg, color: onColor(concreteColor("$primary", t, t.primary)) };
      const src = dsl.image?.src;
      const children: IrNode[] = src
        ? [
            el("img", {
              attrs: { src, alt: dsl.image?.alt ?? "" },
              style: {
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
                "object-fit": "cover",
                display: "block",
              },
            }),
          ]
        : [text(initialsOf(dsl.text ?? dsl.name ?? ""))];
      return el("div", { ...base, style: st, children, credit: dsl.image?.author });
    }
    case "badge": {
      const children: IrNode[] = [];
      if (dsl.icon) children.push(iconIr(dsl.icon, 12, 2.2));
      if (dsl.text) children.push(text(dsl.text));
      children.push(...kids());
      return el("span", { ...base, style: { ...style, display: "inline-flex" }, children });
    }
    case "toggle": {
      const on = truthy(dsl.value);
      return el("div", {
        ...base,
        attrs: { role: "switch", "aria-checked": String(on) },
        style: {
          background: on ? "var(--t-primary)" : "var(--t-surface-alt)",
          border: on ? "1px solid transparent" : "1px solid var(--t-border)",
          ...style,
        },
        children: [
          el("span", {
            style: {
              position: "absolute",
              top: "2px",
              left: "2px",
              width: "25px",
              height: "25px",
              "border-radius": "50%",
              background: "#fff",
              "box-shadow": "0 2px 4px rgba(0,0,0,.25)",
              ...(on ? { translate: "20px 0" } : {}),
            },
          }),
        ],
      });
    }
    case "checkbox": {
      const on = truthy(dsl.value);
      return el("div", {
        ...base,
        attrs: { role: "checkbox", "aria-checked": String(on) },
        style: {
          border: `1.5px solid ${on ? "var(--t-primary)" : "var(--t-border)"}`,
          background: on ? "var(--t-primary)" : "var(--t-surface-alt)",
          color: "var(--t-primary-fg)",
          ...style,
        },
        children: on ? [iconIr("check", 15, 3)] : [],
      });
    }
    case "progress": {
      const v = clampPct(dsl.value);
      return el("div", {
        ...base,
        attrs: { role: "progressbar", "aria-valuenow": String(v) },
        style,
        children: [
          el("span", {
            style: {
              position: "absolute",
              inset: "0 auto 0 0",
              width: `${v}%`,
              background: cssColor(dsl.style?.color, t, "var(--t-primary)") ?? "var(--t-primary)",
              "border-radius": "inherit",
            },
          }),
        ],
      });
    }
    case "slider": {
      const v = clampPct(dsl.value, 60);
      return el("div", {
        ...base,
        attrs: { role: "slider", "aria-valuenow": String(v) },
        style,
        children: [
          el("span", {
            style: {
              position: "absolute",
              left: "0",
              right: "0",
              height: "6px",
              "border-radius": "999px",
              background: "var(--t-surface-alt)",
            },
          }),
          el("span", {
            style: {
              position: "absolute",
              left: "0",
              height: "6px",
              width: `${v}%`,
              "border-radius": "999px",
              background: "var(--t-primary)",
            },
          }),
          el("span", {
            style: {
              position: "absolute",
              left: `${v}%`,
              width: "22px",
              height: "22px",
              "border-radius": "50%",
              background: "#fff",
              "box-shadow": "0 1px 4px rgba(0,0,0,.3)",
              translate: "-50% 0",
            },
          }),
        ],
      });
    }
    case "chart":
      return el("div", {
        ...base,
        style,
        attrs: { role: "img", "aria-label": dsl.name ?? "chart" },
        children: [chartIr(dsl, t)],
      });
    case "map":
      return el("div", {
        ...base,
        style: { background: "var(--t-surface-alt)", ...style },
        attrs: { role: "img", "aria-label": dsl.name ?? "map" },
        children: [
          mapIr(t),
          el("span", {
            style: {
              position: "absolute",
              left: "50%",
              top: "50%",
              translate: "-50% -100%",
              color: "var(--t-primary)",
              filter: "drop-shadow(0 4px 6px rgba(0,0,0,.3))",
              display: "inline-flex",
            },
            children: [iconIr("map-pin", 36, 1.5, { fill: "currentColor", stroke: "#fff" })],
          }),
        ],
      });
    case "statusbar":
      if (ctx.platform === "web") return null;
      return el("div", {
        ...base,
        style,
        children: [
          el("span", { children: [text(dsl.text || "9:41")] }),
          el("span", {
            style: { display: "flex", gap: "6px", "align-items": "center" },
            children: [
              iconIr("signal", 16, 2.2),
              iconIr("wifi", 16, 2.2),
              el("span", {
                style: {
                  width: "25px",
                  height: "12px",
                  "border-radius": "4px",
                  border: "1.5px solid currentColor",
                  opacity: "0.9",
                  position: "relative",
                },
                pseudo: {
                  after: {
                    content: "''",
                    position: "absolute",
                    inset: "2px",
                    right: "3px",
                    "border-radius": "2px",
                    background: "currentColor",
                  },
                },
              }),
            ],
          }),
        ],
      });
    case "vector": {
      const svg = sanitizeSvg(dsl.svg);
      if (svg) return svgBoxIr(dsl, svg, style, base);
      return vectorIr(dsl, style, base, ctx);
    }
    case "navbar":
      return navbarIr(dsl, style, base, ctx, kids);
    case "tabbar":
      return tabbarIr(dsl, style, base);
    default:
      return el("div", { ...base, style, children: kids() });
  }
}

type Base = { name: string; id: string; interaction: SceneElement["interaction"] };

/**
 * A state frame's children: every state, tagged `data-pt-state`; all but the active one hidden (`display: none`) for
 * the prototype runtime to switch (exports keep them as markup a developer can wire up).
 */
/**
 * A drop-down that switches a state frame (set-state with `options`): a native select over the element, invisible,
 * its options naming the states (the prototype runtime switches on change; the phone opens its own picker).
 */
const NONE: SceneElement[] = [];

function choiceIr(dsl: SceneElement): IrElement | null {
  const i = dsl.interaction;
  if (i?.onTap !== "set-state" || !i.options?.length) return null;
  return el("select", {
    attrs: { "data-pt-choice": "", "aria-label": dsl.name ?? "Choose" },
    style: {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      opacity: "0",
      cursor: "pointer",
      margin: "0",
      "font-size": "16px",
    },
    children: i.options.map((o) =>
      el("option", {
        attrs: { value: o.state, ...(o.state === i.state ? { selected: "" } : {}) },
        children: [text(o.label)],
      }),
    ),
  });
}

function stateChildren(dsl: SceneElement, dir: Dir, ctx: Ctx, box: Box): IrNode[] {
  const active = activeState(dsl);
  return renderChildren(dsl.children ?? [], dir, ctx, box).map((n, i) => {
    const c = dsl.children![i];
    if (!n || n.kind !== "el" || !c) return n;
    // its own display, for the runtime to show it again over the class rule that hides it
    n.attrs = { ...n.attrs, "data-pt-state": c.id, "data-pt-display": n.style.display ?? "block" };
    if (c !== active) n.style = { ...n.style, display: "none" };
    return n;
  });
}

/** Children in paint order; siblings after a mask element get its CSS mask when both boxes are static (as the renderer). */
function renderChildren(children: SceneElement[], dir: Dir, ctx: Ctx, box: Box = NO_BOX): IrNode[] {
  const masks = children.some((c) => c.mask) ? maskTargets(children) : null;
  return children
    .map((c) => {
      // web: absolute layers wholly above / below a clipping parent never show at any width (closed modals, off-canvas)
      if (clippedOut(c, box)) return null;
      const r = renderElement(c, dir, ctx, false, box);
      const mask = masks?.get(c.id);
      const st = r && mask ? staticMaskStyle(mask, c) : null;
      if (r && st) r.style = { ...r.style, ...styleMapOf(st) };
      return r;
    })
    .filter((c): c is IrElement => !!c);
}

/** CSS for an absolute layer's constraints (dsl/fluid.ts; kept here for existing importers). */
export { fluidStyle } from "@harness/scene";

/** Inline SVG markup (SceneRenderer SvgEl): scaled into the box; an icon-font glyph also as HTML text (WebKit ligatures). */
function svgBoxIr(dsl: SceneElement, svg: string, style: StyleMap, base: Base): IrElement {
  const w = dsl.layout?.width,
    h = dsl.layout?.height;
  // a layer name is an accessible name only when it says something ("Search"); imported icons are named after their
  // site's CSS classes ("Sc jxm YRc") or nothing in particular ("Icon"): decorative then
  const label = meaningfulLayerName(dsl.name) && !/^icon\s*\d*$/i.test(dsl.name!.trim()) ? dsl.name! : null;
  const a11y: Record<string, string> = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": "true" };
  const box: StyleMap = { display: "inline-flex", "flex-shrink": "0", "line-height": "0", ...style };
  const glyph = typeof w === "number" && typeof h === "number" ? svgGlyphText(svg) : null;
  if (glyph && typeof w === "number" && typeof h === "number") {
    return el("span", {
      ...base,
      style: box,
      attrs: a11y,
      children: [
        el("span", {
          attrs: { "data-glyph": "", "aria-hidden": "true" },
          style: S(svgGlyphStyle(glyph, w, h)),
          children: [text(glyph.text)],
        }),
        el("span", {
          attrs: { "data-glyph-svg": "", "aria-hidden": "true" },
          children: [svgIr(svg, dsl.name)],
        }),
      ],
    });
  }
  return el("span", {
    ...base,
    style: box,
    attrs: { ...a11y, "data-svg": "" },
    children: [svgIr(svg, dsl.name)],
  });
}

/** Vector → inline SVG path in the element box (paint as CSS so token variables keep working). */
function vectorIr(dsl: SceneElement, style: StyleMap, base: Base, ctx: Ctx): IrElement {
  const v = dsl.vector;
  if (!v) return el("div", { ...base, style });
  const a = vectorAttrs(v, (c) => cssColor(c, ctx.tokens));
  const paint: StyleMap = { fill: a.fill };
  if (a.stroke) {
    paint.stroke = a.stroke;
    paint["stroke-width"] = `${a["stroke-width"]}px`;
    if (a["stroke-linecap"]) paint["stroke-linecap"] = a["stroke-linecap"];
    if (a["stroke-linejoin"]) paint["stroke-linejoin"] = a["stroke-linejoin"];
    if (a["stroke-dasharray"]) paint["stroke-dasharray"] = a["stroke-dasharray"];
  }
  const attrs: Record<string, string> = { d: a.d };
  if (a["fill-rule"]) attrs["fill-rule"] = a["fill-rule"];
  return el("div", {
    ...base,
    style: { ...style, overflow: "visible" },
    children: [
      el("svg", {
        svg: true,
        attrs: { xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true" },
        style: {
          position: "absolute",
          left: "0",
          top: "0",
          width: "100%",
          height: "100%",
          overflow: "visible",
          display: "block",
        },
        children: [
          ...(v.fillRegions
            ? [
                el("path", {
                  svg: true,
                  attrs: { d: regionFillPath(v) ?? "", "fill-rule": "evenodd" },
                  style: { fill: a.fill },
                }),
              ]
            : []),
          el("path", { svg: true, attrs, style: v.fillRegions ? { ...paint, fill: "none" } : paint }),
        ],
      }),
    ],
  });
}

function imageIr(dsl: SceneElement, style: StyleMap, base: Base, ctx: Ctx): IrElement {
  const t = ctx.tokens;
  const src = dsl.image?.src;
  const ph = `linear-gradient(135deg, ${mix(t.primary, "#ffffff", 0.08)}, ${rotateHue(t.primary, -24, 0.9)} 55%, ${mix(t.primary, "#000000", 0.35)})`;
  const w = typeof dsl.layout?.width === "number" ? dsl.layout.width : 390;
  const h =
    typeof dsl.layout?.height === "number"
      ? dsl.layout.height
      : dsl.style?.aspect
        ? w / dsl.style.aspect
        : w * 0.66;
  const children: IrNode[] = [];
  const label = dsl.image?.alt ?? dsl.image?.query ?? dsl.name ?? "";
  if (src) {
    children.push(
      el("img", {
        attrs: {
          src,
          alt: dsl.image?.alt ?? dsl.image?.query ?? "",
          // where the page's <picture> switches pictures (read by responsive.ts artDirection, never exported)
          ...(typeof dsl.meta?.pictureSwitches === "string"
            ? { "data-picture-switches": dsl.meta.pictureSwitches }
            : {}),
        },
        style: {
          // the picture fills its box: in its flow where the box has no padding (the same pixels), placed otherwise
          ...(dsl.layout?.padding === undefined || dsl.layout.padding === 0
            ? { position: "static" }
            : { position: "absolute", inset: "0" }),
          width: "100%",
          height: "100%",
          "object-fit": dsl.style?.fit ?? "cover",
          ...(dsl.style?.objectPosition
            ? {
                "object-position": `${lenCss(dsl.style.objectPosition[0])} ${lenCss(dsl.style.objectPosition[1])}`,
              }
            : {}),
          display: "block",
        },
      }),
    );
  } else {
    children.push(
      el("span", {
        attrs: { "data-placeholder": "true" },
        style: {
          position: "absolute",
          inset: "0",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          color: "rgba(255,255,255,0.72)",
          "background-image":
            "radial-gradient(120% 90% at 85% 0%, rgba(255,255,255,.22), transparent 55%), radial-gradient(80% 60% at 10% 100%, rgba(0,0,0,.22), transparent 60%)",
        },
        pseudo: {
          after: {
            content: "''",
            position: "absolute",
            inset: "0",
            "background-image": "radial-gradient(rgba(255,255,255,.08) 1px, transparent 1px)",
            "background-size": "6px 6px",
            opacity: ".35",
            "mix-blend-mode": "overlay",
          },
        },
        children: [
          iconIr("image", Math.max(20, Math.min(40, Math.round(Math.min(w, h) * 0.18))), 1.5, {
            opacity: "0.8",
            style: "position: relative",
          }),
        ],
      }),
    );
  }
  if (dsl.type === "video") {
    children.push(
      el("span", {
        style: {
          position: "absolute",
          left: "50%",
          top: "50%",
          translate: "-50% -50%",
          width: "56px",
          height: "56px",
          "border-radius": "50%",
          background: "rgba(255,255,255,.9)",
          color: "#111",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
        },
        children: [iconIr("play", 24, 2, { fill: "currentColor" })],
      }),
    );
  }
  return el("figure", {
    ...base,
    // (agent 2) a decorative repeat (an app's option stage picture) is hidden from assistive tech: the option names it
    attrs: dsl.meta?.decorative === true ? { "aria-hidden": "true" } : { role: "img", "aria-label": label },
    // an explicit src (imported / uploaded, possibly a transparent PNG) gets no placeholder fill behind it
    style: {
      ...style,
      ...(style.margin ? {} : { margin: "0" }),
      ...(style.background || src ? {} : { background: ph }),
    },
    children,
    credit: dsl.image?.author,
    // the placeholder background is what "include images: off" falls back to
  });
}

function navbarIr(
  dsl: SceneElement,
  style: StyleMap,
  base: Base,
  ctx: Ctx,
  kids: (c?: SceneElement[]) => IrNode[],
): IrElement {
  const children = dsl.children ?? [];
  if (!dsl.text) return el("header", { ...base, style, children: kids() });
  const leadIdx = children.findIndex((c) => c.type === "icon" || c.type === "button" || c.type === "avatar");
  const lead = leadIdx === 0 ? children[0] : undefined;
  const rest = lead ? children.slice(1) : children;
  const centered = !!lead || (dsl.style?.textAlign ?? "center") === "center";
  const out: IrNode[] = [];
  if (lead) {
    const l = renderElement(lead, "row", ctx);
    if (l) out.push(l);
  }
  const titleStyle: StyleMap = {
    flex: "1",
    "min-width": "0",
    "text-align": centered ? (dsl.style?.textAlign ?? "center") : "left",
    "font-weight": String(dsl.style?.fontWeight ?? 600),
    "font-size": `${dsl.style?.fontSize ?? 17}px`,
    "white-space": "nowrap",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    margin: "0",
  };
  out.push(el("h1", { name: "title", style: titleStyle, children: [text(dsl.text)] }));
  if (rest.length > 0) out.push(...kids(rest));
  else if (lead)
    out.push(
      el("span", {
        style: {
          width: `${typeof lead.layout?.width === "number" ? lead.layout.width : 24}px`,
          "flex-shrink": "0",
        },
      }),
    );
  return el("header", { ...base, style, children: out });
}

function tabbarIr(dsl: SceneElement, style: StyleMap, base: Base): IrElement {
  const tabs = (dsl.children ?? []).filter((t) => t.meta?.hidden !== true);
  const anyActive = tabs.some((x) => truthy(x.value) || x.variant === "active" || x.meta?.active === true);
  const items = tabs.map((t, i) => {
    const iconName = t.icon ?? t.children?.find((c) => c.type === "icon")?.icon;
    const label = t.text ?? t.children?.find((c) => c.type === "text")?.text ?? t.name;
    const active =
      truthy(t.value) || t.variant === "active" || t.meta?.active === true || (i === 0 && !anyActive);
    const nav = t.interaction?.onTap === "navigate" && t.interaction.target ? t.interaction : undefined;
    const children: IrNode[] = [iconIr(iconName ?? label, 24, active ? 2.2 : 1.8)];
    if (label)
      children.push(
        el("span", {
          style: {
            "white-space": "nowrap",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "max-width": "100%",
          },
          children: [text(label)],
        }),
      );
    return el("a", {
      name: t.name ?? label ?? "tab",
      id: t.id,
      interaction: nav,
      attrs: active ? { "aria-current": "page" } : {},
      style: {
        position: "relative",
        flex: "1 1 0",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "4px",
        color: active ? "var(--t-primary)" : "var(--t-text-muted)",
        "font-size": "11px",
        "font-weight": "500",
        padding: "0 4px",
        "min-width": "0",
        "text-decoration": "none",
        cursor: nav ? "pointer" : "default",
      },
      children,
    });
  });
  items.push(
    el("span", {
      attrs: { "aria-hidden": "true" },
      style: {
        position: "absolute",
        left: "50%",
        bottom: "8px",
        width: "134px",
        height: "5px",
        "border-radius": "3px",
        background: "var(--t-text)",
        opacity: "0.85",
        translate: "-50% 0",
      },
    }),
  );
  return el("nav", { ...base, style, children: items });
}

/* ---------------------------------------------------------------- chart / map */

function chartValues(dsl: SceneElement): number[] {
  const raw =
    typeof dsl.value === "string"
      ? dsl.value
      : typeof dsl.meta?.values === "string"
        ? dsl.meta.values
        : typeof dsl.meta?.data === "string"
          ? dsl.meta.data
          : "";
  const nums = raw
    .split(/[,\s;]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (nums.length >= 2) return nums;
  if (typeof dsl.value === "number") return [dsl.value * 0.6, dsl.value * 0.8, dsl.value * 0.7, dsl.value];
  return [18, 26, 22, 34, 30, 42, 38, 52, 47, 58];
}

const svgRoot = (viewBox: string, par: string, children: IrNode[]) =>
  el("svg", {
    svg: true,
    attrs: { xmlns: "http://www.w3.org/2000/svg", viewBox, preserveAspectRatio: par, "aria-hidden": "true" },
    style: { display: "block", width: "100%", height: "100%" },
    children,
  });
const svgEl = (tag: string, attrs: Record<string, string | number>, children: IrNode[] = []) =>
  el(tag, {
    svg: true,
    attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])),
    children,
  });

function chartIr(dsl: SceneElement, tokens: SceneTokens): IrElement {
  const values = chartValues(dsl);
  const W = 300,
    H = 100;
  const min = Math.min(...values),
    max = Math.max(...values);
  const range = max - min || 1;
  const bars = (dsl.variant ?? "").includes("bar") || dsl.meta?.kind === "bars";
  const color = concreteColor(dsl.style?.color, tokens, tokens.primary);
  if (bars) {
    const gap = 6;
    const bw = (W - gap * (values.length - 1)) / values.length;
    return svgRoot(
      `0 0 ${W} ${H}`,
      "none",
      values.map((v, i) => {
        const h = Math.max(3, ((v - min) / range) * (H - 8) + 6);
        return svgEl("rect", {
          x: +(i * (bw + gap)).toFixed(2),
          y: +(H - h).toFixed(2),
          width: +bw.toFixed(2),
          height: +h.toFixed(2),
          rx: +Math.min(6, bw / 3).toFixed(2),
          fill: i === values.length - 1 ? color : alpha(color, 0.35),
        });
      }),
    );
  }
  const pts = values.map(
    (v, i) => [(i / (values.length - 1)) * W, H - 6 - ((v - min) / range) * (H - 14)] as const,
  );
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const gid = `g-${dsl.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const last = pts[pts.length - 1] ?? [0, 0];
  return svgRoot(`0 0 ${W} ${H}`, "none", [
    svgEl("defs", {}, [
      svgEl("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, [
        svgEl("stop", { offset: 0, "stop-color": color, "stop-opacity": 0.35 }),
        svgEl("stop", { offset: 1, "stop-color": color, "stop-opacity": 0 }),
      ]),
    ]),
    svgEl("path", { d: `${d} L${W},${H} L0,${H} Z`, fill: `url(#${gid})` }),
    svgEl("path", {
      d,
      fill: "none",
      stroke: color,
      "stroke-width": 2.5,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      "vector-effect": "non-scaling-stroke",
    }),
    svgEl("circle", {
      cx: last[0].toFixed(1),
      cy: last[1].toFixed(1),
      r: 4,
      fill: color,
      stroke: "#fff",
      "stroke-width": 1.5,
      "vector-effect": "non-scaling-stroke",
    }),
  ]);
}

function mapIr(tokens: SceneTokens): IrElement {
  const dark = tokens.theme === "dark";
  const land = dark ? "#1c2230" : "#e8ecef";
  const water = dark ? "#121a26" : "#cfe3f3";
  const road = dark ? "#2a3243" : "#ffffff";
  const park = alpha(tokens.success ?? "#22c55e", dark ? 0.18 : 0.25);
  return svgRoot("0 0 300 200", "xMidYMid slice", [
    svgEl("rect", { width: 300, height: 200, fill: land }),
    svgEl("path", {
      d: "M-10,150 C60,120 120,170 200,140 S300,120 320,150 L320,220 L-10,220 Z",
      fill: water,
    }),
    svgEl("circle", { cx: 70, cy: 60, r: 34, fill: park }),
    svgEl("rect", { x: 190, y: 30, width: 70, height: 46, rx: 10, fill: park }),
    ...[20, 70, 120, 170].map((y) =>
      svgEl("line", { x1: 0, y1: y, x2: 300, y2: y + 12, stroke: road, "stroke-width": y === 70 ? 7 : 4 }),
    ),
    ...[50, 110, 180, 250].map((x) =>
      svgEl("line", { x1: x, y1: 0, x2: x - 14, y2: 200, stroke: road, "stroke-width": x === 180 ? 7 : 4 }),
    ),
    svgEl("line", {
      x1: 0,
      y1: 70,
      x2: 300,
      y2: 82,
      stroke: alpha(tokens.warning ?? "#f59e0b", 0.6),
      "stroke-width": 2.5,
      "stroke-dasharray": "10 8",
    }),
  ]);
}

/** Photographer credits used by a screen (deduplicated by URL). */
/**
 * The screen as it was measured at another viewport width of its layout range (URL capture: each layer's
 * `layout.fluid` entry at `at` replaces its geometry; docs/responsive.md "Layout ranges"). Same tree, other numbers:
 * the fluid export (responsive.ts fluidVariants) interpolates every value between this and the screen itself.
 */
export function measuredScreen(screen: SceneScreen, at: number): SceneScreen {
  /**
   * `dw`: how much wider the parent is at `at` than at the design width. A layer the alt walk did not pair (no
   * fluid entry there) follows its parent by its constraints instead of keeping its design-width box — a stretched
   * band keeps its insets, a right-pinned box keeps its right inset — else the interpolation between the two would
   * read a full-width layer as a fixed-width one (its right inset growing with the viewport).
   */
  const apply = (e: SceneElement, dw: number): SceneElement => {
    let out = e;
    const w0 = typeof e.layout?.width === "number" ? e.layout.width : null;
    if (e.layout?.fluid) {
      const { fluid, ...layout } = e.layout;
      const f = fluid.find((x) => x.at === at);
      out = { ...e, layout };
      if (f) {
        const { at: _at, fontSize, lineHeightPx, letterSpacing, src, ...geo } = f;
        out.layout = { ...layout, ...geo };
        if (src && out.image) out.image = { ...out.image, src };
        if (fontSize !== undefined || lineHeightPx !== undefined || letterSpacing !== undefined) {
          out.style = {
            ...out.style,
            ...(fontSize !== undefined ? { fontSize } : {}),
            ...(lineHeightPx !== undefined ? { lineHeightPx } : {}),
            ...(letterSpacing !== undefined ? { letterSpacing } : {}),
          };
        }
      } else if (dw && out.layout) out = { ...out, layout: followParent(out.layout, dw) };
    } else if (dw && e.layout) out = { ...e, layout: followParent(e.layout, dw) };
    const w1 = typeof out.layout?.width === "number" ? out.layout.width : null;
    // a layer filling its parent is as much wider as the parent (not wider than its cap: the import sets maxWidth on
    // a box that sits at its cap)
    const childDw =
      w0 !== null && w1 !== null
        ? w1 - w0
        : e.layout?.width === "fill" || e.layout?.width === "100%"
          ? e.layout.maxWidth !== undefined && dw > 0
            ? 0
            : dw
          : 0;
    if (e.children) out = { ...out, children: e.children.map((c) => apply(c, childDw)) };
    return out;
  };
  const root = apply(screen.root, at - screen.width);
  return {
    ...screen,
    width: at,
    height: typeof root.layout?.height === "number" ? root.layout.height : screen.height,
    root,
  };
}

/** An absolutely placed layer's box in a parent `dw` px wider, by its horizontal constraint (Figma semantics). */
function followParent(
  layout: NonNullable<SceneElement["layout"]>,
  dw: number,
): NonNullable<SceneElement["layout"]> {
  if (layout.position !== "absolute") return layout;
  const h = layout.constraints?.horizontal;
  const x = typeof layout.x === "number" ? layout.x : null;
  const w = typeof layout.width === "number" ? layout.width : null;
  if (h === "left-right" && w !== null) return { ...layout, width: Math.max(0, w + dw) };
  if (h === "right" && x !== null) return { ...layout, x: x + dw };
  if (h === "center" && x !== null) return { ...layout, x: x + dw / 2 };
  return layout;
}

export function creditsOf(screen: SceneScreen): Array<{ name: string; url: string; image: string }> {
  const out = new Map<string, { name: string; url: string; image: string }>();
  const visit = (e: SceneElement) => {
    const a = e.image?.author;
    if (a?.name)
      out.set(a.url || a.name, {
        name: a.name,
        url: a.url,
        image: e.image?.alt ?? e.image?.query ?? e.name ?? "photo",
      });
    e.children?.forEach(visit);
  };
  visit(screen.root);
  return [...out.values()];
}

/**
 * True vector SVG for an element made of vector geometry (a vector, or a frame / imported SVG whose subtree is
 * vectors, shapes, text and images positioned absolutely). Null when the element needs the DOM (flex layout,
 * components) — callers fall back to the rendered (foreignObject) SVG.
 */
export function vectorSvgOf(
  screen: SceneScreen,
  elementId: string,
  baseTokens?: Partial<SceneTokens>,
): string | null {
  const found = findElement(screen.root, elementId);
  if (!found) return null;
  const ok = (e: SceneElement, root: boolean): boolean => {
    if (e.meta?.hidden === true) return true;
    const abs = root || e.layout?.position === "absolute";
    const sized = typeof e.layout?.width === "number" && typeof e.layout?.height === "number";
    if (e.type === "vector") return !!e.vector && sized;
    if (e.type === "text") return abs;
    if (e.type === "image") return abs && sized;
    if (e.type === "frame") return sized && (root || abs) && (e.children ?? []).every((c) => ok(c, false));
    return false;
  };
  if (
    !ok(found, true) ||
    (found.type !== "vector" && !(found.children ?? []).some((c) => c.type === "vector"))
  )
    return null;
  return elementToSvg(found, resolveTokens(baseTokens, screen.tokens));
}
