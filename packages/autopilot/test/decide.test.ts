import { describe, expect, it } from "vitest";
import {
  decideCandidate,
  failingHardGates,
  hardGatesPassing,
  matrixGates,
  type Finding,
  type FindingsFile,
  type Gate,
  type MatrixResult,
  type StageSummary,
} from "@harness/autopilot";

const gate = (id: string, pass: boolean, over: Partial<Gate> = {}): Gate => ({
  id,
  pass,
  hard: true,
  ...over,
});
const stage = (gates: Gate[], status: StageSummary["status"] = "passed"): StageSummary => ({
  stage: "mirror",
  site: "x",
  status,
  wallClockMs: 1,
  gates,
  issues: [],
  artifacts: {},
});
const matrix = (sites: Record<string, Gate[]>, status?: StageSummary["status"]): MatrixResult => ({
  cycle: 1,
  commit: "c",
  sites: Object.fromEntries(
    Object.entries(sites).map(([site, gates]) => [site, { mirror: stage(gates, status) }]),
  ),
});

const finding = (signature: string, sites: string[], code = "visual.parity"): Finding => ({
  signature,
  stage: "mirror",
  code,
  message: "m",
  sites,
  rank: 1,
  status: "new",
  evidence: [],
});
const findings = (...f: Finding[]): FindingsFile => ({ cycle: 2, findings: f });

const SIG = "mirror:visual.parity:CSS_MISSING";
const target = { signature: SIG, sites: ["bvg", "ibm"] };

const before = matrix({
  bvg: [gate("visual.parity", false), gate("links.ok", true)],
  ibm: [gate("visual.parity", false), gate("links.ok", true)],
  acme: [gate("links.ok", true)],
});

describe("decideCandidate", () => {
  it("accepts when the signature is gone everywhere and no gate regressed", () => {
    const candidate = matrix({
      bvg: [gate("visual.parity", true), gate("links.ok", true)],
      ibm: [gate("visual.parity", true), gate("links.ok", true)],
      acme: [gate("links.ok", true)],
    });
    expect(decideCandidate({ baseline: before, candidate, findings: findings(), target })).toMatchObject({
      accepted: true,
      regressions: [],
    });
  });

  it("accepts a finding that is no gate at all: the signature going away is the improvement", () => {
    const same = matrix({
      bvg: [gate("links.ok", true)],
      ibm: [gate("links.ok", true)],
      acme: [gate("links.ok", true)],
    });
    const decision = decideCandidate({
      baseline: same,
      candidate: same,
      findings: findings(),
      target: { signature: "mirror:NEW_PAGE_ERROR", sites: ["bvg"] },
    });
    expect(decision.accepted).toBe(true);
  });

  it("rejects any pass → fail, even on a site the finding did not touch", () => {
    const candidate = matrix({
      bvg: [gate("visual.parity", true), gate("links.ok", true)],
      ibm: [gate("visual.parity", true), gate("links.ok", true)],
      acme: [gate("links.ok", false)],
    });
    const decision = decideCandidate({ baseline: before, candidate, findings: findings(), target });
    expect(decision.accepted).toBe(false);
    expect(decision.regressions).toEqual(["acme/mirror/links.ok"]);
    expect(decision.reason).toContain("regressed");
  });

  it("treats a regression of an advisory gate as a regression", () => {
    const baseline = matrix({ bvg: [gate("seo.title", true, { hard: false }), gate("a", false)] });
    const candidate = matrix({ bvg: [gate("seo.title", false, { hard: false }), gate("a", true)] });
    const decision = decideCandidate({
      baseline,
      candidate,
      findings: findings(),
      target: { signature: SIG, sites: ["bvg"] },
    });
    expect(decision.accepted).toBe(false);
    expect(decision.regressions).toEqual(["bvg/mirror/seo.title"]);
  });

  it("rejects when the signature is still on one of its sites, naming it", () => {
    const candidate = matrix({
      bvg: [gate("visual.parity", true), gate("links.ok", true)],
      ibm: [gate("visual.parity", false), gate("links.ok", true)],
      acme: [gate("links.ok", true)],
    });
    const decision = decideCandidate({
      baseline: before,
      candidate,
      findings: findings(finding(SIG, ["ibm"])),
      target,
    });
    expect(decision).toMatchObject({ accepted: false, regressions: [] });
    expect(decision.reason).toContain("still present on ibm");
  });

  it("counts a gate that disappeared as failing: a crashed stage must not look clean", () => {
    const candidate = matrix({
      bvg: [gate("visual.parity", true), gate("links.ok", true)],
      ibm: [],
      acme: [gate("links.ok", true)],
    });
    const decision = decideCandidate({ baseline: before, candidate, findings: findings(), target });
    expect(decision.accepted).toBe(false);
    expect(decision.regressions).toEqual(["ibm/mirror/links.ok"]);
  });

  it("counts a stage that no longer runs to the end as a regression", () => {
    const baseline = matrix({ bvg: [gate("a", true)] });
    const crashed = matrix({ bvg: [gate("a", true)] }, "crashed");
    const decision = decideCandidate({
      baseline,
      candidate: crashed,
      findings: findings(),
      target: { signature: SIG, sites: ["bvg"] },
    });
    expect(decision.regressions).toEqual(["bvg/mirror/stage.ok"]);
  });

  it("rejects a new PIPELINE_BUG but not one that was already there", () => {
    const candidate = matrix({
      bvg: [gate("visual.parity", true), gate("links.ok", true)],
      ibm: [gate("visual.parity", true), gate("links.ok", true)],
      acme: [gate("links.ok", true)],
    });
    const bug = finding("mirror:PIPELINE_BUG:CHECK_CRASHED", ["bvg"], "PIPELINE_BUG");
    const fresh = decideCandidate({ baseline: before, candidate, findings: findings(bug), target });
    expect(fresh.accepted).toBe(false);
    expect(fresh.reason).toContain("PIPELINE_BUG");
    const known = decideCandidate({
      baseline: before,
      candidate,
      findings: findings(bug),
      baselineFindings: findings(bug),
      target,
    });
    expect(known.accepted).toBe(true);
  });

  it("in the fast lane judges only what the candidate ran", () => {
    const candidate = matrix({ bvg: [gate("visual.parity", true), gate("links.ok", true)] });
    const decision = decideCandidate({
      baseline: before,
      candidate,
      findings: findings(),
      target,
      scope: { candidateOnly: true },
    });
    expect(decision.accepted).toBe(true);
  });

  it("is not fooled in the fast lane by a stage that regressed on the sites it did run", () => {
    const candidate = matrix({ bvg: [gate("visual.parity", true), gate("links.ok", false)] });
    const decision = decideCandidate({
      baseline: before,
      candidate,
      findings: findings(),
      target,
      scope: { candidateOnly: true },
    });
    expect(decision.regressions).toEqual(["bvg/mirror/links.ok"]);
  });
});

describe("matrix metrics", () => {
  it("counts hard gates and names failures", () => {
    const m = matrix({ bvg: [gate("a", true), gate("b", false), gate("seo", false, { hard: false })] });
    expect(hardGatesPassing(m)).toBe(1);
    expect(failingHardGates(m)).toEqual(["bvg/mirror/b"]);
    expect(matrixGates(m)).toEqual({
      "bvg/mirror/stage.ok": true,
      "bvg/mirror/a": true,
      "bvg/mirror/b": false,
      "bvg/mirror/seo": false,
    });
  });

  it("keeps viewports apart in gate keys", () => {
    const m = matrix({
      bvg: [
        gate("visual.parity", true, { viewport: "mobile" }),
        gate("visual.parity", false, { viewport: "desktop" }),
      ],
    });
    expect(Object.keys(matrixGates(m))).toContain("bvg/mirror/visual.parity@desktop");
    expect(failingHardGates(m)).toEqual(["bvg/mirror/visual.parity@desktop"]);
  });

  it("reports a crashed stage as a failing gate", () => {
    expect(failingHardGates(matrix({ bvg: [] }, "crashed"))).toEqual(["bvg/mirror/stage.ok=crashed"]);
  });
});
