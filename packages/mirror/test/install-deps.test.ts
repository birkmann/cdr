import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installAppDeps } from "../src/app.js";

/** An `npm` on PATH that installs a stub `next`; with `PUBLISH_FIRST` another run publishes the cache meanwhile. */
function fakeNpm(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
mkdir -p node_modules/next
echo '{"name":"next"}' > node_modules/next/package.json
if [ -n "$PUBLISH_FIRST" ]; then
  cached="\${PWD%.tmp-*}"
  mkdir -p "$cached/node_modules/next"
  echo '{"name":"next","published":"first"}' > "$cached/node_modules/next/package.json"
fi
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mirror-deps-"));
  const app = join(root, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { next: "1.0.0" } }));
  const runs = join(root, "runs");
  mkdirSync(runs);
  return { root, app, runs, env: { ...process.env, PATH: `${fakeNpm(root)}:${process.env.PATH}` } };
}

describe("installAppDeps", () => {
  it("keeps a cache another run published while this one installed", async () => {
    const { app, runs, env } = setup();
    await installAppDeps(app, runs, { ...env, PUBLISH_FIRST: "1" }, () => {});
    // the other run may still be copying from it, so it must be the first run's files, untouched
    expect(readFileSync(join(app, "node_modules/next/package.json"), "utf8")).toContain('"published":"first"');
  });

  it("replaces a leftover cache folder with no complete install in it", async () => {
    const { app, runs, env } = setup();
    const { createHash } = await import("node:crypto");
    const manifest = JSON.stringify({ dependencies: { next: "1.0.0" } }, null, 2);
    const key = createHash("sha256").update(manifest).digest("hex").slice(0, 16);
    mkdirSync(join(runs, ".mirror-deps", key, "partial"), { recursive: true });
    await installAppDeps(app, runs, env, () => {});
    expect(existsSync(join(app, "node_modules/next/package.json"))).toBe(true);
    expect(existsSync(join(runs, ".mirror-deps", key, "partial"))).toBe(false);
  });
});
