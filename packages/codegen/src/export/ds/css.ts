// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Styles of a design-system component: one class per styled layer, the declarations every variant shares on the
// class, the rest under the root's `data-v` (the variant the props select). Nested components are placed by a class
// of the outer component: on their root element (light DOM: React, Angular) or through `::part(root)` (Lit, shadow
// DOM). Token references stay `var(--t-*)` (tokens.css). Pure.
import type { StyleMap } from "../ir.js";
import { textPreset } from "@harness/scene";
import { walkT, type DsSpec, type TNode } from "./model.js";

export type CssFlavor = "global" | "shadow";

/** Do two properties set some of the same longhands (`border` / `border-top`, `inset` / `left`)? */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.startsWith(`${s}-`)) return true;
  if (s === "inset" && /^(top|right|bottom|left)$/.test(l)) return true;
  if ((s === "font" && /^(line-height|letter-spacing)$/.test(l)) || (s === "flex" && l === "flex-basis"))
    return true;
  if (/^border-(top|right|bottom|left)$/.test(s) && l.startsWith("border-") && l.endsWith(s.slice(7)))
    return true;
  if (
    /^border-(width|style|color)$/.test(s) &&
    /^border-(top|right|bottom|left)-(width|style|color)$/.test(l) &&
    l.endsWith(s.slice(6))
  )
    return true;
  return false;
}

/** Split per-variant styles into what every variant shares and what each sets on its own. */
export function splitVariants(styles: Record<string, StyleMap>): {
  common: StyleMap;
  own: Record<string, StyleMap>;
} {
  const vs = Object.keys(styles);
  const props = new Set(vs.flatMap((v) => Object.keys(styles[v]!)));
  const varying = new Set<string>();
  for (const p of props) {
    const first = styles[vs[0]!]![p];
    if (vs.some((v) => styles[v]![p] !== first)) varying.add(p);
  }
  // a shared shorthand / longhand next to a varying one goes with it (declaration order decides between them)
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of props)
      if (!varying.has(p) && [...varying].some((x) => overlaps(p, x))) {
        varying.add(p);
        grew = true;
      }
  }
  const common: StyleMap = {};
  const first = styles[vs[0]!] ?? {};
  for (const [k, val] of Object.entries(first)) if (!varying.has(k)) common[k] = val;
  const own: Record<string, StyleMap> = {};
  for (const v of vs) {
    const o: StyleMap = {};
    for (const [k, val] of Object.entries(styles[v]!)) if (varying.has(k)) o[k] = val;
    if (Object.keys(o).length) own[v] = o;
  }
  return { common, own };
}

const block = (sel: string, s: StyleMap) =>
  `${sel} {\n${Object.entries(s)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n")}\n}`;

/** CSS of one component (its layers, its variants, the placement of the components it nests). */
export function componentCss(spec: DsSpec, flavor: CssFlavor): string {
  const rules: string[] = [];
  const root = `.${spec.cls}`;
  const vSel = (v: string) => `${root}[data-v="${v}"]`;
  walkT(spec.template, (n: TNode) => {
    if (n.t === "el" && n.cls) {
      const self = `.${n.cls}`;
      // the root class is shared by every variant group (structure differs per group): a group's root styles go under data-v
      const partial = !!n.root && Object.keys(n.styles).length < spec.variants.length;
      const { common, own } = partial
        ? {
            common: {} as StyleMap,
            own: Object.fromEntries(Object.entries(n.styles).filter(([, s]) => Object.keys(s).length)),
          }
        : splitVariants(n.styles);
      if (Object.keys(common).length) rules.push(block(self, common));
      for (const [v, s] of Object.entries(own))
        rules.push(block(n.root ? `${vSel(v)}` : `${vSel(v)} ${self}`, s));
      for (const which of ["before", "after"] as const) {
        const ps: Record<string, StyleMap> = {};
        for (const [v, p] of Object.entries(n.pseudo)) if (p?.[which]) ps[v] = p[which]!;
        if (!Object.keys(ps).length) continue;
        const split = splitVariants(ps);
        // a pseudo element on some variants only: its own rules
        const everywhere = !partial && Object.keys(ps).length === Object.keys(n.styles).length;
        if (everywhere && Object.keys(split.common).length)
          rules.push(block(`${self}::${which}`, split.common));
        for (const [v, s] of Object.entries(everywhere ? split.own : ps))
          rules.push(block(`${n.root ? vSel(v) : `${vSel(v)} ${self}`}::${which}`, s));
      }
    }
    if (n.t === "use" && n.place) {
      const { common, own } = splitVariants(n.placeStyles);
      const target = (scope: string) =>
        flavor === "shadow" ? `${scope}.${n.place}::part(root)` : `${scope}.${n.spec.cls}.${n.place}`;
      if (Object.keys(common).length)
        rules.push(block(flavor === "shadow" ? target("") : `${root} ${target("")}`, common));
      for (const [v, s] of Object.entries(own)) rules.push(block(`${vSel(v)} ${target("")}`, s));
    }
  });
  return `/* ${spec.name} (${spec.def.name}) */\n${rules.join("\n")}\n`;
}

/** Does a use need its placing class (some variant sets something)? */
export const hasPlacement = (n: { placeStyles: Record<string, StyleMap> }) =>
  Object.values(n.placeStyles).some((s) => Object.keys(s).length > 0);

/**
 * Reset + the renderer's rules the IR cannot carry inline (text trim, inline SVG boxes, icon-font glyphs), scoped to
 * the components (`.<prefix>-c` roots; in a shadow root: everything in it). Zero specificity: component classes win.
 */
export function baseCss(prefix: string, flavor: CssFlavor): string {
  const c = `.${prefix}-c`;
  const sc = (inner: string) =>
    flavor === "shadow" ? `:where(${inner})` : `:where(${c}) :where(${inner}), :where(${c}):where(${inner})`;
  return `${flavor === "shadow" ? ":host { display: contents; }\n*, *::before, *::after { box-sizing: border-box; }" : `:where(${c}), :where(${c}) *, :where(${c}) *::before, :where(${c}) *::after { box-sizing: border-box; }`}
${sc("h1, h2, h3, h4, h5, h6, p, figure, ul, ol, li")} { margin: 0; padding: 0; list-style: none; }
${sc("button")} { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; text-align: inherit; letter-spacing: inherit; word-spacing: inherit; text-transform: inherit; text-indent: inherit; text-shadow: inherit; }
${sc("input")} { font: inherit; letter-spacing: inherit; margin: 0; }
${flavor === "shadow" ? ":where(input)::placeholder" : `:where(${c}) :where(input)::placeholder`} { color: var(--t-text-muted); opacity: 1; }
${sc("a")} { color: inherit; text-decoration: none; }
[data-trim] { text-box: trim-both cap alphabetic; }
@supports not (text-box: trim-both cap alphabetic) { [data-trim] { margin-top: var(--trim-top, 0); margin-bottom: var(--trim-bottom, 0); } }
:where([data-svg]) > svg { width: 100%; height: 100%; display: block; overflow: visible; }
:where([data-glyph]) { display: none; text-box: trim-end text alphabetic; pointer-events: none; }
:where([data-glyph-svg]) { position: absolute; inset: 0; display: block; }
:where([data-glyph-svg]) > svg { width: 100%; height: 100%; display: block; overflow: visible; }
@supports (text-box: trim-end text alphabetic) { :where([data-glyph]) { display: block; } :where([data-glyph-svg]) { display: none; } }
`;
}

/** What a page around the components sets (the design's screen root): the theme class for `<body>` or a wrapper. */
export function themeCss(prefix: string): string {
  return `.${prefix}-theme {
  color: var(--t-text);
  font-family: var(--t-font);
  font-size: ${textPreset("body", "web").size}px;
  line-height: 1.45;
  letter-spacing: -0.005em;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
`;
}
