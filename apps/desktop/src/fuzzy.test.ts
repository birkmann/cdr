import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./components/fuzzy";
import { resolveMarkers } from "./components/conflict-markers";

describe("fuzzy", () => {
  it("matches subsequences and prefers basenames", () => {
    expect(fuzzyScore("xyz", "src/app.ts")).toBeNull();
    const files = ["src/components/AppShell.tsx", "docs/app.md", "src/app.ts", "packages/api/src/index.ts"];
    expect(fuzzyFilter(files, "app.ts", (f) => f)[0]).toBe("src/app.ts");
    expect(fuzzyFilter(files, "apsh", (f) => f)[0]).toBe("src/components/AppShell.tsx");
  });
});

describe("conflict markers", () => {
  const text = [
    "a",
    "<<<<<<< HEAD",
    "ours",
    "||||||| base",
    "base",
    "=======",
    "theirs",
    ">>>>>>> feature",
    "z",
  ].join("\n");
  it("resolves each side", () => {
    expect(resolveMarkers(text, "ours")).toBe("a\nours\nz");
    expect(resolveMarkers(text, "theirs")).toBe("a\ntheirs\nz");
    expect(resolveMarkers(text, "both")).toBe("a\nours\ntheirs\nz");
  });
});
