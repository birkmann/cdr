import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deepMerge,
  globToRegExp,
  loadConfig,
  harnessHome,
  initProject,
  loadDotEnv,
  parseModelRef,
  redact,
  registerSecret,
  truncateMiddle,
  unifiedDiff,
  wildcardMatch,
  detectStack,
  parseTextToolCalls,
  toTextProtocolMessages,
} from "@harness/core";
import { tempProject } from "./helpers.js";

describe("util", () => {
  it("truncates the middle of long strings", () => {
    const r = truncateMiddle("a".repeat(100) + "b".repeat(100), 50);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("a")).toBe(true);
    expect(r.text.endsWith("b")).toBe(true);
    expect(r.text).toContain("omitted");
    expect(truncateMiddle("short", 50)).toEqual({ text: "short", truncated: false });
  });

  it("converts globs to regexps", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/c.ts")).toBe(false);
    expect(globToRegExp("*.{ts,js}").test("x.js")).toBe(true);
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
  });

  it("matches permission wildcards", () => {
    expect(wildcardMatch("git diff*", "git diff --stat")).toBe(true);
    expect(wildcardMatch("pnpm *", "pnpm test")).toBe(true);
    expect(wildcardMatch("git status", "git status --short")).toBe(false);
  });

  it("redacts secrets", () => {
    registerSecret("supersecretvalue123");
    expect(redact("key=supersecretvalue123 and sk-abcdefghijklmnopqrstuvwx")).toBe(
      "key=[REDACTED] and [REDACTED]",
    );
  });

  it("deep merges config objects", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] })).toEqual({
      a: { b: 1, c: 3 },
      d: [2],
    });
  });

  it("prefers CDR config while retaining legacy configuration and init behavior", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-config-"));
    writeFileSync(join(dir, "harness.config.json"), JSON.stringify({ permissions: { mode: "auto" } }));
    expect(loadConfig({ projectPath: dir, skipGlobal: true }).permissions?.mode).toBe("auto");
    const init = initProject(dir, { configName: "cdr.config.json" });
    expect(init.skipped).toContain(join(dir, "harness.config.json"));
    writeFileSync(join(dir, "morrow.config.json"), JSON.stringify({ permissions: { mode: "ask" } }));
    expect(loadConfig({ projectPath: dir, skipGlobal: true }).permissions?.mode).toBe("ask");
    expect(initProject(dir, { configName: "cdr.config.json" }).skipped).toContain(
      join(dir, "morrow.config.json"),
    );
    writeFileSync(join(dir, "cdr.config.json"), JSON.stringify({ permissions: { mode: "yolo" } }));
    expect(loadConfig({ projectPath: dir, skipGlobal: true }).permissions?.mode).toBe("yolo");
  });

  it("prefers CDR_HOME while preserving both legacy home aliases", () => {
    try {
      vi.stubEnv("HARNESS_HOME", "/legacy-harness");
      vi.stubEnv("MORROW_HOME", "/legacy-morrow");
      vi.stubEnv("CDR_HOME", "/cdr-home");
      expect(harnessHome()).toBe("/cdr-home");
      vi.stubEnv("CDR_HOME", undefined);
      expect(harnessHome()).toBe("/legacy-morrow");
      vi.stubEnv("MORROW_HOME", undefined);
      expect(harnessHome()).toBe("/legacy-harness");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("parses model refs with slashes in the model name", () => {
    expect(parseModelRef("openrouter/anthropic/claude")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude",
    });
    expect(() => parseModelRef("nope")).toThrow();
  });
});

describe("config", () => {
  it("merges project config over defaults and validates providers", () => {
    const root = tempProject({
      "harness.config.json": JSON.stringify({
        models: { executor: "local/qwen" },
        verify: { test: "echo ok" },
      }),
    });
    const cfg = loadConfig({ projectPath: root, skipGlobal: true });
    expect(cfg.models.executor).toBe("local/qwen");
    expect(cfg.models.reviewer).toBe("deepseek/deepseek-v4-pro");
    expect(cfg.verify?.test).toBe("echo ok");
    expect(cfg.verify?.maxAttempts).toBe(3);
    const bad = tempProject({ "harness.config.json": JSON.stringify({ models: { executor: "nope/x" } }) });
    expect(() => loadConfig({ projectPath: bad, skipGlobal: true })).toThrow(/unknown provider/);
  });

  it("loads .env without overriding existing env", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    writeFileSync(
      join(dir, ".env"),
      'A_TEST_KEY="quoted"\nB_TEST_KEY=plain # comment\nexport C_TEST_KEY=c\n',
    );
    const env: NodeJS.ProcessEnv = { B_TEST_KEY: "keep" };
    loadDotEnv(dir, env);
    expect(env).toEqual({ A_TEST_KEY: "quoted", B_TEST_KEY: "keep", C_TEST_KEY: "c" });
  });
});

describe("diff", () => {
  it("produces a unified diff with context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 10\n", "line ten\n");
    const d = unifiedDiff("f.txt", before, after);
    expect(d).toContain("--- a/f.txt");
    expect(d).toContain("@@ -7,7 +7,7 @@");
    expect(d).toContain("-line 10");
    expect(d).toContain("+line ten");
    expect(unifiedDiff("f", "x", "x")).toBe("");
    expect(unifiedDiff("new.txt", "", "a\nb\n")).toContain("@@ -0,0 +1,2 @@");
  });
});

describe("stack detection", () => {
  it("detects node + pnpm scripts", () => {
    const root = tempProject({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest", lint: "eslint ." } }),
      "pnpm-lock.yaml": "",
      "tsconfig.json": "{}",
    });
    expect(detectStack(root)).toEqual({
      languages: ["typescript"],
      packageManager: "pnpm",
      commands: { build: "pnpm run build", test: "pnpm test", lint: "pnpm run lint" },
    });
  });
  it("ignores npm's placeholder test script and detects go", () => {
    const root = tempProject({
      "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "go.mod": "module x",
    });
    const s = detectStack(root);
    expect(s.commands.test).toBe("go test ./...");
    expect(s.languages).toEqual(["javascript", "go"]);
  });
});

describe("text protocol fallback", () => {
  it("parses fenced tool blocks", () => {
    const calls = parseTextToolCalls(
      'I will read it.\n```tool\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```\n```tool\n{"name":"nope","arguments":{}}\n```',
      new Set(["read_file"]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: "a.ts" });
  });
  it("rewrites tool messages into text", () => {
    const msgs = toTextProtocolMessages(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a"}' }],
        },
        { role: "tool", toolCallId: "1", name: "read_file", content: "hello" },
      ],
      [{ name: "read_file", description: "read", parameters: {} }],
    );
    expect(msgs[0].content).toContain("Tool calling protocol");
    expect(msgs[2].content).toContain("```tool");
    expect(msgs[3]).toEqual({ role: "user", content: "Result of tool `read_file`:\nhello" });
  });
});
