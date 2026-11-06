// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Pieces every design-system package shares: the variant runtime, bundled images, tokens.css + fonts, prop defaults
// as TypeScript expressions, README sections. Pure.
import { SYSTEM_FACES_CSS } from "@harness/scene";
import { tokensCss, type FontFace } from "../tokens.js";
import type { FileMap } from "../bundle.js";
import { themeCss } from "./css.js";
import { defaultOf, type DsModel, type DsSpec, type SpecProp } from "./model.js";

export type DsFont = FontFace & { data: Uint8Array };

export const js = (v: unknown) => JSON.stringify(v);

/** TypeScript runtime of a package: which variant the enum props select (exact match, else the closest one). */
export const VARIANTS_TS = `// Which variant of a component its props select: the exact match, else the one sharing the most values.
export interface VariantDef { id: string; values: Readonly<Record<string, string>> }

export function pickVariant(list: readonly VariantDef[], fallback: string, want: Readonly<Record<string, string | undefined>>): string {
  const base = list.find((v) => v.id === fallback) ?? list[0]
  if (!base) return fallback
  const wanted: Record<string, string> = { ...base.values }
  for (const [k, v] of Object.entries(want)) if (typeof v === 'string') wanted[k] = v
  let best = base
  let score = -1
  for (const v of list) {
    let s = 0
    for (const [k, x] of Object.entries(wanted)) if (v.values[k] === x) s += 1
    if (s > score) { score = s; best = v }
  }
  return best.id
}

/** class names, falsy ones left out */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}
`;

/** \`[{ id: 'v0', values: { size: 'md' } }, …]\` of a set with more than one variant. */
export const variantTable = (spec: DsSpec) =>
  `[\n${spec.variants.map((v) => `  { id: ${js(v.id)}, values: ${js(v.values)} },`).join("\n")}\n]`;

/** Does the template look at the variant (more than one, selected by enum props)? */
export const hasVariants = (spec: DsSpec) => spec.variants.length > 1;

/** The resolved value of a prop: given, else its default in the selected variant (`v`). */
export function defaultExpr(spec: DsSpec, p: SpecProp, v = "v"): string {
  const lit = (x: string | boolean) =>
    typeof x === "string" && x.startsWith("@asset:") ? x.slice(7) : js(x);
  const base = lit(defaultOf(p, spec.defaultV));
  const own = Object.entries(p.byVariant).filter(([id]) => id !== spec.defaultV);
  if (!own.length) return base;
  return `(${own.map(([id, x]) => `${v} === ${js(id)} ? ${lit(x)} : `).join("")}${base})`;
}

/** The literal default as TypeScript (for a property initialiser / a defaults table). */
export const defaultLiteral = (spec: DsSpec, p: SpecProp) => {
  const d = defaultOf(p, spec.defaultV);
  return typeof d === "string" && d.startsWith("@asset:") ? d.slice(7) : js(d);
};

/** Bundled images as constants (`src/assets.ts`): data URLs work in every bundler and in Angular libraries. */
export function assetsTs(model: DsModel): string {
  const lines = [...model.assets].map(([name, url]) => `export const ${name} = ${js(url)}`);
  return `// Images the components show by default (bundled, so the package works offline).\n${lines.join("\n")}\n${lines.length ? "" : "export {}\n"}`;
}

/** Asset imports a component file needs. */
export const assetImports = (spec: DsSpec, from: string) =>
  spec.assets.size ? `import { ${[...spec.assets].sort().join(", ")} } from '${from}'\n` : "";

/** tokens.css (custom properties, @font-face, the theme class) + the font files. */
export function tokenFiles(model: DsModel, fonts: readonly DsFont[], dir = ""): FileMap {
  const files: FileMap = {};
  for (const f of fonts) files[`${dir}${f.file}`] = f.data;
  files[`${dir}tokens.css`] =
    `${tokensCss(model.vars, [...fonts])}\n/* Local faces of system fonts the designs name */\n${SYSTEM_FACES_CSS}\n\n/* Put the theme class on <body> (or around the components): the page defaults the designs assume */\n${themeCss(model.prefix)}`;
  return files;
}

/** Prop docs (README / docs page): name, type, default. */
export function propRows(
  spec: DsSpec,
): Array<{ name: string; attr: string; type: string; def: string; doc: string }> {
  return spec.props.map((p) => {
    const d = defaultOf(p, spec.defaultV);
    const def =
      typeof d === "string" && d.startsWith("@asset:")
        ? "(bundled image)"
        : typeof d === "string" && d.length > 60
          ? `${js(d.slice(0, 57))}…`
          : js(d);
    const src = p.api.source;
    const doc =
      src.kind === "axis"
        ? `variant "${src.axis}"`
        : src.kind === "property"
          ? `property "${src.property}"`
          : `${src.field} of "${p.api.label}"`;
    return { name: p.name, attr: p.attr, type: p.tsType, def, doc };
  });
}

/** A prop value as written in a snippet / demo: strings as given, booleans, image constants. */
export type SnippetValue = string | boolean;

/** Pick the values a snippet passes: known props that differ from their default. */
export function snippetValues(
  spec: DsSpec,
  values: Record<string, string | boolean>,
): Array<[SpecProp, SnippetValue]> {
  const out: Array<[SpecProp, SnippetValue]> = [];
  for (const p of spec.props) {
    const val = values[p.name] ?? values[p.api.name] ?? values[p.api.label];
    if (val === undefined) continue;
    let x: SnippetValue;
    if (p.type === "boolean") x = val === true || val === "true";
    else if (p.type === "instance") {
      const i = p.optionIds?.indexOf(String(val)) ?? -1;
      x = i >= 0 ? p.options![i]! : String(val);
    } else x = String(val);
    const d = defaultOf(p, spec.defaultV);
    if (x === d) continue;
    out.push([p, x]);
  }
  return out;
}
