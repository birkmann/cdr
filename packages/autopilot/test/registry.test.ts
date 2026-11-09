import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  autopilotPaths,
  discardedSinceAccepted,
  isFixable,
  labelFinding,
  markFixing,
  mergeFindings,
  needsHumanReport,
  readRegistry,
  recordAttempt,
  writeRegistry,
  type Finding,
  type FindingsFile,
  type Registry,
} from "@harness/autopilot";

const finding = (signature: string, sites: string[], over: Partial<Finding> = {}): Finding => ({
  signature,
  stage: "mirror",
  code: "visual.parity",
  message: "parity too low",
  sites,
  rank: 1,
  status: "new",
  evidence: [],
  ...over,
});

const file = (cycle: number, ...findings: Finding[]): FindingsFile => ({ cycle, findings });
const empty = (): Registry => ({ entries: {} });
const SIG = "mirror:visual.parity:CSS_MISSING";

describe("mergeFindings", () => {
  it("creates entries and tracks sites and counts across cycles", () => {
    let registry = mergeFindings(empty(), file(1, finding(SIG, ["bvg"])));
    registry = mergeFindings(registry, file(2, finding(SIG, ["ibm"])));
    expect(registry.entries[SIG]).toMatchObject({
      firstCycle: 1,
      lastCycle: 2,
      sites: ["bvg", "ibm"],
      count: 2,
      status: "open",
    });
  });

  it("is idempotent for the same cycle, so a resumed inspect does not count twice", () => {
    const once = mergeFindings(empty(), file(1, finding(SIG, ["bvg"])));
    const twice = mergeFindings(once, file(1, finding(SIG, ["bvg"])));
    expect(twice.entries[SIG]!.count).toBe(1);
  });

  it("marks a signature fixed only when its site and stage ran", () => {
    const seen = mergeFindings(empty(), file(1, finding(SIG, ["bvg"])));
    const ranElsewhere = mergeFindings(seen, file(2), { ran: { sites: ["ibm"], stages: ["mirror"] } });
    expect(ranElsewhere.entries[SIG]!.status).toBe("open");
    const otherStage = mergeFindings(seen, file(2), { ran: { sites: ["bvg"], stages: ["freeze"] } });
    expect(otherStage.entries[SIG]!.status).toBe("open");
    const ran = mergeFindings(seen, file(2), { ran: { sites: ["bvg"], stages: ["mirror"] } });
    expect(ran.entries[SIG]!.status).toEqual({ fixed: 2 });
  });

  it("labels a fixed signature that is back as regressed", () => {
    const registry = mergeFindings(empty(), file(1, finding(SIG, ["bvg"])));
    recordAttempt(registry, SIG, { goalId: "g1", cycle: 1, verdict: "accepted", reason: "ok" });
    expect(registry.entries[SIG]!.status).toEqual({ fixed: 1 });
    expect(labelFinding(registry, SIG)).toBe("regressed");
    const back = mergeFindings(registry, file(2, finding(SIG, ["bvg"])));
    expect(back.entries[SIG]!.status).toBe("regressed");
    expect(labelFinding(empty(), SIG)).toBe("new");
  });
});

describe("attempt memory", () => {
  const discard = (registry: Registry, cycle: number, reason = "no") =>
    recordAttempt(registry, SIG, { goalId: `g${cycle}`, cycle, verdict: "discarded", reason });

  it("marks NEEDS_HUMAN after the third discarded attempt and keeps every reason", () => {
    const registry = mergeFindings(empty(), file(1, finding(SIG, ["bvg"])));
    expect(discard(registry, 1, "first").status).toBe("open");
    expect(discard(registry, 2, "second").status).toBe("open");
    expect(discard(registry, 3, "third").status).toBe("NEEDS_HUMAN");
    expect(registry.entries[SIG]!.attempts.map((a) => a.reason)).toEqual(["first", "second", "third"]);
    const report = needsHumanReport(registry);
    expect(report).toContain(SIG);
    expect(report).toContain("third");
    expect(isFixable(registry.entries[SIG])).toBe(false);
  });

  it("starts the count over after an accepted fix", () => {
    const registry = empty();
    discard(registry, 1);
    discard(registry, 2);
    recordAttempt(
      registry,
      SIG,
      { goalId: "ok", cycle: 3, verdict: "accepted", reason: "fine" },
      "autopilot/rules/x.md",
    );
    expect(registry.entries[SIG]!.rule).toBe("autopilot/rules/x.md");
    expect(discardedSinceAccepted(registry.entries[SIG]!)).toBe(0);
    expect(discard(registry, 4).status).toBe("regressed");
  });

  it("does not hand a running goal's signature to another fixer, but takes back one left by a crash", () => {
    const registry = mergeFindings(empty(), file(1, finding(SIG, ["bvg"])));
    markFixing(registry, SIG, "goal-a");
    expect(isFixable(registry.entries[SIG], (id) => id === "goal-a")).toBe(false);
    expect(isFixable(registry.entries[SIG], () => false)).toBe(true);
  });
});

describe("persistence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips with sorted keys and reads a missing file as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "autopilot-registry-"));
    dirs.push(root);
    const paths = autopilotPaths(root);
    expect(readRegistry(paths)).toEqual({ entries: {} });
    const registry = mergeFindings(empty(), file(1, finding("z:Z", ["bvg"]), finding("a:A", ["bvg"])));
    writeRegistry(paths, registry);
    expect(Object.keys(readRegistry(paths).entries)).toEqual(["a:A", "z:Z"]);
    expect(readFileSync(join(root, "autopilot/registry.json"), "utf8")).toContain('"a:A"');
  });
});
