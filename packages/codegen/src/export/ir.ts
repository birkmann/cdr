// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Export IR: a tiny framework-neutral element tree. DSL screens and rendered template DOM both become IR;
// the HTML, React/Tailwind, prototype and Dev Mode emitters all read IR.
import type { CSSProperties } from "@harness/scene";
import type { SceneInteraction } from "@harness/protocol";

/** kebab-case CSS property → value (already a string with units) */
export type StyleMap = Record<string, string>;

export interface IrElement {
  kind: "el";
  tag: string;
  /** layer name used for semantic class names */
  name?: string;
  /** DSL element id (for element-scoped exports and Dev Mode) */
  id?: string;
  attrs: Record<string, string>;
  style: StyleMap;
  children: IrNode[];
  pseudo?: Partial<Record<"before" | "after", StyleMap>>;
  /** SVG namespace (JSX attribute casing) */
  svg?: boolean;
  interaction?: SceneInteraction;
  /** image credit to collect into ATTRIBUTION.md */
  credit?: { name: string; url: string };
  /** verbatim outer markup the HTML emitter writes instead of this element (sanitised inline SVG, exactly as the
   *  renderer inserts it); other emitters use tag / attrs / children */
  raw?: string;
  /** design-system instance this element is the root of (DSL `instance`): the React export writes it as a use of the
   *  set's component */
  instance?: { componentId: string; variant?: Record<string, string> };
}
export interface IrText {
  kind: "text";
  text: string;
}
export type IrNode = IrElement | IrText;

export const VOID_TAGS = new Set([
  "img",
  "input",
  "hr",
  "br",
  "meta",
  "link",
  "source",
  "area",
  "col",
  "embed",
  "wbr",
]);

export function el(tag: string, init: Partial<Omit<IrElement, "kind" | "tag">> = {}): IrElement {
  return {
    kind: "el",
    tag,
    attrs: init.attrs ?? {},
    style: init.style ?? {},
    children: init.children ?? [],
    ...stripUndef({
      name: init.name,
      id: init.id,
      pseudo: init.pseudo,
      svg: init.svg,
      interaction: init.interaction,
      credit: init.credit,
      raw: init.raw,
    }),
  };
}
export const text = (t: string): IrText => ({ kind: "text", text: t });

function stripUndef<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

const UNITLESS = new Set([
  "opacity",
  "flexGrow",
  "flexShrink",
  "zIndex",
  "fontWeight",
  "lineHeight",
  "WebkitLineClamp",
  "order",
  "flex",
]);
export const kebabProp = (k: string) =>
  k.startsWith("--")
    ? k
    : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/^(webkit|moz|ms)-/, "-$1-");

/** React style object → StyleMap (numbers get px where CSS needs a unit). */
export function styleMapOf(style: CSSProperties): StyleMap {
  const out: StyleMap = {};
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined || v === null || v === "") continue;
    out[kebabProp(k)] = typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v);
  }
  return out;
}

export function walkIr(
  node: IrNode,
  fn: (n: IrElement, parent: IrElement | null) => void,
  parent: IrElement | null = null,
) {
  if (node.kind !== "el") return;
  fn(node, parent);
  node.children.forEach((c) => walkIr(c, fn, node));
}

export function findIr(node: IrNode, id: string): IrElement | null {
  let hit: IrElement | null = null;
  walkIr(node, (n) => {
    if (!hit && n.id === id) hit = n;
  });
  return hit;
}

export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** "a: b; c: d;" for a StyleMap */
export const declarations = (s: StyleMap, sep = " ") =>
  Object.entries(s)
    .map(([k, v]) => `${k}: ${v};`)
    .join(sep);
