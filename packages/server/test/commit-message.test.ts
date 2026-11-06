import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness, MockProvider } from "@harness/core";
import { startServer, type StartedServer } from "@harness/server";
import { createClient, HarnessApiError } from "@harness/client";

let srv: StartedServer;
let repo: string;
const mock = new MockProvider({
  handler: (req) =>
    String(req.messages[0]?.content).includes("project picker")
      ? { text: '{"title":"Greeting demo","summary":"Says hello."}' }
      : { text: "Update the greeting\n\nSay hello to everyone." },
});

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "srv-commit-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(repo, "hello.txt"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const harness = new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: { providers: { mock: { type: "mock" } }, models: { executor: "mock/m" } } as never,
  });
  srv = await startServer({ harness, port: 0, token: "t" });
});
afterAll(async () => {
  await srv?.close();
});

describe("POST /commit-message", () => {
  it("generates a message for the repository's changes", async () => {
    const client = createClient({ baseUrl: srv.url, token: "t" });
    await expect(client.commitMessage(repo)).rejects.toMatchObject({ status: 400 });
    writeFileSync(join(repo, "hello.txt"), "hello everyone\n");
    const r = await client.commitMessage(repo);
    expect(r).toEqual({
      message: "Update the greeting\n\nSay hello to everyone.",
      scope: "all",
      model: "mock/m",
    });
    await expect(client.commitMessage(join(repo, "missing"))).rejects.toBeInstanceOf(HarnessApiError);
    expect((await fetch(`${srv.url}/commit-message`, { method: "POST" })).status).toBe(401);
  });
});

describe("POST /project-summary", () => {
  it("returns an AI title and summary for a project folder", async () => {
    const client = createClient({ baseUrl: srv.url, token: "t" });
    expect(await client.projectSummary(repo)).toEqual({
      title: "Greeting demo",
      summary: "Says hello.",
      model: "mock/m",
    });
    await expect(client.projectSummary(join(repo, "missing"))).rejects.toMatchObject({ status: 404 });
    expect((await fetch(`${srv.url}/project-summary`, { method: "POST" })).status).toBe(401);
  });
});
