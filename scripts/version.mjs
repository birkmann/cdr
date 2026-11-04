#!/usr/bin/env node
// Set the CDR version everywhere, date the changelog, then commit and tag.
//
//   pnpm release:version 0.2.0            # updates files, commits "Release v0.2.0", tags v0.2.0
//   pnpm release:version 0.2.0 --push     # also pushes the commit and tag (starts the release workflow)
//   pnpm release:version 0.2.0 --no-git   # only update files
//   pnpm release:version --check          # verify all version fields agree (used in CI)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const packageJsons = [
  "package.json",
  ...["packages", "apps"].flatMap((d) =>
    readdirSync(join(root, d))
      .map((p) => `${d}/${p}/package.json`)
      .filter((p) => existsSync(join(root, p))),
  ),
];
const PROTOCOL = "packages/protocol/src/index.ts";
const CARGO = "Cargo.toml";
const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, s) => writeFileSync(join(root, p), s);

function current() {
  const found = new Map();
  for (const p of packageJsons) found.set(p, JSON.parse(read(p)).version);
  found.set(PROTOCOL, /HARNESS_VERSION = "([^"]+)"/.exec(read(PROTOCOL))?.[1]);
  found.set(CARGO, /\[workspace\.package\][^[]*?version = "([^"]+)"/s.exec(read(CARGO))?.[1]);
  return found;
}

if (flag("--check")) {
  const found = current();
  const versions = new Set(found.values());
  if (versions.size !== 1) {
    for (const [p, v] of found) console.error(`${v}\t${p}`);
    console.error("Version fields disagree. Run `pnpm release:version <version>`.");
    process.exit(1);
  }
  const [v] = versions;
  const tag = process.env.GITHUB_REF_NAME;
  if (tag?.startsWith("v") && tag !== `v${v}`) {
    console.error(`Tag ${tag} does not match version ${v}.`);
    process.exit(1);
  }
  console.log(v);
  process.exit(0);
}

const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
if (!version || !SEMVER.test(version)) {
  console.error("Usage: pnpm release:version <x.y.z[-pre]> [--push] [--no-git]");
  process.exit(1);
}

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
if (!flag("--no-git")) {
  if (git("status", "--porcelain")) {
    console.error("The working tree has uncommitted changes. Commit or stash them first.");
    process.exit(1);
  }
  if (git("tag", "--list", `v${version}`)) {
    console.error(`Tag v${version} already exists.`);
    process.exit(1);
  }
}

for (const p of packageJsons) {
  const d = JSON.parse(read(p));
  d.version = version;
  write(p, JSON.stringify(d, null, 2) + "\n");
}
write(PROTOCOL, read(PROTOCOL).replace(/HARNESS_VERSION = "[^"]+"/, `HARNESS_VERSION = "${version}"`));
write(CARGO, read(CARGO).replace(/(\[workspace\.package\][^[]*?version = )"[^"]+"/s, `$1"${version}"`));

// Changelog: "## Unreleased" becomes the release; a fresh empty Unreleased section goes on top.
const today = new Date().toISOString().slice(0, 10);
let changelog = read("CHANGELOG.md");
if (changelog.includes(`## ${version} `) || changelog.includes(`## ${version}\n`)) {
  console.log(`CHANGELOG.md already has a ${version} section.`);
} else if (changelog.includes("## Unreleased")) {
  changelog = changelog.replace("## Unreleased", `## Unreleased\n\n## ${version} (${today})`);
  write("CHANGELOG.md", changelog);
} else {
  console.warn("CHANGELOG.md has no Unreleased section; add release notes by hand.");
}

// Refresh lockfiles so they carry the new workspace versions.
execFileSync("cargo", ["metadata", "--format-version", "1", "--offline"], { cwd: root, stdio: "ignore" });
execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: root, stdio: "inherit" });

console.log(`Version set to ${version}.`);
if (flag("--no-git")) process.exit(0);

git("add", "-A");
git("commit", "-m", `Release v${version}`);
git("tag", "-a", `v${version}`, "-m", `CDR v${version}`);
console.log(`Committed and tagged v${version}.`);
if (flag("--push")) {
  git("push", "origin", "HEAD");
  git("push", "origin", `v${version}`);
  console.log("Pushed. The release workflow builds the apps and publishes the GitHub release.");
} else {
  console.log(`Push with: git push origin HEAD && git push origin v${version}`);
}
