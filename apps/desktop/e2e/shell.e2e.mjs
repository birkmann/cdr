// End-to-end test of the Studio layout in a browser: the real desktop UI and a real harness server with a
// scripted model. Only the Rust side is replaced, by the stand-in below that answers its commands from real
// files and git. It runs anywhere Chromium does (tauri-driver, used by studio.e2e.mjs, has no macOS support).
//
//   pnpm build && pnpm --filter desktop build && pnpm --filter desktop test:e2e:shell
import { chromium, webkit } from "playwright-core";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "studio-shell-home-"));
const { Harness, MockProvider } = await import("@harness/core");
const { startServer } = await import("@harness/server");

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Build the UI first: pnpm --filter desktop build");
const shots = process.env.E2E_SHOTS ?? join(tmpdir(), "studio-shell-e2e");
mkdirSync(shots, { recursive: true });

// ------------------------------------------------------------------ fixture
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "studio-shell-")));
function repo(name, branch) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  const run = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  run("init", "-q", "-b", branch);
  run("config", "user.name", "E2E");
  run("config", "user.email", "e2e@example.com");
  writeFileSync(join(dir, "README.md"), `# ${name}\n\nFirst line.\n`);
  writeFileSync(join(dir, "app.js"), "export const answer = 41;\nexport const second = 2;\n");
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "deep", "util.js"), "export const util = true;\n");
  run("add", "-A");
  run("commit", "-qm", "Initial commit");
  return dir;
}
const demo = repo("demo-repo", "main");
const other = repo("other-repo", "feature/rail");
const third = repo("third-repo", "main");
const plain = join(tmp, "plain-folder");
mkdirSync(plain);
writeFileSync(join(plain, "notes.txt"), "not a repository\n");
writeFileSync(join(demo, "app.js"), "export const answer = 42;\nexport const more = 1;\n");

// ------------------------------------------------------------------ scripted model
const gates = new Map();
const gate = (name) => {
  let open;
  const promise = new Promise((r) => (open = r));
  gates.set(name, { promise, open });
};
const release = (name) => gates.get(name)?.open();
gate("keep-working");
gate("helper");
gate("live-page");

const firstUser = (req) => req.messages.find((m) => m.role === "user")?.content ?? "";
const mock = new MockProvider({
  handler: (req) => {
    const last = req.messages.at(-1);
    const prompt = firstUser(req);
    if (/Explain the files/.test(prompt))
      return {
        text: "See `app.js:2`, [the readme](README.md), `util.js`, `missing/nothing.md` and `not a path`.",
      };
    if (/Needs permission/.test(prompt))
      return last.role === "user"
        ? { toolCalls: [{ name: "bash", args: { command: "touch allowed.txt" } }] }
        : { text: "Permission used." };
    if (/Publish a page/.test(prompt))
      return last.role === "user"
        ? {
            toolCalls: [
              { name: "write_file", args: { path: "index.html", content: "<h1>Page</h1>" } },
              { name: "set_preview", args: { path: "index.html", title: "Page" } },
            ],
          }
        : { text: "Published." };
    if (/Use a helper/.test(prompt) && !/HELPER/.test(prompt))
      return last.role === "user"
        ? {
            toolCalls: [
              { name: "spawn_agent", args: { task: "HELPER inspect the code", isolation: "shared" } },
            ],
          }
        : { text: "Helper finished." };
    return { text: "Done." };
  },
});
mock.capabilities = () => ({
  tools: true,
  json: true,
  contextWindow: 100000,
  reasoningEfforts: ["none", "high"],
});
const originalStream = mock.stream.bind(mock);
mock.stream = async function* (req) {
  const prompt = firstUser(req);
  if (/Keep working/.test(prompt)) await gates.get("keep-working").promise;
  if (/HELPER/.test(prompt)) await gates.get("helper").promise;
  if (/while watched/.test(prompt) && req.messages.at(-1).role === "user")
    await gates.get("live-page").promise;
  yield* originalStream(req);
};

const harness = new Harness({
  providers: { mock },
  skipGlobalConfig: true,
  loadEnv: false,
  configOverrides: {
    providers: { mock: { type: "mock" } },
    models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
    sandbox: "none",
  },
});

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
const ui = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
    .end(readFileSync(file));
});
await new Promise((r) => ui.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${ui.address().port}`;
const server = await startServer({
  harness,
  port: 0,
  token: "e2e-token",
  origins: [origin],
  allowedRoots: [tmp, tmpdir()],
});

// ------------------------------------------------------------------ the Rust side
const git = (root, ...a) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const isRepo = (root) => {
  try {
    return git(root, "rev-parse", "--is-inside-work-tree").trim() === "true";
  } catch {
    return false;
  }
};
const KINDS = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  "?": "untracked",
  " ": "unmodified",
};
function gitStatus(root) {
  const files = git(root, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({
      path: l.slice(3),
      index: l[0] === "?" ? "unmodified" : KINDS[l[0]],
      worktree: KINDS[l[1]],
      conflicted: false,
    }));
  return {
    branch: git(root, "branch", "--show-current").trim(),
    head: "abc1234",
    ahead: 0,
    behind: 0,
    detached: false,
    files,
    mergeInProgress: false,
    rebaseInProgress: false,
  };
}
function gitSummary(path) {
  if (!isRepo(path)) return { isRepo: false, status: null, added: 0, deleted: 0 };
  let added = 0;
  let deleted = 0;
  for (const l of git(path, "diff", "--numstat", "HEAD").split("\n").filter(Boolean)) {
    const [a, d] = l.split("\t");
    added += Number(a) || 0;
    deleted += Number(d) || 0;
  }
  return { isRepo: true, status: gitStatus(path), added, deleted };
}
const opened = [];
const readable = new Set();
const requireReadable = (root) => {
  if (!root || ![...readable].some((r) => root === r || root.startsWith(`${r}/`)))
    throw new Error(`Workspace is not open: ${root}`);
};
const ptyResizes = [];
let recent = [demo, other].map((path, i) => ({
  path,
  name: basename(path),
  openedAt: 1800000000 - i,
  exists: true,
}));
const LISTS =
  /^(lsp_diagnostics|git_stashes|git_remotes|git_worktrees|git_log|provider_keys_list|fs_list_files|github_pulls|harness_logs)$/;
function command(cmd, a = {}) {
  switch (cmd) {
    case "harness_status":
      return { state: "ready", url: server.url, token: "e2e-token", restarts: 0 };
    case "app_info":
      return {
        version: "0",
        home: tmp,
        configDir: tmp,
        defaultCloneDir: tmp,
        platform: "e2e",
        githubClientId: false,
      };
    case "workspace_open":
      opened.push(a.path);
      readable.add(a.path);
      return { root: a.path, name: basename(a.path) };
    case "workspace_allow":
      readable.add(a.path);
      return null;
    case "workspace_recent":
      return recent;
    case "git_is_repo":
      return isRepo(a.root);
    case "git_status":
      return gitStatus(a.root);
    case "git_summary":
      return gitSummary(a.path);
    case "git_branches":
      return git(a.root, "branch", "--format=%(refname:short)")
        .split("\n")
        .filter(Boolean)
        .map((name) => ({
          name,
          isRemote: false,
          isHead: false,
          lastCommitTime: 0,
          lastSubject: "",
          shortId: "abc1234",
        }));
    case "git_diff_file":
      return {
        path: a.path,
        binary: false,
        hunks: [
          {
            header: "@@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [{ kind: "add", newNo: 1, text: `changed ${a.path}` }],
          },
        ],
      };
    case "fs_list_files":
      requireReadable(a.root);
      return git(a.root, "ls-files").split("\n").filter(Boolean);
    case "fs_read_image":
      requireReadable(a.root);
      return "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    case "fs_list_dir":
      requireReadable(a.root);
      return readdirSync(join(a.root, a.path ?? ""))
        .filter((n) => n !== ".git")
        .map((name) => ({
          name,
          path: a.path ? `${a.path}/${name}` : name,
          isDir: statSync(join(a.root, a.path ?? "", name)).isDirectory(),
          ignored: false,
        }));
    case "fs_read": {
      requireReadable(a.root);
      const content = readFileSync(join(a.root, a.path), "utf8");
      return { path: a.path, content, binary: false, size: content.length, tooLarge: false, mtime: 1 };
    }
    case "fs_write":
      writeFileSync(join(a.root, a.path), a.content);
      return 2;
    case "pty_spawn":
      return 7;
    case "pty_resize":
      ptyResizes.push([a.cols, a.rows]);
      return null;
    case "lsp_available":
      return [];
    default:
      return LISTS.test(cmd) ? [] : null;
  }
}

function installTauri() {
  let nextCallback = 1;
  const callbacks = new Map();
  window.__notifications = [];
  // The notification plugin replaces this function the same way, and passes the options on to Rust.
  window.Notification = function (title, options) {
    window.__notifications.push({ ...options, title });
  };
  window.Notification.permission = "granted";
  window.__dialogResult = null;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) {
      const id = nextCallback++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      if (cmd === "plugin:notification|register_listener") {
        window.__notificationChannel = args.handler;
        return null;
      }
      if (cmd === "plugin:dialog|open") return window.__dialogResult;
      if (cmd.startsWith("plugin:")) return null;
      return window.__studioCommand(cmd, args ?? {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}

// ------------------------------------------------------------------ test helpers
const api = async (method, path, body) => {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: "Bearer e2e-token", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
};
async function conversation(projectPath, title, opts = {}) {
  const info = await api("POST", "/sessions", {
    projectPath,
    title,
    permissionMode: opts.permissionMode ?? "yolo",
    origin: "desktop",
  });
  await api("POST", `/sessions/${info.id}/messages`, {
    text: opts.text ?? "Say hello",
    mode: opts.workflow ? "task" : "chat",
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
  });
  return info.id;
}
const sessionStatus = async (id) => (await api("GET", `/sessions/${id}?events=false`)).info?.status;
const until = async (fn, what, timeout = 20000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
};

const exe =
  process.env.CHROME_PATH ?? ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync);
// E2E_BROWSER=webkit runs the engine of the macOS app.
const engine = process.env.E2E_BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch(
  engine === webkit ? { headless: true } : { executablePath: exe, headless: true },
);
const errors = [];
const steps = [];
let failed = false;

async function newPage(storage) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  await page.exposeFunction("__studioCommand", (cmd, args) => command(cmd, args));
  await page.addInitScript(installTauri);
  if (storage)
    await page.addInitScript((s) => {
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, storage);
  await page.goto(origin);
  await page.locator(".st-app").waitFor();
  return page;
}

async function step(name, fn) {
  const t = Date.now();
  await fn();
  steps.push(name);
  console.log(`✓ ${name} (${Date.now() - t} ms)`);
}

let page;
const list = (name) => page.locator(`.st-conversations section[aria-label="${name}"]`);
const row = (title) => page.locator(".st-conv", { hasText: title });
const rail = (name) => page.locator(`.st-rail section[aria-label="${name}"]`);
const pick = (title) => row(title).locator(".st-conv-main").click();
const mode = () => page.locator(".st-body").getAttribute("class");
const inMode = (m) => page.locator(`.st-body.mode-${m}`).waitFor();
const toggle = (name) => page.locator(".st-view-toggle button", { hasText: name }).click();
const visible = (css) => page.locator(css).first().isVisible();
const press = (keys) => page.keyboard.press(keys);
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });

try {
  page = await newPage();

  await step("the app starts in the chat view with three columns", async () => {
    await inMode("chat");
    await page.locator(".st-new-chat").waitFor();
    assert.equal(await visible(".st-conversations"), true);
    assert.equal(await visible(".st-rail"), true);
    assert.equal(await visible(".st-activity"), false, "no activity bar in the chat view");
    const [left, center, right] = await Promise.all(
      [".st-conversations", ".st-agent", ".st-rail"].map((c) => page.locator(c).boundingBox()),
    );
    assert.ok(left.x < center.x && center.x < right.x, "columns run left to right");
    assert.ok(
      center.width > left.width && center.width > right.width,
      "the conversation is the widest column",
    );
    assert.equal(
      await page.locator(".st-agent-head").count(),
      0,
      "no second conversation menu in the chat view",
    );
  });

  let hello, otherChat, sandbox;
  await step("every conversation is listed, with its project", async () => {
    hello = await conversation(demo, "Hello demo");
    otherChat = await conversation(other, "Other project chat");
    await until(async () => (await sessionStatus(otherChat)) !== "running", "conversations to finish");
    const created = await api("POST", "/sessions", {
      sandbox: { name: "box" },
      title: "Sandbox chat",
      permissionMode: "yolo",
    });
    sandbox = created.id;
    await row("Hello demo").waitFor();
    await row("Other project chat").waitFor();
    await row("Sandbox chat").waitFor();
    assert.match(await row("Hello demo").textContent(), /demo-repo/);
    assert.match(await row("Sandbox chat").textContent(), /sandbox/);
    assert.equal(await page.locator(".st-conv-group", { hasText: "Settled" }).count(), 1);
    await list("Today").waitFor();
  });

  await step("search and the project filter narrow the list", async () => {
    await page.fill(".st-conv-search", "other");
    await until(async () => (await page.locator(".st-conv").count()) === 1, "one match");
    await page.fill(".st-conv-search", "");
    await page.locator(".st-conv-filter .pill").click();
    await page.locator(".st-conv-filter button", { hasText: "other-repo" }).click();
    await until(async () => (await page.locator(".st-conv").count()) === 1, "one project");
    assert.match(await page.locator(".st-conv").textContent(), /Other project chat/);
    await page.locator(".st-conv-filter .pill").click();
    await page.locator(".st-conv-filter button", { hasText: "Sandboxes" }).click();
    await until(
      async () => (await page.locator(".st-conv").textContent()).includes("Sandbox chat"),
      "sandboxes",
    );
    await page.locator(".st-conv-filter .pill").click();
    await page.locator(".st-conv-filter button", { hasText: "All projects" }).click();
    await until(async () => (await page.locator(".st-conv").count()) === 3, "all projects");
  });

  await step("selecting a conversation shows it and its project", async () => {
    await pick("Hello demo");
    await page.locator(".st-agent-body", { hasText: "Done." }).waitFor();
    await rail("Project").locator(".st-rail-name", { hasText: "demo-repo" }).waitFor();
    await rail("Repository").locator(".st-add", { hasText: "+2" }).waitFor();
    assert.match(await rail("Repository").locator(".st-del").textContent(), /2/);
    await rail("Changes").locator(".st-rail-row", { hasText: "app.js" }).waitFor();
    assert.match(await page.locator(".st-titlebar").textContent(), /demo-repo/);
    assert.equal(await page.locator(".st-conv.on").count(), 1);
    await shot("chat-view");
  });

  await step("the header is a breadcrumb whose project narrows the list", async () => {
    const [folder, title] = await Promise.all([
      page.locator(".st-agent .chat-folder").boundingBox(),
      page.locator(".st-agent .chat-rename").boundingBox(),
    ]);
    assert.ok(folder.x < title.x, "project before title");
    assert.equal(await page.locator('.st-agent button[aria-label="New conversation"]').count(), 0);
    assert.equal(await page.locator('.st-agent [aria-label="Conversation history"]').count(), 0);
    await page.locator(".st-agent .chat-folder-open").click();
    await until(async () => (await page.locator(".st-conv").count()) === 1, "list narrowed to the project");
    await inMode("chat");
    await page.locator(".st-conv-filter .pill").click();
    await page.locator(".st-conv-filter button", { hasText: "All projects" }).click();
  });

  await step("a project that is not open is summarised without opening it", async () => {
    const before = opened.length;
    await pick("Other project chat");
    await rail("Project").locator(".st-rail-name", { hasText: "other-repo" }).waitFor();
    await rail("Repository").locator(".st-rail-branch-static", { hasText: "feature/rail" }).waitFor();
    assert.equal(opened.length, before, "the open folder stays");
    assert.match(
      await page.locator(".st-titlebar").textContent(),
      /other-repo/,
      "title bar follows the conversation",
    );
    await rail("Repository").getByText("No changes").waitFor();
  });

  await step("sandboxes are marked, and a plain folder has no repository", async () => {
    await pick("Sandbox chat");
    await rail("Project").locator(".st-sw-badge", { hasText: "sandbox" }).waitFor();
    await conversation(plain, "Plain folder chat");
    await pick("Plain folder chat");
    await rail("Project").locator(".st-rail-name", { hasText: "plain-folder" }).waitFor();
    await rail("Repository").getByText("not a Git repository").waitFor();
    await rail("Goals").getByText("need a repository").waitFor();
    assert.equal(await rail("Changes").count(), 0);
  });

  await step("a new conversation starts in the project just left, and can be pointed elsewhere", async () => {
    await pick("Other project chat");
    await rail("Project").locator(".st-rail-name", { hasText: "other-repo" }).waitFor();
    await page.locator(".st-conv-new").click();
    await page.locator(".st-new-chat").waitFor();
    await page.locator(".st-new-chat h2", { hasText: "other-repo" }).waitFor();
    await rail("Project").locator(".st-rail-name", { hasText: "other-repo" }).waitFor();
    await page.locator(".st-target .pill").click();
    await page.locator(".st-target button", { hasText: "New sandbox" }).click();
    await page.locator(".st-rail-empty", { hasText: "sandbox folder" }).waitFor();
    await page.locator(".st-target .pill").click();
    await page.locator(".st-target button", { hasText: "other-repo" }).click();
    await rail("Project").locator(".st-rail-name", { hasText: "other-repo" }).waitFor();
  });

  let working;
  await step("a running conversation is under Working and can be stopped", async () => {
    working = await conversation(other, "Keep working please", { text: "Keep working" });
    await list("Working").locator(".st-conv", { hasText: "Keep working please" }).waitFor();
    assert.match(await list("Working").locator(".st-conv-group").textContent(), /Working\s*1/);
    await list("Working").getByText("feature/rail").waitFor();
    await page.locator(".st-conv-group button", { hasText: "Stop all" }).waitFor();
    await pick("Keep working please");
    await rail("Agents").getByText("1 running").waitFor();
    await rail("Agents").locator(".st-rail-agent", { hasText: "Keep working please" }).waitFor();
    assert.match(
      await list("Working").locator(".st-conv-when").textContent(),
      /\d+s/,
      "elapsed time beside the stop button",
    );
    assert.equal(await list("Working").locator(".st-conv-when").isVisible(), true);
    await shot("chat-working");
    await row("Keep working please").locator('button[aria-label="Stop agent"]').click();
    release("keep-working");
    await until(async () => (await list("Working").count()) === 0, "the run to stop");
  });

  let asking;
  await step("a blocked conversation is under Waiting and answered from the list", async () => {
    await page.evaluate(() => (document.hasFocus = () => false));
    asking = await conversation(demo, "Needs permission now", {
      permissionMode: "ask",
      workflow: "quick-fix",
      text: "Needs permission to run",
    });
    const waiting = list("Waiting");
    await waiting.locator(".st-conv", { hasText: "Needs permission now" }).waitFor();
    await waiting.locator(".st-approval code", { hasText: "bash" }).waitFor();
    await waiting.locator(".st-approval-args", { hasText: "touch allowed.txt" }).waitFor();
    await page.locator(".st-pill.warn", { hasText: "1 waiting" }).waitFor();
    await shot("chat-waiting");
    const notified = await until(
      () => page.evaluate(() => window.__notifications[0]),
      "a system notification",
    );
    assert.match(notified.body, /Needs permission now/);

    await toggle("Code");
    await inMode("code");
    await page.evaluate(
      (id) =>
        window.__notificationChannel.onmessage({ actionId: "tap", inputValue: null, notification: { id } }),
      notified.id,
    );
    await inMode("chat");
    await page.locator(".st-agent .chat-title", { hasText: "Needs permission now" }).waitFor();

    await pick("Hello demo");
    await page.locator(".st-pill.warn").click();
    await page.locator(".st-agent .chat-title", { hasText: "Needs permission now" }).waitFor();

    await waiting.locator(".st-approval button", { hasText: "Allow" }).click();
    await until(
      async () => (await list("Waiting").count()) === 0,
      "the conversation to leave Waiting",
      30000,
    );
    assert.equal(await page.locator(".st-pill.warn").count(), 0);
    await until(() => existsSync(join(demo, "allowed.txt")), "the allowed command to run");
  });

  await step("subagents appear under their parent in the project column, not in the list", async () => {
    const parent = await conversation(demo, "Use a helper here", {
      workflow: "quick-fix",
      text: "Use a helper for this",
    });
    await list("Working").locator(".st-conv", { hasText: "Use a helper here" }).waitFor();
    await pick("Use a helper here");
    const helper = rail("Agents").locator(".st-rail-agent").nth(1);
    await helper.waitFor();
    assert.notEqual(
      await helper.evaluate((e) => e.style.paddingLeft),
      await rail("Agents")
        .locator(".st-rail-agent")
        .first()
        .evaluate((e) => e.style.paddingLeft),
      "indented",
    );
    assert.equal(await list("Working").locator(".st-conv").count(), 1, "the helper has no row of its own");
    await shot("chat-subagent");
    await helper.locator(".st-rail-agent-main").click();
    await until(
      async () => (await page.locator(".st-rail-agent.on").count()) === 1,
      "the helper to be shown",
    );
    assert.match(
      await page.locator(".st-conv.on").textContent(),
      /Use a helper here/,
      "its parent stays selected in the list",
    );
    release("helper");
    await until(async () => (await sessionStatus(parent)) !== "running", "the parent to finish", 30000);
    await until(async () => (await list("Working").count()) === 0, "the list to settle", 30000);
    await rail("Agents").locator(".st-rail-agent").nth(1).waitFor();
  });

  let terminal;
  await step("the code view opens the conversation's project, with the same conversation", async () => {
    await pick("Other project chat");
    await page.locator(".st-agent-body", { hasText: "Done." }).waitFor();
    await page.evaluate(() => {
      window.__agent = document.querySelector(".st-agent");
    });
    await toggle("Code");
    await inMode("code");
    await page.locator(".st-tree-row", { hasText: "README.md" }).waitFor();
    assert.equal(opened.at(-1), other);
    assert.equal(await visible(".st-activity"), true);
    assert.deepEqual(
      await page.locator(".st-activity-btn").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label"))),
      ["Explorer", "Search", "Source control", "Settings"],
    );
    assert.equal(await page.locator(".st-conversations, .st-rail").count(), 0);
    assert.equal(
      await page.evaluate(() => window.__agent === document.querySelector(".st-agent")),
      true,
      "the conversation did not remount",
    );
    await page.locator(".st-agent-body", { hasText: "Done." }).waitFor();
    assert.match(await page.locator(".st-titlebar").textContent(), /feature\/rail/);
    const [editor, chat] = await Promise.all(
      [".st-center", ".st-agent"].map((c) => page.locator(c).boundingBox()),
    );
    assert.ok(editor.x < chat.x, "chat is the column on the right");
    await shot("code-view");
  });

  await step("editors and terminals survive a trip to the chat view", async () => {
    await page.locator(".st-tree-row", { hasText: "app.js" }).click();
    await page.locator(".cm-content", { hasText: "answer" }).waitFor();
    await page.locator(".cm-content").click();
    await page.keyboard.type("// edit ");
    await page.locator(".st-tab.on .st-tab-close.dirty").waitFor();
    await shot("code-editor");
    await press("Control+j");
    terminal = page.locator(".xterm").first();
    await terminal.waitFor();
    await page.evaluate(() => {
      window.__term = document.querySelector(".xterm");
      window.__cm = document.querySelector(".cm-editor");
    });
    ptyResizes.length = 0;

    await press("Control+Shift+u");
    await inMode("chat");
    assert.equal(await visible(".st-center"), false);
    assert.equal(
      await page.evaluate(() => document.contains(window.__term) && document.contains(window.__cm)),
      true,
      "still mounted while hidden",
    );
    await page.waitForTimeout(400);
    assert.ok(
      ptyResizes.every(([c, r]) => c > 2 && r > 0),
      `no resize to nothing: ${JSON.stringify(ptyResizes)}`,
    );

    await press("Control+Shift+u");
    await inMode("code");
    assert.equal(
      await page.evaluate(
        () =>
          window.__term === document.querySelector(".xterm") &&
          window.__cm === document.querySelector(".cm-editor"),
      ),
      true,
      "the same terminal and editor",
    );
    await page.locator(".cm-content", { hasText: "edit" }).waitFor();
    await page.locator(".st-tab.on .st-tab-close.dirty").waitFor();
  });

  await step("Ctrl+click opens a conversation in an editor tab", async () => {
    await toggle("Chat");
    await inMode("chat");
    await row("Hello demo")
      .locator(".st-conv-main")
      .click({ modifiers: ["ControlOrMeta"] });
    await inMode("code");
    await page.locator(".st-tab.on", { hasText: "Hello demo" }).waitFor();
    await page.locator(".st-chat-tab", { hasText: "Done." }).waitFor();
    await page.locator(".st-tab.on .st-tab-close").click();
    await page.locator(".st-tab", { hasText: "app.js" }).click();
    await page.locator(".cm-content", { hasText: "edit" }).waitFor();
  });

  await step("modified files keep the project open and stay in reach", async () => {
    await toggle("Chat");
    await inMode("chat");
    await pick("Hello demo");
    const count = opened.length;
    await toggle("Code");
    await inMode("code");
    await page.locator(".st-toast", { hasText: "Save or close your modified files" }).waitFor();
    assert.equal(opened.length, count, "did not switch");
    await page.locator(".cm-content", { hasText: "edit" }).waitFor();
    await page.locator(".cm-content").click();
    await press("ControlOrMeta+s");
    await page.locator(".st-tab.on .st-tab-close.dirty").waitFor({ state: "detached" });
    assert.match(readFileSync(join(other, "app.js"), "utf8"), /edit/, "saved to disk");
  });

  await step("shortcuts: toggles, panels, list search, composer", async () => {
    await toggle("Chat");
    await inMode("chat");
    await press("Control+r");
    await until(
      () => page.evaluate(() => document.activeElement?.classList.contains("st-conv-search")),
      "list search focus",
    );
    await press("Control+l");
    await until(
      () =>
        page.evaluate(
          () =>
            document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest(".st-agent"),
        ),
      "composer focus",
    );
    await press("Control+i");
    await page.locator(".st-agent .st-new-chat").waitFor();
    const tabs = await page.locator(".st-tab").count();
    await press("Control+w");
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".st-tab").count(), tabs, "Ctrl+W does not close a hidden editor tab");
    await pick("Other project chat");
    await press("Control+Shift+g");
    await inMode("code");
    await page.locator('.st-activity-btn[aria-label="Source control"].on').waitFor();
    await toggle("Chat");
    await inMode("chat");
    await press("Control+Shift+a");
    await rail("Agents").waitFor();
    await rail("Agents").locator(".st-rail-title[aria-expanded=true]").waitFor();
  });

  await step("the palette offers the views and keeps the chat view's commands working", async () => {
    await press("Control+Shift+p");
    await page.locator(".st-palette input, .st-modal input").first().fill(">View: Code");
    await page.keyboard.press("Enter");
    await inMode("code");
    await toggle("Chat");
    await inMode("chat");
  });

  await step("rail links open the right thing in the code view", async () => {
    await pick("Hello demo");
    await rail("Changes").locator(".st-rail-row", { hasText: "app.js" }).waitFor();
    // The editor has no modified files any more, so this project can be opened.
    const dirty = await page.evaluate(() => document.querySelectorAll(".st-tab-close.dirty").length);
    assert.equal(dirty, 0, "app.js was saved");
    await rail("Changes").locator(".st-rail-row", { hasText: "app.js" }).click();
    await inMode("code");
    await page.locator(".st-tab.on", { hasText: "app.js" }).waitFor();
    await page.locator(".st-editor", { hasText: "changed app.js" }).waitFor();
    assert.equal(opened.at(-1), demo);
    await toggle("Chat");
    await inMode("chat");
    await rail("Repository").locator("button", { hasText: "Commit…" }).click();
    await inMode("code");
    await page.locator('.st-activity-btn[aria-label="Source control"].on').waitFor();
    await toggle("Chat");
    await inMode("chat");
  });

  await step("the open project's branch can be switched from the project column", async () => {
    await rail("Repository").locator(".st-branch-menu .pill").click();
    const menu = page.locator(".st-rail .st-branch-menu .popover");
    await menu.waitFor();
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, "the menu fits the window");
    await page.keyboard.press("Escape");
  });

  await step("goals are created and listed from the project column", async () => {
    await rail("Goals").locator('button[aria-label="New goal"]').click();
    await inMode("code");
    await page.locator(".st-goal-inner input").first().fill("Make the answer configurable");
    await page.locator(".st-list-input input").first().fill("pnpm test passes");
    await page.locator(".st-goal-inner button", { hasText: "Save draft" }).click();
    await page.locator(".st-tab.on", { hasText: "Goal" }).waitFor();
    await toggle("Chat");
    await inMode("chat");
    const goal = rail("Goals").locator(".st-rail-row", { hasText: "Make the answer configurable" });
    await goal.waitFor();
    assert.match(await goal.textContent(), /Draft/);
    await goal.click();
    await inMode("code");
    await page.locator(".st-goal-inner", { hasText: "Make the answer configurable" }).waitFor();
    await toggle("Chat");
    await inMode("chat");
  });

  await step("a published page opens beside the conversation, in the chat view", async () => {
    const before = opened.length;
    await conversation(demo, "Publish a page please", { workflow: "quick-fix", text: "Publish a page" });
    await row("Publish a page please").waitFor();
    await until(async () => !(await list("Working").count()), "the page to be published", 30000);
    await pick("Publish a page please");
    await page.locator(".st-agent .chat-title", { hasText: "Publish a page please" }).waitFor();
    const link = rail("Preview").locator(".st-rail-row", { hasText: "index.html" });
    await link.waitFor();
    await inMode("chat");
    assert.equal(await page.locator(".st-file-pane").count(), 0, "selecting it leaves the project column");

    await link.click();
    const frame = page.locator(".st-file-pane iframe.preview-frame");
    await frame.waitFor();
    await inMode("chat");
    assert.equal(opened.length, before, "the open folder stays");
    assert.equal(await page.locator(".st-rail").count(), 0, "the preview takes the project column's place");
    assert.equal(await visible(".st-conversations"), true);
    const [chat, pane] = await Promise.all(
      [".st-agent", ".st-file-pane"].map((c) => page.locator(c).boundingBox()),
    );
    assert.ok(chat.x < pane.x, "the preview is on the right");
    await page
      .frameLocator(".st-file-pane iframe.preview-frame")
      .locator("h1", { hasText: "Page" })
      .waitFor();
    await shot("chat-preview");

    await page.evaluate(() => (window.__frame = document.querySelector(".st-file-pane iframe")));
    await page.locator(".st-agent .preview-card").click();
    await inMode("chat");
    await page.locator(".st-file-pane .st-fp-tab.on", { hasText: "Preview" }).waitFor();
  });

  await step("the preview shares the pane with files and stays loaded behind them", async () => {
    await page.locator('button[aria-label="Toggle folder tree"]').click();
    await page.locator(".st-file-tree .st-tree-row", { hasText: "app.js" }).click();
    await page.locator(".st-file-pane .cm-content", { hasText: "answer" }).waitFor();
    assert.equal(await page.locator(".st-file-pane iframe").isVisible(), false);
    assert.equal(
      await page.evaluate(() => window.__frame === document.querySelector(".st-file-pane iframe")),
      true,
      "the page was not reloaded",
    );
    await page.locator(".st-file-pane .st-fp-tab-main", { hasText: "Preview" }).click();
    await page.locator(".st-file-pane iframe").waitFor();
    assert.equal(await page.locator(".st-file-tree").count(), 0, "the page gets the whole pane");
    await page.locator('.st-file-pane button[aria-label="Close app.js"]').click();
    assert.equal(await page.locator(".st-file-pane iframe").isVisible(), true);
  });

  await step("the preview belongs to its conversation and closes back to the project", async () => {
    await pick("Hello demo");
    await page.locator(".st-rail").waitFor();
    assert.equal(
      await page.locator(".st-file-pane").count(),
      0,
      "another conversation has its project column",
    );
    await pick("Publish a page please");
    await page.locator(".st-file-pane iframe").waitFor();
    await page.locator('button[aria-label="Close preview"]').click();
    await page.locator(".st-rail").waitFor();
    await inMode("chat");
  });

  await step("the code view is one explicit click from the preview", async () => {
    await page.locator(".st-agent .preview-card").click();
    await page.locator(".st-file-pane iframe").waitFor();
    await inMode("chat");
    await page.locator('button[aria-label="Open preview in Code view"]').click();
    await inMode("code");
    await page.locator(".st-tab.on", { hasText: "Preview" }).waitFor();
    await toggle("Chat");
    await inMode("chat");
    await page.locator('button[aria-label="Close preview"]').click();
    await page.locator(".st-rail").waitFor();
  });

  await step("a page the agent publishes while you watch opens beside it", async () => {
    await conversation(demo, "Publish live please", {
      workflow: "quick-fix",
      text: "Publish a page while watched",
    });
    await list("Working").locator(".st-conv", { hasText: "Publish live please" }).waitFor();
    await pick("Publish live please");
    await page.locator(".st-agent .chat-title", { hasText: "Publish live please" }).waitFor();
    assert.equal(await page.locator(".st-file-pane").count(), 0);
    release("live-page");
    await page.locator(".st-file-pane iframe.preview-frame").waitFor({ timeout: 30000 });
    await inMode("chat");
    await until(async () => !(await list("Working").count()), "the page to be published", 30000);
    await page.locator('button[aria-label="Close file pane"]').click();
    await page.locator(".st-rail").waitFor();
  });

  await step("a file linked in the conversation opens beside it, in the chat view", async () => {
    const before = opened.length;
    assert.equal(readable.has(third), false, "this project was never opened");
    await conversation(third, "Explain the files please", { text: "Explain the files" });
    await pick("Explain the files please");
    const links = page.locator(".st-agent-body .file-link");
    await links.filter({ hasText: "app.js:2" }).waitFor();
    assert.deepEqual(await links.evaluateAll((l) => l.map((x) => x.textContent)), [
      "app.js:2",
      "the readme",
      "util.js",
    ]);
    assert.deepEqual(
      await page.locator(".st-agent-body code.inline").evaluateAll((c) => c.map((x) => x.textContent)),
      ["missing/nothing.md", "not a path"],
    );

    await links.filter({ hasText: "app.js:2" }).click();
    await page.locator(".st-file-pane .cm-content", { hasText: "answer" }).waitFor();
    await inMode("chat");
    assert.equal(await page.locator(".st-rail").count(), 0, "the files take the project column's place");
    assert.equal(await visible(".st-conversations"), true);
    assert.equal(opened.length, before, "the open folder stays");
    await page.locator(".st-file-pane .cm-activeLine", { hasText: "second" }).waitFor();
    const [chat, pane] = await Promise.all(
      [".st-agent", ".st-file-pane"].map((c) => page.locator(c).boundingBox()),
    );
    assert.ok(chat.x < pane.x, "the file is on the right");
    assert.ok(Math.abs(chat.width - pane.width) < 12, `an even split: ${chat.width} / ${pane.width}`);
    await page.locator(".st-fp-crumbs", { hasText: "third-repo" }).waitFor();
    await shot("chat-files");
  });

  await step("the file pane is read-only and keeps up with changes on disk", async () => {
    const code = page.locator(".st-file-pane .cm-content");
    await code.click();
    await page.keyboard.type("typed into the viewer");
    assert.equal((await code.textContent()).includes("typed into the viewer"), false, "nothing can be typed");
    writeFileSync(
      join(third, "app.js"),
      "export const answer = 'changed on disk';\nexport const second = 2;\n",
    );
    await code.getByText("changed on disk").waitFor({ timeout: 8000 });
  });

  await step("the file pane has tabs, a rendered Markdown view and a folder tree", async () => {
    await page.locator(".st-agent-body .file-link", { hasText: "the readme" }).click();
    await page.locator('.st-fp-tab.on[title="README.md"]').waitFor();
    assert.equal(await page.locator(".st-fp-tab").count(), 2);
    await page.locator('button[aria-label="Toggle rendered Markdown"]').click();
    await page.locator(".st-file-pane .st-md-preview h1", { hasText: "third-repo" }).waitFor();
    await page.locator('button[aria-label="Toggle rendered Markdown"]').click();
    await page.locator(".st-file-pane .cm-content").waitFor();

    const tree = page.locator(".st-file-tree");
    await page.locator(".st-agent-body .file-link", { hasText: "util.js" }).click();
    await tree.locator(".st-tree-row.on", { hasText: "util.js" }).waitFor();
    await page.locator(".st-fp-crumbs strong", { hasText: "util.js" }).waitFor();
    assert.match(await page.locator(".st-fp-crumbs").textContent(), /src.*deep.*util\.js/);

    await tree.locator(".st-tree-row", { hasText: /^README\.md$/ }).click();
    await page.locator('.st-fp-tab.on[title="README.md"]').waitFor();
    assert.equal(await page.locator(".st-fp-tab").count(), 3, "no second tab for an open file");
    await tree.locator('input[aria-label="Search files"]').fill("utl");
    await until(async () => (await tree.locator(".st-tree-result").count()) === 1, "one search result");
    await tree.locator('input[aria-label="Search files"]').fill("");
    await page.locator('button[aria-label="Toggle folder tree"]').click();
    await tree.waitFor({ state: "detached" });
    await page.locator('button[aria-label="Toggle folder tree"]').click();
    await tree.waitFor();
  });

  await step("each project keeps its own files in the pane", async () => {
    await pick("Hello demo");
    await page.locator(".st-file-pane .st-empty", { hasText: "Click a file" }).waitFor();
    assert.equal(await page.locator(".st-fp-tab").count(), 0);
    await page.locator(".st-file-tree .st-tree-row", { hasText: "app.js" }).waitFor();
    await pick("Explain the files please");
    await until(async () => (await page.locator(".st-fp-tab").count()) === 3, "this project's tabs");
  });

  await step("the pane closes back to the project, and opens from it", async () => {
    await page.locator('button[aria-label="Close file pane"]').click();
    await page.locator(".st-rail").waitFor();
    await page.locator(".st-rail button", { hasText: "Browse files" }).click();
    await page.locator(".st-file-pane .st-fp-tab").first().waitFor();
    for (const name of ["app.js", "README.md"])
      await page.locator(`.st-file-pane button[aria-label="Close ${name}"]`).click();
    assert.equal(await visible(".st-file-pane"), true);
    await page.locator('.st-file-pane button[aria-label="Close util.js"]').click();
    await page.locator(".st-rail").waitFor();
  });

  await step("the file pane is usable in a narrow window", async () => {
    await page.locator(".st-agent-body .file-link", { hasText: "app.js:2" }).click();
    await page.setViewportSize({ width: 960, height: 700 });
    await page.waitForTimeout(150);
    assert.equal(await visible(".st-conversations"), false, "the list gives way");
    const [chat, pane] = await Promise.all(
      [".st-agent", ".st-file-pane"].map((c) => page.locator(c).boundingBox()),
    );
    assert.ok(chat.width >= 320 && pane.width >= 360, `${chat.width} / ${pane.width}`);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no horizontal scroll",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await step("a file goes from the pane to the editor, and links open tabs in the code view", async () => {
    await page.locator('button[aria-label="Open in Code view"]').click();
    await inMode("code");
    assert.equal(opened.at(-1), third);
    await page.locator(".st-tab.on", { hasText: "app.js" }).waitFor();
    await page.locator(".st-center .cm-content", { hasText: "changed on disk" }).waitFor();
    await page.locator(".st-agent-body .file-link", { hasText: "the readme" }).click();
    await page.locator(".st-tab.on", { hasText: "README.md" }).waitFor();
    assert.equal(await page.locator(".st-file-pane").count(), 0);
    await toggle("Chat");
    await inMode("chat");
    await page.locator('.st-file-pane button[aria-label="Close app.js"]').click();
    await page.locator(".st-rail").waitFor();
  });

  await step("sections collapse, the column hides, and both are remembered", async () => {
    await rail("Goals").locator(".st-rail-title").click();
    await rail("Goals").locator(".st-rail-title[aria-expanded=false]").waitFor();
    await page.locator('button[aria-label="Toggle project column"]').click();
    await page.locator(".st-rail").waitFor({ state: "detached" });
    await page.reload();
    await page.locator(".st-app").waitFor();
    await inMode("chat");
    assert.equal(await page.locator(".st-rail").count(), 0, "hidden after reload");
    await page.locator('button[aria-label="Toggle project column"]').click();
    await pick("Hello demo");
    await rail("Goals").locator(".st-rail-title[aria-expanded=false]").waitFor();
    await rail("Goals").locator(".st-rail-title").click();
  });

  await step("the layout holds in the light theme", async () => {
    await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
    await page.waitForTimeout(100);
    const [bg, fg] = await page
      .locator(".st-conv-title")
      .first()
      .evaluate((e) => {
        const c = getComputedStyle(e);
        return [getComputedStyle(document.querySelector(".st-conversations")).backgroundColor, c.color];
      });
    assert.notEqual(bg, fg, "the list is legible");
    await shot("chat-light");
    await page.evaluate(() => delete document.documentElement.dataset.theme);
  });

  await step("a narrow window gives way to the conversation", async () => {
    await page.setViewportSize({ width: 960, height: 700 });
    await page.waitForTimeout(150);
    assert.equal(await visible(".st-rail"), false);
    const box = await page.locator(".st-agent").boundingBox();
    assert.ok(box.width >= 320, `conversation width ${box.width}`);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no horizontal scroll",
    );
    await shot("chat-narrow");
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await step("the code view is remembered across a restart", async () => {
    await toggle("Code");
    await inMode("code");
    await page.reload();
    await page.locator(".st-app").waitFor();
    await inMode("code");
    await toggle("Chat");
    await inMode("chat");
  });

  await step("a conversation is deleted from the list", async () => {
    await row("Sandbox chat").hover();
    await row("Sandbox chat").locator('button[aria-label="Delete conversation"]').click();
    await page.locator(".st-dialog button", { hasText: "Delete" }).click();
    await page.locator(".st-dialog button", { hasText: "Keep folder" }).click();
    await row("Sandbox chat").waitFor({ state: "detached" });
    assert.throws(() => harness.getSession(sandbox), /not found/);
  });

  await step("a layout from before the chat view opens in the chat view", async () => {
    const old = await newPage({
      "cdr.studio.layout.v1": JSON.stringify({
        side: "agents",
        bottom: null,
        agentPanel: true,
        agentDock: "left",
      }),
    });
    await old.locator(".st-body.mode-chat").waitFor();
    assert.equal(await old.locator(".st-agent.dock-left").count(), 1);
    await old.locator(".st-view-toggle button", { hasText: "Code" }).click();
    await old.locator(".st-body.mode-code").waitFor();
    await old.locator('.st-activity-btn[aria-label="Explorer"].on').waitFor();
    const [agent, center] = await Promise.all(
      [".st-agent", ".st-center"].map((c) => old.locator(c).boundingBox()),
    );
    assert.ok(agent.x < center.x, "a chat docked left stays left in the code view");
    await old.context().close();
  });

  assert.deepEqual(errors, [], "no uncaught page errors");
} catch (e) {
  failed = true;
  console.error(`\n✗ after ${steps.length} steps: ${e.stack ?? e}`);
  if (errors.length) console.error("page errors:", errors);
  await page?.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  console.error(`screenshots: ${shots}`);
} finally {
  await browser.close();
  ui.close();
  await server.close();
}
console.log(failed ? "\nE2E FAILED" : `\nE2E passed: ${steps.length} steps (screenshots: ${shots})`);
process.exit(failed ? 1 : 0);
