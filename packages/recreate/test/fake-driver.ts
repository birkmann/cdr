// A capture driver that replays the recorded acme capture: the pipeline's logic without a browser.
import { existsSync, readFileSync } from "node:fs";
import type { CaptureDriver, Shot } from "@harness/capture";
import type { LayoutFacts } from "@harness/measure";

const REC = new URL("../../capture/test/sites/acme/recorded/", import.meta.url);
const rec = (f: string) => readFileSync(new URL(f, REC));
const RECORDED = [390, 768, 1440];
/** a recorded shot (the nearest recorded width for widths that were not recorded: the sweep) */
const liveShot = (w: number): Shot => {
  const r = RECORDED.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
  return { width: w, height: 0, png: rec(`${r}.png`), ...JSON.parse(rec(`${r}.json`).toString()) };
};

/** Layout facts with nothing wrong: no overlaps, nothing cut or off-screen, the page `docHeight` tall. */
export const cleanFacts = (docHeight = 3000): LayoutFacts => ({
  blocks: 10,
  overlaps: [],
  overlapCount: 0,
  offscreen: [],
  offscreenCount: 0,
  offscreenKeys: [],
  pairs: [],
  clipped: [],
  clippedText: [],
  outOfFlow: [],
  docHeight,
  anchors: [],
});

export interface FakeDriverOptions {
  /** a driver that only returns its shots at the end (no onShot), like an older or remote one */
  quiet?: boolean;
  /** layout facts per width: of the live page (`live`) or of the output (`out`); default cleanFacts() */
  facts?: (width: number, page: "live" | "out", url: string) => LayoutFacts;
  /** the output's section boxes per width (the build's section checks); default none (every band then fails) */
  rects?: (width: number, url: string) => Record<string, { y: number; h: number }>;
}

/** A driver that replays the recorded acme capture: the pipeline's logic without a browser. */
export function fakeDriver(
  calls: string[],
  { quiet = false, facts, rects }: FakeDriverOptions = {},
): CaptureDriver {
  const factsAt = (w: number, page: "live" | "out", url = "") => (facts ? facts(w, page, url) : cleanFacts());
  return {
    id: "fake",
    async probe(_url, o) {
      calls.push("probe");
      o?.onPeek?.({ width: 1440, height: 900, jpeg: Buffer.from("peek") });
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
    async capture(_url, plan, o) {
      calls.push(`capture ${plan.width}`);
      // recordings exist for the captured widths only (the sweep widths have no live shot then)
      const shots = (o?.shotWidths ?? [])
        .filter((w) => existsSync(new URL(`${w}.png`, REC)))
        .map((w) => ({ ...liveShot(w), probe: factsAt(w, "live") }));
      // like the Chrome driver: each shot reported as soon as it is taken (none at all with `quiet`)
      if (!quiet) for (const shot of shots) o?.onShot?.(shot);
      const probes = (o?.probeWidths ?? []).map((w) => {
        const f = factsAt(w, "live");
        return {
          width: w,
          height: f.docHeight ?? 0,
          png: Buffer.alloc(0),
          texts: [],
          overflowPx: 0,
          probe: f,
        };
      });
      if (!quiet) for (const p of probes) o?.onProbe?.(p);
      return {
        snapshot: JSON.parse(rec(`${plan.width}.snapshot.json`).toString()),
        finalUrl: "https://acme.example/",
        skipped: plan.width === 1440 ? ["menu at 1600px"] : [],
        shots,
        ...(probes.length ? { probes } : {}),
        ms: 1,
      };
    },
    async shoot(url, widths, o) {
      calls.push(`shoot ${widths.join(",")}${o?.factsOnly ? " (facts)" : ""}`);
      // the output measured "as live": same pixels and texts, every interaction working
      return widths.map((w) => ({
        ...liveShot(w),
        ...(o?.factsOnly ? { png: Buffer.alloc(0) } : {}),
        probe: o?.probe?.includes("overlapCount")
          ? factsAt(w, "out", url)
          : o?.probe?.includes("data-open-overlay")
            ? {
                menu: { opened: true },
                submenu: { opened: true },
                carousels: [{ moved: true }],
                pinned: { stays: true },
              }
            : o?.probe?.includes("data-section")
              ? (rects?.(w, url) ?? {})
              : null,
      }));
    },
  };
}
