import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { harnessHome } from "./config.js";
import { slugify } from "./util.js";

export function sandboxesDir(): string {
  return process.env.HARNESS_SANDBOXES ?? join(harnessHome(), "sandboxes");
}

/** These containers are not individual projects and must not be browsed as one. */
export function isWorkspaceContainer(path: string): boolean {
  const canonical = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const root = canonical(path);
  return (
    root === dirname(root) || [homedir(), harnessHome(), sandboxesDir()].some((p) => canonical(p) === root)
  );
}

let bwrapOk: boolean | undefined;
/** True if bubblewrap is installed and usable (user namespaces allowed). */
export function bwrapAvailable(): boolean {
  if (bwrapOk === undefined) {
    bwrapOk =
      spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "true"], { stdio: "ignore" }).status === 0;
  }
  return bwrapOk;
}

/** Create a fresh, git-initialised workspace for a sandbox session. */
export function createSandboxDir(name?: string): string {
  const base = sandboxesDir();
  mkdirSync(base, { recursive: true });
  const slug = slugify(name || "sandbox", 32);
  let dir: string;
  do dir = join(base, `${slug}-${randomBytes(3).toString("hex")}`);
  while (existsSync(dir));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.harness/\ndist/\n__pycache__/\n.venv/\n");
  const g = (...a: string[]) =>
    spawnSync("git", ["-c", "user.email=harness@localhost", "-c", "user.name=harness", ...a], {
      cwd: dir,
      stdio: "ignore",
    });
  g("init", "-q");
  g("add", "-A");
  g("commit", "-qm", "sandbox created");
  return dir;
}

export const SANDBOX_PROMPT = `# Sandbox workspace
This project is a fresh sandbox created for this conversation (the folder starts empty apart from .gitignore). You own it, but only build when the user asks for something to be made.
- Questions, explanations, opinions and casual chat get a text answer only: do not create files, call \`set_preview\` or call \`check_preview\`, even though the folder is empty.
- When the user does ask you to build something, create the project from scratch.
- Prefer self-contained, dependency-free solutions (plain HTML/CSS/JavaScript in an index.html, or a small Node/Python script) unless the user asks for a framework.
- If you need packages, install them with the package manager (network may be available); keep it minimal.
- For anything viewable in a browser (game, page, UI, chart): build it as a static HTML file (inline or relative scripts/styles; or build it and use the built index.html). As soon as a first working version exists, call \`set_preview\` – the user sees it live and can try it while you continue.
- For a native program (desktop app, game, CLI – e.g. Rust, Go, Python, Swift) that you built and ran successfully, call \`set_launch\` with the command that starts it (e.g. \`cargo run --release\`) so the user gets a Launch button; do not leave them to copy the command from your summary.
- Check a web page with \`check_preview\` (headless browser at phone and desktop widths: JavaScript errors, horizontal overflow, broken images, unlabelled controls, rendered summary). Do NOT install browsers, Playwright or Puppeteer, do NOT write browser test harnesses, and do NOT save screenshots or test scripts in the project.
- Keep it focused: build, preview, check, fix every problem the check reports (check again after layout or script fixes), then give a short summary of what you made and how to use it. Once the check reports no problems, stop: do not keep polishing.`;
