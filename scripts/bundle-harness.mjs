// Bundle the CDR CLI (core + server) into one ESM file for CDR Studio's sidecar.
// Output: dist-harness/cdr.mjs (+ package.json marker). Requires `pnpm build:packages` first.
import { build } from "esbuild";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages/cli/dist/bin.js");
if (!existsSync(entry)) {
  console.error("packages/cli/dist/bin.js is missing; run `pnpm build:packages` first.");
  process.exit(1);
}
const out = join(root, "dist-harness");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [entry],
  outfile: join(out, "cdr.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  // Shebang comes from the entry file; CommonJS dependencies need require().
  banner: { js: "import { createRequire as __cdrRequire } from 'node:module'; const require = __cdrRequire(import.meta.url);" },
  logLevel: "warning",
});
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2) + "\n");
console.log("bundled", join(out, "cdr.mjs"));
