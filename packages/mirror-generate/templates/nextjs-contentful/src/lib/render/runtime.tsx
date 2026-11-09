/**
 * Runtime for components compiled from design/components/*.json (Handlebars subset → TSX, see the generator).
 * Compiled code only calls these helpers, so the semantics of {{x}}, {{{x}}}, {{#each}}, {{#if}} live in one place.
 */
import { Fragment, isValidElement, type ReactNode } from "react";
import type { RichTextDoc } from "../ccm-types";
import type { AssetView, CollectionView, EntryStub, EntryView, LinkView, NavItemView, SettingsView, TermView } from "../data/types";
import { RawHtml } from "../richtext/RawHtml";
import { RichText, richTextToPlainText } from "../richtext/RichText";
import dateConfig from "../../generated/config.json";
import { parseHtml, styleToObject } from "../html/parse";
import { nodesToReact } from "../html/react";
import { renderToHtml } from "../html/serialize";

// ---------------------------------------------------------------- render context

export interface NavItemState extends Omit<NavItemView, "children"> {
  active: boolean;
  activeTrail: boolean;
  hasChildren: boolean;
  children: NavItemState[];
}
export interface LanguageLink {
  code: string;
  locale: string;
  name: string;
  label: string;
  href: string;
  hreflang: string;
  active: boolean;
  translated: boolean;
}
export interface ChromeData {
  site: SettingsView;
  siteName: string;
  slogan?: string;
  logo?: AssetView;
  footerText?: string;
  homeHref: string;
  nav: Record<string, NavItemState[]>;
  languages: LanguageLink[];
  locale: string;
  path: string;
  entry: EntryView | null;
  title: string;
  /** embedded listings (design props with `collection`) run for this page's entry: collection id → rows */
  collections?: Record<string, EntryView[]>;
}
/** prop definition as written by @cmp/design (design/components/*.json) */
export interface PropDef {
  name: string;
  type: string;
  ccmField?: string;
  /** html prop rendered by another design component (siteHeader → mainNav) */
  component?: string;
  /** list items rendered by this component, exposed as {{{this.html}}} */
  itemComponent?: string;
  itemFields?: Record<string, string>;
  valueType?: "boolean";
  /** UI string per locale ({{t.key}}) */
  i18n?: Record<string, string>;
  /** dates: {{x.iso}} / {{x.formatted}} */
  format?: { kind: "date"; options: Intl.DateTimeFormatOptions; locales: Record<string, string>; pattern?: string; case?: Record<string, "title"> };
  /** value of the canonical mined instance — default for presentational props without ccmField (e.g. align) */
  example?: unknown;
  /** value derived from the bound entry: "ccmIdTail" = Drupal entity id (source id / last ccmId segment) */
  derive?: "ccmIdTail";
  /** rich text whose original container has no block element: a single paragraph renders without <p> */
  inline?: boolean;
  /** text prop bound to a rich-text field: plain text */
  plainText?: boolean;
  /** list prop showing an embedded Views block: CCM collection id, run for the page entry (ChromeData.collections) */
  collection?: string;
  /** source formatter of a bound number/enum, per locale: [prefix, suffix] around numbers, enum key → label */
  display?: { affix?: Record<string, [string, string]>; labels?: Record<string, Record<string, string>> };
}

/** number/enum value as the source printed it (design `display`): locale first, then the other site languages */
export function displayValue(d: NonNullable<PropDef["display"]>, v: unknown, ctx: Pick<RenderCtx, "locale" | "chrome">): unknown {
  if (typeof v !== "number" && typeof v !== "string") return v;
  const order = [ctx.locale, ...ctx.chrome.languages.map((l) => l.code).filter((c) => c !== ctx.locale)];
  if (d.labels && typeof v === "string") {
    for (const l of order) if (d.labels[l]?.[v] !== undefined) return d.labels[l][v];
    return v;
  }
  if (d.affix && (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(v))) {
    const a = order.map((l) => d.affix![l]).find(Boolean) ?? Object.values(d.affix)[0];
    return a ? `${a[0]}${v}${a[1]}` : v;
  }
  return v;
}
/** observed values of every mined instance of a component (design `instanceProps`), keyed by entity id or page path */
export interface InstanceInfo {
  key?: "entityId" | "path";
  props?: Record<string, Record<string, unknown>>;
}

/** Drupal entity id of a bound entry: numeric source id (`node/123`, `456`) or numeric last ccmId segment */
/** the collection a listing page shows: the synthetic `collection` entry's own, or a document field holding one */
export function collectionOf(entry: EntryView): CollectionView | undefined {
  const own = entry.fields.collection;
  if (kindOf(own) === "collection") return own as CollectionView;
  for (const v of Object.values(entry.fields)) if (kindOf(v) === "collection") return v as CollectionView;
  return undefined;
}

/** collection id of a listing entry (`collection:<id>` synthetic entries, or the id of the collection it shows) */
export function listingCollectionId(entry: EntryView): string | undefined {
  if (entry.ccmId.startsWith("collection:")) return entry.ccmId.slice("collection:".length);
  return collectionOf(entry)?.id;
}

/**
 * Rows of a mined Views listing on a crawled path (design instanceProps[path]) win over the collection run when the
 * collection has nothing to show, shows the same entities in the same order (the observed row markup is exact), or
 * yields entries no teaser component can render (a collection definition the adapter could not reproduce).
 * Returns the `extra` binding `{ <listProp>: minedRows }`, or undefined to render the collection's items.
 */
export function minedListingRows(c: { props: PropDef[]; instanceKey?: string; instanceProps?: Record<string, Record<string, unknown>> }, entry: EntryView, ctx: RenderCtx): Record<string, unknown> | undefined {
  const p = c.props.find((x) => x.type === "list" && x.ccmField === "collection");
  if (!p || c.instanceKey !== "path") return undefined;
  const mined = c.instanceProps?.[ctx.path]?.[p.name];
  if (!Array.isArray(mined) || !mined.length) return undefined;
  const items = collectionOf(entry)?.items ?? [];
  const urls = mined.map((m) => (m && typeof m === "object" ? (m as { url?: unknown }).url : undefined));
  const same = items.length >= mined.length && urls.every((u, i) => typeof u === "string" && u === items[i]?.path);
  const unrenderable = !!ctx.canRender && items.some((it) => !ctx.canRender!(it));
  return !items.length || same || unrenderable ? { [p.name]: mined } : undefined;
}

export function entityIdOf(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const e = source as { _kind?: string; ccmId?: string; source?: { id?: string } };
  if (e._kind !== "entry" && e._kind !== "entryStub") return undefined;
  const m = e.source?.id ? /^(?:[a-z_]+\/)?(\d+)$/.exec(e.source.id) : null;
  if (m) return m[1];
  const tail = e.ccmId?.split(":").pop();
  return tail && /^\d+$/.test(tail) ? tail : undefined;
}
export interface RenderCtx {
  locale: string;
  path: string;
  chrome: ChromeData;
  /** render an entry (section/component/document) through the registry */
  renderEntry(e: EntryView): ReactNode;
  /** render a design component by id with a data source (entry / chrome / list item) */
  renderComponent(id: string, source: unknown): ReactNode;
  renderAsset?(a: AssetView, caption?: string): ReactNode;
  /** whether an embedded entry has a design component (teaser/section) — else list items fall back to mined HTML */
  canRender?(e: EntryView): boolean;
}

// ---------------------------------------------------------------- scopes & lookups

export interface Scope {
  v: unknown;
  parent?: Scope;
  index?: number;
  first?: boolean;
  last?: boolean;
  key?: string;
}
export const scope = (v: unknown): Scope => ({ v });

type Kinded = { _kind?: string };
const kindOf = (o: unknown) => (o && typeof o === "object" ? (o as Kinded)._kind : undefined);

/** property access with view-aware aliases (entry fields, link href/label, asset url, …) */
export function prop(obj: unknown, key: string): unknown {
  if (obj == null) return undefined;
  if (Array.isArray(obj)) {
    if (key === "length") return obj.length;
    if (/^\d+$/.test(key)) return obj[Number(key)];
    return undefined;
  }
  if (typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  switch (kindOf(obj)) {
    case "entry": {
      const e = obj as EntryView;
      if (key in e.fields) return e.fields[key];
      if (key === "url" || key === "href") return e.path;
      if (key === "fields") return e.fields;
      if (key === "label" || key === "name") return e.fields.title ?? e.fields.name;
      if (key === "id") return e.ccmId;
      return (e as unknown as Record<string, unknown>)[key];
    }
    case "entryStub": {
      const e = obj as EntryStub;
      if (key === "url" || key === "href") return e.path;
      return (e as unknown as Record<string, unknown>)[key];
    }
    case "asset":
      if (key === "src" || key === "href") return (obj as AssetView).url;
      return o[key];
    case "link":
      if (key === "url" || key === "uri") return (obj as LinkView).href;
      if (key === "text" || key === "title" || key === "name") return o.title && key === "title" ? o.title : (obj as LinkView).label;
      return o[key];
    case "term":
      if (key === "url" || key === "href") return (obj as TermView).path;
      if (key === "label" || key === "title") return (obj as TermView).name;
      return o[key];
    case "collection":
      if (key === "rows" || key === "results" || key === "entries") return (obj as CollectionView).items;
      return o[key];
  }
  if (key in o) return o[key];
  if ("href" in o && (key === "url" || key === "uri")) return o.href;
  if ("label" in o && (key === "title" || key === "text")) return o.label;
  return undefined;
}

export function getPath(obj: unknown, path: string): unknown {
  if (path === "" || path === "this" || path === ".") return obj;
  let cur = obj;
  for (const part of path.split(".")) {
    cur = prop(cur, part);
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** resolve a Handlebars path in a scope chain: this, this.x, ../x, @index, @first, @last, x (falls back to parents) */
export function val(s: Scope, path: string): unknown {
  let p = path.trim();
  let sc: Scope | undefined = s;
  while (p.startsWith("../")) {
    sc = sc?.parent;
    p = p.slice(3);
  }
  if (!sc) return undefined;
  if (p === "@index") return sc.index;
  if (p === "@first") return sc.first;
  if (p === "@last") return sc.last;
  if (p === "@key") return sc.key;
  if (p === "this" || p === ".") return sc.v;
  if (p.startsWith("this.")) return getPath(sc.v, p.slice(5));
  if (p.startsWith("@root.")) {
    let r: Scope = sc;
    while (r.parent) r = r.parent;
    return getPath(r.v, p.slice(6));
  }
  for (let c: Scope | undefined = sc; c; c = c.parent) {
    const v = getPath(c.v, p);
    if (v !== undefined) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------- coercions

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
type DateCfg = { dateLocales?: Record<string, string>; dateFormat?: Intl.DateTimeFormatOptions };

export function formatDate(iso: string, locale: string): string {
  const cfg = dateConfig as DateCfg;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const tag = cfg.dateLocales?.[locale] ?? (locale === "en" ? "en-GB" : locale);
  return new Intl.DateTimeFormat(tag, cfg.dateFormat ?? { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

/** escaped text value of a placeholder (`{{x}}` in text content) */
export function text(v: unknown, ctx?: { locale: string }): string {
  if (v == null || v === false) return "";
  if (typeof v === "string") return ctx && ISO_DATE.test(v) && v.length > 10 ? formatDate(v, ctx.locale) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => text(x, ctx)).filter(Boolean).join(", ");
  const o = v as Record<string, unknown>;
  if (o.type === "doc") return richTextToPlainText(v as RichTextDoc);
  switch (kindOf(v)) {
    case "link":
      return (v as LinkView).label;
    case "asset":
      return (v as AssetView).url;
    case "term":
      return (v as TermView).name;
    case "entry":
      return text((v as EntryView).fields.title ?? (v as EntryView).fields.name ?? "", ctx);
    case "entryStub":
      return (v as EntryStub).title ?? "";
  }
  if (typeof o.label === "string") return o.label;
  if (typeof o.value === "string") return o.value;
  return "";
}

/** attribute value of a placeholder (`attr="{{x}}"`) */
export function attr(v: unknown): string {
  if (v == null || v === false) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  switch (kindOf(v)) {
    case "link":
      return (v as LinkView).href;
    case "asset":
      return (v as AssetView).url;
    case "term":
      return (v as TermView).path ?? "";
    case "entry":
    case "entryStub":
      return (v as EntryView).path ?? "";
  }
  if (typeof (v as { href?: unknown }).href === "string") return (v as { href: string }).href;
  return text(v);
}

/** attribute bag of a compiled element (untyped on purpose: original markup wins over React's DOM prop types) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function p(o: Record<string, unknown>): Record<string, any> {
  return o;
}

/** dynamic style="…" → React style object */
export function style(css: string): Record<string, string> {
  return styleToObject(css);
}

/** {{#each}} inside an attribute value */
export function eachStr(s: Scope, path: string, fn: (item: Scope) => string): string {
  const items = list(val(s, path));
  return items.map((it, i) => fn({ v: it, parent: s, index: i, first: i === 0, last: i === items.length - 1 })).join("");
}

export function cat(...parts: unknown[]): string {
  return parts.map((p) => (typeof p === "string" ? p : attr(p))).join("");
}

export function truthy(v: unknown): boolean {
  if (v == null || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "doc") return Array.isArray(o.children) && o.children.length > 0;
    if (kindOf(v) === "collection") return (v as CollectionView).items.length > 0;
    if (kindOf(v) === "link") return !!(v as LinkView).href || !!(v as LinkView).label;
  }
  return true;
}

export function list(v: unknown): unknown[] {
  if (v == null || v === false) return [];
  if (Array.isArray(v)) return v;
  if (kindOf(v) === "collection") return (v as CollectionView).items;
  if (typeof v === "object" && Array.isArray((v as { items?: unknown }).items)) return (v as { items: unknown[] }).items;
  return [v];
}

export function each(s: Scope, path: string, fn: (item: Scope, i: number) => ReactNode): ReactNode {
  const items = list(val(s, path));
  return items.map((it, i) => <Fragment key={i}>{fn({ v: it, parent: s, index: i, first: i === 0, last: i === items.length - 1 }, i)}</Fragment>);
}

// ---------------------------------------------------------------- {{{ }}} rendering

export function Html({ value, ctx }: { value: unknown; ctx: RenderCtx }): ReactNode {
  if (value == null || value === false || value === "") return null;
  if (isValidElement(value)) return value;
  if (typeof value === "string") return <RawHtml html={value} />;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v, i) => <Html key={i} value={v} ctx={ctx} />);
  const o = value as Record<string, unknown>;
  if (o.type === "doc")
    return <RichText doc={value as RichTextDoc} hooks={{ renderEntry: (e) => ctx.renderEntry(e), renderAsset: ctx.renderAsset }} />;
  switch (kindOf(value)) {
    case "entry":
      return <>{ctx.renderEntry(value as EntryView)}</>;
    case "collection":
      return <>{(value as CollectionView).items.map((e, i) => <Fragment key={i}>{ctx.renderEntry(e)}</Fragment>)}</>;
    case "asset": {
      const a = value as AssetView;
      return <img src={a.url} alt={a.alt} width={a.width} height={a.height} />;
    }
    case "link": {
      const l = value as LinkView;
      return <a href={l.href}>{l.label}</a>;
    }
    case "term": {
      const t = value as TermView;
      return t.path ? <a href={t.path}>{t.name}</a> : t.name;
    }
  }
  if (typeof o.html === "string") return <RawHtml html={o.html} />;
  if (typeof o.value === "string") return <RawHtml html={o.value} />;
  return null;
}

// ---------------------------------------------------------------- prop binding

/** value of a UI string for the page locale (else another site language, else the first value) */
export function pickI18n(m: Record<string, string>, ctx: Pick<RenderCtx, "locale" | "chrome">): string | undefined {
  return m[ctx.locale] ?? m[ctx.chrome.languages.find((l) => l.code !== ctx.locale)?.code ?? ""] ?? Object.values(m)[0];
}
/** `t` scope of a content-type wrapper (design template i18n: `{{t.<key>}}`) */
export function wrapperI18n(i18n: Record<string, Record<string, string>> | undefined, ctx: Pick<RenderCtx, "locale" | "chrome">): Record<string, string> | undefined {
  if (!i18n) return undefined;
  return Object.fromEntries(Object.entries(i18n).map(([k, m]) => [k, pickI18n(m, ctx) ?? ""]));
}

/** Bind a component's declared props to its data source (entry, chrome data, list item). Undeclared fields stay reachable. */
export function bindProps(props: PropDef[], source: unknown, ctx: RenderCtx, extra?: Record<string, unknown>, inst?: InstanceInfo): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (kindOf(source) === "entry") {
    const e = source as EntryView;
    Object.assign(base, { path: e.path, url: e.path, locale: e.locale, slug: e.slug, ccmId: e.ccmId, type: e.type }, e.fields);
  } else if (source && typeof source === "object" && !Array.isArray(source)) Object.assign(base, source);
  const vm: Record<string, unknown> = { ...base, $source: source };
  // mined instance values (design instanceProps) of THIS instance: fallback for props the CCM entry does not carry
  const ikey = inst?.props ? (inst.key === "path" ? ctx.path : entityIdOf(source)) : undefined;
  const ip = ikey !== undefined ? inst!.props![ikey] : undefined;
  // page not crawled: a crawled instance in the same locale (language prefix) beats the canonical default-locale
  // example for values the content cannot provide (menus, UI strings of unbound props)
  const lp = !ip && inst?.key === "path" && inst.props ? sameLocaleInstance(inst.props, ctx) : undefined;
  for (const p of props) {
    let v: unknown;
    let fromInstance = false;
    if (p.i18n) v = pickI18n(p.i18n, ctx);
    else if (p.component) v = ctx.renderComponent(p.component, source);
    else if (p.derive === "ccmIdTail") v = entityIdOf(source) ?? ip?.[p.name];
    else {
      const path = p.ccmField ?? p.name;
      const own = !!ip; // with instance values, don't fall back to page-level chrome data for entity props
      // markup twin of a text field (`<field>Html`: inline markup the theme printed, e.g. <strong>, brush font spans)
      if (p.type === "richText" || p.type === "html") {
        const h = resolveBinding(`${path}Html`, source, ctx, true);
        if (typeof h === "string") v = h;
      }
      // props the design did not map to a CCM field: the mined value of this instance wins over same-named fields
      if (v === undefined && !p.ccmField && ip && p.name in ip) {
        v = ip[p.name];
        fromInstance = true;
      }
      // embedded Views block (related content): the collection run for this page's entry (crawled pages keep the
      // observed rows above)
      if (v === undefined && p.collection && ctx.chrome.collections?.[p.collection]) v = ctx.chrome.collections[p.collection];
      if (v === undefined) v = resolveBinding(path, source, ctx, own);
      if (v === undefined && p.ccmField && p.ccmField !== p.name) v = resolveBinding(p.name, source, ctx, own);
      if (v === undefined && ip && p.name in ip) {
        v = ip[p.name];
        fromInstance = true;
      }
      if (v === undefined && own) v = resolveBinding(path, source, ctx);
      // single-asset prop bound to a multi-value media field: its first asset
      if (p.type === "asset" && Array.isArray(v)) v = v[0];
      // responsive image sources kept next to the asset field (`<field>Sources` = <picture> sources / srcset)
      if (kindOf(v) === "asset" && !(v as Record<string, unknown>).sources) {
        const srcs = resolveBinding(`${path}Sources`, source, ctx, true) as { sources?: unknown } | unknown[] | undefined;
        const list = Array.isArray(srcs) ? srcs : srcs && typeof srcs === "object" ? (srcs as { sources?: unknown }).sources : undefined;
        if (Array.isArray(list)) v = { ...(v as object), sources: list };
      }
      // same entity, partial CCM value (e.g. asset without <picture> sources): missing keys from the mined instance
      if (!fromInstance && ip && v && typeof v === "object" && !Array.isArray(v) && !isValidElement(v)) {
        const iv = ip[p.name];
        if (iv && typeof iv === "object" && !Array.isArray(iv)) {
          const missing = Object.entries(iv as Record<string, unknown>).filter(([k]) => (v as Record<string, unknown>)[k] === undefined);
          if (missing.length) v = { ...(v as object), ...Object.fromEntries(missing) };
        }
      }
      if (v === undefined && !p.ccmField && lp && lp[p.name] !== undefined && (typeof lp[p.name] !== "object" || lp[p.name] === null)) v = lp[p.name];
      if (v === undefined && !p.ccmField && p.example !== undefined) v = p.example;
      // a link the entry does not carry, on an entity no crawled instance exists for: the entry's own URL (teaser
      // "read more" / title links of rows rendered for a collection)
      if (v === undefined && !ip && p.type === "link" && kindOf(source) === "entry" && (source as EntryView).path) {
        const u = (source as EntryView).path!;
        v = { url: u, href: u };
      }
      // site menus the content source could not provide (e.g. Drupal JSON:API without menu_link_content): an empty
      // CCM navigation renders the crawled menu of this page, else the mined example (chrome is site-wide)
      if (p.type === "list" && p.ccmField?.startsWith("navigation.") && Array.isArray(v) && !v.length) {
        const mined = ip?.[p.name] ?? lp?.[p.name] ?? p.example;
        if (Array.isArray(mined) && mined.length) {
          v = mined;
          fromInstance = true;
        }
      }
      if (p.display && !fromInstance) v = displayValue(p.display, v, ctx);
      if (p.format?.kind === "date" && typeof v === "string") v = dateValue(v, p.format, ctx.locale);
      if (p.inline && v && typeof v === "object" && (v as RichTextDoc).type === "doc") v = inlineDoc(v as RichTextDoc, ctx);
      if (p.plainText && v && typeof v === "object" && (v as RichTextDoc).type === "doc") v = richTextToPlainText(v as RichTextDoc);
      if (p.type === "list" && !fromInstance) {
        let items = list(v);
        // link items bound to an item shape like { link: "link", link2: "text" }: the link and its label
        if (p.itemFields) {
          const lk = Object.entries(p.itemFields).find(([, t]) => t === "link")?.[0];
          const tk = Object.entries(p.itemFields).find(([, t]) => t === "text")?.[0];
          if (lk) items = items.map((it) => (kindOf(it) === "link" ? { ...(it as object), [lk]: it, ...(tk ? { [tk]: (it as LinkView).label } : {}) } : it));
        }
        // same entity: item keys the CCM item lacks come from the mined instance item at the same position
        const mined = Array.isArray(ip?.[p.name]) ? (ip![p.name] as unknown[]) : undefined;
        if (mined && mined.length === items.length)
          items = items.map((it, i) => {
            const m = mined[i];
            if (!it || typeof it !== "object" || !m || typeof m !== "object" || kindOf(it) === "entry") return it;
            const missing = Object.entries(m as Record<string, unknown>).filter(([k]) => (it as Record<string, unknown>)[k] === undefined);
            return missing.length ? { ...(it as object), ...Object.fromEntries(missing) } : it;
          });
        if (p.itemComponent) items = items.map((it) => withHtml(it, ctx.renderComponent(p.itemComponent!, it)));
        else if (p.itemFields?.html) {
          const mined = Array.isArray(ip?.[p.name]) ? (ip![p.name] as unknown[]) : undefined;
          items = items.map((it, i) => {
            if (kindOf(it) !== "entry") return it;
            const m = mined?.[i] as { html?: unknown } | undefined;
            if (ctx.canRender && !ctx.canRender(it as EntryView) && m && typeof m.html === "string") return m; // no teaser component: observed markup
            return withHtml(it, ctx.renderEntry(it as EntryView));
          });
        }
        v = items;
      }
    }
    setPath(vm, p.name, v);
  }
  if (extra) for (const [k, v] of Object.entries(extra)) setPath(vm, k, v);
  return vm;
}

/** values of a crawled instance (path-keyed) under the page's language prefix, if the locale has one (not "/") */
export function sameLocaleInstance(props: Record<string, Record<string, unknown>>, ctx: Pick<RenderCtx, "chrome">): Record<string, unknown> | undefined {
  const home = ctx.chrome.homeHref;
  if (!home || home === "/") return undefined;
  const key = Object.keys(props).sort().find((k) => k === home || k.startsWith(home + "/"));
  return key ? props[key] : undefined;
}

/** rich text rendered without its single wrapping <p> (original markup had inline content only) → HTML string */
function inlineDoc(doc: RichTextDoc, ctx: RenderCtx): unknown {
  const blocks = doc.children ?? [];
  if (blocks.length !== 1 || blocks[0].type !== "paragraph") return doc;
  const html = renderToHtml(<RichText doc={doc} hooks={{ renderEntry: (e) => ctx.renderEntry(e), renderAsset: ctx.renderAsset }} />);
  return html.replace(/^<p>/, "").replace(/<\/p>$/, "");
}

function withHtml(item: unknown, html: ReactNode): unknown {
  if (kindOf(item) === "entry") {
    const e = item as EntryView;
    return { ...e, fields: { ...e.fields, html } };
  }
  return item && typeof item === "object" ? { ...(item as object), html } : { value: item, html };
}

function setPath(obj: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (const k of parts.slice(0, -1)) {
    const next = cur[k];
    cur = (cur[k] = next && typeof next === "object" ? { ...(next as object) } : {}) as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = v;
}

/** Drupal-style ISO (2024-05-20T08:00:00+00:00) + formatted string, like the mined `{{x.iso}}` / `{{x.formatted}}` */
export function dateValue(iso: string, fmt: NonNullable<PropDef["format"]>, locale: string): { iso: string; formatted: string; value: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { iso, formatted: iso, value: iso };
  // mined formats only know the locales that were crawled — other locales use the site date locale (same options)
  const tag = fmt.locales[locale] ?? (dateConfig as DateCfg).dateLocales?.[locale] ?? locale;
  // PHP date() pattern (Drupal date formats Intl can't express: "jS F Y" → "25th October 2026")
  const formatted = fmt.pattern ? formatPhpDate(iso, fmt.pattern, tag, fmt.case?.[locale]) : new Intl.DateTimeFormat(tag, { ...fmt.options, timeZone: "UTC" }).format(d);
  return { iso: d.toISOString().replace(/\.\d{3}Z$/, "+00:00"), formatted, value: iso };
}

/** PHP date(pattern) in UTC, month/day names from Intl `tag` (`title` = first letter upper-cased); same as @cmp/design php-date.ts */
export function formatPhpDate(iso: string, pattern: string, tag: string, cs?: "title"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const name = (opt: Intl.DateTimeFormatOptions) => {
    let s: string;
    try {
      s = new Intl.DateTimeFormat(tag, { ...opt, timeZone: "UTC" }).format(d);
    } catch {
      s = new Intl.DateTimeFormat("en", { ...opt, timeZone: "UTC" }).format(d);
    }
    return cs === "title" && s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
  };
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const ord = day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  const map: Record<string, () => string> = {
    d: () => pad(day),
    j: () => String(day),
    S: () => ord,
    D: () => name({ weekday: "short" }),
    l: () => name({ weekday: "long" }),
    F: () => name({ month: "long" }),
    M: () => name({ month: "short" }).replace(/\.$/, ""),
    m: () => pad(d.getUTCMonth() + 1),
    n: () => String(d.getUTCMonth() + 1),
    Y: () => String(d.getUTCFullYear()),
    y: () => String(d.getUTCFullYear()).slice(-2),
    H: () => pad(h),
    G: () => String(h),
    g: () => String(h % 12 || 12),
    h: () => pad(h % 12 || 12),
    i: () => pad(d.getUTCMinutes()),
    s: () => pad(d.getUTCSeconds()),
    a: () => (h < 12 ? "am" : "pm"),
    A: () => (h < 12 ? "AM" : "PM"),
  };
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") out += pattern[++i] ?? "";
    else out += map[ch] ? map[ch]() : ch;
  }
  return out;
}

/** {en: "…", de: "…"} records (settings) → value of the current locale */
function localize(v: unknown, ctx: RenderCtx): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v) || kindOf(v)) return v;
  const keys = Object.keys(v);
  const codes = ctx.chrome.languages.map((l) => l.code);
  if (!keys.length || !keys.every((k) => codes.includes(k))) return v;
  const rec = v as Record<string, unknown>;
  return rec[ctx.locale] ?? rec[codes[0]] ?? rec[keys[0]];
}

export function resolveBinding(path: string, source: unknown, ctx: RenderCtx, sourceOnly = false): unknown {
  return localize(resolveRaw(path, source, ctx, sourceOnly), ctx);
}

function resolveRaw(path: string, source: unknown, ctx: RenderCtx, sourceOnly = false): unknown {
  const p = path.replace(/^fields\./, "");
  const chrome = ctx.chrome;
  const m = /^(settings|site|siteSettings)\.(.+)$/.exec(p);
  if (m) return getPath(chrome.site, m[2]) ?? getPath(chrome, m[2]);
  const nav = /^(navigation|nav|menu)[.:]([\w-]+)(?:\.(.+))?$/.exec(p);
  if (nav) {
    const items = chrome.nav[nav[2]] ?? [];
    return nav[3] ? getPath(items, nav[3]) : items;
  }
  if (p === "route.home" || p === "homeUrl") return chrome.homeHref;
  if (p === "route.path" || p === "route.url") return chrome.path;
  if (p === "translations" || p === "languages") return chrome.languages;
  if (p.startsWith("entry.")) return getPath(chrome.entry, p.slice(6));
  if (p.startsWith("chrome.")) return getPath(chrome, p.slice(7));
  const fromSource = getPath(source, p);
  if (fromSource !== undefined || sourceOnly) return fromSource;
  return getPath(chrome, p);
}

// ---------------------------------------------------------------- runtime string renderer (fallback for templates not compilable to JSX)

type TNode = { t: "text"; v: string } | { t: "var"; path: string; raw: boolean } | { t: "each"; path: string; body: TNode[] } | { t: "if"; path: string; body: TNode[]; else: TNode[] };
const TOKEN = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#/]?)(each|if|else)?\s*([^}]*?)\s*\}\}/g;
const escapeHtml = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseTpl(src: string): TNode[] {
  const root: TNode[] = [];
  const stack: { node: TNode | null; list: TNode[] }[] = [{ node: null, list: root }];
  let last = 0;
  const top = () => stack[stack.length - 1];
  for (const m of src.matchAll(TOKEN)) {
    if (m.index! > last) top().list.push({ t: "text", v: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      top().list.push({ t: "var", path: m[1].trim(), raw: true });
      continue;
    }
    const [, , sigil, kw, rest] = m;
    if (sigil === "#" && (kw === "each" || kw === "if")) {
      const node: TNode = kw === "each" ? { t: "each", path: rest.trim(), body: [] } : { t: "if", path: rest.trim(), body: [], else: [] };
      top().list.push(node);
      stack.push({ node, list: node.body });
    } else if (sigil === "/" && stack.length > 1) stack.pop();
    else if (!sigil && kw === "else" && top().node?.t === "if") top().list = (top().node as { else: TNode[] }).else;
    else top().list.push({ t: "var", path: `${kw ?? ""}${kw && rest ? " " : ""}${rest}`.trim(), raw: false });
  }
  if (last < src.length) top().list.push({ t: "text", v: src.slice(last) });
  return root;
}

function runTpl(nodes: TNode[], s: Scope, ctx: RenderCtx): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") {
      const v = val(s, n.path);
      out += n.raw ? (typeof v === "string" ? v : "") : escapeHtml(text(v, ctx));
    } else if (n.t === "if") out += truthy(val(s, n.path)) ? runTpl(n.body, s, ctx) : runTpl(n.else, s, ctx);
    else {
      const items = list(val(s, n.path));
      items.forEach((it, i) => (out += runTpl(n.body, { v: it, parent: s, index: i, first: i === 0, last: i === items.length - 1 }, ctx)));
    }
  }
  return out;
}

export function TemplateString({ template, vm, ctx }: { template: string; vm: Scope; ctx: RenderCtx }): ReactNode {
  return <>{nodesToReact(parseHtml(runTpl(parseTpl(template), vm, ctx)))}</>;
}

/** registry entry component for a design template rendered by the string renderer (static render mode registries) */
export function templateComponent(template: string): (p: { vm: Scope; ctx: RenderCtx }) => ReactNode {
  return function TemplateComponent({ vm, ctx }: { vm: Scope; ctx: RenderCtx }) {
    return <TemplateString template={template} vm={vm} ctx={ctx} />;
  };
}
