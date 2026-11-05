import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_RUBRIC, MockProvider, findChrome, loadEvalTasks, runEvals } from "@harness/core";
import { MOCK_MODELS, tempProject } from "./helpers.js";

const PAGE = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shop</title><h1>Shop</h1><button aria-label="Open bag" id="b">Bag</button><button id="add">Add</button>
<dialog id="d"><button id="shut">Close</button></dialog>
<script>
let bag = []; try { bag = JSON.parse(localStorage.getItem("bag") || "[]"); } catch {}
add.onclick = () => { bag.push(1); try { localStorage.setItem("bag", JSON.stringify(bag)); } catch {} };
b.onclick = () => d.showModal(); shut.onclick = () => d.close();
</script>`;

const judgeReply = (score: number) =>
  "```json\n" +
  JSON.stringify({
    scores: Object.fromEntries(JUDGE_RUBRIC.map((_, i) => [String(i + 1), score])),
    notes: { "1": "Clear hierarchy." },
    summary: "Solid.",
  }) +
  "\n```";

function evalsDir(tasks: object[]) {
  const dir = tempProject();
  mkdirSync(join(dir, "tasks"));
  mkdirSync(join(dir, "fixtures", "basic"), { recursive: true });
  writeFileSync(join(dir, "fixtures", "basic", "a.txt"), "a\n");
  tasks.forEach((t, i) => writeFileSync(join(dir, "tasks", `${i}.json`), JSON.stringify(t)));
  return dir;
}

function appMock(judgeScore: number | string, page = PAGE) {
  const systems: string[] = [];
  const mock = new MockProvider({
    handler: (req) => {
      const sys = req.messages[0]?.content ?? "";
      if (sys.startsWith("You are a strict senior product designer")) {
        systems.push("judge");
        return { text: typeof judgeScore === "number" ? judgeReply(judgeScore) : judgeScore };
      }
      systems.push(sys);
      const steps = req.messages.filter((m) => m.role === "assistant").length;
      if (steps === 0)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "index.html", content: page } },
            { name: "set_preview", args: { path: "index.html", title: "Shop" } },
          ],
        };
      return { text: "Shop is ready." };
    },
  });
  return { mock, systems };
}

const harnessOptions = (mock: MockProvider) => ({
  providers: { mock },
  loadEnv: false,
  configOverrides: { providers: MOCK_MODELS.providers },
});

const STORE = {
  id: "store",
  suite: "apps",
  sandbox: true,
  task: "Build a responsive store with a working bag",
  checks: [
    { type: "maxFiles", count: 1 },
    { type: "fileContains", path: "index.html", pattern: "localStorage" },
    { type: "preview", viewports: ["small", "desktop"], minButtons: 2 },
    { type: "judge", minScore: 4 },
  ],
};

describe("app evals", () => {
  it("selects suites: code by default, apps or all on request", () => {
    const dir = evalsDir([
      { id: "code-1", fixture: "basic", task: "x", checks: [] },
      { ...STORE, id: "app-1" },
    ]);
    expect(loadEvalTasks(dir).map((t) => t.id)).toEqual(["code-1"]);
    expect(loadEvalTasks(dir, undefined, "apps").map((t) => t.id)).toEqual(["app-1"]);
    expect(loadEvalTasks(dir, undefined, "all")).toHaveLength(2);
    expect(loadEvalTasks(dir, "app")).toHaveLength(1);
  });

  it("ships an apps suite in the repository with browser and judge checks", () => {
    const repoEvals = fileURLToPath(new URL("../../../evals", import.meta.url));
    const apps = loadEvalTasks(repoEvals, undefined, "apps");
    expect(apps.map((t) => t.id)).toEqual([
      "20-form-store",
      "21-landing-page",
      "22-dashboard",
      "23-snake-game",
      "24-todo-app",
    ]);
    for (const t of apps) {
      expect(t.sandbox).toBe(true);
      expect(t.checks.map((c) => c.type)).toEqual(expect.arrayContaining(["preview", "judge", "maxFiles"]));
    }
    expect(loadEvalTasks(repoEvals).every((t) => !t.sandbox)).toBe(true);
  });

  it("searches every matching file for glob content checks", async () => {
    const mock = new MockProvider({
      handler: (req) =>
        req.messages.some((m) => m.role === "assistant")
          ? { text: "done" }
          : {
              toolCalls: [
                { name: "write_file", args: { path: "index.html", content: "<link rel=stylesheet href=styles.css>" } },
                { name: "write_file", args: { path: "styles.css", content: "@media (min-width: 760px) {}" } },
              ],
            },
    });
    const s = await runEvals({
      evalsDir: evalsDir([
        {
          id: "split",
          suite: "apps",
          sandbox: true,
          task: "make a page",
          checks: [
            { type: "fileContains", path: "**/*.{html,css,js}", pattern: "@media" },
            { type: "fileContains", path: "index.html", pattern: "@media" },
            { type: "fileNotContains", path: "**/*.{html,css,js}", pattern: "min-width" },
            { type: "maxFiles", count: 2 },
          ],
        },
      ]),
      model: "mock/m",
      suite: "apps",
      harnessOptions: harnessOptions(mock),
    });
    expect(s.results[0].checks.map((c) => [c.passed, c.detail])).toEqual([
      [true, undefined],
      [false, "pattern /@media/ not found in index.html"],
      [false, "pattern /min-width/ found in styles.css"],
      [true, undefined],
    ]);
  });

  it.skipIf(!findChrome())(
    "runs sandbox tasks like a web chat, with the skill, browser checks and a judge",
    async () => {
      const { mock, systems } = appMock(4.5);
      const s = await runEvals({
        evalsDir: evalsDir([STORE]),
        model: "mock/m",
        suite: "apps",
        judgeModel: "mock/judge",
        repeat: 2,
        harnessOptions: harnessOptions(mock),
      });
      expect(s.total).toBe(2);
      expect(s.judgeModel).toBe("mock/judge");
      for (const r of s.results) {
        expect(r.checks.filter((c) => !c.passed)).toEqual([]);
        expect(r.passed).toBe(true);
        expect(r.files).toEqual(["index.html"]);
        expect(r.checks.find((c) => c.check.type === "judge")?.score).toBe(4.5);
      }
      expect(s.results.map((r) => r.run)).toEqual([1, 2]);
      const executor = systems.find((x) => x !== "judge")!;
      expect(executor).toContain("# Sandbox workspace");
      expect(executor).toContain('<skill name="web-app">');
      const judgeCall = mock.calls.find((c) => c.model === "judge")!;
      const prompt = judgeCall.messages[1].content;
      expect(prompt).toContain("Build a responsive store");
      expect(prompt).toContain("No problems found.");
      expect(prompt).toContain("```html");
    },
    90_000,
  );

  it.skipIf(!findChrome())(
    "fails on low judge scores, unparseable judges, too many files and browser problems",
    async () => {
      const low = await runEvals({
        evalsDir: evalsDir([STORE]),
        model: "mock/m",
        suite: "apps",
        harnessOptions: harnessOptions(appMock(3).mock),
      });
      const judge = low.results[0].checks.find((c) => c.check.type === "judge")!;
      expect(judge.passed).toBe(false);
      expect(judge.detail).toContain("score 3/5 (min 4)");

      const garbled = await runEvals({
        evalsDir: evalsDir([STORE]),
        model: "mock/m",
        suite: "apps",
        harnessOptions: harnessOptions(appMock("I like it").mock),
      });
      expect(garbled.results[0].checks.find((c) => c.check.type === "judge")?.detail).toContain("not JSON");

      const broken = PAGE.replace("<h1>Shop</h1>", '<h1>Shop</h1><div style="width:700px">wide</div>').replace(
        "shut.onclick = () => d.close();",
        "shut.onclick = () => { d.close(); missing(); };",
      );
      const bad = await runEvals({
        evalsDir: evalsDir([STORE]),
        model: "mock/m",
        suite: "apps",
        harnessOptions: harnessOptions(appMock(5, broken).mock),
      });
      const preview = bad.results[0].checks.find((c) => c.check.type === "preview")!;
      expect(preview.passed).toBe(false);
      expect(preview.detail).toMatch(/errors while clicking: .*missing is not defined/);
      expect(preview.detail).not.toContain("JavaScript errors:");
      expect(preview.detail).toMatch(/overflow \d+px at 320px/);
      expect(bad.results[0].passed).toBe(false);
    },
    120_000,
  );
});
