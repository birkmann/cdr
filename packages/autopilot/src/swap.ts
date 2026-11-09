// The swap contract (plan §2.4): replacing a measured box with a primitive changes pixels. A swap stays only if every
// section it sits in keeps its parity gate; otherwise that box keeps the measured markup and the swap is recorded as
// DS_SWAP_REVERTED with its crop. This is the accept/rollback rule of the repair stage, applied to component substitution.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureScreenshot,
  compareImages,
  loadForCaptureInfo,
  newCaptureContext,
  type ViewportSpec,
} from "@harness/mirror-verify";
import { decodePng, encodePng } from "@harness/recreate";
import type { StageIssue } from "./types.js";

/** Measured parity (0..1) per section/set and viewport. */
export type ParityTable = Record<string, Record<string, number>>;

/** Where a swapped set was rendered. */
export interface SwapUsage {
  set: string;
  section: string;
  viewport: string;
}

export interface SwapDecision {
  /** sets that stay swapped */
  keep: string[];
  revert: { set: string; section: string; viewport: string; sectionParity: number; setParity: number }[];
}

/**
 * Which swaps to revert after a measurement: a set used in a section (at a viewport) whose parity fell below `gate`.
 * The sets whose own crops match the page least go first; when none of them stands out, every swap in the section does.
 * Pure: the numbers come in, the decision goes out.
 */
export function decideSwaps(input: {
  enabled: readonly string[];
  usage: readonly SwapUsage[];
  sections: ParityTable;
  sets: ParityTable;
  gate: number;
  setFloor?: number;
}): SwapDecision {
  const floor = input.setFloor ?? input.gate;
  const revert: SwapDecision["revert"] = [];
  const reverted = new Set<string>();
  for (const [section, byVp] of Object.entries(input.sections))
    for (const [viewport, sectionParity] of Object.entries(byVp)) {
      if (sectionParity >= input.gate) continue;
      const here = input.usage.filter(
        (u) => u.section === section && u.viewport === viewport && input.enabled.includes(u.set),
      );
      if (!here.length) continue;
      const setParity = (set: string) => input.sets[set]?.[viewport] ?? 1;
      const bad = here.filter((u) => setParity(u.set) < floor);
      for (const u of bad.length ? bad : here) {
        if (reverted.has(u.set)) continue;
        reverted.add(u.set);
        revert.push({ set: u.set, section, viewport, sectionParity, setParity: setParity(u.set) });
      }
    }
  return { keep: input.enabled.filter((s) => !reverted.has(s)), revert };
}

export interface SectionBand {
  id: string;
}

export interface ParityMeasure {
  sections: ParityTable;
  sets: ParityTable;
  usage: SwapUsage[];
  /** crops per swapped set and viewport, for the reports */
  crops: Record<string, string>;
}

interface RectFacts {
  sections: Record<string, { x: number; y: number; w: number; h: number }>;
  primitives: { set: string; section: string | null; x: number; y: number; w: number; h: number }[];
}

const FACTS_JS = `(() => {
  const v = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 };
  const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } };
  const sections = {};
  for (const e of document.querySelectorAll('[data-section]')) {
    if (!v(e)) continue;
    const id = e.getAttribute('data-section');
    if (!sections[id]) sections[id] = rect(e);
  }
  const primitives = [];
  for (const e of document.querySelectorAll('[data-ds-primitive]')) {
    if (!v(e)) continue;
    const sec = e.closest('[data-section]');
    primitives.push({ set: e.getAttribute('data-ds-set') || e.getAttribute('data-ds-primitive'), section: sec ? sec.getAttribute('data-section') : null, ...rect(e) });
  }
  return { sections, primitives };
})()`;

/**
 * The replica next to the frozen page, with the routine verify uses: shots of both sides at every viewport, cropped to
 * every section and every swapped primitive at the box they have on the new page.
 */
export async function measureSectionParity(o: {
  browser: Parameters<typeof newCaptureContext>[0];
  oldUrl: string;
  newUrl: string;
  viewports: ViewportSpec[];
  sections: readonly SectionBand[];
  capture: Parameters<typeof newCaptureContext>[2];
  outDir: string;
  log(line: string): void;
}): Promise<ParityMeasure> {
  const sections: ParityTable = {};
  const sets: ParityTable = {};
  const usage: SwapUsage[] = [];
  const crops: Record<string, string> = {};
  mkdirSync(o.outDir, { recursive: true });
  for (const vp of o.viewports) {
    const shot = async (url: string) => {
      const ctx = await newCaptureContext(o.browser, vp, o.capture);
      try {
        const page = await ctx.newPage();
        await loadForCaptureInfo(page, url, vp);
        const facts = (await page.evaluate(FACTS_JS).catch(() => null)) as RectFacts | null;
        const png = await captureScreenshot(page, url, vp, { mask: [], skipLoad: true });
        return { png, facts };
      } finally {
        await ctx.close().catch(() => undefined);
      }
    };
    const [oldShot, newShot] = [await shot(o.oldUrl), await shot(o.newUrl)];
    if (!newShot.facts) continue;
    const old = oldShot.png,
      nu = newShot.png;
    for (const s of o.sections) {
      // the same page coordinates on both sides: a section that moved is a mismatch here, as it is for the page's gate
      const rect = newShot.facts.sections[s.id];
      if (!rect) continue;
      const box = { x: 0, y: Math.floor(rect.y), w: vp.width, h: Math.ceil(rect.h) };
      const parity = compareCrops(old, nu, box, box);
      (sections[s.id] ??= {})[vp.name] = parity.parity;
    }
    for (const p of newShot.facts.primitives) {
      if (p.section) usage.push({ set: p.set, section: p.section, viewport: vp.name });
      const rect = { x: Math.floor(p.x), y: Math.floor(p.y), w: Math.ceil(p.w), h: Math.ceil(p.h) };
      const cmp = compareCrops(old, nu, rect, rect);
      const key = `${p.set}@${vp.name}`;
      const cur = sets[p.set]?.[vp.name] ?? 1;
      if (cmp.parity <= cur) {
        (sets[p.set] ??= {})[vp.name] = cmp.parity;
        crops[key] = writeCrops(o.outDir, key, cmp);
      }
    }
  }
  return { sections, sets, usage, crops };
}

function writeCrops(dir: string, key: string, cmp: ReturnType<typeof compareCrops>): string {
  const file = join(dir, `${key.replace(/[^\w.@-]/g, "_")}.diff.png`);
  writeFileSync(file, cmp.diffPng);
  return file;
}

/** Parity of the same box cropped from both full-page shots (the diff image is kept). */
function compareCrops(
  oldPng: Buffer,
  newPng: Buffer,
  oldRect: { x: number; y: number; w: number; h: number },
  newRect: { x: number; y: number; w: number; h: number },
): { parity: number; diffPng: Buffer } {
  const a = cropPng(oldPng, oldRect);
  const b = cropPng(newPng, newRect);
  const cmp = compareImages(a, b);
  return { parity: cmp.parity, diffPng: cmp.diffPng };
}

/** A box cut out of a full-page shot, as a PNG. */
export function cropPng(png: Buffer, r: { x: number; y: number; w: number; h: number }): Buffer {
  const src = decodePng(png);
  const channels = Math.round(src.data.length / (src.width * src.height));
  const x0 = Math.max(0, Math.min(Math.round(r.x), src.width - 1));
  const y0 = Math.max(0, Math.min(Math.round(r.y), src.height - 1));
  const w = Math.max(1, Math.min(Math.round(r.w), src.width - x0));
  const h = Math.max(1, Math.min(Math.round(r.h), src.height - y0));
  const data = new Uint8Array(w * h * channels);
  for (let row = 0; row < h; row++) {
    const from = (y0 + row) * src.width * channels + x0 * channels;
    data.set(src.data.subarray(from, from + w * channels), row * w * channels);
  }
  return encodePng({ width: w, height: h, data });
}

/** DS_SWAP_REVERTED issues for a decision. */
export function revertIssues(decision: SwapDecision, crops: Record<string, string>): StageIssue[] {
  return decision.revert.map((r) => ({
    code: "DS_SWAP_REVERTED",
    message: `${r.set} at ${r.viewport} in section ${r.section}: section parity ${r.sectionParity.toFixed(4)}, swap crop ${r.setParity.toFixed(4)}; the set keeps its measured markup`,
    severity: "warning" as const,
    ...(crops[`${r.set}@${r.viewport}`] ? { evidence: [crops[`${r.set}@${r.viewport}`]!] } : {}),
  }));
}

/** The source of `packages/site/src/swaps.ts`. */
export function swapsSource(enabled: readonly string[], all: readonly string[]): string {
  const on = new Set(enabled);
  const map = Object.fromEntries(all.map((s) => [s, on.has(s)]));
  return `// Written by the replica stage: which sets render through a primitive.\nexport const SWAPS: Record<string, boolean> = ${JSON.stringify(map)}\n`;
}
