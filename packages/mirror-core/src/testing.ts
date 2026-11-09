/**
 * Test helpers shared across packages (exported from @cmp/core): temp workspaces + a minimal StepContext.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteConfig, type StepContext } from "./contracts.js";
import { silentLogger } from "./logger.js";
import { Workspace } from "./workspace.js";

export async function createTempWorkspace(site = "test-site"): Promise<{ ws: Workspace; baseDir: string; cleanup: () => Promise<void> }> {
  const baseDir = await mkdtemp(join(tmpdir(), "cmp-ws-"));
  const ws = new Workspace(site, baseDir);
  await ws.init();
  return { ws, baseDir, cleanup: () => rm(baseDir, { recursive: true, force: true }) };
}

/** Minimal valid SiteConfig (all defaults) for tests. */
export function testSiteConfig(overrides: Partial<Record<keyof SiteConfig, unknown>> = {}): SiteConfig {
  return SiteConfig.parse({ site: "test-site", baseUrl: "http://localhost:4400", ...overrides });
}

export function testStepContext(ws: Workspace, overrides: Partial<StepContext> = {}): StepContext {
  return { site: testSiteConfig({ site: ws.site }), ws, dryRun: false, log: silentLogger, options: {}, ...overrides };
}
