import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { SiteConfig, Workspace, type Logger, type StepReport, type Entry } from "@harness/mirror-core";
import {
  verifyStep,
  textSimilarity,
  extractSeo,
  buildVerifyContext,
  expectedRedirects,
  richTextCleanliness,
  richTextFidelity,
  linkCheck,
  captureScreenshot,
  newCaptureContext,
  CHECKS,
  diffRegions,
  attributeRegions,
  hostAllowed,
  diffSeo,
  type CheckResult,
} from "../src/index.js";
import { decodeCfEmails } from "../src/html.js";
import { renderedContentPaths } from "../src/context.js";

// ------------------------------------------------------------------ fixture site

type Variant = {
  aboutText?: string;
  homeMainLink?: string;
  homeImgAlt?: boolean;
  deDescription?: string;
  deColor?: string;
  oldAboutTarget?: string;
  cookieText?: string;
};

const png = (() => {
  const p = new PNG({ width: 40, height: 20 });
  for (let i = 0; i < p.data.length; i += 4) p.data.set([200, 120, 40, 255], i);
  return PNG.sync.write(p);
})();

function page(o: { origin: string; path: string; lang: string; title: string; desc: string; main: string; color?: string; cookie: string; alt: Record<string, string> }) {
  const hreflang = Object.entries(o.alt)
    .map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${o.origin}${p}">`)
    .join("");
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><title>${o.title}</title>
<meta name="description" content="${o.desc}"><link rel="canonical" href="${o.origin}${o.path}">
<meta property="og:title" content="${o.title}"><meta property="og:url" content="${o.origin}${o.path}">${hreflang}
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","url":"${o.origin}${o.path}","name":"${o.title}"}</script>
<style>body{margin:0;font-family:sans-serif;background:${o.color ?? "#ffffff"}}header{height:50px;background:#1f4e79;color:#fff}main{padding:20px}footer{height:40px;background:#333;color:#fff}#cookie-banner{height:40px;background:#eee}</style></head>
<body><header><nav><a href="/">Home</a> <a href="/about-us">About us</a> <a href="/de/ueber-uns">Über uns</a> <a href="/careers">Careers</a></nav></header>
<main>${o.main}</main><footer>© 2024 Demo</footer><div id="cookie-banner">${o.cookie}</div></body></html>`;
}

function makeSite(v: Variant = {}) {
  let origin = "";
  const redirects: Record<string, [number, string]> = {
    "/old-about": [301, v.oldAboutTarget ?? "/about-us"],
    "/node/1": [301, "/"],
    "/node/2": [301, "/about-us"],
    "/de/node/2": [301, "/de/ueber-uns"],
  };
  const pages: Record<string, () => string> = {
    "/": () =>
      page({
        origin,
        path: "/",
        lang: "en",
        title: "Home | Demo",
        desc: "Recipes and tips.",
        cookie: v.cookieText ?? "We use cookies.",
        alt: { en: "/" },
        main: `<div class="paragraph paragraph--type--text"><h2>Why breakfast matters</h2><p>A balanced breakfast gives you energy. Learn more <a href="${v.homeMainLink ?? "/about-us"}">about us</a>.</p></div>
<img src="/sites/default/files/a.png" width="40" height="20"${v.homeImgAlt === false ? "" : ' alt="Oats"'}>`,
      }),
    "/about-us": () =>
      page({
        origin,
        path: "/about-us",
        lang: "en",
        title: "About us | Demo",
        desc: "Who we are.",
        cookie: v.cookieText ?? "We use cookies.",
        alt: { en: "/about-us", de: "/de/ueber-uns" },
        main: `<article class="node--type-page"><h1>About us</h1><p>${v.aboutText ?? "We are a small team of food lovers."}</p><h2>Our values</h2><ul><li>Fresh ingredients</li><li>Simple recipes</li></ul></article>`,
      }),
    "/de/ueber-uns": () =>
      page({
        origin,
        path: "/de/ueber-uns",
        lang: "de",
        title: "Über uns | Demo",
        desc: v.deDescription ?? "Wer wir sind.",
        color: v.deColor,
        cookie: v.cookieText ?? "We use cookies.",
        alt: { en: "/about-us", de: "/de/ueber-uns" },
        main: `<article class="node--type-page"><h1>Über uns</h1><p>Wir sind ein kleines Team von Genießern.</p></article>`,
      }),
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (redirects[path]) {
      res.writeHead(redirects[path][0], { location: redirects[path][1] });
      return res.end();
    }
    if (path === "/sites/default/files/a.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png);
    }
    const p = pages[path];
    if (!p) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<!doctype html><html><head><title>Not found</title></head><body><main>Not found</main></body></html>");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(p());
  });
  return {
    server,
    async start(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return origin;
    },
  };
}

// ------------------------------------------------------------------ fixture CCM

const doc = (...blocks: unknown[]) => ({ type: "doc", children: blocks });
const p = (t: string) => ({ type: "paragraph", children: [{ type: "text", value: t }] });
const h2 = (t: string) => ({ type: "heading", level: 2, children: [{ type: "text", value: t }] });

async function makeWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "cmp-verify-"));
  const ws = new Workspace("t", dir);
  await ws.init();
  await ws.writeJson(Workspace.SCHEMA_PATH, {
    contentTypes: [
      { id: "landingPage", name: "Landing", kind: "document", displayField: "title", fields: [{ id: "title", name: "Title", type: "text" }, { id: "sections", name: "Sections", type: "componentList", cardinality: -1 }] },
      { id: "page", name: "Page", kind: "document", displayField: "title", fields: [{ id: "title", name: "Title", type: "text" }, { id: "body", name: "Body", type: "richText" }] },
      { id: "sectionText", name: "Text", kind: "component", fields: [{ id: "body", name: "Body", type: "richText" }] },
    ],
  });
  await ws.writeJson(Workspace.LOCALES_PATH, [
    { code: "en", name: "English", default: true, pathPrefix: "" },
    { code: "de", name: "Deutsch", default: false, pathPrefix: "de", fallback: "en" },
  ]);
  const src = (kind: string, id: string) => ({ system: "drupal", kind, id });
  const entries: Entry[] = [
    { ccmId: "drupal:node:1", type: "landingPage", locale: "en", path: "/", slug: "", status: "published", fields: { title: "Home", sections: [{ kind: "entry", id: "drupal:paragraph:101" }] }, source: src("node", "1") },
    { ccmId: "drupal:paragraph:101", type: "sectionText", locale: "en", status: "published", fields: { body: doc(h2("Why breakfast matters"), p("A balanced breakfast gives you energy. Learn more about us.")) }, source: src("paragraph", "101") },
    { ccmId: "drupal:node:2", type: "page", locale: "en", path: "/about-us", slug: "about-us", status: "published", fields: { title: "About us", body: doc(p("We are a small team of food lovers."), h2("Our values")) }, source: src("node", "2") },
    { ccmId: "drupal:node:2", type: "page", locale: "de", path: "/de/ueber-uns", slug: "ueber-uns", status: "published", fields: { title: "Über uns", body: doc(p("Wir sind ein kleines Team von Genießern.")) }, source: src("node", "2") },
  ];
  for (const e of entries) await ws.writeJson(ws.entryPath(e.type, e.ccmId, e.locale), e);
  await ws.writeJson(ws.assetPath("drupal:media:22"), { ccmId: "drupal:media:22", src: "raw/files/a.png", originalPath: "/sites/default/files/a.png", fileName: "a.png", mime: "image/png", source: src("media", "22") });
  await ws.writeJson(Workspace.REDIRECTS_PATH, [{ from: "/old-about", to: "internal:/node/2", status: 301, locale: "en" }]);
  await ws.writeJson(Workspace.SETTINGS_PATH, { siteName: { en: "Demo" }, baseUrl: "https://www.example.com" });
  return ws;
}

const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

function siteFor(oldUrl: string) {
  return SiteConfig.parse({
    site: "t",
    baseUrl: oldUrl,
    urls: ["/", "/about-us", "/de/ueber-uns"],
    locales: [{ code: "en", default: true }, { code: "de", pathPrefix: "de" }],
    crawl: { viewports: [{ name: "desktop", width: 800, height: 600 }], mask: ["#cookie-banner"] },
  });
}

async function readCheck(ws: Workspace, id: string): Promise<CheckResult> {
  return JSON.parse(await readFile(ws.path(`verify/${id}.json`), "utf8"));
}

// ------------------------------------------------------------------ tests

const servers: Server[] = [];
const dirs: string[] = [];
let oldUrl = "";
let sameUrl = "";
let alteredUrl = "";

beforeAll(async () => {
  const old = makeSite();
  const same = makeSite({ cookieText: "Different cookie text, masked" });
  const altered = makeSite({
    aboutText: "We are a big team of food lovers.",
    homeMainLink: "/missing-page",
    homeImgAlt: false,
    deDescription: "Ganz anders.",
    deColor: "#ff0000",
    oldAboutTarget: "/wrong",
  });
  oldUrl = await old.start();
  sameUrl = await same.start();
  alteredUrl = await altered.start();
  servers.push(old.server, same.server, altered.server);
});

afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("unit", () => {
  it("source drift needs the live original to differ from its crawl-time capture (a static replay never drifts)", async () => {
    const { sourceDrifted } = await import("../src/checks/visual.js");
    const shot = (paint: (i: number) => [number, number, number], h = 20) => {
      const p = new PNG({ width: 40, height: h });
      for (let i = 0; i < p.data.length; i += 4) p.data.set([...paint(i / 4), 255], i);
      return PNG.sync.write(p);
    };
    const a = shot(() => [200, 120, 40]);
    expect(sourceDrifted(a, shot(() => [200, 120, 40]))).toBe(false); // pixel-identical live and crawl shot
    expect(sourceDrifted(a, shot((i) => (i < 60 ? [0, 0, 0] : [200, 120, 40])))).toBe(true); // a teaser changed
    expect(sourceDrifted(a, shot(() => [200, 120, 40], 24))).toBe(true); // the page grew
  });

  it("once the original drifted, the crawl-time capture judges the shot — also when the live comparison passed", async () => {
    const { judgeDrifted } = await import("../src/checks/visual.js");
    const pass = { parityPass: true, bboxPass: true, heightPass: true };
    const fail = { parityPass: true, bboxPass: true, heightPass: false };
    // live failed (teaser changed), capture reproduced → pass, warning (the classic drift rescue)
    expect(judgeDrifted(fail, { parity: 1, heightDelta: 0, widthDelta: 0 }, 0.97, 4)).toMatchObject({ parityPass: true, heightPass: true, livePass: false, capturePass: true, severity: "warning" });
    // live happened to be in the same short state as the defective new page (ibm.com footer, 144 px) → the capture fails it
    expect(judgeDrifted(pass, { parity: 0.9844, heightDelta: -144, widthDelta: 0 }, 0.97, 4)).toMatchObject({ parityPass: true, heightPass: false, livePass: true, capturePass: false, severity: "warning" });
    // live and capture agree → pass, only an info note
    expect(judgeDrifted(pass, { parity: 0.999, heightDelta: 2, widthDelta: 0 }, 0.97, 4)).toMatchObject({ parityPass: true, heightPass: true, livePass: true, capturePass: true, severity: "info" });
    // fails against both → fail against the capture, warning
    expect(judgeDrifted(fail, { parity: 0.9, heightDelta: 300, widthDelta: 0 }, 0.97, 4)).toMatchObject({ parityPass: false, heightPass: false, livePass: false, capturePass: false, severity: "warning" });
  });

  it("clusters diff pixels into regions and attributes them to the owning component", () => {
    const w = 200;
    const h = 300;
    const mask = new Uint8Array(w * h);
    const blob = (x0: number, y0: number, bw: number, bh: number) => {
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) mask[y * w + x] = 1;
    };
    blob(10, 10, 30, 20); // 600 px, inside the header
    blob(100, 200, 50, 40); // 2000 px, inside the teaser
    const regions = diffRegions(mask, w, h, 2600);
    expect(regions.length).toBe(2);
    expect(regions[0]).toMatchObject({ x: 96, y: 200, pixels: 2000 });
    const boxes = [
      { label: "header.site-header", component: true, path: [], x: 0, y: 0, w: 200, h: 60 },
      { label: "main", component: true, path: [], x: 0, y: 60, w: 200, h: 240 },
      { label: "div.paragraph--type--teaser", component: true, path: ["main"], x: 80, y: 180, w: 120, h: 100 },
      { label: "span", component: false, path: ["main", "div.paragraph--type--teaser"], x: 100, y: 200, w: 50, h: 40 },
    ];
    const att = attributeRegions(regions, boxes);
    expect(att[0].component).toBe("div.paragraph--type--teaser");
    expect(att[0].componentPath).toEqual(["main", "div.paragraph--type--teaser"]);
    expect(att[0].element).toBe("span");
    expect(att[1].component).toBe("header.site-header");
  });

  it("decodes Cloudflare e-mail obfuscation of the captured original", () => {
    // "a@b.co" XOR 0x42
    const hex = "42" + Buffer.from(Array.from(Buffer.from("a@b.co"), (c) => c ^ 0x42)).toString("hex");
    const html = `<a href="/cdn-cgi/l/email-protection#${hex}">x</a> <span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span>`;
    expect(decodeCfEmails(html)).toBe('<a href="mailto:a@b.co">x</a> a@b.co');
  });

  it("host guard: forbidden production origin is refused, only allowed hosts load", () => {
    const o = { allowHosts: ["localhost:4401", "localhost"], forbiddenHosts: ["www.acme.com", "acme.com"] };
    expect(hostAllowed("https://www.acme.com/about", o)).toBe(false);
    expect(hostAllowed("https://cdn.example.net/x.js", o)).toBe(false);
    expect(hostAllowed("http://localhost:4411/_next/x.js", o)).toBe(true);
    expect(hostAllowed("data:image/png;base64,AA", o)).toBe(true);
  });
  it("a live original loads its third parties (CDN, web components) on both sides, trackers never", () => {
    const o = { allowHosts: ["www.volkswagen.de", "127.0.0.1:4438"], allowThirdParty: true, forbiddenHosts: ["www.acme.com"] };
    expect(hostAllowed("https://assets.volkswagen.com/is/image/x.jpg", o)).toBe(true);
    expect(hostAllowed("https://1.www.s81c.com/common/carbon/plex/sans.css", o)).toBe(true);
    expect(hostAllowed("https://www.googletagmanager.com/gtm.js?id=GTM-X", o)).toBe(false);
    expect(hostAllowed("https://tags.tiqcdn.com/utag/vw/main/utag.js", o)).toBe(false);
    expect(hostAllowed("https://www.acme.com/", o)).toBe(false);
  });

  it("SEO: lang, article:* and JSON-LD @graph nodes are compared per node", () => {
    const norm = (u: string) => u;
    const page = (lang: string, mod: string, graph: string) =>
      `<html lang="${lang}"><head><title>T</title><meta property="article:modified_time" content="${mod}"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[${graph}]}</script></head></html>`;
    const a = extractSeo(page("en", "2026-01-01", '{"@type":"Organization","name":"N"},{"@type":"WebPage","name":"A"}'), norm, (s) => s);
    const b = extractSeo(page("en", "2026-01-02", '{"@type":"WebPage","name":"B"},{"@type":"Organization","name":"N"}'), norm, (s) => s);
    const d = diffSeo("/", a, b).map((x) => x.field);
    expect(d).toEqual(["article:modified_time", 'jsonLd["WebPage"]']);
    expect(diffSeo("/", a, extractSeo(page("de", "2026-01-01", '{"@type":"WebPage","name":"A"},{"@type":"Organization","name":"N"}'), norm, (s) => s)).map((x) => x.field)).toEqual(["lang"]);
  });

  it("textSimilarity finds differing windows", () => {
    const r = textSimilarity("we are a small team of food lovers", "we are a big team of food lovers");
    expect(r.similarity).toBeCloseTo(14 / 16);
    expect(r.diffs).toEqual([{ old: "small", new: "big", at: 3 }]);
    expect(textSimilarity("", "").similarity).toBe(1);
  });

  it("extractSeo host-normalises canonical, og:url, hreflang and JSON-LD", () => {
    const html = (host: string) =>
      `<html><head><title>T</title><link rel="canonical" href="${host}/a"><meta property="og:url" content="${host}/a"><link rel="alternate" hreflang="de" href="${host}/de/a"><script type="application/ld+json">{"url":"${host}/a","b":1}</script></head></html>`;
    const known = (u: string, force?: boolean) => (force || /localhost|example/.test(u) ? new URL(u).pathname : u);
    const a = extractSeo(html("http://localhost:4400"), known, (s) => s);
    const b = extractSeo(html("https://www.example.com"), known, (s) => s);
    expect(a).toEqual(b);
    expect(a.canonical).toBe("/a");
    expect(a.hreflang).toEqual(["de -> /de/a"]);
  });

  it("derives /node/<nid> redirects per locale and resolves internal: targets", async () => {
    const ws = await makeWorkspace();
    dirs.push(join(ws.root, ".."));
    const cx = await buildVerifyContext({ site: siteFor("http://127.0.0.1:1"), ws, log }, { newBaseUrl: "http://127.0.0.1:2" });
    const exp = expectedRedirects(cx).map((r) => `${r.from}>${r.to}:${r.status}`);
    expect(exp.sort()).toEqual(["/de/node/2>/de/ueber-uns:301", "/node/1>/:301", "/node/2>/about-us:301", "/old-about>/node/2:301"]);
  });

  it("renders the old side in a browser only for pages whose content came from the rendered DOM", async () => {
    const ws = await makeWorkspace();
    dirs.push(join(ws.root, ".."));
    const words = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}word`).join(" ");
    const next = '<script src="/_next/static/chunks/main.js" async></script>';
    const page = (head: string, main: string) => `<!doctype html><html><head>${head}</head><body><main>${main}</main></body></html>`;
    const base = `<h1>Start</h1><p>${words(40, "base")}</p>`;
    // /de: Next.js page whose news widget is fetched in the browser (skeleton in the server HTML)
    await ws.writeText("raw/html/pages/de.raw.html", page(next, `${base}<div class="skeleton"></div>`));
    await ws.writeText("raw/html/pages/de.rendered.html", page(next, `${base}<ul><li>${words(40, "news")}</li></ul>`));
    await ws.writeJson("raw/html/pages/de.json", { path: "/de", id: "de", status: 200, files: { raw: "raw/html/pages/de.raw.html", rendered: "raw/html/pages/de.rendered.html" } });
    // /about-us: server-rendered page, the rendered DOM adds nothing
    await ws.writeText("raw/html/pages/about-us.raw.html", page("", base));
    await ws.writeText("raw/html/pages/about-us.rendered.html", page("", base));
    await ws.writeJson("raw/html/pages/about-us.json", { path: "/about-us", id: "about-us", status: 200, files: { raw: "raw/html/pages/about-us.raw.html", rendered: "raw/html/pages/about-us.rendered.html" } });
    await ws.writeJson("raw/html/crawl.json", {
      baseUrl: "http://127.0.0.1:1",
      pages: [
        { path: "/de", id: "de", status: 200, manifest: "raw/html/pages/de.json" },
        { path: "/about-us", id: "about-us", status: 200, manifest: "raw/html/pages/about-us.json" },
        { path: "/gone", id: "gone", status: 404, manifest: "raw/html/pages/gone.json" },
      ],
    });
    expect(await renderedContentPaths(ws)).toEqual(["/de"]);
    const cx = await buildVerifyContext({ site: siteFor("http://127.0.0.1:1"), ws, log }, { newBaseUrl: "http://127.0.0.1:2" });
    expect(cx.renderedOldPaths).toEqual(["/de"]);
    // no crawl at all → nothing is rendered
    const ws2 = await makeWorkspace();
    dirs.push(join(ws2.root, ".."));
    expect(await renderedContentPaths(ws2)).toEqual([]);
  });

  it("rich-text cleanliness reports rawHtml share", async () => {
    const ws = await makeWorkspace();
    dirs.push(join(ws.root, ".."));
    await ws.writeJson(ws.entryPath("page", "drupal:node:9", "en"), {
      ccmId: "drupal:node:9",
      type: "page",
      locale: "en",
      path: "/x",
      fields: { title: "X", body: doc({ type: "rawHtml", html: "<table></table>" }, { type: "rawHtml", html: "<iframe></iframe>" }) },
      source: { system: "drupal", kind: "node", id: "9" },
    });
    const cx = await buildVerifyContext({ site: siteFor("http://127.0.0.1:1"), ws, log }, { newBaseUrl: "http://127.0.0.1:2" });
    const r = await richTextCleanliness(cx);
    expect(r.stats.rawHtml).toBe(2);
    expect(r.stats.blocks).toBe(7);
    expect(r.gates.rawHtmlShare.pass).toBe(false);
  });
});

describe("verifyStep against local servers", () => {
  it("identical sites pass every gate", async () => {
    const ws = await makeWorkspace();
    dirs.push(join(ws.root, ".."));
    const site = siteFor(oldUrl);
    // a design/ baseline for "/" captured with the shared routine; other pages fall back to live capture
    const browser = await chromium.launch();
    const bctx = await newCaptureContext(browser, site.crawl.viewports[0]);
    const pg = await bctx.newPage();
    await ws.writeText("design/screenshots/desktop/root.png", await captureScreenshot(pg, oldUrl + "/", site.crawl.viewports[0], { mask: site.crawl.mask }));
    await browser.close();

    const report: StepReport = await verifyStep({ site, ws, dryRun: false, log, options: { newBaseUrl: sameUrl, baseline: "design" } });
    const failing = Object.entries(report.gates!).filter(([, g]) => !g.pass);
    expect(failing, JSON.stringify(report.issues.filter((i) => i.severity === "error"), null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.gates!["visual.parity"].value).toBe(1);
    expect(report.gates!["redirects.failed"].value).toBe(0);
    expect(report.gates!["performance.score"].value).toBe("skipped");
    const visual = await readCheck(ws, "visual");
    const rows = (visual.details as { results: Array<{ path: string; baselineSource: string }> }).results;
    expect(rows.find((r) => r.path === "/")!.baselineSource).toBe("design");
    expect(rows.find((r) => r.path === "/about-us")!.baselineSource).toBe("live");
    // /careers is linked identically on old and new but not part of the POC: reported, not broken
    const links = await readCheck(ws, "links");
    expect(links.stats.outOfScope).toBe(1);
    expect(links.issues.some((i) => i.code === "OUT_OF_SCOPE_LINK" && i.message.includes("/careers"))).toBe(true);
    expect(report.gates!["visual.height"].pass).toBe(true);
    const summary = JSON.parse(await readFile(ws.path("verify/summary.json"), "utf8"));
    expect(summary.ok).toBe(true);
    const content = await readCheck(ws, "content");
    expect(content.stats.entries).toBe(3);
  });

  it("source drift: a difference the crawl-time capture already had is reported, not failed (links, fidelity)", async () => {
    // the "altered" site plays the new site. The crawl captured exactly what the new site shows (/about-us text, the
    // home link to /missing-page); the live original (oldUrl) has moved on since — source drift, not a migration defect.
    const ws = await makeWorkspace();
    dirs.push(join(ws.root, ".."));
    const fetchText = async (u: string) => await (await fetch(u)).text();
    const home = await fetchText(alteredUrl + "/");
    const about = await fetchText(alteredUrl + "/about-us");
    await ws.writeText("raw/html/pages/root.raw.html", home);
    await ws.writeText("raw/html/pages/root.rendered.html", home);
    await ws.writeText("raw/html/pages/about-us.raw.html", about);
    await ws.writeText("raw/html/pages/about-us.rendered.html", about);
    await ws.writeJson("raw/html/pages/root.json", { path: "/", id: "root", status: 200, links: ["/", "/about-us", "/de/ueber-uns", "/careers", "/missing-page"], files: { raw: "raw/html/pages/root.raw.html", rendered: "raw/html/pages/root.rendered.html" } });
    await ws.writeJson("raw/html/pages/about-us.json", { path: "/about-us", id: "about-us", status: 200, links: ["/", "/about-us", "/de/ueber-uns", "/careers"], files: { raw: "raw/html/pages/about-us.raw.html", rendered: "raw/html/pages/about-us.rendered.html" } });
    await ws.writeJson("raw/html/crawl.json", {
      baseUrl: oldUrl,
      pages: [
        { path: "/", id: "root", status: 200, manifest: "raw/html/pages/root.json" },
        { path: "/about-us", id: "about-us", status: 200, manifest: "raw/html/pages/about-us.json" },
      ],
    });
    const cx = await buildVerifyContext({ site: siteFor(oldUrl), ws, log }, { newBaseUrl: alteredUrl });
    expect(cx.crawlPage("/")!.links).toContain("/missing-page");
    expect(cx.crawlPage("/nope")).toBeUndefined();
    try {
      // links: /missing-page is linked by the new home and was linked by the original when crawled → drift + out of scope
      const links = await linkCheck(cx);
      expect(links.gates.broken.value).toBe(0);
      expect(links.gates.structureDiffs.value).toBe(0);
      expect(links.issues.find((i) => i.code === "SOURCE_DRIFT")!.message).toContain("/missing-page");
      expect(links.issues.some((i) => i.code === "BROKEN_LINK" || i.code === "LINK_STRUCTURE")).toBe(false);
      // fidelity: /about-us text differs from the live original but equals the capture → pass with SOURCE_DRIFT
      const fid = await richTextFidelity(cx);
      expect(fid.gates.similarity.pass).toBe(true);
      const row = (fid.details as { pages: Array<{ path: string; baseline: string; liveSimilarity?: number; pass: boolean }> }).pages.find((r) => r.path === "/about-us")!;
      expect(row.baseline).toBe("crawl");
      expect(row.liveSimilarity).toBeLessThan(0.99);
      expect(fid.issues.filter((i) => i.code === "SOURCE_DRIFT").map((i) => i.ref)).toEqual(["/about-us"]);
      expect(fid.issues.some((i) => i.code === "TEXT_DIFF")).toBe(false);
    } finally {
      await cx.close();
    }
    // without a crawl the same differences are migration defects
    const ws2 = await makeWorkspace();
    dirs.push(join(ws2.root, ".."));
    const cx2 = await buildVerifyContext({ site: siteFor(oldUrl), ws: ws2, log }, { newBaseUrl: alteredUrl });
    try {
      expect((await linkCheck(cx2)).gates.broken.value).toBe(1);
      expect((await richTextFidelity(cx2)).gates.similarity.pass).toBe(false);
    } finally {
      await cx2.close();
    }
  });

  it("altered site fails with the right diffs", async () => {
    const ws = await makeWorkspace();
    dirs.push(join(ws.root, ".."));
    const report = await verifyStep({ site: siteFor(oldUrl), ws, dryRun: false, log, options: { newBaseUrl: alteredUrl } });
    const g = report.gates!;
    expect(report.ok).toBe(false);

    // text
    expect(g["fidelity.similarity"].pass).toBe(false);
    const fidelity = await readCheck(ws, "fidelity");
    const about = (fidelity.details as { pages: Array<{ path: string; diffs: Array<{ old: string; new: string }> }> }).pages.find((x) => x.path === "/about-us")!;
    expect(about.diffs).toContainEqual(expect.objectContaining({ old: "small", new: "big" }));
    expect(g["content.missingTexts"].pass).toBe(false);
    const content = await readCheck(ws, "content");
    expect(JSON.stringify(content.details)).toContain("We are a small team of food lovers.");

    // links
    expect(g["links.broken"].value).toBe(1);
    const links = await readCheck(ws, "links");
    expect(links.issues.find((i) => i.code === "BROKEN_LINK")!.message).toContain("/missing-page");
    expect(g["links.structureDiffs"].pass).toBe(false);

    // SEO
    const seo = await readCheck(ws, "seo");
    const diffs = (seo.details as { diffs: Array<{ path: string; field: string; old: string; new: string }> }).diffs;
    expect(diffs).toEqual([{ path: "/de/ueber-uns", field: "description", old: "Wer wir sind.", new: "Ganz anders." }]);

    // redirects
    expect(g["redirects.failed"].value).toBe(1);
    const red = await readCheck(ws, "redirects");
    expect(red.issues[0].message).toContain("/old-about");
    expect(red.issues[0].message).toContain("/wrong");

    // visual
    expect(g["visual.parity"].pass).toBe(false);
    const visual = await readCheck(ws, "visual");
    const rows = (visual.details as { results: Array<{ path: string; parity: number; pass: boolean; diff: string }> }).results;
    const de = rows.find((r) => r.path === "/de/ueber-uns")!;
    expect(de.parity).toBeLessThan(0.97);
    expect((await stat(ws.path(de.diff))).size).toBeGreaterThan(0);
    // default policy: the old side is captured live with the same routine; diff regions are attributed
    const deRow = de as unknown as { baselineSource: string; regions: Array<{ component: string }>; height: { delta: number } };
    expect(deRow.baselineSource).toBe("live");
    expect(deRow.regions.length).toBeGreaterThan(0);
    expect(deRow.height.delta).toBe(0);
    expect(visual.issues.find((i) => i.code === "VISUAL_DIFF" && i.ref === "/de/ueber-uns")!.message).toMatch(/first divergence at y=\d+ in \S+.*top diff regions: \S+/);
    // W1-B: a text-only diagnosis dossier per failing shot, referenced from the row and the issue
    const dg = (de as unknown as { diagnosis?: { file: string; cause: string } }).diagnosis!;
    expect(dg.file).toBe("verify/diagnosis/desktop/de_ueber-uns.json");
    const dossier = JSON.parse(await readFile(ws.path(dg.file), "utf8"));
    expect(dossier.classification.cause).toBe(dg.cause);
    expect(visual.issues.find((i) => i.code === "VISUAL_DIFF" && i.ref === "/de/ueber-uns")!.message).toContain(`[diagnosis: ${dg.cause}`);

    // a11y: img without alt on "/"
    expect(g["a11y.newViolations"].pass).toBe(false);
    const a11y = await readCheck(ws, "a11y");
    expect(a11y.issues.some((i) => i.code === "A11Y_REGRESSION" && i.message.includes("image-alt"))).toBe(true);

    // media still fine
    expect(g["media.missing"].pass).toBe(true);
  });

  it("selected checks only, and a crashing check does not stop the others", async () => {
    const ws = await makeWorkspace();
    dirs.push(join(ws.root, ".."));
    const report = await verifyStep({ site: siteFor(oldUrl), ws, dryRun: false, log, options: { newBaseUrl: sameUrl, checks: ["redirects", "seoParity"], urls: ["/"] } });
    expect(Object.keys(report.gates!).sort()).toEqual(["redirects.failed", "seo.diffs"]);
    expect(report.ok).toBe(true);
    await expect(verifyStep({ site: siteFor(oldUrl), ws, dryRun: false, log, options: { checks: ["seo"] } })).rejects.toThrow(/newBaseUrl/);

    const original = CHECKS.redirects;
    CHECKS.redirects = async () => {
      throw new Error("boom");
    };
    try {
      const r2 = await verifyStep({ site: siteFor(oldUrl), ws, dryRun: false, log, options: { newBaseUrl: sameUrl, checks: "redirects,seo", urls: ["/"] } });
      expect(r2.gates!["redirects.run"]).toEqual({ pass: false, value: "crashed" });
      expect(r2.gates!["seo.diffs"].pass).toBe(true);
      expect(r2.issues.some((i) => i.code === "CHECK_CRASHED")).toBe(true);
    } finally {
      CHECKS.redirects = original;
    }
  });
});
