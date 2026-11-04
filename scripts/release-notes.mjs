#!/usr/bin/env node
// Print the CHANGELOG.md section for a version (used as the GitHub release body).
//   node scripts/release-notes.mjs 0.2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] ?? "").replace(/^v/, "");
const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
let body = "";
if (start >= 0) {
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}
const install = `
### Install

| Platform | Download |
|---|---|
| Linux | \`.AppImage\` (any distribution), \`.deb\` (Debian, Ubuntu), \`.rpm\` (Fedora, openSUSE) |
| macOS | \`.dmg\` (Apple silicon and Intel) |
| Windows | \`-setup.exe\` or \`.msi\` |
| Terminal and web app | \`cdr-${version}.tar.gz\` or \`.zip\`. Then run \`node cdr-${version}/bin/cdr.mjs\` |

CDR Studio and the CLI need [Node.js 22 or newer](https://nodejs.org) on your machine. The macOS and Windows builds are not code-signed yet. On macOS, open the app with right-click → Open the first time. On Windows, choose "More info" → "Run anyway" in SmartScreen.`;
process.stdout.write((body || `CDR v${version}`) + "\n" + install + "\n");
