// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Snapshot format produced by domCapture.js (one capture script for the Node driver and fig-server) and consumed by
// convert.ts. Coordinates are CSS px in page space (top-left of the document, scroll 0); rects are border boxes
// (axis-aligned bounds for transformed boxes). Only non-default style values are present.
import type { BrandCapture } from "@harness/protocol";

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapFont {
  /** family the browser actually draws with (first loaded webfont of the stack, else first named family) */
  family: string;
  stack: string;
  size: number;
  /** px from the line rect top to the baseline */
  ascent?: number;
  weight: number;
  italic?: boolean;
  /** px; null = 'normal' */
  lineHeight: number | null;
  /** px */
  letterSpacing: number;
  color: string;
  transform?: string;
  decoration?: { line: string; color: string; thickness: string; style: string; offset: string };
  align: string;
  whiteSpace: string;
  shadow?: string;
  features?: string;
  textWrap?: "balance" | "pretty";
  hyphens?: "auto";
  /** px added to every space (word-spacing) */
  wordSpacing?: number;
  /** font-variation-settings (variable fonts), e.g. `"wght" 380` */
  variation?: string;
  /** font-stretch when not 100% */
  stretch?: string;
  /** -webkit-text-stroke */
  stroke?: { w: number; color: string };
  /** vertical-align of the text's own box (sup / sub footnote markers) */
  verticalAlign?: "super" | "sub";
  /** gradient text: the background (CSS image) its transparent fill shows, of the box clipping its background to text */
  clipBg?: string;
  /** -webkit-line-clamp of the block the text sits in (lines past it are clipped, the last visible one ends in …) */
  lineClamp?: number;
}

export interface SnapLine extends SnapRect {
  text: string;
  /** how this line continues on the next one: at a space, directly (explicit hyphen / slash), or mid-word (hyphenation) */
  brk?: "space" | "join" | "word";
}

export interface SnapBgLayer {
  image: string;
  url: boolean;
  size: string;
  position: string;
  repeat: string;
  /** background-clip of this layer when not border-box ('padding-box' | 'content-box') */
  clip?: string;
  /** background-origin when not padding-box ('border-box' | 'content-box') */
  origin?: string;
  /** background-attachment: fixed (positioned against the viewport) */
  attachment?: "fixed";
  /** background-blend-mode with the layers / colour below */
  blend?: string;
}
export interface SnapBorderSide {
  w: number;
  style: string;
  color: string;
}

export interface SnapStyle {
  bg?: string;
  bgLayers?: SnapBgLayer[];
  bgClipText?: boolean;
  /** background colour painting area when not the border box ('padding-box' | 'content-box') */
  bgClip?: string;
  /** border-image: drawn instead of the border sides' colours */
  borderImage?: {
    source: string;
    url: boolean;
    slice: string;
    width: string;
    outset: string;
    repeat: string;
  };
  /** top, right, bottom, left (null = no visible stroke on that side) */
  border?: (SnapBorderSide | null)[];
  /** top-left, top-right, bottom-right, bottom-left (px) */
  radius?: number[];
  /**
   * only when a corner is elliptical (`30px / 12px`, a % radius on a non-square box): the used [horizontal, vertical]
   * radius per corner (same order as `radius`), already scaled down where adjacent radii would overlap
   */
  radii?: [number, number][];
  shadow?: string;
  outline?: { w: number; color: string; offset: number; style: string };
  opacity?: number;
  blend?: string;
  filter?: string;
  backdrop?: string;
  overflow?: [string, string];
  clipPath?: string;
  /** one CSS mask-image layer (url or gradient) */
  mask?: { image: string; url: boolean; size: string; position: string; repeat: string; mode?: string };
  transform?: string;
  color?: string;
}

export interface SnapLayout {
  display: string;
  position: string;
  z?: number;
  /** the box establishes a stacking context (z-indexed descendants are painted inside it) */
  stack?: boolean;
  dir?: string;
  wrap?: string;
  justify?: string;
  align?: string;
  gap?: [number, number];
  cols?: string;
  rows?: string;
  /** top, right, bottom, left */
  padding?: number[];
  borderWidth?: number[];
  alignSelf?: string;
  grow?: number;
}

interface SnapBase {
  id: number;
  rect?: SnapRect;
  /** walks at another width of the same page (`Snapshot.alt`): the id this box has in the main walk */
  base?: number;
}

export interface SnapText extends SnapBase {
  kind: "text";
  /** raw text node data (whitespace not collapsed) */
  text: string;
  lines: SnapLine[];
  font: SnapFont;
  parent: number;
  /** list marker synthesised by the capture (bullet / number of an outside ::marker) */
  marker?: boolean;
}

export interface SnapElement extends SnapBase {
  kind?: "img" | "svg" | "raster" | "input" | "br" | "marker";
  tag: string;
  rect: SnapRect;
  layout?: SnapLayout;
  attrs?: Record<string, string>;
  style?: SnapStyle;
  children?: SnapNode[];
  /** materialised ::before / ::after */
  pseudo?: string;
  /**
   * fixed / sticky box the page moves once it scrolls: by `dy` px at 400 px of scroll, along with the page up to there
   * ('scroll') or at once ('step')
   */
  scrollShift?: { dy: number; mode: "scroll" | "step"; after?: number };
  /**
   * id of the DOM parent when the capture re-parented the box to paint it in its stacking context (z-indexed box
   * whose ancestors in between form none); the node then sits right after the subtree it came from
   */
  from?: number;
  /** display: contents */
  contents?: boolean;
  hidden?: boolean;
  /** untransformed size (offsetWidth / offsetHeight) when the box has a transform */
  size?: { w: number; h: number };
  pointer?: boolean;
  /** img */
  src?: string | null;
  natural?: { w: number; h: number };
  objectFit?: string;
  objectPosition?: string;
  alt?: string;
  /** video poster */
  poster?: string;
  /** video: player state when the page was walked (before the driver touched it) */
  video?: { paused: boolean; time: number; ended?: boolean };
  /** video: time (s) of the screenshotted frame when it was matched to a reference screenshot */
  videoTime?: number;
  /** inline svg markup (computed paint inlined) */
  svg?: string;
  /** external sprite URLs the svg still references (resolved and removed by the driver) */
  svgExternal?: string[];
  color?: string;
  /** list marker shape (kind 'marker') */
  shape?: "disc" | "circle" | "square";
  input?: {
    type: string;
    value: string;
    placeholder: string;
    placeholderColor: string;
    font: SnapFont;
    multiline: boolean;
  };
  /**
   * the box scrolls its content along `axis` (its children include what is scrolled / translated out of view): a native
   * scroller ('scroll': overflow auto / scroll) or a slide track ('track': overflow hidden around a row of slides moved by
   * transform). `snap` = computed scroll-snap-type.
   */
  scroller?: { axis: "x" | "y"; kind: "scroll" | "track"; snap?: string };
  /** a slider's previous (-1) / next (1) arrow and the scroller (SnapElement.id) it moves; `disabled` as captured */
  carousel?: { dir: 1 | -1; scroller: number; disabled?: boolean };
}

export type SnapNode = SnapElement | SnapText;

/** `stretch`: the face's font-stretch descriptor (a width range of a variable font, e.g. `100% 130%`) */
export interface SnapFontFace {
  family: string;
  weight: string;
  style: string;
  unicodeRange?: string;
  stretch?: string;
  src: { url: string; format: string | null }[];
}

/** A webfont face embedded by the driver (data URL), registered so text renders in the real face. */
export interface ImportedFont {
  family: string;
  weight: string;
  style: string;
  unicodeRange?: string;
  stretch?: string;
  src: string;
  file?: string;
  sourceUrl?: string;
}

export interface Snapshot {
  version: 1;
  url: string;
  title: string;
  lang?: string;
  capturedAt?: string;
  viewport: { width: number; height: number };
  page: { width: number; height: number; background: string; color: string; font: string };
  root: SnapElement | null;
  fonts: { family: string; weight: number; style: string; stack: string }[];
  fontFaces: SnapFontFace[];
  sheets: string[];
  nodes: number;
  truncated?: boolean;
  devicePixelRatio?: number;
  /** added by the driver: resource URL → data URL (images re-encoded at display size) */
  assets?: Record<string, string>;
  /** added by the driver */
  embeddedFonts?: ImportedFont[];
  /**
   * interactive states the driver opened after the walk (phone / tablet widths: the navigation menu behind the
   * hamburger). Each is a full re-walk of the page with the state open; `assets` / `embeddedFonts` live on the
   * parent snapshot only.
   */
  states?: SnapState[];
  /**
   * controls that change their widget in place (filter chips, tabs, expanding cards, accordions), in the order the
   * capture found them: 'select' picks one of a group, 'toggle' switches on / off; `id` = the control in this snapshot.
   * A native drop-down is one control per option (`option` = its index, `label` = its text), all with the select's id.
   */
  controls?: { kind: "select" | "toggle"; id?: number; option?: number; label?: string }[];
  /**
   * the page's walk with `opts.brand` (fig-server, `pnpm import:url`): what the brand guide reads on top of the tree —
   * controls with their CSSOM states, custom properties, @media widths, marks, images, icons, bands, grids, font files,
   * a covering consent layer, the visible strings. `{ error }` when reading it failed. convert.ts → `SceneScreen.capture`.
   */
  brand?: BrandCapture | { error: string };
  /**
   * the same page walked again at other viewport widths of its layout range (fig-server `alt`, no states / assets /
   * fonts): every box names its box of this walk (`base`); the import measures its layers' geometry there (fluid.ts)
   */
  alt?: Array<Snapshot & { width: number; menuState?: SnapState }>;
}

/** How an opened panel came in, read from its computed transition / animation (transform / opacity / clip). */
export interface SnapMotion {
  /** the edge it slid in from, or 'fade' (opacity only), or 'none' (appeared instantly) */
  enter: "left" | "right" | "top" | "bottom" | "fade" | "none";
  /** ms (longest transition / animation duration + delay on the panel or its first animated descendant) */
  duration: number;
  /** CSS timing function as computed, e.g. `cubic-bezier(0.4, 0, 0.2, 1)` / `ease-out` */
  easing: string;
}

export interface SnapState {
  /**
   * 'menu': the open navigation menu; 'submenu': a next level of it, opened in place by one of its entries; 'region':
   * a widget of the page in another state (its snapshot is the changed region only)
   */
  kind: "menu" | "submenu" | "region";
  /** region: index (in the page snapshot's `controls`) of the control that shows this state */
  index?: number;
  /** region: id (in the page snapshot) of the box the state changes; its own snapshot's root is that box */
  region?: number;
  /** region: the control toggles (clicked again = back); else it selects (its group's selected control = back) */
  toggle?: boolean;
  /** id (SnapElement.id in the parent snapshot's `root`) of the control that opens the state (hamburger button) */
  trigger?: number;
  /** submenu: index (in `states`) of the menu state it opens from */
  parent?: number;
  /** submenu: id (in that menu state's `snapshot.root`) of the entry that opens it */
  item?: number;
  /** submenu: id in `snapshot.root` of the control that goes back to the menu's first level */
  back?: number;
  /** aria-label / visible text of the trigger */
  label?: string;
  /** the page with the state open (same node id space is NOT shared: ids are local to this snapshot) */
  snapshot: Omit<Snapshot, "states" | "assets" | "embeddedFonts">;
  /** id in `snapshot.root` of the panel that opened (drawer / full-screen menu / dropdown) */
  panel?: number;
  /** id in `snapshot.root` of the control that closes it again (the X; often the trigger itself, morphed) */
  close?: number;
  motion?: SnapMotion;
}

export const isText = (n: SnapNode): n is SnapText => n.kind === "text";
