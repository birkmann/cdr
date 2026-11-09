// Shared by the design-system and replica tests: a recorded acme recreation (no browser), and a workspace generated from it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesignSystem, type DsBuildResult } from "@harness/autopilot";
import { runRecreate } from "@harness/recreate";
import { fakeDriver } from "../../recreate/test/fake-driver.js";

export async function recordedDesignSystem(): Promise<DsBuildResult & { project: string }> {
  const project = mkdtempSync(join(tmpdir(), "autopilot-ds-"));
  const r = await buildDesignSystem({
    projectDir: project,
    out: join(project, "ds"),
    url: "https://acme.example/",
    name: "Acme Outdoor",
    prefix: "acme",
    frameworks: ["react"],
    yes: true,
    generateOnly: true,
    log: () => undefined,
    recreateRun: (req, host) => runRecreate(req, { ...host, driver: fakeDriver([]), sectionChecks: false }),
  });
  return { ...r, project };
}
