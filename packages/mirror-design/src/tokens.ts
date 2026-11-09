/**
 * Design-token extraction (MIGRATION_PLAN.md §7.1 step 2) -> design/tokens.json in W3C Design Tokens format.
 *
 * Sources, in order of trust: CSS custom properties declared on :root (resolved per viewport), computed styles of key
 * elements (body, headings, links, buttons…), frequency histograms over all visible elements, media queries.
 * Responsive values are kept in `$extensions["cmp.responsive"]` ({ mobile, tablet, desktop }); the CSS variable a
 * token came from is kept in `$extensions["cmp.cssVar"]` so generated code can reference the ported variable.
 */
import type { PageManifest, StyleSnapshot, ViewportSpec } from "@harness/mirror-capture";

type Token = { $type: string; $value: unknown; $description?: string; $extensions?: Record<string, unknown> };
export type TokenTree = { [k: string]: Token | TokenTree };

const ROOT_PX = 16;

export function toHex(color: string): string | undefined {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join("")}`;
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(c);
  if (!m) return undefined;
  const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  if (m[4] !== undefined) {
    const a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (a === 0) return undefined;
    if (a < 1) return `#${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
  }
  return `#${hex}`;
}

export function toPx(v: string): string | undefined {
  const s = v.trim();
  let m = /^(-?[\d.]+)px$/.exec(s);
  if (m) return `${+m[1]}px`;
  m = /^(-?[\d.]+)r?em$/.exec(s);
  if (m) return `${+(Number(m[1]) * ROOT_PX).toFixed(2)}px`;
  if (s === "0") return "0px";
  return undefined;
}

function parseShadow(v: string): unknown {
  // "0 2px 8px rgba(29, 29, 31, 0.08)" or computed "rgba(29, 29, 31, 0.08) 0px 2px 8px 0px"
  const color = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(v)?.[1];
  const lens = v.replace(color ?? "", "").trim().split(/\s+/).filter(Boolean).map((x) => toPx(x) ?? x);
  return { color: color ? (toHex(color) ?? color) : "#000000", offsetX: lens[0] ?? "0px", offsetY: lens[1] ?? "0px", blur: lens[2] ?? "0px", spread: lens[3] ?? "0px" };
}

function fontFamilyList(v: string): string[] {
  return v.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

function set(tree: TokenTree, path: string[], token: Token): void {
  let cur = tree;
  for (const p of path.slice(0, -1)) cur = (cur[p] ??= {}) as TokenTree;
  cur[path[path.length - 1]] = token;
}

function topN(h: Record<string, number> | undefined, n: number): string[] {
  return Object.entries(h ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => k);
}

function merged(pages: PageManifest[], vp: string, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pages) for (const [k, n] of Object.entries(p.styles[vp]?.histograms?.[key] ?? {})) out[k] = (out[k] ?? 0) + n;
  return out;
}

export function extractTokens(pages: PageManifest[], viewports: ViewportSpec[]): { tokens: TokenTree; stats: Record<string, number> } {
  const tokens: TokenTree = {};
  const vps = [...viewports].sort((a, b) => a.width - b.width);
  const largest = vps[vps.length - 1]?.name ?? "desktop";
  const snap = (vp: string): StyleSnapshot | undefined => pages.find((p) => p.styles[vp])?.styles[vp];
  const base = snap(largest);
  const responsive = (name: string): Record<string, string> => Object.fromEntries(vps.map((v) => [v.name, snap(v.name)?.cssVariables?.[name] ?? ""]).filter(([, x]) => x));

  // ---- 1. CSS custom properties
  const vars = base?.cssVariables ?? {};
  let fromVars = 0;
  for (const [name, raw] of Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))) {
    const m = /^--(color|font-size|font|line-height|space|spacing|radius|shadow|container|gutter|breakpoint)-?(.*)$/.exec(name);
    if (!m) continue;
    const [, group, rest] = m;
    const key = rest || "default";
    const resp = responsive(name);
    const varies = new Set(Object.values(resp)).size > 1;
    const ext = { "cmp.cssVar": name, ...(varies ? { "cmp.responsive": Object.fromEntries(Object.entries(resp).map(([k, v]) => [k, toPx(v) ?? v])) } : {}) };
    let token: Token | undefined;
    if (group === "color") {
      const hex = toHex(raw);
      if (hex) token = { $type: "color", $value: hex, $extensions: ext };
    } else if (group === "font" && /^(sans|serif|mono|heading|body|family)/.test(key)) token = { $type: "fontFamily", $value: fontFamilyList(raw), $extensions: ext };
    else if (group === "font-size") token = { $type: "dimension", $value: toPx(raw) ?? raw, $extensions: ext };
    else if (group === "line-height") token = { $type: "number", $value: Number(raw) || raw, $extensions: ext };
    else if (group === "shadow") token = { $type: "shadow", $value: parseShadow(raw), $extensions: ext };
    else token = { $type: "dimension", $value: toPx(raw) ?? raw, $extensions: ext };
    if (!token) continue;
    const groupName = { "font-size": "fontSize", font: "fontFamily", "line-height": "lineHeight", space: "spacing", spacing: "spacing", radius: "radius", shadow: "shadow", container: "size", gutter: "size", breakpoint: "breakpoint", color: "color" }[group]!;
    set(tokens, [groupName, group === "gutter" ? "gutter" : key], token);
    fromVars++;
  }

  // ---- 2. semantic colours / typography from key elements (always, also for sites without variables)
  const el = (key: string, vp = largest) => {
    for (const p of pages) {
      const e = p.styles[vp]?.elements.find((x) => x.key === key);
      if (e) return e;
    }
    return undefined;
  };
  const semantic: [string, string, string][] = [
    ["text", "body", "color"],
    ["background", "body", "backgroundColor"],
    ["link", "a", "color"],
    ["heading", "h1", "color"],
    ["buttonBackground", "buttonPrimary", "backgroundColor"],
    ["headerBackground", "header", "backgroundColor"],
    ["footerBackground", "footer", "backgroundColor"],
  ];
  for (const [name, key, prop] of semantic) {
    const v = el(key)?.styles[prop];
    const hex = v ? toHex(v) : undefined;
    if (hex) set(tokens, ["color", "semantic", name], { $type: "color", $value: hex, $extensions: { "cmp.source": `${key}.${prop}` } });
  }
  const palette = topN(merged(pages, largest, "color"), 6)
    .concat(topN(merged(pages, largest, "backgroundColor"), 6))
    .map((c) => toHex(c))
    .filter((c, i, a): c is string => !!c && a.indexOf(c) === i);
  palette.forEach((hex, i) => set(tokens, ["color", "palette", String(i + 1)], { $type: "color", $value: hex, $extensions: { "cmp.source": "histogram" } }));

  for (const key of ["body", "h1", "h2", "h3", "p", "a", "button", "navLink", "footerLink"]) {
    const e = el(key);
    if (!e) continue;
    const resp = Object.fromEntries(vps.map((v) => [v.name, el(key, v.name)?.styles.fontSize]).filter(([, x]) => x));
    set(tokens, ["typography", key], {
      $type: "typography",
      $value: {
        fontFamily: fontFamilyList(e.styles.fontFamily ?? ""),
        fontSize: e.styles.fontSize,
        fontWeight: Number(e.styles.fontWeight) || e.styles.fontWeight,
        lineHeight: e.styles.lineHeight,
        letterSpacing: e.styles.letterSpacing === "normal" ? "0px" : e.styles.letterSpacing,
      },
      $extensions: { "cmp.selector": e.selector, ...(new Set(Object.values(resp)).size > 1 ? { "cmp.responsive": resp } : {}) },
    });
  }
  const weights = topN(merged(pages, largest, "fontWeight"), 4).sort((a, b) => Number(a) - Number(b));
  const weightName: Record<string, string> = { "300": "light", "400": "regular", "500": "medium", "600": "semibold", "700": "bold", "800": "extrabold" };
  for (const w of weights) set(tokens, ["fontWeight", weightName[w] ?? w], { $type: "fontWeight", $value: Number(w) });
  if (!("fontFamily" in tokens)) {
    const fam = topN(merged(pages, largest, "fontFamily"), 2);
    fam.forEach((f, i) => set(tokens, ["fontFamily", i === 0 ? "base" : `alt${i}`], { $type: "fontFamily", $value: fontFamilyList(f) }));
  }

  // ---- 3. scales from histograms when no variables exist
  if (!("spacing" in tokens)) topN(merged(pages, largest, "spacing"), 8).map(toPx).filter(Boolean).sort((a, b) => parseFloat(a!) - parseFloat(b!)).forEach((v, i) => set(tokens, ["spacing", String(i + 1)], { $type: "dimension", $value: v, $extensions: { "cmp.source": "histogram" } }));
  if (!("radius" in tokens)) topN(merged(pages, largest, "radius"), 4).map(toPx).filter(Boolean).sort((a, b) => parseFloat(a!) - parseFloat(b!)).forEach((v, i) => set(tokens, ["radius", String(i + 1)], { $type: "dimension", $value: v, $extensions: { "cmp.source": "histogram" } }));
  if (!("shadow" in tokens)) topN(merged(pages, largest, "shadow"), 3).forEach((v, i) => set(tokens, ["shadow", String(i + 1)], { $type: "shadow", $value: parseShadow(v), $extensions: { "cmp.source": "histogram" } }));
  if (!("fontSize" in tokens)) topN(merged(pages, largest, "fontSize"), 8).map(toPx).filter(Boolean).sort((a, b) => parseFloat(a!) - parseFloat(b!)).forEach((v, i) => set(tokens, ["fontSize", String(i + 1)], { $type: "dimension", $value: v, $extensions: { "cmp.source": "histogram" } }));

  // ---- 4. breakpoints from media queries, named after the first viewport that reaches them
  const mins = new Set<number>();
  for (const p of pages) for (const v of Object.values(p.styles)) for (const q of v.mediaQueries ?? []) for (const m of q.matchAll(/min-width:\s*([\d.]+)(px|em|rem)/g)) mins.add(m[2] === "px" ? Number(m[1]) : Number(m[1]) * ROOT_PX);
  const maxs = new Set<number>();
  for (const p of pages) for (const v of Object.values(p.styles)) for (const q of v.mediaQueries ?? []) for (const m of q.matchAll(/max-width:\s*([\d.]+)(px|em|rem)/g)) maxs.add((m[2] === "px" ? Number(m[1]) : Number(m[1]) * ROOT_PX) + 1);
  const used = new Set<string>();
  for (const bp of [...new Set([...mins, ...maxs])].sort((a, b) => a - b)) {
    let name = vps.find((v) => v.width >= bp)?.name ?? `bp${bp}`;
    if (used.has(name)) name = `${name}-${bp}`;
    used.add(name);
    set(tokens, ["breakpoint", name], { $type: "dimension", $value: `${bp}px`, $extensions: { "cmp.mediaQuery": `(min-width: ${bp}px)` } });
  }

  const count = (t: TokenTree): number => Object.values(t).reduce<number>((n, v) => n + ("$type" in v ? 1 : count(v as TokenTree)), 0);
  return { tokens, stats: { tokens: count(tokens), fromCssVariables: fromVars, breakpoints: used.size } };
}
