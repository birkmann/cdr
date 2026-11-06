// A measurement of one output against the live page: per width pixel / text / layout /
// interaction results, and the gates that fail a run. Pure: shots come in as PNG bytes, the report goes out as JSON.
import { decodePng, encodePng, cropRows, type RgbImage } from "@harness/capture";
import { interactionChecks, type InteractionCheck, type LiveExpectations } from "./interactions.js";
import { bandMismatch, pixelDiff, type PixelReport } from "./pixel.js";
import { textCompare, type TextReport } from "./text.js";
import { layoutCheck, type LayoutCheck } from "./layout.js";

/** Gate thresholds (config `recreate.gates`). */
export interface Gates {
  /** share of differing pixels per width after shift tolerance */
  pixel: number;
  /** missing + extra visible strings the output itself is responsible for */
  text: number;
  /** page height within this many percent of the live page */
  heightPct: number;
  /** pixel mismatch allowed at the sweep widths (no exact capture there) */
  responsivePixel: number;
}

export const DEFAULT_GATES: Gates = { pixel: 0.01, text: 0, heightPct: 3, responsivePixel: 0.05 };

export interface GateResult {
  name: "pixel" | "text" | "layout" | "interactions" | "responsive" | "components" | "build" | "a11y";
  pass: boolean;
  detail: string;
}

export interface WidthMeasurement {
  width: number;
  pixel: number;
  shifted: number;
  textReal: number;
  textDrift: number;
  liveHeight: number;
  outHeight: number;
  heightPct: number;
  hscroll: number;
  bands: PixelReport["bands"];
  text: TextReport;
  interactions: InteractionCheck[];
  /** paths of live.png / out.png / diff.png relative to the run's measure folder */
  images?: { live: string; out: string; diff: string };
}

export interface MeasureReport {
  target: string;
  at: string;
  widths: WidthMeasurement[];
  gates: GateResult[];
  pass: boolean;
  vision?: {
    width: number;
    verdict: string;
    differences: { issue: string; severity: string; area?: string }[];
  }[];
}

export interface ShotInput {
  width: number;
  png: Buffer;
  texts?: string[];
  overflowPx?: number;
  probe?: unknown;
}

export interface MeasureInput {
  target: string;
  live: ShotInput[];
  out: ShotInput[];
  /** the texts the capture saw per width (drift detection) */
  captured?: Record<number, string[]>;
  /** what the live page has per width (interaction checks) */
  expectations?: Record<number, LiveExpectations>;
  /** page-space row ranges per width excluded from the pixel gate (live content: feeds, tickers) */
  exclude?: Record<number, [number, number][]>;
  /**
   * page-space boxes per width painted out of both images before the diff: moving media (a hero video, a canvas
   * animation) never shows the same frame twice, so its pixels say nothing about the recreation
   */
  mask?: Record<number, MaskRect[]>;
  gates?: Partial<Gates>;
  /**
   * shots at widths that were not captured (sweepWidths): the output (probe: LAYOUT_CHECK_JS) and, where taken, the
   * live page at the same width (probe: LAYOUT_CHECK_JS too). Every captured width's output is also layout-checked
   * when its probe carries the layout facts (`layout`).
   */
  sweep?: { out: ShotInput[]; live: ShotInput[]; spans?: [number, number][] };
}

export interface MeasureOutput {
  report: MeasureReport;
  /** per width: live / out / diff PNGs to write next to the report */
  images: { width: number; live: Buffer; out: Buffer; diff: Buffer }[];
}

export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `img` with `rects` filled in one neutral grey (a copy; the same image without rects). */
export function maskRects(img: RgbImage, rects: MaskRect[] | undefined): RgbImage {
  if (!rects?.length) return img;
  const data = new Uint8Array(img.data);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)),
      x1 = Math.min(img.width, Math.ceil(r.x + r.w));
    const y0 = Math.max(0, Math.floor(r.y)),
      y1 = Math.min(img.height, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) data.fill(128, (y * img.width + x0) * 3, (y * img.width + x1) * 3);
  }
  return { width: img.width, height: img.height, data };
}

/** Compare every width the live page and the output were both shot at, and evaluate the gates. */
export function measure(input: MeasureInput): MeasureOutput {
  const gates = { ...DEFAULT_GATES, ...input.gates };
  const widths: WidthMeasurement[] = [];
  const images: MeasureOutput["images"] = [];
  for (const live of input.live) {
    const out = input.out.find((o) => o.width === live.width);
    if (!out) continue;
    const ref = maskRects(decodePng(live.png), input.mask?.[live.width]),
      got = maskRects(decodePng(out.png), input.mask?.[live.width]);
    const { report, diff } = pixelDiff(ref, got, { exclude: input.exclude?.[live.width] });
    const text = textCompare(live.texts ?? [], out.texts ?? [], input.captured?.[live.width] ?? null);
    const real = text.real ?? { missing: text.missing, extra: text.extra };
    const heightPct = ref.height ? (Math.abs(got.height - ref.height) / ref.height) * 100 : 0;
    widths.push({
      width: live.width,
      pixel: report.mismatch,
      shifted: report.shifted,
      textReal: real.missing.length + real.extra.length,
      textDrift: text.drift?.count ?? 0,
      liveHeight: ref.height,
      outHeight: got.height,
      heightPct,
      hscroll: out.overflowPx ?? 0,
      bands: report.bands,
      text,
      interactions: input.expectations?.[live.width]
        ? interactionChecks(out.probe, input.expectations[live.width])
        : [],
      images: {
        live: `${live.width}/live.png`,
        out: `${live.width}/out.png`,
        diff: `${live.width}/diff.png`,
      },
    });
    images.push({ width: live.width, live: live.png, out: out.png, diff: encodePng(diff) });
  }
  const list = (f: (w: WidthMeasurement) => string | null) => widths.map(f).filter(Boolean).join("; ");
  const fails = (f: (w: WidthMeasurement) => boolean) => widths.filter(f);
  const result: GateResult[] = [
    {
      name: "pixel",
      pass: widths.length > 0 && fails((w) => w.pixel > gates.pixel).length === 0,
      detail:
        list((w) => `${w.width}px ${(w.pixel * 100).toFixed(2)} %`) +
        ` (gate ≤ ${(gates.pixel * 100).toFixed(1)} %)`,
    },
    {
      name: "text",
      pass: widths.length > 0 && fails((w) => w.textReal > gates.text).length === 0,
      detail: list(
        (w) => `${w.width}px ${w.textReal} missing/extra${w.textDrift ? `, ${w.textDrift} drift` : ""}`,
      ),
    },
    {
      name: "layout",
      pass: widths.length > 0 && fails((w) => w.hscroll > 0 || w.heightPct > gates.heightPct).length === 0,
      detail: list(
        (w) =>
          `${w.width}px height ${w.heightPct.toFixed(1)} %${w.hscroll ? `, ${w.hscroll}px horizontal scroll` : ""}`,
      ),
    },
    {
      name: "interactions",
      pass: widths.every((w) => w.interactions.every((c) => c.result !== "fail")),
      detail:
        list((w) =>
          w.interactions.length
            ? `${w.width}px ${w.interactions.map((c) => `${c.name} ${c.result}${c.detail ? ` (${c.detail})` : ""}`).join(", ")}`
            : null,
        ) || "nothing to check",
    },
  ];
  // responsive: no overlapping text, nothing pushed off-screen, no sideways scroll at any width, and close to the live
  // page where it was shot (beyond the widest capture the layout must hold, not be extrapolated)
  const sweep: LayoutCheck[] = [];
  for (const o of input.sweep?.out ?? []) {
    const l = input.sweep?.live.find((x) => x.width === o.width) ?? null;
    let pixel: number | undefined;
    if (l) {
      try {
        // the live page's moving media at this width (its layout probe), painted out of both shots
        const media = (l.probe as { media?: MaskRect[] } | undefined)?.media;
        pixel = pixelDiff(maskRects(decodePng(l.png), media), maskRects(decodePng(o.png), media)).report
          .mismatch;
      } catch {
        pixel = undefined;
      }
    }
    // pixels must match only where the output has measured geometry around this width (inside a variant's span)
    const spans = input.sweep?.spans;
    const inside = !spans || spans.some(([a, b]) => o.width >= a && o.width <= b);
    sweep.push(layoutCheck(o.width, o, l, pixel, gates.responsivePixel, inside));
  }
  if (input.sweep)
    result.push({
      name: "responsive",
      pass: sweep.every((c) => c.pass),
      detail:
        sweep
          .map(
            (c) =>
              `${c.width}px ${c.pass ? "ok" : c.issues.join(", ")}${c.pixel !== undefined && c.pass ? ` (${(c.pixel * 100).toFixed(1)} %)` : ""}`,
          )
          .join("; ") || "no sweep widths",
    });
  return {
    report: {
      target: input.target,
      ...(input.sweep ? { sweep } : {}),
      at: new Date().toISOString(),
      widths,
      gates: result,
      pass: result.every((g) => g.pass),
    },
    images,
  };
}

/** One section's band at one width: pixel mismatch of its rows + the live and output crops (for a repair turn). */
export function sectionBand(
  live: Buffer | RgbImage,
  out: Buffer | RgbImage,
  y: number,
  h: number,
): { pixel: number; live: Buffer; out: Buffer } {
  const ref = Buffer.isBuffer(live) ? decodePng(live) : live;
  const got = Buffer.isBuffer(out) ? decodePng(out) : out;
  const { report } = pixelDiff(cropRows(ref, y, h), cropRows(got, y, h));
  return {
    pixel: bandMismatch(report, 0, h),
    live: encodePng(cropRows(ref, y, h)),
    out: encodePng(cropRows(got, y, h)),
  };
}

/** Short summary for tool outputs and the CLI. */
export function formatReport(r: MeasureReport): string {
  const lines = [
    `${r.target}: ${
      r.pass
        ? "all gates pass"
        : `failing: ${r.gates
            .filter((g) => !g.pass)
            .map((g) => g.name)
            .join(", ")}`
    }`,
  ];
  for (const w of r.widths)
    lines.push(
      `  ${w.width}px  pixel ${(w.pixel * 100).toFixed(2)} %  text ${w.textReal} missing/extra (${w.textDrift} drift)  height ${w.outHeight}/${w.liveHeight}px${w.hscroll ? `  h-scroll ${w.hscroll}px` : ""}`,
    );
  for (const g of r.gates) lines.push(`  ${g.pass ? "✓" : "✗"} ${g.name}: ${g.detail}`);
  return lines.join("\n");
}
