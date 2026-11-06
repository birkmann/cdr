// Applying a naming plan to a design system and its screens, without an app store. Ported from the earlier project's
// components/library/componentSets.ts (renameComponentSets, movePropsIn) and components/dsflow/ai.ts (retryEntries,
// mergeRetry) as pure functions: (ds, screens, plan) → (ds, screens).
import type { SceneComponentDef, SceneDesignSystem, SceneElement, SceneScreen } from "@harness/protocol";
import { headNounKind } from "./brandKit.js";
import { KIND_CATEGORY, slotKey } from "./catalog.js";
import { ID_SEP } from "./instances.js";
import { isBuiltInName, propLabel, transliterate, type NamingEntry, type NamingPlan } from "./naming.js";

const renameKeys = (props: Record<string, string | boolean>, moves: ReadonlyMap<string, string>) => {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(props)) out[moves.get(k) ?? k] = v;
  return out;
};

/** An element tree with instance property values moved to renamed properties (set id → old → new name). */
export function movePropsIn(
  el: SceneElement,
  propMoves: ReadonlyMap<string, ReadonlyMap<string, string>>,
): SceneElement {
  let cur = el;
  const moves = el.instance ? propMoves.get(el.instance.componentId) : undefined;
  if (moves && el.instance?.props)
    cur = { ...el, instance: { ...el.instance, props: renameKeys(el.instance.props, moves) } };
  const ov = cur.instance?.overrides;
  if (ov && Object.values(ov).some((o) => o?.instance)) {
    const setAt = (key: string): string | undefined => {
      const id = `${cur.id}${ID_SEP}${key}`;
      let hit: SceneElement | undefined;
      const find = (x: SceneElement) => {
        if (hit) return;
        if (x.id === id) {
          hit = x;
          return;
        }
        x.children?.forEach(find);
      };
      cur.children?.forEach(find);
      return hit?.instance?.componentId;
    };
    type Lnk = NonNullable<NonNullable<(typeof ov)[string]>["instance"]>;
    const fixLink = (link: Lnk, setId: string | undefined): Lnk => {
      let out = link;
      const m = setId ? propMoves.get(setId) : undefined;
      if (m && link.props)
        out = { ...out, props: renameKeys(link.props as Record<string, string | boolean>, m) };
      if (link.overrides)
        out = {
          ...out,
          overrides: Object.fromEntries(
            Object.entries(link.overrides).map(([k, o]) => [
              k,
              o?.instance
                ? { ...o, instance: fixLink(o.instance as Lnk, (o.instance as Lnk).componentId) }
                : o,
            ]),
          ),
        };
      return out;
    };
    const next: typeof ov = {};
    for (const [key, o] of Object.entries(ov))
      next[key] = o?.instance
        ? { ...o, instance: fixLink(o.instance as Lnk, (o.instance as Lnk).componentId ?? setAt(key)) }
        : o;
    if (JSON.stringify(next) !== JSON.stringify(ov))
      cur = { ...cur, instance: { ...cur.instance!, overrides: next } };
  }
  if (cur.children) {
    const children = cur.children.map((c) => movePropsIn(c, propMoves));
    if (children.some((c, i) => c !== cur.children![i])) cur = { ...cur, children };
  }
  return cur;
}

/** Apply a validated naming plan: set names, kinds / categories, prop names (instances keep their values), order. */
export function applyNamingPlan(
  ds: SceneDesignSystem,
  screens: SceneScreen[],
  plan: NamingPlan,
): { ds: SceneDesignSystem; screens: SceneScreen[]; renamed: number } {
  const sets0 = ds.componentSets ?? [];
  const want = new Map(plan.sets.filter((c) => sets0.some((d) => d.id === c.id)).map((c) => [c.id, c]));
  const propMoves = new Map<string, Map<string, string>>();
  for (const c of want.values()) {
    const m = new Map<string, string>();
    for (const p of c.props) {
      if (p.ref.kind !== "property") continue;
      const to = (p.label ?? propLabel(p.to)).trim();
      if (to && to !== p.ref.property) m.set(p.ref.property, to);
    }
    if (m.size) propMoves.set(c.id, m);
  }
  let renamed = 0;
  let sets: SceneComponentDef[] = sets0.map((d) => {
    const c = want.get(d.id);
    let next = d;
    if (c?.name?.trim() && c.name.trim() !== d.name) {
      renamed++;
      next = { ...next, name: c.name.trim() };
      const k = headNounKind(next.name, d.kind);
      if (k) next = { ...next, kind: k, category: c.category ?? KIND_CATEGORY[k] };
    }
    if (c?.category && c.category !== next.category) next = { ...next, category: c.category };
    const moves = propMoves.get(d.id);
    if (moves && d.properties)
      next = {
        ...next,
        properties: d.properties.map((p) => (moves.has(p.name) ? { ...p, name: moves.get(p.name)! } : p)),
      };
    const slots = (c?.props ?? []).filter((p) => p.ref.kind !== "property");
    if (slots.length)
      next = {
        ...next,
        propNames: {
          ...(d.propNames ?? {}),
          ...Object.fromEntries(
            slots.map((p) => {
              const ref = p.ref as { target: string; field: "text" | "image" };
              return [slotKey(ref.target, ref.field), (p.label ?? propLabel(p.to)).trim()];
            }),
          ),
        },
      };
    if (propMoves.size)
      next = {
        ...next,
        variants: Object.fromEntries(
          Object.entries(next.variants).map(([k, v]) => [k, movePropsIn(v, propMoves)]),
        ),
      };
    return next;
  });
  if (plan.order?.length) {
    const ids = plan.order.filter((id) => sets.some((d) => d.id === id));
    const at = sets.map((d, i) => (ids.includes(d.id) ? i : -1)).filter((i) => i >= 0);
    const byId = new Map(sets.map((d) => [d.id, d]));
    const out = [...sets];
    at.forEach((slot, i) => (out[slot] = byId.get(ids[i])!));
    sets = out;
  }
  const outScreens = propMoves.size
    ? screens.map((s) => ({ ...s, root: movePropsIn(s.root, propMoves) }))
    : screens;
  return { ds: { ...ds, componentSets: sets }, screens: outScreens, renamed };
}

/** Entries the model should name again: rejected proposals, and sets left on a built-in name. */
export function retryEntries(entries: NamingEntry[], plan: NamingPlan): NamingEntry[] {
  const named = new Set(plan.sets.filter((x) => x.name).map((x) => x.id));
  const bad = new Set(
    plan.rejected
      .map(
        (r) =>
          /^(.*?) → [A-Za-z0-9]+: (not unique|ends in a number|a filler suffix|not a PascalCase|too long|reserved|does not survive|captured page copy|a product, brand or event|a CSS class token|names an? )/.exec(
            r,
          )?.[1],
      )
      .filter((x): x is string => !!x),
  );
  return entries.filter((e) => !named.has(e.id) && (bad.has(e.name) || isBuiltInName(e.name)));
}

/** The retry round's names on top of the first plan. */
export function mergeRetry(plan: NamingPlan, again: NamingPlan): NamingPlan {
  const sets = plan.sets.map((x) => ({ ...x }));
  for (const a of again.sets) {
    if (!a.name) continue;
    const hit = sets.find((x) => x.id === a.id);
    if (hit) hit.name = a.name;
    else sets.push({ id: a.id, from: a.from, name: a.name, props: [] });
  }
  return { ...plan, sets, rejected: [...plan.rejected, ...again.rejected.map((r) => `retry: ${r}`)] };
}

/**
 * Deterministic names for sets still on built-in names (no model, or the model failed): PascalCase from the kind
 * and the built-in name's words, transliterated (no mangled non-ASCII: "Über uns" → "UeberUns"), digits dropped and
 * made unique with a word instead of a number. W3/W4 of the plan.
 */
export function fallbackNames(ds: SceneDesignSystem): NamingPlan {
  const sets = ds.componentSets ?? [];
  const taken = new Set(sets.filter((d) => !isBuiltInName(d.name)).map((d) => d.name));
  const changes: NamingPlan["sets"] = [];
  const pascal = (s: string) =>
    transliterate(s)
      .replace(/[^A-Za-z ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      .join("");
  // what tells two sets of one kind apart, read from the main's structure (never a filler like Alt / Variant / Copy)
  const traits = (d: SceneComponentDef): string[] => {
    const main = d.variants[d.defaultVariant];
    const kinds = new Set<string>();
    const visit = (e: SceneElement) => {
      kinds.add(e.type);
      e.children?.forEach(visit);
    };
    if (main) visit(main);
    const out: string[] = [];
    if (kinds.has("image")) out.push("Media");
    if (kinds.has("icon")) out.push("Icon");
    if (main?.layout?.direction === "row") out.push("Inline");
    else if ((main?.children?.length ?? 0) > 1) out.push("Stacked");
    if (main?.style?.background) out.push("Filled");
    else if (main?.style?.border || main?.style?.borders) out.push("Outlined");
    return [...out, "Compact", "Wide", "Plain", "Strong", "Muted", "Large", "Small", "Bordered"];
  };
  for (const d of sets) {
    if (!isBuiltInName(d.name)) continue;
    const kind = pascal((!d.kind || d.kind === "other" ? "block" : d.kind).replace(/-/g, " "));
    const nameWords = pascal(d.name.split(" / ").slice(1).join(" ").replace(/\d+/g, " "));
    let name = nameWords && !nameWords.endsWith(kind) ? `${nameWords.slice(0, 24)}${kind}` : kind;
    if (!/^[A-Z]/.test(name)) name = `Part${name}`;
    let k = 0;
    const base = name;
    const words = traits(d).filter((w) => !base.includes(w));
    while (taken.has(name)) {
      const w = words[k++];
      name = w ? `${w}${base}` : `${base}${String.fromCharCode(64 + k)}`;
    }
    taken.add(name);
    changes.push({ id: d.id, from: d.name, name, props: [] });
  }
  return { sets: changes, order: null, rejected: [] };
}
