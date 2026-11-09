import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autopilotPaths,
  createPortPool,
  matrixVerdict,
  runMatrix,
  type AutopilotPaths,
  type OpenedReplay,
  type SiteConfig,
  type StageContext,
  type StageName,
  type StageRunner,
  type StageSummary,
} from "@harness/autopilot";

let root: string;
let paths: AutopilotPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdr-autopilot-runner-"));
  paths = autopilotPaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const site = (id: string): SiteConfig => ({ id, url: `https://${id}.test/`, framework: "nextjs" });

const ok = (ctx: StageContext, name: StageName, artifacts: Record<string, string> = {}): StageSummary => ({
  stage: name,
  site: ctx.site.id,
  status: "passed",
  wallClockMs: 0,
  gates: [{ id: `${name}.ok`, pass: true, hard: true }],
  issues: [],
  artifacts,
});

interface Calls {
  order: string[];
}

function runner(
  name: StageName,
  calls: Calls,
  fn?: (ctx: StageContext) => StageSummary | Promise<StageSummary>,
): StageRunner {
  return {
    name,
    run: async (ctx) => {
      calls.order.push(`${ctx.site.id}:${name}`);
      ctx.log(`hello from ${name}`);
      ctx.event({ type: "note", stage: name });
      return fn ? fn(ctx) : ok(ctx, name);
    },
  };
}

const allPassing = (
  calls: Calls,
  overrides: Partial<Record<StageName, StageRunner>> = {},
): Record<StageName, StageRunner> => ({
  freeze: runner("freeze", calls),
  mirror: runner("mirror", calls),
  "design-system": runner("design-system", calls),
  replica: runner("replica", calls),
  final: runner("final", calls),
  ...overrides,
});

describe("runMatrix", () => {
  it("runs the stages in order and writes every stage's evidence and the matrix", async () => {
    const calls: Calls = { order: [] };
    const matrix = await runMatrix({ paths, cycle: 1, sites: [site("a")], runners: allPassing(calls) });
    expect(calls.order).toEqual(["a:freeze", "a:mirror", "a:design-system", "a:replica", "a:final"]);
    const dir = paths.stageDir(1, "a", "mirror");
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"))).toMatchObject({
      stage: "mirror",
      site: "a",
      status: "passed",
    });
    expect(readFileSync(join(dir, "log.txt"), "utf8")).toMatch(/^\[\d{4}-.*\] mirror starts for a$/m);
    expect(readFileSync(join(dir, "log.txt"), "utf8")).toContain("hello from mirror");
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe('{"type":"note","stage":"mirror"}\n');
    expect(JSON.parse(readFileSync(join(dir, "errors.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(paths.cycleDir(1), "matrix.json"), "utf8"))).toMatchObject({
      cycle: 1,
      sites: { a: { mirror: { status: "passed" } } },
    });
    expect(matrixVerdict(matrix).green).toBe(true);
  });

  it("starts a re-run of a stage from an empty output folder", async () => {
    const seen: string[][] = [];
    const replica = (calls: Calls) =>
      runner("replica", calls, (ctx) => {
        const out = join(ctx.stageDir, "out");
        seen.push(existsSync(out) ? readdirSync(out) : []);
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "leftover.tsx"), "");
        return ok(ctx, "replica");
      });
    const twice = async () => {
      const calls: Calls = { order: [] };
      await runMatrix({
        paths,
        cycle: 1,
        sites: [site("a")],
        runners: allPassing(calls, { replica: replica(calls) }),
      });
    };
    await twice();
    await twice();
    expect(seen).toEqual([[], []]);
  });

  it("logs a stray rejection to the running stage and carries on", async () => {
    const calls: Calls = { order: [] };
    const matrix = await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      runners: allPassing(calls, {
        mirror: runner("mirror", calls, (ctx) => {
          process.emit("unhandledRejection", new Error("nobody awaited this"), Promise.resolve());
          return ok(ctx, "mirror");
        }),
      }),
    });
    expect(matrix.sites.a?.mirror?.status).toBe("passed");
    expect(readFileSync(join(paths.stageDir(1, "a", "mirror"), "log.txt"), "utf8")).toContain(
      "unhandled rejection: Error: nobody awaited this",
    );
  });

  it("gives each site a project folder with its own config, and the summaries of earlier stages", async () => {
    const calls: Calls = { order: [] };
    let previousSeen: string[] = [];
    await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      runners: allPassing(calls, {
        mirror: runner("mirror", calls, (ctx) => {
          previousSeen = Object.keys(ctx.previous);
          expect(ctx.projectDir).toBe(paths.projectDir(1, "a"));
          return ok(ctx, "mirror");
        }),
      }),
    });
    expect(previousSeen).toEqual(["freeze"]);
    expect(
      JSON.parse(readFileSync(join(paths.projectDir(1, "a"), ".harness/config.json"), "utf8")),
    ).toMatchObject({ recreate: { allowLocal: true } });
  });

  it("turns a throw into a crashed summary and skips the stages that depend on it", async () => {
    const calls: Calls = { order: [] };
    const matrix = await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a"), site("b")],
      parallel: 2,
      runners: allPassing(calls, {
        mirror: runner("mirror", calls, (ctx) => {
          if (ctx.site.id === "a") throw new Error("boom");
          return ok(ctx, "mirror");
        }),
      }),
    });
    expect(matrix.sites.a!.mirror!.status).toBe("crashed");
    expect(matrix.sites.a!.mirror!.issues[0]).toMatchObject({ code: "CRASHED", severity: "error" });
    expect(
      JSON.parse(readFileSync(join(paths.stageDir(1, "a", "mirror"), "errors.json"), "utf8"))[0],
    ).toMatchObject({ code: "CRASHED", step: "mirror" });
    // the design system does not depend on the mirror; the matrix went on
    expect(matrix.sites.a!["design-system"]!.status).toBe("passed");
    expect(matrix.sites.b!.mirror!.status).toBe("passed");
    expect(matrixVerdict(matrix).green).toBe(false);
  });

  it("records `skipped` for what depends on a failed stage", async () => {
    const calls: Calls = { order: [] };
    const matrix = await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      runners: allPassing(calls, {
        freeze: runner("freeze", calls, (ctx) => ({ ...ok(ctx, "freeze"), status: "failed" })),
      }),
    });
    expect(calls.order).toEqual(["a:freeze"]);
    for (const s of ["mirror", "design-system", "replica", "final"] as const)
      expect(matrix.sites.a![s]).toMatchObject({
        status: "skipped",
        issues: [expect.objectContaining({ message: expect.stringContaining("freeze failed") })],
      });
    expect(readFileSync(join(paths.stageDir(1, "a", "final"), "log.txt"), "utf8")).toContain("final skipped");
  });

  it("with a stage filter, reuses earlier summaries of the cycle", async () => {
    const calls: Calls = { order: [] };
    await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      stages: ["freeze", "mirror"],
      runners: allPassing(calls),
    });
    const second: Calls = { order: [] };
    let seen: string[] = [];
    await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      stages: ["design-system"],
      runners: allPassing(second, {
        "design-system": runner("design-system", second, (ctx) => {
          seen = Object.keys(ctx.previous);
          return ok(ctx, "design-system");
        }),
      }),
    });
    expect(second.order).toEqual(["a:design-system"]);
    expect(seen).toEqual(["freeze", "mirror"]);
    const matrix = JSON.parse(readFileSync(join(paths.cycleDir(1), "matrix.json"), "utf8"));
    expect(Object.keys(matrix.sites.a).sort()).toEqual(["design-system", "freeze", "mirror"]);
  });

  it("keeps a failed earlier stage from being rerun past it with a filter", async () => {
    const calls: Calls = { order: [] };
    await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      stages: ["freeze"],
      runners: allPassing(calls, {
        freeze: runner("freeze", calls, (ctx) => ({ ...ok(ctx, "freeze"), status: "failed" })),
      }),
    });
    const second: Calls = { order: [] };
    const matrix = await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      stages: ["mirror"],
      runners: allPassing(second),
    });
    expect(second.order).toEqual([]);
    expect(matrix.sites.a!.mirror!.status).toBe("skipped");
  });

  it("gives later stages the snapshot's replay and closes it when the site is done", async () => {
    const calls: Calls = { order: [] };
    let closed = 0;
    let seenSnapshot: string | undefined;
    const openReplay = async (dir: string): Promise<OpenedReplay> => {
      expect(dir).toBe("/snapshots/x");
      return {
        snapshot: {
          site: "a",
          dir,
          finalUrl: "https://a.test/",
          replayUrl: "http://127.0.0.1:1234/",
          capturedAt: "t",
          source: "live",
        },
        close: async () => {
          closed++;
        },
      };
    };
    await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      openReplay,
      runners: allPassing(calls, {
        freeze: runner("freeze", calls, (ctx) => ok(ctx, "freeze", { snapshot: "/snapshots/x" })),
        mirror: runner("mirror", calls, (ctx) => {
          seenSnapshot = ctx.snapshot?.replayUrl;
          return ok(ctx, "mirror");
        }),
      }),
    });
    expect(seenSnapshot).toBe("http://127.0.0.1:1234/");
    expect(closed).toBe(1);
    expect(
      JSON.parse(readFileSync(join(paths.projectDir(1, "a"), ".harness/config.json"), "utf8")).autopilot,
    ).toEqual({ replayUrl: "http://127.0.0.1:1234/" });
  });

  it("limits how many sites run at once", async () => {
    let running = 0;
    let max = 0;
    const slow: StageRunner = {
      name: "freeze",
      run: async (ctx) => {
        running++;
        max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return ok(ctx, "freeze");
      },
    };
    const sites = ["a", "b", "c", "d", "e"].map(site);
    await runMatrix({
      paths,
      cycle: 1,
      sites,
      parallel: 2,
      stages: ["freeze"],
      runners: { freeze: slow },
      ports: createPortPool([43900, 43910]),
    });
    expect(max).toBe(2);
  });

  it("does not write matrix.json for freeze alone", async () => {
    const calls: Calls = { order: [] };
    await runMatrix({
      paths,
      cycle: 1,
      sites: [site("a")],
      stages: ["freeze"],
      noMatrix: true,
      runners: allPassing(calls),
    });
    expect(existsSync(join(paths.cycleDir(1), "matrix.json"))).toBe(false);
  });

  it("names a skipped stage in the verdict", async () => {
    mkdirSync(paths.cycleDir(1), { recursive: true });
    writeFileSync(join(paths.cycleDir(1), "unrelated.txt"), "x");
    expect(
      matrixVerdict({
        cycle: 1,
        commit: "c",
        sites: {
          a: {
            mirror: {
              stage: "mirror",
              site: "a",
              status: "skipped",
              wallClockMs: 0,
              gates: [],
              issues: [],
              artifacts: {},
            },
          },
        },
      }).failing,
    ).toEqual(["a/mirror: skipped"]);
  });
});
