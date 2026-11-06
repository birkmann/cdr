// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// IR → React (TSX) + Tailwind. One component per screen (or per responsive group, see reactProject.ts), built from
// shared components (reactComponents.ts); interactions become `onNavigate` / `onBack` props. Styles map losslessly
// (tailwind.ts): utilities / arbitrary properties, a `style` prop for what a class cannot carry, and plain CSS rules
// for pseudo elements that cannot be `before:` / `after:` classes.
import { VOID_TAGS, declarations, type IrElement, type IrNode, type StyleMap } from "./ir.js";
import { pseudoTailwind, splitTailwind, type TwOptions } from "./tailwind.js";
import { resolveVars } from "./tokens.js";

export interface ReactEmitOptions extends TwOptions {
  /** navigate target → screen key passed to onNavigate (null drops the handler) */
  resolveTarget?: (target: string) => string | null;
  /** image src rewrite; null → placeholder (no <img>) */
  imageSrc?: (src: string) => string | null;
  /** collects CSS rules for pseudo elements Tailwind cannot express (class names `${cssPrefix}-n`); absent → best effort classes */
  cssRules?: string[];
  cssPrefix?: string;
  /** overlays the component renders (ComponentVariant.overlays): open- / close-overlay taps drive its `overlay` state */
  overlayIds?: ReadonlySet<string>;
  /** shared components (reactComponents.ts): instances, lists of them, props inside a component's body */
  hooks?: JsxHooks;
}

/** Where a component body reads a prop instead of the literal: a text node, an attribute, the tap, the root's className / style;
 *  `expanded`: a menu opener's open state (with `tap`: it opens the menu); `node`: a swapped nested instance. */
export type SlotName = "text" | "tap" | "class" | "style" | "expanded" | "node" | `attr:${string}`;

export interface JsxHooks {
  /** JSX for an instance of a shared component (no leading padding), null when `n` is none */
  usage?(n: IrElement, pad: string): string | null;
  /** shared component `n` is an instance of (runs of one component's instances may become a list) */
  componentOf?(n: IrElement): string | null;
  /** consecutive instances of one component as `{items.map(…)}`, null to write them one by one */
  list?(run: IrElement[], pad: string): string | null;
  /** inside a component's body: the expression standing for this slot of `n` (null: the literal); `extra` = the root's
   *  pseudo-element classes for the `class` slot; `expanded` ending in `?`: only some instances open a menu there */
  bind?(n: IrNode, slot: SlotName, extra?: string[]): string | null;
}

const ATTR_RENAME: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  colspan: "colSpan",
  rowspan: "rowSpan",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  autoplay: "autoPlay",
  playsinline: "playsInline",
  crossorigin: "crossOrigin",
  srcset: "srcSet",
  fetchpriority: "fetchPriority",
  referrerpolicy: "referrerPolicy",
  contenteditable: "contentEditable",
  spellcheck: "spellCheck",
  inputmode: "inputMode",
  enterkeyhint: "enterKeyHint",
  datetime: "dateTime",
  novalidate: "noValidate",
  allowfullscreen: "allowFullScreen",
  frameborder: "frameBorder",
  usemap: "useMap",
  "accept-charset": "acceptCharset",
  "http-equiv": "httpEquiv",
  "xlink:href": "xlinkHref",
  "xml:space": "xmlSpace",
  "xml:lang": "xmlLang",
};
const BOOLEAN_ATTRS = new Set([
  "hidden",
  "disabled",
  "required",
  "readonly",
  "autofocus",
  "autoplay",
  "muted",
  "loop",
  "controls",
  "playsinline",
  "multiple",
  "selected",
  "open",
  "novalidate",
  "allowfullscreen",
  "default",
  "reversed",
  "itemscope",
  "inert",
]);

/** JSX prop names @types/react knows on SVG elements / additionally on HTML elements (any other non-hyphenated name is a
 *  type error: such attributes go through a spread instead) */
const SVG_PROPS = new Set(
  (
    "accentHeight accumulate additive alignmentBaseline allowReorder alphabetic amplitude arabicForm ascent attributeName attributeType autoReverse azimuth " +
    "baseFrequency baseProfile baselineShift bbox begin bias by calcMode capHeight clip clipPath clipPathUnits clipRule color colorInterpolation " +
    "colorInterpolationFilters colorProfile colorRendering contentScriptType contentStyleType crossOrigin cursor cx cy d decelerate descent diffuseConstant " +
    "direction display divisor dominantBaseline dur dx dy edgeMode elevation enableBackground end exponent externalResourcesRequired fill fillOpacity " +
    "fillRule filter filterRes filterUnits floodColor floodOpacity focusable fontFamily fontSize fontSizeAdjust fontStretch fontStyle fontVariant " +
    "fontWeight format fr from fx fy g1 g2 glyphName glyphOrientationHorizontal glyphOrientationVertical glyphRef gradientTransform gradientUnits hanging " +
    "height horizAdvX horizOriginX href id ideographic imageRendering in in2 intercept k k1 k2 k3 k4 kernelMatrix kernelUnitLength kerning keyPoints " +
    "keySplines keyTimes lang lengthAdjust letterSpacing lightingColor limitingConeAngle local markerEnd markerHeight markerMid markerStart markerUnits " +
    "markerWidth mask maskContentUnits maskUnits mathematical max media method min mode name numOctaves offset opacity operator order orient orientation " +
    "origin overflow overlinePosition overlineThickness paintOrder panose1 path pathLength patternContentUnits patternTransform patternUnits pointerEvents " +
    "points pointsAtX pointsAtY pointsAtZ preserveAlpha preserveAspectRatio primitiveUnits r radius refX refY renderingIntent repeatCount repeatDur " +
    "requiredExtensions requiredFeatures restart result role rotate rx ry scale seed shapeRendering slope spacing specularConstant specularExponent speed " +
    "spreadMethod startOffset stdDeviation stemh stemv stitchTiles stopColor stopOpacity strikethroughPosition strikethroughThickness string stroke " +
    "strokeDasharray strokeDashoffset strokeLinecap strokeLinejoin strokeMiterlimit strokeOpacity strokeWidth surfaceScale systemLanguage tabIndex " +
    "tableValues target targetX targetY textAnchor textDecoration textLength textRendering to transform type u1 u2 underlinePosition underlineThickness " +
    "unicode unicodeBidi unicodeRange unitsPerEm vAlphabetic vHanging vIdeographic vMathematical values vectorEffect version vertAdvY vertOriginX " +
    "vertOriginY viewBox viewTarget visibility width widths wordSpacing writingMode x x1 x2 xChannelSelector xHeight xlinkActuate xlinkArcrole xlinkHref " +
    "xlinkRole xlinkShow xlinkTitle xlinkType xmlBase xmlLang xmlSpace xmlns xmlnsXlink y y1 y2 yChannelSelector z zoomAndPan"
  ).split(" "),
);
const HTML_PROPS = new Set([
  ...SVG_PROPS,
  ...(
    "abbr about accept acceptCharset accessKey action align allow allowFullScreen allowTransparency allowpopups alt as async autoCapitalize autoComplete " +
    "autoCorrect autoFocus autoPlay autoSave autosize bgcolor blinkfeatures border capture cellPadding cellSpacing challenge charSet checked cite classID " +
    "colSpan cols content contentEditable contextMenu controls controlsList coords data datatype dateTime decoding default defer dir dirName " +
    "disablePictureInPicture disableRemotePlayback disableblinkfeatures disabled disableguestresize disablewebsecurity download draggable encType " +
    "enterKeyHint fetchPriority form formAction formEncType formMethod formNoValidate formTarget frame frameBorder guestinstance headers hidden high " +
    "hrefLang htmlFor httpEquiv httpreferrer imageSizes imageSrcSet inlist inputMode integrity is itemID itemProp itemRef itemScope itemType keyParams " +
    "keyType kind label list loading loop low manifest marginHeight marginWidth maxLength mediaGroup minLength multiple muted noModule noValidate " +
    "nodeintegration nonce open optimum partition pattern ping placeholder playsInline plugins poster prefix preload property radioGroup readOnly ref " +
    "referrerPolicy rel required resource results rev reversed rowSpan rows rules sandbox scope scoped scrolling seamless security selected shape size " +
    "sizes slot span spellCheck src srcDoc srcLang srcSet start step summary title translate typeof unselectable useMap useragent valign value vocab " +
    "webpreferences wmode wrap"
  ).split(" "),
]);

const NUMERIC_ARIA =
  /^aria-(valuenow|valuemin|valuemax|level|posinset|setsize|colcount|colindex|colspan|rowcount|rowindex|rowspan)$/;

/** attribute names JSX can spell (captured DOMs carry junk like `...`) */
const JSX_NAME = /^[A-Za-z_][\w-]*(:[A-Za-z_][\w-]*)?$/;

function jsxAttrName(name: string, svg: boolean): string {
  if (ATTR_RENAME[name]) return ATTR_RENAME[name];
  if (name.startsWith("data-") || name.startsWith("aria-")) return name;
  if (svg && name.includes("-")) return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  if (name.includes(":")) return name.replace(/:([a-z])/g, (_, c: string) => c.toUpperCase());
  return name;
}

export const jsString = (s: string) => JSON.stringify(s);
export function jsxAttrValue(v: string): string {
  return /["{}<>&\\\n]/.test(v) ? `{${jsString(v)}}` : `"${v}"`;
}
export function jsxText(t: string): string {
  if (!t) return "";
  // (quotes and comment starts as a string too: generated modules stay readable by a plain JS lexer, reactStyles.ts)
  return /[{}<>&\n\r"'`]|\/[/*]/.test(t) || /^\s|\s$/.test(t) ? `{${jsString(t)}}` : t;
}

/** CSS property → React style key (`-webkit-mask` → `WebkitMask`, custom properties stay). */
export const styleKey = (p: string) =>
  p.startsWith("--")
    ? p
    : p
        .replace(/^-ms-/, "ms-")
        .replace(/^-/, "")
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        .replace(/^(webkit|moz)(?=[A-Z])/, (m) => m[0]!.toUpperCase() + m.slice(1));

/** `style={{…}}` for declarations that stay inline (order preserved: later overlapping ones win, as in CSS). */
export function styleProp(inline: StyleMap): string | null {
  const entries = Object.entries(inline);
  if (!entries.length) return null;
  const body = entries
    .map(([k, v]) => {
      const key = styleKey(k);
      return `${/^[A-Za-z]\w*$/.test(key) ? key : jsString(key)}: ${jsString(v)}`;
    })
    .join(", ");
  return entries.some(([k]) => k.startsWith("--"))
    ? `style={{ ${body} } as CSSProperties}`
    : `style={{ ${body} }}`;
}

function pseudoClasses(n: IrElement, o: ReactEmitOptions): string[] {
  const out: string[] = [];
  let ruleClass: string | null = null;
  for (const which of ["before", "after"] as const) {
    const st = n.pseudo?.[which];
    if (!st) continue;
    const tw = pseudoTailwind(st, which, o);
    if (tw) {
      out.push(...tw);
      continue;
    }
    if (!o.cssRules) continue;
    if (!ruleClass) {
      ruleClass = `${o.cssPrefix ?? "fx"}-${o.cssRules.length + 1}`;
      out.push(ruleClass);
    }
    const resolved = Object.fromEntries(
      Object.entries(st).map(([k, v]) => [k, o.cssVars ? v : resolveVars(v, o.vars)]),
    );
    o.cssRules.push(`.${ruleClass}::${which} { ${declarations(resolved)} }`);
  }
  return out;
}

/** `<tag a="b">inner</tag>` → parts (verbatim markup from the IR's `raw`, e.g. sanitised inline SVG). */
export function parseMarkup(
  markup: string,
): { tag: string; attrs: Array<[string, string]>; inner: string } | null {
  const m = /^\s*<([A-Za-z][\w:-]*)/.exec(markup);
  if (!m) return null;
  const attrs: Array<[string, string]> = [];
  const re = /\s*(?:([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?|(\/?>))/y;
  re.lastIndex = m[0].length;
  for (;;) {
    const a = re.exec(markup);
    if (!a) return null;
    if (a[5]) {
      if (a[5] === "/>") return { tag: m[1]!, attrs, inner: "" };
      const rest = markup.slice(re.lastIndex);
      const close = new RegExp(`</${m[1]}\\s*>\\s*$`, "i").exec(rest);
      return { tag: m[1]!, attrs, inner: close ? rest.slice(0, close.index) : rest };
    }
    attrs.push([a[1]!, decodeEntities(a[2] ?? a[3] ?? a[4] ?? "")]);
  }
}
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (ENTITIES[e.toLowerCase()] ?? m),
  );

/** Attributes @types/react has no prop for, as a spread (typed loosely: TypeScript rejects a spread that shares no
 *  property with the element's props). */
const unknownSpread = (entries: string[]) => `{...({ ${entries.join(", ")} } as Record<string, string>)}`;

/** Push one attribute as a JSX prop; names @types/react does not know come back as `"name": value` for a spread
 *  (React passes unknown attributes through verbatim, TypeScript only rejects them as direct props). */
export function jsxAttr(k: string, v: string, svg: boolean, attrs: string[]): string[] {
  const name = jsxAttrName(k, svg);
  if (BOOLEAN_ATTRS.has(k) && (v === "" || v.toLowerCase() === k)) {
    attrs.push(name);
    return [];
  }
  // ARIA attributes @types/react types as numbers (aria-valuenow, aria-level…): a number, not a string
  if (NUMERIC_ARIA.test(k) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    attrs.push(`${name}={${v.trim()}}`);
    return [];
  }
  if (
    name === "className" ||
    (svg ? SVG_PROPS : HTML_PROPS).has(name) ||
    (name.includes("-") && !svg) ||
    name.startsWith("data-") ||
    name.startsWith("aria-")
  ) {
    attrs.push(`${name}=${jsxAttrValue(v)}`);
    return [];
  }
  return [`${jsString(k)}: ${jsString(v)}`];
}

/** Attributes of verbatim markup as JSX props (`style` as a style object, unknown names through a spread). */
function markupAttrs(list: Array<[string, string]>, svg: boolean): string[] {
  const attrs: string[] = [],
    unknown: string[] = [];
  for (const [k, v] of list) {
    if (k === "xmlns:xlink" || /^on/i.test(k) || !JSX_NAME.test(k)) continue;
    if (k === "style") {
      const st: StyleMap = {};
      for (const d of v.split(";")) {
        const i = d.indexOf(":");
        if (i > 0) st[d.slice(0, i).trim()] = d.slice(i + 1).trim();
      }
      const sp = styleProp(st);
      if (sp) attrs.push(sp);
      continue;
    }
    unknown.push(...jsxAttr(k, v, svg, attrs));
  }
  if (unknown.length) attrs.push(unknownSpread(unknown));
  return attrs;
}

/** SVG presentation attributes children inherit; one repeating its parent's value says nothing. */
const SVG_INHERITED = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "clip-rule",
  "color",
  "visibility",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
  "shape-rendering",
  "image-rendering",
  "text-rendering",
  "color-interpolation",
  "color-interpolation-filters",
  "letter-spacing",
  "word-spacing",
  "pointer-events",
  "marker-start",
  "marker-mid",
  "marker-end",
  "direction",
  "writing-mode",
]);

/** Drop presentation attributes that change nothing (captured SVGs spell out every computed value): an inherited one
 *  equal to what the element inherits anyway, `opacity="1"`, gradient-stop properties off a `<stop>`. */
function pruneSvgAttrs(
  tag: string,
  attrs: Array<[string, string]>,
  inherited: ReadonlyMap<string, string>,
): { attrs: Array<[string, string]>; inherits: Map<string, string> } {
  const inherits = new Map(inherited);
  if (attrs.some(([k]) => k === "style")) {
    for (const [k, v] of attrs) if (SVG_INHERITED.has(k)) inherits.set(k, v);
    return { attrs, inherits };
  }
  const out: Array<[string, string]> = [];
  for (const [k, v] of attrs) {
    if ((k === "stop-color" || k === "stop-opacity") && tag !== "stop") continue;
    if (k === "opacity" && v.trim() === "1") continue;
    if (SVG_INHERITED.has(k)) {
      if (inherited.get(k) === v) continue;
      inherits.set(k, v);
    }
    out.push([k, v]);
  }
  return { attrs: out, inherits };
}

interface MarkupEl {
  tag: string;
  attrs: Array<[string, string]>;
  children: Array<MarkupEl | string>;
}
const MARKUP_TOKEN =
  /<!--[\s\S]*?-->|<\/([A-Za-z][\w:.-]*)\s*>|<[A-Za-z][\w:.-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|[^<]+/y;
const TEXT_TAGS = new Set(["text", "tspan", "textPath", "title", "desc"]);

/** Well-formed SVG content → elements (null: anything else, e.g. `<style>`, CDATA, unbalanced tags). */
function parseSvgContent(inner: string): Array<MarkupEl | string> | null {
  if (/<style[\s>]|<script[\s>]|<!\[CDATA\[|<!DOCTYPE|<\?/i.test(inner)) return null;
  const root: MarkupEl = { tag: "", attrs: [], children: [] };
  const stack = [root];
  MARKUP_TOKEN.lastIndex = 0;
  while (MARKUP_TOKEN.lastIndex < inner.length) {
    const m = MARKUP_TOKEN.exec(inner);
    if (!m) return null;
    const tok = m[0],
      top = stack[stack.length - 1]!;
    if (tok.startsWith("<!--")) continue;
    if (m[1]) {
      if (stack.length < 2 || top.tag !== m[1]) return null;
      stack.pop();
      continue;
    }
    if (tok.startsWith("<")) {
      const p = parseMarkup(tok.endsWith("/>") ? tok : `${tok.slice(0, -1)}/>`);
      if (!p) return null;
      const e: MarkupEl = { tag: p.tag, attrs: p.attrs, children: [] };
      top.children.push(e);
      if (!tok.endsWith("/>")) stack.push(e);
      continue;
    }
    if (tok.trim() || TEXT_TAGS.has(top.tag)) top.children.push(decodeEntities(tok));
  }
  return stack.length === 1 ? root.children : null;
}

function markupJsx(node: MarkupEl | string, pad: string, inherited: ReadonlyMap<string, string>): string {
  if (typeof node === "string") return pad + jsxText(node);
  const pruned = pruneSvgAttrs(node.tag, node.attrs, inherited);
  const attrs = markupAttrs(pruned.attrs, true);
  const open = `${pad}<${node.tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
  if (!node.children.length) return `${open} />`;
  if (node.children.every((c) => typeof c === "string"))
    return `${open}>${node.children.map((c) => jsxText(c as string)).join("")}</${node.tag}>`;
  return `${open}>\n${node.children.map((c) => markupJsx(c, pad + "  ", pruned.inherits)).join("\n")}\n${pad}</${node.tag}>`;
}

/** Verbatim markup as JSX: the root element's attributes as props, its content as JSX children (inline SVG), else as
 *  innerHTML — exactly the HTML export's DOM either way. */
function rawJsx(raw: string, pad: string): string | null {
  const p = parseMarkup(raw);
  if (!p) return null;
  const svg = p.tag.toLowerCase() === "svg";
  // an SVG with ids of its own (gradients, clip paths) drawn by a component: every instance would repeat them and
  // `url(#…)` resolves to the first in the document — in a hidden variant it draws nothing. As an image each copy keeps
  // its own document (not for currentColor drawings: an image does not inherit the text colour)
  if (svg && /\sid="/.test(raw) && !/currentColor/i.test(raw))
    return `${pad}<img src=${jsxAttrValue(`data:image/svg+xml,${encodeURIComponent(raw)}`)} alt="" aria-hidden="true" style={{ width: '100%', height: '100%', display: 'block' }} />`;
  const kids = svg && p.inner.trim() ? parseSvgContent(p.inner) : null;
  const pruned = svg
    ? pruneSvgAttrs(p.tag, p.attrs, new Map())
    : { attrs: p.attrs, inherits: new Map<string, string>() };
  const attrs = markupAttrs(pruned.attrs, svg);
  if (kids?.length)
    return `${pad}<${p.tag}${attrs.length ? " " + attrs.join(" ") : ""}>\n${kids.map((k) => markupJsx(k, pad + "  ", pruned.inherits)).join("\n")}\n${pad}</${p.tag}>`;
  if (p.inner.trim() && !kids) attrs.push(`dangerouslySetInnerHTML={{ __html: ${jsString(p.inner)} }}`);
  return `${pad}<${p.tag}${attrs.length ? " " + attrs.join(" ") : ""} />`;
}

/** JSX for one IR subtree. */
export function emitJsx(node: IrNode, o: ReactEmitOptions, depth = 0): string {
  const pad = "  ".repeat(depth);
  const h = o.hooks;
  if (node.kind === "text") {
    const b = h?.bind?.(node, "text");
    return pad + (b ? `{${b}}` : jsxText(node.text));
  }
  const n = node;
  const use = h?.usage?.(n, pad);
  if (use != null) return pad + use;
  if (n.raw !== undefined) {
    const r = rawJsx(n.raw, pad);
    if (r !== null) return r;
  }
  const attrs: string[] = [];
  const { classes, inline } = splitTailwind(n.style, o);
  const pseudo = pseudoClasses(n, o);
  const boundClass = h?.bind?.(n, "class", pseudo);
  classes.push(...pseudo);
  // (a plain string literal reads as one: className="…")
  if (boundClass)
    attrs.push(/^"[^"\\{}]*"$/.test(boundClass) ? `className=${boundClass}` : `className={${boundClass}}`);
  else if (classes.length) attrs.push(`className="${classes.join(" ")}"`);
  const i = n.interaction;
  // opens one of the component's overlays (a menu button): its expanded state follows the overlay (inside a shared
  // component: the props the screen passes)
  const boundOpen = h?.bind?.(n, "expanded");
  const opens = boundOpen
    ? ""
    : (i?.onTap === "open-overlay" || i?.onTap === "swap-overlay") && i.target && o.overlayIds?.has(i.target)
      ? i.target
      : null;
  const unknown: string[] = [];
  for (const [k, raw] of Object.entries(n.attrs)) {
    if (k === "style" || k === "class" || k === "xmlns:xlink" || !JSX_NAME.test(k)) continue;
    if (opens !== null && (k === "aria-expanded" || k === "aria-haspopup")) continue;
    const bound = h?.bind?.(n, `attr:${k}`);
    if (bound) {
      attrs.push(`${jsxAttrName(k, !!n.svg)}={${bound}}`);
      continue;
    }
    let v = raw;
    if (n.tag === "img" && k === "src" && o.imageSrc) {
      const r = o.imageSrc(v);
      if (r === null) return "";
      v = r;
    }
    if (n.tag === "input" && (k === "value" || k === "checked"))
      attrs.push(k === "value" ? `defaultValue=${jsxAttrValue(v)}` : "defaultChecked");
    // React warns (a console error) on `selected` options: the select's defaultValue picks it
    else if (n.tag === "option" && k === "selected") continue;
    else unknown.push(...jsxAttr(k, v, !!n.svg, attrs));
  }
  if (n.tag === "select" && !("value" in n.attrs)) {
    const sel = n.children.find(
      (c): c is IrElement => c.kind === "el" && c.tag === "option" && "selected" in c.attrs,
    );
    if (sel) attrs.push(`defaultValue=${jsxAttrValue(sel.attrs.value ?? "")}`);
  }
  if (unknown.length) attrs.push(unknownSpread(unknown));
  const boundStyle = h?.bind?.(n, "style");
  const sp = boundStyle ? `style={${boundStyle}}` : styleProp(inline);
  if (sp) attrs.push(sp);
  const boundTap = h?.bind?.(n, "tap");
  if (boundOpen?.endsWith("?")) {
    // the others keep the layer's own attributes
    const x = boundOpen.slice(0, -1),
      hp = n.attrs["aria-haspopup"],
      ex = n.attrs["aria-expanded"];
    attrs.push(
      `aria-haspopup={${x} === undefined ? ${hp === undefined ? "undefined" : jsString(hp)} : "dialog"}`,
      `aria-expanded={${x} ?? ${ex === "true" || ex === "false" ? jsString(ex) : "undefined"}}`,
      ...(boundTap ? [`onClick={${boundTap}}`] : []),
    );
  } else if (boundOpen)
    attrs.push(
      'aria-haspopup="dialog"',
      `aria-expanded={${boundOpen}}`,
      ...(boundTap ? [`onClick={${boundTap}}`] : []),
    );
  else if (boundTap) attrs.push(`onClick={${boundTap}}`);
  else if (i?.onTap === "navigate" && i.target) {
    const t = o.resolveTarget ? o.resolveTarget(i.target) : i.target;
    if (t) attrs.push(`onClick={() => onNavigate?.(${jsString(t)})}`);
  } else if (i?.onTap === "back") attrs.push("onClick={() => onBack?.()}");
  else if (i?.onTap === "open-url" && i.url)
    attrs.push(`onClick={() => window.open(${jsString(i.url)}, '_blank', 'noopener')}`);
  else if (opens)
    attrs.push(
      'aria-haspopup="dialog"',
      `aria-expanded={overlay === ${jsString(opens)}}`,
      `onClick={() => setOverlay(${jsString(opens)})}`,
    );
  else if (i?.onTap === "close-overlay" && o.overlayIds?.size) attrs.push("onClick={() => setOverlay(null)}");

  const open = `${pad}<${n.tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
  const kids: string[] = [];
  for (let k = 0; k < n.children.length; k++) {
    const c = n.children[k]!;
    // a run of one shared component's instances (product cards): one list
    const comp = h?.list && c.kind === "el" ? h.componentOf?.(c) : null;
    if (comp) {
      let end = k + 1;
      while (end < n.children.length) {
        const x = n.children[end]!;
        if (x.kind !== "el" || h!.componentOf?.(x) !== comp) break;
        end++;
      }
      const list = end - k > 1 ? h!.list!(n.children.slice(k, end) as IrElement[], pad + "  ") : null;
      if (list) {
        kids.push(`${pad}  ${list}`);
        k = end - 1;
        continue;
      }
    }
    const s = emitJsx(c, o, depth + 1);
    if (s.trim() !== "") kids.push(s);
  }
  if (VOID_TAGS.has(n.tag) || !kids.length) return `${open} />`;
  if (n.children.every((c) => c.kind === "text"))
    return `${open}>${kids.map((k) => k.trim()).join("")}</${n.tag}>`;
  return `${open}>\n${kids.join("\n")}\n${pad}</${n.tag}>`;
}

export interface ComponentVariant {
  root: IrElement;
  /** responsive variant: visible from `minWidth` up to the next variant's (Tailwind `min-[…]` classes) */
  minWidth?: number;
  /** screens this variant opens over itself (the menu of a page reflowed for small screens) */
  overlays?: ComponentOverlay[];
}

/**
 * An overlay rendered inside its variant: always mounted, `data-open` while it is the open one (CSS slides it in).
 * `placed`: cut out at its box in the page (an imported site's menu panel, CSS `[data-placed]`); `modal`: a tap
 * outside it does not close it; `cutout`: an imported page's menu drawing its own card (no frame of ours around it).
 */
export interface ComponentOverlay {
  id: string;
  root: IrElement;
  label: string;
  placed?: boolean;
  cutout?: boolean;
  modal?: boolean;
}

function overlayJsx(ov: ComponentOverlay, o: ReactEmitOptions, depth: number): string {
  const pad = "  ".repeat(depth);
  const id = jsString(ov.id);
  const flags = `${ov.placed ? ' data-placed=""' : ""}${ov.cutout ? ' data-cutout=""' : ""}${ov.modal ? ' data-modal=""' : ""}`;
  const outside = ov.modal ? "" : " onClick={(e) => { if (e.target === e.currentTarget) setOverlay(null) }}";
  return `${pad}<div data-overlay=${jsxAttrValue(ov.id)}${flags} data-open={overlay === ${id} ? '' : undefined} aria-hidden={overlay !== ${id}} role="dialog" aria-modal="true" aria-label=${jsxAttrValue(ov.label)}${outside}>
${pad}  <div data-overlay-panel>
${emitJsx(ov.root, o, depth + 2)}
${pad}  </div>
${pad}</div>`;
}

const OVERLAY_STATE = `  // the open overlay (menu); Escape and a tap outside its panel close it
  const [overlay, setOverlay] = useState<OverlayId | null>(null)
  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverlay(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay])
`;

/** Visibility classes per variant: exactly one is `display: block` in every viewport range. */
export function variantClasses(minWidths: number[]): string[] {
  return minWidths.map((m, i) => {
    const next = minWidths[i + 1];
    const show = m > 0 ? `hidden min-[${m}px]:block` : "block";
    return next !== undefined ? `${show} min-[${next}px]:hidden` : show;
  });
}

export interface ScreenModuleOptions {
  /** `// …` first line */
  comment?: string;
  /** import lines after React's (shared components, the page's CSS); called once the JSX is written */
  imports?: () => string[];
  /** module-level declarations before the component (the data of its lists) */
  decls?: string[];
}

/** A complete component module for a screen, or for a responsive group (one wrapper per breakpoint variant). Screens
 *  take the shared `ScreenProps` (src/types.ts): `onNavigate` with a typed screen key, `onBack`. */
export function screenComponent(
  name: string,
  root: IrElement | ComponentVariant[],
  o: ReactEmitOptions,
  m: ScreenModuleOptions = {},
): string {
  const variants = Array.isArray(root) ? root : [{ root }];
  const overlayIds = new Set(variants.flatMap((v) => (v.overlays ?? []).map((x) => x.id)));
  const eo: ReactEmitOptions = overlayIds.size ? { ...o, overlayIds } : o;
  const withOverlays = (v: ComponentVariant, depth: number) =>
    [emitJsx(v.root, eo, depth), ...(v.overlays ?? []).map((x) => overlayJsx(x, eo, depth))].join("\n");
  let body: string;
  if (variants.length === 1 && variants[0]!.minWidth === undefined)
    body = variants[0]!.overlays?.length
      ? `    <>\n${withOverlays(variants[0]!, 3)}\n    </>`
      : emitJsx(variants[0]!.root, eo, 2);
  else {
    const cls = variantClasses(variants.map((v) => v.minWidth ?? 0));
    body = `    <>\n${variants.map((v, i) => `      <div data-bp="${v.minWidth ?? 0}" className="${cls[i]}">\n${withOverlays(v, 4)}\n      </div>`).join("\n")}\n    </>`;
  }
  const decls = m.decls ?? [];
  const used = (p: string) => body.includes(`${p}?.(`) || decls.some((d) => d.includes(`${p}?.(`));
  const props = ["onNavigate", "onBack"].filter(used);
  const react = [
    ...(overlayIds.size ? ["useEffect", "useState"] : []),
    ...([body, ...decls].some((x) => x.includes("as CSSProperties")) ? ["type CSSProperties"] : []),
  ];
  const head = [
    ...(react.length ? [`import { ${react.join(", ")} } from 'react'`] : []),
    ...(props.length ? ["import type { ScreenProps } from '../types'"] : []),
    ...(m.imports?.() ?? []),
  ];
  const overlayType = overlayIds.size
    ? [
        `/** the menus this page opens over itself */\ntype OverlayId = ${[...overlayIds].map(jsString).join(" | ")}`,
      ]
    : [];
  const top = [...overlayType, ...decls];
  return `${m.comment ? `// ${m.comment}\n` : ""}${head.length ? `${head.join("\n")}\n\n` : ""}${top.length ? `${top.join("\n\n")}\n\n` : ""}export default function ${name}(${props.length ? `{ ${props.join(", ")} }: ScreenProps` : ""}) {
${overlayIds.size ? OVERLAY_STATE : ""}  return (
${body}
  )
}
`;
}

/** Snippet (no module wrapper) for clipboard / Dev Mode. */
export function jsxSnippet(root: IrElement, o: ReactEmitOptions): string {
  return emitJsx(root, o, 0);
}
