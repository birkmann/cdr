// design-system (plan §2.3): the design system of the frozen page, built and checked for real.
import { join } from "node:path";
import { buildDesignSystem, type DsBuildOptions } from "../ds-build.js";
import { viewportsOf } from "./replica.js";
import type { StageContext, StageRunner, StageSummary } from "../types.js";

export interface DesignSystemStageOptions {
  /** Overrides parts of the build (tests). */
  build?: typeof buildDesignSystem;
  extra?: Partial<DsBuildOptions>;
}

function prefixOf(site: string): string {
  const word = site.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /^[a-z][a-z0-9]{1,11}/.test(word) ? word.slice(0, 12) : `s${word}`.slice(0, 12);
}

export function createDesignSystemStage(options: DesignSystemStageOptions = {}): StageRunner {
  return {
    name: "design-system",
    async run(ctx: StageContext): Promise<StageSummary> {
      const startedAt = Date.now();
      const url = ctx.snapshot?.replayUrl;
      const summary = (
        partial: Pick<StageSummary, "status" | "gates" | "issues" | "artifacts">,
      ): StageSummary => ({
        stage: "design-system",
        site: ctx.site.id,
        wallClockMs: Date.now() - startedAt,
        ...partial,
      });
      if (!url)
        return summary({
          status: "failed",
          gates: [],
          issues: [
            {
              code: "STAGE_FAILED",
              cause: "no-snapshot",
              message: `${ctx.site.id} has no snapshot replay URL to read from; run freeze first`,
              severity: "error",
            },
          ],
          artifacts: {},
        });
      const out = join(ctx.stageDir, "out", "design-system");
      const budget = ctx.config.budgets.designSystemMs;
      const timer = setTimeout(
        () => ctx.log(`design-system: over budget (${Math.round(budget / 60_000)} min)`),
        budget,
      );
      try {
        const r = await (options.build ?? buildDesignSystem)({
          projectDir: ctx.projectDir,
          out,
          url,
          name: ctx.site.id[0]?.toUpperCase() + ctx.site.id.slice(1),
          prefix: prefixOf(ctx.site.id),
          frameworks: ["react"],
          recreate: { allowLocal: true, respectRobots: false },
          // the page's own layout ranges, each measured at the viewport the verify suite compares it at
          preferWidths: viewportsOf(ctx).map((v) => v.width),
          yes: true,
          log: ctx.log,
          signal: ctx.signal,
          ...options.extra,
        });
        return summary({
          status: r.ok ? "passed" : "failed",
          gates: r.gates,
          issues: r.issues,
          artifacts: {
            designSystem: out,
            runDir: r.runDir,
            report: join(out, "design-system", "report.json"),
          },
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const designSystemStage: StageRunner = createDesignSystemStage();
