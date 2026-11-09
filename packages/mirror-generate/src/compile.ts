/**
 * design/components/*.json `template` (original outer HTML + Handlebars subset, see @cmp/design render.ts) → TSX.
 *
 *   {{path}}        → {R.text(R.val(s, "path"), ctx)}          escaped text
 *   {{{path}}}      → <R.Html value={R.val(s, "path")} ctx={ctx} />   rich text / html / rendered component
 *   {{#each p}}…    → {R.each(s, "p", (s1) => <>…</>)}         this / this.x / @index / @first / @last
 *   {{#if p}}…{{else}}…{{/if}} → {R.truthy(R.val(s, "p")) ? <>…</> : <>…</>}
 *   attr="a {{#if x}}b{{/if}} {{y}}"  → attr={R.cat("a ", R.truthy(…) ? "b" : "", " ", R.attr(R.val(s, "y")))}
 *   <a{{#if this.active}} aria-current="page"{{/if}}> → {...(R.truthy(…) ? { "aria-current": "page" } : {})}
 *
 * The DOM, class names and every whitespace text node of the original are kept (text is emitted as string literals),
 * so the ported CSS renders identically. Output is deterministic (same input → same bytes).
 */
import { BOOLEAN_ATTRS, parseHtml, reactAttrName, styleToObject, VOID, type HElement, type HNode } from "./template-html-parse.js";

const TOKEN = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#/]?)(each|if|else)?\s*([^}]*?)\s*\}\}/g;
const S_OPEN = "";
const S_CLOSE = "";
const SENTINEL = /(\d+)/g;

type Mustache =
  | { k: "var"; path: string; raw: boolean }
  | { k: "open"; block: "each" | "if"; path: string }
  | { k: "else" }
  | { k: "close"; block: "each" | "if" };

export class TemplateCompileError extends Error {}

function lexMustaches(src: string): { html: string; ms: Mustache[] } {
  const ms: Mustache[] = [];
  const html = src.replace(TOKEN, (_m, triple: string | undefined, sigil: string, kw: string | undefined, rest: string) => {
    let t: Mustache;
    if (triple !== undefined) t = { k: "var", path: triple.trim(), raw: true };
    else if (sigil === "#" && (kw === "each" || kw === "if")) t = { k: "open", block: kw, path: rest.trim() };
    else if (sigil === "/" && (kw === "each" || kw === "if")) t = { k: "close", block: kw };
    else if (!sigil && kw === "else" && !rest) t = { k: "else" };
    else t = { k: "var", path: `${kw ?? ""}${kw && rest ? " " : ""}${rest}`.trim(), raw: false };
    ms.push(t);
    return `${S_OPEN}${ms.length - 1}${S_CLOSE}`;
  });
  return { html, ms };
}

// ---------------------------------------------------------------- structuring (flat tokens → block tree)

type Flat<T> = { t: "item"; v: T } | { t: "m"; m: Mustache };
type Tree<T> = { t: "item"; v: T } | { t: "var"; path: string; raw: boolean } | { t: "if"; path: string; body: Tree<T>[]; else: Tree<T>[] } | { t: "each"; path: string; body: Tree<T>[] };

function structure<T>(flat: Flat<T>[], where: string): Tree<T>[] {
  const root: Tree<T>[] = [];
  const stack: { node: Tree<T> | null; list: Tree<T>[] }[] = [{ node: null, list: root }];
  const top = () => stack[stack.length - 1];
  for (const f of flat) {
    if (f.t === "item") {
      top().list.push(f);
      continue;
    }
    const m = f.m;
    if (m.k === "var") top().list.push({ t: "var", path: m.path, raw: m.raw });
    else if (m.k === "open") {
      const node: Tree<T> = m.block === "each" ? { t: "each", path: m.path, body: [] } : { t: "if", path: m.path, body: [], else: [] };
      top().list.push(node);
      stack.push({ node, list: node.t === "each" || node.t === "if" ? node.body : [] });
    } else if (m.k === "else") {
      const n = top().node;
      if (!n || n.t !== "if") throw new TemplateCompileError(`{{else}} outside {{#if}} (${where})`);
      top().list = n.else;
    } else {
      const n = top().node;
      if (!n || n.t !== m.block) throw new TemplateCompileError(`unbalanced {{/${m.block}}} (${where}) — blocks must open and close within the same element`);
      stack.pop();
    }
  }
  if (stack.length !== 1) throw new TemplateCompileError(`unclosed {{#${(top().node as { t: string }).t}}} (${where}) — blocks must open and close within the same element`);
  return root;
}

function splitSentinels(s: string, ms: Mustache[]): Flat<string>[] {
  const out: Flat<string>[] = [];
  let last = 0;
  for (const m of s.matchAll(SENTINEL)) {
    if (m.index! > last) out.push({ t: "item", v: s.slice(last, m.index) });
    out.push({ t: "m", m: ms[Number(m[1])] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ t: "item", v: s.slice(last) });
  return out;
}

// ---------------------------------------------------------------- emitter

const q = (s: string) => JSON.stringify(s);

export interface CompileOptions {
  /** component id, for error messages */
  id?: string;
}
export interface CompileResult {
  /** JSX expression (a fragment) using `s0` (root scope), `ctx` and `R` (runtime) */
  jsx: string;
  paths: string[];
  warnings: string[];
}

export function compileTemplate(template: string, opts: CompileOptions = {}): CompileResult {
  const { html, ms } = lexMustaches(template);
  const nodes = parseHtml(html);
  const warnings: string[] = [];
  const paths = new Set<string>();
  let scopeN = 0;
  const where = opts.id ?? "template";

  const val = (sv: string, path: string) => {
    paths.add(path);
    return `R.val(${sv}, ${q(path)})`;
  };

  /** attribute value (string with sentinels) → string expression */
  const attrValue = (raw: string, sv: string): { expr: string; dynamic: boolean } => {
    const flat = splitSentinels(raw, ms);
    if (flat.every((f) => f.t === "item")) return { expr: q(raw), dynamic: false };
    const tree = structure(flat, `${where} attribute`);
    const emit = (ts: Tree<string>[], s: string): string => {
      const parts = ts.map((t): string => {
        switch (t.t) {
          case "item":
            return q(t.v);
          case "var":
            return `R.attr(${val(s, t.path)})`;
          case "if":
            return `(R.truthy(${val(s, t.path)}) ? ${emit(t.body, s)} : ${t.else.length ? emit(t.else, s) : '""'})`;
          case "each": {
            const ns = `s${++scopeN}`;
            return `R.eachStr(${s}, ${q(t.path)}, (${ns}) => ${emit(t.body, ns)})`;
          }
        }
      });
      if (!parts.length) return '""';
      return parts.length === 1 ? parts[0] : `R.cat(${parts.join(", ")})`;
    };
    return { expr: emit(tree, sv), dynamic: true };
  };

  type AttrItem = { name: string; value: string | null };
  const propEntry = (el: HElement, a: AttrItem, sv: string): [string, string] | null => {
    const lower = a.name.toLowerCase();
    if (lower.startsWith("on")) {
      warnings.push(`${where}: dropped event handler attribute ${a.name}`);
      return null;
    }
    let name = reactAttrName(a.name);
    if (el.name === "input" || el.name === "textarea" || el.name === "select") {
      if (lower === "value") name = "defaultValue";
      if (lower === "checked") name = "defaultChecked";
    }
    if (a.value === null) return [name, BOOLEAN_ATTRS.has(lower) ? "true" : q("")];
    const v = attrValue(a.value, sv);
    if (lower === "style") return [name, v.dynamic ? `R.style(${v.expr})` : JSON.stringify(styleToObject(a.value))];
    if (BOOLEAN_ATTRS.has(lower) && !v.dynamic) return [name, a.value === "" || a.value.toLowerCase() === lower ? "true" : q(a.value)];
    return [name, v.expr];
  };

  const attrs = (el: HElement, sv: string): string => {
    const flat: Flat<AttrItem>[] = [];
    for (const [name, value] of el.attrs) {
      const sm = /^(\d+)$/.exec(name);
      if (sm) {
        const m = ms[Number(sm[1])];
        if (m.k === "var") {
          warnings.push(`${where}: attribute-position placeholder {{${m.path}}} ignored`);
          continue;
        }
        flat.push({ t: "m", m });
      } else if (name.includes(S_OPEN)) warnings.push(`${where}: placeholder inside attribute name ${q(name)} ignored`);
      else flat.push({ t: "item", v: { name, value } });
    }
    const tree = structure(flat, `${where} <${el.name}> attributes`);
    const objOf = (ts: Tree<AttrItem>[], s: string): string => {
      const parts: string[] = [];
      for (const t of ts) {
        if (t.t === "item") {
          const e = propEntry(el, t.v, s);
          if (e) parts.push(`${q(e[0])}: ${e[1]}`);
        } else if (t.t === "if") parts.push(`...(R.truthy(${val(s, t.path)}) ? ${objOf(t.body, s)} : ${objOf(t.else, s)})`);
        else if (t.t === "each") warnings.push(`${where}: {{#each}} in attribute position ignored`);
      }
      return `{ ${parts.join(", ")} }`;
    };
    // one untyped spread per element: original attributes are kept verbatim even where React's DOM types are stricter
    const obj = objOf(tree, sv);
    return obj === "{  }" ? "" : ` {...R.p(${obj})}`;
  };

  const tagName = (el: HElement) => (el.rawName !== el.rawName.toLowerCase() ? el.rawName : el.name);

  const element = (el: HElement, sv: string, ind: string): string => {
    const tag = tagName(el);
    const a = attrs(el, sv);
    if (VOID.has(el.name)) return `<${tag}${a} />`;
    if (el.name === "script" || el.name === "style") {
      const body = el.children.map((c) => (c.type === "text" ? c.value : "")).join("");
      if (body.includes(S_OPEN)) warnings.push(`${where}: placeholders inside <${el.name}> are not supported (kept literally)`);
      return `<${tag}${a} dangerouslySetInnerHTML={{ __html: ${q(body.replace(SENTINEL, ""))} }} />`;
    }
    if (el.name === "textarea") {
      const body = el.children.map((c) => (c.type === "text" ? c.value : "")).join("");
      return `<${tag}${a} defaultValue={${q(body)}} />`;
    }
    const kids = children(el.children, sv, ind + "  ");
    if (!kids.trim()) return `<${tag}${a}></${tag}>`;
    return `<${tag}${a}>\n${kids}\n${ind}</${tag}>`;
  };

  const children = (nodes: HNode[], sv: string, ind: string): string => {
    const flat: Flat<HNode>[] = [];
    for (const n of nodes) {
      if (n.type === "comment") continue;
      if (n.type === "text") {
        for (const f of splitSentinels(n.value, ms)) flat.push(f.t === "item" ? { t: "item", v: { type: "text", value: f.v } } : f);
      } else flat.push({ t: "item", v: n });
    }
    const tree = structure(flat, `${where} children`);
    return emitTree(tree, sv, ind);
  };

  const emitTree = (ts: Tree<HNode>[], sv: string, ind: string): string => {
    const lines: string[] = [];
    for (const t of ts) {
      switch (t.t) {
        case "item":
          if (t.v.type === "text") {
            if (t.v.value) lines.push(`${ind}{${q(t.v.value)}}`);
          } else if (t.v.type === "element") lines.push(ind + element(t.v, sv, ind));
          break;
        case "var":
          if (t.path.startsWith(">")) lines.push(`${ind}{ctx.renderComponent(${q(t.path.slice(1).trim())}, ${sv}.v)}`);
          else if (t.raw) lines.push(`${ind}<R.Html value={${val(sv, t.path)}} ctx={ctx} />`);
          else lines.push(`${ind}{R.text(${val(sv, t.path)}, ctx)}`);
          break;
        case "if": {
          const body = emitTree(t.body, sv, ind + "  ");
          const els = emitTree(t.else, sv, ind + "  ");
          lines.push(`${ind}{R.truthy(${val(sv, t.path)}) ? (\n${ind}  <>\n${body}\n${ind}  </>\n${ind}) : ${els.trim() ? `(\n${ind}  <>\n${els}\n${ind}  </>\n${ind})` : "null"}}`);
          break;
        }
        case "each": {
          const ns = `s${++scopeN}`;
          paths.add(t.path);
          const body = emitTree(t.body, ns, ind + "  ");
          lines.push(`${ind}{R.each(${sv}, ${q(t.path)}, (${ns}) => (\n${ind}  <>\n${body}\n${ind}  </>\n${ind}))}`);
          break;
        }
      }
    }
    return lines.join("\n");
  };

  const body = children(nodes, "s0", "      ");
  return { jsx: `<>\n${body}\n    </>`, paths: [...paths].sort(), warnings };
}

export function pascalCase(id: string): string {
  const s = id.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, _p, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, "");
  return /^[A-Z]/.test(s) ? s : "C" + s;
}

/** Full TSX module for a compiled template. Falls back to the runtime string renderer for unbalanced templates. */
export function compileComponentModule(id: string, template: string, header: string, runtimeImport = "../../lib/render/runtime"): { code: string; warnings: string[]; fallback: boolean } {
  const name = pascalCase(id);
  const head = `// GENERATED by @cmp/generator-nextjs-contentful from ${header} — do not edit (regenerated on every run).\n` +
    `// Fix the design component (or override it in src/components/) instead.\n` +
    `import * as R from ${q(runtimeImport)};\n\n`;
  try {
    const r = compileTemplate(template, { id });
    return {
      code: `${head}export default function ${name}({ vm: s0, ctx }: { vm: R.Scope; ctx: R.RenderCtx }) {\n  void s0;\n  void ctx;\n  return (\n    ${r.jsx}\n  );\n}\n`,
      warnings: r.warnings,
      fallback: false,
    };
  } catch (e) {
    if (!(e instanceof TemplateCompileError)) throw e;
    return {
      code: `${head}// Not compilable to JSX (${e.message.replace(/\n/g, " ")}) → rendered by the runtime string renderer.\nconst TEMPLATE = ${q(template)};\n\nexport default function ${name}({ vm: s0, ctx }: { vm: R.Scope; ctx: R.RenderCtx }) {\n  return <R.TemplateString template={TEMPLATE} vm={s0} ctx={ctx} />;\n}\n`,
      warnings: [`${id}: ${e.message} — using runtime string rendering`],
      fallback: true,
    };
  }
}
