// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Lint of a DESIGN.md, offline and dependency-free. The earlier project runs Google's linter (`npx @google/design.md lint`) and
// adds its own checks on top; the official package is not available offline, so the Google-side rules this module
// knows from design-md--generator/spec/format.md (§2, §3, §6) and spec/schema.json are re-implemented here under the
// same rule ids:
//   google (re-implemented)
//     front-matter        no YAML front matter / it does not parse (error)
//     missing-key         a required top-level key is missing: name, colors, typography, rounded, spacing,
//                         components (error)
//     invalid-color       a colour token is not #rgb/#rrggbb/#rrggbbaa (or a ref) (error)
//     invalid-dimension   fontSize / rounded / spacing / letterSpacing not a px/em/rem dimension (`normal` is the
//                         known case) (error); lineHeight not a positive number or dimension (error)
//     invalid-typography  a typography role misses fontFamily / fontSize / fontWeight / lineHeight (error)
//     unknown-property    a typography prop or component sub-token outside the spec's set (warning; textTransform
//                         is the known case)
//     missing-primary     no `primary` colour (warning)
//     orphaned-tokens     a colour no component references (warning)
//     contrast-ratio      component text/background contrast < 4.5 (warning; a missing background is not checked)
//     section-order       sections 1–8 out of order (warning, Google) — superseded by ours below (error)
//   ours (cli/lint.mjs)
//     broken-ref          `{a.b}` does not resolve: front matter error, prose warning
//     section-order       the 11 sections out of order (error); section-duplicate (error); section-missing (warning)
//     literal-hex         a component prop holds a literal hex that a colour token has (error)
//     ungrounded-hex/-px  a hex / px value in the prose that is not in the front matter (warning)
// Pure: text in, findings out.

/* ------------------------------------------------------------------ YAML (subset) */

export type Yaml = any;

/**
 * The YAML subset DESIGN.md uses: block mappings / sequences by indentation, `- key: v` items, `|` `>` block scalars
 * (with -/+ chomping), single / double quoted scalars (multi-line too), plain scalars (multi-line folded), flow
 * sequences of scalars, comments. Throws on a line it cannot read.
 */
export function parseDesignMdYaml(text: string): Yaml {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const indentOf = (l: string) => l.match(/^ */)![0].length;
  const blank = (l: string) => /^\s*(#.*)?$/.test(l);
  const skip = () => {
    while (i < lines.length && blank(lines[i])) i++;
  };

  function scalar(raw: string): Yaml {
    const s = raw.trim();
    if (s === "" || s === "~" || s === "null") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    if (s[0] === '"') return JSON.parse(s.replace(/\\\//g, "/").replace(/\t/g, "\\t"));
    if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
    if (s[0] === "[") return splitFlow(s.slice(1, s.lastIndexOf("]"))).map(scalar);
    const plain = s.replace(/\s+#.*$/, "");
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(plain)) return Number(plain);
    return plain;
  }
  function splitFlow(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    let q = "";
    for (const ch of s) {
      if (q) {
        cur += ch;
        if (ch === q) q = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        cur += ch;
        continue;
      }
      if (ch === ",") {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.filter((x) => x.trim() !== "");
  }
  function inlineValue(first: string, ind: number): Yaml {
    let v = first.trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const closed = (s: string) =>
        q === '"'
          ? /(^|[^\\])(\\\\)*"\s*(#.*)?$/.test(s.slice(1))
          : /'\s*(#.*)?$/.test(s.slice(1)) && !/''$/.test(s.slice(1).replace(/'\s*(#.*)?$/, ""));
      while (!closed(v) && i < lines.length) {
        const nx = lines[i++].trim();
        v += nx === "" ? "\\n" : " " + nx;
      }
      v = v.replace(/\s+#[^"']*$/, "");
      return scalar(v);
    }
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      indentOf(lines[i]) > ind &&
      !/^\s*-\s/.test(lines[i]) &&
      !/^\s*[^\s:#][^:#]*:(\s|$)/.test(lines[i])
    )
      v += " " + lines[i++].trim();
    return scalar(v);
  }
  function blockScalar(header: string, ind: number): string {
    const folded = header[0] === ">";
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const body: string[] = [];
    let contentIndent = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") {
        body.push("");
        i++;
        continue;
      }
      const n = indentOf(l);
      if (n <= ind) break;
      if (contentIndent < 0) contentIndent = n;
      if (n < contentIndent) break;
      body.push(l.slice(contentIndent));
      i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    let out: string;
    if (!folded) out = body.join("\n");
    else {
      out = "";
      for (let k = 0; k < body.length; k++) {
        const l = body[k];
        if (k === 0) {
          out = l;
          continue;
        }
        if (l === "") {
          out += "\n";
          continue;
        }
        const prev = body[k - 1];
        out += prev === "" || /^\s/.test(l) || /^\s/.test(prev) ? (prev === "" ? "" : "\n") + l : " " + l;
      }
    }
    if (chomp === "clip" && body.length) out += "\n";
    if (chomp === "keep") out += "\n".repeat(trailing + 1);
    return out;
  }
  function value(rest: string, ind: number): Yaml {
    const r = rest.trim();
    if (r === "" || r.startsWith("#")) {
      skip();
      if (
        i < lines.length &&
        (indentOf(lines[i]) > ind || (indentOf(lines[i]) === ind && /^\s*-(\s|$)/.test(lines[i])))
      )
        return block(indentOf(lines[i]));
      return null;
    }
    if (/^[|>][-+]?\s*(#.*)?$/.test(r)) return blockScalar(r, ind);
    return inlineValue(r, ind);
  }
  function block(ind: number): Yaml {
    skip();
    if (i >= lines.length) return null;
    return /^\s*-(\s|$)/.test(lines[i]) ? sequence(ind) : mapping(ind);
  }
  function mapping(ind: number): Record<string, Yaml> {
    const out: Record<string, Yaml> = {};
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== ind || /^\s*-(\s|$)/.test(lines[i])) break;
      const l = lines[i].slice(ind);
      const m =
        l.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"][^:#]*?)\s*:(?:\s+(.*))?$/) ||
        l.match(/^([^:]+?)\s*:$/);
      if (!m) throw new Error(`YAML: cannot parse line ${i + 1}: ${lines[i]}`);
      i++;
      const key = /^["']/.test(m[1]) ? String(scalar(m[1])) : m[1];
      out[key] = value(m[2] ?? "", ind);
    }
    return out;
  }
  function sequence(ind: number): Yaml[] {
    const out: Yaml[] = [];
    for (;;) {
      skip();
      if (i >= lines.length || indentOf(lines[i]) !== ind || !/^\s*-(\s|$)/.test(lines[i])) break;
      const rest = lines[i].slice(ind + 1).replace(/^ /, "");
      if (rest.trim() === "") {
        i++;
        out.push(value("", ind));
        continue;
      }
      if (/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[{][^:#]*?)\s*:(\s|$)/.test(rest)) {
        lines[i] = " ".repeat(ind + 2) + rest.trimStart();
        out.push(mapping(ind + 2));
        continue;
      }
      i++;
      out.push(/^[|>][-+]?\s*$/.test(rest.trim()) ? blockScalar(rest.trim(), ind) : inlineValue(rest, ind));
    }
    return out;
  }
  return block(0) ?? {};
}

/* ------------------------------------------------------------------ DESIGN.md parts */

export interface DesignMdParts {
  frontMatter: Yaml;
  yaml: string;
  body: string;
  /** 1-based line where the body starts */
  bodyLine: number;
  /** false when the file has no `---` front matter */
  hasFrontMatter: boolean;
}

/** Split a DESIGN.md into front matter (parsed), body text and the line where the body starts. */
export function splitDesignMd(text: string): DesignMdParts {
  const src = text.replace(/\r\n?/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  if (!m) return { frontMatter: {}, yaml: "", body: src, bodyLine: 1, hasFrontMatter: false };
  return {
    frontMatter: parseDesignMdYaml(m[1]),
    yaml: m[1],
    body: src.slice(m[0].length),
    bodyLine: m[0].split("\n").length,
    hasFrontMatter: true,
  };
}

export const LINT_SECTIONS = [
  "Overview",
  "Colors",
  "Typography",
  "Layout",
  "Elevation & Depth",
  "Shapes",
  "Components",
  "Do's and Don'ts",
  "Responsive Behavior",
  "Iteration Guide",
  "Known Gaps",
];
const ALIASES: Record<string, string> = {
  "brand & style": "Overview",
  "layout & spacing": "Layout",
  elevation: "Elevation & Depth",
  "dos and don'ts": "Do's and Don'ts",
  "do's & don'ts": "Do's and Don'ts",
  responsive: "Responsive Behavior",
};

/** Canonical section name for a `##` heading (the spec's aliases folded in), or null for an unknown heading. */
export function canonicalSection(title: string): string | null {
  const t = title.trim().replace(/[‘’]/g, "'").toLowerCase();
  return LINT_SECTIONS.find((s) => s.toLowerCase() === t) ?? ALIASES[t] ?? null;
}

export interface BodySection {
  title: string;
  canonical: string | null;
  line: number;
  text: string;
  subsections: Array<{ title: string; line: number; text: string }>;
}

/** `##` sections of the body with their `###` subsections, text and line numbers (code fences skipped). */
export function bodySections(body: string, bodyLine = 1): BodySection[] {
  const out: BodySection[] = [];
  let cur: BodySection | null = null;
  let sub: BodySection["subsections"][number] | null = null;
  let fence = false;
  body.split("\n").forEach((line, k) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h2 = !fence && line.match(/^##\s+(.+?)\s*#*\s*$/);
    const h3 = !fence && line.match(/^###\s+(.+?)\s*#*\s*$/);
    if (h2) {
      cur = {
        title: h2[1],
        canonical: canonicalSection(h2[1]),
        line: bodyLine + k,
        text: "",
        subsections: [],
      };
      sub = null;
      out.push(cur);
      return;
    }
    if (!cur) return;
    if (h3) {
      sub = { title: h3[1], line: bodyLine + k, text: "" };
      cur.subsections.push(sub);
      return;
    }
    cur.text += line + "\n";
    if (sub) sub.text += line + "\n";
  });
  return out;
}

/** Resolve `a.b` (or `{a.b}`) against the front matter; `component.x` reads `components.x`. undefined when broken. */
export function resolveRef(fm: Yaml, ref: string): Yaml {
  const path = ref.replace(/^\{|\}$/g, "").split(".");
  if (path[0] === "component") path[0] = "components";
  let v = fm;
  for (const p of path) {
    if (v == null || typeof v !== "object" || !(p in v)) return undefined;
    v = v[p];
  }
  return v;
}

/** Resolve a value through refs until it is not a single `{ref}` (max 8 hops). */
export function deref(fm: Yaml, v: Yaml): Yaml {
  for (let k = 0; k < 8 && typeof v === "string" && /^\{[^{}]+\}$/.test(v.trim()); k++)
    v = resolveRef(fm, v.trim());
  return v;
}

/* ------------------------------------------------------------------ colour / value helpers */

/** #rgb / #rgba / #rrggbb / #rrggbbaa → lowercase #rrggbb (alpha dropped when ff); null if not hex. */
export function normHexColor(s: unknown): string | null {
  const m = String(s ?? "")
    .trim()
    .match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  return "#" + (h.length === 8 && h.endsWith("ff") ? h.slice(0, 6) : h);
}

function luminanceOf(hex: string): number | null {
  const h = normHexColor(hex);
  if (!h) return null;
  const [r, g, b] = [1, 3, 5]
    .map((k) => parseInt(h.slice(k, k + 2), 16))
    .map((c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pxValues(s: unknown): number[] {
  if (typeof s === "number") return s === 0 ? [0] : [];
  return [...String(s).matchAll(/(-?\d*\.?\d+)px\b/g)].map((m) => Number(m[1]));
}

function leaves(obj: Yaml, prefix = ""): Array<[string, Yaml]> {
  const out: Array<[string, Yaml]> = [];
  if (obj && typeof obj === "object")
    for (const [k, v] of Object.entries(obj)) out.push(...leaves(v, prefix ? `${prefix}.${k}` : k));
  else out.push([prefix, obj]);
  return out;
}

const isObj = (v: Yaml): v is Record<string, Yaml> => !!v && typeof v === "object" && !Array.isArray(v);
const DIMENSION = /^-?(\d+|\d*\.\d+)(px|em|rem)$/;
const REF_ONLY = /^\{[a-z][\w-]*(\.[\w-]+)+\}$/i;
const isDimension = (v: Yaml) => (typeof v === "string" && DIMENSION.test(v.trim())) || v === 0;
const TYPO_PROPS = new Set([
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "fontFeature",
  "fontVariation",
]);
const COMPONENT_PROPS = new Set([
  "backgroundColor",
  "textColor",
  "typography",
  "rounded",
  "padding",
  "size",
  "height",
  "width",
]);

/* ------------------------------------------------------------------ lint */

export interface LintFinding {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  path?: string;
  line?: number;
  /** google = a re-implemented rule of `@google/design.md lint`; ours = design-md--generator/cli/lint.mjs */
  source: "google" | "ours";
}

export interface LintResult {
  errors: number;
  warnings: number;
  info: number;
  findings: LintFinding[];
  stats: { fmRefs: number; proseRefs: number; hex: number; hexFound: number; px: number; pxFound: number };
}

const HEX_RE = /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const REF_RE = /\{([a-zA-Z][\w-]*(?:\.[\w-]+)+)\}/g;
const PLACEHOLDER_REFS = new Set(["token.refs", "token.ref"]);

function lineOf(text: string, index: number, base: number) {
  return base + text.slice(0, index).split("\n").length - 1;
}

/**
 * Lint a DESIGN.md text. `facts` (brand.json) widens what counts as grounded in the prose. Never throws: a front
 * matter that does not parse is one `front-matter` error.
 */
export function lintDesignMd(text: string, o: { facts?: unknown } = {}): LintResult {
  const out: LintFinding[] = [];
  const add = (
    source: LintFinding["source"],
    severity: LintFinding["severity"],
    rule: string,
    message: string,
    extra: { path?: string; line?: number } = {},
  ) => out.push({ severity, rule, message, source, ...extra });
  const stats = { fmRefs: 0, proseRefs: 0, hex: 0, hexFound: 0, px: 0, pxFound: 0 };
  const finish = (): LintResult => ({
    errors: out.filter((f) => f.severity === "error").length,
    warnings: out.filter((f) => f.severity === "warning").length,
    info: out.filter((f) => f.severity === "info").length,
    findings: out,
    stats,
  });

  let parts: DesignMdParts;
  try {
    parts = splitDesignMd(text);
  } catch (e) {
    add(
      "google",
      "error",
      "front-matter",
      `front matter does not parse: ${e instanceof Error ? e.message : String(e)}`,
    );
    return finish();
  }
  const { body, bodyLine } = parts;
  const fm: Yaml = isObj(parts.frontMatter) ? parts.frontMatter : {};
  if (!parts.hasFrontMatter)
    add("google", "error", "front-matter", "no YAML front matter (--- … ---) at the top");

  /* --- Google's schema rules (re-implemented) */
  if (typeof fm.name !== "string" || !fm.name.trim())
    add("google", "error", "missing-key", "name is required");
  for (const k of ["colors", "typography", "rounded", "spacing", "components"])
    if (parts.hasFrontMatter && !isObj(fm[k]))
      add("google", "error", "missing-key", `${k} is required (a map)`);
  const colors: Record<string, Yaml> = isObj(fm.colors) ? fm.colors : {};
  for (const [k, v] of Object.entries(colors)) {
    const ok = (typeof v === "string" && (normHexColor(v) || REF_ONLY.test(v.trim()))) || false;
    if (!ok)
      add("google", "error", "invalid-color", `colors.${k} = ${JSON.stringify(v)} is not a colour`, {
        path: `colors.${k}`,
      });
  }
  if (parts.hasFrontMatter && isObj(fm.colors) && !("primary" in colors))
    add("google", "warning", "missing-primary", "no `primary` colour");
  for (const [k, t] of Object.entries(isObj(fm.typography) ? fm.typography : {})) {
    const path = `typography.${k}`;
    if (!isObj(t)) {
      add("google", "error", "invalid-typography", `${path} is not a map`, { path });
      continue;
    }
    for (const req of ["fontFamily", "fontSize", "fontWeight", "lineHeight"])
      if (t[req] === undefined || t[req] === null)
        add("google", "error", "invalid-typography", `${path}.${req} is missing`, { path });
    if (t.fontSize !== undefined && !isDimension(t.fontSize))
      add("google", "error", "invalid-dimension", `${path}.fontSize = ${JSON.stringify(t.fontSize)}`, {
        path,
      });
    if (t.letterSpacing !== undefined && !isDimension(t.letterSpacing))
      add(
        "google",
        "error",
        "invalid-dimension",
        `${path}.letterSpacing = ${JSON.stringify(t.letterSpacing)}`,
        { path },
      );
    if (
      t.lineHeight !== undefined &&
      !(typeof t.lineHeight === "number" && t.lineHeight > 0) &&
      !isDimension(t.lineHeight)
    )
      add("google", "error", "invalid-dimension", `${path}.lineHeight = ${JSON.stringify(t.lineHeight)}`, {
        path,
      });
    if (t.fontWeight !== undefined && !(Number(t.fontWeight) >= 1 && Number(t.fontWeight) <= 1000))
      add("google", "error", "invalid-typography", `${path}.fontWeight = ${JSON.stringify(t.fontWeight)}`, {
        path,
      });
    for (const p of Object.keys(t))
      if (!TYPO_PROPS.has(p))
        add("google", "warning", "unknown-property", `${path}.${p} is not a DESIGN.md typography property`, {
          path,
        });
  }
  for (const group of ["rounded", "spacing"])
    for (const [k, v] of Object.entries(isObj(fm[group]) ? fm[group] : {}))
      if (!isDimension(v) && !(group === "spacing" && typeof v === "number"))
        add("google", "error", "invalid-dimension", `${group}.${k} = ${JSON.stringify(v)}`, {
          path: `${group}.${k}`,
        });
  const components: Record<string, Yaml> = isObj(fm.components) ? fm.components : {};
  const usedColors = new Set<string>();
  for (const [name, props] of Object.entries(components)) {
    if (!isObj(props)) {
      add("google", "error", "invalid-component", `components.${name} is not a map`, {
        path: `components.${name}`,
      });
      continue;
    }
    for (const [p, v] of Object.entries(props)) {
      if (!COMPONENT_PROPS.has(p))
        add(
          "google",
          "warning",
          "unknown-property",
          `components.${name}.${p} is not a DESIGN.md component sub-token`,
          {
            path: `components.${name}.${p}`,
          },
        );
      if (typeof v === "string")
        for (const m of v.matchAll(REF_RE)) if (m[1].startsWith("colors.")) usedColors.add(m[1].slice(7));
    }
    const bg = normHexColor(deref(fm, props.backgroundColor));
    const fg = normHexColor(deref(fm, props.textColor));
    if (bg && fg && bg.length === 7 && fg.length === 7) {
      const a = luminanceOf(bg)!,
        b = luminanceOf(fg)!;
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5)
        add(
          "google",
          "warning",
          "contrast-ratio",
          `components.${name}: text on background is ${ratio.toFixed(2)}:1 (< 4.5)`,
          {
            path: `components.${name}`,
          },
        );
    }
  }
  // colours referenced only through another colour count as used
  for (const [k, v] of Object.entries(colors))
    if (usedColors.has(k) && typeof v === "string")
      for (const m of v.matchAll(REF_RE)) usedColors.add(m[1].replace(/^colors\./, ""));
  for (const k of Object.keys(colors))
    if (!usedColors.has(k))
      add("google", "warning", "orphaned-tokens", `colors.${k} is not used by any component`, {
        path: `colors.${k}`,
      });

  /* --- ours (cli/lint.mjs) */
  for (const [path, v] of leaves(fm)) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(REF_RE)) {
      stats.fmRefs++;
      if (resolveRef(fm, m[1]) === undefined)
        add("ours", "error", "broken-ref", `{${m[1]}} does not resolve`, { path });
    }
  }
  for (const m of body.matchAll(REF_RE)) {
    if (PLACEHOLDER_REFS.has(m[1])) continue;
    stats.proseRefs++;
    if (resolveRef(fm, m[1]) === undefined)
      add("ours", "warning", "broken-ref", `prose ref {${m[1]}} does not resolve`, {
        line: lineOf(body, m.index, bodyLine),
      });
  }

  const secs = bodySections(body, bodyLine);
  const seen = new Map<string, number>();
  let last = -1;
  for (const s of secs) {
    if (!s.canonical) {
      add("ours", "info", "unknown-section", `## ${s.title} is not one of the 11 sections`, { line: s.line });
      continue;
    }
    if (seen.has(s.canonical))
      add(
        "ours",
        "error",
        "section-duplicate",
        `## ${s.canonical} appears twice (line ${seen.get(s.canonical)})`,
        {
          line: s.line,
        },
      );
    seen.set(s.canonical, s.line);
    const idx = LINT_SECTIONS.indexOf(s.canonical);
    if (idx < last)
      add("ours", "error", "section-order", `## ${s.title} comes after ## ${LINT_SECTIONS[last]}`, {
        line: s.line,
      });
    last = Math.max(last, idx);
  }
  for (const s of LINT_SECTIONS)
    if (!seen.has(s)) add("ours", "warning", "section-missing", `## ${s} is missing`);

  const tokenByHex = new Map<string, string>();
  for (const [k, v] of Object.entries(colors)) {
    const h = normHexColor(v);
    if (h && !tokenByHex.has(h)) tokenByHex.set(h, k);
  }
  for (const [name, props] of Object.entries(components)) {
    if (!isObj(props)) continue;
    for (const [p, v] of Object.entries(props)) {
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(HEX_RE)) {
        const tok = tokenByHex.get(normHexColor(m[0])!);
        if (tok)
          add("ours", "error", "literal-hex", `components.${name}.${p} = ${m[0]}, use {colors.${tok}}`, {
            path: `components.${name}.${p}`,
          });
      }
    }
  }

  const fmHex = new Set(Object.values(colors).map(normHexColor).filter(Boolean) as string[]);
  const fmPx = new Set<number>();
  for (const [path, v] of leaves(fm)) {
    if (/^(seo|description|mockups)\b/.test(path)) continue;
    for (const n of pxValues(v)) fmPx.add(n);
  }
  if (o.facts)
    for (const [, v] of leaves(o.facts)) {
      if (typeof v === "number") fmPx.add(v);
      else if (typeof v === "string") {
        for (const m of v.matchAll(HEX_RE)) fmHex.add(normHexColor(m[0])!);
        for (const n of pxValues(v)) fmPx.add(n);
      }
    }
  const seo = isObj(fm.seo) ? fm.seo : {};
  const prose: Array<[string, (k: number) => { path?: string; line?: number }]> = [
    [body, (k) => ({ line: lineOf(body, k, bodyLine) })],
  ];
  for (const [path, v] of leaves({
    description: fm.description,
    seo: {
      title: seo.title,
      metaDescription: seo.metaDescription,
      highlights: seo.highlights,
      opening: seo.opening,
      questions: seo.questions,
    },
  }))
    if (typeof v === "string") prose.push([v, () => ({ path })]);
  const missHex = new Map<string, { path?: string; line?: number }>();
  const missPx = new Map<number, { path?: string; line?: number }>();
  for (const [t, where] of prose) {
    for (const m of t.matchAll(HEX_RE)) {
      const h = normHexColor(m[0])!;
      stats.hex++;
      if (fmHex.has(h)) stats.hexFound++;
      else if (!missHex.has(h)) missHex.set(h, where(m.index));
    }
    for (const m of t.matchAll(/(?<![\w.#-])(\d*\.?\d+)px\b/g)) {
      const n = Number(m[1]);
      stats.px++;
      if (fmPx.has(n)) stats.pxFound++;
      else if (!missPx.has(n)) missPx.set(n, where(m.index));
    }
  }
  for (const [h, at] of missHex)
    add("ours", "warning", "ungrounded-hex", `${h} in the prose is not a front-matter colour`, at);
  for (const [n, at] of missPx)
    add("ours", "warning", "ungrounded-px", `${n}px in the prose occurs nowhere in the front matter`, at);
  return finish();
}
