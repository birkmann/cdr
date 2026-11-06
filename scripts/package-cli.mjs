#!/usr/bin/env node
// Package the standalone terminal + web app: dist-release/cdr-<version>.{tar.gz,zip}
// Layout: cdr-<v>/bin/cdr.mjs (+ launchers), cdr-<v>/web/ (web UI), LICENSE, README.txt
// Requires: pnpm build && pnpm bundle:harness
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const name = `cdr-${version}`;
const outDir = join(root, "dist-release");
const dir = join(outDir, name);
for (const need of ["dist-harness/cdr.mjs", "apps/web/dist/index.html"])
  if (!existsSync(join(root, need))) throw new Error(`${need} is missing: run pnpm build && pnpm bundle:harness`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, "bin"), { recursive: true });
cpSync(join(root, "dist-harness/cdr.mjs"), join(dir, "bin/cdr.mjs"));
cpSync(join(root, "packages/core/skills"), join(dir, "bin/skills"), { recursive: true });
writeFileSync(join(dir, "bin/package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");
cpSync(join(root, "apps/web/dist"), join(dir, "web"), { recursive: true });
cpSync(join(root, "LICENSE"), join(dir, "LICENSE"));
cpSync(join(root, "THIRD_PARTY_NOTICES.md"), join(dir, "THIRD_PARTY_NOTICES.md"));
// Licences of the npm packages compiled into cdr.mjs (written by bundle-harness.mjs).
cpSync(join(root, "dist-harness/THIRD_PARTY_LICENSES.txt"), join(dir, "THIRD_PARTY_LICENSES.txt"));
cpSync(join(root, ".env.example"), join(dir, ".env.example"));
writeFileSync(join(dir, "bin/cdr"), '#!/bin/sh\nexec node "$(dirname "$0")/cdr.mjs" "$@"\n');
chmodSync(join(dir, "bin/cdr"), 0o755);
writeFileSync(join(dir, "bin/cdr.cmd"), '@echo off\r\nnode "%~dp0cdr.mjs" %*\r\n');
writeFileSync(
  join(dir, "README.txt"),
  `CDR ${version}: terminal workspace and web app

Requires Node.js 22 or newer.

  bin/cdr                 terminal workspace in the current folder (Windows: bin\\cdr.cmd)
  bin/cdr serve           web app; open the printed link
  bin/cdr --help          all commands

Put provider keys (see .env.example) in a .env file in your project or in ~/.harness/.env.
Documentation: https://github.com/birkmann/cdr#readme
`,
);
rmSync(join(outDir, `${name}.tar.gz`), { force: true });
rmSync(join(outDir, `${name}.zip`), { force: true });
execFileSync("tar", ["-czf", `${name}.tar.gz`, name], { cwd: outDir });
try {
  execFileSync("zip", ["-qr", `${name}.zip`, name], { cwd: outDir });
} catch {
  console.warn("zip is not installed; only the .tar.gz was created.");
}
console.log(`packaged ${join(outDir, name)}.tar.gz`);
