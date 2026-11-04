import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Harness, MockProvider } from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

describe("continue failed jobs", () => {
  it("survives restart and repeated failure, retains the approved plan and files, and verifies again", async () => {
    const root = tempProject(),
      sessionsDir = join(tempProject(), "sessions");
    let attempt = 0,
      planned = 0,
      approvals = 0,
      permissions = 0;
    const mock = new MockProvider({
      handler: (req) => {
        const system = req.messages[0].content,
          last = req.messages.at(-1)!;
        if (system.startsWith("You are the PLANNER")) {
          planned++;
          return { text: "# Plan\n## Steps\n1. Keep the first file\n2. Finish the second file" };
        }
        if (system.includes("REVIEWER")) return { text: '{"summary":"reviewed","findings":[]}' };
        if (attempt === 0) {
          if (last.role === "tool") throw new Error("Provider temporarily unavailable");
          return {
            toolCalls: [
              {
                name: "todo",
                args: {
                  items: [
                    { id: "first", text: "Keep first.txt", status: "done" },
                    { id: "second", text: "Write second.txt", status: "pending" },
                  ],
                },
              },
              { name: "write_file", args: { path: "first.txt", content: "completed work" } },
            ],
          };
        }
        if (last.role === "user") {
          expect(last.content).toContain("Approved plan (follow it)");
          expect(last.content).toContain("Keep the first file");
          expect(last.content).toContain("Provider temporarily unavailable");
          expect(last.content).toContain("Write second.txt");
          expect(req.messages.some((m) => m.role === "tool" && m.content.includes("first.txt"))).toBe(true);
          expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("completed work");
          if (attempt === 1) throw new Error("Still unavailable");
          return {
            toolCalls: [{ name: "write_file", args: { path: "second.txt", content: "remaining work" } }],
          };
        }
        return { text: "Finished the remaining work." };
      },
    });
    const create = () =>
      new Harness({
        providers: { mock },
        sessionsDir,
        skipGlobalConfig: true,
        loadEnv: false,
        configOverrides: {
          ...MOCK_MODELS,
          verify: { test: "node -e \"require('node:fs').readFileSync('second.txt')\"" },
        },
      });
    const approve = (s: ReturnType<Harness["getSession"]>) =>
      s.subscribe((e) => {
        if (e.type === "status" && e.status === "waiting") {
          for (const p of s.pendingRequests()) {
            if (p.type === "plan.proposed") {
              approvals++;
              s.decidePlan(p.id, "approve");
            }
            if (p.type === "permission.request") {
              permissions++;
              s.resolvePermission(p.id, "allow");
            }
          }
        }
      });
    const first = create().createSession({ projectPath: root });
    approve(first);
    expect((await first.run("Build both files")).status).toBe("failed");
    first.close();
    attempt = 1;
    const second = create().getSession(first.id);
    approve(second);
    expect(second.todos).toHaveLength(2);
    expect((await second.continueJob()).status).toBe("failed");
    second.close();
    attempt = 2;
    const third = create().getSession(first.id);
    approve(third);
    expect((await third.continueJob()).status).toBe("success");
    expect(planned).toBe(1);
    expect(approvals).toBe(1);
    expect(permissions).toBe(2);
    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("completed work");
    expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("remaining work");
    expect(third.events.some((e) => e.type === "verify.result" && e.exitCode === 0)).toBe(true);
    const starts = third.events.filter((e) => e.type === "run.start");
    expect(starts).toHaveLength(3);
    expect(starts[2]).toMatchObject({ continuedFrom: starts[1].seq, task: "Build both files" });
    expect(() => third.continueJob()).toThrow("no failed or stopped job");
  });

  it("does not treat a rejected plan as approved", async () => {
    const root = tempProject();
    const h = new Harness({
      providers: {
        mock: new MockProvider({
          handler: (req) =>
            req.messages[0].content.startsWith("You are the PLANNER")
              ? { text: "# Plan\n## Steps\n1. Explain the project" }
              : { text: '{"summary":"ok","findings":[]}' },
        }),
      },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ projectPath: root });
    let prompts = 0;
    s.subscribe((e) => {
      if (e.type === "status" && e.status === "waiting") {
        const p = s.pendingRequests()[0];
        if (p.type === "plan.proposed") s.decidePlan(p.id, ++prompts === 1 ? "reject" : "approve");
      }
    });
    expect((await s.run("Explain the project")).status).toBe("cancelled");
    expect((await s.continueJob()).status).toBe("success");
    expect(prompts).toBe(2);
  });

  it("continues a failed chat with its existing context and rejects concurrent attempts", async () => {
    let fail = true,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = new MockProvider({
      handler: async (req) => {
        if (fail) throw new Error("Connection lost");
        expect(req.messages.some((m) => m.content === "Remember the blue timer")).toBe(true);
        await gate;
        return { text: "Finished the blue timer." };
      },
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ projectPath: tempProject() });
    expect((await s.chat("Remember the blue timer")).status).toBe("error");
    fail = false;
    const continuing = s.continueJob();
    expect(() => s.continueJob()).toThrow("already running");
    release();
    expect((await continuing).status).toBe("completed");
  });
});
