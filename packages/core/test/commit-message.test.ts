import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, cleanCommitMessage, commitDiff, generateCommitMessage } from "@harness/core";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "commit-msg-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "feat: add a");
  return { dir, git };
}

describe("commit messages", () => {
  it("cleans model output", () => {
    expect(cleanCommitMessage("```\nFix login redirect\n- keep the return URL\n```")).toBe(
      "Fix login redirect\n\n- keep the return URL",
    );
    expect(cleanCommitMessage('Commit message: "Update docs"')).toBe("Update docs");
    expect(cleanCommitMessage("Add x\n\n\n\nBody")).toBe("Add x\n\nBody");
  });

  it("describes staged changes first, otherwise all changes, and passes the repo's style", async () => {
    const { dir, git } = repo();
    expect(commitDiff(dir)).toBeNull();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    expect(commitDiff(dir)?.scope).toBe("all");
    git("add", "b.txt");
    const staged = commitDiff(dir)!;
    expect(staged.scope).toBe("staged");
    expect(staged.diff).toContain("b.txt");
    expect(staged.diff).not.toContain("a.txt");

    const mock = new MockProvider({ replies: [{ text: "```\nfeat: add b\n```" }] });
    const r = await generateCommitMessage({ root: dir, provider: mock, model: "m" });
    expect(r).toEqual({ message: "feat: add b", scope: "staged" });
    const prompt = mock.calls[0].messages.at(-1)!.content;
    expect(prompt).toContain("feat: add a");
    expect(prompt).toContain("+new");
  });

  it("refuses when there is nothing to describe", async () => {
    const { dir } = repo();
    await expect(
      generateCommitMessage({ root: dir, provider: new MockProvider(), model: "m" }),
    ).rejects.toThrow(/no changes/);
  });
});
