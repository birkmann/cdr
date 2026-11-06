import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Harness,
  MockProvider,
  defaultOutputDir,
  globTool,
  grepTool,
  listDirTool,
  outputBaseDir,
  patchFileTool,
  readFileTool,
  resolveTarget,
  writeFileTool,
} from "@harness/core";
import { MOCK_MODELS, tempProject, toolCtx } from "./helpers.js";

const outDir = () => join(mkdtempSync(join(tmpdir(), "harness-out-")), "chat-1");

describe("chat output folder", () => {
  it("creates new files in the output folder and edits existing project files in place", async () => {
    const root = tempProject({ "a.txt": "a\n" });
    const out = outDir();
    const ctx = { ...toolCtx(root), outputDir: out };

    const created = await writeFileTool.execute({ path: "poems/dogs.md", content: "Dogs\n" }, ctx);
    expect(created.ok).toBe(true);
    expect(created.edited).toBeUndefined();
    expect(created.output).toContain(join(out, "poems/dogs.md").replace(process.env.HOME ?? "\0", "~"));
    expect(readFileSync(join(out, "poems/dogs.md"), "utf8")).toBe("Dogs\n");
    expect(existsSync(join(root, "poems"))).toBe(false);

    // the model can read and patch what it wrote with the same relative path
    expect((await readFileTool.execute({ path: "poems/dogs.md" }, ctx)).output).toBe("1\tDogs");
    await patchFileTool.execute({ path: "poems/dogs.md", search: "Dogs", replace: "Cats" }, ctx);
    expect(readFileSync(join(out, "poems/dogs.md"), "utf8")).toBe("Cats\n");

    // existing project files stay in the project
    const edited = await writeFileTool.execute({ path: "a.txt", content: "b\n" }, ctx);
    expect(edited.edited).toEqual(["a.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("b\n");
  });

  it("lets the model find and read back what it wrote by the path write_file reports", async () => {
    const root = tempProject({ "a.txt": "a\n" });
    const out = outDir();
    const ctx = { ...toolCtx(root), outputDir: out };
    const created = await writeFileTool.execute(
      { path: "scripts/run.py", content: "print('needle')\n" },
      ctx,
    );
    const shown = created.output.match(/Created (\S+)/)![1];
    expect(shown.startsWith("~") || shown.startsWith("/")).toBe(true);
    expect((await readFileTool.execute({ path: shown }, ctx)).output).toContain("needle");
    const dir = shown.replace(/\/run\.py$/, "");
    expect((await listDirTool.execute({ path: dir }, ctx)).output).toContain("run.py");
    expect((await globTool.execute({ pattern: "*.py", path: dir }, ctx)).output).toContain("run.py");
    expect((await grepTool.execute({ pattern: "needle", path: dir }, ctx)).output).toContain("run.py");
    // project searches are unchanged
    expect((await grepTool.execute({ pattern: "needle" }, ctx)).output).toBe("No matches.");
  });

  it("writes a new file into an existing project folder in the project", async () => {
    const root = tempProject({ "src/a.ts": "a\n" });
    const ctx = { ...toolCtx(root), outputDir: outDir() };
    expect(resolveTarget(ctx, "src/b.ts", { forWrite: true }).output).toBe(false);
    expect(resolveTarget(ctx, "notes.md", { forWrite: true }).output).toBe(true);
    expect(resolveTarget(ctx, "docs/new.md", { forWrite: true }).output).toBe(true);
    expect(writeFileTool.risk!({ path: "src/b.ts" }, ctx)).toBe("medium");
  });

  it("labels the first write with a path relative to the output folder even under a symlink", async () => {
    const root = tempProject();
    const real = mkdtempSync(join(tmpdir(), "harness-real-"));
    const link = join(mkdtempSync(join(tmpdir(), "harness-link-")), "docs");
    symlinkSync(real, link);
    const ctx = { ...toolCtx(root), outputDir: join(link, "chat-1") };
    const r = await writeFileTool.execute({ path: "n.md", content: "x\n" }, ctx);
    expect(r.diffPath).toBe("n.md");
    expect(readFileSync(join(real, "chat-1", "n.md"), "utf8")).toBe("x\n");
  });

  it("expands ~ and relative CDR_OUTPUT_DIR values", () => {
    const saved = process.env.CDR_OUTPUT_DIR;
    try {
      process.env.CDR_OUTPUT_DIR = "~/notes";
      expect(defaultOutputDir()).toBe(join(process.env.HOME!, "notes"));
      process.env.CDR_OUTPUT_DIR = "out";
      expect(defaultOutputDir()).toBe(join(process.cwd(), "out"));
    } finally {
      process.env.CDR_OUTPUT_DIR = saved;
    }
  });

  it("names the folder of a chat without Latin letters 'chat'", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-docs-"));
    const h = new Harness({
      providers: { mock: new MockProvider({ replies: [{ text: "ok" }] }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
      defaultOutputDir: base,
    });
    const s = h.createSession({ projectPath: tempProject() });
    await s.chat("你好 🐶");
    expect(s.chatOutputDir()!.startsWith(join(base, "chat-"))).toBe(true);
  });

  it("keeps confinement: no escapes from the project or the output folder", () => {
    const root = tempProject();
    const ctx = { projectRoot: root, outputDir: outDir() };
    expect(() => resolveTarget(ctx, "../x", { forWrite: true })).toThrow(/outside/);
    expect(() => resolveTarget(ctx, "/etc/passwd", { forWrite: true })).toThrow(/outside/);
    expect(() => resolveTarget(ctx, ".git/config", { forWrite: true })).toThrow(/\.git/);
    expect(resolveTarget({ projectRoot: root }, "new.txt", { forWrite: true }).output).toBe(false);
  });

  it("writes outside the project need no approval in ask mode, project writes still do", async () => {
    const root = tempProject({ "a.txt": "a\n" });
    const base = mkdtempSync(join(tmpdir(), "harness-docs-"));
    const mock = new MockProvider({
      replies: [
        { toolCalls: [{ name: "write_file", args: { path: "poems/dogs-poem.md", content: "Dogs\n" } }] },
        { text: "Saved." },
      ],
    });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
      defaultOutputDir: base,
    });
    const s = h.createSession({ projectPath: root });
    const r = await s.chat("write me a poem about dogs");
    expect(r.status).toBe("completed");
    expect(s.events.some((e) => e.type === "permission.request")).toBe(false);
    const dir = s.chatOutputDir()!;
    expect(dir.startsWith(join(base, "write-me-a-poem-about-dogs-"))).toBe(true);
    expect(readFileSync(join(dir, "poems/dogs-poem.md"), "utf8")).toBe("Dogs\n");
    expect(existsSync(join(root, "poems"))).toBe(false);
    expect(mock.calls[0].messages[0].content).toContain(`# Output folder`);
    expect(mock.calls[0].messages[0].content).toContain(dir);
    // writes to files that exist in the project keep their normal (prompting) risk
    const ctx = { ...toolCtx(root), outputDir: dir };
    expect(writeFileTool.risk!({ path: "poems/dogs-poem.md" }, ctx)).toBe("low");
    expect(writeFileTool.risk!({ path: "a.txt" }, ctx)).toBe("medium");
    expect(patchFileTool.risk!({ path: "a.txt" }, ctx)).toBe("medium");
  });

  it("is off for build runs, sandboxes and outputDir: false", async () => {
    const base = mkdtempSync(join(tmpdir(), "harness-docs-"));
    const h = (extra = {}) =>
      new Harness({
        providers: { mock: new MockProvider({ replies: [] }) },
        skipGlobalConfig: true,
        loadEnv: false,
        configOverrides: { ...MOCK_MODELS, ...extra },
        defaultOutputDir: base,
      });
    expect(h().createSession({ sandbox: true }).chatOutputDir()).toBeUndefined();
    expect(
      h({ outputDir: false }).createSession({ projectPath: tempProject() }).chatOutputDir(),
    ).toBeUndefined();
    const configured = h({ outputDir: "~/Notes" }).createSession({ projectPath: tempProject() });
    expect(configured.chatOutputDir()?.startsWith(join(process.env.HOME!, "Notes"))).toBe(true);
    expect(outputBaseDir({})).toBeUndefined();

    // the default workflow (Build mode) writes new files into the project
    const root = tempProject();
    const mock = new MockProvider({
      handler: (req) =>
        req.messages[0].content.includes("EXECUTOR") && !req.messages.some((m) => m.role === "tool")
          ? { toolCalls: [{ name: "write_file", args: { path: "new.txt", content: "x" } }] }
          : { text: "done" },
    });
    const build = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
      defaultOutputDir: base,
    }).createSession({ projectPath: root, workflow: "quick-fix", permissionMode: "auto" });
    await build.run("add new.txt");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("x");
  });
});
