// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Static rendering of design-system components: the markup a component renders for some props, with the package's
// classes (the docs page draws every variant with the package CSS, no framework needed), and the showcase every
// package's docs / demo lists: each component in each variant on a stage as wide as it was designed. Pure.
import { VOID_TAGS, escAttr, escHtml, type IrElement } from "../ir.js";
import { resolveVars, type VarMap } from "../tokens.js";
import { luminance } from "@harness/scene";
import { hasPlacement } from "./css.js";
import {
  resolveProps,
  type AttrVal,
  type DsModel,
  type DsSpec,
  type SpecVariant,
  type TNode,
  type Test,
} from "./model.js";

/** HTML of one instance (`assetUrl`: where a bundled image is served; default: its data URL). */
export function renderHtml(
  spec: DsSpec,
  given: Record<string, AttrVal | boolean | string>,
  model: DsModel,
  o: { assetUrl?: (name: string) => string; extraClass?: string } = {},
): string {
  const { v, values } = resolveProps(spec, given, model);
  const byUrl = new Map([...model.assets].map(([k, url]) => [url, k]));
  const src = (x: string) => {
    const a = byUrl.get(x);
    return a && o.assetUrl ? o.assetUrl(a) : x;
  };
  const val = (a: AttrVal): string =>
    a.k === "lit"
      ? a.v
      : a.k === "asset"
        ? o.assetUrl
          ? o.assetUrl(a.a)
          : (model.assets.get(a.a) ?? "")
        : src(String(values[a.p] ?? ""));
  const test = (t: Test) =>
    t.k === "truthy" ? values[t.p] === true : t.k === "eq" ? values[t.p] === t.v : t.vs.includes(v);
  const multi = spec.variants.length > 1;
  const out = (n: TNode): string => {
    switch (n.t) {
      case "text":
        return escHtml(n.v);
      case "prop":
        return escHtml(String(values[n.p] ?? ""));
      case "if":
        return (test(n.test) ? n.then : n.else).map(out).join("");
      case "use":
        return renderHtml(n.spec, n.props, model, {
          ...o,
          extraClass: n.place && hasPlacement(n) ? n.place : undefined,
        });
      case "el": {
        const cls = n.root ? [`${model.prefix}-c`, spec.cls, o.extraClass].filter(Boolean).join(" ") : n.cls;
        const attrs =
          (cls ? ` class="${cls}"` : "") +
          (n.root && multi ? ` data-v="${v}"` : "") +
          n.attrs.map(([k, a]) => ` ${k}="${escAttr(val(a))}"`).join("");
        if (VOID_TAGS.has(n.tag)) return `<${n.tag}${attrs}>`;
        const inner = n.html !== undefined ? n.html : n.children.map(out).join("");
        return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
      }
    }
  };
  return out(spec.template);
}

/** The props selecting one variant (its enum values). */
export function variantProps(spec: DsSpec, variant: SpecVariant): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of spec.props)
    if (p.axis && variant.values[p.axis] !== undefined) out[p.name] = variant.values[p.axis]!;
  return out;
}

/** Width of a variant's stage: its preview width, else its own px width. */
export function stageWidth(variant: SpecVariant): number {
  if (variant.width) return Math.round(variant.width);
  const w = /^([\d.]+)px$/.exec(variant.ir.style.width ?? "");
  return w ? Math.ceil(Number(w[1])) : DEFAULT_STAGE;
}

/** Stage width of a main without a width of its own and no preview width (as stageScreen lays it out). */
export const DEFAULT_STAGE = 400;

/** A stage colour the component reads on: dark when its copy is light, else white. */
export function stageBackground(variant: SpecVariant, vars: VarMap): string {
  const colours: number[] = [];
  const visit = (n: IrElement) => {
    const hasText = n.children.some((c) => c.kind === "text" && c.text.trim());
    if (hasText && n.style.color) colours.push(luminance(resolveVars(n.style.color, vars)));
    n.children.forEach((c) => {
      if (c.kind === "el") visit(c);
    });
  };
  visit(variant.ir);
  if (!colours.length) return "#ffffff";
  // muted copy on a dark theme (#a1a1aa) counts as light
  const light = colours.filter((l) => l > 0.3).length;
  return light > colours.length / 2 ? "#141418" : "#ffffff";
}

export interface ShowcaseItem {
  spec: DsSpec;
  variant: SpecVariant;
  props: Record<string, string>;
  width: number;
  background: string;
  label: string;
}

/** Every component in every variant (docs page, demo apps), in catalog order. */
export function showcase(model: DsModel): ShowcaseItem[] {
  return model.specs.flatMap((spec) =>
    spec.variants.map((variant) => ({
      spec,
      variant,
      props: variantProps(spec, variant),
      width: stageWidth(variant),
      background: stageBackground(variant, model.vars),
      label:
        spec.variants.length > 1
          ? Object.entries(variant.values)
              .map(([a, x]) => `${a}=${x}`)
              .join(", ")
          : "default",
    })),
  );
}
