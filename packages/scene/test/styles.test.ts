// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneElement } from "@harness/protocol";
import { DEFAULT_TOKENS } from "@harness/protocol";
import {
  elementStyle,
  figMatrixCss,
  layoutStyle,
  maskGroups,
  maskStyleFor,
  maskTargets,
  shadowStyle,
  staticMaskStyle,
  type StyleCtx,
} from "@harness/scene";
import { fallbackStackFor } from "@harness/scene";

const ctx: StyleCtx = { tokens: DEFAULT_TOKENS, platform: "web", parentDir: "column", interactive: false };
const abs = (
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<NonNullable<SceneElement["layout"]>> = {},
) => ({ position: "absolute" as const, x, y, width: w, height: h, ...extra });
const svgOf = (url: unknown) =>
  decodeURIComponent(
    String(url)
      .replace(/^url\("data:image\/svg\+xml,/, "")
      .replace(/"\)$/, ""),
  );

// the "Works" card of the Instrument template: a rounded mask rect, then photos placed partly outside it
const mask: SceneElement = {
  id: "m",
  type: "frame",
  mask: true,
  layout: abs(0, 0, 708, 708),
  style: { background: "#1b30ae", radius: 32 },
};
const photo: SceneElement = {
  id: "p",
  type: "image",
  image: { src: "data:image/png;base64,AAAA" },
  layout: abs(-195, -193, 500, 500),
  style: { background: "transparent" },
};

describe("masks", () => {
  it("clips every following sibling up to the next mask; a hidden mask clips nothing", () => {
    const a: SceneElement = { id: "a", type: "frame" };
    const m2: SceneElement = { id: "m2", type: "frame", mask: true, layout: abs(0, 0, 10, 10) };
    const b: SceneElement = { id: "b", type: "frame" };
    const hidden: SceneElement = { id: "h", type: "frame", mask: true, meta: { hidden: true } };
    const c: SceneElement = { id: "c", type: "frame" };
    const t = maskTargets([a, mask, photo, m2, b, hidden, c]);
    expect([...t.entries()].map(([k, v]) => [k, v.id])).toEqual([
      ["p", "m"],
      ["b", "m2"],
    ]);
  });

  it("positions the mask shape in the sibling’s own coordinates (no double offset) with the corner radius", () => {
    const st = staticMaskStyle(mask, photo)!;
    // the mask box (0,0) seen from the photo's border box at (-195,-193)
    expect(st.maskPosition).toBe("195px 193px");
    expect(st.maskSize).toBe("708px 708px");
    expect(st.maskClip).toBe("no-clip");
    const svg = svgOf(st.maskImage);
    expect(svg).toContain('width="708" height="708"');
    expect(svg).toMatch(/<path d="M0 32 C/); // rounded top-left corner
    // stable object for memoised elements
    expect(staticMaskStyle(mask, photo)).toBe(st);
  });

  it("needs no size for unrotated hug siblings, but measures when the mask is in flow", () => {
    const text: SceneElement = {
      id: "t",
      type: "text",
      text: "x",
      layout: { position: "absolute", x: 10, y: 20, width: "hug", height: "hug" },
    };
    expect(staticMaskStyle(mask, text)?.maskPosition).toBe("-10px -20px");
    const flowMask: SceneElement = { ...mask, id: "fm", layout: { width: 100, height: 100 } };
    expect(staticMaskStyle(flowMask, photo)).toBeNull();
  });

  it("maps rotated masks and rotated siblings into the sibling’s local space", () => {
    const rotMask: SceneElement = {
      id: "rm",
      type: "frame",
      mask: true,
      layout: abs(0, 0, 100, 100, { rotation: 45 }),
    };
    const st = maskStyleFor(rotMask, { x: 0, y: 0, w: 100, h: 100 }, photo, { x: 0, y: 0, w: 0, h: 0 });
    const s2 = Math.SQRT2 * 100;
    expect(st.maskSize).toBe(`${Math.round(s2 * 100) / 100}px ${Math.round(s2 * 100) / 100}px`);
    // a sibling rotated by the same angle sees an axis-aligned mask
    const rotPhoto: SceneElement = { ...photo, layout: abs(0, 0, 100, 100, { rotation: 45 }) };
    const local = maskStyleFor(rotMask, { x: 0, y: 0, w: 100, h: 100 }, rotPhoto, {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
    expect(local.maskPosition).toBe("0px 0px");
    expect(local.maskSize).toBe("100px 100px");
  });

  it("ellipse masks clip to the ellipse; image masks use the image alpha fitted like the image", () => {
    const ellipse: SceneElement = {
      id: "e",
      type: "frame",
      mask: true,
      layout: abs(0, 0, 200, 100),
      style: { radius: 9999 },
    };
    expect(svgOf(staticMaskStyle(ellipse, photo)!.maskImage)).toContain("C");
    const imgMask: SceneElement = {
      id: "im",
      type: "image",
      mask: true,
      image: { src: "data:image/png;base64,QUJD" },
      layout: abs(10, 10, 50, 40, { rotation: 30 }),
      style: { radius: 8 },
    };
    const svg = svgOf(staticMaskStyle(imgMask, photo)!.maskImage);
    expect(svg).toContain('<image href="data:image/png;base64,QUJD"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain('clip-path="url(#c)"');
    expect(svg).toMatch(/<g transform="matrix\(0\.86603 0\.5 -0\.5 0\.86603 /);
  });

  it("mask layers are not painted", () => {
    expect(elementStyle(mask, ctx).opacity).toBe(0);
  });

  it("exporter groups end at the next mask", () => {
    const m2: SceneElement = { id: "m2", type: "frame", mask: true, layout: abs(0, 0, 10, 10) };
    const b: SceneElement = { id: "b", type: "frame", layout: abs(1, 1, 2, 2) };
    const items = maskGroups([mask, photo, m2, b]);
    expect(
      items.map((i) =>
        i.kind === "el" ? i.el.id : `[${i.mask.id}:${i.children.map((c) => c.id).join(",")}]`,
      ),
    ).toEqual(["m", "[m:p]", "m2", "[m2:b]"]);
    const g = items[1] as Extract<(typeof items)[number], { kind: "mask" }>;
    expect(g.style.maskPosition).toBe("0px 0px");
  });
});

describe("imported paint details", () => {
  it("casts shadows of transparent images / vectors with drop-shadow, exact from meta.figEffects", () => {
    const effects = JSON.stringify([
      {
        type: "DROP_SHADOW",
        visible: true,
        color: { r: 0, g: 0, b: 0, a: 0.25 },
        offset: { x: 0, y: 4 },
        radius: 4,
        spread: 0,
      },
    ]);
    const globe: SceneElement = {
      ...photo,
      style: { background: "transparent", shadow: "sm" },
      meta: { figEffects: effects },
    };
    const st = elementStyle(globe, ctx);
    expect(st.boxShadow).toBeUndefined();
    expect(st.filter).toBe("drop-shadow(0px 4px 4px rgba(0, 0, 0, 0.25))");
    // an edited preset no longer matches the imported effect → preset values
    expect(shadowStyle({ ...globe, style: { shadow: "lg" } }, "lg", false).filter).toContain(
      "drop-shadow(0 16px",
    );
    // filled boxes keep box-shadow (follows the radius)
    const card: SceneElement = {
      id: "c",
      type: "frame",
      style: { background: "#fff", shadow: "sm" },
      meta: { figEffects: effects },
    };
    expect(elementStyle(card, ctx).boxShadow).toBe("0px 4px 4px 0px rgba(0, 0, 0, 0.25)");
    expect(elementStyle({ id: "k", type: "card", style: { shadow: "md" } }, ctx).boxShadow).toBe(
      "var(--t-shadow-md)",
    );
  });

  it("draws skew matrices around the centre until the layer is re-rotated", () => {
    const el: SceneElement = {
      id: "s",
      type: "frame",
      layout: abs(0, 0, 10, 10, { rotation: 15 }),
      meta: { figMatrix: "0.96593,0.25882,-0.1,1" },
    };
    expect(figMatrixCss(el)).toBeUndefined(); // closest rotation of this matrix is not 15°
    const a = 0.96593,
      b = 0.25882,
      c = -0.3,
      d = 1;
    const rot = Math.round(((Math.atan2(b - c, a + d) * 180) / Math.PI) * 1000) / 1000;
    const ok: SceneElement = {
      ...el,
      layout: abs(0, 0, 10, 10, { rotation: rot }),
      meta: { figMatrix: [a, b, c, d].join(",") },
    };
    expect(elementStyle(ok, ctx).transform).toBe("matrix(0.96593, 0.25882, -0.3, 1, 0, 0)");
    expect(elementStyle({ ...ok, layout: abs(0, 0, 10, 10, { rotation: rot + 20 }) }, ctx).transform).toMatch(
      /^rotate\(/,
    );
  });

  it("blend modes, italic, justify, vertical alignment and the cap-height trim", () => {
    const photoLum: SceneElement = { ...photo, meta: { figBlendMode: "LUMINOSITY" } };
    expect(elementStyle(photoLum, ctx)).toMatchObject({ mixBlendMode: "luminosity", filter: "grayscale(1)" });
    const text: SceneElement = {
      id: "t",
      type: "text",
      text: "x",
      layout: { width: 100, height: 80 },
      style: { fontSize: 20, lineHeight: 1.2 },
      meta: {
        figItalic: true,
        figTextAlign: "justify",
        figAlignV: "BOTTOM",
        figLeadingTrim: "CAP_HEIGHT",
        figCapHeight: 0.72,
      },
    };
    const st = elementStyle(text, ctx) as Record<string, unknown>;
    expect(st).toMatchObject({
      fontStyle: "italic",
      textAlign: "justify",
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
    });
    // top + bottom trim = line height − cap height
    expect(-parseFloat(String(st["--trim-top"])) - parseFloat(String(st["--trim-bottom"]))).toBeCloseTo(
      1.2 - 0.72,
      1,
    );
  });

  it("wrapped auto layout packs its rows and keeps the counter-axis gap", () => {
    const wrap: SceneElement = {
      id: "w",
      type: "frame",
      layout: { direction: "row", wrap: true, gap: 8, align: "start" },
      meta: { figCounterGap: 24 },
    };
    expect(layoutStyle(wrap, ctx)).toMatchObject({
      flexWrap: "wrap",
      alignContent: "flex-start",
      gap: 8,
      rowGap: 24,
    });
  });

  it('maps unknown "… Serif" families to a serif stack', () => {
    expect(fallbackStackFor("Instrument Serif")).toMatch(/serif$/);
    expect(fallbackStackFor("Instrument Serif")).not.toMatch(/sans-serif$/);
    expect(fallbackStackFor("Instrument Sans")).toMatch(/sans-serif$/);
    expect(fallbackStackFor("IBM Plex Sans")).toMatch(/sans-serif$/);
  });
});

describe("padding", () => {
  it("clamps negative sides instead of losing the whole declaration (CSS rejects any negative padding)", () => {
    const frame = (padding: NonNullable<SceneElement["layout"]>["padding"]): SceneElement => ({
      id: "f",
      type: "frame",
      layout: { direction: "column", padding },
    });
    expect(layoutStyle(frame([-0.5, 0, 0, 1]), ctx).padding).toBe("0px 0px 0px 1px");
    expect(layoutStyle(frame(-2), ctx).padding).toBe("0px");
    expect(layoutStyle(frame([12, 24]), ctx).padding).toBe("12px 24px");
    expect(
      elementStyle({ id: "t", type: "text", text: "a", layout: { padding: [-1, 4, 2, 4] } }, ctx).padding,
    ).toBe("0px 4px 2px 4px");
    // margins may be negative
    expect(elementStyle({ id: "m", type: "frame", layout: { margin: [-4, 0, 0, 0] } }, ctx).margin).toBe(
      "-4px 0px 0px 0px",
    );
  });
});
