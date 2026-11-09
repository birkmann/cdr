/**
 * Handlebars-subset → HTML string renderer for the static render mode. Same semantics as the compiled TSX components
 * (runtime.tsx: val / text / attr / truthy / list), but the output is the template's own source text with the
 * placeholders substituted — byte-identical markup (whitespace, attribute quoting, entities) to the original page.
 *
 * Placeholders inside a start tag (attribute values, `<a{{#if x}} aria-current="page"{{/if}}>`) are attribute
 * context: `{{x}}` there uses attr() (link → href, asset → url) instead of text().
 */
import { attr, list, text, truthy, val, type RenderCtx, type Scope } from "./runtime";
import { escapeAttr, escapeText } from "../html/serialize";

type TNode =
  | { t: "text"; v: string }
  | { t: "var"; path: string; raw: boolean; inTag: boolean }
  | { t: "each"; path: string; body: TNode[] }
  | { t: "if"; path: string; body: TNode[]; else: TNode[]; inElse?: boolean };

const TOKEN = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([#/]?)(each|if|else)?\s*([^}]*?)\s*\}\}/g;

/** tracks whether the scanner is inside a start/end tag (attribute context) or inside raw text (script/style) */
class TagState {
  inTag = false;
  private quote: string | null = null;
  private tagName = "";
  private readingName = false;
  private rawUntil: string | null = null;
  feed(s: string) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (this.rawUntil) {
        if (ch === "<" && s.slice(i, i + this.rawUntil.length).toLowerCase() === this.rawUntil) {
          this.rawUntil = null;
          this.inTag = true;
          this.tagName = "";
          this.readingName = false;
          i += 1;
        }
        continue;
      }
      if (!this.inTag) {
        if (ch === "<" && /[a-zA-Z/]/.test(s[i + 1] ?? "")) {
          this.inTag = true;
          this.quote = null;
          this.tagName = "";
          this.readingName = s[i + 1] !== "/";
        }
        continue;
      }
      if (this.quote) {
        if (ch === this.quote) this.quote = null;
        continue;
      }
      if (this.readingName) {
        if (/[\w:-]/.test(ch)) {
          this.tagName += ch;
          continue;
        }
        this.readingName = false;
      }
      if (ch === '"' || ch === "'") this.quote = ch;
      else if (ch === ">") {
        this.inTag = false;
        const n = this.tagName.toLowerCase();
        if (n === "script" || n === "style") this.rawUntil = `</${n}`;
      }
    }
  }
}

const cache = new Map<string, TNode[]>();

export function parseTemplate(src: string): TNode[] {
  const hit = cache.get(src);
  if (hit) return hit;
  const root: TNode[] = [];
  const stack: { node: TNode | null; list: TNode[] }[] = [{ node: null, list: root }];
  const st = new TagState();
  let last = 0;
  const top = () => stack[stack.length - 1];
  for (const m of src.matchAll(TOKEN)) {
    if (m.index! > last) {
      const chunk = src.slice(last, m.index);
      top().list.push({ t: "text", v: chunk });
      st.feed(chunk);
    }
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      top().list.push({ t: "var", path: m[1].trim(), raw: true, inTag: st.inTag });
      continue;
    }
    const [, , sigil, kw, rest] = m;
    if (sigil === "#" && (kw === "each" || kw === "if")) {
      const node: TNode = kw === "each" ? { t: "each", path: rest.trim(), body: [] } : { t: "if", path: rest.trim(), body: [], else: [] };
      top().list.push(node);
      stack.push({ node, list: node.body });
    } else if (sigil === "/" && stack.length > 1) stack.pop();
    else if (!sigil && kw === "else" && top().node?.t === "if") top().list = (top().node as { else: TNode[] }).else;
    else top().list.push({ t: "var", path: `${kw ?? ""}${kw && rest ? " " : ""}${rest}`.trim(), raw: false, inTag: st.inTag });
  }
  if (last < src.length) top().list.push({ t: "text", v: src.slice(last) });
  if (cache.size > 2000) cache.clear();
  cache.set(src, root);
  return root;
}

export interface StringRenderHooks {
  /** {{{x}}} value → HTML */
  html(v: unknown, ctx: RenderCtx): string;
}

function run(nodes: TNode[], s: Scope, ctx: RenderCtx, hooks: StringRenderHooks): string {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        out += n.v;
        break;
      case "var": {
        if (n.path.startsWith(">")) {
          out += hooks.html(ctx.renderComponent(n.path.slice(1).trim(), s.v), ctx);
          break;
        }
        const v = val(s, n.path);
        if (n.raw) out += n.inTag ? escapeAttr(attr(v)) : hooks.html(v, ctx);
        else out += n.inTag ? escapeAttr(attr(v)) : escapeText(text(v, ctx));
        break;
      }
      case "if":
        out += truthy(val(s, n.path)) ? run(n.body, s, ctx, hooks) : run(n.else, s, ctx, hooks);
        break;
      case "each": {
        const items = list(val(s, n.path));
        items.forEach((it, i) => (out += run(n.body, { v: it, parent: s, index: i, first: i === 0, last: i === items.length - 1 }, ctx, hooks)));
        break;
      }
    }
  }
  return out;
}

export function renderTemplateString(template: string, vm: Scope, ctx: RenderCtx, hooks: StringRenderHooks): string {
  return run(parseTemplate(template), vm, ctx, hooks);
}
