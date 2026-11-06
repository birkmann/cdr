// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Framework-neutral model of a design-system package: per component set a spec (names, typed props, variants) with a
// template (elements, bound props, conditionals, nested components) and its styles per variant, all derived from the
// set's mains through the same DSL → IR conversion the HTML export uses, so a component with its default props
// renders exactly like its main (`instantiate` evaluates a template back to IR; ds.test.ts checks it for every set).
// The React / Lit / Angular emitters (react.ts, lit.ts, angular.ts) print templates; css.ts writes the styles.
import type {
  SceneComponentCategory,
  SceneComponentDef,
  SceneComponentKind,
  SceneDesignSystem,
  SceneElement,
  SceneScreen,
} from "@harness/protocol";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  classifyComponent,
  componentApi,
  KIND_LABELS,
  type ComponentProp,
} from "@harness/extract";
import { buildInstance, ID_SEP, parseVariantKey, pickVariant } from "@harness/extract";
import { dslElementToIr } from "../fromDsl.js";
import { tokenVars, type VarMap } from "../tokens.js";
import { createNamer } from "@harness/scene";
import type { IrElement, IrNode, StyleMap } from "../ir.js";
import { asciiCamel, dsPrefix, layerClass, safePropName, attrName, specNamer } from "./names.js";

/* ------------------------------------------------------------------ template AST */

/** An attribute value / prop value: literal, a prop of the component, or a bundled image (src/assets.ts constant). */
export type AttrVal = { k: "lit"; v: string } | { k: "prop"; p: string } | { k: "asset"; a: string };
type Pseudo = IrElement["pseudo"];

export interface TEl {
  t: "el";
  tag: string;
  svg?: boolean;
  /** class base (layer name) until naming; then the final class name. Absent: no styles on any variant */
  cls?: string;
  root?: boolean;
  attrs: Array<[string, AttrVal]>;
  children: TNode[];
  /** verbatim markup of an inline SVG (what the HTML export writes); `children` hold it parsed, `html` its inner markup when it cannot be parsed */
  raw?: string;
  html?: string;
  /** styles per variant id (only the variants this node is part of) */
  styles: Record<string, StyleMap>;
  pseudo: Record<string, Pseudo>;
}
export interface TText {
  t: "text";
  v: string;
}
/** text content from a prop (its resolved value: given, else the variant's default) */
export interface TProp {
  t: "prop";
  p: string;
}
export type Test = { k: "truthy"; p: string } | { k: "eq"; p: string; v: string } | { k: "v"; vs: string[] };
export interface TIf {
  t: "if";
  test: Test;
  then: TNode[];
  else: TNode[];
}
/** A nested component: its props (literals) and the class that places it (outer layout, per variant). */
export interface TUse {
  t: "use";
  spec: DsSpec;
  props: Record<string, AttrVal | boolean>;
  place?: string;
  placeStyles: Record<string, StyleMap>;
}
export type TNode = TEl | TText | TProp | TIf | TUse;

/* ------------------------------------------------------------------ specs */

export interface SpecProp {
  api: ComponentProp;
  /** identifier in every framework (reserved names renamed, names.ts) */
  name: string;
  /** attribute name (Lit / Angular static attributes) */
  attr: string;
  type: ComponentProp["type"];
  /** TypeScript type */
  tsType: string;
  /** default of the default variant */
  default: string | boolean;
  /** defaults of other variants where their main differs (`title` of the `lg` breakpoint) */
  byVariant: Record<string, string | boolean>;
  /** enum values; instance: component names (`optionIds` parallel: set ids) */
  options?: string[];
  optionIds?: string[];
  axis?: string;
  /** bundled image constant of a data-URL default */
  defaultAsset?: string;
}

export interface SpecVariant {
  id: string;
  key: string;
  values: Record<string, string>;
  /** width the main is laid out at when its own width is relative (the set's previewWidths / design width) */
  width?: number;
  ir: IrElement;
  /** the main with its nested instances materialized */
  tree: SceneElement;
}

export interface DsSpec {
  def: SceneComponentDef;
  name: string;
  file: string;
  tag: string;
  /** root class */
  cls: string;
  category: SceneComponentCategory;
  categoryLabel: string;
  kind: SceneComponentKind;
  kindLabel: string;
  description: string;
  props: SpecProp[];
  variants: SpecVariant[];
  defaultV: string;
  /** the markup (an `if` chain over variant groups when variants differ in structure) */
  template: TNode;
  uses: Set<DsSpec>;
  /** asset constants the template / defaults reference */
  assets: Set<string>;
  /** html / raw content needs innerHTML (Angular: DomSanitizer) */
  usesHtml: boolean;
}

export interface DsModel {
  ds: SceneDesignSystem;
  name: string;
  prefix: string;
  specs: DsSpec[];
  byId: Map<string, DsSpec>;
  vars: VarMap;
  /** constant name → data URL */
  assets: Map<string, string>;
  /** sets that could not become a component (no main) */
  skipped: string[];
}

export interface ModelOptions {
  prefix?: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* ------------------------------------------------------------------ build */

export function buildModel(ds: SceneDesignSystem, o: ModelOptions = {}): DsModel {
  const prefix = o.prefix ?? dsPrefix(ds.name);
  const names = specNamer(prefix);
  const model: DsModel = {
    ds,
    // One plain line: the name lands in code comments, package.json and docs.
    name:
      ds.name
        ?.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .trim()
        .slice(0, 120) || "Design system",
    prefix,
    specs: [],
    byId: new Map(),
    vars: tokenVars(ds.tokens),
    assets: new Map(),
    skipped: [],
  };
  const assetByUrl = new Map<string, string>();
  const assetOf = (url: string) => {
    let a = assetByUrl.get(url);
    if (!a) {
      a = `ASSET_${assetByUrl.size + 1}`;
      assetByUrl.set(url, a);
      model.assets.set(a, url);
    }
    return a;
  };
  const sets = ds.componentSets ?? [];
  const building = new Set<string>();
  const done = new Map<string, DsSpec | null>();
  const specFor = (id: string): DsSpec | null => {
    if (done.has(id)) return done.get(id)!;
    if (building.has(id)) return null;
    const def = sets.find((d) => d.id === id);
    if (!def) return null;
    building.add(id);
    const spec = buildSpec(def, model, names, specFor, assetOf);
    building.delete(id);
    done.set(id, spec);
    if (spec) {
      model.byId.set(id, spec);
    } else model.skipped.push(def.name);
    return spec;
  };
  for (const d of sets) specFor(d.id);
  // catalog order: by category, then kind, then name
  const rank = (s: DsSpec) => CATEGORY_ORDER.indexOf(s.category);
  model.specs = [...model.byId.values()].sort(
    (a, b) => rank(a) - rank(b) || a.kindLabel.localeCompare(b.kindLabel) || a.name.localeCompare(b.name),
  );
  return model;
}

interface Binding {
  field: "text" | "image" | "href" | "hidden" | "swap";
  prop: SpecProp;
}

function buildSpec(
  def: SceneComponentDef,
  model: DsModel,
  names: ReturnType<typeof specNamer>,
  specFor: (id: string) => DsSpec | null,
  assetOf: (url: string) => string,
): DsSpec | null {
  const keys = Object.keys(def.variants).filter((k) => def.variants[k]);
  if (!keys.length) return null;
  const defaultKey = def.variants[def.defaultVariant] ? def.defaultVariant : keys[0]!;
  const n = names(def.name);
  const { category, kind } = classifyComponent(def, model.ds);
  const spec: DsSpec = {
    def,
    ...n,
    category,
    categoryLabel: CATEGORY_LABELS[category] ?? category,
    kind,
    kindLabel: KIND_LABELS[kind] ?? kind,
    description: def.description ?? "",
    props: [],
    variants: [],
    defaultV: "v0",
    template: { t: "text", v: "" },
    uses: new Set(),
    assets: new Set(),
    usesHtml: false,
  };
  // props (componentApi with content slots) under names every framework can take
  const taken = new Set<string>();
  // (a list item's copy stays the main's: one prop per item field would be numbered — as reactComponents.ts dsNames)
  const api = componentApi(def, model.ds, { slots: true }).filter(
    (p) => !(p.item && p.source.kind === "slot"),
  );
  for (const p of api) {
    // a name with letters outside ASCII (`pÜberschrift`) is spelled again from its label (`uberschrift`)
    const name = safePropName(
      /^[A-Za-z0-9_]+$/.test(p.name) && !/[a-z][A-Z]{2}/.test(p.name)
        ? p.name
        : asciiCamel(p.label || p.name),
      p.type,
      taken,
    );
    const sp: SpecProp = {
      api: p,
      name,
      attr: attrName(name),
      type: p.type,
      tsType: "string",
      default: p.default,
      byVariant: {},
    };
    if (p.type === "enum") {
      sp.options = p.options ?? [];
      sp.tsType = sp.options.map((v) => JSON.stringify(v)).join(" | ") || "string";
      if (p.source.kind === "axis") sp.axis = p.source.axis;
    } else if (p.type === "boolean") {
      sp.tsType = "boolean";
      sp.default = p.default === true || p.default === "true";
    } else if (p.type === "instance") {
      // the component that fits a swap: the default first, a handful of alternatives
      const ids = [String(p.default), ...(p.options ?? []).filter((id) => id !== p.default)]
        .filter((id, i, a) => a.indexOf(id) === i)
        .slice(0, 8);
      sp.optionIds = ids;
      sp.options = []; // names resolved after the nested specs are built
    } else sp.default = String(p.default ?? "");
    spec.props.push(sp);
  }
  // instance options → component names (builds those specs first)
  for (const sp of spec.props) {
    if (sp.type !== "instance") continue;
    const pairs = (sp.optionIds ?? [])
      .map((id) => [id, specFor(id)] as const)
      .filter((x): x is readonly [string, DsSpec] => !!x[1]);
    sp.optionIds = pairs.map((x) => x[0]);
    sp.options = pairs.map((x) => x[1].name);
    sp.default = sp.options[0] ?? "";
    sp.tsType = sp.options.length ? sp.options.map((v) => JSON.stringify(v)).join(" | ") : "string";
  }
  const bindings = new Map<string, Binding[]>();
  const bind = (target: string, b: Binding) => bindings.set(target, [...(bindings.get(target) ?? []), b]);
  for (const sp of spec.props) {
    const src = sp.api.source;
    if (src.kind === "slot") bind(src.target, { field: src.field, prop: sp });
    else if (src.kind === "property") {
      const p = def.properties?.find((x) => x.name === src.property);
      if (!p) continue;
      bind(p.target, {
        field:
          sp.type === "boolean"
            ? "hidden"
            : sp.type === "instance"
              ? "swap"
              : sp.type === "image"
                ? "image"
                : sp.type === "link"
                  ? "href"
                  : "text",
        prop: sp,
      });
    }
  }
  const enumProps = spec.props.filter((p) => p.axis);
  // variants: IR of each main, laid out in a column as wide as it was designed
  keys.forEach((key, i) => {
    const values = parseVariantKey(key);
    // nested instances as the canvas shows them (materialized from their current mains)
    const tree = materialize(clone(def.variants[key]!), model.ds);
    // a boolean's target renders when true (and is conditional in the template), whatever the main shows
    const unhide = (e: SceneElement) => {
      const b = bindings.get(e.id);
      if (b?.some((x) => x.field === "hidden") && e.meta?.hidden) {
        e.meta = { ...e.meta };
        delete e.meta.hidden;
      }
      e.children?.forEach(unhide);
    };
    unhide(tree);
    const width = variantWidth(def, key, tree);
    const ir = mainIr(tree, model.ds, width);
    if (!ir) return;
    spec.variants.push({ id: `v${i}`, key, values, ...(width ? { width } : {}), ir, tree });
    if (key === defaultKey) spec.defaultV = `v${i}`;
  });
  if (!spec.variants.length) return null;
  if (!spec.variants.some((v) => v.id === spec.defaultV)) spec.defaultV = spec.variants[0]!.id;
  // per-variant defaults of content props (a breakpoint's own copy)
  for (const v of spec.variants) {
    const tree = def.variants[v.key]!;
    for (const sp of spec.props) {
      const src = sp.api.source;
      if (sp.axis) continue;
      const target =
        src.kind === "slot"
          ? src.target
          : src.kind === "property"
            ? def.properties?.find((x) => x.name === src.property)?.target
            : undefined;
      const el = target ? findEl(tree, target) : undefined;
      if (!el) continue;
      const val = sp.type === "text" ? el.text : sp.type === "image" ? el.image?.src : undefined;
      if (val !== undefined && val !== sp.default && v.id !== spec.defaultV) sp.byVariant[v.id] = val;
      if (v.id === spec.defaultV && val !== undefined && val !== sp.default) sp.default = val;
    }
  }
  for (const sp of spec.props) {
    if (sp.type === "image" && typeof sp.default === "string" && sp.default.startsWith("data:")) {
      sp.defaultAsset = assetOf(sp.default);
      spec.assets.add(sp.defaultAsset);
    }
    for (const [v, val] of Object.entries(sp.byVariant))
      if (typeof val === "string" && val.startsWith("data:")) {
        const a = assetOf(val);
        spec.assets.add(a);
        sp.byVariant[v] = `@asset:${a}`;
      }
  }

  // templates per variant, then one per group of variants sharing their structure
  const perVariant = spec.variants.map((v) => ({
    v,
    t: toTemplate(v, spec, bindings, specFor, assetOf, model),
  }));
  const groups = new Map<string, Array<{ v: SpecVariant; t: TEl }>>();
  for (const x of perVariant) {
    const k = templateKey(x.t);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const merged = [...groups.values()].map((g) => {
    const t = g[0]!.t;
    for (const x of g.slice(1)) mergeInto(t, x.t);
    return { vs: g.map((x) => x.v.id), t };
  });
  // final class names: root = spec class, layers `<root>__<layer>`
  const namer = createNamer("-");
  for (const g of merged) nameClasses(g.t, spec.cls, namer);
  if (merged.length === 1) spec.template = merged[0]!.t;
  else {
    // the default variant's group last (the fallback)
    const order = [...merged].sort(
      (a, b) => (a.vs.includes(spec.defaultV) ? 1 : 0) - (b.vs.includes(spec.defaultV) ? 1 : 0),
    );
    let node: TNode = order[order.length - 1]!.t;
    for (let i = order.length - 2; i >= 0; i--)
      node = { t: "if", test: { k: "v", vs: order[i]!.vs }, then: [order[i]!.t], else: [node] };
    spec.template = node;
  }
  walkT(spec.template, (n) => {
    if (n.t === "use") spec.uses.add(n.spec);
    if (n.t === "el") {
      if (n.html !== undefined) spec.usesHtml = true;
      for (const [, a] of n.attrs) if (a.k === "asset") spec.assets.add(a.a);
    }
    if (n.t === "use")
      for (const a of Object.values(n.props))
        if (typeof a === "object" && a.k === "asset") spec.assets.add(a.a);
  });
  void enumProps;
  return spec;
}

/** A variant's main as the canvas renders it: nested instances rebuilt from their mains. */
export const mainTree = (def: SceneComponentDef, key: string, ds: SceneDesignSystem): SceneElement =>
  materialize(clone(def.variants[key]!), ds);

/** Nested instances rebuilt from their mains (buildInstance), as the canvas renders a main. */
function materialize(e: SceneElement, ds: SceneDesignSystem, root = true): SceneElement {
  if (!root && e.instance) return buildInstance(e, ds);
  if (e.children) e.children = e.children.map((c) => materialize(c, ds, false));
  return e;
}

function findEl(e: SceneElement, id: string): SceneElement | undefined {
  if (e.id === id) return e;
  for (const c of e.children ?? []) {
    const hit = findEl(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Width a variant's main is laid out at: its own px width, else the set's preview width for it. */
function variantWidth(def: SceneComponentDef, key: string, main: SceneElement): number | undefined {
  const w = main.layout?.width;
  if (typeof w === "number") return undefined;
  return def.previewWidths?.[key];
}

/** The stage a main is laid out on (the docs page, the reference render): a column as wide as its preview width. */
export function stageScreen(main: SceneElement, width: number | undefined, background?: string): SceneScreen {
  const w = width ?? (typeof main.layout?.width === "number" ? main.layout.width : 400);
  // room for the main's margins and content that grows past its design height
  const h = (typeof main.layout?.height === "number" ? main.layout.height : 400) + 200;
  return {
    version: 1,
    id: "ds-stage",
    name: "Stage",
    platform: "web",
    width: Math.ceil(w),
    height: Math.ceil(h),
    root: {
      id: "__ds-stage",
      type: "frame",
      name: "Stage",
      layout: { direction: "column", width: "fill", align: "start" },
      ...(background ? { style: { background } } : {}),
      children: [main],
    },
  };
}

function mainIr(main: SceneElement, ds: SceneDesignSystem, width: number | undefined): IrElement | null {
  return dslElementToIr(stageScreen(main, width), main.id, { baseTokens: ds.tokens });
}

/* ------------------------------------------------------------------ IR → template */

function toTemplate(
  v: SpecVariant,
  spec: DsSpec,
  bindings: Map<string, Binding[]>,
  specFor: (id: string) => DsSpec | null,
  assetOf: (url: string) => string,
  model: DsModel,
): TEl {
  const tree = v.tree;
  const dsl = new Map<string, SceneElement>();
  const index = (e: SceneElement) => {
    dsl.set(e.id, e);
    e.children?.forEach(index);
  };
  index(tree);
  // where a text / image / link binding lands in the IR
  const textHost = new Map<IrElement, { prop: SpecProp; literal: string }>();
  const imgHost = new Map<IrElement, SpecProp>();
  const hrefHost = new Map<IrElement, SpecProp>();
  const prepare = (n: IrElement) => {
    for (const b of (n.id ? bindings.get(n.id) : undefined) ?? []) {
      // an avatar draws initials of its text ("Lena Weber" → "LW"): the drawn copy is no plain text binding
      if (b.field === "text") {
        const h = textHostOf(n);
        if (h && dsl.get(n.id!)?.type !== "avatar") textHost.set(h, { prop: b.prop, literal: plainText(h) });
      } else if (b.field === "image") {
        const h = findTag(n, "img");
        if (h) imgHost.set(h, b.prop);
      } else if (b.field === "href") {
        const h = findTag(n, "a");
        if (h) hrefHost.set(h, b.prop);
      }
    }
    n.children.forEach((c) => {
      if (c.kind === "el") prepare(c);
    });
  };
  prepare(v.ir);
  const bindsBelow = (n: IrElement): boolean => {
    let hit = false;
    const w = (x: IrElement) => {
      if (x !== n && x.id && bindings.has(x.id)) hit = true;
      x.children.forEach((c) => {
        if (c.kind === "el") w(c);
      });
    };
    w(n);
    return hit;
  };

  const attrsOf = (n: IrElement): Array<[string, AttrVal]> => {
    const out: Array<[string, AttrVal]> = [];
    for (const [k, val] of Object.entries(n.attrs)) {
      if (
        k.startsWith("data-href") ||
        k.startsWith("data-nav") ||
        k === "data-back" ||
        k === "data-url" ||
        k === "data-transition"
      )
        continue;
      if (k === "src" && imgHost.has(n)) {
        out.push([k, { k: "prop", p: imgHost.get(n)!.name }]);
        continue;
      }
      if (k === "href" && hrefHost.has(n)) {
        out.push([k, { k: "prop", p: hrefHost.get(n)!.name }]);
        continue;
      }
      if ((k === "src" || k === "poster") && val.startsWith("data:")) {
        out.push([k, { k: "asset", a: assetOf(val) }]);
        continue;
      }
      out.push([k, { k: "lit", v: val }]);
    }
    return out;
  };

  const plain = (n: IrElement, root: boolean): TEl => {
    const out: TEl = {
      t: "el",
      tag: n.tag,
      ...(n.svg ? { svg: true } : {}),
      ...(root ? { root: true } : {}),
      attrs: attrsOf(n),
      children: [],
      styles: { [v.id]: { ...n.style } },
      pseudo: n.pseudo ? { [v.id]: clone(n.pseudo) } : {},
    };
    if (root || Object.keys(n.style).length || n.pseudo)
      out.cls = root ? spec.cls : layerClass(n.name, n.tag);
    if (n.raw !== undefined) {
      out.raw = n.raw;
      const parsed = parseSvgMarkup(n.raw);
      if (parsed) {
        out.tag = parsed.tag;
        out.svg = true;
        out.attrs = parsed.attrs.map(([k, x]) => [k, { k: "lit", v: x }]);
        out.children = parsed.children;
        out.styles = { [v.id]: {} };
        out.pseudo = {};
        delete out.cls;
      } else {
        const p = splitOuter(n.raw);
        if (p) {
          out.tag = p.tag;
          out.attrs = p.attrs.map(([k, x]) => [k, { k: "lit", v: x }]);
          out.html = p.inner;
          out.styles = { [v.id]: {} };
          out.pseudo = {};
          delete out.cls;
        }
      }
      return out;
    }
    const th = textHost.get(n);
    if (th) {
      const kids = n.children.some((c) => c.kind === "el");
      out.children = kids
        ? [
            {
              t: "if",
              test: { k: "eq", p: th.prop.name, v: th.literal },
              then: n.children.flatMap((c) => conv(c, false)),
              else: [{ t: "prop", p: th.prop.name }],
            },
          ]
        : [{ t: "prop", p: th.prop.name }];
      return out;
    }
    out.children = n.children.flatMap((c) => conv(c, false));
    return out;
  };

  const conv = (n: IrNode, root: boolean): TNode[] => {
    if (n.kind === "text") return [{ t: "text", v: n.text }];
    const d = n.id ? dsl.get(n.id) : undefined;
    const binds = (n.id ? bindings.get(n.id) : undefined) ?? [];
    let out: TNode[] | null = null;
    if (!root && d?.instance && !bindsBelow(n)) {
      const ns = specFor(d.instance.componentId);
      const usage = ns ? nestedUse(ns, n, d, v, model, assetOf) : null;
      if (usage) out = [usage];
    }
    if (!out) out = [plain(n, root)];
    const swap = binds.find((b) => b.field === "swap");
    if (swap && !root) {
      let node: TNode[] = out;
      const opts = swap.prop.optionIds ?? [];
      for (let i = opts.length - 1; i >= 1; i--) {
        const os = specFor(opts[i]!);
        if (!os) continue;
        node = [
          {
            t: "if",
            test: { k: "eq", p: swap.prop.name, v: os.name },
            then: [
              {
                t: "use",
                spec: os,
                props: {},
                place: layerClass(n.name, n.tag),
                placeStyles: { [v.id]: placementOnly(n.style) },
              },
            ],
            else: node,
          },
        ];
      }
      out = node;
    }
    const hide = binds.find((b) => b.field === "hidden");
    if (hide && !root) out = [{ t: "if", test: { k: "truthy", p: hide.prop.name }, then: out, else: [] }];
    return out;
  };
  return conv(v.ir, true)[0] as TEl;
}

const PLACEMENT =
  /^(position|left|right|top|bottom|inset|z-index|margin(-.*)?|flex(-grow|-shrink|-basis)?|align-self|justify-self|order|grid-(row|column|area).*|width|height|min-width|max-width|min-height|max-height|translate|rotate|transform|scale)$/;
const placementOnly = (s: StyleMap): StyleMap =>
  Object.fromEntries(Object.entries(s).filter(([k]) => PLACEMENT.test(k)));

/**
 * A nested instance as a use of its component: the props its content differs by, when the component renders that
 * content exactly (else null: the markup stays inline). The root's other differences (placement, size) go to the
 * placing class.
 */
function nestedUse(
  ns: DsSpec,
  n: IrElement,
  d: SceneElement,
  v: SpecVariant,
  model: DsModel,
  assetOf: (url: string) => string,
): TUse | null {
  const link = d.instance!;
  const chosen = pickVariant(ns.def, link.variant);
  const values = parseVariantKey(chosen);
  const props: Record<string, AttrVal | boolean> = {};
  const vid = ns.variants.find((x) => x.key === chosen)?.id ?? ns.defaultV;
  for (const p of ns.props) {
    const src = p.api.source;
    let val: string | boolean | undefined;
    if (src.kind === "axis") val = values[src.axis];
    else if (src.kind === "property") {
      const raw = link.props?.[src.property] ?? p.api.default;
      val =
        p.type === "instance"
          ? p.options?.[p.optionIds?.indexOf(String(raw)) ?? -1]
          : p.type === "boolean"
            ? raw === true || raw === "true"
            : String(raw);
    } else {
      const el = findEl(d, `${d.id}${ID_SEP}${src.target}`) ?? findEl(d, src.target);
      if (!el) continue;
      val =
        src.field === "text"
          ? el.text
          : src.field === "image"
            ? el.image?.src
            : src.field === "hidden"
              ? el.meta?.hidden !== true
              : undefined;
    }
    if (val === undefined) continue;
    const def = defaultOf(p, vid);
    if (
      val === def ||
      (typeof def === "string" && def.startsWith("@asset:") && model.assets.get(def.slice(7)) === val)
    )
      continue;
    props[p.name] =
      typeof val === "boolean"
        ? val
        : typeof val === "string" && val.startsWith("data:")
          ? { k: "asset", a: assetOf(val) }
          : { k: "lit", v: val };
  }
  const inst = instantiate(ns, props, model);
  if (canonical(inst, false) !== canonical(n, false)) return null;
  return {
    t: "use",
    spec: ns,
    props,
    place: layerClass(n.name ?? ns.file, n.tag),
    placeStyles: { [v.id]: placementDiff(n.style, inst.style) },
  };
}

/** Declarations that turn `base` into `want` (`revert` for one `want` lacks). */
export function placementDiff(want: StyleMap, base: StyleMap): StyleMap {
  const out: StyleMap = {};
  for (const [k, val] of Object.entries(want)) if (base[k] !== val) out[k] = val;
  for (const k of Object.keys(base)) if (!(k in want)) out[k] = "revert";
  return out;
}

/** A prop's default in a variant (`@asset:NAME` for a bundled image). */
export function defaultOf(p: SpecProp, vid: string): string | boolean {
  if (vid in p.byVariant) return p.byVariant[vid]!;
  return p.defaultAsset ? `@asset:${p.defaultAsset}` : p.default;
}

function textHostOf(n: IrElement): IrElement | null {
  if (n.raw !== undefined) return null;
  if (n.children.some((c) => c.kind === "text")) return n;
  // a text layer with runs (spans) is its own host; a button's label sits in a span
  if (
    n.children.length &&
    n.children.every(
      (c) =>
        c.kind === "el" && (c.tag === "span" || c.tag === "a") && c.children.every((x) => x.kind === "text"),
    ) &&
    /^(p|h\d)$/.test(n.tag)
  )
    return n;
  for (const c of n.children)
    if (c.kind === "el" && c.tag === "span" && c.children.length === 1 && c.children[0]!.kind === "text")
      return c;
  return null;
}
const plainText = (n: IrNode): string => (n.kind === "text" ? n.text : n.children.map(plainText).join(""));
function findTag(n: IrElement, tag: string): IrElement | null {
  if (n.tag === tag) return n;
  for (const c of n.children)
    if (c.kind === "el") {
      const h = findTag(c, tag);
      if (h) return h;
    }
  return null;
}

/* ------------------------------------------------------------------ structure / merge / names */

export function walkT(n: TNode, fn: (n: TNode) => void) {
  fn(n);
  if (n.t === "el") n.children.forEach((c) => walkT(c, fn));
  else if (n.t === "if") {
    n.then.forEach((c) => walkT(c, fn));
    n.else.forEach((c) => walkT(c, fn));
  }
}

/** Structure of a template (everything but styles and class names). */
export function templateKey(n: TNode): string {
  switch (n.t) {
    case "el":
      return `<${n.tag}${n.svg ? " svg" : ""}${n.cls !== undefined ? " c" : ""} ${JSON.stringify(n.attrs)}${n.raw ? ` r${n.raw.length}:${hash(n.raw)}` : ""}${n.html !== undefined ? ` h${hash(n.html)}` : ""}>${n.children.map(templateKey).join("")}</>`;
    case "text":
      return `T${JSON.stringify(n.v)}`;
    case "prop":
      return `P${n.p}`;
    case "if":
      return `?${JSON.stringify(n.test)}{${n.then.map(templateKey).join("")}|${n.else.map(templateKey).join("")}}`;
    case "use":
      return `U${n.spec.name}${JSON.stringify(n.props)}`;
  }
}
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Merge the styles of a template with the same structure into `into`. */
function mergeInto(into: TNode, from: TNode) {
  if (into.t === "el" && from.t === "el") {
    Object.assign(into.styles, from.styles);
    Object.assign(into.pseudo, from.pseudo);
    into.children.forEach((c, i) => mergeInto(c, from.children[i]!));
  } else if (into.t === "if" && from.t === "if") {
    into.then.forEach((c, i) => mergeInto(c, from.then[i]!));
    into.else.forEach((c, i) => mergeInto(c, from.else[i]!));
  } else if (into.t === "use" && from.t === "use") Object.assign(into.placeStyles, from.placeStyles);
}

function nameClasses(n: TNode, root: string, namer: (b: string) => string) {
  walkT(n, (x) => {
    if (x.t === "el" && x.cls !== undefined) x.cls = x.root ? root : `${root}__${namer(x.cls)}`;
    if (x.t === "use" && x.place !== undefined) x.place = `${root}__${namer(`${x.place}-place`)}`;
  });
}

/* ------------------------------------------------------------------ evaluate */

/** Every variant's values for the enum props → variant id (exact match, else the one matching most). */
export function chooseVariant(spec: DsSpec, values: Record<string, string | boolean | undefined>): string {
  const axes = spec.props.filter((p) => p.axis);
  if (spec.variants.length <= 1 || !axes.length) return spec.defaultV;
  const def = spec.variants.find((v) => v.id === spec.defaultV)!;
  const want: Record<string, string> = { ...def.values };
  for (const p of axes) {
    const val = values[p.name];
    if (typeof val === "string") want[p.axis!] = val;
  }
  let best = def,
    score = -1;
  for (const v of spec.variants) {
    let s = 0;
    for (const [a, val] of Object.entries(want)) if (v.values[a] === val) s += 1;
    if (s > score) {
      score = s;
      best = v;
    }
  }
  return best.id;
}

/** Resolved prop values of an instance (given, else its variant's defaults; bundled images as data URLs). */
export function resolveProps(
  spec: DsSpec,
  given: Record<string, AttrVal | boolean | string>,
  model: Pick<DsModel, "assets">,
): { v: string; values: Record<string, string | boolean> } {
  const lit = (x: AttrVal | boolean | string): string | boolean =>
    typeof x === "object" ? (x.k === "asset" ? (model.assets.get(x.a) ?? "") : x.k === "lit" ? x.v : "") : x;
  const flat: Record<string, string | boolean | undefined> = {};
  for (const [k, x] of Object.entries(given)) flat[k] = lit(x);
  const v = chooseVariant(spec, flat);
  const values: Record<string, string | boolean> = {};
  for (const p of spec.props) {
    const d = defaultOf(p, v);
    values[p.name] =
      flat[p.name] ??
      (typeof d === "string" && d.startsWith("@asset:") ? (model.assets.get(d.slice(7)) ?? "") : d);
  }
  return { v, values };
}

/** The IR an instance with these props renders (styles per its variant): the template evaluated. */
export function instantiate(
  spec: DsSpec,
  given: Record<string, AttrVal | boolean | string>,
  model: Pick<DsModel, "assets">,
  opts: { classes?: boolean } = {},
): IrElement {
  const { v, values } = resolveProps(spec, given, model);
  const val = (a: AttrVal): string =>
    a.k === "lit" ? a.v : a.k === "asset" ? (model.assets.get(a.a) ?? "") : String(values[a.p] ?? "");
  const test = (t: Test) =>
    t.k === "truthy"
      ? values[t.p] === true || values[t.p] === "true"
      : t.k === "eq"
        ? values[t.p] === t.v
        : t.vs.includes(v);
  const ev = (n: TNode): IrNode[] => {
    switch (n.t) {
      case "text":
        return [{ kind: "text", text: n.v }];
      case "prop":
        return [{ kind: "text", text: String(values[n.p] ?? "") }];
      case "if":
        return (test(n.test) ? n.then : n.else).flatMap(ev);
      case "use": {
        const inner = instantiate(n.spec, n.props, model, opts);
        const place = n.placeStyles[v] ?? {};
        const style = { ...inner.style };
        for (const [k, x] of Object.entries(place)) {
          if (x === "revert") delete style[k];
          else style[k] = x;
        }
        return [{ ...inner, style }];
      }
      case "el": {
        const attrs = Object.fromEntries(n.attrs.map(([k, a]) => [k, val(a)]));
        if (n.raw !== undefined)
          return [{ kind: "el", tag: "svg", attrs: {}, style: {}, children: [], raw: n.raw }];
        const out: IrElement = {
          kind: "el",
          tag: n.tag,
          attrs,
          style: { ...(n.styles[v] ?? {}) },
          children: n.html !== undefined ? [] : n.children.flatMap(ev),
          ...(n.svg ? { svg: true } : {}),
        };
        if (n.html !== undefined)
          out.raw = `<${n.tag}${Object.entries(attrs)
            .map(([k, x]) => ` ${k}="${x.replace(/"/g, "&quot;")}"`)
            .join("")}>${n.html}</${n.tag}>`;
        if (n.pseudo[v]) out.pseudo = n.pseudo[v];
        if (opts.classes && n.cls) out.name = n.cls;
        return [out];
      }
    }
  };
  return ev(spec.template)[0] as IrElement;
}

/** Comparable form of an IR subtree (no ids / layer names; style keys sorted); `rootStyle: false` leaves the root's style out. */
export function canonical(n: IrNode, rootStyle = true): string {
  const c = (x: IrNode, root: boolean): unknown => {
    if (x.kind === "text") return x.text;
    if (x.raw !== undefined) return { raw: x.raw };
    const attrs = Object.fromEntries(
      Object.entries(x.attrs)
        .filter(([k]) => !/^data-(href|nav|back|url|transition)$/.test(k))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    return [
      x.tag,
      attrs,
      root && !rootStyle ? null : sortObj(x.style),
      x.pseudo
        ? { b: x.pseudo.before && sortObj(x.pseudo.before), a: x.pseudo.after && sortObj(x.pseudo.after) }
        : null,
      x.children.map((k) => c(k, false)),
    ];
  };
  return JSON.stringify(c(n, true));
}
const sortObj = (s: StyleMap) => Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b)));

/* ------------------------------------------------------------------ inline SVG markup */

const VOID_SVG = /\/>$/;
const TOKEN =
  /<!--[\s\S]*?-->|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|[^<]+/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (ENT[e.toLowerCase()] ?? m),
  );
const parseAttrs = (s: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const m of s.matchAll(ATTR)) {
    let k = m[1]!;
    if (k === "xmlns" || k.startsWith("xmlns:") || /^on/i.test(k) || !/^[A-Za-z_][\w:.-]*$/.test(k)) continue;
    if (k === "xlink:href") k = "href";
    out.push([k, decode(m[2] ?? m[3] ?? m[4] ?? "")]);
  }
  return out;
};

/** `<svg …>…</svg>` → an element tree (null: markup a template cannot carry — `<style>`, CDATA, unbalanced tags). */
export function parseSvgMarkup(
  markup: string,
): { tag: string; attrs: Array<[string, string]>; children: TNode[] } | null {
  if (/<style[\s>]|<script[\s>]|<!\[CDATA\[|<!DOCTYPE|<\?|<foreignObject/i.test(markup)) return null;
  const root: TEl = { t: "el", tag: "#root", attrs: [], children: [], styles: {}, pseudo: {} };
  const stack: TEl[] = [root];
  TOKEN.lastIndex = 0;
  const src = markup.trim();
  while (TOKEN.lastIndex < src.length) {
    const m = TOKEN.exec(src);
    if (!m) return null;
    const tok = m[0],
      top = stack[stack.length - 1]!;
    if (tok.startsWith("<!--")) continue;
    if (m[1]) {
      if (stack.length < 2 || top.tag !== m[1]) return null;
      stack.pop();
      continue;
    }
    if (m[2]) {
      const e: TEl = {
        t: "el",
        tag: m[2],
        svg: true,
        attrs: parseAttrs(m[3] ?? "").map(([k, v]) => [k, { k: "lit", v }]),
        children: [],
        styles: {},
        pseudo: {},
      };
      top.children.push(e);
      if (!m[4] && !VOID_SVG.test(tok)) stack.push(e);
      continue;
    }
    if (tok.trim() || /^(text|tspan|textPath|title|desc)$/.test(top.tag))
      top.children.push({ t: "text", v: decode(tok) });
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.children[0]!.t !== "el") return null;
  const svg = root.children[0] as TEl;
  return {
    tag: svg.tag,
    attrs: svg.attrs.map(([k, a]) => [k, (a as { v: string }).v]),
    children: svg.children,
  };
}

/** `<tag attrs>inner</tag>` → parts. */
function splitOuter(markup: string): { tag: string; attrs: Array<[string, string]>; inner: string } | null {
  const m =
    /^\s*<([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/.exec(
      markup,
    );
  if (!m) return null;
  if (m[3]) return { tag: m[1]!, attrs: parseAttrs(m[2] ?? ""), inner: "" };
  const rest = markup.slice(m[0].length);
  const close = new RegExp(`</${m[1]}\\s*>\\s*$`, "i").exec(rest);
  return { tag: m[1]!, attrs: parseAttrs(m[2] ?? ""), inner: close ? rest.slice(0, close.index) : rest };
}
