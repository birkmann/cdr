// Agent tools of the recreate pipeline. Registered only when `recreate.enabled` is not
// false; `recreate_capture` is the consent gate and only ever runs after an explicit request (skill recreate-url).
import { existsSync, readFileSync } from "node:fs";
import type { RecreateRequest, RecreateStage, RecreateTarget } from "@harness/protocol";
import { isRunId, RunDir, runRecreate, type RecreateResult, type RunManifest } from "@harness/recreate";
import { formatReport, sectionBand, type MeasureReport } from "@harness/measure";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { recreateHost } from "./host.js";

function needRun(ctx: ToolContext, run: unknown): { dir: RunDir; m: RunManifest } | ToolResult {
  if (typeof run !== "string" || !run)
    return { ok: false, output: "Pass `run`: the run id recreate_capture returned." };
  if (!isRunId(run)) return { ok: false, output: `"${run}" is not a run id (recreate_capture returns one).` };
  const dir = new RunDir(ctx.projectRoot, run);
  if (!dir.exists("manifest.json"))
    return { ok: false, output: `No recreation run "${run}" in this project.` };
  let m: RunManifest;
  try {
    m = dir.manifest();
  } catch (e) {
    return { ok: false, output: `Run "${run}" has an unreadable manifest.json: ${(e as Error).message}` };
  }
  if (!m?.request || typeof m.request.url !== "string")
    return { ok: false, output: `Run "${run}" has no request in its manifest.json.` };
  return { dir, m };
}

/** A JSON file of the run, or a tool error when it is missing or unreadable. */
function readRunJson<T>(dir: RunDir, rel: string, hint: string): T | ToolResult {
  if (!dir.exists(rel)) return { ok: false, output: `${dir.rel(rel)} is missing. ${hint}` };
  try {
    return dir.readJson<T>(rel);
  } catch (e) {
    return { ok: false, output: `${dir.rel(rel)} is unreadable: ${(e as Error).message}` };
  }
}
const isResult = (x: unknown): x is ToolResult =>
  !!x && typeof x === "object" && "ok" in x && "output" in x && typeof (x as ToolResult).ok === "boolean";

/**
 * The request a tool re-runs a stage with. Only what a stage needs is taken from the stored manifest (the URL, the
 * widths, targets, style, repair); never `out` (a model can write manifest.json) — consent stays the pipeline's.
 */
export function resumeRequest(
  m: RunManifest,
  run: string,
  from: RecreateStage,
  extra: { to?: RecreateTarget[]; style?: "tailwind" | "css-modules" | "vanilla" } = {},
): RecreateRequest {
  const q = m.request;
  const to = [...new Set([...(Array.isArray(q.to) && q.to.length ? q.to : ["static"]), ...(extra.to ?? [])])];
  const style = extra.style ?? q.style;
  return {
    url: q.url,
    run,
    from,
    to,
    ...(Array.isArray(q.widths) && q.widths.length ? { widths: q.widths } : {}),
    ...(style ? { style } : {}),
    ...(typeof q.repair === "boolean" ? { repair: q.repair } : {}),
  };
}

function stageLines(r: RecreateResult): string {
  return Object.entries(r.manifest.stages)
    .map(
      ([k, v]) =>
        `- ${k}: ${v?.status}${v?.ms ? ` (${Math.round(v.ms / 1000)} s)` : ""}${v?.detail ? ` — ${v.detail}` : ""}${v?.skipped?.length ? ` · skipped: ${v.skipped.slice(0, 6).join(", ")}` : ""}`,
    )
    .join("\n");
}

async function runStages(
  ctx: ToolContext,
  got: { m: RunManifest },
  run: string,
  from: RecreateStage,
  stopAfter: RecreateStage,
  extra: { to?: RecreateTarget[]; style?: "tailwind" | "css-modules" | "vanilla" } = {},
): Promise<RecreateResult> {
  return runRecreate(resumeRequest(got.m, run, from, extra), recreateHost(ctx), { stopAfter });
}

export const recreateCaptureTool: Tool = {
  name: "recreate_capture",
  description:
    "Capture a live web page for a 1:1 recreation: probes its layout ranges, captures it in headless Chrome at each device class (menus, sliders, widget states, fonts, images) and converts it to a scene with ordered sections. " +
    "Only when the user explicitly asked to recreate / clone / copy a page exactly (load the recreate-url skill first). Always asks the user for consent. Returns the run id for the other recreate_* tools.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The page URL, with or without https:// (nestle.com works)." },
      widths: {
        type: "array",
        items: { type: "integer" },
        description: "Capture widths in CSS px. Default: the page's own layout ranges (else 390, 768, 1440).",
      },
    },
    required: ["url"],
  },
  readOnly: false,
  selfGated: true,
  risk: () => "high",
  async execute(args: { url: string; widths?: number[] }, ctx) {
    const r = await runRecreate(
      { url: args.url, ...(args.widths?.length ? { widths: args.widths } : {}) },
      recreateHost(ctx, { consentArgs: args }),
      { stopAfter: "scene" },
    );
    if (r.status !== "success")
      return { ok: false, output: `Capture failed: ${r.summary}\n${stageLines(r)}` };
    const dir = new RunDir(ctx.projectRoot, r.runId);
    const sections = readRunJson<{ id: string; kind: string; label: string; copies: { width: number }[] }[]>(
      dir,
      "scene/sections.json",
      "The scene stage did not finish.",
    );
    if (isResult(sections)) return sections;
    const page = readRunJson<{ warnings?: string[] }>(
      dir,
      "scene/page.json",
      "The scene stage did not finish.",
    );
    const warnings = isResult(page) ? [] : (page.warnings ?? []);
    return {
      ok: true,
      output: [
        `Run ${r.runId} (${r.dir}). Captured ${r.manifest.finalUrl ?? args.url} at ${(r.manifest.variants ?? []).map((v) => `${v.width}px (from ${v.minWidth})`).join(", ")}.`,
        stageLines(r),
        `Sections (${sections.length}): ${sections.map((s) => `${s.id} [${s.kind}]`).join(", ")}`,
        warnings.length ? `Warnings: ${warnings.slice(0, 8).join("; ")}` : "",
        "Next: recreate_build with this run id.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};

export const recreateBuildTool: Tool = {
  name: "recreate_build",
  description:
    "Build the captured page as static HTML in one pass and score every section against the live page (one shot per width). Sections that miss their threshold are repaired by the model only when the run was started with repair: true.",
  parameters: {
    type: "object",
    properties: { run: { type: "string", description: "Run id from recreate_capture." } },
    required: ["run"],
  },
  readOnly: false,
  risk: () => "medium",
  async execute(args: { run: string }, ctx) {
    const got = needRun(ctx, args.run);
    if ("ok" in got) return got;
    // the preview shows the page from the start; it refreshes as sections are added
    const index = got.dir.rel("out/static/index.html");
    let shown = false;
    const r = await runRecreate(
      resumeRequest(got.m, args.run, "build"),
      {
        ...recreateHost(ctx),
        progress: (e) => {
          ctx.emit(e);
          if (!shown && e.type === "recreate.section" && e.status === "building") {
            shown = true;
            ctx.emit({ type: "preview.ready", path: index, title: "Recreation" });
          }
        },
      },
      { stopAfter: "build" },
    );
    return {
      ok: r.status === "success",
      output: `${r.summary}\n${stageLines(r)}\nOutput: ${index}. Next: recreate_measure.`,
      ...(r.status === "success" ? { edited: [index] } : {}),
    };
  },
};

export const recreateMeasureTool: Tool = {
  name: "recreate_measure",
  description:
    "Compare the recreation with the live page at every captured width: pixel difference, visible text, page height, horizontal scroll, menus / sliders / pinned header, and the vision verdict when a vision model is configured. Writes the compare page.",
  parameters: {
    type: "object",
    properties: { run: { type: "string", description: "Run id from recreate_capture." } },
    required: ["run"],
  },
  // shoots the output in headless Chrome and writes the measure/ and compare/ files
  readOnly: false,
  risk: () => "medium",
  async execute(args: { run: string }, ctx) {
    const got = needRun(ctx, args.run);
    if ("ok" in got) return got;
    const r = await runStages(ctx, got, args.run, "measure", "measure");
    const reports = r.reports;
    const images = reports.flatMap((rep: MeasureReport) =>
      rep.widths.flatMap((w) => {
        const worst = [...w.bands]
          .filter((b) => b.mismatch > 0.05)
          .sort((a, b) => b.mismatch - a.mismatch)[0];
        if (!worst) return [];
        const livePath = `measure/${rep.target}/${w.width}/live.png`;
        const outPath = `measure/${rep.target}/${w.width}/out.png`;
        if (!got.dir.exists(livePath) || !got.dir.exists(outPath)) return [];
        const live = got.dir.read(livePath);
        const out = got.dir.read(outPath);
        const band = sectionBand(live, out, worst.y, worst.h);
        return [
          {
            mimeType: "image/png",
            data: band.live.toString("base64"),
            name: `live-${w.width}-${worst.y}.png`,
          },
          { mimeType: "image/png", data: band.out.toString("base64"), name: `out-${w.width}-${worst.y}.png` },
        ];
      }),
    );
    return {
      ok: r.status === "success",
      output: `${reports.map(formatReport).join("\n\n") || r.summary}\nCompare page: ${r.comparePath ?? "(none)"}`,
      ...(images.length ? { images: images.slice(0, 6) } : {}),
    };
  },
};

export const recreateComponentsTool: Tool = {
  name: "recreate_components",
  description:
    "Extract the page's component sets (repeated parts and sections, one set per part with a breakpoint axis, props from how copies differ), name them with the configured model (validated, retried, deterministic fallback), lint them and complete the design system (tokens, type roles, generated essentials).",
  parameters: { type: "object", properties: { run: { type: "string" } }, required: ["run"] },
  readOnly: false,
  risk: () => "medium",
  async execute(args: { run: string }, ctx) {
    const got = needRun(ctx, args.run);
    if ("ok" in got) return got;
    const r = await runStages(ctx, got, args.run, "components", "system", { to: ["tokens"] });
    const sets = got.dir.exists("components/sets.json")
      ? got.dir.readJson<{ name: string; kind?: string; variants: Record<string, unknown> }[]>(
          "components/sets.json",
        )
      : [];
    const lint = got.dir.exists("components/lint.json")
      ? got.dir.readJson<{ ok: boolean; checks: { ok: boolean; label: string; detail?: string }[] }>(
          "components/lint.json",
        )
      : null;
    return {
      ok: r.status === "success",
      output: [
        stageLines(r),
        `${sets.length} sets: ${sets
          .slice(0, 60)
          .map((s) => `${s.name}${s.kind ? ` (${s.kind})` : ""}`)
          .join(", ")}`,
        lint
          ? `Lint ${lint.ok ? "passes" : "fails"}: ${
              lint.checks
                .filter((c) => !c.ok)
                .map((c) => `${c.label} ${c.detail ?? ""}`)
                .join("; ") || "all checks pass"
            }`
          : "",
      ].join("\n"),
    };
  },
};

export const recreateConvertTool: Tool = {
  name: "recreate_convert",
  description:
    "Convert a recreation into a project: react-vite (Vite + React + TypeScript, styles tailwind | css-modules | vanilla) or a design-system package (ds-react, ds-lit, ds-angular), or tokens. Runs the components stage first when needed.",
  parameters: {
    type: "object",
    properties: {
      run: { type: "string" },
      to: { type: "string", enum: ["react-vite", "ds-react", "ds-lit", "ds-angular", "tokens", "design-md"] },
      style: { type: "string", enum: ["tailwind", "css-modules", "vanilla"] },
    },
    required: ["run", "to"],
  },
  readOnly: false,
  risk: () => "medium",
  async execute(
    args: { run: string; to: RecreateTarget; style?: "tailwind" | "css-modules" | "vanilla" },
    ctx,
  ) {
    const got = needRun(ctx, args.run);
    if ("ok" in got) return got;
    const from: RecreateStage = got.dir.exists("design-system/system.json") ? "convert" : "components";
    const r = await runStages(ctx, got, args.run, from, "ds-export", { to: [args.to], style: args.style });
    const out = r.outputs.find((o) => o.target === args.to);
    return {
      ok: r.status === "success" && !!out,
      output: `${stageLines(r)}\n${out ? `Written to ${out.path}` : `No ${args.to} output.`}`,
    };
  },
};

export const recreateSectionTool: Tool = {
  name: "recreate_section",
  description:
    "Show one section of a recreation for a repair: its markup between the section markers, and crops of the live page and of the recreation at each width (images). Patch only between `<!-- section:ID -->` and `<!-- /section -->`, never change copy or photos.",
  parameters: {
    type: "object",
    properties: {
      run: { type: "string" },
      id: { type: "string", description: "Section id (see recreate_capture)." },
    },
    required: ["run", "id"],
  },
  readOnly: true,
  risk: () => "low",
  async execute(args: { run: string; id: string }, ctx) {
    const got = needRun(ctx, args.run);
    if ("ok" in got) return got;
    const sections = readRunJson<
      { id: string; label: string; kind: string; copies: { width: number; y: number; h: number }[] }[]
    >(got.dir, "scene/sections.json", "Capture the page first (recreate_capture).");
    if (isResult(sections)) return sections;
    const s = sections.find((x) => x.id === args.id);
    if (!s)
      return {
        ok: false,
        output: `No section "${args.id}". Sections: ${sections.map((x) => x.id).join(", ")}`,
      };
    const file = got.dir.path("out/static/index.html");
    if (!existsSync(file)) return { ok: false, output: "Build the run first (recreate_build)." };
    const html = readFileSync(file, "utf8");
    const blocks = [
      ...html.matchAll(new RegExp(`<!-- section:${args.id} -->[\\s\\S]*?<!-- /section -->`, "g")),
    ].map((m) => m[0]);
    const images = s.copies.flatMap((c) => {
      const livePath = `measure/static/${c.width}/live.png`;
      const outPath = `measure/static/${c.width}/out.png`;
      if (!got.dir.exists(livePath) || !got.dir.exists(outPath)) return [];
      const band = sectionBand(got.dir.read(livePath), got.dir.read(outPath), c.y, c.h);
      return [
        { mimeType: "image/png", data: band.live.toString("base64"), name: `live-${c.width}.png` },
        { mimeType: "image/png", data: band.out.toString("base64"), name: `out-${c.width}.png` },
      ];
    });
    return {
      ok: true,
      output: [
        `Section ${s.id} "${s.label}" (${s.kind}) in ${got.dir.rel("out/static/index.html")}, ${blocks.length} copies (one per breakpoint variant). Styles: ${got.dir.rel("out/static/styles.css")}.`,
        "<document-data>",
        blocks.join("\n").slice(0, 40_000),
        "</document-data>",
        images.length
          ? "Images: live then recreation per width (crops measured at the last recreate_measure)."
          : "Run recreate_measure for crops.",
      ].join("\n"),
      ...(images.length ? { images } : {}),
    };
  },
};

export function recreateTools(enabled = true): Tool[] {
  if (!enabled) return [];
  return [
    recreateCaptureTool,
    recreateBuildTool,
    recreateMeasureTool,
    recreateComponentsTool,
    recreateConvertTool,
    recreateSectionTool,
  ];
}
