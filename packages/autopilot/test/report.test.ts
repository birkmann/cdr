import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autopilotPaths,
  buildCycleReport,
  renderCycleMarkdown,
  writeReports,
  type AutopilotPaths,
  type MatrixResult,
  type StageSummary,
} from "@harness/autopilot";

let root: string;
let paths: AutopilotPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdr-autopilot-report-"));
  paths = autopilotPaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const stage = (
  site: string,
  status: StageSummary["status"],
  parity: number,
  costUsd: number,
): StageSummary => ({
  stage: "mirror",
  site,
  status,
  wallClockMs: 120_000,
  gates: [
    {
      id: "visual.parity",
      viewport: "desktop",
      pass: parity >= 0.97,
      hard: true,
      value: parity,
      threshold: 0.97,
    },
  ],
  issues: [],
  usage: { calls: 3, cachedCalls: 1, costUsd },
  artifacts: { runDir: "/tmp/run", verifyDir: "/tmp/run/verify" },
});

function writeCycle(cycle: number, sites: Record<string, StageSummary>, findings: unknown[] = []): void {
  const matrix: MatrixResult = {
    cycle,
    commit: "abc1234",
    sites: Object.fromEntries(Object.entries(sites).map(([s, m]) => [s, { mirror: m }])),
  };
  mkdirSync(paths.cycleDir(cycle), { recursive: true });
  writeFileSync(join(paths.cycleDir(cycle), "matrix.json"), JSON.stringify(matrix));
  writeFileSync(join(paths.cycleDir(cycle), "findings.json"), JSON.stringify({ cycle, findings }));
  for (const [site, s] of Object.entries(sites))
    mkdirSync(paths.stageDir(cycle, site, s.stage), { recursive: true });
}

const finding = (signature: string, sites: string[], status: string, message = "broken") => ({
  signature,
  stage: "mirror",
  code: "visual.parity",
  message,
  sites,
  rank: 1,
  status,
  evidence: ["/tmp/run/verify/diagnosis/mobile/index.json"],
});

describe("reports", () => {
  it("aggregates sites, marks anything not passed as not green and adds the model usage", () => {
    writeCycle(1, { bvg: stage("bvg", "passed", 0.99, 0.5), ibm: stage("ibm", "failed", 0.9, 0.25) });
    const r = buildCycleReport(paths, 1);
    expect(r.green).toBe(false);
    expect(r.sites.map((s) => [s.site, s.green])).toEqual([
      ["bvg", true],
      ["ibm", false],
    ]);
    expect(r.usage).toEqual({ calls: 6, cachedCalls: 2, costUsd: 0.75 });
  });

  it("diffs against the previous cycle", () => {
    writeCycle(1, { bvg: stage("bvg", "failed", 0.9, 0.5) }, [
      finding("mirror:visual.parity", ["bvg"], "new"),
    ]);
    writeCycle(2, { bvg: { ...stage("bvg", "passed", 0.99, 2), wallClockMs: 200_000 } }, [
      finding("mirror:links.broken", ["bvg"], "new"),
    ]);
    const r = buildCycleReport(paths, 2);
    expect(r.diff).toMatchObject({
      against: 1,
      gatesFlipped: [
        { site: "bvg", stage: "mirror", id: "visual.parity", viewport: "desktop", from: false, to: true },
      ],
      findingsAppeared: ["mirror:links.broken"],
      findingsDisappeared: ["mirror:visual.parity"],
      wallClockDeltaMs: 80_000,
      costDeltaUsd: 1.5,
    });
    const md = renderCycleMarkdown(r);
    expect(md).toContain("Changes since cycle 1");
    expect(md).toContain("`visual.parity` (desktop): fail to pass");
  });

  it("writes REPORT.md, report.json and index.html per cycle and per site, and escapes HTML", () => {
    writeCycle(1, { bvg: stage("bvg", "passed", 0.99, 0) }, [
      finding("mirror:x", ["bvg"], "new", "<script>alert(1)</script> broke"),
    ]);
    writeReports(paths, 1);
    for (const f of ["REPORT.md", "report.json", "index.html"]) {
      expect(readFileSync(join(paths.cycleDir(1), f), "utf8").length).toBeGreaterThan(0);
      expect(readFileSync(join(paths.siteDir(1, "bvg"), f), "utf8").length).toBeGreaterThan(0);
    }
    const site = readFileSync(join(paths.siteDir(1, "bvg"), "index.html"), "utf8");
    expect(site).not.toContain("<script>alert");
    expect(site).toContain("visual.parity");
    expect(readFileSync(join(paths.siteDir(1, "bvg"), "REPORT.md"), "utf8")).toContain(
      "| mirror | passed | 120.0 s | 2400.0 s |",
    );
    expect(readFileSync(join(paths.cycleDir(1), "index.html"), "utf8")).toContain('href="bvg/index.html"');
  });

  it("refuses a cycle that does not exist", () => {
    expect(() => writeReports(paths, 9)).toThrow(/has no folder/);
  });
});
