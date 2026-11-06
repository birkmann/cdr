import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Harness,
  MockProvider,
  builtinSkillsDir,
  delegatedSkills,
  discoverSkills,
  estimateTokens,
  harnessHome,
  loadSkillTool,
  matchSkills,
  parseFrontmatter,
  skillReferences,
  skillsIndex,
} from "@harness/core";
import { MOCK_MODELS, tempProject, toolCtx } from "./helpers.js";

function skill(base: string, name: string, front: string, body = `Body of ${name}.`) {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, name, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`);
  return join(base, name);
}

describe("skill frontmatter", () => {
  it("parses scalars, quoted values, inline and block lists", () => {
    const { data, body } = parseFrontmatter(
      `---\nname: demo\ndescription: "Does: things"\ntags: [a, 'b']\ntriggers:\n  - \\bstore\\b\n  - game\n---\n# Title\n`,
    );
    expect(data).toEqual({
      name: "demo",
      description: "Does: things",
      tags: ["a", "b"],
      triggers: ["\\bstore\\b", "game"],
    });
    expect(body).toBe("# Title\n");
  });
  it("returns the whole text as body without frontmatter", () => {
    expect(parseFrontmatter("# Just markdown").data).toEqual({});
  });
});

describe("skill discovery", () => {
  it("finds the built-in web-app skill within the token budget", () => {
    expect(builtinSkillsDir()).toBeTruthy();
    const web = discoverSkills(tempProject()).find((s) => s.name === "web-app")!;
    expect(web.source).toBe("builtin");
    expect(web.auto).toBe("sandbox");
    expect(estimateTokens(web.body)).toBeLessThan(3500);
  });

  it("prefers project over config paths over user over built-in, and skips invalid skills", () => {
    const root = tempProject();
    const user = join(harnessHome(), "skills");
    const extra = mkdtempSync(join(tmpdir(), "skills-extra-"));
    skill(join(root, ".harness", "skills"), "web-app", "name: web-app\ndescription: project override");
    skill(extra, "shared", "name: shared\ndescription: from config");
    skill(user, "shared", "name: shared\ndescription: from user");
    skill(user, "personal", "name: personal\ndescription: user skill");
    skill(user, "broken", "name: Not Valid!\ndescription: bad name");
    skill(user, "nodesc", "name: nodesc");
    const skills = discoverSkills(root, { ...MOCK_MODELS, skills: { paths: [extra] } } as any);
    const by = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(by["web-app"].description).toBe("project override");
    expect(by.shared.description).toBe("from config");
    expect(by.personal.source).toBe("user");
    expect(by.broken).toBeUndefined();
    expect(by.nodesc).toBeUndefined();
    const hidden = discoverSkills(root, { skills: { disabled: ["personal"] } } as any);
    expect(hidden.some((s) => s.name === "personal")).toBe(false);
    expect(discoverSkills(root, { skills: { enabled: false } } as any)).toEqual([]);
  });

  it("matches triggers only where auto-activation is allowed", () => {
    const base = mkdtempSync(join(tmpdir(), "skills-"));
    skill(base, "a", "name: a\ndescription: x\ntriggers:\n  - \\bstore\\b");
    skill(base, "b", "name: b\ndescription: x\nauto: always\ntriggers: [store]");
    skill(base, "c", "name: c\ndescription: x\nauto: never\ntriggers: [store]");
    const skills = discoverSkills(tempProject(), { skills: { paths: [base] } } as any).filter((s) =>
      ["a", "b", "c"].includes(s.name),
    );
    expect(matchSkills(skills, "Build a Store", { sandbox: true }).map((s) => s.name)).toEqual(["a", "b"]);
    expect(matchSkills(skills, "Build a store", { sandbox: false }).map((s) => s.name)).toEqual(["b"]);
    expect(matchSkills(skills, "Fix the parser", { sandbox: true })).toEqual([]);
  });

  it("built-in web-app triggers on app briefs but not on unrelated tasks", () => {
    const web = discoverSkills(tempProject()).filter((s) => s.name === "web-app");
    const hit = (t: string) => matchSkills(web, t, { sandbox: true }).length === 1;
    expect(hit("Build Form, a responsive accessories store with a clean product grid")).toBe(true);
    expect(hit("create a snake game for me")).toBe(true);
    expect(hit("Make a landing page for my bakery")).toBe(true);
    expect(hit("write a python script that renames photos by date")).toBe(false);
  });
});

describe("load_skill", () => {
  it("returns the body with reference files, reads references, and refuses escapes", async () => {
    const root = tempProject({ "secret.txt": "top secret" });
    const dir = skill(
      join(root, ".harness", "skills"),
      "demo",
      "name: demo\ndescription: d",
      "Use the reference.",
    );
    mkdirSync(join(dir, "reference"));
    writeFileSync(join(dir, "reference", "a.md"), "Reference A");
    symlinkSync(join(root, "secret.txt"), join(dir, "reference", "leak.md"));
    const ctx = toolCtx(root);
    const body = await loadSkillTool.execute({ name: "demo" }, ctx);
    expect(body.ok).toBe(true);
    expect(body.output).toContain("Use the reference.");
    expect(body.output).toContain("reference/a.md");
    expect(ctx.events).toContainEqual({ type: "log", level: "info", message: "Skill demo loaded" });
    expect((await loadSkillTool.execute({ name: "demo", file: "reference/a.md" }, ctx)).output).toBe(
      "Reference A",
    );
    for (const file of ["../../../secret.txt", "reference/leak.md", join(root, "secret.txt")]) {
      const r = await loadSkillTool.execute({ name: "demo", file }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).not.toContain("top secret");
    }
    const unknown = await loadSkillTool.execute({ name: "nope" }, ctx);
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toContain("web-app");
  });

  it("reads the web-app reference store", async () => {
    const r = await loadSkillTool.execute(
      { name: "web-app", file: "reference/form.html" },
      toolCtx(tempProject()),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Everyday objects");
  });
});

describe("skills in sessions", () => {
  it("injects matching skills into sandbox prompts and lists all skills", async () => {
    const mock = new MockProvider({ replies: [{ text: "Done." }] });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ sandbox: { name: "store" } });
    await s.chat("Build a responsive accessories store with a working bag");
    const system = mock.calls[0].messages[0].content;
    expect(system).toContain("# Skills");
    expect(system).toContain("**web-app** (already loaded below)");
    expect(system).toContain('<skill name="web-app">');
    expect(system).toContain("## Finish checklist");
    expect(mock.calls[0].tools?.map((t) => t.name)).toContain("load_skill");
    expect(s.events).toContainEqual(
      expect.objectContaining({ type: "log", message: "Skill web-app activated" }),
    );
    const activated = s.events.findIndex((e) => e.type === "skill.activated");
    expect(s.events[activated]).toMatchObject({ name: "web-app", source: "builtin" });
    expect(s.events[activated]).toHaveProperty("content", expect.stringContaining("## Finish checklist"));
    // Shown inside the turn, after the user's message.
    expect(activated).toBeGreaterThan(s.events.findIndex((e) => e.type === "message.end"));
  });

  it("only lists skills in project sessions and unrelated sandbox tasks", async () => {
    const mock = new MockProvider({ replies: [{ text: "Done." }, { text: "Done." }] });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    await h.createSession({ projectPath: tempProject({ "a.txt": "a" }) }).chat("Build a store page");
    await h.createSession({ sandbox: true }).chat("write a python script that sorts numbers");
    for (const call of mock.calls) {
      expect(call.messages[0].content).toContain("**web-app**:");
      expect(call.messages[0].content).not.toContain('<skill name="web-app">');
    }
  });

  it("follows skills.enabled = false", async () => {
    const mock = new MockProvider({ replies: [{ text: "Done." }] });
    const h = new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MOCK_MODELS, skills: { enabled: false } },
    });
    await h.createSession({ sandbox: true }).chat("Build a store");
    expect(mock.calls[0].messages[0].content).not.toContain("# Skills");
  });

  it("does not crash on project skill folders that are not readable", async () => {
    const root = tempProject();
    writeFileSync(join(root, "file"), "x");
    mkdirSync(join(root, ".harness", "skills"), { recursive: true });
    symlinkSync(join(root, "missing"), join(root, ".harness", "skills", "dangling"));
    expect(skillsIndex(discoverSkills(root))).toContain("web-app");
  });
});

describe("user-selected skills", () => {
  const harness = (mock: MockProvider) =>
    new Harness({
      providers: { mock },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });

  it("ships the mattpocock/skills set with valid frontmatter and user-only flags", () => {
    const all = discoverSkills(tempProject());
    const names = all.map((s) => s.name);
    for (const n of ["tdd", "grill-me", "grilling", "diagnosing-bugs", "to-spec", "handoff", "code-review"])
      expect(names).toContain(n);
    expect(all.find((s) => s.name === "grill-me")).toMatchObject({ userOnly: true, auto: "never" });
    expect(all.find((s) => s.name === "tdd")).toMatchObject({ userOnly: false });
    expect(all.find((s) => s.name === "teach")?.argumentHint).toBe("What would you like to learn about?");
    // escaped quotes inside a double-quoted description
    expect(all.find((s) => s.name === "code-review")?.description).toContain('"review since X"');
    // user-only skills stay out of the agent's index
    const index = skillsIndex(all);
    expect(index).toContain("**tdd**");
    expect(index).not.toContain("**grill-me**");
    expect(skillsIndex(all, ["grill-me"])).toContain("**grill-me** (already loaded below)");
  });

  it("injects selected skills into a fresh system prompt and records them", async () => {
    const mock = new MockProvider({ replies: [{ text: "Done." }] });
    const s = harness(mock).createSession({ projectPath: tempProject({ "a.txt": "a" }) });
    await s.chat("Plan the new cache", undefined, { skills: ["grill-me"] });
    const system = mock.calls[0].messages[0].content;
    expect(system).toContain('<skill name="grill-me">');
    expect(system).toContain("**grill-me** (already loaded below)");
    const end = s.events.find((e) => e.type === "message.end");
    expect(end).toMatchObject({ text: "Plan the new cache", skills: ["grill-me"] });
    expect(s.events).toContainEqual(
      expect.objectContaining({ type: "skill.activated", name: "grill-me", reason: "selected" }),
    );
  });

  it("brings the skills a selected redirect skill hands off to, in load_skill terms", async () => {
    const mock = new MockProvider({ replies: [{ text: "Done." }] });
    const s = harness(mock).createSession({ projectPath: tempProject({ "a.txt": "a" }) });
    await s.chat("Plan the new cache", undefined, { skills: ["grill-with-docs"] });
    const system = mock.calls[0].messages[0].content;
    expect(system).toContain('<skill name="grilling">');
    expect(system).toContain('<skill name="domain-modeling">');
    expect(system).toContain("Interview the user relentlessly");
    expect(system).not.toContain("Skill tool");
    expect(system).toContain("Call `load_skill` twice");
    expect(s.events).toContainEqual(
      expect.objectContaining({ type: "skill.activated", name: "grilling", reason: "matched" }),
    );
    // the user's selection is recorded as is
    expect(s.events.find((e) => e.type === "message.end")).toMatchObject({ skills: ["grill-with-docs"] });
  });

  it("only inlines hand-offs of pure redirect skills", () => {
    const all = discoverSkills(tempProject());
    const pick = (...n: string[]) => all.filter((s) => n.includes(s.name));
    expect(delegatedSkills(pick("grill-me"), all).map((s) => s.name)).toEqual(["grilling"]);
    // grilling is already selected: not duplicated
    expect(delegatedSkills(pick("grill-me", "grilling"), all)).toEqual([]);
    // wayfinder mentions several skills conditionally; those stay on demand via load_skill
    expect(delegatedSkills(pick("wayfinder"), all)).toEqual([]);
    expect(skillReferences(pick("wayfinder")[0], all)).toEqual(
      expect.arrayContaining(["research", "prototype", "grilling", "domain-modeling"]),
    );
  });

  it("attaches selected skills to the user message of a continued conversation, for that turn only", async () => {
    const mock = new MockProvider({ replies: [{ text: "One." }, { text: "Two." }, { text: "Three." }] });
    const s = harness(mock).createSession({ projectPath: tempProject({ "a.txt": "a" }) });
    await s.chat("hello");
    await s.chat("fix the parser", undefined, { skills: ["tdd"] });
    const user = mock.calls[1].messages.at(-1)!;
    expect(user.role).toBe("user");
    expect(user.content).toMatch(/^<skill name="tdd">/);
    expect(user.content).toContain("fix the parser");
    await s.chat("thanks");
    expect(mock.calls[2].messages.at(-1)!.content).toBe("thanks");
  });

  it("rejects unknown skills before the turn starts", async () => {
    const mock = new MockProvider({ replies: [{ text: "Done." }] });
    const s = harness(mock).createSession({ projectPath: tempProject({ "a.txt": "a" }) });
    await expect(s.chat("x", undefined, { skills: ["nope"] })).rejects.toThrow("Unknown skill: nope");
    expect(s.status).not.toBe("running");
    expect(mock.calls).toHaveLength(0);
  });
});
