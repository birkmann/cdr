// Licence texts of the npm packages compiled into a bundle, so every shipped bundle carries its notices.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** `files`: paths of bundled modules (absolute, or relative to `root`). Returns the text of THIRD_PARTY_LICENSES.txt. */
export function licenseNotices(files, root, what) {
  const packages = new Map();
  for (const raw of files) {
    const file = raw.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
    const at = file.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const parts = file.slice(at + "node_modules/".length).split("/");
    const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    const base = file.slice(0, at);
    packages.set(name, join(isAbsolute(base) ? base : join(root, base), "node_modules", name));
  }
  const notices = [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, dir]) => existsSync(join(dir, "package.json")))
    .map(([name, dir]) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
      const text = file
        ? readFileSync(join(dir, file), "utf8").trim()
        : `(no licence file in the package; declared licence: ${pkg.license})`;
      return `${name} ${pkg.version} (${pkg.license})\n${"-".repeat(72)}\n${text}\n`;
    });
  return `Packages compiled into ${what}, each under its own licence.\n\n${notices.join("\n\n")}`;
}

/** Vite plugin: writes THIRD_PARTY_LICENSES.txt next to the built app. */
export function licensesPlugin(what) {
  return {
    name: "cdr-licenses",
    apply: "build",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).flatMap((chunk) => (chunk.type === "chunk" ? Object.keys(chunk.modules) : []));
      this.emitFile({ type: "asset", fileName: "THIRD_PARTY_LICENSES.txt", source: licenseNotices(files, process.cwd(), what) });
    },
  };
}
