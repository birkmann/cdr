import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SceneElement } from "@harness/protocol";
import { pageScreens, pageSections, screensUpTo, tagSections, walk } from "@harness/scene";

const recorded = (w: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../capture/test/sites/acme/recorded/${w}.snapshot.json`, import.meta.url),
      "utf8",
    ),
  );

const caps = () => [
  { width: 390, minWidth: 0, snap: recorded(390) },
  { width: 768, minWidth: 768, snap: recorded(768) },
  { width: 1440, minWidth: 1024, snap: recorded(1440) },
];

describe("pageScreens (recorded acme snapshots)", () => {
  it("converts deterministically: same input, same JSON", () => {
    const a = pageScreens(caps());
    const b = pageScreens(caps());
    expect(JSON.stringify(a.screens)).toBe(JSON.stringify(b.screens));
  });

  it("makes one variant per width plus linked menu overlays and their drill-down level", () => {
    const ps = pageScreens(caps());
    expect(ps.variants.map((v) => v.width)).toEqual([390, 768, 1440]);
    expect(ps.screens.filter((s) => s.responsive).map((s) => s.responsive!.minWidth)).toEqual([0, 768, 1024]);
    const menus = ps.screens.filter((s) => typeof s.root.meta?.overlayOf === "string");
    // phone and tablet have the drawer and its "Products" level; desktop shows its nav inline
    expect(menus.length).toBe(4);
    expect(ps.variants[0].menuId).toBeTruthy();
    let opener: SceneElement | null = null;
    walk(ps.screens[0].root, (e) => {
      if (e.interaction?.onTap === "open-overlay") opener = e;
    });
    expect(opener).not.toBeNull();
    expect(ps.fonts.map((f) => f.family)).toContain("Acme Sans");
  });
});

describe("pageSections: widget states", () => {
  it("counts a states frame as its active state; the other states are never sections", () => {
    const block = (id: string, h: number, text: string): SceneElement => ({
      id,
      type: "frame",
      name: id,
      layout: { width: 1440, height: h },
      children: [{ id: `${id}-t`, type: "text", name: text, text } as SceneElement],
    });
    const main: SceneElement = {
      id: "main",
      type: "frame",
      name: "Main",
      layout: { width: 1440, height: 1800, position: "absolute", x: 0, y: 0 },
      children: [
        block("a", 600, "Alpha intro words"),
        block("b", 600, "Beta middle words"),
        block("c", 600, "Gamma closing words"),
      ],
    };
    const state = (id: string): SceneElement => ({
      ...block(id, 1800, "Alpha intro words again"),
      layout: { width: 1440, height: 1800, position: "absolute", x: 0, y: 0 },
    });
    const screen = {
      id: "p-1440",
      name: "p",
      width: 1440,
      height: 1848,
      root: {
        id: "root",
        type: "frame",
        name: "Page",
        layout: { width: 1440, height: 1848 },
        children: [
          block("header", 48, "Logo menu"),
          {
            id: "states",
            type: "frame",
            name: "States · Main",
            layout: { width: 1440, height: 1800 },
            states: { active: "main" },
            children: [main, state("s0"), state("s1")],
          },
        ],
      },
    } as unknown as Parameters<typeof pageSections>[0][number];
    const sections = pageSections([screen]);
    const elements = sections.flatMap((x) => x.copies.map((c) => c.element));
    expect(elements).toEqual(["header", "a", "b", "c"]);
  });
});

describe("pageSections", () => {
  const ps = pageScreens(caps());
  const sections = pageSections(ps.screens);

  it("finds the stacked blocks in order and matches them across widths", () => {
    expect(sections.map((s) => s.kind)).toEqual([
      "header",
      "hero",
      "section",
      "section",
      "section",
      "footer",
    ]);
    expect(sections[2].label).toBe("Featured products");
    for (const s of sections) expect(s.copies.map((c) => c.width)).toEqual([390, 768, 1440]);
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
  });

  it("tags sections and truncates later ones (page-level layers of a dropped band go too)", () => {
    const tagged = tagSections(ps.screens, sections);
    const ids = new Set<string>();
    walk(tagged[0].root, (e) => {
      if (typeof e.meta?.section === "string") ids.add(e.meta.section);
    });
    expect(ids.size).toBe(sections.length);
    const two = screensUpTo(tagged, sections, 2);
    const left = new Set<string>();
    walk(two[0].root, (e) => {
      if (typeof e.meta?.section === "string") left.add(e.meta.section);
      if (typeof e.meta?.sectionOf === "string") left.add(`of:${e.meta.sectionOf}`);
    });
    // only the first two sections (and layers placed over them) are left
    expect([...left].map((x) => x.replace(/^of:/, "")).every((x) => x === "header" || x === "hero")).toBe(
      true,
    );
    expect(left.has("header") && left.has("hero")).toBe(true);
  });
});
