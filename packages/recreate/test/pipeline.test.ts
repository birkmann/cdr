import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CdpCaptureDriver, findChrome } from "@harness/capture";
import {
  RunDir,
  repairMarker,
  runRecreate,
  spliceFitted,
  stagesFor,
  type RecreateHost,
  type RecreateProgress,
  type RepairTask,
} from "@harness/recreate";
import { LAYOUT_CHECK_JS, layoutCheck, type LayoutFacts } from "@harness/measure";
import type { SceneElement, SceneLayout, SceneScreen } from "@harness/protocol";
import { cleanFacts, fakeDriver } from "./fake-driver.js";
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
    // the output at the captured widths, at the widths the live page was screenshotted at (narrowest phone, gaps,
    // wide screens), then layout facts only at the rest of the sweep plan, in two browsers
    expect(calls.slice(0, 6)).toEqual([
      "probe",
      "capture 390",
      "capture 768",
      "capture 1440",
      "shoot 390,768,1440",
      "shoot 320,579,1104,1920,2560",
    ]);
    const factCalls = calls.slice(6);
    expect(factCalls).toHaveLength(2);
    expect(factCalls.every((c) => c.endsWith(" (facts)"))).toBe(true);
    const factWidths = factCalls.flatMap((c) => c.slice(6, -8).split(",").map(Number));
    expect(factWidths.length).toBeGreaterThan(40);
    expect(factWidths).toEqual(expect.arrayContaining([344, 767, 1023, 1024, 1088]));
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

  it("fails the responsive gate on an overlap at a width between the captures that the old sweep never checked", async () => {
    // the output overlaps only at 488 px: none of the five widths the live page is screenshotted at
    const overlapAt = (w: number) => w >= 470 && w <= 500;
    const facts = (w: number, page: "live" | "out") =>
      page === "out" && overlapAt(w)
        ? {
            ...cleanFacts(),
            overlapCount: 1,
            overlaps: [["Summit tent", "Learn more"]] as [string, string][],
            pairs: [
              {
                key: "t:learn more × t:summit tent",
                kind: "text" as const,
                a: "Summit tent",
                b: "Learn more",
                section: "s2",
              },
            ],
          }
        : cleanFacts();
    const root = project();
    const calls: string[] = [];
    const r = await runRecreate(
      { url: "acme.example" },
      { projectRoot: root, driver: fakeDriver(calls, { facts }), consent: yes, sectionChecks: false },
    );
    expect(r.status).toBe("failed");
    const g = r.reports[0]!.gates.find((x) => x.name === "responsive")!;
    expect(g.pass).toBe(false);
    expect(g.detail).toMatch(
      /488px 1 overlapping pair the live page does not have: "Summit tent" × "Learn more"/,
    );
    // the five widths the old gate checked are all clean
    const old = [320, 579, 1104, 1920, 2560];
    expect(r.reports[0]!.sweep!.filter((c) => old.includes(c.width)).every((c) => c.pass)).toBe(true);
    // the live page was probed at the grid during the capture: its facts are in the run folder
    const dir = new RunDir(root, r.runId);
    expect(dir.exists("capture/live/488.json")).toBe(true);
    expect(dir.manifest().probe).toContain(488);
    expect(dir.exists("build/styles.base.css")).toBe(true);
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

  describe("repairs checked between the captured widths", () => {
    /** a run captured at 390 px and split into sections, and the output's section boxes = the live bands */
    const captured = async (live?: () => LayoutFacts) => {
      const root = project();
      const r = await runRecreate(
        { url: "https://acme.example/", widths: [390], repair: true },
        { projectRoot: root, driver: fakeDriver([], live ? { facts: () => live() } : {}), consent: yes },
        { stopAfter: "scene" },
      );
      const dir = new RunDir(root, r.runId);
      const sections =
        dir.readJson<{ id: string; copies: { width: number; y: number; h: number }[] }[]>(
          "scene/sections.json",
        );
      const rects = (w: number) =>
        Object.fromEntries(
          sections.flatMap((s) =>
            s.copies.filter((c) => c.width === w).map((c) => [s.id, { y: c.y, h: c.h }]),
          ),
        );
      return { root, r, dir, sections, rects };
    };
    const css = (url: string) =>
      readFileSync(fileURLToPath(url).replace(/index\.html$/, "styles.css"), "utf8");
    const overlap = (section: string, a: string, b: string): LayoutFacts => ({
      ...cleanFacts(),
      overlapCount: 1,
      overlaps: [[a, b]],
      pairs: [{ key: `t:${a.toLowerCase()} × t:${b.toLowerCase()}`, kind: "text", a, b, section }],
    });

    it("sends a section whose pixels pass but whose layout breaks between them, and undoes a patch that breaks another width", async () => {
      const { root, r, dir, sections, rects } = await captured();
      const target = sections[1]!.id;
      // the output overlaps at 488 px until a repair says FIXED; a repair that says BREAK overlaps at 704 px instead
      const facts = (w: number, page: "live" | "out", url: string) => {
        if (page === "live") return cleanFacts();
        const c = css(url);
        if (w === 488 && !c.includes("FIXED")) return overlap(target, "Summit tent", "Learn more");
        if (w === 704 && c.includes("BREAK")) return overlap(target, "60-day returns", "Lifetime repairs");
        return cleanFacts();
      };
      const tasks: RepairTask[] = [];
      const snapshots: string[] = [];
      const events: RecreateProgress[] = [];
      const out = await runRecreate(
        { url: "https://acme.example/", run: r.runId, from: "build" },
        {
          projectRoot: root,
          driver: fakeDriver([], { facts, rects }),
          consent: yes,
          progress: (e) => events.push(e),
          repair: async (task) => {
            tasks.push(task);
            const file = dir.path("out/static/styles.css");
            snapshots.push(
              readFileSync(file, "utf8") + readFileSync(dir.path("out/static/index.html"), "utf8"),
            );
            const fix = task.attempt === 1 ? "FIXED BREAK" : "FIXED";
            writeFileSync(
              file,
              `${readFileSync(file, "utf8")}\n${repairMarker(task.section.id, task.attempt)}\n[data-section="${task.section.id}"] { gap: 12px; } /* ${fix} */\n`,
            );
            return { changed: true };
          },
        },
        { stopAfter: "build" },
      );
      expect(out.status, out.summary).toBe("success");
      // only that section is repaired (every section's pixels pass), for its layout between the captured widths
      expect(tasks.map((t) => [t.section.id, t.attempt, t.reason])).toEqual([
        [target, 1, "responsive"],
        [target, 2, "responsive"],
      ]);
      expect(tasks[0]!.sweep).toEqual([{ width: 488, issues: ['"Summit tent" overlaps "Learn more"'] }]);
      expect(tasks[0]!.boundaries).toEqual([]);
      // the first patch fixed 488 px but broke 704 px: undone, the files exactly as before it
      expect(snapshots[1]).toBe(snapshots[0]);
      const rows = events.filter((e) => e.type === "recreate.section" && e.id === target);
      // the second one fixed it and broke nothing: kept
      expect(rows.at(-1)).toMatchObject({ status: "repaired" });
      expect(readFileSync(dir.path("out/static/styles.css"), "utf8")).toContain(repairMarker(target, 2));
      expect(readFileSync(dir.path("out/static/styles.css"), "utf8")).not.toContain(repairMarker(target, 1));
    });

    it("ends a section below its threshold, marked reverted, when every patch breaks a width", async () => {
      const { root, r, dir, sections, rects } = await captured();
      const target = sections[2]!.id;
      const facts = (w: number, page: "live" | "out", url: string) =>
        page === "out" &&
        ((w === 488 && !css(url).includes("FIXED")) || (w === 704 && css(url).includes("BREAK")))
          ? overlap(target, "Scree boots", "Learn more")
          : cleanFacts();
      const events: RecreateProgress[] = [];
      await runRecreate(
        { url: "https://acme.example/", run: r.runId, from: "build" },
        {
          projectRoot: root,
          driver: fakeDriver([], { facts, rects }),
          consent: yes,
          progress: (e) => events.push(e),
          repair: async (task) => {
            const file = dir.path("out/static/styles.css");
            writeFileSync(
              file,
              `${readFileSync(file, "utf8")}\n${repairMarker(task.section.id, task.attempt)}\n/* FIXED BREAK */\n`,
            );
            return true;
          },
        },
        { stopAfter: "build" },
      );
      expect(events.filter((e) => e.type === "recreate.section" && e.id === target).at(-1)).toMatchObject({
        status: "below-threshold",
        reason: "responsive",
        reverted: true,
      });
      // no repair is left in the page: the stylesheet is the one the build wrote
      expect(readFileSync(dir.path("out/static/styles.css"), "utf8")).toBe(
        readFileSync(dir.path("build/styles.base.css"), "utf8"),
      );
    });

    it("sends a section whose texts are placed by coordinates (the live page keeps them in flow) for its CSS", async () => {
      const anchors = [{ k: "t:60-day returns", x: 0, y: 10 }];
      // the live page has the text, in its flow
      const { root, r, sections, rects } = await captured(() => ({ ...cleanFacts(), anchors }));
      const target = sections[3]!.id;
      const facts = (_w: number, page: "live" | "out") =>
        page === "out"
          ? { ...cleanFacts(), outOfFlow: ["t:60-day returns"], anchors: [{ ...anchors[0]!, s: target }] }
          : { ...cleanFacts(), anchors };
      const tasks: RepairTask[] = [];
      await runRecreate(
        { url: "https://acme.example/", run: r.runId, from: "build" },
        {
          projectRoot: root,
          driver: fakeDriver([], { facts, rects }),
          consent: yes,
          repair: async (task) => {
            tasks.push(task);
            return false;
          },
        },
        { stopAfter: "build" },
      );
      expect(tasks.map((t) => [t.section.id, t.reason])).toEqual([[target, "flow"]]);
      expect(tasks[0]!.sweep).toEqual([
        { width: 0, issues: ['"60-day returns" placed by coordinates; the page keeps it in its flow'] },
      ]);
    });

    it("hands the reasons a patch was rejected for to the next attempt", async () => {
      const { root, r, sections, rects } = await captured();
      const target = sections[1]!.id;
      const facts = (w: number, page: "live" | "out") =>
        page === "out" && w === 488 ? overlap(target, "Summit tent", "Learn more") : cleanFacts();
      const tasks: RepairTask[] = [];
      await runRecreate(
        { url: "https://acme.example/", run: r.runId, from: "build" },
        {
          projectRoot: root,
          driver: fakeDriver([], { facts, rects }),
          consent: yes,
          repair: async (task) => {
            tasks.push(task);
            return { changed: false, rejected: ["value-pin: margin-top jumps between widths"] };
          },
        },
        { stopAfter: "build" },
      );
      expect(tasks.map((t) => t.attempt)).toEqual([1, 2]);
      expect(tasks[0]!.rejected).toBeUndefined();
      expect(tasks[1]!.rejected).toEqual(["value-pin: margin-top jumps between widths"]);
    });
  });

  describe("fitted fallback (gates.fittedSections)", () => {
    it("swaps a section's content for the fitted conversion's, in place, and leaves controls in flow", () => {
      const el = (
        id: string,
        meta: Record<string, string | boolean>,
        layout: SceneLayout,
        children: SceneElement[] = [],
      ) => ({ id, type: "frame", name: id, meta, layout, style: {}, children }) as SceneElement;
      const screen = (root: SceneElement): SceneScreen => ({
        version: 1,
        id: "s",
        name: "s",
        width: 390,
        height: 900,
        platform: "web",
        root,
      });
      const flow = [
        screen(
          el("root", {}, { direction: "column" }, [
            el("a", { section: "hero" }, { width: "fill", margin: [0, 16, 0, 16] }, [el("t", {}, {})]),
            el("b", { section: "menu" }, { width: "fill" }, [
              { ...el("m", {}, {}), interaction: { onTap: "back" } },
            ]),
          ]),
        ),
      ];
      const fitted = [
        screen(
          el("R", {}, {}, [
            el("A", { section: "hero" }, { position: "absolute", x: 0, y: 70, width: 358, height: 400 }, [
              el("T", {}, { position: "absolute", x: 10, y: 10 }),
            ]),
            el("B", { section: "menu" }, { position: "absolute", x: 0, y: 0, width: 390, height: 60 }),
          ]),
        ),
      ];
      const out = spliceFitted(flow, fitted, "hero")!;
      const hero = out[0]!.root.children![0]!;
      // its place in the flow kept (fill, margins), its own geometry and content the fitted one's
      expect(hero.layout).toEqual({ width: "fill", height: 400, margin: [0, 16, 0, 16] });
      expect(hero.children![0]).toMatchObject({ id: "f-T", layout: { position: "absolute", x: 10, y: 10 } });
      expect(hero.meta).toMatchObject({ section: "hero", fitted: true });
      expect(hero.id).toBe("a");
      // the input is not changed; a section with a control stays in flow
      expect(flow[0]!.root.children![0]!.children![0]!.id).toBe("t");
      expect(spliceFitted(flow, fitted, "menu")).toBeNull();
      expect(spliceFitted(flow, fitted, "nope")).toBeNull();
    });

    const run = async (budget: number, fittedHelps: boolean) => {
      const root = project();
      const first = await runRecreate(
        { url: "https://acme.example/", widths: [390] },
        {
          projectRoot: root,
          driver: fakeDriver([]),
          consent: yes,
          config: { gates: { fittedSections: budget } },
        },
        { stopAfter: "scene" },
      );
      const dir = new RunDir(root, first.runId);
      const sections =
        dir.readJson<{ id: string; copies: { width: number; y: number; h: number }[] }[]>(
          "scene/sections.json",
        );
      const target = sections[2]!.id;
      // the flow version of the target misses its band by 60 px; the fitted one (its boxes placed: more absolute
      // layers in the stylesheet) matches it, if it helps
      const placed = (url: string) =>
        (
          readFileSync(fileURLToPath(url).replace(/index\.html$/, "styles.css"), "utf8").match(
            /position: absolute/g,
          ) ?? []
        ).length;
      let flowPlaced = -1;
      const rects = (w: number, url: string) => {
        if (flowPlaced < 0) flowPlaced = placed(url);
        const off = placed(url) <= flowPlaced || !fittedHelps ? 60 : 0;
        return Object.fromEntries(
          sections.flatMap((s) =>
            s.copies
              .filter((c) => c.width === w)
              .map((c) => [s.id, { y: c.y, h: c.h + (s.id === target ? off : 0) }]),
          ),
        );
      };
      const r = await runRecreate(
        { url: "https://acme.example/", run: first.runId, from: "build" },
        {
          projectRoot: root,
          driver: fakeDriver([], { rects }),
          consent: yes,
          config: { gates: { fittedSections: budget } },
        },
      );
      return { r, dir, target };
    };

    it("keeps a section's fitted geometry when its flow version misses the live page, within the budget", async () => {
      const { r, dir, target } = await run(1, true);
      expect(dir.exists("scene/screens.fitted.json")).toBe(true);
      expect(dir.readJson<string[]>("out/static/fitted.json")).toEqual([target]);
      const flow = r.reports[0]!.flow!;
      expect(flow.fitted).toEqual([target]);
      // its CSS is left out of the flow rules; the section counts against the budget, which it fits
      expect(flow.pass).toBe(true);
      expect(r.reports[0]!.gates.find((g) => g.name === "flow")!.detail).toMatch(
        /1 fitted section\(s\) \(≤ 1\)/,
      );
    });

    it("keeps the flow version when the fitted one is no closer, and never falls back without a budget", async () => {
      const worse = await run(1, false);
      expect(worse.dir.exists("out/static/fitted.json")).toBe(false);
      const none = await run(0, true);
      expect(none.dir.exists("scene/screens.fitted.json")).toBe(false);
      expect(none.dir.exists("out/static/fitted.json")).toBe(false);
      expect(none.r.reports[0]!.flow!.fitted).toEqual([]);
    });
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
describe.concurrent.skipIf(!chrome)(
  "recreations that hold at every width (acceptance, headless Chrome)",
  () => {
    // every 24 px from 320 to 1920: the widths the gate checks and every width between them
    const every = Array.from({ length: (1920 - 320) / 24 + 1 }, (_, i) => 320 + 24 * i);
    for (const name of ["acme", "fluid"])
      it(`${name}: no overlap, cut text or sideways scroll the site does not have, its height within 3 %, CSS that flows`, async () => {
        const site = await serveSite(name);
        try {
          const root = project();
          const r = await runRecreate(
            { url: site.url },
            {
              projectRoot: root,
              config: { allowLocal: true, respectRobots: false },
              consent: yes,
              sectionChecks: false,
            },
          );
          expect(r.status, r.summary).toBe("success");
          expect(r.reports[0]!.flow?.pass).toBe(true);
          const driver = new CdpCaptureDriver();
          const outUrl = pathToFileURL(new RunDir(root, r.runId).path("out/static/index.html")).href;
          const [o, l] = await Promise.all([
            driver.shoot(outUrl, every, { guard: false, probe: LAYOUT_CHECK_JS, factsOnly: true }),
            driver.shoot(site.url, every, { guard: false, probe: LAYOUT_CHECK_JS, factsOnly: true }),
          ]);
          const bad = every.flatMap((w, i) => {
            const c = layoutCheck(w, o[i]!, { probe: l[i]!.probe }, undefined, 1, true, { heightPct: 3 });
            return c.pass ? [] : [`${w}px ${c.issues.join("; ")}`];
          });
          expect(bad).toEqual([]);
        } finally {
          await site.close();
        }
      }, 600_000);
  },
);

describe.skipIf(!chrome)("runRecreate end to end (fixture site, headless Chrome)", () => {
  it("recreates the fixture at 390 and 1440 and passes every gate, the responsive and flow gates too", async () => {
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
      expect(rep.gates.map((g) => [g.name, g.pass])).toEqual([
        ["pixel", true],
        ["text", true],
        ["layout", true],
        ["interactions", true],
        ["responsive", true],
        ["flow", true],
      ]);
    } finally {
      await site.close();
    }
  }, 240_000);
});

describe.skipIf(!chrome)(
  "runRecreate modern (fixture site with video, slider, hover, menu; headless Chrome)",
  () => {
    it("recreates one DOM for every width that plays the video, drives the slider, keeps the hover looks and passes every gate", async () => {
      const site = await serveSite("motion");
      try {
        const root = project();
        const r = await runRecreate(
          { url: site.url, to: ["modern"] },
          {
            projectRoot: root,
            config: { allowLocal: true, respectRobots: false, gates: { lighthouse: false } },
            consent: yes,
            sectionChecks: false,
          },
        );
        const rep = r.reports.find((x) => x.target === "modern");
        expect(rep, r.summary).toBeTruthy();
        expect(r.outputs.map((o) => o.target)).toEqual(["modern"]);
        // every gate passes; pixels within 2 % (glyph rendering differs a little between machines)
        const failing = rep!.gates
          .filter((g) => !g.pass && g.name !== "pixel")
          .map((g) => `${g.name}: ${g.detail}`);
        expect(failing).toEqual([]);
        for (const w of rep!.widths) expect(w.pixel).toBeLessThan(0.02);
        expect(rep!.gates.map((g) => g.name)).toEqual(
          expect.arrayContaining([
            "pixel",
            "text",
            "layout",
            "interactions",
            "responsive",
            "flow",
            "a11y",
            "markup",
            "motion",
            "behaviour",
            "hover",
          ]),
        );
        const html = readFileSync(join(root, ".harness/recreate", r.runId, "out/modern/index.html"), "utf8");
        expect(html).not.toMatch(/data-bp=/);
        expect(html).toMatch(/<video [^>]*autoplay/);
        expect(existsSync(join(root, ".harness/recreate", r.runId, "capture/media.json"))).toBe(true);
      } finally {
        await site.close();
      }
    }, 420_000);
  },
);
