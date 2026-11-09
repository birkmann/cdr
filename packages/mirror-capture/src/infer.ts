/**
 * Profile inference, deterministic part (P2, docs/DEEPSEEK_ONLY_PLAN.md §5.3). Theme-agnostic.
 *
 *  - analyzeCoverage(): which server-HTML text of every entity root (paragraph / view-mode node / theme item) and of the
 *    document body no typed CCM field covers. Reported as STRUCTURE ONLY (selector path, tag, textLength,
 *    hasInlineMarkup, isImage, isLink, repeated) — never the text itself, so it can go into an LLM dossier.
 *  - inferProfiles(): the rule pre-pass. BEM `block__element` children with text -> text / richText slots,
 *    <img>/<picture> -> asset(s), classed anchors -> link(s) (+ labelSel), repeated matches -> textList / links / assets,
 *    BEM block roots holding uncovered document text -> entityRoots.
 *  - skeletonOf(): element skeleton for dossiers (text -> "…", attribute values except class -> "…").
 *  - measureTextCoverage() / simulateCoverage(): the covered-text ratio of a workspace (after transform) or of an
 *    in-memory transform with a candidate mapping/profiles.yaml.
 */
import type { Entry, Issue, SiteConfig, Workspace } from "@harness/mirror-core";
import { readCrawl, type AssetRecord, type LinkProbe, type PageManifest, type CrawlIndex } from "./crawl.js";
import { pageContentHtml } from "./content-source.js";
import { attr, childElements, classes, pathOf, selectAll, text, toHtml, walk, type Element, type ElementContent } from "./dom.js";
import { bundleToType, paragraphToType, parsePage } from "./page.js";
import { profileSetFor, type ListItemSpec, type ParagraphProfile, type ProfilePack, type ProfileSet, type SlotDef, type SlotKind } from "./profiles.js";
import { resolveProfileSet } from "./theme-pack.js";
import { buildCcm, classifyField, entityRoot, fieldInfo, type ToCcmResult } from "./to-ccm.js";
import { fieldNameToId } from "./page.js";

// ------------------------------------------------------------------ types

export interface UncoveredElement {
  /** selector relative to the entity root (class-based; matches with to-ccm slot semantics) */
  selector: string;
  tag: string;
  /** characters of visible text (0 for images, which weigh IMAGE_WEIGHT in the ratio); max over instances */
  textLength: number;
  hasInlineMarkup: boolean;
  isImage: boolean;
  /** inside (or is) an anchor of the root */
  isLink: boolean;
  /** matches of `selector` inside one instance (max over instances) */
  repeated: number;
  /** instances of the group showing it uncovered */
  instances: number;
  /** inside a Drupal field wrapper (mapped generically; a mapping issue, not a profile slot) */
  inField?: boolean;
  /**
   * what is uncovered besides text: the href of a link, a form, an inline background image, a JSON data island
   * (`<script type="application/json">`), a repeated data item (element carrying a `data-*-id` attribute)
   */
  what?: "href" | "form" | "bgImage" | "json" | "data" | "variant";
  /** what === "variant": the class-derived value a typed field should hold (class names only, never text) */
  variant?: VariantUnit;
  /** what === "href" of the anchor wrapping the whole entity root (to-ccm `parentLink`); labelSel of its label element */
  parentLink?: { labelSel?: string };
}

/**
 * A class-derived value: a variant class on entity roots (`cta-style-primary` → classField `^cta-style-(.+)$`), a state
 * class that varies between instances of one type (`is-expanded` → profile flag), or the class list of a component
 * element carrying a BEM modifier (`card-grid card-grid--2` → `classes` slot).
 */
export type VariantUnit =
  | { kind: "classField"; prefix: string; sep: "-" | "--"; field: string }
  | { kind: "flag"; cls: string; field: string }
  | { kind: "classes"; sel: string; field: string };

export interface CoverageGroup {
  /** Drupal machine name; `document:<ccmType>` for text outside every entity root */
  machine: string;
  entity: "paragraph" | "node" | "item" | "document";
  ccmType: string;
  instances: number;
  pages: string[];
  totalChars: number;
  coveredChars: number;
  ratio: number;
  uncovered: UncoveredElement[];
  /** per page path: chars of this group's instances on that page */
  byPage: Record<string, { totalChars: number; coveredChars: number }>;
}

export interface TextCoverage {
  profileSet: string;
  totalChars: number;
  coveredChars: number;
  ratio: number;
  groups: CoverageGroup[];
}

export interface InstanceRef {
  root: Element;
  page: string;
  /** text units of the root that are not covered */
  uncovered: Element[];
}

export interface CoverageAnalysis {
  coverage: TextCoverage;
  /** machine -> instance roots (in page order) */
  instances: Map<string, InstanceRef[]>;
  /** BEM block roots holding uncovered document-level text: selector -> machine/count */
  blockRoots: { sel: string; machine: string; uncoveredChars: number; instances: number }[];
  /** every uncovered element per page (deduped by page + group + selector), for issues */
  findings: CoverageFinding[];
  ps: ProfileSet;
}

export interface CoverageFinding extends Omit<UncoveredElement, "instances" | "repeated"> {
  page: string;
  machine: string;
  entity: CoverageGroup["entity"];
  ccmType: string;
  /** matches on this page */
  count: number;
  /** a section of this type on this page kept an `html` fallback (→ SECTION_TEXT_UNMAPPED already reported it) */
  fallback?: boolean;
}

export interface CoveragePage {
  path: string;
  /** final URL of the crawl (entries' source.url starts with it) */
  finalUrl: string;
  html: string;
}

// ------------------------------------------------------------------ text helpers

const SKIP_TAGS = new Set(["script", "style", "svg", "button", "form", "label", "select", "option", "noscript", "template", "input", "textarea", "nav"]);
const INLINE = new Set(["a", "b", "strong", "i", "em", "span", "abbr", "sup", "sub", "br", "small", "code", "u", "s", "mark", "time", "img", "picture", "source", "wbr"]);
const BLOCK_CHILD = new Set(["p", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "dl"]);
const HIDDEN = /^(visually-hidden|sr-only|hidden|element-invisible)$/;
/** whitespace-free form used for containment checks (robust to inline markup splitting text nodes) */
const squash = (s: string) => s.replace(/\s+/g, "");
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#039": "'", "#160": " " };
/** text of an HTML string value (rawHtml blocks, *Html siblings, kept forms) */
const htmlToPlain = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&([a-z]+|#\d+);/gi, (m, e: string) => ENT[e.toLowerCase()] ?? (e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : m));

const directText = (el: Element) => el.children.some((c) => c.type === "text" && c.value.trim().length > 0);
const isHidden = (el: Element) => classes(el).some((c) => HIDDEN.test(c)) || attr(el, "ariaHidden") === "true";

function typeOf(r: { machine: string; entity: string }): string {
  return r.entity === "node" ? bundleToType(r.machine) : paragraphToType(r.machine);
}

/** Elements of an entity (not inside nested entity roots). */
function ownSet(root: Element, ps: ProfileSet): Set<Element> {
  const own = new Set<Element>();
  walk(root, (el) => {
    if (el !== root && entityRoot(el, ps)) return false;
    own.add(el);
    return true;
  });
  return own;
}

/** Text units of an entity root: elements with a direct visible text node (descendants of a unit belong to it) + images. */
function units(root: Element, ps: ProfileSet): { texts: Element[]; images: Element[] } {
  const texts: Element[] = [];
  const images: Element[] = [];
  const rec = (el: Element) => {
    for (const c of el.children) {
      if (c.type !== "element") continue;
      // field labels come from the field config (schema), not from the content
      if (SKIP_TAGS.has(c.tagName) || isHidden(c) || classes(c).includes("field__label")) continue;
      if (c !== root && entityRoot(c, ps)) continue;
      if (c.tagName === "img") {
        images.push(c);
        continue;
      }
      if (directText(c)) {
        texts.push(c);
        for (const i of selectAll("img", c)) images.push(i);
        continue;
      }
      rec(c);
    }
  };
  if (directText(root)) texts.push(root);
  else rec(root);
  return { texts, images };
}

/** typed string values of entries (squashed), without the `html` fallback and class lists */
function typedValues(entries: Entry[]): string {
  const out: string[] = [];
  const rec = (v: unknown, key: string) => {
    if (typeof v === "string") out.push(squash(/<[a-z!/]/i.test(v) ? htmlToPlain(v) : v));
    else if (Array.isArray(v)) v.forEach((x) => rec(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) rec(x, k);
  };
  for (const e of entries) for (const [k, v] of Object.entries(e.fields)) if (k !== "html" && k !== "classes" && !/Classes$/.test(k)) rec(v, k);
  // rich text docs: also the concatenation of each field's text leaves (text split by inline marks)
  for (const e of entries)
    for (const [k, v] of Object.entries(e.fields)) {
      if (k === "html" || !v || typeof v !== "object") continue;
      const leaves: string[] = [];
      const walkV = (x: unknown) => {
        if (typeof x === "string") leaves.push(x);
        else if (Array.isArray(x)) x.forEach(walkV);
        else if (x && typeof x === "object") for (const [kk, y] of Object.entries(x)) if (kk === "value" || kk === "content" || kk === "children") walkV(y);
      };
      walkV(v);
      if (leaves.length > 1) out.push(squash(leaves.join("")));
    }
  return out.join("\u0000");
}

const bemElementClass = (el: Element) => classes(el).find((c) => /^[a-z0-9-]+__[a-z0-9_-]+$/i.test(c) && !/--/.test(c.split("__")[1] ?? ""));
const bemBlockClasses = (el: Element) => classes(el).filter((c) => /^[a-z][a-z0-9-]*$/.test(c) && !c.includes("__") && !c.includes("--"));
const cssEscape = (c: string) => c.replace(/([^a-zA-Z0-9_-])/g, "\\$1");

/** class-based selector of `el` relative to `root`: `.block__el`, `.anc__el tag`, `tag.class`, `tag` */
function selectorFor(el: Element, root: Element, parents: Map<Element, Element>): string {
  const own = bemElementClass(el);
  if (own) return `.${cssEscape(own)}`;
  const plain = classes(el).find((c) => /^[a-z][a-z0-9_-]*$/i.test(c) && !/^(is-|has-|js-|visually-hidden)/.test(c));
  if (plain) return `${el.tagName}.${cssEscape(plain)}`;
  for (let a = parents.get(el); a && a !== root; a = parents.get(a)) {
    const c = bemElementClass(a);
    if (c) return `.${cssEscape(c)} ${el.tagName}`;
  }
  return el.tagName;
}

function parentsOf(root: Element): Map<Element, Element> {
  const m = new Map<Element, Element>();
  walk(root, (el, anc) => {
    if (anc.length) m.set(el, anc[anc.length - 1]);
  });
  return m;
}

// ------------------------------------------------------------------ structured data (theme-agnostic)

/** id-like data attributes (`data-id`, `data-brand-id`, `data-category-id`) */
const DATA_ID = /^data-(?:[a-z0-9]+-)*id$/;
/** data attributes Drupal core / contrib print for its own bookkeeping (never content) */
const DATA_SKIP = /^data-(drupal|block|quickedit|contextual|history|big-pipe|once|views|entity|layout|component|off-canvas|dialog|toggle|bs|slick)(-|$)/;
const kebab = (prop: string) => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** `data-*` attributes with a non-empty value (kebab names), Drupal bookkeeping attributes excluded */
function dataAttrs(el: Element): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(el.properties ?? {})) {
    if (!/^data[A-Z0-9]/.test(k) || v === undefined || v === null || v === "" || typeof v === "boolean") continue;
    const name = kebab(k);
    if (DATA_SKIP.test(name)) continue;
    out.push([name, Array.isArray(v) ? v.join(" ") : String(v)]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Repeated data items of an entity root: own elements carrying an id-like `data-*` attribute, grouped by their
 * class-based selector; a group counts when it has ≥ 2 elements with ≥ 2 distinct values of one id attribute
 * (filter pills, carousel bubbles, tabs keyed by an id). element -> { sel, idAttr }
 */
function dataItemsOf(root: Element, own: Set<Element>, parents: Map<Element, Element>): Map<Element, { sel: string; idAttr: string }> {
  const bySel = new Map<string, Element[]>();
  walk(root, (el) => {
    if (el !== root && !own.has(el)) return false;
    if (["script", "style", "svg", "template", "noscript", "nav", "form"].includes(el.tagName)) return false;
    if (el !== root && dataAttrs(el).some(([n]) => DATA_ID.test(n))) {
      const sel = selectorFor(el, root, parents);
      (bySel.get(sel) ?? bySel.set(sel, []).get(sel)!).push(el);
    }
    return true;
  });
  const out = new Map<Element, { sel: string; idAttr: string }>();
  for (const [sel, els] of bySel) {
    if (els.length < 2 || !/[.[]/.test(sel)) continue; // bare tags are too ambiguous
    // the matched set must be exactly these elements (selector semantics of to-ccm)
    if (safeSelectAll(sel, root).filter((x) => own.has(x)).length !== els.length) continue;
    const idAttr = dataAttrs(els[0])
      .map(([n]) => n)
      .find((n) => DATA_ID.test(n) && new Set(els.map((e) => dataAttrs(e).find(([k]) => k === n)?.[1])).size >= 2);
    if (!idAttr) continue;
    for (const e of els) out.set(e, { sel, idAttr });
  }
  return out;
}

/** a JSON data island of a component (not Drupal's settings JSON, not SEO JSON-LD) */
function isDataIsland(el: Element): boolean {
  return el.tagName === "script" && (attr(el, "type") ?? "").toLowerCase() === "application/json" && !/drupal-settings/.test(attr(el, "dataDrupalSelector") ?? "");
}

/** a distinctive string of a data island (the CCM keeps it when the island is mapped); undefined = no string content */
function dataIslandProbe(el: Element): string | undefined {
  let v: unknown;
  try {
    v = JSON.parse(el.children.map((c) => ("value" in c ? String(c.value) : "")).join(""));
  } catch {
    return undefined;
  }
  const stack = [v];
  while (stack.length) {
    const x = stack.shift();
    if (typeof x === "string") {
      if (x.length >= 3 && !/^(https?:)?\/\//.test(x) && !x.startsWith("/")) return x;
    } else if (Array.isArray(x)) stack.push(...x);
    else if (x && typeof x === "object") stack.push(...Object.values(x));
  }
  return undefined;
}

/** class-derived values weigh this many characters in the covered ratio */
export const VARIANT_WEIGHT = 5;
/** Drupal core / theme-system class families that never carry a content variant */
const CLASS_SKIP = /^(paragraph|node|field|block|views?|layout|region|js|is|has|contextual|clearfix|visually|element|path|page|user|toolbar|menu|form|entity|media|align|text-formatted|lazy|ajax|once)(-|$)/;
/** …plus carousel-library classes, which never name a content variant on an entity root */
const ROOT_CLASS_SKIP = /^(slick|blazy|swiper|splide|owl|flickity)(-|$)/;

/**
 * Site-wide variant class analysis over every entity root. A prefix `P` (split at the last `--`, else at any `-`) is a
 * variant prefix when its classes use the BEM modifier syntax (`x--y`), or one type shows ≥ 2 values, or ≥ 2 values
 * exist and a value is shared by ≥ 2 types (a vocabulary such as colours, not a type name). Each class takes its
 * longest variant prefix. State classes `is-x` that some but not all instances of a type carry become flags.
 */
function variantClasses(roots: { el: Element; machine: string }[], ps: ProfileSet) {
  const stats = new Map<string, { prefix: string; sep: "-" | "--"; values: Map<string, Set<string>>; perMachine: Map<string, Set<string>>; multi: boolean }>();
  const splits = (c: string): { prefix: string; sep: "-" | "--"; value: string }[] => {
    if (c.includes("__") || CLASS_SKIP.test(c) || ROOT_CLASS_SKIP.test(c) || ps.classFields.some((f) => f.re.test(c))) return [];
    const i = c.lastIndexOf("--");
    if (i > 0) return /^[a-z0-9][a-z0-9-]*$/.test(c.slice(i + 2)) ? [{ prefix: c.slice(0, i), sep: "--", value: c.slice(i + 2) }] : [];
    const out: { prefix: string; sep: "-"; value: string }[] = [];
    for (let j = c.indexOf("-"); j > 0; j = c.indexOf("-", j + 1)) out.push({ prefix: c.slice(0, j), sep: "-", value: c.slice(j + 1) });
    return out.filter((x) => x.value);
  };
  const states = new Map<string, { n: number; cls: Map<string, number> }>();
  for (const { el, machine } of roots) {
    const st = states.get(machine) ?? states.set(machine, { n: 0, cls: new Map() }).get(machine)!;
    st.n++;
    const onRoot = new Set<string>();
    for (const c of classes(el)) {
      if (/^is-[a-z0-9-]+$/.test(c)) st.cls.set(c, (st.cls.get(c) ?? 0) + 1);
      for (const sp of splits(c)) {
        const k = `${sp.prefix}${sp.sep}`;
        const x = stats.get(k) ?? stats.set(k, { prefix: sp.prefix, sep: sp.sep, values: new Map(), perMachine: new Map(), multi: false }).get(k)!;
        // several classes of one root share the prefix: a modifier set (`card-item--red card-item--plain`), not one value
        if (onRoot.has(k)) x.multi = true;
        onRoot.add(k);
        (x.values.get(sp.value) ?? x.values.set(sp.value, new Set()).get(sp.value)!).add(machine);
        (x.perMachine.get(machine) ?? x.perMachine.set(machine, new Set()).get(machine)!).add(sp.value);
      }
    }
  }
  const isVariant = (k: string) => {
    const x = stats.get(k);
    if (!x || x.multi) return false;
    if (x.sep === "--") return true;
    if ([...x.perMachine.values()].some((v) => v.size >= 2)) return true;
    return x.values.size >= 2 && [...x.values.values()].some((m) => m.size >= 2);
  };
  return {
    classFieldOf(c: string): Extract<VariantUnit, { kind: "classField" }> | undefined {
      const best = splits(c)
        .filter((sp) => isVariant(`${sp.prefix}${sp.sep}`))
        .sort((a, b) => b.prefix.length - a.prefix.length)[0];
      return best ? { kind: "classField", prefix: best.prefix, sep: best.sep, field: camel(best.prefix) } : undefined;
    },
    flagOf(machine: string, c: string): Extract<VariantUnit, { kind: "flag" }> | undefined {
      const st = states.get(machine);
      const n = st?.cls.get(c);
      return st && n && st.n >= 2 && n < st.n ? { kind: "flag", cls: c, field: camel(c.slice(3)) } : undefined;
    },
  };
}

/**
 * Per type: BEM elements (unique `.b__e` in each root) whose class list differs between instances (`__text bg-orange`
 * vs `__text bg-green`): their class list is a per-instance variant → `classes` slot. machine -> (selector -> field id)
 */
function varyingClassLists(roots: { el: Element; machine: string }[], ps: ProfileSet): Map<string, Map<string, string>> {
  const seen = new Map<string, Map<string, Set<string>>>();
  const count = new Map<string, Map<string, number>>();
  for (const { el: root, machine } of roots) {
    const own = ownSet(root, ps);
    const parents = parentsOf(root);
    const m = seen.get(machine) ?? seen.set(machine, new Map()).get(machine)!;
    const n = count.get(machine) ?? count.set(machine, new Map()).get(machine)!;
    walk(root, (el) => {
      if (el !== root && !own.has(el)) return false;
      if (["script", "style", "svg", "template", "noscript", "nav", "form"].includes(el.tagName) || inViewListing(el, root, parents)) return false;
      if (el === root || fieldInfo(el)) return true;
      const b = bemElementClass(el);
      if (!b || CLASS_SKIP.test(b) || classes(el).length < 2) return true;
      const sel = `.${cssEscape(b)}`;
      if (safeSelectAll(sel, root).filter((x) => own.has(x)).length !== 1) return true;
      (m.get(sel) ?? m.set(sel, new Set()).get(sel)!).add(classes(el).join(" "));
      n.set(sel, (n.get(sel) ?? 0) + 1);
      return true;
    });
  }
  const out = new Map<string, Map<string, string>>();
  for (const [machine, m] of seen)
    for (const [sel, lists] of m)
      if (lists.size >= 2 && (count.get(machine)!.get(sel) ?? 0) >= 2) (out.get(machine) ?? out.set(machine, new Map()).get(machine)!).set(sel, `${camel(sel.split("__")[1].split("-").pop()!)}Classes`);
  return out;
}

/** own descendants of an entity root whose classes hold a block `b` and its BEM modifier `b--m` (unique `.b` in the root) */
function modifierElements(root: Element, own: Set<Element>, parents: Map<Element, Element>): { el: Element; sel: string; field: string }[] {
  const out: { el: Element; sel: string; field: string }[] = [];
  walk(root, (el) => {
    if (el !== root && !own.has(el)) return false;
    if (["script", "style", "svg", "template", "noscript", "nav", "form"].includes(el.tagName) || inViewListing(el, root, parents)) return false;
    if (el === root || fieldInfo(el)) return true;
    const cls = classes(el);
    const b = cls.find((c) => /^[a-z][a-z0-9-]*$/.test(c) && !c.includes("--") && !CLASS_SKIP.test(c) && cls.some((m) => m.startsWith(`${c}--`) && m.length > c.length + 2));
    if (!b) return true;
    const sel = `.${cssEscape(b)}`;
    if (safeSelectAll(sel, root).filter((x) => own.has(x)).length !== 1) return true;
    out.push({ el, sel, field: `${camel(b.split("-").pop()!)}Classes` });
    return true;
  });
  return out;
}

/**
 * Label of a block link (an anchor wrapping several text elements: a card, a teaser): its last short BEM text element
 * ("Read more", "Download"), so the link label is not the whole card text. undefined for plain anchors.
 */
export function blockLinkLabel(anchor: Element): string | undefined {
  const texts: Element[] = [];
  walk(anchor, (el) => {
    if (el !== anchor && (isHidden(el) || ["script", "style", "svg"].includes(el.tagName))) return false;
    if (el !== anchor && directText(el)) texts.push(el);
    return true;
  });
  if (texts.length < 2) return undefined;
  const last = [...texts].reverse().find((t) => !/^h[1-6]$/.test(t.tagName) && bemElementClass(t) && text(t).replace(/\s+/g, " ").trim().length <= 60);
  if (!last || last !== texts[texts.length - 1]) return undefined;
  return `.${cssEscape(bemElementClass(last)!)}`;
}

/**
 * Repeated BEM block inside an entity root around `u`: an ancestor whose block class `b` (with `b__*` elements inside)
 * also sits on ≥ 2 sibling elements (download items, team members, steps). Such blocks become `item` entity roots.
 */
function repeatedBlockOf(u: Element, root: Element, parents: Map<Element, Element>): { sel: string; type: string } | undefined {
  let best: { sel: string; type: string } | undefined;
  for (let a: Element | undefined = u; a && a !== root; a = parents.get(a)) {
    const p = parents.get(a) ?? root; // parentsOf() has no entry for the root's own children
    for (const b of bemBlockClasses(a)) {
      if (CLASS_SKIP.test(b) || ROOT_CLASS_SKIP.test(b) || classes(root).includes(b)) continue;
      const sibs = childElements(p).filter((x) => classes(x).includes(b));
      if (sibs.length < 2) continue;
      if (!sibs.every((x) => selectAll(`[class*='${b}__']`, x).length > 0)) continue;
      best = { sel: `.${cssEscape(b)}`, type: b.replace(/[^a-z0-9]+/gi, "_").toLowerCase() };
      break;
    }
    if (best) break;
  }
  return best;
}

const plural = (id: string) => (/s$/.test(id) ? id : /[^aeiou]y$/.test(id) ? `${id.slice(0, -1)}ies` : `${id}s`);

/**
 * `list` item spec for repeated data items `all` (matched by `sel`): every data-* attribute (`@data-x`; `#@data-x` for
 * integer non-id values), the label (own text, else `@aria-label`), state classes that vary (`?is-x`), the first
 * image, BEM text children (`.block__el`), and nested data items as nested lists.
 */
function dataItemSpec(sel: string, all: Element[], items: Map<Element, { sel: string; idAttr: string }>, parents: Map<Element, Element>): ListItemSpec {
  const spec: ListItemSpec = {};
  const put = (key: string, v: ListItemSpec[string]) => {
    let k = key || "value";
    for (let n = 2; k in spec; n++) k = `${key}${n}`;
    spec[k] = v;
  };
  const elemOf = (e: Element) => bemElementClass(e)?.split("__")[1];
  const xElem = elemOf(all[0]);
  const local = (name: string) => camel(xElem && name.startsWith(`${xElem}-`) ? name.slice(xElem.length + 1) : name);
  const mine = new Set(all);
  // nested items: the nearest item ancestor is one of `all`
  const nested = new Map<string, Element[]>();
  const nestedEls = new Set<Element>();
  for (const [el, info] of items) {
    if (info.sel === sel) continue;
    let a = parents.get(el);
    while (a && !items.has(a)) a = parents.get(a);
    if (!a || !mine.has(a)) continue;
    (nested.get(info.sel) ?? nested.set(info.sel, []).get(info.sel)!).push(el);
  }
  for (const els of nested.values())
    for (const e of els)
      walk(e, (d) => {
        nestedEls.add(d);
        return true;
      });
  const names = [...new Set(all.flatMap((e) => dataAttrs(e).map(([n]) => n)))].sort();
  for (const n of names) {
    const vals = all.map((e) => dataAttrs(e).find(([k]) => k === n)?.[1]);
    put(camel(n.slice(5)), !DATA_ID.test(n) && vals.every((v) => v !== undefined && /^-?\d+$/.test(v)) ? `#@${n}` : `@${n}`);
  }
  if (all.some((e) => directText(e))) put("label", "text");
  else if (all.every((e) => attr(e, "ariaLabel"))) put("label", "@aria-label");
  const states = [...new Set(all.flatMap((e) => classes(e).filter((c) => /^is-[a-z0-9-]+$/.test(c))))].sort();
  for (const st of states) if (!all.every((e) => classes(e).includes(st))) put(camel(st.slice(3)), `?${st}`);
  const imgOf = (e: Element) => selectAll("img", e).find((i) => !nestedEls.has(i));
  const img = all.map(imgOf).find(Boolean);
  if (img) put(elemOf(img) ? local(elemOf(img)!) : "image", "img");
  const seen = new Set<string>();
  for (const e of all)
    walk(e, (d) => {
      if (nestedEls.has(d)) return false;
      const b = d !== e ? bemElementClass(d) : undefined;
      if (b && directText(d) && !seen.has(b) && seen.size < 8) {
        seen.add(b);
        put(local(b.split("__")[1]), `.${cssEscape(b)}`);
      }
      return true;
    });
  for (const [nsel, els] of [...nested].sort(([a], [b]) => a.localeCompare(b))) {
    const ne = elemOf(els[0]);
    put(plural(ne ? local(ne) : camel(els[0].tagName)), { sel: nsel, item: dataItemSpec(nsel, els, items, parents) });
  }
  return spec;
}


// ------------------------------------------------------------------ coverage

/**
 * Coverage of server HTML by the CCM entries. `pages` = the crawled HTML (raw server HTML preferred), `entries` = the CCM
 * the transform produced with profile set `ps` (which also decides what an entity root is).
 */
export function analyzeCoverage(pages: CoveragePage[], entries: Entry[], ps: ProfileSet, base = "", origin?: string): CoverageAnalysis {
  /** same-origin path of an URL; production-origin URLs (replay captures) count as same-origin */
  const pathFor = (u: string, b: string) => pathOf(u, b) ?? (origin ? pathOf(u, origin) : undefined) ?? u;
  const groups = new Map<string, CoverageGroup & { _unc: Map<string, UncoveredElement> }>();
  const instances = new Map<string, InstanceRef[]>();
  const findings = new Map<string, CoverageFinding>();
  const addFinding = (page: string, machine: string, entity: CoverageGroup["entity"], ccmType: string, sel: string, u: Omit<UncoveredElement, "instances" | "repeated">) => {
    const k = `${page}\u0000${machine}\u0000${sel}`;
    const f = findings.get(k);
    if (f) {
      f.count++;
      f.textLength = Math.max(f.textLength, u.textLength);
    } else {
      const fallback = entity !== "document" && (byPageType.get(`${strip(pages.find((p) => p.path === page)?.finalUrl ?? "")}|${ccmType}`) ?? []).some((e) => e.fields.html !== undefined);
      findings.set(k, { ...u, page, machine, entity, ccmType, count: 1, ...(fallback ? { fallback } : {}) });
    }
  };
  const blockRoots = new Map<string, { sel: string; machine: string; uncoveredChars: number; pages: Set<Element> }>();
  const strip = (u: string) => u.replace(/#.*$/, "");
  const byPageType = new Map<string, Entry[]>();
  const byType = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = `${strip(e.source?.url ?? "")}|${e.type}`;
    (byPageType.get(k) ?? byPageType.set(k, []).get(k)!).push(e);
    (byType.get(e.type) ?? byType.set(e.type, []).get(e.type)!).push(e);
  }
  const valuesCache = new Map<string, string>();
  const values = (key: string, list: Entry[]) => {
    let v = valuesCache.get(key);
    if (v === undefined) valuesCache.set(key, (v = typedValues(list)));
    return v;
  };
  const allValues = typedValues(entries);

  const parsed = pages.flatMap((pg) => {
    const info = parsePage(pg.html, pg.path, base || pg.finalUrl);
    const main = info.main ?? (info.tree.children.find((c) => c.type === "element") as Element | undefined);
    if (!main) return [];
    // entity roots in document order (nested ones too)
    const roots: { el: Element; r: { machine: string; entity: string } }[] = [];
    walk(main, (el) => {
      const r = entityRoot(el, ps);
      if (r) roots.push({ el, r });
      return true;
    });
    return [{ pg, main, roots }];
  });
  const allRoots = parsed.flatMap((p) => p.roots.map(({ el, r }) => ({ el, machine: r.machine })));
  const variants = variantClasses(allRoots, ps);
  const varying = varyingClassLists(allRoots, ps);
  for (const { pg, main, roots } of parsed) {
    const pageParents = parentsOf(main);
    const pageVals = typedValues(entries.filter((e) => strip(e.source?.url ?? "") === strip(pg.finalUrl) || e.path === pg.path));
    const consider = (machine: string, entity: CoverageGroup["entity"], ccmType: string, root: Element, vals: string, isDoc: boolean, list: Entry[]) => {
      const g =
        groups.get(machine) ??
        groups.set(machine, { machine, entity, ccmType, instances: 0, pages: [], totalChars: 0, coveredChars: 0, ratio: 1, uncovered: [], byPage: {}, _unc: new Map() }).get(machine)!;
      const bp = (g.byPage[pg.path] ??= { totalChars: 0, coveredChars: 0 });
      g.instances++;
      if (!g.pages.includes(pg.path)) g.pages.push(pg.path);
      const parents = parentsOf(root);
      const own = ownSet(root, ps);
      const { texts, images } = units(root, ps);
      const unc: Element[] = [];
      const seenSel = new Set<string>();
      const inField = (el: Element) => {
        for (let a = parents.get(el); a && a !== root; a = parents.get(a)) if (fieldInfo(a)) return true;
        return false;
      };
      const inView = (el: Element) => inViewListing(el, root, parents);
      const inLink = (el: Element) => {
        if (el.tagName === "a") return true;
        for (let a = parents.get(el); a; a = parents.get(a)) if (a.tagName === "a") return true;
        return false;
      };
      for (const t of texts) {
        const s = squash(text(t));
        if (!s) continue;
        g.totalChars += s.length;
        bp.totalChars += s.length;
        // <time datetime>: the CCM keeps the machine value (ISO date), the page prints a formatted one
        const dt = t.tagName === "time" ? attr(t, "dateTime") : undefined;
        const has = (x: string) => vals.includes(x) || ((isDoc || inView(t)) && allValues.includes(x));
        if (has(s) || (dt && has(squash(dt)))) {
          g.coveredChars += s.length;
          bp.coveredChars += s.length;
          continue;
        }
        unc.push(t);
        const sel = selectorFor(t, root, parents);
        const rep = safeSelectAll(sel, root).filter((x) => own.has(x)).length;
        const prev = g._unc.get(sel);
        const rec: UncoveredElement = {
          selector: sel,
          tag: t.tagName,
          textLength: Math.max(prev?.textLength ?? 0, text(t).replace(/\s+/g, " ").trim().length),
          hasInlineMarkup: (prev?.hasInlineMarkup ?? false) || t.children.some((c) => c.type === "element" && INLINE.has(c.tagName)) || childElements(t).some((c) => BLOCK_CHILD.has(c.tagName)),
          isImage: false,
          isLink: (prev?.isLink ?? false) || inLink(t),
          repeated: Math.max(prev?.repeated ?? 0, rep),
          instances: (prev?.instances ?? 0) + (seenSel.has(sel) ? 0 : 1),
          ...(inField(t) || prev?.inField ? { inField: true } : {}),
        };
        seenSel.add(sel);
        g._unc.set(sel, rec);
        addFinding(pg.path, machine, entity, ccmType, sel, { selector: sel, tag: t.tagName, textLength: text(t).replace(/\s+/g, " ").trim().length, hasInlineMarkup: rec.hasInlineMarkup, isImage: false, isLink: inLink(t), ...(inField(t) ? { inField: true } : {}) });
        if (isDoc) {
          const b = blockRootOf(t, root, parents, ps);
          if (b) {
            const x = blockRoots.get(b.sel) ?? blockRoots.set(b.sel, { ...b, uncoveredChars: 0, pages: new Set() }).get(b.sel)!;
            x.uncoveredChars += s.length;
            x.pages.add(b.el);
          }
        }
      }
      for (const img of images) {
        const p = pathFor(attr(img, "src") ?? attr(img, "dataSrc") ?? "", base || pg.finalUrl);
        if (!p || p.startsWith("data:")) continue;
        g.totalChars += IMAGE_WEIGHT;
        bp.totalChars += IMAGE_WEIGHT;
        if (vals.includes(squash(p)) || ((isDoc || inView(img)) && allValues.includes(squash(p)))) {
          g.coveredChars += IMAGE_WEIGHT;
          bp.coveredChars += IMAGE_WEIGHT;
          continue;
        }
        unc.push(img);
        const wrap = (() => {
          for (let a = parents.get(img); a && a !== root; a = parents.get(a)) {
            const c = bemElementClass(a);
            if (c) return c;
          }
          return undefined;
        })();
        const sel = bemElementClass(img) ? `img.${cssEscape(bemElementClass(img)!)}` : wrap ? `.${cssEscape(wrap)} img` : "img";
        const rep = safeSelectAll(sel, root).filter((x) => own.has(x)).length;
        const prev = g._unc.get(sel);
        g._unc.set(sel, {
          selector: sel,
          tag: "img",
          textLength: 0,
          hasInlineMarkup: false,
          isImage: true,
          isLink: (prev?.isLink ?? false) || inLink(img),
          repeated: Math.max(prev?.repeated ?? 0, rep),
          instances: (prev?.instances ?? 0) + (seenSel.has(sel) ? 0 : 1),
          ...(inField(img) || prev?.inField ? { inField: true } : {}),
        });
        seenSel.add(sel);
      }
      // non-text values: link targets, forms, inline background images (own elements only)
      const pageBase = base || pg.finalUrl;
      const extra = (el: Element, what: NonNullable<UncoveredElement["what"]>, weight: number, covered: boolean) => {
        g.totalChars += weight;
        bp.totalChars += weight;
        if (covered) {
          g.coveredChars += weight;
          bp.coveredChars += weight;
          return;
        }
        unc.push(el);
        const sel = what === "form" ? "form" : selectorFor(el, root, parents);
        const key = `${what}:${sel}`;
        const prev = g._unc.get(key);
        g._unc.set(key, {
          selector: sel,
          tag: el.tagName,
          textLength: 0,
          hasInlineMarkup: false,
          isImage: what === "bgImage",
          isLink: what === "href",
          repeated: Math.max(prev?.repeated ?? 0, safeSelectAll(sel, root).filter((x) => own.has(x)).length),
          instances: (prev?.instances ?? 0) + (seenSel.has(key) ? 0 : 1),
          what,
          ...(inField(el) || prev?.inField ? { inField: true } : {}),
        });
        seenSel.add(key);
        if (what === "json" || what === "data") addFinding(pg.path, machine, entity, ccmType, sel, { selector: sel, tag: el.tagName, textLength: 0, hasInlineMarkup: false, isImage: false, isLink: false, what });
      };
      let rawJson: string | undefined;
      const raw = () => (rawJson ??= JSON.stringify(list.map((e) => Object.fromEntries(Object.entries(e.fields).filter(([k]) => k !== "html")))));
      const dataItems = dataItemsOf(root, own, parents);
      walk(root, (el) => {
        if (el !== root && entityRoot(el, ps)) return false;
        if (isDataIsland(el)) {
          const probe = dataIslandProbe(el);
          if (probe) extra(el, "json", IMAGE_WEIGHT, raw().includes(JSON.stringify(probe)));
          return false;
        }
        if (["nav", "script", "style", "svg", "template", "noscript"].includes(el.tagName)) return false;
        const di = dataItems.get(el);
        if (di) {
          const v = dataAttrs(el).find(([n]) => n === di.idAttr)?.[1];
          if (v) extra(el, "data", LINK_WEIGHT, raw().includes(JSON.stringify(v)));
        }
        if (el.tagName === "form") {
          extra(el, "form", LINK_WEIGHT * 2, raw().includes("<form"));
          return false;
        }
        if (el.tagName === "a") {
          const href = attr(el, "href") ?? "";
          if (href && !/^(#|javascript:|mailto:|tel:)/i.test(href)) {
            const p = pathFor(href, pageBase);
            extra(el, "href", LINK_WEIGHT, vals.includes(squash(p)) || ((isDoc || inView(el)) && allValues.includes(squash(p))));
          }
        }
        const bg = /background-image:\s*url\(\s*['"]?([^'")]+)/i.exec(attr(el, "style") ?? "")?.[1];
        if (bg) {
          const p = pathFor(bg, pageBase);
          extra(el, "bgImage", IMAGE_WEIGHT, vals.includes(squash(p)));
        }
        return true;
      });
      // the anchor wrapping the whole root (linked cards): its target belongs to the entity
      const pa = isDoc ? undefined : pageParents.get(root);
      const paHref = pa && pa.tagName === "a" && childElements(pa).length === 1 ? attr(pa, "href") : undefined;
      if (pa && paHref && !/^(#|javascript:|mailto:|tel:)/i.test(paHref)) {
        const p = pathFor(paHref, pageBase);
        g.totalChars += LINK_WEIGHT;
        bp.totalChars += LINK_WEIGHT;
        if (vals.includes(squash(p))) {
          g.coveredChars += LINK_WEIGHT;
          bp.coveredChars += LINK_WEIGHT;
        } else {
          const labelSel = blockLinkLabel(pa);
          const rec: UncoveredElement = { selector: "a", tag: "a", textLength: 0, hasInlineMarkup: false, isImage: false, isLink: true, repeated: 1, instances: (g._unc.get("parentLink")?.instances ?? 0) + 1, what: "href", parentLink: labelSel ? { labelSel } : {} };
          g._unc.set("parentLink", rec);
          const { instances: _i, repeated: _r, ...f } = rec;
          addFinding(pg.path, machine, entity, ccmType, "parentLink", f);
        }
      }
      // class-derived values (entity roots only): variant classes, varying state classes, modifier class lists
      if (!isDoc) {
        const vunits: { el: Element; v: VariantUnit; covered: boolean; sel: string }[] = [];
        for (const c of classes(root)) {
          if (ps.classFields.some((f) => f.re.test(c))) continue; // mapped by the profile set (to-ccm always extracts it)
          const vc = variants.classFieldOf(c);
          if (vc) vunits.push({ el: root, v: vc, covered: raw().includes(JSON.stringify(c.slice(vc.prefix.length + vc.sep.length))), sel: c });
          const fl = variants.flagOf(machine, c);
          if (fl) vunits.push({ el: root, v: fl, covered: Object.keys(ps.profiles[machine]?.flags ?? {}).some((k) => ps.profiles[machine]!.flags![k] === c) || raw().includes(`"${fl.field}":true`), sel: c });
        }
        const mods = modifierElements(root, own, parents);
        for (const [sel, field] of varying.get(machine) ?? []) {
          const el = safeSelectAll(sel, root).find((x) => own.has(x));
          if (el && !mods.some((m) => m.sel === sel)) mods.push({ el, sel, field });
        }
        for (const m of mods) vunits.push({ el: m.el, v: { kind: "classes", sel: m.sel, field: m.field }, covered: raw().includes(JSON.stringify(classes(m.el).join(" "))), sel: m.sel });
        for (const u of vunits) {
          g.totalChars += VARIANT_WEIGHT;
          bp.totalChars += VARIANT_WEIGHT;
          if (u.covered) {
            g.coveredChars += VARIANT_WEIGHT;
            bp.coveredChars += VARIANT_WEIGHT;
            continue;
          }
          // not in `unc`: slot rules for elements would turn the root's class into a text slot; handled per record
          const key = `variant:${u.v.kind}:${u.v.kind === "classField" ? `${u.v.prefix}${u.v.sep}` : u.v.kind === "flag" ? u.v.cls : u.v.sel}`;
          const prev = g._unc.get(key);
          g._unc.set(key, { selector: u.v.kind === "classes" ? u.v.sel : `.${cssEscape(u.sel)}`, tag: u.el.tagName, textLength: 0, hasInlineMarkup: false, isImage: false, isLink: false, repeated: 1, instances: (prev?.instances ?? 0) + 1, what: "variant", variant: u.v });
          addFinding(pg.path, machine, entity, ccmType, key, { selector: u.v.kind === "classes" ? u.v.sel : `.${cssEscape(u.sel)}`, tag: u.el.tagName, textLength: 0, hasInlineMarkup: false, isImage: false, isLink: false, what: "variant", variant: u.v });
        }
      }
      (instances.get(machine) ?? instances.set(machine, []).get(machine)!).push({ root, page: pg.path, uncovered: unc });
    };
    for (const { el, r } of roots) {
      const t = typeOf(r);
      const list = byPageType.get(`${strip(pg.finalUrl)}|${t}`) ?? byType.get(t) ?? [];
      consider(r.machine, r.entity as CoverageGroup["entity"], t, el, values(`${strip(pg.finalUrl)}|${t}`, list), false, list);
    }
    // document level: main content outside every entity root (roots are skipped by units())
    const docType = entries.find((e) => e.path === pg.path)?.type ?? "page";
    consider(`document:${docType}`, "document", docType, main, pageVals, true, entries);
  }
  const out: CoverageGroup[] = [...groups.values()]
    .map(({ _unc, ...g }) => ({ ...g, ratio: g.totalChars ? round(g.coveredChars / g.totalChars) : 1, uncovered: [..._unc.values()] }))
    .sort((a, b) => a.machine.localeCompare(b.machine));
  const total = out.reduce((n, g) => n + g.totalChars, 0);
  const covered = out.reduce((n, g) => n + g.coveredChars, 0);
  return {
    coverage: { profileSet: ps.id, totalChars: total, coveredChars: covered, ratio: total ? round(covered / total) : 1, groups: out },
    instances,
    findings: [...findings.values()],
    blockRoots: [...blockRoots.values()].map((b) => ({ sel: b.sel, machine: b.machine, uncoveredChars: b.uncoveredChars, instances: b.pages.size })).sort((a, b) => b.uncoveredChars - a.uncoveredChars || a.sel.localeCompare(b.sel)),
    ps,
  };
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
/** an <img> counts like this many characters of text in the covered ratio */
export const IMAGE_WEIGHT = 20;
/** a link target counts like this many characters (a form twice that) */
export const LINK_WEIGHT = 10;

function safeSelectAll(sel: string, root: Element): Element[] {
  try {
    return selectAll(sel, root);
  } catch {
    return [];
  }
}

function ancestorsUpTo(root: Element, parents: Map<Element, Element>, from: Element): Element[] {
  const out: Element[] = [];
  for (let a = parents.get(from); a && a !== root; a = parents.get(a)) out.push(a);
  return out;
}

function inViewListing(el: Element, root: Element, parents: Map<Element, Element>): boolean {
  for (let a = parents.get(el); a && a !== root; a = parents.get(a)) if (classes(a).some((c) => c === "view" || c === "views-element-container" || c === "views-row")) return true;
  return false;
}

/** outermost BEM block ancestor (within the document root, not crossing entity roots) that owns `__element` children */
function blockRootOf(el: Element, root: Element, parents: Map<Element, Element>, ps: ProfileSet): { sel: string; machine: string; el: Element } | undefined {
  const chain: Element[] = [];
  for (let a: Element | undefined = el; a && a !== root; a = parents.get(a)) {
    if (a !== el && entityRoot(a, ps)) return undefined;
    chain.push(a);
  }
  // element classes along the chain -> their block names
  const blocks = new Set(chain.map((a) => bemElementClass(a)?.split("__")[0]).filter((x): x is string => !!x));
  let best: { sel: string; machine: string; el: Element } | undefined;
  // views listings and teaser nodes are collections, not paragraphs
  if (chain.some((a) => classes(a).includes("view") || classes(a).includes("views-element-container"))) return undefined;
  for (const [i, a] of chain.entries()) {
    const b = bemBlockClasses(a).find((c) => blocks.has(c));
    if (!b || /^(region|main|container|layout|page|field|block|views?|node)(-|$)/.test(b)) continue;
    if (fieldInfo(a) || classes(a).includes("node")) continue; // a field wrapper / node is not a paragraph root
    // only roots inside an entity-reference(-revisions) field become sections of the document
    const above = [...chain.slice(i + 1), ...ancestorsUpTo(root, parents, chain[chain.length - 1])];
    if (!above.some((w) => fieldInfo(w) && classifyField(w, fieldInfo(w)!.type, ps) === "componentList")) continue;
    best = { sel: `${a.tagName}.${cssEscape(b)}`, machine: b.replace(/-/g, "_"), el: a };
  }
  return best;
}

// ------------------------------------------------------------------ transform issues

export const DOCUMENT_TEXT_UNMAPPED = "DOCUMENT_TEXT_UNMAPPED";

/**
 * Issues for text the transform keeps nowhere in a typed field and that SECTION_TEXT_UNMAPPED does not report:
 * page-level text outside every paragraph root, text inside a Drupal field wrapper that the field value lacks, and
 * paragraph text the section kept no `html` fallback for (to-ccm saw an equal text elsewhere).
 * One issue per (page, entity group / document, selector); structure only (selector, tag, length), never the text.
 * ref = `<path>#<group>/<selector>`; message prefix `<ccmType> on <path>:` or `document:<ccmType> on <path>:`.
 */
export function unmappedTextIssues(a: CoverageAnalysis): Issue[] {
  const out: Issue[] = [];
  const fs = a.findings
    .filter((f) => (!f.what && !f.isImage && f.textLength > 0 && (f.entity === "document" || f.inField || !f.fallback)) || f.what === "json" || f.what === "data" || f.what === "variant" || !!f.parentLink)
    .sort((x, y) => x.page.localeCompare(y.page) || x.machine.localeCompare(y.machine) || x.selector.localeCompare(y.selector));
  for (const f of fs) {
    const doc = f.entity === "document";
    if (f.parentLink) {
      out.push({
        severity: "warning",
        code: DOCUMENT_TEXT_UNMAPPED,
        message: `${f.ccmType} on ${f.page}: ${f.count} link target(s) of the anchor wrapping ${f.machine} not in any typed field (parent <a>)`,
        ref: `${f.page}#${f.machine}/parentLink`,
        actionable: true,
      });
      continue;
    }
    if (f.what === "variant" && f.variant) {
      const v = f.variant;
      const what = v.kind === "classField" ? `variant class ${v.prefix}${v.sep}* on the root` : v.kind === "flag" ? `state class ${v.cls} on some roots` : `modifier classes of ${v.sel}`;
      out.push({
        severity: "warning",
        code: DOCUMENT_TEXT_UNMAPPED,
        message: `${f.ccmType} on ${f.page}: ${f.count} class-derived value(s) of ${f.machine} not in any typed field: ${what} (proposed field ${v.field})`,
        ref: `${f.page}#${f.machine}/variant:${v.kind === "classField" ? `${v.prefix}${v.sep}` : v.kind === "flag" ? v.cls : v.sel}`,
        actionable: true,
      });
      continue;
    }
    if (f.what === "json" || f.what === "data") {
      // structured content to-ccm's leftover check cannot see (script JSON, data-* ids on buttons): no text in the message
      out.push({
        severity: "warning",
        code: DOCUMENT_TEXT_UNMAPPED,
        message: `${f.ccmType} on ${f.page}: ${f.count} ${f.what === "json" ? "JSON data island(s)" : "data item(s) keyed by data-* ids"} of ${f.machine} not in any typed field: ${f.selector} (<${f.tag}>)`,
        ref: `${f.page}#${f.machine}/${f.what}:${f.selector}`,
        actionable: true,
      });
      continue;
    }
    out.push({
      severity: "warning",
      code: DOCUMENT_TEXT_UNMAPPED,
      message: `${doc ? `document:${f.ccmType}` : f.ccmType} on ${f.page}: ${f.count} text element(s) ${doc ? "outside every paragraph" : f.inField ? `inside a Drupal field wrapper of ${f.machine}` : `of ${f.machine} without html fallback`} not in any typed field: ${f.selector} (<${f.tag}>, ${f.textLength} chars)`,
      ref: `${f.page}#${doc ? `document:${f.ccmType}` : f.machine}/${f.selector}`,
      actionable: true,
    });
  }
  return out;
}

// ------------------------------------------------------------------ rule pre-pass

const camel = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    .replace(/^[^a-z]+/, "") || "value";
const RESERVED = new Set(["html", "classes", "items"]);

export interface InferredSlot {
  machine: string;
  id: string;
  def: SlotDef;
  /** instances in which the selector matched an uncovered unit */
  support: number;
  reason: string;
}

export interface InferResult {
  pack: ProfilePack;
  slots: InferredSlot[];
  entityRoots: NonNullable<ProfilePack["entityRoots"]>;
  /** pack-level class fields (variant classes on roots) and per-type flags (state classes) */
  classFields: NonNullable<ProfilePack["classFields"]>;
  flags: { machine: string; field: string; cls: string }[];
}

/**
 * Rule pre-pass over a coverage analysis: slots for uncovered units of each entity group (restricted to `machines` when
 * given) + entity roots for BEM blocks with uncovered document text. Existing slots of the current set are kept (the
 * output only adds). Deterministic.
 */
export function inferProfiles(a: CoverageAnalysis, opts: { machines?: string[]; existingFields?: Record<string, string[]>; minEntityRootChars?: number } = {}): InferResult {
  const profiles: Record<string, ParagraphProfile> = {};
  const slots: InferredSlot[] = [];
  const genericRoots: NonNullable<ProfilePack["entityRoots"]> = [];
  const documents: Record<string, ParagraphProfile> = {};
  const classFields: NonNullable<ProfilePack["classFields"]> = [];
  const flags: InferResult["flags"] = [];
  const itemRoots: NonNullable<ProfilePack["entityRoots"]> = [];
  const minChars = opts.minEntityRootChars ?? 20;
  const known = new Set(a.ps.entityRoots.map((r) => r.sel));
  const blockRootsProposed = a.blockRoots.filter((b) => b.uncoveredChars >= minChars && !known.has(b.sel));
  const proposedSel = new Set(blockRootsProposed.map((b) => b.sel));
  for (const g of a.coverage.groups) {
    const isDoc = g.entity === "document";
    if (g.machine === "generic") {
      // roots recognised only by id="section-<pid>" share the machine "generic": name them by their own class instead
      for (const ins of a.instances.get("generic") ?? []) {
        if (!ins.uncovered.length) continue;
        const cls = bemElementClass(ins.root) ?? bemBlockClasses(ins.root)[0];
        if (!cls) continue;
        const sel = `${ins.root.tagName}.${cssEscape(cls)}${/^section-\d+$/.test(attr(ins.root, "id") ?? "") ? "[id^='section-']" : ""}`;
        if (!genericRoots.some((r) => r.sel === sel)) genericRoots.push({ sel, type: cls.replace(/[^a-z0-9]+/gi, "_").toLowerCase(), entity: "paragraph" });
      }
      continue;
    }
    if (opts.machines && !opts.machines.includes(g.machine)) continue;
    const inst = a.instances.get(g.machine) ?? [];
    const current = (isDoc ? a.ps.documents[g.ccmType] : a.ps.profiles[g.machine])?.slots ?? {};
    const usedSel = new Set(Object.values(current).map((s) => (typeof s === "string" ? s : s.sel)));
    const usedIds = new Set([...Object.keys(current), ...(opts.existingFields?.[g.ccmType] ?? []), ...RESERVED]);
    const found = new Map<string, InferredSlot & { lastInstance?: InstanceRef }>(); // by selector
    const claimed = new Set<Element>();
    for (const ins of inst) {
      const parents = parentsOf(ins.root);
      const own = ownSet(ins.root, a.ps);
      for (const u of ins.uncovered) {
        if (claimed.has(u)) continue;
        // document text inside a BEM block that becomes an entity root is handled by that root, not a document slot;
        // text of views listings (teaser cards, related content) needs a collection, not a profile slot
        if (isDoc && proposedSel.has(blockRootOf(u, ins.root, parents, a.ps)?.sel ?? "")) continue;
        if (isDoc && inViewListing(u, ins.root, parents)) continue;
        // repeated BEM blocks inside a paragraph are child items (their own entries), not lists of the paragraph
        const rb = !isDoc ? repeatedBlockOf(u, ins.root, parents) : undefined;
        if (rb) {
          if (!known.has(rb.sel) && !itemRoots.some((r) => r.sel === rb.sel)) itemRoots.push({ sel: rb.sel, type: rb.type, entity: "item" });
          continue;
        }
        // document level: text inside a Drupal field wrapper printed outside the node root (Layout Builder field blocks)
        const cands = (isDoc ? fieldWrapperSlot(u, ins.root, parents, own, a.ps) : undefined) ?? slotCandidates(u, ins.root, parents, own);
        for (const c of cands) {
          if (usedSel.has(c.def.sel)) continue;
          const prev = found.get(c.def.sel);
          if (prev) {
            if (prev.lastInstance !== ins) {
              prev.support++;
              prev.lastInstance = ins;
            }
            continue;
          }
          let id = c.id;
          for (let n = 2; usedIds.has(id); n++) id = `${c.id}${n}`;
          usedIds.add(id);
          found.set(c.def.sel, { machine: g.machine, id, def: c.def, support: 1, reason: c.reason, lastInstance: ins });
        }
        // a richText slot on a wrapper claims every unit inside it
        for (const c of cands) if (c.claims) for (const x of c.claims) claimed.add(x);
      }
    }
    // class-derived values: variant classes (pack-level class fields), state flags, modifier class lists (slots)
    const flagMap: Record<string, string> = {};
    if (!isDoc)
      for (const u of g.uncovered) {
        const v = u.variant;
        if (u.parentLink) {
          if (Object.values(current).some((x) => typeof x !== "string" && x?.parentLink) || [...found.values()].some((x) => x.def.parentLink)) continue;
          let id = "link";
          for (let n = 2; usedIds.has(id); n++) id = `link${n}`;
          usedIds.add(id);
          found.set("(parent a)", { machine: g.machine, id, def: { sel: "a", kind: "link", parentLink: true, ...(u.parentLink.labelSel ? { labelSel: u.parentLink.labelSel } : {}) }, support: u.instances, reason: "anchor wrapping the whole root" });
          continue;
        }
        if (u.what !== "variant" || !v) continue;
        if (v.kind === "classField") {
          const re = `^${(v.prefix + v.sep).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(.+)$`;
          if (classFields.some((c) => c.re === re) || a.ps.classFields.some((c) => c.re.source === re) || RESERVED.has(v.field)) continue;
          classFields.push({ re, field: v.field });
        } else if (v.kind === "flag") {
          if (usedIds.has(v.field) || Object.values(a.ps.profiles[g.machine]?.flags ?? {}).includes(v.cls)) continue;
          usedIds.add(v.field);
          flagMap[v.field] = v.cls;
          flags.push({ machine: g.machine, field: v.field, cls: v.cls });
        } else if (!usedSel.has(v.sel) && !found.has(v.sel)) {
          let id = v.field;
          for (let n = 2; usedIds.has(id); n++) id = `${v.field}${n}`;
          usedIds.add(id);
          found.set(v.sel, { machine: g.machine, id, def: { sel: v.sel, kind: "classes" }, support: u.instances, reason: "class list with a BEM modifier" });
        }
      }
    if (!found.size && !Object.keys(flagMap).length) continue;
    const list = [...found.values()];
    for (const s of list) delete s.lastInstance;
    slots.push(...list);
    const prof: ParagraphProfile = {
      ...(list.length ? { slots: Object.fromEntries(list.map((s) => [s.id, s.def.kind === "text" && Object.keys(s.def).length === 2 ? s.def.sel : s.def])) } : {}),
      ...(Object.keys(flagMap).length ? { flags: flagMap } : {}),
    };
    if (isDoc) documents[g.ccmType] = prof;
    else profiles[g.machine] = prof;
  }
  const entityRoots = [...genericRoots.filter((r) => !known.has(r.sel)), ...blockRootsProposed.map((b) => ({ sel: b.sel, type: b.machine, entity: "paragraph" as const })), ...itemRoots];
  const pack: ProfilePack = {
    ...(entityRoots.length ? { entityRoots } : {}),
    ...(classFields.length ? { classFields } : {}),
    ...(Object.keys(profiles).length ? { profiles } : {}),
    ...(Object.keys(documents).length ? { documents } : {}),
  };
  return { pack, slots, entityRoots, classFields, flags };
}

/**
 * Slot for a unit inside a Drupal field wrapper (`field--name-<name>`): selector on the wrapper class, kind from the
 * generic field classification, id from the field name (field_recipe_instruction -> recipeInstruction). Claims the
 * whole wrapper. undefined when the unit is not inside a mappable field wrapper.
 */
function fieldWrapperSlot(u: Element, root: Element, parents: Map<Element, Element>, own: Set<Element>, ps: ProfileSet): { id: string; def: SlotDef; reason: string; claims?: Element[] }[] | undefined {
  let w: Element | undefined;
  for (let a: Element | undefined = u; a && a !== root; a = parents.get(a)) if (fieldInfo(a)) w = a; // outermost wrapper
  if (!w) return undefined;
  const fi = fieldInfo(w)!;
  const base = `.field--name-${cssEscape(fi.name)}`;
  if (safeSelectAll(base, root).filter((x) => own.has(x)).length !== 1) return undefined; // ambiguous on this page
  const kind = classifyField(w, fi.type, ps);
  const items = safeSelectAll(".field__item", w).filter((x) => x !== w); // single-value wrappers carry field__item themselves
  const n = (sel: string) => safeSelectAll(sel, w!).length;
  const one = (k: SlotKind, many: SlotKind, sel: string, cnt: number): SlotDef => ({ sel, kind: cnt > 1 ? many : k });
  let def: SlotDef | undefined;
  switch (kind) {
    case "componentList":
    case "collection":
      return undefined; // child entities / views are not slots
    case "asset":
      def = one("asset", "assets", `${base} img`, n("img"));
      break;
    case "link":
    case "termRefs":
    case "entryRefs":
      def = n("a") ? one("link", "links", `${base} a`, n("a")) : one("text", "textList", items.length ? `${base} .field__item` : base, items.length);
      break;
    case "date":
      def = { sel: n("time") ? `${base} time` : base, kind: "text" };
      break;
    case "richText":
      def = items.length > 1 ? { sel: base, kind: "richText" } : { sel: items.length ? `${base} .field__item` : base, kind: "richText" };
      break;
    default:
      def = items.length > 1 ? { sel: `${base} .field__item`, kind: "textList" } : { sel: items.length ? `${base} .field__item` : base, kind: "text" };
  }
  const claims: Element[] = [];
  walk(w, (x) => {
    claims.push(x);
    return true;
  });
  return [{ id: fieldNameToId(fi.name), def, reason: `Drupal field wrapper ${fi.name} (${fi.type ?? "?"}) outside the node root`, claims }];
}

function slotCandidates(u: Element, root: Element, parents: Map<Element, Element>, own: Set<Element>): { id: string; def: SlotDef; reason: string; claims?: Element[] }[] {
  const out: { id: string; def: SlotDef; reason: string; claims?: Element[] }[] = [];
  const count = (sel: string) => safeSelectAll(sel, root).filter((x) => own.has(x)).length;
  const elemName = (cls: string) => cls.split("__")[1] ?? cls;
  if (u.tagName === "form") return [{ id: "formHtml", def: { sel: "form", kind: "html" }, reason: "form (kept verbatim)" }];
  if (isDataIsland(u)) {
    const cls = classes(u).find((c) => /^[a-z][a-z0-9_-]*$/i.test(c));
    for (const sel of [cls ? `script.${cssEscape(cls)}` : "", "script[type='application/json']"])
      if (sel && count(sel) === 1) return [{ id: cls ? camel(cls) : "data", def: { sel, kind: "json" }, reason: "JSON data island" }];
    return [];
  }
  const items = dataItemsOf(root, own, parents);
  if (items.has(u)) {
    // the outermost data item around the unit owns the list (nested items become nested lists)
    let x = u;
    for (let a = parents.get(u); a && a !== root; a = parents.get(a)) if (items.has(a)) x = a;
    const { sel } = items.get(x)!;
    const all = safeSelectAll(sel, root).filter((e) => own.has(e));
    const claims: Element[] = [];
    for (const e of all)
      walk(e, (d) => {
        claims.push(d);
        return true;
      });
    const bem = bemElementClass(x);
    const base = bem ? elemName(bem) : (classes(x).find((c) => /^[a-z][a-z0-9_-]*$/i.test(c) && !/^(is-|has-|js-)/.test(c)) ?? x.tagName);
    return [{ id: plural(camel(base)), def: { sel, kind: "list", item: dataItemSpec(sel, all, items, parents) }, reason: "repeated data items keyed by data-* ids", claims }];
  }
  if (/background-image:\s*url\(/i.test(attr(u, "style") ?? "")) {
    const bem = bemElementClass(u);
    const plain = classes(u).find((c) => /^[a-z][a-z0-9_-]*$/i.test(c));
    if (bem || plain) out.push({ id: bem ? camel(`${elemName(bem)} image`).replace(/ImageImage$/, "Image") : "backgroundImage", def: { sel: bem ? `.${cssEscape(bem)}` : `${u.tagName}.${cssEscape(plain!)}`, kind: "bgImage" }, reason: "inline background-image" });
    if (!directText(u)) return out;
  }
  if (u.tagName === "img") {
    let wrap: string | undefined;
    for (let a = parents.get(u); a && a !== root && !wrap; a = parents.get(a)) wrap = bemElementClass(a);
    const own = bemElementClass(u);
    const sel = own ? `img.${cssEscape(own)}` : wrap ? `.${cssEscape(wrap)} img` : "img";
    const n = count(sel);
    const id = camel(own ? elemName(own) : wrap ? elemName(wrap) : "image");
    out.push({ id: n > 1 ? `${id}s`.replace(/ss$/, "s") : /image|img|picture|logo|icon|photo/i.test(id) ? id : `${id}Image`, def: { sel, kind: n > 1 ? "assets" : "asset" }, reason: n > 1 ? "repeated <img>" : "<img>" });
    return out;
  }
  // anchor around the unit (or the unit itself)
  let anchor: Element | undefined = u.tagName === "a" ? u : undefined;
  for (let a = parents.get(u); a && !anchor; a = parents.get(a)) {
    if (a.tagName === "a") anchor = a;
    if (a === root) break;
  }
  const blockKids = childElements(u).some((c) => BLOCK_CHILD.has(c.tagName));
  const inline = u.children.some((c) => c.type === "element" && INLINE.has(c.tagName));
  const bem = bemElementClass(u);
  if (anchor && anchor !== u) {
    const acls = bemElementClass(anchor) ?? classes(anchor).find((c) => /^[a-z][a-z0-9_-]*$/i.test(c));
    const asel = acls ? `a.${cssEscape(acls)}` : count("a") === 1 ? "a" : undefined;
    const label = blockLinkLabel(anchor) ?? (bem ? `.${cssEscape(bem)}` : undefined);
    if (asel) {
      const n = count(asel);
      out.push({ id: n > 1 ? "links" : camel(acls ? elemName(acls) : "link").replace(/^(.*)$/, (m) => (/link/i.test(m) ? m : `${m}Link`)), def: { sel: asel, kind: n > 1 ? "links" : "link", ...(label && n === 1 ? { labelSel: label } : {}) }, reason: "classed anchor" });
    }
  }
  if (u.tagName === "a") {
    const acls = bem ?? classes(u).find((c) => /^[a-z][a-z0-9_-]*$/i.test(c));
    if (!acls) {
      // unclassed anchor inside a BEM element: `.block__el a`
      for (let a = parents.get(u); a && a !== root; a = parents.get(a)) {
        const c = bemElementClass(a);
        if (!c) continue;
        const sel = `.${cssEscape(c)} a`;
        const n = count(sel);
        out.push({ id: n > 1 ? "links" : camel(elemName(c)).replace(/^(.*)$/, (m) => (/link/i.test(m) ? m : `${m}Link`)), def: { sel, kind: n > 1 ? "links" : "link" }, reason: "anchor inside a BEM element" });
        break;
      }
    }
    if (acls) {
      const sel = `a.${cssEscape(acls)}`;
      const n = count(sel);
      out.push({ id: n > 1 ? "links" : camel(elemName(acls)).replace(/^(.*)$/, (m) => (/link/i.test(m) ? m : `${m}Link`)), def: { sel, kind: n > 1 ? "links" : "link" }, reason: "classed anchor with text" });
    }
    return out;
  }
  if (bem) {
    const sel = `.${cssEscape(bem)}`;
    const n = count(sel);
    const withText = safeSelectAll(sel, root).filter((x) => own.has(x) && text(x).trim()).length;
    // line breaks (`<br>`) are paragraph structure: rich text keeps them, a text slot would flatten them
    const breaks = withText === 1 && u.children.some((c) => c.type === "element" && c.tagName === "br");
    const kind: SlotKind = blockKids || breaks ? "richText" : withText > 1 ? "textList" : "text";
    // the label element of the surrounding block link ("Read more" inside a linked card) is a label, not a link
    const isLabel = !!anchor && anchor !== u && n === 1 && blockLinkLabel(anchor) === sel;
    const base = camel(elemName(bem));
    out.push({ id: isLabel && !/label$/i.test(base) ? `${base}Label` : base, def: { sel, kind, ...(n > 1 && withText === 1 ? { nonEmpty: true } : {}) }, reason: `BEM element with text${blockKids ? " (block children)" : breaks ? " (line breaks)" : inline ? " (inline markup)" : ""}${isLabel ? ", label of the block link" : ""}` });
    return out;
  }
  // no own BEM class: a BEM wrapper holding block content -> richText on the wrapper; else tag inside the wrapper
  for (let a = parents.get(u); a && a !== root; a = parents.get(a)) {
    const c = bemElementClass(a);
    if (!c) continue;
    const hasBlocks = childElements(a).some((x) => BLOCK_CHILD.has(x.tagName));
    if (hasBlocks && ["p", "ul", "ol", "li", "blockquote"].includes(u.tagName)) {
      const sel = `.${cssEscape(c)}`;
      const claims: Element[] = [];
      walk(a, (x) => {
        claims.push(x);
        return true;
      });
      out.push({ id: camel(elemName(c)), def: { sel, kind: "richText" }, reason: "BEM wrapper with block content", claims });
      return out;
    }
    const sel = `.${cssEscape(c)} ${u.tagName}`;
    const n = count(sel);
    const withText = safeSelectAll(sel, root).filter((x) => own.has(x) && text(x).trim()).length;
    out.push({ id: /^h[1-6]$/.test(u.tagName) ? camel(`${elemName(c)} heading`) : camel(elemName(c)), def: { sel, kind: withText > 1 ? "textList" : "text", ...(n > 1 && withText === 1 ? { nonEmpty: true } : {}) }, reason: "text inside a BEM element" });
    return out;
  }
  const plain = classes(u).find((c) => /^[a-z][a-z0-9_-]*$/i.test(c) && !/^(is-|has-|js-)/.test(c));
  const sel = plain ? `${u.tagName}.${cssEscape(plain)}` : u.tagName;
  const n = count(sel);
  if (!plain && n > 1) return out; // bare repeated tags are too ambiguous for a rule
  out.push({ id: plain ? camel(plain) : /^h[1-6]$/.test(u.tagName) ? "heading" : u.tagName === "p" ? "text" : camel(u.tagName), def: { sel, kind: blockKids ? "richText" : n > 1 ? "textList" : "text" }, reason: plain ? "classed text element" : "only element of its tag" });
  return out;
}

/** Merge an inferred pack over an existing site pack (existing entries win; new slots/roots appended). */
export function mergeIntoSitePack(site: ProfilePack | undefined, add: ProfilePack): ProfilePack {
  const out: ProfilePack = JSON.parse(JSON.stringify(site ?? {}));
  if (add.entityRoots?.length) {
    out.entityRoots = [...(out.entityRoots ?? [])];
    for (const r of add.entityRoots) if (!out.entityRoots.some((x) => x.sel === r.sel)) out.entityRoots.push(r);
  }
  if (add.classFields?.length) {
    out.classFields = [...(out.classFields ?? [])];
    for (const c of add.classFields) if (!out.classFields.some((x) => x.re === c.re)) out.classFields.push(c);
  }
  for (const key of ["profiles", "documents"] as const) {
    for (const [m, p] of Object.entries(add[key] ?? {})) {
      if (!p) continue;
      const map = (out[key] ??= {});
      const cur = map[m] ?? {};
      const slots = { ...(cur?.slots ?? {}) };
      for (const [id, s] of Object.entries(p.slots ?? {})) if (!(id in slots)) slots[id] = s;
      const flags = { ...(cur?.flags ?? {}) };
      for (const [id, c] of Object.entries(p.flags ?? {})) if (!(id in flags)) flags[id] = c;
      map[m] = {
        ...(cur ?? {}),
        ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== "slots" && k !== "flags" && !(cur && k in cur))),
        ...(Object.keys(slots).length ? { slots } : {}),
        ...(Object.keys(flags).length ? { flags } : {}),
      };
    }
  }
  return out;
}

// ------------------------------------------------------------------ skeletons (dossiers; never text)

const KEEP_ATTR = new Set(["className"]);
/** Skeleton of an element: tags + classes; text -> "…", other attribute values -> "…"; script/style/svg bodies dropped. */
export function skeletonOf(el: Element, maxChars = 6000): string {
  const clone = (n: ElementContent): ElementContent | undefined => {
    if (n.type === "text") return n.value.trim() ? { type: "text", value: "…" } : undefined;
    if (n.type !== "element") return undefined;
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.properties ?? {})) props[k] = KEEP_ATTR.has(k) ? v : "…";
    const drop = ["script", "style", "svg", "noscript", "template"].includes(n.tagName);
    return { type: "element", tagName: n.tagName, properties: props as Element["properties"], children: drop ? [] : (n.children.map(clone).filter(Boolean) as ElementContent[]) };
  };
  const html = toHtml(clone(el) as Element).replace(/(…)+/g, "…");
  return html.length > maxChars ? html.slice(0, maxChars) + "<!-- … truncated -->" : html;
}

/**
 * Pruned skeleton for document groups (a whole page is too big): only the uncovered elements' parent subtrees and their
 * ancestor chain up to the main content root; every dropped sibling run becomes `<!-- … -->`. Text/attributes as skeletonOf.
 */
export function prunedSkeletonOf(root: Element, targets: Element[], maxChars = 6000): string {
  const parents = parentsOf(root);
  const keepSubtree = new Set<Element>();
  const keepPath = new Set<Element>([root]);
  for (const t of targets) {
    const ctx = parents.get(t) && parents.get(t) !== root ? parents.get(t)! : t;
    keepSubtree.add(ctx);
    for (let a = parents.get(ctx); a; a = parents.get(a)) keepPath.add(a);
  }
  const prune = (el: Element): Element => {
    if (keepSubtree.has(el)) return el;
    const kids: ElementContent[] = [];
    let dropped = false;
    for (const c of el.children) {
      if (c.type === "element" && (keepPath.has(c) || keepSubtree.has(c))) {
        if (dropped) kids.push({ type: "comment", value: " … " });
        dropped = false;
        kids.push(prune(c));
      } else if (c.type === "element" || (c.type === "text" && c.value.trim())) dropped = true;
    }
    if (dropped) kids.push({ type: "comment", value: " … " });
    return { ...el, children: kids };
  };
  return skeletonOf(prune(root), maxChars);
}

/**
 * Dossier parts of a document group: pruned skeletons (≤ maxInstances pages) around the uncovered elements outside views
 * listings, and those elements' structure records. Never text.
 */
export function documentDossierParts(a: CoverageAnalysis, machine: string, maxInstances = 3): { skeletons: string[]; uncovered: UncoveredElement[] } {
  const g = a.coverage.groups.find((x) => x.machine === machine);
  if (!g) return { skeletons: [], uncovered: [] };
  const skeletons: string[] = [];
  const sels = new Set<string>();
  for (const ins of a.instances.get(machine) ?? []) {
    const parents = parentsOf(ins.root);
    const targets = ins.uncovered.filter((u) => !inViewListing(u, ins.root, parents));
    if (!targets.length) continue;
    for (const t of targets) sels.add(selectorFor(t, ins.root, parents));
    if (skeletons.length < maxInstances) {
      const sk = prunedSkeletonOf(ins.root, targets);
      if (!skeletons.includes(sk)) skeletons.push(sk);
    }
  }
  return { skeletons, uncovered: g.uncovered.filter((u) => sels.has(u.selector)) };
}

// ------------------------------------------------------------------ workspace helpers

export interface CoverageInput {
  pages: CoveragePage[];
  crawl: { index: CrawlIndex; pages: PageManifest[]; assets: AssetRecord[]; links: Record<string, LinkProbe> };
  base: string;
}

/**
 * Content HTML of every crawled page with status 200: the server HTML, or the rendered DOM where the CCM build takes
 * its content from it too (content-source.ts) — coverage is measured against the HTML the content came from, so the
 * skeleton placeholders of client-rendered widgets are not reported as unmapped text.
 */
export async function loadCoverageInput(ws: Workspace): Promise<CoverageInput> {
  const crawl = await readCrawl(ws);
  if (!crawl) throw new Error("raw/html/crawl.json not found — run extract (html adapter) first");
  const pages: CoveragePage[] = [];
  for (const m of crawl.pages) {
    if (m.status !== 200) continue;
    const html = await pageContentHtml(m.files, (rel) => ws.readText(rel)).then((r) => r.html).catch(() => "");
    if (html) pages.push({ path: m.path, finalUrl: m.finalUrl, html });
  }
  return { pages, crawl, base: crawl.index.baseUrl.replace(/\/+$/, "") };
}

export async function readCcmEntries(ws: Workspace): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const f of await ws.list("ccm/entries", ".json")) out.push(await ws.readJson<Entry>(f));
  return out;
}

/** Covered-text ratio of the workspace's current ccm/ (after transform), with the site's resolved profile set. */
export async function measureTextCoverage(ws: Workspace, site: Pick<SiteConfig, "source">, opts: { themePack?: string; input?: CoverageInput } = {}): Promise<CoverageAnalysis> {
  const input = opts.input ?? (await loadCoverageInput(ws));
  const { set } = await resolveProfileSet(ws, site, input.crawl, { themePack: opts.themePack });
  return analyzeCoverage(input.pages, await readCcmEntries(ws), set, input.base, input.crawl.index.origin);
}

/**
 * In-memory transform with `sitePack` as mapping/profiles.yaml (null = none) over theme pack `themePackId`, then coverage.
 * Nothing is written. Returns the CCM too (for schema/field lookups).
 */
export async function simulateCoverage(input: CoverageInput, themePackId: string, sitePack: ProfilePack | undefined, siteLocales?: SiteConfig["locales"]): Promise<{ analysis: CoverageAnalysis; ccm: ToCcmResult }> {
  const ps = profileSetFor(themePackId, sitePack);
  const byFile = new Map<string, string>();
  for (const pg of input.pages) byFile.set(pg.path, pg.html);
  const pages = input.crawl.pages.filter((m) => m.status === 200 && byFile.has(m.path)).map((m) => ({ ...m, files: { ...m.files, raw: `@${m.path}`, rendered: `@${m.path}` } }));
  const ccm = await buildCcm({
    profiles: ps,
    baseUrl: input.crawl.index.baseUrl,
    pages,
    assets: input.crawl.assets,
    links: input.crawl.links,
    redirects: input.crawl.index.redirects,
    readText: async (rel) => byFile.get(rel.slice(1)) ?? "",
    siteLocales,
    origin: input.crawl.index.origin,
  });
  return { analysis: analyzeCoverage(input.pages, ccm.entries, ps, input.base, input.crawl.index.origin), ccm };
}

export interface InferRound {
  round: number;
  ratioBefore: number;
  ratioAfter: number;
  slots: number;
  entityRoots: number;
}

/**
 * Rule pre-pass to a fixpoint: infer -> simulate -> infer again (new entity roots produce new groups), at most `rounds`
 * times or until the ratio stops improving. Returns the merged site pack (over `sitePack`) and the round log.
 */
export async function inferProfilesIterative(
  input: CoverageInput,
  themePackId: string,
  sitePack: ProfilePack | undefined,
  opts: { rounds?: number; machines?: string[]; siteLocales?: SiteConfig["locales"] } = {},
): Promise<{ pack: ProfilePack; rounds: InferRound[]; analysis: CoverageAnalysis; ccm: ToCcmResult; slots: InferredSlot[]; entityRoots: NonNullable<ProfilePack["entityRoots"]>; classFields: InferResult["classFields"]; flags: InferResult["flags"] }> {
  let pack = sitePack;
  let sim = await simulateCoverage(input, themePackId, pack, opts.siteLocales);
  const rounds: InferRound[] = [];
  const allSlots: InferredSlot[] = [];
  const allRoots: NonNullable<ProfilePack["entityRoots"]> = [];
  const allClassFields: InferResult["classFields"] = [];
  const allFlags: InferResult["flags"] = [];
  let machines = opts.machines;
  for (let r = 1; r <= (opts.rounds ?? 3); r++) {
    const before = coverageRatio(sim.analysis, machines).ratio;
    const existingFields = Object.fromEntries(sim.ccm.schema.contentTypes.map((t) => [t.id, t.fields.map((f) => f.id)]));
    const inf = inferProfiles(sim.analysis, { machines, existingFields });
    if (!inf.slots.length && !inf.entityRoots.length && !inf.classFields.length && !inf.flags.length) break;
    const next = mergeIntoSitePack(pack, inf.pack);
    const nsim = await simulateCoverage(input, themePackId, next, opts.siteLocales);
    // new entity roots create new groups: follow them in the next round
    if (machines) machines = [...new Set([...machines, ...inf.entityRoots.map((e) => e.type)])];
    const after = coverageRatio(nsim.analysis, machines).ratio;
    rounds.push({ round: r, ratioBefore: before, ratioAfter: after, slots: inf.slots.length, entityRoots: inf.entityRoots.length });
    if (after <= before && !inf.entityRoots.length) break;
    pack = next;
    sim = nsim;
    allSlots.push(...inf.slots);
    allRoots.push(...inf.entityRoots);
    allClassFields.push(...inf.classFields);
    allFlags.push(...inf.flags);
  }
  return { pack: pack ?? {}, rounds, analysis: sim.analysis, ccm: sim.ccm, slots: allSlots, entityRoots: allRoots, classFields: allClassFields, flags: allFlags };
}

/** Coverage of every group on the given pages (stable when entity roots move text between groups). */
export function pageCoverageRatio(a: CoverageAnalysis, pages: string[]): { ratio: number; totalChars: number; coveredChars: number } {
  let total = 0;
  let covered = 0;
  for (const g of a.coverage.groups)
    for (const p of pages) {
      const x = g.byPage[p];
      if (!x) continue;
      total += x.totalChars;
      covered += x.coveredChars;
    }
  return { ratio: total ? round(covered / total) : 1, totalChars: total, coveredChars: covered };
}

/** Coverage summary for one group set. */
export function coverageRatio(a: CoverageAnalysis, machines?: string[]): { ratio: number; totalChars: number; coveredChars: number } {
  const gs = machines ? a.coverage.groups.filter((g) => machines.includes(g.machine)) : a.coverage.groups;
  const total = gs.reduce((n, g) => n + g.totalChars, 0);
  const covered = gs.reduce((n, g) => n + g.coveredChars, 0);
  return { ratio: total ? round(covered / total) : 1, totalChars: total, coveredChars: covered };
}

