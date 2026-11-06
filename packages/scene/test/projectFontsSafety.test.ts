// Font weights / families come from crawled stylesheets: they must not reach file paths or CSS unvalidated.
import { describe, expect, it } from "vitest";
import { projectFontFaceCss, projectFontFileName, safeFontWeight, type ProjectFont } from "@harness/scene";

const face = (o: Partial<ProjectFont>): ProjectFont => ({
  id: "pf-abcdef123",
  family: "Brand",
  weight: "400",
  style: "normal",
  format: "woff2",
  src: "data:font/woff2;base64,AAAA",
  size: 4,
  ...o,
});

describe("font weight", () => {
  it("accepts CSS weights only", () => {
    expect(safeFontWeight("700")).toBe("700");
    expect(safeFontWeight(" 100   900 ")).toBe("100 900");
    expect(safeFontWeight("450.5")).toBe("450.5");
    expect(safeFontWeight("Bold")).toBe("bold");
    expect(safeFontWeight(300)).toBe("300");
    for (const bad of ["/../../../../tmp/pwn", "0", "1001", "100 200 300", "400;}", "", "normal bold", null])
      expect(safeFontWeight(bad)).toBeNull();
  });

  it("keeps the bundle path inside fonts/", () => {
    const name = projectFontFileName(face({ weight: "/../../../../tmp/pwn", family: "../../x" }));
    expect(name).toMatch(/^fonts\/[a-z0-9-]+\.woff2$/);
    expect(name).not.toContain("..");
    expect(projectFontFileName(face({ weight: "100 900", style: "italic" }))).toBe(
      "fonts/brand-100-900-italic-abcdef.woff2",
    );
  });

  it("escapes the family and validates descriptors in @font-face", () => {
    const css = projectFontFaceCss([
      face({
        family: "x'; } body { background: red } </style><script>alert(1)</script>",
        weight: "400; } *{",
        stretch: "50%; } *{",
        unicodeRange: "U+0-FF; } *{",
      }),
    ]);
    // outside its (escaped) string literals the rule has exactly one block
    expect(css.replace(/'(?:\\.|[^'\\\n])*'/g, "''").match(/[{}]/g)).toEqual(["{", "}"]);
    expect(css).not.toMatch(/[<>]/);
    expect(css).toContain("font-weight: 400;");
    expect(css).not.toContain("font-stretch");
    expect(css).not.toContain("unicode-range");
  });
});
