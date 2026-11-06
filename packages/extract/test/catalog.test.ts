// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneComponentDef, SceneDesignSystem, SceneElement } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import {
  catalogOf,
  classifyComponent,
  classifyTree,
  componentApi,
  instancesOf,
  mainShows,
  numberedProps,
  numberedPropsOf,
  propertyNames,
} from "@harness/extract";
import { repeatedItems } from "@harness/extract";

const ds = (sets: SceneComponentDef[] = []): SceneDesignSystem => ({
  version: 1,
  name: "DS",
  tokens: { ...DEFAULT_TOKENS },
  componentSets: sets,
});
const text = (id: string, t: string, fontSize = 16): SceneElement => ({
  id,
  type: "text",
  text: t,
  style: { fontSize },
});

describe("classify components", () => {
  it("a line code on a small plate (U5, M10) is a badge even when it links, a short label on a plate is a button", () => {
    const plate = (label: string, tag = "a"): SceneElement => ({
      id: "p",
      type: "frame",
      meta: { tag },
      interaction: { onTap: "open-url", target: "https://x.de/u5" },
      layout: { width: 34, height: 22, padding: [0, 6] },
      style: { background: "#528dba", radius: 4 },
      children: [text("t", label, 14)],
    });
    expect(classifyTree(plate("U5"))).toBe("badge");
    expect(classifyTree(plate("M10", "button"))).toBe("badge");
    expect(classifyTree({ ...plate("Los", "button"), layout: { width: 80, height: 40 } })).toBe("button");
  });

  it("reads form controls from DSL types, captured inputs and tags", () => {
    expect(classifyTree({ id: "a", type: "toggle" })).toBe("toggle");
    expect(classifyTree({ id: "a", type: "frame", meta: { role: "input", inputType: "checkbox" } })).toBe(
      "checkbox",
    );
    expect(
      classifyTree({
        id: "a",
        type: "frame",
        name: "Input · Suche",
        meta: { role: "input", inputType: "search" },
      }),
    ).toBe("search");
    expect(classifyTree({ id: "a", type: "frame", meta: { role: "input", inputType: "email" } })).toBe(
      "input",
    );
    expect(classifyTree({ id: "a", type: "frame", meta: { tag: "select" } })).toBe("select");
    expect(
      classifyTree({
        id: "a",
        type: "frame",
        meta: { tag: "form" },
        children: [
          { id: "i", type: "frame", meta: { role: "input", inputType: "text" } },
          { id: "j", type: "frame", meta: { role: "input", inputType: "email" } },
        ],
      }),
    ).toBe("form");
  });

  it("tells buttons, links, tags, badges and icon buttons apart", () => {
    expect(
      classifyTree({
        id: "b",
        type: "button",
        text: "Buy",
        style: { background: "#0055ff" },
        layout: { height: 40 },
      }),
    ).toBe("button");
    expect(
      classifyTree({
        id: "b",
        type: "frame",
        meta: { tag: "a" },
        interaction: { onTap: "open-url", url: "x" },
        children: [text("t", "Read more")],
      }),
    ).toBe("link");
    expect(
      classifyTree({
        id: "b",
        type: "frame",
        style: { background: "#eeeeee", radius: 12 },
        layout: { height: 24 },
        children: [text("t", "New")],
      }),
    ).toBe("badge");
    expect(classifyTree({ id: "b", type: "frame", name: "Bds Tag", children: [text("t", "U2")] })).toBe(
      "tag",
    );
    expect(
      classifyTree({
        id: "b",
        type: "button",
        layout: { width: 32, height: 32 },
        children: [{ id: "i", type: "icon", icon: "x" }],
      }),
    ).toBe("icon-button");
    expect(
      classifyTree({ id: "b", type: "icon", icon: "arrow-right", layout: { width: 24, height: 24 } }),
    ).toBe("icon");
  });

  it("reads media, logos, cards, teasers, list items, accordions and carousels", () => {
    const img = (w: number, h: number): SceneElement => ({
      id: "img",
      type: "image",
      image: { src: "x.jpg" },
      layout: { width: w, height: h },
    });
    expect(classifyTree(img(300, 200))).toBe("image");
    expect(
      classifyTree({
        id: "l",
        type: "image",
        name: "BMW Logo",
        image: { src: "logo.svg" },
        layout: { width: 36, height: 36 },
      }),
    ).toBe("logo");
    expect(
      classifyTree({
        id: "c",
        type: "frame",
        style: { background: "#fff", radius: 8 },
        children: [img(300, 200), text("t", "Title", 20)],
      }),
    ).toBe("card");
    expect(
      classifyTree({
        id: "c",
        type: "frame",
        meta: { tag: "a" },
        interaction: { onTap: "open-url", url: "x" },
        children: [img(300, 200), text("t", "Title", 20)],
      }),
    ).toBe("teaser");
    expect(
      classifyTree({
        id: "r",
        type: "frame",
        meta: { tag: "li" },
        layout: { direction: "row" },
        children: [{ id: "i", type: "icon", icon: "check" }, text("t", "Free shipping")],
      }),
    ).toBe("list-item");
    expect(
      classifyTree({
        id: "a",
        type: "frame",
        states: {},
        children: [
          {
            id: "h",
            type: "frame",
            children: [text("t", "Question"), { id: "i", type: "icon", icon: "chevron-down" }],
          },
          { id: "p", type: "frame", meta: { hidden: true }, children: [text("a", "Answer")] },
        ],
      }),
    ).toBe("accordion");
    const slide = (k: string): SceneElement => ({
      id: k,
      type: "frame",
      children: [img(200, 200), text(`${k}t`, k)],
    });
    expect(
      classifyTree({
        id: "c",
        type: "frame",
        layout: { scroll: "horizontal" },
        children: [slide("a"), slide("b"), slide("c")],
      }),
    ).toBe("carousel");
  });

  it("reads page sections from their place: header on top, footer at the bottom, the stage with a big picture and heading", () => {
    const at = (n: number, count = 4) => ({
      section: true,
      sectionIndex: n,
      sectionCount: count,
      viewportHeight: 900,
    });
    expect(
      classifyTree(
        {
          id: "h",
          type: "frame",
          meta: { tag: "header" },
          layout: { height: 64 },
          children: [text("t", "Shop")],
        },
        { ...at(0), atTop: true, size: { w: 1280, h: 64 } },
      ),
    ).toBe("header");
    expect(
      classifyTree(
        { id: "f", type: "frame", meta: { tag: "footer" }, children: [text("t", "Imprint")] },
        { ...at(3), atBottom: true, size: { w: 1280, h: 300 } },
      ),
    ).toBe("footer");
    const stage: SceneElement = {
      id: "s",
      type: "frame",
      children: [
        { id: "i", type: "image", image: { src: "x" }, layout: { width: "fill", height: 600 } },
        text("t", "Spring", 56),
      ],
    };
    expect(classifyTree(stage, { ...at(1), atTop: true, size: { w: 1280, h: 600 } })).toBe("hero");
    expect(classifyTree(stage, { ...at(3, 5), size: { w: 1280, h: 600 } })).toBe("section");
    expect(
      classifyTree({ id: "m", type: "frame", children: [text("t", "Home")] }, { ...at(0), overlay: true }),
    ).toBe("menu");
  });

  it("a set keeps the kind it has; catalogOf groups sets by category in the system's order", () => {
    const set = (id: string, kind: SceneComponentDef["kind"], tree: SceneElement): SceneComponentDef => ({
      id,
      name: id,
      kind,
      variants: { default: tree },
      defaultVariant: "default",
    });
    const sets = [
      set("btn", undefined, { id: "b", type: "button", text: "Go", style: { background: "#000" } }),
      set("hdr", "header", { id: "h", type: "frame" }),
      set("ico", undefined, { id: "i", type: "icon", icon: "x" }),
    ];
    expect(classifyComponent(sets[1]!, ds(sets))).toEqual({ kind: "header", category: "shell" });
    expect(classifyComponent(sets[0]!, ds(sets))).toEqual({ kind: "button", category: "forms" });
    expect(catalogOf(ds(sets)).map((g) => [g.category, g.sets.map((s) => s.id)])).toEqual([
      ["shell", ["hdr"]],
      ["forms", ["btn"]],
      ["foundations", ["ico"]],
    ]);
  });
});

describe("component API", () => {
  it("names text, image, boolean and swap properties by their role", () => {
    const main: SceneElement = {
      id: "c",
      type: "frame",
      children: [
        text("eyebrow", "NEW", 12),
        text("title", "Spring is here", 32),
        text("desc", "A long description of the season and all the plants that come with it, and more.", 16),
        { id: "img", type: "image", image: { src: "x.jpg" }, layout: { width: 300, height: 200 } },
        { id: "ic", type: "icon", icon: "leaf" },
      ],
    };
    expect(
      propertyNames(main, "card", {
        text: ["desc", "title", "eyebrow"],
        image: ["img"],
        boolean: ["ic"],
        swap: [],
      }).map((p) => [p.name, p.type, p.target]),
    ).toEqual([
      ["Eyebrow", "text", "eyebrow"],
      ["Title", "text", "title"],
      ["Description", "text", "desc"],
      ["Image", "image", "img"],
      ["Show icon", "boolean", "ic"],
    ]);
    // a list's texts are its items
    const list: SceneElement = {
      id: "l",
      type: "frame",
      children: [text("h", "Service", 18), text("a", "Contact"), text("b", "Help")],
    };
    expect(
      propertyNames(list, "list", { text: ["h", "a", "b"], image: [], boolean: [], swap: [] }).map(
        (p) => p.name,
      ),
    ).toEqual(["Title", "Item 1", "Item 2"]);
  });

  it("lists axes, properties (with defaults) and named content slots", () => {
    const def: SceneComponentDef = {
      id: "hero",
      name: "Hero",
      kind: "hero",
      defaultVariant: "breakpoint=sm",
      variantAxes: { breakpoint: ["sm", "lg"] },
      properties: [{ name: "Image", type: "image", target: "img", default: "stage.jpg" }],
      variants: {
        "breakpoint=sm": {
          id: "r",
          type: "frame",
          children: [
            { id: "img", type: "image", image: { src: "stage.jpg" } },
            text("t", "Spring", 36),
            text("s", "Plants for every room", 18),
          ],
        },
        "breakpoint=lg": {
          id: "r",
          type: "frame",
          children: [
            { id: "img", type: "image", image: { src: "stage.jpg" } },
            text("t", "Spring", 56),
            text("s", "Plants for every room", 20),
          ],
        },
      },
    };
    expect(
      componentApi(def, ds([def]), { slots: true }).map((p) => [p.name, p.type, p.default, p.source.kind]),
    ).toEqual([
      ["breakpoint", "enum", "sm", "axis"],
      ["image", "image", "stage.jpg", "property"],
      ["title", "text", "Spring", "slot"],
      ["subtitle", "text", "Plants for every room", "slot"],
    ]);
  });
});

describe("list items in the API", () => {
  // a merged card-grid section (Q1): a heading, six alike cards (picture, title, description, link), a button
  const card = (n: number, t: string): SceneElement => ({
    id: `card${n}`,
    type: "frame",
    meta: { tag: "article" },
    style: { background: "#fff", radius: 8 },
    children: [
      {
        id: `card${n}-img`,
        type: "image",
        image: { src: `https://x.com/${n}.jpg` },
        layout: { width: 300, height: 160 },
      },
      text(`card${n}-t`, `${t} title`, 20),
      text(
        `card${n}-d`,
        `${t}: a longer description of what this card is about, more than sixty characters long.`,
        14,
      ),
      {
        id: `card${n}-a`,
        type: "frame",
        meta: { tag: "a" },
        interaction: { onTap: "open-url", url: `https://x.com/${n}` },
        children: [text(`card${n}-al`, "Read more", 14)],
      },
    ],
  });
  const names = ["Cloud", "Data", "AI", "Security", "Consulting", "Research"];
  const grid: SceneElement = {
    id: "sec",
    type: "frame",
    meta: { tag: "section" },
    layout: { width: 1280 },
    children: [
      text("h", "What we do", 40),
      {
        id: "row",
        type: "frame",
        layout: { direction: "row", wrap: true },
        children: names.map((t, i) => card(i + 1, t)),
      },
      { id: "cta", type: "button", children: [text("cta-l", "See all", 16)] },
    ],
  };
  const section: SceneComponentDef = {
    id: "grid",
    name: "Section / Card grid",
    kind: "section",
    variants: { default: grid },
    defaultVariant: "default",
  };

  it("finds alike sibling items from structure alone", () => {
    expect(repeatedItems(grid)).toEqual([{ parent: "row", items: names.map((_, i) => `card${i + 1}`) }]);
    // a heading and a paragraph are no items
    expect(
      repeatedItems({ id: "r", type: "frame", children: [text("a", "Hello", 32), text("b", "World")] }),
    ).toEqual([]);
  });

  it("groups the copy of repeated items per item: no flat numbered slots", () => {
    const api = componentApi(section, ds([section]), { slots: true });
    const flat = api.filter((p) => !p.item);
    expect(flat.map((p) => p.label)).toEqual(["Title", "Action"]);
    const items = api.filter((p) => p.item);
    expect(items.length).toBe(6 * 4);
    expect(items.slice(0, 4).map((p) => [p.name, p.item!.itemLabel, p.item!.field, p.type])).toEqual([
      ["cards[0].title", "Card 1", "Title", "text"],
      ["cards[0].description", "Card 1", "Description", "text"],
      ["cards[0].action", "Card 1", "Action", "text"],
      ["cards[0].image", "Card 1", "Image", "image"],
    ]);
    expect(items.find((p) => p.name === "cards[5].title")!.default).toBe("Research title");
    // zero numbered props
    expect(numberedProps(section, ds([section]))).toEqual([]);
    expect(api.filter((p) => /\d$/.test(p.name) || /\d$/.test(p.label))).toEqual([]);
  });

  it("names item properties per item (the set's own copy first) and still flags flat numbered names", () => {
    const ids = names.map((_, i) => `card${i + 1}-t`);
    expect(
      propertyNames(grid, "section", { text: ["h", ...ids], image: [], boolean: [], swap: [] }).map(
        (p) => p.name,
      ),
    ).toEqual(["Title", ...names.map((_, i) => `Card ${i + 1} title`)]);
    // a set whose properties were numbered flat (before list items): a lint hit each
    const old: SceneComponentDef = {
      ...section,
      id: "old",
      properties: [
        { name: "Title", type: "text", target: "h", default: "What we do" },
        { name: "Title 2", type: "text", target: "card1-t", default: "Cloud title" },
      ],
    };
    expect(numberedProps(old, ds([old])).map((p) => p.label)).toEqual(["Title 2"]);
    expect(numberedPropsOf(ds([old, section]))).toEqual([
      { set: "old", name: "Section / Card grid", prop: "Title 2" },
    ]);
  });

  it("defaults come from what most instances show; mainShows tells which use the main is", () => {
    const def: SceneComponentDef = {
      id: "teaser",
      name: "Teaser",
      kind: "card",
      defaultVariant: "default",
      variants: {
        default: {
          id: "r",
          type: "frame",
          children: [text("t", "Riverty", 20), text("d", "Buy now, pay later with a partner of ours.")],
        },
      },
    };
    const at = (el: string, t?: string): SceneElement => ({
      id: el,
      type: "frame",
      instance: { componentId: "teaser", ...(t ? { overrides: { t: { text: t } } } : {}) },
    });
    const screens = [
      {
        id: "s1",
        dsl: { root: { id: "root1", type: "frame", children: [at("a", "Cloud"), at("b")] } as SceneElement },
      },
      {
        id: "s2",
        dsl: {
          root: {
            id: "root2",
            type: "frame",
            children: [at("c", "Cloud"), at("d", "Cloud"), at("e", "Data")],
          } as SceneElement,
        },
      },
    ];
    const uses = instancesOf("teaser", screens);
    expect(uses.map((u) => `${u.screen}/${u.element}`)).toEqual(["s1/a", "s1/b", "s2/c", "s2/d", "s2/e"]);
    const api = componentApi(def, ds([def]), { slots: true, instances: uses });
    const title = api.find((p) => p.label === "Title")!;
    expect([title.default, title.main]).toEqual(["Cloud", "Riverty"]);
    // the description no instance changes keeps the main's copy
    expect(api.find((p) => p.label === "Subtitle")).toMatchObject({
      default: "Buy now, pay later with a partner of ours.",
    });
    expect(api.find((p) => p.label === "Subtitle")!.main).toBeUndefined();
    expect(mainShows(def, ds([def]), uses)).toMatchObject({
      index: 1,
      matching: 1,
      total: 5,
      use: { screen: "s1", element: "b" },
    });
  });
});

describe("popovers", () => {
  it("reads a popover of links as a menu, a few words as a tooltip", async () => {
    const { classifyTree } = await import("@harness/extract");
    const link = (i: number) => ({
      id: `l${i}`,
      type: "text" as const,
      text: `Link ${i}`,
      interaction: { onTap: "open-url" as const, url: `https://x.de/${i}` },
    });
    expect(
      classifyTree({
        id: "p",
        type: "frame",
        name: "Popover",
        layout: { width: 280, height: 220 },
        children: [1, 2, 3, 4].map(link),
      }),
    ).toBe("menu");
    expect(
      classifyTree({
        id: "t",
        type: "frame",
        name: "Tooltip",
        layout: { width: 160, height: 40 },
        children: [{ id: "x", type: "text", text: "Copied" }],
      }),
    ).toBe("tooltip");
  });
});
