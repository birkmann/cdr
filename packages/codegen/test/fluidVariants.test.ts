// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Fluid variants (docs/responsive.md "Between the breakpoints"): a responsive web page's variants follow the site
// between and around the captured widths, and stay exactly as captured at them.
import { describe, expect, it } from "vitest";
import { el, type IrElement } from "@harness/codegen";
import {
  designBoxes,
  fitMinWidth,
  fluidVariants,
  layerOverlap,
  lerpCss,
  irPaths,
  linear,
  pwlCss,
  fluidValue,
  fluidFit,
  FLUID_TOL,
  reflowIr,
  FLUID_FIT,
  type FluidScreen,
} from "@harness/codegen";
import { buildHtmlFiles, buildReactFiles, type ExportScreen } from "@harness/codegen";

/**
 * Evaluates the CSS lengths the fluid pass writes (`calc` / `min` / `max`, px, vw, %) at a viewport width; `pct` is
 * what 100% resolves to.
 */
function len(expr: string, vw: number, pct = 0): number {
  const src = expr.replace(/\s+/g, " ").trim();
  let i = 0;
  const peek = () => src[i];
  const ws = () => {
    while (src[i] === " ") i++;
  };
  const expr_ = (): number => {
    let v = term();
    for (;;) {
      ws();
      const c = peek();
      if (c !== "+" && c !== "-") return v;
      i++;
      const r = term();
      v = c === "+" ? v + r : v - r;
    }
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      ws();
      const c = peek();
      if (c !== "*" && c !== "/") return v;
      i++;
      const r = factor();
      v = c === "*" ? v * r : v / r;
    }
  };
  const args = (): number[] => {
    const out: number[] = [];
    i++; // (
    for (;;) {
      out.push(expr_());
      ws();
      if (src[i] === ",") {
        i++;
        continue;
      }
      i++;
      return out;
    }
  };
  const factor = (): number => {
    ws();
    for (const fn of ["calc", "min", "max", "clamp"]) {
      if (src.startsWith(fn + "(", i)) {
        i += fn.length;
        const a = args();
        return fn === "calc"
          ? a[0]!
          : fn === "min"
            ? Math.min(...a)
            : fn === "clamp"
              ? Math.min(Math.max(a[0]!, a[1]!), a[2]!)
              : Math.max(...a);
      }
    }
    if (src[i] === "(") {
      i++;
      const v = expr_();
      ws();
      i++;
      return v;
    }
    const m = /^-?\d+(?:\.\d+)?(px|vw|%)?/.exec(src.slice(i));
    if (!m) throw new Error(`cannot read ${src.slice(i)}`);
    i += m[0].length;
    const n = Number.parseFloat(m[0]);
    return m[1] === "vw" ? (n * vw) / 100 : m[1] === "%" ? (n * pct) / 100 : n;
  };
  const v = expr_();
  return v;
}

/** a page: root (W wide) → column `Main` (stretched, side padding `pad`) → a centred `Column` and a row of cards */
function page(
  W: number,
  o: { pad: number; column: number; card: number; cards?: number; heroH: number; textW?: number },
): IrElement {
  const cards = Array.from({ length: o.cards ?? 3 }, (_, n) =>
    el("div", {
      name: `Card ${n}`,
      style: { position: "relative", width: `${o.card}px`, height: "200px", "flex-shrink": "0" },
    }),
  );
  const text = el("p", {
    name: "Lead",
    style: {
      position: "relative",
      width: `${o.textW ?? o.column}px`,
      "white-space": "pre-wrap",
      "overflow-wrap": "anywhere",
    },
    children: [{ kind: "text", text: "Some lead text that wraps" }],
  });
  const column = el("div", {
    name: "Column",
    style: {
      display: "flex",
      "flex-direction": "column",
      position: "relative",
      width: `${o.column}px`,
      height: "120px",
      "align-self": "center",
    },
    children: [text],
  });
  const row = el("div", {
    name: "Cards",
    style: {
      display: "flex",
      "flex-direction": "row",
      gap: "16px",
      position: "relative",
      width: "auto",
      height: "200px",
      "align-self": "stretch",
    },
    children: cards,
  });
  const hero = el("div", {
    name: "Hero",
    style: { position: "relative", width: `${W - 2 * o.pad}px`, height: `${o.heroH}px`, "flex-shrink": "0" },
  });
  const main = el("div", {
    name: "Main",
    style: {
      display: "flex",
      "flex-direction": "column",
      position: "absolute",
      left: "0px",
      top: "0px",
      right: "0px",
      width: "auto",
      height: "1000px",
      padding: `0px ${o.pad}px 0px ${o.pad}px`,
    },
    children: [hero, column, row],
  });
  const root = el("div", {
    name: "Page",
    style: {
      display: "flex",
      "flex-direction": "column",
      position: "relative",
      width: "100%",
      height: "100%",
      overflow: "hidden",
    },
    children: [main],
  });
  return el("main", {
    name: `Home · ${W}`,
    attrs: { "data-screen": `Home · ${W}` },
    style: {
      display: "flex",
      "flex-direction": "column",
      width: "100%",
      height: "1000px",
      position: "relative",
    },
    children: [root],
  });
}

const variant = (W: number, minWidth: number, ir: IrElement): FluidScreen & ExportScreen => ({
  nodeId: `home-${W}`,
  dslId: `home-${W}`,
  name: `Home · ${W}`,
  width: W,
  height: 1000,
  ir,
  vars: {},
  credits: [],
  platform: "web",
  responsive: { group: "home", minWidth },
});

/** the side of a `padding` shorthand (its parts may be calc() expressions) */
const side = (padding: string, k: number): string => {
  const parts: string[] = [];
  let depth = 0,
    cur = "";
  for (const ch of padding.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (cur) parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts[k]!;
};

const find = (root: IrElement, name: string): IrElement => {
  for (const { el: e } of irPaths(root).values()) if (e.name === name) return e;
  throw new Error(`no ${name}`);
};

describe("lerpCss", () => {
  it("is the captured px at the design width and follows the slopes either side", () => {
    expect(lerpCss(100, 1280, 0, 0)).toBe("100px");
    const css = lerpCss(1170, 1280, 0.5, 1);
    expect(len(css, 1280)).toBeCloseTo(1170, 2);
    expect(len(css, 1440)).toBeCloseTo(1250, 2);
    expect(len(css, 1024)).toBeCloseTo(914, 2);
    expect(lerpCss(10, 390, 0.25, 0.25)).toBe("calc(10px + 0.25 * (100vw - 390px))");
  });
});

describe("fitMinWidth", () => {
  const vs = [
    { width: 390, responsive: { group: "g", minWidth: 0 } },
    { width: 768, responsive: { group: "g", minWidth: 768 } },
    { width: 1280, responsive: { group: "g", minWidth: 1280 } },
    { width: 1440, responsive: { group: "g", minWidth: 1024 } },
  ];
  it("starts a variant captured at its breakpoint at FLUID_FIT of its width when the variant below is another layout", () => {
    expect(fitMinWidth(vs, 0)).toBe(0);
    expect(fitMinWidth(vs, 1)).toBe(Math.round(768 * FLUID_FIT));
    expect(fitMinWidth(vs, 2)).toBe(1024);
  });
  it("keeps the captured breakpoint when the variant below is the same layout, and an explicit one", () => {
    expect(fitMinWidth(vs, 2, true)).toBe(1280);
    expect(fitMinWidth(vs, 3)).toBe(1024);
  });
  it("never starts at or below the narrower variant", () => {
    expect(
      fitMinWidth([{ width: 1200 }, { width: 1280, responsive: { group: "g", minWidth: 1280 } }], 1),
    ).toBe(1201);
  });
});

describe("designBoxes", () => {
  it("resolves px widths, stretched column children and absolute layers between insets", () => {
    const ir = page(1280, { pad: 55, column: 800, card: 300, heroH: 600 });
    const b = designBoxes(ir, 1280);
    expect(b.get(find(ir, "Main"))).toEqual({ box: 1280, pad: 1280, content: 1170 });
    expect(b.get(find(ir, "Cards"))?.content).toBe(1170);
    expect(b.get(find(ir, "Column"))?.box).toBe(800);
  });
});

describe("fluidVariants", () => {
  // the same layout at 1280 and 1728: gutters 55 → 120, a max-width column 800 → 800, cards share the row,
  // the hero keeps its proportions
  const a = page(1280, { pad: 55, column: 800, card: 300, heroH: 585 });
  const b = page(1728, { pad: 120, column: 800, card: 400, heroH: 744 });
  const out = fluidVariants([variant(1280, 1280, a), variant(1728, 1728, b)]);
  const fa = out[0]!.ir;

  it("leaves the input untouched and marks the variants fluid", () => {
    expect(find(a, "Hero").style.width).toBe("1170px");
    expect(out.every((s) => s.responsive?.fluid)).toBe(true);
  });

  it("is exactly the captured geometry at the design width", () => {
    const hero = find(fa, "Hero");
    expect(len(hero.style.width!, 1280, 1170)).toBeCloseTo(1170, 2);
    expect(hero.style["aspect-ratio"]).toBe("1170 / 585");
    expect(len(side(find(fa, "Main").style.padding!, 1), 1280)).toBeCloseTo(55, 2);
    expect(len(find(fa, "Card 0").style.width!, 1280, 1170)).toBeCloseTo(300, 2);
  });

  it("follows the line to the next variant between the breakpoints", () => {
    // at 1504 (half-way) the gutter is half-way and a card a share of the row it sits in
    expect(len(side(find(fa, "Main").style.padding!, 1), 1504)).toBeCloseTo(87.5, 2);
    const row = 1504 - 2 * 87.5;
    expect(len(find(fa, "Card 0").style.width!, 1504, row)).toBeCloseTo(
      300 + (100 * (row - 1170)) / (1488 - 1170),
      3,
    );
    // a max-width column keeps its width
    expect(find(fa, "Column").style.width).toBe("800px");
  });

  it("reflows below the design width: boxes shrink with the viewport, never wider than captured", () => {
    const lead = find(fa, "Lead");
    expect(lead.style["min-width"]).toBe("min-content");
    expect(lead.style["overflow-wrap"]).toBe("break-word");
    const col = find(fa, "Column");
    expect(len(col.style["max-width"]!, 1024, 900)).toBe(900);
    expect(len(col.style["max-width"]!, 1280, 1170)).toBeGreaterThanOrEqual(800);
  });

  it("page height grows with its content away from the design width, and is pinned at it", () => {
    const m = fa.style;
    expect(m.height).toBe("auto");
    expect(m["min-height"]).toBe("1000px");
    expect(len(m["max-height"]!, 1280)).toBe(1000);
    expect(len(m["max-height"]!, 1200)).toBeGreaterThan(50000);
    // the page's main layer joined the flow
    expect(find(fa, "Main").style.position).toBe("relative");
    expect(find(fa, "Main").style.top).toBeUndefined();
  });

  it("starts the wider variant at its captured width when both are the same layout", () => {
    expect(out[1]!.responsive?.minWidth).toBe(1728);
    expect(layerOverlap(irPaths(a), irPaths(b))).toBe(1);
  });

  it("starts it at FLUID_FIT of its width when the layouts differ", () => {
    const other = page(1728, { pad: 120, column: 800, card: 400, heroH: 744, cards: 4 });
    find(other, "Cards").children.push(
      el("div", { name: "Extra", style: {} }),
      el("div", { name: "More", style: {} }),
    );
    const o2 = fluidVariants([variant(1280, 1280, a), variant(1728, 1728, other)]);
    expect(o2[1]!.responsive?.minWidth).toBe(Math.round(1728 * FLUID_FIT));
  });
});

describe("reflowIr", () => {
  it("lets a row of fixed boxes share the width it loses, never below width − Δ", () => {
    const ir = page(1280, { pad: 55, column: 800, card: 300, heroH: 585 });
    reflowIr(ir, 1280);
    const card = find(ir, "Card 1").style;
    expect(card["flex-shrink"]).toBe("1");
    expect(len(card["min-width"]!, 1280)).toBe(300);
    expect(len(card["min-width"]!, 1180)).toBe(200);
  });

  it("keeps icon-sized boxes in a row at their size (no shrink, no per-variant rule)", () => {
    const ir = page(1280, { pad: 55, column: 800, card: 40, heroH: 585 });
    reflowIr(ir, 1280);
    const icon = find(ir, "Card 1").style;
    expect(icon["flex-shrink"]).not.toBe("1");
    expect(icon["min-width"]).toBeUndefined();
    expect(icon["max-width"]).toBeUndefined();
  });

  it("makes the bottom layer of a box of placed layers join its flow, so the box grows with its text", () => {
    const title = el("p", {
      name: "Title",
      style: { position: "absolute", left: "16px", top: "16px", "white-space": "pre", "line-height": "26px" },
      children: [{ kind: "text", text: "Hinweise" }],
    });
    const list = el("div", {
      name: "List",
      style: {
        display: "flex",
        "flex-direction": "column",
        position: "absolute",
        left: "16px",
        top: "54px",
        right: "16px",
        width: "auto",
        height: "216px",
      },
      children: [
        el("p", {
          name: "Item",
          style: { "white-space": "pre-wrap" },
          children: [{ kind: "text", text: "long text" }],
        }),
      ],
    });
    const box = el("div", {
      name: "Box",
      style: {
        display: "flex",
        "flex-direction": "column",
        position: "relative",
        width: "358px",
        height: "288px",
      },
      children: [title, list],
    });
    const ir = el("main", {
      style: { height: "1000px" },
      children: [el("div", { name: "Root", style: { position: "relative" }, children: [box] })],
    });
    reflowIr(ir, 390);
    expect(list.style.position).toBe("relative");
    expect(list.style.margin).toBe("54px 16px 0px 16px");
    expect(list.style.top).toBeUndefined();
    expect(title.style.position).toBe("absolute");
    expect(box.style.height).toBe("auto");
    expect(box.style["min-height"]).toBe("288px");
    expect(len(box.style["max-height"]!, 390)).toBe(288);
  });

  it("turns a grid of equal px tracks that fills its box into fr tracks", () => {
    const cells = [0, 1, 2, 3].map((n) =>
      el("div", { name: `Tile ${n}`, style: { position: "relative", width: "292px", height: "280px" } }),
    );
    const grid = el("div", {
      name: "Grid",
      style: {
        display: "grid",
        "grid-template-columns": "292px 292px 292px 292px",
        "column-gap": "16px",
        position: "relative",
        width: "1216px",
        height: "600px",
      },
      children: cells,
    });
    const ir = el("main", {
      style: { height: "1000px" },
      children: [el("div", { name: "Root", style: { position: "relative" }, children: [grid] })],
    });
    reflowIr(ir, 1280);
    expect(grid.style["grid-template-columns"]).toBe("repeat(4, minmax(0, 1fr))");
    expect(cells[0]!.style.width).toBe("auto");
  });

  it("keeps hidden layers hidden", () => {
    const hidden = el("div", {
      name: "State",
      style: {
        display: "none",
        position: "absolute",
        left: "0px",
        top: "0px",
        width: "390px",
        height: "900px",
      },
      children: [el("p", { style: { "white-space": "pre-wrap" }, children: [{ kind: "text", text: "x" }] })],
    });
    const shown = el("div", {
      name: "Default",
      style: { position: "absolute", left: "0px", top: "0px", width: "390px", height: "800px" },
    });
    const group = el("div", {
      name: "States",
      style: { display: "flex", position: "relative", width: "390px", height: "800px" },
      children: [shown, hidden],
    });
    const ir = el("main", {
      style: { height: "1000px" },
      children: [el("div", { name: "Root", style: { position: "relative" }, children: [group] })],
    });
    reflowIr(ir, 390);
    expect(hidden.style.display).toBe("none");
  });
});

describe("bundles", () => {
  const a = page(1280, { pad: 55, column: 800, card: 300, heroH: 585 });
  const b = page(1728, { pad: 120, column: 800, card: 400, heroH: 744 });
  const screens = [variant(1280, 1280, a), variant(1728, 1728, b)];
  const o = { semantic: true, cssVars: false, images: false, attribution: false, vars: {} };

  it("HTML: fluid variants reflow down to FLUID_FIT of their width, are scaled only below, and carry the fluid geometry", () => {
    const files = buildHtmlFiles(screens, o);
    const css = String(files["styles.css"]);
    expect(css).not.toContain("calc(100vw / 1280px)");
    expect(css).toContain(
      '@media (max-width: 1023.98px) { body[data-page="home"] > [data-bp="0"] > main { zoom: 0.312; zoom: min(1, calc(100vw / 1024px)); } }',
    );
    expect(css).toContain("aspect-ratio: 1170 / 585");
    expect(css).toMatch(/min-height: 1000px/);
  });

  it("React: the same geometry", () => {
    const files = buildReactFiles(screens, o);
    const all = Object.entries(files)
      .filter(([k]) => /\.(tsx|css)$/.test(k))
      .map(([, v]) => String(v))
      .join("\n");
    expect(all).toMatch(/aspect-ratio|aspect-\[/);
    expect(all).not.toContain("calc(100vw / 1280px)");
  });
});

describe("measured variants (URL capture: one per layout range, measured at the range ends)", () => {
  // the desktop layout captured at 1440, measured at 1200 (its range start) and 1920: gutters 55 → 75 → 315 (a
  // centred 1290 column past 1440), the hero keeps its proportions
  const at = (W: number, pad: number, heroH: number) =>
    page(W, { pad, column: 800, card: 300, heroH, textW: 800 });
  const desk: FluidScreen & ExportScreen = {
    ...variant(1440, 1200, at(1440, 75, 640)),
    measured: [
      { width: 1200, ir: at(1200, 55, 554) },
      { width: 1920, ir: at(1920, 315, 640) },
    ],
  };
  const phone: FluidScreen & ExportScreen = {
    ...variant(390, 0, at(390, 16, 300)),
    measured: [
      { width: 320, ir: at(320, 16, 241.34) },
      { width: 767, ir: at(767, 32, 589.11) },
    ],
  };
  const out = fluidVariants([phone, desk]);
  const d = out[1]!,
    p = out[0]!;

  it("applies from its range start exactly and reflows over its whole range (never scaled)", () => {
    expect(d.responsive).toMatchObject({ minWidth: 1200, fluid: 1200 });
    expect(p.responsive).toMatchObject({ minWidth: 0, fluid: 0 });
    const css = String(buildHtmlFiles([phone, desk], { vars: {} } as never)["styles.css"]);
    expect(css).not.toMatch(/zoom:/);
  });

  it("follows the measured geometry on either side of the capture width (a kink at the capture is kept)", () => {
    const pad = find(d.ir, "Main").style.padding!;
    expect(len(side(pad, 1), 1440)).toBeCloseTo(75, 2);
    expect(len(side(pad, 1), 1200)).toBeCloseTo(55, 2);
    expect(len(side(pad, 1), 1920)).toBeCloseTo(315, 2);
    expect(len(side(pad, 1), 1728)).toBeCloseTo(75 + 0.5 * 288, 2);
    expect(len(side(pad, 1), 1280)).toBeCloseTo(55 + (20 / 240) * 80, 2);
    // the column's own width never changed: it stays a plain px width
    expect(find(d.ir, "Column").style.width).toBe("800px");
  });

  it("a value measured on one side only continues that trend on the other", () => {
    const hero = find(p.ir, "Hero").style;
    expect(hero["aspect-ratio"]).toBe("358 / 300");
    expect(len(hero.width!, 390)).toBeCloseTo(358, 2);
    expect(len(hero.width!, 412)).toBeCloseTo(358 + 22 * ((767 - 64 - 358) / 377), 2);
    expect(len(hero.width!, 375)).toBeCloseTo(358 - 15 * ((358 - 288) / 70), 2);
  });

  it("the HTML export carries the measured geometry and the range start as the breakpoint", () => {
    const files = buildHtmlFiles([phone, desk], { vars: {} } as never);
    const css = String(files["styles.css"]);
    expect(css).toContain("@media (min-width: 1200px)");
    // (measured: the widest variant follows the viewport past its widest measurement too, continuing its lines)
    const vw = String.raw`100vw`;
    expect(css).toMatch(
      new RegExp(
        String.raw`calc\(75px \+ 0\.5 \* max\(0px, ${vw} - 1440px\) \+ 0\.083333 \* min\(0px, ${vw} - 1440px\)\)`,
      ),
    );
  });
});

describe("pwlCss", () => {
  it("passes through every measured width and keeps a kink between them (a max-width column reaching its cap)", () => {
    // ibm.com-like: a 16 px gutter grid filling the viewport up to 1584 px, then centred
    const col = (vw: number) => Math.min(vw - 32, 1584);
    const css = pwlCss(
      [
        [1280, col(1280)],
        [1440, col(1440)],
        [1680, col(1680)],
        [1920, col(1920)],
      ],
      1280,
    )!;
    for (const w of [1280, 1440, 1680, 1920]) expect(len(css, w)).toBeCloseTo(col(w), 2);
    expect(len(css, 1200)).toBeCloseTo(1168, 2);
    expect(len(css, 2560)).toBeCloseTo(1584, 2);
    expect(
      pwlCss(
        [
          [390, 10],
          [480, 10],
        ],
        390,
      ),
    ).toBeNull();
  });
});

describe("a text narrowed to its longest line at the capture width", () => {
  const at = (W: number, w: number, fit?: number) =>
    el("main", {
      name: `P · ${W}`,
      style: { width: "100%" },
      children: [
        el("div", {
          name: "Page",
          style: { position: "relative", width: "100%" },
          children: [
            el("p", {
              name: "Lead",
              attrs: fit ? { "data-narrowed": String(fit - w) } : {},
              style: { position: "relative", width: `${w}px` },
              children: [{ kind: "text", text: "Details zum Deutschlandticket" }],
            }),
          ],
        }),
      ],
    });
  // 390: narrowed to 279 (its box in the page is 310 wide); 375: its box 295
  const s: FluidScreen & ExportScreen = {
    ...variant(390, 0, at(390, 279, 310)),
    measured: [{ width: 375, ir: at(375, 295) }],
  };
  const out = fluidVariants([s, { ...variant(800, 600, at(800, 500)), nodeId: "p-800" }])[0]!;
  const lead = find(out.ir, "Lead");

  it("follows the page width at every width (no width pinned to the capture width); the mark is not exported", () => {
    expect(len(lead.style.width!, 390)).toBeCloseTo(310, 2);
    expect(len(lead.style.width!, 393)).toBeCloseTo(313, 2);
    expect(len(lead.style.width!, 375)).toBeCloseTo(295, 2);
    expect(lead.style.width).not.toMatch(/1000/);
    expect("data-narrowed" in lead.attrs).toBe(false);
  });

  it("a stretched one keeps the page's right margin at every width (its narrowing is not pinned)", () => {
    const m = (W: number, right: number, nb?: number) =>
      el("main", {
        name: `Q · ${W}`,
        style: { width: "100%" },
        children: [
          el("div", {
            name: "Page",
            style: { display: "flex", "flex-direction": "column", position: "relative", width: "100%" },
            children: [
              el("p", {
                name: "Lead",
                attrs: nb ? { "data-narrowed": String(nb) } : {},
                style: { position: "relative", width: "auto", margin: `0px ${right}px 0px 0px` },
                children: [{ kind: "text", text: "x" }],
              }),
            ],
          }),
        ],
      });
    const q: FluidScreen & ExportScreen = {
      ...variant(390, 0, m(390, 33.64, 33.64)),
      nodeId: "q-390",
      measured: [{ width: 375, ir: m(375, 0) }],
    };
    const lead2 = find(
      fluidVariants([q, { ...variant(800, 600, m(800, 0)), nodeId: "q-800" }])[0]!.ir,
      "Lead",
    );
    expect(len(side(lead2.style.margin!, 1), 390)).toBeCloseTo(0, 2);
    expect(len(side(lead2.style.margin!, 1), 393)).toBeCloseTo(0, 2);
    expect(len(side(lead2.style.margin!, 1), 375)).toBeCloseTo(0, 2);
  });
});

describe("art direction (another picture at some measured widths)", () => {
  const at = (W: number, src: string) =>
    el("main", {
      name: `A · ${W}`,
      style: { width: "100%" },
      children: [
        el("figure", {
          name: "Hero",
          style: { position: "relative", width: "100%", height: "640px" },
          children: [el("img", { attrs: { src, alt: "" }, style: { position: "absolute", inset: "0" } })],
        }),
      ],
    });
  const s: FluidScreen & ExportScreen = {
    ...variant(1440, 1200, at(1440, "data:image/jpeg;base64,AAAA")),
    measured: [
      { width: 1728, ir: at(1728, "data:image/jpeg;base64,AAAA") },
      { width: 1920, ir: at(1920, "data:image/jpeg;base64,BBBB") },
    ],
  };
  const out = fluidVariants([
    { ...variant(390, 0, at(390, "data:image/jpeg;base64,CCCC")), nodeId: "a-390" },
    s,
  ])[1]!;

  it("wraps the image in a picture whose source shows the other picture from halfway between the measured widths", () => {
    const fig = find(out.ir, "Hero");
    const pic = fig.children[0] as IrElement;
    expect(pic.tag).toBe("picture");
    expect(pic.style).toEqual({ display: "contents" });
    expect(pic.children.map((c) => (c as IrElement).tag)).toEqual(["source", "img"]);
    expect((pic.children[0] as IrElement).attrs).toEqual({
      media: "(min-width: 1824px)",
      srcset: "data:image/jpeg;base64,BBBB",
    });
  });

  it("the HTML export writes the other picture as a file too", () => {
    const files = buildHtmlFiles(
      [{ ...variant(390, 0, at(390, "data:image/jpeg;base64,CCCC")), nodeId: "a-390" }, s],
      { vars: {}, images: true } as never,
    );
    const page = Object.entries(files).find(([k]) => k.endsWith(".html") && k !== "index.html")![1] as string;
    expect(page).toMatch(/<source media="\(min-width: 1824px\)" srcset="assets\/[^"]+">/);
  });
});

describe("fluidValue (continuous values through the measured widths)", () => {
  /** the value as CSS evaluated at viewport width x (len), or the constant when there is no CSS */
  const value = (pts: Array<[number, number]>, W: number) => {
    const css = fluidValue(pts, W);
    const at = pts.find((p) => p[0] === W)![1];
    return (x: number) => (css === null ? at : len(css, x));
  };
  const lo = 320,
    hi = 1920;
  /** the largest step between neighbouring widths a value may take: its steepest measured slope (+1 px rounding) */
  const continuous = (f: (x: number) => number, pts: Array<[number, number]>) => {
    const s = [...pts].sort((a, b) => a[0] - b[0]);
    const steep = Math.max(...s.slice(1).map((p, i) => Math.abs((p[1] - s[i]![1]) / (p[0] - s[i]![0]))));
    for (let x = lo; x < hi; x++) if (Math.abs(f(x + 1) - f(x)) > steep + 1e-6) return x;
    return null;
  };
  const sets: Record<string, Array<[number, number]>> = {
    "a line (a column that follows the viewport)": [
      [360, 320],
      [390, 350],
      [412, 372],
      [767, 727],
    ],
    "a column reaching its max-width between two measured widths": [
      [1024, 1024],
      [1100, 1100],
      [1232, 1200],
      [1280, 1200],
      [1440, 1200],
      [1920, 1200],
    ],
    "clamp(): flat, growing, flat": [
      [320, 28],
      [400, 28],
      [600, 36],
      [800, 44],
      [1000, 52],
      [1200, 52],
      [1440, 52],
    ],
    "two kinks at measured widths": [
      [320, 16],
      [390, 16],
      [600, 37],
      [767, 37],
    ],
    "an irregular value (a height that changes where text wraps)": [
      [320, 168],
      [340, 120],
      [360, 168],
      [390, 120],
      [412, 168],
      [430, 120],
    ],
  };
  for (const [name, pts] of Object.entries(sets))
    it(`${name}: within 1 px at every measured width, or constant; continuous; monotone where the points are`, () => {
      const W = pts[Math.min(2, pts.length - 1)]![0];
      const f = value(pts, W);
      const css = fluidValue(pts, W);
      if (css !== null)
        for (const [x, y] of pts) expect(Math.abs(f(x) - y), `${x}px`).toBeLessThanOrEqual(FLUID_TOL + 1e-6);
      else for (let x = lo; x <= hi; x += 7) expect(f(x)).toBe(pts.find((p) => p[0] === W)![1]);
      expect(continuous(f, pts)).toBeNull();
      expect(css ?? "").not.toMatch(/\* ?1000\b|\b1000 ?\*|clamp\(0px/);
      const sorted = [...pts].sort((a, b) => a[0] - b[0]);
      const rising = sorted.every((p, i) => i === 0 || p[1] >= sorted[i - 1]![1]);
      if (rising && css !== null)
        for (let x = sorted[0]![0]; x < sorted[sorted.length - 1]![0]; x += 3)
          expect(f(x + 3)).toBeGreaterThanOrEqual(f(x) - 1e-6);
    });

  it("is exact at a kink between measured widths (min(100vw, 1200px))", () => {
    const f = value(sets["a column reaching its max-width between two measured widths"]!, 1440);
    expect(f(1104)).toBeCloseTo(1104, 3);
    expect(f(1199)).toBeCloseTo(1199, 3);
    expect(f(1200)).toBeCloseTo(1200, 3);
    expect(f(1300)).toBeCloseTo(1200, 3);
  });

  it("never fits the measured widths with steps: an irregular value is the design width's, constant", () => {
    const zigzag = sets["an irregular value (a height that changes where text wraps)"]!;
    expect(fluidValue(zigzag, 390)).toBeNull();
    expect(fluidFit(zigzag, 390)).toBeNull();
    expect(linear(zigzag)).toBe(false);
    // four points always have a continuous line through them (two knots): no step either
    const four: Array<[number, number]> = [
      [320, 168],
      [360, 120],
      [390, 120],
      [412, 144],
    ];
    const f = value(four, 390);
    for (const [x, y] of four) expect(f(x)).toBeCloseTo(y, 2);
    expect(Math.abs(f(401) - f(400))).toBeLessThan(2);
  });
});

describe("the recorded fixture, emitted (flow first)", async () => {
  const { readFileSync } = await import("node:fs");
  const { pageScreens, pageSections, tagSections } = await import("@harness/scene");
  const { getEmitter } = await import("@harness/codegen");
  const { flowLint, sectionClasses } = await import("@harness/measure");
  const recorded = (w: number) =>
    JSON.parse(
      readFileSync(
        new URL(`../../capture/test/sites/acme/recorded/${w}.snapshot.json`, import.meta.url),
        "utf8",
      ),
    );
  const ps = pageScreens([
    { width: 390, minWidth: 0, snap: recorded(390) },
    { width: 768, minWidth: 768, snap: recorded(768) },
    { width: 1440, minWidth: 1024, snap: recorded(1440) },
  ]);
  const screens = tagSections(ps.screens, pageSections(ps.screens));
  const files = getEmitter("static")!.emit({ screens, fonts: ps.fonts, page: ps.page }, { assets: "none" });
  const html = String(files["index.html"]),
    css = String(files["styles.css"]);
  // per class: its tag, whether it sits in a menu overlay, whether it holds text that wraps (its own or below it)
  const info = new Map<string, { tag: string; overlay: boolean; wraps: boolean }>();
  const rules = new Map<string, string>();
  for (const m of css.matchAll(/^\.([\w-]+) \{\n([\s\S]*?)\n\}/gm)) rules.set(m[1]!, m[2]!);
  const stack: { cls?: string; overlay: boolean }[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z0-9-]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) {
      const own = stack[stack.length - 1]?.cls;
      if (m[5].trim() && own && !/white-space: (pre|nowrap);/.test(rules.get(own) ?? ""))
        for (const s of stack) if (s.cls) info.get(s.cls)!.wraps = true;
      continue;
    }
    if (m[1]) {
      stack.pop();
      continue;
    }
    const cls = /class="([^"]+)"/.exec(m[3]!)?.[1];
    const overlay = stack.some((s) => s.overlay) || /data-overlay[= ]/.test(m[3]!);
    if (cls && !info.has(cls)) info.set(cls, { tag: m[2]!, wraps: false, overlay });
    if (!/^(img|br|input|source|meta|link|path|circle|rect|polygon|line)$/.test(m[2]!) && !m[4])
      stack.push({ cls, overlay });
  }
  const page = [...rules].filter(([c]) => !info.get(c)?.overlay);

  it("has no CSS that holds at one width only: no pins, no scaling", () => {
    const { sections, media } = sectionClasses(html);
    const lint = flowLint({
      css,
      scope: { ids: [...sections.keys()], classes: [...sections.values()].flatMap((c) => [...c]) },
      mediaClasses: media,
      boundaries: [768, 1024],
    });
    expect(lint.counts["value-pin"] ?? 0).toBe(0);
    expect(lint.counts["media-pin"] ?? 0).toBe(0);
    expect(lint.counts.zoom ?? 0).toBe(0);
  });

  it("takes boxes out of the flow only where the page does (the carousel arrows), and never fixes a wrapping text's height", () => {
    // 110 such rules before flow first; the page itself places 3 boxes (×2 slider arrows per variant here)
    const placed = page.filter(([, b]) => /^ {2}position: (absolute|fixed);/m.test(b)).map(([c]) => c);
    expect(placed.length).toBeLessThanOrEqual(10);
    const fixed = page
      .filter(([c, b]) => /^ {2}height: [\d.]+px;/m.test(b) && info.get(c)?.wraps)
      .map(([c]) => c);
    expect(fixed).toEqual([]);
  });

  it("takes far fewer boxes out of the flow than the fitted geometry (under a third)", () => {
    const fit = pageScreens(
      [
        { width: 390, minWidth: 0, snap: recorded(390) },
        { width: 768, minWidth: 768, snap: recorded(768) },
        { width: 1440, minWidth: 1024, snap: recorded(1440) },
      ],
      true,
      { flow: false },
    );
    const fcss = String(
      getEmitter("static")!.emit(
        { screens: tagSections(fit.screens, pageSections(fit.screens)), fonts: fit.fonts, page: fit.page },
        { assets: "none" },
      )["styles.css"],
    );
    expect((fcss.match(/position: absolute/g) ?? []).length).toBeGreaterThan(
      3 * (css.match(/position: absolute/g) ?? []).length,
    );
  });
});

describe("a box taller than its flowing content (its heading placed over it)", () => {
  // a card as tall as its grid row: 48 px of icons in flow, the heading placed (absolute) at its top
  const card = (h: number) =>
    el("main", {
      name: "Main",
      style: { position: "relative", width: "1440px", height: "900px" },
      children: [
        el("div", {
          name: "Page",
          style: { position: "relative", height: "900px" },
          children: [
            el("div", {
              name: "Card",
              style: {
                display: "flex",
                "flex-direction": "row",
                "align-items": "flex-end",
                height: `${h}px`,
                padding: "0px 16px 16px 16px",
              },
              children: [
                el("div", { name: "Icon", style: { width: "48px", height: "48px" } }),
                el("p", {
                  name: "Heading",
                  style: { position: "absolute", left: "16px", top: "0px", width: "268px" },
                  children: [{ kind: "text", text: "Create a streamhouse" }],
                }),
              ],
            }),
          ],
        }),
      ],
    });
  it("keeps its measured height where it changes between widths (it does not collapse to its icons)", () => {
    const desk: FluidScreen & ExportScreen = {
      ...variant(1440, 1200, card(192)),
      measured: [
        { width: 1200, ir: card(214) },
        { width: 1920, ir: card(192) },
      ],
    };
    const [d] = fluidVariants([desk]);
    expect(find(d!.ir, "Card").style.height).not.toBe("auto");
    expect(len(find(d!.ir, "Card").style.height!, 1440)).toBeCloseTo(192, 0);
  });
});
