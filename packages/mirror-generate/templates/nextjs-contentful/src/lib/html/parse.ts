/**
 * Tiny dependency-free HTML parser + React attribute mapping. Used twice:
 *  - at runtime by RawHtml (sanitised HTML → React elements without a wrapper element, so the DOM matches the original)
 *  - at generate time by @cmp/generator-nextjs-contentful (design/components templates → TSX), which imports this file
 * Keeps attribute order/case and all whitespace text, decodes entities. NO imports (shared across packages).
 */

export type HNode = HElement | HText | HComment;
export interface HElement {
  type: "element";
  name: string; // lower-cased tag name (svg children keep case in `rawName`)
  rawName: string;
  attrs: [string, string | null][]; // [name, value] (null = bare attribute)
  children: HNode[];
}
export interface HText {
  type: "text";
  value: string; // decoded
}
export interface HComment {
  type: "comment";
  value: string;
}

export const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param", "keygen"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript"]);
/** opening these closes an open <p> */
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul", "figure", "figcaption", "details"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", deg: "°", plusmn: "±", times: "×", divide: "÷",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à",
  aacute: "á", iacute: "í", oacute: "ó", uacute: "ú", ccedil: "ç", ntilde: "ñ", shy: "­", zwj: "‍", zwnj: "‌",
  thinsp: " ", ensp: " ", emsp: " ", larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥", check: "✓",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

export function parseHtml(html: string, opts: { decode?: boolean } = {}): HNode[] {
  const decode = opts.decode !== false ? decodeEntities : (s: string) => s;
  const root: HElement = { type: "element", name: "#root", rawName: "#root", attrs: [], children: [] };
  const stack: HElement[] = [root];
  const cur = () => stack[stack.length - 1];
  const closeTo = (name: string) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === name) {
        stack.length = i;
        return true;
      }
    }
    return false;
  };
  let i = 0;
  const n = html.length;
  const pushText = (t: string) => {
    if (!t) return;
    const kids = cur().children;
    const last = kids[kids.length - 1];
    if (last && last.type === "text") last.value += decode(t);
    else kids.push({ type: "text", value: decode(t) });
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const stop = end < 0 ? n : end;
      cur().children.push({ type: "comment", value: html.slice(i + 4, stop) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html[i + 1] === "/") {
      const m = /^<\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(html.slice(i, i + 200));
      if (!m) {
        pushText("<");
        i++;
        continue;
      }
      closeTo(m[1].toLowerCase());
      i += m[0].length;
      continue;
    }
    const tag = readStartTag(html, i);
    if (!tag) {
      pushText("<");
      i++;
      continue;
    }
    i = tag.end;
    const name = tag.rawName.toLowerCase();
    if (name === "li") closeIfOpen(stack, "li", ["ul", "ol"]);
    if (name === "p" || CLOSES_P.has(name)) closeIfOpen(stack, "p", ["div", "section", "article", "td", "th", "li", "blockquote", "main", "body"]);
    if (name === "tr") closeIfOpen(stack, "tr", ["table", "tbody", "thead", "tfoot"]);
    if (name === "td" || name === "th") {
      closeIfOpen(stack, "td", ["tr"]);
      closeIfOpen(stack, "th", ["tr"]);
    }
    if (name === "option") closeIfOpen(stack, "option", ["select"]);
    const el: HElement = {
      type: "element",
      name,
      rawName: tag.rawName,
      attrs: tag.attrs.map(([k, v]) => [k, v == null ? null : decode(v)]),
      children: [],
    };
    cur().children.push(el);
    if (VOID.has(name) || tag.selfClosing) continue;
    if (RAW_TEXT.has(name)) {
      const re = new RegExp(`</\\s*${name}\\s*>`, "i");
      const rest = html.slice(i);
      const m = re.exec(rest);
      const body = m ? rest.slice(0, m.index) : rest;
      if (body) el.children.push({ type: "text", value: name === "textarea" || name === "title" ? decode(body) : body });
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }
    stack.push(el);
  }
  return root.children;
}

function closeIfOpen(stack: HElement[], name: string, scopeStops: string[]) {
  for (let i = stack.length - 1; i > 0; i--) {
    if (stack[i].name === name) {
      stack.length = i;
      return;
    }
    if (scopeStops.includes(stack[i].name)) return;
  }
}

function readStartTag(s: string, start: number): { rawName: string; attrs: [string, string | null][]; selfClosing: boolean; end: number } | null {
  const m = /^<([a-zA-Z][\w:.-]*)/.exec(s.slice(start, start + 100));
  if (!m) return null;
  let i = start + m[0].length;
  const attrs: [string, string | null][] = [];
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (s[i] === ">") return { rawName: m[1], attrs, selfClosing: false, end: i + 1 };
    if (s[i] === "/" && s[i + 1] === ">") return { rawName: m[1], attrs, selfClosing: true, end: i + 2 };
    if (s[i] === "/") {
      i++;
      continue;
    }
    // attribute name (allow handlebars blocks inside a tag as opaque "names")
    let name = "";
    if (s.startsWith("{{", i)) {
      const e = s.indexOf("}}", i);
      if (e < 0) return null;
      name = s.slice(i, e + 2);
      i = e + 2;
      attrs.push([name, null]);
      continue;
    }
    while (i < n && !/[\s=>]/.test(s[i]) && !(s[i] === "/" && s[i + 1] === ">")) name += s[i++];
    if (!name) {
      i++;
      continue;
    }
    while (i < n && /\s/.test(s[i])) i++;
    if (s[i] !== "=") {
      attrs.push([name, null]);
      continue;
    }
    i++;
    while (i < n && /\s/.test(s[i])) i++;
    let value = "";
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      const e = s.indexOf(q, i + 1);
      if (e < 0) return null;
      value = s.slice(i + 1, e);
      i = e + 1;
    } else {
      while (i < n && !/[\s>]/.test(s[i])) value += s[i++];
    }
    attrs.push([name, value]);
  }
  return null;
}

// ---------------------------------------------------------------- React attribute mapping

const ATTR_MAP: Record<string, string> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", maxlength: "maxLength", minlength: "minLength",
  colspan: "colSpan", rowspan: "rowSpan", cellpadding: "cellPadding", cellspacing: "cellSpacing", usemap: "useMap",
  frameborder: "frameBorder", allowfullscreen: "allowFullScreen", autoplay: "autoPlay", autocomplete: "autoComplete",
  autofocus: "autoFocus", enctype: "encType", srcset: "srcSet", srcdoc: "srcDoc", crossorigin: "crossOrigin",
  datetime: "dateTime", hreflang: "hrefLang", accesskey: "accessKey", contenteditable: "contentEditable",
  spellcheck: "spellCheck", novalidate: "noValidate", formaction: "formAction", inputmode: "inputMode",
  referrerpolicy: "referrerPolicy", fetchpriority: "fetchPriority", playsinline: "playsInline", itemprop: "itemProp",
  itemscope: "itemScope", itemtype: "itemType", itemid: "itemID", itemref: "itemRef", "accept-charset": "acceptCharset",
  "http-equiv": "httpEquiv", charset: "charSet", nomodule: "noModule", marginwidth: "marginWidth", marginheight: "marginHeight",
  "xlink:href": "xlinkHref", "xml:lang": "xmlLang", "xml:space": "xmlSpace", "xmlns:xlink": "xmlnsXlink",
  viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio", gradientunits: "gradientUnits", gradienttransform: "gradientTransform",
  patternunits: "patternUnits", clippathunits: "clipPathUnits", markerwidth: "markerWidth", markerheight: "markerHeight",
  refx: "refX", refy: "refY", stddeviation: "stdDeviation", textlength: "textLength", lengthadjust: "lengthAdjust",
};
export const BOOLEAN_ATTRS = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled", "formnovalidate",
  "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open", "playsinline",
  "readonly", "required", "reversed", "selected",
]);

/** React prop name for an HTML attribute (data-/aria- kept, svg kebab presentation attrs camelised) */
export function reactAttrName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("data-") || lower.startsWith("aria-")) return lower;
  if (ATTR_MAP[lower]) return ATTR_MAP[lower];
  if (/^on[a-z]/.test(lower)) return lower; // event handler attrs are stripped by callers
  if (lower.includes("-")) return lower.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  if (name !== lower) return name; // svg camelCase kept (when not lower-cased by the source)
  return lower;
}

/** "color: red; background-image: url(x)" → { color: "red", backgroundImage: "url(x)" } */
export function styleToObject(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0, buf = "";
  const parts: string[] = [];
  for (const ch of style) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);
  for (const decl of parts) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (!prop) continue;
    const key = prop.startsWith("--") ? prop : prop.toLowerCase().replace(/^-ms-/, "ms-").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = value;
  }
  return out;
}
