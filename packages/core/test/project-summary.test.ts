import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, generateProjectSummary, parseProjectSummary, projectContext } from "@harness/core";

describe("project summaries", () => {
  it("builds context from the listing, README, manifests and chat titles", () => {
    const root = mkdtempSync(join(tmpdir(), "proj-sum-"));
    writeFileSync(join(root, "README.md"), "# Snake\nA snake game in the browser.");
    writeFileSync(join(root, "package.json"), '{"name":"snake"}');
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, ".env"), "SECRET=1");
    const ctx = projectContext(root, ["Create a snake game", "Create a snake game", " "]);
    expect(ctx).toContain("src/");
    expect(ctx).toContain("A snake game in the browser.");
    expect(ctx).toContain('{"name":"snake"}');
    expect(ctx).not.toContain("node_modules");
    expect(ctx).not.toContain(".env");
    expect(ctx.match(/- Create a snake game/g)).toHaveLength(1);
    expect(projectContext(join(root, "src"))).toContain("The folder is empty.");
  });

  it("parses fenced or chatty JSON and rejects replies without a title", () => {
    expect(parseProjectSummary('```json\n{"title":"Snake game.","summary":"A game."}\n```')).toEqual({
      title: "Snake game",
      summary: "A game.",
    });
    expect(parseProjectSummary('Sure! {"title": "X"}')).toEqual({ title: "X", summary: "" });
    expect(parseProjectSummary('{"summary":"no title"}')).toBeNull();
    expect(parseProjectSummary("no json")).toBeNull();
  });

  it("asks the model and returns its title and summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "proj-sum-"));
    const provider = new MockProvider({
      handler: () => ({ text: '{"title":"Accessories store","summary":"A responsive storefront."}' }),
    });
    await expect(generateProjectSummary({ root, provider, model: "m" })).resolves.toEqual({
      title: "Accessories store",
      summary: "A responsive storefront.",
    });
    const bad = new MockProvider({ handler: () => ({ text: "I can't tell." }) });
    await expect(generateProjectSummary({ root, provider: bad, model: "m" })).rejects.toThrow();
  });
});
