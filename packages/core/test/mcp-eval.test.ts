import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, McpClient, MockProvider, runEvals } from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

const fake = fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url));

describe("MCP client", () => {
  it("lists and calls tools over stdio", async () => {
    const c = new McpClient("fake", { command: process.execPath, args: [fake] });
    await c.connect();
    const tools = c.toTools(await c.listTools());
    expect(tools.map((t) => t.name)).toEqual(["mcp__fake__add"]);
    expect(tools[0].readOnly).toBe(true);
    expect(await c.callTool("add", { a: 2, b: 3 })).toEqual({ ok: true, output: "5" });
    c.close();
  });

  it("exposes MCP tools to the agent", async () => {
    const root = tempProject();
    const mock = new MockProvider({
      handler: (req, i) => {
        if (i === 0) {
          expect(req.tools?.map((t) => t.name)).toContain("mcp__fake__add");
          return { toolCalls: [{ name: "mcp__fake__add", args: { a: 40, b: 2 } }] };
        }
        return { text: `result ${req.messages.at(-1)?.content}` };
      },
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MOCK_MODELS, mcpServers: { fake: { command: process.execPath, args: [fake] } } },
    });
    const s = h.createSession({ projectPath: root });
    const r = await s.chat("add");
    expect(r.text).toBe("result 42");
    s.close();
  });
});

describe("eval runner", () => {
  it("runs tasks in temp copies and applies checks", async () => {
    const evals = tempProject();
    mkdirSync(join(evals, "tasks"));
    mkdirSync(join(evals, "fixtures", "basic"), { recursive: true });
    writeFileSync(join(evals, "fixtures", "basic", "a.txt"), "old\n");
    writeFileSync(
      join(evals, "tasks", "t1.json"),
      JSON.stringify({
        id: "t1",
        fixture: "basic",
        task: "replace old with new",
        checks: [
          { type: "fileContains", path: "a.txt", pattern: "^new$", flags: "m" },
          { type: "onlyChanged", paths: ["a.txt"] },
          { type: "command", command: "grep -q new a.txt" },
        ],
      }),
    );
    writeFileSync(
      join(evals, "tasks", "t2.json"),
      JSON.stringify({
        id: "t2",
        fixture: "basic",
        task: "do nothing",
        checks: [{ type: "fileContains", path: "a.txt", pattern: "new" }],
      }),
    );
    const mock = new MockProvider({
      handler: (req) => {
        const task = req.messages.find((m) => m.role === "user")!.content;
        const last = req.messages.at(-1)!;
        if (task.includes("replace old") && last.role === "user")
          return {
            toolCalls: [{ name: "patch_file", args: { path: "a.txt", search: "old", replace: "new" } }],
          };
        return { text: "done" };
      },
    });
    const s = await runEvals({
      evalsDir: evals,
      model: "mock/m",
      harnessOptions: {
        providers: { mock },
        loadEnv: false,
        configOverrides: { providers: MOCK_MODELS.providers },
      },
    });
    expect(s.total).toBe(2);
    expect(s.results.map((r) => r.passed)).toEqual([true, false]);
    expect(s.passRate).toBe(0.5);
  });
});
