import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reactInteractionsModule } from "@harness/codegen";
import { INTERACTIONS_RUNTIME_HASH, INTERACTIONS_RUNTIME_SOURCE } from "../src/export/generated.js";

describe("embedded interactions runtime", () => {
  it("is in sync with src/export/interactionsRuntime.ts (run scripts/recreate/embed.mjs after editing it)", () => {
    const src = readFileSync(new URL("../src/export/interactionsRuntime.ts", import.meta.url), "utf8");
    expect(INTERACTIONS_RUNTIME_SOURCE).toBe(src);
    expect(INTERACTIONS_RUNTIME_HASH).toBe(createHash("sha256").update(src).digest("hex").slice(0, 16));
  });

  it("ships as a React module with the useInteractions hook", () => {
    const mod = reactInteractionsModule();
    expect(mod).toContain('import { useEffect } from "react"');
    expect(mod).toContain("export function installInteractions");
    expect(mod).toContain("export function useInteractions");
  });
});
