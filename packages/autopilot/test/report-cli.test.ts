import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autopilotMain,
  autopilotPaths,
  type AutopilotPaths,
  type MatrixResult,
  type StageSummary,
} from "@harness/autopilot";

let root: string;
let paths: AutopilotPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdr-autopilot-cli-"));
  paths = autopilotPaths(root);
  mkdirSync(paths.committed, { recursive: true });
  writeFileSync(join(paths.committed, "sites.yaml"), `sites:\n  a: { url: "https://a.test/" }\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]): Promise<{ code: number; text: string }> {
  let text = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return autopilotMain(args, { cwd: root, out }).then((code) => ({ code, text }));
}

function writeCycle(cycle: number, status: StageSummary["status"], gates: StageSummary["gates"]): void {
  const summary: StageSummary = {
    stage: "mirror",
    site: "a",
    status,
    wallClockMs: 100,
    gates,
    issues: [],
    artifacts: {},
  };
  const dir = paths.stageDir(cycle, "a", "mirror");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  const matrix: MatrixResult = { cycle, commit: "abc", sites: { a: { mirror: summary } } };
  writeFileSync(join(paths.cycleDir(cycle), "matrix.json"), JSON.stringify(matrix));
}

describe("the autopilot CLI", () => {
  it("rejects an unknown stage and an unknown command", async () => {
    expect(await run(["run", "--stages", "bogus"])).toMatchObject({ code: 2 });
    expect(await run(["unknown"])).toMatchObject({ code: 2 });
  });

  it("uses --cwd for the repository root", async () => {
    const other = mkdtempSync(join(tmpdir(), "cdr-autopilot-cli2-"));
    const r = await run(["status", "--cwd", other]);
    rmSync(other, { recursive: true, force: true });
    expect(r.text).toContain("cycles: none yet");
  });

  it("exits 1 from status until a cycle is green, and 0 when it is", async () => {
    expect((await run(["status"])).code).toBe(1);
    writeCycle(1, "failed", [{ id: "visual.parity", pass: false, hard: true, value: 0.9, threshold: 0.97 }]);
    const r = await run(["status"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("mirror failed (0/1 hard gates)");
    writeCycle(2, "passed", [{ id: "visual.parity", pass: true, hard: true, value: 0.99, threshold: 0.97 }]);
    expect((await run(["status"])).code).toBe(0);
  });

  it("exits 1 from inspect when there are new findings and writes FINDINGS.md", async () => {
    writeCycle(1, "failed", [{ id: "visual.parity", pass: false, hard: true, value: 0.9, threshold: 0.97 }]);
    const r = await run(["inspect", "--cycle", "1"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("1 new");
    expect(readFileSync(join(paths.cycleDir(1), "FINDINGS.md"), "utf8")).toContain("mirror:visual.parity");
  });

  it("exits 0 from inspect when nothing is new", async () => {
    writeCycle(1, "failed", [{ id: "visual.parity", pass: false, hard: true, value: 0.9, threshold: 0.97 }]);
    await run(["inspect", "--cycle", "1"]);
    writeCycle(2, "failed", [{ id: "visual.parity", pass: false, hard: true, value: 0.9, threshold: 0.97 }]);
    expect(await run(["inspect", "--cycle", "2"])).toMatchObject({ code: 0 });
  });

  it("writes the reports and says where", async () => {
    writeCycle(1, "passed", [{ id: "visual.parity", pass: true, hard: true, value: 0.99, threshold: 0.97 }]);
    const r = await run(["report", "--cycle", "1"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain(join(paths.cycleDir(1), "index.html"));
  });

  it("delegates the loop's commands", async () => {
    const r = await run(["rules"]);
    expect(r.text).not.toContain("unknown autopilot command");
  });
});
