// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Component sets, variants, properties and instances (PLAN §9.1–9.2). Pure functions over the DSL.
//
// An instance is an element with `instance: { componentId, variant, props, overrides }`. Its children are
// MATERIALIZED from the main component's variant tree: ids are `<instanceId>__<mainElementId>` so they are stable
// across rebuilds. Overrides are keyed by the main element id (`#root` for the instance root) and hold only the
// properties that differ from the main (+ property values). Editing a materialized child anywhere in the app is
// captured back into `overrides` by `captureInstance` before the next rebuild, so no editor needs to know about it.
import type {
  SceneComponentDef,
  SceneDesignSystem,
  SceneElement,
  SceneLayout,
  SceneOverride,
  SceneStyle,
} from "@harness/protocol";

export const ROOT_KEY = "#root";
export const ID_SEP = "__";
export const derivedId = (instanceId: string, mainId: string) => `${instanceId}${ID_SEP}${mainId}`;

type Link = NonNullable<SceneElement["instance"]>;
type Overrides = NonNullable<Link["overrides"]>;
type Additions = NonNullable<Link["additions"]>;

/** Layout keys that belong to the instance's placement, never to the main. */
export const PLACEMENT_KEYS: readonly (keyof SceneLayout)[] = [
  "position",
  "x",
  "y",
  "z",
  "grow",
  "rotation",
  "flipX",
  "flipY",
  "constraints",
];

/* ------------------------------------------------------------------ */
/* Variant keys                                                        */
/* ------------------------------------------------------------------ */

/** `{ size: 'md', state: 'hover' }` → `"size=md,state=hover"` (axis order of the set, else alphabetical). */
export function variantKeyOf(values: Record<string, string>, axes?: Record<string, string[]>): string {
  const keys = axes && Object.keys(axes).length ? Object.keys(axes) : Object.keys(values).sort();
  return keys
    .filter((k) => values[k] !== undefined)
    .map((k) => `${k}=${values[k]}`)
    .join(",");
}

export function parseVariantKey(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of key.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function findDef(ds: SceneDesignSystem, id: string | undefined): SceneComponentDef | undefined {
  return id ? ds.componentSets?.find((d) => d.id === id) : undefined;
}

/** Variant key for the requested axis values: exact match, else the closest variant (most matching axes), else default. */
export function pickVariant(def: SceneComponentDef, requested?: Record<string, string>): string {
  const keys = Object.keys(def.variants);
  const fallback = def.variants[def.defaultVariant] ? def.defaultVariant : (keys[0] ?? def.defaultVariant);
  if (!requested || !Object.keys(requested).length || keys.length <= 1) return fallback;
  const wanted = { ...parseVariantKey(fallback), ...requested };
  const exact = variantKeyOf(wanted, def.variantAxes);
  if (def.variants[exact]) return exact;
  let best = fallback;
  let score = -1;
  for (const k of keys) {
    const v = parseVariantKey(k);
    // requested axes weigh more than the default's
    let s = 0;
    for (const [axis, val] of Object.entries(wanted)) if (v[axis] === val) s += axis in requested ? 10 : 1;
    if (s > score) {
      score = s;
      best = k;
    }
  }
  return best;
}

/** Axes of a set: declared axes, else inferred from the variant keys. */
export function axesOf(def: SceneComponentDef): Record<string, string[]> {
  if (def.variantAxes && Object.keys(def.variantAxes).length) return def.variantAxes;
  const axes: Record<string, string[]> = {};
  for (const k of Object.keys(def.variants))
    for (const [a, v] of Object.entries(parseVariantKey(k))) {
      axes[a] ??= [];
      if (!axes[a].includes(v)) axes[a].push(v);
    }
  return axes;
}

/* ------------------------------------------------------------------ */
/* Structural helpers                                                   */
/* ------------------------------------------------------------------ */

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** A text that is one run of its own text (a link label): a text property can still set it (through the run). */
export const linkedText = (el: SceneElement | undefined): boolean =>
  !!el && typeof el.text === "string" && el.runs?.length === 1 && el.runs[0]!.text === el.text;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>,
    bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined),
    bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

const MERGE_KEYS = new Set(["style", "layout", "meta", "image", "interaction"]);

/**
 * Apply an override / property patch: nested objects (style, layout, meta…) merge, everything else replaces.
 * `null` removes the key (a whole property, or one style / layout / meta key).
 */
export function mergePatch(el: SceneElement, patch: SceneOverride | Partial<SceneElement>): SceneElement {
  const out: Record<string, unknown> = { ...el };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    if (MERGE_KEYS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      const merged: Record<string, unknown> = { ...((out[k] as object | undefined) ?? {}) };
      let removed = false;
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (sv === null) {
          delete merged[sk];
          removed = true;
        } else merged[sk] = clone(sv);
      }
      if (removed && !Object.keys(merged).length) delete out[k];
      else out[k] = merged;
    } else out[k] = clone(v);
  }
  return out as unknown as SceneElement;
}

/* ------------------------------------------------------------------ */
/* Build                                                                */
/* ------------------------------------------------------------------ */

const MAX_DEPTH = 8;

function propertyPatches(def: SceneComponentDef, link: Link): Map<string, SceneOverride> {
  const patches = new Map<string, SceneOverride>();
  const add = (target: string, p: Partial<SceneElement>) =>
    patches.set(target, mergePatch((patches.get(target) ?? {}) as SceneElement, p) as SceneOverride);
  for (const p of def.properties ?? []) {
    const v = link.props?.[p.name] ?? p.default;
    if (p.type === "text") add(p.target, { text: String(v) });
    else if (p.type === "boolean") {
      // shown = no `hidden` key at all (a layer shown by its property looks like one that was never hidden)
      const cur = patches.get(p.target) ?? {};
      patches.set(p.target, {
        ...cur,
        meta: { ...(cur.meta ?? {}), hidden: v === false || v === "false" ? true : null },
      });
    } else if (p.type === "instance-swap" && typeof v === "string" && v)
      add(p.target, { instance: { componentId: v } });
    else if (p.type === "image" && typeof v === "string" && v) add(p.target, { image: { src: v } });
  }
  return patches;
}

/** Overrides that change a nested instance's link (variant / props / component), re-keyed below `rel`. */
function linkOverridesBelow(ov: Overrides, rel: string): Overrides {
  const out: Overrides = {};
  const p = rel + ID_SEP;
  for (const [k, v] of Object.entries(ov))
    if (k.startsWith(p) && v.instance !== undefined) out[k.slice(p.length)] = { instance: v.instance };
  return out;
}

/** Insert `additions` (sorted by index) into a children list. */
function withAdditions(
  children: SceneElement[] | undefined,
  list: Additions[string] | undefined,
): SceneElement[] | undefined {
  if (!list?.length) return children;
  const out = [...(children ?? [])];
  for (const a of [...list].sort((x, y) => x.index - y.index))
    out.splice(Math.max(0, Math.min(out.length, a.index)), 0, clone(a.el));
  return out;
}

/**
 * Materialize an instance: the chosen variant tree with property values and overrides applied, children re-id'd
 * as `<instanceId>__<mainId>`, added layers inserted. Nested instances are built recursively; an override of a nested
 * instance's link (key `inner`, or `inner__deeper` further down) applies before that instance is built.
 * `linkOv` carries such link overrides from an enclosing instance. Unknown components return `inst` unchanged.
 */
export function buildInstance(
  inst: SceneElement,
  ds: SceneDesignSystem,
  depth = 0,
  linkOv: Overrides = {},
): SceneElement {
  const link = inst.instance;
  const def = findDef(ds, link?.componentId);
  if (!link || !def || depth > MAX_DEPTH) return inst;
  const main = def.variants[pickVariant(def, link.variant)];
  if (!main) return inst;
  const prefix = inst.id + ID_SEP;
  const patches = propertyPatches(def, link);
  const ov = link.overrides ?? {};
  // own link overrides first, the enclosing instance's win
  const links: Overrides = {};
  for (const [k, v] of Object.entries(ov))
    if (k !== ROOT_KEY && v.instance !== undefined) links[k] = { instance: v.instance };
  Object.assign(links, linkOv);
  const swapOf = (rel: string) => {
    const p = patches.get(rel);
    return p?.instance?.componentId;
  };
  // interactions that point at layers of the main (a slider's arrows → its track, a tab → its state frame) point at
  // this instance's copies of them
  const mainIds = new Set<string>();
  const collect = (m: SceneElement) => {
    mainIds.add(m.id);
    m.children?.forEach(collect);
  };
  collect(main);
  const idIn = (id: string | undefined) =>
    id !== undefined && mainIds.has(id) ? (id === main.id ? inst.id : prefix + id) : id;

  const copy = (m: SceneElement, isRoot: boolean): SceneElement => {
    const { children, ...rest } = m;
    let el = clone(rest) as SceneElement;
    el.id = isRoot ? inst.id : prefix + m.id;
    if (el.interaction) {
      const i = el.interaction;
      el.interaction = {
        ...i,
        ...(i.target !== undefined ? { target: idIn(i.target) } : {}),
        ...(i.state !== undefined ? { state: idIn(i.state) } : {}),
        ...(i.options ? { options: i.options.map((o) => ({ ...o, state: idIn(o.state)! })) } : {}),
      };
    }
    if (el.states?.active) el.states = { ...el.states, active: idIn(el.states.active) };
    const p = patches.get(m.id);
    if (p) {
      // instance-swap keeps the nested instance's variant/props, only the component changes
      el =
        p.instance && el.instance
          ? {
              ...mergePatch(el, { ...p, instance: undefined }),
              instance: { ...el.instance, componentId: p.instance.componentId },
            }
          : mergePatch(el, p);
      // a linked label (one run: its text + href) shows the property's text through its run
      if (p.text !== undefined && !p.runs && linkedText(m))
        el.runs = [{ ...m.runs![0]!, text: String(p.text) }];
    }
    if (children) el.children = children.map((c) => copy(c, false));
    if (!isRoot && el.instance) {
      const lo = links[m.id]?.instance;
      if (lo === null) delete el.instance;
      else if (lo) el.instance = { ...clone(lo), ...(swapOf(m.id) ? { componentId: swapOf(m.id)! } : {}) };
      if (el.instance) el = buildInstance(el, ds, depth + 1, linkOverridesBelow(links, m.id));
    }
    return el;
  };

  let out = copy(main, true);
  if (out.meta) {
    const meta = { ...out.meta };
    delete meta.componentMain;
    delete meta.componentId;
    delete meta.variantKey;
    out.meta = Object.keys(meta).length ? meta : undefined;
  }
  // the instance root keeps its own identity, placement, interactions and editor meta
  const placement: Partial<SceneLayout> = {};
  for (const k of PLACEMENT_KEYS)
    if (inst.layout?.[k] !== undefined) (placement as Record<string, unknown>)[k] = inst.layout[k];
  out = { ...out, name: inst.name ?? main.name, instance: link, layout: { ...out.layout, ...placement } };
  if (inst.meta) out.meta = { ...inst.meta };
  if (inst.interaction) out.interaction = inst.interaction;
  if (out.layout && !Object.keys(out.layout).length) delete out.layout;

  const adds = link.additions ?? {};
  if (!Object.keys(ov).length && !Object.keys(adds).length) return out;
  const apply = (el: SceneElement): SceneElement => {
    const key = el.id === inst.id ? ROOT_KEY : el.id.startsWith(prefix) ? el.id.slice(prefix.length) : null;
    let next = el;
    if (key && ov[key]) {
      const { instance: lo, ...restOv } = ov[key];
      next = mergePatch(el, key === ROOT_KEY ? restOv : ov[key]);
      // the link was applied before the nested build; a swap property still decides the component
      if (key !== ROOT_KEY && lo && el.instance)
        next = { ...next, instance: { ...clone(lo), ...(swapOf(key) ? { componentId: swapOf(key)! } : {}) } };
    }
    if (next.children) next = { ...next, children: next.children.map(apply) };
    const added = key ? adds[key] : undefined;
    if (added?.length) next = { ...next, children: withAdditions(next.children, added) };
    return next;
  };
  return apply(out);
}

/* ------------------------------------------------------------------ */
/* Capture                                                              */
/* ------------------------------------------------------------------ */

const TEXT_STYLE_KEYS: readonly (keyof SceneStyle)[] = [
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "uppercase",
];

/** Style keys whose values come from a style or variable binding (never captured as overrides). */
function governed(el: SceneElement): {
  style: Set<string>;
  layout: Set<string>;
  text: boolean;
  hidden: boolean;
  borderColor: boolean;
} {
  const style = new Set<string>(),
    layout = new Set<string>();
  let text = false,
    hidden = false,
    borderColor = false;
  for (const path of Object.keys(el.bindings ?? {})) {
    if (path === "text") text = true;
    else if (path === "visible") hidden = true;
    else if (path === "style.border.color") borderColor = true;
    else if (path.startsWith("style.")) style.add(path.slice(6));
    else if (path.startsWith("layout.")) layout.add(path.slice(7));
  }
  if (el.styleRefs?.text) TEXT_STYLE_KEYS.forEach((k) => style.add(k));
  if (el.styleRefs?.fill) {
    style.add("background");
    style.add("gradient");
    if (el.type === "text") style.add("color");
  }
  if (el.styleRefs?.effect) {
    style.add("shadow");
    style.add("blur");
    style.add("shadows");
    style.add("filter");
  }
  return { style, layout, text, hidden, borderColor };
}

const SIMPLE_KEYS: readonly (keyof SceneElement)[] = [
  "name",
  "text",
  "runs",
  "icon",
  "svg",
  "variant",
  "placeholder",
  "value",
  "image",
  "vector",
  "mask",
  "interaction",
  "bindings",
  "styleRefs",
  "instance",
];
const ROOT_SKIP = new Set<string>(["name", "interaction", "instance"]);

/** Properties of `cur` that differ from `base` (the pristine materialized element). */
export function diffElement(base: SceneElement, cur: SceneElement, isRoot = false): SceneOverride | null {
  const out: Record<string, unknown> = {};
  const g = governed(cur);
  const gb = governed(base);
  for (const k of SIMPLE_KEYS) {
    if (isRoot && ROOT_SKIP.has(k)) continue;
    if (k === "text" && (g.text || gb.text)) continue;
    if (!deepEqual(base[k], cur[k])) out[k] = cur[k] === undefined ? null : clone(cur[k]);
  }
  const bs = base.style ?? {},
    cs = cur.style ?? {};
  const style: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(bs), ...Object.keys(cs)])) {
    if (g.style.has(k) || gb.style.has(k)) continue;
    let a = (bs as Record<string, unknown>)[k],
      b = (cs as Record<string, unknown>)[k];
    if (k === "border" && (g.borderColor || gb.borderColor)) {
      a = a ? { ...(a as object), color: undefined } : a;
      b = b ? { ...(b as object), color: undefined } : b;
    }
    if (!deepEqual(a, b)) style[k] = b === undefined ? null : clone((cs as Record<string, unknown>)[k]);
  }
  if (Object.keys(style).length) out.style = style;
  const bl = base.layout ?? {},
    cl = cur.layout ?? {};
  const layout: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(bl), ...Object.keys(cl)])) {
    if (g.layout.has(k) || gb.layout.has(k)) continue;
    if (isRoot && (PLACEMENT_KEYS as readonly string[]).includes(k)) continue;
    const a = (bl as Record<string, unknown>)[k],
      b = (cl as Record<string, unknown>)[k];
    if (!deepEqual(a, b)) layout[k] = b === undefined ? null : clone(b);
  }
  if (Object.keys(layout).length) out.layout = layout;
  if (!isRoot && !g.hidden && !gb.hidden && !!base.meta?.hidden !== !!cur.meta?.hidden)
    out.meta = { hidden: !!cur.meta?.hidden };
  // `null` marks a property the instance removed
  return Object.keys(out).length ? (out as SceneOverride) : null;
}

/**
 * Read the edits made to an instance's materialized children back into `instance.overrides` / `props` / `additions`.
 * Children are matched to the pristine build by id, then (only in lists re-id'd by a duplicate) by position + type.
 * Edits to a text/boolean property's target update the property value instead of creating an override. Layers that
 * are not in the main become `additions`. Changes to a nested instance's link (variant / props / swap) are found
 * first, so the rest is diffed against a pristine build that already shows the nested instance's new variant.
 */
export function captureInstance(inst: SceneElement, ds: SceneDesignSystem): SceneElement {
  const link = inst.instance;
  const def = findDef(ds, link?.componentId);
  if (!link || !def) return inst;
  const props: Record<string, string | boolean> = { ...(link.props ?? {}) };
  const propByTarget = new Map((def.properties ?? []).map((p) => [p.target, p]));
  const build = (overrides: Overrides | undefined) =>
    buildInstance(
      {
        ...inst,
        instance: { ...link, ...(Object.keys(props).length ? { props: { ...props } } : {}), overrides },
      },
      ds,
    );
  let pristine = build(undefined);
  if (pristine === inst) return inst;
  const prefix = inst.id + ID_SEP;
  const relOf = (id: string) =>
    id === inst.id ? ROOT_KEY : id.startsWith(prefix) ? id.slice(prefix.length) : id;
  const addedIds = new Set(
    Object.values(link.additions ?? {})
      .flat()
      .map((a) => a.el.id),
  );

  // phase 1: nested instance links (repeated: a new nested variant may contain further nested instances)
  const linkOv: Overrides = {};
  for (let pass = 0; pass < MAX_DEPTH; pass++) {
    const base = new Map<string, SceneElement>();
    for (const e of elementsOf(pristine)) base.set(e.id, e);
    let changed = false;
    for (const c of elementsOf(inst)) {
      if (c === inst || !c.id.startsWith(prefix)) continue;
      const b = base.get(c.id);
      if (!b || (!b.instance && !c.instance) || deepEqual(b.instance, c.instance)) continue;
      const rel = relOf(c.id);
      // only the component changed where an instance-swap property points: that is the property's value
      const swap = propByTarget.get(rel);
      if (
        swap?.type === "instance-swap" &&
        c.instance &&
        b.instance &&
        !linkOv[rel] &&
        deepEqual({ ...c.instance, componentId: b.instance.componentId }, b.instance)
      ) {
        if (props[swap.name] !== c.instance.componentId) {
          props[swap.name] = c.instance.componentId;
          changed = true;
        }
        continue;
      }
      const v: SceneOverride = { instance: c.instance ? clone(c.instance) : null };
      if (!deepEqual(linkOv[rel], v)) {
        linkOv[rel] = v;
        changed = true;
      }
    }
    if (!changed) break;
    pristine = build(clone(linkOv));
  }

  const ov: Overrides = clone(linkOv);
  const adds: Additions = {};
  let idMatched = false;

  const record = (base: SceneElement, cur: SceneElement, isRoot: boolean) => {
    const d = diffElement(base, cur, isRoot);
    if (!d) return;
    const rel = relOf(base.id);
    // a property may point at the main's root (a button's label): the instance root's edits update it
    const prop =
      propByTarget.get(rel) ??
      (isRoot ? propByTarget.get(def.variants[pickVariant(def, link.variant)]?.id ?? "") : undefined);
    if (prop?.type === "text" && d.text !== undefined) {
      props[prop.name] = d.text ?? "";
      delete d.text;
      // (a linked label's run follows its text: only a run that differs otherwise, another href, stays an override)
      if (
        d.runs !== undefined &&
        linkedText(base) &&
        linkedText(cur) &&
        deepEqual(cur.runs![0], { ...base.runs![0]!, text: cur.text })
      )
        delete d.runs;
    }
    if (prop?.type === "boolean" && d.meta && "hidden" in d.meta) {
      props[prop.name] = !d.meta.hidden;
      delete d.meta;
    }
    if (prop?.type === "image" && d.image && typeof cur.image?.src === "string" && cur.image.src) {
      // the picture is the property's value; what else differs from the main's (alt text…) stays an override
      if (cur.image.src !== base.image?.src) props[prop.name] = cur.image.src;
      const was: Record<string, unknown> = { ...(base.image ?? {}), src: cur.image.src };
      const now = cur.image as Record<string, unknown>;
      const rest: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(was), ...Object.keys(now)]))
        if (!deepEqual(was[k], now[k])) rest[k] = now[k] === undefined ? null : clone(now[k]);
      if (Object.keys(rest).length) d.image = rest as SceneOverride["image"];
      else delete d.image;
    }
    if (
      prop?.type === "instance-swap" &&
      d.instance &&
      d.instance.componentId !== base.instance?.componentId
    ) {
      props[prop.name] = d.instance.componentId;
      const rest = { ...d.instance, componentId: base.instance?.componentId ?? d.instance.componentId };
      if (deepEqual(rest, base.instance)) delete d.instance;
      else d.instance = rest;
    }
    if (Object.keys(d).length) ov[rel] = { ...(ov[rel] ?? {}), ...d };
  };

  const match = (
    parent: SceneElement,
    bases: SceneElement[] | undefined,
    curs: SceneElement[] | undefined,
  ) => {
    if (!bases && !curs) return;
    const bl = bases ?? [];
    const list = curs ?? [];
    const used = new Set<SceneElement>();
    const baseOf = new Map<SceneElement, number>();
    // positional matching only where a duplicate re-id'd the whole list (no derived ids left)
    const reIded = !list.some((x) => x.id.startsWith(prefix) || addedIds.has(x.id));
    bl.forEach((b, i) => {
      let c = list.find((x) => x.id === b.id && !used.has(x));
      if (c) idMatched = true;
      else if (reIded) {
        const cand = list[i];
        if (cand && !used.has(cand) && cand.type === b.type) c = cand;
      }
      const added = addedIds.has(b.id);
      if (!c) {
        if (!added && (idMatched || list.length))
          ov[relOf(b.id)] = { ...(ov[relOf(b.id)] ?? {}), meta: { hidden: true } };
        return;
      }
      used.add(c);
      if (added) return; // re-recorded below with its current content
      baseOf.set(c, i);
      record(b, c, false);
      match(b, b.children, c.children);
    });
    // layers that are not in the main: additions at their position in the rebuilt list
    const order: Array<{ base: number } | { add: SceneElement }> = [];
    for (const x of list) {
      const bi = baseOf.get(x);
      if (bi !== undefined) order.push({ base: bi });
      else if (!x.id.startsWith(prefix)) order.push({ add: x });
    }
    if (!order.some((o) => "add" in o)) return;
    bl.forEach((b, bi) => {
      if (addedIds.has(b.id) || [...baseOf.values()].includes(bi)) return;
      const at = order.findIndex((o) => "base" in o && o.base > bi);
      order.splice(at < 0 ? order.length : at, 0, { base: bi });
    });
    const rel = relOf(parent.id);
    order.forEach((o, index) => {
      if ("add" in o) (adds[rel] ??= []).push({ index, el: clone(o.add) });
    });
  };

  record(pristine, inst, true);
  match(pristine, pristine.children, inst.children);
  const next: Link = { ...link };
  if (Object.keys(ov).length) next.overrides = ov;
  else delete next.overrides;
  if (Object.keys(props).length) next.props = props;
  else delete next.props;
  if (Object.keys(adds).length) next.additions = adds;
  else delete next.additions;
  return deepEqual(next, link) ? inst : { ...inst, instance: next };
}

/** Map a materialized instance subtree back to main-component ids (for "push changes to main"). */
export function toMainTree(inst: SceneElement, mainRootId: string): SceneElement {
  const prefix = inst.id + ID_SEP;
  const go = (el: SceneElement, isRoot: boolean): SceneElement => {
    const { children, ...rest } = el;
    const out = clone(rest) as SceneElement;
    out.id = isRoot ? mainRootId : el.id.startsWith(prefix) ? el.id.slice(prefix.length) : el.id;
    if (isRoot) {
      delete out.instance;
      if (out.layout) {
        for (const k of PLACEMENT_KEYS) delete out.layout[k];
        if (!Object.keys(out.layout).length) delete out.layout;
      }
      delete out.meta;
    }
    if (children) out.children = children.map((c) => go(c, false));
    return out;
  };
  return go(inst, true);
}

/** Every element of a tree, depth-first. */
export function* elementsOf(root: SceneElement): Generator<SceneElement> {
  yield root;
  for (const c of root.children ?? []) yield* elementsOf(c);
}
