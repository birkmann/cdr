// Snapshot strings (the page's <html lang>, font families / weights from crawled stylesheets) are untrusted: the
// exported HTML and CSS must escape or validate them.
import { describe, expect, it } from "vitest";
import { htmlDocument, safeLang, tokensCss } from "@harness/codegen";

describe("html lang", () => {
  it("keeps valid language tags and falls back to en otherwise", () => {
    expect(safeLang("de")).toBe("de");
    expect(safeLang(" en-US ")).toBe("en-US");
    expect(safeLang("zh-Hant-TW")).toBe("zh-Hant-TW");
    for (const bad of ['en"><script>alert(1)</script>', "", "en us", "-en", "x".repeat(9), undefined, null])
      expect(safeLang(bad)).toBe("en");
  });

  it("htmlDocument cannot be broken out of through lang", () => {
    const html = htmlDocument({ title: "t", body: "", lang: 'en"><script>alert(1)</script><x a="' });
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain("<script>alert");
    expect(htmlDocument({ title: "t", body: "", lang: "fr-CA" })).toContain('<html lang="fr-CA">');
  });
});

describe("@font-face in tokens.css", () => {
  it("escapes the family and file, validates weight / style / range / format", () => {
    const css = tokensCss({}, [
      {
        family: "Evil'; } body { background: url(https://x.example/) } </style><script>alert(1)</script>",
        file: "fonts/a.woff2') ; } x { y: url('z",
        weight: "400; } body { color: red",
        style: "normal; } *{",
        format: "woff2') } *{",
        unicodeRange: "U+0-FF; } *{",
      },
    ]);
    const face = css.split(":root")[0]!;
    // one rule, nothing after its closing brace, no markup
    // outside its (escaped) string literals the rule has exactly one block
    expect(face.replace(/'(?:\\.|[^'\\\n])*'/g, "''").match(/[{}]/g)).toEqual(["{", "}"]);
    expect(face).not.toMatch(/[<>]/);
    expect(face).toContain("font-weight: 400;");
    expect(face).toContain("font-style: normal;");
    expect(face).toContain("format('woff2')");
    expect(face).not.toContain("unicode-range");
  });

  it("leaves ordinary faces as they were", () => {
    const css = tokensCss({}, [
      { family: "Inter", file: "fonts/inter.woff2", weight: "100 900", unicodeRange: "U+0000-00FF" },
    ]);
    expect(css).toContain(
      "@font-face {\n  font-family: 'Inter';\n  src: url('fonts/inter.woff2') format('woff2');\n  font-weight: 100 900;\n  font-style: normal;\n  unicode-range: U+0000-00FF;\n  font-display: swap;\n}\n",
    );
  });
});
