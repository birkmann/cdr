/**
 * Page assembly: entry + design template (src/generated/registry) → React tree.
 * Without a design output every content type falls back to the plain components in src/components/fallback.
 */
import { Fragment, type ReactNode } from "react";
import { components, byType, templates, layout, views, type ComponentEntry, type TemplateDef } from "../../generated/registry";
import type { Store } from "../data/store";
import type { EntryView, NavItemView } from "../data/types";
import { Fallback } from "../../components/fallback";
import { bindProps, listingCollectionId, minedListingRows, scope, wrapperI18n, type ChromeData, type LanguageLink, type NavItemState, type RenderCtx } from "./runtime";

export async function buildChrome(data: Store, entry: EntryView | null, locale: string, path: string): Promise<ChromeData> {
  const site = await data.getSettings(locale);
  const navIds = new Set(["main", "footer", ...data.bundle.navigation.map((n) => n.id)]);
  const nav: Record<string, NavItemState[]> = {};
  for (const id of navIds) nav[id] = markActive(await data.getNavigation(id, locale), path);
  const locales = await data.getLocales();
  const alternates = entry ? await data.getAlternates(entry.ccmId) : [];
  const languages: LanguageLink[] = locales.map((l) => {
    const alt = alternates.find((a) => a.locale === l.code);
    const home = data.startPath(l.code);
    return { code: l.code, locale: l.code, name: l.name, label: l.name, hreflang: l.code, href: alt?.path ?? home, active: l.code === locale, translated: !!alt };
  });
  const title = entry ? String(entry.fields.title ?? entry.fields.name ?? "") : "";
  // embedded listings (Views blocks inside a node, e.g. related recipes): run with this entry as the context
  const collections: Record<string, EntryView[]> = {};
  if (entry && !entry.ccmId.startsWith("collection:")) for (const id of embeddedCollectionIds()) collections[id] = await data.runCollection(id, locale, { current: entry.ccmId });
  return {
    ...(Object.keys(collections).length ? { collections } : {}),
    site,
    siteName: site.siteName,
    slogan: site.slogan,
    logo: site.logo,
    footerText: site.footerText,
    homeHref: data.startPath(locale),
    nav,
    languages,
    locale,
    path,
    entry,
    title,
  };
}

let embedded: string[] | undefined;
/** collection ids that design components embed (list props with `collection`) */
function embeddedCollectionIds(): string[] {
  return (embedded ??= [...new Set(Object.values(components).flatMap((c) => c.props.map((p) => p.collection).filter((x): x is string => !!x)))].sort());
}

function markActive(items: NavItemView[], path: string): NavItemState[] {
  return items.map((it) => {
    const children = markActive(it.children, path);
    const active = it.href === path;
    return { ...it, children, active, activeTrail: active || children.some((c) => c.activeTrail), hasChildren: children.length > 0 };
  });
}

function componentForType(type: string): ComponentEntry | undefined {
  const id = byType[type];
  return id ? components[id] : undefined;
}

/** nav/language components iterate `items` — give each chrome component the list it is about */
function chromeSource(id: string, chrome: ChromeData): Record<string, unknown> {
  const lid = id.toLowerCase();
  let items: unknown = chrome.nav.main ?? [];
  if (/lang/.test(lid)) items = chrome.languages;
  else if (/footer/.test(lid) && /(nav|menu)/.test(lid)) items = chrome.nav.footer ?? [];
  else if (/footer/.test(lid)) items = chrome.nav.footer ?? [];
  return { ...chrome, items, links: items, menu: items, mainNav: chrome.nav.main ?? [], footerNav: chrome.nav.footer ?? [] };
}

export function makeCtx(chrome: ChromeData): RenderCtx {
  const ctx: RenderCtx = {
    locale: chrome.locale,
    path: chrome.path,
    chrome,
    renderEntry(e: EntryView): ReactNode {
      const c = componentForType(e.type);
      if (c) return <c.Component vm={scope(bindProps(c.props, e, ctx))} ctx={ctx} />;
      return <Fallback.Entry entry={e} ctx={ctx} />;
    },
    renderComponent(id: string, source: unknown): ReactNode {
      const c = components[id];
      if (!c) return null;
      const src = c.kind === "chrome" ? chromeSource(id, chrome) : source;
      return <c.Component vm={scope(bindProps(c.props, src, ctx))} ctx={ctx} />;
    },
  };
  const media = Object.values(components).find((c) => c.ccmType === "asset" || /^(media|mediaImage|embeddedAsset|embeddedMedia)$/i.test(c.id));
  if (media) ctx.renderAsset = (a, caption) => <media.Component vm={scope(bindProps(media.props, { ...a, image: a, caption }, ctx))} ctx={ctx} />;
  return ctx;
}

export function templateFor(type: string): TemplateDef | undefined {
  return templates[type] ?? templates["*"];
}

/** template of an entry: its type's, else — for a document showing a collection (Views page as a document) — the listing template */
export function templateForEntry(entry: EntryView): TemplateDef | undefined {
  return templates[entry.type] ?? (templates.collection && listingCollectionId(entry) ? templates.collection : undefined) ?? templates["*"];
}

/**
 * Synthetic listing pages (`collection:<id>`) take their title from Collection.name, which is one string for every
 * locale. On a crawled listing page the mined title (a title-bound slot's instance value for this path, e.g. "Recetas"
 * on /es/recipes) is the real one: it wins, so the h1 and the breadcrumb ({{title}}) show the page's own language.
 */
export function withCrawledListingTitle(entry: EntryView, path: string): EntryView {
  if (!entry.ccmId?.startsWith("collection:")) return entry;
  // any path-keyed component with a text prop bound to `title` (the type's or the page's own pageTitle slot)
  for (const c of Object.values(components)) {
    if (c.instanceKey !== "path" || !c.instanceProps?.[path]) continue;
    const p = c.props.find((x) => x.ccmField === "title" && x.type === "text");
    const v = p ? c.instanceProps[path][p.name] : undefined;
    if (typeof v === "string" && v.trim() && v !== entry.fields.title) return { ...entry, fields: { ...entry.fields, title: v } };
  }
  return entry;
}

/** Drupal body classes depend on the route (front page vs node) — keep the template's classes but fix those tokens. */
export function bodyClassFor(entry: EntryView, isFront: boolean): string | undefined {
  const t = templateForEntry(entry);
  if (!t?.bodyClass) return undefined;
  return t.bodyClass
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => (c === "path-frontpage" || c === "path-node" ? (isFront ? "path-frontpage" : entry.type === "taxonomyTerm" ? "path-taxonomy" : "path-node") : c))
    .join(" ");
}

function renderSlot(slot: TemplateDef["slots"][number], entry: EntryView, ctx: RenderCtx, key: number): ReactNode {
  const extra = slot.props;
  if (slot.component === "$collection") {
    // listing pages (collection / taxonomy term): the view component of that Drupal view, else teasers via the registry
    const cid = listingCollectionId(entry);
    const viewId = cid ? views[cid] : undefined;
    const vc = viewId ? components[viewId] : undefined;
    if (vc) return <vc.Component key={key} vm={scope(bindProps(vc.props, entry, ctx, { ...(extra ?? {}), ...(minedListingRows(vc, entry, ctx) ?? {}) }))} ctx={ctx} />;
    const items = (entry.fields.items as EntryView[] | undefined) ?? [];
    return <Fragment key={key}>{items.map((it, j) => <Fragment key={j}>{ctx.renderEntry(it)}</Fragment>)}</Fragment>;
  }
  const comp = components[slot.component];
  if (slot.field) {
    const v = entry.fields[slot.field];
    if (slot.repeat || Array.isArray(v)) {
      const items = Array.isArray(v) ? v : v == null ? [] : [v];
      return (
        <Fragment key={key}>
          {items.map((it, j) => {
            const e = it as EntryView;
            const c = (e && e._kind === "entry" ? componentForType(e.type) : undefined) ?? comp;
            return <Fragment key={j}>{c ? <c.Component vm={scope(bindProps(c.props, it, ctx, extra))} ctx={ctx} /> : e?._kind === "entry" ? ctx.renderEntry(e) : null}</Fragment>;
          })}
        </Fragment>
      );
    }
    if (!comp) return null;
    const src = v && typeof v === "object" && (v as EntryView)._kind === "entry" ? v : entry;
    return <comp.Component key={key} vm={scope(bindProps(comp.props, src, ctx, extra))} ctx={ctx} />;
  }
  if (!comp) return null;
  if (comp.kind === "chrome") return <Fragment key={key}>{ctx.renderComponent(slot.component, entry)}</Fragment>;
  return <comp.Component key={key} vm={scope(bindProps(comp.props, entry, ctx, extra))} ctx={ctx} />;
}

/** The <body> content of a page: layout(chrome + main) → wrapper(regions) → slots. */
export function PageBody({ entry: entry0, ctx }: { entry: EntryView; ctx: RenderCtx }): ReactNode {
  const entry = withCrawledListingTitle(entry0, ctx.chrome.path);
  const t = templateForEntry(entry);
  if (!t) return <Fallback.Page entry={entry} ctx={ctx} />;
  const regions: Record<string, ReactNode[]> = {};
  t.slots.forEach((slot, i) => {
    const r = slot.region ?? "content";
    (regions[r] ??= []).push(renderSlot(slot, entry, ctx, i));
  });
  const regionEls = Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, <>{v}</>]));
  const content = <>{Object.values(regions).flat()}</>;
  const main = t.Wrapper ? (
    <t.Wrapper vm={scope({ ...ctx.chrome, ...entry.fields, regions: regionEls, content, slots: content, ...(t.i18n ? { t: wrapperI18n(t.i18n, ctx) } : {}) })} ctx={ctx} />
  ) : (
    content
  );
  const chromeIds = [...new Set([...(layout?.chrome ?? []), ...t.chrome])];
  const chromeEls: Record<string, ReactNode> = {};
  for (const id of chromeIds) chromeEls[id] = ctx.renderComponent(id, entry);
  if (layout) {
    const L = layout.Component;
    return <L vm={scope(bindProps(layout.props, { ...ctx.chrome, chrome: chromeEls, main }, ctx))} ctx={ctx} />;
  }
  const before = t.chrome.filter((id) => !/footer|cookie/i.test(id));
  const after = t.chrome.filter((id) => /footer|cookie/i.test(id));
  return (
    <>
      {before.map((id) => (
        <Fragment key={id}>{chromeEls[id]}</Fragment>
      ))}
      {main}
      {after.map((id) => (
        <Fragment key={id}>{chromeEls[id]}</Fragment>
      ))}
    </>
  );
}
