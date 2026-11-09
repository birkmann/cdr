import { describe, expect, it } from "vitest";
import { summariseCoverage } from "@harness/autopilot";

const sample = (viewport: string, painted: number, primitive: number, set: number, section: number) => ({
  viewport,
  painted,
  primitive,
  set,
  section,
  byComponent: {},
});

describe("DS coverage", () => {
  it("counts primitives and repeated components over painted boxes", () => {
    const r = summariseCoverage([sample("desktop", 100, 10, 50, 40)]);
    expect(r.value).toBe(0.6);
    expect(r.primitiveOnly).toBe(0.1);
    expect(r.withSections).toBe(1);
  });

  it("reports the lowest viewport as the number that is gated", () => {
    const r = summariseCoverage([sample("mobile", 100, 20, 30, 50), sample("desktop", 200, 80, 80, 40)]);
    expect(r.value).toBe(0.5);
    expect(r.perViewport.desktop!.value).toBe(0.8);
  });

  it("is zero, not NaN, on a page with no painted boxes", () => {
    expect(summariseCoverage([sample("desktop", 0, 0, 0, 0)]).value).toBe(0);
    expect(summariseCoverage([]).value).toBe(0);
  });
});
