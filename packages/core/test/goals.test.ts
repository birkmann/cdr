import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent } from "@harness/protocol";
import {
  GoalError,
  GoalStore,
  Harness,
  MockProvider,
  currentBranch,
  discardGoal,
  git,
  mergeGoal,
  pauseGoal,
  parseCriteria,
  runGoal,
  startGoal,
  type MockHandler,
} from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

function harnessWith(mock: MockProvider) {
  return new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: MOCK_MODELS,
  });
}

/** planner → plan; executor → writes hello.txt; reviewer → criteria verdict. */
function goalMock(met: () => boolean, onExecutor?: () => Promise<void>): MockProvider {
  const handler: MockHandler = async (req) => {
    const sys = req.messages[0].content;
    const last = req.messages.at(-1)!;
    if (sys.startsWith("You are the PLANNER")) return { text: "# Plan\n## Steps\n1. write hello.txt" };
    if (sys.includes("code REVIEWER"))
      return {
        text:
          "```json\n" +
          JSON.stringify({
            summary: "looks fine",
            findings: [],
            criteria: [{ criterion: "hello.txt exists", met: met(), evidence: "hello.txt present" }],
          }) +
          "\n```",
      };
    await onExecutor?.();
    if (last.role === "user")
      return { toolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "hello\n" } }] };
    return { text: "Wrote hello.txt" };
  };
  return new MockProvider({ handler });
}

const ofType = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) =>
  events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);

describe("goals", () => {
  it("parses acceptance criteria from a review reply", () => {
    const c = parseCriteria('{"summary":"s","findings":[],"criteria":[{"criterion":"a","met":true}]}', [
      "a",
      "b",
    ]);
    expect(c).toEqual([
      { criterion: "a", met: true },
      { criterion: "b", met: false, evidence: "not evaluated by the reviewer" },
    ]);
  });

  it("stores goals per repo and validates them", () => {
    const repo = tempProject({ "README.md": "x\n" }, { git: true });
    const store = new GoalStore();
    expect(() => store.create({ title: "", repo })).toThrow(GoalError);
    expect(() =>
      store.create({
        title: "t",
        repo,
        schedule: { at: "2030-01-01T00:00:00Z" },
        policy: { permissionMode: "yolo" },
      }),
    ).toThrow(/yolo/);
    const g = store.create({ title: "Draft goal", repo, acceptance: ["one"] });
    expect(g.status).toBe("draft");
    expect(g.baseBranch).toBe(currentBranch(repo));
    expect(existsSync(join(repo, ".harness", "goals", `${g.id}.json`))).toBe(true);
    expect(store.list(repo).map((x) => x.id)).toContain(g.id);
    expect(store.list().map((x) => x.id)).toContain(g.id);
    const u = store.update(g.id, { description: "more", schedule: { cron: "0 2 * * *" } });
    expect(u.status).toBe("scheduled");
    expect(store.get(g.id)?.description).toBe("more");
    store.delete(g.id);
    expect(store.get(g.id)).toBeNull();
  });

  it("runs a goal: criteria met in round 1 → checkpoint commit, status review; merge brings the file to base", async () => {
    const repo = tempProject({ "README.md": "x\n" }, { git: true });
    const base = currentBranch(repo)!;
    const store = new GoalStore();
    const goal = store.create({ title: "Add hello", repo, acceptance: ["hello.txt exists"] });
    const h = harnessWith(goalMock(() => true));
    const final = await runGoal(h, goal.id);
    expect(final.status).toBe("review");
    expect(final.checkpoints).toBe(1);
    expect(final.branch).toBe("cdr/goal-add-hello");
    expect(final.criteria).toEqual([
      { criterion: "hello.txt exists", met: true, evidence: "hello.txt present" },
    ]);
    expect(final.usage.inputTokens).toBeGreaterThan(0);
    // committed on the goal branch, not in the main checkout
    expect(git(repo, ["show", `${final.branch}:hello.txt`]).out).toBe("hello\n");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);

    const session = h.getSession(final.sessionId!);
    expect(session.info().goalId).toBe(goal.id);
    expect(session.projectRoot).toBe(final.worktree);
    const events = session.events;
    expect(ofType(events, "goal.started")[0]).toMatchObject({
      goalId: goal.id,
      round: 1,
      branch: final.branch,
    });
    const cp = ofType(events, "goal.checkpoint")[0];
    expect(cp.commit).toBe(git(repo, ["rev-parse", final.branch!]).out.trim());
    expect(cp.criteria[0].met).toBe(true);
    expect(ofType(events, "goal.finished")[0]).toMatchObject({ status: "success", branch: final.branch });
    expect(events.some((e) => e.type === "run.start" && e.workflow === "autonomous")).toBe(true);
    // the autonomous plan is not gated
    expect(ofType(events, "plan.proposed")).toHaveLength(0);

    const merged = mergeGoal(goal.id);
    expect(merged.status).toBe("done");
    expect(currentBranch(repo)).toBe(base);
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(final.worktree!)).toBe(false);
    expect(() => discardGoal(goal.id)).toThrow(/merged/);
  });

  it("pauses with needs-attention when the budget is exceeded", async () => {
    const repo = tempProject({ "README.md": "x\n" }, { git: true });
    const store = new GoalStore();
    const goal = store.create({
      title: "Tiny budget",
      repo,
      acceptance: ["hello.txt exists"],
      budget: { maxTokens: 10 },
    });
    const h = harnessWith(goalMock(() => true));
    const final = await runGoal(h, goal.id);
    expect(final.status).toBe("needs-attention");
    const paused = ofType(h.getSession(final.sessionId!).events, "goal.paused");
    expect(paused[0].reason).toBe("budget");
    expect(final.checkpoints).toBe(0);
  });

  it("loops rounds until maxRounds when criteria stay unmet, and can be discarded", async () => {
    const repo = tempProject({ "README.md": "x\n" }, { git: true });
    const store = new GoalStore();
    const goal = store.create({
      title: "Never done",
      repo,
      acceptance: ["hello.txt exists"],
      budget: { maxRounds: 2 },
    });
    const h = harnessWith(goalMock(() => false));
    const final = await runGoal(h, goal.id);
    expect(final.status).toBe("needs-attention");
    expect(final.round).toBe(2);
    const events = h.getSession(final.sessionId!).events;
    expect(ofType(events, "goal.started").map((e) => e.round)).toEqual([1, 2]);
    expect(ofType(events, "goal.paused")[0].detail).toContain("maxRounds");
    // round 2 is told about the unmet criterion
    const runs = ofType(events, "run.start");
    expect(runs[1].task).toContain("unmet");

    const discarded = discardGoal(goal.id);
    expect(discarded.status).toBe("discarded");
    expect(existsSync(final.worktree!)).toBe(false);
    expect(git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${final.branch}`]).ok).toBe(false);
  });

  it("pauseGoal cancels a running goal (reason user)", async () => {
    const repo = tempProject({ "README.md": "x\n" }, { git: true });
    const store = new GoalStore();
    const goal = store.create({ title: "Slow", repo, acceptance: ["hello.txt exists"] });
    const h = harnessWith(
      goalMock(
        () => true,
        () => new Promise((r) => setTimeout(r, 40)),
      ),
    );
    const started = startGoal(h, goal.id);
    expect(started.goal.status).toBe("running");
    expect(() => startGoal(h, goal.id)).toThrow(/already running/);
    await new Promise((r) => setTimeout(r, 60));
    expect(pauseGoal(goal.id).wasRunning).toBe(true);
    const final = await started.done;
    expect(final.status).toBe("needs-attention");
    expect(ofType(started.session.events, "goal.paused")[0].reason).toBe("user");
  });
});
