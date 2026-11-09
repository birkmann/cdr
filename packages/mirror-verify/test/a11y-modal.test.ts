import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { a11yAxeSource } from "../src/checks/a11y.js";

// live ibm.com: TrustArc's consent overlay is open, so stock axe lets landmark-one-main pass ("passForModal")
const page = (modal: boolean) => `<!doctype html><html lang="en"><head><title>t</title></head><body>
<header><h1>Title</h1></header><div>content without a main landmark</div>
${modal ? '<div role="dialog" aria-modal="true" aria-label="Cookie consent" style="position:fixed;inset:0;background:#fff">consent</div>' : ""}
</body></html>`;

describe("a11y: page-level landmark/heading rules ignore open modals (both sides judged alike)", () => {
  it("reports landmark-one-main with and without a consent modal", async () => {
    const source = a11yAxeSource();
    expect(source).toBeDefined();
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const results: Record<string, string[]> = {};
      for (const modal of [false, true]) {
        for (const [name, src] of [["stock", undefined], ["pipeline", source]] as const) {
          const p = await ctx.newPage();
          await p.setContent(page(modal));
          const r = await new AxeBuilder({ page: p, ...(src ? { axeSource: src } : {}) }).withRules(["landmark-one-main"]).analyze();
          results[`${name}:${modal ? "modal" : "plain"}`] = r.violations.map((v) => v.id);
          await p.close();
        }
      }
      expect(results).toEqual({
        "stock:plain": ["landmark-one-main"],
        "stock:modal": [], // the original's false pass
        "pipeline:plain": ["landmark-one-main"],
        "pipeline:modal": ["landmark-one-main"],
      });
    } finally {
      await browser.close();
    }
  });
});
