import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChrome } from "@harness/capture";
import { RunDir, runRecreate, stagesFor, type RecreateHost, type RecreateProgress } from "@harness/recreate";
import { fakeDriver } from "./fake-driver.js";
import { serveSite } from "../../capture/test/sites/serve.js";

const project = () => mkdtempSync(join(tmpdir(), "recreate-"));
const yes: RecreateHost["consent"] = async () => ({ by: "auto", at: new Date().toISOString(), mode: "yes" });

describe("stage selection", () => {
  it("runs the static stages for static output, adds components for projects and design systems", () => {
    expect(stagesFor(["static"])).toEqual(["consent", "probe", "capture", "scene", "build", "measure"]);
    expect(stagesFor(["react-vite"])).toContain("convert");
    expect(stagesFor(["ds-lit"])).toEqual(expect.arrayContaining(["components", "system", "ds-export"]));
  });
});

describe("runRecreate (recorded capture, no browser)", () => {
  it("announces the live page while capturing: the first screen, then every live shot before the build", async () => {
    for (const quiet of [false, true]) {
      const root = project();
      const events: RecreateProgress[] = [];
      const r = await runRecreate(
        { url: "acme.example" },
        {
          projectRoot: root,
          driver: fakeDriver([], { quiet }),
          consent: yes,
          progress: (e) => events.push(e),
          sectionChecks: false,
        },
        { stopAfter: "build" },
      );
      expect(r.status).toBe("success");
      const shots = events.filter((e) => e.type === "recreate.shot");
      expect(shots[0]).toMatchObject({ kind: "peek", width: 1440 });
      expect(
        shots
          .filter((e) => e.kind === "live")
          .map((e) => e.width)
          .sort((a, b) => a - b),
      ).toEqual([390, 768, 1440]);
      for (const e of shots) expect(existsSync(join(root, e.path)), e.path).toBe(true);
      // all of them before the build starts (the preview shows them until the page grows)
      const build = events.findIndex((e) => e.type === "recreate.stage" && e.stage === "build");
      expect(events.indexOf(shots.at(-1)!)).toBeLessThan(build);
    }
  });

  it("runs consent → measure, writes the run folder and reports every step as an event", async () => {
    const root = project();
    const calls: string[] = [];
    const events: RecreateProgress[] = [];
    const r = await runRecreate(
      { url: "acme.example" },
      {
        projectRoot: root,
        driver: fakeDriver(calls),
        consent: yes,
        progress: (e) => events.push(e),
        sectionChecks: false,
      },
    );
    expect(r.status, `${r.summary} ${JSON.stringify(r.manifest.gates.filter((g) => !g.pass))}`).toBe(
      "success",
    );
    // the output at the captured widths, then the responsive sweep (narrowest phone, gaps, wide screens)
    expect(calls).toEqual([
      "probe",
      "capture 390",
      "capture 768",
      "capture 1440",
      "shoot 390,768,1440",
      "shoot 320,579,1104,1920,2560",
    ]);
    const dir = new RunDir(root, r.runId);
    for (const f of [
      "manifest.json",
      "capture/390.snapshot.json",
      "capture/live/768.png",
      "scene/screens.json",
      "scene/sections.json",
      "out/static/index.html",
      "out/static/credits.json",
      "measure/static/report.json",
      "measure/static/1440/diff.png",
      "compare/index.html",
    ])
      expect(dir.exists(f), f).toBe(true);
    const m = dir.manifest();
    expect(m.consent?.by).toBe("auto");
    expect(m.request.url).toBe("https://acme.example/");
    expect(m.variants?.map((v) => [v.width, v.minWidth])).toEqual([
      [390, 0],
      [768, 768],
      [1440, 1024],
    ]);
    expect(m.stages.capture?.skipped).toEqual(["1440px: menu at 1600px"]);
    expect(m.gates.every((g) => g.pass)).toBe(true);
    // the build style that hides later sections is gone at the end
    expect(readFileSync(dir.path("out/static/index.html"), "utf8")).not.toContain("harness-build");
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("recreate.started");
    expect(types.at(-1)).toBe("recreate.finished");
    expect(events.filter((e) => e.type === "recreate.section" && e.status === "ok")).toHaveLength(6);
    // every section carries its band on the live page, so the UI can place the built page over the screenshot
    const first = events.find((e) => e.type === "recreate.section");
    expect(first?.type === "recreate.section" && first.bands?.map((b) => b.width).sort()).toEqual(
      expect.arrayContaining([390]),
    );
    expect(events.find((e) => e.type === "recreate.measured")).toMatchObject({ target: "static" });
    expect(existsSync(join(root, ".harness/recreate", r.runId))).toBe(true);
  });

  it("captures nothing without consent", async () => {
    const root = project();
    const calls: string[] = [];
    const r = await runRecreate(
      { url: "https://acme.example/" },
      { projectRoot: root, driver: fakeDriver(calls), consent: async () => null },
    );
    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/Consent/);
    expect(calls).toEqual([]);
    // a denied run leaves no run folder (and no .git/info/exclude entry)
    expect(existsSync(join(root, ".harness/recreate", r.runId))).toBe(false);
  });

  it("reports a new run's consent only once given, not in recreate.started", async () => {
    const events: RecreateProgress[] = [];
    await runRecreate(
      { url: "https://acme.example/", widths: [390] },
      { projectRoot: project(), driver: fakeDriver([]), consent: yes, progress: (e) => events.push(e) },
      { stopAfter: "probe" },
    );
    const started = events.find((e) => e.type === "recreate.started")!;
    expect(started).not.toHaveProperty("consent");
    expect(events.find((e) => e.type === "recreate.consent")).toMatchObject({ consent: { by: "auto" } });
  });

  it("resumes a run without a URL: the manifest's URL and consent, its targets kept", async () => {
    const root = project();
    const first = await runRecreate(
      { url: "https://acme.example/", widths: [390] },
      { projectRoot: root, driver: fakeDriver([]), consent: yes, sectionChecks: false },
      { stopAfter: "build" },
    );
    expect(first.status).toBe("success");
    const calls: string[] = [];
    const events: RecreateProgress[] = [];
    const r = await runRecreate(
      { url: "", run: first.runId, from: "measure" },
      {
        projectRoot: root,
        driver: fakeDriver(calls),
        consent: async () => null,
        progress: (e) => events.push(e),
      },
    );
    expect(r.status, r.summary).toBe("success");
    expect(calls.every((c) => c.startsWith("shoot"))).toBe(true);
    expect(events[0]).toMatchObject({
      type: "recreate.started",
      url: "https://acme.example/",
      targets: ["static"],
      consent: { by: "auto" },
    });
    // an unknown run without a URL is an error, not a new run
    await expect(runRecreate({ url: "", run: "nope" }, { projectRoot: root, consent: yes })).rejects.toThrow(
      /No recreation run/,
    );
  });

  it("refuses run ids and out folders that leave their place", async () => {
    const root = project();
    expect(() => new RunDir(root, "../../..")).toThrow(/run id/);
    expect(() => new RunDir(root, "a/b")).toThrow(/run id/);
    const dir = new RunDir(root, "ok-run");
    expect(() => dir.path("../other/manifest.json")).toThrow(/leaves/);
    expect(() => dir.write("../../x.txt", "x")).toThrow(/leaves/);
    await expect(
      runRecreate({ url: "x", run: "../.." }, { projectRoot: root, consent: yes }),
    ).rejects.toThrow(/run id/);
    for (const out of ["../escape", "/tmp/escape", "site/../../escape", ".git/hooks"])
      await expect(
        runRecreate({ url: "https://acme.example/", out }, { projectRoot: root, consent: yes }),
        out,
      ).rejects.toThrow(/out/);
    // a symlink out of the project is refused too
    const outside = project();
    symlinkSync(outside, join(root, "link"));
    await expect(
      runRecreate({ url: "https://acme.example/", out: "link/site" }, { projectRoot: root, consent: yes }),
    ).rejects.toThrow(/outside the project/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("copies the outputs into a project folder with out", async () => {
    const root = project();
    mkdirSync(join(root, "web"));
    const r = await runRecreate(
      { url: "https://acme.example/", widths: [390], out: "web/site" },
      { projectRoot: root, driver: fakeDriver([]), consent: yes, sectionChecks: false },
      { stopAfter: "build" },
    );
    expect(r.status).toBe("success");
    expect(existsSync(join(root, "web/site/index.html"))).toBe(true);
  });

  it("resumes from a later stage and names components with the model (validated) or deterministically", async () => {
    const root = project();
    const calls: string[] = [];
    const first = await runRecreate(
      { url: "https://acme.example/", widths: [390, 1440] },
      { projectRoot: root, driver: fakeDriver(calls), consent: yes, sectionChecks: false },
    );
    expect(first.status).toBe("success");
    calls.length = 0;
    const asked: string[] = [];
    const r = await runRecreate(
      { url: "https://acme.example/", run: first.runId, from: "components", to: ["tokens"] },
      {
        projectRoot: root,
        driver: fakeDriver(calls),
        consent: async () => {
          throw new Error("consent is recorded already");
        },
        chat: async (req) => {
          asked.push(req.purpose);
          return "not json";
        },
      },
    );
    expect(calls).toEqual([]);
    expect(asked[0]).toBe("naming");
    const dir = new RunDir(root, r.runId);
    const sets = dir.readJson<{ name: string }[]>("components/sets.json");
    expect(sets.length).toBeGreaterThan(0);
    // the model gave junk: every set got a deterministic PascalCase name, none numbered, none built-in
    for (const s of sets) expect(s.name).toMatch(/^[A-Z][A-Za-z]+$/);
    expect(dir.readJson<{ error?: string }>("components/naming.json").error).toMatch(/no usable answer/);
    expect(dir.exists("out/tokens/tokens.json")).toBe(true);
    expect(dir.exists("design-system/system.json")).toBe(true);
  });

  it("repairs sections below their threshold only when asked, in at most two batched passes", async () => {
    const root = project();
    const calls: string[] = [];
    const driver = fakeDriver(calls);
    // the output's sections are "missing" (no rect): every band fails its threshold
    const attempts: number[] = [];
    const r = await runRecreate(
      { url: "https://acme.example/", widths: [390], repair: true },
      {
        projectRoot: root,
        driver,
        consent: yes,
        repair: async (task) => {
          attempts.push(task.attempt);
          expect(task.file).toMatch(/out\/static\/index\.html$/);
          expect(task.widths[0].live.length).toBeGreaterThan(0);
          return true;
        },
      },
      { stopAfter: "build" },
    );
    expect(r.status).toBe("success");
    // 6 sections × 2 passes, none reached the threshold
    expect(attempts).toHaveLength(12);
    expect(attempts.filter((a) => a === 1)).toHaveLength(6);
    // one output shot per pass for every section at once: the first check and one after each pass
    expect(calls.filter((c) => c === "shoot 390")).toHaveLength(3);
    const html = readFileSync(new RunDir(root, r.runId).path("out/static/index.html"), "utf8");
    expect(html).not.toContain("harness-build");
  });

  it("makes no repair call unless the run asks for it, and shoots the output once", async () => {
    const root = project();
    const calls: string[] = [];
    let repairs = 0;
    const r = await runRecreate(
      { url: "https://acme.example/", widths: [390] },
      {
        projectRoot: root,
        driver: fakeDriver(calls),
        consent: yes,
        repair: async () => {
          repairs++;
          return true;
        },
      },
      { stopAfter: "build" },
    );
    expect(r.status).toBe("success");
    expect(repairs).toBe(0);
    expect(calls.filter((c) => c === "shoot 390")).toHaveLength(1);
  });

  it("embeds the captured fonts by default", async () => {
    const root = project();
    const r = await runRecreate(
      { url: "https://acme.example/", widths: [390] },
      { projectRoot: root, driver: fakeDriver([]), consent: yes, sectionChecks: false },
      { stopAfter: "build" },
    );
    const dir = new RunDir(root, r.runId);
    expect(readFileSync(dir.path("out/static/RECREATION.md"), "utf8")).toContain("Fonts: embed");
    expect(readFileSync(dir.path("out/static/tokens.css"), "utf8")).not.toMatch(/url\('https?:/);
  });
});

const chrome = findChrome();
describe.skipIf(!chrome)("runRecreate end to end (fixture site, headless Chrome)", () => {
  it("recreates the fixture at 390 and 1440 and passes the pixel, text, layout and interaction gates", async () => {
    const site = await serveSite("acme");
    try {
      const r = await runRecreate(
        { url: site.url, widths: [390, 1440] },
        {
          projectRoot: project(),
          config: { allowLocal: true, respectRobots: false },
          consent: yes,
          sectionChecks: false,
        },
      );
      expect(r.status, r.summary).toBe("success");
      const rep = r.reports[0];
      for (const w of rep.widths) {
        expect(w.pixel).toBeLessThan(0.01);
        expect(w.textReal).toBe(0);
        expect(w.hscroll).toBe(0);
      }
      expect(rep.gates.map((g) => g.pass)).toEqual(
        [true, true, true, true, true] /* pixel, text, layout, interactions, responsive */,
      );
    } finally {
      await site.close();
    }
  }, 240_000);
});
