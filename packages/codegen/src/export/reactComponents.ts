// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Shared components of the React export: a subtree that repeats (same markup; its copy, images, links, taps and own
// position may differ) becomes one component in src/components with typed props, used by the screens and by each
// other. Copies whose classes differ further down (the same card at each breakpoint of a responsive page) are one
// component with a `variant` prop and a class table. Runs of one component's instances on a screen become a typed
// data array + `.map()`. Lossless by construction: an instance renders exactly the markup the subtree would (react.ts
// JsxHooks).
// With the design system (DsInput), instances of its component sets (IrElement.instance) are those sets' components
// instead: named as in the design-system package (export/ds/names.ts), the set's API (catalog.ts componentApi) as
// typed props, a `variant` prop for its looks per breakpoint, nested instances as nested components, swapped ones
// as ReactNode props. Same guarantee: an instance a component cannot draw exactly stays inline markup (dsReport).
import type { SceneComponentDef, SceneDesignSystem, SceneInteraction } from "@harness/protocol";
import { componentApi } from "@harness/extract";
import type { IrElement, IrNode, StyleMap } from "./ir.js";
import {
  emitJsx,
  jsString,
  jsxAttrValue,
  styleProp,
  type JsxHooks,
  type ReactEmitOptions,
  type SlotName,
} from "./react.js";
import { splitTailwind } from "./tailwind.js";
import { withoutOwnIds } from "./icons.js";
import { createNamer, pascalCase, slugify } from "@harness/scene";
import { asciiCamel, safePropName, specNamer } from "./ds/names.js";
import { meaningfulLayerName } from "@harness/scene";

/** Attributes whose values may differ between instances (props); every other attribute is part of the markup. */
const SLOT_ATTRS: Record<string, (tag: string) => boolean> = {
  src: (t) => t === "img" || t === "source" || t === "video",
  srcset: (t) => t === "img" || t === "source",
  alt: (t) => t === "img",
  poster: (t) => t === "video",
  href: (t) => t === "a",
  "aria-label": () => true,
  title: () => true,
};
/** Taps an instance's caller wires up (`onClick` props); overlay taps drive the screen's own state: never inside a component. */
const PROP_TAPS = new Set(["navigate", "back", "open-url"]);
const OVERLAY_TAPS = new Set(["open-overlay", "swap-overlay", "close-overlay"]);
/** Taps a design-system component handles itself when every instance does the same (a link out) */
const OWN_TAPS = new Set(["open-url"]);
/** Variant names: the project's breakpoints, smallest first (a look is named after the smallest one it shows at). */
const VARIANT_NAMES: Record<number, string[]> = {
  2: ["sm", "lg"],
  3: ["sm", "md", "lg"],
  4: ["sm", "md", "lg", "xl"],
  5: ["xs", "sm", "md", "lg", "xl"],
  6: ["xs", "sm", "md", "lg", "xl", "2xl"],
};
/** more breakpoints than the table names: xs, sm, md, lg, xl, 2xl, 3xl… (smallest first) */
const moreVariantNames = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => ["xs", "sm", "md", "lg", "xl"][i] ?? `${i - 3}xl`);

type Slot =
  /** `expanded`: whether the menu an opener (a design-system component's menu button) opens is open; `node`: a swapped
   *  nested instance (instance-swap property) the caller renders */
  | { kind: "text" | "tap" | "expanded" | "node"; at: number[] }
  | { kind: "attr"; at: number[]; attr: string }
  | { kind: "class" | "style"; at: [] }
  /** the look an instance shows; `axis`: one axis of a set with several (its value in the look's name) */
  | { kind: "variant"; at: []; axis?: number }
  /** a prop of a nested instance (`at` = that instance) the outer component passes through */
  | { kind: "inst"; at: number[]; inner: Prop; comp: SharedComponent }
  /** a run of alike items below `at` (links, cards): one array prop, an object per item */
  | { kind: "list"; at: number[]; run: Run }
  /** a picture's crop (CSS object-position): the picture's, like its source */
  | { kind: "crop"; at: number[] }
  /** an instance in a menu (a component drawn otherwise there than on the page): `inMenu` */
  | { kind: "context"; at: [] };
type Row = Record<string, string | IrElement | undefined>;
type Val = string | StyleMap | SceneInteraction | IrElement | Row[] | undefined;
type PropType =
  "string" | "handler" | "className" | "style" | "variant" | "node" | "expanded" | "list" | "flag";

/**
 * Siblings in a component that are the same markup with other copy (the links of a footer column, the cards of a
 * row): written once in a `.map()` over their data — a typed array prop when the component's instances show other
 * items, else a constant array in its module.
 */
interface Run {
  /** the items' parent (path from the component's root), the first item's index, the number of items */
  parent: number[];
  from: number;
  count: number;
  /** the array (prop or module constant), one item's variable, the item type */
  name: string;
  itemVar: string;
  itemType: string;
  /** what differs between the items: slots relative to an item's root (`tap`: a link out, its address is the data) */
  fields: Array<{ name: string; rel: Slot; tsType: string; tap?: boolean; cls?: string[] }>;
  /** the component's instances show other items: a prop */
  varying: boolean;
  /** the items are instances of this component (else markup) */
  comp: SharedComponent | null;
  /** the field that keys the items (unique in every list), else the index */
  key: string | null;
}

interface Prop {
  name: string;
  type: PropType;
  slot: Slot;
  doc: string;
  /** a string some instances leave empty (`alt=""`): optional, defaulting to '' */
  emptyDefault?: boolean;
  /** a prop of the design-system set's API (always a prop, named as in the design-system package) */
  api?: boolean;
  /** `expanded`: only some instances open a menu there (the others draw that layer as it is) */
  sometimes?: boolean;
}

export interface SharedComponent {
  name: string;
  /** every place it is used, in document order; the first one is the template */
  occurrences: IrElement[];
  size: number;
  /** `variant` prop first, then the template's varying parts in markup order */
  props: Prop[];
  /** looks: the variant names, each with its first occurrence (one entry: no variants) */
  variants: Array<{ name: string; template: IrElement }>;
  variantOf: Map<IrElement, string>;
  /** root classes every instance shares; per variant, the ones all of that variant's share on top */
  common: string[];
  variantCommon: Map<string, string[]>;
  /** slots that always hold the same value as a prop's (`aria-label` = `alt`): bound to that prop */
  aliases: Prop[];
  /** nested instances' classes that follow this component's look (its class table, not a prop) */
  byVariant: Slot[];
  /** the design-system component this is one shape of (the instances of a set whose markup has this structure) */
  ds?: DsComponent;
  /** runs of alike items written as a `.map()` */
  runs?: Run[];
  /**
   * looks that are only the layout at successive breakpoints (same markup, other classes): no `variant` prop, each
   * look's classes under the media range it shows at (look name → `min-[768px]:max-[1023.98px]:`)
   */
  responsive?: Map<string, string>;
  /** its looks in menus (`menu-…`) are drawn otherwise than on the page: an `inMenu` prop picks the menu's */
  menuLooks?: boolean;
}

/** Input of the design-system components: the sets the trees' instances (IrElement.instance) belong to. */
export interface DsInput {
  designSystem: Pick<SceneDesignSystem, "name" | "componentSets"> & Partial<SceneDesignSystem>;
  /** the overlays (menus) a tree's page opens: openers / close buttons inside a component become its props */
  overlayIds?: (tree: IrElement) => ReadonlySet<string>;
  /** identifiers components must not take (the pages' components) */
  reserved?: Iterable<string>;
  /** a tree is a menu overlay (its instances' looks are told apart from the page's: `menu-lg`) */
  isOverlay?: (tree: IrElement) => boolean;
}

/** A design-system set's component: one module, a shape per markup structure (the `variant` prop picks it). */
export interface DsComponent {
  name: string;
  def: SceneComponentDef;
  /** the prop that picks a look: the set's one variant axis other than the breakpoint (`tone`, `size`), else `variant` */
  look: string;
  /** its type's name (`TagTone`, `HeaderVariant`) */
  lookType: string;
  /** a set with several axes (tone and breakpoint): a prop per axis, `look` joins them (`lime_sm`) */
  axisProps?: Array<{ prop: string; type: string }>;
  shapes: SharedComponent[];
  /** the set's API props that bind to a layer: text / image / link of a main layer, an instance swap */
  api: DsApiProp[];
}
interface DsApiProp {
  name: string;
  label: string;
  field: "text" | "image" | "href" | "swap";
  target: string;
  /** a content slot of the main (not one of the set's properties): a prop only where the instances differ in it */
  slot?: boolean;
}

/** How the design-system instances came out: as their set's component, or inline markup (and why). */
export interface DsReport {
  /** design-system components written (src/components) */
  components: number;
  /** instances drawn by their set's component */
  instances: number;
  /** instances written as inline markup instead */
  inline: Array<{ set: string; reason: string }>;
}

export interface ComponentFile {
  path: string;
  source: string;
  css?: string;
}

/** A component module's data: list constants, the nested components whose Props type it imports, its runs' item types. */
interface ModuleLists {
  decls: string[];
  namer: (base: string) => string;
  types: Set<string>;
  runs: Run[];
}

export interface SharedComponents {
  components: SharedComponent[];
  /** the component a subtree is an instance of */
  instanceOf: Map<IrElement, SharedComponent>;
  /** hooks for a screen's JSX; `decls` collects the module-level data of its lists, `uses` the components it imports */
  screenHooks(o: ReactEmitOptions, imp: { decls: string[]; uses: Set<SharedComponent> }): JsxHooks;
  /** src/components/<Name>.tsx (+ .css for pseudo elements Tailwind cannot express) */
  files(o: ReactEmitOptions): ComponentFile[];
  /** the `cn` helper is needed (src/lib/cn.ts) */
  usesCn(): boolean;
  /** design-system components (one per set used), empty without DsInput */
  dsComponents: DsComponent[];
  dsReport(): DsReport;
}

interface NodeInfo {
  /** structure: tags, attributes, pseudo elements, inline styles below the root — classes and slot values left out */
  loose: string | null;
  /** `loose` + the classes below the root: copies with the same one are the same look */
  strict: string | null;
  size: number;
  parent: IrElement | null;
  index: number;
  tree: IrElement;
}

/* ------------------------------------------------------------------ detection */

/** A button or link with a label: worth a component on its own. */
const isControl = (n: IrElement) =>
  (n.tag === "button" || n.tag === "a") && n.children.some((c) => c.kind === "text" && c.text.trim() !== "");

/**
 * Find the shared components of a set of trees (every variant and overlay of every screen; `rank` orders a component's
 * looks: a responsive variant's min width). A subtree qualifies when at least two copies of it end up in different
 * places of the output — copies at the same spot of another component's template are one (they are written once) —
 * and it is big enough to be worth a name: two elements, an inline SVG, a labelled button or link.
 */
export function sharedComponents(
  trees: IrElement[],
  o: ReactEmitOptions,
  rank: (tree: IrElement) => number = () => 0,
  ds?: DsInput,
): SharedComponents {
  const info = new Map<IrElement, NodeInfo>();
  // design-system instances: the set of an instance root, nested instances a set's instance-swap property swaps, the
  // overlay taps inside an instance that open / close a menu of its page (props of the component then)
  const sets = new Map((ds?.designSystem.componentSets ?? []).map((d) => [d.id, d]));
  const setOf = (n: IrElement) => (n.instance ? sets.get(n.instance.componentId) : undefined);
  const swapped = new Set<IrElement>();
  const swapTargets = memo(
    (d: SceneComponentDef) =>
      new Set((d.properties ?? []).filter((p) => p.type === "instance-swap").map((p) => p.target)),
  );
  const overlayTap = (n: IrElement, tree: IrElement): "open" | "close" | null => {
    const i = n.interaction;
    if (!i?.onTap || !OVERLAY_TAPS.has(i.onTap)) return null;
    const ids = ds?.overlayIds?.(tree);
    if (i.onTap === "close-overlay") return ids?.size ? "close" : null;
    return i.target && ids?.has(i.target) ? "open" : null;
  };
  const imageSrc = memo((src: string) => (o.imageSrc ? o.imageSrc(src) : src));
  // (a picture's crop is the picture's: not part of its look — a `crop` slot)
  const cropOf = (n: IrElement) => (n.tag === "img" ? (n.style["object-position"] ?? "") : "");
  const classesOf = memo((n: IrElement) => {
    if (n.tag !== "img" || n.style["object-position"] === undefined) return splitTailwind(n.style, o);
    const { "object-position": _crop, ...rest } = n.style;
    return splitTailwind(rest, o);
  });
  // keys nest their children's: interned to short ids so they stay small on pages with thousands of elements
  const interned = new Map<string, string>();
  const intern = (k: string) => {
    let id = interned.get(k);
    if (id === undefined) {
      id = `#${interned.size}`;
      interned.set(k, id);
    }
    return id;
  };

  type Keys = { loose: string | null; strict: string | null; size: number };
  /** `encl`: the nearest design-system instance root above (its id prefixes the ids of its layers) */
  const keyOf = (
    n: IrElement,
    parent: IrElement | null,
    index: number,
    tree: IrElement,
    encl: { id: string; def: SceneComponentDef } | null = null,
  ): Keys => {
    const def = setOf(n);
    const inDs = !!def || !!encl;
    // inside a design-system instance a menu's opener / close button is a prop of the component (react.ts `expanded`):
    // instances that open a menu there and ones that do not draw the same markup otherwise
    let poisoned =
      n.tag === "main" ||
      "data-page" in n.attrs ||
      (!inDs && n.interaction?.onTap !== undefined && OVERLAY_TAPS.has(n.interaction.onTap));
    if (n.tag === "img" && n.attrs.src !== undefined && imageSrc(n.attrs.src) === null) {
      info.set(n, { loose: null, strict: null, size: 0, parent, index, tree });
      return { loose: "X", strict: "X", size: 0 };
    }
    let size = 1;
    const loose: string[] = [],
      strict: string[] = [];
    const inner = def && n.id ? { id: n.id, def } : encl;
    n.children.forEach((c, i) => {
      if (c.kind === "text") {
        loose.push("T");
        strict.push("T");
        return;
      }
      const k = keyOf(c, n, i, tree, inner);
      if (k.loose === null) poisoned = true;
      size += k.size;
      // a swapped nested instance is the caller's (a ReactNode prop): any component fits there
      if (
        inner &&
        setOf(c) &&
        c.id?.startsWith(`${inner.id}__`) &&
        swapTargets(inner.def).has(c.id.slice(inner.id.length + 2))
      ) {
        swapped.add(c);
        loose.push("S");
        strict.push("S");
        return;
      }
      loose.push(k.loose ?? "");
      strict.push(k.strict ?? "");
    });
    let own: { loose: string; strict: string } | null = null;
    if (!poisoned) {
      // (an SVG with or without its namespace declaration draws the same)
      if (n.raw !== undefined) {
        const r = intern(`R${withoutOwnIds(n.raw).replace(/\s+xmlns(?::xlink)?="[^"]*"/g, "")}`);
        own = { loose: r, strict: r };
      } else {
        const attrs = Object.entries(n.attrs)
          .filter(([k]) => k !== "style" && k !== "class")
          .map(([k, v]) => (SLOT_ATTRS[k]?.(n.tag) && !n.svg ? `${k}=?` : `${k}=${v}`));
        // (inside a design-system instance a tap is a prop either way: an instance without one passes none)
        const base = [
          n.tag,
          n.svg ? 1 : 0,
          attrs,
          n.pseudo ?? null,
          !inDs && n.interaction?.onTap && PROP_TAPS.has(n.interaction.onTap) ? 1 : 0,
          ...(def ? [`ds:${def.id}`] : []),
        ];
        own = {
          loose: intern(JSON.stringify([...base, loose])),
          strict: intern(JSON.stringify([...base, strict])),
        };
      }
    }
    info.set(n, { loose: own?.loose ?? null, strict: own?.strict ?? null, size, parent, index, tree });
    if (!own) return { loose: null, strict: null, size };
    if (n.raw !== undefined) return { ...own, size };
    const c = classesOf(n);
    return {
      loose: intern(`${own.loose}|${JSON.stringify(c.inline)}`),
      strict: intern(`${own.strict}|${JSON.stringify([c.classes, c.inline])}`),
      size,
    };
  };
  for (const t of trees) keyOf(t, null, -1, t);

  const groups = new Map<string, IrElement[]>();
  const dsRoots: IrElement[] = [];
  // inside a design-system instance only its nested instances are components (its API binds to its own layers)
  const inDs = memo((n: IrElement): boolean => {
    const p = info.get(n)?.parent;
    return !!p && (!!setOf(p) || inDs(p));
  });
  // …and what holds one is the page's layout around it: the page reads as a composition of the set's components
  const holdsDs = new Set<IrElement>();
  if (ds)
    for (const [n] of info)
      if (setOf(n))
        for (let p = info.get(n)!.parent; p && !holdsDs.has(p); p = info.get(p)!.parent) holdsDs.add(p);
  for (const [n, i] of info) {
    // a design-system instance is its set's component (or inline): never one found by its markup
    if (setOf(n)) {
      dsRoots.push(n);
      continue;
    }
    if (ds && (inDs(n) || holdsDs.has(n))) continue;
    // a screen's root frame (the child of its <main>) is the screen, no component
    if (
      i.loose === null ||
      !i.parent ||
      !info.get(i.parent)!.parent ||
      !(i.size >= 2 || n.raw !== undefined || isControl(n))
    )
      continue;
    const g = groups.get(i.loose);
    if (g) g.push(n);
    else groups.set(i.loose, [n]);
  }
  const order = new Map<IrElement, number>();
  let seq = 0;
  const number = (n: IrNode) => {
    if (n.kind !== "el") return;
    order.set(n, seq++);
    n.children.forEach(number);
  };
  trees.forEach(number);

  // one component with looks only when few elements differ (a card's sizes per breakpoint); a whole page section
  // whose every box moves is separate components per look
  const strictGroups = (g: IrElement[]) => {
    const m = new Map<string, IrElement[]>();
    for (const n of g) {
      const k = info.get(n)!.strict!;
      const l = m.get(k);
      if (l) l.push(n);
      else m.set(k, [n]);
    }
    return [...m.values()];
  };
  const differing = (looks: IrElement[]): number => {
    let count = 0;
    const walk = (nodes: IrElement[]) => {
      if (nodes[0]!.raw !== undefined) return;
      if (nodes.some((x) => classesOf(x).classes.join(" ") !== classesOf(nodes[0]!).classes.join(" ")))
        count++;
      nodes[0]!.children.forEach((c, i) => {
        if (c.kind === "el") walk(nodes.map((x) => x.children[i] as IrElement));
      });
    };
    looks[0]!.children.forEach((c, i) => {
      if (c.kind === "el") walk(looks.map((x) => x.children[i] as IrElement));
    });
    return count;
  };
  const rankOf = (n: IrElement) => rank(info.get(n)!.tree);
  const ranks = [...new Set(trees.map(rank))].sort((a, b) => a - b);
  const labels = new Map(
    ranks.map((r, i) => [r, (VARIANT_NAMES[ranks.length] ?? moreVariantNames(ranks.length))[i]!]),
  );
  // looks are breakpoints: one look per breakpoint, no two looks at the same one
  const perBreakpoint = (looks: IrElement[][]) => {
    const seen = new Set<number>();
    for (const l of looks)
      for (const r of new Set(l.map(rankOf))) {
        if (seen.has(r)) return false;
        seen.add(r);
      }
    return true;
  };
  const treeSize = memo((t: IrElement) => info.get(t)!.size);
  const candidateGroups = [...groups.values()]
    .filter((g) => g.length > 1)
    .flatMap((g) => {
      const size = info.get(g[0]!)!.size;
      // a whole page section (the page body at two breakpoints) is no component
      if (size > Math.max(40, treeSize(info.get(g[0]!)!.tree) / 4)) return [];
      const looks = strictGroups(g);
      if (
        looks.length === 1 ||
        (perBreakpoint(looks) && differing(looks.map((l) => l[0]!)) <= Math.max(2, Math.floor(size / 4)))
      )
        return [g];
      return looks.filter((l) => l.length > 1);
    });
  // biggest first: a card is decided before the button inside it
  const candidates = candidateGroups.sort(
    (a, b) => info.get(b[0]!)!.size - info.get(a[0]!)!.size || b.length - a.length,
  );
  const instanceOf = new Map<IrElement, SharedComponent>();
  const pathFrom = (anc: IrElement, n: IrElement): number[] => {
    const p: number[] = [];
    for (let x: IrElement | null = n; x && x !== anc; x = info.get(x)!.parent) p.unshift(info.get(x)!.index);
    return p;
  };
  const nearestInstance = (n: IrElement): IrElement | null => {
    for (let x = info.get(n)!.parent; x; x = info.get(x)!.parent) if (instanceOf.has(x)) return x;
    return null;
  };
  const components: SharedComponent[] = [];
  const dsComponents: DsComponent[] = [];
  const inline: DsReport["inline"] = [];
  if (ds) {
    const named = dsNames(ds.designSystem, ds.reserved);
    const bySet = new Map<SceneComponentDef, IrElement[]>();
    for (const n of dsRoots.sort((a, b) => order.get(a)! - order.get(b)!)) {
      const d = setOf(n)!;
      const l = bySet.get(d);
      if (l) l.push(n);
      else bySet.set(d, [n]);
    }
    const lookKey = (n: IrElement) => `${info.get(n)!.loose}|${info.get(n)!.strict}`;
    const minRank = (l: IrElement[]) => Math.min(...l.map(rankOf));
    for (const [def, all] of bySet) {
      const api = named.get(def.id);
      const occ = all.filter((n) => {
        if (api && info.get(n)!.loose !== null) return true;
        inline.push({
          set: def.name,
          reason: api ? "its markup holds a part no component can (the page itself)" : "the set has no main",
        });
        return false;
      });
      if (!api || !occ.length) continue;
      // the look an instance shows: its variant (sets with variant axes: `breakpoint=lg` → 'lg'), else the breakpoint
      // of the page it is on; every instance of one look must render the same markup (props aside)
      const axes = Object.keys(def.variantAxes ?? {}).filter((a) => (def.variantAxes![a]?.length ?? 0) > 1);
      const defaults = Object.fromEntries(
        def.defaultVariant
          .split(",")
          .map((p) => p.split("="))
          .filter((p) => p.length === 2),
      ) as Record<string, string>;
      // a set looked up by its breakpoint variant whose instances are drawn differently on pages of one variant (the
      // fluid layout of each page width): a look per page breakpoint instead
      let byPage = false;
      const lookOf = (n: IrElement) => {
        const vals = axes.map((a) => n.instance?.variant?.[a] ?? defaults[a] ?? "");
        return axes.length && vals.every(Boolean) && !byPage ? vals.join("_") : labels.get(rankOf(n))!;
      };
      const groupLooks = () => {
        const m = new Map<string, IrElement[]>();
        for (const n of occ) {
          const k = lookOf(n);
          const l = m.get(k);
          if (l) l.push(n);
          else m.set(k, [n]);
        }
        return m;
      };
      let byLook = groupLooks();
      if (
        axes.length &&
        axes.every((a) => a === "breakpoint") &&
        [...byLook.values()].some((l) => new Set(l.map(lookKey)).size > 1)
      ) {
        byPage = true;
        byLook = groupLooks();
      }
      const looks: Array<{ name: string; list: IrElement[] }> = [];
      for (const [name, list] of byLook) {
        const byMarkup = new Map<string, IrElement[]>();
        for (const n of list) {
          const k = lookKey(n);
          const l = byMarkup.get(k);
          if (l) l.push(n);
          else byMarkup.set(k, [n]);
        }
        const groups = [...byMarkup.values()].sort(
          (a, b) => b.length - a.length || order.get(a[0]!)! - order.get(b[0]!)!,
        );
        // instances of one look drawn differently (a menu's copy laid out otherwise than the page's): looks of their own,
        // named after where they are (`menu-lg`), else numbered — never inline markup
        const inMenu = (l: IrElement[]) => l.every((n) => ds?.isOverlay?.(info.get(n)!.tree));
        const menuSplit =
          groups.length === 2 &&
          inMenu(groups[1]!) &&
          !groups[0]!.some((n) => ds?.isOverlay?.(info.get(n)!.tree));
        groups.forEach((g, i) =>
          looks.push({ name: i === 0 ? name : menuSplit ? `menu-${name}` : `${name}-${i + 1}`, list: g }),
        );
      }
      looks.sort(
        (a, b) => minRank(a.list) - minRank(b.list) || order.get(a.list[0]!)! - order.get(b.list[0]!)!,
      );
      // one markup throughout: no looks; else one shape per markup structure, the `variant` prop picks it
      const single = new Set(looks.map((l) => lookKey(l.list[0]!))).size === 1;
      const shapes = new Map<string, typeof looks>();
      for (const l of looks) {
        const k = info.get(l.list[0]!)!.loose!;
        const x = shapes.get(k);
        if (x) x.push(l);
        else shapes.set(k, [l]);
      }
      // a set whose looks are one axis of its own (tone, size): the prop is named after it
      const own = axes.filter((a) => a !== "breakpoint");
      const propOk = (a: string) =>
        /^[a-z][a-zA-Z]{1,15}$/.test(a) && !JS_RESERVED.has(a) && !api.api.some((x) => x.name === a);
      const pascal = (x: string) => `${x.charAt(0).toUpperCase()}${x.slice(1)}`;
      // several axes (a tone and the breakpoint): a prop each, the breakpoint's is `variant`
      const several =
        axes.length > 1 && axes.every((a) => a === "breakpoint" || propOk(a))
          ? axes.map((a) => (a === "breakpoint" ? "variant" : a))
          : null;
      const look = several
        ? "look"
        : own.length === 1 && axes.length === 1 && propOk(own[0]!)
          ? own[0]!
          : "variant";
      const mod: DsComponent = {
        name: api.name,
        def,
        shapes: [],
        api: api.api,
        look,
        lookType: `${api.name}${pascal(look)}`,
        ...(several
          ? { axisProps: several.map((prop) => ({ prop, type: `${api.name}${pascal(prop)}` })) }
          : {}),
      };
      for (const ls of shapes.values()) {
        const occs = ls.flatMap((l) => l.list).sort((a, b) => order.get(a)! - order.get(b)!);
        const c: SharedComponent = {
          name: mod.name,
          occurrences: occs,
          size: info.get(occs[0]!)!.size,
          props: [],
          common: [],
          variantCommon: new Map(),
          aliases: [],
          byVariant: [],
          ds: mod,
          variants: single
            ? [{ name: "default", template: occs[0]! }]
            : ls.map((l) => ({ name: l.name, template: l.list[0]! })),
          variantOf: new Map(ls.flatMap((l) => l.list.map((n) => [n, single ? "default" : l.name] as const))),
        };
        mod.shapes.push(c);
        components.push(c);
        for (const n of occs) instanceOf.set(n, c);
      }
      dsComponents.push(mod);
    }
  }
  for (const occ of candidates) {
    const spots = new Set(
      occ.map((n) => {
        const a = nearestInstance(n);
        return a
          ? `${components.indexOf(instanceOf.get(a)!)}:${pathFrom(a, n).join(".")}`
          : `own:${order.get(n)}`;
      }),
    );
    if (spots.size < 2) continue;
    occ.sort((a, b) => order.get(a)! - order.get(b)!);
    // looks: copies with the same classes throughout, ordered by where they show (smallest breakpoint first)
    const looks = new Map<string, IrElement[]>();
    for (const n of occ) {
      const k = info.get(n)!.strict!;
      const l = looks.get(k);
      if (l) l.push(n);
      else looks.set(k, [n]);
    }
    const at = (l: IrElement[]) => Math.min(...l.map(rankOf));
    const sorted = [...looks.values()].sort((a, b) => at(a) - at(b) || order.get(a[0]!)! - order.get(b[0]!)!);
    const names = sorted.length === 1 ? ["default"] : sorted.map((l) => labels.get(at(l))!);
    const c: SharedComponent = {
      name: "",
      occurrences: occ,
      size: info.get(occ[0]!)!.size,
      props: [],
      common: [],
      variantCommon: new Map(),
      aliases: [],
      byVariant: [],
      variants: sorted.map((l, i) => ({ name: names[i]!, template: l[0]! })),
      variantOf: new Map(sorted.flatMap((l, i) => l.map((n) => [n, names[i]!] as const))),
    };
    components.push(c);
    for (const n of occ) instanceOf.set(n, c);
  }
  // every copy must hold the same components at the same places: the template's nested instance is what all of them
  // render, so a copy whose part there became another component (that part's look at another breakpoint differs too
  // much to be a variant) or no component would render the wrong markup. Such copies are no component (they stay
  // inline; the parts inside them stay components): lossless
  const nodeAt = (root: IrElement, path: number[]): IrNode | undefined =>
    path.reduce<IrNode | undefined>((n, i) => (n?.kind === "el" ? n.children[i] : undefined), root);
  /** the components (undefined: none) copies of `c` hold at a place where they do not all hold the same one */
  const mismatches = (c: SharedComponent): Set<SharedComponent | undefined> => {
    const out = new Set<SharedComponent | undefined>();
    const walk = (n: IrElement, path: number[]) =>
      n.children.forEach((ch, i) => {
        if (ch.kind !== "el" || swapped.has(ch)) return;
        const p = [...path, i];
        const xs = c.occurrences.map((o) => {
          const x = nodeAt(o, p);
          return x?.kind === "el" ? instanceOf.get(x) : undefined;
        });
        if (xs.some((x) => x !== xs[0])) {
          for (const x of xs) out.add(x);
          return;
        }
        if (!xs[0]) walk(ch, p);
      });
    walk(c.occurrences[0]!, []);
    return out;
  };
  const drop = (c: SharedComponent) => {
    components.splice(components.indexOf(c), 1);
    for (const n of c.occurrences) instanceOf.delete(n);
    if (c.ds) c.ds.shapes.splice(c.ds.shapes.indexOf(c), 1);
  };
  // a design-system component keeps its instances: a part found by its markup that only some of them hold there is
  // no component; when they hold different design-system components there, they are inline markup
  for (let again = true; again;) {
    again = false;
    for (const c of components) {
      if (!c.ds) continue;
      const bad = mismatches(c);
      if (!bad.size) continue;
      const found = [...bad].filter((x): x is SharedComponent => !!x && !x.ds);
      if (found.length) found.forEach(drop);
      else {
        drop(c);
        for (const _ of c.occurrences)
          inline.push({
            set: c.ds.def.name,
            reason: "its nested instances differ from the other instances'",
          });
      }
      again = true;
      break;
    }
  }
  for (let i = dsComponents.length - 1; i >= 0; i--)
    if (!dsComponents[i]!.shapes.length) dsComponents.splice(i, 1);
  // smallest first: a part dropped inside a card is inline in every copy of the card before the card is checked
  for (const c of [...components].filter((x) => !x.ds).sort((a, b) => a.size - b.size)) {
    if (!mismatches(c).size) continue;
    drop(c);
  }

  /* ------------------------------------------------------------------ props */

  const at = (root: IrElement, path: number[]): IrNode =>
    path.reduce<IrNode>((n, i) => (n as IrElement).children[i]!, root);
  const intersect = (lists: string[][]) => lists[0]!.filter((x) => lists.every((l) => l.includes(x)));
  const valueOf = (slot: Slot, occ: IrElement): Val => {
    const n = at(occ, slot.at);
    switch (slot.kind) {
      case "text":
        return (n as { text: string }).text;
      case "attr": {
        const v = (n as IrElement).attrs[slot.attr];
        return v !== undefined && slot.attr === "src" && (n as IrElement).tag === "img"
          ? (imageSrc(v) ?? v)
          : v;
      }
      case "tap": {
        const i = (n as IrElement).interaction;
        return i?.onTap && (PROP_TAPS.has(i.onTap) || overlayTapIn(n as IrElement)) ? i : undefined;
      }
      case "expanded": {
        const i = (n as IrElement).interaction;
        return overlayTapIn(n as IrElement) === "open" ? i!.target : undefined;
      }
      case "node":
        return n as IrElement;
      case "class": {
        const c = instanceOf.get(occ)!;
        const shared = [...c.common, ...(c.variantCommon.get(c.variantOf.get(occ)!) ?? [])];
        return classesOf(occ)
          .classes.filter((x) => !shared.includes(x))
          .join(" ");
      }
      case "style":
        return classesOf(occ).inline;
      case "variant": {
        const v = instanceOf.get(occ)!.variantOf.get(occ);
        return slot.axis === undefined ? v : v?.split("_")[slot.axis];
      }
      case "crop":
        return cropOf(n as IrElement);
      case "context":
        return instanceOf.get(occ)!.variantOf.get(occ)?.startsWith("menu-") ? "menu" : undefined;
      case "inst":
        return valueOf(slot.inner.slot, n as IrElement);
      case "list": {
        const r = slot.run;
        return Array.from({ length: r.count }, (_, k) =>
          Object.fromEntries(
            r.fields.map((f) => {
              // (an item's own classes: what it adds to the ones all items share)
              if (f.cls)
                return [
                  f.name,
                  classesOf(at(occ, [...r.parent, r.from + k]) as IrElement)
                    .classes.filter((x) => !f.cls!.includes(x))
                    .join(" "),
                ];
              const v = valueOf(runSlot(r, f.rel, k), occ);
              return [
                f.name,
                f.tap ? (v as SceneInteraction | undefined)?.url : (v as string | IrElement | undefined),
              ];
            }),
          ),
        );
      }
    }
  };
  /** a slot relative to a run's item → the same slot of its k-th item (path from the component's root) */
  const runSlot = (r: Run, rel: Slot, k: number): Slot =>
    ({ ...rel, at: [...r.parent, r.from + k, ...rel.at] }) as Slot;
  // (a swapped instance by what it draws: layer ids differ from page to page)
  const valKey = (v: Val) =>
    v && typeof v === "object" && "kind" in v
      ? JSON.stringify(v, (k, x: unknown) => (k === "id" ? undefined : x))
      : JSON.stringify(v);
  const same = (vals: Val[]) => {
    const k = valKey(vals[0]);
    return vals.every((v) => valKey(v) === k);
  };
  const overlayTapIn = (n: IrElement) => overlayTap(n, info.get(n)?.tree ?? n);
  /** the slots of a design-system shape's template its set's API props bind to (by the main layer they come from:
   *  an instance's layers are `<instance id>__<main layer id>`) */
  const apiSlots = (d: DsComponent, t: IrElement, slots: Slot[]): Map<Slot, DsApiProp> => {
    const out = new Map<Slot, DsApiProp>();
    if (!t.id || !d.api.length) return out;
    const pre = `${t.id}__`;
    const mainOf = (x: IrElement) =>
      x === t ? DS_ROOT : x.id?.startsWith(pre) ? x.id.slice(pre.length) : null;
    const layerAt = (path: number[]): string | null => {
      for (let k = path.length; k >= 0; k--) {
        const x = at(t, path.slice(0, k));
        if (x.kind === "el" && (x.id || x === t)) return mainOf(x);
      }
      return null;
    };
    const byKey = new Map<string, Slot[]>();
    for (const s of slots) {
      const key =
        s.kind === "text"
          ? `text:${layerAt(s.at.slice(0, -1))}`
          : s.kind === "attr" && s.attr === "src" && (at(t, s.at) as IrElement).tag === "img"
            ? `image:${layerAt(s.at)}`
            : s.kind === "attr" && s.attr === "href"
              ? `href:${layerAt(s.at)}`
              : s.kind === "node"
                ? `swap:${mainOf(at(t, s.at) as IrElement)}`
                : null;
      if (key) {
        const l = byKey.get(key);
        if (l) l.push(s);
        else byKey.set(key, [s]);
      }
    }
    // a layer with several texts (styled runs) stays the component's own
    for (const a of d.api) {
      const l = byKey.get(`${a.field}:${a.target}`);
      if (l?.length === 1 && !out.has(l[0]!)) out.set(l[0]!, a);
    }
    return out;
  };

  /**
   * A component whose looks are its layout at successive breakpoints (each look shows on pages of a width range of its
   * own, one markup, nested components responsive too): the media ranges of its looks, else null.
   */
  const responsiveRanges = (c: SharedComponent): Map<string, string> | null => {
    if (c.variants.length < 2 || c.occurrences[0]!.raw !== undefined) return null;
    if (c.ds) {
      const axes = Object.entries(c.ds.def.variantAxes ?? {})
        .filter(([, v]) => v.length > 1)
        .map(([a]) => a);
      if (c.ds.shapes.length > 1 || c.ds.look !== "variant" || axes.some((a) => a !== "breakpoint"))
        return null;
    }
    if (c.variants.some((v) => /-\d+$/.test(v.name))) return null;
    const ranks = c.variants.map((v) =>
      c.occurrences.filter((n) => c.variantOf.get(n) === v.name).map(rankOf),
    );
    if (ranks.some((r) => !r.length)) return null;
    // (looks in menus and on the page: each kind its own ranges)
    const inMenu = (i: number) => c.variants[i]!.name.startsWith("menu-");
    const groups = [
      c.variants.map((_, i) => i).filter((i) => !inMenu(i)),
      c.variants.map((_, i) => i).filter(inMenu),
    ].filter((g) => g.length);
    const out = new Map<string, string>();
    // nested components whose look changes with this one's must not need a look prop either
    let ok = true;
    const walk = (n: IrNode, path: number[]) => {
      if (!ok || n.kind !== "el") return;
      if (path.length && instanceOf.has(n)) {
        const inner = instanceOf.get(n)!;
        if (inner.variants.length > 1 && !inner.responsive) ok = false;
        return;
      }
      n.children.forEach((ch, i) => walk(ch, [...path, i]));
    };
    for (const v of c.variants) walk(v.template, []);
    if (!ok) return null;
    for (const g of groups) {
      const ord = [...g].sort((a, b) => Math.min(...ranks[a]!) - Math.min(...ranks[b]!));
      for (let k = 1; k < ord.length; k++)
        if (Math.max(...ranks[ord[k - 1]!]!) >= Math.min(...ranks[ord[k]!]!)) return null;
      ord.forEach((i, k) => {
        const lo = Math.min(...ranks[i]!),
          hi = k + 1 < ord.length ? Math.min(...ranks[ord[k + 1]!]!) : undefined;
        out.set(
          c.variants[i]!.name,
          `${k > 0 && lo > 0 ? `min-[${lo}px]:` : ""}${hi !== undefined ? `max-[${Math.round((hi - 0.02) * 100) / 100}px]:` : ""}`,
        );
      });
    }
    return out;
  };

  /** Runs of alike items in a component's markup (see Run): their props become one array prop, or module data. */
  const findRuns = (c: SharedComponent) => {
    const t = c.occurrences[0]!;
    if (t.raw !== undefined) return;
    const inPath = (at: number[], r: { parent: number[]; from: number; count: number }) =>
      at.length > r.parent.length &&
      r.parent.every((x, i) => at[i] === x) &&
      at[r.parent.length]! >= r.from &&
      at[r.parent.length]! < r.from + r.count;
    const taken = createNamer("");
    for (const p of c.props) taken(p.name);
    const runNames = new Set(c.props.map((p) => p.name));
    const runs: Run[] = [];
    const walk = (n: IrElement, path: number[]) => {
      if (path.length && (instanceOf.has(n) || swapped.has(n))) return;
      const kids = n.children;
      for (let i = 0; i < kids.length;) {
        let j = i + 1;
        // the same markup (classes included) in every instance of the component
        // the same markup in every instance of the component (an item's own classes, its place in the list, aside)
        const alike = (a: number, b: number) =>
          c.occurrences.every((o) => {
            const p = at(o, path) as IrElement;
            const x = p.children[a],
              y = p.children[b];
            if (
              x?.kind !== "el" ||
              y?.kind !== "el" ||
              swapped.has(x) ||
              instanceOf.get(x) !== instanceOf.get(y)
            )
              return false;
            const kx = info.get(x)?.strict ?? null;
            return (
              kx !== null &&
              kx === (info.get(y)?.strict ?? null) &&
              (x.raw !== undefined
                ? y.raw !== undefined && withoutOwnIds(x.raw) === withoutOwnIds(y.raw)
                : JSON.stringify(classesOf(x).inline) === JSON.stringify(classesOf(y).inline))
            );
          });
        if (kids[i]!.kind === "el") while (j < kids.length && alike(i, j)) j++;
        const run = j - i >= 2 ? makeRun(c, path, i, j - i, taken) : null;
        if (run) {
          runs.push(run);
          i = j;
          continue;
        }
        const x = kids[i]!;
        if (x.kind === "el" && x.raw === undefined) walk(x, [...path, i]);
        i++;
      }
    };
    const makeRun = (
      c: SharedComponent,
      parent: number[],
      from: number,
      count: number,
      namer: (b: string) => string,
    ): Run | null => {
      const x0 = at(t, [...parent, from]) as IrElement;
      const comp = instanceOf.get(x0) ?? null;
      const rel: Slot[] = [];
      let ok = true;
      if (comp) for (const ip of comp.props) rel.push({ kind: "inst", at: [], inner: ip, comp });
      else {
        const visit = (n: IrNode, p: number[]) => {
          if (n.kind === "text") {
            rel.push({ kind: "text", at: p });
            return;
          }
          if (swapped.has(n)) {
            ok = false;
            return;
          }
          if (p.length && instanceOf.has(n)) {
            const inner = instanceOf.get(n)!;
            for (const ip of inner.props) rel.push({ kind: "inst", at: p, inner: ip, comp: inner });
            return;
          }
          if (n.raw !== undefined) return;
          // (a picture the export leaves out is no data)
          if (n.tag === "img" && n.attrs.src !== undefined && imageSrc(n.attrs.src) === null) {
            ok = false;
            return;
          }
          if (!n.svg)
            for (const k of Object.keys(n.attrs))
              if (SLOT_ATTRS[k]?.(n.tag)) rel.push({ kind: "attr", at: p, attr: k });
          rel.push({ kind: "tap", at: p });
          n.children.forEach((ch, i) => visit(ch, [...p, i]));
        };
        visit(x0, []);
      }
      if (!ok) return null;
      const r: Run = {
        parent,
        from,
        count,
        name: "",
        itemVar: "",
        itemType: "",
        fields: [],
        varying: false,
        comp,
        key: null,
      };
      const fieldNamer = createNamer("");
      // markup items whose own classes differ (their places): a className field over the classes they all share
      if (!comp) {
        const items = c.occurrences.flatMap((o) =>
          Array.from({ length: count }, (_, k) => at(o, [...parent, from + k]) as IrElement),
        );
        const lists = items.map((x) => classesOf(x).classes);
        // (items that differ only between the component's looks, alike within each instance, are its look's business)
        const within = c.occurrences.some((o) => {
          const own = Array.from({ length: count }, (_, k) =>
            classesOf(at(o, [...parent, from + k]) as IrElement).classes.join(" "),
          );
          return new Set(own).size > 1;
        });
        if (within && lists.some((l) => l.join(" ") !== lists[0]!.join(" "))) {
          // only their places and sizes may differ (another font is another item), and only in a component with one
          // look (its looks' class table covers the first item alone)
          const common = intersect(lists);
          // (places and sizes: position, insets, width / height, margins, how it sits in its flow)
          const GEOMETRY =
            /^(absolute|relative|fixed|sticky|-?(left|top|right|bottom|inset)-|w-|h-|min-[wh]-|max-[wh]-|-?m[trblxy]?-|self-|shrink|grow|flex-1|basis-|z-|\[(left|top|right|bottom|width|height|margin(-\w+)?|min-width|max-width|min-height|max-height|flex|z-index):)/;
          // (and how a text wraps in its box: a line that breaks at one width and not another is the same item)
          const WRAP = /^(whitespace-|break-|truncate$|text-ellipsis$|\[overflow-wrap:)/;
          // a responsive component's looks are media-prefixed classes in its one markup (`max-[767.98px]:left-[8px]`)
          const placeOnly = (k: string) => {
            const bare = k.replace(/^(?:(?:min|max)-\[[^\]]+\]:|(?:sm|md|lg|xl|2xl):)+/, "");
            return GEOMETRY.test(bare) || WRAP.test(bare);
          };
          // (within one instance the items differ only in geometry; between looks anything may differ)
          for (const o of c.occurrences) {
            const own = Array.from(
              { length: count },
              (_, k) => classesOf(at(o, [...parent, from + k]) as IrElement).classes,
            );
            const here = intersect(own);
            if (!own.every((l) => l.every((k) => here.includes(k) || placeOnly(k)))) return null;
          }
          r.fields.push({
            name: fieldNamer("className"),
            rel: { kind: "class", at: [] },
            tsType: "string",
            cls: common,
          });
        }
      }
      const texts = rel.filter((x) => x.kind === "text");
      for (const sl of rel) {
        const vals = c.occurrences.flatMap((o) =>
          Array.from({ length: count }, (_, k) => valueOf(runSlot(r, sl, k), o)),
        );
        if (same(vals)) continue;
        // data only: copy, links, pictures, a nested component's copy or look, links out (other taps and menus stay
        // the component's)
        const type: string =
          sl.kind === "inst" ? sl.inner.type : sl.kind === "text" || sl.kind === "attr" ? "string" : sl.kind;
        if (type === "tap" || type === "handler") {
          if (
            !vals.every(
              (v) =>
                !!v &&
                typeof v === "object" &&
                (v as SceneInteraction).onTap === "open-url" &&
                typeof (v as SceneInteraction).url === "string",
            )
          )
            return null;
          r.fields.push({
            name: fieldNamer(r.fields.some((f) => f.name === "href") ? "url" : "href"),
            rel: sl,
            tsType: "string",
            tap: true,
          });
          continue;
        }
        // a swapped nested component (the icon of a menu item): a node per item
        if (type === "node" && sl.kind === "inst") {
          if (!vals.every((v) => !!v && typeof v === "object" && "kind" in v)) return null;
          r.fields.push({ name: fieldNamer(sl.inner.name), rel: sl, tsType: "ReactNode" });
          continue;
        }
        if (type !== "string" && type !== "variant" && type !== "className") return null;
        if (vals.some((v) => v !== undefined && typeof v !== "string")) return null;
        // a nested component's look that is this one's (both named after the breakpoint): no data
        if (
          type === "variant" &&
          sl.kind === "inst" &&
          c.occurrences.every((o) =>
            Array.from({ length: count }, (_, k) => valueOf(runSlot(r, sl, k), o)).every(
              (v) => v === c.variantOf.get(o),
            ),
          )
        )
          continue;
        let base: string;
        if (sl.kind === "inst")
          base = sl.at.length
            ? `${camel(sl.comp.name.match(/^[A-Z][a-z]*/)?.[0] ?? sl.comp.name)}${sl.inner.name.charAt(0).toUpperCase()}${sl.inner.name.slice(1)}`
            : sl.inner.name;
        else if (sl.kind === "attr")
          base =
            (
              {
                src: "image",
                srcset: "imageSrcSet",
                alt: "imageAlt",
                poster: "poster",
                href: "href",
                "aria-label": "ariaLabel",
                title: "tooltip",
              } as Record<string, string>
            )[sl.attr] ?? camel(pascalCase(sl.attr, "value"));
        else {
          const sizes = texts.map((x) => fontPx(textHost(at(x0, x.at.slice(0, -1)) as IrElement, x0, x.at)));
          const big = Math.max(...sizes),
            mine = sizes[texts.indexOf(sl)]!;
          base =
            closestClickable(x0, sl.at) || x0.tag === "a" || x0.tag === "button"
              ? texts.length > 1 && mine === big && sizes.filter((z) => z === big).length === 1
                ? "title"
                : "label"
              : texts.length > 1 && mine === big && sizes.filter((z) => z === big).length === 1
                ? "title"
                : "text";
        }
        const tsType =
          sl.kind === "inst" && sl.inner.type === "variant"
            ? (sl.comp.ds?.lookType ?? `${sl.comp.name}Variant`)
            : "string";
        r.fields.push({ name: fieldNamer(base), rel: sl, tsType });
      }
      if (!r.fields.length) return null;
      // every prop of the component inside the items is one of the fields (a design-system property is the set's own)
      const covered = (p: Prop) =>
        !inPath(p.slot.at, r) ||
        (!(p.api && c.ds?.api.some((a) => a.name === p.name && !a.slot)) &&
          r.fields.some((f) =>
            [...Array(count).keys()].some((k) => {
              const sl = runSlot(r, f.rel, k);
              return (
                sl.kind === p.slot.kind &&
                sl.at.join(".") === p.slot.at.join(".") &&
                (sl.kind !== "attr" || (p.slot.kind === "attr" && p.slot.attr === sl.attr)) &&
                (sl.kind !== "inst" || (p.slot.kind === "inst" && p.slot.inner === sl.inner))
              );
            }),
          ));
      if (![...c.props, ...c.aliases].every(covered)) return null;
      // (an item's own classes: what it adds to the classes all items share)
      const fieldValue = (f: Run["fields"][number], k: number, o: IrElement): Val =>
        f.cls
          ? classesOf(at(o, [...parent, from + k]) as IrElement)
              .classes.filter((x) => !f.cls!.includes(x))
              .join(" ")
          : valueOf(runSlot(r, f.rel, k), o);
      r.varying = r.fields.some((f) =>
        [...Array(count).keys()].some((k) => !same(c.occurrences.map((o) => fieldValue(f, k, o)))),
      );
      // a short constant run reads fine as it is
      if (!r.varying && count < 3) return null;
      const linky =
        !comp && (x0.tag === "a" || r.fields.some((f) => f.rel.kind === "attr" && f.rel.attr === "href"));
      // named after what the items are, and where several runs would share a name, after where they sit (a menu's
      // items, a pseudo element's shapes) — never numbered while a name that says something is free
      const up = at(t, parent) as IrElement;
      const pseudo = /^::?(before|after)$/i.exec(x0.name ?? "")?.[1]?.toLowerCase();
      const candidates = comp
        ? [camel(comp.name.replace(/\d+$/, ""))]
        : [
            ...(pseudo ? [`${pseudo}Shape`] : []),
            ...(goodName(x0.name, textOf(x0)) ? [camel(goodName(x0.name, textOf(x0))!)] : []),
            linky ? "link" : "item",
            ...(["menu", "ul", "ol", "nav"].includes(up.tag)
              ? [`${up.tag === "ol" || up.tag === "ul" ? "list" : up.tag}${linky ? "Link" : "Item"}`]
              : []),
            ...(goodName(up.name, textOf(up))
              ? [`${camel(goodName(up.name, textOf(up))!)}${linky ? "Link" : "Item"}`]
              : []),
          ];
      const safe = (x: string) => (JS_RESERVED.has(x) ? `${x}Item` : x);
      const item = candidates.map(safe).find((x) => !runNames.has(plural(x))) ?? safe(candidates[0]!);
      r.itemVar = item;
      r.name = namer(plural(r.itemVar));
      runNames.add(plural(r.itemVar)).add(r.name);
      r.itemType = `${c.ds?.name ?? c.name}${r.itemVar.charAt(0).toUpperCase()}${r.itemVar.slice(1)}`;
      const unique = (f: Run["fields"][number]) =>
        c.occurrences.every(
          (o) => new Set(Array.from({ length: count }, (_, k) => fieldValue(f, k, o))).size === count,
        );
      r.key =
        (
          r.fields.find((f) => f.rel.kind === "text" && unique(f)) ??
          r.fields.find((f) => f.rel.kind === "attr" && f.rel.attr === "href" && unique(f)) ??
          r.fields.find((f) => f.tsType === "string" && unique(f))
        )?.name ?? null;
      return r;
    };
    walk(t, []);
    if (!runs.length) return;
    c.runs = runs;
    const inRun = (at: number[]) => runs.some((r) => inPath(at, r));
    c.props = c.props.filter((p) => !inRun(p.slot.at));
    c.aliases = c.aliases.filter((p) => !inRun(p.slot.at));
    for (const r of runs)
      if (r.varying)
        c.props.push({
          name: r.name,
          type: "list",
          slot: { kind: "list", at: r.parent, run: r },
          doc: `the ${r.count} ${r.name} (${r.fields.map((f) => f.name).join(", ")})`,
        });
  };

  nameComponents(
    components.filter((c) => !c.ds),
    (n) => info.get(n)?.parent ?? null,
    [...(ds?.reserved ?? []), ...dsComponents.map((d) => d.name)],
  );
  // smallest first: a nested component's props are known before the outer one passes them through
  for (const c of [...components].sort((a, b) => a.size - b.size)) {
    const t = c.occurrences[0]!;
    if (t.raw === undefined) {
      c.common = intersect(c.occurrences.map((n) => classesOf(n).classes));
      for (const v of c.variants) {
        const mine = c.occurrences.filter((n) => c.variantOf.get(n) === v.name);
        c.variantCommon.set(
          v.name,
          intersect(mine.map((n) => classesOf(n).classes)).filter((x) => !c.common.includes(x)),
        );
      }
    }
    // a design-system component with several shapes: the `variant` prop picks one
    const slots: Slot[] =
      c.variants.length > 1 || (c.ds?.shapes.length ?? 0) > 1
        ? c.ds?.axisProps
          ? c.ds.axisProps.map((_, axis) => ({ kind: "variant" as const, at: [] as [], axis }))
          : [{ kind: "variant", at: [] }]
        : [];
    const tree = info.get(t)!.tree;
    const visit = (n: IrNode, path: number[]) => {
      if (n.kind === "text") {
        slots.push({ kind: "text", at: path });
        return;
      }
      if (path.length && swapped.has(n)) {
        slots.push({ kind: "node", at: path });
        return;
      }
      if (path.length && instanceOf.has(n)) {
        const inner = instanceOf.get(n)!;
        for (const p of inner.props) slots.push({ kind: "inst", at: path, inner: p, comp: inner });
        return;
      }
      if (n.raw !== undefined) return;
      if (!path.length) slots.push({ kind: "class", at: [] }, { kind: "style", at: [] });
      if (!n.svg)
        for (const k of Object.keys(n.attrs))
          if (SLOT_ATTRS[k]?.(n.tag)) slots.push({ kind: "attr", at: path, attr: k });
      if (n.tag === "img") slots.push({ kind: "crop", at: path });
      if (c.ds || overlayTap(n, tree) === "open") slots.push({ kind: "expanded", at: path });
      slots.push({ kind: "tap", at: path });
      n.children.forEach((ch, i) => visit(ch, [...path, i]));
    };
    visit(t, []);
    const api = c.ds ? apiSlots(c.ds, t, slots) : new Map<Slot, DsApiProp>();
    const lookOf = (n: IrElement) => c.variantOf.get(n);
    const varying = slots.filter((s) => {
      // a nested instance's look follows this component's (its class table), never a prop of its own
      if (s.kind === "inst" && s.inner.type === "variant") return false;
      if (s.kind === "variant" || (api.has(s) && !api.get(s)!.slot)) return true;
      const vals = c.occurrences.map((n) => valueOf(s, n));
      // a content slot every instance fills the same way is the component's own copy, no prop
      if (api.has(s)) return !same(vals);
      if (s.kind === "expanded" || (s.kind === "inst" && s.inner.type === "expanded"))
        return vals.some((v) => v !== undefined);
      // a design-system component opens its own links; the screen's navigation and menus are the caller's
      if (c.ds && (s.kind === "tap" || (s.kind === "inst" && s.inner.type === "handler")))
        return vals.some(
          (v) => v !== undefined && (!same(vals) || !OWN_TAPS.has((v as SceneInteraction).onTap!)),
        );
      if (s.kind === "tap" || (s.kind === "inst" && s.inner.type === "handler"))
        return vals.some((v) => v !== undefined);
      if (s.kind === "class") return vals.some((v) => v !== "");
      if (same(vals)) return false;
      // a nested instance's position that only changes with the look: the class table
      if (
        s.kind === "inst" &&
        s.inner.type === "className" &&
        c.variants.length > 1 &&
        c.variants.every((v) =>
          same(c.occurrences.filter((n) => lookOf(n) === v.name).map((n) => valueOf(s, n))),
        )
      ) {
        c.byVariant.push(s);
        return false;
      }
      return true;
    });
    // one prop for slots that always agree (an image's aria-label and alt): the copy, then alt, href, src name it
    const canon = new Map<string, Slot>();
    const rankOf = (s: Slot) =>
      s.kind === "text"
        ? 0
        : s.kind === "attr"
          ? (({ alt: 1, href: 2, src: 3 } as Record<string, number>)[s.attr] ?? 5)
          : s.kind === "inst"
            ? 4
            : 9;
    const sig = (s: Slot) =>
      s.kind === "text" || s.kind === "attr" || (s.kind === "inst" && s.inner.type === "string")
        ? JSON.stringify(c.occurrences.map((n) => valueOf(s, n)))
        : null;
    // (the set's API props are props of their own)
    for (const s of varying) {
      const k = api.has(s) ? null : sig(s);
      if (k !== null && (!canon.has(k) || rankOf(s) < rankOf(canon.get(k)!))) canon.set(k, s);
    }
    const own = (s: Slot) => {
      const k = api.has(s) ? null : sig(s);
      return k === null || canon.get(k) === s;
    };
    c.props = nameProps(c, varying.filter(own), valueOf, api);
    c.aliases = varying
      .filter((s) => !own(s))
      .map((s) => ({ ...c.props.find((p) => p.slot === canon.get(sig(s)!))!, slot: s }));
    for (const p of c.props)
      if (p.type === "string" && c.occurrences.some((n) => valueOf(p.slot, n) === "")) p.emptyDefault = true;
    for (const p of c.props)
      if (p.type === "expanded" && c.occurrences.some((n) => valueOf(p.slot, n) === undefined))
        p.sometimes = true;
    findRuns(c);
    const ranges = responsiveRanges(c);
    if (ranges) {
      c.responsive = ranges;
      c.props = c.props.filter((p) => p.slot.kind !== "variant");
      // drawn otherwise in menus than on the page: one flag picks the menu's classes
      if (
        c.variants.some((v) => v.name.startsWith("menu-")) &&
        c.variants.some((v) => !v.name.startsWith("menu-"))
      ) {
        c.menuLooks = true;
        c.props.unshift({
          name: "inMenu",
          type: "flag",
          slot: { kind: "context", at: [] },
          doc: "drawn in a menu (its look there)",
        });
      }
    }
  }
  // one prop name, one type across a design-system component's shapes
  for (const d of dsComponents) {
    const types = new Map<string, PropType>();
    for (const c of d.shapes) {
      const namer = createNamer("");
      for (const p of c.props) namer(p.name);
      const renamed = new Map<string, string>();
      for (const p of c.props) {
        const had = types.get(p.name);
        if (had !== undefined && had !== p.type) {
          const n = namer(p.name);
          renamed.set(p.name, n);
          p.name = n;
        }
        if (!types.has(p.name)) types.set(p.name, p.type);
      }
      for (const a of c.aliases) a.name = renamed.get(a.name) ?? a.name;
    }
  }

  /* ------------------------------------------------------------------ emission */

  let cnUsed = false;

  /** `<Card title="…" />` with literal values (a screen), or bound to the outer component's props / class table. */
  const usage = (n: IrElement, pad: string, value: (p: Prop) => string | null): string => {
    const c = instanceOf.get(n)!;
    const attrs = c.props
      .map((p) => {
        const v = value(p);
        return v === null ? null : p.type === "flag" && v === "{true}" ? p.name : `${p.name}=${v}`;
      })
      .filter((x): x is string => x !== null);
    const one = `<${c.name}${attrs.length ? " " + attrs.join(" ") : ""} />`;
    return one.length + pad.length <= 120 || attrs.length < 2
      ? one
      : `<${c.name}\n${attrs.map((a) => `${pad}  ${a}`).join("\n")}\n${pad}/>`;
  };

  /** JSX of a swapped instance (a ReactNode prop's value), its further lines indented under `pad`. */
  const nodeJsx = (x: IrElement, o: ReactEmitOptions, pad: string) =>
    emitJsx(x, o, 0)
      .split("\n")
      .map((l, i) => (i ? `${pad}  ${l}` : l))
      .join("\n");

  /** A prop's value at one instance as a JSX attribute value (null: leave it out); `node` writes a swapped instance. */
  /** a list prop's value: an array of item objects (one per line under `pad`, else on one line) */
  const rowsSrc = (rows: Row[], pad: string | null, node: (x: IrElement) => string = () => "null") => {
    const row = (r: Row) =>
      `{ ${Object.entries(r)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => `${k}: ${typeof x === "string" ? jsString(x) : node(x!)}`)
        .join(", ")} }`;
    return pad === null
      ? `[${rows.map(row).join(", ")}]`
      : `[\n${rows.map((r) => `${pad}  ${row(r)},`).join("\n")}\n${pad}]`;
  };
  const literal = (
    p: Prop,
    n: IrElement,
    o: ReactEmitOptions,
    node: (x: IrElement) => string,
    pad = "",
  ): string | null => {
    const v = valueOf(p.slot, n);
    if (v === undefined) return null;
    if (p.type === "list") return `{${rowsSrc(v as Row[], `${pad}  `, node)}}`;
    if (p.type === "flag") return "{true}";
    if (p.type === "handler") return handlerOf(v as SceneInteraction, o);
    if (p.type === "expanded") return `{overlay === ${jsString(v as string)}}`;
    if (p.type === "node") return `{${node(v as IrElement)}}`;
    if (p.type === "style") {
      const sp = styleProp(v as StyleMap);
      return sp ? sp.slice("style=".length) : null;
    }
    if ((p.type === "className" || p.emptyDefault) && v === "") return null;
    return jsxAttrValue(v as string);
  };
  const dataValue = (p: Prop, n: IrElement, node: (x: IrElement) => string): string | null => {
    const v = valueOf(p.slot, n);
    if (v === undefined || ((p.type === "className" || p.emptyDefault) && v === "")) return null;
    if (p.type === "list") return rowsSrc(v as Row[], null, node);
    if (p.type === "flag") return "true";
    if (p.type === "style") {
      const sp = styleProp(v as StyleMap);
      return sp ? sp.slice("style={".length, -1) : null;
    }
    if (p.type === "node") return node(v as IrElement);
    return jsString(v as string);
  };

  const screenHooks = (
    o: ReactEmitOptions,
    imp: { decls: string[]; uses: Set<SharedComponent> },
  ): JsxHooks => {
    const listNamer = createNamer("");
    const hooks: JsxHooks = {
      usage(n, pad) {
        const c = instanceOf.get(n);
        if (!c) return null;
        imp.uses.add(c);
        return usage(n, pad, (p) => literal(p, n, o, (x) => nodeJsx(x, { ...o, hooks }, pad), pad));
      },
      componentOf: (n) => instanceOf.get(n)?.name ?? null,
      list(run) {
        // a design-system component's instances may be of different shapes: each row has its own
        const comps = run.map((n) => instanceOf.get(n)!);
        // taps and open menus are the screen's: no data
        if (
          comps.some((c, i) =>
            c.props.some(
              (p) =>
                (p.type === "handler" || p.type === "expanded") && valueOf(p.slot, run[i]!) !== undefined,
            ),
          )
        )
          return null;
        if (comps.every((c) => !c.props.length)) return null;
        for (const x of comps) imp.uses.add(x);
        const node = (x: IrElement) => nodeJsx(x, { ...o, hooks }, "  ");
        const rows = run.map(
          (n, i) =>
            `  { ${comps[i]!.props.map((p) => {
              const v = dataValue(p, n, node);
              return v === null ? null : `${p.name}: ${v}`;
            })
              .filter(Boolean)
              .join(", ")} },`,
        );
        return mapOver(run, comps, rows, listNamer, imp.decls);
      },
    };
    return hooks;
  };

  /** `{items.map(…)}` over a typed data array (`decls`) of one component's instances, one row each. */
  const mapOver = (
    run: IrElement[],
    comps: SharedComponent[],
    rows: string[],
    namer: (base: string) => string,
    decls: string[],
  ): string => {
    const c = comps[0]!;
    // NavigationListButton2's rows are not `navigationListButtons` (that reads as NavigationListButton's list): a
    // numbered component keeps its number — `navigationListButton2Items`
    const item = camel(c.name);
    const name = namer(/\d$/.test(c.name) ? `${item}Items` : plural(item));
    decls.push(`const ${name}: ${c.name}Props[] = [\n${rows.join("\n")}\n]`);
    // the copy reads best as a key, then the link, then anything else that is unique
    const rowProp = (p: Prop, i: number) =>
      comps[i]!.props.find((x) => x.name === p.name && x.type === p.type && !x.emptyDefault);
    const unique = c.props.filter(
      (p) =>
        p.type === "string" &&
        !p.emptyDefault &&
        run.every((_, i) => rowProp(p, i)) &&
        new Set(run.map((n, i) => valueOf(rowProp(p, i)!.slot, n))).size === run.length,
    );
    const keyProp =
      unique.find((p) => p.slot.kind === "text") ??
      unique.find((p) => p.slot.kind === "attr" && p.slot.attr === "href") ??
      unique[0];
    return keyProp
      ? `{${name}.map((${item}) => <${c.name} key={${item}.${keyProp.name}} {...${item}} />)}`
      : `{${name}.map((${item}, i) => <${c.name} key={i} {...${item}} />)}`;
  };

  /** One component's (or design-system shape's) markup at `depth`, its class table `table`, what it needs. */
  const emitShape = (
    c: SharedComponent,
    o: ReactEmitOptions,
    cssRules: string[],
    prefix: string,
    depth: number,
    table: string,
    optional: ReadonlySet<string> = new Set(),
    lists: ModuleLists = { decls: [], namer: createNamer(""), types: new Set(), runs: [] },
  ) => {
    const t = c.occurrences[0]!;
    const multi = c.variants.length > 1;
    const slotAt = new Map<IrNode, Map<SlotName, Prop>>();
    const cropAt = new Map<IrNode, Prop>();
    for (const p of [...c.props, ...c.aliases]) {
      if (
        p.slot.kind === "inst" ||
        p.slot.kind === "variant" ||
        p.slot.kind === "list" ||
        p.slot.kind === "context"
      )
        continue;
      const n = at(t, p.slot.at);
      if (p.slot.kind === "crop") {
        cropAt.set(n, p);
        continue;
      }
      const name: SlotName = p.slot.kind === "attr" ? `attr:${p.slot.attr}` : p.slot.kind;
      if (!slotAt.has(n)) slotAt.set(n, new Map());
      slotAt.get(n)!.set(name, p);
    }
    const propOf = (s: (p: Prop) => boolean) => [...c.props, ...c.aliases].find((p) => s(p));
    // runs of alike items: the first item is written once inside a `.map()` (its fields bound to the item variable),
    // the others are left out; nested instances among an item's layers take their field values
    const runItem = new Map<IrNode, { run: Run; k: number }>();
    /** a run item's classes all items share (its own come from its className field) */
    const runShared = new Map<IrNode, string[]>();
    const runInst = new Map<IrNode, Map<Prop, string>>();
    for (const r of c.runs ?? []) {
      for (let k = 0; k < r.count; k++) runItem.set(at(t, [...r.parent, r.from + k]), { run: r, k });
      for (const f of r.fields) {
        if (f.cls) {
          const x0 = at(t, [...r.parent, r.from]);
          runShared.set(x0, f.cls);
          if (!slotAt.has(x0)) slotAt.set(x0, new Map());
          slotAt.get(x0)!.set("class", {
            name: `${r.itemVar}.${f.name}`,
            type: "className",
            slot: { kind: "class", at: [] },
            doc: "",
          });
          continue;
        }
        const sl = runSlot(r, f.rel, 0);
        const n = at(t, sl.at);
        const ref = f.tap
          ? `() => window.open(${r.itemVar}.${f.name}, '_blank', 'noopener')`
          : `${r.itemVar}.${f.name}`;
        if (sl.kind === "inst") {
          if (!runInst.has(n)) runInst.set(n, new Map());
          runInst.get(n)!.set(sl.inner, ref);
          continue;
        }
        const name: SlotName = sl.kind === "attr" ? `attr:${sl.attr}` : sl.kind === "tap" ? "tap" : "text";
        if (!slotAt.has(n)) slotAt.set(n, new Map());
        slotAt.get(n)!.set(name, { name: ref, type: f.tap ? "handler" : "string", slot: sl, doc: "" });
      }
    }
    const writing = new Set<IrNode>();

    // the class table: per look, the classes of every element whose classes differ between looks (`v.title`), the
    // look of every nested instance whose look differs from this one's (`v.picture`), nested instances' classes that
    // follow the look (`v.pictureClass`)
    type Look = SharedComponent["variants"][number];
    const entries: Array<{ key: string; value: (v: Look) => string }> = [];
    const tableKey = new Map<IrElement, string>(),
      lookKey = new Map<IrElement, string>(),
      classKey = new Map<IrElement, string>();
    const shared = new Map<IrElement, string[]>();
    if (multi) {
      const keys = createNamer("");
      const nodeIn = (v: Look, path: number[]) => at(v.template, path) as IrElement;
      const visit = (n: IrElement, path: number[]) => {
        const nodes = c.variants.map((v) => nodeIn(v, path));
        if (path.length && swapped.has(n)) return;
        if ((runItem.get(n)?.k ?? 0) > 0) return;
        // (a run item with its own classes as data: no table entry of its own, its children still)
        if (runItem.get(n)?.run.fields.some((f) => f.cls)) {
          n.children.forEach((ch, i) => {
            if (ch.kind === "el") visit(ch, [...path, i]);
          });
          return;
        }
        if (path.length && instanceOf.has(n)) {
          const inner = instanceOf.get(n)!;
          const base = camel(inner.name.replace(/\d+$/, ""));
          const looks = nodes.map((x) => inner.variantOf.get(x));
          if (
            inner.variants.length > 1 &&
            !inner.responsive &&
            !same(looks) &&
            !c.variants.every((v, i) => looks[i] === v.name)
          ) {
            const key = keys(base);
            lookKey.set(n, key);
            entries.push({ key, value: (v) => inner.variantOf.get(nodeIn(v, path))! });
          }
          const cls = c.byVariant.find((sl) => sl.kind === "inst" && sl.at.join(".") === path.join("."));
          if (cls) {
            const key = keys(`${base}Class`);
            classKey.set(n, key);
            entries.push({ key, value: (v) => valueOf(cls, v.template) as string });
          }
          return;
        }
        if (n.raw !== undefined) return;
        if (!path.length) {
          if (c.variants.some((v) => c.variantCommon.get(v.name)!.length)) {
            tableKey.set(n, keys("root"));
            entries.push({ key: "root", value: (v) => c.variantCommon.get(v.name)!.join(" ") });
          }
        } else if (!same(nodes.map((x) => classesOf(x).classes.join(" ")))) {
          const key = keys(elementKey(n)),
            common = intersect(nodes.map((x) => classesOf(x).classes));
          tableKey.set(n, key);
          shared.set(n, common);
          entries.push({
            key,
            value: (v) =>
              classesOf(nodeIn(v, path))
                .classes.filter((k) => !common.includes(k))
                .join(" "),
          });
        }
        n.children.forEach((ch, i) => {
          if (ch.kind === "el") visit(ch, [...path, i]);
        });
      };
      visit(t, []);
    }

    // a responsive component: a table entry is its looks' classes, each under its look's media range
    const ranged = (key: string, menu?: boolean): string => {
      const e = entries.find((x) => x.key === key)!;
      return c.variants
        .filter((v) => menu === undefined || v.name.startsWith("menu-") === menu)
        .flatMap((v) =>
          e
            .value(v)
            .split(/\s+/)
            .filter(Boolean)
            .map((k) => `${c.responsive!.get(v.name)}${k}`),
        )
        .join(" ");
    };
    /** a table entry as class expression: ranged classes, or (looks in menus) the menu's or the page's */
    const rangedExpr = (key: string): string =>
      c.menuLooks
        ? `inMenu ? ${jsString(ranged(key, true))} : ${jsString(ranged(key, false))}`
        : jsString(ranged(key));
    const nested = new Set<SharedComponent>();
    let usesCn = false;
    const eo: ReactEmitOptions = { ...o, cssRules, cssPrefix: prefix, resolveTarget: undefined };
    const variantOfInner = (n: IrElement, inner: SharedComponent) =>
      multi &&
      c.variants.every((v) => inner.variantOf.get(at(v.template, pathFrom(t, n)) as IrElement) === v.name);
    const hooks: JsxHooks = {
      // a design-system component's runs of nested instances whose props are all its own literals: a list
      ...(c.ds
        ? {
            componentOf: (n: IrElement) =>
              n !== t && instanceOf.has(n) && !slotAt.get(n)?.has("node") && !runItem.has(n)
                ? instanceOf.get(n)!.name
                : null,
            list(run: IrElement[]) {
              const comps = run.map((n) => instanceOf.get(n)!);
              if (comps.every((x) => !x.props.length)) return null;
              const node = (x: IrElement) => nodeJsx(x, { ...eo, hooks }, "  ");
              const rows: string[] = [];
              for (const [i, n] of run.entries()) {
                if (lookKey.has(n) || classKey.has(n)) return null;
                const path = pathFrom(t, n).join(".");
                const cells: string[] = [];
                for (const ip of comps[i]!.props) {
                  if (
                    propOf(
                      (p) => p.slot.kind === "inst" && p.slot.inner === ip && p.slot.at.join(".") === path,
                    )
                  )
                    return null;
                  if (ip.type === "variant" && variantOfInner(n, comps[i]!)) return null;
                  if (ip.type === "handler" || ip.type === "expanded") {
                    if (valueOf(ip.slot, n) !== undefined) return null;
                    continue;
                  }
                  const v = dataValue(ip, n, node);
                  if (v !== null) cells.push(`${ip.name}: ${v}`);
                }
                rows.push(`  { ${cells.join(", ")} },`);
              }
              for (const x of comps) nested.add(x);
              lists.types.add(comps[0]!.name);
              return mapOver(run, comps, rows, lists.namer, lists.decls);
            },
          }
        : {}),
      usage(n, pad) {
        // a run's items: the first one is the `.map()`, the others are left out
        const ri = runItem.get(n);
        if (ri && !writing.has(n)) return ri.k > 0 ? "" : runJsx(ri.run, n as IrElement, pad);
        // a swapped instance: the caller's
        const node = slotAt.get(n)?.get("node");
        if (node) return `{${node.name}}`;
        if (n === t || !instanceOf.has(n)) return null;
        const inner = instanceOf.get(n)!;
        nested.add(inner);
        const path = pathFrom(t, n).join(".");
        return usage(n, pad, (ip) => {
          // an item of a run: its field
          const rf = runInst.get(n)?.get(ip);
          if (rf) return `{${rf}}`;
          if (ip.type === "variant" && lookKey.has(n)) {
            // a design-system component with one prop per variant axis: this axis' part of the look ('light_lg' → 'light')
            const ax = ip.slot.kind === "variant" ? ip.slot.axis : undefined;
            const ap = ax !== undefined ? inner.ds?.axisProps?.[ax] : undefined;
            return ap
              ? `{v.${lookKey.get(n)}.split('_')[${ax}] as Parameters<typeof ${inner.name}>[0]['${ap.prop}']}`
              : `{v.${lookKey.get(n)}}`;
          }
          if (ip.type === "className" && classKey.has(n))
            return c.responsive
              ? c.menuLooks
                ? `{${rangedExpr(classKey.get(n)!)}}`
                : jsxAttrValue(ranged(classKey.get(n)!))
              : `{v.${classKey.get(n)}}`;
          // the same look as this component's (both named after the breakpoint)
          if (ip.type === "variant" && variantOfInner(n, inner)) {
            // (one prop per axis on the nested set: the axis of the same name of this component's, else its part of the
            // joined look — never the whole 'orange_sm' for a `tone`)
            const ax = ip.slot.kind === "variant" ? ip.slot.axis : undefined;
            const ap = ax !== undefined ? inner.ds?.axisProps?.[ax] : undefined;
            if (ap) {
              const mine = c.ds?.axisProps?.findIndex((p) => p.prop === ap.prop) ?? -1;
              if (mine >= 0) return `{${ap.prop}}`;
              return `{(${c.ds?.look ?? "variant"}.split('_')[${ax}]) as Parameters<typeof ${inner.name}>[0]['${ap.prop}']}`;
            }
            return `{${c.ds?.look ?? "variant"}}`;
          }
          const own = propOf(
            (p) => p.slot.kind === "inst" && p.slot.inner === ip && p.slot.at.join(".") === path,
          );
          // (a prop only some shapes of a design-system component have is optional, though this one always passes it)
          return own
            ? `{${own.name}${optional.has(own.name) && required(ip) ? "!" : ""}}`
            : literal(ip, n, eo, (x) => nodeJsx(x, { ...eo, hooks }, pad), pad);
        });
      },
      bind(n, slot, extra) {
        // a picture whose crop is a prop: its classes without the template's crop, the crop as its style
        const crop = n.kind === "el" ? cropAt.get(n) : undefined;
        if (crop && slot === "style")
          return `${crop.name} ? { ${Object.entries(classesOf(n as IrElement).inline)
            .map(
              ([k, v]) =>
                `${JSON.stringify(k.replace(/-([a-z])/g, (_, x: string) => x.toUpperCase()))}: ${jsString(String(v))}, `,
            )
            .join("")}objectPosition: ${crop.name} } : undefined`;
        if (crop && slot === "class" && !slotAt.get(n)?.get("class") && !tableKey.has(n as IrElement))
          return jsString([...classesOf(n as IrElement).classes, ...(extra ?? [])].join(" "));
        const p = slotAt.get(n)?.get(slot);
        if (slot === "class" && n.kind === "el" && (p || tableKey.has(n))) {
          const fixed = [
            ...(n === t ? c.common : (shared.get(n) ?? runShared.get(n) ?? [])),
            ...(extra ?? []),
            ...(c.responsive && !c.menuLooks && tableKey.has(n) ? [ranged(tableKey.get(n)!)] : []),
          ]
            .filter(Boolean)
            .join(" ");
          const parts = [
            ...(fixed ? [jsString(fixed)] : []),
            ...(tableKey.has(n) && !c.responsive ? [`v.${tableKey.get(n)}`] : []),
            ...(tableKey.has(n) && c.menuLooks ? [`(${rangedExpr(tableKey.get(n)!)})`] : []),
            ...(p ? [p.name] : []),
          ];
          // (one static class string: the layer's own classes, unless it carries a responsive look's ranged ones)
          if (parts.length === 1)
            return parts[0]!.startsWith('"') && !(c.responsive && tableKey.has(n)) && !crop
              ? null
              : parts[0]!;
          usesCn = true;
          return `cn(${parts.join(", ")})`;
        }
        return p ? `${p.name}${p.sometimes ? "?" : ""}` : null;
      },
    };
    /** `{links.map((link) => (<… key={link.href}>…</…>))}`: a run written once over its data (a prop, else a module constant) */
    function runJsx(r: Run, x0: IrElement, pad: string): string {
      // (a list only some shapes take is optional: the shape that renders it always gets it)
      // one item type per field set (another look's items with other fields: a type of their own)
      const sig = (x: Run) =>
        x.fields
          .map((f) => `${f.name}:${f.tsType}:${f.rel.kind === "inst" ? f.rel.inner.name : ""}`)
          .join(",");
      const clash = lists.runs.find((x) => x.itemType === r.itemType && x !== r && sig(x) !== sig(r));
      if (clash) {
        let n = 2;
        while (lists.runs.some((x) => x.itemType === `${r.itemType}${n}`)) n++;
        r.itemType = `${r.itemType}${n}`;
      }
      let data = optional.has(r.name) ? `${r.name}!` : r.name;
      if (!r.varying) {
        // (the same data in another look of the component: one constant)
        const src = `: ${r.itemType}[] = ${rowsSrc(valueOf({ kind: "list", at: r.parent, run: r }, t) as Row[], "", (x) => nodeJsx(x, { ...eo, hooks }, "  "))}`;
        const had = lists.decls.find((d) => d.endsWith(src));
        data = had ? had.slice("const ".length, had.length - src.length) : lists.namer(r.name);
        if (!had) lists.decls.push(`const ${data}${src}`);
      }
      if (!lists.runs.some((x) => x.itemType === r.itemType)) lists.runs.push(r);
      for (const f of r.fields) if (f.rel.kind === "inst") lists.types.add(f.rel.comp.name);
      writing.add(x0);
      let body = emitJsx(x0, { ...eo, hooks }, pad.length / 2 + 1);
      writing.delete(x0);
      const keyAttr = `key={${r.key ? `${r.itemVar}.${r.key}` : "i"}}`;
      // (a tag whose attributes go one per line: the key is the first of them)
      body = /^\s*<[\w.]+\n/.test(body)
        ? body.replace(/^(\s*)(<[\w.]+)\n/, `$1$2\n$1  ${keyAttr}\n`)
        : body.replace(/^(\s*<[\w.]+)/, `$1 ${keyAttr}`);
      return `{${data}.map((${r.itemVar}${r.key ? "" : ", i"}) => (\n${body}\n${pad}))}`;
    }
    const body = emitJsx(t, { ...eo, hooks }, depth);
    const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : jsString(name));
    const tableSrc =
      multi && entries.length && !c.responsive
        ? `const ${table} = {\n${c.variants.map((v) => `  ${key(v.name)}: {\n${entries.map((e) => `    ${e.key}: ${jsString(e.value(v))},`).join("\n")}\n  },`).join("\n")}\n} as const\n\n`
        : "";
    const lookup =
      entries.length && !c.responsive
        ? `${"  ".repeat(depth - 1)}const v = ${table}[${c.ds?.look ?? "variant"}]\n`
        : "";
    return { body, tableSrc, lookup, usesCn, nested, multi: multi && !c.responsive, hasTable: !!tableSrc };
  };

  /** src/components/<name>.tsx: one component, or a design-system component's shapes (the `variant` picks one). */
  const fileOf = (
    name: string,
    shapes: SharedComponent[],
    o: ReactEmitOptions,
    d?: DsComponent,
  ): ComponentFile => {
    const cssRules: string[] = [];
    const prefix = `${slugify(name)}-fx`;
    const several = shapes.length > 1;
    // props: one per name across the shapes, required where every shape requires it
    const props = new Map<string, { p: Prop; required: boolean }>();
    for (const c of shapes)
      for (const p of c.props) {
        const req = required(p);
        const had = props.get(p.name);
        if (!had)
          props.set(p.name, {
            p,
            required: req && shapes.every((x) => x.props.some((q) => q.name === p.name)),
          });
        else if (!req) had.required = false;
      }
    const empty = new Set(shapes.flatMap((c) => c.props.filter((p) => p.emptyDefault).map((p) => p.name)));
    const all = [...props.values()];
    const optional = new Set(all.filter((x) => !x.required || empty.has(x.p.name)).map((x) => x.p.name));
    const tableName = (c: SharedComponent) =>
      several ? `VARIANTS_${c.variants[0]!.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}` : "VARIANTS";
    const lists: ModuleLists = { decls: [], namer: createNamer(""), types: new Set(), runs: [] };
    // (module data never takes a prop's name: a shape's list prop and another shape's constant list)
    for (const c of shapes) for (const p of c.props) lists.namer(p.name);
    const parts = shapes.map((c, i) =>
      emitShape(
        c,
        o,
        cssRules,
        prefix,
        several && i < shapes.length - 1 ? 3 : 2,
        tableName(c),
        several ? optional : undefined,
        lists,
      ),
    );
    const usesCn = parts.some((p) => p.usesCn);
    if (usesCn) cnUsed = true;
    const nested = new Map<string, SharedComponent>();
    for (const p of parts) for (const x of p.nested) if (x.name !== name) nested.set(x.name, x);
    const names = shapes.flatMap((c) => c.variants.map((v) => v.name));
    const look = d?.look ?? "variant",
      lookType = d?.lookType ?? `${name}Variant`;
    const typeOf = (p: Prop) => {
      if (p.type === "variant")
        return p.slot.kind === "variant" && p.slot.axis !== undefined && d?.axisProps
          ? d.axisProps[p.slot.axis]!.type
          : lookType;
      if (p.type !== "list") return TS_TYPE[p.type];
      // its own run's items, else (passed through to a nested component) that component's prop type
      if (p.slot.kind === "list") return `${p.slot.run.itemType}[]`;
      const inner = p.slot.kind === "inst" ? p.slot : null;
      if (!inner) return "unknown[]";
      lists.types.add(inner.comp.name);
      return `${inner.comp.name}Props[${jsString(inner.inner.name).replace(/"/g, "'")}]`;
    };
    const docOf = (p: Prop) =>
      p.type === "variant" && several && !(p.slot.kind === "variant" && p.slot.axis !== undefined)
        ? look === "variant"
          ? `look: ${names.map((v) => `'${v}'`).join(" | ")} (its variants, smallest breakpoint first)`
          : `${look}: ${names.map((v) => `'${v}'`).join(" | ")}`
        : p.doc;

    let fn: string;
    if (!several) {
      const x = parts[0]!;
      fn = `${x.lookup}  return (\n${x.body}\n  )\n`;
    } else {
      fn = parts
        .map((x, i) => {
          if (i === parts.length - 1) return `${x.lookup}  return (\n${x.body}\n  )\n`;
          const cond = shapes[i]!.variants.map((v) => `${look} === ${jsString(v.name)}`).join(" || ");
          return `  if (${cond}) {\n${x.lookup}    return (\n${x.body}\n    )\n  }\n`;
        })
        .join("");
    }
    // a set with several axes: its look joins their props (`lime_sm`)
    if (d?.axisProps && /(?<![.\w$])look\b/.test(fn))
      fn = `  const look = \`${d.axisProps.map((a) => `\${${a.prop}}`).join("_")}\` as ${lookType}\n${fn}`;
    // a design-system component's shapes read their own props: the rest are not destructured
    // (a name read as itself, not as an item's field `link.variant`)
    const sigProps = d ? all.filter((x) => new RegExp(`(?<![.\\w$])${x.p.name}\\b`).test(fn)) : all;
    // the prop types first: a list passed through to a nested component imports that component's Props type
    for (const x of all) typeOf(x.p);
    const react = [
      ...(all.some((x) => x.p.type === "style") || parts.some((x) => x.body.includes("as CSSProperties"))
        ? ["CSSProperties"]
        : []),
      ...(all.some((x) => x.p.type === "node") ||
      lists.runs.some((r) => r.fields.some((f) => f.tsType === "ReactNode" && f.rel.kind !== "inst"))
        ? ["ReactNode"]
        : []),
    ];
    const imports = [
      ...(react.length ? [`import type { ${react.join(", ")} } from 'react'`] : []),
      ...(usesCn ? ["import { cn } from '../lib/cn'"] : []),
      ...[...nested.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((x) => `import ${x}${lists.types.has(x) ? `, { type ${x}Props }` : ""} from './${x}'`),
      ...(cssRules.length ? [`import './${name}.css'`] : []),
    ];
    const looks = names.map((v) => jsString(v).replace(/"/g, "'")).join(" | ");
    const what =
      d && look !== "variant"
        ? `${name}'s ${look} variants`
        : d
          ? `${name}'s looks (its variants, smallest breakpoint first)`
          : `${name}'s looks (the breakpoints it is designed at, smallest first)`;
    let tableSrc = "";
    if (several)
      tableSrc = `${parts.map((x) => x.tableSrc).join("")}/** ${what} */\nexport type ${lookType} = ${looks}\n\n`;
    else if (parts[0]!.multi)
      tableSrc = parts[0]!.hasTable
        ? `/** ${what}: what differs between them */\n${parts[0]!.tableSrc}export type ${lookType} = keyof typeof VARIANTS\n\n`
        : `/** ${what.replace(" (", ": ").replace(/\)$/, "")} */\nexport type ${lookType} = ${looks}\n\n`;
    // the axes' own types (`LineBadgeTone`, `LineBadgeVariant`)
    for (const [i, a] of (d?.axisProps ?? []).entries()) {
      const vals = [...new Set(names.map((n) => n.split("_")[i]!))];
      if (all.some((x) => x.p.slot.kind === "variant" && x.p.slot.axis === i))
        tableSrc += `/** ${name}'s ${a.prop === "variant" ? "breakpoint" : a.prop} values */\nexport type ${a.type} = ${vals.map((v) => `'${v}'`).join(" | ")}\n\n`;
    }
    const iface = all.length
      ? `export interface ${name}Props {\n${all.map(({ p, required }) => `  /** ${docOf(p)} */\n  ${p.name}${required && !empty.has(p.name) ? "" : "?"}: ${typeOf(p)}`).join("\n")}\n}\n\n`
      : "";
    const sig = !all.length
      ? ""
      : sigProps.length
        ? `{ ${sigProps.map(({ p }) => (empty.has(p.name) ? `${p.name} = ''` : p.name)).join(", ")} }: ${name}Props`
        : `_props: ${name}Props`;
    const count = shapes.reduce((s, c) => s + c.occurrences.length, 0);
    const where = count === 1 ? "once" : `${count}×`;
    const head = d
      ? `// ${name} — the design system's “${d.def.name}”${d.def.kind && d.def.kind !== "other" ? ` (${d.def.kind})` : ""}, used ${where}`
      : `// ${name} — used ${where}`;
    // the runs' item types (a field of a nested component: that component's prop type)
    const itemTypes = lists.runs
      .map(
        (r) =>
          `/** one of ${name}'s ${r.name} */\nexport interface ${r.itemType} {\n${r.fields.map((f) => `  ${f.name}: ${f.rel.kind === "inst" && !f.tap ? `${f.rel.comp.name}Props[${jsString(f.rel.inner.name).replace(/"/g, "'")}]` : f.tsType}`).join("\n")}\n}\n\n`,
      )
      .join("");
    const decls = `${itemTypes}${lists.decls.length ? `${lists.decls.join("\n\n")}\n\n` : ""}`;
    const source = `${head}\n${imports.length ? `${imports.join("\n")}\n\n` : ""}${tableSrc}${iface}${decls}export default function ${name}(${sig}) {\n${fn}}\n`;
    return {
      path: `src/components/${name}.tsx`,
      source,
      ...(cssRules.length
        ? { css: `/* ${name}: pseudo elements Tailwind classes cannot express */\n${cssRules.join("\n")}\n` }
        : {}),
    };
  };

  const files = (o: ReactEmitOptions): ComponentFile[] => {
    const out: ComponentFile[] = [];
    const done = new Set<DsComponent>();
    for (const c of components) {
      if (!c.ds) {
        out.push(fileOf(c.name, [c], o));
        continue;
      }
      if (done.has(c.ds)) continue;
      done.add(c.ds);
      out.push(fileOf(c.ds.name, c.ds.shapes, o, c.ds));
    }
    return out;
  };

  const dsReport = (): DsReport => ({
    components: dsComponents.length,
    instances: dsComponents.reduce((s, d) => s + d.shapes.reduce((t, c) => t + c.occurrences.length, 0), 0),
    inline: [...inline],
  });

  return { components, instanceOf, screenHooks, files, usesCn: () => cnUsed, dsComponents, dsReport };
}

/** Short key of an element in a class table: its layer name, else what it is. */
function elementKey(n: IrElement): string {
  const g = goodName(n.name, textOf(n));
  if (g) return camel(g);
  // a box by the copy it holds ("impressum", "cookieEinstellungen")
  const t = textOf(n).replace(/\s+/g, " ").trim();
  const k = t && t.length <= 28 ? asciiCamel(t.split(" ").slice(0, 3).join(" ")) : "";
  if (/^[a-z][A-Za-z0-9]{1,30}$/.test(k) && !JS_RESERVED.has(k)) return k;
  if (n.tag === "img" || n.tag === "figure" || n.tag === "picture") return "image";
  if (n.tag === "svg") return "icon";
  if (n.tag === "a" || n.tag === "button") return n.tag === "a" ? "link" : "button";
  if (n.children.length && n.children.every((c) => c.kind === "text")) return "text";
  return "box";
}

const TS_TYPE: Record<PropType, string> = {
  string: "string",
  handler: "() => void",
  className: "string",
  style: "CSSProperties",
  variant: "string",
  node: "ReactNode",
  expanded: "boolean",
  list: "unknown[]",
  flag: "boolean",
};
const optionalInst = (p: Prop): boolean =>
  p.slot.kind === "inst" &&
  ((p.slot.inner.type !== "string" && p.slot.inner.type !== "list") || optionalInst(p.slot.inner));
/** a prop every use passes */
const required = (p: Prop) =>
  (p.type === "string" || p.type === "variant" || p.type === "list" || (p.type === "node" && !!p.api)) &&
  !p.emptyDefault &&
  !optionalInst(p);

/** `onClick` value of a prototype tap at a screen. */
function handlerOf(i: SceneInteraction, o: ReactEmitOptions): string | null {
  if (i.onTap === "navigate" && i.target) {
    const t = o.resolveTarget ? o.resolveTarget(i.target) : i.target;
    return t ? `{() => onNavigate?.(${jsString(t)})}` : null;
  }
  if (i.onTap === "back") return "{() => onBack?.()}";
  if (i.onTap === "open-url" && i.url) return `{() => window.open(${jsString(i.url)}, '_blank', 'noopener')}`;
  // a menu's opener / close button inside a design-system component: the screen's overlay state (react.ts)
  if ((i.onTap === "open-overlay" || i.onTap === "swap-overlay") && i.target)
    return `{() => setOverlay(${jsString(i.target)})}`;
  if (i.onTap === "close-overlay") return "{() => setOverlay(null)}";
  return null;
}

/* ------------------------------------------------------------------ naming */

/** Globals a component must not shadow (`new Image()`, `Text` nodes…). */
const RESERVED = new Set([
  "Image",
  "Text",
  "Option",
  "Audio",
  "Element",
  "Node",
  "Event",
  "Range",
  "Selection",
  "Comment",
  "Document",
  "Window",
  "Map",
  "Set",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "Error",
  "Function",
  "Symbol",
  "Promise",
  "Proxy",
  "Fragment",
  "Request",
  "Response",
  "Headers",
  "File",
  "Blob",
  "Location",
  "History",
  "Navigator",
  "Screen",
  "Animation",
]);
const JS_RESERVED = new Set([
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
  "key",
  "ref",
  "children",
  "cn",
  "v",
  "variant",
]);

const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const plural = (s: string) =>
  /(s|x|ch|sh)$/.test(s) ? `${s}List` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`;

/** A layer name worth turning into an identifier (lib/layerNames.ts), PascalCase. */
function goodName(name: string | undefined, text?: string): string | null {
  const n = meaningfulLayerName(name, text);
  const p = n ? pascalCase(n, "") : "";
  return p && /^[A-Za-z]/.test(p) ? p : null;
}

/** The name a role gives a subtree when its layer name says nothing. */
function roleName(n: IrElement): string {
  let img = false,
    txt = false,
    svg = false;
  const clickable: IrElement[] = [];
  const walk = (x: IrNode) => {
    if (x.kind === "text") {
      if (x.text.trim()) txt = true;
      return;
    }
    if (x.raw !== undefined || x.tag === "svg") {
      svg = true;
      return;
    } // inline SVG (an <img> where no DOM parser was around)
    if (x.tag === "img" || x.tag === "picture" || x.tag === "video") img = true;
    if (x.tag === "a" || x.tag === "button" || x.attrs.role === "button") clickable.push(x);
    x.children.forEach(walk);
  };
  walk(n);
  if (n.raw !== undefined || n.tag === "svg") return "Icon";
  const click =
    clickable.length === 1 && textOf(clickable[0]!).trim() === textOf(n).trim() ? clickable[0]! : null;
  if (img && txt) return "Card";
  if (click) return click.tag === "a" ? (txt ? "Link" : "IconLink") : txt ? "Button" : "IconButton";
  if (n.tag === "li") return "ListItem";
  if (img) return "Picture";
  if (svg && !txt) return "Icon";
  if (svg && txt) return "IconLabel";
  if (/^h[1-6]$/.test(n.tag) || fontPx(n) >= 24) return "Heading";
  // one line of copy on a filled, rounded box: a pill
  if (
    txt &&
    n.children.length === 1 &&
    (n.style.background || n.style["background-color"]) &&
    n.style["border-radius"]
  )
    return "Badge";
  if (txt) return "TextBlock";
  return "Shape";
}

/** Most used first gets the plain name; names two components would share get the nearest named layer above them
 *  as a prefix (`FooterLink`, `HeaderIcon`), numbers only when that still collides. */
function nameComponents(
  components: SharedComponent[],
  parentOf: (n: IrElement) => IrElement | null,
  reserved: string[] = [],
) {
  // a layer name names the component when every instance has it ("Product card"); names that differ ("More", "Help")
  // describe instances: the role names it then
  const baseOf = (c: SharedComponent) => {
    const t = c.occurrences[0]!;
    const names = new Set(c.occurrences.map((n) => goodName(n.name, textOf(n))));
    const b = (names.size === 1 ? [...names][0] : null) ?? roleName(t);
    return RESERVED.has(b) ? `${b}Block` : b;
  };
  const bases = new Map(components.map((c) => [c, baseOf(c)]));
  const count = new Map<string, number>();
  for (const b of bases.values()) count.set(b, (count.get(b) ?? 0) + 1);
  const context = (c: SharedComponent, base: string): string | null => {
    for (let x = parentOf(c.occurrences[0]!); x; x = parentOf(x)) {
      const g = goodName(x.name, textOf(x));
      if (!g || g === base) continue;
      const humps = g.match(/[A-Z][a-z0-9]*/g) ?? [g];
      const ctx = humps.slice(0, 2).join("");
      return base.startsWith(ctx) ? null : ctx;
    }
    return null;
  };
  const namer = createNamer("");
  for (const r of reserved) namer(r);
  for (const c of [...components].sort(
    (a, b) => b.occurrences.length - a.occurrences.length || b.size - a.size,
  )) {
    const base = bases.get(c)!;
    c.name = namer(count.get(base)! > 1 ? `${context(c, base) ?? ""}${base}` : base);
  }
}

const textOf = (n: IrNode): string => (n.kind === "text" ? n.text : n.children.map(textOf).join(""));
const fontPx = (n: IrElement | undefined) => parseFloat(n?.style["font-size"] ?? "") || 0;

function nameProps(
  c: SharedComponent,
  slots: Slot[],
  valueOf: (s: Slot, n: IrElement) => Val,
  api: ReadonlyMap<Slot, DsApiProp> = new Map(),
): Prop[] {
  const t = c.occurrences[0]!;
  const nodeAt = (path: number[]) => path.reduce<IrNode>((n, i) => (n as IrElement).children[i]!, t);
  const parentOf = (path: number[]) => (path.length ? (nodeAt(path.slice(0, -1)) as IrElement) : undefined);
  const sample = (s: Slot) => {
    const v = valueOf(s, t);
    return typeof v === "string" ? v : "";
  };
  const texts = slots.filter((s) => s.kind === "text");
  const sizes = texts.map((s) => fontPx(textHost(parentOf(s.at)!, t, s.at)));
  const max = Math.max(0, ...sizes);
  const titled = texts.length > 1 && sizes.filter((x) => x === max).length === 1;
  const namer = createNamer("");
  const used = new Set<string>();
  const ident = (base: string) => {
    let b = base;
    if (JS_RESERVED.has(b)) b = `${b}Value`;
    const n = namer(b);
    used.add(b);
    used.add(n);
    return n;
  };
  // the design-system set's API names come first (the props named as in its package), the look prop is its own
  for (const a of c.ds?.api ?? []) namer(a.name);
  if (c.ds && c.ds.look !== "variant") namer(c.ds.look);
  for (const a of c.ds?.axisProps ?? []) namer(a.prop);
  const quote = (s: string) =>
    `"${s.replace(/\s+/g, " ").trim().slice(0, 48)}${s.trim().length > 48 ? "…" : ""}"`;
  // a menu's opener / close button (here or in a nested component) reads as what it does for the screen
  const menuTap = (s: Slot): string | null => {
    const inner = s.kind === "inst" ? s.inner.type : s.kind === "tap" ? "handler" : s.kind;
    if (inner === "expanded") return "menuOpen";
    if (inner !== "handler") return null;
    const tap = c.occurrences.map((n) => valueOf(s, n)).find((v) => v !== undefined) as
      SceneInteraction | undefined;
    return tap?.onTap === "close-overlay"
      ? "onMenuClose"
      : tap?.onTap && OVERLAY_TAPS.has(tap.onTap)
        ? "onMenuClick"
        : null;
  };
  return slots.map((s): Prop => {
    const a = api.get(s);
    const menu = c.ds ? menuTap(s) : null;
    if (menu)
      return {
        name: ident(menu),
        type: menu === "menuOpen" ? "expanded" : "handler",
        slot: s,
        doc:
          menu === "menuOpen"
            ? "the menu it opens is open"
            : menu === "onMenuClose"
              ? "closes the menu"
              : "opens the menu",
      };
    if (a) {
      const v = sample(s);
      const what =
        a.field === "swap"
          ? "the nested component (instance swap)"
          : a.field === "image"
            ? "image file"
            : a.field === "href"
              ? "link target"
              : v
                ? `e.g. ${quote(v)}`
                : "text";
      return {
        name: a.name,
        type: a.field === "swap" ? "node" : "string",
        slot: s,
        doc: `${a.label}: ${what}`,
        api: true,
      };
    }
    switch (s.kind) {
      case "variant":
        return s.axis !== undefined && c.ds?.axisProps
          ? {
              name: c.ds.axisProps[s.axis]!.prop,
              type: "variant",
              slot: s,
              doc: `${c.ds.axisProps[s.axis]!.prop}: ${[...new Set(c.variants.map((v) => v.name.split("_")[s.axis!]))].map((v) => `'${v}'`).join(" | ")}`,
            }
          : c.ds && c.ds.look !== "variant"
            ? {
                name: c.ds.look,
                type: "variant",
                slot: s,
                doc: `${c.ds.look}: ${c.variants.map((v) => `'${v.name}'`).join(" | ")} (the set's ${c.ds.look} variants)`,
              }
            : {
                name: namer("variant"),
                type: "variant",
                slot: s,
                doc: `look: ${c.variants.map((v) => `'${v.name}'`).join(" | ")} (the breakpoints it is designed at, smallest first)`,
              };
      case "class":
        return {
          name: ident("className"),
          type: "className",
          slot: s,
          doc: "position and size of this instance (Tailwind classes)",
        };
      case "style":
        return { name: ident("style"), type: "style", slot: s, doc: "inline styles of this instance" };
      case "tap": {
        const n = nodeAt(s.at) as IrElement;
        const what = s.at.length ? (goodName(n.name, textOf(n)) ?? roleName(n)) : "";
        return {
          name: ident(`on${what}Click`),
          type: "handler",
          slot: s,
          doc: `tap on ${s.at.length ? `the ${camel(what)}` : "it"}`,
        };
      }
      case "expanded": {
        const n = nodeAt(s.at) as IrElement;
        const what = s.at.length ? (goodName(n.name, textOf(n)) ?? roleName(n)) : "";
        return {
          name: ident(what ? `${camel(what)}Expanded` : "expanded"),
          type: "expanded",
          slot: s,
          doc: `the menu ${s.at.length ? `the ${camel(what)}` : "it"} opens is open`,
        };
      }
      case "node": {
        const n = nodeAt(s.at) as IrElement;
        return {
          name: ident(camel(goodName(n.name, textOf(n)) ?? roleName(n))),
          type: "node",
          slot: s,
          doc: "the nested component shown here",
        };
      }
      case "attr": {
        const n = nodeAt(s.at) as IrElement;
        const base =
          (
            {
              src: n.tag === "img" ? "image" : "src",
              srcset: "imageSrcSet",
              alt: "imageAlt",
              poster: "poster",
              href: "href",
              "aria-label": "ariaLabel",
              title: "tooltip",
            } as Record<string, string>
          )[s.attr] ?? camel(pascalCase(s.attr, "value"));
        const v = sample(s);
        const what =
          (
            {
              src: "image file",
              srcset: "image candidates (srcset)",
              alt: "alternative text",
              poster: "poster image",
              href: "link target",
              "aria-label": "accessible name",
              title: "tooltip",
            } as Record<string, string>
          )[s.attr] ?? s.attr;
        return {
          name: ident(base),
          type: "string",
          slot: s,
          doc:
            v && !v.startsWith("data:") && s.attr !== "src" && s.attr !== "srcset" && s.attr !== "poster"
              ? `${what}, e.g. ${quote(v)}`
              : what,
        };
      }
      case "text": {
        const host = textHost(parentOf(s.at)!, t, s.at);
        const i = texts.indexOf(s);
        const clickable = host.tag === "a" || host.tag === "button" || closestClickable(t, s.at);
        const base =
          titled && sizes[i] === max
            ? "title"
            : goodName(host.name, sample(s))
              ? camel(goodName(host.name, sample(s))!)
              : clickable
                ? "label"
                : "text";
        return { name: ident(base), type: "string", slot: s, doc: `e.g. ${quote(sample(s))}` };
      }
      case "list":
        return { name: ident(s.run.name || "items"), type: "list", slot: s, doc: "" };
      case "context":
        return { name: "inMenu", type: "flag", slot: s, doc: "drawn in a menu (its look there)" };
      case "crop":
        return {
          name: ident("imagePosition"),
          type: "string",
          slot: s,
          doc: 'where the picture is cropped (CSS object-position), e.g. "31% 51%"',
        };
      case "inst": {
        const inner = s.inner;
        // a design-system component passing a nested one's prop through: named after the component that has it,
        // by its first word (`cardTitleText`, not `listVerticalCardVerticalTitleText`)
        let own = inner,
          comp = s.comp;
        if (c.ds)
          while (own.slot.kind === "inst") {
            comp = own.slot.comp;
            own = own.slot.inner;
          }
        const make = (ctx: string) =>
          own.name.startsWith("on")
            ? `on${ctx}${own.name.slice(2)}`
            : own.name.toLowerCase().startsWith(ctx.toLowerCase())
              ? own.name
              : `${camel(ctx)}${own.name.charAt(0).toUpperCase()}${own.name.slice(1)}`;
        // (`icon`, not `iconIcon`: a prop that already says what it is; the short name taken: the component's whole name)
        const short = make(
          c.ds ? (comp.name.match(/^[A-Z][a-z]*/)?.[0] ?? comp.name) : comp.name.replace(/\d+$/, ""),
        );
        const base = used.has(short) ? make(comp.name) : short;
        return { name: ident(base), type: inner.type, slot: s, doc: `${s.comp.name}: ${inner.doc}` };
      }
    }
  });
}

/** The element a text node's font comes from: its parent, or a run span's parent (text styles live on the block). */
function textHost(parent: IrElement, root: IrElement, path: number[]): IrElement {
  if (parent.style["font-size"] || path.length < 2) return parent;
  const up = path.slice(0, -2).reduce<IrNode>((n, i) => (n as IrElement).children[i]!, root) as IrElement;
  return up.style["font-size"] ? up : parent;
}
function closestClickable(root: IrElement, path: number[]): boolean {
  let n: IrNode = root;
  for (const i of path) {
    if (n.kind === "el" && (n.tag === "a" || n.tag === "button")) return true;
    n = (n as IrElement).children[i]!;
  }
  return false;
}

/* ------------------------------------------------------------------ design system */

/** API prop target standing for an instance's root layer (whatever the main root's id in each variant). */
const DS_ROOT = "#root";

/**
 * Component and API prop names of a design system's sets, as its packages have them (export/ds/model.ts buildSpec:
 * specNamer, componentApi with content slots, safePropName, in the same order so the names match), with the layer
 * each prop binds to. Names in `reserved` (the pages' components) get a number.
 */
export function dsNames(
  ds: DsInput["designSystem"],
  reserved: Iterable<string> = [],
): Map<string, { name: string; api: DsApiProp[] }> {
  const sets = ds.componentSets ?? [];
  const byId = new Map(sets.map((d) => [d.id, d]));
  const names = specNamer("ds");
  const avoid = new Set(reserved);
  const out = new Map<string, { name: string; api: DsApiProp[] }>();
  const visit = (id: string) => {
    const def = byId.get(id);
    if (!def || out.has(id) || !Object.keys(def.variants).some((k) => def.variants[k])) return;
    const base = names(def.name).name;
    let name = base;
    for (let i = 2; avoid.has(name); i++) name = `${base}${i}`;
    const entry = { name, api: [] as DsApiProp[] };
    out.set(id, entry);
    const roots = new Set(
      Object.values(def.variants)
        .filter(Boolean)
        .map((v) => v.id),
    );
    const taken = new Set<string>();
    // (a list item's copy is no prop of its own: the items' markup is one run, an array prop — Run)
    const api = componentApi(def, ds as SceneDesignSystem, { slots: true }).filter(
      (p) => !(p.item && p.source.kind === "slot"),
    );
    for (const p of api) {
      const prop = safePropName(
        /^[A-Za-z0-9_]+$/.test(p.name) && !/[a-z][A-Z]{2}/.test(p.name)
          ? p.name
          : asciiCamel(p.label || p.name),
        p.type,
        taken,
      );
      const src = p.source;
      let field: DsApiProp["field"] | null = null,
        target = "";
      let slot = false;
      if (src.kind === "slot" && src.field !== "hidden") {
        field = src.field;
        target = src.target;
        slot = true;
      } else if (src.kind === "property") {
        const q = def.properties?.find((x) => x.name === src.property);
        if (q && q.type !== "boolean") {
          field = q.type === "instance-swap" ? "swap" : q.type;
          target = q.target;
        }
      }
      // (variant axes are the `variant` prop; show / hide toggles are looks of their own)
      if (field && prop !== "variant")
        entry.api.push({
          name: prop,
          label: p.label,
          field,
          target: roots.has(target) ? DS_ROOT : target,
          ...(slot ? { slot } : {}),
        });
    }
    // the sets an instance swap offers are named next, as the package's build does
    for (const p of api)
      if (p.type === "instance")
        for (const x of [String(p.default), ...(p.options ?? [])]
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 8))
          visit(x);
  };
  for (const d of sets) visit(d.id);
  return out;
}

function memo<A, R>(f: (a: A) => R): (a: A) => R {
  const m = new Map<A, R>();
  return (a) => {
    if (m.has(a)) return m.get(a)!;
    const r = f(a);
    m.set(a, r);
    return r;
  };
}

/** src/lib/cn.ts: joins a component's own classes with an instance's (`className` prop). */
export const CN_SOURCE = `/** Joins class names, skipping empty ones: \`cn('flex gap-2', className)\`. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
`;
