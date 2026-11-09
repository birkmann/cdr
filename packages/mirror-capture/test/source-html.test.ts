import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { createTempWorkspace, testSiteConfig, silentLogger, validateCcm, readCcm, type StepContext, type Workspace } from "@harness/mirror-core";
import { startFixtureServer, type FixtureServer } from "../../mirror/test/fixtures/serve.js";
import { htmlAdapter, buildCcm, readCrawl } from "../src/index.js";

const POC = ["/", "/about-us", "/news/healthy-breakfast", "/de", "/de/ueber-uns"];
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

let server: FixtureServer;
let ws: Workspace;
let cleanup: () => Promise<void>;
let ctx: StepContext;

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

beforeAll(async () => {
  server = await startFixtureServer({ port: 0, quiet: true });
  ({ ws, cleanup } = await createTempWorkspace("fixture"));
  const site = testSiteConfig({
    site: "fixture",
    baseUrl: server.baseUrl,
    urls: POC,
    locales: [
      { code: "en", name: "English", default: true, pathPrefix: "" },
      { code: "de", name: "Deutsch", fallback: "en", pathPrefix: "de" },
    ],
    crawl: { follow: false, maxPages: 50, viewports: VIEWPORTS, mask: ["#cookie-banner"] },
  });
  ctx = { site, ws, dryRun: false, log: silentLogger, options: {} };
}, 60_000);

afterAll(async () => {
  await server?.close();
  await cleanup?.();
});

describe("fixture server", () => {
  it("serves pages, 301 redirects and a 404 page", async () => {
    for (const p of POC) expect((await fetch(server.baseUrl + p)).status).toBe(200);
    const r = await fetch(server.baseUrl + "/node/2", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/about-us");
    expect((await fetch(server.baseUrl + "/de/alt-ueber-uns", { redirect: "manual" })).headers.get("location")).toBe("/de/ueber-uns");
    const nf = await fetch(server.baseUrl + "/does-not-exist");
    expect(nf.status).toBe(404);
    expect(await nf.text()).toContain("Page not found");
    const home = await (await fetch(server.baseUrl + "/")).text();
    expect(home).toContain(`<link rel="canonical" href="${server.baseUrl.replace("localhost", "localhost")}/" />`);
  });
});

describe("htmlAdapter", () => {
  it("detects a Drupal 10 site", async () => {
    const info = await htmlAdapter.detect(ctx);
    expect(info.system).toBe("drupal");
    expect(info.version).toBe("10");
    expect(info.capabilities).toContain("sitemap");
  });

  it("extract: crawls POC URLs with screenshots, assets and manifests", async () => {
    const rep = await htmlAdapter.extract(ctx);
    expect(rep.ok).toBe(true);
    expect(rep.gates?.["crawl.pocUrls"].pass).toBe(true);
    expect(rep.stats.pages).toBe(5);
    expect(rep.stats.screenshots).toBe(15);
    const crawl = (await readCrawl(ws))!;
    expect(crawl.pages.map((p) => p.path).sort()).toEqual([...POC].sort());
    for (const p of crawl.pages) {
      expect(p.status).toBe(200);
      expect(p.styles.desktop.cssVariables["--color-primary"]).toBe("#1f4e79");
      expect(p.styles.mobile.mediaQueries).toContain("(min-width: 768px)");
      expect(p.styles.desktop.fonts.some((f) => f.family === "Inter" && f.status === "loaded")).toBe(true);
      for (const vp of VIEWPORTS) {
        const file = ws.path(p.screenshots[vp.name]);
        const size = pngSize(await readFile(file));
        expect(size.width).toBe(vp.width);
        expect(size.height).toBeGreaterThan(vp.height * 0.8);
      }
      expect(await readFile(ws.path(p.files.rendered), "utf8")).toContain("<html");
      // third-party analytics is blocked, never fetched
      expect(p.network.find((n) => n.url.includes("googletagmanager"))?.blocked).toBe(true);
    }
    // mobile and desktop layouts differ (responsive theme)
    const home = crawl.pages.find((p) => p.path === "/")!;
    expect(home.styles.mobile.documentHeight).toBeGreaterThan(home.styles.desktop.documentHeight);
    const paths = crawl.assets.map((a) => a.path);
    for (const want of [
      "/sites/default/files/2024-05/hero-breakfast.jpg",
      "/sites/default/files/2024-05/oats.jpg",
      "/sites/default/files/logo.svg",
      "/themes/custom/demo/css/base.css",
      "/themes/custom/demo/fonts/inter-regular.woff2",
      "/themes/custom/demo/images/footer-pattern.png",
      "/themes/custom/demo/images/icon-menu.svg",
    ])
      expect(paths).toContain(want);
    for (const a of crawl.assets) expect((await stat(ws.path(a.file))).size).toBe(a.size);
    // hard-coded /node/N links in body text were probed and recorded as redirects
    expect(crawl.index.redirects).toContainEqual({ from: "/node/2", to: "/about-us", status: 301 });
  });

  it("toCCM: fast path produces valid CCM with referential integrity", async () => {
    const rep = await htmlAdapter.toCCM(ctx);
    expect(rep.ok).toBe(true);
    const v = await validateCcm(ws);
    expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(v.ok).toBe(true);
    const b = await readCcm(ws);
    const types = b.schema.contentTypes.map((t) => t.id).sort();
    expect(types).toEqual(["article", "landingPage", "page", "sectionHero", "sectionTeaserList", "sectionText"]);
    expect(b.schema.contentTypes.find((t) => t.id === "sectionHero")!.kind).toBe("component");
    expect(b.locales.map((l) => [l.code, l.default, l.pathPrefix])).toEqual([["en", true, ""], ["de", false, "de"]]);

    // translations share a ccmId (Drupal-native ids when the markup exposes nid/pid: same ids as the Drupal import)
    const about = b.entries.filter((e) => e.ccmId === "drupal:node:2");
    expect(about.map((e) => [e.locale, e.path, e.slug]).sort()).toEqual([["de", "/de/ueber-uns", "ueber-uns"], ["en", "/about-us", "about-us"]]);
    expect(about.find((e) => e.locale === "de")!.fields.title).toBe("Über uns");
    const aboutBody = JSON.stringify(about.find((e) => e.locale === "en")!.fields.body);
    expect(aboutBody).toContain('"type":"rawHtml"'); // table
    expect(aboutBody).toContain('"embeddedAsset"');
    expect(aboutBody).toContain('{"kind":"entry","id":"drupal:node:3"}'); // /node/3 resolved via redirect probe

    const home = b.entries.find((e) => e.ccmId === "drupal:node:1" && e.locale === "en")!;
    expect(home.type).toBe("landingPage");
    expect(home.slug).toBe("");
    expect(home.meta?.description).toBe("Recipes and nutrition tips for a better breakfast.");
    expect(home.meta?.hreflang?.map((h) => h.locale)).toEqual(["en", "de"]);
    const sections = home.fields.sections as { id: string }[];
    expect(sections.map((s) => b.entries.find((e) => e.ccmId === s.id)!.type)).toEqual(["sectionHero", "sectionText", "sectionTeaserList"]);
    const hero = b.entries.find((e) => e.ccmId === sections[0].id && e.locale === "de")!;
    expect(hero.fields).toMatchObject({ title: "Starte richtig in den Tag", cta: { href: "/de/news/gesundes-fruehstueck", ref: { kind: "entry", id: "drupal:node:3" } } });
    const teaser = b.entries.find((e) => e.ccmId === sections[2].id && e.locale === "en")!;
    expect(teaser.fields.collection).toEqual({ collection: "articles--block_latest" });
    expect(b.collections[0]).toMatchObject({ id: "articles--block_latest", type: "article", sort: [{ field: "created", direction: "desc" }] });

    // assets with alt per locale, downloaded files
    const oats = b.assets.find((a) => a.originalPath === "/sites/default/files/2024-05/oats.jpg")!;
    expect(oats.alt).toEqual({ en: "Rolled oats", de: "Haferflocken" });
    expect(oats.src).toBe("raw/html/assets/sites/default/files/2024-05/oats.jpg");
    expect(oats.mime).toBe("image/jpeg");

    // article not crawled in German: partial entry from the German teaser, same ccmId
    const art = b.entries.filter((e) => e.ccmId === "drupal:node:3");
    expect(art.map((e) => e.locale).sort()).toEqual(["de", "en"]);
    expect(art.find((e) => e.locale === "de")!.fields.title).toBe("Fünf Tipps für ein gesundes Frühstück");
    expect(art.find((e) => e.locale === "en")!.fields.tags).toEqual([
      { kind: "term", id: "html:term:/tags/breakfast" },
      { kind: "term", id: "html:term:/tags/nutrition" },
    ]);

    // navigation + settings
    const main = b.navigation.find((n) => n.id === "main")!;
    expect(main.items.map((i) => i.label.en)).toEqual(["Home", "About us", "News"]);
    expect(main.items[1].label.de).toBe("Über uns");
    expect(main.items[2].children[0].ref).toEqual({ kind: "entry", id: "drupal:node:3" });
    const footer = b.navigation.find((n) => n.id === "footer")!;
    expect(footer.items[0].href).toBe("https://www.acme.com/imprint");
    expect(b.settings!.siteName).toEqual({ en: "Acme Demo Kitchen", de: "Acme Demo Küche" });
    expect(b.settings!.footerText!.de).toContain("Alle Rechte vorbehalten");
    expect(b.settings!.scripts!.map((s) => s.id)).toEqual(["analytics-gtm", "cookie-consent"]);
    expect(b.redirects.find((r) => r.from === "/de/node/2")).toMatchObject({ to: "/de/ueber-uns", locale: "de" });
  });

  it("analyze + proposeMapping write inventory and mapping", async () => {
    const a = await htmlAdapter.analyze(ctx);
    expect(a.stats.paragraphTypes).toBe(3);
    const inv = await ws.readJson<{ templates: { template: string }[]; thirdPartyScripts: { src: string }[] }>("analysis/html-inventory.json");
    expect(inv.templates.map((t) => t.template).sort()).toEqual(["node:article", "node:landing_page", "node:page"]);
    expect(inv.thirdPartyScripts[0].src).toContain("googletagmanager");
    await htmlAdapter.proposeMapping!(ctx);
    const yaml = await ws.readText("mapping/html.yaml");
    expect(yaml).toContain("sectionTeaserList:");
    expect(yaml).toContain("source: .field--name-field-sections");
  });

  it("follow mode: sitemap + menus, listing and term pages", async () => {
    const { ws: ws2, cleanup: c2 } = await createTempWorkspace("fixture-follow");
    try {
      const ctx2: StepContext = { ...ctx, ws: ws2, site: { ...ctx.site, urls: ["/"], crawl: { ...ctx.site.crawl, follow: true, viewports: [VIEWPORTS[2]] } } };
      const rep = await htmlAdapter.extract(ctx2);
      expect(rep.stats.pages).toBe(14);
      await htmlAdapter.toCCM(ctx2);
      const v = await validateCcm(ws2);
      expect(v.issues.filter((i) => i.severity === "error")).toEqual([]);
      const b = await readCcm(ws2);
      expect(b.collections.map((c) => c.id).sort()).toEqual(["articles--block_latest", "articles--page_news", "taxonomy_term--page_1"]);
      // W2-F: crawled Views page displays are routable (per-locale crawled path), embedded blocks and term pages are not
      const news = b.collections.find((c) => c.id === "articles--page_news")!;
      expect(news.path).toBeDefined();
      expect(Object.values(news.path!).every((p) => p.startsWith("/"))).toBe(true);
      expect(b.collections.find((c) => c.id === "articles--block_latest")!.path).toBeUndefined();
      expect(b.collections.find((c) => c.id === "taxonomy_term--page_1")!.path).toBeUndefined();
      const tags = b.taxonomies.find((t) => t.id === "tags")!;
      expect(tags.terms.find((t) => t.ccmId === "html:term:/tags/breakfast")!.name).toEqual({ en: "Breakfast", de: "Frühstück" });
      // every node translation is a full entry now (no teaser stubs)
      expect(b.entries.filter((e) => e.type === "article").every((e) => e.source.kind === "page")).toBe(true);
    } finally {
      await c2();
    }
  }, 120_000);
});

describe("buildCcm generic fallback", () => {
  it("maps a non-Drupal page to page + sectionGeneric", async () => {
    const html = `<!doctype html><html lang="en"><head><title>Hello | Acme</title><meta name="description" content="d"></head><body>
      <header><a href="/"><img src="/logo.png" alt="Acme"></a><nav><ul><li><a href="/">Home</a></li><li><a href="/x">X</a></li></ul></nav></header>
      <main><div class="wrap"><h1>Hello</h1><section class="intro"><h2>Intro</h2><p>Some <b>bold</b> text.</p></section><section class="pic"><img src="/a.jpg" alt="A"></section></div></main>
      <footer><p>© Acme</p></footer></body></html>`;
    const res = await buildCcm({
      baseUrl: "http://acme.test",
      pages: [{ id: "root", path: "/", requestedUrl: "http://acme.test/", finalUrl: "http://acme.test/", status: 200, redirectChain: [], bodyClasses: [], files: { raw: "r", rendered: "x" }, screenshots: {}, styles: {}, images: [], network: [], links: [], hreflang: [] }],
      assets: [],
      links: {},
      redirects: [],
      readText: async () => html,
    });
    const page = res.entries.find((e) => e.type === "page")!;
    expect(page.fields.title).toBe("Hello");
    const secs = res.entries.filter((e) => e.type === "sectionGeneric");
    expect(secs.map((s) => s.fields.heading)).toEqual(["Intro", undefined]);
    expect(res.assets.map((a) => a.originalPath).sort()).toEqual(["/a.jpg", "/logo.png"]);
    expect(res.navigation[0].items.map((i) => i.label.en)).toEqual(["Home", "X"]);
    expect(res.settings.footerText).toEqual({ en: "© Acme" });
  });

  it("redirects a page's own uncrawled URLs (canonical / hreflang) and the empty site root to the crawled page (bmw.de)", async () => {
    const html = `<!doctype html><html lang="de-DE"><head><title>BMW</title><link rel="canonical" href="http://bmw.test/de/home.html"><link rel="alternate" hreflang="de-DE" href="http://bmw.test/de/home.html"></head><body>
      <header><a href="/de/home.html"><img src="/logo.svg" alt="BMW"></a></header><main><h1>Willkommen</h1><p>Text.</p></main></body></html>`;
    const page = (path: string) => ({ id: path, path, requestedUrl: "http://bmw.test" + path, finalUrl: "http://bmw.test" + path, status: 200, redirectChain: [], bodyClasses: [], files: { raw: "r", rendered: "x" }, screenshots: {}, styles: {}, images: [], network: [], links: [], hreflang: [] });
    const input = { baseUrl: "http://bmw.test", assets: [], links: {}, redirects: [], readText: async () => html, siteLocales: [{ code: "de-DE", default: true, pathPrefix: "" }], urls: ["/de/index.html"] };
    const res = await buildCcm({ ...input, pages: [page("/de/index.html")] });
    expect(res.redirects.map((r) => [r.from, r.to, r.status])).toEqual([["/de/home.html", "/de/index.html", 301], ["/", "/de/index.html", 301]]);
    // a crawled alias, a recorded redirect and a crawled root are left alone
    const res2 = await buildCcm({ ...input, pages: [page("/de/index.html"), page("/de/home.html")], redirects: [{ from: "/", to: "/de/index.html", status: 302 }] });
    expect(res2.redirects.map((r) => [r.from, r.to, r.status])).toEqual([["/", "/de/index.html", 302]]);
  });
});

describe("mediaRefsOf — files the page links", () => {
  it("collects same-origin linked documents wherever the CMS stores them, not third-party ones", async () => {
    const { mediaRefsOf } = await import("../src/crawl.js");
    const html = `<a href="/content/dam/bmw/x/Uebersicht.pdf.asset.1771311194085.pdf">PDF</a><a href="/sites/default/files/a.docx?v=2">doc</a><a href="/de/index.html">page</a><a href="https://other.test/x.pdf">ext</a><img src="/i.png">`;
    expect(mediaRefsOf(html, "http://x.test")).toEqual(["http://x.test/content/dam/bmw/x/Uebersicht.pdf.asset.1771311194085.pdf", "http://x.test/i.png", "http://x.test/sites/default/files/a.docx?v=2"]);
  });
});
