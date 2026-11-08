// Captures the CDR Studio screenshots in Chrome: the real desktop UI and a real harness server with the
// scripted demo model. Only the Rust side is replaced, by the stand-in below that answers its commands from
// real files and git (the same approach as apps/desktop/e2e/shell.e2e.mjs), so this runs on every platform.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDemoHarness } from "./demo-model.mjs";
import { prepareGitDemo } from "./git-demo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixture projects
/** A copy of the tracked files with a short made-up history, so the screenshots show no real commits or branches. */
function prepareRepo(root, repo) {
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
    execFileSync("git", ["commit", "-qm", message], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  });
  // A small uncommitted change so the project has something to show.
  const policy = join(repo, "packages/core/src/permissions.ts");
  writeFileSync(
    policy,
    readFileSync(policy, "utf8").replace(
      "export class PermissionPolicy",
      "/** Decides whether a tool call runs, asks, or is refused. */\nexport class PermissionPolicy",
    ),
  );
  return g;
}

// ------------------------------------------------------------------ the Rust side
const SEP = "\x1f";
const KINDS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", "?": "untracked", " ": "unmodified" };
/** Git output, even for commands that exit non-zero on success (`git diff --no-index`). */
const git = (root, ...a) => spawnSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
const isRepo = (root) => git(root, "rev-parse", "--is-inside-work-tree").trim() === "true";

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
    head: git(root, "rev-parse", "--short", "HEAD").trim(),
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

function parseDiff(text, path) {
  const hunks = [];
  let hunk;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("Binary files")) return { path, binary: true, hunks: [] };
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      oldNo = Number(head[1]);
      newNo = Number(head[3]);
      hunk = { header: line, oldStart: oldNo, oldLines: Number(head[2] ?? 1), newStart: newNo, newLines: Number(head[4] ?? 1), lines: [] };
      hunks.push(hunk);
    } else if (hunk && line.startsWith("+")) hunk.lines.push({ kind: "add", newNo: newNo++, text: line.slice(1) });
    else if (hunk && line.startsWith("-")) hunk.lines.push({ kind: "del", oldNo: oldNo++, text: line.slice(1) });
    else if (hunk && line.startsWith(" ")) hunk.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  return { path, binary: false, hunks };
}

function gitDiffFile(root, path, staged) {
  const tracked = git(root, "ls-files", "--error-unmatch", "--", path).trim() !== "";
  const text = tracked
    ? git(root, "diff", ...(staged ? ["--cached"] : []), "--", path)
    : git(root, "diff", "--no-index", "--", "/dev/null", path);
  return parseDiff(text, path);
}

const LOG_FORMAT = ["%H", "%h", "%P", "%an", "%ae", "%at", "%ct", "%s", "%b", "%D"].join("%x1f") + "%x1e";
function parseCommit(record) {
  const [id, shortId, parents, authorName, authorEmail, authorTime, committerTime, subject, body, decoration] = record.trim().split(SEP);
  const refs = (decoration ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r && r !== "HEAD")
    .map((r) => ({ name: r.replace(/^HEAD -> /, ""), kind: "localBranch" }));
  return {
    id,
    shortId,
    parents: parents ? parents.split(" ") : [],
    authorName,
    authorEmail,
    authorTime: Number(authorTime),
    committerTime: Number(committerTime),
    subject,
    body: body ?? "",
    refs,
  };
}
function gitLog(root, o = {}) {
  const args = ["log", `--format=${LOG_FORMAT}`, `--skip=${o.skip ?? 0}`, `-n${o.limit ?? 200}`, o.rev ?? "--all"];
  if (o.path) args.push("--", o.path);
  const commits = git(root, ...args).split("\x1e").filter((r) => r.trim()).map(parseCommit);
  // The made-up history is one straight line.
  const graph = commits.map((_, i) => ({
    lane: 0,
    lanesIn: i === 0 ? [] : [0],
    edges: i === commits.length - 1 ? [] : [{ fromLane: 0, toLane: 0, kind: "firstParent" }],
    width: 1,
  }));
  return { commits, graph };
}
function gitShow(root, id) {
  const commit = parseCommit(git(root, "log", "-1", `--format=${LOG_FORMAT}`, id));
  const kinds = new Map(
    git(root, "show", "--format=", "--name-status", id)
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [k, p] = l.split("\t");
        return [p, KINDS[k[0]] ?? "modified"];
      }),
  );
  const files = git(root, "show", "--format=", "--numstat", id)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, path] = l.split("\t");
      return { path, kind: kinds.get(path) ?? "modified", additions: Number(a) || 0, deletions: Number(d) || 0 };
    });
  return { commit, files };
}
function gitBranches(root) {
  return git(root, "branch", "--format=%(refname:short)%1f%(HEAD)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(contents:subject)")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, head, shortId, time, lastSubject] = l.split(SEP);
      return { name, isRemote: false, isHead: head === "*", lastCommitTime: Number(time), lastSubject, shortId };
    });
}

const LISTS = /^(lsp_diagnostics|lsp_available|git_stashes|git_remotes|git_worktrees|provider_keys_list|github_pulls|harness_logs)$/;
function standIn(serverInfo, recent, home) {
  return (cmd, a = {}) => {
    switch (cmd) {
      case "harness_status":
        return { state: "ready", url: serverInfo.url, token: serverInfo.token, restarts: 0 };
      case "app_info":
        return { version: "0", home, configDir: home, defaultCloneDir: home, platform: "linux", githubClientId: false };
      case "workspace_open":
        return { root: a.path, name: basename(a.path) };
      case "workspace_recent":
        return recent;
      case "git_is_repo":
        return isRepo(a.root);
      case "git_status":
        return gitStatus(a.root);
      case "git_summary":
        return gitSummary(a.path);
      case "git_branches":
        return gitBranches(a.root);
      case "git_diff_file":
        return gitDiffFile(a.root, a.path, a.staged);
      case "git_diff_text":
        return git(a.root, "diff", ...(a.staged ? ["--cached"] : []));
      case "git_log":
        return gitLog(a.root, a.options);
      case "git_show":
        return gitShow(a.root, a.id);
      case "git_commit_file_diff":
        return parseDiff(git(a.root, "show", "--format=", a.id, "--", a.path), a.path);
      case "fs_list_files":
        return git(a.root, "ls-files").split("\n").filter(Boolean);
      case "fs_list_dir":
        return readdirSync(join(a.root, a.path ?? ""))
          .filter((n) => n !== ".git")
          .map((name) => ({
            name,
            path: a.path ? `${a.path}/${name}` : name,
            isDir: statSync(join(a.root, a.path ?? "", name)).isDirectory(),
            ignored: false,
          }));
      case "fs_read": {
        const content = readFileSync(join(a.root, a.path), "utf8");
        return { path: a.path, content, binary: false, size: content.length, tooLarge: false, mtime: 1 };
      }
      default:
        return LISTS.test(cmd) ? [] : null;
    }
  };
}

function installTauri() {
  let nextCallback = 1;
  const callbacks = new Map();
  window.Notification = function () {};
  window.Notification.permission = "granted";
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
      if (cmd.startsWith("plugin:")) return null;
      return window.__studioCommand(cmd, args ?? {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}

// ------------------------------------------------------------------ capture
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };

export async function captureDesktop({ root, out, tmp, chromium, chrome, scale }) {
  const dist = join(root, "apps/desktop/dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("Build the UI first: pnpm --filter desktop build");
  const { startServer } = await import(join(root, "packages/server/dist/index.js"));

  const projects = join(realpathSync(tmp), "projects");
  const repo = join(projects, "cdr");
  const g = prepareRepo(root, repo);
  // A second checkout: two agents never edit the same folder at once.
  const uiRepo = join(projects, "cdr-ui");
  execFileSync("git", ["clone", "-q", "--local", repo, uiRepo]);
  const api_ = join(projects, "node-api");
  cpSync(join(root, "evals/fixtures/node-api"), api_, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: api_ });
  execFileSync("git", ["add", "-A"], { cwd: api_ });
  execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "-qm", "Initial API"], { cwd: api_ });

  const ui = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const file = join(dist, path === "/" ? "index.html" : path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((r) => ui.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${ui.address().port}`;
  const token = "demo";
  const server = await startServer({ harness: createDemoHarness({ sessionsDir: join(tmp, "desktop-sessions") }), port: 0, token, origins: [origin], allowedRoots: [realpathSync(tmp)] });
  const api = async (path, body) => {
    const res = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  /** A conversation the UI did not start: it shows up in the chat view's list. */
  const conversation = async (session, text) => {
    const info = await api("/sessions", { origin: "desktop", ...session });
    await api(`/sessions/${info.id}/messages`, { text, mode: "chat" });
    return info.id;
  };

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const errors = [];
  try {
    const now = Math.floor(Date.now() / 1000);
    const recent = [repo, uiRepo].map((path, i) => ({ path, name: basename(path), openedAt: now - 3600 * (i + 1), exists: true }));
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: scale });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
    const command = standIn({ url: server.url, token }, recent, projects);
    await page.exposeFunction("__studioCommand", (cmd, args) => command(cmd, args));
    await page.addInitScript(installTauri);
    await page.addInitScript(() => {
      const key = "harness.settings.v1";
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || "{}"), theme: "dark", model: "" }));
    });
    await page.goto(origin);
    await page.locator(".st-app").waitFor();

    const exact = (text) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    const shot = async (name) => {
      // The temporary folder says nothing about the app; show where a project would normally live.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll(".st-rail-path")) el.textContent = `\u200e${el.textContent.replace(/^.*\/projects\//, "~/projects/").replace(/\/$/, "")}\u200e`; // the field is right-to-left
      });
      await page.mouse.move(0, 0);
      await sleep(600);
      await page.screenshot({ path: join(out, name) });
      console.log(`✓ ${name}`);
    };
    const toggle = (name) => page.locator(".st-view-toggle button", { hasText: name }).click();
    const send = async (scope, text) => {
      const box = page.locator(`${scope} .st-new-chat textarea`);
      await box.fill(text);
      await box.press("Enter");
    };
    const showSteps = async (scope, text) => {
      const toggleSteps = page.locator(`${scope} .activity-toggle`).first();
      await toggleSteps.waitFor({ timeout: 60000 });
      if ((await toggleSteps.getAttribute("aria-expanded")) !== "true") await toggleSteps.click();
      await page.locator(scope, { hasText: text }).first().waitFor({ timeout: 60000 });
    };

    // ---- Code view: editor with a question about the open file
    await toggle("Code");
    await page.locator(".st-recent .st-link").first().click();
    await page.locator(".st-titlebar", { hasText: "main" }).waitFor();
    await page.locator(".st-tree-row", { hasText: exact("packages") }).click();
    await page.locator(".st-tree-row", { hasText: exact("core") }).click();
    await page.locator(".st-tree-row", { hasText: exact("src") }).click();
    await page.locator(".st-tree-row", { hasText: /^\s*permissions\.ts/ }).click();
    await page.locator(".cm-content", { hasText: "HARD_DENY" }).waitFor();
    await send(".st-agent", "How does the agent loop decide when to ask for permission?");
    await page.locator(".st-agent-body", { hasText: "approvals inbox" }).waitFor({ timeout: 30000 });
    await sleep(800);
    await page.evaluate(() => document.querySelector(".st-agent-body .messages")?.scrollTo(0, 0));
    await shot("desktop-editor.png");

    // ---- Source control: a substantive change set, with the agent's review beside it
    g("restore", "packages/core/src/permissions.ts");
    prepareGitDemo(repo);
    await page.locator('.st-agent button[aria-label="New conversation"]').click();
    await page.locator(".st-agent .st-new-chat textarea").waitFor();
    await send(".st-agent", "Review the permission mode summary changes before I commit.");
    await page.locator(".st-agent-body", { hasText: "Ready for your review" }).waitFor({ timeout: 30000 });
    await page.locator('.st-activity-btn[aria-label="Source control"]').click();
    await page.locator(".st-panel", { hasText: "permission-summary.ts" }).first().waitFor();
    await page.locator(".st-change-main", { hasText: "permission-summary.ts" }).first().click();
    await page.locator(".st-diff-table").first().waitFor();
    await page.locator("button.st-generate").click();
    await page.waitForFunction(() => document.querySelector(".st-commit textarea")?.value.length > 10);
    await page.setViewportSize({ width: 1480, height: 860 });
    await sleep(300);
    await page.evaluate(() => {
      const messages = document.querySelector(".st-agent-body .messages");
      const answer = [...document.querySelectorAll(".st-agent-body .msg.assistant")].at(-1);
      if (messages && answer) messages.scrollTop += answer.getBoundingClientRect().top - messages.getBoundingClientRect().top - 12;
    });
    await shot("desktop-git.png");

    // ---- History
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator('.st-panel-head button[aria-label="History"]').click();
    await page.locator(".st-commit-row").nth(3).waitFor();
    await page.locator(".st-commit-row").first().click();
    await page.locator(".st-commit-detail .st-commit-files button").first().waitFor();
    await page.locator(".st-commit-detail .st-commit-files button").first().click();
    await sleep(400);
    await shot("desktop-history.png");

    // ---- Conversations side by side in editor tabs: two agents working, one new
    await page.setViewportSize({ width: 1600, height: 1100 });
    const phonePage = await browser.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 });
    await phonePage.goto(pathToFileURL(join(root, "packages/core/skills/web-app/reference/form.html")).href);
    await phonePage.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 20000 }).catch(() => {});
    await sleep(500);
    const phone = await phonePage.screenshot();
    await phonePage.close();
    // Closing the last tab brings Welcome back, so that one stays.
    const closable = page.locator(".st-tab", { hasNotText: "Welcome" }).locator(".st-tab-close");
    while (await closable.count()) {
      await closable.first().click();
      await sleep(100);
    }
    await page.locator('.st-activity-btn[aria-label="Explorer"]').click();
    await page.locator('.st-agent button[aria-label="New conversation"]').click();
    await page.locator('.st-agent button[aria-label="New conversation in an editor tab"]').click();
    await page.locator(".st-chat-tab .st-new-chat textarea").waitFor();
    await page.keyboard.press("Control+l");
    await page.locator(".st-agent").waitFor({ state: "hidden" }).catch(() => {});
    const attach = async (scope, name, buffer) => {
      await page.locator(`${scope} .composer input[type=file]`).setInputFiles({ name, mimeType: "image/png", buffer });
      await page.locator(`${scope} .composer .attachment`).first().waitFor();
    };
    await attach(".st-chat-tab", "form-390.png", phone);
    await send(".st-chat-tab", "On phones the product grid in the Form app crops the last card (screenshot). Fix the grid and check it at 390px.");
    await showSteps(".st-editor:nth-child(1) .st-chat-tab", "update checklist");
    const self = await page.screenshot();
    await page.locator('.st-chat-tab button[aria-label="New conversation to the side"]').first().click();
    const second = ".st-editor:nth-child(2) .st-chat-tab";
    await page.locator(`${second} .st-new-chat textarea`).waitFor();
    await page.locator(`${second} .st-target .pill`).click();
    await page.locator(`${second} .st-target .st-menu button`, { hasText: "cdr-ui" }).click();
    await page.locator(`${second} .st-target-name`, { hasText: "cdr-ui" }).waitFor();
    await attach(second, "studio.png", self);
    await send(second, "Make the conversation header one row like in this screenshot, and keep the composer toolbar on a single line.");
    await showSteps(second, "update checklist");
    await page.locator(`${second} button[aria-label="New conversation to the side"]`).click();
    await page.locator(".st-editor:nth-child(3) .st-new-chat").waitFor();
    await sleep(2500);
    await page.evaluate(() => document.querySelectorAll(".st-chat-tab .messages").forEach((m) => m.scrollTo(0, m.scrollHeight)));
    await shot("desktop-agents.png");

    // ---- Chat view, where the app opens: everything that runs, waits, or is done
    await conversation({ projectPath: api_, title: "Add a GET /version endpoint with a test", permissionMode: "ask" }, "Add a GET /version endpoint that returns the package version, with a test");
    await conversation({ sandbox: { name: "form" }, title: "Build Form, a responsive accessories store", permissionMode: "yolo" }, "Build Form, a responsive accessories store with a clean product grid, product details, and a working bag.");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await toggle("Chat");
    await page.locator(".st-body.mode-chat .st-conversations").waitFor();
    await page.locator('.st-conversations section[aria-label="Today"]').waitFor({ timeout: 30000 });
    await page.locator(".st-conv", { hasText: "On phones" }).locator(".st-conv-main").click();
    await page.locator(".st-agent-body:visible", { hasText: "update checklist" }).first().waitFor({ timeout: 30000 });
    await page.locator(".st-rail .st-rail-name", { hasText: "cdr" }).first().waitFor();
    await sleep(1500);
    await shot("desktop-chat.png");
    if (errors.length) throw new Error(`Errors on the page:\n${errors.join("\n")}`);
    console.log("✓ desktop");
  } catch (e) {
    const [page] = browser.contexts().flatMap((c) => c.pages());
    await page?.screenshot({ path: join(tmp, "desktop-failure.png") }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
    await Promise.race([server.close(), sleep(3000)]);
    ui.close();
  }
}
