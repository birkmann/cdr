// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneComponentDef, SceneElement } from "@harness/protocol";
import { builtinName, cssClassName, pageCopyName, pageTexts, structureLint } from "@harness/extract";

const text = (id: string, t: string): SceneElement => ({ id, type: "text", text: t });
const def = (
  id: string,
  name: string,
  kind: SceneComponentDef["kind"],
  main: Partial<SceneElement> = {},
  extra: Partial<SceneComponentDef> = {},
): SceneComponentDef => ({
  id,
  name,
  kind,
  origin: "extracted",
  defaultVariant: "default",
  variants: { default: { id: `${id}-m`, type: "frame", children: [text(`${id}-t`, "Hallo")], ...main } },
  ...extra,
});
const inst = (id: string, componentId: string): SceneElement => ({
  id,
  type: "frame",
  instance: { componentId },
});
const screen = (id: string, children: SceneElement[], group = "start") => ({
  id,
  root: { id: `${id}-r`, type: "frame" as const, children },
  responsive: { group, minWidth: 0 },
});
const check = (l: ReturnType<typeof structureLint>, id: string) => l.checks.find((c) => c.id === id)!;

describe("structure lint", () => {
  it("tells built-in, page-copy and CSS-class names", () => {
    expect(builtinName("Card / with image 2")).toBe(true);
    expect(builtinName("TeaserCard")).toBe(false);
    const texts = pageTexts([
      { id: "r", type: "frame", children: [text("h", "Schulungen für die Zukunft"), text("b", "Mehr")] },
    ]);
    expect(pageCopyName("Section / Schulungen für die Zukunft", texts)).toBe(true);
    // the kind word is no copy; two words are not enough
    expect(pageCopyName("SchulungenFürDieZukunftSection", texts)).toBe(true);
    expect(pageCopyName("TrainingSection", texts)).toBe(false);
    expect(pageCopyName("Section / Mehr", texts)).toBe(false);
    expect(cssClassName("Cds card content")).toBe(true);
    expect(cssClassName("CdsMasthead")).toBe(true);
    expect(cssClassName("Section / Sc jxm3yrc")).toBe(true);
    expect(cssClassName("Masthead")).toBe(false);
    expect(cssClassName("Hero 1440px")).toBe(false);
  });

  it("finds twins (not icons), single-use sets over budget, the sections : parts ratio and numbered props", () => {
    const sets = [
      def("s1", "Section / Cds card content 1", "section", { style: { background: "#fff" } }),
      def("s2", "Section / Cds card content 2", "section", { style: { background: "#fff" } }),
      def("i1", "ArrowIcon", "icon", { svg: "<svg a/>" }),
      def("i2", "ChevronIcon", "icon", { svg: "<svg b/>" }),
      def(
        "c",
        "Card",
        "card",
        {},
        {
          properties: [
            { name: "Title", type: "text", default: "x", target: "c-t" },
            { name: "Title 2", type: "text", default: "y", target: "c-t2" },
            { name: "Logo", type: "text", default: "data:image/avif;base64,AAAA", target: "c-l" },
          ],
        },
      ),
      def("g", "Button", "button", {}, { origin: "generated" }),
    ];
    // one page at two widths: each section once per width, the card twice, the icons in the card's main
    const kids = [inst("a", "s1"), inst("b", "s2"), inst("c1", "c"), inst("c2", "c")];
    const withIcons = sets.map((d) =>
      d.id === "c"
        ? {
            ...d,
            variants: { default: { ...d.variants.default!, children: [inst("x", "i1"), inst("y", "i2")] } },
          }
        : d,
    );
    const l = structureLint({ sets: withIcons, screens: [screen("p1", kids), screen("p2", kids)] });
    expect(check(l, "twins")).toMatchObject({
      ok: false,
      count: 1,
      sets: ["Section / Cds card content 1 = Section / Cds card content 2"],
    });
    expect(l.counts).toMatchObject({
      extracted: 5,
      sections: 2,
      parts: 1,
      icons: 2,
      singleUseSections: 2,
      singleUseParts: 0,
      unused: 0,
      pageSections: 2,
    });
    expect(check(l, "single-use").ok).toBe(true);
    expect(check(l, "ratio")).toMatchObject({ ok: false, count: 2 });
    expect(check(l, "unnamed")).toMatchObject({ ok: false, count: 2 });
    expect(check(l, "numbered-names").sets).toEqual([
      "Section / Cds card content 1",
      "Section / Cds card content 2",
    ]);
    expect(check(l, "css-class").count).toBe(2);
    expect(check(l, "numbered-props").sets).toEqual(["Card.Title 2"]);
    expect(check(l, "image-text").sets).toEqual(["Card.Logo"]);
    // the generated essentials are not the extraction's
    expect(l.checks.flatMap((c) => c.sets).some((s) => s.startsWith("Button"))).toBe(false);
    // a section the extraction marked unique is not a single-use defect
    const one = structureLint({
      sets: [def("s", "HeroSection", "hero"), def("p", "Card", "card"), def("q", "Tag", "tag")],
      screens: [screen("p1", [inst("a", "s"), inst("b", "p"), inst("c", "p"), inst("d", "q")])],
      uniqueSection: (d) => d.id === "s",
    });
    expect(one.counts).toMatchObject({ singleUseSections: 0, singleUseParts: 1 });
    expect(check(one, "single-use")).toMatchObject({ ok: false, sets: ["Tag"] });
  });

  it("takes the naming outcome: sets it left unnamed or only on a fallback name, and an unfinished step, fail", () => {
    const sets = [
      def("a", "TeaserCard", "card"),
      def("b", "NewsCard", "card", { style: { background: "#000" } }),
    ];
    const screens = [screen("p", [inst("1", "a"), inst("2", "a"), inst("3", "b"), inst("4", "b")])];
    expect(check(structureLint({ sets, screens, naming: { status: "complete" } }), "unnamed")).toMatchObject({
      ok: true,
      detail: "naming complete",
    });
    const l = structureLint({ sets, screens, naming: { status: "partial", unnamed: [], fallback: ["b"] } });
    expect(check(l, "unnamed")).toMatchObject({
      ok: false,
      count: 0,
      sets: ["NewsCard (fallback)"],
      ids: ["b"],
      detail: "1 with a fallback name only · naming partial",
    });
    expect(
      check(structureLint({ sets, screens, naming: { status: "timeout", unnamed: ["a"] } }), "unnamed"),
    ).toMatchObject({ ok: false, count: 1, ids: ["a"] });
  });

  it("budgets every page's section slots once (shared header / footer once), the nested ones, and the allowed single-use parts", () => {
    const sets = [
      def("h", "Header", "header"),
      def("f", "Footer", "footer"),
      def("a", "HomeHero", "hero"),
      def("b", "NewsSection", "section"),
      def("m", "MobileMenu", "menu"),
      def("n", "NavBar", "navigation", { children: [inst("nm", "m")] }),
      def("c", "Card", "card"),
      def("k", "SkipLink", "link"),
    ];
    const home = [
      inst("1", "h"),
      inst("2", "a"),
      inst("3", "n"),
      inst("4", "c"),
      inst("5", "c"),
      inst("6", "k"),
      inst("7", "f"),
    ];
    const news = [
      inst("1", "h"),
      inst("2", "b"),
      inst("3", "n"),
      inst("4", "c"),
      inst("5", "c"),
      inst("7", "f"),
    ];
    const l = structureLint({
      sets,
      screens: [screen("p1", home, "home"), screen("p2", news, "news")],
      budget: { singleUseParts: 0.5 },
    });
    // header, footer, hero, news section, the menu inside the nav bar: 5 slots; + Card, NavBar repeated + 1 single-use part
    expect(l.counts).toMatchObject({ pageSections: 5, singleUseParts: 1, budget: 8, extracted: 8 });
    expect(check(l, "budget").ok).toBe(true);
    // one slot drawn by two sets at two widths is one slot: the second set is over budget
    const narrow = [inst("1", "h"), inst("2", "a"), inst("7", "f")],
      wide = [inst("1", "h"), inst("2", "b"), inst("7", "f")];
    const split = structureLint({
      sets: sets.slice(0, 4),
      screens: [screen("s", narrow, "home"), screen("w", wide, "home")],
    });
    expect(split.counts).toMatchObject({ pageSections: 3, extracted: 4, budget: 3 });
    expect(check(split, "budget").ok).toBe(false);
  });
});
