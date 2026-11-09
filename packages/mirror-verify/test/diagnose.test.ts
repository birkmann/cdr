import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { alignChildren, classify, diagnoseShot, diffAssetSets, findDivergence, launchBrowser, signature, skeleton, type SnapNode } from "../src/diagnose.js";
import { componentClassRe, COMPONENT_CLASS_RE } from "../src/capture.js";
import { resolveViewports } from "../src/checks/visual.js";
import { parseUrlList } from "../src/context.js";

// ------------------------------------------------------------------ synthetic snapshots

let seq = 0;
function n(tag: string, box: [number, number, number, number], extra: Partial<SnapNode> = {}, kids: SnapNode[] = []): SnapNode {
  return { i: seq++, p: -1, d: 0, tag, cls: [], x: box[0], y: box[1], w: box[2], h: box[3], t: 0, tt: 0, sh: "", ch: [], ...extra, _kids: kids } as SnapNode & { _kids: SnapNode[] };
}
/** flatten a tree built with n() into a SnapNode[] (indices, parents, depth, text totals) */
function flat(roots: SnapNode[]): SnapNode[] {
  const out: SnapNode[] = [];
  const rec = (x: SnapNode & { _kids?: SnapNode[] }, p: number, d: number) => {
    const node: SnapNode = { ...x, i: out.length, p, d, ch: [] };
    delete (node as { _kids?: unknown })._kids;
    out.push(node);
    for (const k of x._kids ?? []) node.ch.push(rec(k, node.i, d + 1));
    return node.i;
  };
  for (const r of roots) rec(r as SnapNode & { _kids?: SnapNode[] }, -1, 0);
  for (let q = out.length - 1; q >= 0; q--) {
    out[q].tt += out[q].t;
    if (out[q].p >= 0) out[out[q].p].tt += out[q].tt;
  }
  return out;
}
const emptyAssets = diffAssetSets(
  { snapshot: { nodes: [], truncated: false, height: 0, stylesheets: [], noscriptStylesheets: [], scripts: [], inlineScripts: 0 }, failedRequests: [], consoleErrors: [] },
  { snapshot: { nodes: [], truncated: false, height: 0, stylesheets: [], noscriptStylesheets: [], scripts: [], inlineScripts: 0 }, failedRequests: [], consoleErrors: [] },
);

describe("divergence + classifier (pure)", () => {
  it("aligns children by signature (LCS) and ignores script state classes", () => {
    expect(signature({ tag: "div", cls: ["slick-slide", "slick-active", "card"] })).toBe("div.card");
    expect(alignChildren(["a", "b", "c"], ["a", "c"])).toEqual([[0, 0], [1, -1], [2, 1]]);
    expect(alignChildren(["br", "br"], ["p"])).toEqual([[0, -1], [1, -1], [-1, 0]]);
  });

  it("missing slot on new → MARKUP/missing-element at the missing element", () => {
    const mk = (withShare: boolean) =>
      flat([
        n("main", [0, 0, 1000, 500], { comp: 1 }, [
          n("div", [0, 0, 1000, withShare ? 200 : 140], { cls: ["region", "region-page-header"], comp: 1 }, [
            n("header", [0, 0, 1000, 120], { id: "block-title", t: 10 }),
            ...(withShare ? [n("div", [0, 130, 1000, 60], { cls: ["page-header__social-share"] }, [n("a", [0, 130, 40, 40], { a: { href: "/share" } })])] : []),
          ]),
          n("div", [0, withShare ? 200 : 140, 1000, 300], { cls: ["region-content"], comp: 1, t: 40 }),
        ]),
      ]);
    const o = mk(true);
    const nn = mk(false);
    const d = findDivergence(o, nn);
    expect(d?.kind).toBe("missing");
    expect(d?.old?.cls).toContain("page-header__social-share");
    expect(d?.path.join(" > ")).toContain("div.region.region-page-header");
    const c = classify({ divergence: d, oldNodes: o, newNodes: nn, styleDiff: [], rules: [], assets: emptyAssets, attributes: [] });
    expect(c).toMatchObject({ cause: "MARKUP", subtype: "missing-element", lane: "design" });
  });

  it("extra <p> inside a prop container → MARKUP/extra-wrapper", () => {
    const o = flat([n("div", [0, 0, 300, 100], { cls: ["card-item__body"], t: 50 }, [n("br", [0, 20, 0, 18]), n("br", [0, 40, 0, 18])])]);
    const nn = flat([n("div", [0, 0, 300, 108], { cls: ["card-item__body"] }, [n("p", [0, 0, 300, 108], { t: 50 }, [n("br", [0, 20, 0, 18]), n("br", [0, 40, 0, 18])])])]);
    const d = findDivergence(o, nn);
    expect(d).toMatchObject({ kind: "extra" });
    expect(d?.new?.tag).toBe("p");
    expect(classify({ divergence: d, oldNodes: o, newNodes: nn, styleDiff: [], rules: [], assets: emptyAssets, attributes: [] })).toMatchObject({ cause: "MARKUP", subtype: "extra-wrapper" });
  });

  it("lazy image resolved on new → ASSET/lazy-src", () => {
    const o = flat([n("footer", [0, 0, 375, 300], { comp: 1 }, [n("img", [10, 10, 1, 1], { cls: ["b-lazy"], a: { src: "data:image/gif;base64,…", "data-src": "/files/map.webp" }, img: { nw: 1, nh: 1, cur: "data:image/gif;base64,…", done: true } })])]);
    const nn = flat([n("footer", [0, 0, 375, 461], { comp: 1 }, [n("img", [10, 10, 284, 161], { cls: ["b-lazy"], a: { src: "/files/map.webp", "data-src": "/files/map.webp" }, img: { nw: 512, nh: 290, cur: "/files/map.webp", done: true } })])]);
    const d = findDivergence(o, nn)!;
    expect(d.old?.tag).toBe("img");
    const c = classify({ divergence: d, oldNodes: o, newNodes: nn, styleDiff: [], rules: [], assets: emptyAssets, attributes: [{ node: "img.b-lazy", attr: "src", old: "data:image/gif;base64,…", new: "/files/map.webp" }] });
    expect(c).toMatchObject({ cause: "ASSET", subtype: "lazy-src" });
  });

  it("inline element dropped inside rich text → CONTENT lane; same structure + other text length → CONTENT", () => {
    const o = flat([n("div", [0, 0, 300, 40], { cls: ["field--name-body"] }, [n("p", [0, 0, 300, 40], { t: 30 }, [n("abbr", [50, 0, 30, 20], { t: 3 })])])]);
    const nn = flat([n("div", [0, 0, 300, 40], { cls: ["field--name-body"] }, [n("p", [0, 0, 300, 40], { t: 33 })])]);
    const d = findDivergence(o, nn, { regions: [{ x: 40, y: 0, w: 50, h: 22 }] });
    expect(d?.kind).toBe("missing");
    expect(classify({ divergence: d, oldNodes: o, newNodes: nn, styleDiff: [], rules: [], assets: emptyAssets, attributes: [] })).toMatchObject({ cause: "CONTENT", subtype: "richtext-inline-dropped:abbr", lane: "content" });
    // no pixel diff → the detail pass is skipped entirely
    expect(findDivergence(o, nn, { regions: [] })).toBeUndefined();

    const o2 = flat([n("h2", [0, 0, 300, 40], { t: 20 })]);
    const n2 = flat([n("h2", [0, 0, 300, 80], { t: 45 })]);
    expect(classify({ divergence: findDivergence(o2, n2), oldNodes: o2, newNodes: n2, styleDiff: [], rules: [], assets: emptyAssets, attributes: [] })).toMatchObject({ cause: "CONTENT", subtype: "text-length-differs" });
  });

  it("noscript-only stylesheet loaded on new → CSS_ORDER; winning rule only on old → CSS_MISSING", () => {
    const snap = (css: string[], ns: string[] = []) => ({ snapshot: { nodes: [], truncated: false, height: 0, stylesheets: css.map((href) => ({ href, owner: "link" })), noscriptStylesheets: ns, scripts: [], inlineScripts: 0 }, failedRequests: [], consoleErrors: [] });
    const assets = diffAssetSets(snap(["/a.css", "/seckit.no_body.css"], ["/modules/seckit/css/seckit.noscript_tag.css"]), snap(["/a.css", "/seckit.no_body.css", "/_design/styles/seckit.noscript_tag.css"]));
    expect(assets.stylesheets.noscriptLoadedOnNew).toEqual(["/_design/styles/seckit.noscript_tag.css"]);
    const o = flat([n("div", [0, 0, 300, 0], { cls: ["swiper-slide"], a: { style: "height: 0px;" } })]);
    const nn = flat([n("div", [0, 0, 300, 339], { cls: ["swiper-slide"], a: { style: "height: 339px;" } })]);
    const d = findDivergence(o, nn);
    expect(classify({ divergence: d, oldNodes: o, newNodes: nn, styleDiff: [], rules: [], assets, attributes: [] })).toMatchObject({ cause: "CSS_ORDER", subtype: "noscript-stylesheet-loaded" });

    const o3 = flat([n("h2", [0, 0, 300, 40], { cls: ["title"], t: 10 })]);
    const n3 = flat([n("h2", [0, 0, 300, 52], { cls: ["title"], t: 10 })]);
    const rules = [{ node: "h2.title", level: 0, prop: "line-height", old: [{ selector: ".title", href: "/theme.css", origin: "regular", value: "1.2", wins: true }], new: [{ selector: "h2", href: "user-agent", origin: "user-agent", value: "normal", wins: true }] }];
    expect(classify({ divergence: findDivergence(o3, n3), oldNodes: o3, newNodes: n3, styleDiff: [{ node: "h2.title", level: 0, side: "pair", props: { "line-height": { old: "40px", new: "52px" } } }], rules, assets: emptyAssets, attributes: [] })).toMatchObject({ cause: "CSS_MISSING", subtype: "rule-missing" });
  });

  it("proven instability → DYNAMIC (mask lane); skeleton is text-free", () => {
    const o = flat([n("div", [0, 0, 300, 100], { cls: ["ticker"], t: 12 })]);
    const c = classify({ divergence: findDivergence(o, flat([n("div", [0, 0, 300, 120], { cls: ["ticker"], t: 12 })])), oldNodes: o, newNodes: o, styleDiff: [], rules: [], assets: emptyAssets, attributes: [], dynamic: { proven: true, parity: 0.98, regions: 1 } });
    expect(c).toMatchObject({ cause: "DYNAMIC", lane: "mask" });
    expect(skeleton(o, o[0])).toBe('<div class="ticker">… [300×100]');
  });

  it("component class regex: generic default + theme prefixes from site config", () => {
    expect(new RegExp(COMPONENT_CLASS_RE).test("dsu-c-hero")).toBe(false);
    expect(new RegExp(COMPONENT_CLASS_RE).test("paragraph--type--text")).toBe(true);
    expect(new RegExp(componentClassRe(["dsu-c-", "ln-c-"])).test("dsu-c-hero")).toBe(true);
    expect(new RegExp(componentClassRe(["a.b"])).test("axb")).toBe(false);
  });

  it("verify filters: --urls / --viewports parsing", () => {
    const vps = [{ name: "mobile", width: 375, height: 812 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1440, height: 900 }];
    expect(resolveViewports(undefined, vps)).toBe(vps);
    expect(resolveViewports(["mobile,desktop"], vps).map((v) => v.name)).toEqual(["mobile", "desktop"]);
    expect(resolveViewports("tablet", vps).map((v) => v.name)).toEqual(["tablet"]);
    expect(() => resolveViewports(["phone"], vps)).toThrow(/unknown viewport/);
    expect(resolveViewports([vps[0]], vps)).toEqual([vps[0]]);
    expect(parseUrlList("/,/about")).toEqual(["/", "/about"]);
    expect(parseUrlList(["/a", "/b,/c"])).toEqual(["/a", "/b", "/c"]);
    expect(parseUrlList(undefined)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ real browser: privacy + instability

const SECRET = ["Zebrafinch", "quantumlollipop", "Marmaladeoctopus", "Xylophonewizard"];
const page = (o: { share: boolean; ticker?: number }) => `<!doctype html><html lang="en"><head><title>${SECRET[0]} title</title>
<meta name="description" content="${SECRET[1]} description"><style>body{margin:0;font:16px/1.5 sans-serif} .hero{height:200px;background:#eee} .share{height:60px;background:#c00}</style></head>
<body><header class="site-header"><nav class="nav-main"><a href="/x" title="${SECRET[2]}" aria-label="${SECRET[2]}">${SECRET[0]} link</a></nav></header>
<main><section class="paragraph--type--hero hero" data-title="${SECRET[3]} words here" data-id="hero-1"><h1>${SECRET[0]} ${SECRET[1]}</h1>
<img alt="${SECRET[3]} alt" src="data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="10" height="10"></section>
${o.share ? `<div class="share"><p>${SECRET[2]} share text</p></div>` : ""}
<div class="ticker" style="height:${40 + (o.ticker ?? 0)}px">${SECRET[1]} ticker</div>
<p class="body">${SECRET.join(" ")} plain body text.</p>
<script>console.error("boom ${SECRET[3]} message that is long enough");</script></main></body></html>`;

let browser: Browser;
const servers: Server[] = [];
let oldUrl = "";
let newUrl = "";
let dynUrl = "";
let tallUrl = "";
async function serve(fn: () => string): Promise<string> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fn());
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  browser = await launchBrowser();
  oldUrl = await serve(() => page({ share: true }));
  newUrl = await serve(() => page({ share: false }));
  let k = 0;
  dynUrl = await serve(() => page({ share: true, ticker: (k++ % 2) * 30 }));
  tallUrl = await serve(() => page({ share: true, ticker: 30 }));
});
afterAll(async () => {
  await browser?.close();
  for (const s of servers) await new Promise((r) => s.close(r));
});

const vp = { name: "desktop", width: 800, height: 600 };

describe("diagnoseShot (browser)", () => {
  it("finds the missing block, classifies MARKUP and leaks no page text", async () => {
    const d = await diagnoseShot(browser, { path: "/", oldUrl: oldUrl + "/", newUrl: newUrl + "/", viewport: vp });
    expect(d.parity.value).toBeLessThan(1);
    expect(d.firstDivergence).toMatchObject({ kind: "missing", element: "div.share" });
    expect(d.classification).toMatchObject({ cause: "MARKUP", subtype: "missing-element" });
    expect(d.instability?.tested).toBe(true);
    expect(d.instability?.divergenceUnstable).toBe(false);
    expect(d.instability?.maskCandidates).toEqual([]);
    expect(d.markup.old).toContain('<div class="share"> [800×60]');
    const text = JSON.stringify(d);
    for (const w of SECRET) expect(text).not.toContain(w);
    expect(text).not.toMatch(/plain body text|share text|ticker</);
  }, 60_000);

  it("instability self-test: a region that differs between two captures of the original is DYNAMIC with a mask proof", async () => {
    const d = await diagnoseShot(browser, { path: "/", oldUrl: dynUrl + "/", newUrl: tallUrl + "/", viewport: vp });
    expect(d.instability?.unstableElements.join(" ")).toContain("div.ticker");
    expect(d.classification.cause).toBe("DYNAMIC");
    expect(d.instability?.maskCandidates[0]).toMatchObject({ selector: ".ticker" });
    expect(d.instability?.maskCandidates[0].proof).toMatch(/original vs original/);
  }, 60_000);
});

describe("console message scrubbing", () => {
  it("keeps code-like tokens and error vocabulary, drops prose", async () => {
    const { scrubMsg } = await import("../src/diagnose.js");
    expect(scrubMsg("pageerror: exports is not defined")).toBe("pageerror: exports is not defined");
    expect(scrubMsg("Failed to load resource: the server responded with a status of 404 (Not Found)")).toContain("status of 404");
    expect(scrubMsg("TypeError: Cannot read properties of undefined (reading 'slick')")).toContain("TypeError:");
    expect(scrubMsg("boom Xylophonewizard message that is long enough")).not.toMatch(/Xylophonewizard|message|enough/);
  });
});

describe("divergence refinements", () => {
  it("a moved-only element is not the cause when a resized one exists; it is reported when nothing else differs", async () => {
    const { assetKey } = await import("../src/diagnose.js");
    const o = flat([n("div", [0, 0, 300, 200], { cls: ["wrap"] }, [n("div", [0, 0, 300, 100], { cls: ["a"] }), n("div", [0, 100, 300, 100], { cls: ["b"] })])]);
    // a got a margin-top: wrap grows, a + b only move → the first moved element (a) is reported
    const moved = flat([n("div", [0, 0, 300, 220], { cls: ["wrap"] }, [n("div", [0, 20, 300, 100], { cls: ["a"] }), n("div", [0, 120, 300, 100], { cls: ["b"] })])]);
    expect(findDivergence(o, moved)?.old?.cls).toEqual(["a"]);
    // a grew: a is the cause even though b (after it) only moved
    const resized = flat([n("div", [0, 0, 300, 220], { cls: ["wrap"] }, [n("div", [0, 0, 300, 120], { cls: ["a"] }), n("div", [0, 120, 300, 100], { cls: ["b"] })])]);
    expect(findDivergence(o, resized)?.old?.cls).toEqual(["a"]);
    const grown = flat([n("div", [0, 0, 300, 230], { cls: ["wrap"] }, [n("div", [0, 0, 300, 100], { cls: ["a"] }), n("div", [0, 130, 300, 100], { cls: ["b"] })])]);
    // wrap grew, a unchanged, b only moved (e.g. a gap above b) → b
    expect(findDivergence(o, grown)?.old?.cls).toEqual(["b"]);
    expect(assetKey("/_design/styles/mainTheme.aaf5871d.css")).toBe(assetKey("/themes/x/mainTheme.css?tgtv2m"));
  });

  it("an inline <style> only on new → CSS_ORDER/stylesheet-set-differs", () => {
    const snap = (sheets: { href: string; selectors?: string[]; rules?: number }[]) => ({ snapshot: { nodes: [], truncated: false, height: 0, stylesheets: sheets.map((x) => ({ ...x, owner: "style" })), noscriptStylesheets: [], scripts: [], inlineScripts: 0 }, failedRequests: [], consoleErrors: [] });
    const assets = diffAssetSets(snap([{ href: "inline:aa", selectors: [".x"], rules: 1 }]), snap([{ href: "inline:aa", selectors: [".x"], rules: 1 }, { href: "inline:bb", selectors: ["body"], rules: 1 }]));
    expect(assets.stylesheets.inlineOnlyNew).toEqual([{ key: "inline:bb", rules: 1, selectors: ["body"] }]);
    const o = flat([n("span", [0, 100, 100, 20], { cls: ["t"] })]);
    const nn = flat([n("span", [0, 177, 100, 20], { cls: ["t"] })]);
    expect(classify({ divergence: findDivergence(o, nn), oldNodes: o, newNodes: nn, styleDiff: [], rules: [], assets, attributes: [] })).toMatchObject({ cause: "CSS_ORDER", subtype: "stylesheet-set-differs" });
  });
});
