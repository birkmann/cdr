// CSS helpers of the design-system workspace: a declaration walker, the extraction of measured values into the token
// layer (`@<prefix>-ds/site`), and the lint of §1: no raw colour or size in component CSS.

/** A raw value the lint found. */
export interface RawValue {
  value: string;
  prop: string;
  selector: string;
}

export interface CssDeclContext {
  /** the selector (or at-rule prelude) of the enclosing block */
  selector: string;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g;
/** px, rem and em lengths. Zero and the viewport-relative units are not sizes a token could hold. */
const LENGTH_RE = /(?<![\w#.-])-?(?:\d+\.\d+|\d+|\.\d+)(?:px|rem|em)\b/g;

/**
 * Applies `fn` to every declaration value in `css`, rebuilding the text unchanged around it. Skips `@font-face` blocks
 * (their `src` is a file reference, not a design value) and custom property definitions are visited like any other
 * declaration. A broken stylesheet is copied through from where the parser loses it.
 */
export function mapCssDeclarations(
  css: string,
  fn: (prop: string, value: string, ctx: CssDeclContext) => string,
): string {
  const n = css.length;
  let out = "";
  let i = 0;
  const stack: { selector: string; kind: "rule" | "at" | "font-face" }[] = [];
  const copyTrivia = () => {
    for (;;) {
      if (css.startsWith("/*", i)) {
        const j = css.indexOf("*/", i + 2);
        if (j < 0) {
          out += css.slice(i);
          i = n;
          return;
        }
        out += css.slice(i, j + 2);
        i = j + 2;
      } else if (i < n && /\s/.test(css[i]!)) {
        out += css[i++];
      } else return;
    }
  };
  while (i < n) {
    copyTrivia();
    if (i >= n) break;
    if (css[i] === "}") {
      stack.pop();
      out += "}";
      i++;
      continue;
    }
    // a statement up to the next `;`, `{` or `}` at top level (strings and parentheses skipped)
    let j = i;
    let depth = 0;
    let quote = "";
    for (; j < n; j++) {
      const c = css[j]!;
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === ";" || c === "{" || c === "}")) break;
    }
    const stmt = css.slice(i, j);
    const term = css[j];
    if (term === "{") {
      const prelude = stmt.trim();
      const top = stack[stack.length - 1];
      const fontFace = /^@font-face\b/i.test(prelude);
      const at = prelude.startsWith("@");
      if (top?.kind === "font-face") stack.push({ selector: prelude, kind: "font-face" });
      else if (fontFace) stack.push({ selector: prelude, kind: "font-face" });
      else if (at) stack.push({ selector: prelude, kind: "at" });
      else stack.push({ selector: prelude, kind: "rule" });
      out += `${stmt}{`;
      i = j + 1;
      continue;
    }
    const top = stack[stack.length - 1];
    const colon = stmt.indexOf(":");
    if (top && top.kind !== "font-face" && colon > 0 && !stmt.trimStart().startsWith("@")) {
      const prop = stmt.slice(0, colon).trim();
      const value = stmt.slice(colon + 1);
      out += `${stmt.slice(0, colon)}:${fn(prop, value, { selector: top.selector })}`;
    } else out += stmt;
    if (term === undefined) break;
    out += term === "}" ? "" : term;
    i = term === "}" ? j : j + 1;
  }
  return out;
}

/** A measured value turned into a token: `--<prefix>-site-size-3`, or a design token that already holds it. */
export interface MeasuredToken {
  name: string;
  value: string;
  kind: "color" | "size";
}

export interface TokenizeOptions {
  /** the CSS variable prefix of the measured layer, e.g. `--acme-site` */
  tokenPrefix: string;
  /** an exact colour value (normalised `#rrggbb` or `#rrggbbaa`) → the design token holding it, e.g. `var(--acme-primary-60)` */
  aliases?: ReadonlyMap<string, string>;
}

export interface TokenizedCss {
  css: string;
  tokens: MeasuredToken[];
  /** colours taken from a design token instead of a new measured one */
  aliased: number;
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");

/** `#abc`, `#aabbcc`, `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)` → `#rrggbb[aa]`, or null for other colour syntaxes. */
export function normColorValue(v: string): string | null {
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4)
      return `#${[...h].map((c) => c + c).join("")}`.replace(/ff$/, (x) => (h.length === 4 ? "" : x));
    if (h.length === 6) return `#${h}`;
    if (h.length === 8) return h.endsWith("ff") ? `#${h.slice(0, 6)}` : `#${h}`;
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4]!.endsWith("%") ? parseFloat(m[4]!) / 100 : parseFloat(m[4]!);
    const base = `#${hex2(+m[1]!)}${hex2(+m[2]!)}${hex2(+m[3]!)}`;
    return a >= 1 ? base : `${base}${hex2(a * 255)}`;
  }
  return null;
}

const URL_PART = /url\([^)]*\)/gi;

/** Maps the parts of `value` matching `re`, leaving `url(...)` alone. */
function replaceOutsideUrls(value: string, re: RegExp, fn: (m: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of value.matchAll(URL_PART)) {
    out += value.slice(last, m.index).replace(re, fn) + m[0];
    last = m.index! + m[0].length;
  }
  return out + value.slice(last).replace(re, fn);
}

/**
 * Moves every measured colour and length of `css` into named custom properties, so component CSS consumes tokens only.
 * Exact matches of a design token become that token; the rest get a token of the measured layer (one per distinct value,
 * in order of first use, so the same input always gives the same names).
 */
export function tokenizeCss(css: string, o: TokenizeOptions): TokenizedCss {
  const colors = new Map<string, string>();
  const sizes = new Map<string, string>();
  let aliased = 0;
  const colorVar = (raw: string): string => {
    const norm = normColorValue(raw);
    const key = norm ?? raw.trim().toLowerCase();
    const alias = norm ? o.aliases?.get(norm) : undefined;
    if (alias) {
      aliased++;
      return alias;
    }
    let name = colors.get(key);
    if (!name) {
      name = `${o.tokenPrefix}-color-${colors.size + 1}`;
      colors.set(key, name);
    }
    return `var(${name})`;
  };
  const sizeVar = (raw: string): string => {
    if (parseFloat(raw) === 0) return raw;
    const key = raw.toLowerCase();
    let name = sizes.get(key);
    if (!name) {
      name = `${o.tokenPrefix}-size-${sizes.size + 1}`;
      sizes.set(key, name);
    }
    return `var(${name})`;
  };
  const out = mapCssDeclarations(css, (prop, value) => {
    if (prop.startsWith("--")) return value;
    const withColors = replaceOutsideUrls(value, COLOR_RE, colorVar);
    return replaceOutsideUrls(withColors, LENGTH_RE, sizeVar);
  });
  const tokens: MeasuredToken[] = [
    ...[...colors].map(([value, name]) => ({ name, value, kind: "color" as const })),
    ...[...sizes].map(([value, name]) => ({ name, value, kind: "size" as const })),
  ];
  return { css: out, tokens, aliased };
}

/** The measured layer's stylesheet. */
export function measuredTokensCss(tokens: readonly MeasuredToken[], comment: string): string {
  return `/* ${comment} */\n:root {\n${tokens.map((t) => `  ${t.name}: ${t.value};`).join("\n")}\n}\n`;
}

const HAIRLINE = /^(?:border|outline|box-shadow)/i;

/**
 * Raw colours and sizes in component CSS. Zero, percentages and viewport units are not raw sizes; hairlines (1 to 3 px)
 * in a border, outline or box shadow are structural, as in the Carbon components this set follows. `url()`s and
 * custom property definitions are not values of a component's own.
 */
export function lintRawCss(css: string): RawValue[] {
  const found: RawValue[] = [];
  mapCssDeclarations(css, (prop, value, ctx) => {
    if (prop.startsWith("--")) return value;
    const clean = value.replace(URL_PART, "");
    for (const m of clean.matchAll(COLOR_RE)) found.push({ value: m[0], prop, selector: ctx.selector });
    for (const m of clean.matchAll(LENGTH_RE)) {
      if (parseFloat(m[0]) === 0) continue;
      if (HAIRLINE.test(prop) && /^-?[123](\.\d+)?px$/.test(m[0])) continue;
      found.push({ value: m[0], prop, selector: ctx.selector });
    }
    return value;
  });
  return found;
}

/** CSS of a Lit component source: the bodies of its `css` template literals. */
export function cssOfLitSource(source: string): string {
  return [...source.matchAll(/css`([\s\S]*?)`/g)].map((m) => m[1]!.replace(/\$\{[^}]*\}/g, "")).join("\n");
}

/** Lints a whole generated workspace (files by relative path): component CSS of the web components and the site. */
export function lintWorkspaceCss(files: Readonly<Record<string, string>>): { file: string; raw: RawValue }[] {
  const out: { file: string; raw: RawValue }[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    let css: string | null = null;
    if (/^packages\/web-components\/src\/.*\.ts$/.test(file) && !file.endsWith(".d.ts"))
      css = cssOfLitSource(content);
    else if (/^packages\/site\/src\/.*\.css$/.test(file) && !/site-tokens\.css$/.test(file)) css = content;
    if (!css) continue;
    for (const raw of lintRawCss(css)) out.push({ file, raw });
  }
  return out;
}
