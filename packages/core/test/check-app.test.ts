import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkAppTool,
  launchBlocker,
  setLaunchTool,
  setWindowBackend,
  type AppWindow,
  type WindowBackend,
} from "@harness/core";
import { tempProject, toolCtx } from "./helpers.js";

// a 1×1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Pretends every started program opens one window; records the keys pressed. */
function fakeBackend(opts: { capture?: string } = {}): WindowBackend & { pressed: string[] } {
  const pressed: string[] = [];
  return {
    name: "fake",
    permissionHint: "grant permission",
    keysHint: "allow keys",
    pressed,
    list: (pids): AppWindow[] => [{ id: "1", pid: pids[0]!, width: 400, height: 600, title: "Game" }],
    capture: (_w, file) => {
      if (opts.capture) return opts.capture;
      writeFileSync(file, PNG);
      return undefined;
    },
    press: (_w, key) => {
      pressed.push(key);
      return undefined;
    },
  };
}

const review = (problems: string[]) =>
  "```json\n" +
  JSON.stringify({
    frames: ["a bird and one solid block"],
    problems,
    verdict: problems.length ? "fail" : "pass",
  }) +
  "\n```";

function ctxWith(root: string, reply: string) {
  const calls: { role: string; images: number }[] = [];
  const ctx = toolCtx(root);
  ctx.complete = async (role, messages) => {
    const user = messages.find((m) => m.role === "user") as { images?: unknown[] } | undefined;
    calls.push({ role, images: user?.images?.length ?? 0 });
    return reply;
  };
  return { ctx, calls };
}

const GAME = "sleep 30"; // stands in for a program that keeps its window open

afterEach(() => setWindowBackend(undefined));

describe("check_app", () => {
  it("captures frames, presses keys between them and reports the vision review's problems", async () => {
    const backend = fakeBackend();
    setWindowBackend(backend);
    const root = tempProject({ "Cargo.toml": "[package]" });
    const { ctx, calls } = ctxWith(root, review(["The pipes are one solid column with no gap."]));
    const r = await checkAppTool.execute(
      { command: GAME, expect: "pairs of pipes with a gap", keys: ["space"], frames: 3, interval: 100 },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/one solid column with no gap/);
    expect(r.output).toMatch(/frame 1: a bird/);
    expect(r.images).toHaveLength(3);
    expect(backend.pressed).toEqual(["space", "space"]);
    expect(calls).toEqual([{ role: "executor", images: 3 }]);
  });

  it("uses appCheck.model for the review", async () => {
    setWindowBackend(fakeBackend());
    const root = tempProject({});
    const { ctx, calls } = ctxWith(root, review([]));
    ctx.config.appCheck = { model: "anthropic/claude" };
    const r = await checkAppTool.execute({ command: GAME, expect: "x", frames: 1 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/No visible problems/);
    expect(calls[0]!.role).toBe("anthropic/claude");
  });

  it("reports a program that fails before opening a window", async () => {
    setWindowBackend({ ...fakeBackend(), list: () => [] });
    const root = tempProject({});
    const { ctx } = ctxWith(root, review([]));
    const r = await checkAppTool.execute({ command: "echo boom; exit 3", expect: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/exited with code 3/);
    expect(r.output).toMatch(/boom/);
  });

  it("explains missing permission when the window cannot be captured", async () => {
    setWindowBackend(fakeBackend({ capture: "could not create image from window" }));
    const root = tempProject({});
    const { ctx } = ctxWith(root, review([]));
    const r = await checkAppTool.execute({ command: GAME, expect: "x", frames: 1 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/could not be captured/);
    expect(r.output).toMatch(/grant permission/);
  });

  it("suggests the CDR_APP_CHECK fallback when keys cannot be pressed", async () => {
    setWindowBackend({ ...fakeBackend(), press: () => "Accessibility permission missing." });
    const root = tempProject({});
    const { ctx } = ctxWith(root, review([]));
    const r = await checkAppTool.execute(
      { command: GAME, expect: "x", keys: ["space"], frames: 2, interval: 100 },
      ctx,
    );
    expect(r.output).toMatch(/Accessibility permission missing\. allow keys/);
    expect(r.output).toMatch(/CDR_APP_CHECK=1/);
  });

  it("runs the program with CDR_APP_CHECK=1 and without provider keys", async () => {
    setWindowBackend({ ...fakeBackend(), list: () => [] });
    process.env.CHECK_APP_TEST_SECRET = "s3cret";
    const root = tempProject({});
    const { ctx } = ctxWith(root, review([]));
    ctx.secretEnv = ["CHECK_APP_TEST_SECRET"];
    const r = await checkAppTool.execute(
      { command: 'echo "flag=$CDR_APP_CHECK secret=${CHECK_APP_TEST_SECRET:-none}"', expect: "x" },
      ctx,
    );
    delete process.env.CHECK_APP_TEST_SECRET;
    expect(r.output).toMatch(/flag=1 secret=none/);
  });

  it("asks again when the review is not JSON and passes plain notes on", async () => {
    setWindowBackend(fakeBackend());
    const root = tempProject({});
    const replies = ["The pipes look like one block.", "still no json"];
    const ctx = toolCtx(root);
    let n = 0;
    ctx.complete = async () => replies[n++] ?? "";
    const r = await checkAppTool.execute({ command: GAME, expect: "x", frames: 1 }, ctx);
    expect(n).toBe(2);
    expect(r.output).toMatch(/review model's notes/);
    expect(r.output).toMatch(/still no json/);

    n = 0;
    replies.splice(0, 2, "not json", review(["no gap between the pipes"]));
    const again = await checkAppTool.execute({ command: GAME, expect: "x", frames: 1 }, ctx);
    expect(again.output).toMatch(/no gap between the pipes/);
  });

  it("hands the frames to the agent when the review model cannot see images", async () => {
    setWindowBackend(fakeBackend());
    const root = tempProject({});
    const { ctx } = ctxWith(root, "NO_IMAGES");
    const r = await checkAppTool.execute({ command: GAME, expect: "x", frames: 2, interval: 100 }, ctx);
    expect(r.output).toMatch(/cannot view images/);
    expect(r.images).toHaveLength(2);
  });
});

describe("set_launch gate", () => {
  it("needs a passing visual check of the current files where windows can be captured", async () => {
    setWindowBackend(fakeBackend());
    const root = tempProject({ "Cargo.toml": "[package]", "src/main.rs": "fn main() {}" });
    const command = GAME;

    const ctx = toolCtx(root);
    const blocked = await setLaunchTool.execute({ command }, ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.output).toMatch(/check_app/);
    expect(ctx.events).toEqual([]);

    // a failing check keeps it blocked and repeats the problems
    const failing = ctxWith(root, review(["The pipes have no gap."]));
    await checkAppTool.execute({ command, expect: "pipes with a gap", frames: 1 }, failing.ctx);
    expect(launchBlocker(root, command)).toMatch(/pipes have no gap/);

    const passing = ctxWith(root, review([]));
    await checkAppTool.execute({ command, expect: "pipes with a gap", frames: 1 }, passing.ctx);
    expect(launchBlocker(root, command)).toBeUndefined();

    // editing a source file afterwards makes the check stale
    const future = new Date(Date.now() + 5000);
    utimesSync(join(root, "src/main.rs"), future, future);
    expect(launchBlocker(root, command)).toMatch(/check_app/);
  });

  it("lets a stuck agent hand over after three failed checks", async () => {
    setWindowBackend(fakeBackend());
    const root = tempProject({});
    for (let i = 0; i < 3; i++) {
      const { ctx } = ctxWith(root, review(["still broken"]));
      await checkAppTool.execute({ command: GAME, expect: "x", frames: 1 }, ctx);
    }
    const ctx = toolCtx(root);
    const r = await setLaunchTool.execute({ command: GAME }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/still broken/);
  });

  it("is not enforced where windows cannot be captured", async () => {
    setWindowBackend(null);
    const root = tempProject({});
    expect(launchBlocker(root, "cargo run")).toBeUndefined();
  });
});
