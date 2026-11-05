// A scripted "model" for README screenshots and demos. It drives the real harness: tool calls write
// real files, run real tests, and publish a real preview. No model API calls.
// The store demo loads credited photography from Unsplash.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { Harness, MockProvider } = await import(join(root, "packages/core/dist/index.js"));

export const DEMO_MODEL = "cdr/demo";

// The store is the web-app skill's reference app, so the demo and the skill never drift apart.
const STORE_APP = readFileSync(join(root, "packages/core/skills/web-app/reference/form.html"), "utf8");

const APP_JS_ROUTE_SEARCH = `  "GET /users": () => ({ status: 200, body: [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }] }),
};`;
const APP_JS_ROUTE_REPLACE = `  "GET /users": () => ({ status: 200, body: [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }] }),
  "GET /version": () => ({ status: 200, body: { name: pkg.name, version: pkg.version } }),
};`;

function scenario(first) {
  if (/form|store|accessories|kiosk|coffee|landing page|ember/i.test(first)) return "store";
  if (/permission mode summary/i.test(first)) return "permission-summary";
  if (/permission/i.test(first)) return "explain";
  if (/version/i.test(first)) return "endpoint";
  return "default";
}

/** Tool results since the latest user message tell the script which step comes next. */
function step(req) {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role === "user") break;
    if (m.role === "assistant") n++;
  }
  return n;
}

export function demoHandler(req) {
  const users = req.messages.filter((m) => m.role === "user");
  const first = users.at(-1)?.content ?? "";
  const s = step(req);
  const sys = req.messages[0]?.content ?? "";
  if (sys.startsWith("You write git commit messages"))
    return { text: "Clarify permission modes and confirmation rules\n\nAdd structured mode summaries while preserving the string API.\nCover each mode and keep built-in restrictions visible." };
  switch (scenario(first)) {
    case "permission-summary":
      if (s === 0) return {
        text: "I'll read the staged helper and tests alongside the mode documentation.",
        toolCalls: [
          { name: "read_file", args: { path: "packages/core/src/permission-summary.ts" } },
          { name: "read_file", args: { path: "packages/core/test/permission-summary.test.ts" } },
          { name: "read_file", args: { path: "docs/permission-modes.md" } },
        ],
      };
      return { text: "## Ready for your review\n\n**Permission enforcement is unchanged.** The new helper supplies display copy; `PermissionPolicy` still decides which tools run.\n\n### In this diff\n\n- Labels and confirmation rules for **Ask**, **Auto**, and **Full access**.\n- The existing string API stays available.\n- Full access still mentions built-in restrictions.\n\n### Before committing\n\nThe helper and tests are staged; the mode guide is unstaged. Tests cover every mode and returned-object isolation. **Run them before committing** — this review only inspected the files." };
    case "store":
      if (s === 0)
        return {
          reasoning:
            "Use a white catalogue with quiet typography, large product photographs, and a responsive grid. Product selection, size choices and the bag should work.",
          text: "I'll build Form as a responsive collection with product details and a working bag.",
          toolCalls: [
            {
              name: "todo",
              args: {
                items: [
                  { text: "Design the responsive product collection", status: "done" },
                  { text: "Add product details, size selection, filters and a bag", status: "done" },
                  { text: "Publish the preview", status: "in_progress" },
                ],
              },
            },
            { name: "write_file", args: { path: "index.html", content: STORE_APP } },
          ],
        };
      if (s === 1)
        return {
          toolCalls: [
            { name: "set_preview", args: { path: "index.html", title: "Form · Everyday objects" } },
            {
              name: "todo",
              args: {
                items: [
                  { text: "Design the responsive product collection", status: "done" },
                  { text: "Add product details, size selection, filters and a bag", status: "done" },
                  { text: "Publish the preview", status: "done" },
                ],
              },
            },
          ],
        };
      return {
        text: "**Form** is ready.\n\nA responsive collection with product photography, category filters and a working bag. Open an object to see its details; choose a size for the runner before adding it.\n\nThe layout adapts from a two-column phone catalogue to a wider desktop grid. Your bag stays saved after a reload.\n\nCheckout is a demo — no payment or order is submitted.",
      };
    case "explain":
      if (s === 0)
        return {
          reasoning: "Read the permission policy and see where the loop calls it.",
          text: "Let me look at the policy and the loop.",
          toolCalls: [
            { name: "read_file", args: { path: "packages/core/src/permissions.ts" } },
            { name: "grep", args: { pattern: "requestPermission", path: "packages/core/src" } },
          ],
        };
      return {
        text:
          "Every tool call goes through `PermissionPolicy` before it runs (`packages/core/src/permissions.ts`), and the loop only asks you when the policy says so:\n\n" +
          "1. **Hard deny first.** Destructive shell commands are refused in every mode, even `yolo`.\n" +
          "2. **Config rules.** `permissions.bash.allow` / `deny` patterns and per-tool settings are checked next; every segment of a compound command must be allowed.\n" +
          "3. **Mode.** `ask` prompts for anything that is not read-only, `auto` prompts only for risky or unconfined commands, `yolo` allows the rest.\n\n" +
          "When a prompt is needed, `runAgent` calls `host.requestPermission(tool, args, risk)`, which emits a `permission.request` event and waits. That event is what you see in the approvals inbox. Choosing **Always** records a grant so the same command is not asked again.\n\n" +
          "```ts\nconst decision = await host.requestPermission(call.name, args, risk, reason);\nif (decision === \"deny\") return { ok: false, output: \"Denied by the user.\" };\n```",
      };
    case "endpoint":
      if (s === 0)
        return {
          text: "I'll add the route, cover it with a test, and run the suite.",
          toolCalls: [{ name: "read_file", args: { path: "src/app.js" } }],
        };
      if (s === 1)
        return {
          toolCalls: [
            { name: "patch_file", args: { path: "src/app.js", search: 'import { createServer } from "node:http";', replace: 'import { createServer } from "node:http";\nimport pkg from "../package.json" with { type: "json" };' } },
            { name: "patch_file", args: { path: "src/app.js", search: APP_JS_ROUTE_SEARCH, replace: APP_JS_ROUTE_REPLACE } },
          ],
        };
      if (s === 2)
        return {
          toolCalls: [
            {
              name: "patch_file",
              args: {
                path: "test/app.test.js",
                search: 'test("unknown route", () => {',
                replace: 'test("version", () => {\n  assert.deepEqual(handle("GET", "/version").body, { name: "node-api", version: "1.0.0" });\n});\n\ntest("unknown route", () => {',
              },
            },
          ],
        };
      if (s === 3) return { toolCalls: [{ name: "run_verification", args: {} }] };
      return {
        text: "Added `GET /version`, which returns the package name and version from `package.json`, plus a test. All 4 tests pass.",
      };
    default:
      return { text: "Done." };
  }
}

export function demoProvider() {
  const p = new MockProvider({ id: "cdr", handler: demoHandler });
  p.capabilities = () => ({ tools: true, json: true, contextWindow: 128000, reasoningEfforts: ["none", "low", "high"] });
  return p;
}

/** A Harness whose only model is the scripted demo model. */
export function createDemoHarness(opts = {}) {
  return new Harness({
    providers: { cdr: demoProvider() },
    skipGlobalConfig: true,
    loadEnv: false,
    sessionsDir: opts.sessionsDir,
    configOverrides: {
      providers: { cdr: { type: "mock" } },
      models: { executor: DEMO_MODEL, planner: DEMO_MODEL, reviewer: DEMO_MODEL, summarizer: DEMO_MODEL },
      verify: opts.verify,
    },
  });
}
