// `@<prefix>-ds/site`: the page's own components (header, hero, bands, cards, footer), taken from the rebuild pipeline's
// react-vite output, in the same workspace as the Carbon-like primitives. Its styles consume tokens: colours that are
// design tokens become those tokens, every other measured value goes into the package's token layer.
import { measuredTokensCss, normColorValue, tokenizeCss, type MeasuredToken } from "../css.js";
import { SEMANTIC_TOKENS, type TokenSystem } from "../tokens/system.js";
import type { PackageNames } from "./packages.js";
import type { FileMap } from "./tokens.js";

export interface SiteSet {
  /** the set's component name, e.g. `Card` */
  name: string;
  /** what the rebuild pipeline's components stage found it to be: `button`, `card`, `hero`, `footer`, … */
  kind?: string;
}

export interface SiteInput {
  /** text files of the react-vite output: `src/components/**`, `src/sections/**`, `src/data/**`, `src/lib/**`, `src/**.css`, `src/pages/**` */
  files: Readonly<Record<string, string>>;
  /** the component sets of the rebuild's `components` stage */
  sets: readonly SiteSet[];
  /** captured page origin, rewritten to site-relative links */
  origin?: string;
  /** the captured page's first-loaded URL (a link to it is a `#fragment` link) */
  pageUrl?: string;
  /** texts the page draws through `::before` / `::after`: painted, not part of its text */
  pseudoTexts?: readonly string[];
}

/** Which measured values the composites hold and where the swap machinery reads them. */
export interface SiteMeta {
  components: string[];
  sections: string[];
  tokens: { measured: number; aliased: number };
  /** the stylesheet before its values became tokens (what the flow lint reads) */
  rawCss: string;
  /** the page-level source files (the page and its CSS), for the replica */
  pages: Record<string, string>;
  /** sets that render through a primitive when the replica stage keeps the swap */
  swaps: SwapCandidate[];
  /** files extracted out of inlined `data:` URLs, written next to the page's images (`public/images/…`) */
  inlineImages: Record<string, Uint8Array>;
}

const SECTION_KINDS = new Set(["header", "footer", "hero", "section", "nav", "navigation"]);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Internal links of the captured page → links on the rebuilt site. */
export function rewriteOrigin(text: string, origin: string | undefined): string {
  if (!origin) return text;
  const o = origin.replace(/\/+$/, "");
  const esc = o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`${esc}/?(#[^"'\\s]*)`, "g"), "$1")
    .replace(new RegExp(`${esc}(?=[/"'?#])`, "g"), "");
}

/** `<source srcSet="data:…">` becomes a file (a `data:` URL holds commas, which a srcset's parser splits on). */
function extractInlineImages(src: string, out: Record<string, Uint8Array>, counter: { n: number }): string {
  return src.replace(
    /srcSet="data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)"/g,
    (_m, ext: string, b64: string) => {
      counter.n++;
      const name = `inline-${counter.n}.${ext === "svg+xml" ? "svg" : ext}`;
      out[`images/${name}`] = Uint8Array.from(Buffer.from(b64, "base64"));
      return `srcSet="/images/${name}"`;
    },
  );
}

/** JSX whose whole text is a pseudo-element's content: the content moves to an attribute the stylesheet draws. */
function pseudoAsAttribute(src: string, texts: readonly string[]): string {
  let out = src;
  for (const t of texts) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`<([a-z][\\w]*)([^<>]*)>${esc}</\\1>`, "g"),
      (_m, tag: string, attrs: string) => `<${tag}${attrs} data-pseudo-text=${JSON.stringify(t)}></${tag}>`,
    );
  }
  return out;
}

/** Marks the root DOM element of each return with the component it belongs to (what the coverage metric counts). */
function markRoot(src: string, name: string, kind: "set" | "section"): string {
  return src.replace(/return \(\s*<([a-z][\w]*)(?=[\s>/])/g, (m, tag: string) =>
    m.replace(`<${tag}`, `<${tag} data-ds="${name}" data-ds-kind="${kind}"`),
  );
}

const PRIMITIVE_OF_KIND: Record<string, SwapPrimitive> = {
  button: "Button",
  link: "Link",
  badge: "Tag",
  tag: "Tag",
};

export type SwapPrimitive = "Button" | "Link" | "Tag";

/** A set whose root can be rendered by a primitive of `@<prefix>-ds/react`. */
export interface SwapCandidate {
  set: string;
  primitive: SwapPrimitive;
  /** root element tag and the classes it wears across its variants */
  rootTag: string;
  classes: string[];
}

interface JsxElement {
  tag: string;
  attrs: string;
  children: string;
  /** index just past the element */
  end: number;
}

/** Scans one JSX element from `src[start] === "<"`. Tolerant: returns null on anything unexpected. */
function scanElement(src: string, start: number): JsxElement | null {
  const nameRe = /<([A-Za-z][\w.]*)/y;
  nameRe.lastIndex = start;
  const m = nameRe.exec(src);
  if (!m) return null;
  const tag = m[1]!;
  let i = start + m[0].length;
  const attrStart = i;
  // attributes: up to the matching `>`, skipping strings and `{…}`
  const skipExpr = (at: number): number => {
    let depth = 0;
    for (let k = at; k < src.length; k++) {
      const c = src[k]!;
      if (c === '"' || c === "'" || c === "`") {
        const q = c;
        for (k++; k < src.length && src[k] !== q; k++) if (src[k] === "\\") k++;
      } else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return k + 1;
      }
    }
    return -1;
  };
  for (; i < src.length;) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++);
      i++;
    } else if (c === "{") {
      i = skipExpr(i);
      if (i < 0) return null;
    } else if (c === "/" && src[i + 1] === ">") {
      return { tag, attrs: src.slice(attrStart, i), children: "", end: i + 2 };
    } else if (c === ">") break;
    else i++;
  }
  if (src[i] !== ">") return null;
  const attrs = src.slice(attrStart, i);
  i++;
  const childStart = i;
  let depth = 0;
  // children: nested tags, expressions; the text of the element is left alone
  for (; i < src.length;) {
    const c = src[i]!;
    if (c === "{") {
      i = skipExpr(i);
      if (i < 0) return null;
    } else if (c === "<" && src[i + 1] === "/") {
      const end = src.indexOf(">", i);
      if (end < 0) return null;
      if (depth === 0) return { tag, attrs, children: src.slice(childStart, i), end: end + 1 };
      depth--;
      i = end + 1;
    } else if (c === "<" && /[A-Za-z]/.test(src[i + 1] ?? "")) {
      const inner = scanElement(src, i);
      if (!inner) return null;
      i = inner.end;
    } else i++;
  }
  return null;
}

const ROOT_RE = /return \(\s*</g;

/** Classes the root wears: its className literals plus the `root` entries of the variant tables. */
function rootClasses(src: string, attrs: string): string[] {
  const out = new Set<string>();
  for (const m of attrs.matchAll(/"([a-z0-9][\w-]*__[\w-]+)"/g)) out.add(m[1]!);
  for (const m of src.matchAll(/\broot: "([a-z0-9][\w-]*__[\w-]+)"/g)) out.add(m[1]!);
  return [...out];
}

/**
 * Rewrites a set's roots to render the primitive when `SWAPS[set]` is on, keeping the measured markup otherwise. Both
 * paths stay in the source: the replica decides per set, by measuring it (the swap contract).
 */
function swapReady(
  src: string,
  set: string,
  kind: string | undefined,
  scope: string,
  css: string,
): { src: string; c?: SwapCandidate } {
  let primitive = kind ? PRIMITIVE_OF_KIND[kind] : undefined;
  if (!primitive) return { src };
  // a "button" that paints no shell of its own (a text link): the Link primitive, not a filled Button
  if (primitive === "Button") {
    const d = rootClasses(src, src).map((c) => declsOf(css, c));
    if (
      d.length &&
      d.every((x) => !x["background-color"] && !x["background"] && !x["border-style"] && !x["border"])
    )
      primitive = "Link";
  }
  const roots = [...src.matchAll(ROOT_RE)];
  if (!roots.length) return { src };
  const firstEl = scanElement(src, roots[0]!.index! + roots[0]![0].length - 1);
  if (!firstEl || !/^[a-z]/.test(firstEl.tag)) return { src };
  const classes = new Set<string>();
  let out = "";
  let last = 0;
  let any = false;
  for (const r of roots) {
    const at = r.index! + r[0].length - 1;
    const el = scanElement(src, at);
    if (!el || !/^[a-z]/.test(el.tag)) continue;
    const measured = src.slice(at, el.end);
    for (const c of rootClasses(src, el.attrs)) classes.add(c);
    const kept = el.attrs
      .replace(/\s(role|data-url|data-svg)=(?:"[^"]*"|\{[^}]*\})/g, "")
      .replace(/\s(aria-hidden)="[^"]*"/g, "");
    const hrefAttr = /\shref=(?:"[^"]*"|\{[^}]*\})/.exec(kept)?.[0];
    const attrsNoHref = kept.replace(/\shref=(?:"[^"]*"|\{[^}]*\})/, "");
    let swapped: string;
    if (primitive === "Link") {
      swapped = `<DsLink data-ds-primitive="Link" data-ds-set="${set}">${measured}</DsLink>`;
    } else if (primitive === "Button") {
      if (el.tag !== "a" && el.tag !== "button" && el.tag !== "div") return { src };
      const children = el.tag === "a" && hrefAttr ? `<a${hrefAttr}>${el.children}</a>` : el.children;
      const flag = el.tag !== "button" ? " linkSlot" : "";
      swapped = `<DsButton data-ds-primitive="Button" data-ds-set="${set}"${flag}${attrsNoHref}>${children}</DsButton>`;
    } else {
      if (el.tag !== "div" && el.tag !== "span") return { src };
      swapped = `<DsTag data-ds-primitive="Tag" data-ds-set="${set}"${attrsNoHref}>${el.children}</DsTag>`;
    }
    out += src.slice(last, r.index!);
    // `data-ds-set`, not `data-ds`: the coverage metric counts `data-ds`, and the docs' catalogue finds the set by this
    const marked = measured.replace(/^<([a-z][\w]*)/, `<$1 data-ds-set="${set}"`);
    out += `return (\n      SWAPS.${set} ? (\n        ${swapped}\n      ) : (\n        ${marked}\n      )\n    )`;
    // the original closes with `)` after the JSX
    const close = src.indexOf(")", el.end);
    last = close + 1;
    any = true;
  }
  if (!any) return { src };
  out += src.slice(last);
  const header = `import { ${primitive} as Ds${primitive} } from '${scope}/react'\nimport { SWAPS } from '../../swaps'\n`;
  const firstImport = out.search(/^import /m);
  out = firstImport >= 0 ? out.slice(0, firstImport) + header + out.slice(firstImport) : header + out;
  return { src: out, c: { set, primitive, rootTag: firstEl.tag, classes: [...classes].sort() } };
}

/** The first declarations of `.cls` (the page's stylesheet keeps one rule per class). */
function declsOf(css: string, cls: string): Record<string, string> {
  const m = new RegExp(`\\.${cls.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split(";")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * What a swapped root keeps of its measured class: its place in its parent. The visual properties come from the
 * primitive; where the page's value differs from the brand token, the rule sets the primitive's own token to the
 * page's value, the measured value through the primitive's token API rather than past it.
 */
export function primitiveRules(prefix: string, c: SwapCandidate, css: string): string {
  const p = `--${prefix}`;
  const rules: string[] = [];
  for (const cls of c.classes) {
    const d = declsOf(css, cls);
    const decl: string[] = [];
    const set = (prop: string, value: string | undefined) => {
      if (value) decl.push(`${prop}: ${value};`);
    };
    if (c.primitive === "Button") {
      set(`${p}-button-primary`, d["background-color"] ?? d["background"]);
      set(`${p}-button-primary-text`, d["color"]);
      set(`${p}-spacing-05`, d["padding-left"] ?? d["padding-inline"]);
      set(
        `${p}-size-md`,
        d["height"] && d["height"] !== "auto" && !/fit|content|%/.test(d["height"]) ? d["height"] : undefined,
      );
      set(`${p}-radius-control`, d["border-radius"]);
    } else if (c.primitive === "Tag") {
      set(`${p}-layer-accent-01`, d["background-color"] ?? d["background"]);
      set(`${p}-text-primary`, d["color"]);
      set(`${p}-spacing-03`, d["padding-left"] ?? d["padding-inline"]);
      set(`${p}-radius-pill`, d["border-radius"]);
    }
    for (const [k, v] of Object.entries(d))
      if (/^font-(size|weight|family)$|^line-height$|^letter-spacing$/.test(k) && c.primitive === "Button")
        set(`${p}-body-compact-01-${k}`, v);
    if (c.primitive !== "Link")
      decl.push(
        "display: inline-flex; background: none; padding: 0; width: auto; height: auto; min-width: 0; min-height: 0; border-radius: 0; border: 0;",
      );
    rules.push(`[data-ds-primitive="${c.primitive}"].${cls} { ${decl.join(" ")} }`);
  }
  return rules.join("\n");
}

const dataExports = (src: string): string[] =>
  [...src.matchAll(/^export (?:const|let|function|type|interface|enum) (\w+)/gm)].map((m) => m[1]!);

/**
 * Names that several data modules export (each section's data is its own module, so `links` can occur twice). `export *`
 * cannot carry them, so the barrel names them after their module: `links` of `data/footer` is `footerLinks`.
 */
export function dataAliases(files: Readonly<Record<string, string>>): Map<string, Map<string, string>> {
  const modules = Object.entries(files)
    .map(([f, c]) => [/^src\/data\/([\w-]+)\.ts$/.exec(f)?.[1], c] as const)
    .filter((e): e is [string, string] => !!e[0] && typeof e[1] === "string");
  const count = new Map<string, number>();
  for (const [, src] of modules)
    for (const x of new Set(dataExports(src))) count.set(x, (count.get(x) ?? 0) + 1);
  const out = new Map<string, Map<string, string>>();
  for (const [stem, src] of modules) {
    const camel = stem.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    const renamed = new Map(
      dataExports(src)
        .filter((x) => count.get(x)! > 1)
        .map((x) => [x, `${camel}${x[0]!.toUpperCase()}${x.slice(1)}`] as const),
    );
    if (renamed.size) out.set(stem, renamed);
  }
  return out;
}

/** `import X, { Y } from '../y/X'` and `import { z } from '../data/p'` → named imports of `@scope/site`, for the replica's page. */
export function pageSource(
  src: string,
  scope: string,
  aliases: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): string {
  const site = `${scope}/site`;
  const named: string[] = [];
  const rest: string[] = [];
  for (const line of src.split("\n")) {
    const m =
      /^import (?:(\w+)(?:, )?)?(?:\{ ([^}]*) \})? ?from '\.\.\/(sections|components|data)\/([\w-]+)'$/.exec(
        line,
      );
    if (m) {
      const renamed = m[3] === "data" ? aliases.get(m[4]!) : undefined;
      if (m[1]) named.push(m[1]);
      if (m[2])
        named.push(
          ...m[2]
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
            .map((x) => (renamed?.has(x) ? `${renamed.get(x)!} as ${x}` : x)),
        );
    } else if (/^import '\.\/\w+\.css'$/.test(line)) continue;
    else rest.push(line);
  }
  const body = rest.join("\n").replace(/^(\/\/.*\n)/, "$1");
  const imports = named.length ? `import { ${named.sort().join(", ")} } from '${site}'\n` : "";
  return `${imports}${body}`;
}

/** The page's root and overlay frames are boxes, not `<main>`: the page keeps one landmark (the verify suite counts them). */
export function frameBoxes(src: string): string {
  const re = /<main\b([^>]*)>|<\/main>/g;
  const stack: boolean[] = [];
  return src.replace(re, (m, attrs: string | undefined) => {
    if (m.startsWith("</")) return stack.pop() ? "</div>" : m;
    const isFrame = /\bdata-screen=/.test(attrs ?? "");
    stack.push(isFrame);
    return isFrame ? `<div${attrs ?? ""}>` : m;
  });
}

const pageCss = (css: string) =>
  css
    .replace(/\bmain\[data-screen\]/g, "[data-screen]")
    .replace(/\bmain\[data-page=/g, "[data-page=")
    .replace(/>\s*main\b/g, "> [data-screen]")
    // a scale-to-fit for widths below the variant's own range: never active in the range the variant is shown in
    .replace(/\s*zoom:\s*min\([^;}]*\);?/g, "");

/** Exact design-token matches (light-side semantic tokens of the default theme first, then the palettes). */
export function designTokenAliases(t: TokenSystem): Map<string, string> {
  const p = t.spec.prefix;
  const out = new Map<string, string>();
  const put = (value: string, token: string) => {
    const k = normColorValue(value);
    if (k && !out.has(k)) out.set(k, `var(--${p}-${token})`);
  };
  const theme = t.themes[t.defaultTheme];
  for (const k of SEMANTIC_TOKENS) if (theme[k]) put(theme[k], k);
  for (const [name, steps] of Object.entries(t.palettes))
    for (const [step, value] of Object.entries(steps)) put(value, `${name}-${step}`);
  return out;
}

/** The composites package (pure). */
export function sitePackage(
  t: TokenSystem,
  n: PackageNames,
  input: SiteInput,
): { files: FileMap; meta: SiteMeta } {
  const p = t.spec.prefix;
  const scope = n.scope;
  const siteName = `${scope}/site`;
  const kindOf = new Map(input.sets.map((s) => [s.name, s.kind]));
  const sources: Record<string, string> = {};
  const pages: Record<string, string> = {};
  const inlineImages: Record<string, Uint8Array> = {};
  const counter = { n: 0 };
  const components: string[] = [];
  const sections: string[] = [];
  const swaps: SwapCandidate[] = [];
  const rawStyles = Object.entries(input.files)
    .filter(([f]) => /^src\/(styles\.css|pages\/[^/]+\.css)$/.test(f))
    .map(([, c]) => c)
    .join("\n\n");
  const pseudo = [...(input.pseudoTexts ?? [])];
  const prep = (text: string) =>
    pseudoAsAttribute(extractInlineImages(rewriteOrigin(text, input.origin), inlineImages, counter), pseudo);
  const aliases = dataAliases(input.files);
  for (const [file, content] of Object.entries(input.files)) {
    if (typeof content !== "string") continue;
    if (/^src\/pages\/[^/]+\.tsx$/.test(file)) {
      pages[file.replace(/^src\/pages\//, "")] = frameBoxes(pageSource(prep(content), scope, aliases));
      continue;
    }
    if (/^src\/pages\/[^/]+\.css$/.test(file)) continue;
    let m = /^src\/(components|sections)\/([^/]+)\/\2\.tsx$/.exec(file);
    if (m) {
      const name = m[2]!;
      const section = m[1] === "sections" || SECTION_KINDS.has(kindOf.get(name) ?? "");
      if (m[1] === "sections") sections.push(name);
      else components.push(name);
      const ready = swapReady(prep(content), name, kindOf.get(name), scope, rawStyles);
      if (ready.c) swaps.push(ready.c);
      sources[file] = markRoot(ready.src, name, section ? "section" : "set");
      continue;
    }
    m = /^src\/(?:components|sections|data|lib)\//.exec(file);
    if (m) sources[file] = prep(content);
  }
  components.sort();
  sections.sort();
  // the stylesheets: the components' and the page's in one, measured values moved into the token layer
  const cssParts = [input.files["src/styles.css"], input.files["src/styles/base.css"]].filter(
    (c): c is string => typeof c === "string",
  );
  for (const [file, content] of Object.entries(input.files))
    if (/^src\/pages\/[^/]+\.css$/.test(file) && typeof content === "string") cssParts.push(content);
  const baseCss = input.files["src/styles/index.css"] ?? "";
  const tokenPrefix = `--${p}-site`;
  const colorAliases = designTokenAliases(t);
  const rawCss = pageCss(cssParts.join("\n\n"));
  const primitiveCss = swaps.map((c) => primitiveRules(p, c, rawCss)).join("\n");
  const composites = tokenizeCss(
    `${rawCss}\n\n/* Texts the page draws through pseudo-elements */\n[data-pseudo-text]::before { content: attr(data-pseudo-text); }\n\n/* Roots rendered by a primitive */\n${primitiveCss}\n`,
    {
      tokenPrefix,
      aliases: colorAliases,
    },
  );
  const base = tokenizeCss(pageCss(baseCss), { tokenPrefix: `${tokenPrefix}-base`, aliases: colorAliases });
  const measured: MeasuredToken[] = [...composites.tokens, ...base.tokens];
  // webfonts and the exporter's tokens, kept as they are: `@font-face` names a file and `--t-*` are the export's own vars
  const fontsCss = (input.files["src/styles/tokens.css"] ?? "").replace(
    /url\((['"]?)(?:\.\.\/)*fonts\//g,
    "url($1/fonts/",
  );
  const files: FileMap = {};
  for (const [f, c] of Object.entries(sources)) files[`src/${f.replace(/^src\//, "")}`] = c;
  files["src/styles/composites.css"] = composites.css;
  files["src/styles/base.css"] = base.css;
  files["src/styles/fonts.css"] = fontsCss;
  files["src/styles/site-tokens.css"] = measuredTokensCss(
    measured,
    `${t.spec.name}: values measured from the page, as tokens. Generated by CDR.`,
  );
  const names = [...new Set([...components, ...sections])].sort();
  // one flag per candidate set: the replica stage writes them (the swap contract), the measured markup is the default
  files["src/swaps.ts"] =
    `// Which sets render through a primitive. Written by the replica stage (see the swap contract).
export const SWAPS: Record<string, boolean> = ${JSON.stringify(Object.fromEntries(swaps.map((c) => [c.set, false])))}
`;
  // a page without sliders or menus has no interactions runtime; the page calls the hook either way
  files["src/lib/interactions.ts"] ??= "export function useInteractions(): void {}\n";
  files["src/index.ts"] = [
    `// ${t.spec.name}: the page's components. Generated by CDR from the page; regenerate instead of editing.`,
    ...names.map(
      (x) =>
        `export { default as ${x} } from './${components.includes(x) ? "components" : "sections"}/${x}'\nexport * from './${components.includes(x) ? "components" : "sections"}/${x}'`,
    ),
    ...Object.keys(files)
      .filter((f) => /^src\/data\/[\w-]+\.ts$/.test(f))
      .sort()
      .map((f) => {
        const path = `./${f.slice("src/".length, -".ts".length)}`;
        const renamed = aliases.get(f.slice("src/data/".length, -".ts".length));
        if (!renamed) return `export * from '${path}'`;
        const specs = dataExports(files[f]!).map((x) => (renamed.has(x) ? `${x} as ${renamed.get(x)!}` : x));
        return `export { ${specs.join(", ")} } from '${path}'`;
      }),
    "export { useInteractions } from './lib/interactions'",
    "",
  ].join("\n");
  files["scripts/build-css.mjs"] = `// Concatenates the package's stylesheets into dist/styles.css.
import { readFileSync, writeFileSync } from 'node:fs'
const dir = new URL('../src/styles/', import.meta.url)
const css = ['site-tokens', 'fonts', 'base', 'composites'].map((f) => readFileSync(new URL(\`\${f}.css\`, dir), 'utf8')).join('\\n\\n')
writeFileSync(new URL('../dist/styles.css', import.meta.url), css)
`;
  files["package.json"] = json({
    name: siteName,
    version: n.version,
    description: `${t.spec.name}: the page's composite components, built from ${n.react} and ${n.tokens}.`,
    type: "module",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./styles.css": "./dist/styles.css",
    },
    files: ["dist"],
    sideEffects: ["./dist/styles.css"],
    scripts: { build: "tsc -p tsconfig.json && node scripts/build-css.mjs", test: 'node -e ""' },
    dependencies: { [n.react]: n.version, [n.tokens]: n.version },
    peerDependencies: { react: ">=18" },
    devDependencies: { typescript: "^5.9.3", "@types/react": "^18.3.31", react: "^18.3.1" },
  });
  files["tsconfig.json"] = json({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      strict: true,
      declaration: true,
      skipLibCheck: true,
      outDir: "dist",
      rootDir: "src",
    },
    include: ["src"],
  });
  return {
    files,
    meta: {
      components,
      sections,
      tokens: { measured: measured.length, aliased: composites.aliased + base.aliased },
      swaps,
      rawCss,
      pages,
      inlineImages,
    },
  };
}
