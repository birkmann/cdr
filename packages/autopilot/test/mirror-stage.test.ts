import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness, recreateInSession } from "@harness/core";
import {
  autopilotPaths,
  createMirrorStage,
  createPortPool,
  DEFAULT_AUTOPILOT_CONFIG,
  type AutopilotPaths,
  type StageContext,
} from "@harness/autopilot";

let root: string;
let paths: AutopilotPaths;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdr-autopilot-mirror-"));
  paths = autopilotPaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctxFor(keepCache = false, withSnapshot = true): StageContext {
  const stageDir = paths.stageDir(1, "acme", "mirror");
  const projectDir = paths.projectDir(1, "acme");
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  return {
    site: { id: "acme", fixture: "acme", framework: "nextjs" },
    cycle: 1,
    paths,
    config: DEFAULT_AUTOPILOT_CONFIG,
    projectDir,
    stageDir,
    previous: {},
    ...(withSnapshot
      ? {
          snapshot: {
            site: "acme",
            dir: "/x",
            finalUrl: "https://acme.test/",
            replayUrl: "http://127.0.0.1:4310/",
            capturedAt: "t",
            source: "fixture" as const,
          },
        }
      : {}),
    ports: createPortPool([43600, 43605]),
    signal: new AbortController().signal,
    log: () => undefined,
    event: () => undefined,
    keepCache,
  };
}

function file(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}

/** A finished run, as `recreateInSession` leaves it. */
function fakeRecreate(status: "success" | "failed" = "success", writeCache = true): typeof recreateInSession {
  return async (session) => {
    const events: unknown[] = [];
    const s = session as unknown as { emit(e: unknown): void };
    const dir = ".harness/recreate/run1";
    const abs = join(session.projectRoot, dir);
    s.emit({
      type: "recreate.started",
      runId: "run1",
      url: "u",
      widths: [],
      targets: ["mirror"],
      mode: "mirror",
      dir,
    });
    events.push("recreate.started");
    file(join(abs, "manifest.json"), {
      status,
      stages: { appbuild: { status: "done", ms: 100 }, report: { status: "done", ms: 10 } },
    });
    file(join(abs, "verify/summary.json"), {
      gates: {
        "visual.parity": {
          pass: status === "success",
          value: status === "success" ? 0.99 : 0.9,
          threshold: 0.97,
        },
      },
    });
    file(join(abs, "verify/visual.json"), {
      details: {
        results: [
          {
            viewport: "mobile",
            path: "/",
            parity: 0.99,
            pass: status === "success",
            parityPass: status === "success",
            bboxPass: true,
            heightPass: true,
            baseline: "b.png",
            current: "c.png",
            diff: "d.png",
          },
        ],
      },
    });
    for (const f of ["b.png", "c.png", "d.png"]) file(join(abs, f), "png");
    if (writeCache) file(join(abs, "llm-cache/x.json"), { content: "c" });
    return {
      runId: "run1",
      dir,
      status,
      summary: "done",
      outputs: [],
      reports: [],
      manifest: { stages: {} },
    } as unknown as Awaited<ReturnType<typeof recreateInSession>>;
  };
}

function fakeHarness(ctx: StageContext): Harness {
  const listeners = new Set<(e: { type: string; [k: string]: unknown }) => void>();
  const session = {
    projectRoot: ctx.projectDir,
    subscribe: (l: (e: { type: string; [k: string]: unknown }) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (e: { type: string; [k: string]: unknown }) => listeners.forEach((l) => l(e)),
    cancel: () => undefined,
    close: () => undefined,
  };
  return { createSession: () => session } as unknown as Harness;
}

describe("mirror stage", () => {
  it("fails with a finding when there is no snapshot and no live permission", async () => {
    const s = await createMirrorStage().run(ctxFor(false, false));
    expect(s.status).toBe("failed");
    expect(s.issues[0]).toMatchObject({ code: "SNAPSHOT_INCOMPLETE", cause: "missing" });
  });

  it("reads the finished run into gates, links the verify shots, and reports where the app is", async () => {
    const ctx = ctxFor();
    const s = await createMirrorStage({ createHarness: fakeHarness, recreate: fakeRecreate() }).run(ctx);
    expect(s.status).toBe("passed");
    expect(s.gates.find((g) => g.id === "visual.parity")).toMatchObject({
      viewport: "mobile",
      pass: true,
      value: 0.99,
      hard: true,
    });
    expect(s.gates.find((g) => g.id === "appbuild")).toMatchObject({ pass: true });
    const runDir = join(ctx.projectDir, ".harness/recreate/run1");
    expect(s.artifacts).toMatchObject({
      runDir,
      mirrorApp: join(runDir, "out/mirror"),
      verifyDir: join(runDir, "verify"),
    });
    const link = join(ctx.stageDir, "screens/mobile/diff.png");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("png");
    expect(existsSync(join(ctx.stageDir, "screens/mobile/original.png"))).toBe(true);
  });

  it("passes the snapshot's replay URL to the run", async () => {
    let url: string | undefined;
    const ctx = ctxFor();
    const recreate: typeof recreateInSession = async (session, request, opts) => {
      url = request.url;
      expect(request.mode).toBe("mirror");
      expect(opts?.yes).toBe(true);
      return fakeRecreate()(session, request, opts);
    };
    await createMirrorStage({ createHarness: fakeHarness, recreate }).run(ctx);
    expect(url).toBe("http://127.0.0.1:4310/");
  });

  it("marks a run with a failing hard gate as failed", async () => {
    const s = await createMirrorStage({ createHarness: fakeHarness, recreate: fakeRecreate("failed") }).run(
      ctxFor(),
    );
    expect(s.status).toBe("failed");
    expect(s.issues.find((i) => i.code === "visual.parity")).toBeDefined();
  });

  it("keeps the run's model answers for a --keep-cache repeat", async () => {
    await createMirrorStage({ createHarness: fakeHarness, recreate: fakeRecreate() }).run(ctxFor());
    const cached = join(paths.state, "llm-cache/acme/x.json");
    expect(existsSync(cached)).toBe(true);
    const ctx = ctxFor(true);
    rmSync(ctx.projectDir, { recursive: true });
    mkdirSync(ctx.projectDir, { recursive: true });
    writeFileSync(cached, JSON.stringify({ content: "from cache" }));
    const seen: string[] = [];
    const recreate: typeof recreateInSession = async (session, request, opts) => {
      const r = await fakeRecreate("success", false)(session, request, opts);
      seen.push(readFileSync(join(session.projectRoot, ".harness/recreate/run1/llm-cache/x.json"), "utf8"));
      return r;
    };
    await createMirrorStage({ createHarness: fakeHarness, recreate }).run(ctx);
    expect(seen[0]).toContain("from cache");
  });
});
