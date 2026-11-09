// The real chain on a local fixture: npm install, next build, Chrome, Playwright (minutes, and npm needs the network).
// CDR_DS_BUILD=1 pnpm vitest run packages/autopilot/test/replica-e2e.test.ts
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  autopilotPaths,
  createDesignSystemStage,
  createFinalStage,
  createReplicaStage,
  DEFAULT_AUTOPILOT_CONFIG,
  type StageContext,
  type StageName,
  type StageRunner,
  type StageSummary,
} from "@harness/autopilot";
import { serveSite } from "../../capture/test/sites/serve.js";

describe.skipIf(process.env.CDR_DS_BUILD !== "1")(
  "URL to design system to replica, for real (CDR_DS_BUILD=1)",
  () => {
    it.each(["acme", "fluid"])(
      "%s: every hard gate of the chain passes",
      async (site) => {
        const served = await serveSite(site);
        const root = mkdtempSync(join(tmpdir(), `autopilot-e2e-${site}-`));
        const paths = autopilotPaths(root);
        let next = 48300 + (site === "acme" ? 0 : 50);
        const previous: Partial<Record<StageName, StageSummary>> = {};
        const contextOf = (stage: StageName): StageContext => {
          const stageDir = paths.stageDir(1, site, stage);
          mkdirSync(stageDir, { recursive: true });
          mkdirSync(paths.projectDir(1, site), { recursive: true });
          return {
            site: { id: site, fixture: site, framework: "nextjs" },
            cycle: 1,
            paths,
            config: DEFAULT_AUTOPILOT_CONFIG,
            projectDir: paths.projectDir(1, site),
            stageDir,
            snapshot: {
              site,
              dir: root,
              finalUrl: served.url,
              replayUrl: served.url,
              capturedAt: "",
              source: "fixture",
            },
            previous,
            ports: { acquire: async () => next++, release: () => undefined },
            signal: new AbortController().signal,
            log: () => undefined,
            event: () => undefined,
            keepCache: false,
          };
        };
        try {
          const stages: StageRunner[] = [createDesignSystemStage(), createReplicaStage(), createFinalStage()];
          for (const stage of stages) {
            const summary = await stage.run(contextOf(stage.name));
            previous[stage.name] = summary;
            const failing = summary.gates
              .filter((g) => g.hard && !g.pass)
              .map((g) => `${g.id}=${String(g.value)}`);
            expect({
              stage: stage.name,
              failing,
              issues: summary.status === "passed" ? [] : summary.issues.slice(0, 5),
            }).toEqual({
              stage: stage.name,
              failing: [],
              issues: [],
            });
          }
          const final = previous.final!;
          expect(final.gates.some((g) => g.id === "visual.parity" && g.viewport === "mobile")).toBe(true);
          expect(existsSync(join(paths.stageDir(1, site, "final"), "compare/index.html"))).toBe(true);
        } finally {
          await served.close();
        }
      },
      1_500_000,
    );
  },
);
