// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
/**
 * Design DSL v1 — the canonical, model-friendly description of a screen (PLAN.md §4A.4).
 * The AI emits this JSON; the DOM renderer turns it into HTML/CSS; Pro-mode panels edit it.
 * Colors may be literal (#hex / rgba()) or token refs like "$primary", "$surface", "$text".
 */
import type { BrandCapture, BrandGuide } from "./brand.js";

export type SceneVersion = 1;

export interface SceneTokens {
  theme: "dark" | "light";
  primary: string;
  secondary?: string;
  accent?: string;
  background: string;
  surface: string;
  surfaceAlt?: string;
  text: string;
  textMuted: string;
  border: string;
  success?: string;
  warning?: string;
  danger?: string;
  /** base corner radius in px; components derive from it */
  radius: number;
  /** base spacing unit in px (4 or 8) */
  spacing: number;
  fontFamily: string;
  fontMono?: string;
}

export type SceneElementType =
  | "frame"
  | "text"
  | "image"
  | "button"
  | "input"
  | "icon"
  | "divider"
  | "spacer"
  | "avatar"
  | "badge"
  | "toggle"
  | "checkbox"
  | "progress"
  | "slider"
  | "chart"
  | "map"
  | "statusbar"
  | "navbar"
  | "tabbar"
  | "list"
  | "card"
  | "video"
  /** wave 3: free vector path drawn with the pen/pencil tools or imported from SVG/.fig */
  | "vector";

export type SceneSize = number | "fill" | "hug" | `${number}%`;
/** wave 4: px number or a percent string (of the box, or of the containing block for positions) */
export type SceneLength = number | `${number}%`;

export interface SceneLayout {
  direction?: "row" | "column";
  gap?: number;
  /** uniform | [vertical, horizontal] | [top, right, bottom, left] */
  padding?: number | [number, number] | [number, number, number, number];
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between" | "around" | "evenly";
  wrap?: boolean;
  width?: SceneSize;
  height?: SceneSize;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  grow?: number;
  position?: "auto" | "absolute";
  x?: number;
  y?: number;
  z?: number;
  scroll?: "none" | "vertical" | "horizontal";
  /** scrolling frame: no visible scrollbar (carousels, menu panes) */
  scrollbar?: "hidden";
  /** scrolling frame: scrolling comes to rest on a child marked `snapAlign` (CSS scroll-snap, mandatory) */
  snap?: boolean;
  /** snapping frame: px from its start edge where a snapped child comes to rest (scroll-padding; the first slide's inset) */
  snapPadding?: number;
  /** descendant of a `snap` frame that scrolling rests on (a slide) */
  snapAlign?: "start" | "center" | "end";
  /** wave 3 (prototype): how a child of a scrolling frame behaves while it scrolls — moves with the content (default), stays fixed, or sticks to the top once reached */
  scrollBehavior?: "scroll" | "fixed" | "sticky";
  clip?: boolean;
  /** wave 3: rotation in degrees, clockwise, around the element centre */
  rotation?: number;
  /** wave 3: flip */
  flipX?: boolean;
  flipY?: boolean;
  /** wave 3: constraints applied when the parent (non-auto-layout) resizes */
  constraints?: {
    horizontal: "left" | "right" | "center" | "left-right" | "scale";
    vertical: "top" | "bottom" | "center" | "top-bottom" | "scale";
  };
  /* ---- wave 4: CSS-level fidelity (all optional; renderer + exporters honour them, see dsl/styles.ts) ---- */
  /** CSS margin, negatives allowed: uniform | [vertical, horizontal] | [top, right, bottom, left] */
  margin?: number | [number, number] | [number, number, number, number];
  /** cross-axis alignment of this element inside its auto-layout parent (overrides the parent's `align`) */
  alignSelf?: "auto" | "start" | "center" | "end" | "stretch" | "baseline";
  /** spacing between wrapped lines of a `wrap` frame (Figma counter-axis spacing); default = gap */
  crossGap?: number;
  /**
   * CSS grid instead of flex for this frame. `columns`: count (equal `minmax(0, 1fr)` tracks) or track list
   * ('240px' | '1fr' | 'auto' | 'minmax(0, 1fr)' | 'repeat(3, 1fr)' …). Gaps default to `layout.gap`.
   * `direction` / `wrap` are ignored on a grid; `align` / `justify` map to align-items / justify-content.
   */
  grid?: {
    columns: number | string[];
    rows?: number | string[];
    columnGap?: number;
    rowGap?: number;
    autoRows?: string;
    flow?: "row" | "column" | "row dense" | "column dense";
  };
  /** grid child: number of tracks spanned (default 1) */
  colSpan?: number;
  rowSpan?: number;
  /** absolute children: anchor to the parent's right / bottom edge instead of x / y (x / y win when both are set) */
  right?: number;
  bottom?: number;
  /** uniform or [x, y] scale around the centre (applied after rotation) */
  scale?: number | [number, number];
  /**
   * URL capture: this layer's geometry at other viewport widths of its layout range (the same page measured again
   * there, only what differs from the values above). Exports interpolate between the widths (export/responsive.ts).
   */
  fluid?: SceneFluidAt[];
}

/** A layer's geometry at another viewport width (`at`, CSS px) of the same layout (SceneLayout.fluid). */
export interface SceneFluidAt {
  at: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  right?: number;
  bottom?: number;
  gap?: number;
  crossGap?: number;
  padding?: [number, number, number, number];
  margin?: [number, number, number, number];
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  /** an image's other picture there (the page's art direction: another crop, not another resolution) */
  src?: string;
}

/** wave 4: one exact CSS shadow. Boxes → box-shadow, text → text-shadow (no spread / inset), vectors / svg icons → drop-shadow(). */
export interface SceneShadow {
  x: number;
  y: number;
  blur: number;
  spread?: number;
  color: string;
  inset?: boolean;
}

/** wave 4: gradient colour stop; `pos` 0..1 along the gradient line (omitted = evenly spaced); colours may carry alpha */
export interface SceneGradientStop {
  color: string;
  pos?: number;
}

/** wave 4: multi-stop gradient (CSS semantics) */
export interface SceneGradient {
  /** default 'linear' */
  kind?: "linear" | "radial" | "conic";
  /** linear / conic: CSS degrees (0 = to top, 90 = to right, 180 = to bottom); default 180 */
  angle?: number;
  stops: SceneGradientStop[];
  /** radial: default 'ellipse' */
  shape?: "ellipse" | "circle";
  /** radial extent: keyword or explicit radii [rx, ry]; default 'farthest-corner' */
  size?: "closest-side" | "closest-corner" | "farthest-side" | "farthest-corner" | [SceneLength, SceneLength];
  /** radial / conic centre [x, y]; default ['50%', '50%'] */
  at?: [SceneLength, SceneLength];
  repeating?: boolean;
}

/**
 * wave 4: one background layer. `style.fills` is a CSS background stack: the FIRST layer paints on top
 * (CSS order, not Figma's). `style.background` stays the solid colour underneath all layers.
 */
export type SceneFill =
  | { type: "solid"; color: string }
  | ({ type: "gradient" } & SceneGradient)
  | {
      type: "image";
      /** http(s) or data:image URL */
      src: string;
      /** default 'cover'; [w, h] with 'auto' for either axis */
      size?: "cover" | "contain" | "auto" | [SceneLength | "auto", SceneLength | "auto"];
      /** default ['50%', '50%'] */
      position?: [SceneLength, SceneLength];
      /** default 'no-repeat' */
      repeat?: "no-repeat" | "repeat" | "repeat-x" | "repeat-y";
    };

/** wave 4: one border side */
export interface SceneStroke {
  width: number;
  color: string;
  style?: "solid" | "dashed" | "dotted";
}

/** wave 4: CSS filter functions (identity: blur 0, brightness / contrast / saturate 1, grayscale / sepia / invert 0, hueRotate 0deg) */
export interface SceneFilter {
  blur?: number;
  brightness?: number;
  contrast?: number;
  saturate?: number;
  grayscale?: number;
  sepia?: number;
  invert?: number;
  hueRotate?: number;
}

export type SceneBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "plus-lighter"
  | "plus-darker";

/**
 * wave 4: CSS mask layer on the element itself (recolourable icon masks, fade-out edges). One source: `src`
 * (http(s) / data:image URL), `svg` (markup, sanitised) or `gradient`. Opaque mask pixels keep the element visible.
 */
export interface SceneMaskImage {
  src?: string;
  svg?: string;
  gradient?: SceneGradient;
  /** default 'contain' for src / svg, '100% 100%' for a gradient */
  size?: "cover" | "contain" | "auto" | [SceneLength | "auto", SceneLength | "auto"];
  /** default ['50%', '50%'] */
  position?: [SceneLength, SceneLength];
  /** default 'no-repeat' */
  repeat?: "no-repeat" | "repeat" | "repeat-x" | "repeat-y";
  /** default 'alpha' */
  mode?: "alpha" | "luminance";
}

/** wave 4: CSS outline (outside the border box unless offset is negative); never affects layout */
export interface SceneOutline {
  width: number;
  color: string;
  style?: "solid" | "dashed" | "dotted";
  offset?: number;
}

/** wave 4: text decoration with CSS details */
export interface SceneDecoration {
  line?: "underline" | "line-through" | "overline" | "none";
  color?: string;
  /** px */
  thickness?: number;
  /** underline offset, px */
  offset?: number;
  style?: "solid" | "double" | "dotted" | "dashed" | "wavy";
}

export interface SceneStyle {
  background?: string;
  gradient?: { from: string; to: string; angle?: number };
  color?: string;
  radius?: number | [number, number, number, number];
  /** `sides` limits the stroke to some edges (table rules / hairlines); omitted = all four */
  border?: {
    width: number;
    color: string;
    style?: "solid" | "dashed" | "dotted";
    sides?: ("top" | "right" | "bottom" | "left")[];
  };
  shadow?: "none" | "sm" | "md" | "lg" | "glow";
  opacity?: number;
  blur?: number;
  /** text */
  textStyle?: "display" | "headline" | "title" | "body" | "label" | "caption";
  /**
   * per-element family (overrides tokens.fontFamily); mapped to the closest bundled/system face by dsl/fontStack.
   * May be a CSS fallback list ('BMWTypeNext, Helvetica, Arial, sans-serif'): the first entry is the family, the rest are
   * tried before the computed fallbacks (validate also accepts an array and stores the comma list).
   */
  fontFamily?: string;
  fontSize?: number;
  /** 100–900 (wave 4 widened from 400–800) */
  fontWeight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  /** multiplier of the font size */
  lineHeight?: number;
  /** em */
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right" | "justify";
  uppercase?: boolean;
  underline?: boolean;
  /** never wrap (single-line labels copied from a reference keep their line even if the fallback font runs wider) */
  noWrap?: boolean;
  /** true = single line ellipsis, number = max lines */
  truncate?: boolean | number;
  /** media */
  aspect?: number;
  /** image / video object-fit (wave 4 adds fill / none / scale-down) */
  fit?: "cover" | "contain" | "fill" | "none" | "scale-down";

  /* ---- wave 4: CSS-level fidelity (all optional) ---- */
  /** background layers above `background`, first = top (see SceneFill); wins over `gradient` */
  fills?: SceneFill[];
  /** exact shadows, first = top; wins over the `shadow` preset */
  shadows?: SceneShadow[];
  /** per-side borders; each given side overrides `border` on that side */
  borders?: { top?: SceneStroke; right?: SceneStroke; bottom?: SceneStroke; left?: SceneStroke };
  blend?: SceneBlendMode;
  /** layer filters (CSS filter) */
  filter?: SceneFilter;
  /** backdrop filters (CSS backdrop-filter); `blur` above stays the shorthand for a backdrop blur */
  backdrop?: SceneFilter;
  italic?: boolean;
  /** wins over `uppercase` */
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  /** wins over `underline` */
  decoration?: SceneDecoration;
  /** wins over `noWrap`; text defaults to 'pre-wrap' */
  whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
  /** exact line height in px; wins over `lineHeight` */
  lineHeightPx?: number;
  /** CSS font-feature-settings, e.g. '"tnum" 1, "ss01" 1' */
  fontFeatures?: string;
  /** CSS font-stretch as a percentage ('130%': the wide cut of a variable font with a width axis) */
  fontStretch?: string;
  /** image / video object-position, or the focus of a `fit: cover` crop: [x, y], default ['50%', '50%'] */
  objectPosition?: [SceneLength, SceneLength];
  /** mask on the element itself (CSS mask-image); independent of `mask` sibling masking */
  maskImage?: SceneMaskImage;
  /** CSS text-wrap: balanced headings / no orphans */
  textWrap?: "balance" | "pretty";
  /** CSS hyphens; 'auto' needs a language (element or screen `lang`) */
  hyphens?: "auto" | "manual" | "none";
  outline?: SceneOutline;
  /** CSS clip-path basic shape: inset(…) | circle(…) | ellipse(…) | polygon(…) | path('…') (no url()) */
  clipPath?: string;
  /** 'text' paints the background (fills / gradient) through the glyphs (gradient text); colour becomes transparent */
  backgroundClip?: "border-box" | "padding-box" | "content-box" | "text";
}

/** wave 4: style a rich-text run may override (inherits everything else from its text element) */
export type SceneRunStyle = Pick<
  SceneStyle,
  | "color"
  | "background"
  | "fontFamily"
  | "fontSize"
  | "fontWeight"
  | "italic"
  | "letterSpacing"
  | "lineHeight"
  | "lineHeightPx"
  | "underline"
  | "decoration"
  | "uppercase"
  | "textTransform"
  | "fontFeatures"
  | "fontStretch"
  | "opacity"
>;

/** wave 4: one styled span of a text element */
export interface SceneTextRun {
  text: string;
  style?: SceneRunStyle;
  /** link (an <a> in exports; never navigates on the canvas) — http(s):, mailto:, tel: or #anchor */
  href?: string;
}

export interface SceneImage {
  /** Unsplash search query the renderer/agent resolves to a photo */
  query?: string;
  src?: string;
  alt?: string;
  unsplashId?: string;
  author?: { name: string; url: string };
}

export interface SceneInteraction {
  /**
   * wave 3 adds: open/swap/close overlay, scroll-to (target = element id in the same screen), set-variable and
   * conditional (if variable … then actions else actions).
   */
  onTap?:
    | "navigate"
    | "back"
    | "open-url"
    | "toggle"
    | "none"
    | "open-overlay"
    | "swap-overlay"
    | "close-overlay"
    | "scroll-to"
    | "scroll-by"
    | "set-state"
    | "set-variable"
    | "conditional";
  /** target screen id for navigate / open-overlay / swap-overlay; element id for scroll-to; scrolling frame id for scroll-by */
  target?: string;
  /** scroll-by: move the frame to its next / previous child (a carousel's arrows), smoothly unless duration is 0 */
  direction?: "next" | "prev";
  /** scroll-by: one child at a time ('slide', default) or a page: the first child not wholly in view comes to the start */
  by?: "slide" | "page";
  /** set-state: id of the child of the `target` state frame (SceneElement.states) to show */
  state?: string;
  /**
   * set-state from a drop-down: its choices, each showing a state; `state` is the one shown now. Exports put a native
   * select over the element (the phone's own picker on a phone)
   */
  options?: { label: string; state: string }[];
  url?: string;
  transition?: "instant" | "dissolve" | "slide-left" | "slide-up" | "smart";
  /** wave 3: animation curve of the transition (default 'ease-out') */
  easing?: SceneEasing;
  /** wave 3: transition duration in ms (default 320) */
  duration?: number;
  /** wave 3: open-overlay / swap-overlay presentation */
  overlay?: SceneOverlaySettings;
  /** wave 3: set-variable — variable id (designSystem.variables) and the new value (or an operation on it) */
  variable?: { id: string; op?: "set" | "toggle" | "increment" | "decrement"; value?: SceneVariableValue };
  /** wave 3: conditional — `if` compares a variable with a value; `then` / `else` run in order (no `if`: `then` always runs — a sequence of actions) */
  if?: {
    variableId: string;
    op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
    value: string | number | boolean;
  };
  then?: SceneInteraction[];
  else?: SceneInteraction[];
}

/** wave 3: easing presets (Figma names) or a custom cubic-bezier(x1, y1, x2, y2) */
export type SceneEasing =
  | "linear"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "ease-in-back"
  | "ease-out-back"
  | "ease-in-out-back"
  | { bezier: [number, number, number, number] };

/** wave 3: where an overlay appears over the current screen */
export interface SceneOverlaySettings {
  position?:
    | "center"
    | "top-left"
    | "top-center"
    | "top-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right"
    | "manual";
  /** manual position: offset of the overlay's top-left corner in screen px */
  offset?: { x: number; y: number };
  closeOnOutsideClick?: boolean;
  /** colour of the dim layer behind the overlay ('none' = no background); default rgba(0,0,0,0.4) */
  background?: string;
  /** blur (px) of the page seen through the dim layer (`backdrop-filter: blur()`) */
  blur?: number;
  /**
   * entrance (exit = reversed), with the interaction's duration / easing: slides fully in from that edge of the
   * screen, or fades in place ('fade'), or appears at once ('none'). Default: a short nudge by `position`.
   */
  enter?: "left" | "right" | "top" | "bottom" | "fade" | "none";
}

/** wave 5: boolean group operation (Figma UNION / SUBTRACT / INTERSECT / XOR) */
export type SceneBooleanOp = "union" | "subtract" | "intersect" | "exclude";

export interface SceneElement {
  id: string;
  type: SceneElementType;
  /** layer name shown in the Layers panel; defaults to type */
  name?: string;
  text?: string;
  /** lucide icon name in kebab-case, e.g. "arrow-left" */
  icon?: string;
  image?: SceneImage;
  /** component variant: button primary|secondary|outlined|ghost|danger; input default|search; badge default|success|warning|danger; list default|inset */
  variant?: string;
  placeholder?: string;
  value?: string | number | boolean;
  layout?: SceneLayout;
  style?: SceneStyle;
  interaction?: SceneInteraction;
  children?: SceneElement[];
  /** wave 3: vector geometry for `type: 'vector'` (SVG path data in the element's own box, 0..width × 0..height) */
  vector?: SceneVector;
  /** wave 3: this element masks its following siblings (alpha mask) */
  mask?: boolean;
  /**
   * wave 5 (PLAN 7.3): live boolean group. Only on `type: 'frame'` without auto layout: the absolutely positioned
   * children are the operands (paint order, bottom first) and stay editable; the renderer / exporters draw the
   * combined outline (dsl/BooleanGroup.tsx, vector/booleanGroups.ts). Paint: `vector` paint fields, else
   * `style.background` / `style.border`, else the bottom operand's paint.
   */
  boolean?: { op: SceneBooleanOp };
  /** wave 3: component instance link (main component id in designSystem.components) + variant/property values */
  instance?: {
    componentId: string;
    variant?: Record<string, string>;
    props?: Record<string, string | boolean>;
    /** keyed by main element id (`#root` = the instance root; nested instances: `inner__el`); `null` values = removed here */
    overrides?: Record<string, SceneOverride>;
    /**
     * layers added inside this instance (not in the main), keyed by the parent's main element id (`#root` for the
     * instance root); `index` = position in the rebuilt parent's children. Survive rebuilds and main edits.
     */
    additions?: Record<string, { index: number; el: SceneElement }[]>;
  };
  /** wave 3: style references (designSystem.styles ids); concrete values in `style` are kept in sync by the style editor */
  styleRefs?: { text?: string; fill?: string; effect?: string };
  /** wave 3: variable bindings: property path → variable id, e.g. { "style.background": "var-123", "layout.gap": "var-9" } */
  bindings?: Record<string, string>;
  /**
   * the children are alternative states of one region (a filtered list, an expanded card): only `active` (default:
   * the first child) shows; `set-state` taps switch it in the prototype, and the content below moves with its height
   */
  states?: { active?: string };
  /**
   * wave 4: rich text for `type: 'text'` — styled spans rendered in order. `text` must stay the plain concatenation
   * (search, layers, AI context and older readers use it); inline editing on the canvas flattens runs back to `text`.
   */
  runs?: SceneTextRun[];
  /**
   * wave 4: inline SVG markup (`<svg …>…</svg>`, sanitised before rendering) for `type: 'icon'` and `type: 'vector'`:
   * logos, brand / social glyphs. Scaled into the element box (keep its viewBox); `currentColor` = style.color.
   * Wins over `icon` (lucide) and `vector`.
   */
  svg?: string;
  /** wave 4: BCP 47 language of this subtree (hyphenation, quotes), e.g. "de"; inherits the screen's `lang` */
  lang?: string;
  /** free-form for the agent (e.g. semantic role); never rendered */
  meta?: Record<string, string | number | boolean>;
  /**
   * app state (Preview and the HTML / React exports): shown only while the condition on a prototype variable holds
   * (an option's "selected" ring, a result). The canvas shows it as the variables' defaults decide.
   */
  showIf?: {
    variableId: string;
    op?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
    value: string | number | boolean;
  };
  /** motion (Preview and exports): an entrance each time the layer is shown ('show', e.g. a step of a flow) or scrolls into view; `counter` counts its number up */
  motion?: SceneMotion;
}

/** Entrance / counter of a layer in Preview and the exports (CSS keyframes, never on the canvas). */
export interface SceneMotion {
  enter?: "fade" | "rise" | "slide" | "zoom" | "pop";
  /** 'show' (default): whenever it appears (page load, a state switch); 'view': once it scrolls into view */
  trigger?: "show" | "view";
  /** ms */
  delay?: number;
  /** ms (default 480) */
  duration?: number;
  /** a text with a number in it counts up to it when shown */
  counter?: boolean;
}

type Nullable<T> = { [K in keyof T]?: T[K] | null };
/**
 * An instance override: the properties of one layer that differ from its main. `null` marks a property (or a
 * style / layout key) that the instance removed. Nested objects other than style / layout / meta replace wholesale.
 */
export type SceneOverride = Omit<Nullable<SceneElement>, "style" | "layout" | "meta" | "id" | "children"> & {
  style?: Nullable<SceneStyle> | null;
  layout?: Nullable<SceneLayout> | null;
  meta?: Nullable<NonNullable<SceneElement["meta"]>> | null;
};

export interface SceneScreen {
  version: SceneVersion;
  id: string;
  name: string;
  platform: "app" | "web";
  width: number;
  height: number;
  /** screen-level overrides on top of the project design system tokens */
  tokens?: Partial<SceneTokens>;
  /** wave 4: BCP 47 language of the page, e.g. "de-DE" (hyphens: 'auto' needs it) */
  lang?: string;
  /** wave 3: selected variable mode per collection for this screen (collectionId → modeId) */
  variableModes?: Record<string, string>;
  /**
   * Breakpoint variant of a responsive page: screens sharing `group` are one page captured / designed at several
   * widths; this one applies from `minWidth` (CSS px, inclusive) up to the next variant's minWidth. See docs/responsive.md.
   */
  responsive?: {
    group: string;
    minWidth: number;
    /**
     * other viewport widths this variant was measured at (its layers' `layout.fluid`): its layout range is known, it
     * applies from `minWidth` exactly and follows the measured geometry in between
     */
    measured?: number[];
  };
  /** brand-guide extras of a URL capture (states, custom properties, media queries, marks, images…; brandmd/types.ts) */
  capture?: BrandCapture;
  root: SceneElement;
}

/** 7.2 handle mirroring of a vector point: none (independent handles), angle (colinear), length (angle and length). */
export type SceneMirror = "none" | "angle" | "length";

export interface SceneVector {
  /** SVG path `d` in element-local coordinates */
  path: string;
  fillRule?: "nonzero" | "evenodd";
  /** fill / stroke colours (literal or `$token`); stroke width in px */
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  strokeCap?: "butt" | "round" | "square";
  strokeJoin?: "miter" | "round" | "bevel";
  dash?: number[];
  /** editable network for the pen tool: anchor points with optional bezier handles (absolute, element-local) */
  points?: {
    x: number;
    y: number;
    in?: [number, number];
    out?: [number, number];
    corner?: boolean;
    mirror?: SceneMirror;
  }[];
  closed?: boolean;
  /**
   * 7.2 paint bucket: filled regions. Each key names one face of the closed subpaths' arrangement by the sorted
   * indices of the closed subpaths that contain it ('0', '0+1' …). Absent = the whole path is filled by `fillRule`.
   */
  fillRegions?: string[];
}

/** wave 3: Figma-style variables */
export type SceneVariableType = "color" | "number" | "string" | "boolean";
export type SceneVariableValue = string | number | boolean | { alias: string };
export interface SceneVariable {
  id: string;
  name: string;
  type: SceneVariableType;
  values: Record<string, SceneVariableValue>;
  scopes?: string[];
  description?: string;
  /**
   * computed in the prototype / exports: a template whose `{…}` parts are sums over other variables' names or ids
   * (`€ {base + colourPrice + wheelsPrice}`); `values` hold the result for the defaults (what the canvas shows)
   */
  expr?: string;
}
export interface SceneVariableCollection {
  id: string;
  name: string;
  modes: { id: string; name: string }[];
  defaultModeId: string;
  variables: SceneVariable[];
}

/** wave 3: shared styles */
export interface SceneTextStyle {
  id: string;
  name: string;
  fontFamily?: string;
  fontSize: number;
  fontWeight: number;
  lineHeight?: number;
  letterSpacing?: number;
  uppercase?: boolean;
}
export interface ScenePaintStyle {
  id: string;
  name: string;
  color?: string;
  gradient?: { from: string; to: string; angle?: number };
}
export interface SceneEffectStyle {
  id: string;
  name: string;
  shadow?: "none" | "sm" | "md" | "lg" | "glow";
  blur?: number;
  /** wave 5: exact shadows (win over the `shadow` preset; written to `style.shadows` when present) */
  shadows?: SceneShadow[];
  /** wave 5: layer blur in px (written to `style.filter.blur` when present) */
  layerBlur?: number;
  description?: string;
}

/** wave 3: component sets with variants and properties */
/** Where a component belongs in a design system (components/library/catalog.ts: order, labels, classification). */
export type SceneComponentCategory =
  "shell" | "sections" | "content" | "navigation" | "forms" | "feedback" | "media" | "foundations";

/** What a component is (drives its category, its docs, its framework export and what a complete system still lacks). */
export type SceneComponentKind =
  | "header"
  | "footer"
  | "hero"
  | "section"
  | "navigation"
  | "menu"
  | "breadcrumb"
  | "pagination"
  | "tabs"
  | "link"
  | "card"
  | "teaser"
  | "list-item"
  | "list"
  | "accordion"
  | "carousel"
  | "table"
  | "quote"
  | "stat"
  | "button"
  | "icon-button"
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "toggle"
  | "search"
  | "form"
  | "badge"
  | "tag"
  | "alert"
  | "toast"
  | "modal"
  | "tooltip"
  | "progress"
  | "image"
  | "video"
  | "lightbox"
  | "avatar"
  | "icon"
  | "logo"
  | "text"
  | "divider"
  | "other";

export interface SceneComponentDef {
  id: string;
  name: string;
  description?: string;
  /** design-system placement (catalog.ts classifyComponent fills it when missing) */
  category?: SceneComponentCategory;
  kind?: SceneComponentKind;
  /** how the set came to be: extracted from screens, generated to complete a system (brandKit.ts), or made by hand */
  origin?: "extracted" | "generated" | "manual";
  /** variant axes, e.g. { size: ['sm','md','lg'], state: ['default','hover'] } */
  variantAxes?: Record<string, string[]>;
  /** variant key ("size=md,state=default") → element tree */
  variants: Record<string, SceneElement>;
  defaultVariant: string;
  /**
   * component properties exposed on instances: `text` sets the target's text, `boolean` shows / hides it,
   * `instance-swap` swaps the nested instance's component (value: set id), `image` sets the target's picture (value: src)
   */
  properties?: {
    name: string;
    type: "text" | "boolean" | "instance-swap" | "image";
    default: string | boolean;
    target: string; /* element id inside the variant */
  }[];
  /**
   * variant key → width its main is shown at on the Components frame when the main's own width is relative ('fill':
   * the width it had where it came from, e.g. a section of a 390 px page)
   */
  previewWidths?: Record<string, number>;
  /**
   * names given to content slots that are not component properties (`<target>:<field>` → prop label, e.g.
   * `"t3:text" → "Image caption"`); catalog.ts componentApi uses them instead of the derived role name
   */
  propNames?: Record<string, string>;
}

export interface SceneDesignSystem {
  version: SceneVersion;
  name: string;
  tokens: SceneTokens;
  /** optional component presets the agent should reuse (buttons, cards, inputs…) */
  components?: Record<string, SceneElement>;
  /** human-readable Design.md */
  notes?: string;
  /** wave 3 */
  variables?: SceneVariableCollection[];
  styles?: { text: SceneTextStyle[]; paint: ScenePaintStyle[]; effect: SceneEffectStyle[] };
  componentSets?: SceneComponentDef[];
  /** the last brand guide run (brandmd/run.ts): DESIGN.md + the facts behind it; `notes` holds the same markdown */
  brandGuide?: BrandGuide;
}

export const DEFAULT_TOKENS: SceneTokens = {
  theme: "dark",
  primary: "#8b5cf6",
  background: "#0f0f12",
  surface: "#17171b",
  surfaceAlt: "#1f1f25",
  text: "#f4f4f5",
  textMuted: "#a1a1aa",
  border: "rgba(255,255,255,0.08)",
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#ef4444",
  radius: 12,
  spacing: 8,
  fontFamily: "Inter",
  fontMono: "JetBrains Mono",
};

// ---------------------------------------------------------------- short names

/** One captured page at one layout range (a breakpoint variant). */
export type Screen = SceneScreen;
/** A component set with its variant axes, variants and properties. */
export type ComponentSet = SceneComponentDef;
/** Tokens, shared styles, variables and component sets of a recreated page. */
export type DesignSystem = SceneDesignSystem;
