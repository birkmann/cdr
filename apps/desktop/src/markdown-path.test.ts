import { describe, expect, it } from "vitest";
import { isMarkdownPath, resolveRelative } from "./markdown-path";

describe("markdown paths", () => {
  it("detects Markdown files", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/Guide.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("src/index.ts")).toBe(false);
  });

  it("resolves references relative to the file", () => {
    expect(resolveRelative("README.md", "docs/readme/hub.jpg")).toBe("docs/readme/hub.jpg");
    expect(resolveRelative("docs/a/b.md", "../img/x.png")).toBe("docs/img/x.png");
    expect(resolveRelative("docs/a/b.md", "./c.md")).toBe("docs/a/c.md");
    expect(resolveRelative("docs/a/b.md", "/root.md")).toBe("root.md");
    expect(resolveRelative("README.md", "my%20file.png")).toBe("my file.png");
    expect(resolveRelative("README.md", "prototypes/")).toBe("prototypes/");
  });

  it("refuses paths that leave the workspace", () => {
    expect(resolveRelative("README.md", "../secret")).toBeNull();
    expect(resolveRelative("README.md", "")).toBeNull();
  });
});
