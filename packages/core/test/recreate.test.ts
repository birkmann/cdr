import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RunDir, runRecreate } from "@harness/recreate";
import { fakeDriver } from "../../recreate/test/fake-driver.js";
import { describe, expect, it } from "vitest";
import type { EventBody } from "@harness/protocol";
import {
  Harness,
  MockProvider,
  askConsent,
  attemptLines,
  compareScores,
  discoverSkills,
  matchSkills,
  measureRefusal,
  recordMeasure,
  recreateInSession,
  recreateTools,
  repairSection,
  resetAttempts,
  restoredMeasured,
  resumeRequest,
  scoreOf,
} from "@harness/core";
import type { MeasureReport } from "@harness/measure";
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
    expect(await repairSection(ctx, "executor", task)).toEqual({ changed: true, note: "smaller heading" });
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
      const r = await repairSection(ctx, "executor", task);
      expect(r.changed).toBe(false);
      expect(r.rejected?.length).toBeGreaterThan(0);
      expect(readFileSync(join(root, "out/index.html"), "utf8")).toBe(PAGE);
    }
  });

  it("rejects markup that brings its own styles", async () => {
    const root = setup();
    const ctx = toolCtx(root);
    ctx.complete = async () =>
      JSON.stringify({
        html: '<section data-section="hero" class="hero"><h1 class="t" style="position:absolute;top:40px">Gear for every trail</h1><img src="assets/a.png" alt=""></section>',
      });
    const r = await repairSection(ctx, "executor", task);
    expect(r.rejected?.join()).toMatch(/style attributes/);
    expect(readFileSync(join(root, "out/index.html"), "utf8")).toBe(PAGE);
  });

  // the flow lint's corpus (packages/measure/test/corpus): patches that fit the checked widths, and patches that flow
  const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "../../measure/test/corpus");
  const corpus = (kind: string) =>
    readdirSync(join(CORPUS, kind))
      .filter((f) => f.endsWith(".css"))
      .map((f) => ({ name: f, css: readFileSync(join(CORPUS, kind, f), "utf8") }));
  const HERO = `<html><head></head><body>
<!-- section:hero -->
<section data-section="hero" class="hero-row"><nav class="hero-nav"></nav><h1 class="hero-title">Gear for every trail</h1><p class="hero-copy">Since 1987</p><div class="hero-grid"></div><img class="hero-media" src="assets/a.png" alt=""></section>
<!-- /section -->
</body></html>`;
  const heroSetup = () => {
    const root = tempProject();
    mkdirSync(join(root, "out"), { recursive: true });
    writeFileSync(join(root, "out/index.html"), HERO);
    writeFileSync(join(root, "out/styles.css"), ".hero-title { font-size: 40px; }\n");
    return root;
  };
  const heroTask = { ...task, boundaries: [768, 1024] };

  it("rejects every patch of the cheat corpus with a reason and writes nothing; the reasons reach the next attempt", async () => {
    const cheats = corpus("cheat");
    expect(cheats.length).toBeGreaterThanOrEqual(10);
    for (const f of cheats) {
      const root = heroSetup();
      const ctx = toolCtx(root);
      const mock = new MockProvider({
        replies: [
          { text: JSON.stringify({ css: f.css, note: "fit" }) },
          { text: JSON.stringify({ note: "nothing" }) },
        ],
      });
      ctx.complete = async (_role, messages) => {
        let text = "";
        for await (const e of mock.stream({ model: "m", messages })) if (e.type === "text") text += e.text;
        return text;
      };
      const r = await repairSection(ctx, "executor", heroTask);
      expect(r.changed, f.name).toBe(false);
      expect(r.rejected?.[0], f.name).toMatch(new RegExp(`^${f.name.split(".")[0]}:`));
      expect(readFileSync(join(root, "out/index.html"), "utf8")).toBe(HERO);
      expect(readFileSync(join(root, "out/styles.css"), "utf8")).toBe(".hero-title { font-size: 40px; }\n");
      // the second attempt is told why the first one was not written
      await repairSection(ctx, "executor", { ...heroTask, attempt: 2, rejected: r.rejected });
      const second = mock.calls[1]!.messages[1]!;
      expect(typeof second.content === "string" && second.content).toContain(
        `Your previous patch was rejected and not written:\n- ${r.rejected![0]}`,
      );
    }
  });

  it("writes every patch of the honest corpus", async () => {
    for (const f of corpus("honest")) {
      const root = heroSetup();
      const ctx = toolCtx(root);
      ctx.complete = async () => JSON.stringify({ css: f.css, note: "flows" });
      const r = await repairSection(ctx, "executor", heroTask);
      expect(r, f.name).toEqual({ changed: true, note: "flows" });
      expect(readFileSync(join(root, "out/styles.css"), "utf8")).toContain(
        "/* repair: section hero, attempt 1 */",
      );
    }
  });

  it("tells the model what breaks between the captured widths and why the section is repaired", async () => {
    const root = heroSetup();
    const ctx = toolCtx(root);
    let prompt = "";
    let system = "";
    ctx.complete = async (_role, messages) => {
      system = String(messages[0]!.content);
      prompt = String(messages[1]!.content);
      return JSON.stringify({});
    };
    await repairSection(ctx, "executor", {
      ...heroTask,
      reason: "responsive",
      sweep: [{ width: 488, issues: ['"Summit tent" overlaps "Learn more"'] }],
    });
    expect(prompt).toContain("its layout breaks at widths between the captured ones");
    expect(prompt).toContain('- 488px: "Summit tent" overlaps "Learn more"');
    expect(system).toMatch(
      /checked again at the captured widths and at many widths between them that you are not shown/,
    );
    expect(system).toMatch(/Rejected before it is written/);
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
        type: "recreate.section",
        runId,
        index: 1,
        total: 2,
        id: "hero",
        kind: "hero",
        label: "hero",
        status: "below-threshold",
        pixel: 0.002,
        reason: "responsive",
        reverted: true,
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
      {
        index: 1,
        total: 2,
        id: "hero",
        kind: "hero",
        label: "hero",
        status: "below-threshold",
        pixel: 0.002,
        reason: "responsive",
        reverted: true,
      },
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
      "31-recreate-fluid",
      "32-recreate-repair-honest",
      "33-plain-brief-no-copy",
    ]);
    // every recreation task requires the gates that hold at every width
    for (const t of tasks.filter((x) => x.id.startsWith("3") && x.id !== "33-plain-brief-no-copy"))
      expect(t.checks.find((c) => c.type === "recreateGate")).toMatchObject({
        gates: expect.arrayContaining(["responsive", "flow"]),
      });
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

describe("recreate beside a running agent", () => {
  it("runs while another conversation holds the project, unless it copies its output into the project", async () => {
    const root = tempProject();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = new Harness({
      providers: { mock: new MockProvider({ handler: async () => (await gate, { text: "ok" }) }) },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const agent = h.createSession({ projectPath: root });
    const running = agent.chat("work");
    await new Promise((r) => setTimeout(r, 20));
    const opts = { yes: true, shareCheckout: true, stopAfter: "consent" as const };

    // only its own .harness/recreate folder: no lock, no checkpoint
    const s = h.createSession({ projectPath: root });
    const r = await recreateInSession(s, { url: "https://example.com" }, opts);
    expect(r.status).toBe("success");
    expect(s.events.some((e) => e.type === "checkpoint.created")).toBe(false);
    expect(s.isRunning).toBe(false);

    // `out` writes into the project, so it still waits its turn; so does a run that did not ask to share
    const out = h.createSession({ projectPath: root });
    await expect(recreateInSession(out, { url: "https://example.com", out: "site" }, opts)).rejects.toThrow(
      /busy/,
    );
    await expect(
      recreateInSession(out, { url: "https://example.com" }, { yes: true, stopAfter: "consent" }),
    ).rejects.toThrow(/busy/);

    release();
    await running;
  });
});

describe("repair attempts", () => {
  type Gate = { name: string; pass: boolean; detail: string };
  const report = (o: { failing?: string[]; sweepFail?: number; pixel?: number }): MeasureReport => {
    const names = ["pixel", "text", "layout", "interactions", "responsive", "flow"];
    const gates: Gate[] = names.map((name) => ({ name, pass: !o.failing?.includes(name), detail: "" }));
    return {
      target: "static",
      at: "",
      widths: [
        {
          width: 390,
          pixel: o.pixel ?? 0.02,
          liveHeight: 900,
          outHeight: 900,
          textReal: 0,
          textDrift: 0,
          hscroll: 0,
          bands: [],
        },
      ] as unknown as MeasureReport["widths"],
      gates,
      pass: gates.every((g) => g.pass),
      sweep: Array.from({ length: 50 }, (_, i) => ({
        width: 320 + i * 40,
        pass: i >= (o.sweepFail ?? 0),
        issues: [],
      })) as unknown as MeasureReport["sweep"],
    };
  };
  const run = () => {
    const dir = new RunDir(tempProject(), "20261107-185113-acme-com-abc");
    dir.write("out/static/styles.css", "v1");
    dir.write("out/static/index.html", "<p>v1</p>");
    dir.write("out/static/assets/a.png", "img");
    dir.write("measure/static/report.json", JSON.stringify(report({ failing: ["pixel"] })));
    dir.write("compare/index.html", "compare v1");
    return dir;
  };

  it("ranks a newly failing responsive or flow gate as worse, whatever the pixels did", () => {
    const base = scoreOf(report({ failing: ["pixel"], pixel: 0.05 }));
    expect(compareScores(scoreOf(report({ failing: ["responsive"], pixel: 0.001 })), base)).toBeGreaterThan(
      0,
    );
    expect(compareScores(scoreOf(report({ failing: ["pixel"], sweepFail: 20 })), base)).toBeGreaterThan(0);
    expect(compareScores(scoreOf(report({ failing: ["pixel"], pixel: 0.0501 })), base)).toBe(0);
    expect(compareScores(scoreOf(report({ failing: [] })), base)).toBeLessThan(0);
  });

  it("tells the agent to report after the first measure instead of repairing", () => {
    const dir = run();
    const a = recordMeasure(dir, report({ failing: ["pixel"] }));
    expect(a).toMatchObject({ n: 1, verdict: "first", best: 1, restored: false });
    expect(attemptLines(a, false).join("\n")).toMatch(
      /give the user the summary .* and stop\. Repair only when the user asked/,
    );
    expect(attemptLines(a, true).join("\n")).toMatch(/every gate passes/);
  });

  it("puts the best version back over a worse one, says to stop, then refuses until a rebuild", () => {
    const dir = run();
    recordMeasure(dir, report({ failing: ["pixel"], sweepFail: 10 }));
    // a patch that breaks the page, written outside the tools (bash), measured worse
    dir.write("out/static/styles.css", "broken");
    dir.write("out/static/extra.js", "x");
    dir.write("measure/static/report.json", JSON.stringify(report({ failing: ["pixel", "responsive"] })));
    dir.write("compare/index.html", "compare broken");
    const worse = recordMeasure(dir, report({ failing: ["pixel", "responsive"], sweepFail: 30 }));
    expect(worse).toMatchObject({ n: 2, verdict: "worse", best: 1, restored: true, stale: 1 });
    expect(readFileSync(dir.path("out/static/styles.css"), "utf8")).toBe("v1");
    expect(readFileSync(dir.path("compare/index.html"), "utf8")).toBe("compare v1");
    expect(existsSync(dir.path("out/static/assets/a.png"))).toBe(true);
    const ev = restoredMeasured(dir);
    expect(ev).toMatchObject({ type: "recreate.measured", target: "static" });
    expect((ev as { gates: Gate[] }).gates.find((g) => g.name === "responsive")?.pass).toBe(true);
    expect(attemptLines(worse, false).join("\n")).toMatch(
      /put back to measure #1.*\n.*Next: the next section/s,
    );

    const same = recordMeasure(dir, report({ failing: ["pixel"], sweepFail: 10 }));
    expect(same).toMatchObject({ verdict: "same", stale: 2, restored: false });
    expect(attemptLines(same, false).join("\n")).toMatch(
      /Next: 2 measures without improvement\. Stop repairing/,
    );

    // an improvement becomes the new best and resets the count
    dir.write("out/static/styles.css", "v2");
    const better = recordMeasure(dir, report({ failing: ["pixel"], sweepFail: 2 }));
    expect(better).toMatchObject({ n: 4, verdict: "better", best: 4, stale: 0 });
    expect(measureRefusal(dir)).toBeNull();
    for (let i = 0; i < 4; i++) recordMeasure(dir, report({ failing: ["pixel"], sweepFail: 2 }));
    expect(measureRefusal(dir)).toMatch(/last 4 measures .* did not improve on measure #4.*recreate_build/s);
    expect(readFileSync(dir.path("out/static/styles.css"), "utf8")).toBe("v2");

    resetAttempts(dir);
    expect(measureRefusal(dir)).toBeNull();
    expect(recordMeasure(dir, report({ failing: ["pixel"] })).verdict).toBe("first");
  });
});

describe("model calls with images", () => {
  it("refuse a model that cannot view images instead of answering blind", async () => {
    const provider = new MockProvider({ handler: async () => ({ text: '{"verdict":"different"}' }) });
    let vision: boolean | undefined = false;
    const caps = provider.capabilities.bind(provider);
    provider.capabilities = () => ({ ...caps(), vision });
    const h = new Harness({
      providers: { mock: provider },
      skipGlobalConfig: true,
      loadEnv: false,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ projectPath: tempProject() });
    const img = [
      { role: "user" as const, content: "compare", images: [{ mimeType: "image/png", data: "AA==" }] },
    ];
    await expect(s.complete("executor", img)).rejects.toThrow(/cannot view images/);
    expect(await s.complete("executor", [{ role: "user", content: "name it" }])).toContain("different");
    vision = undefined;
    expect(await s.complete("executor", img)).toContain("different");
  });
});
