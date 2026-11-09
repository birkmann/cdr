/**
 * Deterministic heuristic component miner (MIGRATION_PLAN.md §7.1 step 3–4).
 *
 * 1. Detect instances of recurring blocks on every page: chrome (header, main nav, language switcher, footer nav,
 *    footer, cookie banner, site-wide blocks), page title, document bodies (node full view + its component
 *    container), sections (paragraphs, custom `data-component` blocks, nested entities such as accordion items or
 *    node teasers in sliders), embedded media; generic landmarks/sections for non-Drupal markup.
 * 2. Turn each instance into a template: the ORIGINAL outer HTML (DOM, classes, data-attributes and whitespace
 *    preserved so the ported CSS + JS apply unchanged) with varying content replaced by Handlebars-subset
 *    placeholders. Drupal field markup names the props (field--name-field-title -> {{title}}), BEM elements of
 *    custom paragraph templates name the rest (statement__eyebrow -> {{eyebrow}}), repeated siblings become
 *    {{#each}} with a merged item template, nested entities become {{#each x}}{{{this.html}}}{{/each}}, the
 *    entity id inside ids/aria attributes becomes {{entityId}}, state classes become {{#if this.active}}.
 * 3. Dedupe instances across pages and locales: the token-level diff of instance templates turns remaining
 *    differences into props: locale-only differences -> i18n props ({{t.key}}), content differences between
 *    instances of the same locale -> content props, modifier classes sharing a prefix -> `cta-style-{{ctaStyle}}`,
 *    other class tokens -> boolean flags. Structurally different instances become variant components
 *    (`siteHeaderV2`, `pageTitleArticle`), each with its own template.
 * 4. Self-check: rendering the template with every instance's values must reproduce that instance's HTML. Values of
 *    every instance are kept (`instanceProps`, keyed by entity id or page path) so a renderer can fall back to the
 *    observed value of a prop the CCM entry does not carry.
 */
import type { Issue } from "@harness/mirror-core";
import { classifyField, dom, fieldInfo, fieldNameToId, machineName, paragraphToType, bundleToType, type PageInfo, type ProfileSet } from "@harness/mirror-capture";
import { renderTemplate } from "./render.js";

type Element = dom.Element;
type ElementContent = dom.ElementContent;
const { attr, classes, childElements, describe, innerHtml, outerHtml, select, selectAll, text, toHtml, parseFragment } = dom;

export type PropType = "text" | "richText" | "asset" | "link" | "list" | "html" | "reference";

export interface PropDef {
  name: string;
  type: PropType;
  ccmField?: string;
  /** html props rendered by another component (siteHeader -> mainNav) */
  component?: string;
  /** list props whose items are rendered by a component ({{{this.html}}}) */
  itemComponent?: string;
  /** list props: shape of each item ({ label: "text", url: "link", active: "boolean", children: "list" }) */
  itemFields?: Record<string, string>;
  /** "boolean" for state flags ({{#if visuallyHidden}}) */
  valueType?: "boolean";
  /** UI strings: value per locale */
  i18n?: Record<string, string>;
  /** dates: render `{{x.iso}}` and `{{x.formatted}}` = Intl.DateTimeFormat(locales[locale], options) */
  format?: {
    kind: "date";
    options: Intl.DateTimeFormatOptions;
    locales: Record<string, string>;
    /** PHP date() pattern the source printed with (Drupal date formats Intl can't express, e.g. "jS F Y"): rendered by
     *  `formatPhpDate` (php-date.ts) instead of Intl options; `case` = name case per locale */
    pattern?: string;
    case?: Record<string, "title">;
  };
  /** value derived from the bound entry instead of a field: "ccmIdTail" = last `:` segment of the entry ccmId (Drupal pid/nid) */
  derive?: "ccmIdTail";
  /** rich text whose original markup has no block element (text, <br>, inline tags directly in the container):
   * render the single top-level paragraph's children WITHOUT the <p> wrapper */
  inline?: boolean;
  /** text prop bound to a CCM rich text field: render the field's plain text (set by the CCM reconciliation) */
  plainText?: boolean;
  /** list prop rendering the rows of an embedded Views block (`view-id-<v> view-display-id-<d>` around it): the CCM
   *  collection `<v>--<d>` (set by the CCM reconciliation); the app runs it for the page's entry (contextual filters) */
  collection?: string;
  /** how the source printed the bound number/enum value, per locale (set by the CCM reconciliation from the crawled
   *  instances): `affix` = [prefix, suffix] around a number ("40" → "40 minutes"), `labels` = enum key → label
   *  ("medium" → "Medium" / "Medio") */
  display?: { affix?: Record<string, [string, string]>; labels?: Record<string, Record<string, string>> };
}

export interface ComponentDef {
  id: string;
  name: string;
  selector: string;
  kind: "chrome" | "section" | "document";
  ccmType?: string;
  viewMode?: string;
  template: string;
  props: PropDef[];
  exampleHtml: string;
  /** values of the canonical instance — renderTemplate(template, exampleProps) reproduces exampleHtml */
  exampleProps: Record<string, unknown>;
  source: "heuristic" | "llm";
  instances: number;
  pages: string[];
  locales: string[];
  verified: boolean;
  /** structural variant of `variantOf` (same role, different markup on some pages/content types) */
  variantOf?: string;
  /** how instanceProps are keyed: Drupal entity id (pid/nid) for entities, page path for chrome/document parts */
  instanceKey?: "entityId" | "path";
  /** observed values of every instance (render fallback for props the CCM does not provide) */
  instanceProps?: Record<string, Record<string, unknown>>;
  /** instances whose re-render matched their original HTML / all instances */
  instancesVerified?: number;
  /** the template could not generalise all instances: some content stays static (see issues) */
  degraded?: boolean;
}

export interface TemplateDef {
  contentType: string;
  layout: "default";
  chrome: string[];
  slots: { component: string; field?: string; repeat?: boolean; region?: string; props?: Record<string, unknown> }[];
  bodyClass?: string;
  /** main wrapper between header and footer; {{{regions.<name>}}} marks where slots of that region render */
  wrapperHtml?: string;
  /** UI strings of the wrapper (`{{t.<key>}}` in wrapperHtml): key -> value per locale, from crawled pages of the type in
   *  other locales (breadcrumb labels, static sidebar blocks); only present on multilingual sites */
  i18n?: Record<string, Record<string, string>>;
  examplePath?: string;
}

export interface LayoutDef {
  id: string;
  htmlAttrs: Record<string, string>;
  bodyAttrs: Record<string, string>;
  /** body inner HTML: {{{chrome.<id>}}}, {{{main}}} (= rendered content-type wrapperHtml), {{t.*}} */
  template: string;
  chrome: string[];
  props: PropDef[];
  exampleHtml: string;
  exampleProps: Record<string, unknown>;
  /** structurally different layouts observed on some pages: { id, pages, template, exampleProps } */
  variants?: { id: string; pages: string[]; template: string; props: PropDef[]; exampleProps: Record<string, unknown> }[];
  /** per page values when they differ from exampleProps */
  instanceProps?: Record<string, Record<string, unknown>>;
}

/** Per crawled page: which variant components and values were observed (renderer overrides for known paths). */
export interface PageDesign {
  contentType?: string;
  locale: string;
  bodyClass?: string;
  /** component id -> variant component id used on this page */
  components: Record<string, string>;
  layoutVariant?: string;
  /** this page's own slots/wrapper when they differ from its content-type template (extra static blocks, other regions) */
  template?: Pick<TemplateDef, "slots" | "wrapperHtml">;
}

export interface MinePage {
  path: string;
  locale: string;
  info: PageInfo;
  /** CCM type of the page's document entry (landingPage, page, article) or undefined for listings/other */
  ccmType?: string;
  /** server HTML before JS ran (used for JS-toggled chrome such as the cookie banner) */
  rawInfo?: PageInfo;
}

export interface MineResult {
  components: ComponentDef[];
  templates: TemplateDef[];
  layout?: LayoutDef;
  pages: Record<string, PageDesign>;
  issues: Issue[];
}

// ------------------------------------------------------------------ templating primitives

const T = (value: string): ElementContent => ({ type: "text", value });
const DROP_ATTRS = new Set(["dataParagraphId", "dataHistoryNodeId", "dataDrupalLinkSystemPath", "dataQuickeditEntityId", "dataQuickeditField"]);

class Tpl {
  props = new Map<string, PropDef>();
  values: Record<string, unknown> = {};
  raw: string[] = [];
  constructor(readonly locale: string) {}
  prop(def: PropDef, value?: unknown): void {
    if (!this.props.has(def.name)) this.props.set(def.name, def);
    else if (def.format && !this.props.get(def.name)!.format) this.props.get(def.name)!.format = def.format;
    if (value !== undefined) setPath(this.values, def.name, value);
  }
  /** unique prop name: reuse `base` when it already holds the same value, else base2, base3… */
  name(base: string, value: unknown): string {
    const v = JSON.stringify(value);
    for (let i = 1; ; i++) {
      const n = i === 1 ? base : `${base}${i}`;
      if (!this.props.has(n) && getPath(this.values, n) === undefined) return n;
      if (JSON.stringify(getPath(this.values, n)) === v) return n;
    }
  }
  rawAttr(props: Element["properties"], s: string): void {
    props[`dataCmpRaw${this.raw.length}`] = "x";
    this.raw.push(s);
  }
  /** pre-serialised template markup (e.g. a merged {{#each}} item) inserted verbatim on serialize */
  rawNode(html: string): Element {
    const el: Element = { type: "element", tagName: "cmp-raw", properties: { dataI: String(this.raw.length) }, children: [] };
    this.raw.push(html);
    return el;
  }
  serialize(node: Element | ElementContent[]): string {
    const html = Array.isArray(node) ? toHtml({ type: "root", children: node } as dom.Root) : toHtml(node);
    return html.replace(/ data-cmp-raw-?(\d+)="x"/g, (_, i) => this.raw[Number(i)]).replace(/<cmp-raw data-i="(\d+)"><\/cmp-raw>/g, (_, i) => this.raw[Number(i)]);
  }
}

function setPath(obj: Record<string, unknown>, path: string, v: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = v;
}
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

type Visit = (el: Element, copy: Element) => ElementContent[] | "recurse";

/** Deep-clone with transformation. `fn` may return replacement nodes or "recurse" (after mutating copy.properties). */
function mapTree(el: Element, fn: Visit): Element {
  const out = mapNode(el, fn);
  const first = out.find((n): n is Element => n.type === "element");
  if (!first) throw new Error(`mapTree: root <${el.tagName}> was replaced by non-element content`);
  return first;
}
function mapNode(el: Element, fn: Visit): ElementContent[] {
  const copy: Element = { type: "element", tagName: el.tagName, properties: { ...el.properties }, children: [] };
  for (const k of Object.keys(copy.properties)) if (DROP_ATTRS.has(k)) delete copy.properties[k];
  const r = fn(el, copy);
  if (r !== "recurse") return r;
  copy.children = mapChildren(el.children, fn);
  if (el.tagName === "template" && (el as Element & { content?: dom.Root }).content) (copy as Element & { content?: dom.Root }).content = structuredClone((el as Element & { content?: dom.Root }).content);
  return [copy];
}
function mapChildren(children: ElementContent[], fn: Visit): ElementContent[] {
  const out: ElementContent[] = [];
  for (const c of children) out.push(...(c.type === "element" ? mapNode(c, fn) : [structuredClone(c) as ElementContent]));
  return out;
}
const identity: Visit = () => "recurse";

function withChildren(copy: Element, children: ElementContent[]): ElementContent[] {
  copy.children = children;
  return [copy];
}

const WS = /^(\s*)([\s\S]*?)(\s*)$/;
function splitWs(s: string): [string, string, string] {
  const m = WS.exec(s)!;
  return [m[1], m[2], m[3]];
}
/** concatenated text of an element whose children are all text nodes (undefined otherwise) */
function ownText(el: Element): string | undefined {
  if (!el.children.length || !el.children.every((c) => c.type === "text" || c.type === "comment")) return undefined;
  return el.children.map((c) => (c.type === "text" ? c.value : "")).join("");
}
/** placeholder keeping the original leading/trailing whitespace */
function wsPlaceholder(raw: string, placeholder: string): ElementContent[] {
  const [lead, , trail] = splitWs(raw);
  return [T(`${lead}${placeholder}${trail}`)];
}

/** Innermost element holding all of el's text (descends while there is a single element child and no own text). */
function textHolderPath(el: Element): number[] {
  const path: number[] = [];
  let cur = el;
  for (;;) {
    const own = cur.children.some((c) => c.type === "text" && c.value.trim());
    const kids = cur.children.map((c, i) => [c, i] as const).filter(([c]) => c.type === "element");
    if (own || kids.length !== 1) return path;
    path.push(kids[0][1]);
    cur = kids[0][0] as Element;
  }
}
function replaceText(el: Element, copy: Element, placeholder: string): ElementContent[] {
  const path = textHolderPath(el);
  const holderText = (h: Element) => ownText(h);
  if (!path.length) {
    const t = holderText(el);
    return withChildren(copy, t !== undefined ? wsPlaceholder(t, placeholder) : [T(placeholder)]);
  }
  copy.children = el.children.map((c) => structuredClone(c) as ElementContent);
  let cur = copy;
  let orig = el;
  for (const i of path) {
    const next = cur.children[i] as Element;
    const nc: Element = { ...next, properties: { ...next.properties } };
    cur.children[i] = nc;
    cur = nc;
    orig = orig.children[i] as Element;
  }
  const t = holderText(orig);
  cur.children = t !== undefined ? wsPlaceholder(t, placeholder) : [T(placeholder)];
  return [copy];
}

const INLINE = new Set(["i", "em", "b", "strong", "br", "span", "sup", "sub", "abbr", "small", "u", "mark", "s", "a", "wbr"]);
/** element with text + inline formatting only (no block children), rendered as {{{html}}} */
function inlineOnly(el: Element): boolean {
  let ok = el.children.some((c) => (c.type === "text" && c.value.trim()) || c.type === "element");
  const walkIn = (e: Element) => {
    for (const c of e.children) {
      if (c.type !== "element") continue;
      if (!INLINE.has(c.tagName) || classes(c).some((x) => x.includes("__"))) ok = false;
      else walkIn(c);
    }
  };
  walkIn(el);
  return ok && !!text(el);
}

const BLOCK = new Set(["p", "div", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "figure", "section", "article", "pre", "hr", "dl"]);
/** container has block-level children (rich text renders paragraphs) */
function hasBlockContent(el: Element): boolean {
  return el.children.some((c) => c.type === "element" && BLOCK.has(c.tagName));
}

const camel = (s: string) => s.replace(/[-_]+([a-zA-Z0-9])/g, (_, x: string) => x.toUpperCase()).replace(/^[^a-zA-Z]+/, "");
const pascal = (s: string) => s.replace(/(^|[-_\s]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());
const camelClass = (c: string) => c.replace(/[-_]+([a-z0-9])/g, (_, x: string) => x.toUpperCase()).replace(/^[^a-zA-Z]+/, "");

/** BEM element name of an element: `statement__eyebrow` -> "eyebrow", `quick-facts__card-title` -> "cardTitle" */
function bemName(el: Element): string | undefined {
  const c = classes(el).find((x) => /^[a-z][\w-]*__[\w-]+$/.test(x) && !/--/.test(x.split("__")[1]));
  return c ? camel(c.split("__").pop()!) || undefined : undefined;
}
function bemBlock(el: Element): string | undefined {
  const c = classes(el).find((x) => /^[a-z][\w-]*__[\w-]+$/.test(x));
  return c?.split("__")[0];
}

// ------------------------------------------------------------------ dates

const DATE_CANDIDATES: Intl.DateTimeFormatOptions[] = [
  { day: "numeric", month: "long", year: "numeric" },
  { day: "2-digit", month: "2-digit", year: "numeric" },
  { day: "numeric", month: "short", year: "numeric" },
  { month: "short", day: "2-digit", year: "numeric" },
  { dateStyle: "medium" },
  { dateStyle: "long" },
  { dateStyle: "short" },
];
const LOCALE_TAGS: Record<string, string[]> = { en: ["en-GB", "en-US"], de: ["de-DE", "de-CH", "de-AT"], fr: ["fr-FR", "fr-CH"], it: ["it-IT"], es: ["es-ES"], nl: ["nl-NL"] };

export function detectDateFormat(iso: string, shown: string, locale: string): { tag: string; options: Intl.DateTimeFormatOptions } | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const tags = LOCALE_TAGS[locale.split("-")[0]] ?? [locale];
  // Drupal formats in the site timezone: try UTC first, then the offset written in the ISO string
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  const local = offset ? new Date(d.getTime() + (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60000) : undefined;
  for (const date of local ? [d, local] : [d])
    for (const options of DATE_CANDIDATES)
      for (const tag of [locale, ...tags]) {
        try {
          if (new Intl.DateTimeFormat(tag, { ...options, timeZone: "UTC" }).format(date) === shown.trim()) return { tag, options };
        } catch {
          /* invalid tag */
        }
      }
  return undefined;
}

// ------------------------------------------------------------------ list items (menus, switchers, term links)

interface ItemObs {
  li: Element;
  depth: number;
  data: { label: string; url: string; locale?: string; active: boolean; activeTrail: boolean; hasChildren: boolean };
}
type Rules = Map<string, Map<string, string>>; // position -> class -> rule ("static" | predicate name | "locale")

/** items of a link list: <li> of a <ul>/<ol>, or the `field__item` children of a Drupal `field__items` <div> (entity reference fields) */
function listItems(ul: Element): Element[] {
  const lis = childElements(ul).filter((c) => c.tagName === "li");
  if (lis.length || ul.tagName === "ul" || ul.tagName === "ol") return lis;
  return childElements(ul).filter(isFieldItem);
}

function itemData(li: Element, depth: number, out: ItemObs[]): ItemObs["data"] {
  const a = childElements(li).find((c) => c.tagName === "a") ?? select("a", li);
  const sub = childElements(li).find((c) => c.tagName === "ul" || c.tagName === "ol");
  const children = sub ? listItems(sub).map((c) => itemData(c, depth + 1, out)) : [];
  const active = !!a && (classes(a).includes("is-active") || attr(a, "ariaCurrent") === "page" || classes(li).includes("is-active"));
  const data = {
    label: text(a),
    url: attr(a, "href") ?? "",
    locale: attr(a, "hrefLang") ?? attr(li, "hrefLang"),
    active,
    activeTrail: active || children.some((c) => c.activeTrail),
    hasChildren: children.length > 0,
  };
  out.push({ li, depth, data });
  return data;
}

function collectItems(lists: Element[]): ItemObs[] {
  const out: ItemObs[] = [];
  for (const ul of lists) for (const li of listItems(ul)) itemData(li, 1, out);
  return out;
}

const PREDICATES: [string, (d: ItemObs["data"]) => boolean][] = [
  ["children", (d) => d.hasChildren],
  ["active", (d) => d.active],
  ["activeTrail", (d) => d.activeTrail],
];

function computeRules(obs: ItemObs[]): Rules {
  const rules: Rules = new Map();
  const positions = new Map<string, { el: Element | undefined; d: ItemObs["data"] }[]>();
  for (const o of obs) {
    const a = childElements(o.li).find((c) => c.tagName === "a") ?? select("a", o.li);
    for (const [pos, el] of [[`${o.depth}:li`, o.li], [`${o.depth}:a`, a]] as const) {
      const l = positions.get(pos) ?? [];
      l.push({ el, d: o.data });
      positions.set(pos, l);
    }
  }
  for (const [pos, list] of positions) {
    const r = new Map<string, string>();
    const all = new Set(list.flatMap((x) => classes(x.el)));
    for (const c of all) {
      const has = list.map((x) => classes(x.el).includes(c));
      if (has.every(Boolean)) r.set(c, "static");
      else if (list.every((x, i) => (x.d.locale === c) === has[i] || (!x.d.locale && !has[i])) && list.some((x) => x.d.locale === c)) r.set(c, "locale");
      else {
        const preds = /trail/.test(c) ? [...PREDICATES].sort(([a]) => (a === "activeTrail" ? -1 : 0)) : PREDICATES;
        const p = preds.find(([, f]) => list.every((x, i) => f(x.d) === has[i]));
        r.set(c, p ? p[0] : "drop");
      }
    }
    // aria-current follows the "active" state
    const aria = list.map((x) => attr(x.el, "ariaCurrent") === "page");
    if (aria.some(Boolean)) r.set("@aria-current", PREDICATES.find(([, f]) => list.every((x, i) => f(x.d) === aria[i]))?.[0] ?? "drop");
    rules.set(pos, r);
  }
  return rules;
}

function classTokens(cls: string[], rule: Map<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const c of cls) {
    const r = rule?.get(c) ?? "static";
    if (r === "static") out.push(c);
    else if (r === "locale") out.push("{{this.locale}}");
    else if (r !== "drop") out.push(`{{#if this.${r}}}${c}{{/if}}`);
  }
  for (const [c, r] of rule ?? []) if (!cls.includes(c) && !c.startsWith("@") && r !== "static" && r !== "drop" && r !== "locale") out.push(`{{#if this.${r}}}${c}{{/if}}`);
  return out;
}

/** Template an <ul>/<ol> of link items: {{#each <prop>}}<li …><a href="{{this.url}}">{{this.label}}</a>…{{/each}}. */
function templateList(tpl: Tpl, ul: Element, copy: Element, rules: Rules, depth: number, each: string): ElementContent[] {
  const items = listItems(ul);
  if (!items.length) return withChildren(copy, []);
  const rep = items.find((li) => childElements(li).some((c) => c.tagName === "ul" || c.tagName === "ol")) ?? items[0];
  const firstIdx = ul.children.indexOf(items[0]);
  const lastIdx = ul.children.indexOf(items[items.length - 1]);
  const before = ul.children.slice(0, firstIdx).map((c) => structuredClone(c) as ElementContent);
  const after = ul.children.slice(lastIdx + 1).map((c) => structuredClone(c) as ElementContent);
  const itemTpl = mapTree(rep, (el, c) => {
    if (el === rep) {
      applyItemAttrs(tpl, c, rules.get(`${depth}:li`), el);
      return "recurse";
    }
    if (el.tagName === "a" && (childElements(rep).includes(el) || select("a", rep) === el)) {
      applyItemAttrs(tpl, c, rules.get(`${depth}:a`), el);
      if (c.properties.href !== undefined) c.properties.href = "{{this.url}}";
      if (c.properties.hrefLang !== undefined) c.properties.hrefLang = "{{this.locale}}";
      return withChildren(c, [T("{{this.label}}")]);
    }
    if ((el.tagName === "ul" || el.tagName === "ol") && childElements(rep).includes(el)) {
      const inner = templateList(tpl, el, c, rules, depth + 1, "this.children");
      return [T("{{#if this.children}}"), ...inner, T("{{/if}}")];
    }
    return "recurse";
  });
  return withChildren(copy, [...before, T(`{{#each ${each}}}`), itemTpl, T("{{/each}}"), ...after]);
}

function applyItemAttrs(tpl: Tpl, c: Element, rule: Map<string, string> | undefined, el: Element): void {
  const cls = classes(el);
  if (cls.length || [...(rule ?? []).values()].some((r) => r !== "static" && r !== "drop")) c.properties.className = classTokens(cls, rule);
  if (c.properties.hrefLang !== undefined) c.properties.hrefLang = "{{this.locale}}";
  // Drupal core language links: <li data-drupal-language="es">
  if (c.properties.dataDrupalLanguage !== undefined) c.properties.dataDrupalLanguage = "{{this.locale}}";
  if (c.properties.ariaCurrent !== undefined || rule?.has("@aria-current")) {
    delete c.properties.ariaCurrent;
    const r = rule?.get("@aria-current");
    if (r && r !== "drop") tpl.rawAttr(c.properties, `{{#if this.${r}}} aria-current="page"{{/if}}`);
  }
}

interface ListValue {
  label: string;
  url: string;
  locale?: string;
  active: boolean;
  activeTrail: boolean;
  children: ListValue[];
}
function listValue(ul: Element): ListValue[] {
  return listItems(ul)
    .map((li) => {
      const d = itemData(li, 1, []);
      const sub = childElements(li).find((c) => c.tagName === "ul" || c.tagName === "ol");
      return { label: d.label, url: d.url, ...(d.locale ? { locale: d.locale } : {}), active: d.active, activeTrail: d.activeTrail, children: sub ? listValue(sub) : [] };
    });
}
const LIST_ITEM_FIELDS = { label: "text", url: "link", locale: "text", active: "boolean", activeTrail: "boolean", children: "list" };

// ------------------------------------------------------------------ entities (paragraphs / nodes / custom components)

const VIEW_MODE = /^node--view-mode-{1,2}([\w-]+)$/;
const SECTION_ID = /^section-(\d+)$/;

/** an embedded entity rendered by its own component (paragraph, custom data-component block, node teaser, pid-identified item) */
export function isEntity(el: Element): boolean {
  const cls = classes(el);
  if (cls.includes("paragraph") && cls.some((c) => c.startsWith("paragraph--type--"))) return true;
  if (attr(el, "dataComponent") !== undefined) return true;
  if (cls.some((c) => VIEW_MODE.test(c) && !/full$/.test(c))) return true;
  if (cls.includes("node--view-mode-teaser") || (cls.includes("node") && cls.includes("teaser"))) return true;
  return SECTION_ID.test(attr(el, "id") ?? "");
}

/** Drupal id of an entity element: paragraph id (`id="section-123"`), node id, or a numeric `data-*-uid` */
export function entityIdOf(el: Element): string | undefined {
  const m = SECTION_ID.exec(attr(el, "id") ?? "");
  if (m) return m[1];
  const nid = attr(el, "dataHistoryNodeId");
  if (nid && /^\d+$/.test(nid)) return nid;
  for (const [k, v] of Object.entries(el.properties)) if (/^data\w*(Uid|Pid|Nid)$/.test(k) && /^\d+$/.test(String(v))) return String(v);
  return undefined;
}

function hasCls(el: Element | undefined, ...names: string[]): boolean {
  const cls = classes(el);
  return names.some((n) => cls.includes(n));
}
const isFieldItems = (el: Element) => hasCls(el, "field__items", "field--items");
const isFieldItem = (el: Element) => hasCls(el, "field__item", "field--item");

function contentImage(src: string | undefined): boolean {
  return !!src && !src.startsWith("data:") && /\/(sites\/[^/]+\/files|files)\//.test(src);
}

function assetValue(img: Element) {
  const src = attr(img, "src");
  const dataSrc = attr(img, "dataSrc");
  return {
    url: (contentImage(dataSrc) || !contentImage(src) ? dataSrc : undefined) ?? src ?? "",
    alt: attr(img, "alt") ?? "",
    ...(attr(img, "title") !== undefined ? { title: attr(img, "title") } : {}),
    ...(attr(img, "width") ? { width: attr(img, "width") } : {}),
    ...(attr(img, "height") ? { height: attr(img, "height") } : {}),
    ...(attr(img, "srcSet") ? { srcset: attr(img, "srcSet") } : {}),
    ...(attr(img, "sizes") ? { sizes: attr(img, "sizes") } : {}),
    ...(attr(img, "dataSrcset") ? { srcset: attr(img, "dataSrcset") } : {}),
  };
}
/** img attributes -> {{name.*}} (lazy-loading placeholders such as blazy's data:image src stay static) */
function imgPlaceholders(c: Element, name: string, keepSrcset = false): void {
  const src = c.properties.src === undefined ? undefined : String(c.properties.src);
  const dataSrc = c.properties.dataSrc === undefined ? undefined : String(c.properties.dataSrc);
  if (dataSrc !== undefined && (contentImage(dataSrc) || !contentImage(src))) c.properties.dataSrc = `{{${name}.url}}`;
  else c.properties.src = `{{${name}.url}}`;
  if (c.properties.alt !== undefined) c.properties.alt = `{{${name}.alt}}`;
  if (c.properties.title !== undefined) c.properties.title = `{{${name}.title}}`;
  if (c.properties.width !== undefined) c.properties.width = `{{${name}.width}}`;
  if (c.properties.height !== undefined) c.properties.height = `{{${name}.height}}`;
  if (keepSrcset) {
    if (c.properties.srcSet !== undefined) c.properties.srcSet = `{{${name}.srcset}}`;
    if (c.properties.sizes !== undefined) c.properties.sizes = `{{${name}.sizes}}`;
    if (c.properties.dataSrcset !== undefined) c.properties.dataSrcset = `{{${name}.srcset}}`;
  } else {
    delete c.properties.srcSet;
    delete c.properties.sizes;
  }
}
/** <picture>: the <img> plus every <source srcset> ({{name.sources.N.srcset}}) */
function templatePicture(tpl: Tpl, root: Element, name: string): { node: Element; value: Record<string, unknown> } | undefined {
  const img = select("img", root);
  if (!img) return undefined;
  const sources = selectAll("source", root);
  const value: Record<string, unknown> = { ...assetValue(img) };
  if (sources.length) value.sources = sources.map((s) => ({ srcset: attr(s, "srcSet") ?? attr(s, "dataSrcset") ?? "", ...(attr(s, "media") ? { media: attr(s, "media") } : {}), ...(attr(s, "type") ? { type: attr(s, "type") } : {}) }));
  const node = mapTree(root, (x, xc) => {
    if (x === img) {
      imgPlaceholders(xc, name, true);
      return [xc];
    }
    const si = sources.indexOf(x);
    if (si >= 0) {
      if (xc.properties.srcSet !== undefined) xc.properties.srcSet = `{{${name}.sources.${si}.srcset}}`;
      if (xc.properties.dataSrcset !== undefined) xc.properties.dataSrcset = `{{${name}.sources.${si}.srcset}}`;
      return [xc];
    }
    return "recurse";
  });
  void tpl;
  return { node, value };
}

interface EntityCtx {
  tpl: Tpl;
  /** called for nested entities found in componentList/collection fields */
  itemComponentOf(el: Element): string | undefined;
  titleLink?: boolean;
  /** entity id substituted by {{entityId}} in attribute values */
  entityId?: string;
  /** BEM text/link/image props, repeated siblings -> {{#each}}, nested entities outside fields (Drupal theme markup) */
  rich?: boolean;
  /** page title text -> {{title}} */
  pageTitle?: string;
}

function dateProp(tpl: Tpl, name: string, time: Element, c: Element): ElementContent[] {
  const iso = attr(time, "dateTime") ?? "";
  const shown = text(time);
  const f = detectDateFormat(iso, shown, tpl.locale);
  tpl.prop(
    { name, type: "text", ccmField: name, ...(f ? { format: { kind: "date", options: f.options, locales: { [tpl.locale]: f.tag } } } : {}) },
    { iso, formatted: shown },
  );
  c.properties.dateTime = `{{${name}.iso}}`;
  const t = ownText(time);
  return withChildren(c, t !== undefined ? wsPlaceholder(t, `{{${name}.formatted}}`) : [T(`{{${name}.formatted}}`)]);
}

/** replace the entity id inside attribute values (ids, aria-controls, slick ids, component-<nid> classes) */
function substituteEntityId(c: Element, eid: string | undefined, tpl: Tpl): void {
  if (!eid) return;
  const re = new RegExp(`(?<!\\d)${eid}(?!\\d)`, "g");
  let hit = false;
  for (const [k, v] of Object.entries(c.properties)) {
    if (typeof v === "string" && re.test(v)) {
      re.lastIndex = 0;
      c.properties[k] = v.replace(re, "{{entityId}}");
      hit = true;
    } else if (Array.isArray(v) && v.some((x) => typeof x === "string" && new RegExp(`(?<!\\d)${eid}(?!\\d)`).test(x))) {
      c.properties[k] = v.map((x) => (typeof x === "string" ? x.replace(re, "{{entityId}}") : x));
      hit = true;
    }
    re.lastIndex = 0;
  }
  if (hit) tpl.prop({ name: "entityId", type: "text", derive: "ccmIdTail" }, eid);
}

/** a run of nested entities -> {{#each name}}{{{this.html}}}{{/each}} */
function entityRun(ctx: EntityCtx, container: Element, copy: Element, base: string): ElementContent[] | undefined {
  const kids = childElements(container);
  if (!kids.length || !kids.every(isEntity)) return undefined;
  const { tpl } = ctx;
  const values = kids.map((k) => ({ type: ctx.itemComponentOf(k), html: outerHtml(k), ...(entityIdOf(k) ? { entityId: entityIdOf(k) } : {}) }));
  const name = tpl.name(base, values);
  const comps = [...new Set(values.map((v) => v.type).filter(Boolean))];
  tpl.prop({ name, type: "list", ccmField: name, ...(comps.length === 1 ? { itemComponent: comps[0] } : {}), itemFields: { html: "html", type: "text" } }, values);
  const first = container.children.indexOf(kids[0]);
  const last = container.children.indexOf(kids[kids.length - 1]);
  return withChildren(copy, [
    ...container.children.slice(0, first).map((x) => structuredClone(x) as ElementContent),
    T(`{{#each ${name}}}{{{this.html}}}{{/each}}`),
    ...container.children.slice(last + 1).map((x) => structuredClone(x) as ElementContent),
  ]);
}

const SVG_TAGS = new Set(["svg", "g", "defs", "symbol", "clipPath", "mask", "pattern", "linearGradient", "radialGradient", "text", "use", "path", "line", "circle", "rect", "polygon", "polyline", "ellipse"]);

/** signature for "same kind of sibling" (tag + first class without modifiers/state) */
function siblingSig(el: Element): string {
  const cls = classes(el).filter((c) => !/--|^(is-|js-|active|first|last|odd|even)/.test(c) && !/\d/.test(c));
  return `${el.tagName}.${cls.slice(0, 2).join(".")}`;
}

/** Repeated siblings (slides, cards, pills, bubbles): one merged item template inside {{#each}}. */
function repeatRun(ctx: EntityCtx, el: Element, copy: Element, visitor: (c: EntityCtx) => Visit): ElementContent[] | undefined {
  const kids = childElements(el);
  if (SVG_TAGS.has(el.tagName) || kids.some((k) => SVG_TAGS.has(k.tagName))) return undefined;
  if (kids.length < 2 || kids.some(isEntity) || new Set(kids.map(siblingSig)).size !== 1) return undefined;
  if (kids.some((k) => fieldInfo(k) || isFieldItem(k))) return undefined;
  const items: Inst0[] = kids.map((k, i) => {
    const sub = new Tpl(ctx.tpl.locale);
    const node = mapTree(k, visitor({ ...ctx, tpl: sub }));
    return { key: String(i), locale: ctx.tpl.locale, template: sub.serialize(node), values: sub.values, props: [...sub.props.values()] };
  });
  const groups = groupByShape(items);
  if (groups.length !== 1) return undefined;
  const m = mergeGroup("item", items, 0, { content: true });
  if (!m.template.includes("{{")) return undefined; // identical items: keep static
  // every item must re-render to its own markup
  for (const [i, k] of kids.entries()) {
    try {
      if (normalizeHtml(renderTemplate(m.template, m.values[i])) !== normalizeHtml(outerHtml(k))) return undefined;
    } catch {
      return undefined;
    }
  }
  let template = m.template;
  let props = m.props;
  let values = m.values.map((v) => ({ ...v }));
  // item index rendered into the markup (slick `slide--0`, `data-position="1"`…) -> {{@index}}
  for (const p of [...props]) {
    if (p.type === "text" && !p.valueType && values.every((v, i) => v[p.name] === String(i)) && template.includes(`{{${p.name}}}`)) {
      template = template.split(`{{${p.name}}}`).join("{{@index}}");
      values.forEach((v) => delete v[p.name]);
      props = props.filter((x) => x !== p);
    }
  }
  // every item wraps exactly one nested entity: the item IS that entity ({{{this.html}}} inside the item wrapper)
  const wrapped = props.find((p) => p.type === "list" && p.itemFields?.html && values.every((v) => Array.isArray(v[p.name]) && (v[p.name] as unknown[]).length === 1));
  if (wrapped && template.includes(`{{#each ${wrapped.name}}}{{{this.html}}}{{/each}}`)) {
    template = template.split(`{{#each ${wrapped.name}}}{{{this.html}}}{{/each}}`).join("{{{html}}}");
    values = values.map((v) => {
      const { [wrapped.name]: inner, ...rest } = v;
      return { ...rest, ...((inner as Record<string, unknown>[])[0] ?? {}) };
    });
    props = [...props.filter((x) => x !== wrapped), { name: "html", type: "html" }, { name: "type", type: "text" }, { name: "entityId", type: "text" }];
  }
  const entityItems = !!wrapped && values.every((v) => typeof v.entityId === "string");
  const comps = entityItems ? [...new Set(values.map((v) => v.type).filter(Boolean))] : [];
  const name = ctx.tpl.name(bemName(el) ?? (bemName(kids[0]) ? `${bemName(kids[0])}s` : "items"), values);
  const itemFields: Record<string, string> = {};
  for (const p of props) itemFields[p.name] = p.valueType ?? p.type;
  ctx.tpl.prop({ name, type: "list", ccmField: name, ...(comps.length === 1 ? { itemComponent: comps[0] as string } : {}), itemFields }, values);
  const first = el.children.indexOf(kids[0]);
  const last = el.children.indexOf(kids[kids.length - 1]);
  const between = el.children.slice(first + 1, el.children.indexOf(kids[1]));
  const sep = between.every((x) => x.type === "text") ? between.map((x) => (x as { value: string }).value).join("") : "";
  return withChildren(copy, [
    ...el.children.slice(0, first).map((x) => structuredClone(x) as ElementContent),
    ctx.tpl.rawNode(`{{#each ${name}}}${scopeItem(template)}${sep ? `{{#if @last}}{{else}}${sep}{{/if}}` : ""}{{/each}}`),
    ...el.children.slice(last + 1).map((x) => structuredClone(x) as ElementContent),
  ]);
}

/** prefix the placeholders of an item template with `this.` */
export function scopeItem(tpl: string): string {
  return tpl.replace(/\{\{(\{?)(\s*)(#each\s+|#if\s+|)([^}#/\s][^}]*?)(\s*)\}\}(\}?)/g, (all, b1: string, s1: string, kw: string, path: string, s2: string, b2: string) => {
    if (path === "else" || /^(this\b|@|\.\.\/|t\.)/.test(path)) return all;
    return `{{${b1}${s1}${kw}this.${path}${s2}}}${b2}`;
  });
}

function entityVisitor(ctx: EntityCtx, root: Element): Visit {
  const { tpl } = ctx;
  const self: Visit = (el, c) => {
    if (ctx.rich) substituteEntityId(c, ctx.entityId, tpl);
    if (el !== root && ctx.rich && isEntity(el)) return [structuredClone(el)]; // only reached when not part of an entity run
    const fi = fieldInfo(el);
    if (!fi) return nonField(el, c);
    const kind = classifyField(el, fi.type, MINING_PROFILES);
    const name = kind === "collection" ? "items" : fieldNameToId(fi.name);
    switch (kind) {
      case "text": {
        // labelled single-value field (`.field__label` + one `.field__item`): only the item holds the value
        const items = childElements(el).filter(isFieldItem);
        if (items.length === 1 && childElements(el).length > 1 && childElements(el).some((x) => hasCls(x, "field__label"))) {
          const item = items[0];
          tpl.prop({ name, type: "text", ccmField: name }, text(item));
          return [mapTree(el, (x, xc) => (x === item ? replaceText(x, xc, `{{${name}}}`) : "recurse"))];
        }
        // multi-value plain-text field (`.field__items` > `.field__item`*): one {{#each}} over the item texts
        const holderOf = childElements(el).find(isFieldItems) ?? (isFieldItems(el) ? el : undefined);
        const multi = holderOf ? childElements(holderOf).filter(isFieldItem) : [];
        if (holderOf && multi.length > 1 && multi.length === childElements(holderOf).length && multi.every((x) => ownText(x) !== undefined)) {
          const vals = multi.map((x) => splitWs(ownText(x)!)[1]);
          tpl.prop({ name, type: "list", ccmField: name }, vals);
          const build = (h: Element, hc: Element): ElementContent[] => {
            const wrap = mapTree(multi[0], () => "recurse");
            wrap.children = wsPlaceholder(ownText(multi[0])!, "{{this}}");
            const first = h.children.indexOf(multi[0]);
            const last = h.children.indexOf(multi[multi.length - 1]);
            return withChildren(hc, [...h.children.slice(0, first).map((x) => structuredClone(x) as ElementContent), T(`{{#each ${name}}}`), wrap, T("{{/each}}"), ...h.children.slice(last + 1).map((x) => structuredClone(x) as ElementContent)]);
          };
          if (holderOf === el) return build(el, c);
          return [mapTree(el, (x, xc) => (x === holderOf ? build(x, xc) : "recurse"))];
        }
        // themed field markup (label, icon, value element, e.g. a badge): only the single non-label text leaf holds the value
        if (textHolderPath(el).length || childElements(el).length > 1) {
          const leaves = selectAll("*", el).filter((x) => !SVG_TAGS.has(x.tagName) && x.tagName !== "script" && !!ownText(x)?.trim() && !classes(x).some((k) => /label/.test(k)));
          const holder = (() => {
            let cur = el;
            for (const i of textHolderPath(el)) cur = cur.children[i] as Element;
            return cur;
          })();
          if (leaves.length === 1 && childElements(holder).length > 1) {
            const leaf = leaves[0];
            tpl.prop({ name, type: "text", ccmField: name }, text(leaf));
            return [mapTree(el, (x, xc) => (x === leaf ? replaceText(x, xc, `{{${name}}}`) : "recurse"))];
          }
        }
        tpl.prop({ name, type: "text", ccmField: name }, text(el));
        return replaceText(el, c, `{{${name}}}`);
      }
      case "richText": {
        const items = childElements(el).filter(isFieldItem);
        const holder = items.length ? items[0] : el;
        const [, core] = splitWs(innerHtml(holder));
        tpl.prop({ name, type: "richText", ccmField: name, ...(ctx.rich && !hasBlockContent(holder) ? { inline: true } : {}) }, ctx.rich ? core : innerHtml(holder));
        const ph = ctx.rich ? wsPlaceholder(innerHtml(holder), `{{{${name}}}}`) : [T(`{{{${name}}}}`)];
        if (items.length) {
          const first = mapTree(items[0], () => "recurse");
          first.children = ph;
          if (ctx.rich) substituteEntityId(first, ctx.entityId, tpl);
          // labelled field (`.field__label` before the item): keep the label markup
          if (childElements(el).some((x) => !isFieldItem(x))) return withChildren(c, el.children.filter((x) => x.type !== "element" || !isFieldItem(x) || x === items[0]).map((x) => (x === items[0] ? first : (structuredClone(x) as ElementContent))));
          return withChildren(c, [first]);
        }
        return withChildren(c, ph);
      }
      case "link": {
        const a = select("a", el);
        tpl.prop({ name, type: "link", ccmField: name }, a ? { url: attr(a, "href") ?? "", label: text(a) } : undefined);
        return [
          mapTree(el, (x, xc) => {
            if (x !== a) return "recurse";
            xc.properties.href = `{{${name}.url}}`;
            const t = ownText(x);
            return withChildren(xc, t !== undefined ? wsPlaceholder(t, `{{${name}.label}}`) : [T(`{{${name}.label}}`)]);
          }),
        ];
      }
      case "asset": {
        const img = select("img", el);
        const pic = ctx.rich ? select("picture", el) : undefined;
        if (pic) {
          const r = templatePicture(tpl, pic, name)!;
          tpl.prop({ name, type: "asset", ccmField: name }, r.value);
          const t = mapTree(el, (x) => (x === pic ? [r.node] : "recurse"));
          return [T(`{{#if ${name}}}`), t, T("{{/if}}")];
        }
        tpl.prop({ name, type: "asset", ccmField: name }, img ? assetValue(img) : undefined);
        const t = mapTree(el, (x, xc) => {
          if (x !== img) return "recurse";
          imgPlaceholders(xc, name, ctx.rich);
          return [xc];
        });
        return [T(`{{#if ${name}}}`), t, T("{{/if}}")];
      }
      case "date": {
        const time = select("time[datetime]", el);
        if (!time) return "recurse";
        return [mapTree(el, (x, xc) => (x === time ? dateProp(tpl, name, x, xc) : "recurse"))];
      }
      case "termRefs":
      case "entryRefs": {
        const ul = select("ul, ol", el) ?? childElements(el).find(isFieldItems) ?? (isFieldItems(el) ? el : undefined);
        if (!ul) {
          // a reference printed as its plain label (no link, no media, one text leaf), e.g. the node author `uid` in
          // "submitted by": a text prop (bound to the CCM field holding that label by value)
          if (ctx.rich && kind === "entryRefs" && !select("a[href], img, svg, picture", el)) {
            const leaves = [el, ...selectAll("*", el)].filter((x) => !!ownText(x)?.trim());
            if (leaves.length === 1 && text(el).trim() === ownText(leaves[0])!.trim()) {
              const leaf = leaves[0];
              tpl.prop({ name, type: "text", ccmField: name }, splitWs(ownText(leaf)!)[1]);
              if (leaf === el) return withChildren(c, wsPlaceholder(ownText(el)!, `{{${name}}}`));
              return [mapTree(el, (x, xc) => (x === leaf ? withChildren(xc, wsPlaceholder(ownText(x)!, `{{${name}}}`)) : "recurse"))];
            }
          }
          return "recurse";
        }
        const rules = computeRules(collectItems([ul]));
        tpl.prop({ name, type: "list", ccmField: name, itemFields: { label: "text", url: "link", locale: "text" } }, listValue(ul).map(({ label, url, locale }) => ({ label, url, locale })));
        const t = mapTree(el, (x, xc) => (x === ul ? templateList(tpl, x, xc, rules, 1, name) : "recurse"));
        // Drupal prints no field wrapper (label included) for an empty reference field: the whole field is conditional
        return ctx.rich && classes(el).some((x) => x.startsWith("field--name-")) ? [T(`{{#if ${name}}}`), t, T("{{/if}}")] : [t];
      }
      case "componentList": {
        const holder = childElements(el).find(isFieldItems) ?? el;
        let items = childElements(holder).filter(isFieldItem);
        // single-value field rendered as `field … field--item` with the entity directly inside
        const single = !items.length && isFieldItem(el);
        if (single) items = [el];
        const values = items.map((it) => {
          const p = it === el ? childElements(el).find(isEntity) : (childElements(it).find(isEntity) ?? select(".paragraph", it) ?? childElements(it)[0]);
          return { type: p ? ctx.itemComponentOf(p) : undefined, html: innerHtml(it), ...(ctx.rich && p && entityIdOf(p) ? { entityId: entityIdOf(p) } : {}) };
        });
        const comps = [...new Set(values.map((v) => v.type).filter(Boolean))];
        tpl.prop({ name, type: "list", ccmField: name, ...(ctx.rich && comps.length === 1 ? { itemComponent: comps[0] } : {}), itemFields: { html: "html", type: "text" } }, values);
        if (single) {
          if (ctx.rich) substituteEntityId(c, ctx.entityId, tpl);
          return withChildren(c, [T(`{{#each ${name}}}{{{this.html}}}{{/each}}`)]);
        }
        const build = (h: Element, hc: Element): ElementContent[] => {
          if (!items.length) return withChildren(hc, []);
          const wrap = mapTree(items[0], () => "recurse");
          wrap.children = [T("{{{this.html}}}")];
          const firstIdx = h.children.indexOf(items[0]);
          const lastIdx = h.children.indexOf(items[items.length - 1]);
          return withChildren(hc, [
            ...h.children.slice(0, firstIdx).map((x) => structuredClone(x) as ElementContent),
            T(`{{#each ${name}}}`),
            wrap,
            T("{{/each}}"),
            ...h.children.slice(lastIdx + 1).map((x) => structuredClone(x) as ElementContent),
          ]);
        };
        if (holder === el) return build(el, c);
        return [mapTree(el, (x, xc) => (x === holder ? build(x, xc) : "recurse"))];
      }
      case "collection": {
        let content = select(".view-content", el);
        let rows = content ? childElements(content).filter((x) => classes(x).includes("views-row")) : [];
        if (!rows.length && ctx.rich) {
          const first = select(".views-row", el);
          const parents = first ? dom.parentMap({ type: "root", children: [el] }) : undefined;
          const p = first ? parents!.get(first) : undefined;
          if (p && p.type === "element") {
            content = p;
            rows = childElements(p).filter((x) => classes(x).includes("views-row"));
          }
        }
        // other Views styles (responsive grid, grid, html list): the row wrappers around the result entities are the
        // children of the entities' common parent; each row keeps its wrappers, the entity becomes {{{this.html}}}
        if (!rows.length && ctx.rich && content) {
          const g = gridRows(content);
          if (g) return templateGridRows(tpl, el, name, g, ctx);
        }
        const itemComponent = rows.length ? ctx.itemComponentOf(childElements(rows[0])[0] ?? rows[0]) : undefined;
        tpl.prop({ name, type: "list", ccmField: "collection", itemComponent, itemFields: { html: "html" } }, rows.map((r) => ({ html: innerHtml(r) })));
        return [
          mapTree(el, (x, xc) => {
            if (x !== content) return "recurse";
            const wrap = rows.length ? mapTree(rows[0], () => "recurse") : undefined;
            if (wrap) wrap.children = [T("{{{this.html}}}")];
            const lead = x.children.slice(0, rows.length ? x.children.indexOf(rows[0]) : x.children.length).map((y) => structuredClone(y) as ElementContent);
            const tail = rows.length ? x.children.slice(x.children.indexOf(rows[rows.length - 1]) + 1).map((y) => structuredClone(y) as ElementContent) : [];
            return withChildren(xc, [...lead, T(`{{#each ${name}}}`), ...(wrap ? [wrap] : []), T("{{/each}}"), ...tail]);
          }),
        ];
      }
    }
    return "recurse";
  };

  const nonField: Visit = (el, c) => {
    if (el.tagName === "time" && attr(el, "dateTime")) return dateProp(tpl, tpl.name("created", attr(el, "dateTime")), el, c);
    if (ctx.titleLink && el.tagName === "a" && (attr(el, "rel") === "bookmark" || classes(el).length === 0) && select(".field--name-title", el)) {
      tpl.prop({ name: "url", type: "link", ccmField: "path" }, attr(el, "href"));
      c.properties.href = "{{url}}";
    }
    if (ctx.pageTitle) {
      const t = ownText(el);
      if (t !== undefined && t.trim() === ctx.pageTitle) {
        tpl.prop({ name: "title", type: "text", ccmField: "title" }, ctx.pageTitle);
        return withChildren(c, wsPlaceholder(t, "{{title}}"));
      }
      if (ctx.rich && t === undefined && text(el) === ctx.pageTitle && inlineOnly(el)) {
        const [, core] = splitWs(innerHtml(el));
        tpl.prop({ name: "titleHtml", type: "html", ccmField: "title" }, core);
        return withChildren(c, wsPlaceholder(innerHtml(el), "{{{titleHtml}}}"));
      }
    }
    if (!ctx.rich) return "recurse";
    // nested entities outside field markup (quick-facts track, slick slides, accordion items)
    if (el !== root) {
      const run = entityRun(ctx, el, c, bemName(el) ?? "items");
      if (run) return run;
    }
    if (el.tagName === "picture") {
      const name = tpl.name(bemName(el) ?? "image", null);
      const r = templatePicture(tpl, el, name);
      if (r) {
        tpl.prop({ name, type: "asset", ccmField: name }, r.value);
        return [r.node];
      }
    }
    if (el.tagName === "img" && contentImage(attr(el, "src") ?? attr(el, "dataSrc"))) {
      const v = assetValue(el);
      const name = tpl.name(bemName(el) ?? "image", v);
      tpl.prop({ name, type: "asset", ccmField: name }, v);
      imgPlaceholders(c, name, true);
      return [c];
    }
    const bem = bemName(el);
    if (bem && el !== root) {
      const t = ownText(el);
      if (el.tagName === "a" && attr(el, "href") !== undefined) {
        const v = { url: attr(el, "href")!, ...(t !== undefined ? { label: splitWs(t)[1] } : {}) };
        const name = tpl.name(bem, v);
        tpl.prop({ name, type: "link", ccmField: name }, v);
        c.properties.href = `{{${name}.url}}`;
        if (t !== undefined && t.trim()) return withChildren(c, wsPlaceholder(t, `{{${name}.label}}`));
        return "recurse";
      }
      if (t !== undefined && t.trim() && !["script", "style", "button", "option", "label", "textarea"].includes(el.tagName)) {
        const v = splitWs(t)[1];
        const name = tpl.name(bem, v);
        tpl.prop({ name, type: "text", ccmField: name }, v);
        return withChildren(c, wsPlaceholder(t, `{{${name}}}`));
      }
      // (an inline wrapper around a Drupal field, e.g. <h2 class="card__title"><span class="field--name-title">, is left to the field rule)
      if (t === undefined && !["button", "form", "nav", "ul", "ol", "select", "svg"].includes(el.tagName) && inlineOnly(el) && !select("a[href], img, svg, input, button", el) && !selectAll("*", el).some((x) => !!fieldInfo(x))) {
        const [, core] = splitWs(innerHtml(el));
        const name = tpl.name(bem, core);
        tpl.prop({ name, type: "richText", ccmField: name, inline: true }, core);
        return withChildren(c, wsPlaceholder(innerHtml(el), `{{{${name}}}}`));
      }
    }
    const rep = repeatRun(ctx, el, c, (sub) => entityVisitor(sub, root));
    if (rep) return rep;
    return "recurse";
  };
  return self;
}

/** outermost entity elements below `root` (not nested in another entity) */
function outerEntities(root: Element): Element[] {
  const out: Element[] = [];
  const walkIn = (e: Element) => {
    for (const c of childElements(e)) {
      if (isEntity(c)) out.push(c);
      else walkIn(c);
    }
  };
  walkIn(root);
  return out;
}

interface GridRows {
  parent: Element;
  rows: Element[];
  /** the entity inside each row */
  entities: Element[];
}
/** repeated row wrappers (same tag/class signature), each holding exactly one result entity */
function gridRows(content: Element): GridRows | undefined {
  const ents = outerEntities(content);
  if (!ents.length) return undefined;
  const parents = dom.parentMap({ type: "root", children: [content] });
  const chain = (e: Element) => [e, ...dom.ancestorsOf(e, parents)];
  // lowest element holding every entity whose children are the rows
  let parent: Element | undefined = ents.length === 1 ? undefined : chain(ents[0]).find((a) => a !== ents[0] && ents.every((x) => chain(x).includes(a)));
  if (!parent) {
    // single result: the nearest ancestor with a repeated-row-like child structure (one child)
    parent = chain(ents[0]).slice(1).find((a) => childElements(a).length > 0 && a !== ents[0]);
    if (!parent) return undefined;
  }
  const rows = childElements(parent);
  if (!rows.length || new Set(rows.map(siblingSig)).size !== 1) return undefined;
  const entities = rows.map((r) => (isEntity(r) ? r : outerEntities(r)));
  if (entities.some((x) => Array.isArray(x) && x.length !== 1)) return undefined;
  const flat = entities.map((x) => (Array.isArray(x) ? x[0] : x));
  if (flat.some((x) => x === undefined) || flat.length !== ents.length) return undefined;
  return { parent, rows, entities: flat };
}

/** link target of a teaser/card entity (title link, else its first link) — identifies the row's entity */
function entityUrl(e: Element): string | undefined {
  return attr(select("a[rel=bookmark][href]", e) ?? select("a[href]", e), "href");
}

function templateGridRows(tpl: Tpl, field: Element, name: string, g: GridRows, ctx: EntityCtx): ElementContent[] {
  const comps = [...new Set(g.entities.map((e) => ctx.itemComponentOf(e)).filter((x): x is string => !!x))];
  const values = g.entities.map((e) => ({ html: outerHtml(e), ...(entityUrl(e) ? { url: entityUrl(e) } : {}) }));
  tpl.prop({ name, type: "list", ccmField: "collection", ...(comps.length === 1 ? { itemComponent: comps[0] } : {}), itemFields: { html: "html", url: "link" } }, values);
  const row0 = g.rows[0];
  const ent0 = g.entities[0];
  const wrap = row0 === ent0 ? undefined : mapTree(row0, (x) => (x === ent0 ? [T("{{{this.html}}}")] : "recurse"));
  const first = g.parent.children.indexOf(g.rows[0]);
  const last = g.parent.children.indexOf(g.rows[g.rows.length - 1]);
  return [
    mapTree(field, (x, xc) => {
      if (x !== g.parent) return "recurse";
      return withChildren(xc, [
        ...x.children.slice(0, first).map((y) => structuredClone(y) as ElementContent),
        T(`{{#each ${name}}}`),
        ...(wrap ? [wrap] : [T("{{{this.html}}}")]),
        T("{{/each}}"),
        ...x.children.slice(last + 1).map((y) => structuredClone(y) as ElementContent),
      ]);
    }),
  ];
}

function templateEntity(root: Element, ctx: EntityCtx): Element {
  return mapTree(root, entityVisitor(ctx, root));
}

// ------------------------------------------------------------------ detectors

interface Instance {
  id: string;
  kind: ComponentDef["kind"];
  ccmType?: string;
  viewMode?: string;
  el: Element;
  page: MinePage;
  template: string;
  values: Record<string, unknown>;
  props: PropDef[];
  /** instanceProps key */
  key: string;
}

function teaserType(el: Element): string | undefined {
  const cls = classes(el);
  if (!cls.includes("node--view-mode-teaser") && !cls.includes("teaser")) return undefined;
  const t = cls.find((c) => c.startsWith("node--type-"));
  return t ? bundleToType(machineName(t.slice(11))) : undefined;
}

function componentIdOf(el: Element): string | undefined {
  const cls = classes(el);
  const p = cls.find((c) => c.startsWith("paragraph--type--"));
  if (cls.includes("paragraph") && p) return paragraphToType(machineName(p.slice(17)));
  const t = teaserType(el);
  if (t) return `${t}Teaser`;
  const dc = attr(el, "dataComponent");
  if (dc) return paragraphToType(machineName(dc));
  const vm = cls.map((c) => VIEW_MODE.exec(c)?.[1]).find((x) => x && x !== "full");
  if (vm) {
    const nt = cls.find((c) => c.startsWith("node--type-"));
    return nt ? `${bundleToType(machineName(nt.slice(11)))}${pascal(vm)}` : `node${pascal(vm)}`;
  }
  if (SECTION_ID.test(attr(el, "id") ?? "")) {
    const b = cls.find((c) => c.includes("__")) ?? cls.find((c) => !/--/.test(c));
    return b ? paragraphToType(machineName(b.replace(/__/g, "-"))) : "sectionItem";
  }
  return undefined;
}

interface Chrome {
  header?: Element;
  mainNav?: Element;
  languageSwitcher?: Element;
  footer?: Element;
  footerNav?: Element;
  cookieBanner?: Element;
}
function findChrome(info: PageInfo): Chrome {
  const tree = info.tree;
  const header = select("header[role=banner], header.site-header, body header", tree) ?? undefined;
  const footer = select("footer.site-footer, footer[role=contentinfo], body footer", tree) ?? undefined;
  const plugin = (id: string) => select(`[data-block-plugin-id="${id}"]`, tree) ?? undefined;
  return {
    header,
    mainNav: select("nav.menu--main", tree) ?? plugin("system_menu_block:main") ?? (header ? select("nav", header) : undefined) ?? undefined,
    languageSwitcher: select(".language-switcher-language-url, [class*=language-switcher]", tree) ?? select("[data-block-plugin-id^='language_block']", tree) ?? undefined,
    footer,
    footerNav: select("nav.menu--footer", tree) ?? plugin("system_menu_block:footer") ?? (footer ? select("nav", footer) : undefined) ?? undefined,
    cookieBanner: select("#cookie-banner, #sliding-popup, .eu-cookie-compliance-banner, .cookie-banner", tree) ?? undefined,
  };
}

const titleBlockOf = (tree: dom.Root) => select(".block-page-title-block, [data-block-plugin-id=page_title_block]", tree) ?? undefined;

/** node full view (Olivero/Claro markup or a bare `article[data-history-node-id]` theme) */
function nodeBodyOf(main: Element): Element | undefined {
  return select("article.node.node--view-mode-full, .node--view-mode-full", main) ?? select("article[data-history-node-id]", main) ?? undefined;
}
/**
 * The element a document component is mined from: the node (or listing) element itself, or — when a content block
 * (Drupal's main-content block `div.block-system-main-block#block-…`) wraps nothing but it — that block with its
 * single-child wrappers up to the region. Otherwise the block would be mined as its own (static) component holding
 * the node and the node would render a second time from its own slot.
 */
export function documentRootOf(main: Element, el: Element | undefined): Element | undefined {
  if (!el) return el;
  const parents = dom.parentMap({ type: "root", children: [main] });
  const onlyChild = (p: Element, c: Element) => childElements(p).length === 1 && childElements(p)[0] === c && !p.children.some((x) => x.type === "text" && x.value.trim());
  let cur = el;
  let block: Element | undefined;
  const isBlock = (x: Element) => /^block-/.test(attr(x, "id") ?? "") && classes(x).includes("block");
  for (;;) {
    const p = parents.get(cur);
    if (!p || p.type !== "element" || classes(p).includes("region") || !onlyChild(p, cur)) break;
    if (p === main) {
      // main content root = the main-content block itself (source-html picks `.block-system-main-block`)
      if (isBlock(p)) block = p;
      break;
    }
    cur = p;
    if (isBlock(p)) block = p;
  }
  if (!block) return el;
  // same upward expansion as contentBlocksOf (block wrappers up to the region belong to the component)
  let root = block;
  for (;;) {
    const p = parents.get(root);
    if (!p || p.type !== "element" || p === main || classes(p).includes("region") || childElements(p).length !== 1) return root;
    root = p;
  }
}

/** Views page display (`view:<id>.<display>` pages without a node): the listing element and its view component id */
function listingOf(info: PageInfo, main: Element, rich: boolean): { el: Element; root: Element; id: string } | undefined {
  if (!info.template.startsWith("view:") || !info.drupal.views.length) return undefined;
  const el = select(".views-element-container", main) ?? select(".view", main);
  if (!el) return undefined;
  return { el, root: (rich ? documentRootOf(main, el) : el) ?? el, id: `view${pascal(info.drupal.views[0].id)}${pascal(info.drupal.views[0].display)}` };
}

/** custom themes render the node's component field outside the <article> (`div.field-components-container`) */
function componentsContainerOf(main: Element): Element | undefined {
  return select(".field-components-container", main) ?? undefined;
}
/** site-wide blocks placed in content regions (`section#block-…` inside main) */
function contentBlocksOf(main: Element, exclude: Element[]): Element[] {
  const parents = dom.parentMap({ type: "root", children: [main] });
  return selectAll("section.block[id^=block-], div.block[id^=block-]", main)
    .filter((b) => {
      if (exclude.includes(b) || attr(b, "dataBlockPluginId") === "page_title_block") return false;
      return !exclude.some((x) => selectAll("*", x).includes(b));
    })
    .map((b) => {
      // the block's wrappers (block-view-container, theme divs) up to the region belong to the component
      let el = b;
      for (;;) {
        const p = parents.get(el);
        if (!p || p.type !== "element" || p === main || classes(p).includes("region") || childElements(p).length !== 1) return el;
        el = p;
      }
    });
}
/**
 * Views blocks placed in theme regions of the main wrapper but outside the main content (`info.main`), whose
 * `.view-content` holds `.views-row`s of one entity each (teasers): e.g. Umami's "More featured articles" sidebar.
 */
function sideViewBlocksOf(info: PageInfo, wrapper: Element | undefined): Element[] {
  const main = info.main;
  if (!wrapper || !main) return [];
  const inMain = new Set([main, ...selectAll("*", main)]);
  const parents = dom.parentMap(info.tree);
  return selectAll("div.block[id^=block-], section.block[id^=block-]", wrapper).filter((b) => {
    if (inMain.has(b) || inMain.has(parents.get(b) as Element) || selectAll("*", b).includes(main)) return false;
    if (!dom.ancestorsOf(b, parents).some((a) => a.type === "element" && classes(a).includes("region") && !!regionNameOf(a))) return false;
    const view = select(".view[class*='view-id-'][class*='view-display-id-']", b);
    const content = view ? select(".view-content", view) : undefined;
    const rows = content ? childElements(content).filter((x) => classes(x).includes("views-row")) : [];
    return rows.length > 0 && rows.length === childElements(content!).length && rows.every((r) => childElements(r).length === 1 && isEntity(childElements(r)[0]));
  });
}

/** a side Views block: its rows → `{{#each items}}<row wrapper>{{{this.html}}}</row wrapper>{{/each}}` */
function viewBlockTemplate(tpl: Tpl, b: Element, itemComponentOf: (el: Element) => string | undefined): Element {
  const content = select(".view-content", select(".view[class*='view-id-']", b)!)!;
  const rows = childElements(content).filter((x) => classes(x).includes("views-row"));
  const values = rows.map((r) => {
    const e = childElements(r)[0];
    return { type: itemComponentOf(e), html: innerHtml(r), ...(entityIdOf(e) ? { entityId: entityIdOf(e) } : {}) };
  });
  const comps = [...new Set(values.map((v) => v.type).filter(Boolean))];
  tpl.prop({ name: "items", type: "list", ...(comps.length === 1 ? { itemComponent: comps[0] } : {}), itemFields: { html: "html", type: "text" } }, values);
  return mapTree(b, (x, xc) => {
    if (x !== content) return "recurse";
    const wrap = mapTree(rows[0], () => "recurse");
    wrap.children = [T("{{{this.html}}}")];
    const lead = x.children.slice(0, x.children.indexOf(rows[0])).map((y) => structuredClone(y) as ElementContent);
    const tail = x.children.slice(x.children.indexOf(rows[rows.length - 1]) + 1).map((y) => structuredClone(y) as ElementContent);
    return withChildren(xc, [...lead, T("{{#each items}}"), wrap, T("{{/each}}"), ...tail]);
  });
}

const blockOf = (el: Element) => (attr(el, "id")?.startsWith("block-") ? el : (select("section.block[id^=block-], div.block[id^=block-]", el) ?? el));
const blockIdOf = (el: Element) => `block${pascal((attr(blockOf(el), "id") ?? "").replace(/^block-/, "").replace(/^(da-vinci-code|olivero|bartik|claro)-/, ""))}`;

function detect(page: MinePage, listRules: Map<string, Rules>, rich: boolean): Instance[] {
  const out: Instance[] = [];
  const { info } = page;
  const ch = findChrome(info);
  const add = (id: string, kind: Instance["kind"], el: Element, build: (tpl: Tpl) => Element, extra: Partial<Instance> = {}) => {
    const tpl = new Tpl(page.locale);
    const node = build(tpl);
    out.push({ id, kind, el, page, template: tpl.serialize(node), values: tpl.values, props: [...tpl.props.values()], key: page.path, ...extra });
  };
  /** list templating only when it reproduces the list; otherwise the nav stays static (merge turns active-trail classes into flags) */
  const listBuild = (id: string, nav: Element, prop: string, ccm: string, fields: Record<string, string>, map: (v: ListValue[]) => unknown) => (tpl: Tpl) => {
    const ul = select("ul, ol", nav)!;
    const probe = new Tpl(page.locale);
    const node = mapTree(nav, (x, xc) => (x === ul ? templateList(probe, x, xc, listRules.get(id)!, 1, prop) : "recurse"));
    const value = map(listValue(ul));
    let ok = false;
    try {
      ok = normalizeHtml(renderTemplate(probe.serialize(node), { [prop]: value })) === normalizeHtml(outerHtml(nav));
    } catch {
      ok = false;
    }
    if (!ok) return mapTree(nav, identity);
    tpl.raw = probe.raw;
    tpl.prop({ name: prop, type: "list", ccmField: ccm, itemFields: fields }, value);
    return node;
  };

  // a header/footer only delegates to a nav component that exists; a nav without a <ul> (divs + links) stays inline markup
  const hasMainNav = !!(ch.mainNav && select("ul", ch.mainNav));
  const hasFooterNav = !!(ch.footerNav && select("ul", ch.footerNav));
  const hasLanguageSwitcher = !!(ch.languageSwitcher && select("ul", ch.languageSwitcher));
  if (hasMainNav && ch.mainNav) add("mainNav", "chrome", ch.mainNav, listBuild("mainNav", ch.mainNav, "items", "navigation.main", LIST_ITEM_FIELDS, (v) => v));
  if (hasFooterNav && ch.footerNav) add("footerNav", "chrome", ch.footerNav, listBuild("footerNav", ch.footerNav, "items", "navigation.footer", LIST_ITEM_FIELDS, (v) => v));
  if (hasLanguageSwitcher && ch.languageSwitcher) {
    const sw = ch.languageSwitcher;
    add("languageSwitcher", "chrome", sw, listBuild("languageSwitcher", sw, "links", "translations", { label: "text", url: "link", locale: "text", active: "boolean" }, (v) => v.map(({ label, url, locale, active }) => ({ label, url, locale, active }))));
  }
  if (ch.header) {
    const h = ch.header;
    add("siteHeader", "chrome", h, (tpl) => {
      const logo = select(".site-branding img, .site-branding__logo img, a.logo img", h) ?? select("img", h);
      return mapTree(h, (x, xc) => {
        if (hasMainNav && x === ch.mainNav) {
          tpl.prop({ name: "mainNav", type: "html", component: "mainNav" }, outerHtml(x));
          return [T("{{{mainNav}}}")];
        }
        if (hasLanguageSwitcher && x === ch.languageSwitcher) {
          tpl.prop({ name: "languageSwitcher", type: "html", component: "languageSwitcher" }, outerHtml(x));
          return [T("{{{languageSwitcher}}}")];
        }
        if (x === logo && !rich) {
          tpl.prop({ name: "logo", type: "asset", ccmField: "settings.logo" }, assetValue(x));
          imgPlaceholders(xc, "logo");
          return [xc];
        }
        if (x.tagName === "a" && (attr(x, "rel") === "home" || (logo && select("img", x) === logo)) && !rich) {
          tpl.prop({ name: "homeUrl", type: "link", ccmField: "route.home" }, attr(x, "href"));
          xc.properties.href = "{{homeUrl}}";
        }
        const t = text(x);
        if (info.siteName && t === info.siteName && x.children.every((c) => c.type === "text")) {
          tpl.prop({ name: "siteName", type: "text", ccmField: "settings.siteName" }, t);
          return withChildren(xc, [T("{{siteName}}")]);
        }
        if (info.slogan && t === info.slogan && x.children.every((c) => c.type === "text")) {
          tpl.prop({ name: "slogan", type: "text", ccmField: "settings.extra.slogan" }, t);
          return withChildren(xc, [T("{{slogan}}")]);
        }
        return "recurse";
      });
    });
  }
  if (ch.footer) {
    const f = ch.footer;
    add("siteFooter", "chrome", f, (tpl) =>
      mapTree(f, (x, xc) => {
        if (hasFooterNav && x === ch.footerNav) {
          tpl.prop({ name: "footerNav", type: "html", component: "footerNav" }, outerHtml(x));
          return [T("{{{footerNav}}}")];
        }
        if (x.tagName === "script" && !isDataScript(x)) return [];
        if (!rich && info.footerText && x.children.every((c) => c.type === "text") && text(x) === info.footerText) {
          tpl.prop({ name: "footerText", type: "text", ccmField: "settings.footerText" }, info.footerText);
          return withChildren(xc, [T("{{footerText}}")]);
        }
        return "recurse";
      }),
    );
  }
  if (ch.cookieBanner) {
    // JS un-hides the banner; mine the server markup so the template keeps its initial state (e.g. `hidden`)
    const rawBanner = page.rawInfo ? findChrome(page.rawInfo).cookieBanner : undefined;
    const el = rawBanner ?? ch.cookieBanner;
    add("cookieBanner", "chrome", el, () => mapTree(el, () => "recurse"));
  }

  const titleBlock = titleBlockOf(info.tree);
  if (titleBlock && info.pageTitle) {
    if (rich)
      add("pageTitle", "document", titleBlock, (tpl) => templateEntity(titleBlock, { tpl, itemComponentOf: componentIdOf, rich, pageTitle: info.pageTitle }), { ccmType: page.ccmType });
    else
      add("pageTitle", "document", titleBlock, (tpl) =>
        mapTree(titleBlock, (x, xc) => {
          if (x.children.every((c) => c.type === "text") && text(x) === info.pageTitle) {
            tpl.prop({ name: "title", type: "text", ccmField: "title" }, info.pageTitle);
            return withChildren(xc, [T("{{title}}")]);
          }
          return "recurse";
        }),
      );
  }

  const main = info.main;
  const itemComponentOf = (el: Element) => componentIdOf(el);
  if (main) {
    const nodeEl = nodeBodyOf(main);
    const node = rich ? documentRootOf(main, nodeEl) : nodeEl;
    const container = rich ? componentsContainerOf(main) : undefined;
    const nid = nodeEl ? entityIdOf(nodeEl) : undefined;
    if (node && page.ccmType) {
      add(`${page.ccmType}Body`, "document", node, (tpl) => templateEntity(node, { tpl, itemComponentOf, rich, entityId: nid }), { ccmType: page.ccmType, viewMode: "full" });
      if (container) add(`${page.ccmType}Components`, "document", container, (tpl) => templateEntity(container, { tpl, itemComponentOf, rich, entityId: nid }), { ccmType: page.ccmType, viewMode: "full" });
    }
    const listing = !node ? listingOf(info, main, rich) : undefined;
    if (listing) {
      // the listing's main-content block wrapper belongs to the view component (rendered once, by the `$collection` slot)
      const v = listing.root;
      add(listing.id, "document", v, (tpl) => {
        const fake: Element = { type: "element", tagName: "div", properties: { className: ["field", "field--name-field-view", "field--type-viewsreference"] }, children: [v] };
        const t = templateEntity(fake, { tpl, itemComponentOf, rich });
        return childElements(t)[0];
      });
    }
    if (rich) {
      for (const b of contentBlocksOf(main, [node, container, titleBlock, listing?.root].filter((x): x is Element => !!x))) add(blockIdOf(b), "chrome", b, () => mapTree(b, identity));
      // every embedded entity (paragraphs, custom components, nested items, node teasers)
      const seen = new Set<Element>();
      const walkEntities = (root: Element) => dom.walk(root, (el) => {
        if (el.tagName === "script" || el.tagName === "template") return false;
        if (!isEntity(el) || seen.has(el)) return true;
        seen.add(el);
        const id = componentIdOf(el);
        if (!id) return true;
        const vm = classes(el).map((c) => VIEW_MODE.exec(c)?.[1]).find(Boolean);
        add(id, "section", el, (tpl) => templateEntity(el, { tpl, itemComponentOf, rich, entityId: entityIdOf(el), titleLink: !!vm }), { ccmType: id.startsWith("node") ? undefined : id, ...(vm ? { viewMode: vm } : {}), key: entityIdOf(el) ?? `${page.path}#${seen.size}` });
        return true;
      });
      walkEntities(main);
      // Views blocks in other theme regions of the main wrapper (sidebar "More featured articles"): a block component
      // whose rows are a list (reconcile binds it to the view's CCM collection), and the row teasers as components
      for (const b of sideViewBlocksOf(info, mainWrapperOf(info, ch.header))) {
        add(blockIdOf(b), "chrome", b, (tpl) => viewBlockTemplate(tpl, b, itemComponentOf));
        walkEntities(b);
      }
    } else {
      for (const p of selectAll(".paragraph[class*='paragraph--type--']", main)) {
        const id = componentIdOf(p)!;
        add(id, "section", p, (tpl) => templateEntity(p, { tpl, itemComponentOf }), { ccmType: id, key: entityIdOf(p) ?? `${page.path}#${out.length}` });
      }
      for (const t of selectAll(".node--view-mode-teaser", main)) {
        const id = componentIdOf(t);
        if (!id) continue;
        add(id, "section", t, (tpl) => templateEntity(t, { tpl, itemComponentOf, titleLink: true }), { ccmType: teaserType(t), viewMode: "teaser", key: `${page.path}#${out.length}` });
      }
    }
    for (const m of selectAll(".text-content article.media, .text-formatted article.media", main)) {
      add("embeddedMedia", "section", m, (tpl) =>
        mapTree(m, (x, xc) => {
          if (x === m) {
            const align = classes(x).find((c) => c.startsWith("align-"));
            if (align) {
              tpl.prop({ name: "align", type: "text" }, align.slice(6));
              xc.properties.className = classes(x).map((c) => (c === align ? "align-{{align}}" : c));
            }
            return "recurse";
          }
          if (x.tagName === "img") {
            tpl.prop({ name: "image", type: "asset" }, assetValue(x));
            imgPlaceholders(xc, "image");
            return [xc];
          }
          return "recurse";
        }),
        { key: `${page.path}#${out.length}` },
      );
    }
    // generic fallback (no Drupal markup in main): top-level blocks of main become sections
    if (!node && !info.template.startsWith("view:") && !selectAll(".paragraph", main).length) {
      const root = genericSectionRoot(main);
      for (const b of childElements(root).filter((k) => !["script", "style", "template", "noscript", "h1"].includes(k.tagName) && (text(k) || select("img", k)))) {
        add(
          "sectionGeneric",
          "section",
          b,
          (tpl) => {
            // the transform stores the section's whole element in `html` (its classes are per-section: `title`, `ghost`,
            // spacing modifiers …), so the component renders it as is; a wrapper here would nest the element twice
            tpl.prop({ name: "html", type: "html", ccmField: "html" }, outerHtml(b));
            return tpl.rawNode("{{{html}}}");
          },
          { ccmType: "sectionGeneric", key: `${page.path}#${out.length}` },
        );
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ merge (dedupe + i18n + content props + flags + variants)

function tokenize(html: string): string[] {
  return html.split(/(<[^>]+>)/).filter((t) => t !== "");
}
function attrsOf(tag: string): Map<string, string> {
  const m = new Map<string, string>();
  const body = tag.replace(/^<\/?[a-zA-Z0-9-]+/, "");
  for (const a of body.matchAll(/\s([a-zA-Z_:@][-a-zA-Z0-9_:.]*)(?:="([^"]*)"|='([^']*)'|=([^\s>"']+))?/g)) m.set(a[1], a[2] ?? a[3] ?? a[4] ?? "");
  return m;
}
function setAttrInTag(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name.replace(/[-:.]/g, "\\$&")})(="[^"]*")?(?=[\\s/>])`);
  return re.test(tag) ? tag.replace(re, `$1="${value}"`) : tag.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
}
function removeAttrInTag(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name.replace(/[-:.]/g, "\\$&")}(="[^"]*")?(?=[\\s/>])`), "");
}
function keyFor(s: string, used: Set<string>): string {
  const base =
    s
      .normalize("NFKD")
      .replace(/[^\w\s]/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join("") || "text";
  let k = /^\d/.test(base) ? `t${base}` : base;
  const b = k;
  for (let i = 2; used.has(k); i++) k = `${b}${i}`;
  used.add(k);
  return k;
}
function uniqueName(base: string, used: Set<string>): string {
  let k = base || "value";
  for (let i = 2; used.has(k); i++) k = `${base}${i}`;
  used.add(k);
  return k;
}
/** shape of a template: tag names in order (text positions as "#") — instances with equal shapes merge token by token */
function shapeOf(template: string): string {
  return tokenize(template)
    .map((t) => {
      if (!t.startsWith("<")) return t.includes("{{") ? t.trim() : "#";
      const tag = /^<\/?[a-zA-Z0-9-]+/.exec(t)?.[0] ?? "<?";
      const ph = [...attrsOf(t)].filter(([, v]) => v.includes("{{")).map(([k, v]) => `${k}=${v}`).sort();
      return ph.length ? `${tag}[${ph.join(" ")}]` : tag;
    })
    .join(",");
}
function groupByShape(insts: { template: string }[]): number[][] {
  const groups = new Map<string, number[]>();
  insts.forEach((x, i) => {
    const s = shapeOf(x.template);
    groups.set(s, [...(groups.get(s) ?? []), i]);
  });
  return [...groups.values()];
}
/** text token (serialised HTML text) -> plain text */
function decode(s: string): string {
  const root = parseFragment(s);
  return root.children.map((c) => (c.type === "text" ? c.value : "")).join("");
}

interface Inst0 {
  key: string;
  locale: string;
  template: string;
  values: Record<string, unknown>;
  props: PropDef[];
}
interface MergeOut {
  template: string;
  props: PropDef[];
  values: Record<string, unknown>[];
  issues: Issue[];
}

/**
 * Merge structurally equal instance templates (same shape) token by token. Differences become:
 * text -> i18n prop (only locales differ) or content prop; class tokens -> prefix prop / boolean flag; other attributes -> i18n / content prop.
 */
function mergeGroup(id: string, insts: Inst0[], canonIdx: number, opts: { content: boolean }): MergeOut {
  const issues: Issue[] = [];
  const canon = insts[canonIdx];
  const toks = insts.map((i) => tokenize(i.template));
  const tokens = toks[canonIdx];
  const props = new Map<string, PropDef>();
  for (const i of insts)
    for (const p of i.props) {
      const ex = props.get(p.name);
      if (!ex) props.set(p.name, { ...p, ...(p.format ? { format: { ...p.format, locales: { ...p.format.locales } } } : {}) });
      else if (p.format) ex.format = { ...(ex.format ?? p.format), locales: { ...(ex.format?.locales ?? {}), ...p.format.locales } };
      else if (p.itemFields && ex.itemFields) ex.itemFields = { ...ex.itemFields, ...p.itemFields };
    }
  const values = insts.map((i) => structuredClone(i.values));
  const used = new Set<string>([...props.keys()].map((k) => k.split(".")[0]));
  const out = [...tokens];
  const i18n = new Map<string, Record<string, string>>();
  const setI18n = (key: string, idx: number, v: string) => {
    const m = i18n.get(key) ?? {};
    if (m[insts[idx].locale] === undefined) m[insts[idx].locale] = v;
    i18n.set(key, m);
    setPath(values[idx], `t.${key}`, v);
  };
  const localesOnly = (vals: string[]) => {
    // differences only between locales: every locale has a single value
    const per = new Map<string, Set<string>>();
    vals.forEach((v, i) => per.set(insts[i].locale, (per.get(insts[i].locale) ?? new Set()).add(v)));
    return [...per.values()].every((s) => s.size === 1);
  };
  let lastClassCtx = "text";
  tokens.forEach((tok, ti) => {
    const all = toks.map((t) => t[ti]);
    if (tok.startsWith("<") && !tok.startsWith("</")) {
      const c = (attrsOf(tok).get("class") ?? "").split(/\s+/).find((x) => x && !x.includes("{{"));
      if (c) lastClassCtx = c.includes("__") ? camel(c.split("__").pop()!) : camelClass(c);
    }
    if (all.every((t) => t === tok)) return;
    if (!tok.startsWith("<")) {
      const vals = all.map((t) => t.trim());
      if (vals.every((v) => v === vals[canonIdx])) return; // whitespace-only difference
      const [lead, , trail] = splitWs(tok);
      if (!opts.content || localesOnly(vals)) {
        if (insts.some((x, i) => i !== canonIdx && x.locale === canon.locale && vals[i] !== vals[canonIdx]))
          issues.push({ severity: "info", code: "COMPONENT_TEXT_VARIES", message: `${id}: static text "${vals[canonIdx].slice(0, 40)}" differs between instances`, ref: id });
        const key = keyFor(tok, used);
        // i18n values are plain text like content props (the template escapes `{{t.x}}`): decode the serialised token,
        // or "&amp;" in a translated string renders as "&amp;amp;" (W2-J, Umami es footer)
        all.forEach((_, i) => setI18n(key, i, decode(vals[i])));
        out[ti] = `${lead}{{t.${key}}}${trail}`;
      } else {
        const name = uniqueName(lastClassCtx, used);
        all.forEach((t, i) => setPath(values[i], name, decode(t.trim())));
        props.set(name, { name, type: "text" });
        out[ti] = `${lead}{{${name}}}${trail}`;
      }
      return;
    }
    // tag: attribute-level diff
    const attrsAll = all.map(attrsOf);
    let t = tok;
    const names = new Set(attrsAll.flatMap((a) => [...a.keys()]));
    for (const name of names) {
      const vals = attrsAll.map((a) => a.get(name));
      if (vals.every((v) => v === vals[canonIdx])) continue;
      if (vals.some((v) => (v ?? "").includes("{{"))) continue;
      if (name === "class") {
        t = setAttrInTag(t, "class", classTemplate(vals.map((v) => (v ?? "").split(/\s+/).filter(Boolean)), canonIdx, values, props, used, opts.content));
        continue;
      }
      const sv = vals.map((v) => v ?? "");
      if (!opts.content || localesOnly(sv)) {
        const key = keyFor(vals[canonIdx] ?? name, used);
        sv.forEach((v, i) => setI18n(key, i, decode(v)));
        t = setAttrInTag(t, name, `{{t.${key}}}`);
      } else {
        const pname = uniqueName(camel(name.replace(/^data-/, "")) || "attr", used);
        sv.forEach((v, i) => setPath(values[i], pname, decode(v)));
        props.set(pname, { name: pname, type: name === "href" ? "link" : "text" });
        if (vals.some((v) => v === undefined)) {
          t = removeAttrInTag(t, name);
          t = t.replace(/(\s*\/?>)$/, `{{#if ${pname}}} ${name}="{{${pname}}}"{{/if}}$1`);
        } else t = setAttrInTag(t, name, `{{${pname}}}`);
      }
    }
    out[ti] = t;
  });
  for (const [key, m] of i18n) props.set(`t.${key}`, { name: `t.${key}`, type: "text", i18n: m });
  return { template: out.join(""), props: [...props.values()], values, issues };
}

/** class attribute over instances: static tokens, `prefix-{{prop}}` for exclusive modifier groups, boolean flags for the rest */
function classTemplate(lists: string[][], canonIdx: number, values: Record<string, unknown>[], props: Map<string, PropDef>, used: Set<string>, prefixGroups: boolean): string {
  const allTokens: string[] = [];
  for (const l of [lists[canonIdx], ...lists]) for (const c of l) if (!allTokens.includes(c)) allTokens.push(c);
  const statics = allTokens.filter((c) => lists.every((l) => l.includes(c)));
  const variable = allTokens.filter((c) => !statics.includes(c));
  // group variable tokens by a shared `prefix-` (≥ 3 chars), each instance holding at most one token of the group
  const prefixOf = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const p = a.slice(0, i);
    const cut = Math.max(p.lastIndexOf("-"), p.lastIndexOf("_"));
    return cut >= 2 ? p.slice(0, cut + 1) : "";
  };
  const groups: { prefix: string; tokens: string[] }[] = [];
  for (const c of variable) {
    let g = prefixGroups ? groups.find((x) => x.prefix && c.startsWith(x.prefix)) : undefined;
    if (!g) {
      let best = "";
      if (prefixGroups) for (const o of variable) if (o !== c && prefixOf(o, c).length > best.length) best = prefixOf(o, c);
      g = { prefix: best.length >= 3 ? best : "", tokens: [] };
      groups.push(g);
    }
    g.tokens.push(c);
  }
  const tokenRule = new Map<string, string>();
  for (const g of groups) {
    const exclusive = g.prefix && g.tokens.length > 1 && lists.every((l) => l.filter((c) => g.tokens.includes(c)).length <= 1);
    if (exclusive) {
      const name = uniqueName(camelClass(g.prefix.replace(/[-_]+$/, "")) || "variant", used);
      props.set(name, { name, type: "text" });
      lists.forEach((l, i) => setPath(values[i], name, (l.find((c) => g.tokens.includes(c)) ?? "").slice(g.prefix.length)));
      const ph = lists.every((l) => l.some((c) => g.tokens.includes(c))) ? `${g.prefix}{{${name}}}` : `{{#if ${name}}}${g.prefix}{{${name}}}{{/if}}`;
      g.tokens.forEach((c, i) => tokenRule.set(c, i === 0 ? ph : ""));
    } else
      for (const c of g.tokens) {
        const name = uniqueName(camelClass(c) || "flag", used);
        props.set(name, { name, type: "text", valueType: "boolean" });
        lists.forEach((l, i) => setPath(values[i], name, l.includes(c)));
        tokenRule.set(c, `{{#if ${name}}}${c}{{/if}}`);
      }
  }
  // order: canonical order, then tokens of other instances in first-seen order
  const out: string[] = [];
  for (const c of allTokens) {
    if (statics.includes(c)) out.push(c);
    else {
      const r = tokenRule.get(c);
      if (r) out.push(r);
    }
  }
  return out.join(" ");
}

function firstDiff(a: string, b: string): string {
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  return `first difference at ${k}: rendered "${a.slice(Math.max(0, k - 60), k + 80)}" vs original "${b.slice(Math.max(0, k - 60), k + 80)}"`;
}

/** Canonical HTML for comparisons: parse + re-serialise, drop instance-only attributes, collapse whitespace. */
export function normalizeHtml(html: string): string {
  const tree = parseFragment(html);
  const strip = (n: dom.Root | Element) => {
    for (const c of n.children) {
      if (c.type === "element") {
        for (const k of Object.keys(c.properties)) if (DROP_ATTRS.has(k)) delete c.properties[k];
        // class order and empty class attributes do not change rendering
        if (Array.isArray(c.properties.className)) c.properties.className = (c.properties.className as string[]).filter(Boolean).sort();
        if (Array.isArray(c.properties.className) && !c.properties.className.length) delete c.properties.className;
        c.properties = Object.fromEntries(Object.entries(c.properties).sort(([a], [b]) => a.localeCompare(b)));
        strip(c);
      }
    }
  };
  strip(tree);
  return toHtml(tree).replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}

// ------------------------------------------------------------------ layout + content-type templates

function mainWrapperOf(info: PageInfo, header?: Element): Element | undefined {
  const mainEl = select("main", info.tree) ?? info.main;
  if (!mainEl) return undefined;
  const parents = dom.parentMap(info.tree);
  const chain = [mainEl, ...dom.ancestorsOf(mainEl, parents)];
  if (!header) return mainEl;
  const headerParent = parents.get(header);
  return chain.find((el) => parents.get(el) === headerParent) ?? mainEl;
}

const TRACKER_SRC = /[?&]id=GTM-|googletagmanager|google-analytics|gtag\/js|gtm\.js|doubleclick|facebook\.net|hotjar|clarity\.ms|segment\.(io|com)|analytics/i;

function buildLayout(pages: MinePage[], defaultLocale: string): { layout?: LayoutDef; pageVariant: Map<string, string>; issues: Issue[] } {
  const insts: Inst0[] = [];
  const bodies: { page: MinePage; body: Element }[] = [];
  for (const page of pages) {
    const body = select("body", page.info.tree);
    if (!body) continue;
    const ch = findChrome(page.info);
    const wrapper = mainWrapperOf(page.info, ch.header);
    const tpl = new Tpl(page.locale);
    const node = mapTree(body, (x) => {
      if (x === ch.header) return [T("{{{chrome.siteHeader}}}")];
      if (x === ch.footer) return [T("{{{chrome.siteFooter}}}")];
      if (x === ch.cookieBanner) return [T("{{{chrome.cookieBanner}}}")];
      if (x === wrapper) return [T("{{{main}}}")];
      // executable scripts are ported separately; data blocks (application/json, ld+json …) stay in the markup: the
      // site's own scripts read them by id (volkswagen.de <script id="spaModel" type="application/json">)
      if (x.tagName === "script" && !isDataScript(x)) return [];
      // tracker fallbacks (GTM <noscript><iframe>)
      if (x.tagName === "noscript" && selectAll("iframe", x).some((f) => TRACKER_SRC.test(attr(f, "src") ?? ""))) return [];
      return "recurse";
    });
    void tpl;
    const html = innerHtml(node).replace(/\n\s*\n/g, "\n");
    insts.push({ key: page.path, locale: page.locale, template: html, values: {}, props: [] });
    bodies.push({ page, body });
  }
  const pageVariant = new Map<string, string>();
  if (!insts.length) return { pageVariant, issues: [] };
  const canonIdx = Math.max(0, insts.findIndex((i) => i.locale === defaultLocale));
  const groups = groupByShape(insts).sort((a, b) => (a.includes(canonIdx) ? -1 : b.includes(canonIdx) ? 1 : a[0] - b[0]));
  const issues: Issue[] = [];
  const mergeOf = (g: number[]) => {
    const ci = g.includes(canonIdx) ? g.indexOf(canonIdx) : 0;
    return { ...mergeGroup("layout", g.map((i) => insts[i]), ci, { content: false }), ci };
  };
  const main = mergeOf(groups[0]);
  issues.push(...main.issues);
  const instanceProps: Record<string, Record<string, unknown>> = {};
  groups[0].forEach((idx, j) => {
    if (j !== main.ci && JSON.stringify(main.values[j]) !== JSON.stringify(main.values[main.ci])) instanceProps[insts[idx].key] = main.values[j];
  });
  const variants: NonNullable<LayoutDef["variants"]> = [];
  for (const [gi, g] of groups.slice(1).entries()) {
    const m = mergeOf(g);
    const vid = `v${gi + 2}`;
    variants.push({ id: vid, pages: g.map((i) => insts[i].key), template: m.template, props: m.props, exampleProps: m.values[m.ci] });
    for (const i of g) pageVariant.set(insts[i].key, vid);
    issues.push({ severity: "info", code: "LAYOUT_VARIANT", message: `layout differs structurally on ${g.map((i) => insts[i].key).join(", ")} — variant ${vid}`, ref: "layout" });
  }
  const canon = bodies[canonIdx];
  const ch = findChrome(canon.page.info);
  return {
    layout: {
      id: "default",
      htmlAttrs: { lang: "{{locale}}", dir: attr(select("html", canon.page.info.tree), "dir") ?? "ltr" },
      bodyAttrs: { class: "{{bodyClass}}" },
      template: main.template,
      chrome: [ch.header && "siteHeader", ch.footer && "siteFooter", ch.cookieBanner && "cookieBanner"].filter((x): x is string => !!x),
      props: main.props,
      exampleHtml: innerHtml(canon.body),
      exampleProps: main.values[main.ci],
      ...(variants.length ? { variants } : {}),
      ...(Object.keys(instanceProps).length ? { instanceProps } : {}),
    },
    pageVariant,
    issues,
  };
}

/** generic pages (no Drupal markup): the element whose children are the sections — single text-holding wrappers below
 *  main are skipped (AEM: main › div.aem-Grid › columns). The page template's content region is this element. */
function genericSectionRoot(main: Element): Element {
  let root = main;
  for (let i = 0; i < 6; i++) {
    const kids = childElements(root).filter((k) => text(k));
    if (kids.length === 1 && !/^h[1-6]$/.test(kids[0].tagName)) root = kids[0];
    else break;
  }
  return root;
}

const regionNameOf = (el: Element) => {
  const c = classes(el).find((x) => /^region-{1,2}[\w-]+$/.test(x));
  return c ? camel(c.replace(/^region-{1,2}/, "")) : undefined;
};

function buildContentTemplate(type: string, page: MinePage, components: Map<string, ComponentDef>, titleFlags: Record<string, unknown> | undefined, variantOf: (base: string) => string, rich: boolean): TemplateDef {
  const info = page.info;
  const ch = findChrome(info);
  const wrapper = mainWrapperOf(info, ch.header);
  const titleBlock = titleBlockOf(info.tree);
  const slots: TemplateDef["slots"] = [];
  let wrapperHtml: string | undefined;
  const chrome = ["siteHeader", "siteFooter", ...(ch.cookieBanner ? ["cookieBanner"] : [])].filter((c) => components.has(c)).map(variantOf);

  if (rich && wrapper && info.main) {
    // Drupal theme regions: every slot renders into the region (div.region-<name>) that holds it on the original page
    const parents = dom.parentMap(info.tree);
    const regionOf = (el: Element) => [el, ...dom.ancestorsOf(el, parents)].find((a) => regionNameOf(a) && classes(a).includes("region"));
    const node = documentRootOf(info.main, nodeBodyOf(info.main));
    const container = componentsContainerOf(info.main);
    const listing = !node ? listingOf(info, info.main, rich) : undefined;
    const blocks = contentBlocksOf(info.main, [node, container, titleBlock, listing?.root].filter((x): x is Element => !!x));
    const items: { el: Element; slot: TemplateDef["slots"][number] }[] = [];
    if (titleBlock && components.has("pageTitle")) items.push({ el: titleBlock, slot: { component: variantOf("pageTitle"), field: "title", ...(titleFlags && Object.keys(titleFlags).length ? { props: titleFlags } : {}) } });
    if (node && components.has(`${type}Body`)) items.push({ el: node, slot: { component: variantOf(`${type}Body`) } });
    if (container && components.has(`${type}Components`)) items.push({ el: container, slot: { component: variantOf(`${type}Components`) } });
    if (listing && components.has(listing.id)) items.push({ el: listing.root, slot: { component: "$collection" } });
    for (const b of blocks) if (components.has(blockIdOf(b))) items.push({ el: b, slot: { component: variantOf(blockIdOf(b)) } });
    for (const b of sideViewBlocksOf(info, wrapper)) if (components.has(blockIdOf(b))) items.push({ el: b, slot: { component: variantOf(blockIdOf(b)) } });
    const order = new Map<Element, number>();
    let n = 0;
    dom.walk(info.tree, (el) => void order.set(el, n++));
    items.sort((a, b) => order.get(a.el)! - order.get(b.el)!);
    const regions = new Set<Element>();
    for (const it of items) {
      const r = regionOf(it.el);
      if (r) regions.add(r);
      slots.push({ ...it.slot, region: r ? regionNameOf(r)! : "content" });
    }
    // regions: the first slot-holding child becomes {{{regions.<name>}}}, further slot holders are dropped (they render
    // inside the same region placeholder), other children (page-specific static blocks) stay in the wrapper
    const slotEls = items.map((i) => i.el);
    const holds = (c: Element) => slotEls.some((e) => e === c || selectAll("*", c).includes(e));
    const node2 = mapTree(wrapper, (x, xc) => {
      if (!regions.has(x)) return "recurse";
      const kids: ElementContent[] = [];
      let placed = false;
      for (const c of x.children) {
        if (c.type === "element" && holds(c)) {
          if (!placed) kids.push(T(`{{{regions.${regionNameOf(x)}}}}`));
          placed = true;
        } else kids.push(c.type === "element" ? mapTree(c, identity) : (structuredClone(c) as ElementContent));
      }
      return withChildren(xc, kids);
    });
    if (!regions.size) node2.children = [T("{{{regions.content}}}")];
    // static wrapper text that is this page's title (breadcrumb's last item): {{title}}, so other entries of the
    // type show their own title instead of the crawled example's
    if (info.pageTitle) titleTextToProp(node2, info.pageTitle);
    wrapperHtml = toHtml(node2);
  } else {
    const above = titleBlock ? select(".region--content-above", info.tree) : undefined;
    const generic = !components.has(`${type}Body`) && components.has("sectionGeneric");
    // generic sections are the children of genericSectionRoot(main): the region goes there, so wrappers between main and
    // the sections (AEM's div.aem-Grid) stay in the page template
    const mainBlock = select(".block-system-main-block", info.tree) ?? (generic && info.main ? genericSectionRoot(info.main) : info.main);
    if (titleBlock && components.has("pageTitle")) slots.push({ component: "pageTitle", field: "title", region: above ? "contentAbove" : "content", ...(titleFlags && Object.keys(titleFlags).length ? { props: titleFlags } : {}) });
    if (components.has(`${type}Body`)) slots.push({ component: `${type}Body`, region: "content" });
    else if (generic) slots.push({ component: "sectionGeneric", field: "sections", repeat: true, region: "content" });
    if (wrapper) {
      const node = mapTree(wrapper, (x, xc) => {
        if (above && x === above) return withChildren(xc, [T("{{{regions.contentAbove}}}")]);
        if (x === mainBlock) return withChildren(xc, [T("{{{regions.content}}}")]);
        return "recurse";
      });
      if (wrapper === mainBlock) node.children = [T("{{{regions.content}}}")];
      wrapperHtml = toHtml(node);
    }
  }
  return {
    contentType: type,
    layout: "default",
    chrome,
    slots,
    bodyClass: classes(select("body", info.tree)).join(" ") || undefined,
    wrapperHtml,
    examplePath: page.path,
  };
}

function localiseWrapper(
  t: TemplateDef,
  pages: MinePage[],
  components: Map<string, ComponentDef>,
  titleFlagsByPage: Map<string, Record<string, unknown>>,
  pageDesign: Record<string, PageDesign>,
  typeVariant: Map<string, Map<string, string>>,
  rich: boolean,
  issues: Issue[],
): void {
  const canon = pages.find((p) => p.path === t.examplePath);
  if (!canon || !t.wrapperHtml) return;
  const insts: Inst0[] = [{ key: canon.path, locale: canon.locale, template: t.wrapperHtml, values: {}, props: [] }];
  const shape = shapeOf(t.wrapperHtml);
  const slots = JSON.stringify(t.slots);
  for (const locale of [...new Set(pages.map((p) => p.locale))].filter((l) => l !== canon.locale).sort()) {
    // first page of the type in that locale whose wrapper has the canonical shape and slots (token-by-token merge)
    let differs = 0;
    for (const page of pages.filter((p) => p.locale === locale && p.ccmType === t.contentType)) {
      const variantOf = (base: string) => pageDesign[page.path]?.components[base] ?? typeVariant.get(base)?.get(page.ccmType!) ?? base;
      const own = buildContentTemplate(page.ccmType!, page, components, titleFlagsByPage.get(page.path), variantOf, rich);
      if (own.wrapperHtml && JSON.stringify(own.slots) === slots && shapeOf(own.wrapperHtml) === shape) {
        insts.push({ key: page.path, locale, template: own.wrapperHtml, values: {}, props: [] });
        differs = -1;
        break;
      }
      differs++;
    }
    if (differs > 0)
      issues.push({ severity: "info", code: "TEMPLATE_LOCALE_DIFFERS", message: `template ${t.contentType}: no ${locale} page with the wrapper structure of ${canon.path} (${differs} checked) — ${locale} pages of this type use the ${canon.locale} wrapper text`, ref: t.contentType });
  }
  if (insts.length < 2) return;
  const m = mergeGroup(`${t.contentType}Wrapper`, insts, 0, { content: false });
  const i18n = Object.fromEntries(m.props.filter((p) => p.i18n && p.name.startsWith("t.")).map((p) => [p.name.slice(2), p.i18n!]));
  if (!Object.keys(i18n).length) return;
  t.wrapperHtml = m.template;
  t.i18n = i18n;
}

/** text nodes whose trimmed value is the page title → `{{title}}` (whitespace kept); script/style/template untouched */
function titleTextToProp(el: Element, title: string): void {
  for (const c of el.children) {
    if (c.type === "text" && c.value.trim() === title.trim()) {
      const [lead, , trail] = splitWs(c.value);
      c.value = `${lead}{{title}}${trail}`;
    } else if (c.type === "element" && !["script", "style", "template", "title"].includes(c.tagName)) titleTextToProp(c, title);
  }
}

// ------------------------------------------------------------------ main

const NAMES: Record<string, string> = {
  siteHeader: "Site header",
  mainNav: "Main navigation",
  languageSwitcher: "Language switcher",
  siteFooter: "Site footer",
  footerNav: "Footer navigation",
  cookieBanner: "Cookie banner",
  pageTitle: "Page title",
  embeddedMedia: "Embedded media (rich text)",
};
const humanize = (id: string) => NAMES[id] ?? id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const KIND_ORDER = { chrome: 0, document: 1, section: 2 };

/** Theme markup that needs the rich miner (BEM props, nested entities, regions): Drupal themes with aggregated JS/behaviours. */
/** inert data block (JSON, ld+json, templates): not executed, read by the page's scripts; `{{` would be template syntax */
function isDataScript(el: Element): boolean {
  const type = attr(el, "type");
  // drupalSettings is placed by the static plan itself
  if (attr(el, "dataDrupalSelector") === "drupal-settings-json") return false;
  return !!type && !/^(text|application)\/(javascript|ecmascript)$|^module$/i.test(type) && !text(el).includes("{{");
}

export function isRichDrupalTheme(info: PageInfo): boolean {
  return info.scripts.some((s) => !!s.src && /\/sites\/[^/]+\/files\/js\/js_|\/core\/assets\/vendor\/jquery\//.test(s.src)) || !!select("[data-block-plugin-id]", info.tree);
}

/**
 * Profile set of the current (synchronous) mineComponents run: site mapping/profiles.yaml > theme pack > generic,
 * resolved by the step (`resolveProfileSet`). undefined = @cmp/source-html's DEFAULT_PROFILE_SET (da_vinci_code).
 */
let MINING_PROFILES: ProfileSet | undefined;

export function mineComponents(pages: MinePage[], opts: { defaultLocale: string; rich?: boolean; profiles?: ProfileSet }): MineResult {
  const prev = MINING_PROFILES;
  MINING_PROFILES = opts.profiles;
  try {
    return mineComponentsImpl(pages, opts);
  } finally {
    MINING_PROFILES = prev;
  }
}

function mineComponentsImpl(pages: MinePage[], opts: { defaultLocale: string; rich?: boolean }): MineResult {
  const issues: Issue[] = [];
  const sorted = [...pages].sort((a, b) => (a.locale === opts.defaultLocale ? 0 : 1) - (b.locale === opts.defaultLocale ? 0 : 1) || a.path.localeCompare(b.path));
  const rich = opts.rich ?? sorted.some((p) => isRichDrupalTheme(p.info));
  // global list-item rules (classes that follow active/children state) per list component
  const listRules = new Map<string, Rules>();
  const lists: Record<string, Element[]> = { mainNav: [], footerNav: [], languageSwitcher: [] };
  for (const p of sorted) {
    const ch = findChrome(p.info);
    for (const [id, el] of [["mainNav", ch.mainNav], ["footerNav", ch.footerNav], ["languageSwitcher", ch.languageSwitcher]] as const) {
      const ul = el ? select("ul, ol", el) : undefined;
      if (ul) lists[id].push(ul);
    }
  }
  for (const [id, uls] of Object.entries(lists)) listRules.set(id, computeRules(collectItems(uls)));

  const byId = new Map<string, Instance[]>();
  for (const p of sorted) for (const inst of detect(p, listRules, rich)) byId.set(inst.id, [...(byId.get(inst.id) ?? []), inst]);

  const components = new Map<string, ComponentDef>();
  const titleFlagsByPage = new Map<string, Record<string, unknown>>();
  const pageDesign: Record<string, PageDesign> = {};
  for (const p of sorted) pageDesign[p.path] = { ...(p.ccmType ? { contentType: p.ccmType } : {}), locale: p.locale, bodyClass: classes(select("body", p.info.tree)).join(" ") || undefined, components: {} };
  /** component id -> content type -> variant id (variants observed only on pages of one content type) */
  const typeVariant = new Map<string, Map<string, string>>();

  for (const [id, insts] of byId) {
    const canonIdx = Math.max(0, insts.findIndex((i) => i.page.locale === opts.defaultLocale));
    const groups = groupByShape(insts).sort((a, b) => (a.includes(canonIdx) ? -1 : b.includes(canonIdx) ? 1 : a[0] - b[0]));
    const usedIds = new Set<string>();
    for (const [gi, g] of groups.entries()) {
      const gInsts = g.map((i) => insts[i]);
      const ci = gi === 0 ? g.indexOf(canonIdx) : 0;
      const canon = gInsts[ci];
      let cid = id;
      if (gi > 0) {
        const types = [...new Set(gInsts.map((i) => i.page.ccmType ?? ""))];
        const canonTypes = new Set(groups[0].map((i) => insts[i].page.ccmType ?? ""));
        cid = types.length === 1 && types[0] && !canonTypes.has(types[0]) && !usedIds.has(`${id}${pascal(types[0])}`) ? `${id}${pascal(types[0])}` : `${id}V${gi + 1}`;
        if (types.length === 1 && types[0] && cid.endsWith(pascal(types[0]))) {
          const m = typeVariant.get(id) ?? new Map<string, string>();
          m.set(types[0], cid);
          typeVariant.set(id, m);
        }
        issues.push({ severity: "info", code: "COMPONENT_VARIANT", message: `${id}: ${gInsts.length} instance(s) on ${[...new Set(gInsts.map((i) => i.page.path))].join(", ")} differ structurally from ${insts[canonIdx].page.path} — variant ${cid}`, ref: cid });
      }
      usedIds.add(cid);
      const m = mergeGroup(cid, gInsts.map((i) => ({ key: i.key, locale: i.page.locale, template: i.template, values: i.values, props: i.props })), ci, { content: rich });
      issues.push(...m.issues);
      if (process.env.CMP_DESIGN_DEBUG === cid) console.error(JSON.stringify({ merged: m.template, values: m.values, insts: gInsts.map((i) => i.template) }, null, 1));
      // self-check every instance
      let ok = 0;
      let canonOk = false;
      let firstBad = "";
      for (const [j, inst] of gInsts.entries()) {
        let same = false;
        try {
          const a = normalizeHtml(renderTemplate(m.template, m.values[j]));
          const b = normalizeHtml(outerHtml(inst.el));
          same = a === b;
          if (!same && !firstBad) firstBad = ` — e.g. ${inst.key}: ${firstDiff(a, b)}`;
        } catch (e) {
          if (j === ci) issues.push({ severity: "error", code: "COMPONENT_TEMPLATE_INVALID", message: `${cid}: ${(e as Error).message}`, ref: cid, actionable: true });
        }
        if (same) ok++;
        if (j === ci) canonOk = same;
      }
      let template = m.template;
      let props = m.props;
      let values = m.values;
      let degraded = false;
      if (!canonOk && rich) {
        let where = "";
        try {
          where = ` (${firstDiff(normalizeHtml(renderTemplate(m.template, m.values[ci])), normalizeHtml(outerHtml(canon.el)))})`;
        } catch (e) {
          where = ` (${(e as Error).message})`;
        }
        // graceful degradation: the original markup verbatim (content stays static; still renders 1:1 for this instance)
        const tpl = new Tpl(canon.page.locale);
        template = tpl.serialize(mapTree(canon.el, identity));
        props = [];
        values = gInsts.map(() => ({}));
        degraded = true;
        canonOk = normalizeHtml(renderTemplate(template, {})) === normalizeHtml(outerHtml(canon.el));
        issues.push({ severity: "warning", code: "COMPONENT_DEGRADED", message: `${cid}: mined template did not reproduce the original — using the static original markup (props dropped)${where}`, ref: cid, actionable: true });
      }
      if (!canonOk) issues.push({ severity: "warning", code: "COMPONENT_NOT_REPRODUCIBLE", message: `${cid}: template + exampleProps does not reproduce the original HTML`, ref: cid, actionable: true });
      else if (ok < gInsts.length && !degraded) issues.push({ severity: "info", code: "COMPONENT_INSTANCE_DIFFERS", message: `${cid}: ${gInsts.length - ok}/${gInsts.length} instance(s) do not re-render exactly${firstBad}`, ref: cid });
      if (id === "pageTitle" && gi === 0) {
        const flagNames = props.filter((p) => p.valueType === "boolean").map((p) => p.name);
        gInsts.forEach((inst, j) => titleFlagsByPage.set(inst.page.path, Object.fromEntries(flagNames.map((f) => [f, getPath(values[j], f) ?? false]))));
      }
      const exampleProps = values[ci];
      const instanceKey: ComponentDef["instanceKey"] = canon.kind === "section" ? "entityId" : "path";
      const instanceProps: Record<string, Record<string, unknown>> = {};
      // html props rendered by another component (siteHeader.mainNav) are not repeated per instance
      const viaComponent = props.filter((p) => p.component).map((p) => p.name);
      if (rich)
        gInsts.forEach((inst, j) => {
          const v = { ...values[j] };
          for (const n of viaComponent) delete v[n];
          instanceProps[inst.key] = v;
        });
      for (const inst of gInsts) if (gi > 0 && canon.kind !== "section") pageDesign[inst.page.path].components[id] = cid;
      components.set(cid, {
        id: cid,
        name: gi > 0 ? `${humanize(id)} (${cid.slice(id.length)})` : humanize(id),
        selector: describe(canon.el),
        kind: canon.kind,
        ...(canon.ccmType ? { ccmType: canon.ccmType } : {}),
        ...(canon.viewMode ? { viewMode: canon.viewMode } : {}),
        template,
        props,
        exampleHtml: outerHtml(canon.el),
        exampleProps,
        source: "heuristic",
        instances: gInsts.length,
        pages: [...new Set(gInsts.map((i) => i.page.path))].sort(),
        locales: [...new Set(gInsts.map((i) => i.page.locale))].sort(),
        verified: canonOk,
        ...(gi > 0 ? { variantOf: id } : {}),
        ...(rich ? { instanceKey, instanceProps, instancesVerified: degraded ? 1 : ok } : {}),
        ...(degraded ? { degraded } : {}),
      });
    }
  }
  const list = [...components.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));

  // content-type templates from the canonical (default-locale) page of every type
  const templates: TemplateDef[] = [];
  const types = [...new Set(sorted.map((p) => p.ccmType).filter((t): t is string => !!t))].sort();
  for (const type of types) {
    const page = sorted.find((p) => p.ccmType === type)!;
    const variantOf = (base: string) => pageDesign[page.path]?.components[base] ?? typeVariant.get(base)?.get(type) ?? base;
    templates.push(buildContentTemplate(type, page, components, titleFlagsByPage.get(page.path), variantOf, rich));
  }
  // pages whose structure differs from their content-type template get their own slots/wrapper
  if (rich)
    for (const page of sorted) {
      const t = templates.find((x) => x.contentType === page.ccmType);
      if (!t || t.examplePath === page.path) continue;
      const variantOf = (base: string) => pageDesign[page.path]?.components[base] ?? typeVariant.get(base)?.get(page.ccmType!) ?? base;
      const own = buildContentTemplate(page.ccmType!, page, components, titleFlagsByPage.get(page.path), variantOf, rich);
      if (JSON.stringify([own.slots, own.wrapperHtml]) !== JSON.stringify([t.slots, t.wrapperHtml])) pageDesign[page.path].template = { slots: own.slots, wrapperHtml: own.wrapperHtml };
    }
  // (after the per-page overrides, which compare against the canonical wrapper)
  // multilingual: the wrapper's static text/attributes per locale (breadcrumb "Home" / "Inicio", hrefs with the locale
  // prefix, static sidebar blocks) from one crawled page of the type in every other locale → {{t.<key>}} + template i18n,
  // so uncrawled pages of that locale render their own language instead of the canonical page's
  if (rich) for (const t of templates) localiseWrapper(t, sorted, components, titleFlagsByPage, pageDesign, typeVariant, rich, issues);
  // pages whose variant equals their content-type template need no override
  for (const [path, pd] of Object.entries(pageDesign)) {
    const t = templates.find((x) => x.contentType === pd.contentType);
    const used = new Set([...(t?.chrome ?? []), ...(t?.slots.map((s) => s.component) ?? []), ...(pd.template?.slots.map((s) => s.component) ?? [])]);
    for (const [base, v] of Object.entries(pd.components)) if (used.has(v)) delete pd.components[base];
    void path;
  }
  const { layout, pageVariant, issues: li } = buildLayout(sorted, opts.defaultLocale);
  for (const [path, v] of pageVariant) if (pageDesign[path]) pageDesign[path].layoutVariant = v;
  issues.push(...li);
  return { components: list, templates, layout, pages: rich ? pageDesign : {}, issues };
}

export { templateEntity as _templateEntity, Tpl as _Tpl };
