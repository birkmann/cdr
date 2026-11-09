// Bundle the CDR CLI (core + server) into one ESM file for CDR Studio's sidecar.
// Output: dist-harness/cdr.mjs (+ package.json marker, licence files). Requires `pnpm build:packages` first.
// THIRD_PARTY_LICENSES.txt lists every npm package compiled into the bundle with its licence text.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
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
const EXTERNAL = ["playwright", "playwright-core", "@axe-core/playwright"];
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
  // Only mirror mode loads these, at run time, from node_modules next to the bundle.
  external: EXTERNAL,
  // Shebang comes from the entry file; CommonJS dependencies need require().
  banner: { js: "import { createRequire as __cdrRequire } from 'node:module'; const require = __cdrRequire(import.meta.url);" },
  logLevel: "warning",
});
// Built-in skills are found next to the bundle (dist-harness/skills).
rmSync(join(out, "skills"), { recursive: true, force: true });
cpSync(join(root, "packages/core/skills"), join(out, "skills"), { recursive: true });
// Mirror mode: the generated app's template, the fix prompts and theme packs, found next to the bundle.
rmSync(join(out, "mirror"), { recursive: true, force: true });
for (const [from, to] of [
  ["packages/mirror-generate/templates", "templates"],
  ["packages/mirror-fix/prompts", "prompts"],
  ["packages/mirror-capture/themes", "themes"],
])
  cpSync(join(root, from), join(out, "mirror", to), {
    recursive: true,
    filter: (p) => !/\/(node_modules|\.next)(\/|$)/.test(p),
  });
// Playwright cannot be bundled: its real files (dereferenced from pnpm's links) sit next to cdr.mjs.
rmSync(join(out, "node_modules"), { recursive: true, force: true });
/** The folder of package `name` as seen from `from` (package.json may not be exported, so walk up from its entry). */
function packageDir(from, name) {
  let dir = dirname(createRequire(join(from, "package.json")).resolve(name));
  while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== name)
    dir = dirname(dir);
  return dir;
}
const verify = join(root, "packages/mirror-verify");
const axe = packageDir(verify, "@axe-core/playwright");
const playwright = packageDir(verify, "playwright");
for (const [name, dir] of [
  ["playwright", playwright],
  ["playwright-core", packageDir(playwright, "playwright-core")],
  ["@axe-core/playwright", axe],
  ["axe-core", packageDir(axe, "axe-core")],
])
  cpSync(dir, join(out, "node_modules", name), {
    recursive: true,
    dereference: true,
    filter: (p) => !p.slice(dir.length).includes("/node_modules/"),
  });
// Everything in dist-harness ships inside CDR Studio, so the notices travel with the bundle.
for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) cpSync(join(root, f), join(out, f));
// The licence of every npm package that esbuild compiled into the bundle.
writeFileSync(join(out, "THIRD_PARTY_LICENSES.txt"), licenseNotices(Object.keys(result.metafile.inputs), root, "cdr.mjs"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");
console.log("bundled", join(out, "cdr.mjs"));
