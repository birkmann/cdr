import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  emitAngularPage,
  emitLit,
  emitModern,
  emitReactPage,
  parseHtml,
  toJsx,
  toNgTemplate,
  fitCss,
  fitSamples,
  unify,
  UnifyError,
  type ModernVariant,
} from "@harness/codegen";

const rec = (p: string) => new URL(`../../capture/test/sites/motion/recorded/${p}`, import.meta.url);
function variants(): ModernVariant[] {
  const vs = JSON.parse(readFileSync(rec("variants.json"), "utf8")) as { width: number; minWidth: number }[];
  return vs.map((v) => ({ ...v, snap: JSON.parse(readFileSync(rec(`${v.width}.snapshot.json`), "utf8")) }));
}
const video = {
  "http://motion.example/media/hero.mp4": {
    body: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    type: "video/mp4",
  },
};

describe("fitting measured values", () => {
  const pts = (xs: [number, number][]) => xs.map(([x, y]) => ({ x, y }));
  it("keeps constants, shares and lines", () => {
    expect(
      fitCss(
        fitSamples(
          pts([
            [320, 16],
            [768, 16],
            [1440, 16],
          ]),
        )!,
        "vw",
      ),
    ).toBe("16px");
    expect(
      fitCss(
        fitSamples(
          pts([
            [300, 150],
            [600, 300],
            [900, 450],
          ]),
        )!,
        "%",
      ),
    ).toBe("50%");
    expect(
      fitCss(
        fitSamples(
          pts([
            [400, 191],
            [800, 391],
            [1000, 491],
          ]),
        )!,
        "%",
      ),
    ).toBe("calc(50% - 9px)");
  });

  it("holds a line at a plateau only where the samples show one (min / max, never a bound made up at the ends)", () => {
    // an image as wide as its column up to its own 600 px
    const img = fitSamples(
      pts([
        [288, 288],
        [343, 343],
        [547, 547],
        [711, 600],
        [735, 600],
      ]),
    )!;
    expect(fitCss(img, "%")).toBe("min(600px, 100%)");
    // padding: 64 px until the 1200 px column is centred, then half of what is left (nothing caps it at the widest sample)
    const pad = fitSamples(
      pts([
        [1024, 64],
        [1280, 64],
        [1366, 83],
        [1536, 168],
        [1920, 360],
      ]),
    )!;
    expect(fitCss(pad, "%")).toBe("max(64px, 50% - 600px)");
  });

  it("snaps shares to the fractions people write (thirds, halves)", () => {
    const third = fitSamples(
      pts([
        [900, 289.33],
        [1200, 389.33],
        [1500, 489.33],
      ]),
    )!;
    expect(fitCss(third, "%")).toBe("calc(33.333% - 10.67px)");
  });
});

describe("modern recreation (one DOM for every width)", () => {
  const { files, report, doc } = emitModern({ variants: variants(), media: video, page: "Northwind" });
  const html = String(files["index.html"]);
  const css = String(files["styles.css"]);

  it("writes one semantic document, not a copy per breakpoint", () => {
    expect(html).not.toMatch(/data-bp=/);
    expect(html.match(/<h1\b/g)?.length).toBe(1);
    expect(html.match(/<main\b/g)?.length).toBe(1);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<meta name="description" content="Northwind Studio designs/);
    expect(html).toMatch(/<header class="[^"]+">/);
    expect(html).toMatch(/<footer class="[^"]+">/);
    // every visible text once
    expect(html.match(/We build intelligent experiences/g)?.length).toBe(1);
    expect(report.mediaQueries).toEqual([768, 1024]);
    // the page's own breakpoints, mobile first
    expect(css).toMatch(/@media \(min-width: 768px\)/);
    expect(css).toMatch(/@media \(min-width: 1024px\)/);
    // ranges with an upper bound only scope a state (the open menu) to the widths that have it
    for (const m of css.matchAll(/@media [^{]*max-width[^{]*\{([^\n]*)/g))
      expect(m[1]).toMatch(/:root\[data-menu/);
  });

  it("writes layout intent fitted across widths", () => {
    expect(css).toMatch(/\.hero \{[^}]*height: 70vh;[^}]*min-height: 420px;/);
    expect(css).toMatch(/padding: \d+px max\(64px, 50% - 600px\)/);
    expect(css).toMatch(/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.slide \{[^}]*flex: 0 0 85%/);
    // no box placed by its measured coordinates
    expect(css).not.toMatch(/top: \d{3,}(\.\d+)?px/);
  });

  it("plays the hero video with a pause control, and keeps slider, dots and autoplay", () => {
    expect(html).toMatch(
      /<video [^>]*muted[^>]* data-autoplay[^>]* loop[^>]* playsinline[^>]*><source src="media\/[^"]+\.mp4" type="video\/mp4">/,
    );
    expect(html).toMatch(/data-video-toggle="video-1"/);
    expect(report.videos[0]?.file).toMatch(/^media\//);
    expect(html).toMatch(/data-slider data-autoplay="4000"/);
    expect(html.match(/data-slider-dot="\d"/g)?.length).toBe(5);
    expect(html).toMatch(/data-slider-step="1" aria-controls="slider-1"/);
    expect(css).toMatch(/> \[aria-current="true"\] \{ background-color: #6929c4; \}/);
  });

  it("reproduces hover looks as CSS, the JS-revealed ones too, for every control of a kind", () => {
    // the card arrow is shown by a mouseenter handler on the live page
    expect(css).toMatch(/:hover \.card-arrow, [^{]+:focus-visible \.card-arrow \{ opacity: 1; \}/);
    expect(css).toMatch(/:hover \.image[^{]*\{ scale: 1\.05; \}/);
    expect(css).toMatch(/\.card-arrow \{[^}]*transition: opacity 0\.2s/);
    // all three cards share one look (the capture hovered two)
    const cards = [...html.matchAll(/<li><a class="([^"]+)" href="#(strategy|design|technology)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(cards).size).toBe(1);
  });

  it("adds what accessibility needs: a skip link, names for icon controls, in-page links", () => {
    expect(html).toMatch(/<a class="skip-link" href="#main">Skip to content<\/a>/);
    expect(html).toMatch(/<a [^>]*href="#work">Work<\/a>/);
    expect(html).toMatch(/<span class="visually-hidden">Open menu<\/span>/);
    expect(html).toMatch(/data-menu-open="menu"/);
    expect(html).toMatch(/data-menu-panel="menu"/);
    expect(css).toMatch(/:root\[data-menu="menu"\] \.menu-panel \{[^}]*display: block/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus-ring\)/);
  });

  it("hands the Lit emitter its sections and the page skeleton", () => {
    expect(doc.sections.filter((s) => s.html).length).toBeGreaterThan(4);
    expect(doc.skeleton).toMatch(/<!--section:[a-z0-9-]+-->/);
    const lit = emitLit(doc, files, { projectName: "Northwind Studio" });
    expect(Object.keys(lit)).toEqual(
      expect.arrayContaining([
        "package.json",
        "index.html",
        "src/main.ts",
        "src/lib/section.ts",
        "src/lib/controllers.ts",
        "src/prerender.ts",
        "scripts/prerender.mjs",
        "vite.config.ts",
      ]),
    );
    const pkg = JSON.parse(String(lit["package.json"]));
    expect(pkg.scripts.build).toMatch(/vite build && node scripts\/prerender\.mjs/);
    expect(pkg.dependencies.lit).toBeTruthy();
    // a section component per section, its template escaped for a template literal
    const tpl = Object.entries(lit).find(([f]) => /^src\/sections\/hero\.template\.ts$/.test(f));
    expect(String(tpl?.[1])).toMatch(/html`<section class="hero">/);
    expect(String(lit["src/main.ts"])).toMatch(/import "\.\/sections\/hero\.js";/);
    expect(String(lit["index.html"])).toMatch(/<northwind-hero><\/northwind-hero>/);
    expect(String(lit["src/styles/base.css"])).toMatch(/northwind-hero[^{]*\{ display: contents; \}/);
    expect(Object.keys(lit).some((f) => /^public\/media\/.+\.mp4$/.test(f))).toBe(true);
    // the slider section drives its slider with a Lit controller
    const work = Object.entries(lit).find(
      ([f, c]) => /^src\/sections\/[^.]+\.ts$/.test(f) && /SliderController/.test(String(c)),
    );
    expect(work).toBeTruthy();
  });

  it("refuses a capture without DOM keys", () => {
    const vs = variants().map((v) => ({
      ...v,
      snap: { ...v.snap, root: { ...v.snap.root!, key: undefined } },
    }));
    const strip = (n: any): any => ({ ...n, key: undefined, children: (n.children ?? []).map(strip) });
    expect(() => unify(vs.map((v) => ({ ...v, snap: { ...v.snap, root: strip(v.snap.root) } })))).toThrow(
      UnifyError,
    );
  });

  it("switches tabs and accordions in place: a region per widget, its states as CSS, its controls announcing them", () => {
    // the tabs: one region holding the tab list and the panels; each tab selects a state
    expect(html).toMatch(/data-region="r\d+"/);
    expect(html).toMatch(/aria-selected="true"[^>]*data-region-set="r\d+:\d"/);
    expect(css).toMatch(/\[data-region="r\d+"\]\[data-state="2"\] \.[\w-]+ \{ display: none; \}/);
    // the accordion: a toggle that expands its answer
    expect(html).toMatch(
      /data-region-toggle="r\d+:1"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-region-toggle="r\d+:1"/,
    );
    expect(String(files["app.js"])).toMatch(/data-region-toggle/);
  });

  it("writes the page as a React project: one component per section, JSX from the markup, prerendered and hydrated", () => {
    const react = emitReactPage(doc, files, { projectName: "Northwind Studio" });
    expect(String(react["src/App.tsx"])).toMatch(/<Hero \/>/);
    expect(String(react["src/main.tsx"])).toMatch(/startTransition\(\(\) => void hydrateRoot\(root, app\)\)/);
    expect(String(react["scripts/prerender.mjs"])).toMatch(/ssrLoadModule\("\/src\/entry-server\.tsx"\)/);
    expect(JSON.parse(String(react["package.json"])).scripts.build).toMatch(/node scripts\/prerender\.mjs/);
    const hero = String(react["src/sections/Hero.tsx"]);
    expect(hero).toMatch(/className="hero"/);
    expect(hero).not.toMatch(/\sclass=/);
    // markup to JSX: props, numbers, booleans, text kept exactly
    expect(
      toJsx(
        parseHtml(
          '<label for="x" class="a" tabindex="0">Hi {there}</label><video autoplay muted playsinline></video><img alt="" src="a.png">',
        ),
      ),
    ).toBe(
      [
        '<label htmlFor="x" className="a" tabIndex={0}>',
        '  {"Hi {there}"}',
        "</label>",
        "<video autoPlay muted playsInline />",
        '<img alt="" src="a.png" />',
      ].join("\n"),
    );
    expect(
      toJsx(
        parseHtml(
          '<svg viewBox="0 0 2 2"><path stroke-width="2" fill-opacity="0.5" style="stop-color: red"/></svg>',
        ),
      ),
    ).toMatch(/<path strokeWidth="2" fillOpacity="0\.5" style=\{\{ stopColor: "red" \}\} \/>/);
  });

  it("writes the page as an Angular project: standalone components, templates with Angular's syntax characters escaped", () => {
    const ng = emitAngularPage(doc, files, { projectName: "Northwind Studio" });
    const cfg = JSON.parse(String(ng["angular.json"]));
    expect(cfg.projects["northwind-studio"].architect.build.options.outputMode).toBe("static");
    expect(String(ng["src/app/app.config.ts"])).toMatch(/provideClientHydration\(withEventReplay\(\)\)/);
    expect(String(ng["src/app/page/page.html"])).toMatch(/<northwind-hero \/>/);
    expect(String(ng["src/app/sections/hero/hero.ts"])).toMatch(/selector: "northwind-hero"/);
    expect(toNgTemplate(parseHtml("<p>Mail us @ {home}</p>"))).toBe("<p>Mail us &#64; &#123;home&#125;</p>");
  });
});

describe("desktop navigation flyouts", () => {
  // the fixture's 1440 walk with one more navigation entry: a link whose panel shows while the pointer is over it
  const font = {
    family: "Arial",
    stack: "Arial, Helvetica, sans-serif",
    size: 16,
    weight: 400,
    ascent: 13,
    lineHeight: 24,
    letterSpacing: 0,
    color: "rgb(22, 22, 22)",
  };
  const K = "body/header:0/nav:0/div:9";
  const text = (key: string, s: string, x: number, y: number) => ({
    key,
    ord: 0,
    kind: "text",
    text: s,
    lines: [{ text: s, x, y, w: 80, h: 18 }],
    font,
  });
  const entry = (open: boolean) => ({
    id: 9001,
    key: K,
    tag: "div",
    rect: { x: 900, y: 16, w: 80, h: 32 },
    layout: { display: "block", position: "static" },
    attrs: { class: "nav-item" },
    style: { color: "rgb(22, 22, 22)" },
    ord: 9,
    children: [
      {
        id: 9002,
        key: `${K}/a:0`,
        tag: "a",
        rect: { x: 900, y: 16, w: 80, h: 32 },
        layout: { display: "block", position: "static" },
        attrs: { href: "http://motion.example/services/", class: "nav-link" },
        aria: { "aria-haspopup": "true", "aria-controls": "panel-1" },
        style: { color: "rgb(22, 22, 22)" },
        pointer: true,
        ord: 0,
        children: [text(`${K}/a:0~0`, "Services", 900, 20)],
      },
      {
        id: 9003,
        key: `${K}/ul#panel-1:0`,
        tag: "ul",
        rect: { x: 0, y: 64, w: 1440, h: open ? 200 : 1 },
        layout: { display: "block", position: "absolute", padding: [0, 32, 0, 32] },
        attrs: { id: "panel-1", class: "sub-menu" },
        aria: { "aria-hidden": "true" },
        style: { bg: "rgb(255, 255, 255)", opacity: open ? undefined : 0, overflow: ["hidden", "hidden"] },
        ...(open ? {} : { invisible: true }),
        ord: 1,
        children: open
          ? [
              {
                id: 9004,
                key: `${K}/ul#panel-1:0/li:0`,
                tag: "li",
                rect: { x: 32, y: 96, w: 300, h: 24 },
                layout: { display: "list-item", position: "static" },
                attrs: {},
                style: { color: "rgb(22, 22, 22)" },
                ord: 0,
                children: [
                  {
                    id: 9005,
                    key: `${K}/ul#panel-1:0/li:0/a:0`,
                    tag: "a",
                    rect: { x: 32, y: 96, w: 120, h: 24 },
                    layout: { display: "inline", position: "static" },
                    attrs: { href: "http://motion.example/services/strategy/" },
                    style: { color: "rgb(22, 22, 22)" },
                    pointer: true,
                    ord: 0,
                    children: [text(`${K}/ul#panel-1:0/li:0/a:0~0`, "Strategy", 32, 99)],
                  },
                ],
              },
            ]
          : [],
      },
    ],
  });
  const vs = variants();
  const wide = vs[vs.length - 1]!.snap as unknown as Record<string, any>;
  const nav = wide.root.children
    .find((c: any) => c.key === "body/header:0")
    .children.find((c: any) => c.key === "body/header:0/nav:0");
  nav.children.push(entry(false));
  wide.controls = [...(wide.controls ?? []), { kind: "hover", id: 9002 }];
  const { snapshot: _s, ...shell } = wide.states[0];
  wide.states.push({
    ...shell,
    kind: "region",
    index: wide.controls.length - 1,
    region: 9001,
    toggle: false,
    hover: true,
    label: "Services",
    snapshot: { ...wide.states[0].snapshot, root: entry(true), controls: [] },
  });
  const { files } = emitModern({ variants: vs, media: video, page: "Northwind" });
  const html = String(files["index.html"]);
  const css = String(files["styles.css"]);

  it("keeps the panel's content, opens it on hover and keyboard focus, and leaves the link a link", () => {
    expect(html).toMatch(/<ul class="[^"]+" id="panel-1"><li[^>]*><a[^>]*>Strategy<\/a>/);
    expect(html).not.toMatch(/id="panel-1"[^>]*aria-hidden/);
    expect(html).toMatch(/<a [^>]*href="http:\/\/motion\.example\/services\/"[^>]*>Services/);
    expect(html).not.toMatch(/data-region-(toggle|set)="r\d+:\d+"[^>]*>Services/);
    const r = /data-region="(r\d+)"/.exec(html.slice(html.indexOf("Services") - 600))?.[1];
    expect(r).toBeTruthy();
    expect(css).toContain(`:is([data-region="${r}"]:hover, [data-region="${r}"]:focus-within) .`);
    expect(css).toMatch(
      new RegExp(`data-region="${r}"\\]:focus-within\\) \\.[\\w-]+ \\{[^}]*visibility: visible`),
    );
  });

  it("hangs the closed panel under its bar: it opens downwards, never over the navigation", () => {
    const cls = /<ul class="([^"]+)" id="panel-1"/.exec(html)![1]!;
    expect(css).toMatch(new RegExp(`\\.${cls} \\{[^}]*top: 100%`));
    expect(css).not.toMatch(new RegExp(`\\.${cls} \\{[^}]*bottom:`));
  });

  it("lets a panel grow to its content's height in a transition (not in a jump)", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\) \{ :root \{ interpolate-size: allow-keywords; \} \}/,
    );
  });

  it("resets fieldsets: no browser frame around a form's groups", () => {
    expect(css).toMatch(/:where\(fieldset\) \{ border: 0; padding: 0; min-width: 0; \}/);
  });
});
