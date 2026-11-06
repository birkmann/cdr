import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunDir, runRecreate } from "@harness/recreate";
import { fakeDriver } from "../../recreate/test/fake-driver.js";
import { describe, expect, it } from "vitest";
import type { EventBody } from "@harness/protocol";
import {
  Harness,
  MockProvider,
  askConsent,
  discoverSkills,
  matchSkills,
  recreateTools,
  repairSection,
  resumeRequest,
} from "@harness/core";
import { reduceSession, initialSessionState } from "@harness/client";
import { MOCK_MODELS, tempProject, toolCtx } from "./helpers.js";

describe("consent gate", () => {
  it("asks with risk high in ask mode; deny means no consent, 'always' is not remembered", async () => {
    const ctx = toolCtx(tempProject());
    const asked: unknown[] = [];
    ctx.permissionMode = () => "ask";
    ctx.requestPermission = async (tool, _args, risk, reason) => {
      asked.push({ tool, risk, reason });
      return asked.length === 1 ? "deny" : "always";
    };
    expect(await askConsent(ctx, { url: "x" }, "Recreates x 1:1")).toBeNull();
    expect(asked[0]).toMatchObject({ tool: "recreate_capture", risk: "high" });
    expect(await askConsent(ctx, { url: "x" }, "r")).toMatchObject({ by: "user", mode: "ask" });
    // asked again: an "always" answer allowed one run only
    expect(await askConsent(ctx, { url: "x" }, "r")).toMatchObject({ by: "user" });
    expect(asked).toHaveLength(3);
  });

  it("is answered automatically in yolo mode and with --yes, and the log still records it", async () => {
    const ctx = toolCtx(tempProject());
    ctx.permissionMode = () => "yolo";
    const c = await askConsent(ctx, { url: "x" }, "reason");
    expect(c).toMatchObject({ by: "auto", mode: "yolo" });
    const types = (ctx.events as EventBody[]).map((e) => e.type);
    expect(types).toEqual(["permission.request", "permission.resolved"]);
    expect((ctx.events as EventBody[])[1]).toMatchObject({ decision: "allow", auto: true });
    const ctx2 = toolCtx(tempProject());
    expect(await askConsent(ctx2, {}, "r", true)).toMatchObject({ by: "auto", mode: "yes" });
  });
});

describe("recreate tools and skill", () => {
  it("registers the six tools unless recreate.enabled is false; capture is self-gated", () => {
    const names = recreateTools().map((t) => t.name);
    expect(names).toEqual([
      "recreate_capture",
      "recreate_build",
      "recreate_measure",
      "recreate_components",
      "recreate_convert",
      "recreate_section",
    ]);
    expect(recreateTools(false)).toEqual([]);
    expect(recreateTools().find((t) => t.name === "recreate_capture")!.selfGated).toBe(true);
    const h = new Harness({ skipGlobalConfig: true, loadEnv: false, configOverrides: MOCK_MODELS });
    expect(
      h
        .createSession({ projectPath: tempProject() })
        .allTools()
        .map((t) => t.name),
    ).toContain("recreate_capture");
    const off = new Harness({
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: { ...MOCK_MODELS, recreate: { enabled: false } },
    });
    expect(
      off
        .createSession({ projectPath: tempProject() })
        .allTools()
        .map((t) => t.name),
    ).not.toContain("recreate_capture");
  });

  it("never injects the recreate-url skill by triggers: a plain 'bvg.de' brief stays with web-app", () => {
    const skills = discoverSkills(tempProject());
    const skill = skills.find((s) => s.name === "recreate-url");
    expect(skill?.auto).toBe("never");
    for (const task of ["bvg.de", "recreate https://bvg.de exactly 1:1", "a site like bvg.de"])
      expect(matchSkills(skills, task, { sandbox: true }).map((s) => s.name)).not.toContain("recreate-url");
    expect(
      matchSkills(skills, "build a website inspired by bvg.de", { sandbox: true }).map((s) => s.name),
    ).toContain("web-app");
  });

  it("recreate_capture refuses without consent and captures nothing", async () => {
    const root = tempProject();
    const ctx = toolCtx(root);
    ctx.permissionMode = () => "ask";
    ctx.requestPermission = async () => "deny";
    const res = await recreateTools()[0].execute({ url: "https://example.com/" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/Consent was not given/);
  });
});

describe("recreate tools: run ids, manifests, expected failures", () => {
  const tool = (name: string) => recreateTools().find((t) => t.name === name)!;
  const consent = async () => ({ by: "auto" as const, at: "now", mode: "yes" as const });

  it("refuses run ids that are paths, missing and corrupt runs, without throwing", async () => {
    const root = tempProject();
    const ctx = toolCtx(root);
    for (const name of ["recreate_build", "recreate_measure", "recreate_components", "recreate_section"]) {
      const r = await tool(name).execute({ run: "../../..", id: "x", to: "tokens" }, ctx);
      expect(r, name).toMatchObject({ ok: false, output: expect.stringMatching(/not a run id/) });
    }
    expect(await tool("recreate_build").execute({ run: "nope" }, ctx)).toMatchObject({ ok: false });
    const dir = new RunDir(root, "broken");
    dir.write("manifest.json", "{ not json");
    expect(await tool("recreate_build").execute({ run: "broken" }, ctx)).toMatchObject({
      ok: false,
      output: expect.stringMatching(/unreadable manifest/),
    });
    // a run without a scene: recreate_section reports it
    dir.writeJson("manifest.json", { id: "broken", request: { url: "https://acme.example/" }, stages: {} });
    expect(await tool("recreate_section").execute({ run: "broken", id: "hero" }, ctx)).toMatchObject({
      ok: false,
      output: expect.stringMatching(/sections\.json is missing/),
    });
  });

  it("recreate_measure writes files: not read-only, no ignored target parameter", () => {
    const m = tool("recreate_measure");
    expect(m.readOnly).toBe(false);
    expect(Object.keys((m.parameters as { properties: object }).properties)).toEqual(["run"]);
  });

  it("never takes out, run or consent from a manifest the model could have written", async () => {
    const m = {
      request: { url: "https://acme.example/", out: "../escape", run: "../x", to: ["static"], widths: [390] },
      consent: { by: "user", at: "now", mode: "ask" },
    } as never;
    const q = resumeRequest(m, "r1", "build");
    expect(q).toEqual({
      url: "https://acme.example/",
      run: "r1",
      from: "build",
      to: ["static"],
      widths: [390],
    });
    // end to end: a tampered manifest's out is ignored when a tool resumes the run
    const root = join(tempProject(), "p");
    mkdirSync(root);
    const first = await runRecreate(
      { url: "https://acme.example/", widths: [390] },
      { projectRoot: root, driver: fakeDriver([]), consent, sectionChecks: false },
      { stopAfter: "build" },
    );
    const dir = new RunDir(root, first.runId);
    const man = dir.manifest();
    man.request.out = "../escape";
    dir.saveManifest(man);
    const r = await tool("recreate_components").execute({ run: first.runId }, toolCtx(root));
    expect(r.ok, r.output).toBe(true);
    expect(existsSync(join(dirname(root), "escape"))).toBe(false);
  });

  it("records consent as automatic when the session approves permissions itself", async () => {
    const ctx = toolCtx(tempProject());
    ctx.permissionMode = () => "ask";
    ctx.autoApprovesPermissions = () => true;
    ctx.requestPermission = async () => {
      throw new Error("not asked");
    };
    expect(await askConsent(ctx, {}, "r")).toMatchObject({ by: "auto", mode: "yes" });
  });
});

describe("repair (bounded model call)", () => {
  const PAGE = `<html><head></head><body>
<!-- section:hero -->
<section data-section="hero" class="hero"><h1 class="t">Gear for every trail</h1><img src="assets/a.png" alt=""></section>
<!-- /section -->
<!-- section:footer -->
<footer data-section="footer" class="f">© Acme</footer>
<!-- /section -->
</body></html>`;
  const setup = () => {
    const root = tempProject();
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(join(root, "out/index.html"), PAGE);
    writeFileSync(join(root, "out/styles.css"), ".hero { display: flex; }\n.t { font-size: 40px; }\n");
    return root;
  };
  const task = {
    runId: "r",
    file: "out/index.html",
    section: { id: "hero", label: "Gear", kind: "hero", index: 0 },
    attempt: 1,
    maxAttempts: 2,
    threshold: 0.03,
    widths: [{ width: 390, pixel: 0.2, live: Buffer.from("png"), out: Buffer.from("png") }],
  };

  it("applies scoped CSS and a markup patch that keeps copy and pictures; sends both crops", async () => {
    const root = setup();
    const ctx = toolCtx(root);
    const mock = new MockProvider({
      replies: [
        {
          text: JSON.stringify({
            css: '[data-section="hero"] .t { font-size: 36px; }',
            html: '<section data-section="hero" class="hero"><div class="w"><h1 class="t">Gear for every trail</h1></div><img src="assets/a.png" alt=""></section>',
            note: "smaller heading",
          }),
        },
      ],
    });
    ctx.complete = async (_role, messages) => {
      let text = "";
      for await (const e of mock.stream({ model: "m", messages })) if (e.type === "text") text += e.text;
      return text;
    };
    expect(await repairSection(ctx, "executor", task)).toBe(true);
    expect(readFileSync(join(root, "out/styles.css"), "utf8")).toContain("font-size: 36px");
    const html = readFileSync(join(root, "out/index.html"), "utf8");
    expect(html).toContain('<div class="w">');
    expect(html).toContain("© Acme");
    const sent = mock.calls[0].messages[1];
    expect(sent.role === "user" && sent.images?.length).toBe(2);
  });

  it("rejects markup that changes the copy, swaps a picture or adds a script", async () => {
    for (const html of [
      '<section data-section="hero"><h1>Buy now</h1><img src="assets/a.png"></section>',
      '<section data-section="hero"><h1>Gear for every trail</h1><img src="https://evil/x.png"></section>',
      '<section data-section="hero"><h1>Gear for every trail</h1><img src="assets/a.png"><script>x()</script></section>',
    ]) {
      const root = setup();
      const ctx = toolCtx(root);
      ctx.complete = async () => JSON.stringify({ html });
      expect(await repairSection(ctx, "executor", task)).toBe(false);
      expect(readFileSync(join(root, "out/index.html"), "utf8")).toBe(PAGE);
    }
  });
});

describe("client reducer", () => {
  it("merges a run's events across tool calls into one view", () => {
    let s = initialSessionState();
    let seq = 0;
    const ev = (body: EventBody) => ({
      ...body,
      v: 1 as const,
      seq: ++seq,
      ts: new Date().toISOString(),
      sessionId: "s",
    });
    const runId = "r1";
    for (const body of [
      {
        type: "recreate.started",
        runId,
        url: "https://a/",
        widths: [],
        targets: ["static"],
        consent: { by: "user", at: "", mode: "ask" },
        dir: ".harness/recreate/r1",
      },
      { type: "recreate.stage", runId, stage: "capture", status: "done", ms: 10 },
      { type: "recreate.stage", runId, stage: "build", status: "running" },
      {
        type: "recreate.section",
        runId,
        index: 0,
        total: 2,
        id: "header",
        kind: "header",
        label: "header",
        status: "building",
      },
      {
        type: "recreate.section",
        runId,
        index: 0,
        total: 2,
        id: "header",
        kind: "header",
        label: "header",
        status: "ok",
        pixel: 0.01,
      },
      {
        type: "recreate.measured",
        runId,
        target: "static",
        widths: [],
        gates: [{ name: "pixel", pass: true }],
        comparePath: "c.html",
      },
      { type: "recreate.finished", runId, status: "success", outputs: [{ target: "static", path: "out" }] },
    ] as EventBody[])
      s = reduceSession(s, ev(body));
    const run = s.recreate!.runs[runId];
    expect(run.status).toBe("success");
    expect(run.stages.capture.status).toBe("done");
    expect(run.sections).toEqual([
      { index: 0, total: 2, id: "header", kind: "header", label: "header", status: "ok", pixel: 0.01 },
    ]);
    expect(run.comparePath).toBe("c.html");
    expect(s.timeline.filter((t) => t.kind === "event")).toHaveLength(2);
  });
});

describe("recreate evals", () => {
  it("loads the recreate suite and checks a run's gates from its manifest", async () => {
    const { loadEvalTasks, recreateGateCheck, WORKFLOW_PRESETS } = await import("@harness/core");
    const tasks = loadEvalTasks(join(__dirname, "../../../evals"), undefined, "recreate");
    expect(tasks.map((t) => t.id)).toEqual([
      "30-recreate-fixture",
      "33-plain-brief-no-copy",
    ]);
    expect(WORKFLOW_PRESETS.recreate.phases[0].tools).toContain("recreate_capture");
    const root = tempProject();
    expect(recreateGateCheck(root, { type: "recreateGate" }).passed).toBe(false);
    const dir = join(root, ".harness/recreate/r1");
    mkdirSync(dir, { recursive: true });
    const manifest = (pixel: boolean) =>
      JSON.stringify({
        id: "r1",
        createdAt: "2026-11-05T00:00:00Z",
        status: "success",
        gates: [
          { name: "pixel", pass: pixel, detail: "390px 0.4 %" },
          { name: "text", pass: true },
        ],
      });
    writeFileSync(join(dir, "manifest.json"), manifest(true));
    expect(recreateGateCheck(root, { type: "recreateGate", gates: ["pixel", "text"] }).passed).toBe(true);
    expect(recreateGateCheck(root, { type: "recreateGate", gates: ["interactions"] }).detail).toMatch(
      /not measured/,
    );
    writeFileSync(join(dir, "manifest.json"), manifest(false));
    expect(recreateGateCheck(root, { type: "recreateGate" }).passed).toBe(false);
  });
});
