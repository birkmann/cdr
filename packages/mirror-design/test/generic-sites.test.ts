/**
 * Non-Drupal sources seen in Studio acceptance (bvg.de, ibm.com, volkswagen.de): markup patterns the mining must not break on.
 */
import { describe, expect, it } from "vitest";
import { createTempWorkspace } from "@harness/mirror-core";
import { AssetLoader, mineComponents, portScripts, portStyles, serverPageInfo, type MinePage } from "../src/index.js";
import { isConfigAssignment } from "../src/scripts.js";

const BASE = "https://www.example.test";
const page = (body: string): MinePage => {
  const info = serverPageInfo(`<!doctype html><html lang="de"><head><title>T</title></head><body>${body}</body></html>`, "/de", BASE);
  return { path: "/de", locale: "de", info, ccmType: "page", rawInfo: info };
};

describe("site header with a nav that has no <ul> (bvg.de: <nav><div><a>…)", () => {
  it("keeps the nav markup inline instead of delegating to a mainNav component that is never emitted", () => {
    const nav = '<nav aria-label="Hauptmenü" class="navbar"><div class="inner"><a href="/de">Start</a><a href="/de/verbindungen">Verbindungen</a><a href="/de/abos">Abos &amp; Tickets</a></div></nav>';
    const mined = mineComponents([page(`<header class="site-header">${nav}</header><main><h1>Hallo</h1><p>Text</p></main><footer><p>© 2026</p></footer>`)], { defaultLocale: "de" });
    const header = mined.components.find((c) => c.id === "siteHeader");
    expect(header).toBeDefined();
    expect(mined.components.some((c) => c.id === "mainNav")).toBe(false);
    expect(header!.props.some((p) => p.component === "mainNav")).toBe(false);
    expect(header!.template).toContain("Verbindungen");
  });
});

describe("generic sections inside a grid (bmw.de: main › div.aem-Grid › div.aem-GridColumn)", () => {
  const grid = '<div class="aem-Grid aem-Grid--12">'
    + '<div class="title ctx-mode--dark aem-GridColumn"><div class="cmp-title"><h2>Der BMW 1er.</h2></div></div>'
    + '<div class="container responsivegrid aem-GridColumn style-common--cmp-spacing-top-16"><p>Finden Sie Ihren BMW.</p></div>'
    + "</div>";
  const mined = mineComponents([page(`<header class="site-header"><a href="/de">BMW</a></header><main id="main" class="cmp-container">${grid}</main><footer><p>© 2026</p></footer>`)], { defaultLocale: "de" });

  it("renders the section element stored in CCM `html` as is (no second wrapper, per-section classes kept)", () => {
    const section = mined.components.find((c) => c.id === "sectionGeneric");
    expect(section?.template).toBe("{{{html}}}");
  });
  it("puts the content region inside the grid, so the grid wrapper stays in the page template", () => {
    const tpl = mined.templates.find((t) => t.slots.some((s) => s.component === "sectionGeneric"));
    expect(tpl?.wrapperHtml?.replace(/\s+/g, " ")).toContain('<main id="main" class="cmp-container"><div class="aem-Grid aem-Grid--12">{{{regions.content}}}</div></main>');
  });
});

describe("inline loader configuration (ibm.com: window.CARBON_LOADER_PATH)", () => {
  it("accepts literal global assignments only", () => {
    expect(isConfigAssignment("\n  window.CARBON_LOADER_PATH = '/etc.clientlibs/x/resources/';\n")).toBe(true);
    expect(isConfigAssignment('window.a = 1; var b = "x"; window.c.d = true;')).toBe(true);
    expect(isConfigAssignment("self.__next_f.push([1,'x'])")).toBe(false);
    expect(isConfigAssignment("window.x = foo();")).toBe(false);
    expect(isConfigAssignment("window.adobeDataLayer = window.adobeDataLayer || [];")).toBe(false);
    expect(isConfigAssignment(`window.big = '${"x".repeat(5000)}';`)).toBe(false);
  });
});

describe("CSS-in-JS styles (volkswagen.de: styled-components)", () => {
  it("ports the server-rendered <style data-styled> whose rendered DOM copy is empty (rules live in the CSSOM)", async () => {
    const { ws, cleanup } = await createTempWorkspace("cssinjs");
    const css = ".sc-abc{color:rgb(1,2,3)}.hKfpKH{display:flex}";
    const html = (styled: string) => `<!doctype html><html><head><style>body{margin:0}</style><style data-styled="true" data-styled-version="5.3.11">${styled}</style></head><body><div class="sc-abc hKfpKH">x</div></body></html>`;
    const tree = serverPageInfo(html(""), "/de.html", "https://www.example.test").tree;
    const rawTree = serverPageInfo(html(css), "/de.html", "https://www.example.test").tree;
    const res = await portStyles(ws, { baseUrl: "https://www.example.test", pages: [{ path: "/de.html", tree, rawTree }], assets: [], dryRun: false });
    const bodies = await Promise.all(res.stylesheets.map((h) => ws.readText(`design/${h}`)));
    expect(bodies.some((b) => b.includes(".hKfpKH{display:flex}"))).toBe(true);
    expect(res.stylesheets).toHaveLength(2);
    await cleanup();
  });
});

describe("<style> blocks in the body (bmw.de: AEM icon sizes, dropped from CCM html by the app's sanitizer)", () => {
  it("ports them after the head styles", async () => {
    const { ws, cleanup } = await createTempWorkspace("body-styles");
    const html = '<!doctype html><html><head><style>body{margin:0}</style></head><body><div id="icon-1"><style>@media (min-width:1280px){#icon-1{--icon-size:4rem}}</style><i></i></div></body></html>';
    const tree = serverPageInfo(html, "/de", BASE).tree;
    const res = await portStyles(ws, { baseUrl: BASE, pages: [{ path: "/de", tree, rawTree: tree }], assets: [], dryRun: false });
    const bodies = await Promise.all(res.stylesheets.map((h) => ws.readText(`design/${h}`)));
    expect(bodies).toEqual(["body{margin:0}", "@media (min-width:1280px){#icon-1{--icon-size:4rem}}"]);
    await cleanup();
  });
});

describe("vendor scripts of static web-component sites (ibm.com: consent bootstrap on 1.www.s81c.com)", () => {
  it("references cross-origin non-tracker scripts remotely with their loading attributes; trackers stay out", async () => {
    const { ws, cleanup } = await createTempWorkspace("vendor-scripts");
    const base = "https://www.example.test";
    const html = `<!doctype html><html><head>
<script src="https://rum.hlx.page/.rum/@adobe/helix-rum-js@%5E2/dist/micro.js" defer></script>
<script src="https://cdn.example-cdn.test/common/stats/ibm-common.js" type="text/javascript" async="async"></script>
<script src="https://www.googletagmanager.com/gtm.js?id=GTM-X" async></script>
</head><body><c4d-footer></c4d-footer><script type="module" src="https://cdn.example-cdn.test/wc/modal.min.js"></script></body></html>`;
    const tree = serverPageInfo(html, "/us-en", base).tree;
    const loader = new AssetLoader(ws, base, [], { fetch: false });
    const run = (inline: boolean) => portScripts(ws, { baseUrl: base, pages: [{ path: "/us-en", tree }], loader, dryRun: false, rich: false, inline });
    const res = await run(true);
    expect(res.scripts).toEqual([
      { src: "https://cdn.example-cdn.test/common/stats/ibm-common.js", placement: "head", original: "https://cdn.example-cdn.test/common/stats/ibm-common.js", role: "consent", attrs: { async: "" } },
      { src: "https://cdn.example-cdn.test/wc/modal.min.js", placement: "body", original: "https://cdn.example-cdn.test/wc/modal.min.js", role: "vendor", type: "module" },
    ]);
    expect(res.excluded.map((x) => x.original)).toEqual(["https://rum.hlx.page/.rum/@adobe/helix-rum-js@%5E2/dist/micro.js", "https://www.googletagmanager.com/gtm.js?id=GTM-X"]);
    // server-light sites (crawled DOM rendered as is) keep their previous behaviour: no remote scripts
    expect((await run(false)).scripts).toEqual([]);
    await cleanup();
  });

  it("keeps a script's inline load/error bootstrap (bmw.de: onload starts the ePaaS consent controller)", async () => {
    const { ws, cleanup } = await createTempWorkspace("script-handlers");
    const base = "https://www.example.test";
    const html = `<!doctype html><html><head><script id="epaasScriptTag" onerror="window.epaasNotAvailable=true" src="https://cdn.example-cdn.test/wcmp/consentcontroller.fallback/epaas.js" onload="epaas.api.initialize({tenant: 'ds2~bmw-de', locale: 'de_DE'})"></script></head><body></body></html>`;
    const tree = serverPageInfo(html, "/de/index.html", base).tree;
    const res = await portScripts(ws, { baseUrl: base, pages: [{ path: "/de/index.html", tree }], loader: new AssetLoader(ws, base, [], { fetch: false }), dryRun: false, rich: false, inline: true });
    expect(res.scripts).toEqual([
      { src: "https://cdn.example-cdn.test/wcmp/consentcontroller.fallback/epaas.js", placement: "head", original: "https://cdn.example-cdn.test/wcmp/consentcontroller.fallback/epaas.js", role: "consent", attrs: { id: "epaasScriptTag", onload: "epaas.api.initialize({tenant: 'ds2~bmw-de', locale: 'de_DE'})", onerror: "window.epaasNotAvailable=true" } },
    ]);
    await cleanup();
  });
});
