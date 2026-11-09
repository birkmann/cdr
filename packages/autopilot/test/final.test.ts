import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  autopilotPaths,
  createFinalStage,
  DEFAULT_AUTOPILOT_CONFIG,
  gatesFromVerify,
  summariseCoverage,
  sweepIssues,
  type FinalMeasured,
  type StageContext,
} from "@harness/autopilot";

const rows = [
  {
    viewport: "desktop",
    parity: 0.992,
    parityPass: true,
    bboxPass: true,
    heightPass: true,
    bbox: { maxDelta: 1 },
    height: { delta: 1 },
  },
  {
    viewport: "mobile",
    parity: 0.9,
    parityPass: false,
    bboxPass: false,
    heightPass: true,
    bbox: { maxDelta: "missing" as string },
    height: { delta: -2 },
    diff: "verify/visual/mobile/x.diff.png",
    diagnosis: { file: "verify/diagnosis/x.json", cause: "CSS_MISSING" },
  },
];
const verifyGates = {
  "visual.parity": { pass: false, value: 0.9, threshold: 0.97 },
  "visual.bbox": { pass: false, value: "missing", threshold: 4 },
  "visual.height": { pass: true, value: 2, threshold: 4 },
  "content.missing": { pass: true, value: 0, threshold: 0 },
  "links.broken": { pass: true, value: 0, threshold: 0 },
  "media.missing": { pass: true, value: 0, threshold: 0 },
  "fidelity.similarity": { pass: true, value: 1, threshold: 0.99 },
  "a11y.violations": { pass: false, value: 3, threshold: 0 },
  "seo.title": { pass: false, value: 1, threshold: 0 },
};

const measured = (over: Partial<FinalMeasured> = {}): FinalMeasured => ({
  verify: {
    gates: verifyGates,
    issues: [{ severity: "error", code: "VISUAL_DIFF", message: "mobile parity" }],
  },
  rows,
  sweep: [
    { width: 320, pass: false, issues: ['"A" overlaps "B"'] },
    { width: 800, pass: false, issues: ["text cut off by its box"] },
    { width: 1920, pass: false, issues: ["horizontal scroll 12 px"] },
    { width: 2560, pass: true, issues: [] },
  ],
  sweepGate: { name: "responsive", pass: false, detail: "3 widths" },
  flow: {
    pass: false,
    violations: [{ rule: "media-pin", selector: ".x", detail: "around 500px" }],
    outOfFlow: { max: 0 },
  },
  flowGate: { name: "flow", pass: false, detail: "1" },
  coverage: summariseCoverage([
    { viewport: "desktop", painted: 10, primitive: 2, set: 2, section: 6, byComponent: {} },
  ]),
  ...over,
});

function context(coverageStart: number): StageContext {
  const root = mkdtempSync(join(tmpdir(), "autopilot-final-"));
  const paths = autopilotPaths(root);
  return {
    site: { id: "acme", fixture: "acme", framework: "nextjs" },
    cycle: 1,
    paths,
    config: {
      ...DEFAULT_AUTOPILOT_CONFIG,
      coverage: { ...DEFAULT_AUTOPILOT_CONFIG.coverage, start: coverageStart },
    },
    projectDir: join(root, "project"),
    stageDir: paths.stageDir(1, "acme", "final"),
    snapshot: {
      site: "acme",
      dir: root,
      finalUrl: "http://127.0.0.1:1/",
      replayUrl: "http://127.0.0.1:1/",
      capturedAt: "",
      source: "fixture",
    },
    previous: {},
    ports: { acquire: async () => 1, release: () => undefined },
    signal: new AbortController().signal,
    log: () => undefined,
    event: () => undefined,
    keepCache: false,
  };
}

describe("final-stage report", () => {
  it("turns verify into per-viewport hard gates with verify's thresholds, advisory checks stay advisory", () => {
    const gates = gatesFromVerify({ gates: verifyGates }, rows);
    expect(gates.filter((g) => g.id === "visual.parity")).toEqual([
      { id: "visual.parity", viewport: "desktop", pass: true, hard: true, value: 0.992, threshold: 0.97 },
      { id: "visual.parity", viewport: "mobile", pass: false, hard: true, value: 0.9, threshold: 0.97 },
    ]);
    expect(gates.find((g) => g.id === "visual.bbox" && g.viewport === "mobile")).toMatchObject({
      pass: false,
      value: "missing",
      threshold: 4,
    });
    expect(gates.find((g) => g.id === "fidelity.similarity")).toMatchObject({ hard: true, pass: true });
    expect(gates.find((g) => g.id === "a11y.violations")).toMatchObject({ hard: false, pass: false });
    expect(gates.some((g) => g.id.startsWith("seo."))).toBe(false);
    expect(gates.some((g) => g.id === "visual.parity" && !g.viewport)).toBe(false);
  });

  it("names sweep findings by the §4.2 codes", () => {
    const codes = sweepIssues(measured().sweep).map((i) => i.code);
    expect(codes).toEqual(["OVERLAP", "CUT_TEXT", "SIDEWAYS_SCROLL"]);
  });

  it("writes sweep, flow and coverage and reports the failing gates and findings", async () => {
    const ctx = context(0.5);
    const r = await createFinalStage({ measure: async () => measured() }).run(ctx);
    expect(r).toMatchObject({ stage: "final", site: "acme", status: "failed" });
    expect(existsSync(join(ctx.stageDir, "sweep.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(ctx.stageDir, "coverage.json"), "utf8")).value).toBe(0.4);
    expect(JSON.parse(readFileSync(join(ctx.stageDir, "flow.json"), "utf8")).flow.violations).toHaveLength(1);
    const ids = r.gates.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["visual.parity", "responsive", "flow", "ds.coverage"]));
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(["VISUAL_DIFF", "visual.parity", "OVERLAP", "FLOW", "DS_COVERAGE_LOW"]),
    );
    expect(r.issues.find((i) => i.code === "visual.parity")).toMatchObject({ cause: "CSS_MISSING" });
    expect(r.issues.find((i) => i.code === "FLOW")?.cause).toBe("media-pin");
    expect(r.artifacts).toHaveProperty("verifyDir");
  });

  it("takes the coverage target from the config the loop ratchets", async () => {
    const low = await createFinalStage({ measure: async () => measured() }).run(context(0.3));
    expect(low.gates.find((g) => g.id === "ds.coverage")).toEqual({
      id: "ds.coverage",
      pass: true,
      hard: true,
      value: 0.4,
      threshold: 0.3,
    });
    expect(low.issues.some((i) => i.code === "DS_COVERAGE_LOW")).toBe(false);
    const high = await createFinalStage({ measure: async () => measured() }).run(context(0.7));
    expect(high.gates.find((g) => g.id === "ds.coverage")).toEqual({
      id: "ds.coverage",
      pass: false,
      hard: true,
      value: 0.4,
      threshold: 0.7,
    });
  });

  it("passes only when every hard gate passes; advisory checks never fail it", async () => {
    const ok = measured({
      verify: {
        gates: { ...verifyGates, "visual.parity": { pass: true, value: 0.99, threshold: 0.97 } },
        issues: [],
      },
      rows: [rows[0]!],
      sweep: [],
      sweepGate: { name: "responsive", pass: true },
      flow: { pass: true, violations: [], outOfFlow: { max: 0 } },
      flowGate: { name: "flow", pass: true },
      coverage: summariseCoverage([
        { viewport: "desktop", painted: 10, primitive: 5, set: 3, section: 2, byComponent: {} },
      ]),
    });
    const r = await createFinalStage({ measure: async () => ok }).run(context(0.5));
    expect(r.status).toBe("passed");
    expect(r.gates.find((g) => g.id === "a11y.violations")?.pass).toBe(false);
  });
});
