import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalInfo } from "@harness/protocol";
import {
  autopilotPaths,
  cliLanes,
  type Finding,
  type GoalRecord,
  type LaneInput,
  type SiteConfig,
} from "@harness/autopilot";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Stands in for `packages/cli/dist/bin.js`: records its arguments and leaves what `run` and `inspect` would leave. */
const FAKE_CLI = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync("calls.log", args.join(" ") + "\\n");
const cycle = args[args.indexOf("--cycle") + 1];
const dir = ".harness/autopilot/cycles/" + cycle;
mkdirSync(dir, { recursive: true });
if (args[1] === "run") writeFileSync(dir + "/matrix.json", JSON.stringify({ cycle: Number(cycle), commit: "x", sites: { a: {} } }));
if (args[1] === "inspect") writeFileSync(dir + "/findings.json", JSON.stringify({ cycle: Number(cycle), findings: [] }));
process.exit(args[1] === "inspect" ? 1 : 0);
`;

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-lanes-")));
  dirs.push(root);
  const main = autopilotPaths(root);
  const worktree = join(root, "wt");
  mkdirSync(join(worktree, "packages/cli/dist"), { recursive: true });
  writeFileSync(join(worktree, "packages/cli/dist/bin.js"), FAKE_CLI);
  mkdirSync(main.snapshots, { recursive: true });
  return { main, worktree };
}

const site = (id: string, fixture?: string): SiteConfig => ({
  id,
  ...(fixture ? { fixture } : { url: "https://x.test/" }),
  framework: "nextjs",
});
const finding: Finding = {
  signature: "s",
  stage: "replica",
  code: "c",
  message: "m",
  sites: ["bvg"],
  rank: 1,
  status: "new",
  evidence: [],
};
const record: GoalRecord = { goalId: "g", signature: "s", cycle: 4, branch: "b", finding };
const goal = {} as GoalInfo;

const input = (worktree: string, over: Partial<LaneInput>): LaneInput => ({
  goal,
  record,
  worktree,
  sites: [site("bvg"), site("acme", "acme")],
  cycle: 4,
  ...over,
});

const calls = (worktree: string) => readFileSync(join(worktree, "calls.log"), "utf8").trim().split("\n");

describe("the lanes through the candidate's own CLI", () => {
  it("fast lane: re-runs the affected stage on the origin, runs a fixture up to it, and shares the snapshots", async () => {
    const { main, worktree } = setup();
    const upstream = main.stageDir(4, "bvg", "mirror");
    mkdirSync(upstream, { recursive: true });
    writeFileSync(join(upstream, "summary.json"), '{"stage":"mirror"}');

    const result = await cliLanes(main).fast(input(worktree, { stages: ["replica"] }));

    expect(calls(worktree)).toEqual([
      `autopilot run --cwd ${worktree} --cycle 4 --keep-cache --sites bvg --stages replica`,
      `autopilot run --cwd ${worktree} --cycle 4 --keep-cache --sites acme --stages freeze,mirror,design-system,replica`,
      `autopilot inspect --cwd ${worktree} --cycle 4`,
    ]);
    const candidate = autopilotPaths(worktree);
    expect(lstatSync(candidate.snapshots).isSymbolicLink()).toBe(true);
    expect(existsSync(join(candidate.stageDir(4, "bvg", "mirror"), "summary.json"))).toBe(true);
    expect(result).toEqual({
      matrix: { cycle: 4, commit: "x", sites: { a: {} } },
      findings: { cycle: 4, findings: [] },
      costUsd: 0,
    });
  });

  it("slow lane: the whole list, without cached answers", async () => {
    const { main, worktree } = setup();
    await cliLanes(main).slow(input(worktree, { sites: [site("a"), site("b"), site("c", "c")] }));
    expect(calls(worktree)).toEqual([
      `autopilot run --cwd ${worktree} --cycle 4 --sites a,b,c`,
      `autopilot inspect --cwd ${worktree} --cycle 4`,
    ]);
  });

  it("fails loudly when the candidate left no results", async () => {
    const { main, worktree } = setup();
    writeFileSync(join(worktree, "packages/cli/dist/bin.js"), "process.exit(1);");
    await expect(cliLanes(main).slow(input(worktree, {}))).rejects.toThrow(/findings/);
  });
});
