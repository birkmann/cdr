// Browser end-to-end test: harness server serving the built web app + headless Chrome + scripted model.
// Run: pnpm --filter web test:e2e   (after `pnpm build`)
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "e2e-home-"));
const { Harness, MockProvider } = await import("@harness/core");
const { startServer } = await import("@harness/server");

const here = dirname(fileURLToPath(import.meta.url));
const shots = process.env.E2E_SHOTS ?? join(tmpdir(), "harness-web-e2e");
mkdirSync(shots, { recursive: true });
const project = mkdtempSync(join(tmpdir(), "e2e-proj-"));
writeFileSync(join(project, "greet.txt"), "hello world\n");
writeFileSync(join(project, "README.md"), "# Demo project\n");
spawnSync("git", ["init", "-q"], { cwd: project });
spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "add", "-A"], { cwd: project });
spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-qm", "init"], { cwd: project });

let sawImage = false;
let recoveryAttempt = 0, recoveryPlans = 0;
const mock = new MockProvider({
  handler: (req) => {
    const sys = req.messages[0].content;
    const last = req.messages.at(-1);
    if (req.messages.some((m) => m.role === "user" && m.images?.length)) sawImage = true;
    const firstUser = req.messages.find((m) => m.role === "user")?.content ?? "";
    if (req.messages.some((m) => m.role === "user" && m.content.includes("Recover the timer job"))) {
      if (sys.startsWith("You are the PLANNER")) { recoveryPlans++; return { text: "# Timer plan\n## Steps\n1. Save initial progress\n2. Finish the timer" }; }
      if (sys.includes("code REVIEWER")) return { text: '{"summary":"ok","findings":[]}' };
      if (last.role === "user" && !last.content.includes("Continue the interrupted job")) return { toolCalls: [{ name: "write_file", args: { path: "progress.txt", content: "already completed" } }] };
      if (last.role === "tool" && recoveryAttempt++ === 0) throw new Error("Temporary connection failure");
      if (last.role === "user") return { toolCalls: [{ name: "write_file", args: { path: "finished.txt", content: "remaining work completed" } }] };
      return { text: "The timer job has been completed from saved progress." };
    }

    if (/snake/i.test(firstUser)) {
      if (last.role === "user")
        return {
          text: "Building it.",
          toolCalls: [
            { name: "write_file", args: { path: "index.html", content: '<!doctype html><body><h1 id="t">loading</h1><script src="game.js"></script></body>' } },
            { name: "write_file", args: { path: "game.js", content: "document.getElementById('t').textContent = 'SNAKE READY';" } },
            { name: "set_preview", args: { path: "index.html", title: "Snake" } },
          ],
        };
      return { text: "Your snake game is ready in the preview." };
    }
    if (sys.startsWith("You are the PLANNER")) return { text: "# Plan: greet\n## Steps\n1. change `world` to `harness` in greet.txt" };
    if (sys.includes("code REVIEWER")) return { text: '```json\n{"summary":"ok","findings":[{"severity":"nit","file":"greet.txt","issue":"could add punctuation"}]}\n```' };
    if (last.role === "user" && /explain/i.test(last.content)) return { text: "This project has a **README** and a greeting file.\n\n```js\nconsole.log('hi')\n```" };
    if (last.role === "user") return { text: "Patching.", toolCalls: [{ name: "patch_file", args: { path: "greet.txt", search: "world", replace: "harness" } }] };
    return { text: "Changed `greet.txt`." };
  },
});
mock.capabilities = () => ({ tools: true, json: true, contextWindow: 100000, reasoningEfforts: ["none", "low", "high", "max"] });
// Controlled reasoning stream: the browser decides when new thoughts and the answer arrive.
let nextThought, finishThought, nextPlan, finishPlan, nextCompact, finishCompact;
let compactRound = 0;
let compactReadyResolve;
const compactReady = new Promise((resolve) => { compactReadyResolve = resolve; });
const originalStream = mock.stream.bind(mock);
mock.stream = async function* (req) {
  if (req.messages.some((m) => m.role === "user" && m.content === "Follow compact updates")) {
    const round = compactRound++;
    if (round === 7) await new Promise((resolve) => { nextCompact = resolve; compactReadyResolve(); });
    if (round === 8) await new Promise((resolve) => { finishCompact = resolve; });
    yield { type: "text", text: `Compact update ${round}: checking the next file.` };
    if (round < 8) yield { type: "tool_call", call: { id: `compact-${round}`, name: "todo", arguments: JSON.stringify({ items: [{ text: `Step ${round}`, status: "done" }] }) } };
    yield { type: "done", finishReason: round < 8 ? "tool_calls" : "stop" };
    return;
  }
  if (req.messages[0].content.startsWith("You are the PLANNER") && req.messages.some((m) => m.role === "user" && m.content.includes("Read a long plan"))) {
    const next = new Promise((resolve) => { nextPlan = resolve; });
    const finish = new Promise((resolve) => { finishPlan = resolve; });
    yield { type: "text", text: "# A plan you can read from the beginning\n\nStart here: understand the requirements before implementation.\n\n## Steps\n\n" + Array.from({ length: 25 }, (_, i) => `${i + 1}. Inspect requirement ${i + 1}, document the behavior, and verify the result.\n\n`).join("") };
    await next;
    yield { type: "text", text: "\n## Verification\n\n" + "Check the behavior with a deterministic test and inspect the output.\n\n".repeat(20) };
    await finish;
    yield { type: "text", text: "\n## Risks\n\nRead the entire plan before approving.\n\n" + "Preserve existing user work while applying the changes.\n\n".repeat(15) };
    yield { type: "done", finishReason: "stop" };
    return;
  }
  if (req.messages.at(-1)?.content === "Explore thinking UI") {
    const next = new Promise((resolve) => { nextThought = resolve; });
    const finish = new Promise((resolve) => { finishThought = resolve; });
    yield { type: "reasoning", text: "## A considered approach\n\n" + Array.from({ length: 24 }, (_, i) => `Step ${i + 1}: inspect the workspace, compare options, and check the result.\n\n`).join("") + "```js\nconst ready = true;\n```\n" };
    await next;
    yield { type: "reasoning", text: "\nThe implementation is ready for verification.\n" };
    await finish;
    yield { type: "text", text: "The workspace is ready. Here is the verified result." };
    yield { type: "done", finishReason: "stop" };
    return;
  }
  yield* originalStream(req);
};
const harness = new Harness({
  providers: { mock },
  skipGlobalConfig: true,
  loadEnv: false,
  configOverrides: { providers: { mock: { type: "mock" } }, models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" } },
});
const server = await startServer({ harness, port: 0, token: "e2e-token", staticDir: join(here, "..", "dist"), allowedRoots: [tmpdir()] });

const exe = ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, headless: true });
let failed = false;
let terminalChild;
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  page.on("dialog", (d) => d.accept());

  // 1. login link
  await page.goto(`${server.url}/#token=e2e-token`);
  await page.getByRole("heading", { name: /Good|Working late/ }).waitFor();
  assert.equal(new URL(page.url()).hash, "", "token removed from the URL");
  await page.screenshot({ path: join(shots, "1-home.png") });

  // Sidebar width: pointer dragging, keyboard control, persistence, and collapse.
  const sidebarResize = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const sidebarBox = await sidebarResize.boundingBox();
  await page.mouse.move(sidebarBox.x + sidebarBox.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(sidebarBox.x + sidebarBox.width / 2 + 65, 300, { steps: 5 });
  await page.mouse.up();
  assert.equal(await sidebarResize.getAttribute("aria-valuenow"), "323");
  assert.equal(Math.round((await page.locator(".sidebar").boundingBox()).width), 323);
  await page.reload();
  await sidebarResize.waitFor();
  assert.equal(await sidebarResize.getAttribute("aria-valuenow"), "323", "sidebar width persists");
  await sidebarResize.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await sidebarResize.getAttribute("aria-valuenow"), "307");
  await page.keyboard.press("Control+b");
  assert.equal(await sidebarResize.count(), 0, "collapsed sidebar has no divider");
  await page.keyboard.press("Control+b");
  await sidebarResize.dblclick();
  assert.equal(await sidebarResize.getAttribute("aria-valuenow"), "258", "double click resets width");

  // CDR shell: explicit dark default, keyboard search, suggestions, themes, and navigation.
  assert.equal(await page.title(), "CDR — A place for your next idea");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.locator(".suggestions .chip").first().click();
  await page.waitForFunction(() => document.querySelector(".composer.large textarea")?.value.includes("snake"));
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Search and commands" }).waitFor();
  await page.getByRole("combobox").fill("settings");
  await page.getByRole("combobox").press("Enter");
  await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("radio", { name: /Paper light/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: /Graphite/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // Every palette is readable on all main surfaces and survives a reload.
  const palettes = { dark: "Graphite", light: "Paper light", midnight: "Midnight", forest: "Forest", contrast: "High contrast" };
  for (const [id, name] of Object.entries(palettes)) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: new RegExp(name) }).check();
    await page.waitForFunction((id) => document.documentElement.dataset.theme === id, id);
    const ratios = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const luminance = (hex) => {
        const rgb = hex.trim().slice(1).match(/../g).map((n) => parseInt(n, 16) / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const ratio = (fg, bg) => {
        const a = luminance(css.getPropertyValue(fg)), b = luminance(css.getPropertyValue(bg));
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      };
      return ["--text", "--text-2", "--muted", "--accent"].flatMap((fg) => ["--bg", "--bg-elev", "--sidebar", "--user-bubble"].map((bg) => ({ fg, bg, ratio: ratio(fg, bg) }))).concat([{ fg: "--hl-com", bg: "--code-bg", ratio: ratio("--hl-com", "--code-bg") }]);
    });
    for (const check of ratios) assert.ok(check.ratio >= 4.5, `${id} ${check.fg} on ${check.bg}: ${check.ratio.toFixed(2)}`);
    await page.screenshot({ path: join(shots, `theme-${id}.png`) });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), id);
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: /System/ }).check();
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.getByRole("radio", { name: /Graphite/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // Reloading above discards the earlier suggested draft.
  await page.locator(".composer.large textarea").fill("Create a snake game");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();

  // Effort choices come from provider capabilities and are sent when creating the thread.
  await page.getByTitle("Thinking effort", { exact: true }).click();
  assert.equal(await page.locator(".popover .option-title", { hasText: /^Medium$/ }).count(), 0);
  await page.locator(".popover .option", { hasText: "Most thinking" }).click();
  assert.match(await page.getByTitle("Thinking effort", { exact: true }).innerText(), /Max/);

  // 2. no project chosen → a sandbox is created; the agent builds a page and the preview shows it
  assert.match(await page.locator(".composer.large .pill", { hasText: "New sandbox" }).innerText(), /New sandbox/);
  await page.locator(".composer.large textarea").fill("Create a snake game");
  await page.locator(".composer.large textarea").press("Enter");
  await page.waitForURL(/\/c\//);
  await page.locator(".preview-card").waitFor({ timeout: 10000 });
  await page.locator(".chat-title .badge", { hasText: "sandbox" }).waitFor();
  const frame = page.frameLocator("iframe.preview-frame");
  await frame.locator("#t", { hasText: "SNAKE READY" }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator(".card.permission").count(), 0, "sandbox runs without permission prompts");
  assert.match(await page.locator(".history-sub").first().innerText(), /sandbox/);
  await page.screenshot({ path: join(shots, "1b-sandbox-preview.png") });

  // Same-path publications and shell builds refresh automatically, with an explicit pause option.
  const previewSession = harness.getSession(new URL(page.url()).pathname.split("/").pop());
  assert.equal(previewSession.config.reasoningEffort, "max");
  assert.equal(mock.calls.at(-1).reasoningEffort, "max");
  await page.getByTitle("Thinking effort", { exact: true }).click();
  await page.locator(".popover .option", { hasText: "Respond without extended thinking" }).click();
  await page.waitForFunction(() => document.querySelector('[title="Thinking effort"]')?.textContent.includes("Off"));
  assert.equal(previewSession.config.reasoningEffort, "none");
  await page.reload();
  await page.getByTitle("Thinking effort", { exact: true }).filter({ hasText: "Off" }).waitFor();
  await page.getByTitle("Thinking effort", { exact: true }).click();
  await page.locator(".popover .option", { hasText: "Use the provider’s default thinking behavior" }).click();
  await page.getByTitle("Thinking effort", { exact: true }).filter({ hasText: "Default" }).waitFor();
  await page.screenshot({ path: join(shots, "thinking-effort.png") });
  const previewText = page.frameLocator("iframe.preview-frame").locator("#t");
  writeFileSync(join(previewSession.projectRoot, "game.js"), "document.getElementById('t').textContent = 'BLUE SNAKE';");
  previewSession.emit({ type: "preview.ready", path: "index.html", title: "Snake" });
  await previewText.filter({ hasText: "BLUE SNAKE" }).waitFor();
  await page.getByText("Preview refreshed — showing the latest version.", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Auto-refresh" }).uncheck();
  writeFileSync(join(previewSession.projectRoot, "game.js"), "document.getElementById('t').textContent = 'PURPLE SNAKE';");
  previewSession.emit({ type: "preview.ready", path: "index.html", title: "Snake" });
  await page.getByText("A newer version is ready. Refresh to see the changes.", { exact: true }).waitFor();
  assert.equal(await previewText.innerText(), "BLUE SNAKE", "paused preview preserves the running app");
  await page.screenshot({ path: join(shots, "preview-update-available.png") });
  await page.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await previewText.filter({ hasText: "PURPLE SNAKE" }).waitFor();
  await page.getByRole("checkbox", { name: "Auto-refresh" }).check();
  previewSession.emit({ type: "status", status: "running" });
  writeFileSync(join(previewSession.projectRoot, "game.js"), "document.getElementById('t').textContent = 'SNAKE READY';");
  previewSession.emit({ type: "tool.call", id: "preview-shell-build", name: "bash", args: { command: "node build.js" } });
  previewSession.emit({ type: "tool.result", id: "preview-shell-build", name: "bash", ok: true, output: "Built" });
  await page.getByText("Changes in progress — preview will refresh when ready.", { exact: true }).waitFor();
  assert.equal(await previewText.innerText(), "PURPLE SNAKE", "waits for the build turn to finish");
  previewSession.emit({ type: "status", status: "idle" });
  await previewText.filter({ hasText: "SNAKE READY" }).waitFor();
  await page.getByText("Preview refreshed — showing the latest version.", { exact: true }).waitFor();

  // Resize the chat/details split across a live iframe, then restore after reload.
  const chatResize = page.getByRole("separator", { name: "Resize chat and details", exact: true });
  const originalChatWidth = Number(await chatResize.getAttribute("aria-valuenow"));
  const splitBox = await chatResize.boundingBox();
  await page.mouse.move(splitBox.x + splitBox.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(splitBox.x + splitBox.width / 2 + 110, 300, { steps: 8 });
  await page.mouse.up();
  const resizedChatWidth = Number(await chatResize.getAttribute("aria-valuenow"));
  assert.equal(resizedChatWidth, originalChatWidth + 110);
  assert.equal(Math.round((await page.locator(".chat").boundingBox()).width), resizedChatWidth);
  assert.equal(await page.locator(".column-resize-shield").count(), 0, "drag shield is removed");
  await page.reload();
  await chatResize.waitFor();
  assert.equal(Number(await chatResize.getAttribute("aria-valuenow")), resizedChatWidth);
  await chatResize.focus();
  await page.keyboard.press("End");
  assert.ok((await page.locator(".code-panel").boundingBox()).width >= 319, "details minimum width");
  await page.keyboard.press("Home");
  assert.equal(await chatResize.getAttribute("aria-valuenow"), "360", "chat minimum width");
  await page.keyboard.press("Enter");
  await page.screenshot({ path: join(shots, "resizable-columns.png") });
  await page.setViewportSize({ width: 700, height: 900 });
  assert.equal(await chatResize.isVisible(), false, "no column divider in stacked mobile layout");
  assert.equal(await sidebarResize.isVisible(), false, "no divider on the mobile drawer");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no mobile overflow");
  await page.setViewportSize({ width: 1440, height: 900 });
  await chatResize.waitFor();
  await page.waitForFunction((width) => Number(document.querySelector('.chat-resize')?.getAttribute('aria-valuenow')) === width, originalChatWidth);
  assert.equal(Number(await chatResize.getAttribute("aria-valuenow")), originalChatWidth);
  await page.getByRole("button", { name: "New chat" }).click();
  await page.locator(".composer.large").waitFor();

  // Creations come from real preview events and open the saved conversation.
  await page.getByRole("button", { name: "Creations", exact: true }).click();
  await page.locator(".creation-card", { hasText: "Snake" }).waitFor();
  await page.locator(".creation-card", { hasText: "Snake" }).click();
  await page.frameLocator("iframe.preview-frame").locator("#t", { hasText: "SNAKE READY" }).waitFor();
  await page.getByRole("button", { name: "New chat", exact: true }).click();

  // 3. pick the project via the folder browser
  await page.getByRole("button", { name: /New sandbox/ }).first().click();
  await page.getByRole("button", { name: /Browse folders/ }).click();
  await page.getByRole("dialog", { name: "Choose a project folder" }).waitFor();
  await page.locator(".dir", { hasText: project.split("/").pop() }).click();
  await page.locator(".crumbs code", { hasText: project }).waitFor();
  await page.getByRole("button", { name: /^Use / }).last().click();
  await page.getByRole("button", { name: new RegExp(project.split("/").pop()) }).waitFor();

  // 4. chat with a pasted image + a text file
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await page.locator('input[type="file"]').setInputFiles([
    { name: "shot.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# notes\nhello") },
  ]);
  await page.locator(".attachment").nth(1).waitFor();
  await page.locator(".composer.large textarea").fill("Explain the project");
  await page.locator(".composer.large textarea").press("Enter");
  await page.waitForURL(/\/c\//);
  await page.locator(".msg.assistant .md strong", { hasText: "README" }).waitFor({ timeout: 10000 });
  await page.locator(".codeblock .hljs").waitFor();
  assert.equal(await page.locator(".msg.user .msg-attachments img").count(), 1, "image thumbnail in history");
  assert.match(await page.locator(".msg.user .file-chip").innerText(), /notes\.md/);
  assert.ok(sawImage, "model received the image");
  const imgOk = await page.locator(".msg.user .msg-attachments img").evaluate((img) => img.complete && img.naturalWidth > 0);
  assert.ok(imgOk, "attachment image loads from /raw");
  assert.match(await page.locator(".history-title").first().innerText(), /Explain the project/);

  // 5. task mode in the same chat: plan approval + permission + diff
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: /Plan & build/ }).click();
  await page.locator(".chat-bottom textarea").fill("Change world to harness in greet.txt");
  await page.locator(".chat-bottom textarea").press("Enter");
  await page.getByRole("region", { name: "Plan approval" }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(shots, "2-plan.png") });
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("region", { name: "Permission request" }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(shots, "3-permission.png") });
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.status-pill')?.textContent?.trim() === 'done' || document.querySelector('.status-pill')?.textContent?.trim() === 'idle');
  await page.getByRole("button", { name: "Show all steps", exact: true }).last().click();
  await page.locator(".done-row.success").waitFor({ timeout: 15000 });
  assert.equal(readFileSync(join(project, "greet.txt"), "utf8"), "hello harness\n");
  assert.match(await page.locator(".card.review").innerText(), /could add punctuation/);

  // 6. code panel: changes (git diff) and file viewer
  await page.getByRole("button", { name: "Toggle code panel" }).click();
  await page.locator(".code-panel .diff-file-head", { hasText: "greet.txt" }).waitFor({ timeout: 10000 });
  assert.match(await page.locator(".code-panel .dl.add").first().innerText(), /hello harness/);
  await page.locator(".tool-head", { hasText: "greet.txt" }).click();
  await page.locator(".tool-body .dl.add").first().waitFor();
  await page.screenshot({ path: join(shots, "4-chat.png") });
  await page.locator(".code-panel .tabs button", { hasText: "Files" }).click();
  await page.locator(".tree-row", { hasText: "README.md" }).click();
  await page.locator(".viewer-code", { hasText: "Demo project" }).waitFor();

  // Model switches persist, and the project default can be restored.
  await page.getByTitle("Model: mock/m", { exact: true }).click();
  await page.getByPlaceholder("Filter or type provider/model…").fill("mock/alternate");
  await page.getByRole("button", { name: /Use “mock\/alternate”/ }).click();
  await page.getByTitle("Model: mock/alternate", { exact: true }).waitFor();
  await page.reload();
  await page.getByTitle("Model: mock/alternate", { exact: true }).waitFor();
  await page.getByTitle("Model: mock/alternate", { exact: true }).click();
  await page.getByRole("button", { name: /Project default/ }).click();
  await page.getByTitle("Model: mock/m", { exact: true }).waitFor();

  // 7. rename persists and search can reopen the conversation.
  await page.getByRole("button", { name: "Rename conversation" }).click();
  await page.getByRole("textbox", { name: "Conversation title" }).fill("Greeting workshop");
  await page.getByRole("textbox", { name: "Conversation title" }).press("Enter");
  await page.getByRole("heading", { name: "Greeting workshop", exact: true }).waitFor();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator(".library-card", { hasText: project.split("/").pop() }).click();
  assert.match(await page.locator(".composer .pill").first().innerText(), new RegExp(project.split("/").pop()));
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("Greeting workshop");
  await page.getByRole("option", { name: /Greeting workshop/ }).waitFor();
  await page.getByRole("combobox").press("Enter");
  await page.getByRole("heading", { name: "Greeting workshop", exact: true }).waitFor();
  // 8. new chat goes home; history keeps the chat; delete works
  await page.getByRole("button", { name: "New chat" }).click();
  await page.locator(".composer.large").waitFor();
  assert.equal(await page.locator(".history-item").count(), 2);
  await page.locator(".history-item").first().hover();
  await page.getByRole("button", { name: "Delete chat" }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".history-item").length === 1);

  await page.screenshot({ path: join(shots, "6-morrow-home.png") });

  // 9. mobile layout renders
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "5-mobile.png") });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "no horizontal scroll on mobile");

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Creations", exact: true }).click();
  await page.locator(".creation-card").first().click();
  await page.frameLocator("iframe.preview-frame").locator("#t", { hasText: "SNAKE READY" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(shots, "7-mobile-preview.png") });
  // Live thinking remains compact, formats Markdown, and respects manual scroll.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url);
  await page.locator(".composer.large textarea").fill("Explore thinking UI");
  await page.locator(".composer.large textarea").press("Enter");
  await page.getByRole("button", { name: "Show all steps", exact: true }).click();
  await page.locator(".thinking.is-thinking").waitFor();
  const toggle = page.locator(".thinking-toggle");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await page.screenshot({ path: join(shots, "thinking-live.png") });
  await toggle.click();
  await page.locator(".thinking-body .hljs").waitFor();
  const thoughtBody = page.locator(".thinking-body");
  assert.equal(await thoughtBody.evaluate((el) => el.scrollTop), 0, "thought details open at the beginning");
  await thoughtBody.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await page.locator(".thinking").getByRole("button", { name: /Jump to latest/ }).waitFor();
  nextThought();
  await page.locator(".thinking-body", { hasText: "ready for verification" }).waitFor();
  assert.equal(await thoughtBody.evaluate((el) => el.scrollTop), 0, "stream does not move manual scroll");
  await page.locator(".thinking").getByRole("button", { name: /Jump to latest/ }).click();
  await page.waitForFunction(() => { const el = document.querySelector(".thinking-body"); return el.scrollHeight - el.scrollTop - el.clientHeight < 32; });
  await page.screenshot({ path: join(shots, "thinking-expanded.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Toggle code panel" }).click();
  await page.waitForFunction(() => { const el = document.querySelector(".thinking-body"); return el.scrollHeight - el.scrollTop - el.clientHeight < 32; });
  await page.screenshot({ path: join(shots, "thinking-mobile.png") });
  finishThought();
  await page.getByText("The workspace is ready. Here is the verified result.", { exact: true }).waitFor();
  assert.equal(await page.locator(".thinking.is-thinking").count(), 0);
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "completion preserves user expansion");
  await toggle.click();
  assert.equal(await thoughtBody.isVisible(), false);
  // Intermediate work is one compact row by default; all steps remain inspectable.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url);
  await page.locator(".composer.large textarea").fill("Follow compact updates");
  await page.locator(".composer.large textarea").press("Enter");
  await compactReady;
  await page.getByRole("button", { name: "Show all steps", exact: true }).waitFor();
  assert.equal(await page.locator(".tool-group").count(), 0, "tools are collapsed by default");
  assert.equal(await page.locator(".msg.assistant").count(), 0, "intermediate narration is collapsed");
  assert.equal(await page.locator(".turn-activity.active .dots").count(), 1, "single animated activity indicator");
  await page.screenshot({ path: join(shots, "activity-collapsed.png") });
  assert.equal(await page.locator(".conversation-jumps").count(), 0, "no jump button while following short updates");
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.getByRole("button", { name: "Show all steps", exact: true }).click();
  await page.getByText("Compact update 6: checking the next file.", { exact: true }).waitFor();
  await page.locator(".messages").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.locator(".conversation-jumps").waitFor();
  const compactPosition = await page.locator(".messages").evaluate((el) => el.scrollTop);
  nextCompact();
  await page.getByText("Compact update 7: checking the next file.", { exact: true }).waitFor();
  assert.equal(await page.locator(".messages").evaluate((el) => el.scrollTop), compactPosition, "manual reading pauses short updates too");
  const readBox = await page.locator(".messages").boundingBox();
  const jumpsBox = await page.locator(".conversation-jumps").boundingBox();
  const composerBox = await page.locator(".chat-bottom").boundingBox();
  assert.ok(jumpsBox.y >= readBox.y + readBox.height - 1, "jump row sits outside the reading area");
  assert.ok(jumpsBox.y + jumpsBox.height <= composerBox.y + 1, "jump row stays above the composer");
  await page.screenshot({ path: join(shots, "reading-controls.png") });
  await page.getByRole("button", { name: "Hide all steps", exact: true }).click();
  finishCompact();
  await page.getByText("Compact update 8: checking the next file.", { exact: true }).waitFor();
  await page.waitForFunction(() => { const el = document.querySelector(".messages"); return el.scrollHeight - el.scrollTop - el.clientHeight < 2; });
  assert.equal(await page.locator(".conversation-jumps").count(), 0);

  // Long streaming plans preserve the reading position, including after an explicit jump.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: /Plan & build/ }).click();
  await page.locator(".composer.large textarea").fill("Read a long plan");
  await page.locator(".composer.large textarea").press("Enter");
  await page.getByRole("button", { name: "Show all steps", exact: true }).click();
  await page.getByRole("heading", { name: "A plan you can read from the beginning", exact: true }).waitFor();
  const conversation = page.getByRole("region", { name: "Conversation", exact: true });
  assert.equal(await conversation.evaluate((el) => el.scrollTop), 0, "first streamed block does not hide the start");
  await page.screenshot({ path: join(shots, "reading-plan-start.png") });
  await conversation.evaluate((el) => { el.scrollTop = 220; });
  const readingPosition = await conversation.evaluate((el) => el.scrollTop);
  nextPlan();
  await page.getByRole("heading", { name: "Verification", exact: true }).waitFor();
  assert.equal(await conversation.evaluate((el) => el.scrollTop), readingPosition, "streaming keeps the reader's place");
  await page.locator(".conversation-jumps").getByRole("button", { name: /Jump to latest/ }).click();
  const bottomPosition = await conversation.evaluate((el) => el.scrollTop);
  assert.ok(await conversation.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2));
  finishPlan();
  await page.getByRole("region", { name: "Plan approval" }).waitFor();
  assert.equal(await conversation.evaluate((el) => el.scrollTop), bottomPosition, "approval and later tokens do not restart automatic following");
  await page.getByRole("button", { name: /Review plan/ }).click();
  const planTop = await page.getByRole("region", { name: "Plan approval" }).evaluate((el) => {
    const viewport = document.querySelector(".messages").getBoundingClientRect();
    return el.getBoundingClientRect().top - viewport.top;
  });
  assert.ok(planTop >= 0 && planTop < 40, "review jumps to the plan heading, not the approval buttons");
  await page.screenshot({ path: join(shots, "reading-plan-review.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Toggle code panel" }).click();
  await conversation.evaluate((el) => { el.scrollTop = 0; });
  await page.screenshot({ path: join(shots, "reading-plan-mobile.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  // A failed workflow can continue from the recovery card after reloading the page.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: /Plan & build/ }).click();
  await page.locator(".composer.large textarea").fill("Recover the timer job");
  await page.locator(".composer.large textarea").press("Enter");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("button", { name: "Continue job", exact: true }).waitFor();
  const recoveryUrl = page.url();
  const recoveryId = new URL(recoveryUrl).pathname.split("/").pop();
  const recoverySession = harness.getSession(recoveryId);
  const originalProgress = readFileSync(join(recoverySession.projectRoot, "progress.txt"), "utf8");
  await page.reload();
  await page.getByRole("region", { name: "Job recovery" }).waitFor();
  await page.screenshot({ path: join(shots, "continue-failed-job.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.screenshot({ path: join(shots, "continue-failed-job-mobile.png") });
  await page.getByRole("button", { name: "Continue job", exact: true }).click();
  await page.getByText("The timer job has been completed from saved progress.", { exact: true }).waitFor();
  assert.equal(page.url(), recoveryUrl);
  assert.equal(recoveryPlans, 1, "approved plan was reused");
  assert.equal(readFileSync(join(recoverySession.projectRoot, "progress.txt"), "utf8"), originalProgress);
  assert.equal(readFileSync(join(recoverySession.projectRoot, "finished.txt"), "utf8"), "remaining work completed");
  assert.equal(await page.getByRole("region", { name: "Job recovery" }).count(), 0);
  // History hydrates atomically, then live SSE starts at its watermark.
  const historySession = harness.createSession({ sandbox: { name: "snapshot" }, title: "Snapshot loading test" });
  for (let i = 0; i < 40; i++) {
    historySession.emit({ type: "message.start", id: `history-${i}`, role: "assistant" });
    for (let j = 0; j < 20; j++) historySession.emit({ type: "message.delta", id: `history-${i}`, text: `Part ${j}. ` });
    historySession.emit({ type: "message.end", id: `history-${i}`, text: `Saved response ${i}. ` + "Readable completed content. ".repeat(8) });
    historySession.emit({ type: "usage", inputTokens: 1000, outputTokens: 100 });
  }
  const watermark = historySession.events.at(-1).seq;
  const eventCursors = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/sessions/${historySession.id}/events`) eventCursors.push(Number(url.searchParams.get("after")));
  });
  await page.addInitScript(() => {
    window.tokenPaints = [];
    new MutationObserver(() => {
      const value = document.querySelector(".tokens")?.textContent?.trim();
      if (value && window.tokenPaints.at(-1) !== value) window.tokenPaints.push(value);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server.url}/c/${historySession.id}`);
  await page.getByText(/Saved response 39\./).waitFor();
  assert.deepEqual(await page.evaluate(() => window.tokenPaints), ["40k / 4000"], "cold history never counts tokens up from zero");
  assert.equal(eventCursors.at(-1), watermark, "SSE skips saved history");
  await page.getByRole("button", { name: "Show all steps", exact: true }).click();
  await page.locator(".messages").evaluate((el) => { el.scrollTop = 320; el.dispatchEvent(new Event("scroll")); });
  await page.getByRole("button", { name: "Toggle code panel" }).click();
  await page.locator(".code-panel .tabs button", { hasText: "Tasks" }).click();
  let releaseSnapshot;
  const gateSnapshot = new Promise(resolve => { releaseSnapshot = resolve; });
  await page.route(`**/sessions/${historySession.id}?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("internal") === "false") await gateSnapshot;
    await route.continue();
  });
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.locator(".history-item", { hasText: "Snapshot loading test" }).click();
  await page.getByText(/Saved response 39\./).waitFor({ timeout: 3000 });
  assert.equal(await page.locator(".tokens").innerText(), "40k / 4000", "cached thread renders while refresh is blocked");
  assert.equal(await page.locator(".messages").evaluate(el => el.scrollTop), 320, "thread switch restores reading position");
  assert.equal(await page.locator(".code-panel .tabs button.active").innerText(), "Tasks");
  historySession.emit({ type: "usage", inputTokens: 2000, outputTokens: 200 });
  releaseSnapshot();
  await page.waitForFunction(() => document.querySelector(".tokens")?.textContent?.trim() === "42k / 4200");
  await page.unroute(`**/sessions/${historySession.id}?*`);
  await page.reload();
  await page.getByText(/Saved response 39\./).waitFor();
  assert.deepEqual(await page.evaluate(() => window.tokenPaints), ["42k / 4200"]);
  assert.equal(await page.locator(".messages").evaluate(el => el.scrollTop), 320, "reload restores reading position");
  await page.screenshot({ path: join(shots, "thread-snapshot.png") });

  // HTML often arrives before CSS/JS. Never present that incomplete first build as ready,
  // including after a reload, and load all assets once the agent publishes it.
  const staged = harness.createSession({ sandbox: { name: "staged-preview" }, title: "Staged page build" });
  staged.status = "running";
  writeFileSync(join(staged.projectRoot, "index.html"), '<!doctype html><link rel="stylesheet" href="styles.css"><h1 id="staged">Unstyled draft</h1><script src="app.js"></script>');
  staged.emit({ type: "status", status: "running" });
  staged.emit({ type: "tool.call", id: "staged-html", name: "write_file", args: { path: "index.html" } });
  staged.emit({ type: "tool.result", id: "staged-html", name: "write_file", ok: true, output: "Written", diff: "+draft" });
  await page.goto(`${server.url}/c/${staged.id}`);
  await page.getByRole("button", { name: "Toggle code panel" }).click();
  await page.locator(".code-panel .tabs button", { hasText: "Preview" }).click();
  await page.getByText("Building your preview", { exact: true }).waitFor();
  assert.equal(await page.locator("iframe.preview-frame").count(), 0, "HTML alone is not a ready preview");
  await page.reload();
  await page.getByText("Building your preview", { exact: true }).waitFor();
  assert.equal(await page.locator("iframe.preview-frame").count(), 0, "reload still waits for assets");
  await page.screenshot({ path: join(shots, "preview-building.png") });
  writeFileSync(join(staged.projectRoot, "styles.css"), "#staged { color: rgb(20, 80, 160); font-size: 24px; }");
  writeFileSync(join(staged.projectRoot, "app.js"), "document.getElementById('staged').textContent = 'Styled page ready';");
  staged.emit({ type: "preview.ready", path: "index.html" });
  const stagedHeading = page.frameLocator("iframe.preview-frame").locator("#staged");
  await stagedHeading.filter({ hasText: "Styled page ready" }).waitFor();
  assert.equal(await stagedHeading.evaluate(el => getComputedStyle(el).color), "rgb(20, 80, 160)", "published preview loads its relative stylesheet");
  staged.status = "idle";
  staged.emit({ type: "status", status: "idle" });
  await page.screenshot({ path: join(shots, "preview-styled.png") });

  // Storage-dependent scripts must run in the opaque-origin iframe, just as in a new tab.
  const storagePage = harness.createSession({ sandbox: { name: "storage-preview" }, title: "Storage preview" });
  const storageHtml = `<!-- generated page --><!doctype html><html><head>
    <style>.reveal { opacity: 0 } .reveal.visible { opacity: 1 }</style>
    <script>
      const previous = localStorage.getItem('visits');
      localStorage.setItem('visits', String(Number(previous || 0) + 1));
      sessionStorage.setItem('currency', 'EUR');
    </script></head><body><h1 class="reveal">Storage page ready</h1><script>
      new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting) entry.target.classList.add('visible');
      })).observe(document.querySelector('h1'));
    </script></body></html>`;
  writeFileSync(join(storagePage.projectRoot, "index.html"), storageHtml);
  storagePage.emit({ type: "preview.ready", path: "index.html" });
  const storageErrors = [];
  const captureStorageError = error => storageErrors.push(error.message);
  page.on("pageerror", captureStorageError);
  await page.goto(`${server.url}/c/${storagePage.id}`);
  const storageHeading = page.frameLocator("iframe.preview-frame").locator("h1");
  await page.frameLocator("iframe.preview-frame").locator("h1.visible").waitFor();
  assert.equal(await storageHeading.evaluate(el => getComputedStyle(el).opacity), "1");
  assert.deepEqual(storageErrors, [], "sandbox storage no longer aborts page scripts");
  assert.deepEqual(await storageHeading.evaluate(() => {
    const s = sessionStorage;
    s.setItem('number', 42);
    s.named = 'property';
    const keys = Object.keys(s).sort();
    const result = [localStorage.getItem('visits'), s.getItem('currency'), s.number, s.getItem('named'), s.length, keys, document.compatMode];
    delete s.named;
    s.removeItem('number');
    result.push(s.key(0), s.key(99), s.getItem('missing'));
    s.clear();
    result.push(s.length);
    try { void parent.document; result.push('parent accessible'); } catch { result.push('parent isolated'); }
    return result;
  }), ["1", "EUR", "42", "property", 3, ["currency", "named", "number"], "CSS1Compat", "currency", null, null, 0, "parent isolated"]);
  const standaloneUrl = await page.locator("iframe.preview-frame").getAttribute("src");
  const standalone = await browser.newPage();
  await standalone.goto(new URL(standaloneUrl, server.url).href);
  assert.equal(await standalone.evaluate(() => localStorage instanceof Storage), true, "new tabs retain native storage");
  await standalone.reload();
  assert.equal(await standalone.evaluate(() => localStorage.getItem('visits')), "2", "native storage persists across reloads");
  await standalone.close();
  assert.equal(readFileSync(join(storagePage.projectRoot, "index.html"), "utf8"), storageHtml, "source files are unchanged");
  page.off("pageerror", captureStorageError);

  // Existing projects can also discover a page when the turn finishes without set_preview.
  const discovered = harness.createSession({ sandbox: { name: "discovered-preview" }, title: "Discovered page" });
  discovered.status = "running";
  writeFileSync(join(discovered.projectRoot, "index.html"), "<!doctype html><h1>Completed page</h1>");
  discovered.emit({ type: "status", status: "running" });
  await page.goto(`${server.url}/c/${discovered.id}`);
  await page.getByRole("button", { name: "Toggle code panel" }).click();
  await page.locator(".code-panel .tabs button", { hasText: "Preview" }).click();
  await page.getByText("Building your preview", { exact: true }).waitFor();
  discovered.status = "idle";
  discovered.emit({ type: "status", status: "idle" });
  await page.frameLocator("iframe.preview-frame").getByRole("heading", { name: "Completed page" }).waitFor();
  // A real independent terminal process writes to the shared log while the browser is open.
  const terminalCode = `
    const { Harness, MockProvider } = await import(process.env.MORROW_TEST_CORE);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const provider = new MockProvider({ handler: async (_req, index) => {
      if (!index) {
        await gate;
        return { toolCalls: [
          { name: 'write_file', args: { path: 'index.html', content: '<!doctype html><h1>Built from terminal</h1>' } },
          { name: 'set_preview', args: { path: 'index.html', title: 'Terminal creation' } }
        ] };
      }
      return { text: 'Your terminal creation is ready in the web preview.' };
    } });
    const h = new Harness({ providers: { mock: provider }, skipGlobalConfig: true, loadEnv: false,
      configOverrides: { providers: { mock: { type: 'mock' } }, models: { executor: 'mock/m', planner: 'mock/m', reviewer: 'mock/m', summarizer: 'mock/m' } } });
    const session = h.createSession({ sandbox: { name: 'terminal-creation' }, title: 'Live terminal creation' });
    process.on('message', async message => {
      if (message === 'release') release();
      if (message === 'start') {
        await session.chat('Build from the terminal');
        h.closeAll();
        process.disconnect();
      }
    });
    process.send({ id: session.id });
  `;
  terminalChild = spawn(process.execPath, ["--input-type=module", "-e", terminalCode], {
    env: { ...process.env, MORROW_TEST_CORE: new URL("../../../packages/core/dist/index.js", import.meta.url).href },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const terminalExit = new Promise(resolve => terminalChild.once("exit", resolve));
  const terminalInfo = await new Promise((resolve, reject) => {
    terminalChild.once("message", resolve);
    terminalChild.once("error", reject);
    terminalChild.once("exit", code => reject(new Error(`Terminal fixture exited early: ${code}`)));
  });
  await page.goto(`${server.url}/c/${terminalInfo.id}`);
  await page.locator(".chat-title", { hasText: "Live terminal creation" }).waitFor();
  terminalChild.send("start");
  await page.getByText(/Live from another terminal\./).waitFor();
  assert.equal(await page.locator(".composer textarea").isDisabled(), true);
  terminalChild.send("release");
  await page.getByText("Your terminal creation is ready in the web preview.", { exact: true }).waitFor();
  await page.frameLocator("iframe.preview-frame").getByRole("heading", { name: "Built from terminal" }).waitFor();
  assert.equal(await terminalExit, 0);
  await page.screenshot({ path: join(shots, "terminal-web-connected.png") });
  await page.reload();
  await page.frameLocator("iframe.preview-frame").getByRole("heading", { name: "Built from terminal" }).waitFor();
  assert.equal(await page.locator(".composer textarea").isDisabled(), false);

  // A successful plan isn't a built app: show its result without implying missing preview output.
  const planSession = harness.createSession({ sandbox: { name: "plan-result" }, title: "Plan result" });
  await planSession.run("Plan a game", { workflow: "plan-only" });
  await page.goto(`${server.url}/c/${planSession.id}`);
  await page.locator(".status-pill", { hasText: "Plan ready" }).waitFor();
  await page.getByRole("button", { name: "Toggle code panel" }).click();
  await page.locator(".code-panel .tabs button", { hasText: "Preview" }).click();
  await page.getByText(/Plan ready — no app has been built yet/).waitFor();
  assert.deepEqual(errors, []);
  console.log(`web e2e: PASS (screenshots in ${shots})`);
} catch (e) {
  failed = true;
  console.error("web e2e: FAIL", e.message.split("\n").slice(0, 6).join("\n"), "\npage errors:", errors);
} finally {
  if (terminalChild && terminalChild.exitCode === null) terminalChild.kill();
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
