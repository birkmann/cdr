// End-to-end test of CDR Studio through tauri-driver (WebDriver) and WebKitWebDriver.
// Uses an isolated HOME-like environment, a throwaway Git repository, and the mock model provider:
// no network, no real model, no changes to your settings.
//
//   cargo build -p studio-app && pnpm bundle:harness
//   cargo install tauri-driver --locked
//   node apps/desktop/e2e/studio.e2e.mjs
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const app = process.env.STUDIO_BIN ?? join(repoRoot, "target/debug/cdr-studio");
const driverBin = process.env.TAURI_DRIVER ?? join(homedir(), ".cargo/bin/tauri-driver");
if (!existsSync(app)) throw new Error(`Build the app first: cargo build -p studio-app (${app} missing)`);

// ------------------------------------------------------------------ fixture
const tmp = mkdtempSync(join(tmpdir(), "morrow-studio-e2e-"));
const morrowHome = join(tmp, "morrow-home");
const xdgConfig = join(tmp, "config");
const xdgData = join(tmp, "data");
const repo = join(tmp, "projects", "demo-repo");
const remote = join(tmp, "remote.git");
for (const d of [morrowHome, xdgConfig, xdgData, repo]) mkdirSync(d, { recursive: true });
writeFileSync(
  join(morrowHome, "config.json"),
  JSON.stringify({
    providers: { mock: { type: "mock" } },
    models: { executor: "mock/mock", planner: "mock/mock", reviewer: "mock/mock", summarizer: "mock/mock" },
    sandbox: "none",
  }),
);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.name", "E2E");
git("config", "user.email", "e2e@example.com");
writeFileSync(join(repo, "README.md"), "# Demo\n\nHello from the fixture.\n");
writeFileSync(join(repo, "app.js"), "export const answer = 41;\n");
git("add", "-A");
git("commit", "-qm", "Initial commit");
execFileSync("git", ["init", "-q", "--bare", remote]);
git("remote", "add", "origin", remote);
// Pre-seed the recent list so the test can open the repo without the native folder dialog.
const appConfig = join(xdgConfig, "dev.morrow.studio");
mkdirSync(appConfig, { recursive: true });
writeFileSync(
  join(appConfig, "settings.json"),
  JSON.stringify({ recentRepos: [{ path: repo, name: "demo-repo", openedAt: Math.floor(Date.now() / 1000) }] }),
);

const env = {
  ...process.env,
  MORROW_HOME: morrowHome,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
  MORROW_KEYS_BACKEND: "file",
  // Release bundles use their own bundled harness; development builds use the checkout.
  ...(process.env.STUDIO_BIN ? {} : { MORROW_HARNESS_ENTRY: join(repoRoot, "dist-harness/cdr.mjs") }),
};
for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];

// ------------------------------------------------------------------ WebDriver client
const PORT = 4444;
const driver = spawn(driverBin, ["--port", String(PORT)], { env, stdio: ["ignore", "inherit", "inherit"] });
const base = `http://127.0.0.1:${PORT}`;
let sid;
async function wd(method, path, body) {
  const res = await fetch(`${base}${path.replace(":sid", sid)}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
  return json.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
const js = (script, ...args) => wd("POST", "/session/:sid/execute/sync", { script, args });
const find = async (css) => {
  const v = await wd("POST", "/session/:sid/element", { using: "css selector", value: css });
  return Object.values(v)[0];
};
/** Click the first element matching `css` whose text includes `text`. */
const clickText = (css, text) =>
  waitFor(
    () =>
      js(
        `const el=[...document.querySelectorAll(arguments[0])].find(e=>e.textContent.includes(arguments[1])&&e.offsetParent!==null); if(!el) return false; el.click(); return true;`,
        css,
        text,
      ),
    `${css} containing "${text}"`,
  );
const click = (css) =>
  waitFor(() => js(`const el=document.querySelector(arguments[0]); if(!el) return false; el.click(); return true;`, css), css);
const text = (css) => js(`return [...document.querySelectorAll(arguments[0])].map(e=>e.textContent).join("\\n")`, css);
const typeInto = async (css, value) => {
  const el = await waitFor(() => find(css), css);
  await wd("POST", `/session/:sid/element/${el}/value`, { text: value });
};
/** Set a React-controlled input's value. */
const setValue = (css, value) =>
  waitFor(
    () =>
      js(
        `const el=document.querySelector(arguments[0]); if(!el) return false;
         const proto = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
         Object.getOwnPropertyDescriptor(proto,'value').set.call(el, arguments[1]);
         el.dispatchEvent(new Event('input',{bubbles:true})); return true;`,
        css,
        value,
      ),
    css,
  );
const key = (k, mods = {}) =>
  js(
    `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:arguments[0],ctrlKey:!!arguments[1].ctrl,shiftKey:!!arguments[1].shift,bubbles:true}))`,
    k,
    mods,
  );

const steps = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    steps.push(`✓ ${name} (${Date.now() - t} ms)`);
    console.log(steps.at(-1));
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`);
    try {
      const shot = await wd("GET", "/session/:sid/screenshot");
      const file = join(tmp, `failure-${steps.length + 1}.png`);
      writeFileSync(file, Buffer.from(shot, "base64"));
      console.log(`  screenshot: ${file}`);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

let failed = false;
try {
  await waitFor(() => fetch(`${base}/status`).then((r) => r.ok), "tauri-driver");
  const created = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: app } } },
  });
  sid = created.sessionId;

  await step("harness starts and the welcome page renders", async () => {
    await waitFor(() => js(`return !!document.querySelector('.st-app')`), "app shell", 60000);
    await waitFor(async () => (await text(".st-welcome")).includes("demo-repo"), "recent repo on welcome page");
  });

  await step("open a recent repository", async () => {
    await clickText(".st-welcome .st-link", "demo-repo");
    await waitFor(async () => (await text(".st-titlebar")).includes("demo-repo"), "repo name in title bar");
    await waitFor(async () => (await text(".st-titlebar")).includes("main"), "branch in title bar");
  });

  await step("colorful file icons are the default", async () => {
    const icons = await waitFor(
      () =>
        js(
          `return [...document.querySelectorAll('.st-tree-row')].map(r => [r.textContent.trim(), r.querySelector('img.st-file-icon')?.getAttribute('src') ?? ''])`,
        ),
      "tree icons",
    );
    const readme = icons.find(([n]) => n.startsWith("README.md"));
    const js_ = icons.find(([n]) => n.startsWith("app.js"));
    if (!readme?.[1].includes("readme") || !js_?.[1].includes("javascript"))
      throw new Error(`unexpected icons: ${JSON.stringify(icons)}`);
    await waitFor(
      () => js(`return [...document.querySelectorAll('img.st-file-icon')].every(i => i.complete && i.naturalWidth > 0)`),
      "icon images loaded",
    );
  });

  await step("explorer lists files and opens one in the editor", async () => {
    await clickText(".st-tree-row", "README.md");
    await waitFor(async () => (await text(".cm-content")).includes("Hello from the fixture"), "README content");
  });

  await step("edit and save with Ctrl+S", async () => {
    await clickText(".st-tree-row", "app.js");
    await waitFor(async () => (await text(".cm-content")).includes("answer"), "app.js content");
    await js(`const v=document.querySelector('.cm-content').cmView?.view; return !!v`);
    // Replace the document through CodeMirror's DOM: select all, then type.
    const content = await find(".cm-content");
    await wd("POST", `/session/:sid/element/${content}/click`, {});
    await key("a", { ctrl: true });
    await wd("POST", `/session/:sid/element/${content}/value`, { text: "export const answer = 42;\n" });
    await waitFor(async () => (await text(".st-tab.on .st-tab-close.dirty")) !== null, "dirty marker");
    await js(`document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))`);
    await waitFor(() => readFileSync(join(repo, "app.js"), "utf8").includes("42"), "file saved to disk");
  });

  await step("source control shows the change and commits it", async () => {
    await click('.st-activity-btn[aria-label="Source control"]');
    await waitFor(async () => (await text(".st-change")).includes("app.js"), "app.js in changes");
    await clickText(".st-change-main", "app.js");
    await waitFor(async () => (await text(".st-diff-table")).includes("42"), "diff view");
    await click("button.st-generate");
    await waitFor(
      () => js(`return document.querySelector('.st-commit textarea').value === 'Done.'`),
      "generated commit message (mock model)",
    );
    await setValue(".st-commit textarea", "Answer the question");
    await clickText(".st-commit button", "Commit");
    await waitFor(() => git("log", "-1", "--format=%s") === "Answer the question", "commit in git log");
  });

  await step("hunk staging stages only the chosen hunk", async () => {
    writeFileSync(join(repo, "README.md"), "# Demo changed\n\nHello from the fixture.\n");
    await waitFor(async () => (await text(".st-change")).includes("README.md"), "README in changes", 30000);
    await clickText(".st-change-main", "README.md");
    await clickText(".st-hunk button", "Stage hunk");
    await waitFor(() => git("diff", "--cached", "--name-only") === "README.md", "README staged");
  });

  await step("create and switch branches from the title bar", async () => {
    await click(".st-branch-menu .st-title-btn");
    await setValue(".st-branch-menu input", "feature/e2e");
    await key("Enter");
    await waitFor(() => git("branch", "--show-current") === "feature/e2e", "on feature/e2e");
    await waitFor(async () => (await text(".st-titlebar")).includes("feature/e2e"), "branch shown");
  });

  await step("publish the branch to the remote", async () => {
    await clickText(".st-title-btn", "Publish branch");
    await waitFor(
      () => execFileSync("git", ["--git-dir", remote, "branch", "--list", "feature/e2e"], { encoding: "utf8" }).includes("feature/e2e"),
      "branch on remote",
      30000,
    );
  });

  await step("history shows the graph and commit details", async () => {
    await click('.st-panel-head button[aria-label="History"]');
    await waitFor(async () => (await text(".st-commit-row")).includes("Answer the question"), "commit row");
    await clickText(".st-commit-row", "Answer the question");
    await waitFor(async () => (await text(".st-commit-detail")).includes("app.js"), "commit files");
  });

  await step("project search finds text", async () => {
    await click('.st-activity-btn[aria-label="Search"]');
    await setValue('.st-search-form input[aria-label="Search text"]', "fixture");
    await waitFor(async () => (await text(".st-search-summary")).includes("1 results in 1 files"), "search result");
  });

  await step("terminal runs a command", async () => {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true}))`);
    const ta = await waitFor(() => find(".xterm-helper-textarea"), "terminal");
    await sleep(800);
    await wd("POST", `/session/:sid/element/${ta}/value`, { text: "echo studio-$((40+2))\n" });
    await waitFor(async () => (await text(".xterm-rows")).includes("studio-42"), "terminal output");
  });

  await step("agent conversation with the mock model", async () => {
    await waitFor(() => js(`return !!document.querySelector('.st-new-chat textarea')`), "agent composer");
    await setValue(".st-new-chat textarea", "Say hello");
    await js(
      `document.querySelector('.st-new-chat textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    );
    await waitFor(async () => (await text(".st-agent-body")).includes("Done."), "mock reply", 30000);
  });

  await step("goals: create a draft goal", async () => {
    await click('.st-activity-btn[aria-label="Goals"]');
    await click('.st-panel-head button[aria-label="New goal"]');
    await setValue(".st-goal-inner input", "Make the answer configurable");
    await setValue('.st-list-input input', "pnpm test passes");
    await clickText(".st-goal-inner button", "Save draft");
    await waitFor(async () => (await text(".st-goal-row")).includes("Make the answer configurable"), "goal in list");
    await waitFor(() => existsSync(join(repo, ".harness/goals")), "goal file in repo");
  });

  await step("goals: run unattended in a worktree until the budget stops it", async () => {
    await clickText(".st-goal-row", "Make the answer configurable");
    await clickText(".st-goal-inner button", "Run now");
    await waitFor(async () => (await text(".st-goal-inner")).includes("Started round"), "goal timeline", 30000);
    // The mock model never satisfies the criterion, so the goal stops after its rounds.
    await waitFor(
      async () => /Needs attention|Failed/.test(await text(".st-goal-inner .st-goal-status")),
      "goal to stop",
      120000,
    );
    const branches = git("branch", "--list", "cdr/goal-*");
    if (!branches.includes("cdr/goal-")) throw new Error(`goal branch missing: ${branches}`);
    await clickText(".st-goal-inner button", "Discard");
    await clickText(".st-dialog button", "Discard");
    await waitFor(async () => !(await text(".st-goal-row")).includes("Make the answer configurable") || (await text(".st-goal-inner .st-goal-status")).includes("Discarded"), "goal discarded");
  });

  await step("settings dialog and theme switch", async () => {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true}))`);
    await clickText(".st-theme", "Paper light");
    await waitFor(() => js(`return document.documentElement.dataset.theme === 'light'`), "light theme");
    await clickText('.st-themes[aria-label="File icons"] .st-theme', "Monochrome");
    await waitFor(
      () => js(`return !document.querySelector('.st-tabs img.st-file-icon') && !!document.querySelector('.st-tab svg')`),
      "monochrome icons in the editor tabs",
    );
    await clickText('.st-themes[aria-label="File icons"] .st-theme', "Colorful");
    await waitFor(() => js(`return !!document.querySelector('.st-tabs img.st-file-icon')`), "colorful icons again");
    await clickText(".st-settings nav button", "Harness");
    await waitFor(async () => (await text(".st-settings-body")).includes("ready"), "harness ready");
    await click(".st-close");
  });

  await step("discard dialog is legible and can be cancelled", async () => {
    writeFileSync(join(repo, "scratch.txt"), "keep me\n");
    await click('.st-activity-btn[aria-label="Source control"]');
    await waitFor(async () => (await text(".st-change")).includes("scratch.txt"), "scratch.txt in changes", 30000);
    await click('.st-section-actions button[aria-label="Discard all"]');
    const colors = await waitFor(
      () =>
        js(`const b=document.querySelector('.st-dialog .st-danger-btn'); if(!b) return null;
            const cs=getComputedStyle(b); return [cs.backgroundColor, cs.color, b.textContent];`),
      "danger dialog",
    );
    if (colors[0] === colors[1]) throw new Error(`unreadable button: ${colors}`);
    writeFileSync(join(repoRoot, "apps/desktop/e2e/dialog.png"), Buffer.from(await wd("GET", "/session/:sid/screenshot"), "base64"));
    await clickText(".st-dialog button", "Cancel");
    await waitFor(() => js(`return !document.querySelector('.st-dialog')`), "dialog closed");
    if (!existsSync(join(repo, "scratch.txt"))) throw new Error("changes were discarded");
  });

  await step("zoom with Ctrl+= / Ctrl+wheel and reset with Ctrl+0", async () => {
    const before = await js(`return window.innerWidth`);
    const press = (key) => js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:arguments[0],ctrlKey:true,bubbles:true}))`, key);
    await press("=");
    await waitFor(async () => (await js(`return window.innerWidth`)) < before - 20, "zoomed in (narrower CSS viewport)");
    await waitFor(async () => (await text(".st-statusbar")).includes("110%"), "zoom indicator");
    await js(`window.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,ctrlKey:true,bubbles:true,cancelable:true}))`);
    await waitFor(async () => (await text(".st-statusbar")).includes("120%"), "wheel zoom");
    await press("0");
    await waitFor(async () => Math.abs((await js(`return window.innerWidth`)) - before) <= 2, "zoom reset");
    await waitFor(async () => !(await text(".st-statusbar")).includes("%"), "indicator hidden at 100%");
  });

  await step("screenshot", async () => {
    const shot = await wd("GET", "/session/:sid/screenshot");
    const file = join(repoRoot, "apps/desktop/e2e/screenshot.png");
    writeFileSync(file, Buffer.from(shot, "base64"));
    console.log(`  saved ${file}`);
  });
} catch {
  failed = true;
} finally {
  if (sid) await wd("DELETE", "/session/:sid").catch(() => {});
  driver.kill();
  // A failed WebDriver session can leave the app window open; close the one this test started.
  try {
    execFileSync("pkill", ["-f", "-x", `${app}.*`]);
  } catch {
    /* already closed */
  }
  if (!failed && !process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
  else console.log(`fixture kept at ${tmp}`);
}
console.log(failed ? "\nE2E FAILED" : `\nE2E passed: ${steps.length} steps`);
process.exit(failed ? 1 : 0);
