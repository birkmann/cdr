import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { Harness, MockProvider, findChrome } from "@harness/core";
import { main } from "../src/index.js";
import { runRecreate } from "@harness/recreate";
import { serveSite } from "../../capture/test/sites/serve.js";
import { fakeDriver } from "../../recreate/test/fake-driver.js";

const sink = () => {
  let text = "";
  return {
    w: new Writable({
      write(c, _e, cb) {
        text += c.toString();
        cb();
      },
    }),
    get text() {
      return text;
    },
  };
};

describe("cdr recreate", () => {
  it("rejects bad flags with a usage message", async () => {
    const err = sink();
    const code = await main(["recreate"], { stdout: sink().w, stderr: err.w });
    expect(code).toBe(1);
    expect(err.text).toMatch(/usage: cdr recreate/);
    const err2 = sink();
    expect(
      await main(["recreate", "https://x.de", "--widths", "abc"], { stdout: sink().w, stderr: err2.w }),
    ).toBe(1);
    expect(err2.text).toMatch(/--widths/);
  });

  it.skipIf(!findChrome())(
    "recreates the fixture site with --yes --json: JSONL events, consent logged as automatic, gates pass",
    async () => {
      const site = await serveSite("acme");
      const dir = mkdtempSync(join(tmpdir(), "cdr-recreate-"));
      writeFileSync(
        join(dir, "cdr.config.json"),
        JSON.stringify({ recreate: { allowLocal: true, respectRobots: false } }),
      );
      const harness = new Harness({
        providers: { mock: new MockProvider() },
        skipGlobalConfig: true,
        loadEnv: false,
        configOverrides: {
          providers: { mock: { type: "mock" } },
          models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
        },
      });
      const out = sink();
      try {
        const code = await main(
          [
            "recreate",
            site.url,
            "--widths",
            "390",
            "--yes",
            "--json",
            "--no-checks",
            "--no-repair",
            "-C",
            dir,
          ],
          { harness, stdout: out.w, stderr: sink().w },
        );
        const events = out.text
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const types = events.map((e) => e.type);
        expect(types).toContain("recreate.started");
        expect(types).toContain("recreate.measured");
        expect(events.find((e) => e.type === "permission.resolved")).toMatchObject({ auto: true });
        const fin = events.find((e) => e.type === "recreate.finished");
        expect(fin.status).toBe("success");
        expect(code).toBe(0);
      } finally {
        await site.close();
      }
    },
    180_000,
  );
});

describe("cdr recreate --run (resume)", () => {
  const harness = () =>
    new Harness({
      providers: { mock: new MockProvider() },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: {
        providers: { mock: { type: "mock" } },
        models: { executor: "mock/m", planner: "mock/m", reviewer: "mock/m", summarizer: "mock/m" },
      },
    });

  it("refuses a --run that is not a run id", async () => {
    const err = sink();
    const dir = mkdtempSync(join(tmpdir(), "cdr-recreate-"));
    const code = await main(["recreate", "--run", "../../..", "--from", "build", "-C", dir], {
      harness: harness(),
      stdout: sink().w,
      stderr: err.w,
    });
    expect(code).toBe(1);
    expect(err.text).toMatch(/--run: .* is not a run id/);
  });

  it("resumes an earlier run without a URL (the manifest's URL, consent kept)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdr-recreate-"));
    const first = await runRecreate(
      { url: "https://acme.example/", widths: [390] },
      {
        projectRoot: dir,
        driver: fakeDriver([]),
        consent: async () => ({ by: "user", at: new Date().toISOString(), mode: "ask" }),
        sectionChecks: false,
      },
      { stopAfter: "build" },
    );
    expect(first.status).toBe("success");
    const out = sink();
    const code = await main(
      ["recreate", "--run", first.runId, "--from", "components", "--to", "tokens", "--json", "-C", dir],
      { harness: harness(), stdout: out.w, stderr: sink().w },
    );
    const events = out.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === "recreate.started")).toMatchObject({
      url: "https://acme.example/",
      consent: { by: "user" },
    });
    // consent was recorded earlier: nobody is asked again
    expect(events.some((e) => e.type === "permission.request")).toBe(false);
    // the later stages ran (the components gate may fail on a one-width capture; that is not the point here)
    const stages = events
      .filter((e) => e.type === "recreate.stage" && e.status === "done")
      .map((e) => e.stage);
    expect(stages).toEqual(["components", "system", "ds-export"]);
    expect(events.find((e) => e.type === "recreate.finished").summary).not.toMatch(/Invalid URL/);
    expect(existsSync(join(dir, first.dir, "out/tokens/tokens.json"))).toBe(true);
  });
});

describe("renderer: recreate sections", () => {
  it("says why a section is below its threshold and that its repair was undone", async () => {
    const { Renderer } = await import("../src/render.js");
    const out = sink();
    const r = new Renderer(out.w);
    const base = {
      v: 1 as const,
      seq: 1,
      ts: "",
      sessionId: "s",
      runId: "r",
      total: 2,
      kind: "hero",
      label: "hero",
    };
    r.render({
      ...base,
      type: "recreate.section",
      index: 0,
      id: "header",
      status: "ok",
      pixel: 0.001,
      reason: "pixel",
    });
    r.render({
      ...base,
      type: "recreate.section",
      index: 1,
      id: "hero",
      status: "below-threshold",
      pixel: 0.002,
      reason: "responsive",
      reverted: true,
    });
    const lines = out.text.split("\n");
    expect(lines[0]).toContain("header");
    expect(lines[0]).not.toContain("(pixel)");
    expect(lines[1]).toMatch(/hero.*below-threshold 0\.2 %.*\(responsive\).*repair undone/);
  });
});
