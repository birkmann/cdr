// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Which widths a responsive URL import captures (docs/responsive.md "Layout ranges"). fig-server measures where the
// page's own layout switches (POST /api/import/url/layout: `@media` widths, `@container` crossings and script switches,
// the page laid out just below and at each, how much changed); the import then makes one variant per device (phone,
// tablet, desktop: `devicePlan`), each applying from the site's switch nearest its device and measured at the widths of
// its own layout range (`planCaptures` is the finer plan: one variant per layout range). One capture per
// device class (phone / tablet / desktop: the user agent and touch the site sees) walks the same loaded page again at
// every other width of its class (`alt` walks, cheap), so variants share one page state and the import stays quick.

/** One width where the page's style sheets switch rules, as fig-server measured it. */
export interface LayoutSwitch {
  /** first viewport width (CSS px) of the new range */
  px: number;
  /** style rules switched there */
  rules?: number;
  /** area (viewports) of boxes that appear, disappear or change their formatting there */
  structural?: number;
  /** area (viewports) of boxes that jump sideways, resize or change their font size there */
  shifted?: number;
  /**
   * share of shown boxes (tag, role, formatting, own text; no element identity) not on the other side: catches
   * switches a script makes by re-creating its nodes
   */
  tokens?: number;
  /** what switches there: an `@media` rule, a size container's `@container` condition, a script (no CSS behind it) */
  source?: "media" | "container" | "script";
  ns?: number;
  nj?: number;
  samples?: string[];
}

/** One capture of a responsive import: its width, the range it applies from, the other widths it is measured at. */
export interface CapturePlan {
  width: number;
  minWidth: number;
  alt: number[];
}

/** Widths the import captures whatever the page's ranges are (phone, tablet, desktop: docs/responsive.md). */
export const DEFAULT_CAPTURE_WIDTHS = [390, 768, 1440] as const;
/** A switch moves this much of a viewport's area to count as a new layout: formatting changes / boxes jumping. */
export const SWITCH_STRUCTURAL = 0.005;
export const SWITCH_SHIFTED = 0.05;
/** Switches at or below this width are ignored (phones narrower than 360 px take the next range's layout, scaled). */
export const MIN_SWITCH = 361;
/** Switches closer than this keep the bigger one only. */
export const SWITCH_MERGE = 24;
/** At most this many layout ranges (variants): the least important switches go first. */
export const MAX_RANGES = 10;
/** Alternative widths are measured this far from the capture width at least. */
const ALT_MIN_GAP = 24;
/**
 * …and at most this far apart inside a variant's part of its range: between two measured widths the export follows a
 * straight line, so a kink between them (a max-width column reaching its cap, clamp() type) is off by at most a step
 */
export const ALT_STEP = 240;
/** The widest range (open-ended) is measured up to here: centred max-width layouts keep their trend past it. */
export const OPEN_RANGE_ALT = 1920;
const MIN_WIDTH = 320;
const MAX_WIDTH = 2560;

/**
 * Device widths in order of how often visitors use them: a range without a default capture is captured at the most
 * common one inside it.
 */
export const COMMON_WIDTHS = [
  1920, 390, 1366, 1440, 1536, 768, 1280, 412, 375, 360, 1024, 820, 810, 834, 1680, 1600, 430, 414, 600, 1180,
  1080, 1152, 2560, 800, 900, 960, 540, 480, 640, 720,
];

/** formatting changes: boxes that appear / disappear or switch formatting, by identity or by structure */
const structuralOf = (s: LayoutSwitch) => Math.max(s.structural ?? 0, s.tokens ?? 0);
// boxes appearing / disappearing count most (a nav collapsing into a menu button), then formatting, then jumps
const importance = (s: LayoutSwitch) => 100 * (s.tokens ?? 0) + 10 * (s.structural ?? 0) + (s.shifted ?? 0);

/** The switches that change the page's layout (measured, not just rules that never apply), merged and capped. */
export function layoutSwitches(list: readonly LayoutSwitch[], maxRanges = MAX_RANGES): number[] {
  let real = list.filter(
    (s) =>
      s.px >= MIN_SWITCH &&
      s.px <= MAX_WIDTH &&
      (structuralOf(s) >= SWITCH_STRUCTURAL || (s.shifted ?? 0) >= SWITCH_SHIFTED),
  );
  real = [...real].sort((a, b) => a.px - b.px);
  // neighbours a few px apart (`min-width: 960px` and `max-width: 960px`): one switch, the bigger one
  const merged: LayoutSwitch[] = [];
  for (const s of real) {
    const last = merged[merged.length - 1];
    if (last && s.px - last.px < SWITCH_MERGE) {
      if (importance(s) > importance(last)) merged[merged.length - 1] = s;
      continue;
    }
    merged.push(s);
  }
  const keep = [...merged].sort((a, b) => importance(b) - importance(a)).slice(0, Math.max(0, maxRanges - 1));
  return keep.map((s) => s.px).sort((a, b) => a - b);
}

/** Layout ranges [min, max) between the switches (max null = open-ended). */
export function layoutRanges(switches: readonly number[]): Array<{ min: number; max: number | null }> {
  const at = [0, ...switches];
  return at.map((min, i) => ({ min, max: at[i + 1] ?? null }));
}

/**
 * One capture per layout range: the default widths inside it, else the most common device width inside it (else its
 * middle). Each capture applies from its range's start (a second capture in one range from its own width) and is
 * measured again at the ends of the part of the range it covers (`alt`: the range's start, at least 320 px, and its
 * last width; past the widest switch up to OPEN_RANGE_ALT).
 */
export function planCaptures(
  switches: readonly number[],
  defaults: readonly number[] = DEFAULT_CAPTURE_WIDTHS,
): CapturePlan[] {
  const out: CapturePlan[] = [];
  for (const r of layoutRanges(switches)) {
    const inside = (w: number) => w >= r.min && (r.max === null || w < r.max);
    let ws = defaults.filter(inside);
    if (!ws.length) {
      const common = COMMON_WIDTHS.find((w) => inside(w) && w >= MIN_WIDTH);
      ws = [
        common ?? Math.round((Math.max(r.min, MIN_WIDTH) + (r.max === null ? r.min + 480 : r.max - 1)) / 2),
      ];
    }
    ws = [...new Set(ws)].sort((a, b) => a - b);
    ws.forEach((w, i) => {
      const start = i === 0 ? r.min : w;
      const end =
        ws[i + 1] !== undefined
          ? ws[i + 1]! - 1
          : r.max === null
            ? Math.min(MAX_WIDTH, Math.max(OPEN_RANGE_ALT, w + 480))
            : r.max - 1;
      out.push({
        width: w,
        minWidth: out.length ? start : 0,
        alt: measuredWidths(Math.max(start, MIN_WIDTH), w, end),
      });
    });
  }
  return out;
}

/**
 * Viewport widths of common devices (phones, tablets, laptops, desktops): every variant is also measured at the ones
 * inside its part of its range, so the export has the site's exact geometry there (between measured widths it follows
 * a straight line, which a text wrapping onto another line breaks)
 */
export const DEVICE_WIDTHS = [
  360, 375, 390, 393, 412, 768, 810, 820, 1024, 1280, 1366, 1440, 1536, 1728, 1920,
];
/**
 * a device width this close to another measured one (not the capture's own) adds little — 1.2 % of it, at least 8 px
 * (devices sit close together and text wraps differently every few px): each measured width is a walk
 */
const deviceGap = (w: number) => Math.max(8, 0.012 * w);

/** Widths from `a` to `b` (both ends, `w` excluded by the caller) at most ALT_STEP apart. */
function spread(a: number, b: number): number[] {
  if (b <= a) return [a];
  const n = Math.ceil((b - a) / ALT_STEP);
  return Array.from({ length: n + 1 }, (_, i) => Math.round(a + ((b - a) * i) / n));
}

/** Widths a capture at `w` is measured at besides its own, from `lo` to `end`: ALT_STEP apart and the device widths. */
function measuredWidths(lo: number, w: number, end: number): number[] {
  const alt = [...spread(lo, w), ...spread(w, end)].filter((x) => Math.abs(x - w) >= ALT_MIN_GAP);
  // (a device a few px off the capture width still is one: text wraps differently there)
  for (const d of DEVICE_WIDTHS)
    if (d >= lo && d <= end && Math.abs(d - w) >= 2 && alt.every((x) => Math.abs(x - d) >= deviceGap(d)))
      alt.push(d);
  return [...new Set(alt)].sort((a, b) => a - b);
}

/**
 * One variant per device (phone, tablet, desktop at DEFAULT_CAPTURE_WIDTHS), placed at the page's own switches: a
 * variant applies from the start of its layout range (from its own width when it shares that range with the device
 * below), and a range holding no device width goes to the device of its start width (900–1279 → tablet, 1024+ →
 * desktop). Each variant is measured inside its own layout range only: past a switch the site's boxes change formatting,
 * which a geometry morph cannot follow.
 */
export function devicePlan(switches: readonly number[]): CapturePlan[] {
  const ranges = layoutRanges(switches);
  const rangeOf = (w: number) => ranges.find((r) => w >= r.min && (r.max === null || w < r.max))!;
  const ws = DEFAULT_CAPTURE_WIDTHS;
  const starts = ws.map((w, i) => {
    if (i === 0) return 0;
    const r = rangeOf(w),
      below = rangeOf(ws[i - 1]!);
    if (r === below) return w;
    return (
      ranges.find((x) => x.min > below.min && x.min <= r.min && deviceClass(x.min) >= deviceClass(w)) ?? r
    ).min;
  });
  return ws.map((w, i) => {
    const r = rangeOf(w);
    const next = starts[i + 1];
    const top = r.max === null ? Math.min(MAX_WIDTH, Math.max(OPEN_RANGE_ALT, w + 480)) : r.max - 1;
    const end = next === undefined ? top : Math.min(top, next - 1);
    return {
      width: w,
      minWidth: starts[i]!,
      alt: measuredWidths(Math.max(r.min, starts[i]!, MIN_WIDTH), w, end),
    };
  });
}

/** Walks one capture makes at most (each ~1–5 s on a heavy page): a device class with more is captured twice or more */
export const MAX_WALKS = 10;

/** Device class of a viewport width as fig-server's capture emulates it (capture.rs Device): phone, tablet, desktop. */
export const deviceClass = (w: number) => (w < 600 ? 0 : w < 1024 ? 1 : 2);

/**
 * One capture of the page per device class: loaded once at its `width` (a default width of the class when a variant
 * has it), walked again at `alt` (the class's other variant widths first, then every variant's measured widths).
 */
export interface CaptureSession {
  width: number;
  alt: number[];
  variants: CapturePlan[];
}

export function planSessions(plans: readonly CapturePlan[], maxWalks = MAX_WALKS): CaptureSession[] {
  const out: CaptureSession[] = [];
  const session = (vs: CapturePlan[]): CaptureSession => {
    const anchor = (vs.find((v) => (DEFAULT_CAPTURE_WIDTHS as readonly number[]).includes(v.width)) ?? vs[0]!)
      .width;
    // the session's other variants first (a heavy page may run out of time for the rest: measured widths then)
    const own = vs
      .map((v) => v.width)
      .filter((w) => w !== anchor)
      .sort((a, b) => a - b);
    const alt = [
      ...new Set([
        ...own,
        ...vs
          .flatMap((v) => v.alt)
          .filter((w) => w !== anchor)
          .sort((a, b) => a - b),
      ]),
    ];
    return { width: anchor, alt, variants: vs };
  };
  for (const cls of [0, 1, 2]) {
    const vs = plans.filter((p) => deviceClass(p.width) === cls);
    if (!vs.length) continue;
    // a class with more walks than one capture has time for is split: several captures of it run side by side
    const one = session(vs);
    if (one.alt.length <= maxWalks || vs.length < 2) {
      out.push(one);
      continue;
    }
    let chunk: CapturePlan[] = [];
    for (const v of vs) {
      if (chunk.length && session([...chunk, v]).alt.length > maxWalks) {
        out.push(session(chunk));
        chunk = [];
      }
      chunk.push(v);
    }
    if (chunk.length) out.push(session(chunk));
  }
  return out;
}
