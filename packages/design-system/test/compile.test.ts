import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeWorkspace } from "./helpers.js";

const tsc = fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url));

describe("generated packages compile", () => {
  it("type-checks the web components and the React wrappers against lit, @lit/react and react", () => {
    const { dir } = writeWorkspace();
    writeFileSync(
      join(dir, "tsconfig.check.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          noEmit: true,
          useDefineForClassFields: false,
          noImplicitOverride: true,
          skipLibCheck: true,
          jsx: "react-jsx",
          types: [],
          paths: { "@acme-ds/web-components": ["./packages/web-components/src/index.ts"] },
        },
        include: ["packages/web-components/src", "packages/react/src"],
      }),
    );
    const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.check.json"], { cwd: dir, encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 120_000);
});

// Real npm builds of a generated workspace (network, a few minutes): CDR_DS_BUILD=1 pnpm vitest run packages/design-system
describe.skipIf(process.env.CDR_DS_BUILD !== "1")(
  "generated workspace builds with npm (CDR_DS_BUILD=1)",
  () => {
    it("installs, builds (incl. Angular with ng-packagr and the docs), and passes its own tests", async () => {
      const { mkdtempSync, mkdirSync, writeFileSync: write } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { dirname } = await import("node:path");
      const { buildWorkspace, normalizeSpec } = await import("@harness/design-system");
      const ws = buildWorkspace(normalizeSpec({ name: "Acme Outdoor", colors: { primary: "#0f5132" } }));
      const dir = mkdtempSync(join(tmpdir(), "cdr-ds-npm-"));
      for (const [p, c] of Object.entries(ws.files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        write(join(dir, p), c);
      }
      for (const script of [
        ["install", "--no-audit", "--no-fund"],
        ["run", "build"],
        ["test"],
        ["run", "build:angular"],
        ["run", "docs:build"],
      ]) {
        const r = spawnSync("npm", script, { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "1" } });
        expect(r.status, `npm ${script.join(" ")}\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`).toBe(
          0,
        );
      }
    }, 600_000);
  },
);
