// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
import type { SceneElement } from "@harness/protocol";
import {
  applyRegionStates,
  brandCaptureOf,
  easingOf,
  joinMirroredLines,
  menuInteraction,
  menuOverlayOf,
  parseGradient,
  parseShadows,
  prettyClass,
  regionKeepIds,
  rotationOf,
  snapshotToScreen,
  UrlImportError,
} from "@harness/scene";
import type {
  SnapElement,
  SnapFont,
  SnapLine,
  SnapNode,
  SnapState,
  SnapText,
  Snapshot,
} from "@harness/capture";
import type { BrandCapture } from "@harness/protocol";

let id = 1;
const font = (o: Partial<SnapFont> = {}): SnapFont => ({
  family: "Transit",
  stack: "Transit, Arial",
  size: 16,
  weight: 400,
  lineHeight: 24,
  letterSpacing: 0,
  color: "rgb(37, 37, 37)",
  align: "start",
  whiteSpace: "normal",
  ascent: 14,
  ...o,
});
const line = (text: string, x: number, y: number, w: number, brk?: SnapLine["brk"]): SnapLine => ({
  text,
  x,
  y,
  w,
  h: 19,
  ...(brk ? { brk } : {}),
});
const text = (t: string, lines: SnapLine[], f: Partial<SnapFont> = {}): SnapText => ({
  id: id++,
  kind: "text",
  text: t,
  lines,
  font: font(f),
  parent: 0,
});
const box = (
  tag: string,
  rect: [number, number, number, number],
  o: Partial<SnapElement> = {},
  children: SnapNode[] = [],
): SnapElement => ({
  id: id++,
  tag,
  rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] },
  layout: { display: "block", position: "static" },
  attrs: {},
  style: {},
  children,
  ...o,
});
const snap = (children: SnapNode[], o: Partial<Snapshot> = {}): Snapshot => ({
  version: 1,
  url: "https://example.com/",
  title: "Example",
  viewport: { width: 1000, height: 800 },
  page: {
    width: 1000,
    height: 800,
    background: "rgb(255, 255, 255)",
    color: "rgb(0, 0, 0)",
    font: "Transit",
  },
  root: box("body", [0, 0, 1000, 800], {}, children),
  fonts: [],
  fontFaces: [],
  sheets: [],
  nodes: 1,
  ...o,
});
const all = (el: SceneElement): SceneElement[] => [el, ...(el.children ?? []).flatMap(all)];
const find = (el: SceneElement, pred: (e: SceneElement) => boolean) => all(el).find(pred);
const conv = (s: Snapshot, autoLayout = false) => snapshotToScreen(s, { autoLayout });
/** the fitted geometry (flow: false): every box where it was measured, only what lines up exactly in auto layout */
const fitted = (s: Snapshot, autoLayout = false) => snapshotToScreen(s, { autoLayout, flow: false });

describe("snapshotToScreen", () => {
  it("rejects anything that is not a v1 snapshot", () => {
    expect(() => snapshotToScreen({} as Snapshot)).toThrow(UrlImportError);
  });

  it("keeps painted boxes, collapses empty wrappers and positions children relative to the padding box", () => {
    const card = box(
      "div",
      [100, 100, 300, 200],
      {
        style: {
          bg: "rgb(255, 0, 0)",
          radius: [8, 8, 8, 8],
          border: [1, 1, 1, 1].map(() => ({ w: 2, style: "solid", color: "rgb(0, 0, 0)" })),
        },
        layout: { display: "block", position: "static", borderWidth: [2, 2, 2, 2] },
      },
      [
        box("div", [110, 110, 50, 50], {}, [
          box("div", [120, 120, 20, 20], { style: { bg: "rgb(0, 0, 255)" } }),
        ]),
      ],
    );
    const { screen } = conv(snap([box("div", [0, 0, 1000, 800], {}, [card])]));
    expect(screen.width).toBe(1000);
    expect(screen.root.style?.background).toBe("rgb(255, 255, 255)");
    const red = find(screen.root, (e) => e.style?.background === "rgb(255, 0, 0)")!;
    expect(red.layout).toMatchObject({ position: "absolute", x: 100, y: 100, width: 300, height: 200 });
    expect(red.style).toMatchObject({ radius: 8, border: { width: 2, color: "rgb(0, 0, 0)" } });
    // the empty 50×50 wrapper is gone; the blue box sits inside the 2px border
    expect(red.children).toHaveLength(1);
    expect(red.children![0]!.layout).toMatchObject({ x: 18, y: 18, width: 20, height: 20 });
  });

  it("wraps the text of a positioned inline box in the block around it, not in its own line extent", () => {
    const t1 = text(
      "From innovative engineering, we make it more",
      [
        line("From innovative engineering, we make it more", 10, 2, 980, "space"),
        line("fun than it should be.", 400, 30, 200),
      ],
      { align: "center", lineHeight: 28 },
    );
    const sup = box("sup", [10, 0, 980, 58], { layout: { display: "inline", position: "relative" } }, [t1]);
    const t = find(
      conv(snap([box("h2", [0, 0, 1000, 58], {}, [sup])])).screen.root,
      (e) => e.type === "text",
    )!;
    // (narrowed to its longest line + 2 at most: a soft break the next word nearly fit)
    expect(t.layout?.width).toBeGreaterThanOrEqual(982);
  });

  it("keeps the blank line of two <br>s in a row", () => {
    const br = (y: number): SnapElement => ({ ...box("br", [0, y, 0, 19]), kind: "br" });
    const p = box("p", [0, 0, 600, 72], {}, [
      text("So much more.", [line("So much more.", 0, 2.5, 100)], { lineHeight: 24 }),
      br(2),
      br(26),
      text("The 2027 Atlas.", [line("The 2027 Atlas.", 0, 50.5, 110)], { lineHeight: 24 }),
    ]);
    const t = find(conv(snap([p])).screen.root, (e) => e.type === "text")!;
    expect(t.text).toBe("So much more.\n\nThe 2027 Atlas.");
  });

  it("joins the inline runs of a block into one rich text with links", () => {
    const p = box("p", [0, 0, 600, 24], {}, [
      box("strong", [0, 0, 80, 19], { layout: { display: "inline", position: "static" } }, [
        text("Hinweis:", [line("Hinweis:", 0, 2, 70)], { weight: 700 }),
      ]),
      text(" Alle Infos zum ", [line("Alle Infos zum", 74, 2, 110)]),
      box(
        "a",
        [188, 0, 80, 19],
        { layout: { display: "inline", position: "static" }, attrs: { href: "https://example.com/preis" } },
        [
          text("Preis", [line("Preis", 188, 2, 40)], {
            color: "rgb(0, 0, 200)",
            decoration: {
              line: "underline",
              color: "rgb(0, 0, 200)",
              thickness: "auto",
              style: "solid",
              offset: "auto",
            },
          }),
        ],
      ),
    ]);
    const { screen } = conv(snap([p]));
    const t = find(screen.root, (e) => e.type === "text")!;
    expect(t.text).toBe("Hinweis: Alle Infos zum Preis");
    expect(t.runs?.map((r) => r.text).join("")).toBe(t.text);
    expect(t.runs?.[0]?.style?.fontWeight).toBe(700);
    const link = t.runs!.find((r) => r.href)!;
    expect(link).toMatchObject({ text: "Preis", href: "https://example.com/preis" });
    expect(link.style?.decoration?.line).toBe("underline");
    // the paragraph's base style carries no underline (it would propagate to every run)
    expect(t.style?.decoration).toBeUndefined();
    expect(t.style).toMatchObject({ fontFamily: "Transit, Arial", fontSize: 16, lineHeightPx: 24 });
    // flow first: a line with room left in its block is a paragraph that wraps when the block narrows
    expect(t.style?.whiteSpace).toBeUndefined();
    expect(t.layout?.width).toBe(600);
    // the line box starts at the block's top (not 0.5 above it: Chromium rounds the half-leading)
    expect(t.layout).toMatchObject({ x: 0, y: 0 });
    // fitted: a single line never wraps
    expect(find(fitted(snap([p])).screen.root, (e) => e.type === "text")!.style?.whiteSpace).toBe("pre");
  });

  it("reflows a wrapped paragraph at the content width with soft hyphens at hyphenation points", () => {
    const p = box(
      "p",
      [10, 10, 200, 72],
      { layout: { display: "block", position: "static", padding: [0, 0, 0, 0] } },
      [
        text("Über 16.000 € im ersten Jahr verdienen? Jetzt bewerben!", [
          line("Über 16.000 € im ersten Jahr ver", 10, 12, 196, "word"),
          line("dienen? Jetzt", 10, 36, 150, "space"),
          line("bewerben!", 10, 60, 80),
        ]),
      ],
    );
    // fitted: the break inside the word is a hyphenation point (a soft hyphen)
    const t = find(fitted(snap([p])).screen.root, (e) => e.type === "text")!;
    expect(t.text).toBe("Über 16.000 € im ersten Jahr ver­dienen? Jetzt bewerben!");
    // the captured content width, not rounded up (a wider box can pull the next word up)
    expect(t.layout?.width).toBe(200);
    expect(t.style?.whiteSpace).toBeUndefined();
    // flow first: a page that does not hyphenate broke the word only to fit its box; the word stays whole (the box
    // breaks it again where it has to, at any width) and the text is marked as one that breaks words
    const f = find(conv(snap([p])).screen.root, (e) => e.type === "text")!;
    expect(f.text).toBe("Über 16.000 € im ersten Jahr verdienen? Jetzt bewerben!");
    expect(f.layout?.width).toBe(200);
    expect(f.meta?.breaksWords).toBe(true);
  });

  it("a page that hyphenates itself keeps hyphens: auto (every browser hyphenates as on the page)", () => {
    const p = box(
      "p",
      [10, 10, 200, 72],
      { layout: { display: "block", position: "static", padding: [0, 0, 0, 0] } },
      [
        text(
          "Über 16.000 € im ersten Jahr verdienen? Jetzt bewerben!",
          [
            line("Über 16.000 € im ersten Jahr ver", 10, 12, 196, "word"),
            line("dienen? Jetzt", 10, 36, 150, "space"),
            line("bewerben!", 10, 60, 80),
          ],
          { hyphens: "auto" },
        ),
      ],
    );
    const t = find(conv(snap([p])).screen.root, (e) => e.type === "text")!;
    expect(t.text).toContain("ver\u00addienen");
    expect(t.style?.hyphens).toBe("auto");
  });

  it("keeps hard breaks where the source wrapped earlier than the width needs (text-wrap: balance)", () => {
    const p = box("h2", [0, 0, 400, 48], {}, [
      text("Das Deutschlandticket für sehr wenig Mäuse.", [
        line("Das Deutschlandticket", 0, 2, 170, "space"),
        line("für sehr wenig Mäuse.", 0, 26, 165),
      ]),
    ]);
    // fitted: the break stays where the page put it
    const t = find(fitted(snap([p])).screen.root, (e) => e.type === "text")!;
    expect(t.text).toBe("Das Deutschlandticket\nfür sehr wenig Mäuse.");
    // flow first: no break pinned to the capture width; the text balances its lines itself, at every width
    const f = find(conv(snap([p])).screen.root, (e) => e.type === "text")!;
    expect(f.text).toBe("Das Deutschlandticket für sehr wenig Mäuse.");
    expect(f.style?.textWrap).toBe("balance");
  });

  it("splits a line where an inline icon sits between two text pieces", () => {
    const row = box("div", [0, 0, 500, 24], {}, [
      text("Bornholmer Str", [line("Bornholmer Str", 0, 2, 120)]),
      box("svg", [124, 4, 26, 14], {
        kind: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 14"><path d="M0 7h26"/></svg>',
        layout: { display: "inline-block", position: "static" },
      }),
      text(" Am Kupfergraben", [line("Am Kupfergraben", 154, 2, 130)]),
    ]);
    const { screen, stats } = conv(snap([row]));
    const texts = all(screen.root).filter((e) => e.type === "text");
    expect(texts.map((t) => t.text)).toEqual(["Bornholmer Str", "Am Kupfergraben"]);
    expect(texts[1]!.layout?.x).toBe(154);
    expect(stats.icons).toBe(1);
    expect(find(screen.root, (e) => e.type === "icon")?.svg).toContain("<path");
  });

  it("a line piece broken at a soft hyphen draws its hyphen without making it text", () => {
    const row = box("div", [0, 0, 300, 48], {}, [
      text("Ehrlichstr.", [line("Ehrlichstr.", 0, 2, 80)]),
      box("svg", [84, 4, 12, 14], {
        kind: "svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 14"><path d="M0 7h12"/></svg>',
        layout: { display: "inline-block", position: "static" },
      }),
      text(" Wilhelminen\u00adhofstr.", [
        line("Wilhelminen\u00ad", 100, 2, 98, "word"),
        line("hofstr.", 0, 26, 56),
      ]),
    ]);
    const pieces = all(conv(snap([row])).screen.root).filter((e) => e.type === "text");
    const w = pieces.find((t) => t.text?.startsWith("Wilhelminen"))!;
    expect(w.text).toBe("Wilhelminen-");
    expect(w.meta).toMatchObject({ softHyphen: true });
    expect(pieces.find((t) => t.text === "hofstr.")?.meta?.softHyphen).toBeUndefined();
  });

  it("keeps gradient text (a transparent fill over a background clipped to the text)", () => {
    const h = box("h1", [0, 0, 600, 63], {}, [
      text("Watch IBM TechXchange live", [line("Watch IBM TechXchange live", 0, 4, 560)], {
        color: "rgba(0, 0, 0, 0)",
        clipBg: "linear-gradient(90deg, rgb(15, 98, 254), rgb(165, 110, 255))",
      }),
    ]);
    const t = find(conv(snap([h])).screen.root, (e) => e.type === "text")!;
    expect(t.style?.backgroundClip).toBe("text");
    expect(t.style?.fills?.[0]).toMatchObject({ type: "gradient" });
    expect(JSON.stringify(t.style?.fills)).toContain("15, 98, 254");
  });

  it("embeds images from the asset map and keeps object-fit / object-position", () => {
    const img = box("img", [0, 0, 400, 300], {
      kind: "img",
      src: "https://cdn.example.com/cat.jpg",
      natural: { w: 800, h: 600 },
      objectFit: "cover",
      objectPosition: "50% 0%",
      alt: "Katze",
    });
    const { screen } = conv(
      snap([img], { assets: { "https://cdn.example.com/cat.jpg": "data:image/webp;base64,AAAA" } }),
    );
    const el = find(screen.root, (e) => e.type === "image")!;
    expect(el.image).toEqual({ src: "data:image/webp;base64,AAAA", alt: "Katze" });
    expect(el.style).toMatchObject({ fit: "cover", radius: 0, objectPosition: ["50%", "0%"] });
    expect(el.name).toBe("Katze");
    expect(el.image?.query).toBeUndefined();
  });

  it("turns a CSS cover background into an image layer under the content", () => {
    const hero = box(
      "section",
      [0, 0, 1000, 400],
      {
        style: {
          bgLayers: [
            {
              image: "https://cdn.example.com/hero.jpg",
              url: true,
              size: "cover",
              position: "50% 50%",
              repeat: "no-repeat",
            },
          ],
        },
      },
      [
        box("h1", [40, 300, 400, 40], {}, [
          text("Hallo", [line("Hallo", 40, 310, 80)], { size: 32, lineHeight: 40 }),
        ]),
      ],
    );
    const sec = find(conv(snap([hero])).screen.root, (e) => !!e.name?.startsWith("Section"))!;
    expect(sec.name).toBe("Section · Hallo");
    expect(sec.children?.[0]).toMatchObject({
      type: "image",
      name: "Background image",
      style: { fit: "cover" },
    });
    expect(sec.children?.[1]?.type).toBe("text");
  });

  it("drops an empty, unpainted fixed landmark (an idle modal host) that would cover the header", () => {
    const header = box("header", [0, 0, 1000, 64], { style: { bg: "rgb(255, 255, 255)" } }, [
      box("button", [900, 16, 60, 32], {}, [text("Menu", [line("Menu", 906, 22, 40)])]),
    ]);
    const host = box(
      "section",
      [0, 0, 1000, 800],
      { layout: { display: "block", position: "fixed" }, style: { overflow: ["hidden", "hidden"] } },
      [box("div", [0, 0, 1000, 0])],
    );
    const root = conv(snap([header, host])).screen.root;
    expect(all(root).filter((e) => e.name === "Section")).toHaveLength(0);
    expect(find(root, (e) => e.type === "button")).toBeTruthy();
    // an in-flow empty section still holds its place
    expect(
      all(conv(snap([box("section", [0, 0, 1000, 200])])).screen.root).filter((e) => e.name === "Section"),
    ).toHaveLength(1);
  });

  it("paints a positioned overlay above the static image of a collapsed positioned wrapper", () => {
    const wrap = box("div", [0, 0, 1000, 400], { layout: { display: "block", position: "relative" } }, [
      box("div", [0, 0, 1000, 400], {
        layout: { display: "block", position: "absolute" },
        style: {
          bgLayers: [
            {
              image: "linear-gradient(90deg, rgb(0, 0, 0) 10%, rgba(0, 0, 0, 0) 60%)",
              url: false,
              size: "auto",
              position: "0% 0%",
              repeat: "repeat",
            },
          ],
        },
      }),
      box("div", [0, 0, 1000, 400], {}, [
        box("img", [0, 0, 1000, 400], {
          kind: "img",
          src: "https://x/car.jpg",
          natural: { w: 2000, h: 800 },
          objectFit: "cover",
        }),
      ]),
    ]);
    const kids = all(conv(snap([wrap])).screen.root).filter((e) => e.type === "image" || e.style?.fills);
    expect(kids.map((e) => e.type)).toEqual(["image", "frame"]);
    expect(kids[1]!.style?.fills?.[0]).toMatchObject({
      type: "gradient",
      angle: 90,
      stops: [
        { color: "rgb(0, 0, 0)", pos: 0.1 },
        { color: "rgba(0, 0, 0, 0)", pos: 0.6 },
      ],
    });
  });

  it("builds buttons from painted links, with the look taken from the page", () => {
    const a = box(
      "a",
      [20, 20, 232, 52],
      {
        attrs: { href: "https://example.com/konfig" },
        style: {
          bg: "rgb(28, 105, 212)",
          radius: [3, 3, 3, 3],
          shadow: "rgb(242, 242, 242) 0px 0px 0px 1px inset",
        },
        layout: { display: "inline-flex", position: "static" },
      },
      [
        box("span", [76, 34, 120, 24], { layout: { display: "inline", position: "static" } }, [
          text("Konfigurieren", [line("Konfigurieren", 76, 36.5, 120)], { color: "rgb(255, 255, 255)" }),
        ]),
      ],
    );
    const b = find(conv(snap([a]), true).screen.root, (e) => e.type === "button")!;
    expect(b.name).toBe("Button · Konfigurieren");
    expect(b.variant).toBe("ghost");
    expect(b.style).toMatchObject({
      background: "rgb(28, 105, 212)",
      radius: 3,
      shadows: [{ x: 0, y: 0, blur: 0, spread: 1, inset: true, color: "rgb(242, 242, 242)" }],
    });
    expect(b.interaction).toEqual({ onTap: "open-url", url: "https://example.com/konfig" });
    // the label is centred: auto layout reproduces it
    expect(b.layout).toMatchObject({ direction: "row", align: "center", justify: "center" });
    expect(b.children?.[0]?.layout?.position).toBeUndefined();
  });

  it("infers a row auto layout only when every child lines up", () => {
    const chips = (xs: number[]) =>
      box(
        "nav",
        [0, 0, 600, 40],
        { style: { bg: "rgb(240, 240, 240)" } },
        xs.map((x) => box("div", [x, 8, 100, 24], { style: { bg: "rgb(0, 0, 0)" } })),
      );
    const ok = find(conv(snap([chips([10, 126, 242])]), true).screen.root, (e) => e.name === "Nav")!;
    expect(ok.layout).toMatchObject({
      direction: "row",
      gap: 16,
      padding: [0, 0, 0, 10],
      align: "center",
      justify: "start",
    });
    expect(ok.children?.every((c) => c.layout?.position === undefined && c.layout?.width === 100)).toBe(true);
    // an uneven spacing becomes a margin on that child
    const uneven = find(conv(snap([chips([10, 126, 250])]), true).screen.root, (e) => e.name === "Nav")!;
    expect(uneven.layout).toMatchObject({ direction: "row", gap: 16 });
    expect(uneven.children?.[2]?.layout?.margin).toEqual([0, 0, 0, 8]);
    // overlapping children cannot be a flex line: they stay absolute
    const off = find(conv(snap([chips([10, 60, 250])]), true).screen.root, (e) => e.name === "Nav")!;
    expect(off.layout?.direction).toBeUndefined();
    expect(off.children?.[2]?.layout).toMatchObject({ position: "absolute", x: 250 });
  });

  it("keeps a flex item holding several layers as one group, so its parent flows (a teaser: image, text column, arrow)", () => {
    const teaser = box(
      "a",
      [0, 0, 400, 104],
      {
        attrs: { href: "/x" },
        style: { bg: "rgb(255, 255, 255)" },
        layout: { display: "flex", position: "static", padding: [16, 24, 16, 24] },
      },
      [
        box("img", [24, 16, 72, 72], { kind: "img", src: "https://x/t.png", natural: { w: 72, h: 72 } }),
        box("div", [128, 30, 200, 44], { layout: { display: "block", position: "static" } }, [
          box("p", [128, 30, 200, 20], {}, [
            text("Download Netzpläne", [line("Download Netzpläne", 128, 30, 150)], {
              size: 16,
              lineHeight: 20,
            }),
          ]),
          box("p", [128, 56, 200, 18], {}, [
            text("S-Bahn, U-Bahn", [line("S-Bahn, U-Bahn", 128, 56, 110)], { size: 14, lineHeight: 18 }),
          ]),
        ]),
        box("svg", [352, 40, 24, 24], {
          kind: "svg",
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 12h24"/></svg>',
        }),
      ],
    );
    const a = find(conv(snap([teaser]), true).screen.root, (e) => e.type === "button")!;
    expect(a.layout).toMatchObject({ direction: "row" });
    expect(a.children?.map((c) => c.type)).toEqual(["image", "frame", "icon"]);
    expect(a.children?.every((c) => c.layout?.position === undefined)).toBe(true);
    expect(a.children?.[1]?.layout).toMatchObject({ direction: "column" });
    // laid out as a plain block (no flex parent), the wrapper stays one box too (flow first: its texts are a column
    // of their own, not lines among its siblings')
    const block = { ...teaser, layout: { display: "block", position: "static" as const } };
    const b = find(conv(snap([block]), true).screen.root, (e) => e.type === "button")!;
    const col = b.children?.find((c) => c.type === "frame");
    expect(col?.children?.filter((c) => c.type === "text")).toHaveLength(2);
    // fitted: it collapses, as before
    const f = find(fitted(snap([block]), true).screen.root, (e) => e.type === "button")!;
    expect(f.children?.filter((c) => c.type === "text")).toHaveLength(2);
  });

  it("a growing flex item fills the room before its neighbour; a layer the page positions keeps to its corner", () => {
    const row = (textW: number) =>
      box(
        "a",
        [0, 0, 400, 80],
        {
          attrs: { href: "/x" },
          style: { bg: "rgb(255, 255, 255)" },
          layout: { display: "flex", position: "static", padding: [0, 16, 0, 16] },
        },
        [
          box("img", [16, 16, 48, 48], { kind: "img", src: "https://x/t.png", natural: { w: 48, h: 48 } }),
          box("div", [80, 20, textW, 40], { layout: { display: "block", position: "static", grow: 1 } }, [
            box("p", [80, 20, textW, 20], {}, [
              text("Titel", [line("Titel", 80, 20, 40)], { lineHeight: 20 }),
            ]),
            box("p", [80, 40, textW, 20], {}, [text("Text", [line("Text", 80, 40, 30)], { lineHeight: 20 })]),
          ]),
          box("svg", [360, 28, 24, 24], {
            kind: "svg",
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 12h24"/></svg>',
          }),
          box("span", [372, 64, 12, 12], {
            style: { bg: "rgb(255, 0, 0)" },
            layout: { display: "block", position: "absolute" },
          }),
        ],
      );
    const a = find(conv(snap([row(264)]), true).screen.root, (e) => e.type === "button")!;
    const [, col, icon] = a.children!.filter((c) => c.layout?.position !== "absolute");
    expect(col!.layout?.width).toBe("fill");
    expect(icon!.layout?.margin).toBeUndefined();
    // the dot the page positions in the corner: from the right / bottom edges
    const dot = a.children!.find((c) => c.layout?.position === "absolute")!;
    expect(dot.layout).toMatchObject({ right: 16, bottom: 4 });
    expect(dot.layout?.x).toBeUndefined();
  });

  it("a slider track moved by transform keeps its raised slide inside it (the arrows beside the track stay on top)", () => {
    const slide = box(
      "div",
      [0, 0, 400, 300],
      { style: { bg: "rgb(0, 124, 186)" }, layout: { display: "block", position: "relative", z: 4 } },
      [text("Slide", [line("Slide", 10, 10, 40)])],
    );
    const track = box(
      "div",
      [0, 0, 400, 300],
      {
        style: { transform: "matrix(1, 0, 0, 1, 0, 0)" } as SnapElement["style"],
        layout: { display: "block", position: "relative" },
      },
      [slide],
    );
    const nav = box("div", [340, 250, 40, 40], {
      style: { bg: "rgb(255, 255, 255)" },
      layout: { display: "block", position: "absolute", z: 2 },
    });
    const root = conv(
      snap([
        box("div", [0, 0, 400, 300], { layout: { display: "block", position: "relative" } }, [track, nav]),
      ]),
    ).screen.root;
    const t = find(
      root,
      (e) => e.children?.some((c) => c.style?.background === "rgb(0, 124, 186)") ?? false,
    )!;
    expect(t.layout?.z).toBe(0);
  });

  it('a background "image" that is the page itself (an empty url() resolved against it) is dropped', () => {
    const p = box(
      "div",
      [0, 0, 400, 100],
      {
        style: {
          bg: "rgb(250, 250, 250)",
          bgLayers: [
            { image: "https://example.com/", url: true, size: "auto", position: "0% 0%", repeat: "repeat" },
          ],
        } as SnapElement["style"],
      },
      [text("Copy", [line("Copy", 10, 10, 40)])],
    );
    const root = conv(snap([p])).screen.root;
    expect(JSON.stringify(root)).not.toContain("url(https://example.com/)");
    expect(all(root).some((e) => e.style?.fills?.some((f) => f.type === "image"))).toBe(false);
    expect(all(root).some((e) => e.type === "image")).toBe(false);
  });

  it("a raised wrapper around a fixed header is not kept as a box (the export pins the header to the viewport)", () => {
    const head = box(
      "div",
      [0, 0, 400, 49],
      { style: { bg: "rgb(15, 98, 254)" }, layout: { display: "block", position: "fixed", z: 1 } },
      [text("IBM", [line("IBM", 10, 10, 40)])],
    );
    const wrap = box("div", [0, 0, 400, 49], { layout: { display: "block", position: "absolute", z: 900 } }, [
      head,
    ]);
    const root = conv(snap([wrap, box("div", [0, 49, 400, 700], { style: { bg: "rgb(240, 240, 240)" } })]))
      .screen.root;
    const h = find(root, (e) => e.style?.background === "rgb(15, 98, 254)")!;
    expect(h.layout?.scrollBehavior).toBe("fixed");
    // no raised box of its own around it
    expect(all(root).some((e) => e !== root && e.children?.includes(h))).toBe(false);
  });

  it("a big box a reveal clip hides completely is captured revealed; a partial clip and a screen-reader clip stay", () => {
    const pic = (id: string, rect: [number, number, number, number], clipPath: string) =>
      box("div", rect, { style: { bg: "rgb(0, 124, 186)", clipPath } as SnapElement["style"] }, [
        box("img", rect, { kind: "img", src: `https://x/${id}.jpg`, natural: { w: 800, h: 400 } }),
      ]);
    const root = conv(
      snap([
        pic("a", [0, 0, 800, 400], "inset(0px 100% 100% 0px round 0px 0px 80px)"),
        pic("b", [0, 400, 800, 400], "inset(0px 0px 0px 50%)"),
        pic("c", [0, 800, 1, 1], "inset(50%)"),
      ]),
    ).screen.root;
    const clips = all(root)
      .filter((e) => e.style?.background === "rgb(0, 124, 186)")
      .map((e) => e.style?.clipPath ?? null);
    expect(clips).toEqual([null, "inset(0px 0px 0px 50%)", "inset(50%)"]);
  });

  it("a row with equal insets whose item grows keeps the insets as padding (nothing to centre)", () => {
    const card = box(
      "div",
      [100, 100, 704, 226],
      {
        style: { bg: "rgb(255, 255, 255)" },
        layout: { display: "flex", position: "static", padding: [16, 16, 16, 16] },
      },
      [
        box("div", [116, 117, 408, 192], { layout: { display: "block", position: "static", grow: 1 } }, [
          box("p", [116, 117, 300, 20], {}, [
            text("Titel", [line("Titel", 116, 117, 40)], { lineHeight: 20 }),
          ]),
          box("div", [116, 250, 200, 42], { style: { bg: "rgb(240, 215, 34)" } }),
        ]),
        box("img", [548, 117, 240, 192], {
          kind: "img",
          src: "https://x/p.png",
          natural: { w: 240, h: 192 },
        }),
      ],
    );
    const root = conv(snap([box("div", [0, 0, 1000, 800], {}, [card])]), true).screen.root;
    const c = find(root, (e) => e.style?.background === "rgb(255, 255, 255)" && e.children?.length === 2)!;
    expect(c.layout).toMatchObject({ direction: "row", justify: "start" });
    expect(c.layout?.padding).toEqual([1, 16, 1, 16].map((v, i) => (i % 2 ? v : expect.any(Number))));
    expect(c.children![0]!.layout?.width).toBe("fill");
  });

  it("a flow as tall as its content on the page hugs it (it grows where the text wraps onto more lines)", () => {
    const col = (padBottom: number) =>
      box(
        "div",
        [0, 0, 300, 100],
        {
          style: { bg: "rgb(240, 240, 240)" },
          layout: { display: "block", position: "static", padding: [10, 0, padBottom, 0] },
        },
        [
          box("p", [0, 10, 300, 20], {}, [text("Eins", [line("Eins", 0, 10, 40)], { lineHeight: 20 })]),
          box("p", [0, 40, 300, 20], {}, [text("Zwei", [line("Zwei", 0, 40, 40)], { lineHeight: 20 })]),
        ],
      );
    const hug = find(conv(snap([col(40)]), true).screen.root, (e) => e.layout?.direction === "column")!;
    expect(hug.layout).toMatchObject({ height: "hug", padding: [10, 0, 40, 0] });
    // a fixed height (more room below than its padding): it keeps it
    const fixed = find(conv(snap([col(0)]), true).screen.root, (e) => e.layout?.direction === "column")!;
    expect(fixed.layout?.height).toBe(100);
    // side by side in a row (equal cards): each keeps its height (the row's), inside them the flow stays
    const card = (x: number) =>
      box(
        "div",
        [x, 0, 300, 100],
        {
          style: { bg: "rgb(240, 240, 240)" },
          layout: { display: "block", position: "static", padding: [10, 0, 40, 0] },
        },
        [
          box("p", [x, 10, 300, 20], {}, [text("Eins", [line("Eins", x, 10, 40)], { lineHeight: 20 })]),
          box("p", [x, 40, 300, 20], {}, [text("Zwei", [line("Zwei", x, 40, 40)], { lineHeight: 20 })]),
        ],
      );
    const row = box("section", [0, 0, 640, 100], { layout: { display: "flex", position: "static" } }, [
      card(0),
      card(340),
    ]);
    // flow first: equally tall in their line, they stretch to it and are as tall as their content
    const flowRoot = conv(snap([row]), true).screen.root;
    const cards = all(flowRoot).filter((e) => e.layout?.direction === "column");
    expect(cards.map((c) => [c.layout?.height, c.layout?.padding])).toEqual([
      [undefined, [10, 0, 40, 0]],
      [undefined, [10, 0, 40, 0]],
    ]);
    expect(
      find(flowRoot, (e) => e.layout?.direction === "row" && e.children?.length === 2)?.layout?.align,
    ).toBe("stretch");
    // fitted: each keeps its height (the row's), inside them the flow stays
    const fixedCards = all(fitted(snap([row]), true).screen.root).filter(
      (e) => e.layout?.direction === "column",
    );
    expect(fixedCards.map((c) => [c.layout?.height, c.layout?.padding])).toEqual([
      [100, [10, 0, 0, 0]],
      [100, [10, 0, 0, 0]],
    ]);
  });

  it("draws list bullets and icon-font glyphs", () => {
    const li = box("li", [40, 0, 400, 24], { layout: { display: "list-item", position: "static" } }, [
      {
        id: id++,
        kind: "marker",
        tag: "li",
        shape: "disc",
        color: "rgb(0, 0, 0)",
        rect: { x: 29, y: 9, w: 5, h: 5 },
      } as SnapElement,
      text("Eintrag", [line("Eintrag", 40, 2, 60)]),
      box("i", [110, 2, 20, 20], { layout: { display: "inline", position: "static" } }, [
        text("close", [line("close", 110, 2, 20)], {
          family: "bmw_next_icons",
          size: 20,
          lineHeight: 20,
          ascent: 16,
        }),
      ]),
    ]);
    const { screen } = conv(snap([li]));
    expect(find(screen.root, (e) => e.name === "Bullet")?.style).toMatchObject({
      background: "rgb(0, 0, 0)",
      radius: 2.5,
    });
    const icon = find(screen.root, (e) => e.type === "icon")!;
    expect(icon.name).toBe("Icon · close");
    expect(icon.svg).toContain('font-family="bmw_next_icons"');
    expect(icon.svg).toContain(">close</text>");
    expect(find(screen.root, (e) => e.type === "text")?.text).toBe("Eintrag");
  });

  it("turns inputs into a frame with the placeholder in its colour", () => {
    const input = box("input", [0, 0, 300, 48], {
      kind: "input",
      style: { bg: "rgb(255, 255, 255)" },
      layout: {
        display: "inline-block",
        position: "static",
        padding: [0, 12, 0, 12],
        borderWidth: [1, 1, 1, 1],
      },
      input: {
        type: "text",
        value: "",
        placeholder: "Start",
        placeholderColor: "rgb(110, 110, 110)",
        font: font(),
        multiline: false,
      },
    });
    const f = find(conv(snap([input])).screen.root, (e) => e.meta?.role === "input")!;
    expect(f.name).toBe("Input · Start");
    expect(f.children?.[0]).toMatchObject({
      type: "text",
      text: "Start",
      name: "Placeholder",
      style: { color: "rgb(110, 110, 110)" },
      layout: { x: 13, y: 12 },
    });
  });

  it("returns the page webfonts as project fonts and design-system hints", () => {
    const woff2 = `data:font/woff2;base64,${btoa("wOF2" + "\0".repeat(40))}`;
    const res = conv(
      snap([box("p", [0, 0, 200, 24], {}, [text("Hallo", [line("Hallo", 0, 2, 40)])])], {
        embeddedFonts: [
          { family: "Transit", weight: "400", style: "normal", src: woff2 },
          { family: "Unused", weight: "400", style: "normal", src: woff2 },
        ],
      }),
    );
    expect(res.fonts.map((f) => [f.family, f.weight, f.origin])).toEqual([["Transit", "400", "import"]]);
    expect(res.designSystemHints).toMatchObject({
      fontFamily: "Transit",
      background: "rgb(255, 255, 255)",
      theme: "light",
      text: "rgb(37, 37, 37)",
    });
  });
});

describe("css helpers", () => {
  it("parses computed gradients", () => {
    expect(parseGradient("linear-gradient(rgba(0, 0, 0, 0) 0%, rgb(0, 0, 0) 100%)")).toEqual({
      kind: "linear",
      stops: [
        { color: "rgba(0, 0, 0, 0)", pos: 0 },
        { color: "rgb(0, 0, 0)", pos: 1 },
      ],
    });
    expect(parseGradient("linear-gradient(to right, red, blue)")).toMatchObject({
      angle: 90,
      stops: [{ color: "red" }, { color: "blue" }],
    });
    expect(parseGradient("linear-gradient(to top right, red, blue)", { w: 100, h: 100 })?.angle).toBe(45);
    expect(
      parseGradient("radial-gradient(circle at 50% 0%, rgb(255, 255, 255) 0%, rgba(0, 0, 0, 0) 70%)"),
    ).toMatchObject({ kind: "radial", shape: "circle", at: ["50%", "0%"] });
    expect(parseGradient("url(x.png)")).toBeNull();
  });

  it("parses shadows, rotations and class names", () => {
    expect(
      parseShadows("rgba(0, 0, 0, 0.16) 0px 5px 40px 0px, rgb(242, 242, 242) 0px 0px 0px 1px inset"),
    ).toEqual([
      { x: 0, y: 5, blur: 40, color: "rgba(0, 0, 0, 0.16)" },
      { x: 0, y: 0, blur: 0, spread: 1, color: "rgb(242, 242, 242)", inset: true },
    ]);
    expect(parseShadows("rgba(0, 0, 0, 0) 0px 1px 2px 0px")).toEqual([]);
    expect(rotationOf("matrix(0, 1, -1, 0, 0, 0)")).toBe(90);
    expect(rotationOf("matrix(1, 0, 0, 1, 0, -1.92)")).toBe(0);
    expect(prettyClass("Header_navbar__axVCt grid")).toBe("Navbar");
    expect(prettyClass("_BdsIcon_r2bqw_2")).toBe("Bds Icon");
    expect(prettyClass("cmp-list__item-link")).toBe("List item link");
    expect(prettyClass("InfoAnnouncement_InfoAnnouncementBox___jY63")).toBe("Info Announcement Box");
    expect(prettyClass("container-9e7008e1f8 responsivegrid")).toBe("Container");
  });
});

describe("auto layout inference", () => {
  it("builds a grid of equal cells and keeps page-absolute overlays absolute", () => {
    const cell = (x: number, y: number) =>
      box("article", [x, y, 200, 120], { style: { bg: "rgb(255, 255, 255)" } });
    const overlay = box("div", [0, 0, 700, 400], {
      layout: { display: "block", position: "absolute" },
      style: { bg: "rgba(0, 0, 0, 0.1)" },
    });
    const wrap = box("section", [0, 0, 700, 400], { style: { bg: "rgb(240, 240, 240)" } }, [
      overlay,
      cell(20, 30),
      cell(244, 30),
      cell(468, 30),
      cell(20, 174),
      cell(244, 174),
    ]);
    const sec = find(conv(snap([wrap]), true).screen.root, (e) => !!e.name?.startsWith("Section"))!;
    expect(sec.layout?.grid).toEqual({ columns: ["200px", "200px", "200px"], columnGap: 24, rowGap: 24 });
    expect(sec.layout?.padding).toEqual([30, 0, 0, 20]);
    // the positioned overlay paints above the static cells and stays absolute
    expect(sec.children?.[5]?.layout).toMatchObject({ position: "absolute", x: 0, y: 0 });
    expect(sec.children?.slice(0, 5).every((c) => c.layout?.position === undefined)).toBe(true);
  });

  it("aligns odd children with alignSelf and pins buttons in columns", () => {
    const col = box("div", [0, 0, 400, 300], { style: { bg: "rgb(250, 250, 250)" } }, [
      box("div", [100, 20, 200, 40], { style: { bg: "rgb(0, 0, 0)" } }),
      box("div", [100, 80, 200, 40], { style: { bg: "rgb(0, 0, 0)" } }),
      box("div", [0, 140, 120, 40], { style: { bg: "rgb(0, 0, 0)" } }),
      box("button", [140, 200, 120, 40], { style: { bg: "rgb(0, 0, 255)" } }),
    ]);
    const f = find(conv(snap([col]), true).screen.root, (e) => e.layout?.direction === "column")!;
    expect(f.layout).toMatchObject({ align: "center", gap: 20, padding: [20, 0, 0, 0] });
    expect(f.children?.[2]?.layout?.alignSelf).toBe("start");
    expect(f.children?.[3]).toMatchObject({ type: "button", layout: { alignSelf: "center" } });
  });
});

describe("auto layout keeps the captured positions", () => {
  const kidsAt = (el: SceneElement) => el.children!.map((c) => c.layout);

  it("never emits a negative padding for a child a hair outside the box", () => {
    const ul = box(
      "ul",
      [0, 0, 336, 72],
      { style: { bg: "rgb(250, 250, 250)" } },
      [0, 1, 2].map((i) => box("li", [24, -0.32 + i * 26, 130, 18], { style: { bg: "rgb(0, 0, 0)" } })),
    );
    const f = find(conv(snap([ul]), true).screen.root, (e) => e.layout?.direction === "column")!;
    expect(f.layout?.padding).toEqual([0, 0, 0, 24]);
  });

  it("aligns each child the way that reproduces it best and splits offsets between children sharing a line", () => {
    // a 21.6px label centred at 34 (also 0.8px off the start line); the 12px icon centred at 35
    const row = box("div", [0, 0, 1008, 45.59], { style: { bg: "rgb(250, 250, 250)" } }, [
      box("span", [24, 23.2, 300, 21.6], { style: { bg: "rgb(0, 0, 0)" } }),
      box("i", [366.48, 29, 12, 12], { style: { bg: "rgb(255, 0, 0)" } }),
    ]);
    const f = find(conv(snap([row]), true).screen.root, (e) => e.layout?.direction === "row")!;
    expect(f.layout?.align).toBe("center");
    // the centre line sits between the two (34.5, 0.5 off each, not 0 and 1); the label then reproduces better on the
    // start line (0.21 off) than centred: it takes alignSelf start instead of being snapped by the first rule that fits
    expect((f.layout?.padding as number[])[0]).toBeCloseTo(23.41, 2);
    expect(kidsAt(f).map((l) => l?.alignSelf)).toEqual(["start", undefined]);
  });

  it("corrects small extra spacing with margins before it adds up along a line", () => {
    const col = box(
      "div",
      [0, 0, 200, 400],
      { style: { bg: "rgb(250, 250, 250)" } },
      [0, 1, 2, 3].map((i) => box("div", [0, i * 40.4, 200, 24], { style: { bg: "rgb(0, 0, 0)" } })),
    );
    const f = find(conv(snap([col]), true).screen.root, (e) => e.layout?.direction === "column")!;
    expect(f.layout?.gap).toBe(16.4);
    expect(kidsAt(f).every((l) => !l?.margin)).toBe(true);
    // gaps 16, 16.4, 16.8: the third child would drift by 0.8 with a plain 16px gap
    const uneven = box(
      "div",
      [0, 0, 200, 400],
      { style: { bg: "rgb(250, 250, 250)" } },
      [0, 40, 80.4, 121.2].map((y) => box("div", [0, y, 200, 24], { style: { bg: "rgb(0, 0, 0)" } })),
    );
    const g = find(conv(snap([uneven]), true).screen.root, (e) => e.layout?.direction === "column")!;
    expect(g.layout?.gap).toBe(16);
    expect(kidsAt(g).map((l) => (l?.margin as number[] | undefined)?.[0] ?? 0)).toEqual([0, 0, 0.4, 0.8]);
  });

  it("keeps no wrap hints on single-line labels", () => {
    const h = box("h3", [0, 0, 600, 31], {}, [
      text("Sofort und überall programmieren", [line("Sofort und überall programmieren", 0, 0, 351)], {
        size: 22,
        lineHeight: 30.8,
        textWrap: "balance",
        hyphens: "auto",
      }),
    ]);
    // fitted: one line that never wraps
    const t = find(fitted(snap([h])).screen.root, (e) => e.type === "text")!;
    expect(t.style?.whiteSpace).toBe("pre");
    expect(t.style?.textWrap).toBeUndefined();
    expect(t.style?.hyphens).toBeUndefined();
    // flow first: a heading with room left on its line wraps as the page's does (its wrap hints kept)
    const f = find(conv(snap([h])).screen.root, (e) => e.type === "text")!;
    expect(f.style?.whiteSpace).toBeUndefined();
    expect(f.layout?.width).toBe(600);
    expect(f.style?.textWrap).toBe("balance");
    // a label as wide as its line (an inline-block button) keeps its line
    const btn = box("a", [0, 0, 120, 20], { layout: { display: "inline-block", position: "static" } }, [
      text("Mehr erfahren", [line("Mehr erfahren", 0, 0, 120)]),
    ]);
    expect(find(conv(snap([btn])).screen.root, (e) => e.type === "text")!.style?.whiteSpace).toBe("pre");
    // and so does text the page keeps from wrapping
    const nowrap = box(
      "p",
      [0, 0, 600, 20],
      { layout: { display: "block", position: "static", whiteSpace: "nowrap" } },
      [text("Eins zwei", [line("Eins zwei", 0, 0, 80)])],
    );
    expect(find(conv(snap([nowrap])).screen.root, (e) => e.type === "text")!.style?.whiteSpace).toBe("pre");
  });
});

describe("wave 4 styles", () => {
  it("keeps CSS mask icons as recolourable masked layers", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 12h20"/></svg>';
    const icon = box("span", [10, 10, 26, 14], {
      style: {
        bg: "rgb(37, 37, 37)",
        mask: {
          image: "https://x/arrow.svg",
          url: true,
          size: "contain",
          position: "50% 50%",
          repeat: "no-repeat",
        },
      },
      layout: { display: "inline-block", position: "static" },
    });
    const fade = box("div", [0, 100, 300, 50], {
      style: {
        bg: "rgb(0, 0, 0)",
        mask: {
          image: "linear-gradient(rgb(0, 0, 0), rgba(0, 0, 0, 0))",
          url: false,
          size: "auto",
          position: "0% 0%",
          repeat: "repeat",
        },
      },
    });
    const { screen } = conv(
      snap([icon, fade], { assets: { "https://x/arrow.svg": `data:image/svg+xml;base64,${btoa(svg)}` } }),
    );
    const i = find(screen.root, (e) => !!e.style?.maskImage?.svg)!;
    expect(i.style).toMatchObject({
      background: "rgb(37, 37, 37)",
      maskImage: { svg, size: "contain", repeat: "no-repeat" },
    });
    expect(find(screen.root, (e) => !!e.style?.maskImage?.gradient)?.style?.maskImage).toMatchObject({
      gradient: { kind: "linear" },
      repeat: "repeat",
    });
  });

  it("keeps balanced headings reflowable, the page fallbacks, hyphenation and the page language", () => {
    const p = box("h2", [0, 0, 400, 48], {}, [
      text(
        "Das Deutschlandticket für sehr wenig Mäuse.",
        [line("Das Deutschlandticket", 0, 2, 170, "space"), line("für sehr wenig Mäuse.", 0, 26, 165)],
        {
          textWrap: "balance",
          hyphens: "auto",
          stack: "Transit, Arial, sans-serif, Arial, Helvetica, sans-serif",
        },
      ),
    ]);
    const { screen } = conv(snap([p], { lang: "de" }));
    const t = find(screen.root, (e) => e.type === "text")!;
    expect(t.text).toBe("Das Deutschlandticket für sehr wenig Mäuse.");
    expect(t.style).toMatchObject({
      textWrap: "balance",
      hyphens: "auto",
      fontFamily: "Transit, Arial, sans-serif, Helvetica",
    });
    expect(screen.lang).toBe("de");
  });

  it("paints a negative z-index ::before under the background of a box that is no stacking context", () => {
    const card = (o: Partial<SnapElement>) =>
      box(
        "div",
        [100, 100, 400, 200],
        {
          layout: { display: "flex", position: "relative" },
          style: { bg: "rgb(255, 255, 255)", radius: [8, 8, 8, 8] },
          ...o,
        },
        [
          box("span", [140, 60, 400, 300], {
            pseudo: "before",
            layout: { display: "block", position: "absolute", z: -1 },
            style: { bg: "rgb(243, 243, 243)" },
          }),
          box("h3", [120, 120, 200, 24], {}, [text("Titel", [line("Titel", 120, 122, 40)])]),
        ],
      );
    // position: relative without z-index: the grey layer leaves the card and is painted before it
    const flat = conv(snap([card({})]), true).screen.root;
    const grey = find(flat, (e) => e.style?.background === "rgb(243, 243, 243)")!;
    const white = find(flat, (e) => e.meta?.tag === "div")!;
    expect(white.children?.some((c) => c.id === grey.id)).toBe(false);
    const siblings = all(flat).find((e) => e.children?.some((c) => c.id === white.id))!.children!;
    expect(siblings.findIndex((c) => c.id === grey.id)).toBeLessThan(
      siblings.findIndex((c) => c.id === white.id),
    );
    expect(grey.layout).toMatchObject({ position: "absolute", x: 140, y: 60 });
    // the card stays an auto-layout frame around its title; the grey layer never joins a flow
    expect(white.children?.map((c) => c.type)).toEqual(["text"]);
    // with a z-index (or a transform, opacity…) the card is a stacking context: the layer stays inside, under the title
    const ctxCard = conv(snap([card({ layout: { display: "flex", position: "relative", z: 0 } })])).screen
      .root;
    const inside = find(ctxCard, (e) => e.meta?.tag === "div")!;
    expect(inside.children?.map((c) => c.style?.background ?? c.type)).toEqual([
      "rgb(243, 243, 243)",
      "text",
    ]);
  });

  it("lifts a positive z-index layer out of a static landmark only where an outside layer would otherwise cover it", () => {
    // <main> (static, no stacking context) holds a z: 399 hero; its sibling overlay (fixed, z: 398) overlaps the hero top
    const hero = box(
      "header",
      [0, 0, 1000, 640],
      { layout: { display: "block", position: "relative", z: 399 }, style: { bg: "rgb(0, 128, 0)" } },
      [box("h1", [100, 300, 400, 40], {}, [text("Hero", [line("Hero", 100, 302, 80)])])],
    );
    const card = box("div", [0, 700, 400, 100], {
      layout: { display: "block", position: "relative", z: 1 },
      style: { bg: "rgb(0, 0, 255)" },
    });
    const main = box("main", [0, 0, 1000, 800], {}, [hero, card]);
    const overlay = box("div", [0, 0, 1000, 32], {
      layout: { display: "block", position: "fixed", z: 398 },
      style: { bg: "rgb(255, 255, 255)" },
    });
    const root = conv(snap([box("div", [0, 0, 1000, 800], { style: {} }, [main, overlay])])).screen.root;
    const order = (el: SceneElement) =>
      all(root)
        .find((e) => e.children?.some((c) => c.id === el.id))!
        .children!.map((c) => c.id);
    const heroEl = find(root, (e) => e.style?.background === "rgb(0, 128, 0)")!;
    const overlayEl = find(
      root,
      (e) => e.style?.background === "rgb(255, 255, 255)" && e.meta?.tag === "div",
    )!;
    const mainEl = find(root, (e) => e.meta?.tag === "main")!;
    // the hero now paints after (above) the overlay, next to it; the card no layer overlaps stays in <main>
    const siblings = order(overlayEl);
    expect(siblings.indexOf(heroEl.id)).toBeGreaterThan(siblings.indexOf(overlayEl.id));
    expect(mainEl.children?.map((c) => c.style?.background)).toEqual(["rgb(0, 0, 255)"]);
    expect(heroEl.layout).toMatchObject({ position: "absolute", x: 0, y: 0 });
  });

  it("keeps the z-index of a collapsed overlay wrapper on its content above a lower scrim", () => {
    // BMW's stage: a z: 10 gradient ::before over the video, the copy in a bare z: 20 wrapper (collapses) around a
    // transformed zone (kept)
    const scrim = box("span", [0, 0, 1000, 600], {
      pseudo: "before",
      layout: { display: "block", position: "absolute", z: 10 },
      style: {
        bgLayers: [
          {
            image: "linear-gradient(60deg, rgb(0, 0, 0), rgba(0, 0, 0, 0) 65%)",
            position: "0% 0%",
            repeat: "repeat",
            size: "auto",
            url: false,
          },
        ],
      },
    });
    const zone = box(
      "div",
      [96, 400, 800, 120],
      {
        layout: { display: "flex", dir: "column", position: "relative", stack: true },
        style: { transform: "matrix(1, 0, 0, 1, 0, 0)" },
      },
      [
        box("h2", [96, 400, 400, 50], {}, [text("Der neue", [line("Der neue", 96, 402, 200)])]),
        box("p", [96, 460, 400, 24], {}, [
          text("Starker Charakter.", [line("Starker Charakter.", 96, 462, 200)]),
        ]),
      ],
    );
    const overlay = box(
      "div",
      [0, 400, 1000, 200],
      { layout: { display: "block", position: "absolute", z: 20, stack: true } },
      [zone],
    );
    const stage = box(
      "div",
      [0, 0, 1000, 600],
      {
        layout: { display: "block", position: "relative" },
        style: { bg: "rgb(0, 0, 0)", overflow: ["hidden", "hidden"] },
      },
      [scrim, overlay],
    );
    const root = conv(snap([stage]), true).screen.root;
    const scrimEl = find(root, (e) => !!e.style?.fills?.length)!;
    const zoneEl = find(
      root,
      (e) => e.children?.some((c) => c.type === "text") === true && e.meta?.tag === "div",
    )!;
    expect(scrimEl.layout?.z).toBe(10);
    expect(zoneEl.layout?.z).toBe(20);
  });

  it("keeps a form above the opaque ::before backdrop of its card", () => {
    // BVG's connection form: the section's white card is an absolute z: auto ::before, the form a relative z: auto
    // sibling after it (painted on top); the backdrop is raised as an opaque panel, so the form must be raised with it
    const backdrop = box("span", [76, 476, 848, 122], {
      pseudo: "before",
      layout: { display: "block", position: "absolute" },
      style: { bg: "rgb(255, 255, 255)" },
    });
    const form = box("form", [100, 500, 800, 50], { layout: { display: "block", position: "relative" } }, [
      box("div", [100, 500, 300, 50], { style: { bg: "rgb(240, 240, 240)" } }),
      box("div", [500, 500, 300, 50], { style: { bg: "rgb(240, 240, 240)" } }),
    ]);
    const section = box(
      "section",
      [100, 500, 800, 74],
      {
        layout: { display: "block", position: "relative", z: 1, stack: true },
        style: { bg: "rgb(255, 255, 255)" },
      },
      [backdrop, form],
    );
    const root = conv(snap([section]), true).screen.root;
    const sec = find(root, (e) => e.meta?.tag === "section")!;
    const [b, f] = sec.children!;
    expect(b!.name).toBe("::before");
    expect(b!.layout?.z).toBe(1);
    expect(f!.layout?.z ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("clips children to the rounded corners of an overflow: hidden box", () => {
    const fig = (radius: number) =>
      box(
        "figure",
        [0, 0, 192, 96],
        {
          layout: { display: "block", position: "relative", borderWidth: [1, 1, 1, 1] },
          style: {
            border: [1, 1, 1, 1].map(() => ({ w: 1, style: "solid", color: "rgb(204, 204, 204)" })),
            radius: [radius, radius, radius, radius],
            overflow: ["hidden", "hidden"],
          },
        },
        [
          box("img", [1, 1, 190, 94], {
            kind: "img",
            src: "https://x/boat.jpg",
            natural: { w: 400, h: 225 },
            objectFit: "cover",
          }),
        ],
      );
    const rounded = find(conv(snap([fig(8)])).screen.root, (e) => e.meta?.tag === "figure")!;
    expect(rounded.layout?.clip).toBe(true);
    const square = find(conv(snap([fig(0)])).screen.root, (e) => e.meta?.tag === "figure")!;
    expect(square.layout?.clip).toBeUndefined();
    // a child well inside the corners needs no clip
    const inset = box(
      "div",
      [0, 0, 200, 100],
      { style: { bg: "rgb(0, 0, 0)", radius: [8, 8, 8, 8], overflow: ["hidden", "hidden"] } },
      [box("div", [20, 20, 160, 60], { style: { bg: "rgb(255, 0, 0)" } })],
    );
    expect(
      find(conv(snap([inset])).screen.root, (e) => e.style?.background === "rgb(0, 0, 0)")?.layout?.clip,
    ).toBeUndefined();
  });

  it("spaces lines at the measured pitch when the block line height exceeds the inline run", () => {
    // a 14px span with line-height 21 inside a block with line-height 24: the rows sit 24px apart
    const div = box("div", [0, 0, 212, 72], {}, [
      box("h3", [0, 0, 212, 24], {}, [
        text("BVG Fahrinfo-App", [line("BVG Fahrinfo-App", 0, 2.5, 120)], { weight: 700 }),
      ]),
      box("span", [0, 27.5, 193, 41], { layout: { display: "inline", position: "static" } }, [
        text(
          "Optimal für eine umfangreiche Fahrplanauskunft plus Ticketkauf.",
          [
            line("Optimal für eine umfangreiche", 0, 27.5, 175, "space"),
            line("Fahrplanauskunft plus Ticketkauf.", 0, 51.5, 193),
          ],
          { size: 14, lineHeight: 21 },
        ),
      ]),
    ]);
    const t = find(
      conv(snap([div])).screen.root,
      (e) => e.type === "text" && !!e.text?.startsWith("Optimal"),
    )!;
    expect(t.style?.lineHeightPx).toBe(24);
    expect(t.layout?.y).toBe(25);
    // mixed sizes: a 28px run (line-height 36) makes its line taller; the paragraph keeps its CSS line height (24)
    const p = box("p", [0, 100, 300, 60], {}, [
      box("strong", [0, 102, 60, 34], { layout: { display: "inline", position: "static" } }, [
        text("Groß", [line("Groß", 0, 102, 60)], { size: 28, lineHeight: 36 }),
      ]),
      text(" und dann wieder ganz klein weiter", [
        { ...line("und dann wieder", 64, 112, 120, "space") },
        line("ganz klein weiter", 0, 139, 130),
      ]),
    ]);
    const m = find(conv(snap([p])).screen.root, (e) => e.type === "text" && !!e.text?.includes("Groß"))!;
    expect(m.style?.lineHeightPx).toBe(24);
  });

  it("narrows the reflow width to the longest line when a word only just missed a line", () => {
    // "alles," (≈45px) did not fit after the 539px second line in the 586px column: at 587px it would be pulled up
    const p = box("p", [1046, 0, 586, 84], {}, [
      text(
        "Mit Original BMW Zubehör sowie passenden Serviceangeboten starten Sie perfekt vorbereitet in den goldenen Herbst. Entdecken Sie jetzt alles, was Ihren BMW noch besser macht.",
        [
          line("Mit Original BMW Zubehör sowie passenden Serviceangeboten starten", 1046, 2, 578.56, "space"),
          line(
            "Sie perfekt vorbereitet in den goldenen Herbst. Entdecken Sie jetzt",
            1046,
            30,
            539.31,
            "space",
          ),
          line("alles, was Ihren BMW noch besser macht.", 1046, 58, 339.7),
        ],
        { size: 18, lineHeight: 28 },
      ),
    ]);
    const t = find(
      fitted(
        snap([p], {
          page: {
            width: 1728,
            height: 800,
            background: "rgb(255, 255, 255)",
            color: "rgb(0, 0, 0)",
            font: "Transit",
          },
        }),
      ).screen.root,
      (e) => e.type === "text",
    )!;
    expect(t.text).not.toContain("\n");
    expect(t.layout).toMatchObject({ x: 1046, width: 580.56 });
    // centred text keeps its centre
    const c = box("p", [0, 0, 586, 84], {}, [
      text(
        "Eins zwei drei vier fünf sechs",
        [line("Eins zwei drei vier", 23, 2, 540, "space"), line("fünf sechs", 218, 30, 150)],
        { size: 18, lineHeight: 28, align: "center" },
      ),
    ]);
    const ct = find(fitted(snap([c])).screen.root, (e) => e.type === "text")!;
    expect(ct.layout).toMatchObject({ x: 22, width: 542 });
    expect(ct.style?.textAlign).toBe("center");
    // flow first: the text keeps its box's width (its margins are the page's at every width; it wraps there)
    const ft = find(conv(snap([c])).screen.root, (e) => e.type === "text")!;
    expect(ft.layout).toMatchObject({ x: 0, width: 586 });
  });

  it("maps outlines and basic clip-paths", () => {
    const b = box("div", [0, 0, 100, 100], {
      style: {
        bg: "rgb(255, 0, 0)",
        outline: { w: 2, color: "rgb(0, 0, 255)", offset: 3, style: "dashed" },
        clipPath: "circle(50% at 50% 50%)",
      },
    });
    expect(
      find(conv(snap([b])).screen.root, (e) => e.style?.background === "rgb(255, 0, 0)")?.style,
    ).toMatchObject({
      outline: { width: 2, color: "rgb(0, 0, 255)", style: "dashed", offset: 3 },
      clipPath: "circle(50% at 50% 50%)",
    });
  });
});

describe("line-clamped text", () => {
  const clampBox = (lines: SnapLine[], t: string) =>
    box(
      "div",
      [0, 0, 190, 40],
      { layout: { display: "flow-root", position: "static" }, style: { overflow: ["hidden", "hidden"] } },
      [text(t, lines, { lineHeight: 20, size: 14 })],
    );

  it("keeps glyph-by-glyph pieces of one line on one row and restores the clipped rest for the clamp", () => {
    // the clamped second line comes back one overlapping glyph box at a time; the capture stops at the clip
    const glyphs = "Runtime Security:"
      .split("")
      .map((ch, i, a): SnapLine => ({
        text: ch === " " ? "" : ch,
        x: i * 9,
        y: 20,
        w: 16,
        h: 18,
        brk: a[i + 1] === " " ? "space" : "word",
      }))
      .filter((l) => l.text);
    const t = find(
      conv(
        snap([
          clampBox(
            [line("On-Demand | Agentic", 0, 0, 142, "space"), ...glyphs],
            "On-Demand | Agentic Runtime Security: Kontrolle in einer Welt",
          ),
        ]),
      ).screen.root,
      (e) => e.type === "text",
    )!;
    expect(t.text).toBe("On-Demand | Agentic Runtime Security: Kontrolle in einer Welt");
    expect(t.style?.truncate).toBe(2);
    expect(t.layout).toMatchObject({ width: 190 });
  });

  it("clamps to the rows the box shows when hidden rows were captured below it", () => {
    const t = find(
      conv(
        snap([
          clampBox(
            [
              line("Squalan der seidige", 0, 0, 170, "space"),
              line("Schutzschild für deine", 0, 20, 180, "space"),
              line("Haut", 0, 40, 40),
            ],
            "Squalan der seidige Schutzschild für deine Haut",
          ),
        ]),
      ).screen.root,
      (e) => e.type === "text",
    )!;
    expect(t.text).toBe("Squalan der seidige Schutzschild für deine Haut");
    expect(t.style?.truncate).toBe(2);
  });

  it("leaves text that fits its clipping box alone", () => {
    const t = find(
      conv(
        snap([
          clampBox(
            [line("Formen, Vorteile &", 0, 0, 170, "space"), line("Routine", 0, 20, 60)],
            "Formen, Vorteile & Routine",
          ),
        ]),
      ).screen.root,
      (e) => e.type === "text",
    )!;
    expect(t.style?.truncate).toBeUndefined();
  });
});

describe("fluid intent", () => {
  const W = 1000;
  const page = (children: SnapNode[]) =>
    snap(children, {
      page: {
        width: W,
        height: 800,
        background: "rgb(255, 255, 255)",
        color: "rgb(0, 0, 0)",
        font: "Transit",
      },
    });
  const painted = (
    rect: [number, number, number, number],
    o: Partial<SnapElement> = {},
    kids: SnapNode[] = [],
  ) => box("div", rect, { style: { bg: "rgb(240, 240, 240)" }, ...o }, kids);

  it("stretches full-bleed bands and fluid gutters, centres wide-margin columns and pins right-edge layers", () => {
    const hero = painted([0, 0, W, 300], { layout: { display: "block", position: "absolute" } }, [
      painted([200, 50, 600, 200], {
        style: { bg: "rgb(200, 0, 0)" },
        layout: { display: "block", position: "absolute" },
      }),
      painted([940, 20, 40, 40], {
        style: { bg: "rgb(0, 0, 200)" },
        layout: { display: "block", position: "absolute" },
      }),
      painted([24, 260, 952, 30], {
        style: { bg: "rgb(0, 200, 0)" },
        layout: { display: "block", position: "absolute" },
      }),
    ]);
    const { root } = conv(page([hero]), true).screen;
    const at = (bg: string) => find(root, (e) => e.style?.background === bg)!;
    expect(at("rgb(240, 240, 240)").layout?.constraints).toEqual({
      horizontal: "left-right",
      vertical: "top",
    });
    expect(at("rgb(200, 0, 0)").layout?.constraints?.horizontal).toBe("center");
    expect(at("rgb(0, 0, 200)").layout?.constraints?.horizontal).toBe("right");
    expect(at("rgb(0, 200, 0)").layout?.constraints?.horizontal).toBe("left-right");
  });

  it("fills full-width flow children of a column and centres a row whose content sits midway", () => {
    const col = painted([0, 0, W, 400], {}, [
      painted([0, 0, W, 100], { style: { bg: "rgb(1, 1, 1)" } }),
      painted([0, 120, W, 100], { style: { bg: "rgb(2, 2, 2)" } }, [
        painted([300, 140, 180, 40], { style: { bg: "rgb(3, 3, 3)" } }),
        painted([520, 140, 180, 40], { style: { bg: "rgb(4, 4, 4)" } }),
      ]),
    ]);
    const { root } = conv(page([col]), true).screen;
    const at = (bg: string) => find(root, (e) => e.style?.background === bg)!;
    expect(at("rgb(1, 1, 1)").layout?.width).toBe("fill");
    const row = at("rgb(2, 2, 2)");
    expect(row.layout).toMatchObject({ width: "fill", direction: "row", justify: "center" });
    expect((row.layout?.padding as number[])[3]).toBe(0);
    // fixed-size cards inside the centred row keep their size
    expect(at("rgb(3, 3, 3)").layout?.width).toBe(180);
  });

  it("keeps fluid gutters: fills with margins, pins the ends of a row apart, turns equal grid tracks into 1fr", () => {
    const c = (rect: [number, number, number, number], bg: string, kids: SnapNode[] = []) =>
      painted(rect, { style: { bg } }, kids);
    const col = painted([0, 0, W, 800], {}, [
      // a notice inset by a 40px gutter on both sides
      c([40, 0, 920, 100], "rgb(1, 1, 1)"),
      // header: logo · nav · icons between 40px gutters (widest gap after the logo)
      c([0, 120, W, 60], "rgb(2, 2, 2)", [
        c([40, 130, 80, 40], "rgb(3, 3, 3)"),
        c([600, 130, 100, 40], "rgb(4, 4, 4)"),
        c([720, 130, 240, 40], "rgb(5, 5, 5)"),
      ]),
      // 2 × 2 equal cards between 40px gutters
      c(
        [0, 200, W, 500],
        "rgb(6, 6, 6)",
        [0, 1, 2, 3].map((i) =>
          c([40 + (i % 2) * 470, 200 + Math.floor(i / 2) * 250, 450, 230], `rgb(7, 7, ${i})`),
        ),
      ),
    ]);
    const { root } = conv(page([col]), true).screen;
    const at = (bg: string) => find(root, (e) => e.style?.background === bg)!;
    expect(at("rgb(1, 1, 1)").layout).toMatchObject({ width: "fill", margin: [0, 40, 0, 40] });
    const header = at("rgb(2, 2, 2)");
    expect(header.layout).toMatchObject({ width: "fill", justify: "between", padding: [0, 40, 0, 40] });
    expect(header.children!.map((k) => k.style?.background ?? k.name)).toEqual(["rgb(3, 3, 3)", "Group"]);
    expect(header.children![1]!.children!.map((k) => k.style?.background)).toEqual([
      "rgb(4, 4, 4)",
      "rgb(5, 5, 5)",
    ]);
    const grid = at("rgb(6, 6, 6)");
    expect(grid.layout?.grid?.columns).toBe(2);
    expect(grid.layout?.padding).toEqual([0, 40, 0, 40]);
    expect(at("rgb(7, 7, 0)").layout?.width).toBe("fill");
  });

  it("turns the equal tracks of a grid flush with its parent into 1fr", () => {
    // 2 × 2 cards spanning the frame edge to edge (no gutters): px tracks would not shrink with the page
    const grid = painted(
      [0, 0, W, 500],
      { style: { bg: "rgb(6, 6, 6)" } },
      [0, 1, 2, 3].map((i) =>
        painted([(i % 2) * 510, Math.floor(i / 2) * 250, 490, 230], { style: { bg: `rgb(7, 7, ${i})` } }),
      ),
    );
    const { root } = conv(page([painted([0, 0, W, 600], {}, [grid])]), true).screen;
    const at = (bg: string) => find(root, (e) => e.style?.background === bg)!;
    expect(at("rgb(6, 6, 6)").layout?.grid).toMatchObject({ columns: 2, columnGap: 20 });
    expect(at("rgb(6, 6, 6)").layout?.padding).toEqual([0, 0, 0, 0]);
    expect(at("rgb(7, 7, 3)").layout?.width).toBe("fill");
  });

  it("stretches overhanging backgrounds and a left layer up to right-pinned neighbours", () => {
    const abs = { display: "block", position: "absolute" };
    const panel = painted([40, 0, 920, 100], { style: { bg: "rgb(1, 1, 1)" }, layout: abs }, [
      painted([16, -10, 968, 120], { style: { bg: "rgb(2, 2, 2)" }, layout: abs }),
      painted([40, 10, 600, 80], { style: { bg: "rgb(3, 3, 3)" }, layout: abs }),
      painted([680, 10, 200, 40], { style: { bg: "rgb(4, 4, 4)" }, layout: abs }),
    ]);
    const { root } = conv(page([panel]), true).screen;
    const h = (bg: string) => find(root, (e) => e.style?.background === bg)!.layout?.constraints?.horizontal;
    expect([h("rgb(1, 1, 1)"), h("rgb(2, 2, 2)"), h("rgb(3, 3, 3)"), h("rgb(4, 4, 4)")]).toEqual([
      "left-right",
      "left-right",
      "left-right",
      "right",
    ]);
    // a small layer far from the pinned one keeps its place
    const row = painted([0, 200, W, 60], { layout: abs }, [
      painted([0, 210, 20, 20], { style: { bg: "rgb(5, 5, 5)" }, layout: abs }),
      painted([940, 210, 40, 40], { style: { bg: "rgb(6, 6, 6)" }, layout: abs }),
    ]);
    const r2nd = conv(page([row]), true).screen.root;
    expect(find(r2nd, (e) => e.style?.background === "rgb(5, 5, 5)")!.layout?.constraints).toBeUndefined();
    expect(find(r2nd, (e) => e.style?.background === "rgb(6, 6, 6)")!.layout?.constraints?.horizontal).toBe(
      "right",
    );
  });

  it("can be switched off", () => {
    const { root } = snapshotToScreen(
      page([painted([0, 0, W, 300], { layout: { display: "block", position: "absolute" } })]),
      { fluid: false },
    ).screen;
    expect(all(root).some((e) => e.layout?.constraints || e.layout?.width === "fill")).toBe(false);
  });
});

describe("interactive pages", () => {
  const fixed = { display: "block", position: "fixed" };

  it("keeps controls asked for as their own element and maps snapshot ids to DSL ids", () => {
    const icon = box("span", [940, 20, 24, 24], { style: { bg: "rgb(0, 0, 0)" } });
    const trigger = box("div", [930, 10, 44, 44], { attrs: { "aria-label": "Menu" } }, [icon]);
    const s = snap([trigger]);
    expect(conv(s).idOf.has(trigger.id)).toBe(false);
    const { screen, idOf } = snapshotToScreen(s, { keep: [trigger.id] });
    const el = find(screen.root, (e) => e.id === idOf.get(trigger.id))!;
    expect(el.layout).toMatchObject({ width: 44, height: 44 });
    expect(find(screen.root, (e) => e.id === idOf.get(icon.id))?.style?.background).toBe("rgb(0, 0, 0)");
    // fitted: where it was measured
    const f = snapshotToScreen(s, { keep: [trigger.id], flow: false });
    expect(find(f.screen.root, (e) => e.id === f.idOf.get(trigger.id))!.layout).toMatchObject({
      x: 930,
      y: 10,
      width: 44,
      height: 44,
    });
  });

  it("pins fixed bars inside the first viewport and sticky headers that stick for the whole page", () => {
    const header = box("header", [0, 0, 1000, 64], { layout: fixed, style: { bg: "rgb(1, 1, 1)" } });
    const below = box("div", [0, 1500, 300, 60], { layout: fixed, style: { bg: "rgb(2, 2, 2)" } });
    const backdrop = box("div", [0, 0, 1000, 800], { layout: fixed, style: { bg: "rgb(3, 3, 3)" } });
    const long = {
      page: {
        width: 1000,
        height: 3000,
        background: "rgb(255, 255, 255)",
        color: "rgb(0, 0, 0)",
        font: "Transit",
      },
    };
    const { root } = conv(snap([header, below, backdrop], long)).screen;
    const at = (bg: string) => find(root, (e) => e.style?.background === bg)!.layout;
    expect(at("rgb(1, 1, 1)")?.scrollBehavior).toBe("fixed");
    // left further down by the capture / a full-viewport layer: scrolls
    expect(at("rgb(2, 2, 2)")?.scrollBehavior).toBeUndefined();
    expect(at("rgb(3, 3, 3)")?.scrollBehavior).toBeUndefined();
    // nothing else changes: the same layer without position: fixed renders the same
    const { scrollBehavior: _s, ...rest } = at("rgb(1, 1, 1)")!;
    expect(rest).toEqual(
      find(
        conv(snap([{ ...header, layout: { display: "block", position: "absolute" } }, below, backdrop], long))
          .screen.root,
        (e) => e.style?.background === "rgb(1, 1, 1)",
      )!.layout,
    );

    const sticky = (parentH: number) => {
      const bar = box("div", [0, 0, 1000, 56], {
        layout: { display: "block", position: "sticky" },
        style: { bg: "rgb(4, 4, 4)" },
      });
      const r = conv(snap([box("div", [0, 0, 1000, parentH], {}, [bar])], long)).screen.root;
      return find(r, (e) => e.style?.background === "rgb(4, 4, 4)")!.layout?.scrollBehavior;
    };
    expect(sticky(3000)).toBe("fixed");
    // its parent ends long before the page does: the header scrolls away with it
    expect(sticky(600)).toBeUndefined();
  });

  const W = 390;
  const phone = (children: SnapNode[], h = 2000): Omit<Snapshot, "states" | "assets" | "embeddedFonts"> => ({
    version: 1,
    url: "https://example.com/",
    title: "Example",
    viewport: { width: W, height: 844 },
    page: { width: W, height: h, background: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", font: "Transit" },
    root: box("body", [0, 0, W, h], {}, children),
    fonts: [],
    fontFaces: [],
    sheets: [],
    nodes: 1,
  });

  it("cuts the opened drawer out of the menu state, with the dim layer behind it and the parent assets", () => {
    const img = box("img", [24, 100, 64, 32], { kind: "img", src: "https://example.com/logo.png" });
    const close = box("button", [250, 72, 40, 40], {
      attrs: { "aria-label": "Close" },
      style: { bg: "rgb(9, 9, 9)" },
    });
    const drawer = box("nav", [0, 64, 300, 780], { layout: fixed, style: { bg: "rgb(250, 250, 250)" } }, [
      img,
      close,
      box("a", [24, 160, 200, 24], {}, [text("Modelle", [line("Modelle", 24, 162, 70)])]),
    ]);
    const dim = box("div", [0, 0, W, 844], { layout: fixed, style: { bg: "rgba(0, 0, 0, 0.5)" } });
    const state: SnapState = {
      kind: "menu",
      trigger: 99,
      panel: drawer.id,
      close: close.id,
      motion: { enter: "left", duration: 300, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
      snapshot: phone([dim, drawer]),
    };
    const parent = {
      ...phone([]),
      assets: { "https://example.com/logo.png": "data:image/png;base64,AAAA" },
    } as Snapshot;
    const m = menuOverlayOf(parent, state);
    expect(m.screen).toMatchObject({ width: 300, height: 780 });
    expect(m.offset).toEqual({ x: 0, y: 64 });
    expect(m.dim).toBe("rgba(0, 0, 0, 0.5)");
    // only the drawer: no page content, no dim layer inside the overlay
    expect(all(m.screen.root).some((e) => e.style?.background === "rgba(0, 0, 0, 0.5)")).toBe(false);
    expect(find(m.screen.root, (e) => e.type === "image")?.image?.src).toBe("data:image/png;base64,AAAA");
    expect(find(m.screen.root, (e) => e.id === m.closeId)?.layout).toMatchObject({ x: 250, y: 8 });
    expect(JSON.stringify(m.screen.root)).toContain("Modelle");

    expect(menuInteraction("menu-1", m, state.motion)).toEqual({
      onTap: "open-overlay",
      target: "menu-1",
      duration: 300,
      easing: { bezier: [0.4, 0, 0.2, 1] },
      overlay: {
        position: "manual",
        offset: { x: 0, y: 64 },
        background: "rgba(0, 0, 0, 0.5)",
        closeOnOutsideClick: true,
        enter: "left",
      },
    });
  });

  it("keeps the blur of the dim layer's backdrop filter on the overlay", () => {
    const drawer = box("nav", [0, 0, 300, 844], { layout: fixed, style: { bg: "rgb(250, 250, 250)" } }, [
      box("a", [24, 160, 200, 24], {}, [text("Models", [line("Models", 24, 162, 70)])]),
    ]);
    const dim = box("div", [0, 0, W, 844], {
      layout: fixed,
      style: { bg: "rgba(17, 25, 46, 0.6)", backdrop: "blur(10px)" },
    });
    const m = menuOverlayOf(phone([]) as Snapshot, {
      kind: "menu",
      trigger: 1,
      panel: drawer.id,
      snapshot: phone([dim, drawer]),
    });
    expect(menuInteraction("x", m).overlay).toMatchObject({ background: "rgba(17, 25, 46, 0.6)", blur: 10 });
  });

  it("a full-screen translucent panel dims by itself; without a panel the open page is cropped to one viewport", () => {
    const list = box("div", [0, 80, W, 400], { style: { bg: "rgb(255, 255, 255)" } });
    const sheet = box("div", [0, 0, W, 844], { layout: fixed, style: { bg: "rgba(0, 0, 0, 0.4)" } }, [list]);
    const m = menuOverlayOf(phone([]) as Snapshot, {
      kind: "menu",
      trigger: 1,
      panel: sheet.id,
      snapshot: phone([sheet]),
    });
    expect(m.dim).toBe("rgba(0, 0, 0, 0.4)");
    expect(m.offset).toEqual({ x: 0, y: 0 });
    expect(menuInteraction("x", m).overlay).toEqual({
      position: "top-left",
      background: "rgba(0, 0, 0, 0.4)",
      closeOnOutsideClick: true,
    });

    const far = box("div", [0, 1500, W, 100], { style: { bg: "rgb(7, 7, 7)" } });
    const crop = menuOverlayOf(phone([]) as Snapshot, {
      kind: "menu",
      trigger: 1,
      snapshot: phone([list, far]),
    });
    expect(crop.screen).toMatchObject({ width: W, height: 844 });
    expect(all(crop.screen.root).some((e) => e.style?.background === "rgb(7, 7, 7)")).toBe(false);
    expect(crop.dim).toBe("none");
  });

  it("maps CSS timing functions to easing curves", () => {
    expect(easingOf("ease-out")).toBe("ease-out");
    expect(easingOf("ease")).toEqual({ bezier: [0.25, 0.1, 0.25, 1] });
    expect(easingOf("cubic-bezier(0.25, 0.46, 0.45, 0.94), linear")).toEqual({
      bezier: [0.25, 0.46, 0.45, 0.94],
    });
    expect(easingOf("steps(4, end)")).toBe("linear");
    expect(easingOf(undefined)).toBeUndefined();
  });
});

describe("carousels and menu levels", () => {
  const slide = (x: number) => box("li", [x, 100, 200, 150], { style: { bg: "rgb(20, 20, 20)" } });

  it("a slide track becomes a snapping horizontal scroller that keeps the slides out of view; its arrows scroll it", () => {
    const slides = [40, 260, 480, 700, 920, 1140].map(slide);
    const list = box("ul", [40, 100, 1300, 150], { layout: { display: "flex", position: "static" } }, slides);
    const track = box(
      "div",
      [0, 100, 1000, 150],
      { scroller: { axis: "x", kind: "track" }, style: { overflow: ["hidden", "hidden"] } },
      [list],
    );
    const prev = box("button", [880, 280, 48, 48], {
      attrs: { "aria-label": "Previous slide" },
      carousel: { dir: -1, scroller: track.id, disabled: true },
    });
    const next = box("button", [940, 280, 48, 48], {
      attrs: { "aria-label": "Next slide" },
      carousel: { dir: 1, scroller: track.id },
    });
    const { screen } = conv(snap([track, prev, next]), true);
    const frame = find(screen.root, (e) => e.layout?.scroll === "horizontal")!;
    expect(frame.layout).toMatchObject({
      scroll: "horizontal",
      scrollbar: "hidden",
      clip: true,
      snap: true,
      snapPadding: 40,
    });
    // the slides past the page edge are still there, each one a snap point
    expect(all(frame).filter((e) => e.style?.background === "rgb(20, 20, 20)")).toHaveLength(6);
    expect(all(frame).filter((e) => e.layout?.snapAlign === "start")).toHaveLength(6);
    const arrow = (label: string) =>
      find(screen.root, (e) => e.type === "button" && (e.name ?? "").includes(label))!;
    expect(arrow("Next").interaction).toEqual({
      onTap: "scroll-by",
      target: frame.id,
      direction: "next",
      by: "slide",
    });
    expect(arrow("Previous").interaction).toMatchObject({ direction: "prev" });
    expect(arrow("Previous").meta?.carouselDisabled).toBe(true);
  });

  it("a free scroller pages instead of snapping", () => {
    const strip = box(
      "ul",
      [0, 100, 1000, 150],
      { scroller: { axis: "x", kind: "scroll" }, style: { overflow: ["auto", "hidden"] } },
      [28, 256, 484, 712, 940, 1168].map(slide),
    );
    const next = box("button", [940, 40, 48, 48], {
      attrs: { "aria-label": "Next" },
      carousel: { dir: 1, scroller: strip.id },
    });
    const { screen } = conv(snap([strip, next]));
    const frame = find(screen.root, (e) => e.layout?.scroll === "horizontal")!;
    expect(frame.layout?.snap).toBeUndefined();
    expect(frame.children).toHaveLength(6);
    expect(find(screen.root, (e) => e.interaction?.onTap === "scroll-by")?.interaction).toMatchObject({
      target: frame.id,
      by: "page",
    });
  });

  const W = 390;
  const phone = (children: SnapNode[]): Omit<Snapshot, "states" | "assets" | "embeddedFonts"> => ({
    version: 1,
    url: "https://example.com/",
    title: "Example",
    viewport: { width: W, height: 844 },
    page: {
      width: W,
      height: 2000,
      background: "rgb(255, 255, 255)",
      color: "rgb(0, 0, 0)",
      font: "Transit",
    },
    root: box("body", [0, 0, W, 2000], {}, children),
    fonts: [],
    fontFaces: [],
    sheets: [],
    nodes: 1,
  });

  it("a header that turns into the menu (× in the hamburger slot) is cut out with the panel; a level keeps its back control", () => {
    const close = box("button", [28, 25, 33, 22], {
      attrs: { "aria-label": "Menü" },
      style: { bg: "rgb(5, 5, 5)" },
    });
    const back = box("button", [28, 90, 334, 40], { attrs: { "aria-label": "Finden & kaufen" } }, [
      text("Finden & kaufen", [line("Finden & kaufen", 64, 100, 110)]),
    ]);
    const panel = box(
      "div",
      [0, 72, W, 772],
      { layout: { display: "block", position: "absolute" }, style: { bg: "rgb(2, 2, 3)" } },
      [back],
    );
    const header = box(
      "div",
      [0, 0, W, 72],
      { layout: { display: "flex", position: "relative" }, style: { bg: "rgb(2, 2, 3)" } },
      [close, panel],
    );
    const state: SnapState = {
      kind: "submenu",
      parent: 0,
      item: 77,
      panel: panel.id,
      close: close.id,
      back: back.id,
      snapshot: phone([header]),
    };
    const m = menuOverlayOf(phone([]) as Snapshot, state);
    // the whole header band plus the panel below it, from the top of the viewport
    expect(m.offset).toEqual({ x: 0, y: 0 });
    expect(m.screen).toMatchObject({ width: W, height: 844 });
    expect(find(m.screen.root, (e) => e.id === m.closeId)?.layout).toMatchObject({ width: 33, height: 22 });
    expect(find(m.screen.root, (e) => e.id === m.backId)?.layout).toMatchObject({ height: 40 });
    // a sheet down to the bottom of the viewport is filled with its colour in a taller window
    expect(m.screen.root.style?.background).toBe("rgb(2, 2, 3)");
  });

  it("a panel that is one link of a mega menu becomes the menu box around it; the header backdrop past it is the dim", () => {
    const D = 1280,
      VH = 1000;
    const desk = (children: SnapNode[]): Snapshot =>
      ({
        ...phone([]),
        viewport: { width: D, height: VH },
        page: { ...phone([]).page, width: D, height: 4000 },
        root: box("body", [0, 0, D, 4000], {}, children),
      }) as Snapshot;
    const trigger = box("a", [230, 0, 124, 48], { attrs: { role: "button" } }, [
      text("Software", [line("Software", 246, 14, 70)]),
    ]);
    const link = box("a", [804, 652, 460, 84], { attrs: { href: "https://example.com/streamsets" } }, [
      text("StreamSets", [line("StreamSets", 820, 664, 90)]),
    ]);
    const content = box("div", [329, 64, 935, 772], { layout: { display: "block", position: "relative" } }, [
      link,
    ]);
    const mega = box(
      "div",
      [0, 48, D, 788],
      { layout: { display: "block", position: "relative" }, style: { bg: "rgb(255, 255, 255)" } },
      [content],
    );
    const backdrop = box("div", [0, 0, D, VH], {
      layout: { display: "block", position: "fixed" },
      style: { bg: "rgba(0, 0, 0, 0.6)" },
    });
    const header = box(
      "div",
      [0, 0, D, 48],
      { layout: { display: "flex", position: "relative" }, style: { bg: "rgb(255, 255, 255)" } },
      [trigger, backdrop, mega],
    );
    const m = menuOverlayOf(desk([]), {
      kind: "menu",
      trigger: trigger.id,
      panel: link.id,
      close: trigger.id,
      snapshot: desk([header]),
    });
    // header + the whole mega menu (not the 496 px down to the link's bottom edge … nor one link)
    expect(m.offset).toEqual({ x: 0, y: 0 });
    expect(m.screen).toMatchObject({ width: D, height: 836 });
    // the backdrop dims the page around the menu instead of being cropped into it
    expect(m.dim).toBe("rgba(0, 0, 0, 0.6)");
    expect(all(m.screen.root).some((e) => e.style?.background === "rgba(0, 0, 0, 0.6)")).toBe(false);
    expect(JSON.stringify(m.screen.root)).toContain("StreamSets");
  });
});

describe("mirrored text", () => {
  it("glyphs measured right to left (a 180°-turned ligature icon) read in DOM order, as one line", () => {
    const word = "arrow_up";
    // each glyph left of the one before, one "line" each
    const lines = [...word].map((ch, i) => line(ch, 324 - i * 3, 30, 3, "word"));
    expect(joinMirroredLines(lines)).toEqual([{ text: word, x: 303, y: 30, w: 24, h: 19, brk: "word" }]);
    // ordinary wrapped lines are left alone
    const wrapped = [line("Erste", 0, 0, 40, "space"), line("Zeile", 0, 20, 40)];
    expect(joinMirroredLines(wrapped)).toBe(wrapped);
    // through the converter: an icon-font ligature becomes an icon named after the real word, not "pu_worra"
    const span = box("span", [303, 30, 24, 24], { style: { transform: "matrix(-1, 0, 0, -1, 0, 0)" } }, [
      text(word, lines, { family: "site_icons", stack: "site_icons", features: '"liga"' }),
    ]);
    const { screen } = conv(snap([box("button", [200, 0, 140, 84], {}, [span])]));
    expect(JSON.stringify(screen.root)).not.toContain("pu_worra");
    expect(find(screen.root, (e) => e.meta?.glyph === word)).toBeTruthy();
  });
});

describe("widget states", () => {
  // a filter row (two chips) and a card that opens its details below, all in one widget
  const chip = (label: string, x: number) =>
    box("label", [x, 120, 80, 28], { style: { bg: "rgb(30, 30, 30)" }, attrs: { "aria-label": label } });
  const card = () =>
    box("button", [0, 160, 200, 100], {
      style: { bg: "rgb(40, 40, 40)" },
      attrs: { "aria-label": "Audi A3" },
    });
  const widget = (kids: SnapNode[], h: number) =>
    box("section", [0, 100, 1000, h], { style: { bg: "rgb(10, 10, 10)" } }, kids);
  const fragment = (root: SnapElement): Omit<Snapshot, "states" | "assets" | "embeddedFonts"> => ({
    ...snap([]),
    root,
    controls: [],
  });

  it("a widget becomes a state frame: the captured look first, one child per state, its controls switching them", () => {
    const all = chip("Alle", 0),
      neu = chip("Neu", 90),
      a3 = card();
    const base = widget([all, neu, a3], 200);
    const page = snap([base, box("footer", [0, 320, 1000, 100], { style: { bg: "rgb(1, 1, 1)" } })]);
    page.controls = [
      { kind: "select", id: all.id },
      { kind: "select", id: neu.id },
      { kind: "toggle", id: a3.id },
    ];
    // Neu: filtered (same height); the card: open, taller
    const fAll = chip("Alle", 0),
      fNeu = chip("Neu", 90),
      fCard = card();
    const filtered = widget([fAll, fNeu, fCard], 200);
    const oAll = chip("Alle", 0),
      oNeu = chip("Neu", 90),
      oCard = card();
    const open = widget(
      [oAll, oNeu, oCard, box("div", [0, 280, 1000, 300], { style: { bg: "rgb(50, 50, 50)" } })],
      500,
    );
    page.states = [
      {
        kind: "region",
        index: 1,
        region: base.id,
        toggle: false,
        label: "Neu",
        snapshot: {
          ...fragment(filtered),
          controls: [
            { kind: "select", id: fAll.id },
            { kind: "select", id: fNeu.id },
            { kind: "toggle", id: fCard.id },
          ],
        },
      },
      {
        kind: "region",
        index: 2,
        region: base.id,
        toggle: true,
        label: "Audi A3",
        snapshot: {
          ...fragment(open),
          controls: [
            { kind: "select", id: oAll.id },
            { kind: "select", id: oNeu.id },
            { kind: "toggle", id: oCard.id },
          ],
        },
      },
    ];
    expect(regionKeepIds(page)).toEqual(expect.arrayContaining([base.id, all.id, neu.id, a3.id]));
    const res = snapshotToScreen(page, { keep: regionKeepIds(page) });
    applyRegionStates(page, res);
    const sw = find(res.screen.root, (e) => !!e.states)!;
    const [first, sNeu, sOpen] = sw.children!;
    expect(sw.states?.active).toBe(first!.id);
    expect(sw.children).toHaveLength(3);
    // the state frame takes the widget's place (in the page's flow); the states sit at its top-left, each as tall as
    // captured
    expect(sw.layout).toMatchObject({ height: 200 });
    // flow first: the states sit in the frame's flow, one shown at a time (each as tall as captured)
    expect(sOpen!.layout).toMatchObject({ width: "fill", height: 500 });
    expect(sOpen!.layout?.position).toBeUndefined();
    expect(first!.layout?.position).toBeUndefined();
    // fitted: layers over each other at the frame's top-left
    const fit = snapshotToScreen(page, { keep: regionKeepIds(page), flow: false });
    applyRegionStates(page, fit, false);
    const fsw = find(fit.screen.root, (e) => !!e.states)!;
    expect(fsw.children![2]!.layout).toMatchObject({ position: "absolute", x: 0, y: 0, height: 500 });
    const named = (root: SceneElement, label: string) =>
      find(root, (e) => (e.name ?? "").includes(label) && !!e.interaction);
    // in the page: each control shows its state
    expect(named(first!, "Neu")?.interaction).toEqual({ onTap: "set-state", target: sw.id, state: sNeu!.id });
    expect(named(first!, "Audi A3")?.interaction).toEqual({
      onTap: "set-state",
      target: sw.id,
      state: sOpen!.id,
    });
    // filtered: Alle (no state of its own) goes back; the card has no unfiltered-open state here, so it stays put
    expect(named(sNeu!, "Alle")?.interaction?.state).toBe(first!.id);
    expect(find(sNeu!, (e) => (e.name ?? "").includes("Audi A3"))?.interaction?.onTap).not.toBe("set-state");
    // open: the card again closes it, a chip shows its state
    expect(named(sOpen!, "Audi A3")?.interaction?.state).toBe(first!.id);
    expect(named(sOpen!, "Neu")?.interaction?.state).toBe(sNeu!.id);
  });

  it("a rotator (every dot has a state of its own) opens on its first slide, not where autoplay had got to", () => {
    const dot = (label: string, x: number) =>
      box("button", [x, 280, 12, 12], {
        style: { bg: "rgb(200, 200, 200)" },
        attrs: { "aria-label": label },
      });
    const slides = (n: number) => {
      const ds = [dot("Slide 1", 0), dot("Slide 2", 20)];
      return {
        ds,
        w: widget([box("div", [0, 100, 1000, 170], { style: { bg: `rgb(${n}, 0, 0)` } }), ...ds], 200),
      };
    };
    const cap = slides(2);
    const page = snap([cap.w]);
    page.controls = cap.ds.map((d) => ({ kind: "select" as const, id: d.id }));
    page.states = [1, 2].map((n, i) => {
      const s = slides(n);
      return {
        kind: "region" as const,
        index: i,
        region: cap.w.id,
        toggle: false,
        label: `Slide ${n}`,
        snapshot: { ...fragment(s.w), controls: s.ds.map((d) => ({ kind: "select" as const, id: d.id })) },
      };
    });
    const res = snapshotToScreen(page, { keep: regionKeepIds(page) });
    applyRegionStates(page, res);
    const sw = find(res.screen.root, (e) => !!e.states)!;
    expect(sw.states?.active).toBe(sw.children![1]!.id);
  });

  it("a drop-down's options become one choice list on the select", () => {
    const sel = box("select", [0, 120, 300, 48], {
      kind: "input",
      input: {
        type: "select",
        value: "Alle",
        placeholder: "",
        placeholderColor: "rgb(0, 0, 0)",
        font: font(),
        multiline: false,
      },
    });
    const base = widget([sel], 200);
    const page = snap([base]);
    page.controls = [
      { kind: "select", id: sel.id, option: 0, label: "Alle" },
      { kind: "select", id: sel.id, option: 1, label: "Neu" },
    ];
    const fSel = { ...sel, id: id++, input: { ...sel.input!, value: "Neu" } };
    page.states = [
      {
        kind: "region",
        index: 1,
        region: base.id,
        toggle: false,
        label: "Neu",
        snapshot: {
          ...fragment(widget([fSel], 200)),
          controls: [
            { kind: "select", id: fSel.id, option: 0, label: "Alle" },
            { kind: "select", id: fSel.id, option: 1, label: "Neu" },
          ],
        },
      },
    ];
    const res = snapshotToScreen(page, { keep: regionKeepIds(page) });
    applyRegionStates(page, res);
    const sw = find(res.screen.root, (e) => !!e.states)!;
    const [first, sNeu] = sw.children!;
    const pick = (root: SceneElement) =>
      find(root, (e) => e.interaction?.onTap === "set-state")!.interaction!;
    expect(pick(first!)).toEqual({
      onTap: "set-state",
      target: sw.id,
      state: first!.id,
      options: [
        { label: "Alle", state: first!.id },
        { label: "Neu", state: sNeu!.id },
      ],
    });
    expect(pick(sNeu!).state).toBe(sNeu!.id);
  });
});

describe("brand extras (Snapshot.brand → SceneScreen.capture)", () => {
  const brand = (o: Partial<BrandCapture> = {}): BrandCapture => ({
    url: "https://bmw.de",
    finalUrl: "https://www.bmw.de/de/index.html",
    width: 1000,
    customProperties: { "--brand": "#1c69d4" },
    mediaQueries: [{ query: "(min-width: 1024px)", minWidth: 1024, rules: 12 }],
    marks: {
      title: "BMW",
      logo: { svg: "<svg/>", box: { x: 20, y: 10, w: 48, h: 48 } },
      icons: [{ rel: "icon", href: "https://www.bmw.de/favicon.ico" }],
    },
    images: [
      {
        src: "https://www.bmw.de/a.jpg",
        naturalW: 1600,
        naturalH: 900,
        box: { x: 0, y: 64, w: 1000, h: 560 },
        alt: "iX3",
        objectFit: "cover",
        section: 1,
      },
    ],
    icons: [{ svg: '<svg width="24"/>', w: 24, h: 24, count: 5 }],
    sections: [
      {
        box: { x: 0, y: 0, w: 1000, h: 64 },
        background: "#ffffff",
        paddingTop: 12,
        paddingBottom: 12,
        dark: false,
      },
    ],
    grids: [
      { box: { x: 40, y: 700, w: 920, h: 300 }, columns: 4, gap: 16, itemW: 218, count: 8, section: 2 },
    ],
    controls: [
      {
        key: "button-abc",
        kind: "button",
        text: "Mehr erfahren",
        box: { x: 40, y: 500, w: 160, h: 48 },
        count: 3,
        base: {
          backgroundColor: "#1c69d4",
          color: "#ffffff",
          fontFamily: "BMWTypeNext",
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: 0,
          lineHeight: 24,
          borderRadius: 0,
          paddingTop: 12,
          paddingRight: 32,
          paddingBottom: 12,
          paddingLeft: 32,
          height: 48,
        },
        hover: { backgroundColor: "#0653b6" },
        unreached: ["focus", "active"],
      },
    ],
    fontFiles: [
      {
        family: "BMWTypeNext",
        weight: "400",
        style: "normal",
        url: "https://www.bmw.de/f.woff2",
        format: "woff2",
      },
    ],
    overlay: null,
    texts: ["Mehr erfahren", "Freude am Fahren"],
    ...o,
  });

  it("stores the capture on the page screen as it came", () => {
    const b = brand();
    const { screen } = conv(snap([], { brand: b }));
    expect(screen.capture).toEqual(b);
    // none without it (older snapshots), none on a menu overlay (state walks carry no brand)
    expect(conv(snap([])).screen.capture).toBeUndefined();
  });

  it("caps the lists, drops oversized svg markup and turns a failed read into a warning", () => {
    const big = "<svg>" + "x".repeat(30_000) + "</svg>";
    const b = brandCaptureOf(
      brand({
        texts: Array.from({ length: 4000 }, (_, i) => `t${i}`),
        icons: [
          { svg: big, w: 24, h: 24, count: 1 },
          { svg: "<svg/>", w: 16, h: 16, count: 2 },
        ],
        marks: {
          icons: [],
          logo: { svg: "<svg>" + "x".repeat(200_000) + "</svg>", box: { x: 0, y: 0, w: 1, h: 1 } },
        },
      }),
    )!;
    expect(b.texts).toHaveLength(3000);
    expect(b.icons).toEqual([{ svg: "<svg/>", w: 16, h: 16, count: 2 }]);
    expect(b.marks.logo).toEqual({ box: { x: 0, y: 0, w: 1, h: 1 } });
    const warnings: string[] = [];
    expect(brandCaptureOf({ error: "boom" }, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual(["brand extras not captured: boom"]);
    expect(conv(snap([], { brand: { error: "boom" } })).warnings).toContain(
      "brand extras not captured: boom",
    );
  });
});

describe("flow first (the page's layout stays in flow)", () => {
  const card = (x: number, w: number) =>
    box(
      "article",
      [x, 0, w, 140],
      { style: { bg: "rgb(255, 255, 255)" }, layout: { display: "block", position: "static" } },
      [
        box("img", [x, 0, w, 80], {
          kind: "img",
          src: "data:image/png;base64,AAAA",
          natural: { w: 400, h: 200 },
        }),
        box(
          "h3",
          [x + 16, 96, w - 32, 20],
          { layout: { display: "block", position: "static", margin: [16, 16, 4, 16] } },
          [text("Summit tent", [line("Summit tent", x + 16, 96, 90)], { lineHeight: 20 })],
        ),
        box(
          "a",
          [x + 16, 120, 70, 20],
          {
            layout: { display: "inline-block", position: "static", margin: [0, 16, 0, 16] },
            attrs: { href: "#t" },
          },
          [text("Learn more", [line("Learn more", x + 16, 120, 70)], { lineHeight: 20 })],
        ),
      ],
    );

  it("keeps a block's children in its flow, inset by their margins, the text wrapping in its box", () => {
    // (a card spanning the page: the converter stretches what spans its parent, and its children with it)
    const root = conv(snap([card(0, 1000)]), true).screen.root;
    const c = find(root, (e) => e.meta?.tag === "article")!;
    expect(c.layout?.direction).toBe("column");
    expect(c.children!.every((k) => k.layout?.position !== "absolute")).toBe(true);
    const title = find(c, (e) => e.text === "Summit tent")!;
    // a block-level line with room on it: it fills its box between the page's margins and may wrap
    expect(title.layout).toMatchObject({ width: "fill" });
    expect(title.style?.whiteSpace).toBeUndefined();
    // an inline-block link keeps its line, at its margin from the start
    const link = find(c, (e) => e.text === "Learn more")!;
    expect(link.style?.whiteSpace).toBe("pre");
    expect(link.layout?.alignSelf).toBe("start");
    expect((link.layout?.margin as number[])[3]).toBe(16);
    // fitted: the same card keeps its layers where they were measured
    const f = find(fitted(snap([card(0, 1000)]), true).screen.root, (e) => e.meta?.tag === "article")!;
    expect(f.children!.some((k) => k.layout?.position === "absolute")).toBe(true);
  });

  it("takes a wrapping flex row from the page's CSS: its gaps, and its items in flow", () => {
    const chip = (x: number, y: number, w: number, t: string) =>
      box(
        "li",
        [x, y, w, 30],
        {
          style: { bg: "rgb(236, 233, 223)" },
          layout: { display: "list-item", position: "static", padding: [6, 12, 6, 12] },
        },
        [text(t, [line(t, x + 12, y + 6, w - 24)], { lineHeight: 18 })],
      );
    const ul = box(
      "ul",
      [0, 0, 300, 70],
      {
        layout: {
          display: "flex",
          position: "static",
          dir: "row",
          wrap: "wrap",
          justify: "normal",
          align: "normal",
          gap: [10, 10],
        },
      },
      [
        chip(0, 0, 140, "Weather: changeable"),
        chip(150, 0, 120, "Huts open: 17"),
        chip(0, 40, 100, "Rivers: high"),
      ],
    );
    const root = conv(snap([ul]), true).screen.root;
    const row = find(root, (e) => e.meta?.tag === "ul")!;
    expect(row.layout).toMatchObject({
      direction: "row",
      wrap: true,
      gap: 10,
      crossGap: 10,
      justify: "start",
    });
    expect(row.children!.map((k) => k.layout?.position)).toEqual([undefined, undefined, undefined]);
    // as tall as its lines (more lines at a narrower width make it taller)
    expect(row.layout?.height).toBe("hug");
  });

  it("keeps a box the page positions itself absolute inside a flowing card", () => {
    const badge = box(
      "span",
      [250, 8, 40, 20],
      { style: { bg: "rgb(200, 0, 0)" }, layout: { display: "block", position: "absolute" } },
      [text("New", [line("New", 254, 8, 30)])],
    );
    const c = card(0, 300);
    c.children = [...(c.children ?? []), badge];
    const root = conv(snap([c]), true).screen.root;
    const b = find(root, (e) => e.style?.background === "rgb(200, 0, 0)")!;
    expect(b.layout?.position).toBe("absolute");
    expect(find(root, (e) => e.meta?.tag === "article")!.layout?.direction).toBe("column");
  });

  it("fills its parent up to the page's max-width, centred, where it sits at its cap", () => {
    const col = box(
      "div",
      [100, 0, 800, 100],
      { style: { bg: "rgb(240, 240, 240)" }, layout: { display: "block", position: "static", maxW: 800 } },
      [box("p", [100, 20, 800, 20], {}, [text("A column", [line("A column", 100, 20, 80)])])],
    );
    const band = box("section", [0, 0, 1000, 100], { style: { bg: "rgb(250, 250, 250)" } }, [col]);
    const root = conv(snap([band]), true).screen.root;
    const c = find(root, (e) => e.style?.background === "rgb(240, 240, 240)")!;
    expect(c.layout).toMatchObject({ width: "100%", maxWidth: 800 });
    // centred: by its own alignment in a column, by its row's justify in a row
    const parent = find(root, (e) => !!e.children?.includes(c))!;
    expect(c.layout?.alignSelf === "center" || parent.layout?.justify === "center").toBe(true);
  });

  it("lays out floats by their measured positions (no flex or grid behind them)", () => {
    const float = (x: number) =>
      box("div", [x, 0, 200, 50], {
        style: { bg: "rgb(0, 0, 0)" },
        layout: { display: "block", position: "static", float: "left" },
      });
    const row = box("div", [0, 0, 640, 50], { style: { bg: "rgb(250, 250, 250)" } }, [
      float(0),
      float(220),
      float(440),
    ]);
    const r = find(conv(snap([row]), true).screen.root, (e) => e.style?.background === "rgb(250, 250, 250)")!;
    expect(r.layout).toMatchObject({ direction: "row", gap: 20 });
  });
});

describe("flow first: what the page's flow holds beyond its boxes' geometry", () => {
  it("puts a z-indexed box the capture moved to its stacking context back in its flow (relative, not absolute)", () => {
    const pic = box("img", [0, 0, 1000, 300], {
      kind: "img",
      src: "data:image/png;base64,AAAA",
      natural: { w: 1000, h: 300 },
    });
    const teaser = box("section", [0, 0, 1000, 420], { style: { bg: "rgb(0, 0, 0)" } }, [pic]);
    const panel = box(
      "div",
      [0, 300, 1000, 120],
      { layout: { display: "block", position: "relative", z: 20 }, style: { bg: "rgb(0, 0, 0)" } },
      [text("Now on order", [line("Now on order", 24, 340, 120)], { color: "rgb(255, 255, 255)" })],
    );
    // the capture paints it in the body's stacking context: a child of the body after the section
    panel.from = teaser.id;
    const s = snap([teaser, panel]);
    const sec = find(conv(s, true).screen.root, (e) => e.meta?.tag === "section")!;
    expect(find(sec, (e) => e.text === "Now on order")).toBeDefined();
    expect(sec.layout?.direction).toBe("column");
    // the snapshot itself is left as it was; fitted keeps the painted order
    expect(s.root!.children).toContain(panel);
    const fsec = find(fitted(s, true).screen.root, (e) => e.meta?.tag === "section")!;
    expect(find(fsec, (e) => e.text === "Now on order")).toBeUndefined();
    // a box pulled up over the band before its parent (negative margin) stays in the stacking context
    const band = box("section", [0, 0, 1000, 300], { style: { bg: "rgb(0, 0, 0)" } }, [structuredClone(pic)]);
    const form = box("section", [0, 300, 1000, 200], {}, []);
    const card = box(
      "div",
      [16, 260, 968, 120],
      {
        layout: { display: "block", position: "relative", z: 3, margin: [-40, 0, 0, 0] },
        style: { bg: "rgb(255, 255, 255)" },
      },
      [text("Start", [line("Start", 40, 300, 40)])],
    );
    card.from = form.id;
    const r2 = conv(snap([band, form, card]), true).screen.root;
    const f2 = find(r2, (e) => e.meta?.tag === "section" && !find(e, (k) => k.type === "image"));
    expect(f2 && find(f2, (e) => e.text === "Start")).toBeFalsy();
  });

  it("marks a box whose height follows the viewport's, not the boxes around it", () => {
    const video = box("img", [0, 0, 1000, 560], {
      kind: "img",
      src: "data:image/png;base64,AAAA",
      natural: { w: 1000, h: 560 },
    });
    const stage = box(
      "div",
      [0, 0, 1000, 800],
      { style: { bg: "rgb(0, 0, 0)", overflow: ["hidden", "hidden"] }, vh: 200 },
      [video],
    );
    const half = box("div", [0, 800, 1000, 400], { style: { bg: "rgb(240, 240, 240)" }, vh: 100 }, [
      text("Below", [line("Below", 24, 820, 50)]),
    ]);
    const wrap = box("div", [0, 0, 1000, 1200], { vh: 300 }, [stage, half]);
    const s = snap([wrap], {
      viewportProbe: 200,
      page: {
        width: 1000,
        height: 1200,
        background: "rgb(255, 255, 255)",
        color: "rgb(0, 0, 0)",
        font: "Transit",
      },
    });
    const root = conv(s, true).screen.root;
    const st = find(root, (e) => e.style?.background === "rgb(0, 0, 0)")!;
    expect(st.meta).toMatchObject({ vhShare: 1, vhPx: 0 });
    const h = find(root, (e) => e.style?.background === "rgb(240, 240, 240)")!;
    expect(h.meta).toMatchObject({ vhShare: 0.5, vhPx: 0 });
    // the wrapper grew only because its boxes did
    expect(all(root).filter((e) => e.meta?.vhShare !== undefined)).toHaveLength(2);
    expect(st.meta?.vhFixed).toBeUndefined();
    // a stage its video overflows (clipped) has its height set, not a minimum
    const tall = box("img", [0, 0, 1000, 900], {
      kind: "img",
      src: "data:image/png;base64,AAAA",
      natural: { w: 1000, h: 900 },
    });
    const clipping = box(
      "div",
      [0, 0, 1000, 800],
      { style: { bg: "rgb(0, 0, 0)", overflow: ["hidden", "hidden"] }, vh: 200 },
      [tall],
    );
    const f = find(
      conv(snap([clipping], { viewportProbe: 200 }), true).screen.root,
      (e) => e.meta?.vhShare !== undefined,
    )!;
    expect(f.meta).toMatchObject({ vhShare: 1, vhFixed: true });
    // nothing without the capture's viewport walk
    expect(all(conv(snap([wrap]), true).screen.root).some((e) => e.meta?.vhShare !== undefined)).toBe(false);
  });

  it("keeps the clip of a box a picture fills (the picture can outgrow it at another width)", () => {
    const pic = box("img", [0, 0, 1000, 400], {
      kind: "img",
      src: "data:image/png;base64,AAAA",
      natural: { w: 1000, h: 400 },
    });
    const fig = () =>
      box("figure", [0, 0, 1000, 400], { style: { overflow: ["hidden", "hidden"] } }, [
        structuredClone(pic),
        box(
          "p",
          [12, 360, 200, 24],
          { layout: { display: "block", position: "absolute" }, style: { bg: "rgb(0, 0, 0)" } },
          [text("Photo: the valley", [line("Photo: the valley", 16, 362, 150)])],
        ),
      ]);
    const clipped = (r: SceneElement) => all(r).some((e) => e.layout?.clip && e !== r);
    expect(clipped(conv(snap([fig()]), true).screen.root)).toBe(true);
    expect(clipped(fitted(snap([fig()]), true).screen.root)).toBe(false);
  });

  it("keeps a row's padding to the room every child leaves: a lower child gets its own margin", () => {
    // a grid centring a teaser (with a top margin) beside a list as tall as the row
    const row = box(
      "div",
      [40, 0, 944, 425],
      { layout: { display: "grid", position: "static", align: "center" } },
      [
        box("div", [40, 91.5, 616, 282], { style: { bg: "rgb(255, 255, 255)" } }, [
          text("Sharing in one app", [line("Sharing in one app", 57, 108, 200)]),
        ]),
        box("div", [720, 0, 264, 425], { style: { bg: "rgb(240, 240, 240)" } }, [
          text("Ticket app", [line("Ticket app", 737, 16, 100)]),
        ]),
      ],
    );
    const f = find(
      conv(snap([row]), true).screen.root,
      (e) => e.layout?.direction === "row" && e.children?.length === 2,
    )!;
    expect((f.layout?.padding as number[])[0]).toBe(0);
    const [teaser, list] = f.children!;
    expect((teaser!.layout?.margin as number[] | undefined)?.[0]).toBeCloseTo(91.5, 1);
    expect(list!.layout?.alignSelf ?? "start").toBe("start");
  });

  it("keeps a panel the page pulls up over the picture before it (a negative margin) in the column", () => {
    const teaser = (marginTop: number) =>
      box("div", [0, 0, 390, 622], { layout: { display: "block", position: "relative" } }, [
        box("img", [0, 0, 390, 390], {
          kind: "img",
          src: "data:image/png;base64,AAAA",
          natural: { w: 390, h: 390 },
        }),
        box(
          "div",
          [0, 218, 390, 404],
          {
            layout: { display: "block", position: "relative", margin: [marginTop, 0, 0, 0] },
            style: { bg: "rgb(0, 0, 0)" },
          },
          [
            text("The BMW 1 Series.", [line("The BMW 1 Series.", 24, 266, 200)], {
              color: "rgb(255, 255, 255)",
            }),
          ],
        ),
      ]);
    const col = (r: SceneElement) =>
      find(r, (e) => e.layout?.direction === "column" && !!e.children?.some((c) => c.type === "image"));
    const t = col(conv(snap([teaser(-172)]), true).screen.root)!;
    expect(t).toBeDefined();
    expect(t.children!.every((c) => c.layout?.position !== "absolute")).toBe(true);
    const panel = t.children!.find((c) => c.style?.background === "rgb(0, 0, 0)")!;
    expect((panel.layout?.margin as number[])[0]).toBe(-172);
    // an overlap the page's CSS does not account for stays as it was
    expect(col(conv(snap([teaser(-40)]), true).screen.root)).toBeUndefined();
  });

  it("keeps a multi-column list's items in the page's order, for the export's columns to flow", () => {
    const item = (x: number, y: number, h: number, t: string) =>
      box(
        "li",
        [x, y, 230, h],
        { layout: { display: "inline-block", position: "static", margin: [0, 0, 38, 0] } },
        [text(t, [line(t, x, y + 12, 80)])],
      );
    const list = box(
      "ul",
      [0, 0, 960, 456],
      {
        layout: { display: "block", position: "static", columns: { width: 230, gap: 20 } },
        style: { bg: "rgb(66, 66, 66)" },
      },
      [
        item(0, 0, 226, "About"),
        item(0, 264, 154, "Routes"),
        item(250, 0, 178, "Tickets"),
        item(500, 0, 130, "Apps"),
      ],
    );
    const f = find(conv(snap([list]), true).screen.root, (e) => e.meta?.columnWidth !== undefined)!;
    expect(f.meta).toMatchObject({ columnWidth: 230, columnGap: 20 });
    expect(f.children!.map((c) => find(c, (e) => e.type === "text")?.text)).toEqual([
      "About",
      "Routes",
      "Tickets",
      "Apps",
    ]);
    expect(f.children!.every((c) => c.layout?.position !== "absolute")).toBe(true);
    expect((f.children![0]!.layout?.margin as number[])[2]).toBe(38);
    // fitted: where they were measured
    expect(
      find(fitted(snap([list]), true).screen.root, (e) => e.meta?.columnWidth !== undefined),
    ).toBeUndefined();
  });

  it("lays out inline-block children of a block as a wrapping row (they wrap onto more lines when it narrows)", () => {
    const group = (x: number, y: number, h: number, t: string) =>
      box(
        "div",
        [x, y, 320, h],
        {
          layout: { display: "inline-block", position: "static", margin: [0, 0, 48, 0] },
          style: { bg: "rgb(30, 30, 30)" },
        },
        [text(t, [line(t, x + 16, y + 8, 80)])],
      );
    const nav = box("nav", [0, 0, 1000, 472], { layout: { display: "block", position: "static" } }, [
      group(0, 0, 188, "Products"),
      group(324, 0, 188, "Industries"),
      group(648, 0, 188, "Research"),
      group(0, 236, 188, "Careers"),
    ]);
    const f = find(conv(snap([nav]), true).screen.root, (e) => e.layout?.wrap === true)!;
    expect(f.layout).toMatchObject({ direction: "row", wrap: true, gap: 4 });
    expect(f.children!.every((c) => c.layout?.position !== "absolute")).toBe(true);
  });

  it("makes the last line run of a block (a text ending in an info icon, after two paragraphs) inline content", () => {
    const para = (y: number, t: string, display = "block") =>
      box("p", [60, y, 749, display === "block" ? 28 : 23], { layout: { display, position: "static" } }, [
        text(t, [line(t, 60, y + 2, display === "block" ? 340 : 280)], { size: 18, lineHeight: 23 }),
      ]);
    const block = box("div", [60, 0, 749, 84], {}, [
      para(0, "Lease from 299 a month. Optional with"),
      para(28, "comprehensive cover for 49 a month."),
      para(58, "Financial Services.", "inline"),
      box("button", [344, 57, 24, 24], {
        layout: { display: "inline-flex", position: "relative" },
        attrs: { "aria-label": "Info" },
      }),
    ]);
    const root = conv(snap([block]), true).screen.root;
    const run = find(root, (e) => e.meta?.inline === true)!;
    expect(run).toBeDefined();
    expect(run.children!.map((c) => c.type)).toEqual(["text", "button"]);
    expect(run.children![0]!.text).toBe("Financial Services.");
    // the block around it is a column: the two paragraphs, then the run
    const col = find(root, (e) => !!e.children?.includes(run))!;
    expect(col.layout?.direction).toBe("column");
    expect(col.children!.every((c) => c.layout?.position !== "absolute")).toBe(true);
  });

  it("keeps a footnote's relative <sup> in its paragraph, which then wraps as one text", () => {
    const t =
      "Optional extra leasing service. The monthly cost of the insurance is added to the monthly rate.";
    const p = box("p", [24, 0, 342, 54], {}, [
      box("sup", [24, 0, 6, 13], { layout: { display: "inline", position: "relative" } }, [
        text("1", [line("1", 24, 0, 4)], { size: 9 }),
      ]),
      text(
        t,
        [
          line("Optional extra leasing service. The monthly cost of", 30, 1, 320, "space"),
          line("the insurance is added to the monthly rate.", 24, 19, 300),
        ],
        {
          size: 12,
          lineHeight: 18,
        },
      ),
    ]);
    const root = conv(snap([p]), true).screen.root;
    const texts = all(root).filter((e) => e.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]!.meta?.line).toBeUndefined();
    expect(texts[0]!.text).toContain("1");
    expect(texts[0]!.text).toContain("monthly rate.");
  });

  it("keeps the page's CSS grid with its children's placements (a 12-column grid, cards spanning 3)", () => {
    const card = (x: number, y: number, col: string, t: string) =>
      box(
        "a",
        [x, y, 300, 200],
        {
          layout: { display: "block", position: "relative", gridColumn: col },
          style: { bg: "rgb(255, 255, 255)" },
        },
        [text(t, [line(t, x + 16, y + 16, 120)])],
      );
    const grid = box(
      "section",
      [0, 0, 1290, 430],
      {
        layout: {
          display: "grid",
          position: "relative",
          cols: Array(12).fill("80px").join(" "),
          gap: [30, 30],
        },
        style: { bg: "rgb(240, 240, 240)" },
      },
      [
        card(330, 0, "4 / 7", "Subscription"),
        card(660, 0, "span 3 / auto", "Careers"),
        card(220, 230, "3 / 6", "Tickets"),
      ],
    );
    const f = find(conv(snap([grid]), true).screen.root, (e) => !!e.layout?.grid)!;
    expect(f.layout?.grid).toMatchObject({ columns: 12, columnGap: 30, rowGap: 30 });
    expect(f.children!.map((c) => c.meta?.gridColumn)).toEqual(["4 / 7", "span 3 / auto", "3 / 6"]);
    expect(f.children!.every((c) => c.layout?.position !== "absolute")).toBe(true);
  });

  it("keeps a child off the line where it was when a row takes the page's padding (no double count)", () => {
    // a grey statistic bar (padding 16) with a 76px text block and a 20px icon low in the bar
    const bar = box(
      "div",
      [0, 100, 326, 108],
      {
        layout: {
          display: "flex",
          position: "static",
          dir: "row",
          align: "self-end",
          padding: [16, 16, 16, 16],
        },
        style: { bg: "rgb(244, 244, 244)" },
      },
      [
        box("div", [16, 116, 250, 76], { style: { bg: "rgb(1, 1, 1)" } }),
        box("span", [290, 170, 20, 20], { style: { bg: "rgb(2, 2, 2)" } }),
      ],
    );
    const root = conv(snap([bar]), true).screen.root;
    const at = (bg: string) => find(root, (e) => e.style?.background === bg)!;
    expect(at("rgb(244, 244, 244)").layout).toMatchObject({ height: "hug", padding: [16, 16, 16, 16] });
    // 70px below the bar's top: 16 of padding and 54 of margin (70 of margin would put it 86 down and grow the bar)
    expect((at("rgb(2, 2, 2)").layout?.margin as number[])[0]).toBe(54);
  });

  it("keeps a CSS grid the page fills itself (one row of auto-placed tiles) as 1fr tracks", () => {
    const tile = (x: number, t: string) =>
      box("div", [x, 0, 340, 120], { style: { bg: "rgb(255, 255, 255)" } }, [
        text(t, [line(t, x + 16, 16, 120)]),
      ]);
    const grid = (w: number) =>
      box(
        "div",
        [0, 0, w, 120],
        {
          layout: {
            display: "grid",
            position: "relative",
            cols: Array(4).fill("340px").join(" "),
            gap: [0, 16],
          },
          style: { bg: "rgb(240, 240, 240)" },
        },
        [0, 1, 2, 3].map((i) => tile(i * 356, `Tile ${i}`)),
      );
    const f = find(conv(snap([grid(1408)]), true).screen.root, (e) => !!e.layout?.grid)!;
    expect(f.layout?.grid).toMatchObject({ columns: 4, columnGap: 16 });
    expect(f.children!.every((c) => c.layout?.width === "fill" && c.layout?.position !== "absolute")).toBe(
      true,
    );
    // tracks that do not fill the box (the page centres them): 1fr would move every tile
    const wide = find(
      conv(snap([grid(1600)]), true).screen.root,
      (e) => e.style?.background === "rgb(240, 240, 240)",
    )!;
    expect(wide.layout?.grid?.columns).not.toBe(4);
  });

  it("lays out a text and the small box on its last line, right after it, as inline content", () => {
    const note = (iconX: number) =>
      box("div", [24, 100, 600, 42], {}, [
        box("p", [24, 101, 600, 36], { layout: { display: "inline", position: "static" } }, [
          text(
            "Energy use combined: 19–15.7 kWh/100 km (WLTP); range 680–828 km (WLTP)",
            [
              line("Energy use combined: 19–15.7 kWh/100 km (WLTP); range ", 24, 101, 560, "space"),
              line("680–828 km (WLTP)", 24, 120, 116),
            ],
            { size: 12, lineHeight: 19 },
          ),
        ]),
        box(
          "button",
          [iconX, 117.6, 24, 24],
          { layout: { display: "inline-flex", position: "relative" }, attrs: { "aria-label": "Info" } },
          [],
        ),
      ]);
    const block = (r: SceneElement) => find(r, (e) => e.meta?.inline === true);
    const root = conv(snap([note(143)]), true).screen.root;
    const b = block(root)!;
    expect(b).toBeDefined();
    expect(b.children![0]!.type).toBe("text");
    expect(b.children!.every((c) => c.layout?.position !== "absolute")).toBe(true);
    expect((b.children![1]!.layout?.margin as number[])[3]).toBe(3);
    // a box far from where the line ends is laid out as before
    expect(block(conv(snap([note(560)]), true).screen.root)).toBeUndefined();
    // fitted: as measured
    expect(block(fitted(snap([note(143)]), true).screen.root)).toBeUndefined();
  });
});
