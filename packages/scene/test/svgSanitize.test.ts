// sanitizeSvg without a DOM parser (node): the tokenizing fallback must rebuild the markup from the allowlist.
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "@harness/scene";

/** No executable construct left: event handlers, script-ish elements, javascript: URLs. */
const inert = (out: string | null) => {
  expect(typeof DOMParser).toBe("undefined"); // exercising the DOM-less path
  expect(out).not.toBeNull();
  expect(out!).not.toMatch(/[\s/"']on[a-z]+\s*=/i);
  expect(out!).not.toMatch(/<(script|img|a|iframe|foreignobject|object|embed|set|animate)\b/i);
  expect(out!).not.toMatch(/javascript:/i);
};

describe("sanitizeSvg (DOM-less)", () => {
  it("drops handlers separated by `/` (image/href/onerror bypass)", () => {
    const out = sanitizeSvg(`<svg><image/href="data:image/png;base64,AA"/onerror=alert(1) /></svg>`);
    inert(out);
    expect(out).toContain('href="data:image/png;base64,AA"');
    expect(out).toMatch(/<image href="data:image\/png;base64,AA"\/><\/svg>$/);
  });

  it("drops HTML elements inside <desc>", () => {
    const out = sanitizeSvg(`<svg><desc><img/src=x/onerror=alert(2)></desc><path d="M0 0"/></svg>`);
    inert(out);
    expect(out).toContain("<desc></desc>");
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("drops script elements with their content", () => {
    for (const p of [
      `<svg><script>alert(1)</script></svg>`,
      `<svg><SCRIPT>alert(1)</SCRIPT></svg>`,
      `<svg><script/src=//evil.example/x.js></script></svg>`,
      `<svg><g><script>alert(1)</g></svg>`,
    ]) {
      const out = sanitizeSvg(p);
      inert(out);
      expect(out).not.toContain("alert");
    }
  });

  it("drops <a href=javascript:> and its subtree, entity-encoded javascript: hrefs", () => {
    inert(sanitizeSvg(`<svg><a href="javascript:alert(1)"><text>x</text></a></svg>`));
    inert(sanitizeSvg(`<svg><a xlink:href=javascript:alert(1)><rect/></a></svg>`));
    const out = sanitizeSvg(`<svg><use href="&#x6a;avascript:alert(1)"/><use xlink:href="#ok"/></svg>`);
    inert(out);
    expect(out).toContain('<use/><use xlink:href="#ok"/>');
  });

  it("handles uppercase, tab, newline and form-feed separators", () => {
    for (const sep of ["\t", "\n", "\r\n", "\f", "/", " /"]) {
      const out = sanitizeSvg(
        `<svg><RECT${sep}ONLOAD="alert(1)"${sep}width="2"/><circle${sep}OnClick="alert(1)" r="1"/></svg>`,
      );
      inert(out);
      expect(out).toContain('width="2"');
      expect(out).toContain('r="1"');
    }
  });

  it("re-escapes values and text so nothing breaks out of an attribute or into markup", () => {
    const out = sanitizeSvg(
      `<svg><title>a &lt;b&gt; &amp; c</title><g data-x='"><img src=x onerror=alert(1)>'><style>.a{fill:red}</style><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></g></svg>`,
    );
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("<title>a &lt;b&gt; &amp; c</title>");
    expect(out).toContain('data-x="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(out).toContain("<style>.a{fill:red}</style>");
    expect(out).not.toMatch(/<style>[^<]*<(?!\/style>)/);
  });

  it("drops external references, foreignObject, animation and namespace tricks", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/1999/xhtml"><foreignObject><body onload=alert(1)/></foreignObject><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onmouseover" to="alert(1)"/><image href="https://evil.example/x.png"/><rect fill="url(https://evil.example/#a)" style="background:url(https://evil.example/)"/><use evil:href="https://evil.example/#a" xml:base="https://evil.example/"/></svg>`,
    );
    inert(out);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("xhtml");
    expect(out).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg">/);
  });

  it("keeps a normal icon intact", () => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" width="24" height="24" fill="none">' +
      '<defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
      '<clipPath id="c"><rect width="24" height="24" rx="4"/></clipPath></defs>' +
      '<g clip-path="url(#c)" style="opacity:0.9"><path d="M12 2L2 22h20z" fill="url(#g1)" stroke="currentColor" stroke-width="1.5"/>' +
      '<use xlink:href="#g1"/><text x="2" y="20" font-family="Inter">Hi &amp; bye</text>' +
      '<image href="data:image/png;base64,AAAA" width="4" height="4"/></g></svg>';
    expect(sanitizeSvg(`<?xml version="1.0"?><!-- c --><!DOCTYPE svg>${icon}`)).toBe(icon);
    expect(sanitizeSvg(`<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>`)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"/></svg>',
    );
  });

  it("rejects non-SVG input and survives malformed markup", () => {
    expect(sanitizeSvg("<div>no</div>")).toBeNull();
    expect(sanitizeSvg("<svg")).toBeNull();
    expect(sanitizeSvg(`<svg><path d="M0 0`)).toBe(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
    expect(sanitizeSvg(`<svg><g><path d="M0 0"/>`)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0"/></g></svg>',
    );
    inert(sanitizeSvg(`<svg><text>&#x110000; 1 < 2</text></svg>`));
  });
});
