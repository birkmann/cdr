/**
 * Small hast toolkit shared by the crawler, the fast-path CCM mapper and @cmp/design (component mining).
 */
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import { select, selectAll, matches } from "hast-util-select";
import { toHtml } from "hast-util-to-html";
import { toText } from "hast-util-to-text";
import type { Element, ElementContent, Root, Parents } from "hast";

export type { Element, Root, ElementContent };
export { select, selectAll, matches, toHtml };

export function parseDocument(html: string): Root {
  return unified().use(rehypeParse).parse(html) as Root;
}
export function parseFragment(html: string): Root {
  return unified().use(rehypeParse, { fragment: true }).parse(html) as Root;
}

export function classes(el: Element | undefined): string[] {
  const c = el?.properties?.className;
  if (Array.isArray(c)) return c.map(String);
  return typeof c === "string" ? String(c).split(/\s+/).filter(Boolean) : [];
}
export function hasClass(el: Element, cls: string): boolean {
  return classes(el).includes(cls);
}
export function attr(el: Element | undefined, name: string): string | undefined {
  if (!el) return undefined;
  const v = el.properties?.[name];
  if (v === undefined || v === null || v === false) return undefined;
  return Array.isArray(v) ? v.join(" ") : String(v);
}

/** Normalised visible text (whitespace collapsed). */
export function text(node: Element | Root | undefined): string {
  if (!node) return "";
  return toText(node as Element, { whitespace: "normal" }).replace(/\s+/g, " ").trim();
}

export function innerHtml(el: Element): string {
  return toHtml({ type: "root", children: el.children } as Root);
}
export function outerHtml(el: Element): string {
  return toHtml(el);
}

export function isElement(n: unknown): n is Element {
  return !!n && typeof n === "object" && (n as Element).type === "element";
}
export function childElements(el: Element | Root): Element[] {
  return (el.children as ElementContent[]).filter(isElement);
}

/** Depth-first walk with parent chain; return false from cb to skip children. */
export function walk(node: Root | Element, cb: (el: Element, ancestors: Element[]) => boolean | void, ancestors: Element[] = []): void {
  for (const c of node.children as ElementContent[]) {
    if (!isElement(c)) continue;
    if (cb(c, ancestors) === false) continue;
    walk(c, cb, [...ancestors, c]);
  }
}

/** Build a parent map so callers can ask for ancestors of a selected element. */
export function parentMap(root: Root): Map<Element, Element | Root> {
  const map = new Map<Element, Element | Root>();
  const rec = (p: Parents) => {
    for (const c of p.children as ElementContent[]) {
      if (isElement(c)) {
        map.set(c, p as Element | Root);
        rec(c);
      }
    }
  };
  rec(root);
  return map;
}

export function ancestorsOf(el: Element, parents: Map<Element, Element | Root>): Element[] {
  const out: Element[] = [];
  let p = parents.get(el);
  while (p && p.type === "element") {
    out.push(p);
    p = parents.get(p);
  }
  return out;
}

/** CSS-ish selector for an element: tag#id.class1.class2 (first 3 classes). */
export function describe(el: Element): string {
  const id = attr(el, "id");
  const cls = classes(el).slice(0, 3);
  return `${el.tagName}${id ? `#${id}` : ""}${cls.map((c) => `.${c}`).join("")}`;
}

/** Structural signature (tags + classes, text ignored) used to dedupe blocks across pages. */
export function signature(el: Element, depth = 3): string {
  const own = `${el.tagName}.${classes(el)
    .filter((c) => !/^(is-|js-|active|menu-item--active)/.test(c) && !/\d{2,}/.test(c))
    .sort()
    .join(".")}`;
  if (depth <= 0) return own;
  const kids = childElements(el)
    .map((c) => signature(c, depth - 1))
    .filter((s, i, a) => a.indexOf(s) === i);
  return kids.length ? `${own}(${kids.join(",")})` : own;
}

export function pathOf(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) return undefined;
    return decodeURIComponent(u.pathname) || "/";
  } catch {
    return undefined;
  }
}
export function isSameOrigin(href: string, base: string): boolean {
  try {
    return new URL(href, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
