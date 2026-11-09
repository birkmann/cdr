/**
 * Allowlist sanitiser for rawHtml (rich-text fallback nodes, html fields). Works on the parsed tree:
 * drops script/style/object/embed, event handlers, javascript:/data: URLs (except data:image), keeps iframes only for
 * https sources. The source page's own forms and controls (search, journey planners) and full SVG (gradients, masks,
 * clip paths, text) stay: they are part of how the page looks. Deterministic, no DOM needed (server components).
 */
import { parseHtml, type HElement, type HNode } from "./parse";

const DROP_WITH_CONTENT = new Set(["script", "style", "noscript", "template", "object", "embed", "applet", "frame", "frameset", "base", "link", "meta", "title", "head"]);
const UNWRAP = new Set(["html", "body", "font", "center"]);
const ALLOWED = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "iframe", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "picture", "pre", "q", "s", "samp",
  "section", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time",
  "tr", "u", "ul", "var", "video", "audio", "track", "wbr", "svg", "path", "g", "circle", "rect", "line", "polyline", "polygon",
  "use", "defs", "symbol", "title", "button", "label", "drupal-media",
  // forms and controls (static markup; event handlers are stripped below)
  "form", "input", "select", "option", "optgroup", "textarea", "fieldset", "legend", "datalist", "output", "progress", "meter",
  "dialog", "menu", "hgroup", "search", "data", "ruby", "rp", "rt", "map", "area",
  // SVG beyond basic shapes (lower-cased: the parser keeps the original case in rawName)
  "ellipse", "text", "tspan", "textpath", "image", "clippath", "mask", "pattern", "lineargradient", "radialgradient", "stop",
  "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "feflood", "fecomposite", "femerge", "femergenode",
  "fedropshadow", "femorphology", "marker", "desc", "foreignobject",
]);
/** Custom elements (web-component design systems: <maui-image>, <c4d-card>): inert markup until the site's own script
 * defines them; attributes go through the same filter as every other element. */
const CUSTOM_ELEMENT = /^[a-z][a-z0-9]*-[a-z0-9._-]*$/;
const URL_ATTRS = new Set(["href", "src", "srcset", "poster", "action", "formaction", "xlink:href", "cite", "data"]);

function safeUrl(v: string, attr: string, tag: string): boolean {
  const s = v.trim().toLowerCase().replace(/[\u0000-\u001f\s]+/g, "");
  if (s.startsWith("javascript:") || s.startsWith("vbscript:")) return false;
  if (s.startsWith("data:")) return attr === "src" && /^data:image\/(png|gif|jpe?g|webp|avif);/.test(s);
  if (tag === "iframe" && attr === "src") return s.startsWith("https://") || s.startsWith("//");
  return true;
}

function isDataScript(n: HElement): boolean {
  const type = n.attrs.find(([k]) => k.toLowerCase() === "type")?.[1]?.trim().toLowerCase();
  return !!type && /^application\/(ld\+)?json$|^application\/(x-)?[a-z.+-]*json$/.test(type);
}

function clean(nodes: HNode[]): HNode[] {
  const out: HNode[] = [];
  for (const n of nodes) {
    if (n.type === "comment") continue;
    if (n.type === "text") {
      out.push(n);
      continue;
    }
    // inert data blocks (application/json, ld+json): the page's own scripts read them (ibm.com image components, AEM SPA
    // models); executable scripts never pass
    if (n.name === "script" && isDataScript(n)) {
      const body = n.children.map((c) => (c.type === "text" ? c.value : "")).join("");
      if (!/<\/script/i.test(body)) {
        out.push({ ...n, attrs: n.attrs.filter(([k]) => !k.toLowerCase().startsWith("on") && k.toLowerCase() !== "src"), children: [{ type: "text", value: body }] } as HElement);
        continue;
      }
    }
    if (DROP_WITH_CONTENT.has(n.name)) continue;
    if (UNWRAP.has(n.name) || !(ALLOWED.has(n.name) || CUSTOM_ELEMENT.test(n.name))) {
      out.push(...clean(n.children));
      continue;
    }
    const attrs = n.attrs.filter(([k, v]) => {
      const key = k.toLowerCase();
      if (key.startsWith("on") || key === "style" && /expression\(|javascript:/i.test(v ?? "")) return false;
      if (key.startsWith("{{")) return false;
      if (URL_ATTRS.has(key) && v != null && !safeUrl(v, key, n.name)) return false;
      return true;
    });
    const el: HElement = { ...n, attrs, children: clean(n.children) };
    if (n.name === "a" && attrs.some(([k, v]) => k === "target" && v === "_blank") && !attrs.some(([k]) => k === "rel"))
      el.attrs = [...attrs, ["rel", "noopener noreferrer"]];
    out.push(el);
  }
  return out;
}

export function sanitizeTree(nodes: HNode[]): HNode[] {
  return clean(nodes);
}

export function sanitizeHtml(html: string): HNode[] {
  return clean(parseHtml(html));
}
