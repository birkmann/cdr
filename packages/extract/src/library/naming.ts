// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Naming step of "Create components" (design-system flow): the AI model names the extracted component sets and their
// props and sorts them into categories, from a compact catalog of what each set is (structure, kind guess, breakpoints,
// sample copy as read-only context, current props). Its answer is checked hard before anything changes: names must be
// valid, unique, semantic identifiers; props are renamed only (same props, same types); sets it leaves out keep their
// names. Applying is componentSets.ts renameComponentSets (one undo step). Never touches copy, layout or structure.
// Pure; the model call lives in components/dsflow/ai.ts.
import type {
  SceneComponentCategory,
  SceneComponentDef,
  SceneComponentKind,
  SceneDesignSystem,
  SceneElement,
} from "@harness/protocol";
import { DATA_GUARD_RULE, wrapData } from "@harness/scene";
import { pascalCase, slugify } from "@harness/scene";
import { classPrefixes, isClassToken } from "@harness/scene";
import { CATEGORY_ORDER, classifyComponent, componentApi, type ComponentProp } from "./catalog.js";
import { axesOf } from "./instances.js";
import { extractionOf } from "./extract.js";
import { properTokenIn, properTokens } from "./namingWords.js";

/** Where a renameable prop comes from: a component property (by its name) or a content slot (target + field). */
export type NamingPropRef =
  { kind: "property"; property: string } | { kind: "slot"; target: string; field: "text" | "image" };

export interface NamingProp {
  id: string;
  name: string;
  type: ComponentProp["type"];
  ref: NamingPropRef;
  /**
   * a field of every item of a list inside the set (the title of each card of a grid): `name` is the field, the model
   * names it once (for the first item) and the name applies to the same field of every item (`others`)
   */
  item?: {
    list: string;
    itemLabel: string;
    others: Array<{ ref: NamingPropRef; name: string; itemLabel: string }>;
  };
}

/** One set as the model sees it (plus what the checks need). */
export interface NamingEntry {
  id: string;
  name: string;
  kind: SceneComponentKind;
  category: SceneComponentCategory;
  /** compact outline of the main: `a row[icon, text]`, nested sets as `<Button / Outline>` */
  structure: string;
  /** the root layer's own name (aria label, class-ish name) when it says something */
  layer?: string;
  breakpoints?: string[];
  /** copy of the main, read-only context */
  texts: string[];
  links?: string[];
  /** sets this one sits in / holds */
  usedIn?: string[];
  contains?: string[];
  /** where its instances sit on the pages: the control / link around them ("button “Details zur Störung”") */
  uses?: string[];
  /** its size and colours ("24×24 · #252525", "36×19 · outline #e1e1e1 · 16px text"): what tells twins apart */
  look?: string;
  /** what an icon shows, as the vision model read it from its drawing ("arrow right", "tram signet") */
  glyph?: string;
  instances?: number;
  /** a page section found once that matched no other: a unique section (extraction's `single`) */
  single?: boolean;
  /** the built-in name it shares with other sets (extraction's `nameClash`): all of them need distinct semantic names */
  nameClash?: string;
  props: NamingProp[];
  /** prop names the set has but the model does not rename (variant axes, props past the cap) */
  fixedProps: string[];
}

export interface NamingOptions {
  /** instances per set id on the canvas */
  instances?: Record<string, number>;
  /** where each set's instances sit (set id → contexts, see `usageContexts`) */
  contexts?: Record<string, string[]>;
  /** what each icon set shows (set id → glyph words, from the vision model) */
  glyphs?: Record<string, string>;
  maxProps?: number;
  maxTexts?: number;
}

const words = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function mainOf(def: SceneComponentDef): SceneElement | undefined {
  return def.variants[def.defaultVariant] ?? Object.values(def.variants)[0];
}

/** `section[h2, row[card×3], <Button / Filled>]` — what a tree is made of, a few levels deep. */
export function outlineOf(el: SceneElement, ds: SceneDesignSystem, depth = 0, maxDepth = 3): string {
  if (depth > 0 && el.instance)
    return `<${ds.componentSets?.find((d) => d.id === el.instance!.componentId)?.name ?? "instance"}>`;
  const tag = typeof el.meta?.tag === "string" ? el.meta.tag : "";
  const glyph = typeof el.meta?.glyph === "string" ? el.meta.glyph : el.icon;
  if (el.type === "text") return /^h[1-6]$/.test(tag) ? tag : "text";
  if (el.type === "icon" || el.type === "vector" || (el.svg && el.type !== "image"))
    return glyph ? `icon:${String(glyph).slice(0, 24)}` : "icon";
  if (el.type === "image" || el.type === "video") return el.type;
  const self = [
    tag && !["div", "span"].includes(tag) ? tag : el.type,
    el.layout?.direction === "row" ? "row" : "",
    el.layout?.scroll === "horizontal" ? "scroll" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const kids = (el.children ?? []).filter((c) => !c.meta?.hidden);
  if (!kids.length) return self;
  if (depth >= maxDepth) return `${self}(${kids.length})`;
  const parts: string[] = [];
  let prev = "",
    n = 0;
  const flush = () => {
    if (n) parts.push(n > 1 ? `${prev}×${n}` : prev);
  };
  for (const c of kids) {
    const o = outlineOf(c, ds, depth + 1, maxDepth);
    if (o === prev) n++;
    else {
      flush();
      prev = o;
      n = 1;
    }
  }
  flush();
  return `${self}[${parts.join(", ")}]`;
}

function textsOf(el: SceneElement, max: number): string[] {
  const out: string[] = [];
  const walk = (x: SceneElement) => {
    if (out.length >= max || x.meta?.hidden) return;
    const t = words(x.text ?? "");
    if (t && /[\p{L}\p{N}]{2}/u.test(t) && !out.includes(clip(t, 80))) out.push(clip(t, 80));
    x.children?.forEach(walk);
  };
  walk(el);
  return out;
}

function linksOf(el: SceneElement, max: number): string[] {
  const out: string[] = [];
  const walk = (x: SceneElement) => {
    const u = x.interaction?.url;
    if (out.length < max && typeof u === "string" && u && !out.includes(u))
      out.push(clip(u.replace(/^https?:\/\/[^/]+/, ""), 60));
    x.children?.forEach(walk);
  };
  walk(el);
  return out;
}

const hex = (c: string | undefined): string | null => {
  if (!c || /^(transparent|none)$/i.test(c)) return null;
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return c.startsWith("$") ? c : c.slice(0, 9);
  const [r, g, b, a] = m[1]!.split(",").map((x) => parseFloat(x));
  if (a !== undefined && a < 0.05) return null;
  return `#${[r, g, b]
    .map((x) =>
      Math.round(x ?? 0)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

/** A set's size and colours, compactly: what tells two otherwise alike sets apart. */
export function lookOf(main: SceneElement): string {
  const parts: string[] = [];
  const w = main.layout?.width,
    h = main.layout?.height;
  if (typeof w === "number" || typeof h === "number")
    parts.push(
      `${typeof w === "number" ? Math.round(w) : "auto"}×${typeof h === "number" ? Math.round(h) : "auto"}`,
    );
  const st = main.style ?? {};
  const bg = hex(st.background),
    border = st.border && st.border.width > 0 ? hex(st.border.color) : null;
  if (bg) parts.push(`fill ${bg}`);
  if (border) parts.push(`outline ${border}`);
  // the first text's size and colour, else the icon's colour
  let text: SceneElement | null = null;
  const find = (x: SceneElement) => {
    if (text) return;
    if (x.type === "text" && x.text?.trim()) text = x;
    else x.children?.forEach(find);
  };
  find(main);
  const t = text as SceneElement | null;
  if (t) parts.push(`${t.style?.fontSize ?? 16}px ${hex(t.style?.color) ?? ""} text`.replace(/ {2}/g, " "));
  else {
    const c = hex(st.color);
    if (c) parts.push(c);
  }
  return parts.join(" · ");
}

/**
 * Where the instances of each set sit on the given screens: the control or link around them (its label, else its layer
 * name) and the copy right next to them — up to `max` different ones per set. What an icon is for, when its drawing is
 * all the set itself has.
 */
export function usageContexts(screens: SceneElement[], max = 3): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const textOf = (x: SceneElement): string =>
    [x.text ?? "", ...(x.children ?? []).map(textOf)].join(" ").replace(/\s+/g, " ").trim();
  const detail = (x: SceneElement) =>
    x.name?.includes("·") ? x.name.split("·").slice(1).join("·").trim() : "";
  const add = (id: string, c: string) => {
    const l = (out[id] ??= []);
    if (c && l.length < max && !l.includes(c)) l.push(c);
  };
  const walk = (el: SceneElement, up: SceneElement[]) => {
    if (el.instance) {
      const id = el.instance.componentId;
      // the nearest control / link above (three layers at most)
      for (const p of up.slice(-3).reverse()) {
        const tag = typeof p.meta?.tag === "string" ? p.meta.tag : "";
        if (p.type !== "button" && tag !== "a" && tag !== "button" && !p.interaction) continue;
        const label = clip(textOf(p) || detail(p), 60);
        const url =
          typeof p.interaction?.url === "string" ? p.interaction.url.replace(/^https?:\/\/[^/]+/, "") : "";
        if (label || url)
          add(
            id,
            `${p.type === "button" || tag === "button" ? "button" : "link"}${label ? ` “${label}”` : ""}${url ? ` → ${clip(url, 50)}` : ""}`,
          );
        break;
      }
      // the copy next to it (an icon before a label)
      const parent = up[up.length - 1];
      const sib = parent?.children?.find(
        (c) => c !== el && !c.instance && c.type === "text" && c.text?.trim(),
      );
      if (sib) add(id, `next to “${clip(words(sib.text!), 40)}”`);
    }
    el.children?.forEach((c) => walk(c, [...up, el]));
  };
  screens.forEach((r) => walk(r, []));
  return out;
}

/** Set ids of the instances nested in a set's variants. */
function nestedSets(def: SceneComponentDef): Set<string> {
  const out = new Set<string>();
  const walk = (x: SceneElement, root: boolean) => {
    if (!root && x.instance) {
      out.add(x.instance.componentId);
      return;
    }
    x.children?.forEach((c) => walk(c, false));
  };
  for (const v of Object.values(def.variants)) walk(v, true);
  return out;
}

/** The catalog the model names: the given sets (in that order), with their renameable props. */
export function namingCatalog(ds: SceneDesignSystem, ids: string[], o: NamingOptions = {}): NamingEntry[] {
  const sets = ds.componentSets ?? [];
  const byId = new Map(sets.map((d) => [d.id, d]));
  const holders = new Map<string, string[]>();
  for (const d of sets) for (const id of nestedSets(d)) holders.set(id, [...(holders.get(id) ?? []), d.name]);
  const out: NamingEntry[] = [];
  for (const id of ids) {
    const def = byId.get(id);
    const main = def ? mainOf(def) : undefined;
    if (!def || !main) continue;
    const { kind, category } = classifyComponent(def, ds);
    const api = componentApi(def, ds, { slots: true });
    const props: NamingProp[] = [];
    const fixedProps: string[] = [];
    const refOf = (p: ComponentProp): NamingPropRef | null =>
      p.source.kind === "property"
        ? { kind: "property", property: p.source.property }
        : p.source.kind === "slot" && (p.source.field === "text" || p.source.field === "image")
          ? { kind: "slot", target: p.source.target, field: p.source.field }
          : null;
    // a list's items (the cards of a grid) share their fields: the first item's stand for all, the others ride along
    const firstItem = new Map<string, NamingProp>();
    const fieldKey = (p: ComponentProp) => `${p.item!.list}\u0000${p.item!.field}\u0000${p.type}`;
    for (const p of api) {
      const ref = refOf(p);
      if (ref && p.item && p.item.index > 0) {
        const head = firstItem.get(fieldKey(p));
        if (head) {
          head.item!.others.push({ ref, name: p.name, itemLabel: p.item.itemLabel });
          continue;
        }
      }
      if (!ref || props.length >= (o.maxProps ?? 12)) {
        if (!p.item) fixedProps.push(p.name);
        continue;
      }
      if (p.item) {
        const np: NamingProp = {
          id: `p${props.length + 1}`,
          name: camelOf(p.item.field) || p.name,
          type: p.type,
          ref,
          item: { list: p.item.name, itemLabel: p.item.itemLabel, others: [] },
        };
        firstItem.set(fieldKey(p), np);
        props.push(np);
        continue;
      }
      props.push({ id: `p${props.length + 1}`, name: p.name, type: p.type, ref });
    }
    const axes = axesOf(def);
    const layer = words((main.name ?? "").split("·")[0] ?? "");
    const contains = [...nestedSets(def)].map((x) => byId.get(x)?.name).filter((x): x is string => !!x);
    out.push({
      id,
      name: def.name,
      kind,
      category,
      structure: clip(outlineOf(main, ds), 260),
      ...(layer && layer.toLowerCase() !== main.type ? { layer: clip(layer, 48) } : {}),
      ...(axes.breakpoint && axes.breakpoint.length > 1 ? { breakpoints: axes.breakpoint } : {}),
      texts: textsOf(main, o.maxTexts ?? 6),
      ...(linksOf(main, 2).length ? { links: linksOf(main, 2) } : {}),
      ...(holders.get(id)?.length ? { usedIn: [...new Set(holders.get(id))].slice(0, 4) } : {}),
      ...(contains.length ? { contains: [...new Set(contains)].slice(0, 6) } : {}),
      ...(o.contexts?.[id]?.length ? { uses: o.contexts[id] } : {}),
      ...(lookOf(main) ? { look: lookOf(main) } : {}),
      ...(o.glyphs?.[id] ? { glyph: o.glyphs[id] } : {}),
      ...(o.instances?.[id] ? { instances: o.instances[id] } : {}),
      ...(extractionOf(def)?.single ? { single: true } : {}),
      ...(extractionOf(def)?.nameClash ? { nameClash: extractionOf(def)!.nameClash } : {}),
      props,
      fixedProps,
    });
  }
  return out;
}

/** What goes to the model per set (no internal refs). */
export function catalogForModel(entries: NamingEntry[]) {
  return entries.map((e) => ({
    id: e.id,
    name: e.name,
    kind: e.kind,
    category: e.category,
    structure: e.structure,
    ...(e.layer ? { layer: e.layer } : {}),
    ...(e.breakpoints ? { breakpoints: e.breakpoints } : {}),
    texts: e.texts,
    ...(e.links ? { links: e.links } : {}),
    ...(e.usedIn ? { usedIn: e.usedIn } : {}),
    ...(e.contains ? { contains: e.contains } : {}),
    ...(e.uses ? { uses: e.uses } : {}),
    ...(e.look ? { look: e.look } : {}),
    ...(e.glyph ? { glyph: e.glyph } : {}),
    ...(e.instances ? { instances: e.instances } : {}),
    ...(e.single ? { single: true } : {}),
    ...(e.nameClash ? { nameClash: e.nameClash } : {}),
    props: e.props.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      ...(p.item ? { item: p.item.list } : {}),
    })),
  }));
}

export const NAMING_SYSTEM_PROMPT = `You name the components of a design system that was extracted from a website, the way a front-end team names them in its React component library.

For every component in the catalog return:
- "id": its id, unchanged.
- "name": a short, semantic PascalCase name in English that says what the component IS or DOES, e.g. Header, MainNav, MegaMenu, HeroTeaser, JourneyPlanner, NewsCard, ServiceTile, IconButton, PrimaryButton, LineBadge, SocialLinks, FooterLinkGroup, Footer. Use the structure, kind, layer name, links, texts and "uses" (the button or link its instances sit in) to understand it. Not its colour, size or position ("ButtonOutlineLight", "Icon17Dark", "ListItemSmallVertical3" are bad). 1–4 words, letters only, no numbers and no "Alt" / "Variant" / "Other" / "Copy" suffixes: when two components are alike, name what differs — their purpose (PrimaryButton / SecondaryButton, NewsCard / AppCard), their glyph (ArrowRightIcon / InfoIcon), or, when only their "look" differs, their size (LineBadge / LineBadgeSmall). Every name must be unique, also against the other components of the system listed.
- Names describe structure and role — what kind of block it is and what it does — never the specific product, brand, customer, person, place or event the captured copy shows: a section about one product is a ProductTeaserSection, a customer story a CaseStudySection, not MaximoSection or TrivagoCaseStudySection.
- "nameClash": components with the same nameClash are different components that ended up with one built-in name ("Card / with image", "… 2", "… 3"): give each its own semantic name that says what tells it apart (purpose, content, glyph, size from "look") — never numbers, never the same name with a filler. "single": a unique page section, found once on the site: name it after what it is (StatsBand, ContactForm), not after its copy.
- Icons and signets are named after what they show: "glyph" (when given) is what the drawing shows, e.g. glyph "arrow right" → ArrowRightIcon, "tram signet" → TramSignet, "home" → HomeIcon; without a glyph use what the button or link it sits in does ("uses").
- "category": one of shell, sections, navigation, content, forms, feedback, media, foundations.
- "props": the component's props, the same ones with the same "id" and "type" — rename only, never add, drop or merge. Each "name" camelCase in English, saying what it holds: title, subtitle, eyebrow, description, label, href, imageSrc, imageAlt, ctaLabel, date, price, lineName, stopName, showIcon, icon… No numbers: several texts of one kind are named by their role (title, teaserTitle, footnote), not title1 / title2. Unique within the component. A prop with "item" is a field of every item of that list (each card of a grid): name the field once (title, imageSrc); unique within its list.
Also return "order": the component ids in the order a design-system catalog lists them: page shell (header, navigation, footer), then page sections top to bottom, then content blocks, form controls, and small atoms (buttons, tags, icons) last.

The texts are read-only context from the live page: never translate, rewrite or return them. You only name things.
Answer only with JSON: {"components":[{"id":"…","name":"…","category":"…","props":[{"id":"p1","name":"…","type":"text"}]}],"order":["…"]}

${DATA_GUARD_RULE}`;

/** The chat messages for one batch of the catalog. */
export function namingMessages(
  ds: SceneDesignSystem,
  entries: NamingEntry[],
  o: { others?: string[]; site?: string } = {},
): Array<{ role: "system" | "user"; content: string }> {
  const others = o.others ?? [];
  const ctx = others.length
    ? `\nOther components of the same system (being named in parallel, names may change): ${others.slice(0, 120).join(", ")}`
    : "";
  const site =
    [o.site, ds.name && ds.name !== "Design system" ? ds.name : ""].filter(Boolean).join(" · ") || "unknown";
  return [
    { role: "system", content: NAMING_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Website: ${site}. ${entries.length} components to name.${ctx}\n\n${wrapData("component catalog", JSON.stringify(catalogForModel(entries)))}`,
    },
  ];
}

/** The second round: only the sets whose proposed name was rejected, with why and the names already in use. */
export function retryMessages(
  ds: SceneDesignSystem,
  entries: NamingEntry[],
  rejected: string[],
  taken: string[],
  site = "",
): Array<{ role: "system" | "user"; content: string }> {
  const why = entries
    .map((e) =>
      rejected
        .filter((r) => r.startsWith(`${e.name} → `))
        .map((r) => r.slice(e.name.length + 3))
        .join("; "),
    )
    .map((w, i) => ({ id: entries[i]!.id, rejected: w }));
  return [
    { role: "system", content: NAMING_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Website: ${site || ds.name || "unknown"}. The names you proposed for these ${entries.length} components cannot be used (why: "rejected"). Name them again: semantic PascalCase, no numbers, no filler suffixes, and none of the names in use. Say what tells each apart from the component that has the name it wanted (its purpose, its glyph, its size from "look"). Props and order are not needed: {"components":[{"id":"…","name":"…"}]}.\nNames in use: ${taken.slice(0, 200).join(", ")}\n\n${wrapData("component catalog", JSON.stringify(catalogForModel(entries).map((e, i) => ({ ...e, rejected: why[i]!.rejected }))))}`,
    },
  ];
}

/* ------------------------------------------------------------------ checks */

export interface NamingAnswer {
  components?: unknown;
  order?: unknown;
}

export interface SetNamingChange {
  id: string;
  from: string;
  /** new set name (absent: keeps its name) */
  name?: string;
  category?: SceneComponentCategory;
  /** `label`: the exact prop label to apply (an item's property, "Card 2 headline"); else propLabel(to) */
  props: Array<{ ref: NamingPropRef; from: string; to: string; label?: string }>;
}

export interface NamingPlan {
  sets: SetNamingChange[];
  /** set ids in the model's catalog order (null: keep) */
  order: string[] | null;
  /** why parts of the answer were not used */
  rejected: string[];
}

/** Names a JS / TS file, React or the export cannot take as a component. */
const RESERVED_COMPONENT =
  /^(Object|Function|Array|String|Number|Boolean|Symbol|Error|Promise|Map|Set|Date|Math|JSON|Component|Element|Node|Event|Document|Window|Fragment|React|Props|Default|Undefined|Null|Infinity|NaN)$/;
/** JS keywords and names that break a component's props in React / Lit / Angular (export/ds/names.ts suffixes the softer ones). */
const RESERVED_PROP = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
  "arguments",
  "eval",
  "undefined",
  "constructor",
  "prototype",
  "__proto__",
  "key",
  "ref",
  "children",
  "className",
  "style",
  "props",
  "state",
]);

/** "imageSrc" → "Image src" (a prop label componentApi spells back as `imageSrc`). */
export function propLabel(name: string): string {
  const s = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** componentApi's spelling of a label (catalog.ts camel). */
const camelOf = (label: string) => {
  const w = label
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return w
    .map((x, i) => (i ? x.charAt(0).toUpperCase() + x.slice(1) : x.charAt(0).toLowerCase() + x.slice(1)))
    .join("");
};

/** Why a component name is not usable (null: fine). */
export function badComponentName(name: string): string | null {
  if (!/^[A-Z][A-Za-z0-9]{1,39}$/.test(name)) return "not a PascalCase identifier";
  if (pascalCase(name, "") !== name) return "does not survive as an export name";
  if (slugify(name, "").split("-").length > 5) return "too long";
  if (/\d$/.test(name)) return "ends in a number";
  if (FILLER_SUFFIX.test(name)) return "a filler suffix instead of what differs";
  if (RESERVED_COMPONENT.test(name)) return "reserved";
  return null;
}
/** "AppLinksListAlt", "CardVariant", "TeaserOther": a suffix that says the set is a second one, not what it is */
const FILLER_SUFFIX = /[a-z](Alt|Alternative|Variant|Variation|Other|Copy|Duplicate|Second|Two|New|Extra)$/;

/** Why a prop name is not usable (null: fine). */
export function badPropName(name: string): string | null {
  if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(name)) return "not a camelCase identifier";
  if (/[A-Z]{2}/.test(name)) return "has an acronym in capitals";
  if (RESERVED_PROP.has(name) || /^(on[A-Z]|aria|data[A-Z])/.test(name)) return "reserved";
  if (/\d$/.test(name)) return "ends in a number";
  if (camelOf(propLabel(name)) !== name) return "does not spell back";
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const exportName = (setName: string) =>
  pascalCase(slugify(setName, "component").split("-").slice(0, 5).join("-"), "Component").toLowerCase();
/** The key two set names clash on (as export names, case-insensitive). */
export const nameKey = exportName;

/* ------------------------------------------------------------------ semantic lint */

/**
 * What the semantic checks compare a proposed name against: the captured copy (as 3-word runs) and the capture's
 * CSS-class prefixes ("cds" for IBM Carbon), learned from its layer names.
 */
export interface NamingLint {
  /** every run of three consecutive words of the captured texts, folded (`foldWords`) and joined by spaces */
  copy: ReadonlySet<string>;
  /** the capture's own class prefixes (`classPrefixes`), on top of the known framework prefixes */
  classTokens: ReadonlySet<string>;
  /** the copy's products, brands, customers, events (`properTokens`, from its text statistics) */
  proper?: ReadonlySet<string>;
}

/** A built-in name ("Card / with image 2", "Icon 17", "Button group"): not one PascalCase identifier. */
export const isBuiltInName = (name: string) => !/^[A-Z][A-Za-z]*$/.test(name.trim());

/** "für" → "fuer", "ß" → "ss", "é" → "e", "ł" → "l": a name's letters in ASCII (other scripts are dropped). */
export function transliterate(s: string): string {
  const map: Record<string, string> = {
    ä: "ae",
    ö: "oe",
    ü: "ue",
    Ä: "Ae",
    Ö: "Oe",
    Ü: "Ue",
    ß: "ss",
    ẞ: "Ss",
    æ: "ae",
    Æ: "Ae",
    œ: "oe",
    Œ: "Oe",
    ø: "o",
    Ø: "O",
    ł: "l",
    Ł: "L",
    đ: "d",
    Đ: "D",
    þ: "th",
    Þ: "Th",
    ð: "d",
    ı: "i",
  };
  return s
    .replace(/[äöüÄÖÜßẞæÆœŒøØłŁđĐþÞðı]/g, (c) => map[c]!)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{ASCII}]/gu, (c) => (/\p{L}/u.test(c) ? "" : " "));
}

/**
 * Words of a text or a PascalCase name, lower case and folded so that the model's spelling of the copy matches it
 * ("SchulungenFuerDieZukunft" and "Schulungen für die Zukunft" both → schulungen fur die zukunft). Numbers are dropped.
 */
export function foldWords(s: string): string[] {
  return transliterate(s)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .map((w) => w.replace(/([aou])e/g, "$1"));
}

const runsOf = (w: string[], n = 3) =>
  Array.from({ length: Math.max(0, w.length - n + 1) }, (_, i) => w.slice(i, i + n).join(" "));

/**
 * The lint context of a system: the copy of its sets' mains and of the given pages, and the class prefixes of all their
 * layer names.
 */
export function namingLint(ds: SceneDesignSystem, pages: SceneElement[] = []): NamingLint {
  const copy = new Set<string>();
  const layers: string[] = [];
  const texts: string[] = [];
  const walk = (x: SceneElement) => {
    if (x.text) {
      texts.push(x.text);
      for (const r of runsOf(foldWords(x.text))) copy.add(r);
    }
    if (x.name) layers.push(x.name);
    x.children?.forEach(walk);
  };
  for (const d of ds.componentSets ?? []) for (const v of Object.values(d.variants)) walk(v);
  pages.forEach(walk);
  return { copy, classTokens: classPrefixes(layers), proper: properTokens(texts) };
}

/** Head nouns of whole page parts, of items in them and of small controls: a set of one kind named with another's is misnamed. */
const PAGE_HEADS = new Set([
  "section",
  "header",
  "footer",
  "hero",
  "banner",
  "page",
  "layout",
  "grid",
  "carousel",
  "slider",
  "accordion",
  "table",
  "modal",
  "dialog",
  "navigation",
  "nav",
  "menu",
  "masthead",
  "band",
  "stage",
]);
const ATOM_HEADS = new Set([
  "icon",
  "button",
  "badge",
  "tag",
  "chip",
  "pill",
  "input",
  "checkbox",
  "radio",
  "toggle",
  "switch",
  "avatar",
  "divider",
  "tooltip",
  "logo",
  "signet",
]);
const ITEM_KINDS = new Set<SceneComponentKind>(["card", "teaser", "list-item", "quote", "stat"]);
const ATOM_KINDS = new Set<SceneComponentKind>([
  "button",
  "icon-button",
  "link",
  "badge",
  "tag",
  "icon",
  "logo",
  "input",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "toggle",
  "avatar",
  "divider",
  "tooltip",
  "progress",
]);

/** A head noun a set of this kind must not carry: an atom's for a page part or a card, a page part's or a card's for an atom. */
function wrongHead(kind: SceneComponentKind, head: string): boolean {
  if (kind === "header" || kind === "footer" || kind === "section")
    return ATOM_HEADS.has(head) || ["card", "tile", "item", "link"].includes(head);
  if (kind === "hero") return ATOM_HEADS.has(head) || ["tile", "item", "link"].includes(head);
  if (ITEM_KINDS.has(kind))
    return (
      ATOM_HEADS.has(head) ||
      ["header", "footer", "page", "layout", "navigation", "nav", "masthead"].includes(head)
    );
  if (ATOM_KINDS.has(kind)) return PAGE_HEADS.has(head) || ["card", "teaser", "tile"].includes(head);
  return false;
}

/**
 * Why a proposed name is not semantic (null: fine): it is (or holds) captured page copy of three words or more, or a
 * product / brand / event word of the copy (`properTokens`: "MaximoSection", "TrivagoCaseStudySection"), it holds
 * a CSS-class token ("CdsCardContent"), or its head noun is another kind's ("NewsCard" for a button, "ArrowIcon" for a
 * section).
 */
export function semanticNameIssue(
  name: string,
  e: Pick<NamingEntry, "kind" | "texts">,
  lint?: NamingLint,
): string | null {
  const w = foldWords(name);
  const own = new Set((e.texts ?? []).flatMap((t) => runsOf(foldWords(t))));
  const hit = runsOf(w).find((r) => own.has(r) || lint?.copy.has(r));
  if (hit) return `captured page copy (“${hit}”)`;
  // (an icon or logo may be named after the brand it shows: IbmLogo, ConfluentIcon)
  const noun =
    e.kind === "logo" || e.kind === "icon"
      ? null
      : properTokenIn(name, lint?.proper ?? properTokens(e.texts ?? []));
  if (noun) return `a product, brand or event of the copy (“${noun}”), not what the component is`;
  const raw = transliterate(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const cls = raw.find((x) => isClassToken(x, lint?.classTokens));
  if (cls) return `a CSS class token (“${cls}”)`;
  const head = raw[raw.length - 1];
  const a = (w: string) => `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`;
  if (head && wrongHead(e.kind, head)) return `names ${a(head)} for ${a(e.kind)}`;
  return null;
}

/**
 * Check a model's answer against the catalog it was given and the system as it is now. Only what holds up is kept:
 * known sets, valid semantic names (no page copy, no CSS-class tokens, the kind's head noun — `semanticNameIssue`, with
 * `lint` from the system and its pages) that stay unique (with every other set's name), categories from the list, props renamed one
 * for one (same ids and types, valid unique names — else none of that set's props). Sets the answer leaves out (or whose
 * name changed meanwhile) keep their names.
 */
export function validateNaming(
  ds: SceneDesignSystem,
  entries: NamingEntry[],
  answer: NamingAnswer | null,
  pending: ReadonlyMap<string, string> = new Map(),
  lint: NamingLint = namingLint(ds),
): NamingPlan {
  const rejected: string[] = [];
  const plan: NamingPlan = { sets: [], order: null, rejected };
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.components)) {
    rejected.push("answer has no components list");
    return plan;
  }
  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const current = new Map((ds.componentSets ?? []).map((d) => [d.id, d]));
  const seen = new Set<string>();
  const proposed = new Map<string, SetNamingChange>();
  for (const raw of answer.components as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const id = str(a.id);
    const e = byEntry.get(id);
    const def = current.get(id);
    if (!e || !def) {
      if (id) rejected.push(`${id}: unknown component`);
      continue;
    }
    if (seen.has(id)) {
      rejected.push(`${e.name}: named twice`);
      continue;
    }
    seen.add(id);
    if (def.name !== e.name) {
      rejected.push(`${e.name}: renamed meanwhile`);
      continue;
    }
    const change: SetNamingChange = { id, from: e.name, props: [] };
    const name = str(a.name);
    const why = name
      ? (badComponentName(name) ?? (name !== e.name ? semanticNameIssue(name, e, lint) : null))
      : null;
    if (name && why) rejected.push(`${e.name} → ${name}: ${why}`);
    else if (name && name !== e.name) change.name = name;
    const cat = str(a.category) as SceneComponentCategory;
    if (cat && CATEGORY_ORDER.includes(cat) && cat !== e.category) change.category = cat;
    if (a.props !== undefined && e.props.length) {
      const res = checkProps(e, a.props);
      if (typeof res === "string") rejected.push(`${e.name} props: ${res}`);
      else {
        change.props = res.props;
        rejected.push(...res.notes.map((n) => `${e.name} prop ${n}`));
      }
    }
    proposed.set(id, change);
  }
  // names stay unique (as export names, case-insensitive) among every set of the system: a proposal that takes the
  // name of a set that keeps its own is dropped; of two proposals for one name, the first (catalog order) keeps it
  const rank = new Map(entries.map((e, i) => [e.id, i]));
  for (let round = 0; round < 8; round++) {
    const owners = new Map<string, string[]>();
    for (const d of ds.componentSets ?? []) {
      // (`pending`: names other sets are getting in the same run)
      const n = exportName(proposed.get(d.id)?.name ?? pending.get(d.id) ?? d.name);
      owners.set(n, [...(owners.get(n) ?? []), d.id]);
    }
    let dropped = false;
    for (const ids of owners.values()) {
      if (ids.length < 2) continue;
      const renamed = ids.filter((id) => proposed.get(id)?.name).sort((a, b) => rank.get(a)! - rank.get(b)!);
      const keep = renamed.length === ids.length ? renamed[0] : undefined;
      for (const id of renamed) {
        if (id === keep) continue;
        const c = proposed.get(id)!;
        rejected.push(`${c.from} → ${c.name}: not unique`);
        delete c.name;
        dropped = true;
      }
    }
    if (!dropped) break;
  }
  // sets that share a built-in name (extraction's nameClash) must end on distinct base names: of two proposals on one
  // base name (numbers aside) the first keeps it; members left on their numbered built-in name are noted
  const groups = new Map<string, string[]>();
  for (const d of ds.componentSets ?? []) {
    const c = extractionOf(d)?.nameClash;
    if (c) groups.set(c, [...(groups.get(c) ?? []), d.id]);
  }
  const baseOf = (n: string) => exportName(n).replace(/\d+$/, "");
  for (const [clash, ids] of groups) {
    if (ids.length < 2) continue;
    const seenBase = new Map<string, string>();
    for (const id of [...ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9))) {
      const c = proposed.get(id);
      const given = c?.name ?? pending.get(id);
      if (!given) {
        const e = byEntry.get(id);
        if (e && isBuiltInName(e.name))
          rejected.push(
            `${e.name}: still on the built-in name it shares with ${ids.length - 1} other set${ids.length > 2 ? "s" : ""} (“${clash}”)`,
          );
        continue;
      }
      const b = baseOf(given);
      if (seenBase.has(b) && c?.name) {
        rejected.push(
          `${c.from} → ${c.name}: not unique among the sets named “${clash}” (same as ${seenBase.get(b)})`,
        );
        delete c.name;
        continue;
      }
      seenBase.set(b, given);
    }
  }
  plan.sets = [...proposed.values()].filter((c) => c.name || c.category || c.props.length);
  if (Array.isArray(answer.order)) {
    // the model's order, grouped by category (batches of a big catalog each have their own order)
    const catOf = (id: string) =>
      CATEGORY_ORDER.indexOf(proposed.get(id)?.category ?? byEntry.get(id)!.category);
    const given = [
      ...new Set((answer.order as unknown[]).map(str).filter((id) => byEntry.has(id) && current.has(id))),
    ];
    const order = given
      .map((id, i) => ({ id, i }))
      .sort((a, b) => catOf(a.id) - catOf(b.id) || a.i - b.i)
      .map((x) => x.id);
    if (order.length >= 2) plan.order = order;
  }
  return plan;
}

/**
 * A set's prop renames: the answer must list the same props (ids, types); a name that is not usable keeps the prop's
 * old name (noted in `notes`), names stay unique within the set (a later clash keeps its old name too).
 */
function checkProps(
  e: NamingEntry,
  raw: unknown,
): { props: NamingPlan["sets"][number]["props"]; notes: string[] } | string {
  if (!Array.isArray(raw)) return "not a list";
  if (raw.length !== e.props.length) return `${raw.length} props for ${e.props.length}`;
  const byId = new Map(e.props.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const want: Array<{ p: NamingProp; name: string }> = [];
  const notes: string[] = [];
  for (const r of raw) {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const p = byId.get(str(x.id));
    if (!p || seen.has(p.id)) return `unknown or repeated prop ${str(x.id) || "?"}`;
    seen.add(p.id);
    if (x.type !== undefined && str(x.type) !== p.type) return `${p.name} changes type to ${str(x.type)}`;
    const name = str(x.name) || p.name;
    const why = name === p.name ? null : badPropName(name);
    if (why) notes.push(`${p.name} → ${name}: ${why}`);
    want.push({ p, name: why ? p.name : name });
  }
  // unique within the set (and against the props it keeps; an item's field within its list): a clash keeps the later
  // prop's old name
  const fixed = new Set(e.fixedProps.map((n) => n.toLowerCase()));
  const key = (w: { p: NamingProp; name: string }) =>
    `${w.p.item ? `${w.p.item.list}.` : ""}${w.name.toLowerCase()}`;
  for (let round = 0; round < 4; round++) {
    const used = new Set(fixed);
    let moved = false;
    for (const w of want) {
      if (used.has(key(w)) && w.name !== w.p.name) {
        notes.push(`${w.p.name} → ${w.name}: twice`);
        w.name = w.p.name;
        moved = true;
      }
      used.add(key(w));
    }
    if (!moved) break;
  }
  const finals = want.map(key);
  if (new Set(finals).size !== finals.length || finals.some((n) => fixed.has(n))) return "names not unique";
  const out: NamingPlan["sets"][number]["props"] = [];
  for (const w of want.filter((x) => x.name !== x.p.name)) {
    const it = w.p.item;
    // an item's field: the same name for that field of every item of the list (a property keeps its item: "Card 2 headline")
    const one = (ref: NamingPropRef, from: string, itemLabel: string) =>
      out.push({
        ref,
        from,
        to: w.name,
        ...(it && ref.kind === "property"
          ? { label: `${itemLabel} ${propLabel(w.name).toLowerCase()}` }
          : {}),
      });
    one(w.p.ref, w.p.name, it?.itemLabel ?? "");
    for (const x of it?.others ?? []) one(x.ref, x.name, x.itemLabel);
  }
  return { props: out, notes };
}

/** Short summary of a plan for the flow panel. */
export function namingSummary(plan: NamingPlan): { sets: number; props: number; categories: number } {
  return {
    sets: plan.sets.filter((s) => s.name).length,
    props: plan.sets.reduce((n, s) => n + s.props.length, 0),
    categories: plan.sets.filter((s) => s.category).length,
  };
}
