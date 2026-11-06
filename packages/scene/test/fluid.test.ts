// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import { snapshotToScreen } from "@harness/scene";
import { altKeep, altSnapshots, baseIds, geometryDiff, measureAlts, sessionSnapshot } from "@harness/scene";
import type { SnapElement, SnapNode, Snapshot } from "@harness/capture";
import type { SceneElement } from "@harness/protocol";

const el = (
  id: number,
  tag: string,
  rect: [number, number, number, number],
  o: Partial<SnapElement> = {},
  children: SnapNode[] = [],
): SnapElement => ({
  id,
  tag,
  rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] },
  layout: { display: "block", position: "static" },
  style: {},
  children,
  ...o,
});
const label = (id: number, t: string, x: number, y: number, size = 16): SnapNode => ({
  id,
  kind: "text",
  text: t,
  lines: [{ text: t, x, y, w: t.length * 9, h: 20 }],
  parent: 0,
  font: {
    family: "Arial",
    stack: "Arial",
    size,
    weight: 400,
    lineHeight: 20,
    letterSpacing: 0,
    color: "rgb(0, 0, 0)",
    align: "start",
    whiteSpace: "normal",
  },
});

/**
 * The page at viewport `w`: a full-bleed band, a 600 px column centred in it (max-width + margin auto), a heading in
 * the column. `base`: ids as an alt walk names them (its own ids differ, `base` = the main walk's).
 */
function page(w: number, alt = false): Snapshot {
  const off = alt ? 100 : 0;
  const id = (n: number) => n + off;
  const b = <T extends SnapNode>(n: T, main: number): T => (alt ? { ...n, base: main } : n);
  const x = (w - 600) / 2;
  const heading = b(
    el(id(4), "h1", [x, 140, 600, 40], {}, [b(label(id(5), "Hello", x, 150, w > 900 ? 32 : 28), 5)]),
    4,
  );
  const column = b(
    el(id(3), "div", [x, 100, 600, 200], { style: { bg: "rgb(240, 240, 240)" } }, [heading]),
    3,
  );
  const band = b(el(id(2), "section", [0, 80, w, 300], { style: { bg: "rgb(255, 220, 0)" } }, [column]), 2);
  return {
    version: 1,
    url: "https://www.example.com/",
    title: "Example",
    viewport: { width: w, height: 900 },
    page: { width: w, height: 1200, background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", font: "Arial" },
    root: b(el(id(1), "body", [0, 0, w, 1200], {}, [band]), 1),
    fonts: [],
    fontFaces: [],
    sheets: [],
    nodes: 5,
  };
}
const all = (e: SceneElement): SceneElement[] => [e, ...(e.children ?? []).flatMap(all)];

describe("a capture measured at other widths of its layout range", () => {
  it("maps the alt walk to the main walk through `base`", () => {
    expect([...baseIds(page(1000, true))]).toEqual([
      [1, 101],
      [2, 102],
      [3, 103],
      [4, 104],
      [5, 105],
    ]);
    expect(altKeep(page(1000, true), [3, 9])).toEqual([103]);
  });

  it("records on each layer what the other width measured differently", () => {
    const main = page(800);
    main.alt = [{ ...page(1000, true), width: 1000 }];
    const res = snapshotToScreen(main);
    const alts = altSnapshots(main).map((a) => ({ ...a, res: snapshotToScreen(a.snap) }));
    expect(alts.map((a) => a.width)).toEqual([1000]);
    expect(measureAlts(res, alts)).toEqual([1000]);
    const root = res.screen.root;
    // the page itself: as wide as the viewport
    expect(root.layout?.fluid).toEqual([{ at: 1000, width: 1000 }]);
    // the band spans the viewport; the column (centred by its band's layout) keeps its width; the heading's type grows
    const layers = all(root);
    expect(layers.find((e) => e.name?.startsWith("Section"))?.layout?.fluid).toEqual([
      { at: 1000, width: 1000 },
    ]);
    expect(layers.find((e) => e.name?.startsWith("Group"))?.layout?.fluid).toBeUndefined();
    expect(layers.find((e) => e.type === "text")?.layout?.fluid).toEqual([{ at: 1000, fontSize: 32 }]);
  });

  it("a box stretched at the capture width but capped and centred at the other one keeps stretching, by margins", () => {
    // a column 16 px from both edges at 800; at 1200 capped at 800 px and centred (200 px either side)
    const at = (w: number, alt = false): Snapshot => {
      const b = <T extends SnapNode>(n: T, main: number): T => (alt ? { ...n, base: main } : n);
      const cw = Math.min(w - 32, 800),
        cx = (w - cw) / 2;
      const col = b(
        el(alt ? 103 : 3, "div", [cx, 100, cw, 200], { style: { bg: "rgb(240, 240, 240)" } }, [
          b(
            el(alt ? 104 : 4, "p", [cx + 10, 110, 200, 20], {}, [
              b(label(alt ? 105 : 5, "Text", cx + 10, 110), 5),
            ]),
            4,
          ),
        ]),
        3,
      );
      const band = b(
        el(alt ? 102 : 2, "section", [0, 80, w, 300], { style: { bg: "rgb(255, 220, 0)" } }, [
          col,
          b(el(alt ? 106 : 6, "div", [cx, 320, cw, 40], { style: { bg: "rgb(0, 0, 0)" } }), 6),
        ]),
        2,
      );
      return {
        version: 1,
        url: "https://www.example.com/",
        title: "E",
        viewport: { width: w, height: 900 },
        page: {
          width: w,
          height: 1200,
          background: "rgb(255, 255, 255)",
          color: "rgb(0, 0, 0)",
          font: "Arial",
        },
        root: b(el(alt ? 101 : 1, "body", [0, 0, w, 1200], {}, [band]), 1),
        fonts: [],
        fontFaces: [],
        sheets: [],
        nodes: 6,
      };
    };
    const main = at(800);
    main.alt = [{ ...at(1200, true), width: 1200 }];
    const res = snapshotToScreen(main);
    measureAlts(
      res,
      altSnapshots(main).map((a) => ({ ...a, res: snapshotToScreen(a.snap) })),
    );
    const stretched = all(res.screen.root).filter(
      (e) => e.layout?.width === "fill" && e.layout?.fluid?.some((f) => f.margin),
    );
    expect(stretched.length).toBeGreaterThan(0);
    for (const e of stretched)
      expect(e.layout!.fluid!.find((f) => f.at === 1200)!.margin).toEqual([
        expect.any(Number),
        200,
        expect.any(Number),
        200,
      ]);
  });

  it("a walked variant opens the menu walked at its own width, else the capture\u2019s menu by the same toggle", () => {
    const main = page(800);
    const menu = (label: string, trigger: number) => ({
      kind: "menu" as const,
      trigger,
      label,
      snapshot: { ...page(800), states: undefined } as never,
    });
    main.states = [menu("Main menu", 3)];
    main.alt = [
      { ...page(1000, true), width: 1000 },
      { ...page(1200, true), width: 1200, menuState: menu("Own menu", 3) },
    ];
    // ids of the walks: main id + 100
    expect(sessionSnapshot(main, 1000, [])!.states!.map((st) => [st.label, st.trigger])).toEqual([
      ["Main menu", 103],
    ]);
    expect(sessionSnapshot(main, 1200, [])!.states!.map((st) => [st.label, st.trigger])).toEqual([
      ["Own menu", 103],
    ]);
    expect(sessionSnapshot(main, 1200, [1000])!.alt!.map((a) => a.width)).toEqual([1000]);
    expect(sessionSnapshot(main, 900, [])).toBeNull();
    expect(sessionSnapshot(main, 800, [1200])!.alt!.map((a) => a.width)).toEqual([1200]);
  });

  it("only compares layers laid out the same way", () => {
    const a: SceneElement = {
      id: "a",
      type: "frame",
      layout: {
        position: "absolute",
        x: 10,
        y: 0,
        width: 100,
        height: 50,
        direction: "row",
        gap: 8,
        padding: [0, 16, 0, 16],
      },
    };
    expect(
      geometryDiff(a, { ...a, layout: { ...a.layout, x: 30, gap: 12, padding: [0, 24, 0, 24] } }, 1200),
    ).toEqual({ at: 1200, x: 30, gap: 12, padding: [0, 24, 0, 24] });
    // a column there: its gap / padding are another layout's
    expect(
      geometryDiff(a, { ...a, layout: { ...a.layout, direction: "column", gap: 12, x: 30 } }, 1200),
    ).toEqual({ at: 1200, x: 30 });
    expect(geometryDiff(a, { ...a, layout: { ...a.layout, position: "auto" } }, 1200)).toBeNull();
    expect(geometryDiff(a, { ...a, type: "text" }, 1200)).toBeNull();
    expect(geometryDiff(a, { ...a, layout: { ...a.layout, x: 10.3 } }, 1200)).toBeNull();
  });
});
