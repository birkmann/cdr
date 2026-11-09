/**
 * HTML fast path (MIGRATION_PLAN.md §12 Phase 1a): crawled pages -> CCM, no CMS access needed.
 *
 * - Content is extracted from the RAW server HTML (deterministic, before jQuery/slick/blazy touched the DOM: no
 *   cloned slides, no injected widgets); the rendered DOM is the fallback when no raw HTML was captured.
 * - Drupal markup (node--type-*, paragraph--type--*, field--name-*, field--type-*) is mapped to the SAME CCM type and
 *   field ids the Drupal adapter produces (landing_page -> landingPage, hero -> sectionHero, field_foo -> foo).
 * - Custom themes print many values outside field wrappers; paragraph profiles (profiles.ts) map those "slots" to
 *   typed fields. Whatever text is still not covered keeps the section's outer HTML in an `html` field (never dropped).
 * - Pages without Drupal markup become `page` entries with `sectionGeneric` sections inferred from the DOM.
 * - Translations are paired via hreflang / language switcher and share a ccmId (`html:page:<default-locale path>`).
 * - Teasers of pages that were not crawled become partial entries (title, image, date, path) so listings work.
 * - Block content with paragraphs (mini footer, sign-up banners) -> `blockContent` entries + `settings.extra.blocks`.
 */
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import {
  Asset as AssetSchema,
  Collection as CollectionSchema,
  Entry as EntrySchema,
  Locale as LocaleSchema,
  Navigation as NavigationSchema,
  Redirect as RedirectSchema,
  SiteSettings as SiteSettingsSchema,
  Taxonomy as TaxonomySchema,
  Workspace,
  type Asset,
  type Collection,
  type ContentType,
  type Entry,
  type FieldDef,
  type Issue,
  type Locale,
  type NavItem,
  type Navigation,
  type Redirect,
  type Reference,
  type RichTextDoc,
  type SiteSettings,
  type StepContext,
  type StepReport,
  type Taxonomy,
  type Term,
} from "@harness/mirror-core";
import { htmlToRichText } from "@harness/mirror-transforms";
import { readCrawl, type AssetRecord, type LinkProbe, type PageManifest } from "./crawl.js";
import { pageContentHtml, preferRenderedContent } from "./content-source.js";
export { preferRenderedContent };
import {
  attr,
  childElements,
  classes,
  innerHtml,
  matches,
  outerHtml,
  parseFragment,
  pathOf,
  select,
  selectAll,
  text,
  toHtml,
  walk,
  type Element,
  type ElementContent,
  type Root,
} from "./dom.js";
import { toText } from "hast-util-to-text";
import { bundleToType, fieldNameToId, machineName, paragraphToType, parsePage, type MenuItemInfo, type PageInfo } from "./page.js";
import { DEFAULT_PROFILE_SET, slotDef, type ListItemSpec, type ParagraphProfile, type ProfileSet, type SlotDef } from "./profiles.js";
import { resolveProfileSet } from "./theme-pack.js";
// cycle-safe: infer.ts uses to-ccm exports only inside functions
import { analyzeCoverage, loadCoverageInput, unmappedTextIssues } from "./infer.js";

/** hast property name of an HTML attribute: data-brand-id -> dataBrandId, aria-label -> ariaLabel */
const toProp = (a: string) => a.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

// ------------------------------------------------------------------ naming (shared with @cmp/source-drupal, see workplan)
export const pageCcmId = (key: string) => `html:page:${key}`;
export const sectionCcmId = (key: string, index: string | number) => `html:section:${key}:${index}`;
export const assetCcmId = (originalPath: string) => `html:asset:${originalPath}`;
export const termCcmId = (key: string) => `html:term:${key}`;
export const blockCcmId = (id: string) => `html:block:${id}`;
export const collectionId = (view: string, display: string) => `${view}--${display}`;
/** Value of the `collection` json field on sectionTeaserList (workplan: carries { collection: "<id>" }). */
export const collectionFieldValue = (id: string) => ({ collection: id });

const ENTITY_BOUNDARY = ["paragraph", "node", "media", "taxonomy-term", "view", "views-row", "block"];

export type FieldKind =
  | "text"
  | "richText"
  | "link"
  | "links"
  | "asset"
  | "assets"
  | "componentList"
  | "collection"
  | "termRefs"
  | "entryRefs"
  | "date"
  | "textList"
  | "html"
  | "json"
  | "bgImage"
  | "classes"
  | "list"
  | "value";

interface RawField {
  id: string;
  kind: FieldKind;
  el: Element;
  /** all matches (links, textList, assets) */
  els?: Element[];
  drupalName: string;
  drupalType?: string;
  sections?: RawDoc[];
  view?: { id: string; display: string; rows: RawTeaser[] };
  slot?: SlotDef;
  /** precomputed value (classes, flags) */
  value?: unknown;
  /** field id not derived from Drupal markup (theme slot, class) */
  inferred?: boolean;
  /** anchor wrapping the entity root (cards) */
  parentLink?: Element;
}
interface RawTeaser {
  path: string;
  href: string;
  type: string;
  title: string;
  img?: Element;
  created?: string;
  dateField?: string;
}
interface RawDoc {
  type: string;
  kind: "document" | "component";
  fields: RawField[];
  bundle?: string;
  el?: Element;
  /** drupal entity kind of a section ("paragraph", "node" for view-mode teasers, "item" for theme lists) */
  entity?: string;
  /** native id (paragraph id from `id="section-<pid>"`) */
  pid?: string;
  /** text of the section not covered by any field -> `html` fallback */
  leftovers?: string[];
  keepHtml?: boolean;
}
interface ParsedPage {
  manifest: PageManifest;
  info: PageInfo;
  locale: string;
  key: string;
  doc?: RawDoc;
  /** HTML that fed the extraction */
  contentSource: "raw" | "rendered";
}

export interface ToCcmResult {
  entries: Entry[];
  assets: Asset[];
  schema: { contentTypes: ContentType[] };
  taxonomies: Taxonomy[];
  navigation: Navigation[];
  redirects: Redirect[];
  locales: Locale[];
  collections: Collection[];
  settings: SiteSettings;
  issues: Issue[];
}

// ------------------------------------------------------------------ entity detection

export function fieldInfo(el: Element): { name: string; type?: string } | undefined {
  const cls = classes(el);
  const name = cls.find((c) => c.startsWith("field--name-"))?.slice(12);
  if (!name) return undefined;
  return { name, type: cls.find((c) => c.startsWith("field--type-"))?.slice(12) };
}

function safeMatches(sel: string, el: Element): boolean {
  try {
    return matches(sel, el);
  } catch {
    return false;
  }
}

/** Entity root (paragraph, node rendered in a view mode, theme list item) and its Drupal machine name. */
export function entityRoot(el: Element, ps: ProfileSet = DEFAULT_PROFILE_SET): { machine: string; entity: string } | undefined {
  const cls = classes(el);
  if (cls.includes("paragraph")) {
    const t = cls.find((c) => c.startsWith("paragraph--type--"));
    return { machine: t ? machineName(t.slice(17)) : "generic", entity: "paragraph" };
  }
  for (const r of ps.entityRoots) if (safeMatches(r.sel, el)) return { machine: r.type, entity: r.entity };
  const vm = cls.find((c) => c.startsWith("node--view-mode--"));
  if (vm && !cls.includes("node")) return { machine: machineName(vm.slice(17)), entity: "node" };
  if (/^section-\d+$/.test(attr(el, "id") ?? "")) return { machine: "generic", entity: "paragraph" };
  return undefined;
}

function typeOfEntity(r: { machine: string; entity: string }): string {
  return r.entity === "node" ? bundleToType(r.machine) : paragraphToType(r.machine);
}

function isBoundary(el: Element, ps: ProfileSet): boolean {
  if (entityRoot(el, ps)) return true;
  const cls = classes(el);
  return ENTITY_BOUNDARY.some((b) => cls.includes(b));
}

/** Top-level field elements of an entity (not descending into nested entities or other fields). */
function topFields(entity: Element, ps: ProfileSet): Element[] {
  const out: Element[] = [];
  walk(entity, (el) => {
    if (fieldInfo(el)) {
      out.push(el);
      return false;
    }
    if (isBoundary(el, ps)) return false;
    return true;
  });
  return out;
}

/** First-level entity roots inside an element (optionally not descending into Drupal field wrappers). */
function directEntities(el: Element, stopAtFields: boolean, ps: ProfileSet): Element[] {
  const out: Element[] = [];
  walk(el, (c) => {
    if (entityRoot(c, ps)) {
      out.push(c);
      return false;
    }
    if (stopAtFields && fieldInfo(c)) return false;
    if (classes(c).includes("views-row") || classes(c).includes("block")) return false;
    return true;
  });
  return out;
}

/** Elements of an entity that belong to it (not inside nested entities). */
function ownElements(entity: Element, ps: ProfileSet): Set<Element> {
  const own = new Set<Element>();
  walk(entity, (el) => {
    if (entityRoot(el, ps)) return false;
    own.add(el);
    return true;
  });
  return own;
}

export function classifyField(el: Element, type: string | undefined, ps: ProfileSet = DEFAULT_PROFILE_SET): FieldKind {
  if (type === "entity-reference-revisions" || directEntities(el, false, ps).length) return "componentList";
  if (type === "viewsreference" || select(".view[class*='view-id-'], [class*='js-view-dom-id-'], .views-element-container", el)) return "collection";
  if (type === "link") return "link";
  if (type === "image" || ((type === "entity-reference" || !type) && select("img", el) && !text(el))) return "asset";
  if (type === "datetime" || type === "timestamp" || type === "created" || type === "published-at" || (select("time[datetime]", el) && text(el) === text(select("time", el)))) return "date";
  if (type === "entity-reference") {
    const hrefs = selectAll("a[href]", el).map((a) => attr(a, "href")!);
    return hrefs.length && hrefs.every((h) => /\/(tags|taxonomy|term|category|categories|topics?)\//.test(h) || attr(select(`a[href="${h}"]`, el), "hrefLang") !== undefined)
      ? "termRefs"
      : "entryRefs";
  }
  if (type && /^(text|text-long|text-with-summary)$/.test(type)) return "richText";
  if (type && /^(string|string-long|list-string|integer|decimal|email)$/.test(type)) return "text";
  if (selectAll("p, ul, ol, h2, h3, h4, table, blockquote, img", el).length) return "richText";
  const as = selectAll("a", el);
  if (as.length === 1 && text(as[0]) === text(el)) return "link";
  return "text";
}

interface ExtractCtx {
  base: string;
  info: PageInfo;
  parents: Map<Element, Element>;
  /** merged paragraph profiles (site > theme pack > generic) */
  ps: ProfileSet;
}

function viewOf(el: Element, ctx: ExtractCtx): { id: string; display: string } | undefined {
  const v = select(".view[class*='view-id-']", el);
  if (v) {
    const cls = classes(v);
    return { id: cls.find((c) => c.startsWith("view-id-"))!.slice(8), display: cls.find((c) => c.startsWith("view-display-id-"))?.slice(16) ?? "default" };
  }
  const dom = select("[class*='js-view-dom-id-']", el);
  const hash = classes(dom).find((c) => c.startsWith("js-view-dom-id-"))?.slice(15);
  if (hash && ctx.info.drupal.viewDomIds[hash]) return ctx.info.drupal.viewDomIds[hash];
  const title = text(select(".viewsreference--view-title", el));
  if (title) return { id: machineName(title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")), display: "default" };
  return undefined;
}

/**
 * Rows of a Views listing: `.views-row`, else (grid/list styles without row classes, e.g. core's responsive grid) the
 * outermost node entities inside the view.
 */
function viewRowsOf(view: Element): Element[] {
  const rows = selectAll(".views-row", view);
  if (rows.length) return rows;
  const nodes = selectAll("[class*='node--type-']", view).filter((el) => el.tagName === "article" || classes(el).includes("node"));
  const set = new Set(nodes);
  const parents = new Map<Element, Element>();
  walk(view, (el) => {
    for (const c of el.children) if (c.type === "element") parents.set(c, el);
    return true;
  });
  return nodes.filter((n) => {
    for (let p = parents.get(n); p && p !== view; p = parents.get(p)) if (set.has(p)) return false;
    return true;
  });
}

function teasersOf(view: Element, base: string): RawTeaser[] {
  return viewRowsOf(view).map((row) => {
    const node = select(".node", row) ?? row;
    const titleA = select(".node__title a, h2 a, h3 a", node) ?? select("a", node);
    const titleEl = (titleA ? select("[class*='title']", titleA) : undefined) ?? titleA;
    const typeCls = classes(node).find((c) => c.startsWith("node--type-"));
    const time = select("time[datetime]", node);
    let dateField: string | undefined;
    if (time) {
      let p: Element | undefined;
      walk(node, (el) => {
        if (fieldInfo(el) && select("time[datetime]", el)) p = el;
        return !p;
      });
      if (p) dateField = fieldNameToId(fieldInfo(p)!.name);
    }
    const href = attr(titleA, "href") ?? "";
    return {
      path: pathOf(href, base) ?? "",
      href,
      type: typeCls ? bundleToType(machineName(typeCls.slice(11))) : "",
      title: text(titleEl),
      img: select("img", node) ?? undefined,
      created: attr(time, "dateTime"),
      dateField,
    };
  });
}

function slotFields(entity: Element, machine: string, ctx: ExtractCtx): RawField[] {
  return slotFieldsFor(entity, ctx.ps.profiles[machine], ctx);
}

function slotFieldsFor(entity: Element, profile: ParagraphProfile | undefined, ctx: ExtractCtx): RawField[] {
  if (!profile?.slots) return [];
  const own = ownElements(entity, ctx.ps);
  const out: RawField[] = [];
  for (const [id, raw] of Object.entries(profile.slots)) {
    const s = slotDef(raw);
    let els: Element[];
    if (s.parentLink) {
      const p = ctx.parents.get(entity);
      els = p && p.tagName === "a" ? [p] : [];
    } else {
      els = selectAll(s.sel, entity).filter((e) => own.has(e));
      if (s.nonEmpty) els = els.filter((e) => text(e));
    }
    if (!els.length) continue;
    out.push({ id, kind: s.kind, el: els[0], els, drupalName: id, slot: s, inferred: true });
  }
  return out;
}

function classFields(entity: Element, machine: string, ps: ProfileSet): RawField[] {
  const cls = classes(entity);
  const out: RawField[] = [];
  for (const { re, field } of ps.classFields) {
    const c = cls.find((x) => re.test(x));
    if (c && !out.some((f) => f.id === field)) out.push({ id: field, kind: "value", el: entity, drupalName: field, value: re.exec(c)![1], inferred: true });
  }
  const flags = ps.profiles[machine]?.flags ?? {};
  for (const [field, c] of Object.entries(flags)) out.push({ id: field, kind: "value", el: entity, drupalName: field, value: cls.includes(c), inferred: true });
  const rest = cls.filter((c) => c !== "paragraph" && !c.startsWith("paragraph--type--") && c !== "paragraph--view-mode--default");
  if (rest.length) out.push({ id: "classes", kind: "classes", el: entity, drupalName: "classes", value: rest.join(" "), inferred: true });
  return out;
}

const SKIP_TEXT_TAGS = new Set(["script", "style", "svg", "button", "form", "label", "select", "option", "noscript", "template", "input", "textarea", "nav"]);

/** Visible text chunks of an entity not covered by any extracted field. */
function uncoveredText(entity: Element, covered: Element[], capturedTexts: string[], ps: ProfileSet): string[] {
  const coveredSet = new Set(covered);
  const chunks: string[] = [];
  const rec = (el: Element) => {
    for (const c of el.children) {
      if (c.type === "text") {
        const t = c.value.replace(/\s+/g, " ").trim();
        if (t) chunks.push(t);
      } else if (c.type === "element") {
        if (coveredSet.has(c) || SKIP_TEXT_TAGS.has(c.tagName) || fieldInfo(c) || (c !== entity && entityRoot(c, ps))) continue;
        if (classes(c).some((x) => /^(visually-hidden|sr-only|hidden)$/.test(x))) continue;
        rec(c);
      }
    }
  };
  rec(entity);
  const hay = capturedTexts.join(" \u0000 ");
  return chunks.filter((t) => !hay.includes(t));
}

function rawEntity(entity: Element, type: string, kind: RawDoc["kind"], ctx: ExtractCtx, machine?: string): RawDoc {
  const fields: RawField[] = [];
  const add = (f: RawField) => {
    if (!fields.some((x) => x.id === f.id)) fields.push(f);
  };
  for (const el of topFields(entity, ctx.ps)) {
    const fi = fieldInfo(el)!;
    if (fi.name === "title" && kind === "document") continue; // title comes from the page title block
    const k = classifyField(el, fi.type, ctx.ps);
    const f: RawField = { id: k === "collection" ? "collection" : fieldNameToId(fi.name), kind: k, el, drupalName: fi.name, drupalType: fi.type };
    if (k === "componentList") f.sections = directEntities(el, false, ctx.ps).map((p) => sectionDoc(p, ctx));
    if (k === "collection") {
      const v = viewOf(el, ctx) ?? { id: f.id, display: "default" };
      f.view = { ...v, rows: teasersOf(el, ctx.base) };
    }
    add(f);
  }
  const doc: RawDoc = { type, kind, fields, el: entity };
  if (kind === "component" && machine) {
    for (const f of slotFields(entity, machine, ctx)) add(f);
    // child entities not inside a Drupal field wrapper (slides, quick facts, cards)
    const loose = directEntities(entity, true, ctx.ps);
    if (loose.length) {
      const id = ctx.ps.profiles[machine]?.items ?? "items";
      add({ id, kind: "componentList", el: entity, drupalName: id, sections: loose.map((p) => sectionDoc(p, ctx)), inferred: true });
    }
    for (const f of classFields(entity, machine, ctx.ps)) add(f);
    const covered = fields.flatMap((f) => (f.kind === "classes" || f.kind === "value" ? [] : (f.els ?? [f.el]))).filter((e) => e !== entity);
    // the entity root itself is not a capture (loose `items` lists point at it): its text would mask every leftover
    const captured = fields.flatMap((f) => (f.kind === "classes" || f.kind === "value" ? [] : (f.els ?? [f.el]).filter((e) => e !== entity).map((e) => text(e))));
    const left = uncoveredText(entity, covered, captured, ctx.ps);
    if (left.length) doc.leftovers = left;
    doc.keepHtml = ctx.ps.profiles[machine]?.keepHtml;
  }
  return doc;
}

function sectionDoc(p: Element, ctx: ExtractCtx): RawDoc {
  const r = entityRoot(p, ctx.ps) ?? { machine: "generic", entity: "paragraph" };
  const type = typeOfEntity(r);
  const own = r.entity === "paragraph" ? ownElements(p, ctx.ps) : undefined;
  const pid =
    /^section-(\d+)$/.exec(attr(p, "id") ?? "")?.[1] ??
    (/^\d+$/.test(attr(p, "dataParagraphId") ?? "") ? attr(p, "dataParagraphId") : undefined) ??
    (own ? selectAll("[id]", p).filter((e) => own.has(e) && !/^section-/.test(attr(e, "id")!)).map((e) => /-(\d{3,})$/.exec(attr(e, "id")!)?.[1]).find(Boolean) : undefined);
  return { ...rawEntity(p, type, "component", ctx, r.machine), bundle: r.machine, el: p, entity: r.entity, pid };
}

/**
 * Generic (non-Drupal) page: unwrap single-child wrappers inside main, each remaining child is a section. Blocks
 * without text are sections too: widget mounts a script fills (flight search, model carousels), separators and spacers
 * take up space on the page and must not disappear from it.
 */
function rawGeneric(main: Element): RawDoc {
  const NON_BLOCK = ["script", "style", "template", "noscript", "link", "meta"];
  let root = main;
  for (let i = 0; i < 6; i++) {
    const kids = childElements(root).filter((k) => !NON_BLOCK.includes(k.tagName));
    if (kids.length === 1 && text(kids[0]) && !/^h[1-6]$/.test(kids[0].tagName)) root = kids[0];
    else break;
  }
  const blocks = childElements(root).filter((k) => !NON_BLOCK.includes(k.tagName));
  const sections: RawDoc[] = blocks
    .filter((b) => !/^h1$/.test(b.tagName) && !classes(b).includes("page-title"))
    .map((b) => ({ type: "sectionGeneric", kind: "component" as const, fields: [], el: b, bundle: "generic" }));
  return { type: "page", kind: "document", fields: [{ id: "sections", kind: "componentList", el: root, drupalName: "sections", sections }] };
}

const isBlockEl = (el: Element) => classes(el).includes("block-view-container") || (classes(el).includes("block") && /^block-/.test(attr(el, "id") ?? ""));

/**
 * Node root for themes that do not print `article.node--view-mode-full`: the page header region (hero image, date)
 * plus the content region without placed blocks, as one virtual element.
 */
function virtualNodeRoot(main: Element): Element {
  const header = select(".region-page-header", main);
  const content = select(".region-content", main) ?? main;
  const kids = childElements(content).filter((c) => !isBlockEl(c));
  return { type: "element", tagName: "div", properties: { className: ["cmp-node-root"] }, children: [...(header ? [header] : []), ...kids] };
}

// ------------------------------------------------------------------ rich text helpers

/** Top-level rich-text blocks whose markup carries theme classes/styles are kept verbatim (rawHtml): the AST has no classes. */
function isStyled(el: Element): boolean {
  let styled = false;
  const check = (e: Element) => {
    const cls = classes(e);
    if (cls.includes("media") || cls.includes("embedded-entity") || e.tagName === "drupal-media") return false;
    if (e.tagName !== "img" && e.tagName !== "a" && (cls.length || attr(e, "style"))) styled = true;
    return !styled;
  };
  if (check(el)) walk(el, (e) => check(e));
  return styled;
}

const imgsIn = (el: Element): Element[] => (el.tagName === "img" ? [el] : selectAll("img", el));

// ------------------------------------------------------------------ main

export interface BuildCcmInput {
  baseUrl: string;
  pages: PageManifest[];
  assets: AssetRecord[];
  links: Record<string, LinkProbe>;
  redirects: { from: string; to: string; status: number }[];
  /** read a workspace-relative file (raw / rendered html) */
  readText(rel: string): Promise<string>;
  siteLocales?: { code: string; name?: string; default?: boolean; fallback?: string; pathPrefix?: string }[];
  siteName?: string;
  /** which captured HTML feeds content extraction (default "raw": server HTML before JS; falls back to rendered) */
  contentSource?: "raw" | "rendered";
  /** original origin when baseUrl is a capture replay: absolute URLs in SEO meta are mapped back to it */
  origin?: string;
  /** configured POC urls (site.urls): the first one is the start page the empty site root redirects to */
  urls?: string[];
  /** merged paragraph profiles (default DEFAULT_PROFILE_SET = da_vinci_code pack; the step resolves site > theme > generic) */
  profiles?: ProfileSet;
}

function sameOrigin(html: string, base: string, origin: string | undefined): string {
  if (!origin) return html;
  const o = origin.replace(/\/+$/, "");
  if (o === base) return html;
  const host = new URL(o).host.replace(/[.]/g, "\\.");
  return html.replace(new RegExp(`(https?:)?//${host}(?![A-Za-z0-9.-])`, "g"), base);
}

/**
 * Asset file name (the generated app stores it as public/_assets/<safeId>/<fileName>): media-service URLs end in
 * 1 000+ character tokens, above the 255-byte path-segment limit. Long names keep their start and extension plus a
 * hash of the full name (deterministic, collision-free).
 */
export function assetFileName(name: string): string {
  if (name.length <= 120) return name;
  const ext = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] ?? "";
  return `${name.slice(0, 120 - ext.length - 13)}_${createHash("sha1").update(name).digest("hex").slice(0, 12)}${ext}`;
}

/** The content HTML of a crawled page (server HTML, or the rendered DOM for client-rendered Next.js pages: content-source.ts). */
async function pageHtml(m: PageManifest, input: BuildCcmInput): Promise<{ html: string; source: "raw" | "rendered" }> {
  return pageContentHtml(m.files, input.readText, input.contentSource ?? "raw");
}

export async function buildCcm(input: BuildCcmInput): Promise<ToCcmResult> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const ps = input.profiles ?? DEFAULT_PROFILE_SET;
  const issues: Issue[] = [];

  const originBase = input.origin?.replace(/\/+$/, "");
  /** production-origin absolute URL (e.g. inside JSON blobs the HTML rewrite did not reach) -> crawl base */
  const fromOrigin = (href: string): string => (originBase && originBase !== base && (href === originBase || href.startsWith(originBase + "/")) ? base + href.slice(originBase.length) : href);
  /** external URLs the replay server rewrote to /__ext/<host>/<path> -> back to the original absolute URL */
  const unExt = (href0: string): string => {
    const href = fromOrigin(href0);
    const p = pathOf(href, base);
    if (p?.startsWith("/__ext/")) {
      const u = new URL(href, base + "/");
      return `https://${p.slice(7)}${u.search}${u.hash}`;
    }
    return href0;
  };
  const linkHref = (href0: string): string => {
    const href = fromOrigin(href0);
    const h = unExt(href);
    if (h !== href) return h;
    const p = pathOf(href, base);
    if (!p) return href;
    const u = new URL(href, base + "/");
    return p + u.search + u.hash;
  };

  // ---- parse pages
  const parsed: ParsedPage[] = [];
  for (const m of input.pages) {
    if (m.status !== 200) continue;
    const { html: html0, source } = await pageHtml(m, input);
    // production-origin URLs left in the markup (not rewritten by the replay, HAR bodies) count as same-origin
    const html = sameOrigin(html0, base, input.origin);
    const info = parsePage(html, m.path, base);
    parsed.push({ manifest: m, info, locale: "", key: m.path, contentSource: source });
  }
  if (!parsed.length) throw new Error("no crawled HTML pages with status 200 (run extract first)");
  const origin = input.origin?.replace(/\/+$/, "");
  /** replay URL -> production URL (SEO meta keeps what the live site publishes) */
  const toOrigin = (v: string): string => (origin && (v === base || v.startsWith(base + "/")) ? origin + v.slice(base.length) : v);
  if (origin && origin !== base)
    for (const p of parsed) {
      const m = p.info.meta;
      if (m.canonical) m.canonical = toOrigin(m.canonical);
      for (const rec of [m.og, m.twitter]) if (rec) for (const k of Object.keys(rec)) rec[k] = toOrigin(rec[k]);
      if (m.hreflang) m.hreflang = m.hreflang.map((h) => ({ ...h, href: toOrigin(h.href) }));
    }
  const pathOrOrigin = (href: string) => pathOf(href, base) ?? (origin ? pathOf(href, origin) : undefined);
  const pctx = new Map<ParsedPage, ExtractCtx>();
  for (const p of parsed) {
    const parents = new Map<Element, Element>();
    walk(p.info.tree, (el, anc) => {
      if (anc.length) parents.set(el, anc[anc.length - 1]);
    });
    pctx.set(p, { base, info: p.info, parents, ps });
  }

  // ---- locales
  const cfgLocales = input.siteLocales ?? [];
  const seenLangs = new Map<string, string>(); // code -> name
  for (const p of parsed) {
    for (const l of p.info.languageLinks) if (!seenLangs.has(l.locale) || !seenLangs.get(l.locale)) seenLangs.set(l.locale, l.label);
    for (const h of p.info.meta.hreflang ?? []) if (h.locale !== "x-default" && !seenLangs.has(h.locale)) seenLangs.set(h.locale, "");
    if (p.info.lang && !seenLangs.has(p.info.lang)) seenLangs.set(p.info.lang, "");
  }
  for (const c of cfgLocales) if (!seenLangs.has(c.code)) seenLangs.set(c.code, c.name ?? "");
  const front = parsed.find((p) => p.manifest.path === "/") ?? parsed[0];
  const defaultCode = cfgLocales.find((c) => c.default)?.code ?? front.info.lang ?? [...seenLangs.keys()][0] ?? "en";
  const locales: Locale[] = [...seenLangs.keys()]
    .sort((a, b) => (a === defaultCode ? -1 : b === defaultCode ? 1 : a.localeCompare(b)))
    .map((code) => {
      const cfg = cfgLocales.find((c) => c.code === code);
      const isDefault = code === defaultCode;
      return LocaleSchema.parse({
        code,
        name: cfg?.name ?? (seenLangs.get(code) || code),
        default: isDefault,
        fallback: cfg?.fallback ?? (isDefault ? undefined : defaultCode),
        pathPrefix: (cfg?.pathPrefix ?? (isDefault ? "" : code)).replace(/^\/+|\/+$/g, ""),
      });
    });
  const codes = locales.map((l) => l.code);
  const localeOfPath = (path: string): string => {
    for (const l of locales) if (l.pathPrefix && (path === `/${l.pathPrefix}` || path.startsWith(`/${l.pathPrefix}/`))) return l.code;
    return defaultCode;
  };
  for (const p of parsed) p.locale = p.info.lang && codes.includes(p.info.lang) ? p.info.lang : localeOfPath(p.manifest.path);

  // ---- translation groups: key = default-locale path
  const pathToKey = new Map<string, string>();
  const setKey = (path: string | undefined, key: string) => {
    if (path && !pathToKey.has(path)) pathToKey.set(path, key);
  };
  for (const p of parsed) {
    const alts = [
      ...(p.info.meta.hreflang ?? []).map((h) => ({ locale: h.locale, path: pathOrOrigin(h.href) })),
      ...p.info.languageLinks.map((l) => ({ locale: l.locale, path: l.path })),
    ].filter((a) => a.path && codes.includes(a.locale));
    const def = alts.find((a) => a.locale === defaultCode)?.path;
    p.key = def ?? p.manifest.path;
    if (alts.length && !alts.some((a) => a.path === p.manifest.path)) issues.push({ severity: "warning", code: "HREFLANG_SELF_MISSING", message: `${p.manifest.path} is not listed in its own hreflang alternates`, ref: p.manifest.path });
  }
  for (const p of parsed) setKey(p.manifest.path, p.key);
  for (const p of parsed) for (const h of p.info.meta.hreflang ?? []) setKey(pathOrOrigin(h.href), p.key);
  const resolvePathKey = (path: string): string | undefined => {
    const k = pathToKey.get(path);
    if (k) return k;
    const probe = input.links[path];
    if (probe?.finalPath && probe.finalPath !== path) return pathToKey.get(probe.finalPath);
    return undefined;
  };

  // ---- raw documents
  for (const p of parsed) {
    const t = p.info.template;
    const ctx = pctx.get(p)!;
    if (t.startsWith("node:")) {
      const main = p.info.main;
      const nodeEl = main ? (select("article.node.node--view-mode-full, .node--view-mode-full, article.node", main) ?? virtualNodeRoot(main)) : undefined;
      const type = bundleToType(p.info.drupal.nodeType!);
      p.doc = nodeEl ? { ...rawEntity(nodeEl, type, "document", ctx), bundle: p.info.drupal.nodeType } : { type, kind: "document", fields: [], bundle: p.info.drupal.nodeType };
    } else if (t === "generic" || t === "front") {
      p.doc = p.info.main ? rawGeneric(p.info.main) : { type: "page", kind: "document", fields: [] };
    }
    // document-level slots (profile `documents.<type>`): relative to the main content, outside paragraphs
    const dp = p.doc && ps.documents[p.doc.type];
    if (p.doc && dp?.slots && p.info.main) for (const f of slotFieldsFor(p.info.main, dp, ctx)) if (!p.doc.fields.some((x) => x.id === f.id)) p.doc.fields.push(f);
  }
  const groups = new Map<string, Map<string, ParsedPage>>();
  for (const p of parsed) {
    if (!p.doc) continue;
    const g = groups.get(p.key) ?? new Map<string, ParsedPage>();
    if (g.has(p.locale)) issues.push({ severity: "warning", code: "DUPLICATE_TRANSLATION", message: `${p.manifest.path} and ${g.get(p.locale)!.manifest.path} both claim ${p.key} (${p.locale})`, ref: p.manifest.path });
    else g.set(p.locale, p);
    groups.set(p.key, g);
  }

  // ---- block content with paragraphs (one per block id, first page that shows it per locale)
  const blockDocs = new Map<string, Map<string, { p: ParsedPage; doc: RawDoc; region?: string; title?: string }>>();
  const blockPages = new Map<string, Set<string>>();
  for (const p of parsed) {
    for (const b of p.info.blocks) {
      if (!b.hasComponents) continue;
      const pages = blockPages.get(b.id) ?? new Set<string>();
      pages.add(p.manifest.path);
      blockPages.set(b.id, pages);
      const m = blockDocs.get(b.id) ?? new Map();
      if (!m.has(p.locale)) m.set(p.locale, { p, doc: rawEntity(b.el, "blockContent", "document", pctx.get(p)!), region: b.region, title: b.title });
      blockDocs.set(b.id, m);
    }
  }

  // ---- teaser type inference: URL prefix shared with a crawled document (>= 2 segments), else majority of the view
  const docTypeByPath = new Map<string, string>();
  for (const p of parsed) if (p.doc) docTypeByPath.set(p.manifest.path, p.doc.type);
  const inferTeaserType = (path: string): string | undefined => {
    const segs = path.split("/").filter(Boolean);
    let best: { n: number; type: string } | undefined;
    for (const [dp, t] of docTypeByPath) {
      const ds = dp.split("/").filter(Boolean);
      let n = 0;
      while (n < Math.min(segs.length, ds.length) - 0 && segs[n] === ds[n]) n++;
      if (n >= 2 && n < segs.length && (!best || n > best.n)) best = { n, type: t };
    }
    return best?.type;
  };

  // ---- pair positional things across translations (teasers, term links) so they share keys
  const teaserStubs = new Map<string, Map<string, RawTeaser>>(); // key -> locale -> teaser
  const termKeys = new Map<string, Map<string, { name: string; path: string }>>(); // key -> locale -> term
  const allRawFields = (d: RawDoc): RawField[] => d.fields.flatMap((f) => [f, ...(f.sections ?? []).flatMap(allRawFields)]);
  const rawDocsOf = (g: Map<string, ParsedPage>) => [...g.values()].map((p) => ({ p, doc: p.doc! }));
  const allGroups: { p: ParsedPage; doc: RawDoc }[][] = [...[...groups.values()].map(rawDocsOf), ...[...blockDocs.values()].map((m) => [...m.values()].map((x) => ({ p: x.p, doc: x.doc })))];
  for (const g of allGroups) {
    const def = g.find((x) => x.p.locale === defaultCode) ?? g[0];
    const defFields = allRawFields(def.doc);
    for (const { p, doc } of g) {
      const fields = allRawFields(doc);
      fields.forEach((f, i) => {
        const df = defFields[i]?.id === f.id ? defFields[i] : undefined;
        if (f.view) {
          const types = f.view.rows.map((r) => r.type || inferTeaserType(r.path)).filter((x): x is string => !!x);
          const majority = types.sort((a, b) => types.filter((x) => x === b).length - types.filter((x) => x === a).length)[0];
          f.view.rows.forEach((row, r) => {
            if (!row.path) return;
            row.type = row.type || inferTeaserType(row.path) || majority || "page";
            const dRow = df?.view?.rows[r];
            const key = resolvePathKey(row.path) ?? (dRow ? (resolvePathKey(dRow.path) ?? dRow.path) : row.path);
            setKey(row.path, key);
            if (!groups.get(key)?.has(p.locale)) {
              const m = teaserStubs.get(key) ?? new Map<string, RawTeaser>();
              if (!m.has(p.locale)) m.set(p.locale, row);
              teaserStubs.set(key, m);
            }
          });
        }
        if (f.kind === "termRefs") {
          const dLinks = df ? selectAll("a[href]", df.el) : [];
          selectAll("a[href]", f.el).forEach((a, r) => {
            const path = pathOf(attr(a, "href")!, base)!;
            const dPath = dLinks[r] ? pathOf(attr(dLinks[r], "href")!, base)! : path;
            const key = resolvePathKey(path) ?? resolvePathKey(dPath) ?? dPath;
            setKey(path, key);
            const m = termKeys.get(key) ?? new Map();
            m.set(p.locale, { name: text(a), path });
            termKeys.set(key, m);
          });
        }
      });
    }
  }
  // crawled term pages contribute names too
  for (const p of parsed.filter((x) => x.info.template === "taxonomy_term")) {
    const m = termKeys.get(p.key) ?? new Map();
    m.set(p.locale, { name: p.info.pageTitle ?? "", path: p.manifest.path });
    termKeys.set(p.key, m);
  }

  const documentKeys = new Set<string>([...groups.keys(), ...teaserStubs.keys()]);
  // Drupal-native ids when the markup exposes them (nid: drupalSettings / data-history-node-id / shortlink;
  // pid: id="section-<pid>" / data-paragraph-id) -> the same ccmIds the Drupal DB/JSON:API import produces.
  const nidByKey = new Map<string, number>();
  for (const [key, g] of groups) {
    const nid = (g.get(defaultCode) ?? [...g.values()][0]).info.drupal.nid ?? [...g.values()].find((p) => p.info.drupal.nid)?.info.drupal.nid;
    if (nid) nidByKey.set(key, nid);
  }
  const docId = (key: string): string => (nidByKey.has(key) ? `drupal:node:${nidByKey.get(key)}` : pageCcmId(key));
  const usedSectionIds = new Set<string>(); // `${ccmId}|${locale}`
  const resolveLink = (href: string): Reference | undefined => {
    const path = pathOf(href, base);
    if (!path) return undefined;
    const key = resolvePathKey(path);
    if (!key) return undefined;
    if (documentKeys.has(key)) return { kind: "entry", id: docId(key) };
    if (termKeys.has(key)) return { kind: "term", id: termCcmId(key) };
    return undefined;
  };

  // ---- assets
  const assetRecords = new Map(input.assets.map((a) => [a.path, a]));
  const assets = new Map<string, Asset>();
  const manifestImg = new Map<string, { w: number; h: number }>();
  for (const m of input.pages)
    for (const i of m.images) {
      const p = pathOf(i.src, base);
      if (p && i.naturalWidth) manifestImg.set(p, { w: i.naturalWidth, h: i.naturalHeight });
    }
  const notDownloaded = new Set<string>();
  const registerAsset = (src0: string, locale: string, alt?: string, width?: number, height?: number, title?: string): Reference | undefined => {
    if (!src0 || src0.startsWith("data:")) return undefined;
    const src = fromOrigin(src0);
    const ext = unExt(src);
    const path = ext === src ? pathOf(src, base) : undefined;
    const originalPath = path ?? ext.split("#")[0];
    const id = assetCcmId(originalPath);
    let a = assets.get(id);
    if (!a) {
      const rec = path ? assetRecords.get(path) : undefined;
      const nat = path ? manifestImg.get(path) : undefined;
      const url = ext === src ? new URL(src, base + "/").href : ext;
      a = {
        ccmId: id,
        src: rec ? rec.file : url,
        originalPath: path,
        fileName: assetFileName(basename(originalPath.split("?")[0]) || "file"),
        mime: rec?.mime || guessMime(originalPath),
        size: rec?.size,
        width: width ?? nat?.w,
        height: height ?? nat?.h,
        sha256: rec?.sha256 || undefined,
        source: { system: "html", kind: "file", id: originalPath, url },
      };
      if (!rec && path) notDownloaded.add(originalPath);
      assets.set(id, a);
    }
    if (alt !== undefined && alt !== "") a.alt = { ...(a.alt ?? {}), [locale]: a.alt?.[locale] ?? alt };
    if (title) a.title = { ...(a.title ?? {}), [locale]: title };
    return { kind: "asset", id };
  };
  const imgRef = (img: Element, locale: string) => {
    const w = Number(attr(img, "width")) || undefined;
    const h = Number(attr(img, "height")) || undefined;
    return registerAsset(attr(img, "src") ?? attr(img, "dataSrc") ?? "", locale, attr(img, "alt") ?? "", w, h, attr(img, "title"));
  };
  /** responsive candidates (<picture><source>, srcset): registered as assets (downloaded/copied), returned as paths */
  const srcsetPaths = (srcset: string, locale: string): string =>
    srcset
      .split(/,\s+(?=\S)/)
      .map((cand) => {
        const [u, ...d] = cand.trim().split(/\s+/);
        if (!u) return "";
        registerAsset(u, locale);
        return [linkHref(u), ...d].join(" ");
      })
      .filter(Boolean)
      .join(", ");
  const responsiveOf = (img: Element, ctx: ExtractCtx, locale: string): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    const pic = ctx.parents.get(img);
    if (pic?.tagName === "picture") {
      const sources = childElements(pic)
        .filter((s) => s.tagName === "source" && attr(s, "srcSet"))
        .map((s) => ({ srcset: srcsetPaths(attr(s, "srcSet")!, locale), ...(attr(s, "media") ? { media: attr(s, "media") } : {}), ...(attr(s, "type") ? { type: attr(s, "type") } : {}) }));
      if (sources.length) out.sources = sources;
    }
    if (attr(img, "srcSet")) out.srcset = srcsetPaths(attr(img, "srcSet")!, locale);
    if (attr(img, "sizes")) out.sizes = attr(img, "sizes");
    if (attr(img, "src")) out.src = linkHref(attr(img, "src")!);
    return out.sources || out.srcset ? out : undefined;
  };

  // ---- schema accumulation
  const types = new Map<string, ContentType>();
  const ensureType = (id: string, kind: ContentType["kind"], sourceMeta?: Record<string, unknown>): ContentType => {
    let t = types.get(id);
    if (!t) {
      t = { id, name: humanize(id), kind, fields: [], sourceMeta: { system: "html", ...sourceMeta } };
      types.set(id, t);
    }
    return t;
  };
  const ensureField = (t: ContentType, def: Omit<FieldDef, "required" | "localized" | "cardinality"> & Partial<FieldDef>) => {
    const ex = t.fields.find((f) => f.id === def.id);
    if (ex) {
      if (def.allowedTypes) ex.allowedTypes = [...new Set([...(ex.allowedTypes ?? []), ...def.allowedTypes])].sort();
      if ((def.cardinality ?? 1) !== 1) ex.cardinality = -1;
      return;
    }
    t.fields.push({ required: false, localized: false, cardinality: 1, ...def } as FieldDef);
  };

  const entries: Entry[] = [];
  const collections = new Map<string, Collection>();
  const taxFields = new Map<string, string>(); // term key -> taxonomy id

  const ABBR = "https://cmp-abbr.invalid/";
  const convertRich = (html0: string, locale: string, ref: string): RichTextDoc => {
    const tmp = parsePage(`<body>${html0}</body>`, "/", base);
    for (const i of tmp.images) registerAsset(i.src, locale, i.alt, i.width, i.height);
    // <abbr title> has no rich-text mark: carry it through as a sentinel link, then unwrap into text nodes with an
    // additive `abbr` key (renderers emit <abbr title>; targets without support keep the plain text)
    let html = html0;
    if (/<abbr[^>]*\stitle=/i.test(html0)) {
      const f = parseFragment(html0);
      walk(f, (e) => {
        if (e.tagName === "abbr" && attr(e, "title")) {
          e.tagName = "a";
          e.properties = { href: ABBR + encodeURIComponent(attr(e, "title")!) };
        }
        return true;
      });
      html = toHtml(f);
    }
    const res = htmlToRichText(html, {
      baseUrl: base,
      ref,
      resolveLink: (href) => resolveLink(href),
      resolveAsset: (src, kind) => (kind === "img" ? registerAsset(src, locale) : undefined),
    });
    for (const i of res.issues) issues.push({ ...i, ref: i.ref ?? ref, ...(i.message.includes(ABBR) ? { severity: "info" as const } : {}) });
    const unAbbr = (nodes: unknown[]): unknown[] =>
      nodes.flatMap((n) => {
        const o = n as { type: string; href?: string; children?: unknown[] };
        if (o.type === "link" && o.href?.startsWith(ABBR)) {
          const title = decodeURIComponent(o.href.slice(ABBR.length));
          return unAbbr(o.children ?? []).map((c) => ((c as { type: string }).type === "text" ? { ...(c as object), abbr: title } : c));
        }
        return o.children ? [{ ...o, children: unAbbr(o.children) }] : [o];
      });
    return html === html0 ? res.doc : ({ type: "doc", children: unAbbr(res.doc.children) } as RichTextDoc);
  };
  /** rich text that keeps theme-styled top-level blocks verbatim (rawHtml) so classes survive */
  const richText = (html: string, locale: string, ref: string): RichTextDoc => {
    const frag = parseFragment(html);
    // bare inline content (text, <br>, <em>… without any block element): the original has no <p> (line-height differs)
    const BLOCK = /^(p|div|h[1-6]|ul|ol|li|table|blockquote|figure|section|article|header|footer|aside|nav|pre|hr|dl|form|iframe|video|picture|drupal-media)$/;
    const inlineOnly = (frag.children as ElementContent[]).every((c) => c.type !== "element" || !BLOCK.test(c.tagName)) && toText(frag).trim() !== "";
    if (inlineOnly) {
      // one structured paragraph flagged `implicit` (additive key): render its inline content without <p>
      // (design props of such fields carry `inline: true`)
      const d = convertRich(toHtml(frag).trim(), locale, ref);
      return { type: "doc", children: d.children.map((b) => (b.type === "paragraph" ? ({ ...b, implicit: true } as typeof b) : b)) };
    }
    const doc: RichTextDoc = { type: "doc", children: [] };
    let buf: ElementContent[] = [];
    const flush = () => {
      const h = toHtml({ type: "root", children: buf } as Root).trim();
      if (h) doc.children.push(...convertRich(h, locale, ref).children);
      buf = [];
    };
    for (const c of frag.children as ElementContent[]) {
      if (c.type === "element" && isStyled(c)) {
        flush();
        for (const img of imgsIn(c)) imgRef(img, locale);
        for (const s of selectAll("source[srcset]", c)) srcsetPaths(attr(s, "srcSet")!, locale);
        doc.children.push({ type: "rawHtml", html: rewriteUrls(outerHtml(c)), reason: "styled markup" });
      } else buf.push(c);
    }
    flush();
    return doc;
  };
  /** absolute same-origin URLs in kept HTML -> paths; /__ext/ -> original URLs */
  const rewriteUrls = (html: string): string => {
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return html.replace(new RegExp(`${esc}/__ext/([^/"'\\s]+)`, "g"), "https://$1").replace(/(["'(\s])\/__ext\/([^/"'\s]+)/g, "$1https://$2").replace(new RegExp(`${esc}(?=/)`, "g"), "");
  };
  /** inner HTML when the element carries semantic inline markup (<i>, <em>, <strong>, <span class>, <sup>…); icons (svg) and empty wrappers are template decoration */
  const inlineHtml = (el: Element): string | undefined => {
    const strip = (e: Element): Element => ({
      ...e,
      children: e.children
        .filter((c) => !(c.type === "element" && (c.tagName === "svg" || c.tagName === "img" || (!text(c) && c.tagName !== "br"))))
        .map((c) => (c.type === "element" ? strip(c) : c)),
    });
    const clean = strip(el);
    let semantic = false;
    walk(clean, (e) => {
      if (/^(i|em|b|strong|u|s|sup|sub|abbr|small|mark|a|code|q|cite)$/.test(e.tagName) || classes(e).length || (e.tagName === "br" && text(clean))) semantic = true;
      return !semantic;
    });
    if (!semantic) return undefined;
    return rewriteUrls(innerHtml(clean).replace(/\s+/g, " ").trim());
  };

  const linkValue = (a: Element | undefined, labelSel?: string): Record<string, unknown> | undefined => {
    if (!a) return undefined;
    const href = attr(a, "href") ?? "";
    if (!href || href === "#") return undefined;
    const ref = resolveLink(href);
    const labelEl = labelSel ? select(labelSel, a) : undefined;
    const label = labelEl ? text(labelEl) : text(a);
    const out: Record<string, unknown> = { href: linkHref(href) };
    if (ref) out.ref = ref;
    if (label) out.label = label;
    if (attr(a, "target") && attr(a, "target") !== "_self") out.target = attr(a, "target");
    return out;
  };

  /** counter: running index over all componentList fields of the owning entity (keeps section ids unique) */
  type Ctx = { p: ParsedPage; ownerKey: string; prefix: string; ccmOwner: string; counter: { n: number } };

  const fieldValues = (f: RawField, ct: ContentType, c: Ctx): [string, unknown][] => {
    const { p } = c;
    const locale = p.locale;
    const ectx = pctx.get(p)!;
    const meta: Record<string, unknown> = f.inferred ? { inferred: true, ...(f.slot ? { selector: f.slot.sel } : {}) } : { drupalField: f.drupalName.replace(/-/g, "_"), drupalType: f.drupalType };
    const ref = `${c.ccmOwner}:${locale}#${f.id}`;
    switch (f.kind) {
      case "text": {
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "text", localized: true, sourceMeta: meta });
        const out: [string, unknown][] = [[f.id, text(f.el)]];
        const h = inlineHtml(f.el);
        if (h && f.inferred) {
          ensureField(ct, { id: `${f.id}Html`, name: `${humanize(f.id)} (HTML)`, type: "text", localized: true, sourceMeta: { ...meta, inlineMarkup: true } });
          out.push([`${f.id}Html`, h]);
        }
        return out;
      }
      case "richText": {
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "richText", localized: true, sourceMeta: meta });
        const items = childElements(f.el).filter((x) => classes(x).includes("field__item") || (classes(x).includes("field--item") && !fieldInfo(x)));
        const html = items.length && !classes(f.el).includes("field--item") ? items.map(innerHtml).join("\n") : innerHtml(f.el);
        return [[f.id, richText(html, locale, ref)]];
      }
      case "link": {
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "link", localized: true, sourceMeta: meta });
        const a = f.el.tagName === "a" ? f.el : select("a", f.el);
        const v = linkValue(a, f.slot?.labelSel);
        return v ? [[f.id, v]] : [];
      }
      case "links": {
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "link", localized: true, cardinality: -1, sourceMeta: meta });
        const vs = (f.els ?? [f.el]).flatMap((e) => (e.tagName === "a" ? [e] : selectAll("a", e))).map((a) => linkValue(a, f.slot?.labelSel)).filter(Boolean);
        return [[f.id, vs]];
      }
      case "textList":
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "text", localized: true, cardinality: -1, sourceMeta: meta });
        return [[f.id, (f.els ?? [f.el]).map((e) => text(e)).filter(Boolean)]];
      case "asset":
      case "assets": {
        const imgs = (f.els ?? [f.el]).flatMap(imgsIn);
        const multi = f.kind === "assets" || imgs.length > 1;
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "reference", allowedTypes: ["asset"], cardinality: multi ? -1 : 1, sourceMeta: meta });
        const refs = imgs.map((i) => imgRef(i, locale)).filter(Boolean);
        const out: [string, unknown][] = [[f.id, multi ? refs : refs[0]]];
        if (!multi && imgs[0]) {
          const r = responsiveOf(imgs[0], ectx, locale);
          if (r) {
            ensureField(ct, { id: `${f.id}Sources`, name: `${humanize(f.id)} responsive sources`, type: "json", sourceMeta: { responsive: true } });
            out.push([`${f.id}Sources`, r]);
          }
        }
        return refs.length ? out : [];
      }
      case "bgImage": {
        const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(attr(f.el, "style") ?? "");
        if (!m || !m[1]) return [];
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "reference", allowedTypes: ["asset"], sourceMeta: meta });
        const r = registerAsset(m[1], locale);
        return r ? [[f.id, r]] : [];
      }
      case "html":
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "text", localized: true, sourceMeta: { ...meta, html: true } });
        return [[f.id, rewriteUrls(outerHtml(f.el))]];
      case "json": {
        const raw = f.el.children.map((x) => ("value" in x ? String(x.value) : "")).join("");
        try {
          const fix = (x: unknown): unknown => {
            if (typeof x === "string") {
              if (!/^(https?:)?\/\//.test(x) && !x.startsWith("/")) return x;
              const h = linkHref(x);
              if (h.startsWith("/") && /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(h.split("?")[0])) registerAsset(h, locale);
              return h;
            }
            if (Array.isArray(x)) return x.map(fix);
            if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fix(y)]));
            return x;
          };
          const v = fix(JSON.parse(raw));
          ensureField(ct, { id: f.id, name: humanize(f.id), type: "json", sourceMeta: meta });
          return [[f.id, v]];
        } catch {
          return [];
        }
      }
      case "list": {
        const spec = f.slot?.item ?? { text: "text" };
        const item = (el: Element, sp: ListItemSpec): Record<string, unknown> => {
          const o: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(sp)) {
            if (typeof v !== "string") o[k] = selectAll(v.sel, el).map((x) => item(x, v.item));
            else if (v === "text") o[k] = text(el);
            else if (v === "img") {
              const img = el.tagName === "img" ? el : select("img", el);
              const r = img ? imgRef(img, locale) : undefined;
              if (img && r) o[k] = { ...r, src: linkHref(attr(img, "src") ?? ""), ...(attr(img, "alt") ? { alt: attr(img, "alt") } : {}) };
            } else if (v.startsWith("#@")) {
              const n = Number(el.properties?.[toProp(v.slice(2))]);
              if (Number.isFinite(n)) o[k] = n;
            } else if (v.startsWith("@")) {
              const a = el.properties?.[toProp(v.slice(1))];
              if (a !== undefined && a !== null) o[k] = Array.isArray(a) ? a.join(" ") : String(a);
            } else if (v.startsWith("?")) o[k] = classes(el).includes(v.slice(1));
            else o[k] = text(select(v, el));
          }
          return o;
        };
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "json", sourceMeta: { ...meta, list: spec } });
        return [[f.id, (f.els ?? [f.el]).map((e) => item(e, spec))]];
      }
      case "classes":
        ensureField(ct, { id: f.id, name: "CSS classes", type: "text", sourceMeta: meta });
        return [[f.id, f.value ?? classes(f.el).join(" ")]];
      case "value":
        ensureField(ct, { id: f.id, name: humanize(f.id), type: typeof f.value === "boolean" ? "boolean" : "text", sourceMeta: meta });
        return [[f.id, f.value]];
      case "date": {
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "date", sourceMeta: meta });
        return [[f.id, attr(select("time[datetime]", f.el) ?? f.el, "dateTime") ?? text(f.el)]];
      }
      case "termRefs": {
        const tax = f.id.replace(/s$/, "") === "tag" ? "tags" : f.id;
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "reference", allowedTypes: [`term:${tax}`], cardinality: -1, sourceMeta: meta });
        return [
          [
            f.id,
            selectAll("a[href]", f.el).map((a) => {
              const path = pathOf(attr(a, "href")!, base)!;
              const key = resolvePathKey(path) ?? path;
              taxFields.set(key, tax);
              return { kind: "term" as const, id: termCcmId(key) };
            }),
          ],
        ];
      }
      case "entryRefs": {
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "reference", cardinality: -1, sourceMeta: meta });
        return [
          [
            f.id,
            selectAll("a[href]", f.el)
              .map((a) => resolveLink(attr(a, "href")!))
              .filter(Boolean),
          ],
        ];
      }
      case "collection": {
        const v = f.view!;
        const cid = collectionId(v.id, v.display);
        ensureField(ct, { id: "collection", name: "Collection", type: "json", sourceMeta: { ...meta, view: `${v.id}.${v.display}` } });
        if (!collections.has(cid)) collections.set(cid, inferCollection(v, cid, false));
        return [["collection", collectionFieldValue(cid)]];
      }
      case "componentList": {
        const allowed = new Set<string>();
        const refs: Reference[] = [];
        (f.sections ?? []).forEach((s) => {
          const i = c.counter.n++;
          const idx = c.prefix ? `${c.prefix}.${i}` : String(i);
          const native = s.pid && s.entity === "paragraph" ? `drupal:paragraph:${s.pid}` : undefined;
          const id = native && !usedSectionIds.has(`${native}|${c.p.locale}`) ? native : sectionCcmId(c.ownerKey, idx);
          usedSectionIds.add(`${id}|${c.p.locale}`);
          allowed.add(s.type);
          buildSection(s, id, { ...c, prefix: idx, ccmOwner: id, counter: { n: 0 } });
          refs.push({ kind: "entry", id });
        });
        ensureField(ct, { id: f.id, name: humanize(f.id), type: "componentList", cardinality: -1, allowedTypes: [...allowed].sort(), sourceMeta: meta });
        return [[f.id, refs]];
      }
    }
  };

  const buildSection = (s: RawDoc, id: string, c: Ctx) => {
    const { p } = c;
    const ct = ensureType(s.type, "component", s.entity === "node" ? { entity: "node", viewMode: s.bundle, inferred: true } : { paragraphType: s.bundle, ...(s.entity === "item" ? { entity: "item", inferred: true } : {}) });
    const fields: Record<string, unknown> = {};
    if (s.type === "sectionGeneric" && s.el && s.bundle === "generic" && !s.pid && !s.fields.length) {
      ensureField(ct, { id: "heading", name: "Heading", type: "text", localized: true });
      ensureField(ct, { id: "body", name: "Body", type: "richText", localized: true });
      ensureField(ct, { id: "html", name: "Original HTML", type: "text", localized: true });
      const h = select("h1, h2, h3, h4", s.el);
      if (h) fields.heading = text(h);
      fields.body = richText(outerHtml(s.el), p.locale, `${id}:${p.locale}#body`);
      fields.html = rewriteUrls(outerHtml(s.el));
      ct.sourceMeta = { ...ct.sourceMeta, generic: true };
    }
    for (const f of s.fields) for (const [k, v] of fieldValues(f, ct, c)) if (v !== undefined) fields[k] = v;
    if ((s.leftovers?.length || s.keepHtml) && s.el && fields.html === undefined) {
      ensureField(ct, { id: "html", name: "Original HTML", type: "text", localized: true, sourceMeta: { fallback: true } });
      fields.html = rewriteUrls(outerHtml(s.el));
      if (s.leftovers?.length)
        issues.push({
          severity: "warning",
          code: "SECTION_TEXT_UNMAPPED",
          message: `${s.type} on ${p.manifest.path}: ${s.leftovers.length} text chunk(s) not mapped to fields, kept in \`html\`: ${s.leftovers
            .slice(0, 3)
            .map((t) => JSON.stringify(t.slice(0, 40)))
            .join(", ")}`,
          ref: id,
          actionable: true,
        });
    }
    entries.push(
      EntrySchema.parse({
        ccmId: id,
        type: s.type,
        locale: p.locale,
        status: "published",
        fields,
        source: { system: "html", kind: s.entity ?? "paragraph", id: s.pid ?? `${p.key}#${c.prefix}`, bundle: s.bundle, url: p.manifest.finalUrl + (s.el && attr(s.el, "id") ? `#${attr(s.el, "id")}` : "") },
      }),
    );
  };

  const slugOf = (path: string) => {
    const l = locales.find((x) => x.pathPrefix && (path === `/${x.pathPrefix}` || path.startsWith(`/${x.pathPrefix}/`)));
    const rest = l ? path.slice(l.pathPrefix.length + 1) : path;
    const segs = rest.split("/").filter(Boolean);
    return segs.length ? segs[segs.length - 1] : "";
  };

  /** own `time[datetime]` of a node (page header / node meta), not inside sections or listings */
  const nodeDate = (el: Element): { field: string; value: string } | undefined => {
    let found: Element | undefined;
    walk(el, (e) => {
      if (found) return false;
      if (e !== el && (entityRoot(e, ps) || isBoundary(e, ps))) return false;
      if (e.tagName === "time" && attr(e, "dateTime")) {
        found = e;
        return false;
      }
      return true;
    });
    if (!found) return undefined;
    return { field: /publish/i.test(attr(found, "ariaLabel") ?? "") ? "publishedAt" : "created", value: attr(found, "dateTime")! };
  };

  // ---- documents
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const typesInGroup = new Set([...g.values()].map((p) => p.doc!.type));
    if (typesInGroup.size > 1) issues.push({ severity: "error", code: "TRANSLATION_TYPE_MISMATCH", message: `${key}: translations have different templates ${[...typesInGroup].join(", ")}`, ref: key, actionable: true });
    for (const p of [...g.values()].sort((a, b) => codes.indexOf(a.locale) - codes.indexOf(b.locale))) {
      const d = p.doc!;
      const ct = ensureType(d.type, "document", { bundle: d.bundle });
      ct.displayField = "title";
      ensureField(ct, { id: "title", name: "Title", type: "text", required: true, localized: true, sourceMeta: { drupalField: "title" } });
      const fields: Record<string, unknown> = { title: p.info.pageTitle ?? p.info.meta.og?.["og:title"] ?? p.info.title ?? key };
      if (p.info.pageTitleHtml && d.bundle) {
        ensureField(ct, { id: "titleHtml", name: "Title (HTML)", type: "text", localized: true, sourceMeta: { inferred: true, inlineMarkup: true } });
        fields.titleHtml = rewriteUrls(p.info.pageTitleHtml);
      }
      const c: Ctx = { p, ownerKey: key, prefix: "", ccmOwner: docId(key), counter: { n: 0 } };
      for (const f of d.fields) for (const [k, v] of fieldValues(f, ct, c)) if (v !== undefined) fields[k] = v;
      const date = d.el ? nodeDate(d.el) : undefined;
      if (date && !(date.field in fields) && d.type !== "landingPage") {
        ensureField(ct, { id: date.field, name: humanize(date.field), type: "date", sourceMeta: { drupalField: date.field === "created" ? "created" : "published_at" } });
        fields[date.field] = date.value;
      }
      for (const img of [p.info.meta.og?.["og:image"], p.info.meta.twitter?.["twitter:image"]]) {
        const ip = img ? pathOrOrigin(img) : undefined;
        if (ip) registerAsset(ip, p.locale);
      }
      entries.push(
        EntrySchema.parse({
          ccmId: docId(key),
          type: d.type,
          locale: p.locale,
          path: p.manifest.path,
          slug: slugOf(p.manifest.path),
          status: "published",
          fields,
          meta: p.info.meta,
          source: { system: "html", kind: "page", id: p.info.drupal.nid ? `node/${p.info.drupal.nid}` : p.manifest.path, bundle: d.bundle, url: p.manifest.finalUrl },
        }),
      );
    }
  }

  // ---- block content entries
  const blockPlacements: { id: string; ref: Reference; region?: string; title?: string; paths: string[] }[] = [];
  for (const [bid, m] of [...blockDocs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ccmId = blockCcmId(bid);
    let first: { region?: string; title?: string } | undefined;
    for (const [locale, x] of [...m.entries()].sort(([a], [b]) => codes.indexOf(a) - codes.indexOf(b))) {
      first ??= x;
      const ct = ensureType("blockContent", "component", { entity: "block_content" });
      ct.displayField = "title";
      ensureField(ct, { id: "title", name: "Title", type: "text", localized: true, sourceMeta: { drupalField: "info" } });
      const fields: Record<string, unknown> = {};
      if (x.title) fields.title = x.title;
      const c: Ctx = { p: x.p, ownerKey: `block:${bid}`, prefix: "", ccmOwner: ccmId, counter: { n: 0 } };
      for (const f of x.doc.fields) for (const [k, v] of fieldValues(f, ct, c)) if (v !== undefined) fields[k] = v;
      entries.push(EntrySchema.parse({ ccmId, type: "blockContent", locale, status: "published", fields, source: { system: "html", kind: "block_content", id: bid, url: x.p.manifest.finalUrl } }));
    }
    blockPlacements.push({ id: bid, ref: { kind: "entry", id: ccmId }, region: first?.region, title: first?.title, paths: [...(blockPages.get(bid) ?? [])].sort() });
  }

  // ---- partial entries from teasers of pages that were not crawled
  for (const [key, m] of [...teaserStubs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [locale, t] of [...m.entries()].sort(([a], [b]) => codes.indexOf(a) - codes.indexOf(b))) {
      const ct = ensureType(t.type, "document");
      ct.displayField = "title";
      ensureField(ct, { id: "title", name: "Title", type: "text", required: true, localized: true, sourceMeta: { drupalField: "title" } });
      const fields: Record<string, unknown> = { title: t.title };
      if (t.img) {
        ensureField(ct, { id: "image", name: "Image", type: "reference", allowedTypes: ["asset"], sourceMeta: { drupalField: "field_image" } });
        fields.image = imgRef(t.img, locale);
      }
      if (t.created) {
        const df = t.dateField ?? "created";
        ensureField(ct, { id: df, name: humanize(df), type: "date", sourceMeta: { drupalField: df === "created" ? "created" : df.replace(/[A-Z]/g, (x) => `_${x.toLowerCase()}`) } });
        fields[df] = t.created;
      }
      entries.push(
        EntrySchema.parse({
          ccmId: docId(key),
          type: t.type,
          locale,
          path: t.path,
          slug: slugOf(t.path),
          status: "published",
          fields,
          source: { system: "html", kind: "teaser", id: t.path, bundle: t.type, url: base + t.path },
        }),
      );
    }
    issues.push({ severity: "info", code: "PARTIAL_ENTRY_FROM_TEASER", message: `${key} [${[...m.keys()].join(", ")}] was not crawled; entry built from its teaser (title, image, date only) — add it to site.urls or enable crawl.follow`, ref: docId(key) });
  }

  // ---- views pages -> collections
  for (const p of parsed.filter((x) => (x.info.template.startsWith("view:") || x.info.template === "taxonomy_term") && x.info.main)) {
    const v = select(".view[class*='view-id-']", p.info.main!);
    if (!v) continue;
    const cls = classes(v);
    const view = { id: cls.find((c) => c.startsWith("view-id-"))!.slice(8), display: cls.find((c) => c.startsWith("view-display-id-"))?.slice(16) ?? "page", rows: teasersOf(v, base) };
    const cid = collectionId(view.id, view.display);
    const isNew = !collections.has(cid);
    if (isNew) {
      const c = inferCollection(view, cid, true);
      c.source = { system: "html", kind: "view", id: `${view.id}.${view.display}`, url: p.key };
      if (p.info.template === "taxonomy_term") {
        // contextual filter: the term of the page being rendered
        const ct = types.get(c.type);
        const termField = ct?.fields.find((f) => f.allowedTypes?.some((a) => a.startsWith("term:")));
        c.filters = [{ field: termField?.id ?? "tags", op: "contains", value: "{{currentTerm}}" }];
        c.source.url = undefined;
      }
      collections.set(cid, c);
    }
    const c = collections.get(cid)!;
    if (p.info.template !== "taxonomy_term") {
      // the generator renders the name as the page title; a collection first seen as an embedded block gets it too
      const name = listingPageName(p.info);
      if (name && (isNew || c.name === defaultCollectionName(view))) c.name = name;
      if (!isNew && c.type === "page" && view.rows.some((r) => r.type)) c.type = inferCollection(view, cid, true).type;
    }
    // a crawled Views PAGE display is routable: its crawled path per locale (incl. prefix; the front page stays "/<prefix>")
    if (p.info.template !== "taxonomy_term" && p.locale && !(p.locale in (c.path ?? {}))) c.path = { ...(c.path ?? {}), [p.locale]: p.manifest.path };
  }

  // ---- taxonomies
  const taxonomies = new Map<string, Taxonomy>();
  for (const [key, m] of [...termKeys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const tax = taxFields.get(key) ?? (key.split("/").filter(Boolean)[0] || "tags");
    const t = taxonomies.get(tax) ?? { id: tax, name: humanize(tax), hierarchical: false, terms: [], source: { system: "html", kind: "vocabulary", id: tax } };
    const term: Term = {
      ccmId: termCcmId(key),
      name: Object.fromEntries([...m.entries()].map(([l, v]) => [l, v.name])),
      slug: Object.fromEntries([...m.entries()].map(([l, v]) => [l, slugOf(v.path)])),
      source: { system: "html", kind: "taxonomy_term", id: key, url: base + key },
    };
    t.terms.push(term);
    taxonomies.set(tax, t);
  }

  // ---- navigation (paired by position across locales)
  const navigation: Navigation[] = [];
  const menuContent: Record<string, Record<string, unknown>> = {};
  const pageByLocale = new Map<string, ParsedPage>();
  for (const l of codes) {
    const best = parsed.filter((p) => p.locale === l).sort((a, b) => (b.info.menus.main?.length ?? 0) - (a.info.menus.main?.length ?? 0))[0];
    if (best) pageByLocale.set(l, best);
  }
  const defPage = pageByLocale.get(defaultCode);
  const menuIds = [...new Set([...pageByLocale.values()].flatMap((p) => Object.keys(p.info.menus)))].sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));
  const navHref = (it: MenuItemInfo): string | undefined => (it.href ? (it.path !== undefined ? linkHref(it.href) : unExt(it.href)) : undefined);
  for (const menuId of menuIds) {
    const build = (items: MenuItemInfo[], perLocale: Map<string, MenuItemInfo[]>, prefix: string): NavItem[] =>
      items.map((it, i) => {
        const id = `${menuId}:${prefix}${i}`;
        const label: Record<string, string> = {};
        const childLists = new Map<string, MenuItemInfo[]>();
        for (const [l, list] of perLocale) {
          if (list[i]) {
            label[l] = list[i].label;
            childLists.set(l, list[i].children);
          }
        }
        const ref = it.path ? resolveLink(it.href) : undefined;
        const nav: NavItem = { id, label, weight: i, children: build(it.children, childLists, `${prefix}${i}.`) };
        if (ref?.kind === "entry") nav.ref = ref;
        const href = navHref(it);
        if (href && !nav.ref) nav.href = href;
        else if (href && nav.ref && href.includes("?")) nav.href = href;
        if (it.extra) {
          const x: Record<string, unknown> = {};
          const loc = defaultCode;
          if (it.extra.image) x.image = imgRef(it.extra.image, loc);
          if (it.extra.icon) x.icon = imgRef(it.extra.icon, loc);
          if (it.extra.textHtml) x.text = richText(it.extra.textHtml, loc, `navigation:${id}`);
          if (it.extra.goto) x.goto = { label: it.extra.goto.label, href: linkHref(it.extra.goto.href) };
          if (it.extra.linkClasses) x.linkClasses = it.extra.linkClasses.join(" ");
          if (it.extra.heading) x.heading = true;
          if (Object.keys(x).length) menuContent[id] = x;
        }
        return nav;
      });
    const defItems = defPage?.info.menus[menuId] ?? [];
    const per = new Map<string, MenuItemInfo[]>();
    for (const [l, p] of pageByLocale) if (p.info.menus[menuId]) per.set(l, p.info.menus[menuId]);
    const mi = defPage?.info.menuInfo.find((m) => m.id === menuId);
    navigation.push(
      NavigationSchema.parse({
        id: menuId,
        name: menuId === "main" ? "Main navigation" : (mi?.title ?? humanize(menuId)),
        items: build(defItems, per, ""),
        source: { system: "html", kind: "menu", id: menuId, ...(mi?.region ? { bundle: mi.region } : {}) },
      }),
    );
  }
  // composite footer navigation (workplan id "footer"): one group per footer menu, in page order
  if (!navigation.some((n) => n.id === "footer") && defPage) {
    const footerMenus = defPage.info.menuInfo.filter((m) => m.region && /footer/.test(m.region));
    if (footerMenus.length) {
      navigation.push(
        NavigationSchema.parse({
          id: "footer",
          name: "Footer",
          items: footerMenus.map((m, i) => {
            const src = navigation.find((n) => n.id === m.id)!;
            return { id: `footer:${i}`, label: { [defaultCode]: m.title ?? humanize(m.id) }, weight: i, children: src.items };
          }),
          source: { system: "html", kind: "menu", id: "footer", bundle: footerMenus.map((m) => `${m.region}:${m.id}`).join(",") },
        }),
      );
      for (const n of navigation.find((x) => x.id === "footer")!.items) menuContent[n.id] = { heading: true, menu: footerMenus[Number(n.id.slice(7))].id, region: footerMenus[Number(n.id.slice(7))].region };
    }
  }

  // ---- redirects
  const redirects: Redirect[] = input.redirects
    .filter((r) => r.from !== r.to)
    .map((r) => RedirectSchema.parse({ from: r.from, to: r.to, status: [301, 302, 307, 308].includes(r.status) ? r.status : 301, locale: localeOfPath(r.from), source: { system: "html", kind: "redirect", id: r.from } }));
  // URLs a page publishes for itself that were not crawled — its canonical / own-locale hreflang path (bmw.de
  // /de/index.html says canonical /de/home.html, and its logo links there) — and the site root when no page lives at
  // it (/ → first configured page). The crawl only records redirects the source answered; a partial capture answers
  // 404 for them, so they are added here and links to them keep working on the generated site.
  const crawledPaths = new Set(parsed.map((p) => p.manifest.path));
  const addAlias = (from: string | undefined, to: string) => {
    if (!from || from === to || crawledPaths.has(from) || redirects.some((r) => r.from === from)) return;
    redirects.push(RedirectSchema.parse({ from, to, status: 301, locale: localeOfPath(from), source: { system: "html", kind: "redirect", id: from } }));
  };
  for (const p of parsed) {
    const own = [p.info.meta.canonical ? pathOrOrigin(p.info.meta.canonical) : undefined, ...(p.info.meta.hreflang ?? []).filter((h) => h.locale === p.locale).map((h) => pathOrOrigin(h.href))];
    for (const from of own) addAlias(from, p.manifest.path);
  }
  const start = (input.urls ?? []).map((u) => pathOf(u, base) ?? u)[0];
  if (start && crawledPaths.has(start)) addAlias("/", start);

  // ---- settings
  const siteName: Record<string, string> = {};
  const footerText: Record<string, string> = {};
  const slogan: Record<string, string> = {};
  for (const [l, p] of pageByLocale) {
    if (p.info.siteName) siteName[l] = p.info.siteName;
    if (p.info.footerText) footerText[l] = p.info.footerText;
    if (p.info.slogan) slogan[l] = p.info.slogan;
  }
  if (!Object.keys(siteName).length) siteName[defaultCode] = input.siteName ?? new URL(base).host;
  const logoRef = defPage?.info.logo ? registerAsset(defPage.info.logo.src, defaultCode, defPage.info.logo.alt, defPage.info.logo.width, defPage.info.logo.height) : undefined;
  for (const [l, p] of pageByLocale) if (p.info.logo && l !== defaultCode) registerAsset(p.info.logo.src, l, p.info.logo.alt);
  const scripts: NonNullable<SiteSettings["scripts"]> = [];
  const scriptId = (src: string): string => {
    const s = unExt(src);
    if (/cookie|consent|gdpr|onetrust|cookiebot/i.test(s)) return "cookie-consent";
    if (/googletagmanager|\/gtm\.js|google_tag\/js\/gtm/.test(s)) return "analytics-gtm";
    if (/google-analytics|gtag/.test(s)) return "analytics-ga";
    const file = basename(s.split("?")[0]).replace(/\.(min\.)?js$/, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
    return `script-${file || scripts.length + 1}`;
  };
  // site-level scripts: third-party, consent, analytics/tag modules, theme feature scripts — not Drupal core/aggregates (ported by design)
  for (const s of defPage?.info.scripts ?? []) {
    if (s.src) {
      const path = pathOf(s.src, base);
      const isConsent = /cookie|consent|gdpr|onetrust|cookiebot/i.test(s.src);
      const sameOriginFeature = !!path && !path.startsWith("/__ext/") && /^\/(modules|libraries)\//.test(path);
      if (!s.thirdParty && !isConsent && !sameOriginFeature && !path?.startsWith("/__ext/")) continue;
      const id = scriptId(s.src);
      if (scripts.some((x) => x.id === id)) continue;
      scripts.push({ id, src: path && !path.startsWith("/__ext/") ? linkHref(s.src) : unExt(s.src), placement: s.placement });
    } else if (s.inline && /dataLayer|gtag\(|googletagmanager/.test(s.inline) && !s.type) {
      const id = `inline-${/dataLayer_tags/.test(s.inline) ? "datalayer-tags" : /dataLayer\.push|dataLayer =/.test(s.inline) ? "datalayer" : "analytics"}`;
      if (!scripts.some((x) => x.id === id)) scripts.push({ id, inline: s.inline, placement: s.placement });
    }
  }
  const banner = defPage ? select("#cookie-banner, #sliding-popup, .cookie-banner, [class*=cookie-consent], #onetrust-banner-sdk", defPage.info.tree) : undefined;
  const bodyBlocks: Record<string, unknown>[] = [];
  for (const b of defPage?.info.blocks ?? []) {
    if (b.hasComponents) continue;
    const body = select(".field--name-body", b.el) ?? b.el;
    bodyBlocks.push({ id: b.id, region: b.region, ...(b.title ? { title: b.title } : {}), body: richText(innerHtml(body), defaultCode, `settings:block:${b.id}`), html: rewriteUrls(outerHtml(b.el)) });
  }
  const settings = SiteSettingsSchema.parse({
    siteName,
    baseUrl: origin ?? base,
    logo: logoRef,
    footerText: Object.keys(footerText).length ? footerText : undefined,
    seoDefaults: defPage?.info.meta.og?.["og:site_name"] ? { og: { "og:site_name": defPage.info.meta.og["og:site_name"] } } : undefined,
    scripts: scripts.length ? scripts : undefined,
    extra: {
      ...(Object.keys(slogan).length ? { slogan } : {}),
      ...(banner ? { cookieBanner: { selector: attr(banner, "id") ? `#${attr(banner, "id")}` : ".cookie-banner" } } : {}),
      generator: defPage ? attr(select("meta[name=Generator]", defPage.info.tree), "content") : undefined,
      ...(origin && origin !== base ? { crawlBaseUrl: base } : {}),
      ...(defPage?.info.drupal.theme ? { theme: defPage.info.drupal.theme } : {}),
      ...(defPage?.info.logo?.href ? { logoLink: linkHref(defPage.info.logo.href) } : {}),
      ...(defPage?.info.social.length
        ? { socialLinks: defPage.info.social.map((s) => ({ platform: s.platform, href: unExt(s.href), links: s.links.map((l) => ({ label: l.label, href: unExt(l.href) })) })) }
        : {}),
      ...(blockPlacements.length ? { blocks: blockPlacements } : {}),
      ...(bodyBlocks.length ? { textBlocks: bodyBlocks } : {}),
      ...(Object.keys(menuContent).length ? { menuContent } : {}),
      ...(defPage?.info.menuInfo.length ? { menus: defPage.info.menuInfo.map((m) => ({ id: m.id, title: m.title, ...(m.description ? { description: m.description } : {}), region: m.region })) } : {}),
      ...(defPage?.info.chromeBlocks.length ? { chromeBlocks: defPage.info.chromeBlocks.map((b) => ({ id: b.id, region: b.region, text: text(b.el), html: rewriteUrls(outerHtml(b.el)) })) } : {}),
      ...(defPage?.info.skipLink ? { skipLink: defPage.info.skipLink } : {}),
    },
  });

  for (const p of notDownloaded) issues.push({ severity: "warning", code: "ASSET_NOT_DOWNLOADED", message: `${p} was referenced but not downloaded`, ref: p });
  const fromRendered = parsed.filter((p) => p.contentSource === "rendered" && (input.contentSource ?? "raw") === "raw");
  if (fromRendered.length) issues.push({ severity: "info", code: "CONTENT_FROM_RENDERED_DOM", message: `content of ${fromRendered.map((p) => p.manifest.path).join(", ")} extracted from the rendered DOM (no raw server HTML, or the content is rendered client-side)` });

  // ---- finalize assets (Zod) and schema
  const assetList = [...assets.values()].sort((a, b) => a.ccmId.localeCompare(b.ccmId)).map((a) => AssetSchema.parse(a));
  const collectionList = [...collections.values()].sort((a, b) => a.id.localeCompare(b.id)).map((c) => CollectionSchema.parse(c));
  const taxList = [...taxonomies.values()].map((t) => TaxonomySchema.parse(t));
  const contentTypes = [...types.values()].sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "document" ? -1 : 1));
  entries.sort((a, b) => a.ccmId.localeCompare(b.ccmId) || codes.indexOf(a.locale) - codes.indexOf(b.locale));
  return { entries, assets: assetList, schema: { contentTypes }, taxonomies: taxList, navigation, redirects, locales, collections: collectionList, settings, issues };
}

function inferCollection(v: { id: string; display: string; rows: RawTeaser[] }, id: string, isPage: boolean): Collection {
  const dates = v.rows.map((r) => r.created).filter((d): d is string => !!d);
  const desc = dates.length > 1 && dates.every((d, i) => i === 0 || Date.parse(d) <= Date.parse(dates[i - 1]));
  const asc = dates.length > 1 && dates.every((d, i) => i === 0 || Date.parse(d) >= Date.parse(dates[i - 1]));
  // row entity type: the dominant bundle of the rows (first seen wins a tie)
  const counts = new Map<string, number>();
  for (const r of v.rows) if (r.type) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const type = [...counts].reduce<[string, number] | undefined>((best, cur) => (!best || cur[1] > best[1] ? cur : best), undefined)?.[0] ?? "page";
  const sortField = v.rows.find((r) => r.dateField)?.dateField ?? "created";
  return CollectionSchema.parse({
    id,
    name: defaultCollectionName(v),
    type,
    filters: [],
    sort: desc ? [{ field: sortField, direction: "desc" }] : asc ? [{ field: sortField, direction: "asc" }] : [],
    limit: isPage ? undefined : v.rows.length || undefined,
    pagination: isPage ? { pageSize: Math.max(10, v.rows.length) } : undefined,
    manual: false,
    source: { system: "html", kind: "view", id: `${v.id}.${v.display}` },
  });
}

/** page displays are named after the view ("Recipes"); block displays keep the display id to tell them apart */
const isPageDisplay = (display: string) => /^page(_\d+)?$/.test(display);
function defaultCollectionName(v: { id: string; display: string }): string {
  return isPageDisplay(v.display) ? humanize(v.id) : `${humanize(v.id)} (${v.display})`;
}

/** listing page name: the crawled page title (h1), else the head <title> without the site-name suffix */
export function listingPageName(info: { pageTitle?: string; title?: string; siteName?: string }): string | undefined {
  if (info.pageTitle) return info.pageTitle;
  const t = info.title?.trim();
  if (!t) return undefined;
  const parts = t.split(/\s+[|\u2013\u2014·-]\s+/);
  if (parts.length < 2) return info.siteName && t === info.siteName ? undefined : t;
  const last = parts[parts.length - 1];
  if (info.siteName && last.trim() !== info.siteName.trim()) return t;
  return parts.slice(0, -1).join(" | ").trim() || undefined;
}

function humanize(id: string): string {
  const s = id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function guessMime(p: string): string {
  const ext = p.split("?")[0].split(".").pop()?.toLowerCase();
  return (
    { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", pdf: "application/pdf" }[ext ?? ""] ??
    "application/octet-stream"
  );
}

// ------------------------------------------------------------------ step

export async function htmlToCcmStep(ctx: StepContext): Promise<StepReport> {
  const { ws, site } = ctx;
  const startedAt = new Date().toISOString();
  const crawl = await readCrawl(ws);
  if (!crawl) throw new Error("raw/html/crawl.json not found — run `migrate extract` with the html adapter first");
  const prof = await resolveProfileSet(ws, site, crawl, { themePack: (ctx.options as { themePack?: string }).themePack });
  const res = await buildCcm({
    profiles: prof.set,
    baseUrl: crawl.index.baseUrl || site.baseUrl,
    pages: crawl.pages,
    assets: crawl.assets,
    links: crawl.links,
    redirects: crawl.index.redirects,
    readText: (rel) => ws.readText(rel),
    siteLocales: site.locales,
    siteName: site.name,
    contentSource: (ctx.options as { contentSource?: "raw" | "rendered" }).contentSource,
    origin: crawl.index.origin,
    urls: site.urls,
  });
  const outputs: string[] = [];
  const out = async (rel: string, data: unknown) => {
    if (!ctx.dryRun) await ws.writeJson(rel, data);
    outputs.push(rel);
  };
  await out(Workspace.SCHEMA_PATH, res.schema);
  for (const e of res.entries) await out(ws.entryPath(e.type, e.ccmId, e.locale), e);
  for (const a of res.assets) await out(ws.assetPath(a.ccmId), a);
  for (const t of res.taxonomies) await out(ws.taxonomyPath(t.id), t);
  for (const n of res.navigation) await out(ws.navigationPath(n.id), n);
  for (const c of res.collections) await out(ws.collectionPath(c.id), c);
  await out(Workspace.REDIRECTS_PATH, res.redirects);
  await out(Workspace.LOCALES_PATH, res.locales);
  await out(Workspace.SETTINGS_PATH, res.settings);
  // prune files a previous run wrote but this one no longer produces (ids changed, sections removed) — otherwise
  // stale entries collide with the new ones (duplicate paths) and fail ccm.valid
  const pruned: string[] = [];
  if (!ctx.dryRun) {
    const keep = new Set(outputs);
    for (const dir of ["ccm/entries", "ccm/assets", "ccm/taxonomies", "ccm/navigation", "ccm/collections"]) {
      for (const f of await ws.list(dir, ".json").catch(() => [] as string[])) {
        if (keep.has(f)) continue;
        await rm(ws.path(f), { force: true });
        pruned.push(f);
      }
    }
  }
  res.issues.push(...prof.issues);
  // text coverage of the server HTML (report only, never changes ccm/): DOCUMENT_TEXT_UNMAPPED for page-level text
  // outside paragraphs and field-wrapper text the field value lacks (SECTION_TEXT_UNMAPPED covers the rest)
  let coverageRatio: number | undefined;
  let documentTextUnmapped = 0;
  if ((ctx.options as { coverage?: boolean }).coverage !== false) {
    const input = await loadCoverageInput(ws);
    const a = analyzeCoverage(input.pages, res.entries, prof.set, input.base, input.crawl.index.origin);
    const di = unmappedTextIssues(a);
    res.issues.push(...di);
    coverageRatio = a.coverage.ratio;
    documentTextUnmapped = di.length;
  }
  if (pruned.length) res.issues.push({ severity: "info", code: "CCM_STALE_PRUNED", message: `removed ${pruned.length} stale file(s) from a previous transform (e.g. ${pruned.slice(0, 3).join(", ")})` });
  const docs = res.entries.filter((e) => e.path);
  return {
    step: "transform",
    site: site.site,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !res.issues.some((i) => i.severity === "error"),
    dryRun: ctx.dryRun,
    stats: {
      adapter: "html",
      contentTypes: res.schema.contentTypes.length,
      entries: res.entries.length,
      documents: docs.length,
      sections: res.entries.length - docs.length,
      assets: res.assets.length,
      terms: res.taxonomies.reduce((n, t) => n + t.terms.length, 0),
      navigation: res.navigation.length,
      collections: res.collections.length,
      redirects: res.redirects.length,
      locales: res.locales.length,
      htmlFallbacks: res.issues.filter((i) => i.code === "SECTION_TEXT_UNMAPPED").length,
      pruned: pruned.length,
      themePack: prof.set.themePack,
      ...(coverageRatio !== undefined ? { textCoverage: coverageRatio, documentTextUnmapped } : {}),
      profileSources: prof.set.sources.join(" > "),
    },
    issues: res.issues,
    outputs,
  };
}
