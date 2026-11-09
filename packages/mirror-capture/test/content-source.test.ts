import { describe, expect, it } from "vitest";
import { preferRenderedContent } from "../src/to-ccm.js";
import { pageContentHtml } from "../src/content-source.js";

const NEXT = '<script src="/_next/static/chunks/main.js" async></script>';
const doc = (main: string, extra = NEXT) => `<!doctype html><html><head>${extra}</head><body><header>Menu</header><main>${main}</main></body></html>`;
const words = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}word`).join(" ");

describe("content source (bvg.de: news and disruptions are fetched in the browser)", () => {
  const skeleton = `<h1>Startseite</h1><p>${words(40, "base")}</p><div class="skeleton"></div>`;
  const loaded = `<h1>Startseite</h1><p>${words(40, "base")}</p><ul><li>${words(40, "news")}</li></ul>`;

  it("prefers the rendered DOM when it adds substantial content to the server HTML", () => {
    expect(preferRenderedContent(doc(skeleton), doc(loaded))).toBe(true);
  });
  it("keeps the server HTML when JS only adds a word or two, or when the rendered DOM lost server content", () => {
    expect(preferRenderedContent(doc(skeleton), doc(`${skeleton}<p>${words(3, "w")}</p>`))).toBe(false);
    expect(preferRenderedContent(doc(skeleton), doc(`<h1>Startseite</h1><p>${words(20, "base")}</p><ul><li>${words(40, "news")}</li></ul>`))).toBe(false);
  });
  it("prefers a rendered DOM that adds a small client-loaded section", () => {
    expect(preferRenderedContent(doc(skeleton), doc(`${skeleton}<section><h2>Beliebte Modelle</h2><p>${words(9, "car")}</p></section>`))).toBe(true);
  });
  it("keeps other JS sites on their server HTML: their own scripts render client content in the generated app", () => {
    expect(preferRenderedContent(doc(skeleton, '<script src="/etc.clientlibs/app.js"></script>'), doc(loaded, '<script src="/etc.clientlibs/app.js"></script>'))).toBe(false);
  });
  it("keeps web-component pages on their server HTML", () => {
    const wc = Array.from({ length: 8 }, (_, i) => `<x${i}-card>c</x${i}-card>`).join("");
    expect(preferRenderedContent(doc(skeleton + wc), doc(loaded + wc))).toBe(false);
  });
  it("keeps Drupal pages raw-first", () => {
    expect(preferRenderedContent(doc(skeleton, NEXT + '<script type="application/json" data-drupal-selector="drupal-settings-json">{}</script>'), doc(loaded))).toBe(false);
  });
  it("ignores text inside scripts and styles", () => {
    expect(preferRenderedContent(doc(skeleton), doc(`${skeleton}<script>var x = "${words(80, "js")}";</script>`))).toBe(false);
  });

  describe("pageContentHtml (one decision for ccm, coverage and verify)", () => {
    const files = { raw: "p.raw.html", rendered: "p.rendered.html" };
    const reader = (raw: string | undefined, rendered: string) => async (rel: string) => {
      if (rel === "p.rendered.html") return rendered;
      if (rel === "p.raw.html" && raw !== undefined) return raw;
      throw new Error("ENOENT");
    };
    it("takes the server HTML by default", async () => {
      expect(await pageContentHtml(files, reader(doc(skeleton), doc(skeleton + "<p>x</p>")))).toEqual({ html: doc(skeleton), source: "raw" });
    });
    it("takes the rendered DOM when the page is client-rendered", async () => {
      expect(await pageContentHtml(files, reader(doc(skeleton), doc(loaded)))).toEqual({ html: doc(loaded), source: "rendered" });
    });
    it("falls back to the rendered DOM without a usable raw capture, and honours contentSource: rendered", async () => {
      expect(await pageContentHtml(files, reader(undefined, doc(loaded)))).toEqual({ html: doc(loaded), source: "rendered" });
      expect(await pageContentHtml(files, reader("<html>error</html>", doc(loaded)))).toEqual({ html: doc(loaded), source: "rendered" });
      expect(await pageContentHtml(files, reader(doc(skeleton), doc(skeleton)), "rendered")).toEqual({ html: doc(skeleton), source: "rendered" });
    });
  });
});
