// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneElement, SceneLayout } from "@harness/protocol";
import { clippedOut, fitZoom, fluidLayout, fluidStyle, NO_BOX } from "@harness/scene";
import { dslScreenToIr } from "@harness/codegen";
import { findIr } from "@harness/codegen";

const abs = (
  x: number,
  y: number,
  w: number | undefined,
  h: number | undefined,
  constraints?: SceneLayout["constraints"],
): SceneLayout => ({ position: "absolute", x, y, width: w, height: h, constraints });
const el = (layout: SceneLayout, extra: Partial<SceneElement> = {}): SceneElement => ({
  id: "x",
  type: "frame",
  layout,
  ...extra,
});

describe("dsl/fluid constraints (renderer + export)", () => {
  it("resolves every horizontal constraint to the design px at the design width", () => {
    expect(fluidStyle(el(abs(10, 0, 100, 20, { horizontal: "left-right", vertical: "top" })), 400)).toEqual({
      left: "10px",
      right: "290px",
      width: "auto",
    });
    expect(fluidStyle(el(abs(276, 0, 100, 20, { horizontal: "right", vertical: "top" })), 400)).toEqual({
      left: "auto",
      right: "24px",
    });
    expect(fluidStyle(el(abs(150, 0, 100, 20, { horizontal: "center", vertical: "top" })), 400)).toEqual({
      left: "calc(50% - 50px)",
    });
    expect(fluidStyle(el(abs(100, 0, 200, 20, { horizontal: "scale", vertical: "top" })), 400)).toEqual({
      left: "25%",
      width: "50%",
    });
    // left / no constraints / flow children / unknown parent width: nothing
    expect(fluidStyle(el(abs(10, 0, 100, 20, { horizontal: "left", vertical: "top" })), 400)).toEqual({});
    expect(fluidStyle(el(abs(10, 0, 100, 20)), 400)).toEqual({});
    expect(
      fluidStyle(el({ width: 100, constraints: { horizontal: "right", vertical: "top" } }), 400),
    ).toEqual({});
    expect(fluidStyle(el(abs(10, 0, 100, 20, { horizontal: "right", vertical: "top" })), null)).toEqual({});
  });

  it("keeps hug-sized layers (text) pinned by their near edge; stretching needs a size", () => {
    expect(
      fluidStyle(el(abs(211.55, 0, undefined, undefined, { horizontal: "right", vertical: "top" })), 374),
    ).toEqual({ left: "calc(100% - 162.45px)" });
    expect(
      fluidStyle(el(abs(144, 0, undefined, undefined, { horizontal: "center", vertical: "top" })), 374),
    ).toEqual({ left: "calc(50% - 43px)" });
    expect(
      fluidStyle(el(abs(10, 0, undefined, undefined, { horizontal: "left-right", vertical: "top" })), 374),
    ).toEqual({});
  });

  it("maps vertical constraints against the parent height when it is known", () => {
    const v = (vertical: NonNullable<SceneLayout["constraints"]>["vertical"], h?: number) =>
      fluidStyle(el(abs(0, 500, 10, h, { horizontal: "left", vertical })), 400, 600);
    expect(v("bottom", 60)).toEqual({ top: "auto", bottom: "40px" });
    expect(v("top-bottom", 60)).toEqual({ top: "500px", bottom: "40px", height: "auto" });
    expect(v("center", 60)).toEqual({ top: "calc(50% + 200px)" });
    expect(v("scale", 60)).toEqual({ top: `${(500 / 600) * 100}%`, height: "10%" });
    expect(v("bottom")).toEqual({ top: "calc(100% - 100px)" });
    expect(
      fluidStyle(el(abs(0, 500, 10, 60, { horizontal: "left", vertical: "bottom" })), 400, null),
    ).toEqual({});
  });

  it("stretches layers overhanging a full-bleed band with it (both edges, insets kept)", () => {
    const W = 390;
    const stage: SceneElement = {
      id: "stage",
      type: "frame",
      layout: { width: W, height: 200, direction: "row" },
      style: { background: "#000" },
      children: [
        { id: "grad", type: "frame", layout: abs(-24, 0, 438, 200) },
        { id: "inset", type: "frame", layout: abs(10, 0, 300, 200) },
      ],
    };
    const root: SceneElement = {
      id: "r",
      type: "frame",
      layout: { width: W, height: 400 },
      children: [
        {
          id: "main",
          type: "frame",
          layout: {
            ...abs(16, 0, 358, 400, { horizontal: "left-right", vertical: "top" }),
            direction: "column",
            align: "center",
          },
          children: [stage],
        },
      ],
    };
    const ir = dslScreenToIr({
      version: 1,
      id: "s",
      name: "s",
      platform: "web",
      width: W,
      height: 400,
      root,
    }).root;
    expect(findIr(ir, "stage")!.style.width).toBe("max(390px, 100vw)");
    expect(findIr(ir, "grad")!.style).toMatchObject({ left: "-24px", right: "-24px", width: "auto" });
    expect(findIr(ir, "inset")!.style.width).toBe("300px");
  });

  it("boxes: root = the page, clip height for dropping layers outside it, viewport unit per host", () => {
    const page = { width: 390, height: 600, vw: "100cqw" };
    const root = fluidLayout(el({ width: 390, height: 600, clip: true }), "column", NO_BOX, page, true);
    expect(root.style).toEqual({});
    expect(root.box).toMatchObject({ pad: 390, content: 390, padH: 600, fluid: true, vc: true, clipH: 600 });
    expect(clippedOut(el(abs(0, 600, 390, 300)), root.box)).toBe(true);
    expect(clippedOut(el(abs(0, -300, 390, 300)), root.box)).toBe(true);
    expect(clippedOut(el(abs(0, 599, 390, 300)), root.box)).toBe(false);
    expect(clippedOut(el(abs(0, 600, 390, 300)), NO_BOX)).toBe(false);
    expect(fitZoom(page)).toBe("min(1, calc(100cqw / 390px))");
    expect(fitZoom({ width: 1280 })).toBe("min(1, calc(100vw / 1280px))");
  });
});
