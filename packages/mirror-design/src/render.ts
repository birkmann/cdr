/**
 * Renderer for the Handlebars subset used in design/components/*.json templates (workplan "Design output"):
 *   {{path}}  escaped text        {{{path}}}  raw html
 *   {{#each path}}…{{/each}}      inside: {{this}}, {{this.x}}, {{@index}}, {{@first}}, {{@last}}
 *   {{#if path}}…{{else}}…{{/if}} truthy = non-empty string/array/object, true, non-zero number
 * Paths are dotted; `this` is the current each-item; other paths resolve against the current item first, then the root.
 * Exported so the frontend generator / tests can render mined templates without a Handlebars dependency.
 */

type Node =
  | { t: "text"; v: string }
  | { t: "var"; path: string; raw: boolean }
  | { t: "each"; path: string; body: Node[] }
  | { t: "if"; path: string; body: Node[]; else: Node[] };

const TOKEN = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#/]?)(each|if|else)?\s*([^}]*?)\s*\}\}/g;

export function parseTemplate(src: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Node | null; list: Node[] }[] = [{ node: null, list: root }];
  let last = 0;
  const top = () => stack[stack.length - 1];
  for (const m of src.matchAll(TOKEN)) {
    if (m.index! > last) top().list.push({ t: "text", v: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      top().list.push({ t: "var", path: m[1].trim(), raw: true });
      continue;
    }
    const [, , sigil, kw, rest] = m;
    if (sigil === "#" && (kw === "each" || kw === "if")) {
      const node: Node = kw === "each" ? { t: "each", path: rest.trim(), body: [] } : { t: "if", path: rest.trim(), body: [], else: [] };
      top().list.push(node);
      stack.push({ node, list: node.body });
    } else if (sigil === "/" && (kw === "each" || kw === "if")) {
      if (stack.length === 1 || top().node!.t !== kw) throw new Error(`unbalanced {{/${kw}}} at ${m.index}`);
      stack.pop();
    } else if (!sigil && kw === "else" && !rest) {
      const n = top().node;
      if (!n || n.t !== "if") throw new Error(`{{else}} outside {{#if}} at ${m.index}`);
      top().list = n.else;
    } else {
      top().list.push({ t: "var", path: `${kw ?? ""}${kw && rest ? " " : ""}${rest}`.trim(), raw: false });
    }
  }
  if (last < src.length) top().list.push({ t: "text", v: src.slice(last) });
  if (stack.length !== 1) throw new Error("unclosed block in template");
  return root;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface Scope {
  self: unknown;
  root: unknown;
  meta?: { index: number; first: boolean; last: boolean };
}

function get(obj: unknown, parts: string[]): unknown {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function lookup(path: string, s: Scope): unknown {
  if (path === "this" || path === ".") return s.self;
  if (path === "@index") return s.meta?.index;
  if (path === "@first") return s.meta?.first;
  if (path === "@last") return s.meta?.last;
  const parts = path.split(".");
  if (parts[0] === "this") return get(s.self, parts.slice(1));
  if (parts[0] === "@root") return get(s.root, parts.slice(1));
  const local = s.self && typeof s.self === "object" ? get(s.self, parts) : undefined;
  return local !== undefined ? local : get(s.root, parts);
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

function str(v: unknown): string {
  if (v === undefined || v === null || v === false) return "";
  if (typeof v === "object") return "";
  return String(v);
}

function run(nodes: Node[], s: Scope): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") {
      const v = lookup(n.path, s);
      out += n.raw ? str(v) : escapeHtml(str(v));
    } else if (n.t === "if") out += truthy(lookup(n.path, s)) ? run(n.body, s) : run(n.else, s);
    else {
      const list = lookup(n.path, s);
      if (!Array.isArray(list)) continue;
      list.forEach((item, index) => {
        out += run(n.body, { self: item, root: s.root, meta: { index, first: index === 0, last: index === list.length - 1 } });
      });
    }
  }
  return out;
}

export function renderTemplate(template: string, data: unknown): string {
  return run(parseTemplate(template), { self: data, root: data });
}

/** All placeholder paths used by a template (for validation against props). */
export function templatePaths(template: string): string[] {
  const out = new Set<string>();
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      if (n.t === "var") out.add(n.path);
      else if (n.t === "each") {
        out.add(n.path);
        walk(n.body);
      } else if (n.t === "if") {
        out.add(n.path);
        walk(n.body);
        walk(n.else);
      }
    }
  };
  walk(parseTemplate(template));
  return [...out];
}
