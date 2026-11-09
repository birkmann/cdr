/**
 * Static render mode ("static islands") — for sites whose original JavaScript (Drupal behaviours, jQuery plugins,
 * sliders, third-party widgets) must run against the server-rendered markup exactly as on the old site.
 *
 * The page's <head> and <body> contents are rendered to HTML strings from the design templates (template-string.ts)
 * and emitted by the root layout with dangerouslySetInnerHTML. React hydrates only <html>/<head>/<body> themselves and
 * never reconciles their children, so:
 *  - the ported scripts execute during HTML parsing in their original order and placement (head vs. end of body),
 *  - whatever those scripts do to the DOM (slick, once(), dark mode, removing seckit's anti-clickjacking <link>, …)
 *    cannot cause hydration mismatches or be "fixed up" by React,
 *  - Next.js adds no wrapper element, no metadata outlet and no hoisted preloads to the visible document.
 *
 * Generated input: src/generated/design.json (renderMode "static", head/bodyEnd items, scripts, drupalSettings,
 * per content-type / per-path variants) + src/generated/registry.ts (component/wrapper/layout template strings).
 */
import { createElement, isValidElement, type ReactNode } from "react";
import design from "../../generated/design.json";
import { byType, components, layout, templates, views, type ComponentEntry, type TemplateDef } from "../../generated/registry";
import type { RichTextDoc } from "../ccm-types";
import type { Store } from "../data/store";
import type { AssetView, CollectionView, EntryView, LinkView, TermView } from "../data/types";
import { Fallback } from "../../components/fallback";
import { RichText } from "../richtext/RichText";
import { parseHtml, styleToObject } from "../html/parse";
import { sanitizeTree } from "../html/sanitize";
import { escapeAttr, escapeText, RawMarkup, renderToHtml, serializeNodes } from "../html/serialize";
import { seoContext } from "../route";
import { socialTags } from "../seo";
import { bindProps, entityIdOf, listingCollectionId, minedListingRows, scope, wrapperI18n, type ChromeData, type InstanceInfo, type RenderCtx, type Scope } from "./runtime";
import { renderTemplateString } from "./template-string";
import { bodyClassFor, templateForEntry, withCrawledListingTitle } from "./page";
import { PLAYER_FALLBACK_JS } from "./player-fallback";

// ---------------------------------------------------------------- design.json (static part)

export interface HeadItem {
  /** literal markup (already tracker-filtered by the generator) */
  html?: string;
  /** dynamic part rendered per page */
  slot?: "seo" | "title" | "description" | "robots" | "canonical" | "hreflang" | "social" | "icon" | "preload" | "stylesheets" | "scripts" | "drupalSettings" | "jsonld";
}
export interface ScriptDef {
  /** external script; absent for inline scripts and the drupalSettings marker */
  src?: string;
  /** inline JavaScript (original inline <script>) */
  inline?: string;
  /** position of the drupalSettings JSON block within the ordered script list */
  settings?: boolean;
  placement: "head" | "body";
  /** extra attributes in original order (defer, async, fetchpriority, type, data-*) */
  attrs?: Record<string, string | null>;
}
export interface DesignVariant {
  /** crawled <title> of a page without CCM meta (Views listing pages) */
  title?: string;
  head?: HeadItem[];
  bodyEnd?: HeadItem[];
  stylesheets?: (string | { href?: string; inline?: string; media?: string; attrs?: Record<string, string | null> })[];
  scripts?: ScriptDef[];
  /** <link rel="preload"> (fonts) in original order */
  preload?: { href: string; as?: string; type?: string; crossorigin?: string }[];
  drupalSettings?: Record<string, unknown> | null;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
}
export interface DesignJson extends DesignVariant {
  renderMode?: "static" | "react";
  icon?: string;
  /** per content type, per live path (path wins) */
  types?: Record<string, DesignVariant>;
  pages?: Record<string, DesignVariant>;
  /** regexes (strings) of tracker URLs/snippets that must never be emitted (scripts from CCM settings included) */
  trackers?: string[];
  /** per crawled path: component variants (base id → variant id), layout variant, body class */
  pageDesign?: Record<string, { components?: Record<string, string>; layoutVariant?: string; bodyClass?: string; template?: { slots?: TemplateDef["slots"]; wrapperHtml?: string; chrome?: string[] } }>;
  /** absolute URL prefixes rewritten in the static output: replay origin → old origin, old origin → root-relative */
  urlRewrite?: {
    replay?: string;
    origin?: string;
    /** live source: absolute URLs on its origin that point to a file served from public/ become root-relative */
    local?: { origin: string; paths: string[] };
    /** captured third-party resources served from public/__ext/<host>/… (scripts excluded) */
    thirdParty?: { paths: string[] };
  };
}

export const D = design as unknown as DesignJson;
export const isStaticMode = () => D.renderMode === "static";

function deepMerge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
}

/** effective design variant of a page: global ← content type ← path */
export function variantFor(type: string | undefined, path: string): Required<Pick<DesignVariant, "stylesheets" | "scripts">> & DesignVariant {
  const layers = [D as DesignVariant, type ? D.types?.[type] : undefined, D.pages?.[path]].filter(Boolean) as DesignVariant[];
  const v: DesignVariant = {};
  for (const l of layers) {
    for (const k of ["head", "bodyEnd", "stylesheets", "scripts", "preload", "htmlAttrs", "bodyAttrs"] as const) if (l[k] !== undefined) (v as Record<string, unknown>)[k] = l[k];
    if (l.drupalSettings !== undefined) v.drupalSettings = l.drupalSettings === null ? null : (deepMerge(v.drupalSettings ?? {}, l.drupalSettings) as Record<string, unknown>);
  }
  return { ...v, stylesheets: v.stylesheets ?? [], scripts: v.scripts ?? [] };
}

let trackerRes: RegExp[] | undefined;
export function isTracker(s: string | undefined): boolean {
  if (!s) return false;
  trackerRes ??= (D.trackers ?? []).map((t) => new RegExp(t, "i"));
  return trackerRes.some((r) => r.test(s));
}

// ---------------------------------------------------------------- values → HTML

export class SafeHtml {
  constructor(readonly html: string) {}
  toString() {
    return this.html;
  }
}
const isSafe = (v: unknown): v is SafeHtml => v instanceof SafeHtml || (!!v && typeof v === "object" && !isValidElement(v) && typeof (v as SafeHtml).html === "string" && Object.keys(v).length === 1);
const kindOf = (o: unknown) => (o && typeof o === "object" ? (o as { _kind?: string })._kind : undefined);

/** CCM html strings: sanitised (same allowlist as RawHtml), but passed through byte-identical when nothing was removed */
export function cleanHtml(html: string): string {
  const parsed = parseHtml(html);
  const a = serializeNodes(parsed);
  const b = serializeNodes(sanitizeTree(parsed));
  return a === b ? html : b;
}

function richTextHtml(doc: RichTextDoc, ctx: RenderCtx): string {
  return renderToHtml(
    createElement(RichText, {
      doc,
      hooks: {
        renderEntry: (e: EntryView) => createElement(RawMarkup, { html: toHtml(ctx.renderEntry(e), ctx) }),
        renderAsset: ctx.renderAsset ? (a: AssetView, c?: string) => createElement(RawMarkup, { html: toHtml(ctx.renderAsset!(a, c), ctx) }) : undefined,
      },
    }),
  );
}

/** `{{{x}}}` value → HTML (string mode counterpart of runtime Html) */
export function toHtml(value: unknown, ctx: RenderCtx): string {
  if (value == null || value === false || value === "") return "";
  if (isSafe(value)) return value.html;
  if (typeof value === "string") return cleanHtml(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => toHtml(v, ctx)).join("");
  if (isValidElement(value)) return renderToHtml(value as ReactNode);
  const o = value as Record<string, unknown>;
  if (o.type === "doc") return richTextHtml(value as RichTextDoc, ctx);
  switch (kindOf(value)) {
    case "entry":
      return toHtml(ctx.renderEntry(value as EntryView), ctx);
    case "collection":
      return (value as CollectionView).items.map((e) => toHtml(ctx.renderEntry(e), ctx)).join("");
    case "asset": {
      const a = value as AssetView;
      return `<img src="${escapeAttr(a.url)}" alt="${escapeAttr(a.alt ?? "")}"${a.width ? ` width="${a.width}"` : ""}${a.height ? ` height="${a.height}"` : ""}>`;
    }
    case "link": {
      const l = value as LinkView;
      return `<a href="${escapeAttr(l.href)}">${escapeText(l.label)}</a>`;
    }
    case "term": {
      const t = value as TermView;
      return t.path ? `<a href="${escapeAttr(t.path)}">${escapeText(t.name)}</a>` : escapeText(t.name);
    }
  }
  if (typeof o.html === "string") return toHtml(o.html, ctx);
  if (typeof o.value === "string") return toHtml(o.value, ctx);
  return "";
}

const hooks = { html: toHtml };

function renderComp(c: ComponentEntry, vm: Scope, ctx: RenderCtx): SafeHtml {
  if (typeof c.template === "string") return new SafeHtml(renderTemplateString(c.template, vm, ctx, hooks));
  return new SafeHtml(renderToHtml(createElement(c.Component, { vm, ctx })));
}

const inst = (c: ComponentEntry): InstanceInfo | undefined => (c.instanceProps ? { key: c.instanceKey, props: c.instanceProps } : undefined);
const bind = (c: ComponentEntry, source: unknown, ctx: RenderCtx, extra?: Record<string, unknown>) => scope(bindProps(c.props, source, ctx, extra, inst(c)));

/**
 * Structural variant of a design component for this instance: the variant that was mined from this entity (entity id
 * in its instanceProps), the page's recorded variant (design pages[path].components), the variant mined on this path,
 * else the requested component.
 */
export function pickComponent(id: string, source: unknown, path: string): ComponentEntry | undefined {
  const req = components[id];
  if (!req) return undefined;
  const base = req.variantOf ?? id;
  const fam = Object.values(components).filter((c) => c.id === base || c.variantOf === base);
  const eid = entityIdOf(source);
  if (eid) {
    const hit = fam.find((c) => c.instanceKey !== "path" && c.instanceProps?.[eid]);
    if (hit) return hit;
    // the entity was mined as another (nested-entity) component, e.g. accordion subitems → expandable card items
    // (Drupal entity ids are unique, so the mined instance identifies the component even when type names differ)
    const other = Object.values(components).find((c) => c.kind === "section" && c.instanceKey !== "path" && c.instanceProps?.[eid]);
    if (other) return other;
  }
  if (fam.length < 2) return req;
  const pd = D.pageDesign?.[path]?.components?.[base];
  if (pd && components[pd]) return components[pd];
  const onPath = fam.find((c) => c.instanceKey === "path" && c.instanceProps?.[path]);
  return onPath ?? req;
}

// ---------------------------------------------------------------- render context (string mode)

export function makeStaticCtx(chrome: ChromeData): RenderCtx {
  const ctx: RenderCtx = {
    locale: chrome.locale,
    path: chrome.path,
    chrome,
    canRender(e: EntryView): boolean {
      const id = byType[e.type];
      const c = id ? pickComponent(id, e, chrome.path) : undefined;
      return !!c && c.kind !== "document";
    },
    renderEntry(e: EntryView): ReactNode {
      const id = byType[e.type];
      let c = id ? pickComponent(id, e, chrome.path) : undefined;
      if (c?.kind === "document") c = undefined; // embedded entries never render as a full document view
      if (c) return renderComp(c, bind(c, e, ctx), ctx) as unknown as ReactNode;
      return new SafeHtml(renderToHtml(createElement(Fallback.Entry, { entry: e, ctx }))) as unknown as ReactNode;
    },
    renderComponent(id: string, source: unknown): ReactNode {
      const c = pickComponent(id, source, chrome.path);
      if (!c) return null;
      const src = c.kind === "chrome" ? chromeSource(id, chrome) : source;
      return renderComp(c, bind(c, src, ctx), ctx) as unknown as ReactNode;
    },
  };
  const media = Object.values(components).find((c) => c.ccmType === "asset" || /^(media|mediaImage|embeddedAsset|embeddedMedia)$/i.test(c.id));
  if (media) ctx.renderAsset = (a, caption) => renderComp(media, bind(media, { ...a, image: a, caption }, ctx), ctx) as unknown as ReactNode;
  return ctx;
}

/** same chrome data shaping as page.tsx (nav/language components iterate `items`) */
function chromeSource(id: string, chrome: ChromeData): Record<string, unknown> {
  const lid = id.toLowerCase();
  let items: unknown = chrome.nav.main ?? [];
  if (/lang/.test(lid)) items = chrome.languages;
  else if (/footer/.test(lid)) items = chrome.nav.footer ?? [];
  return { ...chrome, items, links: items, menu: items, mainNav: chrome.nav.main ?? [], footerNav: chrome.nav.footer ?? [] };
}

const H = (ctx: RenderCtx, v: unknown) => toHtml(v, ctx);

function renderSlot(slot: TemplateDef["slots"][number], entry: EntryView, ctx: RenderCtx): string {
  const extra = slot.props;
  const path = ctx.chrome.path;
  if (slot.component === "$collection") {
    const cid = listingCollectionId(entry);
    const viewId = cid ? views[cid] : undefined;
    const vc = viewId ? pickComponent(viewId, entry, path) : undefined;
    if (vc) return renderComp(vc, bind(vc, entry, ctx, { ...(extra ?? {}), ...(minedListingRows(vc, entry, ctx) ?? {}) }), ctx).html;
    return ((entry.fields.items as EntryView[] | undefined) ?? []).map((it) => H(ctx, ctx.renderEntry(it))).join("");
  }
  if (slot.field) {
    const v = entry.fields[slot.field];
    if (slot.repeat || Array.isArray(v)) {
      const items = Array.isArray(v) ? v : v == null ? [] : [v];
      return items
        .map((it) => {
          const e = it as EntryView;
          const typed = e && e._kind === "entry" ? byType[e.type] : undefined;
          const c = typed ? pickComponent(typed, e, path) : pickComponent(slot.component, it, path);
          if (c) return renderComp(c, bind(c, it, ctx, extra), ctx).html;
          return e?._kind === "entry" ? H(ctx, ctx.renderEntry(e)) : "";
        })
        .join("");
    }
    const src = v && typeof v === "object" && (v as EntryView)._kind === "entry" ? v : entry;
    const comp = pickComponent(slot.component, src, path);
    if (!comp) return "";
    return renderComp(comp, bind(comp, src, ctx, extra), ctx).html;
  }
  const comp = pickComponent(slot.component, entry, path);
  if (!comp) return "";
  if (comp.kind === "chrome") return H(ctx, ctx.renderComponent(slot.component, entry));
  return renderComp(comp, bind(comp, entry, ctx, extra), ctx).html;
}

/** <body> inner HTML of a page: layout(chrome + main) → wrapper(regions) → slots (string twin of PageBody) */
export function pageBodyHtml(entry0: EntryView, ctx: RenderCtx): string {
  const entry = withCrawledListingTitle(entry0, ctx.chrome.path);
  const t0 = templateForEntry(entry);
  if (!t0) return renderToHtml(createElement(Fallback.Page, { entry, ctx }));
  // page-specific template (design pages[path].template: other slots/wrapper on this page, e.g. a share block)
  const ov = D.pageDesign?.[ctx.chrome.path]?.template;
  const t: TemplateDef = ov ? { ...t0, slots: ov.slots ?? t0.slots, chrome: ov.chrome ?? t0.chrome, ...(ov.wrapperHtml !== undefined ? { wrapperTemplate: ov.wrapperHtml, Wrapper: undefined } : {}) } : t0;
  const regions: Record<string, string[]> = {};
  for (const slot of t.slots) (regions[slot.region ?? "content"] ??= []).push(renderSlot(slot, entry, ctx));
  const regionHtml = Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, new SafeHtml(v.join(""))]));
  const content = new SafeHtml(Object.values(regions).flat().join(""));
  let main: SafeHtml = content;
  // the page-specific wrapper (crawled page) is already in its own language; the type wrapper's UI strings come from i18n
  const ti = ov?.wrapperHtml !== undefined ? undefined : wrapperI18n(t.i18n, ctx);
  const wvm = scope({ ...ctx.chrome, ...entry.fields, regions: regionHtml, content, slots: content, ...(ti ? { t: ti } : {}) });
  if (typeof t.wrapperTemplate === "string") main = new SafeHtml(renderTemplateString(t.wrapperTemplate, wvm, ctx, hooks));
  else if (t.Wrapper) main = new SafeHtml(renderToHtml(createElement(t.Wrapper, { vm: wvm, ctx })));
  const chromeIds = [...new Set([...(layout?.chrome ?? []), ...t.chrome])];
  const chromeEls: Record<string, SafeHtml> = {};
  for (const id of chromeIds) chromeEls[id] = new SafeHtml(H(ctx, ctx.renderComponent(id, entry)));
  if (layout) {
    // layout variant of this page (design layout.variants / pages[path].layoutVariant)
    const path = ctx.chrome.path;
    const lvId = D.pageDesign?.[path]?.layoutVariant;
    const lv = layout.variants?.find((x) => x.id === lvId) ?? layout.variants?.find((x) => x.pages.includes(path));
    const src = { ...ctx.chrome, chrome: chromeEls, main };
    const vm = scope(bindProps(lv?.props ?? layout.props, src, ctx, undefined, layout.instanceProps ? { key: "path", props: layout.instanceProps } : undefined));
    const tpl = lv?.template ?? layout.template;
    return typeof tpl === "string" ? renderTemplateString(tpl, vm, ctx, hooks) : renderToHtml(createElement(layout.Component, { vm, ctx }));
  }
  const before = t.chrome.filter((id) => !/footer|cookie/i.test(id)).map((id) => chromeEls[id].html);
  const after = t.chrome.filter((id) => /footer|cookie/i.test(id)).map((id) => chromeEls[id].html);
  return [...before, main.html, ...after].join("");
}

// ---------------------------------------------------------------- URL normalisation

const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let urlRes: { ext?: RegExp; extLink?: RegExp; replay?: RegExp; attr?: RegExp; srcset?: RegExp } | undefined;

/**
 * Captured sources come with the replay's absolute URLs (http://localhost:4401/…, …/__ext/<host>/…) and the old
 * site's absolute URLs (https://www.example.com/…). The new site must not depend on either: replay URLs become
 * root-relative (third-party ones go back to their host), old-origin URLs in attributes / url() / srcset become
 * root-relative — the live path structure is kept and the browser never requests the old origin.
 */
let localRe: { re: RegExp; paths: Set<string> } | undefined;
/** absolute same-origin resource URLs (img, srcset, preload) → the local copy, when public/ serves that file */
function localizeResources(html: string): string {
  const lo = D.urlRewrite?.local;
  if (!lo?.paths.length) return html;
  if (!localRe) {
    const host = lo.origin.replace(/^https?:/, "").replace(/\/+$/, "");
    localRe = { re: new RegExp(`(?:https?:)?${reEsc(host)}(/[^"'\\s,)<>]*)`, "g"), paths: new Set(lo.paths) };
  }
  return html.replace(localRe.re, (m, path: string) => {
    const file = path.split(/[?#]/)[0]!;
    let decoded = file;
    try {
      decoded = decodeURIComponent(file);
    } catch {
      /* keep */
    }
    return localRe!.paths.has(file) || localRe!.paths.has(decoded) ? path : m;
  });
}

let extRe: { re: RegExp; paths: Set<string> } | undefined;
/**
 * Absolute third-party resource URLs (src, srcset, poster, url(), JSON-escaped copies in inline data) → the captured copy
 * under /__ext/<host>/…, when public/ serves that file. The query string is kept; links (<a href>) keep their host.
 */
export function localizeThirdParty(html: string): string {
  const tp = D.urlRewrite?.thirdParty;
  if (!tp?.paths.length) return html;
  if (!extRe) {
    const hosts = [...new Set(tp.paths.map((p) => p.split("/")[2]!))].sort((a, b) => b.length - a.length);
    extRe = {
      re: new RegExp(`(<a\\b[^>]*?\\shref=\\\\?["'][^"'\\\\]*)|(?:https?:)?(\\\\?/\\\\?/)(${hosts.map(reEsc).join("|")})((?:\\\\?/[^"'\\s,)<>?#\\\\]*)+)`, "g"),
      paths: new Set(tp.paths),
    };
  }
  return html.replace(extRe.re, (m, link: string | undefined, slashes: string, host: string, path: string) => {
    if (link) return m;
    const clean = path.replace(/\\\//g, "/");
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* keep */
    }
    if (!extRe!.paths.has(`/__ext/${host}${clean}`) && !extRe!.paths.has(`/__ext/${host}${decoded}`)) return m;
    return slashes.includes("\\") ? `\\/__ext\\/${host}${path}` : `/__ext/${host}${path}`;
  });
}

export function rewriteUrls(html: string, oldOrigin = true): string {
  const rw = D.urlRewrite;
  if (rw?.local) html = localizeResources(html);
  if (rw?.thirdParty) html = localizeThirdParty(html);
  if (!rw || (!rw.replay && !rw.origin)) return html;
  if (!urlRes) {
    urlRes = {};
    if (rw.replay) {
      const host = rw.replay.replace(/^https?:/, "");
      urlRes.ext = new RegExp(`(?:https?:)?${reEsc(host)}/__ext/`, "g");
      urlRes.extLink = new RegExp(`(<a\\b[^>]*?\\shref=["'])(?:https?:)?${reEsc(host)}/__ext/`, "g");
      urlRes.replay = new RegExp(`(?:https?:)?${reEsc(host)}(?=[/"'?#)\\s,]|$)`, "g");
    }
    if (rw.origin) {
      const o = reEsc(rw.origin.replace(/^https?:/, "").replace(/\/+$/, ""));
      urlRes.attr = new RegExp(`(=\\s*["']|url\\(\\s*["']?)(?:https?:)?${o}(/|(?=["')]))`, "g");
      urlRes.srcset = new RegExp(`((?:^|,)\\s*)(?:https?:)?${o}(?=/)`, "g");
    }
  }
  let out = html;
  // third parties: links go back to their host, resources stay on the copies served from public/__ext/<host>/
  if (urlRes.extLink) out = out.replace(urlRes.extLink, "$1https://");
  if (urlRes.ext) out = out.replace(urlRes.ext, "/__ext/");
  if (urlRes.replay) out = out.replace(urlRes.replay, "");
  // the same inside JSON strings ("http:\/\/host\/path")
  if (rw.replay) {
    const j = rw.replay.replace(/^https?:/, "").replace(/\//g, "\\/");
    out = out.split(`http:${j}\\/`).join("\\/").split(`https:${j}\\/`).join("\\/"); // …\/__ext\/<host>\/… stays local
  }
  if (!oldOrigin) return out;
  if (rw.origin) {
    const j = rw.origin.replace(/^https?:/, "").replace(/\/+$/, "").replace(/\//g, "\\/");
    out = out.split(`https:${j}\\/`).join("\\/").split(`http:${j}\\/`).join("\\/");
  }
  if (urlRes.attr) out = out.replace(urlRes.attr, (_m, pre: string) => `${pre}/`);
  if (urlRes.srcset) out = out.replace(/(\s(?:data-)?srcset=")([^"]*)"/g, (_m, a: string, v: string) => `${a}${v.replace(urlRes!.srcset!, "$1")}"`);
  return out;
}

// ---------------------------------------------------------------- head / body documents

const attrStr = (attrs: Record<string, string | null | undefined>) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (v == null ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
    .join("");

/** Drupal's JSON encoding for drupalSettings (JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT inside strings) */
export function drupalJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/'/g, "\\u0027")
    .replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

/**
 * drupalSettings of a page. Settings captured for exactly this path are used verbatim; settings inherited from another
 * page (content-type / global variant) get this page's `path` block (currentPath drives active-link.js highlighting).
 */
export function pageDrupalSettings(base: Record<string, unknown>, entry: EntryView, path: string, isFront: boolean, prefix: string, exact = false): Record<string, unknown> {
  if (exact) return base;
  const p = (base.path ?? {}) as Record<string, unknown>;
  const nid = entry.source && (entry.source as { system?: string; kind?: string; id?: string }).kind === "node" ? (entry.source as { id?: string }).id : undefined;
  const currentPath = isFront && p.isFront ? p.currentPath : nid ? `node/${nid}` : (p.currentPath ?? path.replace(/^\/+/, ""));
  return { ...base, path: { ...p, baseUrl: p.baseUrl ?? "/", pathPrefix: prefix ? prefix.replace(/^\/+/, "") + "/" : (p.pathPrefix ?? ""), currentPath, isFront, currentLanguage: entry.locale } };
}

export interface StaticDocument {
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  head: string;
  body: string;
}

const scriptKey = (src: string) => src.split("?")[0].replace(/^https?:/, "");

export async function staticDocument(data: Store, entry: EntryView, path: string, locale: string, chrome: ChromeData): Promise<StaticDocument> {
  const isFront = path === (data.prefixOf(locale) || "/");
  const v = variantFor(entry.type, path);
  const settings = chrome.site;
  const ctx = makeStaticCtx(chrome);
  const bodyMain = pageBodyHtml(entry, ctx);

  // ---- dynamic head slots
  const sc = await seoContext(data, entry, path, locale);
  const meta = sc.meta;
  const alternates = meta.hreflang?.length ? meta.hreflang.map((h) => ({ locale: h.locale, href: sc.rehost(h.href) })) : (await data.getAlternates(entry.ccmId)).map((a) => ({ locale: a.locale, href: sc.origin + a.path }));
  const social = socialTags(entry, { ...sc, description: meta.description, og: meta.og, twitter: meta.twitter });
  const slot: Record<string, () => string> = {
    title: () => `<title>${escapeText(entry.meta?.title ?? D.pages?.[path]?.title ?? sc.title)}</title>`,
    description: () => (meta.description ? `<meta name="description" content="${escapeAttr(meta.description)}" />` : ""),
    robots: () => (meta.robots ? `<meta name="robots" content="${escapeAttr(meta.robots)}" />` : ""),
    canonical: () => (sc.canonicalLink ? `<link rel="canonical" href="${escapeAttr(sc.canonicalLink)}" />` : ""),
    hreflang: () => alternates.map((a) => `<link rel="alternate" hreflang="${escapeAttr(a.locale)}" href="${escapeAttr(a.href)}" />`).join("\n"),
    social: () => social.map((t) => `<meta ${t.attr}="${escapeAttr(t.key)}" content="${escapeAttr(t.content)}" />`).join("\n"),
    icon: () => (D.icon ? `<link rel="icon" href="${escapeAttr(D.icon)}" />` : ""),
    jsonld: () => (meta.structuredData ?? []).map((d) => `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, "\\u003c")}</script>`).join(""),
  };
  slot.preload = () => (v.preload ?? []).map((p) => `<link rel="preload"${attrStr({ as: p.as ?? "font", href: p.href, type: p.type, crossorigin: p.crossorigin })}>`).join("\n");
  slot.seo = () => ["title", "description", "robots", "canonical", "hreflang", "social"].map((k) => slot[k]()).filter(Boolean).join("\n");
  const stylesheets = v.stylesheets.map((s) => (typeof s === "string" ? { href: s } : s));
  slot.stylesheets = () =>
    stylesheets
      .map((s) => (s.inline !== undefined ? `<style${attrStr({ media: s.media, ...(s.attrs ?? {}) })}>${s.inline}</style>` : `<link rel="stylesheet"${attrStr({ media: s.media ?? "all", href: s.href, ...(s.attrs ?? {}) })} />`))
      .join("\n");

  // scripts (ordered): design (ported theme/Drupal JS, settings marker, inline) + CCM settings scripts not covered
  const scripts: ScriptDef[] = v.scripts.filter((s) => !isTracker(s.src) && !(s.inline && isTracker(s.inline)));
  const seen = new Set(scripts.filter((s) => s.src).map((s) => scriptKey(s.src!)));
  // CCM SiteSettings scripts only when the design has no ordered script list of its own (the design list is the
  // complete original sequence incl. inline scripts; settings would duplicate it under other URLs)
  for (const s of scripts.length ? [] : (settings.scripts ?? [])) {
    if (s.src) {
      if (seen.has(scriptKey(s.src)) || isTracker(s.src)) continue;
      scripts.push({ src: s.src, placement: s.placement === "head" ? "head" : "body", attrs: /^https?:\/\//.test(s.src) ? { async: null } : undefined });
    } else if (s.inline && !isTracker(s.inline)) scripts.push({ inline: s.inline, placement: s.placement === "head" ? "head" : "body", attrs: { id: s.id } });
  }

  let settingsDone = false;
  const settingsJson = () => {
    if (settingsDone || !v.drupalSettings) return "";
    settingsDone = true;
    const ds = pageDrupalSettings(v.drupalSettings, entry, path, isFront, data.prefixOf(locale), D.pages?.[path]?.drupalSettings != null);
    return `<script type="application/json" data-drupal-selector="drupal-settings-json">${drupalJson(ds)}</script>`;
  };
  const usedScripts = new Set<ScriptDef>();
  const scriptsFor = (placement: "head" | "body", already: string) =>
    scripts
      .filter((s) => s.placement === placement && !usedScripts.has(s))
      .map((s) => {
        usedScripts.add(s);
        if (s.settings) return settingsJson();
        if (s.inline !== undefined) return `<script${attrStr(s.attrs ?? {})}>${s.inline}</script>`;
        if (!s.src || already.includes(`src="${s.src}"`)) return "";
        return `<script src="${escapeAttr(s.src)}"${attrStr(s.attrs ?? {})}></script>`;
      })
      .filter(Boolean)
      .join("\n");

  const hasHeadScripts = scripts.some((s) => s.placement === "head");
  const settingsInList = scripts.some((s) => s.settings);
  const headItems: HeadItem[] = v.head ?? [
    { html: '<meta charset="utf-8" />' },
    { slot: "seo" },
    { slot: "icon" },
    { slot: "preload" },
    { slot: "stylesheets" },
    ...(hasHeadScripts && !settingsInList ? ([{ slot: "drupalSettings" }] as HeadItem[]) : []),
    { slot: "scripts" },
  ];
  const bodyEndItems: HeadItem[] = v.bodyEnd ?? [{ slot: "jsonld" }, { slot: "drupalSettings" }, { slot: "scripts" }];

  const render = (items: HeadItem[], placement: "head" | "body", sofar: string) => {
    const out: string[] = [];
    for (const it of items) {
      if (it.html !== undefined) {
        out.push(it.html); // design markup: trackers already stripped by the generator
        continue;
      }
      if (it.slot === "scripts") out.push(scriptsFor(placement, sofar + out.join("")));
      else if (it.slot === "drupalSettings") out.push(sofar.includes('data-drupal-selector="drupal-settings-json"') ? "" : settingsJson());
      else if (it.slot) out.push(slot[it.slot]?.() ?? "");
    }
    return out.filter(Boolean).join("\n");
  };
  if (bodyMain.includes('data-drupal-selector="drupal-settings-json"')) settingsDone = true;
  const head = render(headItems, "head", "");
  const bodyEnd = render(bodyEndItems, "body", bodyMain + head);

  // ---- <html>/<body> attributes
  const htmlAttrs: Record<string, string> = { lang: locale, dir: "ltr", ...(v.htmlAttrs ?? {}) };
  for (const [k, val] of Object.entries(htmlAttrs)) if (val.includes("{{")) htmlAttrs[k] = k === "lang" ? locale : val.replace(/\{\{[^}]*\}\}/g, "").trim();
  // the design variant's <html lang> comes from the crawled page of ONE locale: other locales render their own
  if (htmlAttrs.lang && htmlAttrs.lang.toLowerCase().split("-")[0] !== locale.toLowerCase().split("-")[0]) htmlAttrs.lang = locale;
  const bodyClass = bodyClassFor(entry, isFront);
  const bodyAttrs: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.bodyAttrs ?? (bodyClass ? { class: "{{bodyClass}}" } : {}))) {
    const out = val.replace(/\{\{\s*bodyClass\s*\}\}/g, bodyClass ?? "").replace(/\{\{[^}]*\}\}/g, "").trim();
    if (out || !val.includes("{{")) bodyAttrs[k] = out;
  }
  // app-owned runtime (never URL-rewritten): poster fallback for embedded players the new domain may not play
  const appScripts = `\n<script data-cmp="player-fallback">${PLAYER_FALLBACK_JS}</script>`;
  return { htmlAttrs, bodyAttrs, head: rewriteUrls(head, false), body: rewriteUrls(bodyMain + (bodyEnd ? "\n" + bodyEnd : "")) + appScripts };
}

/** HTML attribute map → React props for <html>/<body> (class → className; everything else verbatim) */
export function domProps(attrs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") out.style = styleToObject(v);
    else out[k === "class" ? "className" : k === "for" ? "htmlFor" : k] = v;
  }
  return out;
}

