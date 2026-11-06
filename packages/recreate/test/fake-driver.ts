// A capture driver that replays the recorded acme capture: the pipeline's logic without a browser.
import { existsSync, readFileSync } from "node:fs";
import type { CaptureDriver, Shot } from "@harness/capture";

const REC = new URL("../../capture/test/sites/acme/recorded/", import.meta.url);
const rec = (f: string) => readFileSync(new URL(f, REC));
const RECORDED = [390, 768, 1440];
/** a recorded shot (the nearest recorded width for widths that were not recorded: the sweep) */
const liveShot = (w: number): Shot => {
  const r = RECORDED.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
  return { width: w, height: 0, png: rec(`${r}.png`), ...JSON.parse(rec(`${r}.json`).toString()) };
};

/** A driver that replays the recorded acme capture: the pipeline's logic without a browser. */
/** `quiet`: a driver that only returns its shots at the end (no onShot), like an older or remote one. */
export function fakeDriver(calls: string[], { quiet = false } = {}): CaptureDriver {
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
      const shots = (o?.shotWidths ?? []).filter((w) => existsSync(new URL(`${w}.png`, REC))).map(liveShot);
      // like the Chrome driver: each shot reported as soon as it is taken (none at all with `quiet`)
      if (!quiet) for (const shot of shots) o?.onShot?.(shot);
      return {
        snapshot: JSON.parse(rec(`${plan.width}.snapshot.json`).toString()),
        finalUrl: "https://acme.example/",
        skipped: plan.width === 1440 ? ["menu at 1600px"] : [],
        shots,
        ms: 1,
      };
    },
    async shoot(_url, widths, o) {
      calls.push(`shoot ${widths.join(",")}`);
      // the output measured "as live": same pixels and texts, every interaction working
      return widths.map((w) => ({
        ...liveShot(w),
        probe: o?.probe?.includes("overlapCount")
          ? { blocks: 10, overlaps: [], overlapCount: 0, offscreen: [], offscreenCount: 0 }
          : o?.probe?.includes("data-open-overlay")
            ? {
                menu: { opened: true },
                submenu: { opened: true },
                carousels: [{ moved: true }],
                pinned: { stays: true },
              }
            : null,
      }));
    },
  };
}
