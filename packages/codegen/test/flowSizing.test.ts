// Export of what the URL converter reads off the page beyond fixed geometry: boxes sized by the viewport's height,
// and a text with small boxes on its last line laid out as inline content.
import { describe, expect, it } from "vitest";
import type { SceneElement, SceneScreen } from "@harness/protocol";
import { dslScreenToIr, findIr, type IrElement } from "@harness/codegen";

const screen = (children: SceneElement[]): SceneScreen => ({
  version: 1,
  id: "s",
  name: "Home · 390",
  platform: "web",
  width: 390,
  height: 1200,
  root: {
    id: "root",
    type: "frame",
    name: "Page",
    layout: { width: 390, height: 1200, direction: "column" },
    children,
  },
});
const ir = (children: SceneElement[], id: string) =>
  findIr(dslScreenToIr(screen(children)).root, id) as IrElement;

describe("a box as tall as the viewport (meta.vhShare / vhPx)", () => {
  it("is as tall as the viewport, or a share of it plus a length, whatever it measured", () => {
    const stage: SceneElement = {
      id: "stage",
      type: "frame",
      name: "Stage",
      layout: { width: "fill", height: 844 },
      meta: { vhShare: 1, vhPx: 0 },
    };
    expect(ir([stage], "stage").style.height).toBe("100vh");
    const part: SceneElement = { ...stage, id: "part", meta: { vhShare: 0.5, vhPx: -12 } };
    expect(ir([part], "part").style.height).toBe("calc(50vh - 12px)");
  });

  it("keeps it as the minimum of a box that grows with its content", () => {
    const hero: SceneElement = {
      id: "hero",
      type: "frame",
      name: "Hero",
      layout: { width: "fill", height: "hug", direction: "column" },
      meta: { vhShare: 1, vhPx: 0 },
      children: [{ id: "t", type: "text", name: "T", text: "Hello" }],
    };
    const st = ir([hero], "hero").style;
    expect(st["min-height"]).toBe("100vh");
    expect(st.height).not.toBe("100vh");
    // one its content overflows on the page (a stage clipping its video) has its height set, hugging or not
    const stage = ir(
      [{ ...hero, id: "stage2", meta: { vhShare: 1, vhPx: 0, vhFixed: true } }],
      "stage2",
    ).style;
    expect(stage.height).toBe("100vh");
  });
});

describe("a text with small boxes on its last line (meta.inline)", () => {
  const block: SceneElement = {
    id: "note",
    type: "frame",
    name: "Note",
    layout: {
      width: "fill",
      height: "hug",
      direction: "column",
      gap: 0,
      padding: [0, 0, 0, 0],
      align: "stretch",
    },
    meta: { inline: true },
    children: [
      {
        id: "t",
        type: "text",
        name: "Text",
        text: "Energy use combined: 19–15.7 kWh/100 km (WLTP)",
        style: { fontSize: 12, lineHeight: 18 },
        layout: { width: "fill" },
      },
      {
        id: "i",
        type: "frame",
        name: "Info",
        layout: { width: 24, height: 24, margin: [0, 0, 0, 3] },
      },
    ],
  };

  it("lays them out in the block's lines: the text inline, the boxes inline-flex after it", () => {
    const b = ir([block], "note");
    expect(b.style.display).toBe("block");
    expect(b.style["flex-direction"]).toBeUndefined();
    const t = findIr(b, "t") as IrElement;
    expect(t.style.display).toBe("inline");
    expect(t.style.width).toBeUndefined();
    const i = findIr(b, "i") as IrElement;
    expect(i.style.display).toBe("inline-flex");
    expect(i.style.width).toBe("24px");
    expect(i.style.position).toBe("relative");
    expect(i.style.left ?? i.style.top).toBeUndefined();
  });

  it("gives the block the text's line height, so its lines are as tall as the text's", () => {
    const b = ir([block], "note");
    const t = findIr(b, "t") as IrElement;
    expect(b.style["line-height"]).toBe(t.style["line-height"]);
    expect(b.style["font-size"]).toBe(t.style["font-size"]);
  });
});

describe("a pinned layer inside a wrapper of the page (an imported page's masthead in its container)", () => {
  it("is kept at the top while the page scrolls, as one directly under the page root is", async () => {
    const { buildHtmlFiles, el } = await import("@harness/codegen");
    const mast = el("header", {
      id: "mast",
      name: "Masthead",
      attrs: { class: "masthead" },
      style: {
        position: "absolute",
        left: "0px",
        top: "0px",
        right: "0px",
        height: "49px",
        "z-index": "900",
      },
    });
    const wrap = el("div", {
      attrs: { class: "masthead-container" },
      style: { position: "relative" },
      children: [mast],
    });
    const root = el("div", {
      attrs: { class: "page" },
      style: { position: "relative", height: "2000px" },
      children: [wrap],
    });
    const main = el("main", { attrs: { class: "home" }, children: [root] });
    const files = buildHtmlFiles(
      [
        {
          nodeId: "s",
          name: "Home",
          width: 720,
          height: 2000,
          ir: main,
          vars: {},
          credits: [],
          platform: "web",
          pinned: { mast: { behavior: "fixed", y: 0, h: 49 } },
        },
      ],
      { vars: {} } as never,
    );
    const css = String(files["styles.css"]);
    // (classes are the bundle's own: the masthead's rule is the one with its height)
    expect(css).toMatch(/\{\s*position: fixed;[^}]*height: 49px;/);
  });
});

describe("CSS columns (meta.columnWidth / columnCount / columnGap)", () => {
  it("writes the page's columns and keeps each child whole in its column", () => {
    const list: SceneElement = {
      id: "list",
      type: "frame",
      name: "Links",
      layout: { width: "fill", height: "hug", direction: "column", gap: 0, align: "stretch" },
      meta: { columnWidth: 230, columnCount: 4, columnGap: 20 },
      children: [
        { id: "a", type: "frame", name: "A", layout: { width: "fill", height: 226, margin: [0, 0, 38, 0] } },
        { id: "b", type: "frame", name: "B", layout: { width: "fill", height: 154 } },
      ],
    };
    const b = ir([list], "list");
    expect(b.style.display).toBe("block");
    expect(b.style.columns).toBe("230px 4");
    expect(b.style["column-gap"]).toBe("20px");
    expect(b.style["flex-direction"]).toBeUndefined();
    const a = findIr(b, "a") as IrElement;
    expect(a.style["break-inside"]).toBe("avoid");
    expect(a.style.width).toBe("100%");
    expect(a.style.display).toMatch(/^inline-/);
  });
});

describe("wider than ever measured", () => {
  it("keeps a page no other width measured at its layout, centred (only measured variants follow the page on)", async () => {
    const { buildHtmlFiles, el } = await import("@harness/codegen");
    const main = el("main", {
      attrs: { class: "home" },
      children: [el("div", { style: { height: "900px" } })],
    });
    const css = String(
      buildHtmlFiles(
        [
          {
            nodeId: "s",
            name: "Home",
            width: 720,
            height: 900,
            ir: main,
            vars: {},
            credits: [],
            platform: "web",
          },
        ],
        { vars: {} } as never,
      )["styles.css"],
    );
    expect(css).toMatch(/@media \(min-width: 721px\) \{[^}]*> main \{ max-width: 720px; margin-left: auto/);
  });
});
