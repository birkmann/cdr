// React export styles other than Tailwind. The React exporter
// (react.ts, reactComponents.ts) writes Tailwind classes; this reads every class string of the generated modules back
// as CSS — the classes are a closed set (tailwind.ts writes them losslessly from the IR's declarations) — and gives
// each class string one generated class name instead:
//   css-modules: `<Module>.module.css` next to each component / page, `className={styles.box}`;
//   vanilla:     one global `src/styles.css`, `className="home__box"`.
// Breakpoint looks (`min-[768px]:max-[1023.98px]:…`) become @media rules, `before:` / `after:` pseudo-element rules;
// the fluid values (calc() over 100vw) are arbitrary values and carry over as they are.
import { TAILWIND_TABLES } from "./tailwind.js";
import { resolveVars, type VarMap } from "./tokens.js";
import type { FileMap } from "./bundle.js";

export type ReactStyle = "tailwind" | "css-modules" | "vanilla";

/* ------------------------------------------------------------------ Tailwind class → declarations */

export interface ClassCss {
  /** viewport range of a breakpoint look (`min-[…]:` / `max-[…]:`) */
  min?: number;
  max?: number;
  pseudo?: "before" | "after";
  decls: Array<[string, string]>;
}

export interface DecodeOptions {
  /** token colours / radii / shadows as var(--t-…) (default) or, with `cssVars: false`, their values */
  cssVars?: boolean;
  vars?: VarMap;
}

const T = TAILWIND_TABLES;
const INVERSE_KEYWORD = new Map<string, [string, string]>();
for (const [prop, map] of Object.entries(T.keywords))
  for (const [v, cls] of Object.entries(map))
    if (!INVERSE_KEYWORD.has(cls)) INVERSE_KEYWORD.set(cls, [prop, v]);
// Tailwind's own definitions where tailwind.ts maps several values to one class
INVERSE_KEYWORD.set("flex-1", ["flex", "1 1 0%"]);
INVERSE_KEYWORD.set("flex-none", ["flex", "none"]);
const INVERSE_SIZE = new Map(Object.entries(T.sizePrefix).map(([prop, pre]) => [pre, prop]));
const INVERSE_RADIUS = new Map(Object.entries(T.radius).map(([v, cls]) => [cls, v]));
const INVERSE_SHADOW = new Map(Object.entries(T.shadow).map(([v, cls]) => [cls, v]));
const COLOR_PROP: Record<string, string> = {
  bg: "background-color",
  text: "color",
  border: "border-color",
  fill: "fill",
  stroke: "stroke",
};
const BOX: Record<string, string[]> = {
  p: ["padding"],
  px: ["padding-left", "padding-right"],
  py: ["padding-top", "padding-bottom"],
  m: ["margin"],
  mx: ["margin-left", "margin-right"],
  my: ["margin-top", "margin-bottom"],
};
const PROP_RE = /^(--[\w-]+|-?[a-z][a-z0-9-]*)$/;
const SIZE_WORD: Record<string, string> = { full: "100%", auto: "auto", fit: "fit-content" };

/** Arbitrary value → CSS (`_` is a space, `\_` an underscore). */
export const unarb = (v: string) =>
  v
    .replace(/\\_/g, "\u0000")
    .replace(/_/g, " ")
    .replace(/\u0000/g, "_");

function utilityCss(u: string, o: DecodeOptions): Array<[string, string]> | null {
  const tok = (v: string) => (o.cssVars === false && o.vars ? resolveVars(v, o.vars) : v);
  const kw = INVERSE_KEYWORD.get(u);
  if (kw) return [kw];
  const r = INVERSE_RADIUS.get(u);
  if (r) return [["border-radius", tok(r)]];
  const s = INVERSE_SHADOW.get(u);
  if (s) return [["box-shadow", tok(s)]];
  if (u === "font-sans") return [["font-family", tok("var(--t-font)")]];
  if (u === "font-mono") return [["font-family", tok("var(--t-font-mono)")]];
  if (u === "content-none") return [["content", "none"]];
  const prop = /^\[([^:\]]+):(.+)\]$/.exec(u);
  if (prop) return PROP_RE.test(prop[1]!) ? [[prop[1]!, unarb(prop[2]!)]] : null;
  const arbitrary = /^([a-z][a-z-]*?)-\[(.+)\]$/.exec(u);
  if (arbitrary) {
    const [, pre, raw] = arbitrary as unknown as [string, string, string];
    const v = unarb(raw);
    if (pre === "content") return [["content", v]];
    if (COLOR_PROP[pre] && T.literalColor.test(v)) return [[COLOR_PROP[pre]!, v]];
    if (BOX[pre]) return BOX[pre]!.map((p) => [p, v]);
    const p = INVERSE_SIZE.get(pre);
    return p ? [[p, v]] : null;
  }
  const word = /^([a-z][a-z-]*?)-(full|auto|fit)$/.exec(u);
  if (word) {
    const [, pre, w] = word as unknown as [string, string, string];
    if (BOX[pre] && w === "auto") return BOX[pre]!.map((p) => [p, "auto"]);
    const p = INVERSE_SIZE.get(pre);
    if (p) return [[p, SIZE_WORD[w]!]];
  }
  const color = /^(bg|text|border|fill|stroke)-([a-z][a-z0-9-]*)$/.exec(u);
  if (color) return [[COLOR_PROP[color[1]!]!, tok(`var(--t-${color[2]})`)]];
  return null;
}

/** One class the React exporter writes → its CSS (null: not one of them, e.g. a page's pseudo-element rule class). */
export function decodeClass(cls: string, o: DecodeOptions = {}): ClassCss | null {
  const out: Omit<ClassCss, "decls"> = {};
  let rest = cls;
  for (;;) {
    const m = /^(min|max)-\[(\d+(?:\.\d+)?)px\]:/.exec(rest);
    if (m) {
      out[m[1] as "min" | "max"] = Number(m[2]);
      rest = rest.slice(m[0].length);
      continue;
    }
    const p = /^(before|after):/.exec(rest);
    if (p) {
      out.pseudo = p[1] as "before" | "after";
      rest = rest.slice(p[0].length);
      continue;
    }
    break;
  }
  const decls = utilityCss(rest, o);
  return decls ? { ...out, decls } : null;
}

/* ------------------------------------------------------------------ class strings in generated modules */

/** A string literal in a module that holds classes. */
export interface ClassLiteral {
  start: number;
  /** after the closing quote */
  end: number;
  value: string;
  /** a JSX attribute value (`className="…"`): replaced by `{expr}` */
  jsx: boolean;
  /** `strict`: converted only when every class is the exporter's (look tables mix classes and look names) */
  strict: boolean;
  /** a readable base for the generated name (`box`, `smRoot`) */
  base: string;
}

type FrameKind = "code" | "class" | "style" | "table" | "template";
interface Frame {
  kind: FrameKind;
  key?: string;
  /** a class expression's element (`className={…}`) */
  tag?: string;
}

const TAG_BASE: Record<string, string> = {
  p: "text",
  span: "text",
  a: "link",
  img: "image",
  div: "box",
  li: "item",
  ul: "list",
  ol: "list",
  svg: "icon",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
};
const camel = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^[^A-Za-z]+/, "")
    .replace(/^./, (c) => c.toLowerCase());
const tagBase = (tag: string) => TAG_BASE[tag] ?? (camel(tag) || "box");
const isClassKey = (k: string) => /(^c|C)lass(Name)?\d*$/.test(k);

/**
 * The class strings of a generated module: a plain JS lexer (strings, comments, template literals, braces) that
 * knows the exporter's code shapes — `className="…"`, `className={cn("…", v.root)}`, `{ className: "…" }` items, look
 * tables `const VARIANTS = { sm: { root: "…" } }` — and skips style objects (`style={{ display: "block" }}`).
 * Generated JSX text never holds quotes or comment starts (react.ts jsxText), so the lexer needs no JSX mode.
 */
export function classLiterals(src: string): ClassLiteral[] {
  const out: ClassLiteral[] = [];
  const stack: Frame[] = [{ kind: "code" }];
  const before = (i: number) => src.slice(Math.max(0, i - 200), i).replace(/\s+$/, "");
  const tagAt = (i: number) => {
    const head = src.slice(Math.max(0, i - 4000), i);
    let m: RegExpExecArray | null,
      last = "";
    const re = /<([A-Za-z][\w.]*)/g;
    while ((m = re.exec(head))) last = m[1]!;
    return last;
  };
  const top = () => stack[stack.length - 1]!;
  const n = src.length;
  let i = 0;
  // inside a template literal's text: scan to its end or to a `${`
  const template = (from: number): number => {
    let k = from;
    while (k < n) {
      const c = src[k]!;
      if (c === "\\") k += 2;
      else if (c === "`") return k + 1;
      else if (c === "$" && src[k + 1] === "{") {
        stack.push({ kind: "template" });
        return k + 2;
      } else k++;
    }
    return n;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "`") {
      i = template(i + 1);
      continue;
    }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      const end = Math.min(n, k + 1);
      if (c === '"') {
        const lit = literalAt(src, i, end, before(i), top(), stack, tagAt);
        if (lit) out.push(lit);
      }
      i = end;
      continue;
    }
    if (c === "{") {
      const b = before(i);
      const parent = top();
      let f: Frame;
      if (/(^|[\s<])className=$/.test(b)) f = { kind: "class", tag: tagAt(i) };
      else if (/(^|\s)style=$/.test(b) || /[\w$]*[sS]tyle\s*:$/.test(b)) f = { kind: "style" };
      else if (/\bconst\s+VARIANTS\w*\s*=$/.test(b)) f = { kind: "table" };
      else if (parent.kind === "style" || parent.kind === "class") f = { kind: parent.kind, tag: parent.tag };
      else if (parent.kind === "table") {
        const key = /(?:([\w$]+)|"([^"]*)")\s*:$/.exec(b);
        f = { kind: "table", key: key?.[1] ?? key?.[2] };
      } else f = { kind: "code" };
      stack.push(f);
      i++;
      continue;
    }
    if (c === "}") {
      const f = stack.length > 1 ? stack.pop()! : top();
      i = f.kind === "template" ? template(i + 1) : i + 1;
      continue;
    }
    i++;
  }
  return out;
}

function literalAt(
  src: string,
  start: number,
  end: number,
  b: string,
  f: Frame,
  stack: Frame[],
  tagAt: (i: number) => string,
): ClassLiteral | null {
  if (f.kind === "style") return null;
  // an object key (`"sm-2": {`)
  if (/^\s*:/.test(src.slice(end, end + 20))) return null;
  const raw = src.slice(start + 1, end - 1);
  const jsVal = () => {
    try {
      return JSON.parse(src.slice(start, end)) as string;
    } catch {
      return null;
    }
  };
  // JSX attribute (no escapes in its value)
  const attr = /(?:^|[\s<])([A-Za-z][\w-]*)=$/.exec(b);
  if (attr) {
    if (attr[1] !== "className" && !/^[a-z]\w*Class$/.test(attr[1]!)) return null;
    const tag = tagAt(start);
    return {
      start,
      end,
      value: raw,
      jsx: true,
      strict: false,
      base: attr[1] === "className" ? tagBase(tag) : camel(attr[1]!.replace(/Class$/, "")),
    };
  }
  const value = jsVal();
  if (value === null) return null;
  const key = /([\w$]+)\s*:$/.exec(b)?.[1];
  if (f.kind === "class") return { start, end, value, jsx: false, strict: false, base: tagBase(f.tag ?? "") };
  if (/\bclassName\s*=$/.test(b)) return { start, end, value, jsx: false, strict: false, base: "root" };
  if (key && isClassKey(key))
    return {
      start,
      end,
      value,
      jsx: false,
      strict: false,
      base: key.startsWith("className") ? "item" : camel(key.replace(/Class(Name)?\d*$/, "")) || "item",
    };
  if (f.kind === "table") {
    const looks = stack
      .filter((x) => x.kind === "table" && x.key)
      .map((x) => x.key!)
      .join("-");
    return {
      start,
      end,
      value,
      jsx: false,
      strict: true,
      base: camel(`${looks}-${key ?? "root"}`.replace(/Class(Name)?\d*$/, "")) || "root",
    };
  }
  return null;
}

/* ------------------------------------------------------------------ conversion */

/** One generated class: its name and the classes it stands for. */
interface Rule {
  name: string;
  css: ClassCss[];
}

/** The class names and CSS of one module (css-modules) or the whole project (vanilla). */
class Sheet {
  readonly rules: Rule[] = [];
  private byClasses = new Map<string, string>();
  private used = new Set<string>();
  constructor(private readonly format: (base: string) => string) {}

  nameFor(classes: string[], css: ClassCss[], base: string): string {
    const key = classes.join(" ");
    const hit = this.byClasses.get(key);
    if (hit) return hit;
    const stem = this.format(base);
    let name = stem;
    for (let k = 2; this.used.has(name); k++) name = `${stem}${/\d$/.test(stem) ? "-" : ""}${k}`;
    this.used.add(name);
    this.byClasses.set(key, name);
    this.rules.push({ name, css });
    return name;
  }
}

const decl = (d: Array<[string, string]>, pad: string) => d.map(([p, v]) => `${pad}${p}: ${v};`).join("\n");
const mediaOf = (c: ClassCss) =>
  [
    ...(c.min !== undefined ? [`(min-width: ${c.min}px)`] : []),
    ...(c.max !== undefined ? [`(max-width: ${c.max}px)`] : []),
  ].join(" and ");

/** CSS for rules (base rules first, then each breakpoint range's: they win over the base ones they refine). */
export function sheetCss(groups: Array<{ comment?: string; rules: Rule[] }>): string {
  const base: string[] = [];
  const media = new Map<string, { min: number; max: number; body: string[] }>();
  const block = (sel: string, d: Array<[string, string]>, pad: string) =>
    `${pad}${sel} {\n${decl(d, pad + "  ")}\n${pad}}`;
  for (const g of groups) {
    const own: string[] = [];
    for (const r of g.rules) {
      const plain: Array<[string, string]> = [];
      const pseudo: Record<string, Array<[string, string]>> = {};
      for (const c of r.css) {
        const q = mediaOf(c);
        if (q) {
          const m = media.get(q) ?? { min: c.min ?? 0, max: c.max ?? Infinity, body: [] };
          media.set(q, m);
          m.body.push(block(`.${r.name}${c.pseudo ? `::${c.pseudo}` : ""}`, c.decls, "  "));
        } else if (c.pseudo) (pseudo[c.pseudo] ??= []).push(...c.decls);
        else plain.push(...c.decls);
      }
      if (plain.length) own.push(block(`.${r.name}`, plain, ""));
      for (const [p, d] of Object.entries(pseudo)) own.push(block(`.${r.name}::${p}`, d, ""));
    }
    if (own.length) base.push(...(g.comment ? [`/* ${g.comment} */`] : []), ...own);
  }
  const ranges = [...media.entries()]
    .sort(([, a], [, b]) => a.min - b.min || b.max - a.max)
    .map(([q, m]) => `@media ${q} {\n${m.body.join("\n")}\n}`);
  return `${[...base, ...ranges].join("\n\n")}\n`;
}

export interface ConvertOptions extends DecodeOptions {
  style: Exclude<ReactStyle, "tailwind">;
}

/** Name of a module for vanilla class prefixes and module CSS (`src/screens/Home.tsx` → `Home`). */
const moduleName = (path: string) => path.replace(/^.*\//, "").replace(/\.tsx?$/, "");
const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

/**
 * The React project's Tailwind classes → generated classes and CSS (css-modules: `<Module>.module.css` per
 * component / page module; vanilla: `src/styles.css`). Classes that are not the exporter's (pseudo-element rule
 * classes of the page CSS, `home-fx-1`) stay as they are. Returns the new files; non-module files are untouched.
 */
export function convertReactStyles(files: FileMap, o: ConvertOptions): FileMap {
  const out: FileMap = { ...files };
  const modules = Object.keys(files)
    .filter((p) => /^src\/(components|screens)\/[^/]+\.tsx$/.test(p))
    .sort((a, b) =>
      a.startsWith("src/components") === b.startsWith("src/components")
        ? a.localeCompare(b)
        : a.startsWith("src/components")
          ? -1
          : 1,
    );
  const global =
    o.style === "vanilla"
      ? { sheet: null as Sheet | null, groups: [] as Array<{ comment: string; rules: Rule[] }> }
      : null;
  for (const path of modules) {
    const src = String(files[path]);
    const name = moduleName(path);
    const sheet =
      o.style === "css-modules"
        ? new Sheet((b) => camel(b) || "box")
        : new Sheet((b) => `${kebab(name)}__${kebab(b) || "box"}`);
    let code = "";
    let at = 0;
    for (const lit of classLiterals(src)) {
      const classes = lit.value.split(/\s+/).filter(Boolean);
      if (!classes.length) continue;
      const known: string[] = [],
        css: ClassCss[] = [],
        other: string[] = [];
      for (const c of classes) {
        const d = decodeClass(c, o);
        if (d) {
          known.push(c);
          css.push(d);
        } else other.push(c);
      }
      if (!known.length || (lit.strict && other.length)) continue;
      const cls = sheet.nameFor(known, css, lit.base);
      let expr: string;
      if (o.style === "css-modules") {
        const ref = /^[A-Za-z_$][\w$]*$/.test(cls) ? `styles.${cls}` : `styles[${JSON.stringify(cls)}]`;
        expr = other.length ? `\`\${${ref}} ${other.join(" ")}\`` : ref;
        code += src.slice(at, lit.start) + (lit.jsx ? `{${expr}}` : expr);
      } else {
        const v = [cls, ...other].join(" ");
        code += src.slice(at, lit.start) + (lit.jsx ? `"${v}"` : JSON.stringify(v));
      }
      at = lit.end;
    }
    code += src.slice(at);
    if (o.style === "css-modules" && sheet.rules.length) {
      out[path.replace(/\.tsx$/, ".module.css")] =
        `/* ${name}: the classes of ${name}.tsx (generated from the captured page's styles) */\n${sheetCss([{ rules: sheet.rules }])}`;
      code = addImport(code, `import styles from './${name}.module.css'`);
    }
    if (global && sheet.rules.length) global.groups.push({ comment: `${name}.tsx`, rules: sheet.rules });
    out[path] = code;
  }
  if (global)
    out["src/styles.css"] =
      `/* The page's classes (generated from the captured page's styles): one rule per class string of the components\n   and pages, breakpoint looks as @media rules after them. */\n${sheetCss(global.groups)}`;
  return out;
}

/** An import line after the module's last import (or at its top, after a leading comment line). */
export function addImport(code: string, line: string): string {
  const lines = code.split("\n");
  let last = -1;
  lines.forEach((l, k) => {
    if (/^import\s/.test(l)) last = k;
  });
  if (last < 0) last = lines[0]?.startsWith("//") ? 0 : -1;
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}
