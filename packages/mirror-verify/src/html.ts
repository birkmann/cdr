import { unified } from "unified";
import rehypeParse from "rehype-parse";
import { select, selectAll } from "hast-util-select";
import { toText } from "hast-util-to-text";
import type { Element, Root, Parents } from "hast";

/**
 * Undo Cloudflare e-mail obfuscation (a CDN artefact of the captured original, not content):
 * `<a href="/cdn-cgi/l/email-protection#HEX">` → `mailto:` and `<span class="__cf_email__" data-cfemail="HEX">[email protected]</span>` → address.
 */
export function decodeCfEmails(html: string): string {
  if (!html.includes("cdn-cgi/l/email-protection") && !html.includes("data-cfemail")) return html;
  const dec = (hex: string) => {
    const k = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
    return out;
  };
  return html
    .replace(/<(span|a)\b[^>]*data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/\1>/gi, (_m, _t, hex: string) => dec(hex))
    .replace(/(["'])(?:https?:\/\/[^"'\/]+)?\/cdn-cgi\/l\/email-protection#([0-9a-f]+)\1/gi, (_m, q: string, hex: string) => `${q}mailto:${dec(hex)}${q}`);
}

export const MAIN_SELECTORS = ["main", "[role=main]", "#main-content", "article", "body"];
const STRIP = ["script", "style", "noscript", "template"];

const parser = unified().use(rehypeParse, { fragment: false });

export function parseHtml(html: string): Root {
  return parser.parse(html) as Root;
}

function attr(el: Element, name: string): string | undefined {
  const v = el.properties?.[name];
  if (v === undefined || v === null || v === false) return undefined;
  if (Array.isArray(v)) return v.join(" ");
  return String(v);
}

/** Remove elements matching selectors (in place). Invalid selectors are ignored. */
export function stripElements(tree: Root, selectors: string[]): void {
  const doomed = new Set<Element>();
  for (const s of selectors) {
    try {
      for (const el of selectAll(s, tree)) doomed.add(el);
    } catch {
      /* invalid selector */
    }
  }
  if (!doomed.size) return;
  const walk = (node: Parents) => {
    node.children = node.children.filter((c) => !(c.type === "element" && doomed.has(c))) as typeof node.children;
    for (const c of node.children) if (c.type === "element") walk(c);
  };
  walk(tree);
}

/** Text of the main content area, script/style/mask stripped. */
export function mainText(html: string, mask: string[] = []): { text: string; selector: string } {
  const tree = parseHtml(html);
  stripElements(tree, [...STRIP, ...mask]);
  for (const sel of MAIN_SELECTORS) {
    const el = select(sel, tree);
    if (el) return { text: toText(el), selector: sel };
  }
  return { text: toText(tree), selector: "document" };
}

/** Full visible-ish text: <title> + body text, script/style/mask stripped. */
export function pageText(html: string, mask: string[] = []): string {
  const tree = parseHtml(html);
  const title = select("title", tree);
  stripElements(tree, [...STRIP, ...mask]);
  const body = select("body", tree) ?? tree;
  return `${title ? toText(title) : ""}\n${toText(body)}`;
}

/** Raw href values of a[href] (and area[href]). */
export function extractHrefs(html: string): string[] {
  const tree = parseHtml(html);
  return selectAll("a[href], area[href]", tree)
    .map((el) => attr(el, "href"))
    .filter((h): h is string => !!h);
}

/** img src, img/source srcset candidates. */
export function extractImageSrcs(html: string): string[] {
  const tree = parseHtml(html);
  const out: string[] = [];
  for (const el of selectAll("img, source", tree)) {
    const src = attr(el, "src");
    if (src) out.push(src);
    const srcset = attr(el, "srcSet");
    if (srcset)
      for (const part of srcset.split(",")) {
        const u = part.trim().split(/\s+/)[0];
        if (u) out.push(u);
      }
  }
  return out;
}

/** meta name= tags compared besides title/description/robots */
export const SEO_META_NAMES = new Set(["keywords", "news_keywords", "abstract", "google-site-verification", "msvalidate.01"]);

export interface SeoData {
  lang?: string;
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  /** article:* (published/modified time, section, tag) and other meta name= tags that matter for SEO (keywords, news_keywords, abstract) */
  meta?: Record<string, string>;
  hreflang: string[]; // "de -> /de/x", sorted
  jsonLd: string[]; // canonical JSON strings, sorted
  jsonLdErrors: number;
}

/** Extract SEO-relevant head data. `norm` host-normalises URLs (force=true → always path). */
export function extractSeo(html: string, norm: (url: string, force?: boolean) => string, normText: (s: string) => string): SeoData {
  const tree = parseHtml(html);
  const titleEl = select("title", tree);
  const metas = selectAll("meta", tree);
  const data: SeoData = { og: {}, twitter: {}, meta: {}, hreflang: [], jsonLd: [], jsonLdErrors: 0 };
  if (titleEl) data.title = normText(toText(titleEl));
  const htmlEl = select("html", tree);
  const lang = htmlEl ? attr(htmlEl, "lang") : undefined;
  if (lang) data.lang = lang.toLowerCase();
  const multi: Record<string, string[]> = {};
  for (const m of metas) {
    const key = (attr(m, "property") ?? attr(m, "name") ?? "").trim();
    const content = attr(m, "content");
    if (!key || content === undefined) continue;
    const k = key.toLowerCase();
    if (k === "description") data.description = normText(content);
    else if (k === "robots") data.robots = content.replace(/\s+/g, "").toLowerCase();
    else if (k.startsWith("og:") || k.startsWith("twitter:") || k.startsWith("article:")) {
      const v = /url$|image$|image:url$|image:secure_url$|:author$|:publisher$/.test(k) || k === "og:url" ? norm(content, k === "og:url") : normText(content);
      (multi[k] ??= []).push(v);
    } else if (SEO_META_NAMES.has(k)) (multi[`meta:${k}`] ??= []).push(normText(content));
  }
  for (const [k, vs] of Object.entries(multi)) {
    const v = vs.join(" | ");
    if (k.startsWith("og:")) data.og[k] = v;
    else if (k.startsWith("twitter:")) data.twitter[k] = v;
    else data.meta![k.replace(/^meta:/, "")] = v;
  }
  for (const l of selectAll("link[rel]", tree)) {
    const rel = (attr(l, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr(l, "href");
    if (!href) continue;
    if (rel.includes("canonical") && data.canonical === undefined) data.canonical = norm(href, true);
    const hl = attr(l, "hrefLang");
    if (rel.includes("alternate") && hl) data.hreflang.push(`${hl.toLowerCase()} -> ${norm(href, true)}`);
  }
  data.hreflang = [...new Set(data.hreflang)].sort();
  for (const s of selectAll('script[type="application/ld+json"]', tree)) {
    const raw = toText(s);
    try {
      // one canonical string per JSON-LD node: @graph members are split so order/grouping across script tags does not matter
      const parsed = mapStrings(JSON.parse(raw), (x) => norm(x)) as Record<string, unknown> | unknown[];
      const nodes: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as Record<string, unknown>)["@graph"]) ? ((parsed as Record<string, unknown>)["@graph"] as unknown[]) : [parsed];
      for (const n of nodes) data.jsonLd.push(canonicalJson(n));
    } catch {
      data.jsonLdErrors++;
    }
  }
  data.jsonLd.sort();
  return data;
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
