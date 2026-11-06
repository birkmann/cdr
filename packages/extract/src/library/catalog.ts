// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Design-system catalog: where each component set belongs (category / kind), in which order a system lists them, and
// the public API of a set — the props a designer sets in the component library and a framework export exposes
// (variant axes, component properties, content slots). Shared by the component library view (components/storybook),
// the design-system exports (export/ds) and the completion of a system (brandKit.ts). Pure.
import type {
  SceneComponentCategory,
  SceneComponentDef,
  SceneComponentKind,
  SceneDesignSystem,
  SceneElement,
} from "@harness/protocol";
import { ROOT_KEY, axesOf } from "./instances.js";
import { itemPlaces, repeatedItems } from "./repeatedItems.js";

/** Categories in the order a design system lists them. */
export const CATEGORY_ORDER: readonly SceneComponentCategory[] = [
  "shell",
  "sections",
  "navigation",
  "content",
  "forms",
  "feedback",
  "media",
  "foundations",
];

export const CATEGORY_LABELS: Record<SceneComponentCategory, string> = {
  shell: "Shell",
  sections: "Sections",
  navigation: "Navigation",
  content: "Content",
  forms: "Forms & inputs",
  feedback: "Feedback",
  media: "Media",
  foundations: "Foundations",
};

/** Every kind's category (a kind decides its category; `other` falls back to content). */
export const KIND_CATEGORY: Record<SceneComponentKind, SceneComponentCategory> = {
  header: "shell",
  footer: "shell",
  navigation: "shell",
  hero: "sections",
  section: "sections",
  menu: "navigation",
  breadcrumb: "navigation",
  pagination: "navigation",
  tabs: "navigation",
  link: "navigation",
  card: "content",
  teaser: "content",
  "list-item": "content",
  list: "content",
  accordion: "content",
  carousel: "content",
  table: "content",
  quote: "content",
  stat: "content",
  button: "forms",
  "icon-button": "forms",
  input: "forms",
  textarea: "forms",
  select: "forms",
  checkbox: "forms",
  radio: "forms",
  toggle: "forms",
  search: "forms",
  form: "forms",
  badge: "feedback",
  tag: "feedback",
  alert: "feedback",
  toast: "feedback",
  modal: "feedback",
  tooltip: "feedback",
  progress: "feedback",
  image: "media",
  video: "media",
  lightbox: "media",
  avatar: "media",
  icon: "foundations",
  logo: "foundations",
  text: "foundations",
  divider: "foundations",
  other: "content",
};

export const KIND_LABELS: Record<SceneComponentKind, string> = {
  header: "Header",
  footer: "Footer",
  navigation: "Navigation",
  hero: "Hero",
  section: "Section",
  menu: "Menu",
  breadcrumb: "Breadcrumb",
  pagination: "Pagination",
  tabs: "Tabs",
  link: "Link",
  card: "Card",
  teaser: "Teaser",
  "list-item": "List item",
  list: "List",
  accordion: "Accordion",
  carousel: "Carousel",
  table: "Table",
  quote: "Quote",
  stat: "Stat",
  button: "Button",
  "icon-button": "Icon button",
  input: "Input",
  textarea: "Text area",
  select: "Select",
  checkbox: "Checkbox",
  radio: "Radio",
  toggle: "Toggle",
  search: "Search",
  form: "Form",
  badge: "Badge",
  tag: "Tag",
  alert: "Alert",
  toast: "Toast",
  modal: "Modal",
  tooltip: "Tooltip",
  progress: "Progress",
  image: "Image",
  video: "Video",
  lightbox: "Lightbox",
  avatar: "Avatar",
  icon: "Icon",
  logo: "Logo",
  text: "Text",
  divider: "Divider",
  other: "Other",
};

/**
 * The kinds a complete web design system has (brandKit.ts generates the ones a system lacks, in the brand's look).
 * Shell and sections come from the site; these are the building blocks pages are made of.
 */
export const ESSENTIAL_KINDS: readonly SceneComponentKind[] = [
  "header",
  "footer",
  "hero",
  "navigation",
  "section",
  "menu",
  "breadcrumb",
  "pagination",
  "tabs",
  "link",
  "card",
  "teaser",
  "list-item",
  "list",
  "accordion",
  "carousel",
  "table",
  "quote",
  "stat",
  "button",
  "icon-button",
  "input",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "toggle",
  "search",
  "form",
  "badge",
  "tag",
  "alert",
  "toast",
  "modal",
  "tooltip",
  "progress",
  "image",
  "video",
  "lightbox",
  "avatar",
  "icon",
  "divider",
];

/** One prop of a component's public API. */
export interface ComponentProp {
  /** camelCase, unique per component (`variant`, `title`, `showIcon`, `image`) */
  name: string;
  /** what a designer sees in the component library */
  label: string;
  type: "enum" | "text" | "boolean" | "image" | "link" | "instance";
  default: string | boolean;
  /** enum: the values (a variant axis' values); instance: component set ids that fit */
  options?: string[];
  /** where it comes from: a variant axis, a component property, or a content slot instances override */
  source:
    | { kind: "axis"; axis: string }
    | { kind: "property"; property: string }
    | { kind: "slot"; target: string; field: "text" | "image" | "href" | "hidden" };
  description?: string;
  /** the prop belongs to one item of a list of alike items inside the component (a card of a grid): grouped per item */
  item?: PropItem;
  /**
   * the main's own value, when the instances mostly show another (`default` is then the most common one; see
   * componentApi `instances`)
   */
  main?: string | boolean;
}

/** A prop's place in a list of alike items inside its component (the cards of a grid, the links of a column). */
export interface PropItem {
  /** the list: its parent layer (main element id), an array-like name (`cards`) and a label ("Cards") */
  list: string;
  name: string;
  label: string;
  /** the item: 0-based position, its root layer (main element id), its label ("Card 1") */
  index: number;
  root: string;
  itemLabel: string;
  /** what the prop is within its item ("Title", "Image"; a bare entry's copy: "Label") */
  field: string;
}

/** Where a set is used: an instance on a screen (instancesOf). */
export interface InstanceUse {
  screen: string;
  element: string;
  link: NonNullable<SceneElement["instance"]>;
}

const camel = (s: string) => {
  const words = s
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out = words
    .map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toLowerCase() + w.slice(1)))
    .join("");
  return /^[A-Za-z_]/.test(out) ? out : `p${out}`;
};

/**
 * The public API of a component set: one enum prop per variant axis, one prop per component property, then content
 * slots (texts, images, links of the main that are not already a property) when `slots` is set. Copy inside alike
 * sibling items (the cards of a grid) is grouped per item (`item`, named `cards[0].title`), never numbered flat.
 * `instances` (instancesOf: the set's uses on the screens) makes each prop's default the value most instances show,
 * not the copy the main happened to be converted from (`main` keeps the main's own value then).
 */
export function componentApi(
  def: SceneComponentDef,
  ds: SceneDesignSystem,
  o: { slots?: boolean; instances?: readonly InstanceUse[] } = {},
): ComponentProp[] {
  const out: ComponentProp[] = [];
  const taken = new Set<string>();
  const unique = (base: string) => {
    let n = camel(base) || "prop";
    for (let i = 2; taken.has(n); i++) n = `${camel(base)}${i}`;
    taken.add(n);
    return n;
  };
  const axes = axesOf(def);
  const defaults = Object.fromEntries(
    def.defaultVariant
      .split(",")
      .map((p) => p.split("="))
      .filter((p) => p.length === 2),
  ) as Record<string, string>;
  for (const [axis, values] of Object.entries(axes)) {
    if (values.length < 2) continue;
    out.push({
      name: unique(axis),
      label: axis,
      type: "enum",
      default: defaults[axis] ?? values[0]!,
      options: values,
      source: { kind: "axis", axis },
    });
  }
  const main = def.variants[def.defaultVariant] ?? Object.values(def.variants)[0];
  const kind = def.kind ?? (main ? classifyTree(main) : "other");
  // properties on copy inside list items belong to their item
  const propItems = main
    ? itemFields(
        main,
        kind,
        {
          text: (def.properties ?? []).filter((p) => p.type === "text").map((p) => p.target),
          image: (def.properties ?? []).filter((p) => p.type === "image").map((p) => p.target),
        },
        ds,
      )
    : new Map<string, PropItem>();
  for (const p of def.properties ?? []) {
    const type =
      p.type === "boolean"
        ? "boolean"
        : p.type === "instance-swap"
          ? "instance"
          : p.type === "image"
            ? "image"
            : "text";
    const fits = type === "instance" ? kindOfTarget(def, p.target, ds) : undefined;
    const item = type === "text" || type === "image" ? propItems.get(p.target) : undefined;
    out.push({
      name: unique(p.name),
      label: p.name,
      type,
      default: p.default,
      source: { kind: "property", property: p.name },
      ...(type === "instance"
        ? {
            options: (ds.componentSets ?? [])
              .filter((d) => d.id !== def.id && (!fits || d.kind === fits))
              .map((d) => d.id),
          }
        : {}),
      ...(item ? { item } : {}),
    });
  }
  if (o.slots) {
    const targets = new Set((def.properties ?? []).map((p) => p.target));
    const slots: PropertyTargets = { text: [], boolean: [], swap: [], image: [] };
    const byId = new Map<string, SceneElement>();
    const walk = (el: SceneElement, root: boolean) => {
      if (!root && el.instance) return;
      byId.set(el.id, el);
      if (!targets.has(el.id)) {
        // copy, not separators or glyphs ("|", "·", "→")
        if (el.type === "text" && /[\p{L}\p{N}]{2}/u.test(el.text ?? "")) slots.text.push(el.id);
        if (el.image?.src && el.type !== "icon") slots.image.push(el.id);
      }
      el.children?.forEach((c) => walk(c, false));
    };
    if (main) {
      walk(main, true);
      // named like properties ("title", "description", "image"), after the properties' own names
      // (the properties' texts take part in telling the slots' roles apart: a slot above the Title property is its eyebrow)
      const fixed = new Map(
        (def.properties ?? []).filter((p) => p.type === "text").map((p) => [p.target, p.name] as const),
      );
      const named = propertyNames(
        main,
        kind,
        slots,
        ds,
        (def.properties ?? []).map((p) => p.name),
        fixed,
      );
      // a slot someone (or the naming step, naming.ts) gave a name keeps it
      const givenOf = (target: string, type: string) =>
        def.propNames?.[slotKey(target, type === "text" ? "text" : "image")];
      // an item's copy: `cards[0].title`, labelled by what it is in its item ("Title")
      const itemName = (it: PropItem) => {
        const base = `${it.name}[${it.index}].${camel(it.field) || "value"}`;
        let n = base;
        for (let i = 2; taken.has(n); i++) n = `${base}${i}`;
        taken.add(n);
        return n;
      };
      for (const s of named) {
        const el = byId.get(s.target)!;
        const field = s.type === "text" ? "text" : "image";
        const value = s.type === "text" ? (el.text ?? "") : (el.image?.src ?? "");
        if (s.item) {
          const item = { ...s.item, field: givenOf(s.target, s.type) || s.item.field };
          out.push({
            name: itemName(item),
            label: item.field,
            type: field,
            default: value,
            source: { kind: "slot", target: el.id, field },
            item,
          });
          continue;
        }
        const label = givenOf(s.target, s.type) || s.name;
        out.push({
          name: unique(label),
          label,
          type: field,
          default: value,
          source: { kind: "slot", target: el.id, field },
        });
      }
    }
  }
  if (o.instances?.length && main) withCommonDefaults(out, o.instances, main.id);
  return out;
}

/* ------------------------------------------------------------------ instances: neutral defaults */

/** What one instance shows for a prop (undefined: the main's value). */
function instanceValue(
  p: ComponentProp,
  link: InstanceUse["link"],
  rootId: string,
): string | boolean | undefined {
  const s = p.source;
  if (s.kind === "axis") return link.variant?.[s.axis];
  if (s.kind === "property") return link.props?.[s.property] ?? undefined;
  const ov = link.overrides?.[s.target === rootId ? ROOT_KEY : s.target];
  if (!ov) return undefined;
  if (s.field === "text") return typeof ov.text === "string" ? ov.text : undefined;
  if (s.field === "image") return typeof ov.image?.src === "string" ? ov.image.src : undefined;
  if (s.field === "href") return typeof ov.interaction?.url === "string" ? ov.interaction.url : undefined;
  return typeof ov.meta?.hidden === "boolean" ? !ov.meta.hidden : undefined;
}

/** Defaults → the value most instances show (ties keep the main's); the main's own value stays as `main`. */
function withCommonDefaults(api: ComponentProp[], uses: readonly InstanceUse[], rootId: string) {
  for (const p of api) {
    if (p.source.kind === "axis") continue;
    const count = new Map<string | boolean, number>();
    for (const u of uses) {
      const v = instanceValue(p, u.link, rootId) ?? p.default;
      count.set(v, (count.get(v) ?? 0) + 1);
    }
    let best = p.default,
      n = count.get(p.default) ?? 0;
    for (const [v, c] of count)
      if (c > n) {
        best = v;
        n = c;
      }
    if (best !== p.default) {
      p.main = p.default;
      p.default = best;
    }
  }
}

/** Every instance of a set on the given screens (nested ones too), in screen and reading order. */
export function instancesOf(
  setId: string,
  nodes: readonly { id: string; dsl?: { root: SceneElement } }[],
): InstanceUse[] {
  const out: InstanceUse[] = [];
  for (const n of nodes) {
    if (!n.dsl) continue;
    const walk = (el: SceneElement) => {
      if (el.instance?.componentId === setId) out.push({ screen: n.id, element: el.id, link: el.instance });
      el.children?.forEach(walk);
    };
    walk(n.dsl.root);
  }
  return out;
}

/** Which instance the main's content is: the first use showing the main's own copy and pictures (none: -1). */
export interface MainShows {
  /** index into the uses (-1: no instance shows the main's content any more) */
  index: number;
  use: InstanceUse | null;
  /** uses that show exactly the main's content, of all uses */
  matching: number;
  total: number;
}

/**
 * Which of a set's instances the main shows (the copy it was converted from), so a preview can say so ("Shows the
 * copy of 1 of 6 uses"): an instance that overrides none of the main's content (properties, copy, pictures).
 */
export function mainShows(
  def: SceneComponentDef,
  ds: SceneDesignSystem,
  uses: readonly InstanceUse[],
): MainShows {
  const main = def.variants[def.defaultVariant] ?? Object.values(def.variants)[0];
  const api = componentApi(def, ds, { slots: true }).filter(
    (p) => p.source.kind !== "axis" && p.type !== "instance",
  );
  const same = (u: InstanceUse) =>
    api.every((p) => {
      const v = instanceValue(p, u.link, main?.id ?? "");
      return v === undefined || v === p.default;
    });
  const hits = uses.map((u, i) => (same(u) ? i : -1)).filter((i) => i >= 0);
  const index = hits[0] ?? -1;
  return { index, use: index >= 0 ? uses[index]! : null, matching: hits.length, total: uses.length };
}

/* ------------------------------------------------------------------ lint: numbered props */

/**
 * Props of a set's public API (content slots included) whose names still end in a number — `Title 2`, `title2`,
 * `Image 3`: copy appended flat where it should be an item of a list, a lint hit. A list item's copy (`item`:
 * `cards[1].title`, "Card 2 title", a list's bare entries "Item 2") is grouped per item and no hit.
 */
export function numberedProps(def: SceneComponentDef, ds: SceneDesignSystem): ComponentProp[] {
  const numbered = (s: string) => /\d$/.test(s.trim());
  return componentApi(def, ds, { slots: true }).filter(
    (p) =>
      p.source.kind !== "axis" &&
      !(p.item && (p.label === p.item.itemLabel || !numbered(p.label))) &&
      (numbered(p.label) || numbered(p.name)),
  );
}

/** numberedProps of every set of a system: `{ set: set id, name: set name, prop: the prop's label }`. */
export function numberedPropsOf(ds: SceneDesignSystem): Array<{ set: string; name: string; prop: string }> {
  return (ds.componentSets ?? []).flatMap((d) =>
    Object.keys(d.variants).length
      ? numberedProps(d, ds).map((p) => ({ set: d.id, name: d.name, prop: p.label }))
      : [],
  );
}

/** Key of a content slot in `SceneComponentDef.propNames`. */
export const slotKey = (target: string, field: "text" | "image") => `${target}:${field}`;

/** Layers a set's properties point at, by type (main element ids). */
export interface PropertyTargets {
  text: string[];
  boolean: string[];
  swap: string[];
  image: string[];
}

/** Kinds whose one text is a label (a button's, a link's, a tag's), not a title. */
const LABELLED: ReadonlySet<SceneComponentKind> = new Set<SceneComponentKind>([
  "button",
  "icon-button",
  "link",
  "tag",
  "badge",
  "input",
  "textarea",
  "select",
  "search",
  "checkbox",
  "radio",
  "toggle",
  "tabs",
  "breadcrumb",
  "pagination",
  "tooltip",
  "toast",
  "progress",
]);

/** Kinds whose texts are their items (a heading above them, when it is bigger): Title, Item 1, Item 2… */
const LISTS: ReadonlySet<SceneComponentKind> = new Set<SceneComponentKind>([
  "list",
  "navigation",
  "menu",
  "breadcrumb",
  "pagination",
  "tabs",
]);

/** What one item of a list is called, by the kind of its tree ("Card" → "Cards"); anything else is an "Item". */
const ITEM_NOUN: Partial<Record<SceneComponentKind, string>> = {
  card: "Card",
  teaser: "Teaser",
  link: "Link",
  stat: "Stat",
  quote: "Quote",
  button: "Button",
  tag: "Tag",
  badge: "Badge",
  image: "Picture",
  logo: "Logo",
  avatar: "Avatar",
  "icon-button": "Button",
};

/**
 * The copy and pictures among `t` that lie inside alike sibling items of `main` (repeatedItems: the cards of a grid,
 * the links of a column), each with its item and what it is there: the fields of an item are named like a set's own
 * properties ("Title", "Description", "Image"); a bare entry (the item is the text itself) is its "Label".
 */
export function itemFields(
  main: SceneElement,
  kind: SceneComponentKind,
  t: Pick<PropertyTargets, "text" | "image">,
  ds?: SceneDesignSystem,
): Map<string, PropItem> {
  const out = new Map<string, PropItem>();
  if (!t.text.length && !t.image.length) return out;
  const groups = repeatedItems(main, { list: LISTS.has(kind) });
  if (!groups.length) return out;
  const places = itemPlaces(main, groups);
  const byId = new Map<string, SceneElement>();
  const index = (el: SceneElement) => {
    byId.set(el.id, el);
    el.children?.forEach(index);
  };
  index(main);
  const lists = new Set<string>();
  groups.forEach((g, gi) => {
    const first = byId.get(g.items[0]!);
    if (!first) return;
    // (bare lines of one style outside a list: a paragraph's lines, a table's columns)
    const noun =
      first.type === "text" && !LISTS.has(kind)
        ? kind === "table"
          ? "Column"
          : "Line"
        : (ITEM_NOUN[classifyTree(first)] ?? "Item");
    const label = `${noun}s`;
    let name = camel(label);
    if (lists.has(name)) name = `${name}${gi + 1}`;
    lists.add(name);
    g.items.forEach((rootId, i) => {
      const root = byId.get(rootId);
      if (!root) return;
      const mine = (ids: string[]) =>
        ids.filter((id) => {
          const p = places.get(id);
          return p?.group === gi && p.root === rootId;
        });
      const text = mine(t.text),
        image = mine(t.image);
      if (!text.length && !image.length) return;
      const place = { list: g.parent, name, label, index: i, root: rootId, itemLabel: `${noun} ${i + 1}` };
      if (root.type === "text" && text.length === 1 && !image.length) {
        out.set(text[0]!, { ...place, field: "Label" });
        return;
      }
      // (an item's own inner repeats are its content: named flat within the item)
      for (const f of namesOf(
        root,
        classifyTree(root),
        { text, image, boolean: [], swap: [] },
        ds,
        [],
        false,
      ))
        out.set(f.target, { ...place, field: f.name });
    });
  });
  return out;
}

/** A property name with its item, when its layer lies in a list item (itemFields). */
export interface NamedProperty {
  name: string;
  type: "text" | "boolean" | "instance-swap" | "image";
  target: string;
  item?: PropItem;
}

/**
 * Names for a set's properties that say what each is: texts by their role (Title, Eyebrow, Subtitle, Description,
 * Label, Action, Date, Price), pictures (Image, Logo, Avatar), visibility toggles after what they show ("Show icon"),
 * swaps after the kind of what they swap ("Icon"). Copy and pictures inside alike sibling items (the cards of a grid)
 * are named per item ("Card 1 title", "Card 2 title"; a list's bare entries "Item 1", "Item 2"), never numbered
 * flat (`Title 2`). Unique per set (`taken`: names already used), in a stable order: texts by prominence, images,
 * the items' fields item by item, booleans, swaps.
 */
export function propertyNames(
  main: SceneElement,
  kind: SceneComponentKind,
  t: PropertyTargets,
  ds?: SceneDesignSystem,
  taken: string[] = [],
  fixed?: ReadonlyMap<string, string>,
): NamedProperty[] {
  return namesOf(main, kind, t, ds, taken, true, fixed);
}

/** Where a role is taken, the next role a text / picture reads as before anything is numbered. */
const ALTERNATES: Record<string, readonly string[]> = {
  Title: ["Heading", "Subtitle", "Text", "Caption", "Note"],
  Eyebrow: ["Kicker", "Caption"],
  Subtitle: ["Text", "Caption", "Note", "Detail"],
  Description: ["Text", "Caption", "Note", "Detail"],
  Text: ["Caption", "Note", "Detail", "Footnote"],
  Label: ["Hint", "Caption", "Text", "Note"],
  Value: ["Change", "Caption", "Text"],
  Quote: ["Text", "Caption"],
  Date: ["Time", "Caption"],
  Price: ["Caption", "Note"],
  Action: ["Link", "Secondary action"],
  Image: ["Picture", "Media"],
  Logo: ["Brand mark", "Picture"],
  Avatar: ["Picture"],
};

/**
 * propertyNames; `fixed`: texts already named (a set's existing properties: target → name) — they take part in
 * telling the roles apart (the title is the title whether it is a property or a slot) but are not named again.
 */
function namesOf(
  main: SceneElement,
  kind: SceneComponentKind,
  t: PropertyTargets,
  ds: SceneDesignSystem | undefined,
  taken: string[],
  withItems: boolean,
  fixed?: ReadonlyMap<string, string>,
): NamedProperty[] {
  const byId = new Map<string, SceneElement>();
  const parent = new Map<string, SceneElement>();
  const order: string[] = [];
  const index = (el: SceneElement) => {
    byId.set(el.id, el);
    order.push(el.id);
    el.children?.forEach((c) => {
      parent.set(c.id, el);
      index(c);
    });
  };
  index(main);
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (const n of fixed?.values() ?? []) used.add(n.toLowerCase());
  const unique = (base: string) => {
    let n = base;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base} ${i}`;
    used.add(n.toLowerCase());
    return n;
  };
  // a role that is taken reads as the next free one (a second title is a heading, a second label a hint); a number last
  const role = (base: string) => {
    const free = [base, ...(ALTERNATES[base] ?? [])].find((n) => !used.has(n.toLowerCase()));
    return unique(free ?? base);
  };
  const out: NamedProperty[] = [];
  const roleOf = new Map<string, string>();
  const fixedText = [...(fixed?.keys() ?? [])].filter(
    (id) => byId.has(id) && !t.text.includes(id) && byId.get(id)!.type === "text",
  );
  for (const id of fixedText) roleOf.set(id, fixed!.get(id)!);
  // copy and pictures of list items: named per item, after the set's own
  const items = withItems ? itemFields(main, kind, t, ds) : new Map<string, PropItem>();

  // texts: by font size (then reading order); the biggest is the title, a short one above it the eyebrow
  const size = (el: SceneElement) => el.style?.fontSize ?? 16;
  const texts = [...t.text, ...fixedText]
    .filter((id) => byId.has(id) && !items.has(id))
    .sort((a, b) => size(byId.get(b)!) - size(byId.get(a)!) || order.indexOf(a) - order.indexOf(b));
  const inControl = (id: string) => {
    for (let p = parent.get(id); p && p !== main; p = parent.get(p.id))
      if (
        p.type === "button" ||
        p.meta?.tag === "button" ||
        (p.meta?.tag === "a" && (p.children?.length ?? 0) <= 3)
      )
        return true;
    return false;
  };
  const title = texts.find(
    (id) => !inControl(id) && !isDate(byId.get(id)!.text) && !isPrice(byId.get(id)!.text),
  );
  // a list's texts are its items (a heading above them, when it is bigger): Title, Item 1, Item 2…
  if (LISTS.has(kind) && texts.length >= 2) {
    const inOrder = [...texts].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const head =
      size(byId.get(inOrder[0]!)!) > Math.max(...inOrder.slice(1).map((id) => size(byId.get(id)!)))
        ? inOrder[0]!
        : null;
    let n = 0;
    for (const id of inOrder) if (!roleOf.has(id)) roleOf.set(id, id === head ? "Title" : `Item ${++n}`);
  }
  for (const id of texts) {
    if (roleOf.has(id)) continue;
    const el = byId.get(id)!;
    const text = (el.text ?? "").trim();
    let role: string;
    if (LABELLED.has(kind) && (texts.length === 1 || id === texts[0])) role = "Label";
    else if (isDate(text) || parent.get(id)?.meta?.tag === "time" || el.meta?.tag === "time") role = "Date";
    else if (isPrice(text)) role = "Price";
    else if (inControl(id) || el.type === "button") role = "Action";
    else if (id === title)
      role =
        kind === "list-item" || kind === "link"
          ? "Label"
          : kind === "quote"
            ? "Quote"
            : kind === "stat"
              ? "Value"
              : "Title";
    else if (
      title &&
      order.indexOf(id) < order.indexOf(title) &&
      size(el) < size(byId.get(title)!) &&
      text.length <= 32 &&
      (el.style?.uppercase || el.style?.textTransform === "uppercase" || text.split(/\s+/).length <= 4)
    )
      role = "Eyebrow";
    else if (text.length > 60) role = "Description";
    else role = [...roleOf.values()].includes("Subtitle") ? "Text" : "Subtitle";
    roleOf.set(id, role);
  }
  // in reading order of prominence: Eyebrow, Title, Subtitle, Description…, then the rest
  const rank = [
    "Eyebrow",
    "Title",
    "Label",
    "Item",
    "Subtitle",
    "Description",
    "Value",
    "Quote",
    "Date",
    "Price",
    "Text",
    "Action",
  ];
  const rankOf = (id: string) => rank.indexOf(roleOf.get(id)!.replace(/ \d+$/, ""));
  for (const id of [...texts].sort((a, b) => rankOf(a) - rankOf(b) || order.indexOf(a) - order.indexOf(b))) {
    if (fixed?.has(id) && !t.text.includes(id)) continue;
    const r = roleOf.get(id)!;
    out.push({ name: /^Item \d+$/.test(r) ? unique(r) : role(r), type: "text", target: id });
  }

  const area = (el: SceneElement) =>
    (typeof el.layout?.width === "number" ? el.layout.width : 0) *
    (typeof el.layout?.height === "number" ? el.layout.height : 0);
  for (const id of t.image
    .filter((x) => byId.has(x) && !items.has(x))
    .sort((a, b) => area(byId.get(b)!) - area(byId.get(a)!))) {
    const el = byId.get(id)!;
    const base =
      kind === "avatar" ? "Avatar" : kind === "logo" || /logo/i.test(el.name ?? "") ? "Logo" : "Image";
    roleOf.set(id, base);
    out.push({ name: role(base), type: "image", target: id });
  }
  // the items' fields, item by item: "Card 1 title", "Card 1 image", "Card 2 title"… (a bare entry: "Item 1")
  for (const [id, it] of items) {
    if (!byId.has(id)) continue;
    roleOf.set(id, it.field);
    const base =
      it.field === "Label" && byId.get(it.root)?.type === "text"
        ? it.itemLabel
        : `${it.itemLabel} ${it.field.charAt(0).toLowerCase()}${it.field.slice(1)}`;
    out.push({
      name: unique(base),
      type: t.image.includes(id) && !t.text.includes(id) ? "image" : "text",
      target: id,
      item: it,
    });
  }
  const setKind = (el: SceneElement) =>
    el.instance && ds ? ds.componentSets?.find((d) => d.id === el.instance!.componentId)?.kind : undefined;
  const what = (el: SceneElement): string => {
    const k = setKind(el);
    if (k) return KIND_LABELS[k];
    if (roleOf.has(el.id)) return roleOf.get(el.id)!;
    if (el.type === "icon" || el.type === "vector" || el.svg) return "Icon";
    if (el.type === "image" || el.type === "video" || el.image) return "Image";
    if (el.type === "button") return "Button";
    if (el.type === "badge") return "Badge";
    if (el.type === "text") return "Text";
    const own = (el.name ?? "").split("·")[0]!.trim();
    return own && own.length <= 20 && !/^(frame|group|div|span|container|wrapper|box|inner)\b/i.test(own)
      ? own
      : "Content";
  };
  for (const id of t.boolean.filter((x) => byId.has(x)))
    out.push({ name: unique(`Show ${what(byId.get(id)!).toLowerCase()}`), type: "boolean", target: id });
  for (const id of t.swap.filter((x) => byId.has(x)))
    out.push({ name: unique(what(byId.get(id)!)), type: "instance-swap", target: id });
  return out;
}

const isDate = (t: string | undefined) =>
  !!t &&
  /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\.\s*\p{L}+\s+\d{4}|\p{L}+\s+\d{1,2},\s*\d{4})$/u.test(t.trim());
const isPrice = (t: string | undefined) =>
  !!t &&
  /^(ab\s+|from\s+)?[€$£]?\s?\d[\d.,]*\s?(€|\$|£|eur|usd)?(\s*\/.*)?$/i.test(t.trim()) &&
  /[€$£]|eur|usd/i.test(t);

function kindOfTarget(
  def: SceneComponentDef,
  target: string,
  ds: SceneDesignSystem,
): SceneComponentKind | undefined {
  const main = def.variants[def.defaultVariant];
  let hit: SceneElement | undefined;
  const walk = (el: SceneElement) => {
    if (el.id === target) hit = el;
    else el.children?.forEach(walk);
  };
  if (main) walk(main);
  const id = hit?.instance?.componentId;
  return id ? ds.componentSets?.find((d) => d.id === id)?.kind : undefined;
}

/** Where the copies of a set sat (extract.ts fills it while it makes the set; every field is optional). */
export interface ClassifyContext {
  /** the copies start in the top band of their page / end in its bottom band */
  atTop?: boolean;
  atBottom?: boolean;
  /** share of the page width the copies take (0..1) */
  widthShare?: number;
  /** the copies are whole sections of their page (the stacked full-width blocks: header, hero, content, footer) */
  section?: boolean;
  /** a section's place on its page (0 = first) and how many sections the page has */
  sectionIndex?: number;
  sectionCount?: number;
  /** kind of the page section the copies sit in (a link in the footer, a logo in the header) */
  within?: SceneComponentKind;
  /** the copies come from an overlay screen (a menu opened over the page) */
  overlay?: boolean;
  /** the copies' size on their page (px) and the page's viewport height */
  size?: { w: number; h: number };
  viewportHeight?: number;
}

/** What a tree is made of (the classifier's evidence). */
interface Features {
  nodes: number;
  texts: { el: SceneElement; text: string; size: number; weight: number }[];
  chars: number;
  images: number;
  /** biggest image / video box (px²) */
  mediaArea: number;
  videos: number;
  icons: number;
  controls: number;
  links: number;
  inputs: string[];
  tags: Set<string>;
  states: boolean;
  scroll: boolean;
  slideControls: number;
  chevron: boolean;
  hidden: number;
  maxFont: number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isIcon = (el: SceneElement) =>
  el.type === "icon" || el.type === "vector" || (!!el.svg && el.type !== "image");
const isMedia = (el: SceneElement) =>
  el.type === "image" || el.type === "video" || (!!el.image?.src && el.type !== "icon");
const isVideo = (el: SceneElement) => el.type === "video" || el.meta?.video === true;
const isLink = (el: SceneElement) =>
  el.meta?.tag === "a" || el.interaction?.onTap === "navigate" || el.interaction?.onTap === "open-url";
const CHEVRON = /chevron|caret|arrow[ _-]?(down|up)|expand|collapse|plus|minus|accordion/i;

function features(root: SceneElement, rootW = 0): Features {
  const f: Features = {
    nodes: 0,
    texts: [],
    chars: 0,
    images: 0,
    mediaArea: 0,
    videos: 0,
    icons: 0,
    controls: 0,
    links: 0,
    inputs: [],
    tags: new Set(),
    states: false,
    scroll: false,
    slideControls: 0,
    chevron: false,
    hidden: 0,
    maxFont: 0,
  };
  const walk = (el: SceneElement) => {
    f.nodes++;
    if (el.meta?.hidden) f.hidden++;
    const tag = el.meta?.tag;
    if (typeof tag === "string") f.tags.add(tag);
    if (el.states) f.states = true;
    if (el.layout?.scroll === "horizontal") f.scroll = true;
    if (
      el.interaction?.onTap === "scroll-by" ||
      /go to slide|slide \d|next slide|previous slide/i.test(el.name ?? "")
    )
      f.slideControls++;
    if (
      CHEVRON.test(`${el.icon ?? ""} ${el.meta?.glyph ?? ""} ${el.name ?? ""}`) &&
      (isIcon(el) || el.type === "button")
    )
      f.chevron = true;
    if (el.type === "text" || (el.text?.trim() && ["button", "badge"].includes(el.type))) {
      const text = (el.text ?? "").trim();
      if (text) {
        const size = el.style?.fontSize ?? 16;
        f.texts.push({ el, text, size, weight: el.style?.fontWeight ?? 400 });
        f.chars += text.length;
        f.maxFont = Math.max(f.maxFont, size);
      }
    }
    if (isMedia(el)) {
      f.images++;
      if (isVideo(el)) f.videos++;
      f.mediaArea = Math.max(
        f.mediaArea,
        (num(el.layout?.width) ?? (el.layout?.width === "fill" ? rootW : 0)) * (num(el.layout?.height) ?? 0),
      );
    } else if (isIcon(el)) f.icons++;
    if (el.meta?.role === "input" || el.type === "input")
      f.inputs.push(String(el.meta?.inputType ?? el.variant ?? "text"));
    if (el.type === "button" || tag === "button") f.controls++;
    if (isLink(el)) f.links++;
    el.children?.forEach(walk);
  };
  walk(root);
  return f;
}

const hasFill = (el: SceneElement) => {
  const s = el.style ?? {};
  const bg = s.background && !/^(transparent|none|rgba\([^)]*,\s*0\))$/i.test(s.background.trim());
  return !!(
    bg ||
    s.gradient ||
    s.fills?.length ||
    (s.border && s.border.width > 0) ||
    s.borders ||
    s.shadows?.length ||
    (s.shadow && s.shadow !== "none")
  );
};
const radiusOf = (el: SceneElement) => {
  const r = el.style?.radius;
  return typeof r === "number" ? r : Array.isArray(r) ? Math.max(...r) : 0;
};
/** The layer's own word for what it is (before the "·"): "Bds Tag", "Highlight Teaser", "Button". */
const ownName = (el: SceneElement) => (el.name ?? "").split("·")[0]!.trim().toLowerCase();

/**
 * Category and kind of a set: its own when set, else guessed from its structure and name (header / footer / hero,
 * cards, form controls…). `context` tells where its copies sat (top / bottom of a page, share of the page width).
 */
export function classifyComponent(
  def: SceneComponentDef,
  _ds: SceneDesignSystem,
  context: ClassifyContext = {},
): { category: SceneComponentCategory; kind: SceneComponentKind } {
  if (def.kind) return { kind: def.kind, category: def.category ?? KIND_CATEGORY[def.kind] };
  const main = def.variants[def.defaultVariant] ?? Object.values(def.variants)[0];
  const kind = main ? classifyTree(main, context, def.name) : "other";
  return { kind, category: def.category ?? KIND_CATEGORY[kind] };
}

/** A transit line / route code: letters and digits, at least one digit (U5, M10, S41, X9, 100, N1). */
const LINE_CODE = /^[A-Z]{0,3}\d{1,4}[A-Z]?$/;
const hasBorder = (el: SceneElement) => (el.style?.border?.width ?? 0) > 0;

/** The kind of a tree (a set's main, or a copy on a page), from its structure, semantics (tags, roles) and context. */
export function classifyTree(
  root: SceneElement,
  ctx: ClassifyContext = {},
  name?: string,
): SceneComponentKind {
  const f = features(root, ctx.size?.w ?? num(root.layout?.width) ?? 0);
  const tag = typeof root.meta?.tag === "string" ? root.meta.tag : "";
  const own = `${ownName(root)} ${(name ?? "").toLowerCase()}`;
  const full = `${(root.name ?? "").toLowerCase()} ${(name ?? "").toLowerCase()}`;
  const w = ctx.size?.w ?? num(root.layout?.width) ?? 0;
  const h = ctx.size?.h ?? num(root.layout?.height) ?? 0;
  if (ctx.section) return sectionKind(root, f, ctx, tag, own, w, h);

  // form controls: DSL types, captured inputs, semantic tags
  if (root.meta?.role === "input" || root.type === "input") {
    const t = String(root.meta?.inputType ?? "");
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "button" || t === "submit" || t === "reset") return "button";
    if (t === "search" || root.variant === "search" || /search|such/.test(full)) return "search";
    if (tag === "select" || t === "select" || t === "select-one") return "select";
    if (tag === "textarea" || t === "textarea") return "textarea";
    return "input";
  }
  const byType: Partial<Record<SceneElement["type"], SceneComponentKind>> = {
    toggle: "toggle",
    checkbox: "checkbox",
    slider: "progress",
    progress: "progress",
    badge: "badge",
    avatar: "avatar",
    divider: "divider",
    video: "video",
    navbar: "navigation",
    tabbar: "navigation",
    list: "list",
    card: "card",
  };
  if (byType[root.type]) return byType[root.type]!;
  const byTag: Record<string, SceneComponentKind> = {
    select: "select",
    textarea: "textarea",
    table: "table",
    blockquote: "quote",
    hr: "divider",
    details: "accordion",
    form: "form",
    video: "video",
  };
  if (byTag[tag]) return byTag[tag]!;
  if (tag === "nav") return /breadcrumb/.test(full) ? "breadcrumb" : "navigation";
  // inputs inside: a search field with its button, a form
  if (f.inputs.length)
    return f.inputs.some((t) => t === "search") || /search|such/.test(own)
      ? "search"
      : f.inputs.length >= 2 || tag === "form"
        ? "form"
        : "input";

  // what the layer calls itself
  if (/logo|brand/.test(full) && !f.texts.length) return "logo";
  if (/breadcrumb/.test(own)) return "breadcrumb";
  if (/pagination|pager|bullets|dots/.test(own)) return "pagination";
  if (/\btabs?\b|tablist|tab ?bar/.test(own) || root.meta?.role === "tablist") return "tabs";
  if (/accordion|faq|collaps|expander/.test(own)) return "accordion";
  if (/carousel|slider|swiper|splide|slick|scroll wrapper|horizontal scroll/.test(own)) return "carousel";
  if (/modal|dialog|lightbox/.test(own)) return "modal";
  // a popover with links / buttons in it (a dropdown of a main navigation) is a menu; a tooltip holds a few words
  if (/tooltip|popover|nudge|flyout|dropdown/.test(own) && f.texts.length)
    return f.links + f.controls >= 3 || w > 320 || h > 200 || /flyout|dropdown/.test(own)
      ? "menu"
      : "tooltip";
  if (/toast|snackbar/.test(own)) return "toast";
  if (/\balert\b|notice|announcement|hinweis|warning/.test(own)) return "alert";
  if (/quote|testimonial|zitat/.test(own)) return "quote";
  if (/badge|label tag/.test(own) && f.chars <= 30) return "badge";
  if (/\btag\b|chip|pill/.test(own) && f.chars <= 40) return "tag";
  if (/teaser/.test(own) && f.texts.length) return "teaser";
  if (/\bcard\b|tile|kachel/.test(own) && f.texts.length) return "card";
  if (/avatar/.test(own)) return "avatar";
  if (/breadcrumb/.test(full)) return "breadcrumb";

  // carousels, accordions: by behaviour
  if (f.scroll && f.nodes >= 6) return "carousel";
  if (f.slideControls >= 2 && f.nodes > f.slideControls * 2) return "carousel";
  if (f.slideControls >= 2) return "pagination";
  if ((f.states || f.hidden > 0) && f.chevron && f.texts.length) return "accordion";

  // single media / icons
  const onlyIcons = f.icons > 0 && !f.texts.length && !f.images;
  const onlyMedia = f.images > 0 && !f.texts.length && f.icons === 0;
  if (onlyIcons || (onlyMedia && f.images === 1)) {
    const small = (w && w <= 160 && h <= 80) || (!w && f.nodes <= 2);
    if (
      (ctx.within === "header" ||
        ctx.within === "footer" ||
        ctx.within === "menu" ||
        ctx.within === "navigation") &&
      /logo|home|startseite|brand/.test(full)
    )
      return "logo";
    if (ctx.within === "header" && (isLink(root) || f.links) && onlyMedia && small) return "logo";
    if (onlyMedia) {
      if (f.videos) return "video";
      if (w && w <= 96 && radiusOf(root) >= Math.min(w, h) / 2 - 1) return "avatar";
      if (f.controls || f.links) return onlyIcons ? "icon-button" : "image";
      return "image";
    }
    if (root.type === "button" || tag === "button" || isLink(root) || f.controls)
      return f.icons <= 2 && (!w || w <= 72) ? "icon-button" : "list";
    if (f.icons === 1 || (w && w <= 64 && h <= 64)) return "icon";
    return "list";
  }
  if (f.images > 1 && !f.texts.length) return f.images >= 3 ? "list" : "image";

  // a row of buttons (a stage's calls to action): a group of controls, not a control
  const kids = root.children ?? [];
  if (
    kids.length >= 2 &&
    root.type !== "button" &&
    tag !== "button" &&
    tag !== "a" &&
    kids.every((c) => c.type === "button" || c.meta?.tag === "button" || !!c.instance)
  )
    return "other";
  const short = f.chars > 0 && f.chars <= 40 && f.texts.length <= 2;
  const controlLike =
    root.type === "button" ||
    tag === "button" ||
    (tag === "a" && hasFill(root)) ||
    (root.meta?.display === "inline-flex" && tag === "a");
  // buttons / links / tags: short text, small
  if (short && f.nodes <= 5 && !f.images && (!h || h <= 80)) {
    // a line / route code on a small plate (U5, M10, S41, X9): a badge that may link, not an action
    if (
      f.texts.length === 1 &&
      LINE_CODE.test(f.texts[0]!.text.trim()) &&
      (hasFill(root) || hasBorder(root)) &&
      (!h || h <= 40) &&
      (!w || w <= 96)
    )
      return "badge";
    if (controlLike && (hasFill(root) || tag === "button" || root.type === "button")) {
      if (!hasFill(root) && isLink(root) && root.type !== "button") return "link";
      if (h && h <= 32 && radiusOf(root) >= h / 2 - 1 && f.chars <= 24 && !isLink(root) && tag !== "button")
        return "tag";
      return "button";
    }
    if (hasFill(root) && h && h <= 36 && f.chars <= 24) return isLink(root) || f.links ? "tag" : "badge";
    if (isLink(root) || f.links) return "link";
  }
  // list rows: an icon or a small picture next to text
  if (
    tag === "li" ||
    (root.layout?.direction === "row" &&
      (f.icons || f.images) &&
      f.texts.length &&
      f.texts.length <= 3 &&
      (!h || h <= 120) &&
      f.mediaArea <= 96 * 96)
  ) {
    if (f.images && f.mediaArea > 96 * 96 && f.texts.length) return "card";
    if (tag === "li" && !f.icons && !f.images && f.texts.length === 1 && (isLink(root) || f.links))
      return "link";
    return "list-item";
  }
  if (["ul", "ol", "menu", "dl"].includes(tag))
    return ctx.within === "header" || ctx.within === "menu" ? "navigation" : "list";
  // stats, quotes
  const big = f.texts.find((t) => t.size >= 28);
  if (big && /^[\d.,+%€$£ ]{1,10}[a-z%+]{0,4}$/i.test(big.text) && f.texts.length <= 3) return "stat";
  if (f.texts.some((t) => /^[„“"«‚‘»]/.test(t.text) && t.text.length > 30)) return "quote";
  // cards and teasers: media with copy, or a filled block of copy
  if (f.images && f.texts.length)
    return hasFill(root) && !isLink(root)
      ? "card"
      : isLink(root) || f.links || tag === "article"
        ? "teaser"
        : "card";
  if (tag === "article") return "card";
  if (f.texts.length >= 2 && hasFill(root) && radiusOf(root) > 0) return "card";
  if (f.texts.length >= 2 && (isLink(root) || tag === "a") && f.nodes <= 12) return "teaser";
  if (f.texts.length && !f.icons && !f.images && !f.controls && !f.links) return "text";
  if (f.texts.length && f.icons && f.texts.length <= 2 && f.nodes <= 6)
    return isLink(root) || f.links ? "link" : "list-item";
  if (f.controls >= 2 && f.texts.length >= 2 && f.nodes <= 4 * f.controls + 2)
    return ctx.within === "header" || ctx.within === "footer" ? "navigation" : "list";
  if (f.links >= 3)
    return ctx.within === "footer" || ctx.within === "header" || ctx.within === "menu"
      ? "navigation"
      : "list";
  if (!f.texts.length && !f.images && !f.icons && f.nodes === 1 && (h <= 2 || w <= 2)) return "divider";
  return "other";
}

function sectionKind(
  _root: SceneElement,
  f: Features,
  ctx: ClassifyContext,
  tag: string,
  own: string,
  w: number,
  h: number,
): SceneComponentKind {
  if (ctx.overlay) return "menu";
  const first = (ctx.sectionIndex ?? 1) === 0;
  const last = ctx.sectionCount !== undefined && ctx.sectionIndex === ctx.sectionCount - 1;
  const vh = ctx.viewportHeight ?? 900;
  const tags = f.tags;
  if (tag === "footer" || /footer/.test(own) || (tags.has("footer") && !tags.has("main"))) return "footer";
  if (
    (tag === "header" ||
      tag === "nav" ||
      /header|masthead|global ?nav|navigation|navbar|top ?bar/.test(own) ||
      ((tags.has("nav") || tags.has("header")) && h <= 200)) &&
    (ctx.atTop || first) &&
    h <= Math.max(220, vh * 0.3)
  )
    return "header";
  if (last && (ctx.atBottom ?? true) && f.links + f.controls >= 6 && f.maxFont <= 24) return "footer";
  // a big picture or film near the top with a heading: the stage / hero
  const area = Math.max(1, w * h);
  const bigMedia = f.mediaArea >= area * 0.3 || f.videos > 0 || (w > 0 && f.mediaArea >= w * w * 0.25);
  if (
    (ctx.sectionIndex ?? 9) <= 2 &&
    (ctx.atTop ?? true) &&
    bigMedia &&
    (f.maxFont >= 24 || h >= vh * 0.45 || /stage|hero|keyvisual|key visual|banner/.test(own))
  )
    return "hero";
  if (/stage|hero|keyvisual|key visual/.test(own) && (ctx.sectionIndex ?? 9) <= 2) return "hero";
  if (tag === "nav" && !(ctx.atTop || first)) return "navigation";
  return "section";
}

/** Sets grouped by category (in CATEGORY_ORDER), each group sorted by kind then name — the component library's index. */
export function catalogOf(
  ds: SceneDesignSystem,
): Array<{ category: SceneComponentCategory; label: string; sets: SceneComponentDef[] }> {
  const sets = (ds.componentSets ?? []).map((d) => ({ d, c: classifyComponent(d, ds) }));
  const kindRank = (k: SceneComponentKind) => {
    const i = ESSENTIAL_KINDS.indexOf(k);
    return i < 0 ? 999 : i;
  };
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    sets: sets
      .filter((x) => x.c.category === category)
      .sort((a, b) => kindRank(a.c.kind) - kindRank(b.c.kind) || a.d.name.localeCompare(b.d.name))
      .map((x) => x.d),
  })).filter((g) => g.sets.length);
}
