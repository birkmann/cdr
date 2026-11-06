import { describe, expect, it } from "vitest";
import { Harness, MockProvider, detectFramework, setLaunchTool } from "@harness/core";
import { MOCK_MODELS, tempProject, toolCtx } from "./helpers.js";

describe("set_launch", () => {
  it("emits launch.ready with the framework detected from the project", async () => {
    const root = tempProject({ "game/Cargo.toml": '[package]\nname = "snake"\n', "game/src/main.rs": "fn main() {}" });
    const ctx = toolCtx(root);
    const r = await setLaunchTool.execute({ command: "cargo run --release", cwd: "game", title: "Snake" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.events).toEqual([
      { type: "launch.ready", command: "cargo run --release", cwd: "game", title: "Snake", framework: "rust" },
    ]);
  });

  it("rejects empty or multi-line commands, missing folders and paths outside the project", async () => {
    const root = tempProject({ "main.py": "print(1)" });
    const ctx = toolCtx(root);
    expect((await setLaunchTool.execute({ command: " " }, ctx)).ok).toBe(false);
    expect((await setLaunchTool.execute({ command: "a\nrm -rf x" }, ctx)).ok).toBe(false);
    expect((await setLaunchTool.execute({ command: "python main.py", cwd: "nope" }, ctx)).ok).toBe(false);
    await expect(setLaunchTool.execute({ command: "ls", cwd: "../.." }, ctx)).rejects.toThrow(/outside/);
    expect(ctx.events).toEqual([]);
    await setLaunchTool.execute({ command: "python main.py" }, ctx);
    expect(ctx.events).toEqual([{ type: "launch.ready", command: "python main.py", framework: "python" }]);
  });

  it("detects frameworks from manifests, then the command", () => {
    expect(detectFramework(tempProject({ "Cargo.toml": '[dependencies]\ntauri = "2"' }))).toBe("tauri");
    expect(detectFramework(tempProject({ "go.mod": "module x" }))).toBe("go");
    expect(detectFramework(tempProject({ "package.json": "{}" }))).toBe("node");
    expect(detectFramework(tempProject({ "Package.swift": "" }))).toBe("swift");
    expect(detectFramework(tempProject({ "App.csproj": "" }))).toBe("dotnet");
    expect(detectFramework(tempProject({}), "zig build run")).toBe("zig");
    expect(detectFramework(tempProject({}), "./run.sh")).toBe("other");
  });

  it("is offered to the model in sandbox sessions", async () => {
    const mock = new MockProvider({
      replies: [{ toolCalls: [{ name: "set_launch", args: { command: "cargo run" } }] }, { text: "done" }],
    });
    const h = new Harness({ providers: { mock }, skipGlobalConfig: true, loadEnv: false, configOverrides: MOCK_MODELS });
    const s = h.createSession({ sandbox: true });
    await s.chat("build a rust app");
    expect(mock.calls[0].tools?.map((t) => t.name)).toContain("set_launch");
    expect(s.events.find((e) => e.type === "launch.ready")).toMatchObject({ command: "cargo run" });
  });
});
