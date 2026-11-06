// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneDesignSystem, SceneElement, SceneScreen } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import { findElement } from "@harness/scene";
import { extractComponents, extractionOf, type ExtractScreen } from "@harness/extract";
import { buildInstance, elementsOf, findDef } from "@harness/extract";
import { catalogOf, componentApi } from "@harness/extract";

const ds = (): SceneDesignSystem => ({ version: 1, name: "DS", tokens: { ...DEFAULT_TOKENS } });
const ids = () => {
  let n = 0;
  return () => `cmp-${++n}`;
};

const card = (
  key: string,
  title: string,
  price: string,
  o: { photoHeight?: number; buy?: boolean } = {},
): SceneElement => ({
  id: `card-${key}`,
  type: "frame",
  name: "Product card",
  layout: { direction: "column", gap: 8, padding: 12, width: 160 },
  style: { radius: 12, background: "#ffffff" },
  children: [
    {
      id: `photo-${key}`,
      type: "image",
      name: "Photo",
      image: { src: `https://example.com/${key}.jpg`, alt: title },
      layout: { width: "fill", height: o.photoHeight ?? 120 },
    },
    {
      id: `title-${key}`,
      type: "text",
      name: "Title",
      text: title,
      style: { fontSize: 17, fontWeight: 600 },
    },
    { id: `price-${key}`, type: "text", name: "Price", text: price, style: { fontSize: 15 } },
    ...(o.buy
      ? [
          {
            id: `buy-${key}`,
            type: "button" as const,
            name: `Buy ${title}`,
            text: "Add to cart",
            variant: "primary",
          },
        ]
      : []),
  ],
});
const screen = (
  id: string,
  children: SceneElement[],
  responsive?: SceneScreen["responsive"],
): SceneScreen => ({
  version: 1,
  id,
  name: id,
  platform: responsive ? "web" : "app",
  width: 390,
  height: 844,
  ...(responsive ? { responsive } : {}),
  root: {
    id: `${id}-root`,
    type: "frame",
    name: "Root",
    layout: { direction: "column", gap: 16, padding: 16 },
    children,
  },
});
const instancesIn = (s: SceneScreen) => [...elementsOf(s.root)].filter((e) => e.instance);
/** every instance rebuilds into what the screen shows */
const rebuildsExactly = (s: SceneScreen, d: SceneDesignSystem) =>
  instancesIn(s).every((e) => JSON.stringify(buildInstance(e, d)) === JSON.stringify(e));
/** the screen shows what it showed before (ids and instance links aside) */
const strip = (el: SceneElement): unknown => {
  const { id: _id, instance: _i, children, ...rest } = el;
  return { ...rest, ...(children ? { children: children.map(strip) } : {}) };
};
const sameLook = (a: SceneScreen, b: SceneScreen) => expect(strip(b.root)).toEqual(strip(a.root));

describe("create components from screens", () => {
  it("makes one set from copies across screens; each copy becomes an instance with its own content as properties", () => {
    const a = screen("home", [card("a", "Monstera", "€24"), card("b", "Fern", "€12")]);
    const b = screen("shop", [
      {
        id: "grid",
        type: "frame",
        name: "Grid",
        layout: { direction: "row", gap: 12 },
        children: [card("c", "Cactus", "€8"), card("d", "Palm", "€30")],
      },
    ]);
    const r = extractComponents(
      [
        { nodeId: "n1", screen: a },
        { nodeId: "n2", screen: b },
      ],
      ds(),
      { newId: ids() },
    );
    expect(r.components).toEqual([
      { id: "cmp-1", name: "Product card", instances: 4, variants: ["default"], kind: "card" },
    ]);
    const def = findDef(r.ds, "cmp-1")!;
    expect(def).toMatchObject({ kind: "card", category: "content", origin: "extracted" });
    expect(def.variants.default!.children!.map((c) => c.id)).toEqual(["photo-a", "title-a", "price-a"]);
    // what differs between the copies: the title and price texts, the picture
    expect(def.properties).toEqual([
      { name: "Title", type: "text", target: "title-a", default: "Monstera" },
      { name: "Price", type: "text", target: "price-a", default: "€24" },
      { name: "Image", type: "image", target: "photo-a", default: "https://example.com/a.jpg" },
    ]);
    const home = r.screens.get("n1")!,
      shop = r.screens.get("n2")!;
    const fern = findElement(home.root, "card-b")!;
    // the picture is a property; its alt text (not one) stays an override
    expect(fern.instance).toEqual({
      componentId: "cmp-1",
      props: { Title: "Fern", Price: "€12", Image: "https://example.com/b.jpg" },
      overrides: { "photo-a": { image: { alt: "Fern" } } },
    });
    // the first copy is an instance too (the main lives on the Components frame); its content is the main's
    expect(findElement(home.root, "card-a")!.instance).toEqual({ componentId: "cmp-1" });
    expect(findElement(shop.root, "card-d__title-a")!.text).toBe("Palm");
    expect(rebuildsExactly(home, r.ds) && rebuildsExactly(shop, r.ds)).toBe(true);
    sameLook(a, home);
    // the inputs are left alone
    expect(a.root.children![0]!.instance).toBeUndefined();
    // the set's public API lists the properties
    expect(componentApi(def, r.ds).map((p) => [p.name, p.type, p.default])).toEqual([
      ["title", "text", "Monstera"],
      ["price", "text", "€24"],
      ["image", "image", "https://example.com/a.jpg"],
    ]);
  });

  it("content parts get their copy and picture as props even when every copy reads the same", () => {
    const btn = (k: string): SceneElement => ({
      id: `b-${k}`,
      type: "button",
      name: "More",
      text: "Mehr erfahren",
      variant: "primary",
    });
    const a = screen("home", [
      card("a", "Monstera", "€24"),
      card("b", "Monstera", "€24"),
      btn("1"),
      btn("2"),
    ]);
    const r = extractComponents([{ nodeId: "n1", screen: a }], ds(), { newId: ids() });
    const props = (kind: string) =>
      r.ds.componentSets!.find((d) => d.kind === kind)!.properties?.map((p) => [p.name, p.type, p.default]);
    expect(props("button")).toEqual([["Label", "text", "Mehr erfahren"]]);
    expect(props("card")).toEqual(
      expect.arrayContaining([
        ["Title", "text", "Monstera"],
        ["Image", "image", "https://example.com/a.jpg"],
      ]),
    );
    const s = r.screens.get("n1")!;
    expect(rebuildsExactly(s, r.ds)).toBe(true);
    sameLook(a, s);
  });

  it("a linked label (one run with its href) is a text prop too; the run follows the text", () => {
    const btn = (k: string, label: string, href: string): SceneElement => ({
      id: `b-${k}`,
      type: "button",
      name: "More",
      variant: "primary",
      layout: { direction: "row", gap: 8, padding: [0, 16] },
      style: { background: "#f0d722" },
      children: [
        {
          id: `t-${k}`,
          type: "text",
          name: "Label",
          text: label,
          runs: [{ text: label, href }],
          style: { fontSize: 16, fontWeight: 700 },
        },
      ],
    });
    const a = screen("home", [
      btn("1", "Zur Jelbi-Website", "https://jelbi.de/"),
      btn("2", "Mehr erfahren", "https://jelbi.de/"),
      btn("3", "Alle News", "https://bvg.de/news"),
    ]);
    const r = extractComponents([{ nodeId: "n1", screen: a }], ds(), { newId: ids() });
    const def = r.ds.componentSets!.find((d) => d.kind === "button")!;
    expect(def.properties?.map((p) => [p.name, p.type, p.default])).toEqual([
      ["Label", "text", "Zur Jelbi-Website"],
    ]);
    const s = r.screens.get("n1")!;
    expect(findElement(s.root, "b-2")!.instance).toEqual({
      componentId: def.id,
      props: { Label: "Mehr erfahren" },
    });
    // another href stays an override of the run
    expect(findElement(s.root, "b-3")!.instance?.overrides).toBeDefined();
    expect(rebuildsExactly(s, r.ds)).toBe(true);
    sameLook(a, s);
  });

  it("without props, copies keep their content as overrides", () => {
    const a = screen("home", [card("a", "Monstera", "€24"), card("b", "Fern", "€12")]);
    const r = extractComponents([{ nodeId: "n1", screen: a }], ds(), { newId: ids(), props: false });
    expect(findDef(r.ds, "cmp-1")!.properties).toBeUndefined();
    expect(findElement(r.screens.get("n1")!.root, "card-b")!.instance?.overrides).toEqual({
      "title-a": { text: "Fern" },
      "price-a": { text: "€12" },
      "photo-a": { image: { src: "https://example.com/b.jpg", alt: "Fern" } },
    });
  });

  it("makes the smaller part first: the card main holds an instance of the button inside it", () => {
    const a = screen("home", [
      card("a", "Monstera", "€24", { buy: true }),
      card("b", "Fern", "€12", { buy: true }),
      { id: "cta", type: "button", name: "Checkout", text: "Check out", variant: "primary" },
    ]);
    const r = extractComponents([{ nodeId: "n1", screen: a }], ds(), { newId: ids() });
    expect(r.components.map((c) => [c.name, c.instances, c.kind])).toEqual([
      ["Button", 3, "button"],
      ["Product card", 2, "card"],
    ]);
    const card1 = findDef(r.ds, r.components[1]!.id)!.variants.default!;
    expect(card1.children![3]!.instance?.componentId).toBe(r.components[0]!.id);
    const s = r.screens.get("n1")!;
    // a button outside the cards: an instance whose label (a property of the button) differs from the main's
    expect(findDef(r.ds, r.components[0]!.id)!.properties).toEqual([
      { name: "Label", type: "text", target: expect.any(String), default: "Add to cart" },
    ]);
    expect(findElement(s.root, "cta")!.instance).toEqual({
      componentId: r.components[0]!.id,
      props: { Label: "Check out" },
    });
    expect(findElement(s.root, "card-b__buy-a")!.instance?.componentId).toBe(r.components[0]!.id);
    expect(rebuildsExactly(s, r.ds)).toBe(true);
    sameLook(a, s);
  });

  it("makes a part whose breakpoints differ only in geometry one design: each copy keeps its sizes", () => {
    const page = (w: number, minWidth: number) =>
      screen(
        `p${w}`,
        [
          card(`a${w}`, "Monstera", "€24", { photoHeight: w > 600 ? 200 : 120 }),
          card(`b${w}`, "Fern", "€12", { photoHeight: w > 600 ? 200 : 120 }),
        ],
        { group: "start", minWidth },
      );
    const r = extractComponents(
      [
        { nodeId: "n1", screen: page(390, 0) },
        { nodeId: "n2", screen: page(1280, 1280) },
      ],
      ds(),
      { newId: ids() },
    );
    expect(r.components).toEqual([
      { id: "cmp-1", name: "Product card", instances: 4, variants: ["default"], kind: "card" },
    ]);
    const def = findDef(r.ds, "cmp-1")!;
    expect(def.variantAxes).toBeUndefined();
    const big = findElement(r.screens.get("n2")!.root, "card-b1280")!;
    expect(big.instance).toMatchObject({
      componentId: "cmp-1",
      props: { Title: "Fern" },
      overrides: { "photo-a390": { layout: { height: 200 } } },
    });
    expect(rebuildsExactly(r.screens.get("n2")!, r.ds)).toBe(true);
    sameLook(page(1280, 1280), r.screens.get("n2")!);
  });

  it("makes a part whose structure changes at a breakpoint one set with a breakpoint variant", () => {
    // the desktop sets the title in another weight and colour: a design of its own, not just other geometry
    const bold = (el: SceneElement): SceneElement => ({
      ...el,
      children: el.children!.map((c, i) =>
        i === 1 ? { ...c, style: { ...c.style, fontWeight: 800, color: "#c00000" } } : c,
      ),
    });
    const page = (w: number, minWidth: number) =>
      screen(
        `p${w}`,
        [
          w > 600 ? bold(card(`a${w}`, "Monstera", "€24")) : card(`a${w}`, "Monstera", "€24"),
          w > 600 ? bold(card(`b${w}`, "Fern", "€12")) : card(`b${w}`, "Fern", "€12"),
        ],
        { group: "start", minWidth },
      );
    const r = extractComponents(
      [
        { nodeId: "n1", screen: page(390, 0) },
        { nodeId: "n2", screen: page(1280, 1280) },
      ],
      ds(),
      { newId: ids() },
    );
    expect(r.components).toEqual([
      {
        id: "cmp-1",
        name: "Product card",
        instances: 4,
        variants: ["breakpoint=sm", "breakpoint=lg"],
        kind: "card",
      },
    ]);
    const def = findDef(r.ds, "cmp-1")!;
    expect(def.variantAxes).toEqual({ breakpoint: ["sm", "lg"] });
    // both looks share the first one's layer ids: overrides carry over when an instance switches breakpoint
    expect(def.variants["breakpoint=lg"]!.children!.map((c) => c.id)).toEqual([
      "photo-a390",
      "title-a390",
      "price-a390",
    ]);
    expect(def.variants["breakpoint=lg"]!.children![1]!.style?.fontWeight).toBe(800);
    const big = findElement(r.screens.get("n2")!.root, "card-b1280")!;
    expect(big.instance).toMatchObject({
      componentId: "cmp-1",
      variant: { breakpoint: "lg" },
      props: { Title: "Fern" },
    });
    expect(rebuildsExactly(r.screens.get("n2")!, r.ds)).toBe(true);
  });

  it("leaves single parts, screen roots, existing instances and mains alone", () => {
    const existing: SceneElement = {
      id: "inst",
      type: "frame",
      instance: { componentId: "other" },
      children: [card("x", "Monstera", "€24")],
    };
    const main: SceneElement = {
      ...card("m", "Fern", "€12"),
      meta: { componentMain: true, componentId: "other", variantKey: "default" },
    };
    const r = extractComponents(
      [
        { nodeId: "n1", screen: screen("a", [card("a", "Cactus", "€8"), existing, main]) },
        { nodeId: "n2", screen: screen("b", []) },
      ],
      ds(),
      { newId: ids() },
    );
    expect(r.components).toEqual([]);
    expect(r.screens.size).toBe(0);
  });

  it("keeps copies whose classes differ on the same screen as separate sets", () => {
    const big = (k: string) => card(k, "Big", "€1", { photoHeight: 300 });
    const r = extractComponents(
      [
        {
          nodeId: "n1",
          screen: screen("a", [card("a", "A", "€1"), card("b", "B", "€2"), big("c"), big("d")]),
        },
      ],
      ds(),
      { newId: ids() },
    );
    expect(r.components.map((c) => [c.name, c.instances, c.variants.length])).toEqual([
      ["Product card", 2, 1],
      ["Product card / Big", 2, 1],
    ]);
  });

  it("derives boolean and instance-swap properties: a layer hidden in some copies, nested instances of different sets", () => {
    const icon = (id: string, glyph: string): SceneElement => ({
      id,
      type: "icon",
      name: `Icon · ${glyph}`,
      svg: `<svg viewBox="0 0 20 20"><title>${glyph}</title></svg>`,
      layout: { width: 20, height: 20 },
    });
    const row = (k: string, label: string, glyph: string, badge: boolean): SceneElement => ({
      id: `row-${k}`,
      type: "frame",
      name: "Menu row",
      layout: { direction: "row", gap: 8, padding: 8, width: 300 },
      children: [
        icon(`i-${k}`, glyph),
        { id: `l-${k}`, type: "text", text: label, style: { fontSize: 15 } },
        { id: `b-${k}`, type: "badge", text: "New", ...(badge ? {} : { meta: { hidden: true } }) },
      ],
    });
    // the icons appear twice each: they are sets of their own, so the rows hold instances of different sets
    const s = screen("menu", [
      row("a", "Home", "house", true),
      row("b", "Search", "search", false),
      row("c", "Profile", "user", false),
      row("d", "Settings", "house", true),
      row("e", "Help", "search", false),
      row("f", "More", "user", true),
    ]);
    const r = extractComponents([{ nodeId: "n1", screen: s }], ds(), { newId: ids() });
    const rowSet = r.ds.componentSets!.find((d) => d.name === "Menu row")!;
    expect(rowSet.kind).toBe("list-item");
    expect(rowSet.properties!.map((p) => [p.name, p.type])).toEqual([
      ["Label", "text"],
      ["Show badge", "boolean"],
      ["Icon", "instance-swap"],
    ]);
    const iconSets = r.ds
      .componentSets!.filter((d) => d.kind === "icon")
      .map((d) => d.name)
      .sort();
    expect(iconSets).toEqual(["Icon / house", "Icon / search", "Icon / user"]);
    const out = r.screens.get("n1")!;
    const search = findElement(out.root, "row-b")!;
    expect(search.instance?.props).toEqual({
      Label: "Search",
      "Show badge": false,
      Icon: iconSets.length ? r.ds.componentSets!.find((d) => d.name === "Icon / search")!.id : "",
    });
    // only the swapped layer's own name stays an override
    expect(search.instance?.overrides).toEqual({ "i-a": { name: "Icon · search" } });
    expect(rebuildsExactly(out, r.ds)).toBe(true);
    sameLook(s, out);
  });

  it("names sets after what they are when their layer names say nothing", () => {
    const btn = (k: string, label: string): SceneElement => ({
      id: `btn-${k}`,
      type: "button",
      name: `Button · ${label}`,
      text: label,
      style: { background: "#0055ff", radius: 8 },
      layout: { height: 40 },
      meta: { tag: "button" },
    });
    const teaser = (k: string, title: string): SceneElement => ({
      id: `t-${k}`,
      type: "frame",
      name: "Group · whatever",
      meta: { tag: "a" },
      interaction: { onTap: "open-url", url: `https://x.test/${k}` },
      layout: { direction: "column", width: 300 },
      children: [
        {
          id: `ti-${k}`,
          type: "image",
          image: { src: `https://x.test/${k}.jpg` },
          layout: { width: 300, height: 160 },
        },
        { id: `tt-${k}`, type: "text", text: title, style: { fontSize: 22 } },
      ],
    });
    const r = extractComponents(
      [
        {
          nodeId: "n1",
          screen: screen("a", [
            btn("a", "Buy"),
            btn("b", "Sell"),
            teaser("a", "Spring"),
            teaser("b", "Summer"),
          ]),
        },
      ],
      ds(),
      { newId: ids() },
    );
    expect(r.components.map((c) => [c.name, c.kind])).toEqual([
      ["Button", "button"],
      ["Teaser", "teaser"],
    ]);
    expect(findDef(r.ds, r.components[1]!.id)!.properties!.map((p) => p.name)).toEqual(["Title", "Image"]);
  });
});

/* ------------------------------------------------------------------ pages → sections */

/** A responsive web page: header, hero, two content sections, footer — the hero's copy laid out differently on desktop. */
function page(width: number, minWidth: number, id: string): SceneScreen {
  const wide = width > 600;
  const link = (k: string, label: string): SceneElement => ({
    id: `${id}-${k}`,
    type: "text",
    name: `Link · ${label}`,
    text: label,
    interaction: { onTap: "open-url", url: `https://x.test/${k}` },
    style: { fontSize: 14 },
    meta: { tag: "a" },
  });
  const tile = (k: string, title: string): SceneElement => ({
    id: `${id}-tile-${k}`,
    type: "frame",
    name: "Group · tile",
    meta: { tag: "article" },
    layout: { direction: "column", gap: 8, width: wide ? 380 : width - 32 },
    style: { background: "#f4f4f4", radius: 8 },
    children: [
      {
        id: `${id}-tile-${k}-img`,
        type: "image",
        image: { src: `https://x.test/${k}.jpg`, alt: title },
        layout: { width: "fill", height: 180 },
      },
      { id: `${id}-tile-${k}-t`, type: "text", text: title, style: { fontSize: 20, fontWeight: 700 } },
    ],
  });
  return {
    version: 1,
    id,
    name: `Home · ${width}`,
    platform: "web",
    width,
    height: 2400,
    responsive: { group: "home", minWidth },
    root: {
      id: `${id}-body`,
      type: "frame",
      name: "Page",
      meta: { tag: "body", viewportHeight: 900 },
      layout: { direction: "column", width },
      children: [
        {
          id: `${id}-header`,
          type: "frame",
          name: "Header",
          meta: { tag: "header" },
          layout: { direction: "row", width: "fill", height: 64, padding: 16 },
          children: [
            {
              id: `${id}-logo`,
              type: "icon",
              name: "Logo",
              svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
              layout: { width: 40, height: 32 },
            },
            ...(wide
              ? [link("l1", "Shop"), link("l2", "About")]
              : [
                  {
                    id: `${id}-burger`,
                    type: "button" as const,
                    name: "Button · Menu",
                    layout: { width: 32, height: 32 },
                    children: [{ id: `${id}-burger-i`, type: "icon" as const, icon: "menu" }],
                  },
                ]),
          ],
        },
        {
          id: `${id}-main`,
          type: "frame",
          name: "Main",
          meta: { tag: "main" },
          layout: { direction: "column", width: "fill" },
          children: [
            {
              id: `${id}-hero`,
              type: "frame",
              name: "Stage",
              layout: { direction: wide ? "row" : "column", width: "fill", height: wide ? 600 : 520 },
              children: [
                {
                  id: `${id}-hero-img`,
                  type: "image",
                  image: { src: "https://x.test/stage.jpg", alt: "A stage" },
                  layout: { width: wide ? 800 : "fill", height: wide ? 600 : 360 },
                },
                {
                  id: `${id}-hero-copy`,
                  type: "frame",
                  layout: { direction: "column", gap: 8 },
                  children: [
                    {
                      id: `${id}-hero-t`,
                      type: "text",
                      text: "Spring is here",
                      style: { fontSize: wide ? 56 : 36, fontWeight: 700 },
                    },
                    ...(wide
                      ? [
                          {
                            id: `${id}-hero-s`,
                            type: "text" as const,
                            text: "Fresh plants for every room",
                            style: { fontSize: 20 },
                          },
                        ]
                      : []),
                  ],
                },
              ],
            },
            {
              id: `${id}-tiles`,
              type: "frame",
              name: "Section · Highlights",
              meta: { tag: "section" },
              layout: { direction: wide ? "row" : "column", gap: 16, width: "fill", padding: 16 },
              children: [
                { id: `${id}-tiles-h`, type: "text", text: "Highlights", style: { fontSize: 28 } },
                tile("a", "Monstera"),
                tile("b", "Fern"),
                tile("c", "Cactus"),
              ],
            },
            {
              id: `${id}-news`,
              type: "frame",
              name: "Section · Newsletter",
              meta: { tag: "section" },
              layout: { direction: "column", gap: 8, width: "fill", padding: 24, height: 200 },
              children: [
                { id: `${id}-news-t`, type: "text", text: "Stay in touch", style: { fontSize: 28 } },
                {
                  id: `${id}-news-d`,
                  type: "text",
                  text: "One letter a month about plants and the people who grow them, with offers for subscribers.",
                  style: { fontSize: 16 },
                },
              ],
            },
          ],
        },
        {
          id: `${id}-footer`,
          type: "frame",
          name: "Footer",
          meta: { tag: "footer" },
          layout: { direction: "column", width: "fill", height: 240, padding: 24 },
          children: [link("f1", "Imprint"), link("f2", "Privacy"), link("f3", "Contact")],
        },
      ],
    },
  };
}

describe("create components from pages: sections", () => {
  const input = (): ExtractScreen[] => [
    { nodeId: "n1", screen: page(390, 0, "s") },
    { nodeId: "n2", screen: page(1280, 1280, "l") },
  ];

  it("a state wrapper around the whole page (a dark-mode toggle) passes through: the page's sections, no page-sized set", () => {
    const wrap = (sc: SceneScreen): SceneScreen => {
      const body = sc.root;
      const inner: SceneElement = {
        id: `${body.id}-in`,
        type: "frame",
        name: "Container fluid",
        layout: { direction: "column", width: "fill" },
        children: body.children,
      };
      const dark: SceneElement = {
        ...structuredClone(inner),
        id: `${body.id}-dark`,
        name: "State · Dark mode",
      };
      const states: SceneElement = {
        id: `${body.id}-states`,
        type: "frame",
        name: "States · Container fluid",
        layout: { width: "fill", height: 2400 },
        states: { active: inner.id },
        children: [inner, dark],
      };
      return { ...sc, root: { ...body, children: [states] } };
    };
    const r = extractComponents(
      [
        { nodeId: "n1", screen: wrap(page(390, 0, "s")) },
        { nodeId: "n2", screen: wrap(page(1280, 1280, "l")) },
      ],
      ds(),
      { newId: ids(), sections: true },
    );
    const kinds = r.components.filter((c) => c.section).map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["header", "hero", "footer"]));
    expect(kinds.filter((k) => k === "hero")).toHaveLength(1);
    // (the hidden dark copy adds no second header / footer)
    expect(kinds.filter((k) => k === "footer")).toHaveLength(1);
  });

  it("makes every top-level section a set: one per section, a variant per breakpoint, classified and named", () => {
    const before = input();
    const r = extractComponents(before, ds(), { newId: ids(), sections: true });
    const sections = r.components.filter((c) => c.section);
    expect(sections.map((c) => [c.name, c.kind, c.instances, c.variants])).toEqual([
      ["Header", "header", 2, ["breakpoint=sm", "breakpoint=lg"]],
      ["Hero", "hero", 2, ["breakpoint=sm", "breakpoint=lg"]],
      // named after what it is (its heading "Highlights" is page copy), or the name its layer gives it
      ["Section / Card grid", "section", 2, ["breakpoint=sm", "breakpoint=lg"]],
      // alike at both breakpoints: one look
      ["Section / Newsletter", "section", 2, ["default"]],
      ["Footer", "footer", 2, ["default"]],
    ]);
    // the page is made of section instances now; it looks exactly as before
    for (const [i, nodeId] of ["n1", "n2"].entries()) {
      const s = r.screens.get(nodeId)!;
      expect(s.root.children!.map((c) => c.instance?.componentId ?? c.name)).toEqual([
        sections[0]!.id,
        "Main",
        sections[4]!.id,
      ]);
      expect(s.root.children![1]!.children!.every((c) => c.instance)).toBe(true);
      expect(rebuildsExactly(s, r.ds)).toBe(true);
      sameLook(before[i]!.screen, s);
    }
    // the header's looks differ in structure (a menu button on the phone, links on desktop): still one set
    const header = findDef(r.ds, sections[0]!.id)!;
    expect(header.variants["breakpoint=sm"]!.children!.length).toBe(2);
    expect(header.variants["breakpoint=lg"]!.children!.length).toBe(3);
    // corresponding layers share ids across the variants (the logo), the others are their own
    expect(header.variants["breakpoint=lg"]!.children![0]!.id).toBe(
      header.variants["breakpoint=sm"]!.children![0]!.id,
    );
    // the repeated tiles inside are a set of their own: nested instances in the section's mains
    const tiles = r.components.find((c) => !c.section && c.kind === "card")!;
    expect(tiles).toMatchObject({ instances: 6 });
    expect(
      findDef(r.ds, sections[2]!.id)!.variants["breakpoint=lg"]!.children!.filter(
        (c) => c.instance?.componentId === tiles.id,
      ),
    ).toHaveLength(3);
    // a section's prominent copy and picture are properties a composed page sets
    expect(findDef(r.ds, sections[1]!.id)!.properties!.map((p) => [p.name, p.type])).toEqual([
      ["Title", "text"],
      ["Image", "image"],
    ]);
    expect(findDef(r.ds, sections[3]!.id)!.properties!.map((p) => p.name)).toEqual(["Title", "Description"]);
    // the catalog lists shell and sections first
    expect(
      catalogOf(r.ds)
        .map((g) => g.category)
        .slice(0, 2),
    ).toEqual(["shell", "sections"]);
  });

  it("keeps sliders and tabs working: arrows and tabs inside a set point at their own track / panes in every instance and variant", () => {
    const slider = (s: SceneScreen): SceneScreen => {
      const id = s.id;
      const sec = findElement(s.root, `${id}-tiles`)!;
      const [h, ...tiles] = sec.children!;
      const arrow = (k: string, direction: "prev" | "next"): SceneElement => ({
        id: `${id}-${k}`,
        type: "button",
        name: `Button · ${k}`,
        layout: { width: 32, height: 32 },
        interaction: { onTap: "scroll-by", target: `${id}-track`, direction, by: "slide" },
        children: [{ id: `${id}-${k}-i`, type: "icon", icon: k }],
      });
      sec.children = [
        h!,
        {
          id: `${id}-track`,
          type: "frame",
          layout: { direction: "row", gap: 16, width: "fill", scroll: "horizontal", snap: true },
          children: tiles,
        },
        arrow("prev", "prev"),
        arrow("next", "next"),
      ];
      // tabs: a state frame showing one of its panes, a tab that switches it
      const pane = (k: string): SceneElement => ({ id: `${id}-pane-${k}`, type: "text", text: `Pane ${k}` });
      sec.children.push(
        {
          id: `${id}-tab`,
          type: "button",
          name: "Button · Tab",
          interaction: { onTap: "set-state", target: `${id}-panes`, state: `${id}-pane-b` },
          children: [{ id: `${id}-tab-l`, type: "text", text: "B" }],
        },
        {
          id: `${id}-panes`,
          type: "frame",
          states: { active: `${id}-pane-a` },
          children: [pane("a"), pane("b")],
        },
      );
      return s;
    };
    const r = extractComponents(
      [
        { nodeId: "n1", screen: slider(page(390, 0, "s")) },
        { nodeId: "n2", screen: slider(page(1280, 1280, "l")) },
      ],
      ds(),
      { newId: ids(), sections: true },
    );
    for (const nodeId of ["n1", "n2"]) {
      const s = r.screens.get(nodeId)!;
      expect(rebuildsExactly(s, r.ds)).toBe(true);
      const els = [...elementsOf(s.root)];
      const arrows = els.filter((e) => e.interaction?.onTap === "scroll-by");
      expect(arrows).toHaveLength(2);
      for (const a of arrows)
        expect(findElement(s.root, a.interaction!.target!)?.layout?.scroll).toBe("horizontal");
      const tab = els.find((e) => e.interaction?.onTap === "set-state")!;
      const panes = findElement(s.root, tab.interaction!.target!)!;
      expect(panes.children!.map((c) => c.id)).toContain(tab.interaction!.state);
      expect(panes.children!.map((c) => c.id)).toContain(panes.states!.active);
      // no override pins an arrow to another copy's track
      expect(els.some((e) => Object.values(e.instance?.overrides ?? {}).some((o) => o.interaction))).toBe(
        false,
      );
    }
  });

  it("is idempotent: a second run finds nothing", () => {
    const r = extractComponents(input(), ds(), { newId: ids(), sections: true });
    const again = extractComponents(
      input().map((s) => ({ ...s, screen: r.screens.get(s.nodeId) ?? s.screen })),
      r.ds,
      { newId: () => "x", sections: true },
    );
    expect(again.components).toEqual([]);
  });

  it("leaves app screens as they are (sections are a web page thing)", () => {
    const r = extractComponents(
      [{ nodeId: "n1", screen: { ...page(390, 0, "s"), platform: "app", responsive: undefined } }],
      ds(),
      { newId: ids(), sections: true },
    );
    expect(r.components.filter((c) => c.section)).toEqual([]);
  });
});

describe("looks of one part as variants", () => {
  const tag = (key: string, text: string, bg: string, fg: string): SceneElement => ({
    id: `tag-${key}`,
    type: "frame",
    name: "Bds Tag",
    meta: { tag: "strong" },
    layout: { direction: "row", padding: 4, width: 20 + text.length * 7, height: 20 },
    style: { background: bg, radius: 4 },
    children: [
      { id: `tag-${key}-t`, type: "text", text, style: { fontSize: 12, fontWeight: 700, color: fg } },
    ],
  });
  const date = (key: string, text: string): SceneElement => ({
    id: `date-${key}`,
    type: "frame",
    name: "time",
    meta: { tag: "time" },
    layout: { direction: "row", height: 28 },
    style: { borders: { left: { width: 3, color: "#f0d722" } } },
    children: [{ id: `date-${key}-t`, type: "text", text, style: { fontSize: 14 } }],
  });
  const badge = (key: string, size: "sm" | "md"): SceneElement => ({
    id: `line-${key}`,
    type: "button",
    name: "Button · M17",
    layout: { direction: "row", width: size === "sm" ? 32 : 36, height: size === "sm" ? 18 : 19 },
    style: { radius: size === "sm" ? 2.1 : 2.4, border: { width: 1, color: "#cccccc" } },
    children: [
      {
        id: `line-${key}-t`,
        type: "text",
        text: key.toUpperCase(),
        style: { fontSize: size === "sm" ? 14 : 16 },
      },
    ],
  });

  it("makes tags that differ only in colour one set with a tone axis; the date badge of the same structure stays its own", () => {
    const s = screen("page", [
      tag("a", "Störung", "rgb(255, 218, 209)", "rgb(140, 0, 6)"),
      tag("b", "Störung", "rgb(255, 218, 209)", "rgb(140, 0, 6)"),
      tag("c", "Unterbrechung", "rgb(216, 227, 239)", "rgb(0, 69, 115)"),
      tag("d", "Bauarbeiten", "rgb(216, 227, 239)", "rgb(0, 69, 115)"),
      date("a", "01.10.2026"),
      date("b", "02.10.2026"),
    ]);
    const r = extractComponents([{ nodeId: "n", screen: s }], ds(), { newId: ids() });
    const tags = r.ds.componentSets!.find((d) => d.kind === "tag")!;
    expect(tags.variantAxes).toEqual({ tone: ["red", "sky"] });
    expect(Object.keys(tags.variants)).toEqual(["tone=red", "tone=sky"]);
    expect(tags.name).toBe("Tag");
    const out = r.screens.get("n")!;
    expect(findElement(out.root, "tag-c")!.instance).toMatchObject({
      componentId: tags.id,
      variant: { tone: "sky" },
    });
    expect(r.ds.componentSets!.filter((d) => d.id !== tags.id).map((d) => d.kind)).toEqual(["badge"]);
    expect(rebuildsExactly(out, r.ds)).toBe(true);
    sameLook(s, out);
  });

  it("makes a part drawn at two sizes on one page one set with a size axis", () => {
    const s = screen("page", [badge("m17", "md"), badge("m10", "md"), badge("u5", "sm"), badge("u8", "sm")]);
    const r = extractComponents([{ nodeId: "n", screen: s }], ds(), { newId: ids() });
    const set = r.ds.componentSets!.find((d) => d.kind === "badge")!;
    expect(set.variantAxes).toEqual({ size: ["md", "sm"] });
    expect(findElement(r.screens.get("n")!.root, "line-u5")!.instance?.variant).toEqual({ size: "sm" });
    sameLook(s, r.screens.get("n")!);
  });

  it("tells a linked heading from a plain one (an export draws an <a> for it)", () => {
    const group = (key: string, linked: boolean): SceneElement => ({
      id: `g-${key}`,
      type: "frame",
      name: "Group",
      layout: { direction: "column" },
      children: [
        {
          id: `g-${key}-h`,
          type: "text",
          text: key,
          ...(linked ? { runs: [{ text: key, href: `https://x.de/${key}` }] } : {}),
        },
        { id: `g-${key}-l`, type: "text", text: "Mehr" },
      ],
    });
    const s = screen("page", [
      group("apps", true),
      group("dienste", false),
      group("karte", true),
      group("hilfe", false),
    ]);
    const r = extractComponents([{ nodeId: "n", screen: s }], ds(), { newId: ids() });
    expect(r.ds.componentSets).toHaveLength(2);
  });
});

describe("looks in colour and layout", () => {
  it("gives line badges in three colours, smaller on the phone, a tone and a breakpoint axis", () => {
    const badge = (key: string, bg: string, small: boolean): SceneElement => ({
      id: `b-${key}`,
      type: "button",
      name: "Button · line",
      layout: { direction: "row", width: small ? 30 : 34, height: small ? 16 : 17 },
      style: { background: bg, radius: small ? 2 : 2.4 },
      children: [
        {
          id: `b-${key}-t`,
          type: "text",
          text: key.toUpperCase(),
          style: { fontSize: small ? 14 : 16, color: "#ffffff" },
        },
      ],
    });
    const page = (w: number, minWidth: number, small: boolean) => ({
      ...screen(
        `p${w}`,
        [
          badge(`m4${w}`, "rgb(125, 173, 76)", small),
          badge(`m5${w}`, "rgb(125, 173, 76)", small),
          badge(`u3${w}`, "rgb(140, 109, 171)", small),
          badge(`u5${w}`, "rgb(140, 109, 171)", small),
          badge(`s1${w}`, "rgb(255, 255, 255)", small),
          badge(`s2${w}`, "rgb(255, 255, 255)", small),
        ],
        { group: "home", minWidth },
      ),
      width: w,
    });
    const input: ExtractScreen[] = [
      { nodeId: "a", screen: page(390, 0, true) },
      { nodeId: "b", screen: page(1280, 1024, false) },
    ];
    const r = extractComponents(input, ds(), { newId: ids() });
    const set = r.ds.componentSets!.find((d) => d.kind === "badge")!;
    expect(set.variantAxes).toEqual({ tone: ["lime", "violet", "light"], breakpoint: ["sm", "lg"] });
    expect(Object.keys(set.variants).sort()).toEqual([
      "tone=light,breakpoint=lg",
      "tone=light,breakpoint=sm",
      "tone=lime,breakpoint=lg",
      "tone=lime,breakpoint=sm",
      "tone=violet,breakpoint=lg",
      "tone=violet,breakpoint=sm",
    ]);
    const out = r.screens.get("b")!;
    expect(findElement(out.root, "b-u31280")!.instance?.variant).toEqual({
      tone: "violet",
      breakpoint: "lg",
    });
    expect(rebuildsExactly(out, r.ds)).toBe(true);
    sameLook(input[1]!.screen, out);
  });
});

describe("icon glyphs", () => {
  it("reads the sprite symbol an SVG uses", async () => {
    const { svgGlyph } = await import("@harness/extract");
    expect(
      svgGlyph(
        '<svg viewBox="0 0 24 24"><use href="https://www.bvg.de/assets/bds-icons/bds-magnify-line.svg#bds-magnify-line" fill="red"/></svg>',
      ),
    ).toBe("magnify");
    expect(svgGlyph('<svg><use xlink:href="#icon-arrow_right-24"/></svg>')).toBe("arrow right");
    expect(svgGlyph('<svg><path d="M0 0"/></svg>')).toBeNull();
    // an inlined sprite symbol whose name the capture kept
    expect(
      svgGlyph('<svg data-icon="bds-signet-transport-tram" viewBox="0 0 24 24"><path d="M0 0"/></svg>'),
    ).toBe("signet transport tram");
  });
});

describe("breakpoint looks", () => {
  it("makes a part laid out otherwise at each breakpoint (every box moved) one design, its copies keeping their places", () => {
    const col = (key: string, title: string, wide: boolean): SceneElement => ({
      id: `c-${key}`,
      type: "frame",
      name: "Column",
      meta: { tag: "li" },
      layout: { width: wide ? 240 : 160, height: 120 },
      children: [0, 1, 2, 3].map((i) => ({
        id: `c-${key}-${i}`,
        type: "text" as const,
        text: i ? `${title} ${i}` : title,
        layout: { position: "absolute" as const, x: wide ? i * 60 : 0, y: wide ? 0 : i * 24 },
      })),
    });
    const page = (w: number, minWidth: number, wide: boolean) => ({
      ...screen(`p${w}`, [col(`a${w}`, "Tickets", wide), col(`b${w}`, "Service", wide)], {
        group: "home",
        minWidth,
      }),
      width: w,
    });
    const input: ExtractScreen[] = [
      { nodeId: "a", screen: page(390, 0, false) },
      { nodeId: "b", screen: page(1280, 1024, true) },
    ];
    const r = extractComponents(input, ds(), { newId: ids() });
    expect(r.ds.componentSets).toHaveLength(1);
    expect(Object.keys(r.ds.componentSets![0]!.variants)).toEqual(["default"]);
    expect(rebuildsExactly(r.screens.get("b")!, r.ds)).toBe(true);
    sameLook(input[1]!.screen, r.screens.get("b")!);
  });
});

describe("picture crops", () => {
  it("keeps copies whose pictures are cropped differently one part (the crop is the picture’s, like its source)", () => {
    const pic = (k: string, crop?: [`${number}%`, `${number}%`]): SceneElement => ({
      id: `p-${k}`,
      type: "frame",
      name: "Figure",
      layout: { width: 200, height: 120 },
      children: [
        {
          id: `p-${k}-i`,
          type: "image",
          image: { src: `https://x.de/${k}.jpg`, alt: k },
          layout: { width: "fill", height: "fill" },
          style: { ...(crop ? { objectPosition: crop } : {}) },
        },
      ],
    });
    const s = screen("page", [pic("a"), pic("b", ["31%", "51%"]), pic("c", ["51%", "38%"]), pic("d")]);
    const r = extractComponents([{ nodeId: "n", screen: s }], ds(), { newId: ids() });
    expect(r.ds.componentSets).toHaveLength(1);
    expect(r.components[0]!.instances).toBe(4);
    expect(rebuildsExactly(r.screens.get("n")!, r.ds)).toBe(true);
    sameLook(s, r.screens.get("n")!);
  });
});

/* ------------------------------------------------------------------ alike sections */

type Block = (id: string, wide: boolean) => SceneElement;
/** A responsive page: a header, a stage, then the given sections stacked in its main. */
function sectionsPage(width: number, minWidth: number, id: string, blocks: Block[]): SceneScreen {
  const wide = width > 600;
  return {
    version: 1,
    id,
    name: `Home · ${width}`,
    platform: "web",
    width,
    height: 4000,
    responsive: { group: "home", minWidth },
    root: {
      id: `${id}-body`,
      type: "frame",
      name: "Page",
      meta: { tag: "body", viewportHeight: 900 },
      layout: { direction: "column", width },
      children: [
        {
          id: `${id}-header`,
          type: "frame",
          name: "Header",
          meta: { tag: "header" },
          layout: { direction: "row", width: "fill", height: 64, padding: 16 },
          children: [
            {
              id: `${id}-logo`,
              type: "icon",
              name: "Logo",
              svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
              layout: { width: 40, height: 32 },
            },
          ],
        },
        {
          id: `${id}-main`,
          type: "frame",
          name: "Main",
          meta: { tag: "main" },
          layout: { direction: "column", width: "fill" },
          children: [
            {
              id: `${id}-stage`,
              type: "frame",
              name: "Stage",
              layout: { direction: "column", width: "fill", height: 600 },
              children: [
                {
                  id: `${id}-stage-img`,
                  type: "image",
                  image: { src: "https://x.test/stage.jpg", alt: "A stage" },
                  layout: { width: "fill", height: 600 },
                },
              ],
            },
            ...blocks.map((b, i) => b(`${id}-s${i}`, wide)),
          ],
        },
      ],
    },
  };
}
const both = (blocks: Block[]): ExtractScreen[] => [
  { nodeId: "n1", screen: sectionsPage(390, 0, "s", blocks) },
  { nodeId: "n2", screen: sectionsPage(1280, 1280, "l", blocks) },
];
const checkPages = (before: ExtractScreen[], r: ReturnType<typeof extractComponents>) => {
  for (const { nodeId, screen: s } of before) {
    const out = r.screens.get(nodeId)!;
    expect(rebuildsExactly(out, r.ds)).toBe(true);
    sameLook(s, out);
  }
};

/** A band of copy and a picture: its copy, picture and heights are content; `more` adds a link under it. */
const band =
  (
    title: string,
    text: string,
    pic: string,
    o: { height?: number; picHeight?: number; more?: boolean } = {},
  ): Block =>
  (id, wide) => ({
    id,
    type: "frame",
    name: "Group",
    meta: { tag: "div" },
    layout: {
      direction: "column",
      gap: 16,
      padding: 24,
      width: "fill",
      height: (o.height ?? 420) + (wide ? 40 : 0),
    },
    children: [
      {
        id: `${id}-h`,
        type: "text",
        text: title,
        style: { fontSize: 28, fontWeight: 600 },
        meta: { tag: "h2" },
      },
      { id: `${id}-p`, type: "text", text, style: { fontSize: 16 }, meta: { tag: "p" } },
      {
        id: `${id}-img`,
        type: "image",
        image: { src: `https://x.test/${pic}.jpg`, alt: title },
        layout: { width: "fill", height: o.picHeight ?? 200 },
      },
      ...(o.more
        ? [
            {
              id: `${id}-more`,
              type: "text" as const,
              text: "Mehr erfahren",
              interaction: { onTap: "open-url" as const, url: `https://x.test/${pic}` },
              meta: { tag: "a" },
              style: { fontSize: 16 },
            },
          ]
        : []),
    ],
  });
/** A contact form: another component altogether. */
const form: Block = (id) => ({
  id,
  type: "frame",
  name: "Group",
  meta: { tag: "div" },
  layout: { direction: "column", gap: 12, padding: 24, width: "fill", height: 300 },
  children: [
    { id: `${id}-t`, type: "text", text: "Write to us", style: { fontSize: 22 } },
    {
      id: `${id}-in`,
      type: "input",
      placeholder: "E-mail",
      meta: { role: "input", tag: "input" },
      layout: { width: "fill", height: 44 },
    },
    {
      id: `${id}-in2`,
      type: "input",
      placeholder: "Message",
      meta: { role: "input", tag: "textarea" },
      layout: { width: "fill", height: 120 },
    },
  ],
});
/** A section of a heading and a row of product cards (each card's picture its own height: content). */
const stack =
  (title: string, heights: number[]): Block =>
  (id, wide) => ({
    id,
    type: "frame",
    name: "Group",
    meta: { tag: "div" },
    layout: { direction: "column", gap: 16, padding: 24, width: "fill", height: 520 },
    children: [
      { id: `${id}-h`, type: "text", text: title, style: { fontSize: 28 }, meta: { tag: "h2" } },
      {
        id: `${id}-row`,
        type: "frame",
        layout: { direction: wide ? "row" : "column", gap: 16, width: "fill" },
        children: heights.map((h, i) => card(`${id}-${i}`, `${title} ${i}`, `€${i + 1}`, { photoHeight: h })),
      },
    ],
  });

describe("create components from pages: alike sections", () => {
  it("leaves the copy of alike items inside a part to the items: no flat numbered props", () => {
    const panel = (k: string, words: string[]): SceneElement => ({
      id: `pn-${k}`,
      type: "frame",
      name: "Link panel",
      meta: { tag: "div" },
      layout: { direction: "column", gap: 8, width: 300 },
      children: [
        { id: `pn-${k}-t`, type: "text", text: `Panel ${k}`, style: { fontSize: 20 } },
        {
          id: `pn-${k}-ul`,
          type: "frame",
          meta: { tag: "ul" },
          layout: { direction: "column" },
          children: words.map((w, i) => ({
            id: `pn-${k}-a${i}`,
            type: "text" as const,
            text: w,
            meta: { tag: "a" },
            interaction: { onTap: "open-url" as const, url: `https://x.test/${w}` },
          })),
        },
      ],
    });
    const s = screen("page", [
      panel("a", ["Tickets", "Tarife", "Abo"]),
      panel("b", ["Hilfe", "Kontakt", "FAQ"]),
    ]);
    const r = extractComponents([{ nodeId: "n", screen: s }], ds(), { newId: ids() });
    const def = r.ds.componentSets!.find((d) => d.name.startsWith("Link panel"))!;
    expect(def.properties?.map((p) => p.name) ?? []).not.toContain("Label 2");
    expect((def.properties ?? []).filter((p) => p.type === "text").map((p) => p.target)).toEqual(["pn-a-t"]);
    expect(rebuildsExactly(r.screens.get("n")!, r.ds)).toBe(true);
    sameLook(s, r.screens.get("n")!);
  });

  it("makes alike sections that differ in copy, pictures, heights and an optional layer one set with an instance each", () => {
    const blocks = [
      band("Schulungen für die Zukunft", "Kurse für alle.", "a"),
      band("4,5 Milliarden USD", "Umsatz im Jahr 2025.", "b", { height: 480, picHeight: 260 }),
      form,
      band("Forschung", "Labore weltweit.", "c", { more: true }),
    ];
    const before = both(blocks);
    const r = extractComponents(before, ds(), { newId: ids(), sections: true });
    const sections = r.components.filter((c) => c.section && c.kind !== "header" && c.kind !== "hero");
    // three bands × two breakpoints: one set; the form stays its own
    expect(sections.map((c) => c.instances).sort()).toEqual([2, 6]);
    const bands = sections.find((c) => c.instances === 6)!;
    expect(bands.single).toBeUndefined();
    const def = findDef(r.ds, bands.id)!;
    // their copy and picture are properties; no name made of page copy
    expect(def.properties!.map((p) => p.type)).toEqual(expect.arrayContaining(["text", "image"]));
    expect(r.components.map((c) => c.name).join()).not.toMatch(/Schulungen|Milliarden|Forschung/);
    // the band with the extra link holds it as an addition
    const third = findElement(r.screens.get("n2")!.root, "l-s3")!;
    expect(third.instance?.componentId).toBe(bands.id);
    expect(Object.values(third.instance?.additions ?? {}).flat()).toHaveLength(1);
    checkPages(before, r);
  });

  it('does not name a set after the capture\'s CSS classes ("Cds card content")', () => {
    const named =
      (b: Block, name: string): Block =>
      (id, wide) => ({ ...b(id, wide), name });
    const r = extractComponents(
      both([
        named(band("A", "a.", "a"), "Cds card content"),
        named(band("B", "b.", "b", { picHeight: 300 }), "Cds card content"),
        named(form, "Cds form group"),
        named(band("C", "c.", "c", { more: true }), "Cds link list"),
      ]),
      ds(),
      { newId: ids(), sections: true },
    );
    expect(r.components.map((c) => c.name).join()).not.toMatch(/Cds/i);
  });

  it("makes one page slot shown at some widths only one set, its copy and measures its own (bmw.de WLTP line)", () => {
    // the consumption line under a teaser: shortened on the phone, in full on the tablet, absent on desktop; the
    // capture measured how far each text was narrowed (`narrowedBy`: editor meta an instance cannot override)
    const wltp =
      (short: boolean, narrowedBy: number): Block =>
      (id) => ({
        id,
        type: "frame",
        name: "Text · BMW iX3 50 xDrive: Energiev…",
        meta: { tag: "div" },
        layout: { direction: "row", width: "fill", height: short ? 72 : 36 },
        style: { opacity: 0.71 },
        children: [
          {
            id: `${id}-t`,
            type: "text",
            name: "BMW iX3 50 xDrive: Energieverbr…",
            meta: { narrowedBy },
            layout: { width: "fill" },
            style: { fontSize: 12 },
            text: short
              ? "BMW iX3 50 xDrive: Energieverbrauch kombiniert: 17,9–15,1 kWh/100 km (WLTP)"
              : "BMW iX3 50 xDrive: Energieverbrauch kombiniert: 17,9–15,1 kWh/100 km (WLTP); CO₂-Emissionen kombiniert: 0 g/km (WLTP); CO₂-Klasse(n): A",
          },
        ],
      });
    // (on desktop a teaser further down has a layer of the same name and is no wrapper, so neither is the line's frame
    // on the phone and tablet: the frame is the section at both widths)
    const promo: Block = (id) => ({
      id,
      type: "frame",
      name: "Text · BMW 120",
      meta: { tag: "div" },
      layout: { direction: "row", width: "fill", height: 300 },
      children: [
        {
          id: `${id}-i`,
          type: "image",
          image: { src: "https://x.test/120.jpg" },
          layout: { width: 300, height: 300 },
        },
        { id: `${id}-t`, type: "text", text: "Freude am Fahren.", style: { fontSize: 24 } },
      ],
    });
    const before: ExtractScreen[] = [
      { nodeId: "n1", screen: sectionsPage(390, 0, "s", [band("A", "a.", "a"), wltp(true, 20.12), form]) },
      { nodeId: "n2", screen: sectionsPage(768, 768, "m", [band("A", "a.", "a"), wltp(false, 36.3), form]) },
      { nodeId: "n3", screen: sectionsPage(1440, 1024, "l", [band("A", "a.", "a"), form, promo]) },
    ];
    const r = extractComponents(before, ds(), { newId: ids(), sections: true });
    const lines = r.components.filter((c) => c.section && /Text/.test(c.name) && c.instances <= 2);
    // one set at both widths (what differs is geometry: one design, each copy its own measures as overrides)
    expect(lines.map((c) => c.instances)).toEqual([2]);
    checkPages(before, r);
    const again = extractComponents(
      before.map((s) => ({ ...s, screen: r.screens.get(s.nodeId) ?? s.screen })),
      r.ds,
      { newId: () => "x", sections: true },
    );
    expect(again.components).toEqual([]);
  });

  it("makes the cards of a grid the phone stacks full width one card part, not single-use sections (ibm.com Cds tiles)", () => {
    // each card: a pictogram, an arrow, a title and a text laid out absolutely; their heights, text widths and measured
    // narrowing follow their copy; on the phone the grid is a column of full-width cards (each one a "section")
    const titles = [
      "KI-Produktivität steigern mit IBM watsonx",
      "Datenstreaming mit IBM Confluent",
      "Intelligenter Speicherbetrieb mit IBM FlashSystem",
      "Identitätsbasierte Sicherheit mit IBM Vault",
      "Asset-Management mit IBM Maximo",
      "IBM Consulting",
    ];
    const tile = (id: string, i: number, wide: boolean, desk = false): SceneElement => {
      const h = wide ? 316 : [208, 256, 256, 304, 208, 280][i]!;
      // (on desktop the card lays its icons out in a row and leaves its text out: the same card, other markup)
      if (desk)
        return {
          id,
          type: "frame",
          name: "Cds tile",
          meta: { tag: "div" },
          layout: { direction: "row", width: 332, height: 232 },
          style: { background: "#ffffff" },
          children: [
            {
              id: `${id}-c`,
              type: "frame",
              name: "Cds card content",
              meta: { tag: "div" },
              layout: { direction: "row", gap: 232, width: "fill", height: 212 },
              children: [
                {
                  id: `${id}-pic`,
                  type: "icon",
                  name: "Cds card pictogram",
                  svg: `<svg viewBox="0 0 48 48"><path d="M${i} ${i}h${10 + i}"/></svg>`,
                  layout: { width: 48, height: 48 },
                },
                {
                  id: `${id}-cta`,
                  type: "icon",
                  name: "C4d card cta",
                  svg: '<svg viewBox="0 0 20 20"><path d="M0 10h20"/></svg>',
                  layout: { width: 20, height: 20 },
                },
                {
                  id: `${id}-t`,
                  type: "text",
                  name: titles[i]!.slice(0, 30),
                  text: titles[i]!,
                  layout: { position: "absolute", x: 16, y: 2 + (i % 2) * 2, width: 268 },
                  style: { fontSize: 16, lineHeightPx: 22.4 },
                },
              ],
            },
          ],
        };
      const short = titles[i]!.length < 20;
      return {
        id,
        type: "frame",
        name: "Cds tile",
        meta: { tag: "div" },
        layout: { direction: "row", width: wide ? 344 : "fill", height: h },
        style: { background: "#ffffff" },
        children: [
          {
            id: `${id}-c`,
            type: "frame",
            name: "Cds card content",
            meta: { tag: "div" },
            layout: { width: "fill", height: h - (wide ? 16 : 0) },
            children: [
              {
                id: `${id}-pic`,
                type: "icon",
                name: "Cds card pictogram",
                svg: `<svg viewBox="0 0 48 48"><path d="M${i} ${i}h${10 + i}"/></svg>`,
                layout: { position: "absolute", x: 16, y: wide ? h - 64 : 16, width: 48, height: 48 },
              },
              {
                id: `${id}-cta`,
                type: "icon",
                name: "C4d card cta",
                svg: '<svg viewBox="0 0 20 20"><path d="M0 10h20"/></svg>',
                layout: { position: "absolute", x: wide ? 308 : 322, y: h - 36, width: 20, height: 20 },
              },
              {
                id: `${id}-t`,
                type: "text",
                name: titles[i]!.slice(0, 30),
                text: titles[i]!,
                layout: { position: "absolute", x: wide ? 16 : 80, y: wide ? 0 : 16, width: 140 + i * 4 },
                style: { fontSize: 16, lineHeightPx: 22.4, ...(short ? { whiteSpace: "pre" as const } : {}) },
                ...(i % 2 ? { meta: { narrowedBy: 5 + i } } : {}),
              },
              {
                id: `${id}-d`,
                type: "text",
                name: `Text ${i}`,
                text: `Was ${titles[i]} für Sie tun kann, in ${i + 2} Sätzen.`,
                layout: { position: "absolute", x: wide ? 16 : 80, y: 72 + (i % 2) * 24, width: 226 - i },
                style: { fontSize: 14 },
              },
            ],
          },
        ],
      };
    };
    const grid =
      (desk = false): Block =>
      (id, wide) => ({
        id,
        type: "frame",
        name: "Themed pictogram",
        meta: { tag: "c4d-card-group" },
        layout: {
          direction: wide ? "row" : "column",
          width: "fill",
          ...(wide ? { wrap: true, height: 700 } : {}),
        },
        children: titles.map((_, i) => tile(`${id}-${i}`, i, wide, desk)),
      });
    const before: ExtractScreen[] = [
      { nodeId: "n1", screen: sectionsPage(390, 0, "s", [band("A", "a.", "a"), grid(), form]) },
      { nodeId: "n2", screen: sectionsPage(768, 672, "m", [band("A", "a.", "a"), grid(), form]) },
      { nodeId: "n3", screen: sectionsPage(1440, 1056, "l", [band("A", "a.", "a"), grid(true), form]) },
    ];
    const r = extractComponents(before, ds(), { newId: ids(), sections: true });
    // one card set, every card of every width an instance (desktop's markup its own variant); no section per card
    const cards = r.components.filter((c) => !c.section && c.kind !== "icon" && c.kind !== "logo");
    expect(cards.map((c) => c.instances)).toEqual([18]);
    expect(cards[0]!.variants).toContain("breakpoint=lg");
    expect(r.components.filter((c) => c.section && c.instances === 1)).toEqual([]);
    expect(r.components.map((c) => c.name).join()).not.toMatch(/KI-Produktiv|Confluent|Maximo/);
    checkPages(before, r);
    const again = extractComponents(
      before.map((s) => ({ ...s, screen: r.screens.get(s.nodeId) ?? s.screen })),
      r.ds,
      { newId: () => "x", sections: true },
    );
    expect(again.components).toEqual([]);
  });

  it("keeps a genuinely different section apart, flagged as a one-off with how near it came", () => {
    const r = extractComponents(both([band("A", "a.", "a"), band("B", "b.", "b"), form]), ds(), {
      newId: ids(),
      sections: true,
    });
    const formSet = r.components.find((c) => c.section && c.instances === 2 && c.kind !== "header")!;
    expect(formSet).toMatchObject({ single: true });
    expect(extractionOf(findDef(r.ds, formSet.id)!)).toMatchObject({ single: true });
    expect(extractionOf(findDef(r.ds, formSet.id)!)!.nearest ?? 0).toBeLessThan(0.85);
    expect(
      extractionOf(findDef(r.ds, r.components.find((c) => c.instances === 4)!.id)!)?.single,
    ).toBeUndefined();
  });

  it("is idempotent after merging: a second run finds nothing, nothing left for a later round", () => {
    const blocks = [
      band("A", "a.", "a"),
      band("B", "b.", "b", { picHeight: 300 }),
      form,
      band("C", "c.", "c", { more: true }),
      stack("Shop", [120, 160]),
      stack("Sale", [120, 160, 200]),
    ];
    const before = both(blocks);
    const r = extractComponents(before, ds(), { newId: ids(), sections: true });
    // header, stage, bands, form, stacks: every section set once
    expect(r.components.filter((c) => c.section)).toHaveLength(5);
    const again = extractComponents(
      before.map((s) => ({ ...s, screen: r.screens.get(s.nodeId) ?? s.screen })),
      r.ds,
      { newId: () => "x", sections: true },
    );
    expect(again.components).toEqual([]);
    checkPages(before, r);
  });

  it("makes the cards of alike sibling sections a nested item set: the sections differ only in how many they hold", () => {
    const before = both([stack("Shop", [120, 160]), stack("Sale", [120, 160, 200])]);
    const r = extractComponents(before, ds(), { newId: ids(), sections: true });
    const cardSet = r.components.find((c) => !c.section && c.kind === "card")!;
    // 5 cards × 2 breakpoints, their picture heights per copy
    expect(cardSet).toMatchObject({ instances: 10, variants: ["default"] });
    const stacks = r.components.filter((c) => c.section && c.kind !== "header" && c.kind !== "hero");
    expect(stacks.map((c) => c.instances)).toEqual([4]);
    const main = Object.values(findDef(r.ds, stacks[0]!.id)!.variants)[0]!;
    // (the heading beside the row is a trimming: the row of cards is the section)
    expect(main.children!.every((c) => c.instance?.componentId === cardSet.id)).toBe(true);
    // no numbered card props: the cards' copy belongs to the cards
    expect(stacks[0]!.name).toMatch(/^Section \/ Card (grid|list)$/);
    checkPages(before, r);
  });

  it("names sections after their structure; a heading only tells otherwise alike names apart; numbers are flagged", () => {
    const text =
      (title: string, n: number): Block =>
      (id) => ({
        id,
        type: "frame",
        name: "Group",
        meta: { tag: "div" },
        layout: { direction: "column", gap: 12, padding: 24, width: "fill", height: 200 + n * 40 },
        children: [
          { id: `${id}-h`, type: "text", text: title, style: { fontSize: 28 }, meta: { tag: "h2" } },
          ...Array.from({ length: n }, (_, i) => ({
            id: `${id}-p${i}`,
            type: "text" as const,
            text: `Absatz ${i} über ${title}.`,
            style: { fontSize: 16 },
            meta: { tag: "p" },
          })),
        ],
      });
    const pic =
      (n: number): Block =>
      (id) => ({
        id,
        type: "frame",
        name: "Group",
        meta: { tag: "div" },
        layout: { direction: "row", width: "fill", height: 300 },
        children: Array.from({ length: n }, (_, i) => ({
          id: `${id}-i${i}`,
          type: "image" as const,
          image: { src: `https://x.test/${id}-${i}.jpg` },
          layout: { width: 300, height: 300 },
        })),
      });
    const r = extractComponents(
      both([text("Schulungen für die Zukunft", 1), pic(1), text("Unsere Labore", 3), pic(3)]),
      ds(),
      { newId: ids(), sections: true },
    );
    const names = r.components
      .filter((c) => c.section && c.kind !== "header" && c.kind !== "hero")
      .map((c) => c.name);
    // structure first, the heading as a qualifier only
    expect(names.filter((n) => n.startsWith("Section / Text"))).toHaveLength(2);
    expect(names.every((n) => !/^Section \/ (Schulungen|Unsere)/.test(n))).toBe(true);
    // nothing tells the two picture sections apart: numbered, and flagged so the naming step must name them
    const pics = r.components.filter((c) => c.nameClash);
    expect(pics.map((c) => [c.name, c.nameClash, !!c.numbered])).toEqual([
      ["Section / Picture", "Section / Picture", false],
      ["Section / Picture 2", "Section / Picture", true],
    ]);
    for (const c of pics) expect(extractionOf(findDef(r.ds, c.id)!)?.nameClash).toBe("Section / Picture");
  });
});
