// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Names in a design-system package: the element prefix (`bvg` → `<bvg-product-card>`, `.bvg-product-card`), component
// / class / file names per set, prop names that do not collide with what a framework or the DOM already uses. Pure.
import { createNamer, pascalCase, slugify } from "@harness/scene";

/** Prefix of custom element tags and CSS classes: the system's first word, lower case, starting with a letter. */
export function dsPrefix(name: string | undefined): string {
  const first =
    slugify(name ?? "", "")
      .split("-")
      .find((w) => /^[a-z]/.test(w)) ?? "";
  const p = first.replace(/[^a-z0-9]/g, "").slice(0, 12);
  return p.length >= 2 ? p : "ds";
}

/** Default npm package name for a framework. */
export function defaultPackageName(dsName: string | undefined, fw: string): string {
  const base = slugify(dsName ?? "", "design-system");
  return `${base}-ui-${fw}`.replace(/^[._]+/, "");
}

/** Valid npm package name (lower case, url-safe; `@scope/name` kept). */
export function npmName(name: string): string {
  const scoped = /^@([^/]+)\/(.+)$/.exec(name.trim());
  const part = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._~-]+/g, "-")
      .replace(/^[-._]+|-+$/g, "") || "design-system";
  return scoped ? `@${part(scoped[1]!)}/${part(scoped[2]!)}` : part(name);
}

/**
 * Prop names a component cannot take as-is: React's own (`key`, `ref`, `children`, `className`, `style`), and the
 * HTML attributes / element properties a custom element or an Angular host would also receive (`title` shows a
 * tooltip on the host, `hidden` hides it…).
 */
export const RESERVED_PROPS = new Set([
  "key",
  "ref",
  "children",
  "className",
  "class",
  "style",
  "styleClass",
  "id",
  "slot",
  "part",
  "title",
  "hidden",
  "lang",
  "dir",
  "role",
  "tabIndex",
  "draggable",
  "inert",
  "translate",
  "accessKey",
  "nonce",
  "is",
  "render",
  "constructor",
  "prototype",
  "v",
  "props",
  "state",
  "shadowRoot",
  "dataset",
  "attributes",
  "cx",
  "pickVariant",
  "sanitizer",
  "rootClass",
  "html",
  "css",
  "nothing",
  "styles",
  "properties",
  "innerHTML",
  "outerHTML",
  "textContent",
  "nodeName",
  "tagName",
  "localName",
  "onClick",
  "contentEditable",
  // Element / LitElement members a property would shadow
  "prefix",
  "namespaceURI",
  "innerText",
  "outerText",
  "classList",
  "click",
  "focus",
  "blur",
  "remove",
  "append",
  "prepend",
  "after",
  "before",
  "closest",
  "matches",
  "animate",
  "scroll",
  "popover",
  "autofocus",
  "spellcheck",
  "autocapitalize",
  "renderRoot",
  "renderOptions",
  "updateComplete",
  "requestUpdate",
  "update",
  "updated",
  "firstUpdated",
  "connectedCallback",
  "disconnectedCallback",
  "attributeChangedCallback",
  "shouldUpdate",
  "hasUpdated",
  "isConnected",
  "parentElement",
  "parentNode",
  "firstChild",
  "lastChild",
  "nextSibling",
  "previousSibling",
  "ownerDocument",
  "baseURI",
  "childNodes",
  "nodeType",
  "nodeValue",
  "offsetWidth",
  "offsetHeight",
  "offsetTop",
  "offsetLeft",
  "offsetParent",
  "clientWidth",
  "clientHeight",
  "scrollTop",
  "scrollLeft",
  "scrollWidth",
  "scrollHeight",
  "assets",
  "ngOnChanges",
  "ngOnInit",
]);

/** "Größe des Bilds" → "grosseDesBilds" (ASCII camelCase, diacritics dropped). */
export function asciiCamel(s: string): string {
  const words = s
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w.toLowerCase() : w)) // "MEHR ERFAHREN" → mehrErfahren
    .slice(0, 6);
  const out = words
    .map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toLowerCase() + w.slice(1)))
    .join("");
  return out || "prop";
}

/** The prop name a component uses for an API prop (reserved names get a suffix: `title` → `titleText`). */
export function safePropName(name: string, type: string, taken: Set<string>): string {
  // ASCII identifiers (Angular template expressions take nothing else): `Erklärung` → `Erklarung`, `ß` → `ss`
  let n = name
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_]/g, "");
  if (!/^[A-Za-z_]/.test(n)) n = `p${n}`;
  if (RESERVED_PROPS.has(n) || /^(on[A-Z]|aria|data)/.test(n))
    n = `${n}${type === "enum" ? "Variant" : type === "boolean" ? "Flag" : type === "image" ? "Src" : type === "instance" ? "Component" : "Text"}`;
  let out = n;
  for (let i = 2; taken.has(out); i++) out = `${n}${i}`;
  taken.add(out);
  return out;
}

/** kebab-case attribute name of a prop (`showImage` → `show-image`). */
export const attrName = (prop: string) => prop.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

export interface SpecNames {
  name: string;
  file: string;
  tag: string;
  cls: string;
}

/** Unique component names per set: `ProductCard`, file `product-card`, tag / root class `<prefix>-product-card`. */
export function specNamer(prefix: string) {
  const names = createNamer("");
  const files = createNamer("-");
  return (setName: string): SpecNames => {
    // "List / Button" reads as "ListButton"; very long layer names are cut to their first words
    const words = slugify(setName, "component").split("-").slice(0, 5).join("-");
    let name = pascalCase(words, "Component");
    if (
      /^(Object|Function|Array|String|Number|Boolean|Symbol|Error|Promise|Map|Set|Date|Math|JSON|Component|Element|Node|Event|Document|Window)$/.test(
        name,
      )
    )
      name = `${name}Item`;
    name = names(name);
    const file = files(words || "component");
    return { name, file, tag: `${prefix}-${file}`, cls: `${prefix}-${file}` };
  };
}

/** Short class name for a layer inside a component (`title`, `media-image`). */
export function layerClass(name: string | undefined, tag: string): string {
  const s = slugify(name ?? "", "")
    .split("-")
    .filter(Boolean)
    .slice(0, 3)
    .join("-")
    .slice(0, 24)
    .replace(/-+$/, "");
  return s && /^[a-z]/.test(s) ? s : tag.replace(/[^a-z0-9]/gi, "").toLowerCase() || "el";
}
