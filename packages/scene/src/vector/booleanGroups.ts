// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Live boolean groups (PLAN 7.3): a `type: 'frame'` with `boolean: { op }` whose absolutely positioned children are
// the operands. The combined outline is computed on demand (dsl/BooleanGroup.tsx on the canvas, these helpers for
// exporters and commands); the operands stay editable. Pure, no DOM.
import type { SceneBooleanOp, SceneElement, SceneLayout, SceneStyle, SceneVector } from "@harness/protocol";
import { newElementId } from "../dsl/tree.js";
import { pathBounds, toPath, vectorFields, type Subpath } from "./path.js";
import {
  booleanGroupPaint,
  booleanGroupSubpaths,
  elementShape,
  layoutBox,
  type BoxOf,
  type ElementBox,
} from "./shapes.js";
import { BOOLEAN_LABELS } from "./boolean.js";

export type BooleanGroupElement = SceneElement & { boolean: { op: SceneBooleanOp } };

export const isBooleanGroup = (el: SceneElement | null | undefined): el is BooleanGroupElement =>
  !!el?.boolean;

/** SVG path data of a group's result, in the group's own coordinates. */
export function booleanGroupPath(el: SceneElement, boxOf: BoxOf = layoutBox): string {
  return toPath(booleanGroupSubpaths(el, boxOf));
}

/** The group's result as `SceneVector` fields (geometry + paint), in the group's own coordinates. */
export function booleanGroupVector(el: SceneElement, boxOf: BoxOf = layoutBox): SceneVector {
  const subs = booleanGroupSubpaths(el, boxOf);
  const v: SceneVector = { ...vectorFields(subs), ...booleanGroupPaint(el), fillRule: "nonzero" };
  if (!v.path) v.path = "";
  for (const k of Object.keys(v) as Array<keyof SceneVector>) if (v[k] === undefined) delete v[k];
  return v;
}

/** Style properties that are the group's paint (they become the result's paint, not a box background). */
const PAINT_KEYS: ReadonlyArray<keyof SceneStyle> = [
  "background",
  "gradient",
  "fills",
  "border",
  "borders",
  "radius",
];

/** Layout of the group without auto-layout fields (a boolean group never lays out its operands). */
function boxLayout(l: SceneLayout | undefined): SceneLayout | undefined {
  if (!l) return undefined;
  const {
    direction: _d,
    gap: _g,
    padding: _p,
    align: _a,
    justify: _j,
    wrap: _w,
    grid: _gr,
    crossGap: _c,
    scroll: _s,
    clip: _cl,
    ...rest
  } = l;
  return rest;
}

/**
 * One group → an equivalent flat vector element (same id / name / box / transform / opacity / effects). The vector's
 * local frame is the group's, so nothing moves. Used by exporters (and as the destructive "Flatten" of a group when
 * `freshId` is set).
 */
export function booleanGroupAsVector(
  el: SceneElement,
  opts: { boxOf?: BoxOf; freshId?: boolean } = {},
): SceneElement {
  const style: SceneStyle = { ...el.style };
  for (const k of PAINT_KEYS) delete style[k];
  const out: SceneElement = {
    id: opts.freshId ? newElementId("vector") : el.id,
    type: "vector",
    name: el.name ?? (el.boolean ? BOOLEAN_LABELS[el.boolean.op] : "Vector"),
    ...(el.layout ? { layout: boxLayout(el.layout) } : {}),
    ...(Object.keys(style).length ? { style } : {}),
    vector: booleanGroupVector(el, opts.boxOf),
  };
  if (el.mask) out.mask = true;
  if (el.meta) out.meta = el.meta;
  if (el.interaction) out.interaction = el.interaction;
  if (el.bindings) out.bindings = el.bindings;
  return out;
}

/** Replace every boolean group in a tree by its flat vector (exporters that cannot compute booleans). */
export function flattenBooleanGroups(root: SceneElement, boxOf: BoxOf = layoutBox): SceneElement {
  if (root.boolean) return booleanGroupAsVector(root, { boxOf });
  if (!root.children?.length || !hasBooleanGroup(root)) return root;
  return { ...root, children: root.children.map((c) => flattenBooleanGroups(c, boxOf)) };
}

export function hasBooleanGroup(el: SceneElement): boolean {
  return !!el.boolean || (el.children ?? []).some(hasBooleanGroup);
}

const floor = Math.floor,
  ceil = Math.ceil;

/**
 * Wrap operands (siblings, paint order bottom first, with their boxes in the parent's coordinates) into a new live
 * boolean group. The group box is the integer bounds of the operands' visible outlines; operands become absolute
 * children rebased into the group. Returns null when nothing has an outline.
 */
export function makeBooleanGroup(
  op: SceneBooleanOp,
  operands: Array<{ el: SceneElement; box: ElementBox }>,
  opts: { absolute?: boolean; name?: string } = {},
): BooleanGroupElement | null {
  const outlines: Subpath[] = [];
  for (const o of operands) outlines.push(...elementShape(o.el, o.box).subs);
  const b = pathBounds(outlines);
  if (!b) return null;
  const x = floor(b.x),
    y = floor(b.y);
  const w = Math.max(1, ceil(b.x + b.w) - x),
    h = Math.max(1, ceil(b.y + b.h) - y);
  const children = operands.map(({ el, box }): SceneElement => {
    const {
      constraints: _c,
      grow: _g,
      alignSelf: _a,
      margin: _m,
      colSpan: _cs,
      rowSpan: _rs,
      right: _r,
      bottom: _b,
      ...l
    } = el.layout ?? {};
    return {
      ...el,
      layout: {
        ...l,
        position: "absolute",
        x: round(box.x - x),
        y: round(box.y - y),
        width: round(box.w),
        height: round(box.h),
      },
    };
  });
  const first = operands[0]?.el;
  const group: BooleanGroupElement = {
    id: newElementId("frame"),
    type: "frame",
    name: opts.name ?? BOOLEAN_LABELS[op],
    boolean: { op },
    layout: {
      ...(opts.absolute === false ? {} : { position: "absolute" as const, x, y }),
      width: w,
      height: h,
      ...(first?.layout?.constraints ? { constraints: first.layout.constraints } : {}),
    },
    children,
  };
  return group;
}

const round = (v: number) => Math.round(v * 100) / 100;
