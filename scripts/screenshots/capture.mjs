#!/usr/bin/env node
// Regenerates the README screenshots in docs/images with the scripted demo model (no API keys).
//   pnpm build && cargo build -p studio-app --features tauri/custom-protocol
//   node scripts/screenshots/capture.mjs [web] [desktop] [desktop-git] [desktop-agents] [terminal] [terminal-classic] [terminal-approval]
//   node scripts/screenshots/capture.mjs web --real [--model <provider/model>] [--prompt "<brief>"] [--out <dir>]
//     --real builds the app with a real model (API key from .env) and the web-app skill instead of the
//     scripted demo, and saves web-*-real.png (default folder: a temp dir, printed at the end).
// Needs Google Chrome or Chromium (web, terminal), tauri-driver + WebKitWebDriver (desktop), python3 (terminal).
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareGitDemo } from "./git-demo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const argv = process.argv.slice(2);
const takeFlag = (name, hasValue = true) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return hasValue ? argv.splice(i, 2)[1] : (argv.splice(i, 1), true);
};
const REAL = takeFlag("--real", false);
const REAL_MODEL = takeFlag("--model") ?? "deepseek/deepseek-flash";
const STORE_PROMPT = "Build Form, a responsive accessories store with a clean product grid, product details, and a working bag.";
const REAL_PROMPT = takeFlag("--prompt") ?? STORE_PROMPT;
const outFlag = takeFlag("--out");
const out = outFlag ? resolve(outFlag) : REAL ? mkdtempSync(join(tmpdir(), "cdr-real-shots-")) : join(root, "docs/images");
mkdirSync(out, { recursive: true });
const only = new Set(argv);
const want = (name) => only.size === 0 || only.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "cdr-shots-"));
process.env.CDR_HOME = join(tmp, "cdr-home");
mkdirSync(process.env.CDR_HOME, { recursive: true });
// Shots that only prove the demo app works are kept out of docs/images unless --out asks for everything.
const extra = outFlag ? out : join(tmp, "extra");
mkdirSync(extra, { recursive: true });

const requireWeb = createRequire(join(root, "apps/web/package.json"));
const pw = await import(pathToFileURL(requireWeb.resolve("playwright-core")).href);
const chromium = pw.chromium ?? pw.default.chromium;
const chrome = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
const SCALE = 1.5;

// ------------------------------------------------------------------ web app, real model
async function webReal() {
  const core = await import(join(root, "packages/core/dist/index.js"));
  const { startServer } = await import(join(root, "packages/server/dist/index.js"));
  // Keys come from the repository .env and the user's real ~/.harness/.env (CDR_HOME points at a temp dir).
  core.loadDotEnv(root);
  core.loadDotEnv(join(homedir(), ".harness"));
  const harness = new core.Harness({
    skipGlobalConfig: true,
    configOverrides: { models: { executor: REAL_MODEL, planner: REAL_MODEL, reviewer: REAL_MODEL, summarizer: REAL_MODEL } },
  });
  const server = await startServer({ harness, token: "demo", port: 0, staticDir: join(root, "apps/web/dist") });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const started = Date.now();
  try {
    const page = await browser.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: SCALE });
    await page.goto(`${server.url}/#token=demo`);
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("harness.settings.v1") || "{}");
      localStorage.setItem("harness.settings.v1", JSON.stringify({ ...s, theme: "dark", name: "", permissionMode: "auto" }));
      localStorage.setItem("cdr.chat-width", "460");
    });
    await page.reload();
    await page.locator(".composer.large textarea").fill(REAL_PROMPT);
    await page.locator(".composer.large textarea").press("Enter");
    console.log(`… building with ${REAL_MODEL} (this takes a few minutes)`);
    await page.getByRole("button", { name: "Copy response" }).last().waitFor({ timeout: 20 * 60_000 });
    await page.locator("iframe.preview-frame").waitFor({ timeout: 60_000 });
    const preview = page.frames().find((f) => f.url().includes("/preview/"));
    if (!preview) throw new Error("The agent did not publish a preview");
    await preview.waitForFunction(() => [...document.images].every((img) => img.complete), { timeout: 30000 }).catch(() => {});
    await sleep(800);
    await page.screenshot({ path: join(out, "web-preview-real.png") });
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SCALE });
    const errors = [];
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(preview.url());
    await phone.waitForFunction(() => [...document.images].every((img) => img.complete), { timeout: 30000 }).catch(() => {});
    await phone.screenshot({ path: join(out, "web-mobile-real.png") });
    const overflow = [];
    for (const width of [320, 390, 768, 1280]) {
      await phone.setViewportSize({ width, height: 900 });
      if (await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) overflow.push(width);
    }
    await phone.screenshot({ path: join(out, "web-desktop-real.png"), fullPage: true });
    const broken = await phone.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length);
    await phone.close();
    console.log(`✓ web (real, ${REAL_MODEL}, ${Math.round((Date.now() - started) / 1000)} s) → ${out}`);
    console.log(`  JavaScript errors: ${errors.length ? errors.join(" | ") : "none"}`);
    console.log(`  overflow at: ${overflow.length ? overflow.join(", ") + " px" : "none"}; broken images: ${broken}`);
    if (errors.length || overflow.length || broken) throw new Error("The generated app has problems (see above)");
  } finally {
    await browser.close();
    await server.close();
  }
}

// ------------------------------------------------------------------ web app
async function web() {
  if (REAL) return webReal();
  const { createDemoHarness } = await import("./demo-model.mjs");
  const { startServer } = await import(join(root, "packages/server/dist/index.js"));
  const server = await startServer({
    harness: createDemoHarness(),
    token: "demo",
    port: 0,
    staticDir: join(root, "apps/web/dist"),
  });
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE });
    await page.goto(`${server.url}/#token=demo`);
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("harness.settings.v1") || "{}");
      localStorage.setItem("harness.settings.v1", JSON.stringify({ ...s, theme: "dark", name: "", permissionMode: "auto" }));
    });
    await page.reload();
    await page.locator(".composer.large textarea").waitFor();
    await page.screenshot({ path: join(extra, "web-home.png") });
    await page.setViewportSize({ width: 1560, height: 1000 });
    await page.evaluate(() => localStorage.setItem("cdr.chat-width", "460"));
    await page.locator(".composer.large textarea").fill(STORE_PROMPT);
    await page.locator(".composer.large textarea").press("Enter");
    const frame = page.frameLocator("iframe.preview-frame");
    await frame.locator("h1", { hasText: "Everyday objects" }).waitFor({ timeout: 20000 });
    await page.locator(".chat-head").waitFor();
    // Wait for actual photography and settled output, rather than capturing image placeholders.
    await frame.locator(".product").first().waitFor();
    const preview = page.frames().find((f) => f.url().includes("/preview/"));
    if (!preview) throw new Error("Store preview frame is missing");
    await preview.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0), { timeout: 30000 });
    await page.getByText("Form is ready.", { exact: false }).waitFor();
    await sleep(500);
    await page.screenshot({ path: join(out, "web-preview.png") });
    // Exercise the same app at phone widths, using the real isolated preview URL.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SCALE });
    await phone.goto(preview.url());
    await phone.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
    await phone.screenshot({ path: join(extra, "web-mobile-demo.png") });
    const browserErrors = [];
    phone.on("pageerror", error => browserErrors.push(error.message));
    await phone.getByLabel("Filter collection").selectOption("Technology");
    if (await phone.locator(".product").count() !== 2) throw new Error("Technology filter failed");
    await phone.getByLabel("Filter collection").selectOption("All objects");
    await phone.getByRole("button", { name: "View Everyday runner", exact: true }).click();
    if (await phone.locator("#add-to-bag").isEnabled()) throw new Error("Size must be selected first");
    await phone.getByRole("button", { name: "Size 42", exact: true }).click();
    const addRect = await phone.locator("#add-to-bag").boundingBox();
    if (!addRect || addRect.y + addRect.height > 844) throw new Error("Mobile add action is off screen");
    await phone.screenshot({ path: join(extra, "web-product-demo.png") });
    await phone.getByRole("button", { name: "Add to bag", exact: true }).click();
    await phone.getByRole("button", { name: "Open bag", exact: true }).click();
    await phone.getByRole("button", { name: "Add one Everyday runner", exact: true }).click();
    if (await phone.locator(".total").innerText() !== "Total\n€280") throw new Error("Bag total is incorrect");
    await phone.getByRole("button", { name: "Close bag", exact: true }).click();
    await phone.reload();
    await phone.getByRole("button", { name: "Open bag", exact: true }).click();
    if (await phone.locator(".total").innerText() !== "Total\n€280") throw new Error("Bag did not persist");
    await phone.getByRole("button", { name: "Try demo checkout", exact: true }).click();
    await phone.getByText("Your demo order is complete.", { exact: false }).waitFor();
    await phone.getByRole("button", { name: "Back to collection", exact: true }).click();
    for (const width of [320, 390, 768, 1280]) {
      await phone.setViewportSize({ width, height: 900 });
      if (await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Layout overflows at ${width}px`);
      if (await phone.locator(".product").count() !== 4) throw new Error("Missing catalogue products");
    }
    await phone.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
    await phone.screenshot({ path: join(extra, "web-desktop-demo.png"), fullPage: true });
    await phone.setViewportSize({ width: 320, height: 740 });
    await phone.getByRole("button", { name: "Open menu", exact: true }).click();
    await phone.getByRole("button", { name: "Bags & accessories", exact: false }).last().click();
    if (await phone.locator(".product").count() !== 1) throw new Error("Mobile navigation filter failed");
    await phone.getByRole("button", { name: "View Daypack", exact: true }).click();
    await phone.getByRole("button", { name: "Add to bag", exact: true }).click();
    await phone.getByRole("button", { name: "Open bag", exact: true }).click();
    await phone.getByRole("button", { name: "Remove Daypack from bag", exact: true }).click();
    await phone.getByText("Your bag is empty.", { exact: true }).waitFor();
    await phone.keyboard.press("Escape");
    if (await phone.locator("dialog[open]").count()) throw new Error("Escape did not close dialog");
    if (browserErrors.length) throw new Error(browserErrors.join("\n"));
    await phone.close();
    console.log("✓ web");
  } finally {
    await browser.close();
    await server.close();
  }
}

// ------------------------------------------------------------------ terminal (real TUI in a pty, rendered by xterm.js)
// CDR_HOME is an empty temp folder, so the TUI starts in its default design; "classic" is written to tui.json first.
// In `ask` mode the run stops at the first file edit, which shows the approval dialog.
async function terminal({ design = "default", mode = "auto", name = "terminal" } = {}) {
  const classic = design === "classic";
  if (classic) writeFileSync(join(process.env.CDR_HOME, "tui.json"), JSON.stringify({ design }));
  else rmSync(join(process.env.CDR_HOME, "tui.json"), { force: true });
  const project = join(tmpdir(), "projects", "node-api");
  rmSync(project, { recursive: true, force: true });
  mkdirSync(dirname(project), { recursive: true });
  cpSync(join(root, "evals/fixtures/node-api"), project, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qam", "init", "--allow-empty"], { cwd: project });
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "Initial API"], { cwd: project });
  const raw = join(tmp, "tui.raw");
  const py = `
import os, pty, sys, time, select, struct, fcntl, termios, signal
cols, rows = 132, 36
pid, fd = pty.fork()
if pid == 0:
    os.environ.pop("NO_COLOR", None)
    os.environ.update({"COLUMNS": str(cols), "LINES": str(rows), "TERM": "xterm-256color", "COLORTERM": "truecolor"})
    os.execvp("node", ["node", sys.argv[1], "-C", sys.argv[2], "--mode", sys.argv[4]])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
buf = bytearray()
def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: buf.extend(os.read(fd, 65536))
            except OSError: return
pump(2.5)
for ch in "Add a GET /version endpoint that returns the package version, with a test":
    os.write(fd, ch.encode()); pump(0.012)
pump(0.4)
os.write(fd, b"\\r")
pump(9)
open(sys.argv[3], "wb").write(bytes(buf))
os.kill(pid, signal.SIGTERM)
`;
  execFileSync("python3", ["-c", py, join(here, "demo-cli.mjs"), project, raw, mode], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  const requireDesktop = createRequire(join(root, "apps/desktop/package.json"));
  const xtermDir = dirname(requireDesktop.resolve("@xterm/xterm/package.json"));
  const bytes = readFileSync(raw).toString("base64");
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(join(xtermDir, "css/xterm.css")).href}">
<style>html,body{margin:0;background:#151515} #frame{display:inline-block;margin:24px;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px #0008;border:1px solid #4c4d50}
#bar{height:30px;background:#2b2c2e;display:flex;align-items:center;gap:8px;padding:0 12px;font:12px system-ui;color:#b8bbc2}
#bar i{width:11px;height:11px;border-radius:50%;display:inline-block} #t{padding:10px 12px;background:#1c1c1c}</style></head>
<body><div id="frame"><div id="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span style="margin-left:10px">cdr — ~/projects/node-api</span></div><div id="t"></div></div>
<script src="${pathToFileURL(join(xtermDir, "lib/xterm.js")).href}"></script>
<script>
const term = new Terminal({ cols: 132, rows: 36, fontFamily: "'JetBrains Mono', 'DejaVu Sans Mono', monospace", fontSize: 13, lineHeight: 1.15,
  theme: { background: "#1c1c1c", foreground: "#f4f4f5", cursor: "${classic ? "#c8f56b" : "#d4a05a"}" }, allowProposedApi: true });
term.open(document.getElementById("t"));
const bin = atob("${bytes}"); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
term.write(u, () => { document.body.dataset.done = "1"; });
</script></body></html>`;
  const page = join(tmp, "tui.html");
  writeFileSync(page, html);
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--allow-file-access-from-files"] });
  try {
    const p = await browser.newPage({ viewport: { width: 1320, height: 860 }, deviceScaleFactor: SCALE });
    await p.goto(pathToFileURL(page).href);
    await p.waitForSelector("body[data-done='1']", { timeout: 10000 });
    await sleep(300);
    await p.locator("#frame").screenshot({ path: join(out, `${name}.png`), omitBackground: false });
    console.log(`✓ ${name}`);
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ desktop app (Tauri, WebDriver)
async function desktop() {
  const gitOnly = only.has("desktop-git") && !want("desktop");
  const agentsOnly = only.has("desktop-agents") && !want("desktop");
  const app = process.env.STUDIO_BIN ?? join(root, "target/debug/cdr-studio");
  const driverBin = process.env.TAURI_DRIVER ?? join(homedir(), ".cargo/bin/tauri-driver");
  if (!existsSync(app)) throw new Error(`Build the app first: cargo build -p studio-app --features tauri/custom-protocol`);
  // A copy of the tracked files with a short made-up history, so the screenshots show no real commits or branches.
  const repo = join(tmp, "projects", "cdr");
  mkdirSync(repo, { recursive: true });
  execFileSync("sh", ["-c", `git -C "${root}" archive HEAD | tar -x -C "${repo}"`]);
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Rafael Birkmann");
  g("config", "user.email", "demo@example.com");
  const day = 86400;
  const start = Math.floor(Date.now() / 1000) - 9 * day;
  const history = [
    ["Add protocol types and JSON schemas", "packages/protocol"],
    ["Add the agent loop, tools and permission policy", "packages/core"],
    ["Add the HTTP server and the client SDK", "packages/server", "packages/client", "packages/react"],
    ["Add the terminal workspace", "packages/cli"],
    ["Add the web app with sandboxes and live previews", "apps/web"],
    ["Add CDR Studio, the desktop app", "apps/desktop", "crates", "Cargo.toml", "Cargo.lock"],
    ["Add page recreation packages", "packages"],
    ["Add docs, evals and CI", "."],
  ];
  history.forEach(([message, ...paths], i) => {
    const date = `${start + i * day + i * 4321} +0000`;
    g("add", "-A", "--", ...paths);
    execFileSync("git", ["commit", "-qm", message], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  });
  // A small uncommitted change so source control has something to show.
  const loop = join(repo, "packages/core/src/permissions.ts");
  writeFileSync(loop, readFileSync(loop, "utf8").replace("export class PermissionPolicy", "/** Decides whether a tool call runs, asks, or is refused. */\nexport class PermissionPolicy"));
  const xdg = join(tmp, "config");
  mkdirSync(join(xdg, "io.github.birkmann.cdr"), { recursive: true });
  // A second checkout: two agents never edit the same folder at once, so the split-view shot's
  // second conversation works here.
  const uiRepo = join(tmp, "projects", "cdr-ui");
  execFileSync("git", ["clone", "-q", "--local", repo, uiRepo]);
  writeFileSync(
    join(xdg, "io.github.birkmann.cdr/settings.json"),
    JSON.stringify({
      recentRepos: [
        { path: repo, name: "cdr", openedAt: Math.floor(Date.now() / 1000) - 3600 },
        { path: uiRepo, name: "cdr-ui", openedAt: Math.floor(Date.now() / 1000) - 7200 },
      ],
    }),
  );
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    XDG_DATA_HOME: join(tmp, "data"),
    CDR_KEYS_BACKEND: "file",
    CDR_HARNESS_ENTRY: join(here, "demo-server.mjs"),
  };
  const driver = spawn(driverBin, ["--port", "4444"], { env, stdio: "ignore" });
  const base = "http://127.0.0.1:4444";
  let sid;
  const wd = async (method, path, body) => {
    const res = await fetch(base + path.replace(":sid", sid), { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j.value ?? j).slice(0, 300)}`);
    return j.value;
  };
  const js = (script, ...args) => wd("POST", "/session/:sid/execute/sync", { script, args });
  const until = async (fn, what, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await fn()) return;
      } catch {
        /* retry */
      }
      await sleep(200);
    }
    throw new Error(`timed out: ${what}`);
  };
  const clickText = (css, text) =>
    until(() => js(`const e=[...document.querySelectorAll(arguments[0])].find(x=>x.textContent.includes(arguments[1])&&x.offsetParent);if(!e)return false;e.click();return true`, css, text), `${css} ${text}`);
  const shot = async (name) => writeFileSync(join(out, name), Buffer.from(await wd("GET", "/session/:sid/screenshot"), "base64"));
  /** Type into a composer and press Enter. */
  const send = (css, text) =>
    js(
      `const t=document.querySelector(arguments[0]); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t, arguments[1]); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
      css,
      text,
    );
  /** Attach a PNG (base64) to the composer under `scope` through its file input. */
  const attach = async (scope, name, base64) => {
    await js(
      `const input=document.querySelector(arguments[0]+' .composer input[type=file]'); const bin=atob(arguments[2]); const bytes=new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
       const dt=new DataTransfer(); dt.items.add(new File([bytes], arguments[1], {type:'image/png'})); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));`,
      scope,
      name,
      base64,
    );
    await until(() => js(`return !!document.querySelector(arguments[0]+' .composer .attachment')`, scope), `${name} attached`);
  };
  /** Wait for an agent's steps, show them expanded, and wait until `text` is among them. */
  const showSteps = async (scope, text) => {
    await until(
      () =>
        js(
          `const b=document.querySelector(arguments[0]+' .activity-toggle'); if(!b) return false; if (b.getAttribute('aria-expanded')!=='true') b.click(); return document.querySelector(arguments[0]).textContent.includes(arguments[1])`,
          scope,
          text,
        ),
      `${scope}: ${text}`,
      60000,
    );
  };
  // The README's main shot: three conversations side by side, two agents working and one new.
  async function agentsShot() {
    // Tall enough that each conversation shows its attachment and every step without scrolling.
    await wd("POST", "/session/:sid/window/rect", { width: 1600, height: 1100 });
    // A phone-width capture of the Form reference app, as a user would paste it.
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    let phone;
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 });
      await page.goto(pathToFileURL(join(repo, "packages/core/skills/web-app/reference/form.html")).href);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 20000 }).catch(() => {});
      await sleep(500);
      phone = (await page.screenshot()).toString("base64");
    } finally {
      await browser.close();
    }
    // Start from an empty editor with the Agents view open and the agent panel hidden.
    await until(
      () =>
        js(`const tabs=[...document.querySelectorAll('.st-tab')]; if (tabs.length===1 && tabs[0].textContent.includes('Welcome')) return true;
            (tabs.find((t) => !t.textContent.includes('Welcome')) ?? tabs[0])?.querySelector('.st-tab-close')?.click(); return false;`),
      "tabs closed",
    );
    await js(`document.querySelector('.st-activity-btn[aria-label="Agents"]:not(.on)')?.click()`);
    await js(`document.querySelector('.st-agent button[aria-label="New conversation"]')?.click()`);
    await until(() => js(`return !!document.querySelector('.st-agent button[aria-label="New conversation in an editor tab"]')`), "panel ready");
    await js(`document.querySelector('.st-agent button[aria-label="New conversation in an editor tab"]').click()`);
    await until(() => js(`return !!document.querySelector('.st-chat-tab .st-new-chat textarea')`), "first conversation tab");
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',ctrlKey:true}))`);
    await until(() => js(`return !document.querySelector('.st-agent')`), "agent panel hidden");
    // Left: a phone layout bug, reported with a screenshot; the agent checks it in a headless browser.
    await attach(".st-chat-tab", "form-390.png", phone);
    await send(".st-chat-tab .st-new-chat textarea", "On phones the product grid in the Form app crops the last card (screenshot). Fix the grid and check it at 390px.");
    await showSteps(".st-editor:nth-child(1) .st-chat-tab", "update checklist");
    // Middle: a request about the app itself, with a capture of this window attached.
    const self = await wd("GET", "/session/:sid/screenshot");
    await js(`document.querySelector('.st-chat-tab button[aria-label="New conversation to the side"]').click()`);
    await until(() => js(`return document.querySelectorAll('.st-chat-tab').length===2 && !!document.querySelector('.st-editor:nth-child(2) .st-new-chat textarea')`), "second conversation tab");
    await js(`document.querySelector('.st-editor:nth-child(2) .st-target .pill').click()`);
    await clickText(".st-editor:nth-child(2) .st-target .st-menu button", "cdr-ui");
    await until(() => js(`return document.querySelector('.st-editor:nth-child(2) .st-target-name').textContent==='cdr-ui'`), "second checkout picked");
    await attach(".st-editor:nth-child(2) .st-chat-tab", "studio.png", self);
    await send(".st-editor:nth-child(2) .st-new-chat textarea", "Make the conversation header one row like in this screenshot, and keep the composer toolbar on a single line.");
    await showSteps(".st-editor:nth-child(2) .st-chat-tab", "update checklist");
    // Right: a new conversation, waiting for its first message.
    await js(`document.querySelector('.st-editor:nth-child(2) .st-chat-tab button[aria-label="New conversation to the side"]').click()`);
    await until(() => js(`return document.querySelectorAll('.st-editor').length===3 && !!document.querySelector('.st-editor:nth-child(3) .st-new-chat')`), "third column");
    await sleep(2500);
    // Follow the newest step in each conversation, as a user watching it would.
    await js(`document.querySelectorAll('.st-chat-tab .messages').forEach((m) => m.scrollTo(0, m.scrollHeight))`);
    await sleep(600);
    await shot("desktop-agents.png");
    console.log("✓ desktop-agents");
  }
  try {
    await until(() => fetch(`${base}/status`).then((r) => r.ok), "tauri-driver");
    sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } })).sessionId;
    await wd("POST", "/session/:sid/window/rect", { width: 1600, height: 1000 }).catch(() => {});
    await until(() => js(`return !!document.querySelector('.st-welcome')`), "welcome", 60000);
    await js(`localStorage.setItem('harness.settings.v1', JSON.stringify({...JSON.parse(localStorage.getItem('harness.settings.v1')||'{}'), theme:'dark', model:''}))`);
    await clickText(".st-welcome .st-link", "cdr");
    await until(() => js(`return document.querySelector('.st-titlebar').textContent.includes('main')`), "repo open");
    if (agentsOnly) return await agentsShot();
    for (const dir of ["packages", "core", "src"]) await clickText(".st-tree-row", dir);
    await clickText(".st-tree-row", "permissions.ts");
    await until(() => js(`return document.querySelector('.cm-content')?.textContent.includes('HARD_DENY')`), "editor");
    // Ask the agent about the open code.
    await until(() => js(`return !!document.querySelector('.st-new-chat textarea')`), "composer");
    await js(
      `const t=document.querySelector('.st-new-chat textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t, arguments[0]); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
      "How does the agent loop decide when to ask for permission?",
    );
    await until(() => js(`return document.querySelector('.st-agent-body').textContent.includes('approvals inbox')`), "agent answer", 30000);
    await sleep(800);
    await js(`document.querySelector('.st-agent-body .messages, .st-agent-body [class*=messages]')?.scrollTo?.(0, 0)`).catch(() => {});
    if (!gitOnly) await shot("desktop-editor.png");
    // A substantive change set fills the diff and demonstrates both sides of staging.
    g("restore", "packages/core/src/permissions.ts");
    prepareGitDemo(repo);
    await js(`document.querySelector('button[aria-label="New conversation"]').click()`);
    await until(() => js(`return !!document.querySelector('.st-new-chat textarea')`), "review composer");
    await js(
      `const t=document.querySelector('.st-new-chat textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t, arguments[0]); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
      "Review the permission mode summary changes before I commit.",
    );
    await until(() => js(`return document.querySelector('.st-agent-body').textContent.includes('Ready for your review')`), "change review", 30000);
    await js(`document.querySelector('.st-activity-btn[aria-label="Source control"]').click()`);
    await until(() => js(`return document.querySelector('.st-panel').textContent.includes('permission-summary.ts')`), "changes");
    await clickText(".st-change-main", "permission-summary.ts");
    await until(() => js(`return !!document.querySelector('.st-diff-table')`), "diff");
    await js(`document.querySelector('button.st-generate').click()`);
    await until(() => js(`return document.querySelector('.st-commit textarea').value.length > 10`), "generated message");
    await wd("POST", "/session/:sid/window/rect", { width: 1480, height: 860 });
    await js(`const messages = document.querySelector('.st-agent-body .messages'); const answer = [...document.querySelectorAll('.st-agent-body .msg.assistant')].at(-1); if (messages && answer) messages.scrollTop += answer.getBoundingClientRect().top - messages.getBoundingClientRect().top - 12;`);
    await sleep(800);
    await shot("desktop-git.png");
    if (gitOnly) { console.log("✓ desktop-git"); return; }
    await wd("POST", "/session/:sid/window/rect", { width: 1600, height: 1000 });
    await js(`document.querySelector('.st-panel-head button[aria-label="History"]').click()`);
    await until(() => js(`return document.querySelectorAll('.st-commit-row').length > 3`), "history");
    await js(`document.querySelectorAll('.st-commit-row')[0].click()`);
    await until(() => js(`return !!document.querySelector('.st-commit-detail .st-commit-files button')`), "commit detail");
    await sleep(600);
    await shot("desktop-history.png");
    console.log("✓ desktop");
    await agentsShot();
  } catch (e) {
    if (sid) writeFileSync(join(tmp, "desktop-failure.png"), Buffer.from(await wd("GET", "/session/:sid/screenshot"), "base64"));
    throw e;
  } finally {
    if (sid) await wd("DELETE", "/session/:sid").catch(() => {});
    driver.kill();
  }
}

let failed = false;
const targets = [
  ["web", web],
  ["terminal", () => terminal()],
  ["terminal-classic", () => terminal({ design: "classic", name: "terminal-classic" })],
  ["terminal-approval", () => terminal({ mode: "ask", name: "terminal-approval" })],
  ["desktop", desktop],
];
for (const [name, fn] of targets) {
  if (!want(name) && !(name === "desktop" && (only.has("desktop-git") || only.has("desktop-agents")))) continue;
  try {
    await fn();
  } catch (e) {
    failed = true;
    console.error(`✗ ${name}: ${e.message}`);
  }
}
if (!failed) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
else console.error(`kept ${tmp}`);
process.exit(failed ? 1 : 0);
