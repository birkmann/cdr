import { describe, expect, it } from "vitest";
import { ratchetCoverage, type MatrixResult } from "@harness/autopilot";

const coverage = { start: 0.5, step: 0.1, max: 0.9 };

function matrix(values: Record<string, boolean | undefined>, gate = "ds.coverage"): MatrixResult {
  return {
    cycle: 1,
    commit: "c",
    sites: Object.fromEntries(
      Object.entries(values).map(([site, pass]) => [
        site,
        {
          final: {
            stage: "final",
            site,
            status: "passed",
            wallClockMs: 1,
            gates: pass === undefined ? [] : [{ id: gate, pass, hard: true }],
            issues: [],
            artifacts: {},
          },
        },
      ]),
    ),
  };
}

describe("ratchetCoverage", () => {
  it("raises the target by the step when every site passed", () => {
    expect(ratchetCoverage(0.5, coverage, matrix({ a: true, b: true }), ["a", "b"])).toEqual({
      target: 0.6,
      raised: true,
    });
  });

  it("leaves it when a site fell short", () => {
    expect(ratchetCoverage(0.5, coverage, matrix({ a: true, b: false }), ["a", "b"])).toEqual({
      target: 0.5,
      raised: false,
    });
  });

  it("leaves it when a site did not report the gate: a mirror-only cycle says nothing", () => {
    expect(ratchetCoverage(0.5, coverage, matrix({ a: true, b: undefined }), ["a", "b"]).raised).toBe(false);
  });

  it("caps at the maximum and does not raise further", () => {
    expect(ratchetCoverage(0.85, coverage, matrix({ a: true }), ["a"])).toEqual({
      target: 0.9,
      raised: true,
    });
    expect(ratchetCoverage(0.9, coverage, matrix({ a: true }), ["a"])).toEqual({
      target: 0.9,
      raised: false,
    });
  });

  it("stays readable after repeated steps", () => {
    let target = 0.5;
    for (let i = 0; i < 4; i++) target = ratchetCoverage(target, coverage, matrix({ a: true }), ["a"]).target;
    expect(target).toBe(0.9);
  });

  it("judges only the matrix sites it is given", () => {
    expect(ratchetCoverage(0.5, coverage, matrix({ a: true, holdout: false }), ["a"]).raised).toBe(true);
  });
});
