// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneScreen } from "@harness/protocol";
import { dslScreenToIr, measuredScreen } from "@harness/codegen";
import { findIr, type IrElement } from "@harness/codegen";

const screen = (): SceneScreen => ({
  version: 1,
  id: "s",
  name: "Home · 1440",
  platform: "web",
  width: 1440,
  height: 900,
  responsive: { group: "home", minWidth: 1200, measured: [1920] },
  root: {
    id: "root",
    type: "frame",
    name: "Page",
    layout: { width: 1440, height: 900, fluid: [{ at: 1920, width: 1920, height: 880 }] },
    children: [
      {
        id: "col",
        type: "frame",
        name: "Column",
        layout: {
          position: "absolute",
          x: 75,
          y: 0,
          width: 1290,
          height: 400,
          fluid: [{ at: 1920, x: 315 }],
        },
      },
      {
        id: "h",
        type: "text",
        name: "Heading",
        text: "Hallo",
        style: { fontSize: 28 },
        layout: { fluid: [{ at: 1920, fontSize: 32 }] },
      },
      { id: "w", type: "text", name: "Line", text: "Wilhelminen-", meta: { line: true, softHyphen: true } },
    ],
  },
});

describe("a screen measured at another width (URL capture)", () => {
  it("takes every layer’s geometry measured there, nothing else", () => {
    const m = measuredScreen(screen(), 1920);
    expect([m.width, m.height]).toEqual([1920, 880]);
    const col = m.root.children![0]!;
    expect(col.layout).toMatchObject({ x: 315, width: 1290 });
    expect(col.layout?.fluid).toBeUndefined();
    expect(m.root.children![1]!.style?.fontSize).toBe(32);
    // other widths: the screen's own values
    expect(measuredScreen(screen(), 1680).root.children![0]!.layout).toMatchObject({ x: 75 });
  });
});

describe("a layer the alt walk did not pair", () => {
  // ibmix.de's hero: a stretched absolute band inside fill-width sections whose page was paired, the band itself not
  const hero = (): SceneScreen => ({
    version: 1,
    id: "s",
    name: "Home · 1440",
    platform: "web",
    width: 1440,
    height: 900,
    responsive: { group: "home", minWidth: 1024, measured: [1312, 1920] },
    root: {
      id: "root",
      type: "frame",
      name: "Page",
      layout: {
        width: 1440,
        height: 900,
        direction: "column",
        fluid: [
          { at: 1312, width: 1312, height: 900 },
          { at: 1920, width: 1920, height: 900 },
        ],
      },
      children: [
        {
          id: "section",
          type: "frame",
          name: "Section",
          layout: { width: "fill", height: 650 },
          children: [
            {
              id: "stage",
              type: "frame",
              name: "Stage inner",
              layout: {
                position: "absolute",
                x: 0,
                y: 0,
                width: 1440,
                height: 504,
                constraints: { horizontal: "left-right", vertical: "top" },
              },
            },
            {
              id: "pin",
              type: "frame",
              name: "Pause",
              layout: {
                position: "absolute",
                x: 1400,
                y: 600,
                width: 24,
                height: 24,
                constraints: { horizontal: "right", vertical: "top" },
              },
            },
          ],
        },
      ],
    },
  });

  it("follows its parent by its constraints: a stretched band keeps its insets, a right-pinned box its right inset", () => {
    const m = measuredScreen(hero(), 1920);
    const [stage, pin] = m.root.children![0]!.children!;
    expect(stage!.layout).toMatchObject({ x: 0, width: 1920 });
    expect(pin!.layout).toMatchObject({ x: 1880, width: 24 });
  });
});

describe("soft hyphen breaks", () => {
  it("draw the hyphen as a pseudo element: the text keeps the soft hyphen the page has", () => {
    const ir = dslScreenToIr(screen()).root;
    const w = findIr(ir, "w") as IrElement;
    expect(w.children).toEqual([{ kind: "text", text: "Wilhelminen\u00ad" }]);
    expect(w.pseudo?.after).toEqual({ content: '"-"' });
  });
});

describe("gradient text", () => {
  it("exports its gradient clipped to the text over a transparent fill", () => {
    const s: SceneScreen = {
      version: 1,
      id: "g",
      name: "G",
      platform: "web",
      width: 800,
      height: 200,
      root: {
        id: "r",
        type: "frame",
        children: [
          {
            id: "t",
            type: "text",
            text: "Watch",
            style: {
              color: "rgba(0, 0, 0, 0)",
              backgroundClip: "text",
              fills: [
                {
                  type: "gradient",
                  kind: "linear",
                  angle: 90,
                  stops: [
                    { color: "rgb(15, 98, 254)", pos: 0 },
                    { color: "rgb(165, 110, 255)", pos: 1 },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const t = findIr(dslScreenToIr(s).root, "t") as IrElement;
    expect(t.style["background-clip"] ?? t.style["-webkit-background-clip"]).toBe("text");
    expect(t.style.color).toBe("transparent");
    expect(t.style.background ?? t.style["background-image"]).toMatch(/linear-gradient/);
  });
});
