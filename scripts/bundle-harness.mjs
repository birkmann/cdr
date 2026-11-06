// Bundle the CDR CLI (core + server) into one ESM file for CDR Studio's sidecar.
// Output: dist-harness/cdr.mjs (+ package.json marker, licence files). Requires `pnpm build:packages` first.
// THIRD_PARTY_LICENSES.txt lists every npm package compiled into the bundle with its licence text.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { licenseNotices } from "./licenses.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages/cli/dist/bin.js");
if (!existsSync(entry)) {
  console.error("packages/cli/dist/bin.js is missing; run `pnpm build:packages` first.");
  process.exit(1);
}
const out = join(root, "dist-harness");
mkdirSync(out, { recursive: true });
const result = await build({
  entryPoints: [entry],
  outfile: join(out, "cdr.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  // Shebang comes from the entry file; CommonJS dependencies need require().
  banner: { js: "import { createRequire as __cdrRequire } from 'node:module'; const require = __cdrRequire(import.meta.url);" },
  logLevel: "warning",
});
// Built-in skills are found next to the bundle (dist-harness/skills).
rmSync(join(out, "skills"), { recursive: true, force: true });
cpSync(join(root, "packages/core/skills"), join(out, "skills"), { recursive: true });
// Everything in dist-harness ships inside CDR Studio, so the notices travel with the bundle.
for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) cpSync(join(root, f), join(out, f));
// The licence of every npm package that esbuild compiled into the bundle.
writeFileSync(join(out, "THIRD_PARTY_LICENSES.txt"), licenseNotices(Object.keys(result.metafile.inputs), root, "cdr.mjs"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");
console.log("bundled", join(out, "cdr.mjs"));
