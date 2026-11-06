// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Repeated content of a main: sibling layers that are the same structure with other copy (the cards of a grid, the
// links of a footer column, the slides of a row). Their texts and pictures are the items' content, not the
// component's own: the public API (catalog.ts componentApi) groups them per item instead of numbering them flat
// (`Title 2…6`). Read from structure alone — a nested instance is a unit of its own, never searched. Pure.
import type { SceneElement } from "@harness/protocol";

/** Siblings of one parent that are alike items. */
export interface ItemGroup {
  /** the items' parent (main element id) */
  parent: string;
  /** the item roots (main element ids), in reading order */
  items: string[];
}

/** Copy a prop can carry: letters or digits, not separators or glyphs ("|", "·", "→"). */
const isCopy = (el: SceneElement) => el.type === "text" && /[\p{L}\p{N}]{2}/u.test(el.text ?? "");
const isPicture = (el: SceneElement) => !!el.image?.src && el.type !== "icon";
const isLink = (el: SceneElement) =>
  el.meta?.tag === "a" || el.interaction?.onTap === "open-url" || el.interaction?.onTap === "navigate";

/**
 * A layer's structure without its content: types, tags, nested sets and the type of its texts (size, weight) — no
 * ids, names, copy, pictures, sizes or colours. Two items with the same key are the same item with other content.
 */
export function itemKey(el: SceneElement): string {
  const own = [
    el.type,
    el.meta?.tag ?? "",
    el.instance?.componentId ?? "",
    isPicture(el) ? "img" : "",
    el.svg || el.icon ? "glyph" : "",
  ];
  if (el.type === "text") own.push(String(el.style?.fontSize ?? ""), String(el.style?.fontWeight ?? ""));
  // (a nested instance is one unit: what it draws is its set's business)
  const kids = el.instance ? [] : (el.children ?? []);
  return `${own.join(":")}[${kids.map(itemKey).join(",")}]`;
}

/** Copy and pictures below a layer (not inside nested instances). */
function content(el: SceneElement): { texts: number; pictures: number; link: boolean } {
  let texts = 0,
    pictures = 0,
    link = false;
  const walk = (x: SceneElement, root: boolean) => {
    if (!root && x.instance) return;
    if (isCopy(x)) texts++;
    if (isPicture(x)) pictures++;
    if (isLink(x)) link = true;
    x.children?.forEach((c) => walk(c, false));
  };
  walk(el, true);
  return { texts, pictures, link };
}

const LIST_TAGS = new Set(["ul", "ol", "nav", "menu", "dl"]);
const ITEM_TAGS = new Set(["li", "article", "figure", "dt", "dd"]);

/**
 * The groups of alike sibling items in a main (outermost first; an item's own inner repeats are its content). An item
 * carries content (copy or a picture) and reads as an item: a link, a list entry or card (`li`, `article`), a block
 * with a picture or with several texts, a child of a list (`ul`, `nav`) — or any entry when the component is a list
 * itself (`list`: a nav's bare link texts are its items). At least two alike siblings make a group; bare texts of one
 * style outside a list need three (a paragraph captured line by line, a table's head).
 */
export function repeatedItems(main: SceneElement, o: { list?: boolean } = {}): ItemGroup[] {
  const out: ItemGroup[] = [];
  const walk = (el: SceneElement, root: boolean) => {
    if (!root && el.instance) return;
    const kids = el.children ?? [];
    const byKey = new Map<string, SceneElement[]>();
    for (const c of kids) {
      if (c.instance) continue;
      const k = content(c);
      if (!k.texts && !k.pictures) continue;
      // (bare texts of one style side by side — a paragraph captured line by line, a table's head — are items when
      // there are three or more of them)
      const bare = c.type === "text" && !k.link;
      const itemish =
        o.list ||
        k.link ||
        k.pictures > 0 ||
        k.texts >= 2 ||
        ITEM_TAGS.has(String(c.meta?.tag ?? "")) ||
        LIST_TAGS.has(String(el.meta?.tag ?? "")) ||
        bare;
      if (!itemish) continue;
      const key = `${o.list || !bare ? "" : "bare:"}${itemKey(c)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), c]);
    }
    const inItem = new Set<string>();
    for (const [key, items] of byKey) {
      if (items.length < (key.startsWith("bare:") ? 3 : 2)) continue;
      out.push({ parent: el.id, items: items.map((c) => c.id) });
      for (const c of items) inItem.add(c.id);
    }
    for (const c of kids) if (!inItem.has(c.id)) walk(c, false);
  };
  walk(main, true);
  return out;
}

/** Where each layer inside an item sits: its group and item (main element id → place). */
export function itemPlaces(
  main: SceneElement,
  groups: readonly ItemGroup[],
): Map<string, { group: number; index: number; root: string }> {
  const out = new Map<string, { group: number; index: number; root: string }>();
  const roots = new Map<string, { group: number; index: number }>();
  groups.forEach((g, gi) => g.items.forEach((id, index) => roots.set(id, { group: gi, index })));
  const walk = (el: SceneElement, at: { group: number; index: number; root: string } | null) => {
    const here = at ?? (roots.has(el.id) ? { ...roots.get(el.id)!, root: el.id } : null);
    if (here) out.set(el.id, here);
    el.children?.forEach((c) => walk(c, here));
  };
  walk(main, null);
  return out;
}
