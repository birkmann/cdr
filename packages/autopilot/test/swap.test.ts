import { describe, expect, it } from "vitest";
import { decideSwaps, revertIssues, swapsSource } from "@harness/autopilot";

const usage = [
  { set: "Primary", section: "hero", viewport: "desktop" },
  { set: "Tag", section: "hero", viewport: "desktop" },
  { set: "Footer", section: "footer", viewport: "desktop" },
];

describe("the swap contract", () => {
  it("keeps every swap when the sections hold their gate", () => {
    const d = decideSwaps({
      enabled: ["Primary", "Tag", "Footer"],
      usage,
      sections: { hero: { desktop: 0.99 }, footer: { desktop: 0.98 } },
      sets: { Primary: { desktop: 0.5 } },
      gate: 0.97,
    });
    expect(d.revert).toEqual([]);
    expect(d.keep).toEqual(["Primary", "Tag", "Footer"]);
  });

  it("reverts the set whose crop misses when its section drops below the gate", () => {
    const d = decideSwaps({
      enabled: ["Primary", "Tag", "Footer"],
      usage,
      sections: { hero: { desktop: 0.9 }, footer: { desktop: 0.99 } },
      sets: { Primary: { desktop: 0.6 }, Tag: { desktop: 0.995 } },
      gate: 0.97,
    });
    expect(d.revert).toEqual([
      { set: "Primary", section: "hero", viewport: "desktop", sectionParity: 0.9, setParity: 0.6 },
    ]);
    expect(d.keep).toEqual(["Tag", "Footer"]);
  });

  it("reverts every swap in the section when none of their crops stands out", () => {
    const d = decideSwaps({
      enabled: ["Primary", "Tag"],
      usage,
      sections: { hero: { desktop: 0.9 } },
      sets: { Primary: { desktop: 0.99 }, Tag: { desktop: 0.99 } },
      gate: 0.97,
    });
    expect(d.revert.map((r) => r.set)).toEqual(["Primary", "Tag"]);
    expect(d.keep).toEqual([]);
  });

  it("records DS_SWAP_REVERTED with the crop", () => {
    const issues = revertIssues(
      {
        keep: [],
        revert: [
          { set: "Primary", section: "hero", viewport: "desktop", sectionParity: 0.9, setParity: 0.6 },
        ],
      },
      { "Primary@desktop": "/tmp/crop.png" },
    );
    expect(issues).toEqual([
      {
        code: "DS_SWAP_REVERTED",
        message: expect.stringContaining("Primary at desktop in section hero"),
        severity: "warning",
        evidence: ["/tmp/crop.png"],
      },
    ]);
  });

  it("writes the flags for every candidate", () => {
    expect(swapsSource(["A"], ["A", "B"])).toContain('{"A":true,"B":false}');
  });
});
