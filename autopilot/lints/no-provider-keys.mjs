// A produced app must never contain a provider key. Generated apps never see them (secretEnv), so a hit is a leak
// somewhere in the pipeline. Reports the file only, never the matched text.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SKIPPED_DIRS = new Set(["node_modules", ".next", ".git"]);
const TEXT = new Set([
  ".html",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".css",
  ".md",
  ".txt",
  ".env",
  ".yaml",
  ".yml",
]);
const KEY_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-or-v1-[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgsk_[A-Za-z0-9]{20,}/,
  /\bxai-[A-Za-z0-9]{20,}/,
];

export default function noProviderKeys({ appDir }) {
  const issues = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(full);
      } else if (TEXT.has(extname(name).toLowerCase())) {
        const text = readFileSync(full, "utf8");
        if (KEY_PATTERNS.some((pattern) => pattern.test(text)))
          issues.push({
            message: "a provider key appears in the generated app",
            file: relative(appDir, full),
          });
      }
    }
  };
  walk(appDir);
  return issues;
}
