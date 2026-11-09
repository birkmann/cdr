import { join } from "node:path";
import type { AutopilotPaths, StageName } from "./types.js";

export function autopilotPaths(root: string): AutopilotPaths {
  const state = join(root, ".harness", "autopilot");
  const cycleDir = (cycle: number) => join(state, "cycles", String(cycle));
  const siteDir = (cycle: number, site: string) => join(cycleDir(cycle), site);
  return {
    root,
    committed: join(root, "autopilot"),
    state,
    snapshots: join(state, "snapshots"),
    cycleDir,
    siteDir,
    projectDir: (cycle, site) => join(siteDir(cycle, site), "project"),
    stageDir: (cycle, site, stage: StageName) => join(siteDir(cycle, site), stage),
  };
}
