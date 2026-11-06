// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Prototype interaction model (Phases 10.2–10.4), shared by the in-app player and the Prototype tab:
// easing curves + durations, overlay placement, and variables & conditionals ("set variable", "if … then … else").
// Pure functions only. The exported single-file runtime (export/prototypeRuntime.ts) mirrors the small parts it needs.
import type {
  SceneEasing,
  SceneElement,
  SceneInteraction,
  SceneOverlaySettings,
  SceneScreen,
  SceneVariableCollection,
  SceneVariableValue,
} from "@harness/protocol";

/* ------------------------------------------------------------------ */
/* Easing + duration                                                   */
/* ------------------------------------------------------------------ */

export type Bezier = [number, number, number, number];
export type EasingPreset = Exclude<SceneEasing, { bezier: Bezier }>;

export const EASING_PRESETS: Record<EasingPreset, Bezier> = {
  linear: [0, 0, 1, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  "ease-in-back": [0.36, 0, 0.66, -0.56],
  "ease-out-back": [0.34, 1.56, 0.64, 1],
  "ease-in-out-back": [0.68, -0.6, 0.32, 1.6],
};
export const EASING_LABELS: Record<EasingPreset, string> = {
  linear: "Linear",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in and out",
  "ease-in-back": "Ease in back",
  "ease-out-back": "Ease out back",
  "ease-in-out-back": "Ease in and out back",
};
/** The player's long-standing default curve (a soft ease-out) when an interaction sets none. */
export const DEFAULT_BEZIER: Bezier = [0.22, 1, 0.36, 1];
export const DEFAULT_DURATION = 320;
export const MAX_DURATION = 5000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Valid bezier: x1, x2 in [0, 1] (y may overshoot for back / spring-like curves). */
export function normalizeBezier(b: readonly number[]): Bezier {
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = b.map((v) => (Number.isFinite(v) ? v : 0));
  return [
    round3(clamp(x1, 0, 1)),
    round3(clamp(y1, -2, 3)),
    round3(clamp(x2, 0, 1)),
    round3(clamp(y2, -2, 3)),
  ];
}

export function bezierOf(e: SceneEasing | undefined): Bezier {
  if (!e) return DEFAULT_BEZIER;
  if (typeof e === "string") return EASING_PRESETS[e] ?? DEFAULT_BEZIER;
  return normalizeBezier(e.bezier);
}

export const cssEasing = (e: SceneEasing | undefined) => `cubic-bezier(${bezierOf(e).join(", ")})`;

/** The preset whose curve equals `b`, or null for a custom curve. */
export function presetOf(b: Bezier): EasingPreset | null {
  for (const [k, v] of Object.entries(EASING_PRESETS) as [EasingPreset, Bezier][])
    if (v.every((x, i) => Math.abs(x - b[i]!) < 1e-3)) return k;
  return null;
}

export const durationOf = (i: Pick<SceneInteraction, "duration"> | undefined) =>
  clamp(Math.round(i?.duration ?? DEFAULT_DURATION), 0, MAX_DURATION);

/** Point on a cubic bezier easing curve for parameter t (used to draw the curve). */
export function bezierPoint(b: Bezier, t: number): { x: number; y: number } {
  const u = 1 - t;
  const k1 = 3 * u * u * t,
    k2 = 3 * u * t * t,
    k3 = t * t * t;
  return { x: k1 * b[0] + k2 * b[2] + k3, y: k1 * b[1] + k2 * b[3] + k3 };
}

/* ------------------------------------------------------------------ */
/* Overlays                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_OVERLAY_BACKGROUND = "rgba(0, 0, 0, 0.4)";

export interface Size {
  w: number;
  h: number;
}

/** Top-left of an overlay of size `o` inside a frame of size `f` (both in screen px). */
export function overlayPosition(
  s: SceneOverlaySettings | undefined,
  o: Size,
  f: Size,
): { x: number; y: number } {
  const pos = s?.position ?? "center";
  const cx = (f.w - o.w) / 2;
  const right = f.w - o.w;
  const bottom = f.h - o.h;
  switch (pos) {
    case "top-left":
      return { x: 0, y: 0 };
    case "top-center":
      return { x: cx, y: 0 };
    case "top-right":
      return { x: right, y: 0 };
    case "bottom-left":
      return { x: 0, y: bottom };
    case "bottom-center":
      return { x: cx, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
    case "manual":
      return { x: s?.offset?.x ?? 0, y: s?.offset?.y ?? 0 };
    default:
      return { x: cx, y: (f.h - o.h) / 2 };
  }
}

export interface OverlayMotion {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  /** appears at once (no animation) */ instant: boolean;
}

/**
 * Entrance of an overlay (the exit plays it in reverse): the box's start offset (px), scale and opacity, from where it
 * sits (`box`: position + size from overlayPosition) in the `frame`. `enter` 'left' / 'right' / 'top' / 'bottom' slides
 * it fully in from that edge of the frame (it starts just outside it), 'fade' fades it in place, 'none' shows it at
 * once. Unset: the short nudge by position (bottom overlays rise 40px, top ones drop 40px, others scale from 96 %).
 */
export function overlayEnter(
  s: SceneOverlaySettings | undefined,
  box: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 0, h: 0 },
  frame: Size = { w: 0, h: 0 },
): OverlayMotion {
  const m = (x: number, y: number, scale = 1, opacity = 1, instant = false): OverlayMotion => ({
    x,
    y,
    scale,
    opacity,
    instant,
  });
  switch (s?.enter) {
    case "left":
      return m(-(box.x + box.w), 0);
    case "right":
      return m(Math.max(box.w, frame.w - box.x), 0);
    case "top":
      return m(0, -(box.y + box.h));
    case "bottom":
      return m(0, Math.max(box.h, frame.h - box.y));
    case "fade":
      return m(0, 0, 1, 0);
    case "none":
      return m(0, 0, 1, 1, true);
    default:
      break;
  }
  const pos = s?.position ?? "center";
  if (pos.startsWith("bottom")) return m(0, 40);
  if (pos.startsWith("top")) return m(0, -40);
  return m(0, 0, 0.96);
}

/* ------------------------------------------------------------------ */
/* Variables + conditionals                                            */
/* ------------------------------------------------------------------ */

export type Scalar = string | number | boolean;
export type VarValues = Record<string, Scalar>;

/** Current value of every variable in its collection's default mode (aliases followed, cycles cut). */
export function initialVariableValues(
  collections: readonly SceneVariableCollection[] | undefined,
  modes: Record<string, string> = {},
): VarValues {
  const byId = new Map<string, { value: (mode: string) => SceneVariableValue | undefined; mode: string }>();
  for (const c of collections ?? []) {
    const mode = modes[c.id] ?? c.defaultModeId;
    for (const v of c.variables)
      byId.set(v.id, {
        value: (m) => v.values[m] ?? v.values[c.defaultModeId] ?? Object.values(v.values)[0],
        mode,
      });
  }
  const out: VarValues = {};
  const resolve = (id: string, depth = 0): Scalar | undefined => {
    const e = byId.get(id);
    if (!e || depth > 8) return undefined;
    const raw = e.value(e.mode);
    if (raw !== null && typeof raw === "object") return resolve(raw.alias, depth + 1);
    return raw;
  };
  for (const id of byId.keys()) {
    const v = resolve(id);
    if (v !== undefined) out[id] = v;
  }
  return out;
}

const asNumber = (v: Scalar | undefined) =>
  typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : Number.parseFloat(String(v ?? ""));

/** Apply one set-variable action. */
export function applySetVariable(values: VarValues, action: SceneInteraction["variable"]): VarValues {
  if (!action?.id) return values;
  const cur = values[action.id];
  const op = action.op ?? "set";
  let next: Scalar | undefined;
  if (op === "toggle") next = !(cur === true || cur === "true");
  else if (op === "increment" || op === "decrement") {
    const step = action.value === undefined || typeof action.value === "object" ? 1 : asNumber(action.value);
    const base = asNumber(cur);
    next =
      (Number.isFinite(base) ? base : 0) + (op === "increment" ? 1 : -1) * (Number.isFinite(step) ? step : 1);
  } else {
    const v = action.value;
    next = v !== null && typeof v === "object" ? values[v.alias] : v;
  }
  return next === undefined || next === cur ? values : { ...values, [action.id]: next };
}

/** Evaluate a condition against the current variable values. */
export function evalCondition(values: VarValues, cond: SceneInteraction["if"]): boolean {
  if (!cond) return false;
  const cur = values[cond.variableId];
  const want = cond.value;
  const n1 = asNumber(cur),
    n2 = asNumber(want);
  const numeric =
    Number.isFinite(n1) && Number.isFinite(n2) && typeof cur !== "boolean" && typeof want !== "boolean";
  const eq = numeric ? n1 === n2 : String(cur) === String(want);
  switch (cond.op) {
    case "eq":
      return eq;
    case "neq":
      return !eq;
    case "gt":
      return numeric && n1 > n2;
    case "gte":
      return numeric && n1 >= n2;
    case "lt":
      return numeric && n1 < n2;
    case "lte":
      return numeric && n1 <= n2;
    default:
      return false;
  }
}

/**
 * Run an interaction: set-variable actions update the values, conditionals pick their branch (evaluated with the
 * values at that point), and everything else becomes an effect for the player (navigate, back, overlays, scroll-to,
 * open-url). Nested conditionals are supported up to a small depth.
 */
export function runInteraction(
  i: SceneInteraction | undefined,
  values: VarValues,
  depth = 0,
): { effects: SceneInteraction[]; values: VarValues } {
  if (!i || !i.onTap || i.onTap === "none" || depth > 16) return { effects: [], values };
  if (i.onTap === "set-variable") return { effects: [], values: applySetVariable(values, i.variable) };
  if (i.onTap === "conditional") {
    // no condition: a sequence (`then` runs in order)
    const branch = !i.if || evalCondition(values, i.if) ? i.then : i.else;
    let v = values;
    const effects: SceneInteraction[] = [];
    for (const a of branch ?? []) {
      const r = runInteraction(a, v, depth + 1);
      v = r.values;
      effects.push(...r.effects);
    }
    return { effects, values: v };
  }
  return { effects: [i], values };
}

/** `screen` with the state frames switched by set-state taps (frame id → state child id); untouched frames keep their object. */
export function withActiveStates(screen: SceneScreen, active: Readonly<Record<string, string>>): SceneScreen {
  if (!Object.keys(active).length) return screen;
  const visit = (el: SceneElement): SceneElement => {
    const kids = el.children?.map(visit);
    const changedKids = !!kids && kids.some((k, i) => k !== el.children![i]);
    const want = el.states ? active[el.id] : undefined;
    if (!changedKids && (!want || el.states!.active === want)) return el;
    return {
      ...el,
      ...(kids ? { children: kids } : {}),
      ...(want ? { states: { ...el.states, active: want } } : {}),
    };
  };
  const root = visit(screen.root);
  return root === screen.root ? screen : { ...screen, root };
}

/** Interactions the built-in DSL renderer already performs on its own (navigate / back / open-url without extras). */
export const isExtendedAction = (i: SceneInteraction | undefined) =>
  !!i?.onTap && !["navigate", "back", "open-url", "toggle", "none"].includes(i.onTap);

/** Short human summary for lists ("Open overlay → Menu", "If score > 3 …"). */
export function describeAction(
  i: SceneInteraction,
  screenName: (id: string | undefined) => string,
  varName: (id: string | undefined) => string,
): string {
  switch (i.onTap) {
    case "navigate":
      return screenName(i.target);
    case "back":
      return "Back";
    case "open-url":
      return i.url || "URL";
    case "toggle":
      return "Toggle";
    case "open-overlay":
      return `Overlay · ${screenName(i.target)}`;
    case "swap-overlay":
      return `Swap overlay · ${screenName(i.target)}`;
    case "close-overlay":
      return "Close overlay";
    case "scroll-to":
      return "Scroll to";
    case "scroll-by":
      return i.direction === "prev" ? "Scroll back" : "Scroll on";
    case "set-state":
      return "Change state";
    case "set-variable": {
      const op = i.variable?.op ?? "set";
      const name = varName(i.variable?.id);
      return op === "set" ? `${name} = ${String(i.variable?.value ?? "")}` : `${op} ${name}`;
    }
    case "conditional":
      return `If ${varName(i.if?.variableId)} ${OP_SYMBOL[i.if?.op ?? "eq"]} ${String(i.if?.value ?? "")}`;
    default:
      return "—";
  }
}

export const OP_SYMBOL: Record<NonNullable<SceneInteraction["if"]>["op"], string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

/** A background that paints nothing: 'transparent', or a colour with zero alpha. */
export function isClear(bg: unknown): boolean {
  if (typeof bg !== "string") return false;
  const c = bg.trim().toLowerCase();
  return (
    c === "transparent" ||
    /^#[0-9a-f]{3}0$|^#[0-9a-f]{6}00$/.test(c) ||
    /^(rgba|hsla)\(.*[,/]\s*0(\.0*)?%?\s*\)$/.test(c)
  );
}
