import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageScreens, pageSections, tagSections } from "@harness/scene";
import { emitterIds, getEmitter, registerEmitter, rightsNotice } from "@harness/codegen";

const recorded = (w: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../capture/test/sites/acme/recorded/${w}.snapshot.json`, import.meta.url),
      "utf8",
    ),
  );

const input = () => {
  const ps = pageScreens([
    { width: 390, minWidth: 0, snap: recorded(390) },
    { width: 1440, minWidth: 1024, snap: recorded(1440) },
  ]);
  const sections = pageSections(ps.screens);
  return { screens: tagSections(ps.screens, sections), fonts: ps.fonts, page: ps.page, sections };
};

describe("static emitter", () => {
  const inp = input();
  const files = getEmitter("static")!.emit(inp, { sourceUrl: "https://acme.example/", fonts: "reference" });
  const html = String(files["index.html"]);

  it("writes one page as index.html with section markers per variant", () => {
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "index.html",
        "styles.css",
        "tokens.css",
        "nav.js",
        "credits.json",
        "RECREATION.md",
      ]),
    );
    for (const s of inp.sections) {
      expect(html).toContain(`<!-- section:${s.id} -->`);
      expect(html).toContain(`data-section="${s.id}"`);
    }
    // two breakpoint variants: every section framed twice
    expect(html.match(/<!-- section:header -->/g)?.length).toBe(2);
    expect(html.match(/<!-- \/section -->/g)?.length).toBe(inp.sections.length * 2);
    expect(Object.keys(files).some((f) => f.startsWith("assets/"))).toBe(true);
  });

  it("references webfonts at their source by default and embeds them on request", () => {
    expect(String(files["tokens.css"])).toContain("acme-sans.woff2");
    expect(Object.keys(files).some((f) => f.startsWith("fonts/"))).toBe(false);
    const embedded = getEmitter("static")!.emit(inp, { fonts: "embed" });
    expect(Object.keys(embedded).some((f) => f.startsWith("fonts/"))).toBe(true);
    const none = getEmitter("static")!.emit(inp, { fonts: "system", assets: "none" });
    expect(Object.keys(none).some((f) => f.startsWith("fonts/") || f.startsWith("assets/"))).toBe(false);
  });

  it("carries provenance and the rights notice", () => {
    const credits = JSON.parse(String(files["credits.json"]));
    expect(credits.source).toBe("https://acme.example/");
    expect(credits.notice).toBe(rightsNotice("https://acme.example/"));
    expect(String(files["RECREATION.md"])).toContain("rights holder's permission");
  });
});

describe("emitter registry", () => {
  it("lists the built-in emitters and accepts new ones", () => {
    expect(emitterIds()).toEqual(
      expect.arrayContaining(["static", "react-vite", "ds-react", "ds-lit", "ds-angular", "tokens"]),
    );
    registerEmitter({ id: "test-txt", description: "test", emit: (i) => ({ "page.txt": i.page ?? "" }) });
    expect(getEmitter("test-txt")!.emit({ screens: [], page: "P" }, {})).toEqual({ "page.txt": "P" });
    expect(() => registerEmitter({} as never)).toThrow();
  });

  it("writes a React + Vite project", () => {
    const files = getEmitter("react-vite")!.emit(input(), {});
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["package.json", "src/main.tsx", "src/App.tsx", "credits.json"]),
    );
    expect(String(files["package.json"])).toContain('"vite"');
  });
});

describe("wide screens", () => {
  it("a variant measured across its range keeps following the page past its widest measurement (no cap, no frozen term)", () => {
    const css = String(getEmitter("static")!.emit(input(), {})["styles.css"]);
    // the recorded 1440 capture was also walked at 1920: its lines continue past it, as the page's do (a centred
    // column keeps centring, a full-bleed band keeps spanning the window)
    expect(css).not.toMatch(/> main \{ max-width: \d+px; margin-left: auto; margin-right: auto; \}/);
    expect(css).not.toMatch(/min\(100vw, \d+px\)/);
  });
});
