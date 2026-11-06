// Twin merge: sets that differ only in content ("twins": same kind, same structure in every variant)
// are merged after extraction. The earlier project's `mergeIdentities` needs byte-identical shape keys before extraction, so six
// alike "card content" sections stayed six sets; this pass merges what the lint (`twinGroups`) finds afterwards.
// The most-used set is kept; every instance of the others is pointed at it with its element ids, props and override
// keys remapped, plus content overrides wherever the kept main shows other copy or pictures, so every copy still shows
// exactly what it showed before.
import type { SceneComponentDef, SceneDesignSystem, SceneElement, SceneScreen } from "@harness/protocol";
import { ID_SEP } from "./instances.js";
import { mainShape, twinGroups } from "./structureLint.js";

const CONTENT_FIELDS = ["text", "runs", "image", "svg", "icon", "value", "placeholder"] as const;

function usesOf(sets: SceneComponentDef[], screens: SceneScreen[]): Map<string, number> {
  const n = new Map<string, number>();
  const visit = (e: SceneElement) => {
    if (e.instance) n.set(e.instance.componentId, (n.get(e.instance.componentId) ?? 0) + 1);
    e.children?.forEach(visit);
  };
  for (const s of screens) visit(s.root);
  for (const d of sets) for (const v of Object.values(d.variants)) visit(v);
  return n;
}

/** Same variant keys and the same structure in each variant: a merge cannot change what any copy looks like. */
function mergeable(a: SceneComponentDef, b: SceneComponentDef): boolean {
  const ka = Object.keys(a.variants).sort(),
    kb = Object.keys(b.variants).sort();
  return (
    ka.length === kb.length &&
    ka.every((k, i) => k === kb[i] && mainShape(a.variants[k]) === mainShape(b.variants[k]))
  );
}

/** from-main element id → into-main element id (`#root` for the roots), walked in parallel. */
function idMap(from: SceneComponentDef, into: SceneComponentDef): Map<string, string> {
  const map = new Map<string, string>();
  for (const k of Object.keys(from.variants)) {
    const walk = (a: SceneElement, b: SceneElement, root: boolean) => {
      map.set(a.id, root ? "#root" : b.id);
      (a.children ?? []).forEach((c, i) => {
        const d = b.children?.[i];
        if (d) walk(c, d, false);
      });
    };
    walk(from.variants[k], into.variants[k], true);
  }
  return map;
}

/** Content the kept main shows differently: override key → fields with the merged set's values. */
function contentDiffs(
  from: SceneComponentDef,
  into: SceneComponentDef,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const k of Object.keys(from.variants)) {
    const walk = (a: SceneElement, b: SceneElement, root: boolean) => {
      const key = root ? "#root" : b.id;
      for (const f of CONTENT_FIELDS) {
        const va = (a as unknown as Record<string, unknown>)[f];
        const vb = (b as unknown as Record<string, unknown>)[f];
        if (JSON.stringify(va) !== JSON.stringify(vb)) out.set(key, { ...out.get(key), [f]: va ?? null });
      }
      (a.children ?? []).forEach((c, i) => {
        const d = b.children?.[i];
        if (d) walk(c, d, false);
      });
    };
    walk(from.variants[k], into.variants[k], true);
  }
  return out;
}

const remapKey = (key: string, ids: Map<string, string>) =>
  key
    .split(ID_SEP)
    .map((seg, i, all) => (i === all.length - 1 || all.length === 1 ? (ids.get(seg) ?? seg) : seg))
    .join(ID_SEP);

export interface TwinMerge {
  ds: SceneDesignSystem;
  screens: SceneScreen[];
  merged: { from: string; into: string }[];
}

/** Merge every twin group the lint would report (exact structure in every variant only). */
export function mergeTwins(ds: SceneDesignSystem, screens: SceneScreen[]): TwinMerge {
  let sets = [...(ds.componentSets ?? [])];
  const merged: TwinMerge["merged"] = [];
  const uses = usesOf(sets, screens);
  const rewrites: {
    from: SceneComponentDef;
    into: SceneComponentDef;
    ids: Map<string, string>;
    props: Map<string, string>;
    content: Map<string, Record<string, unknown>>;
  }[] = [];
  for (const group of twinGroups(sets)) {
    const ordered = [...group].sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0));
    let keeper = ordered[0];
    for (const from of ordered.slice(1)) {
      if (!mergeable(from, keeper)) continue;
      const ids = idMap(from, keeper);
      // props: the same target keeps the kept set's prop; a target only the merged set exposed becomes a new prop
      const props = new Map<string, string>();
      const kept = [...(keeper.properties ?? [])];
      for (const p of from.properties ?? []) {
        const target =
          ids.get(p.target) === "#root"
            ? keeper.variants[keeper.defaultVariant].id
            : (ids.get(p.target) ?? p.target);
        const same = kept.find((k) => k.target === target && k.type === p.type);
        if (same) props.set(p.name, same.name);
        else {
          let name = p.name;
          for (let i = 0; kept.some((k) => k.name === name); i++) name = `${p.name} ${"ABCDEFGH"[i] ?? i}`;
          kept.push({ ...p, name, target });
          props.set(p.name, name);
        }
      }
      keeper = { ...keeper, properties: kept.length ? kept : keeper.properties };
      sets = sets.map((d) => (d.id === keeper.id ? keeper : d));
      rewrites.push({ from, into: keeper, ids, props, content: contentDiffs(from, keeper) });
      merged.push({ from: from.id, into: keeper.id });
    }
  }
  if (!rewrites.length) return { ds, screens, merged };
  const byFrom = new Map(rewrites.map((r) => [r.from.id, r]));
  const rewrite = (e: SceneElement): SceneElement => {
    let cur = e;
    const r = e.instance ? byFrom.get(e.instance.componentId) : undefined;
    if (r && e.instance) {
      const overrides: NonNullable<NonNullable<SceneElement["instance"]>["overrides"]> = {};
      for (const [k, v] of Object.entries(e.instance.overrides ?? {})) overrides[remapKey(k, r.ids)] = v;
      // content the kept main shows otherwise: this copy keeps its own (an override it already has wins)
      for (const [k, fields] of r.content) {
        const have = (overrides[k] ?? {}) as Record<string, unknown>;
        const add = Object.fromEntries(Object.entries(fields).filter(([f]) => !(f in have)));
        if (Object.keys(add).length) overrides[k] = { ...have, ...add } as never;
      }
      const props = e.instance.props
        ? Object.fromEntries(Object.entries(e.instance.props).map(([k, v]) => [r.props.get(k) ?? k, v]))
        : undefined;
      const prefix = `${e.id}${ID_SEP}`;
      const reid = (c: SceneElement): SceneElement => ({
        ...c,
        id: c.id.startsWith(prefix) ? prefix + remapKey(c.id.slice(prefix.length), r.ids) : c.id,
        ...(c.children ? { children: c.children.map(reid) } : {}),
      });
      cur = {
        ...e,
        instance: {
          ...e.instance,
          componentId: r.into.id,
          ...(props ? { props } : {}),
          overrides,
        },
        ...(e.children ? { children: e.children.map(reid) } : {}),
      };
    }
    return cur.children ? { ...cur, children: cur.children.map(rewrite) } : cur;
  };
  sets = sets
    .filter((d) => !byFrom.has(d.id))
    .map((d) => ({
      ...d,
      variants: Object.fromEntries(Object.entries(d.variants).map(([k, v]) => [k, rewrite(v)])),
    }));
  return {
    ds: { ...ds, componentSets: sets },
    screens: screens.map((s) => ({ ...s, root: rewrite(s.root) })),
    merged,
  };
}
