import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMirrorApps, openMirrorApp } from "@harness/mirror";
import { RunDir, type RunManifest } from "@harness/recreate";

// Stands in for `next start`: answers with what the app was started with.
const FAKE_NEXT = `#!/usr/bin/env node
const http = require("http");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
const body = JSON.stringify({ pid: process.pid, ccm: process.env.CCM_DIR, secret: process.env.MIRROR_TEST_KEY ?? null });
http.createServer((_q, r) => r.end(body)).listen(port, "127.0.0.1");
`;

const RUN = "20261108-120000-example-com-abc";
let root: string;

function writeRun(overrides: Partial<RunManifest> = {}, built = true) {
  const dir = new RunDir(root, RUN);
  mkdirSync(dir.path("out/mirror/node_modules/next/dist/bin"), { recursive: true });
  mkdirSync(dir.path("out/mirror/.next"), { recursive: true });
  if (built) {
    const bin = dir.path("out/mirror/node_modules/next/dist/bin/next");
    writeFileSync(bin, FAKE_NEXT);
    chmodSync(bin, 0o755);
    writeFileSync(dir.path("out/mirror/.next/BUILD_ID"), "build-1\n");
  }
  dir.saveManifest({
    id: RUN,
    version: 1,
    createdAt: "2026-11-08T12:00:00.000Z",
    updatedAt: "2026-11-08T12:00:00.000Z",
    request: { url: "https://example.com/", mode: "mirror", to: ["mirror"] },
    stages: { report: { status: "done" } },
    outputs: [],
    measurements: [],
    gates: [],
    finalUrl: "https://www.example.com/us-en",
    ...overrides,
  } as RunManifest);
  return dir;
}

const answer = async (url: string) =>
  (await (await fetch(url)).json()) as { pid: number; ccm: string; secret: string | null };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mirror-live-"));
});
afterEach(() => {
  closeMirrorApps();
  rmSync(root, { recursive: true, force: true });
});

describe("openMirrorApp", () => {
  it("serves the recreated page from the run's own app, without the secrets", async () => {
    const dir = writeRun();
    process.env.MIRROR_TEST_KEY = "secret-value";
    try {
      const { url } = await openMirrorApp({ projectRoot: root, runId: RUN, secretEnv: ["MIRROR_TEST_KEY"] });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/us-en$/);
      const seen = await answer(url);
      expect(seen.ccm).toBe(dir.path("ccm"));
      expect(seen.secret).toBeNull();
    } finally {
      delete process.env.MIRROR_TEST_KEY;
    }
  });

  it("reuses a running app and restarts it after a rebuild", async () => {
    const dir = writeRun();
    const first = await openMirrorApp({ projectRoot: root, runId: RUN });
    const again = await openMirrorApp({ projectRoot: root, runId: RUN });
    expect(again.url).toBe(first.url);
    const before = await answer(first.url);

    writeFileSync(dir.path("out/mirror/.next/BUILD_ID"), "build-2\n");
    const rebuilt = await openMirrorApp({ projectRoot: root, runId: RUN });
    expect((await answer(rebuilt.url)).pid).not.toBe(before.pid);
  });

  it("refuses what cannot be shown", async () => {
    await expect(openMirrorApp({ projectRoot: root, runId: RUN })).rejects.toThrow(/No recreation run/);
    writeRun({ stages: {} });
    await expect(openMirrorApp({ projectRoot: root, runId: RUN })).rejects.toThrow(/not finished/);
    writeRun({ request: { url: "https://example.com/", to: ["static"] } } as Partial<RunManifest>);
    await expect(openMirrorApp({ projectRoot: root, runId: RUN })).rejects.toThrow(/not a mirror run/);
  });

  it("reports a run without a build", async () => {
    writeRun({}, false);
    await expect(openMirrorApp({ projectRoot: root, runId: RUN })).rejects.toThrow(/no built app/);
  });
});
