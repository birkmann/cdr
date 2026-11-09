// The chain against a local fixture: freeze it, serve it from replay, run the real mirror pipeline with real Chrome,
// no model. Slow (a Next.js build); run with CDR_AUTOPILOT_E2E=1 and NPM_CONFIG_OFFLINE=true so the generated app's
// dependencies come from the npm cache.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Harness } from "@harness/core";
import {
  autopilotPaths,
  createFreezeStage,
  createMirrorStage,
  inspectCycle,
  runMatrix,
  writeReports,
  type SiteConfig,
} from "@harness/autopilot";

const enabled = process.env.CDR_AUTOPILOT_E2E === "1";
const REPO = join(__dirname, "../../..");

describe.skipIf(!enabled)("autopilot end to end on the acme fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "cdr-autopilot-e2e-"));
  afterAll(() => {
    if (process.env.CDR_AUTOPILOT_KEEP !== "1") rmSync(root, { recursive: true, force: true });
  });

  it(
    "freezes the site, replays it and mirrors it from the replay with real Chrome and no model",
    async () => {
      const fixtureDir = join(root, "packages/capture/test/sites/acme");
      mkdirSync(join(fixtureDir, ".."), { recursive: true });
      cpSync(join(REPO, "packages/capture/test/sites/acme"), fixtureDir, { recursive: true });
      mkdirSync(join(root, "autopilot"), { recursive: true });
      const paths = autopilotPaths(root);
      const site: SiteConfig = { id: "acme", fixture: "acme", framework: "nextjs" };
      const stage = createMirrorStage({
        createHarness: (ctx) =>
          new Harness({
            skipGlobalConfig: true,
            loadEnv: false,
            sessionsDir: join(ctx.stageDir, "sessions"),
          }),
      });
      const matrix = await runMatrix({
        paths,
        cycle: 1,
        sites: [site],
        stages: ["freeze", "mirror"],
        runners: { freeze: createFreezeStage({ refresh: true }), mirror: stage },
        progress: (line) => console.log(line),
      });
      const freeze = matrix.sites.acme!.freeze!;
      console.log("freeze gates", JSON.stringify(freeze.gates));
      console.log("freeze issues", JSON.stringify(freeze.issues));
      expect(freeze.status).toBe("passed");
      const snapshot = freeze.artifacts.snapshot!;
      expect(existsSync(join(snapshot, "raw/index.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(snapshot, "replay.json"), "utf8")).source).toBe("fixture");

      const mirror = matrix.sites.acme!.mirror!;
      console.log("mirror status", mirror.status, "stages", mirror.wallClockMs);
      console.log("mirror gates", JSON.stringify(mirror.gates));
      console.log("mirror issues", JSON.stringify(mirror.issues.slice(0, 40)));
      console.log("artifacts", JSON.stringify(mirror.artifacts));
      // what the pipeline measured is reported as it is, pass or fail: the point is the chain runs and its evidence lands
      expect(mirror.status === "passed" || mirror.status === "failed").toBe(true);
      expect(mirror.artifacts.runDir).toBeDefined();
      expect(existsSync(join(mirror.artifacts.runDir!, "manifest.json"))).toBe(true);
      expect(existsSync(join(mirror.artifacts.runDir!, "verify/summary.json"))).toBe(true);

      const replayMisses = join(paths.stageDir(1, "acme", "freeze"), "replay-misses.jsonl");
      if (existsSync(replayMisses)) console.log("replay misses", readFileSync(replayMisses, "utf8"));
      const findings = inspectCycle(paths, 1);
      console.log(
        "findings",
        findings.counts,
        findings.file.findings.map((f) => f.signature),
      );
      expect(findings.file.findings.every((f) => !f.signature.includes("127.0.0.1"))).toBe(true);
      const report = writeReports(paths, 1);
      console.log("report", report.green, join(paths.cycleDir(1), "index.html"));
      expect(existsSync(join(paths.siteDir(1, "acme"), "report.json"))).toBe(true);
    },
    40 * 60_000,
  );
});
