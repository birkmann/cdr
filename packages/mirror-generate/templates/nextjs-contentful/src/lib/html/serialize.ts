/**
 * HTML string serialisers for the static render mode (src/lib/render/static.ts):
 *  - serializeNodes(): parsed HNode tree → HTML (raw attribute names kept, so SVG/case-sensitive attributes survive)
 *  - renderToHtml(): React elements produced by our own synchronous components (RichText, fallback, compiled
 *    design components) → HTML. `react-dom/server` cannot be used inside Server Components, and this subset is tiny:
 *    host elements, fragments, arrays, text, and plain function components without hooks.
 * NO imports from the data layer: shared by the runtime and tests.
 */
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { VOID, type HNode } from "./parse";

export const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const RAW_TEXT = new Set(["script", "style"]);

/** HNode[] → HTML (entities re-escaped minimally; attribute order and names as parsed) */
export function serializeNodes(nodes: HNode[], parentRaw = false): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += parentRaw ? n.value : escapeText(n.value);
    else if (n.type === "comment") out += `<!--${n.value}-->`;
    else {
      const tag = n.rawName;
      const attrs = n.attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`)).join("");
      if (VOID.has(n.name)) out += `<${tag}${attrs}>`;
      else out += `<${tag}${attrs}>${serializeNodes(n.children, RAW_TEXT.has(n.name))}</${tag}>`;
    }
  }
  return out;
}

/** Marker component: its `html` is emitted verbatim by renderToHtml (used to embed pre-rendered HTML in React trees). */
export function RawMarkup(_props: { html: string }): ReactNode {
  return null;
}

// React prop → HTML attribute
const PROP_TO_ATTR: Record<string, string> = {
  className: "class", htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", maxLength: "maxlength", minLength: "minlength",
  colSpan: "colspan", rowSpan: "rowspan", cellPadding: "cellpadding", cellSpacing: "cellspacing", useMap: "usemap",
  frameBorder: "frameborder", allowFullScreen: "allowfullscreen", autoPlay: "autoplay", autoComplete: "autocomplete",
  autoFocus: "autofocus", encType: "enctype", srcSet: "srcset", srcDoc: "srcdoc", crossOrigin: "crossorigin",
  dateTime: "datetime", hrefLang: "hreflang", accessKey: "accesskey", contentEditable: "contenteditable",
  spellCheck: "spellcheck", noValidate: "novalidate", formAction: "formaction", inputMode: "inputmode",
  referrerPolicy: "referrerpolicy", fetchPriority: "fetchpriority", playsInline: "playsinline", itemProp: "itemprop",
  itemScope: "itemscope", itemType: "itemtype", itemID: "itemid", itemRef: "itemref", acceptCharset: "accept-charset",
  httpEquiv: "http-equiv", charSet: "charset", noModule: "nomodule", marginWidth: "marginwidth", marginHeight: "marginheight",
  xlinkHref: "xlink:href", xmlLang: "xml:lang", xmlSpace: "xml:space", xmlnsXlink: "xmlns:xlink",
  defaultValue: "value", defaultChecked: "checked",
};
/** camelCase SVG attributes that are camelCase in SVG itself (everything else camelCase → kebab-case) */
const SVG_CAMEL = new Set([
  "viewBox", "preserveAspectRatio", "gradientUnits", "gradientTransform", "patternUnits", "patternContentUnits", "patternTransform",
  "clipPathUnits", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "stdDeviation", "textLength", "lengthAdjust",
  "pathLength", "baseFrequency", "numOctaves", "keySplines", "keyTimes", "attributeName", "repeatCount", "maskUnits",
  "maskContentUnits", "filterUnits", "primitiveUnits", "spreadMethod", "startOffset", "tableValues", "kernelMatrix",
  "surfaceScale", "specularExponent", "diffuseConstant", "xChannelSelector", "yChannelSelector", "edgeMode", "stitchTiles",
]);
const BOOL_PROPS = new Set([
  "allowFullScreen", "async", "autoFocus", "autoPlay", "checked", "controls", "default", "defer", "disabled", "formNoValidate",
  "hidden", "inert", "isMap", "itemScope", "loop", "multiple", "muted", "noModule", "noValidate", "open", "playsInline",
  "readOnly", "required", "reversed", "selected", "defaultChecked",
]);
const SKIP_PROPS = new Set(["children", "dangerouslySetInnerHTML", "key", "ref", "suppressHydrationWarning", "suppressContentEditableWarning"]);

function attrName(prop: string): string {
  if (PROP_TO_ATTR[prop]) return PROP_TO_ATTR[prop];
  if (prop.startsWith("data-") || prop.startsWith("aria-") || SVG_CAMEL.has(prop)) return prop;
  if (/[A-Z]/.test(prop)) return prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  return prop;
}

const UNITLESS = /^(opacity|zIndex|fontWeight|lineHeight|flex|flexGrow|flexShrink|order|zoom|fillOpacity|strokeOpacity|columnCount|orphans|widows|gridRow|gridColumn)$/;
function styleString(style: Record<string, unknown>): string {
  return Object.entries(style)
    .filter(([, v]) => v != null && v !== "" && v !== false)
    .map(([k, v]) => {
      const name = k.startsWith("--") ? k : k.replace(/^ms([A-Z])/, "-ms-$1").replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
      const val = typeof v === "number" && v !== 0 && !UNITLESS.test(k) ? `${v}px` : String(v);
      return `${name}: ${val}`;
    })
    .join("; ");
}

function hostAttrs(props: Record<string, unknown>): string {
  let out = "";
  for (const [k, v] of Object.entries(props)) {
    if (SKIP_PROPS.has(k) || v == null || typeof v === "function" || typeof v === "symbol") continue;
    const name = attrName(k);
    if (k === "style" && typeof v === "object") {
      const s = styleString(v as Record<string, unknown>);
      if (s) out += ` style="${escapeAttr(s)}"`;
      continue;
    }
    if (typeof v === "boolean") {
      if (BOOL_PROPS.has(k)) {
        if (v) out += ` ${name}`;
      } else if (k.startsWith("data-") || k.startsWith("aria-")) out += ` ${name}="${v}"`;
      else if (v) out += ` ${name}`;
      continue;
    }
    out += ` ${name}="${escapeAttr(String(v))}"`;
  }
  return out;
}

/** React node → HTML string (subset: host elements, fragments, sync function components, RawMarkup). */
export function renderToHtml(node: ReactNode, rawText = false): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return rawText ? node : escapeText(node);
  if (typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map((n) => renderToHtml(n as ReactNode, rawText)).join("");
  if (typeof (node as { html?: unknown }).html === "string" && !isValidElement(node)) return (node as unknown as { html: string }).html; // SafeHtml-like
  if (!isValidElement(node)) {
    if (typeof (node as Iterable<ReactNode>)[Symbol.iterator] === "function") return [...(node as Iterable<ReactNode>)].map((n) => renderToHtml(n, rawText)).join("");
    return "";
  }
  const el = node as ReactElement<Record<string, unknown>>;
  const { type, props } = el;
  if (type === Fragment) return renderToHtml(props.children as ReactNode, rawText);
  if (type === RawMarkup) return String(props.html ?? "");
  if (typeof type === "function") {
    const out = (type as (p: unknown) => ReactNode)(props);
    if (out && typeof (out as Promise<unknown>).then === "function") throw new Error(`renderToHtml: async component ${(type as { name?: string }).name ?? "?"} is not supported in static islands`);
    return renderToHtml(out, rawText);
  }
  if (typeof type !== "string") return renderToHtml(props.children as ReactNode, rawText);
  const tag = type;
  const attrs = hostAttrs(props);
  if (VOID.has(tag.toLowerCase())) return `<${tag}${attrs}>`;
  const inner = props.dangerouslySetInnerHTML as { __html?: string } | undefined;
  if (inner && typeof inner.__html === "string") return `<${tag}${attrs}>${inner.__html}</${tag}>`;
  if (tag === "textarea" && typeof props.defaultValue === "string") return `<${tag}${hostAttrs({ ...props, defaultValue: undefined })}>${escapeText(props.defaultValue)}</${tag}>`;
  return `<${tag}${attrs}>${renderToHtml(props.children as ReactNode, RAW_TEXT.has(tag))}</${tag}>`;
}
