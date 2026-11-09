/**
 * Static render mode (templates/nextjs-contentful/src/lib/render/static.ts) — generator side.
 *
 * Sites whose original JavaScript must run against the server markup (Drupal behaviours + jQuery, sliders, widgets)
 * are rendered as static islands: the generated app emits the page head/body as HTML strings from the design
 * templates, in the original order, with the ported scripts and drupalSettings at their original placement.
 * This module decides the mode, strips trackers, and turns whatever @cmp/design wrote (manifest, layout, templates,
 * per-page variants) into src/generated/design.json.
 */
import type { Design, DesignManifest } from "./design.js";

export type RenderMode = "static" | "react";

/** script/iframe/pixel URLs and inline snippets of analytics & tag managers — never emitted by the generated app */
export const TRACKER_PATTERNS = [
  "googletagmanager\\.com",
  "google-analytics\\.com",
  "/gtag/js",
  "/modules/contrib/google_tag/",
  "/ns\\.html\\?id=GTM-",
  "\\bgtm\\.js\\b",
  "\\bdataLayer\\b",
  "\\bdataLayer_tags\\b",
  "connect\\.facebook\\.net",
  "\\bfbq\\(",
  "static\\.hotjar\\.com",
  "doubleclick\\.net",
  "assets\\.adobedtm\\.com",
  "bat\\.bing\\.com",
  "analytics\\.tiktok\\.com",
  "snap\\.licdn\\.com",
  "clarity\\.ms",
  "js-agent\\.newrelic\\.com",
  "nr-data\\.net",
  "/cdn-cgi/(rum|zaraz|beacon)",
  "static\\.cloudflareinsights\\.com",
];
const TRACKER_RE = new RegExp(TRACKER_PATTERNS.join("|"), "i");
export const isTrackerText = (s: string | undefined) => !!s && TRACKER_RE.test(s);

const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(2).find((x) => x !== undefined);

/** Remove tracker <script>s (src or inline JS; JSON data blocks stay), tracker <noscript>/<iframe>/<img> pixels. */
export function stripTrackers(html: string): { html: string; removed: string[] } {
  const removed: string[] = [];
  let out = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (m, attrs: string, body: string) => {
    const type = (attrOf(`<s ${attrs}>`, "type") ?? "").toLowerCase();
    if (type && !/javascript|module|ecmascript/.test(type)) return m; // application/json, ld+json, templates
    const src = attrOf(`<s ${attrs}>`, "src");
    if (src ? isTrackerText(src) : isTrackerText(body)) {
      removed.push(src ?? `inline:${body.trim().slice(0, 60)}`);
      return "";
    }
    return m;
  });
  out = out.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi, (m, body: string) => {
    if (/<(iframe|img)\b/i.test(body) && isTrackerText(body)) {
      removed.push(`noscript:${(attrOf(body, "src") ?? "").slice(0, 80)}`);
      return "";
    }
    return m;
  });
  out = out.replace(/<(iframe|img)\b[^>]*>(\s*<\/iframe>)?/gi, (m) => {
    const src = attrOf(m, "src");
    if (src && isTrackerText(src)) {
      removed.push(src);
      return "";
    }
    return m;
  });
  return { html: out, removed };
}

const DRUPAL_JS = /\/core\/(misc|assets\/vendor\/jquery)\/|\/sites\/[^/]+\/files\/js\/js_|jquery(\.min)?\.js|drupal(\.init)?\.js|\/core\/misc\/once/i;

export function detectRenderMode(design: Design): RenderMode {
  const m = design.manifest as DesignManifest & Record<string, unknown>;
  if (m.renderMode === "static" || m.renderMode === "react") return m.renderMode;
  const tpls = design.templates as unknown as Record<string, unknown>[];
  if (m.drupalSettings || design.layout?.drupalSettings || tpls.some((t) => t.drupalSettings)) return "static";
  const srcs = [...((m.scripts ?? []) as { src?: string; original?: string }[]), ...tpls.flatMap((t) => (t.scripts as { src?: string; original?: string }[] | undefined) ?? [])].flatMap((s) =>
    typeof s === "string" ? [s] : [s.src, s.original],
  );
  return srcs.some((s) => s && DRUPAL_JS.test(s)) ? "static" : "react";
}

// ---------------------------------------------------------------- design → design.json (static part)

export interface HeadItem {
  html?: string;
  slot?: string;
}
export interface ScriptOut {
  src?: string;
  inline?: string;
  /** position of the drupalSettings JSON block */
  settings?: boolean;
  placement: "head" | "body";
  attrs?: Record<string, string | null>;
}
export interface StylesheetOut {
  href?: string;
  /** inline <style> content (original inline style block) */
  inline?: string;
  media?: string;
  attrs?: Record<string, string | null>;
}
export interface VariantOut {
  head?: HeadItem[];
  bodyEnd?: HeadItem[];
  stylesheets?: StylesheetOut[];
  scripts?: ScriptOut[];
  preload?: { href: string; as?: string; type?: string; crossorigin?: string }[];
  drupalSettings?: Record<string, unknown> | null;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
}

/** raw script/stylesheet declarations as @cmp/design may write them */
type RawScript = string | { src?: string; original?: string; placement?: string; attrs?: Record<string, string | null>; inline?: string; html?: string; type?: string; defer?: boolean; async?: boolean; role?: string };
type RawStyle = string | { href?: string; src?: string; file?: string; original?: string; media?: string; attrs?: Record<string, string | null>; inline?: string; html?: string; role?: string };
type RawHead = string | { html?: string; slot?: string; kind?: string; src?: string; href?: string; inline?: string; [k: string]: unknown };
type RawVariant = {
  head?: RawHead[] | string;
  headHtml?: string;
  bodyEnd?: RawHead[] | string;
  bodyEndHtml?: string;
  stylesheets?: RawStyle[];
  scripts?: RawScript[];
  drupalSettings?: Record<string, unknown> | string | null;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
  bodyClass?: string;
};

export interface StaticPlan {
  json: VariantOut & {
    renderMode: "static";
    types: Record<string, VariantOut>;
    pages: Record<string, VariantOut>;
    /** per crawled path: design component variants, layout variant, body class (design manifest.pages) */
    pageDesign: Record<string, { components?: Record<string, string>; layoutVariant?: string; bodyClass?: string; template?: { slots?: unknown[]; wrapperHtml?: string; chrome?: string[] } }>;
    trackers: string[];
  };
  /** public path (no query) → design-relative source file */
  publicFromDesign: Map<string, string>;
  /** absolute site paths referenced by scripts/styles that must be served (copied from design or downloaded) */
  sitePaths: Set<string>;
  removedTrackers: string[];
  notes: string[];
}

const pick = <T extends object>(o: T, keys: string[]): Partial<T> => Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined)) as Partial<T>;
const isAbs = (s: string) => /^(https?:)?\/\//.test(s);
const designUrl = (rel: string) => "/_design/" + rel.replace(/^\.?\/+/, "").replace(/^design\//, "");

export function buildStaticPlan(design: Design, designFiles: string[], readJson: (rel: string) => unknown, readText: (rel: string) => string | undefined = () => undefined): StaticPlan {
  const removedTrackers: string[] = [];
  const notes: string[] = [];
  const publicFromDesign = new Map<string, string>();
  const sitePaths = new Set<string>();
  const fileSet = new Set(designFiles);

  const strip = (html: string) => {
    const r = stripTrackers(html);
    removedTrackers.push(...r.removed);
    return r.html;
  };

  /** a script/style reference → URL served by the new app (original URL structure kept where possible) */
  const resolveRef = (src: string | undefined, original: string | undefined): string | undefined => {
    const s = src?.trim();
    const o = original?.trim();
    if (s && !isAbs(s) && !s.startsWith("/")) {
      // design-relative ported file
      const rel = s.replace(/^\.?\/+/, "").replace(/^design\//, "");
      if (!fileSet.has(rel.split("?")[0])) notes.push(`design file ${rel} not found`);
      if (o && o.startsWith("/") && !o.startsWith("//")) {
        publicFromDesign.set(o.split("?")[0], rel.split("?")[0]);
        return o;
      }
      return designUrl(rel);
    }
    const url = s || o;
    if (!url) return undefined;
    if (url.startsWith("/") && !url.startsWith("//")) {
      const clean = url.split("?")[0];
      const inDesign = designFiles.find((f) => f === clean.replace(/^\//, "") || f.endsWith("/" + clean.replace(/^\//, "")));
      if (inDesign) publicFromDesign.set(clean, inDesign);
      else sitePaths.add(clean);
    }
    return url;
  };

  const script = (r: RawScript, fallbackPlacement: "head" | "body"): ScriptOut | HeadItem | undefined => {
    if (typeof r === "string") {
      if (r.trim().startsWith("<")) return { html: strip(r) };
      r = { src: r };
    }
    if (r.html) return { html: strip(r.html) };
    const placement0 = r.placement === "head" ? "head" : r.placement === "body" || r.placement === "footer" ? "body" : fallbackPlacement;
    if (r.role === "settings" || r.original === "drupal-settings-json" || r.attrs?.["data-drupal-selector"] === "drupal-settings-json") {
      // drupalSettings block: its JSON becomes the variant's drupalSettings, its position a marker in the script list
      const ds = r.src && !isAbs(r.src) ? readJson(r.src.replace(/^\.?\/+/, "").replace(/^design\//, "")) : r.inline ? JSON.parse(r.inline) : undefined;
      if (ds && typeof ds === "object") pendingSettings = ds as Record<string, unknown>;
      else notes.push(`drupalSettings ${r.src ?? "inline"} unreadable`);
      return { settings: true, placement: placement0 };
    }
    if ((r.role === "inline" || r.original === "inline") && r.src && !isAbs(r.src)) {
      const body = readText(r.src.replace(/^\.?\/+/, "").replace(/^design\//, ""));
      if (body !== undefined) r = { ...r, inline: body, src: undefined };
    }
    if (r.inline !== undefined) {
      if (isTrackerText(r.inline) && !/json/.test(r.type ?? "")) {
        removedTrackers.push(`inline:${r.inline.slice(0, 60)}`);
        return undefined;
      }
      return { inline: r.inline, placement: placement0, ...(r.type ? { attrs: { type: r.type } } : {}) };
    }
    const src = resolveRef(r.src, r.original);
    if (!src) return undefined;
    if (isTrackerText(src) || isTrackerText(r.original)) {
      removedTrackers.push(r.original ?? src);
      return undefined;
    }
    const attrs: Record<string, string | null> = { ...(r.attrs ?? {}) };
    delete attrs.src;
    if (r.defer && !("defer" in attrs)) attrs.defer = null;
    if (r.async && !("async" in attrs)) attrs.async = null;
    if (r.type && !("type" in attrs)) attrs.type = r.type;
    return { src, placement: placement0, ...(Object.keys(attrs).length ? { attrs } : {}) };
  };

  const style = (r: RawStyle): StylesheetOut | HeadItem | undefined => {
    if (typeof r === "string") {
      if (r.trim().startsWith("<")) return { html: strip(r) };
      r = { href: r };
    }
    if (r.html) return { html: r.html };
    const file = r.href ?? r.file ?? r.src;
    if ((r.role === "inline" || r.original === "inline") && file && !isAbs(file)) {
      const body = readText(file.replace(/^\.?\/+/, "").replace(/^design\//, ""));
      if (body !== undefined) r = { ...r, inline: body };
    }
    if (r.inline !== undefined) return { inline: r.inline, ...(r.media && r.media !== "all" ? { media: r.media } : {}), ...(r.attrs && Object.keys(r.attrs).length ? { attrs: r.attrs } : {}) };
    // ported CSS stays under /_design/ (its url()s are relative to the design root); other refs keep their URL
    const href = file && !isAbs(file) && !file.startsWith("/") ? designUrl(file) : resolveRef(file, undefined);
    if (!href) return undefined;
    const attrs = { ...(r.attrs ?? {}) };
    for (const k of ["rel", "href", "media"]) delete attrs[k];
    return { href, media: r.media ?? "all", ...(Object.keys(attrs).length ? { attrs } : {}) };
  };

  const headList = (v: RawHead[] | string | undefined, placement: "head" | "body"): HeadItem[] | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === "string") return [{ html: strip(v) }];
    const out: HeadItem[] = [];
    for (const it of v) {
      if (typeof it === "string") out.push(it.trim().startsWith("<") ? { html: strip(it) } : { slot: it });
      else if (it.slot) out.push({ slot: it.slot });
      else if (it.html !== undefined) {
        const h = strip(it.html);
        if (h.trim()) out.push({ html: h });
      } else if (it.kind === "script" || it.src) {
        const s = script(it as RawScript, placement);
        if (s && "html" in s) out.push(s as HeadItem);
        else if (s && (s as ScriptOut).settings) out.push({ slot: "drupalSettings" });
        else if (s) {
          const so = s as ScriptOut;
          // values are decoded text (hast); inline handlers such as onload="init({a: 'b'})" may carry quotes
          const attrs = Object.entries(so.attrs ?? {}).map(([k, x]) => (x === null ? ` ${k}` : ` ${k}="${x.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)).join("");
          out.push({ html: so.inline !== undefined ? `<script${attrs}>${so.inline}</script>` : `<script src="${so.src}"${attrs}></script>` });
        }
      } else if (it.kind === "stylesheet" || it.href) {
        const s = style(it as RawStyle);
        if (s && "html" in s) out.push(s as HeadItem);
        else if (s) {
          const st = s as StylesheetOut;
          const attrs = Object.entries(st.attrs ?? {}).map(([k, x]) => (x === null ? ` ${k}` : ` ${k}="${x}"`)).join("");
          out.push({ html: st.inline !== undefined ? `<style${st.media ? ` media="${st.media}"` : ""}>${st.inline}</style>` : `<link rel="stylesheet" media="${st.media ?? "all"}" href="${st.href}"${attrs} />` });
        }
      }
    }
    return out;
  };

  const settingsOf = (v: RawVariant["drupalSettings"]): Record<string, unknown> | null | undefined => {
    if (v === undefined || v === null) return v;
    if (typeof v === "string") {
      if (v.trim().startsWith("{")) return JSON.parse(v) as Record<string, unknown>;
      return (readJson(v.replace(/^\.?\/+/, "").replace(/^design\//, "")) as Record<string, unknown>) ?? undefined;
    }
    return v;
  };

  let pendingSettings: Record<string, unknown> | undefined;
  const variant = (raw: RawVariant | undefined, defaultScripts?: RawScript[], defaultStyles?: RawStyle[]): VariantOut => {
    const out: VariantOut = {};
    pendingSettings = undefined;
    if (!raw && !defaultScripts && !defaultStyles) return out;
    const r = raw ?? {};
    const head = headList(r.head ?? r.headHtml, "head");
    if (head) out.head = head;
    const bodyEnd = headList(r.bodyEnd ?? r.bodyEndHtml, "body");
    if (bodyEnd) out.bodyEnd = bodyEnd;
    const scripts = r.scripts ?? defaultScripts;
    if (scripts) {
      out.scripts = [];
      for (const s of scripts) {
        const x = script(s, "body");
        if (!x) continue;
        if ("placement" in x) out.scripts.push(x as ScriptOut);
        else notes.push("markup in scripts[] kept only through head/bodyEnd lists");
      }
    }
    const styles = r.stylesheets ?? defaultStyles;
    if (styles) {
      out.stylesheets = [];
      for (const s of styles) {
        const x = style(s);
        if (x && ("href" in x || "inline" in x)) out.stylesheets.push(x as StylesheetOut);
      }
    }
    const ds = settingsOf(r.drupalSettings) ?? pendingSettings;
    if (ds !== undefined) out.drupalSettings = ds;
    if (r.htmlAttrs) out.htmlAttrs = Object.fromEntries(Object.entries(r.htmlAttrs).filter(([, v]) => typeof v === "string"));
    if (r.bodyAttrs) out.bodyAttrs = Object.fromEntries(Object.entries(r.bodyAttrs).filter(([, v]) => typeof v === "string"));
    return out;
  };

  const m = design.manifest as DesignManifest & RawVariant & { pages?: Record<string, RawVariant> };
  const L = (design.layout ?? {}) as unknown as RawVariant;
  const global = variant(
    {
      head: L.head ?? L.headHtml ?? m.head ?? m.headHtml,
      bodyEnd: L.bodyEnd ?? L.bodyEndHtml ?? m.bodyEnd ?? m.bodyEndHtml,
      drupalSettings: L.drupalSettings ?? m.drupalSettings,
      htmlAttrs: L.htmlAttrs,
      bodyAttrs: L.bodyAttrs,
    },
    (m.scripts ?? []) as RawScript[],
    (m.stylesheets ?? []) as RawStyle[],
  );
  const types: Record<string, VariantOut> = {};
  for (const t of design.templates) {
    const raw = t as unknown as RawVariant;
    const v = variant(raw);
    delete v.bodyAttrs; // body class comes from template.bodyClass via bodyClassFor()
    if (raw.bodyAttrs) v.bodyAttrs = raw.bodyAttrs;
    if (Object.keys(v).length) types[t.contentType] = v;
  }
  const pages: Record<string, VariantOut> = {};
  // @cmp/design "asset sets": pages with identical ordered style + script lists (+ their drupalSettings) share one;
  // manifest.contentTypes[type].assetSet / manifest.pages[path].assetSet point at them
  type AssetSet = { stylesheets?: RawStyle[]; scripts?: RawScript[]; settings?: string };
  const sets = ((m as unknown as { assetSets?: Record<string, AssetSet> }).assetSets ?? {}) as Record<string, AssetSet>;
  const fromSet = (id: string | undefined): RawVariant | undefined => {
    const set = id ? sets[id] : undefined;
    if (!set) return undefined;
    return { stylesheets: set.stylesheets ?? [], scripts: set.scripts ?? [], ...(set.settings && !(set.scripts ?? []).some((x) => typeof x === "object" && x.role === "settings") ? { drupalSettings: set.settings } : {}) };
  };
  const cts = ((m as unknown as { contentTypes?: Record<string, { assetSet?: string }> }).contentTypes ?? {}) as Record<string, { assetSet?: string }>;
  for (const [type, ct] of Object.entries(cts)) {
    const raw = fromSet(ct.assetSet);
    if (!raw) continue;
    types[type] = { ...(types[type] ?? {}), ...variant(raw) };
  }
  const pageDesign: StaticPlan["json"]["pageDesign"] = {};
  for (const [path, raw0] of Object.entries(m.pages ?? {})) {
    const raw = raw0 as RawVariant & { assetSet?: string; components?: Record<string, string>; layoutVariant?: string; bodyClass?: string; template?: { slots?: unknown[]; wrapperHtml?: string; chrome?: string[] } };
    const pd = {
      ...(raw.components && Object.keys(raw.components).length ? { components: raw.components } : {}),
      ...(raw.layoutVariant ? { layoutVariant: raw.layoutVariant } : {}),
      ...(raw.bodyClass ? { bodyClass: raw.bodyClass } : {}),
      ...(raw.template && (raw.template.slots || raw.template.wrapperHtml) ? { template: { ...raw.template, ...(raw.template.wrapperHtml ? { wrapperHtml: strip(raw.template.wrapperHtml) } : {}) } } : {}),
    };
    if (Object.keys(pd).length) pageDesign[path] = pd;
    const v = variant({ ...(fromSet(raw.assetSet) ?? {}), ...pick(raw, ["head", "headHtml", "bodyEnd", "bodyEndHtml", "stylesheets", "scripts", "drupalSettings", "htmlAttrs", "bodyAttrs"]) });
    if (Object.keys(v).length) pages[path] = v;
  }
  const preload = ((m as unknown as { preload?: { href: string; as?: string; type?: string; crossorigin?: string }[] }).preload ?? []).map((p) => ({ ...p, href: isAbs(p.href) || p.href.startsWith("/") ? p.href : designUrl(p.href) }));
  if (preload.length) global.preload = preload;
  return {
    json: { renderMode: "static", ...global, types, pages, pageDesign, trackers: TRACKER_PATTERNS },
    publicFromDesign,
    sitePaths,
    removedTrackers: [...new Set(removedTrackers)],
    notes: [...new Set(notes)],
  };
}

// ---------------------------------------------------------------- <head> of a crawled original page → head items

/** attributes of a start tag, values entity-decoded (numeric ones too: bmw.de `data-breakpoints="{&#34;small&#34;:767}"` stayed escaped, React escaped it again and the site's JSON.parse failed) */
export const startTagAttrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<[a-zA-Z][\w:-]*/, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(/([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
};

/**
 * The original page's <head> as an ordered item list: per-page values (title, description, canonical, hreflang,
 * og/twitter, font preloads, stylesheets, settings + scripts) become slots filled at runtime from CCM / design.json,
 * static markup (favicons, verification metas, viewport, keywords, …) is kept literally. Trackers are dropped
 * (the design's script list decides about everything else, e.g. the seckit guard).
 * Also returns the original <html> and <body> attributes.
 */
/** minimal HTML entity decoding (<title> text, attribute values) */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", "#39": "'" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, k: string) => (k[0] === "#" ? String.fromCodePoint(k[1].toLowerCase() === "x" ? parseInt(k.slice(2), 16) : Number(k.slice(1))) : (named[k.toLowerCase()] ?? m)));
}

/**
 * Inside of a start tag up to its closing `>`, quote-aware: a `>` within a quoted attribute value does not end the tag
 * (ibm.com: `<meta name="ut-codes" content="10M00 > 15MSC > …">` was cut at the first `>`, leaving an open quote that
 * swallowed the next head item, the canonical link).
 */
const TAG_REST = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const startTagRe = (names: string, flags = "i") => new RegExp(`<(?:${names})\\b${TAG_REST}>`, flags);

export function headFromHtml(html: string): { head: HeadItem[]; htmlAttrs: Record<string, string>; bodyAttrs: Record<string, string>; removed: string[]; title?: string } {
  const removed: string[] = [];
  const htmlTag = startTagRe("html").exec(html)?.[0] ?? "<html>";
  const bodyTag = startTagRe("body").exec(html)?.[0] ?? "<body>";
  const headOpen = startTagRe("head").exec(html);
  const he = html.search(/<\/head\s*>/i);
  const head = headOpen && he > headOpen.index ? html.slice(headOpen.index + headOpen[0].length, he) : "";
  const items: HeadItem[] = [];
  const used = new Set<string>();
  const once = (slot: string) => {
    if (used.has(slot)) return;
    used.add(slot);
    items.push({ slot });
  };
  // top-level head elements (raw-text elements and noscript taken whole)
  const re = new RegExp(`<(script|style|title|noscript)\\b${TAG_REST}>[\\s\\S]*?<\\/\\1\\s*>|<(meta|link|base)\\b${TAG_REST}>|<!--[\\s\\S]*?-->`, "gi");
  for (const m of head.matchAll(re)) {
    const el = m[0];
    if (el.startsWith("<!--")) continue;
    const name = (m[1] ?? m[2]).toLowerCase();
    const a = startTagAttrs(new RegExp(`^<[a-zA-Z][\\w:-]*${TAG_REST}>`).exec(el)?.[0] ?? el);
    if (name === "title") once("title");
    else if (name === "meta") {
      const key = (a.property ?? a.name ?? "").toLowerCase();
      if (key === "description") once("description");
      else if (key === "robots") once("robots");
      else if (/^(og|twitter|article):/.test(key)) once("social");
      else items.push({ html: el });
    } else if (name === "link") {
      const rel = (a.rel ?? "").toLowerCase();
      if (rel === "canonical") once("canonical");
      else if (rel === "alternate" && a.hreflang) once("hreflang");
      else if (rel === "preload" && (a.as ?? "") === "font") once("preload");
      else if (rel === "stylesheet") once("stylesheets");
      else items.push({ html: el });
    } else if (name === "style") once("stylesheets");
    else if (name === "script") {
      const type = (a.type ?? "").toLowerCase();
      if (type === "application/json" && a["data-drupal-selector"] === "drupal-settings-json") once("scripts");
      else if (type && !/javascript|module|ecmascript/.test(type)) items.push({ html: el });
      else if (isTrackerText(a.src ?? el)) {
        removed.push(a.src ?? "inline tracker");
        // theme/module JS still pushes events to the dataLayer the removed bootstrap defined: keep an inert array
        if (!a.src && /\bdataLayer\b/.test(el) && !used.has("dataLayerStub")) {
          used.add("dataLayerStub");
          items.push({ html: "<script>window.dataLayer = window.dataLayer || [];</script>" });
        }
      }
      else once("scripts");
    } else if (name === "noscript") {
      const r = stripTrackers(el);
      removed.push(...r.removed);
      if (r.html.replace(/<\/?noscript[^>]*>/gi, "").trim()) items.push({ html: r.html });
    } else items.push({ html: el });
  }
  const attrsOf = (tag: string) => startTagAttrs(tag);
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const title = t === undefined ? undefined : decodeEntities(t).replace(/\s+/g, " ").trim() || undefined;
  return { head: items, htmlAttrs: attrsOf(htmlTag), bodyAttrs: attrsOf(bodyTag), removed, ...(title ? { title } : {}) };
}
