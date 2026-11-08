#!/usr/bin/env node
// Loads a page (a recreation, or any page) at many widths and prints the layout facts per width: overlapping content,
// text cut off or pushed off the screen, sideways scroll and the page's height, compared with another page (the live
// one) by identity, the way the recreate pipeline's responsive gate compares them. Needs Chrome and the built
// packages (pnpm build:packages).
//
//   node scripts/recreate/sweep.mjs <page> [--against <page>]       a file, folder (its index.html) or URL
//   node scripts/recreate/sweep.mjs --run <run folder>               a run's output against the live facts it captured
//   node scripts/recreate/sweep.mjs --fixture                        the acme fixture built from its recordings
//                                                                    (no model, no network) against the fixture site
//   node scripts/recreate/sweep.mjs --fixture --pipeline             the whole pipeline on the fixture site, then the sweep
//   options: --widths 320,400,…  --step 24  --json  --keep (keep the temporary project of --fixture)
//            --capture 390,1440 (with --pipeline: the widths to capture; default the page's own layout ranges)
//            --site fluid (with --fixture --pipeline: another fixture site of packages/capture/test/sites)
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  createReadStream,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const dist = (pkg) => join(root, "packages", pkg, "dist", "index.js");
for (const p of ["capture", "measure", "recreate"])
  if (!existsSync(dist(p))) {
    console.error(`packages/${p}/dist is missing: run pnpm build:packages first`);
    process.exit(2);
  }
const { CdpCaptureDriver, findChrome } = await import(pathToFileURL(dist("capture")).href);
const { LAYOUT_CHECK_JS, layoutCheck, sweepPlan, DEFAULT_GATES } = await import(
  pathToFileURL(dist("measure")).href
);

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter(
  (a, i) =>
    !a.startsWith("--") &&
    !["--against", "--run", "--widths", "--step", "--capture", "--site"].includes(args[i - 1]),
);
if (!findChrome()) {
  console.error("No Chrome found (set HARNESS_CHROME).");
  process.exit(2);
}

/** a file, a folder (its index.html) or a URL → a URL Chrome can load */
const urlOf = (p) => {
  if (/^https?:\/\//i.test(p) || /^file:/i.test(p)) return p;
  const abs = resolve(p);
  return pathToFileURL(existsSync(abs) && statSync(abs).isDirectory() ? join(abs, "index.html") : abs).href;
};

function widthsFrom() {
  const list = opt("widths");
  if (list)
    return list
      .split(",")
      .map(Number)
      .filter((n) => n > 0);
  const step = Number(opt("step"));
  if (step > 0) {
    const ws = [];
    for (let w = 320; w <= 1920; w += step) ws.push(w);
    return [...ws, 2560];
  }
  // the responsive gate's grid (every 24 px below 1024, 48 above, up to 1920, and 2560)
  return sweepPlan({ captured: [], measured: [1920] }).grid;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
/** serve a folder on 127.0.0.1 (the fixture site: Chrome loads it like a live page) */
async function serve(dir) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** the acme fixture built from its recordings, no browser: the capture replayed, build only */
async function buildFixture(project) {
  const { runRecreate } = await import(pathToFileURL(dist("recreate")).href);
  const rec = join(root, "packages/capture/test/sites/acme/recorded");
  const read = (f) => readFileSync(join(rec, f));
  const driver = {
    id: "recorded",
    async probe() {
      return {
        url: "https://acme.example/",
        breakpoints: [
          { px: 768, rules: 4, source: "media", structural: 0.4, shifted: 0.6 },
          { px: 1024, rules: 6, source: "media", structural: 0.5, shifted: 0.8 },
        ],
        samples: 30,
        ms: 1,
      };
    },
    async capture(_u, plan, o) {
      const shots = (o?.shotWidths ?? [])
        .filter((w) => existsSync(join(rec, `${w}.png`)))
        .map((w) => ({
          width: w,
          height: 0,
          png: read(`${w}.png`),
          ...JSON.parse(read(`${w}.json`).toString()),
        }));
      return {
        snapshot: JSON.parse(read(`${plan.width}.snapshot.json`).toString()),
        finalUrl: "https://acme.example/",
        skipped: [],
        shots,
        ms: 1,
      };
    },
    async shoot() {
      return [];
    },
  };
  const consent = async () => ({ by: "auto", at: new Date().toISOString(), mode: "yes" });
  const r = await runRecreate(
    { url: "acme.example" },
    { projectRoot: project, driver, consent, sectionChecks: false },
    { stopAfter: "build" },
  );
  if (r.status !== "success") throw new Error(`fixture build failed: ${r.summary}`);
  return join(project, r.dir, "out/static/index.html");
}

async function probeAll(url, widths) {
  const d = new CdpCaptureDriver();
  const shots = await d.shoot(url, widths, { guard: false, probe: LAYOUT_CHECK_JS, factsOnly: true });
  return new Map(
    shots.map((s) => [s.width, { probe: s.probe, overflowPx: s.overflowPx ?? 0, height: s.height }]),
  );
}

/** the live facts a run captured (capture/live/<width>.json) */
function runFacts(run) {
  const dir = join(run, "capture/live");
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (j.probe) out.set(Number(m[1]), { probe: j.probe, overflowPx: j.overflowPx ?? 0, height: j.height });
  }
  return out;
}

async function main() {
  let page,
    against,
    liveFacts,
    cleanup = async () => {};
  if (flag("fixture")) {
    const name = opt("site") ?? "acme";
    const site = await serve(join(root, "packages/capture/test/sites", name));
    const project = mkdtempSync(join(tmpdir(), "cdr-sweep-"));
    cleanup = async () => {
      await site.close();
      if (!flag("keep")) rmSync(project, { recursive: true, force: true });
      else console.error(`project kept: ${project}`);
    };
    if (flag("pipeline")) {
      const { runRecreate } = await import(pathToFileURL(dist("recreate")).href);
      const consent = async () => ({ by: "auto", at: new Date().toISOString(), mode: "yes" });
      const widths = opt("capture") ? opt("capture").split(",").map(Number) : undefined;
      const r = await runRecreate(
        { url: site.url, ...(widths ? { widths } : {}) },
        {
          projectRoot: project,
          config: { allowLocal: true, respectRobots: false },
          consent,
          sectionChecks: false,
        },
      );
      const rep = r.reports[0];
      if (flag("json"))
        console.log(
          JSON.stringify(
            {
              status: r.status,
              gates: rep?.gates,
              widths: rep?.widths?.map(({ bands, text, ...w }) => w),
              sweep: rep?.sweep,
              flow: rep?.flow,
            },
            null,
            1,
          ),
        );
      else {
        console.log(`pipeline: ${r.status} — ${r.summary}`);
        for (const w of rep?.widths ?? [])
          console.log(
            `  ${w.width}px pixel ${(w.pixel * 100).toFixed(2)} % text ${w.textReal} height ${w.outHeight}/${w.liveHeight}`,
          );
        for (const g of rep?.gates ?? [])
          console.log(`  ${g.pass ? "✓" : "✗"} ${g.name}: ${g.detail.slice(0, 600)}`);
        for (const c of rep?.sweep ?? [])
          if (!c.pass) console.log(`    ${c.width}px ${c.issues.join(" | ")}`);
      }
      await cleanup();
      return;
    }
    if (name !== "acme")
      throw new Error(`--site ${name}: only the pipeline mode (--pipeline) captures other sites`);
    page = urlOf(await buildFixture(project));
    against = site.url;
  } else if (opt("run")) {
    const run = resolve(opt("run"));
    page = urlOf(join(run, "out/static/index.html"));
    liveFacts = runFacts(run);
  } else {
    if (!positional[0]) {
      console.error(
        "usage: sweep.mjs <page> [--against <page>] | --run <run folder> | --fixture [--pipeline]",
      );
      process.exit(2);
    }
    page = urlOf(positional[0]);
    if (opt("against")) against = urlOf(opt("against"));
  }
  const widths =
    liveFacts && !opt("widths") && !opt("step") ? [...liveFacts.keys()].sort((a, b) => a - b) : widthsFrom();
  const [outF, liveF] = await Promise.all([
    probeAll(page, widths),
    against ? probeAll(against, widths) : Promise.resolve(liveFacts ?? new Map()),
  ]);
  const rows = widths.map((w) => {
    const o = outF.get(w);
    const l = liveF.get(w) ?? null;
    const c = layoutCheck(w, { probe: o?.probe, overflowPx: o?.overflowPx }, l, undefined, 1, true, {
      heightPct: DEFAULT_GATES.sweepHeightPct,
    });
    return {
      width: w,
      height: { out: o?.probe?.docHeight ?? o?.height, live: l?.probe?.docHeight ?? l?.height },
      pairs: {
        out: o?.probe?.pairs?.length ?? 0,
        live: l?.probe?.pairs?.length ?? 0,
        new: c.pairs?.length ?? 0,
      },
      overlapsText: { out: o?.probe?.overlapCount ?? 0, live: l?.probe?.overlapCount ?? 0 },
      clipped: c.clipped?.length ?? 0,
      offscreen: o?.probe?.offscreenCount ?? 0,
      outOfFlow: { out: o?.probe?.outOfFlow?.length ?? 0, inFlowOnLive: c.outOfFlow?.length ?? 0 },
      hscroll: o?.overflowPx ?? 0,
      pass: c.pass,
      issues: c.issues,
      samples: (c.pairs ?? []).slice(0, 2).map((p) => `${p.a} × ${p.b}`),
    };
  });
  if (flag("json"))
    console.log(
      JSON.stringify({ page, against: against ?? (liveFacts ? "run live facts" : null), rows }, null, 1),
    );
  else {
    console.log(
      `page: ${page}\nagainst: ${against ?? (liveFacts ? "the run's live facts" : "nothing (output facts only)")}`,
    );
    console.log(
      "width  height out/live    Δ%   text×text out/live  new pairs  cut  out-of-flow  hscroll  ok",
    );
    for (const r of rows) {
      const pct = r.height.live ? (((r.height.out - r.height.live) / r.height.live) * 100).toFixed(1) : "";
      console.log(
        `${String(r.width).padStart(5)}  ${String(r.height.out ?? "").padStart(6)}/${String(r.height.live ?? "").padEnd(6)} ${pct.padStart(6)}   ${String(r.overlapsText.out).padStart(3)}/${String(r.overlapsText.live).padEnd(3)}             ${String(r.pairs.new).padStart(3)}     ${String(r.clipped).padStart(3)}  ${String(r.outOfFlow.out).padStart(4)}/${String(r.outOfFlow.inFlowOnLive).padEnd(4)}   ${String(r.hscroll).padStart(5)}    ${r.pass ? "✓" : "✗"}  ${r.samples.join(" | ")}`,
      );
    }
    const bad = rows.filter((r) => !r.pass);
    console.log(
      `${bad.length} of ${rows.length} widths fail${bad.length ? `: ${bad.map((r) => r.width).join(", ")}` : ""}`,
    );
  }
  await cleanup();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
