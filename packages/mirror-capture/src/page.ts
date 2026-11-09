/**
 * Parse a rendered page into a CMS-neutral PageInfo (meta/SEO, menus, branding, scripts, Drupal hints).
 * Drupal/Olivero markup is recognised when present; custom Drupal themes (e.g. nestle.com's `da_vinci_code`:
 * menus as `ul.menu-level-N` with mega-menu content, `drupalSettings` instead of `data-history-node-id`, block
 * content with paragraphs in header/footer) are handled too; everything has a generic fallback.
 */
import type { SeoMeta } from "@harness/mirror-core";
import { toCamelCase, toPascalCase } from "@harness/mirror-transforms";
import { attr, classes, childElements, matches as selectMatchesRaw, parseDocument, pathOf, select, selectAll, text, toHtml, walk, type Element, type Root } from "./dom.js";

export interface MenuItemInfo {
  label: string;
  href: string; // as authored (path or absolute)
  path?: string; // same-origin path
  active: boolean;
  systemPath?: string; // data-drupal-link-system-path
  children: MenuItemInfo[];
  /** mega-menu / menu_link_content extras (featured image, text, "Go to" link, icon, link classes) */
  extra?: MenuItemExtra;
}

export interface MenuItemExtra {
  image?: Element;
  icon?: Element;
  textHtml?: string;
  goto?: { label: string; href: string };
  linkClasses?: string[];
  heading?: boolean; // group heading without a link (e.g. global country selector regions)
}

export interface MenuInfo {
  id: string;
  title?: string;
  /** text of the menu block outside the list and title (e.g. "You are currently on the Nestlé global website") */
  description?: string;
  region?: string;
  items: MenuItemInfo[];
}

export interface ScriptInfo {
  src?: string;
  inline?: string;
  type?: string;
  placement: "head" | "body";
  thirdParty: boolean;
  async: boolean;
}

export interface BlockInfo {
  /** html id without the `block-` prefix and the `--N` instance suffix */
  id: string;
  region?: string;
  title?: string;
  el: Element;
  /** contains paragraphs (entity_reference_revisions) → modelled as a CCM entry */
  hasComponents: boolean;
}

/** other placed blocks in header/footer (dark-mode switch, share price, social share, follow us): chrome, kept as HTML */
export interface ChromeBlockInfo {
  id: string;
  region?: string;
  el: Element;
}

export interface SocialLinkInfo {
  platform: string;
  href: string;
  links: { label: string; href: string }[];
}

export interface PageInfo {
  path: string;
  lang?: string;
  title?: string;
  bodyClasses: string[];
  meta: SeoMeta;
  /** "node:<bundle>" | "view:<id>.<display>" | "taxonomy_term" | "front" | "generic" */
  template: string;
  drupal: {
    nodeType?: string;
    nid?: number;
    isFront: boolean;
    termId?: number;
    views: { id: string; display: string }[];
    theme?: string;
    /** js-view-dom-id hash -> view (from drupalSettings.views.ajaxViews) */
    viewDomIds: Record<string, { id: string; display: string }>;
  };
  pageTitle?: string;
  /** inner HTML of the page title when it carries inline markup (<i>, <em>, <span class>) */
  pageTitleHtml?: string;
  siteName?: string;
  slogan?: string;
  logo?: { src: string; alt: string; width?: number; height?: number; href?: string };
  footerText?: string;
  menus: Record<string, MenuItemInfo[]>;
  /** menus with titles + regions (same items as `menus`) */
  menuInfo: MenuInfo[];
  languageLinks: { locale: string; label: string; href: string; path?: string; active: boolean }[];
  scripts: ScriptInfo[];
  stylesheets: string[];
  images: { src: string; path?: string; alt: string; width?: number; height?: number; inMain: boolean }[];
  blocks: BlockInfo[];
  chromeBlocks: ChromeBlockInfo[];
  social: SocialLinkInfo[];
  skipLink?: { label: string; href: string };
  tree: Root;
  main?: Element;
}

const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

/** Drupal machine name from a class fragment: "landing-page" -> "landing_page". */
export function machineName(cls: string): string {
  return cls.replace(/-/g, "_");
}
/** CCM type id for a Drupal node bundle (workplan naming): landing_page -> landingPage. */
export function bundleToType(bundle: string): string {
  return toCamelCase(bundle);
}
/** CCM type id for a paragraph type: teaser_list -> sectionTeaserList. */
export function paragraphToType(ptype: string): string {
  return `section${toPascalCase(ptype)}`;
}
/** CCM field id from a Drupal field class: "field-foo-bar" -> "fooBar", "body" -> "body". */
export function fieldNameToId(name: string): string {
  return toCamelCase(name.replace(/^field[-_]/, "").replace(/-/g, "_"));
}

export function mainContentRoot(tree: Root): Element | undefined {
  return (
    select(".block-system-main-block", tree) ??
    select("main [role=main], [role=main]", tree) ??
    select("main", tree) ??
    select("#content, #main, .main-content", tree) ??
    undefined
  );
}

// ------------------------------------------------------------------ tree normalisation

/** Cloudflare email obfuscation: first byte is the XOR key for the rest. */
export function decodeCfEmail(hex: string): string | undefined {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return undefined;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}

const isDataUri = (s: string | undefined) => !s || s.startsWith("data:");

/**
 * Make the server HTML render-independent before extraction (mutates the tree):
 *  - Cloudflare email protection (`/cdn-cgi/l/email-protection#hex`, `span.__cf_email__`) -> plain mailto/text
 *    (what the browser shows after Cloudflare's decoder ran)
 *  - lazy images (blazy `data-src`, `data-srcset`) -> real `src`/`srcset` (placeholders are data: URIs)
 */
export function normalizeTree(tree: Root | Element): void {
  const rec = (parent: Root | Element) => {
    parent.children = parent.children.map((c) => {
      if (c.type !== "element") return c;
      const el = c;
      if (classes(el).includes("__cf_email__") && attr(el, "dataCfemail")) {
        const mail = decodeCfEmail(attr(el, "dataCfemail")!);
        if (mail && el.tagName !== "a") return { type: "text", value: mail };
        if (mail) {
          el.properties.href = `mailto:${mail}`;
          el.children = [{ type: "text", value: mail }];
        }
      }
      if (el.tagName === "a") {
        const m = /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)$/i.exec(attr(el, "href") ?? "");
        const mail = m ? decodeCfEmail(m[1]) : undefined;
        if (mail) el.properties.href = `mailto:${mail}`;
      }
      if (el.tagName === "img" || el.tagName === "source") {
        const ds = attr(el, "dataSrc");
        if (ds && el.tagName === "img" && isDataUri(attr(el, "src"))) el.properties.src = ds;
        const dss = attr(el, "dataSrcset");
        if (dss && !attr(el, "srcSet")) el.properties.srcSet = dss;
      }
      rec(el);
      return el;
    }) as typeof parent.children;
  };
  rec(tree);
}

// ------------------------------------------------------------------ menus

/** Closest `.region-<name>` / `.region--<name>` ancestor name. */
function regionOf(el: Element, parents: Map<Element, Element>): string | undefined {
  let p: Element | undefined = el;
  while (p) {
    const r = classes(p).find((c) => /^region-{1,2}[a-z]/.test(c) && c !== "region");
    if (r) return r.replace(/^region-{1,2}/, "");
    p = parents.get(p);
  }
  return undefined;
}

function elementParents(tree: Root): Map<Element, Element> {
  const m = new Map<Element, Element>();
  walk(tree, (el, anc) => {
    if (anc.length) m.set(el, anc[anc.length - 1]);
  });
  return m;
}

/** Descendants matching `pred` whose nearest `stop` ancestor (below `root`) is `root` itself. */
function ownDescendants(root: Element, pred: (e: Element) => boolean, stop: (e: Element) => boolean): Element[] {
  const out: Element[] = [];
  walk(root, (el) => {
    if (pred(el)) {
      out.push(el);
      return false;
    }
    return !stop(el);
  });
  return out;
}

function menuItemExtra(li: Element, a: Element | undefined): MenuItemExtra | undefined {
  const x: MenuItemExtra = {};
  // menu_link_content of THIS item: first own dropdown container (not inside a nested list)
  const box = ownDescendants(li, (e) => classes(e).includes("menu_link_content") || classes(e).includes("menu-dropdown"), (e) => e.tagName === "ul" || e.tagName === "li")[0];
  const inBox = (sel: string): Element | undefined => {
    if (!box) return undefined;
    const nested = new Set<Element>();
    for (const ul of selectAll("ul", box)) for (const d of selectAll("*", ul)) nested.add(d);
    return selectAll(sel, box).find((e) => !nested.has(e));
  };
  const img = inBox(".field--name-field-menu-featured-image img, .main-menu-content__image img");
  if (img) x.image = img;
  const icon = (a ? select(".field--name-field-inside-menu-icon img", a) : undefined) ?? inBox(".field--name-field-inside-menu-icon img");
  if (icon) x.icon = icon;
  const body = inBox(".field--name-field-menu, .main-menu-content__body");
  if (body && text(body)) x.textHtml = innerHtmlOf(classes(body).includes("field--item") ? body : (select(".field--item", body) ?? body));
  const goto = inBox(".field--name-field-goto-link a");
  if (goto) x.goto = { label: text(goto), href: attr(goto, "href") ?? "" };
  const lc = classes(a).filter((c) => !/^(is-active|active)$/.test(c));
  if (lc.length) x.linkClasses = lc;
  return Object.keys(x).length ? x : undefined;
}

function selectMatches(el: Element, sel: string): boolean {
  try {
    return selectMatchesRaw(sel, el);
  } catch {
    return false;
  }
}
function innerHtmlOf(el: Element): string {
  return toHtml({ type: "root", children: el.children } as Root).trim();
}

function parseMenu(ul: Element | undefined, base: string): MenuItemInfo[] {
  if (!ul) return [];
  return childElements(ul)
    .filter((li) => li.tagName === "li")
    .map((li) => {
      const a = childElements(li).find((c) => c.tagName === "a") ?? ownDescendants(li, (e) => e.tagName === "a", (e) => e.tagName === "ul" || e.tagName === "li")[0];
      const heading = !a ? childElements(li).find((c) => /^(h[1-6]|span|strong)$/.test(c.tagName)) : undefined;
      const sub = childElements(li).find((c) => c.tagName === "ul") ?? ownDescendants(li, (e) => e.tagName === "ul", (e) => e.tagName === "li")[0];
      const href = attr(a, "href") ?? "";
      const titleEl = a ? select(".inside-menu-title", a) : undefined;
      const extra = menuItemExtra(li, a);
      const item: MenuItemInfo = {
        label: titleEl ? text(titleEl) : a ? text(a) : text(heading),
        href,
        path: href ? pathOf(href, base) : undefined,
        active: classes(a).includes("is-active") || attr(a, "ariaCurrent") === "page",
        systemPath: attr(a, "dataDrupalLinkSystemPath"),
        children: parseMenu(sub, base),
      };
      if (!a && heading) item.extra = { ...(extra ?? {}), heading: true };
      else if (extra) item.extra = extra;
      return item;
    })
    .filter((m) => m.label || m.href || m.children.length);
}

/** Menu machine name of a <nav>: `menu--x` class (nav or ul), `menu-link-content<x>` class, or the block id. */
function menuIdOf(nav: Element, ul: Element): string | undefined {
  const byClass = [nav, ul].flatMap((e) => classes(e)).find((c) => c.startsWith("menu--"));
  if (byClass) return byClass.slice(6);
  const mlc = select("[class*='menu-link-content']", ul);
  const c = classes(mlc).find((x) => x.startsWith("menu-link-content") && x.length > "menu-link-content".length);
  if (c) return c.slice("menu-link-content".length);
  const id = attr(nav, "id");
  if (id && classes(ul).includes("menu")) return id.replace(/^block-/, "").replace(/--\d+$/, "").replace(/-\d+$/, "");
  return undefined;
}

// ------------------------------------------------------------------ drupalSettings

interface DrupalSettings {
  path?: { currentPath?: string; isFront?: boolean; currentLanguage?: string };
  ajaxPageState?: { theme?: string };
  views?: { ajaxViews?: Record<string, { view_name?: string; view_display_id?: string; view_dom_id?: string }> };
  ln_datalayer?: { data?: { content_id?: string; content_type?: string } };
}

function drupalSettingsOf(tree: Root): DrupalSettings | undefined {
  const s = select("script[data-drupal-selector=drupal-settings-json]", tree);
  if (!s) return undefined;
  try {
    return JSON.parse(s.children.map((c) => ("value" in c ? String(c.value) : "")).join("")) as DrupalSettings;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ main

export function parsePage(html: string, path: string, baseUrl: string): PageInfo {
  const tree = parseDocument(html);
  normalizeTree(tree);
  const base = baseUrl.replace(/\/+$/, "");
  const html_ = select("html", tree);
  const body = select("body", tree);
  const bodyClasses = classes(body);
  const metaName = (n: string) => attr(select(`meta[name="${n}"]`, tree), "content");
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  for (const m of selectAll("meta[property^='og:'], meta[property^='article:'], meta[property^='fb:']", tree)) og[attr(m, "property")!] = attr(m, "content") ?? "";
  for (const m of selectAll("meta[name^='twitter:']", tree)) twitter[attr(m, "name")!] = attr(m, "content") ?? "";
  const hreflang = selectAll("link[rel=alternate][hreflang]", tree).map((l) => ({ locale: attr(l, "hrefLang")!, href: attr(l, "href") ?? "" }));
  const structuredData: unknown[] = [];
  for (const s of selectAll("script[type='application/ld+json']", tree)) {
    try {
      structuredData.push(JSON.parse(s.children.map((c) => ("value" in c ? String(c.value) : "")).join("")));
    } catch {
      /* ignore */
    }
  }
  // other named meta tags that matter for SEO (same set verify compares: @cmp/verify html.ts SEO_META_NAMES)
  const SEO_META_NAMES = ["keywords", "news_keywords", "abstract", "google-site-verification", "msvalidate.01"];
  const named: Record<string, string> = {};
  for (const n of SEO_META_NAMES) {
    const v = metaName(n);
    if (v !== undefined) named[n] = v;
  }
  const meta: SeoMeta = {
    title: text(select("head > title", tree)) || undefined,
    description: metaName("description"),
    canonical: attr(select("link[rel=canonical]", tree), "href"),
    robots: metaName("robots"),
    og: Object.keys(og).length ? og : undefined,
    twitter: Object.keys(twitter).length ? twitter : undefined,
    meta: Object.keys(named).length ? named : undefined,
    hreflang: hreflang.length ? hreflang : undefined,
    structuredData: structuredData.length ? structuredData : undefined,
  };
  for (const k of Object.keys(meta) as (keyof SeoMeta)[]) if (meta[k] === undefined) delete meta[k];

  // ---- Drupal hints
  const settings = drupalSettingsOf(tree);
  const nodeTypeCls = bodyClasses.find((c) => c.startsWith("page-node-type-"));
  const nodeType = nodeTypeCls ? machineName(nodeTypeCls.slice("page-node-type-".length)) : settings?.ln_datalayer?.data?.content_type || undefined;
  const main = mainContentRoot(tree);
  const nodeEl = main ? select("article.node[data-history-node-id], .node--view-mode-full", main) : undefined;
  const shortlink = attr(select("link[rel=shortlink]", tree), "href");
  const currentPath = settings?.path?.currentPath;
  const nid =
    num(attr(nodeEl, "dataHistoryNodeId")) ??
    num(/\/node\/(\d+)$/.exec(shortlink ?? "")?.[1]) ??
    num(/^node\/(\d+)$/.exec(currentPath ?? "")?.[1]) ??
    num(settings?.ln_datalayer?.data?.content_id);
  const termId = num(/\/taxonomy\/term\/(\d+)$/.exec(shortlink ?? "")?.[1]) ?? num(/^taxonomy\/term\/(\d+)$/.exec(currentPath ?? "")?.[1]);
  const viewDomIds: Record<string, { id: string; display: string }> = {};
  for (const v of Object.values(settings?.views?.ajaxViews ?? {})) {
    if (v.view_dom_id && v.view_name) viewDomIds[v.view_dom_id] = { id: v.view_name, display: v.view_display_id ?? "default" };
  }
  const views = (main ? selectAll(".view[class*='view-id-']", main) : []).map((v) => {
    const cls = classes(v);
    return { id: cls.find((c) => c.startsWith("view-id-"))!.slice(8), display: cls.find((c) => c.startsWith("view-display-id-"))?.slice(16) ?? "default" };
  });
  // views embedded without view-id classes (viewsreference, custom templates): js-view-dom-id-<hash> + drupalSettings
  for (const el of main ? selectAll("[class*='js-view-dom-id-']", main) : []) {
    const v = viewDomIds[classes(el).find((c) => c.startsWith("js-view-dom-id-"))!.slice(15)];
    if (v && !views.some((x) => x.id === v.id && x.display === v.display)) views.push(v);
  }
  const isFront = bodyClasses.includes("path-frontpage") || settings?.path?.isFront === true;
  let template = "generic";
  if (nodeType) template = `node:${nodeType}`;
  else if (bodyClasses.includes("path-taxonomy") || termId) template = "taxonomy_term";
  else if (views.length) template = `view:${views[0].id}.${views[0].display}`;
  else if (isFront) template = "front";

  // ---- chrome
  const parents = elementParents(tree);
  const header = select("header[role=banner], header.site-header, header.header-wrapper, body header", tree);
  const footer = select("footer.site-footer, footer[role=contentinfo], footer.footer-wrapper, body footer", tree);
  const branding = select(".block-system-branding-block, .site-branding", tree);
  const logoImg = select("a.logo img, a.navbar-brand img, a[rel=home] img", tree) ?? select("img", branding ?? header ?? tree);
  const logoA = logoImg ? parents.get(logoImg) : undefined;
  const logo = logoImg
    ? {
        src: attr(logoImg, "src") ?? "",
        alt: attr(logoImg, "alt") ?? "",
        width: num(attr(logoImg, "width")),
        height: num(attr(logoImg, "height")),
        href: logoA?.tagName === "a" ? attr(logoA, "href") : undefined,
      }
    : undefined;
  const siteName = text(select(".site-branding__name", tree)) || og["og:site_name"] || undefined;
  const slogan = text(select(".site-branding__slogan", tree)) || undefined;

  // menus: every <nav> with a list (not nested in another nav — e.g. persistent submenus repeated in mega menus)
  const menus: Record<string, MenuItemInfo[]> = {};
  const menuInfo: MenuInfo[] = [];
  const navs = selectAll("nav", tree).filter((n) => {
    let p = parents.get(n);
    while (p) {
      if (p.tagName === "nav") return false;
      p = parents.get(p);
    }
    return true;
  });
  for (const nav of navs) {
    const ul = childElements(nav).find((c) => c.tagName === "ul") ?? select("ul", nav);
    if (!ul) continue;
    const id = menuIdOf(nav, ul);
    if (!id || menus[id]) continue;
    const items = parseMenu(ul, base);
    if (!items.length) continue;
    menus[id] = items;
    const titleEl = select("h2, .block-title, .block__title", nav);
    const desc = ownDescendants(nav, (e) => e.tagName === "span" || e.tagName === "p", (e) => e.tagName === "ul" || /^h[1-6]$/.test(e.tagName) || e.tagName === "a")
      .map((e) => text(e))
      .filter(Boolean)
      .join(" ");
    menuInfo.push({ id, title: titleEl ? text(titleEl) || undefined : undefined, ...(desc ? { description: desc } : {}), region: regionOf(nav, parents), items });
  }
  if (!menus.main) {
    const nav = header ? select("nav", header) : select("nav", tree);
    if (nav && select("ul", nav)) {
      menus.main = parseMenu(select("ul", nav), base);
      menuInfo.push({ id: "main", region: regionOf(nav, parents), items: menus.main });
    }
  }
  if (!menus.footer && footer && !menuInfo.some((m) => m.region && /footer/.test(m.region))) {
    const nav = select("nav", footer) ?? footer;
    const ul = select("ul", nav);
    if (ul) {
      menus.footer = parseMenu(ul, base);
      menuInfo.push({ id: "footer", region: "footer", items: menus.footer });
    }
  }

  const switcher = select(".language-switcher-language-url, [class*=language-switcher]", tree);
  const languageLinks = (switcher ? selectAll("a[hreflang]", switcher) : []).map((a) => ({
    locale: attr(a, "hrefLang")!,
    label: text(a),
    href: attr(a, "href") ?? "",
    path: pathOf(attr(a, "href") ?? "", base),
    active: classes(a).includes("is-active"),
  }));

  // block content (custom blocks): with paragraphs → CCM entries; plain body blocks → settings
  const blocks: BlockInfo[] = [];
  const seenBlocks = new Set<string>();
  for (const b of selectAll("[class*='block-block-content']", tree)) {
    const rawId = attr(b, "id") ?? "";
    const id = rawId.replace(/^block-/, "").replace(/--\d+$/, "") || classes(b).find((c) => c.startsWith("block-block-content") && c.length > 20)?.slice(19) || "";
    if (!id || seenBlocks.has(id)) continue;
    seenBlocks.add(id);
    const titleEl = childElements(b).find((c) => /^h[1-6]$/.test(c.tagName) || classes(c).includes("block-title"));
    blocks.push({
      id,
      region: regionOf(b, parents),
      title: titleEl ? text(titleEl) || undefined : undefined,
      el: b,
      hasComponents: !!select(".paragraph, [id^='section-']", b),
    });
  }

  const chromeBlocks: ChromeBlockInfo[] = [];
  const chromeIds = new Set<string>();
  for (const root of [header, footer].filter((x): x is Element => !!x)) {
    walk(root, (el) => {
      const id = attr(el, "id") ?? "";
      if (el.tagName === "nav" || classes(el).some((c) => c.startsWith("block-block-content"))) return false;
      if (/^block-/.test(id) && el.tagName !== "nav") {
        const key = id.replace(/^block-/, "").replace(/--\d+$/, "");
        if (!chromeIds.has(key) && text(el)) {
          chromeIds.add(key);
          chromeBlocks.push({ id: key, region: regionOf(el, parents), el });
        }
        return false;
      }
      return true;
    });
  }
  for (const sec of selectAll("main section.block[id^='block-']", tree)) {
    const key = attr(sec, "id")!.replace(/^block-/, "").replace(/--\d+$/, "");
    if (!chromeIds.has(key) && !classes(sec).some((c) => c.startsWith("block-block-content")) && text(sec)) {
      chromeIds.add(key);
      chromeBlocks.push({ id: key, region: regionOf(sec, parents), el: sec });
    }
  }
  const skipA = select("a.skip-link, a[href='#main-content']", tree);
  const skipLink = skipA && text(skipA) ? { label: text(skipA), href: attr(skipA, "href") ?? "#main-content" } : undefined;

  let footerText: string | undefined;
  if (footer) {
    const bottom =
      select(".region--footer-bottom", footer) ??
      selectAll("[class*=block-block-content]", footer)
        .filter((b) => !select(".paragraph, [id^='section-']", b))
        .map((b) => select(".field--name-body", b) ?? b)[0];
    footerText = text(bottom) || undefined;
    if (!footerText) {
      const ps = selectAll("p", footer).map((p) => text(p)).filter(Boolean);
      footerText = ps.join(" ") || undefined;
    }
  }

  const social: SocialLinkInfo[] = [];
  for (const w of selectAll(".social-main-wrapper .social-platform-wrapper, .social-links-wrapper .social-platform-wrapper", footer ?? tree)) {
    const icon = select("a.social-icon", w) ?? select("a", w);
    const platform = classes(select("[class*='social-platforms--']", w)).find((c) => c.startsWith("social-platforms--"))?.slice(18) ?? "";
    social.push({
      platform,
      href: attr(icon, "href") ?? "",
      links: selectAll(".social-links a", w).map((a) => ({ label: text(a), href: attr(a, "href") ?? "" })),
    });
  }

  const scripts: ScriptInfo[] = [];
  const head = select("head", tree);
  const headScripts = new Set(head ? selectAll("script", head) : []);
  for (const s of selectAll("script", tree)) {
    const type = attr(s, "type");
    if (type === "application/json" || type === "application/ld+json") continue;
    const src = attr(s, "src");
    scripts.push({
      src,
      inline: src ? undefined : s.children.map((c) => ("value" in c ? String(c.value) : "")).join("").trim() || undefined,
      type,
      placement: headScripts.has(s) ? "head" : "body",
      thirdParty: !!src && (pathOf(src, base) === undefined || pathOf(src, base)!.startsWith("/__ext/")),
      async: s.properties?.async === true || attr(s, "async") !== undefined,
    });
  }
  const stylesheets = selectAll("link[rel=stylesheet]", tree).map((l) => attr(l, "href")!).filter(Boolean);
  const mainImgs = new Set(main ? selectAll("img", main) : []);
  const images = selectAll("img", tree).map((img) => ({
    src: attr(img, "src") ?? "",
    path: pathOf(attr(img, "src") ?? "", base),
    alt: attr(img, "alt") ?? "",
    width: num(attr(img, "width")),
    height: num(attr(img, "height")),
    inMain: mainImgs.has(img),
  }));
  const titleEl = select(".block-page-title-block h1, h1.page-title", tree) ?? select("h1", main ?? tree);
  const pageTitle = text(titleEl) || undefined;
  const pageTitleHtml = titleEl && childElements(titleEl).length ? innerHtmlOf(titleEl) : undefined;

  return {
    path,
    lang: attr(html_, "lang"),
    title: meta.title,
    bodyClasses,
    meta,
    template,
    drupal: { nodeType, nid, isFront, termId, views, theme: settings?.ajaxPageState?.theme, viewDomIds },
    pageTitle,
    pageTitleHtml,
    siteName,
    slogan,
    logo,
    footerText,
    menus,
    menuInfo,
    languageLinks,
    scripts,
    stylesheets,
    images,
    blocks,
    chromeBlocks,
    social,
    skipLink,
    tree,
    main,
  };
}
