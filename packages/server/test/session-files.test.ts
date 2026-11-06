import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sessionFileScope } from "../src/session-files.js";

describe("session file scope", () => {
  it("lists the outputs of this session's recreation runs although .harness is hidden and excluded from git", () => {
    const root = mkdtempSync(join(tmpdir(), "files-"));
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".git/info/exclude"), ".harness/recreate/\n");
    writeFileSync(join(root, "index.html"), "<p>own</p>");
    const run = join(root, ".harness/recreate/r1");
    mkdirSync(join(run, "out/static/assets"), { recursive: true });
    mkdirSync(join(run, "compare"), { recursive: true });
    mkdirSync(join(run, "capture"), { recursive: true });
    writeFileSync(join(run, "out/static/index.html"), "<p>copy</p>");
    writeFileSync(join(run, "out/static/assets/a.png"), "png");
    writeFileSync(join(run, "compare/index.html"), "compare");
    writeFileSync(join(run, "capture/390.snapshot.json"), "{}");
    const other = join(root, ".harness/recreate/r2/out");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "index.html"), "other run");
    const session = {
      projectRoot: root,
      events: [{ type: "recreate.started", runId: "r1", dir: ".harness/recreate/r1" }],
    } as never;
    const files = sessionFileScope(session).list();
    expect(files).toEqual(
      expect.arrayContaining([
        "index.html",
        ".harness/recreate/r1/out/static/index.html",
        ".harness/recreate/r1/out/static/assets/a.png",
        ".harness/recreate/r1/compare/index.html",
      ]),
    );
    // capture data and other sessions' runs stay out
    expect(files.some((f) => f.includes("capture/") || f.includes("/r2/"))).toBe(false);
  });
});
