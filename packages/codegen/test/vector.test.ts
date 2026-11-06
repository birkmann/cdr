// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import { DEFAULT_TOKENS, type SceneElement, type SceneScreen } from "@harness/protocol";
import { tokenVars } from "@harness/codegen";
import { createNamer } from "@harness/scene";
import { dslScreenToIr, vectorSvgOf } from "@harness/codegen";
import { emitHtml } from "@harness/codegen";
import { emitJsx } from "@harness/codegen";
import { findIr, walkIr, type IrElement } from "@harness/codegen";

const vector = (id: string, extra: Partial<SceneElement> = {}): SceneElement => ({
  id,
  type: "vector",
  name: "Arrow",
  layout: { position: "absolute", x: 10, y: 20, width: 100, height: 50, rotation: 30 },
  vector: { path: "M0 25 L100 25", stroke: "$primary", strokeWidth: 3, strokeCap: "round", fill: null },
  ...extra,
});

const screen = (children: SceneElement[]): SceneScreen => ({
  version: 1,
  id: "s",
  name: "Vectors",
  platform: "app",
  width: 320,
  height: 240,
  root: { id: "root", type: "frame", layout: { width: "fill", height: "fill" }, children },
});

describe("vector export", () => {
  it("emits vectors as inline SVG paths with rotation on the box", () => {
    const { root } = dslScreenToIr(screen([vector("v")]));
    const box = findIr(root, "v")!;
    expect(box.style.transform).toBe("rotate(30deg)");
    const paths: IrElement[] = [];
    walkIr(box, (n) => {
      if (n.tag === "path") paths.push(n);
    });
    const path = paths[0];
    expect(path).toBeDefined();
    expect(path!.attrs.d).toBe("M0 25 L100 25");
    expect(path!.style).toMatchObject({
      fill: "none",
      stroke: "var(--t-primary)",
      "stroke-width": "3px",
      "stroke-linecap": "round",
    });

    const html = emitHtml(root, {
      semantic: true,
      cssVars: true,
      vars: tokenVars(DEFAULT_TOKENS),
      namer: createNamer(),
    });
    expect(html.html).toMatch(
      /<svg class="[^"]+" xmlns="http:\/\/www.w3.org\/2000\/svg" aria-hidden="true">/,
    );
    expect(html.html).toContain('d="M0 25 L100 25"');
    expect(html.rules.join("\n")).toContain("transform: rotate(30deg)");
    const jsx = emitJsx(root, {
      cssVars: true,
      vars: tokenVars(DEFAULT_TOKENS),
      colorNames: new Set(["primary"]),
    });
    expect(jsx).toMatch(/<path className="[^"]*stroke-primary[^"]*" d="M0 25 L100 25" \/>/);
  });

  it("masks the siblings after a mask element like the renderer (per sibling, no wrapper)", () => {
    const mask: SceneElement = {
      id: "m",
      type: "vector",
      name: "Shape",
      mask: true,
      layout: { position: "absolute", x: 0, y: 0, width: 40, height: 40 },
      vector: { path: "M0 0 L40 0 L40 40 Z", fill: "#000" },
    };
    const photo: SceneElement = {
      id: "p",
      type: "frame",
      name: "Photo",
      layout: { position: "absolute", x: 0, y: 0, width: 80, height: 80 },
      style: { background: "#f00" },
    };
    const { root } = dslScreenToIr(screen([mask, photo]));
    const groups: IrElement[] = [];
    walkIr(root, (n) => {
      if (n.attrs["data-mask"]) groups.push(n);
    });
    expect(groups).toHaveLength(0);
    const p = findIr(root, "p")!;
    expect(p.style["mask-image"]).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(p.style["mask-size"]).toBe("40px 40px");
    // the mask layer itself is not painted
    expect(findIr(root, "m")!.style.opacity).toBe("0");
  });

  it("exports real SVG for vectors and frames of vectors, not for components", () => {
    const frame: SceneElement = {
      id: "f",
      type: "frame",
      name: "Icon",
      layout: { position: "absolute", x: 0, y: 0, width: 120, height: 80 },
      children: [vector("v2", { layout: { position: "absolute", x: 10, y: 10, width: 100, height: 50 } })],
    };
    const btn: SceneElement = { id: "b", type: "button", text: "Go" };
    const s = screen([vector("v"), frame, btn]);
    const svg = vectorSvgOf(s, "v", DEFAULT_TOKENS)!;
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain(`stroke="${DEFAULT_TOKENS.primary}"`);
    expect(svg).toContain('stroke-linecap="round"');
    expect(vectorSvgOf(s, "f", DEFAULT_TOKENS)).toContain('<g transform="matrix(1 0 0 1 10 10)">');
    expect(vectorSvgOf(s, "b", DEFAULT_TOKENS)).toBeNull();
  });
});

describe("inline SVG ids in an export", () => {
  it("each emitted SVG gets its own ids (a gradient in a hidden variant must not be the one url(#g1) finds)", async () => {
    const { ownIds } = await import("@harness/codegen");
    const svg =
      '<svg><defs><linearGradient id="g1"><stop offset="0"/></linearGradient></defs><path fill="url(#g1)"/><use href="#g1"/></svg>';
    const a = ownIds(svg),
      b = ownIds(svg);
    const id = (s: string) => /id="([^"]+)"/.exec(s)![1];
    expect(id(a)).not.toBe(id(b));
    expect(a).toContain(`fill="url(#${id(a)})"`);
    expect(a).toContain(`href="#${id(a)}"`);
    expect(ownIds('<svg><path d="M0 0"/></svg>')).toBe('<svg><path d="M0 0"/></svg>');
  });
});
