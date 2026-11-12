// One DOM for every width: the page's walks at its variant widths (and the alt walks inside each variant's range) are
// matched by their live-DOM keys (`SnapNode.key`) into one tree. Each node keeps what every walk saw of it, so its CSS
// can be fitted across widths instead of copied per breakpoint.
import type { SnapElement, SnapNode, SnapText, Snapshot } from "@harness/capture";

export interface ModernVariant {
  /** the width the variant was captured at */
  width: number;
  /** where its layout range starts (the page's own breakpoint; 0 for the narrowest) */
  minWidth: number;
  snap: Snapshot;
}

/** One walk of the page at one viewport width: nodes by key, each with its parent in the walk. */
export interface Walk {
  vw: number;
  vh: number;
  byKey: Map<string, SnapNode>;
  parentOf: Map<SnapNode, SnapElement>;
  byId: Map<number, SnapElement>;
}

export interface UNode {
  key: string;
  text: boolean;
  /** the live tag (`#text` for texts) */
  tag: string;
  /** DOM order among its siblings */
  ord: number;
  /** per variant: the node in that variant's main walk (absent: not shown in that range) */
  at: (SnapNode | undefined)[];
  children: UNode[];
  parent?: UNode;
}

export interface Unified {
  root: UNode;
  variants: ModernVariant[];
  /** per variant: its walks, the main walk first */
  walks: Walk[][];
  byKey: Map<string, UNode>;
}

export const isTextNode = (n: SnapNode | undefined): n is SnapText => !!n && n.kind === "text";
export const isEl = (n: SnapNode | undefined): n is SnapElement => !!n && n.kind !== "text";

/** Index one walk: nodes by key and their parents (a box the capture moved for paint order goes back to its parent). */
export function indexWalk(root: SnapElement | null, vw: number, vh: number): Walk {
  const w: Walk = { vw, vh, byKey: new Map(), parentOf: new Map(), byId: new Map() };
  if (!root) return w;
  const stack: SnapElement[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    w.byId.set(n.id, n);
    for (const c of n.children ?? []) if (c.kind !== "text") stack.push(c as SnapElement);
  }
  const visit = (n: SnapNode, parent: SnapElement | undefined) => {
    if (n.key && !w.byKey.has(n.key)) w.byKey.set(n.key, n);
    if (parent) {
      const from = (n as SnapElement).from;
      w.parentOf.set(n, typeof from === "number" && w.byId.get(from) ? w.byId.get(from)! : parent);
    }
    if (n.kind !== "text") for (const c of (n as SnapElement).children ?? []) visit(c, n as SnapElement);
  };
  visit(root, undefined);
  return w;
}

const grafted = new WeakSet<object>();
const clipped = new WeakSet<object>();
/** Texts clipped out of view (`SnapElement.clippedTexts`) back among their box's children, at their DOM place. */
function graftClipped(n: SnapElement) {
  if (clipped.has(n)) return;
  clipped.add(n);
  if (n.clippedTexts?.length) {
    const kids = (n.children ??= []);
    for (const t of n.clippedTexts) {
      const at = kids.findIndex((c) => (c.ord ?? 0) > (t.ord ?? 0));
      kids.splice(at < 0 ? kids.length : at, 0, t);
    }
  }
  for (const c of n.children ?? []) if (c.kind !== "text") graftClipped(c as SnapElement);
}
/** Transparent subtrees (`Snapshot.invisible`) back under their parents, at their DOM place (once per walk). */
export function graftInvisible(snap: {
  root: SnapElement | null;
  invisible?: { parent: string; node: SnapElement }[];
}) {
  if (!snap.root || !snap.invisible?.length || grafted.has(snap)) return;
  grafted.add(snap);
  const byKey = new Map<string, SnapElement>();
  const stack: SnapElement[] = [snap.root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.key) byKey.set(n.key, n);
    for (const c of n.children ?? []) if (c.kind !== "text") stack.push(c as SnapElement);
  }
  for (const { parent, node } of snap.invisible) {
    const p = byKey.get(parent);
    if (!p) continue;
    const kids = (p.children ??= []);
    const at = kids.findIndex((c) => (c.ord ?? 0) > (node.ord ?? 0));
    kids.splice(at < 0 ? kids.length : at, 0, node);
  }
}

/** The variant's walks: its main walk first, then the walks at the other widths of its range. */
export function walksOf(v: ModernVariant): Walk[] {
  graftInvisible(v.snap);
  for (const a of v.snap.alt ?? []) graftInvisible(a);
  if (v.snap.root) graftClipped(v.snap.root);
  for (const a of v.snap.alt ?? []) if (a.root) graftClipped(a.root);
  const main = indexWalk(v.snap.root, v.snap.viewport.width, v.snap.viewport.height);
  const alts = (v.snap.alt ?? []).map((a) =>
    indexWalk(a.root, a.viewport?.width ?? a.width, a.viewport?.height ?? v.snap.viewport.height),
  );
  return [main, ...alts];
}

export class UnifyError extends Error {}

/** Match the variants' walks into one tree (variants ascending by width). */
export function unify(variants: ModernVariant[]): Unified {
  const vs = [...variants].sort((a, b) => a.width - b.width);
  const walks = vs.map(walksOf);
  if (!vs.length || !vs.some((v) => v.snap.root?.key))
    throw new UnifyError("the capture has no DOM keys (it predates them): capture the page again");
  const byKey = new Map<string, UNode>();
  const make = (n: SnapNode, parent: UNode | undefined): UNode => {
    const u: UNode = {
      key: n.key!,
      text: n.kind === "text",
      tag: n.kind === "text" ? "#text" : (n as SnapElement).tag,
      ord: n.ord ?? 0,
      at: vs.map(() => undefined),
      children: [],
      ...(parent ? { parent } : {}),
    };
    byKey.set(u.key, u);
    if (parent) parent.children.push(u);
    return u;
  };
  let root: UNode | undefined;
  vs.forEach((_, vi) => {
    const w = walks[vi]![0]!;
    const visit = (n: SnapNode, parentU: UNode | undefined) => {
      if (!n.key) return;
      let u = byKey.get(n.key);
      // the page moved this box to another parent at this width (a nav built into the header on desktop): a node of
      // its own here, so each parent lays it out where the page does
      if (u && parentU && u.parent && u.parent !== parentU) {
        const alt = `${n.key}@${parentU.key}`;
        u = byKey.get(alt) ?? make({ ...n, key: alt } as SnapNode, parentU);
      }
      if (!u) u = make(n, parentU);
      u.at[vi] = n;
      if (!parentU) root ??= u;
      if (n.kind !== "text")
        for (const c of (n as SnapElement).children ?? []) {
          const p = w.parentOf.get(c);
          // a re-parented box (paint order) is visited under its DOM parent instead
          if (p && p !== n) continue;
          visit(c, u);
        }
      // boxes the capture moved here from below: back under their DOM parent
      if (n.kind !== "text")
        for (const c of (n as SnapElement).children ?? []) {
          const p = w.parentOf.get(c);
          if (p && p !== n) pending.push([c, p]);
        }
    };
    const pending: [SnapNode, SnapElement][] = [];
    if (w.byKey.size && vs[vi]!.snap.root) visit(vs[vi]!.snap.root!, undefined);
    for (let guard = 0; pending.length && guard < 10000; guard++) {
      const [c, p] = pending.shift()!;
      const pu = p.key ? byKey.get(p.key) : undefined;
      if (pu) visit(c, pu);
    }
  });
  if (!root) throw new UnifyError("no page to unify");
  const sort = (u: UNode) => {
    u.children.sort((a, b) => a.ord - b.ord);
    u.children.forEach(sort);
  };
  sort(root);
  return { root, variants: vs, walks, byKey };
}

/** The node in walk `w` and its parent there (absent: not in that walk). */
export function inWalk(w: Walk, key: string): { n: SnapNode; parent?: SnapElement } | undefined {
  const n = w.byKey.get(key.split("@")[0]!);
  if (!n) return undefined;
  const parent = w.parentOf.get(n);
  return { n, ...(parent ? { parent } : {}) };
}

/** Walk the unified tree depth first. */
export function eachNode(u: UNode, f: (u: UNode) => void) {
  f(u);
  for (const c of u.children) eachNode(c, f);
}
