import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceBlocked } from "@harness/mirror";
import { CaptureStore } from "@harness/mirror-replay";
import {
  autopilotPaths,
  createFreezeStage,
  createPortPool,
  currentSnapshotDir,
  DEFAULT_AUTOPILOT_CONFIG,
  isSnapshotFresh,
  readSnapshotRef,
  snapshotAgeDays,
  type AutopilotPaths,
  type FreezeOptions,
  type ReplayFile,
  type SiteConfig,
  type StageContext,
} from "@harness/autopilot";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("snapshot age", () => {
  it("is reused until it is older than maxAgeDays", () => {
    expect(snapshotAgeDays(iso(NOW - 2 * DAY), NOW)).toBeCloseTo(2, 5);
    expect(isSnapshotFresh(iso(NOW - 7 * DAY), 7, NOW)).toBe(true);
    expect(isSnapshotFresh(iso(NOW - 7 * DAY - 1), 7, NOW)).toBe(false);
  });
  it("treats a clock in the future or a bad date as not fresh", () => {
    expect(isSnapshotFresh(iso(NOW + DAY), 7, NOW)).toBe(false);
    expect(isSnapshotFresh("not a date", 7, NOW)).toBe(false);
  });
});

let root: string;
let paths: AutopilotPaths;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdr-autopilot-freeze-"));
  paths = autopilotPaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const site = (partial: Partial<SiteConfig> = {}): SiteConfig => ({
  id: "a",
  url: "https://a.test/",
  framework: "nextjs",
  ...partial,
});

function ctxFor(s: SiteConfig): StageContext {
  const stageDir = paths.stageDir(1, s.id, "freeze");
  mkdirSync(stageDir, { recursive: true });
  return {
    site: s,
    cycle: 1,
    paths,
    config: DEFAULT_AUTOPILOT_CONFIG,
    projectDir: paths.projectDir(1, s.id),
    stageDir,
    previous: {},
    ports: createPortPool([43700, 43790]),
    signal: new AbortController().signal,
    log: () => undefined,
    event: () => undefined,
    keepCache: false,
  };
}

async function writeSnapshot(id: string, capturedAt: string): Promise<string> {
  const dir = join(paths.snapshots, id, "20261101T000000Z");
  mkdirSync(dir, { recursive: true });
  const store = await CaptureStore.open(dir, { site: id, origin: "https://a.test" });
  await store.put({
    url: "https://a.test/",
    status: 200,
    headers: { "content-type": "text/html" },
    body: "<html></html>",
    from: "live:crawl",
  });
  await store.save(true);
  const replay: ReplayFile = {
    site: id,
    requestedUrl: "https://a.test/",
    finalUrl: "https://a.test/",
    capturedAt,
    source: "live",
    entries: 1,
    bytes: 13,
    parity: { desktop: 1 },
  };
  writeFileSync(join(dir, "replay.json"), JSON.stringify(replay));
  symlinkSync("20261101T000000Z", join(paths.snapshots, id, "current"));
  return dir;
}

describe("freeze stage", () => {
  it("reuses a fresh snapshot without capturing", async () => {
    const dir = await writeSnapshot("a", iso(NOW - DAY));
    let captures = 0;
    const stage = createFreezeStage({
      now: () => NOW,
      capture: async () => (captures++, Promise.reject(new Error("no capture"))),
    });
    const s = await stage.run(ctxFor(site()));
    expect(captures).toBe(0);
    expect(s.status).toBe("passed");
    expect(s.artifacts.snapshot).toBe(dir);
    expect(s.gates.find((g) => g.id === "replay.assets")).toMatchObject({
      pass: true,
      value: 1,
      threshold: 1,
      hard: true,
    });
    expect(currentSnapshotDir(paths, "a")).toBe(dir);
    expect(readSnapshotRef(dir)).toMatchObject({ site: "a", finalUrl: "https://a.test/", source: "live" });
  });

  it("captures again when the snapshot is too old, or on --refresh", async () => {
    await writeSnapshot("a", iso(NOW - 9 * DAY));
    const blocked: FreezeOptions = {
      now: () => NOW,
      robots: async () => ({ allowed: true }),
      resolve: async () => {
        throw new SourceBlocked("a.test", "HTTP 403");
      },
    };
    expect((await createFreezeStage(blocked).run(ctxFor(site()))).issues[0]).toMatchObject({
      code: "BOT_BLOCKED",
    });
    await writeSnapshot("b", iso(NOW - DAY));
    expect(
      (
        await createFreezeStage({ ...blocked, refresh: true }).run(
          ctxFor(site({ id: "b", url: "https://b.test/" })),
        )
      ).issues[0],
    ).toMatchObject({ code: "BOT_BLOCKED" });
  });

  it("reports a blocked site, and only falls back to the archive when told to", async () => {
    const blocked: FreezeOptions = {
      now: () => NOW,
      robots: async () => ({ allowed: true }),
      resolve: async () => {
        throw new SourceBlocked("a.test", "Akamai, HTTP 403");
      },
    };
    const refused = await createFreezeStage(blocked).run(ctxFor(site()));
    expect(refused.status).toBe("failed");
    expect(refused.issues[0]).toMatchObject({ code: "BOT_BLOCKED", severity: "error" });
    expect(refused.issues[0]!.message).toContain("freeze.wayback");

    const waybackCapture: FreezeOptions["waybackCapture"] = async (_ctx, dir) => {
      const store = await CaptureStore.open(dir, { site: "a", origin: "https://a.test" });
      await store.put({
        url: "https://a.test/",
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
        from: "wayback:20261101000000",
      });
      await store.save(true);
      return {
        finalUrl: "https://a.test/",
        entries: 1,
        bytes: 13,
        snapshots: { "/": "20261101000000" },
        unresolved: ["https://a.test/gone.png"],
      };
    };
    for (const options of [{ wayback: ["a"] }, {}]) {
      const s = options.wayback ? site() : site({ freeze: { wayback: true } });
      const archived = await createFreezeStage({ ...blocked, ...options, waybackCapture }).run(ctxFor(s));
      expect(archived.status).toBe("passed");
      expect(archived.issues[0]).toMatchObject({
        code: "BOT_BLOCKED",
        cause: "wayback",
        severity: "warning",
      });
      expect(archived.issues[0]!.message).toContain("Wayback Machine");
      expect(archived.issues.find((i) => i.code === "REPLAY_404")).toBeDefined();
      expect(archived.gates.find((g) => g.id === "replay.assets")).toMatchObject({ pass: true });
      expect(archived.gates.find((g) => g.id === "snapshot.source")).toMatchObject({
        value: "wayback",
        hard: false,
      });
      const dir = currentSnapshotDir(paths, "a")!;
      expect(readSnapshotRef(dir).source).toBe("wayback");
      expect(JSON.parse(readFileSync(join(dir, "replay.json"), "utf8")).wayback.unresolved).toEqual([
        "https://a.test/gone.png",
      ]);
      rmSync(join(paths.snapshots, "a"), { recursive: true, force: true });
    }
  });

  it("treats a live page that never answers as blocked only when the archive is configured", async () => {
    const silent: FreezeOptions = {
      now: () => NOW,
      robots: async () => ({ allowed: true }),
      resolve: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    };
    await expect(createFreezeStage(silent).run(ctxFor(site()))).rejects.toThrow(/timeout/);
    let archived = false;
    await createFreezeStage({
      ...silent,
      wayback: ["a"],
      waybackCapture: async () => {
        archived = true;
        throw new Error("stop here");
      },
    })
      .run(ctxFor(site()))
      .catch(() => undefined);
    expect(archived).toBe(true);
  });

  it("refuses a page robots.txt disallows and never tries the archive for it", async () => {
    const s = await createFreezeStage({
      now: () => NOW,
      wayback: ["a"],
      robots: async () => ({ allowed: false, rule: "Disallow: /" }),
    }).run(ctxFor(site()));
    expect(s.status).toBe("failed");
    expect(s.issues[0]).toMatchObject({ code: "ROBOTS_DISALLOWED" });
    expect(currentSnapshotDir(paths, "a")).toBeUndefined();
  });

  it("fails a site that has neither a URL nor a fixture", async () => {
    await expect(
      createFreezeStage({ now: () => NOW }).run(ctxFor({ id: "x", framework: "nextjs" })),
    ).rejects.toThrow(/neither a url nor a fixture/);
  });
});
