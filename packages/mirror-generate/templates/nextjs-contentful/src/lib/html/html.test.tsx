/**
 * Raw HTML of the source page (rawHtml nodes, html fields) as React elements: what a visitor of the original sees
 * must survive sanitising — forms and controls (bvg.de journey planner), web components (lufthansa.com <maui-image>,
 * ibm.com <c4d-card>), full SVG — while script and event handlers never do.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RawHtml } from "../richtext/RawHtml";
import { domProps } from "../render/static";

const render = (html: string) => renderToStaticMarkup(<RawHtml html={html} />);

describe("RawHtml sanitising", () => {
  it("keeps the source's forms and controls, uncontrolled, without handlers", () => {
    const out = render('<form id="connectionForm" action="/de/verbindungen" onsubmit="x()"><label for="s">Start</label><input type="search" id="s" value="Alex" placeholder=" " required><select name="t"><option value="1" selected>1</option></select><textarea name="n">Hi</textarea></form>');
    expect(out).toContain('<form id="connectionForm" action="/de/verbindungen">');
    expect(out).toContain('<input type="search" id="s" placeholder=" " required="" value="Alex"/>');
    expect(out).toContain("<select");
    expect(out).toContain(">Hi</textarea>");
    expect(out).not.toContain("onsubmit");
  });
  it("keeps custom elements (web components) with their attributes and slots", () => {
    const out = render('<maui-tooltip placement="top"><span slot="box">Hint</span></maui-tooltip><c4d-card href="/x" onclick="y()">Card</c4d-card>');
    expect(out).toContain('<maui-tooltip placement="top"><span slot="box">Hint</span></maui-tooltip>');
    expect(out).toContain('<c4d-card href="/x">Card</c4d-card>');
  });
  it("keeps SVG gradients, masks and text with their original case", () => {
    const out = render('<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><rect width="5" height="5"/></clipPath></defs><text x="1">A</text></svg>');
    expect(out).toContain("<linearGradient");
    expect(out).toContain("<clipPath");
    expect(out).toContain("<text");
  });
  it("keeps inert JSON data blocks the page's scripts read (ibm.com image components), never executable ones", () => {
    const out = render('<div class="image"><script type="application/json">{"src":"/a.png","w":"<b>"}</script><script>alert(1)</script><script type="application/json">x</script></script>y</script></div>');
    expect(out).toContain('<script type="application/json">{"src":"/a.png","w":"<b>"}</script>');
    expect(out).not.toContain("alert(1)");
  });
  it("still drops scripts and javascript: URLs", () => {
    const out = render('<div><script>alert(1)</script><a href="javascript:alert(1)">x</a></div>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("javascript:");
  });
});

describe("crawled <html>/<body> attributes", () => {
  it("turns a style attribute into a React style object (CSS variables keep their name)", () => {
    expect(domProps({ "data-bds-nav-bar": "shown", style: "--navbar-rect-height: 80px; margin-top: 0", class: "a b" })).toEqual({
      "data-bds-nav-bar": "shown",
      style: { "--navbar-rect-height": "80px", marginTop: "0" },
      className: "a b",
    });
  });
});
