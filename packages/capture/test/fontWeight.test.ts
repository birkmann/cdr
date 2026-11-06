// @font-face weights from crawled stylesheets end up in file names: only CSS weights survive capture.
import { describe, expect, it } from "vitest";
import { cssFontWeight, fontFaces } from "@harness/capture";

describe("captured font weights", () => {
  it("validates font-weight descriptors", () => {
    expect(cssFontWeight("700")).toBe("700");
    expect(cssFontWeight("100  900")).toBe("100 900");
    expect(cssFontWeight("BOLD")).toBe("bold");
    for (const bad of ["/../../../../tmp/pwn", "0", "1001", "x", "", null])
      expect(cssFontWeight(bad)).toBeNull();
  });

  it("drops traversal payloads from stylesheets", () => {
    const [f] = fontFaces(
      `@font-face { font-family: Brand; src: url(f.woff2); font-weight:/../../../../tmp/pwn }`,
      "https://site.example/",
    );
    expect(f!.weight).toBe("400");
  });
});
