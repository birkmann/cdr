import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppServer, portFree, RerunEnvironmentError } from "../src/rerun.js";

/** AppServer with stand-in commands: "build" writes a marker, "start" is a tiny node http server reading it. */
let dir: string;
const PORT = 4497;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cmp-appserver-"));
  await writeFile(join(dir, "build.mjs"), `import { writeFileSync } from "node:fs"; if (process.env.FAIL_BUILD) { console.error("compile error x"); process.exit(1); } writeFileSync("built.txt", process.env.CCM_DIR ?? "none");`);
  await writeFile(join(dir, "start.mjs"), `import { createServer } from "node:http"; import { readFileSync } from "node:fs"; const body = readFileSync("built.txt", "utf8"); createServer((_q, r) => { r.end(body); }).listen(Number(process.argv[2]));`);
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

const make = (env: Record<string, string> = {}, port = PORT) =>
  new AppServer({ appDir: dir, port, env: { CCM_DIR: "/ws/ccm", ...env }, buildCmd: [process.execPath, ["build.mjs"]], startCmd: (p) => [process.execPath, ["start.mjs", String(p)]], readyTimeoutMs: 15_000 });

describe("AppServer (the loop's \"build\" contract)", () => {
  it("builds with CCM_DIR, starts on the port, restarts, and stops what it started", async () => {
    const s = make();
    const b = await s.build();
    expect(b.ok).toBe(true);
    await s.restart();
    expect(await (await fetch(`http://localhost:${PORT}/`)).text()).toBe("/ws/ccm");
    await s.restart(); // stop + start again on the same port
    expect(s.running).toBe(true);
    await s.stop();
    expect(await portFree(PORT)).toBe(true);
  }, 30_000);

  it("reports a failing build with its output", async () => {
    const b = await make({ FAIL_BUILD: "1" }).build();
    expect(b.ok).toBe(false);
    expect(b.output).toMatch(/compile error x/);
  });

  it("never kills a foreign server on the port: AUTOFIX_APP_PORT_BUSY", async () => {
    const foreign = createServer((_q, r) => r.end("foreign")).listen(PORT + 1);
    await new Promise((r) => foreign.once("listening", r));
    try {
      const s = make({}, PORT + 1);
      await s.build();
      const err = await s.restart().catch((e) => e);
      expect(err).toBeInstanceOf(RerunEnvironmentError);
      expect((err as RerunEnvironmentError).code).toBe("AUTOFIX_APP_PORT_BUSY");
      expect(await (await fetch(`http://localhost:${PORT + 1}/`)).text()).toBe("foreign");
    } finally {
      await new Promise((r) => foreign.close(r));
    }
  }, 30_000);
});
