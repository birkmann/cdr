// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Page interactions in the HTML and React exports (sliders, dots, mouse drag, region states, menu behaviour): the
// markup marks what moves what (data attributes, below) and one small runtime (interactionsRuntime.ts) drives it —
// nav.js in the HTML bundle, src/lib/interactions.ts (`useInteractions`) in the React project.
//
// Links between a control and what it moves are relative (`<up>:<n>`: the n-th match inside the ancestor <up> levels
// up), never element ids: copies of one component render the same markup (reactComponents.ts shares them), and the
// taps of a component copy name the ids of its main component (`u3k`, not `inst__u3k`).
import type { SceneInteraction } from "@harness/protocol";
import { walkIr, type IrElement } from "./ir.js";
import { installInteractions, installMotion } from "./interactionsRuntime.js";
import { MOTION_CSS } from "@harness/scene";
import { INTERACTIONS_RUNTIME_SOURCE as runtimeSource } from "./generated.js";

/** CSS the interactions need (no effect on how the page looks at load). */
export const INTERACTIONS_CSS = `/* Page interactions: slider arrows / dots, region states, menus */
:where([data-scroll-by], [data-scroll-dot], [data-set-state]) { cursor: pointer; }
:where([data-scroller="x"]) { overscroll-behavior-x: contain; }
html[data-scroll-lock] { overflow: hidden; }
[data-overlay-panel]:focus { outline: none; }
@media (prefers-reduced-motion: reduce) { [data-scroller] { scroll-behavior: auto; } }
:where([data-app-act]) { cursor: pointer; }
${MOTION_CSS}`;

/** The runtime for the HTML bundle (nav.js). */
export function interactionsJs(): string {
  // (leading `;`: nav.js puts this after the link / overlay scripts, which may end in a call without one)
  return `;// Page interactions: slider arrows, dots and mouse drag, region states, menus (scroll lock, focus), app state.\n(${installInteractions.toString()})(window, document);\n// Motion: entrances on scroll into view, counting numbers.\n(${installMotion.toString()})(window, document);\n`;
}

/** src/lib/interactions.ts of the React project: the runtime + the `useInteractions` hook App calls. */
export function reactInteractionsModule(): string {
  const body = `import { useEffect } from "react";\n\n${runtimeSource.slice(runtimeSource.indexOf("/** Install the page interactions"))}
/** React: install the page interactions once while the app is mounted (call it in the App component). */
export function useInteractions(): void {
  useEffect(() => {
    const off = installInteractions(window, document);
    const offMotion = installMotion(window, document);
    return () => {
      off();
      offMotion();
    };
  }, []);
}
`;
  return `// Page interactions: slider arrows (data-scroll-by), dots and mouse drag on sliders (data-scroller), region states
// (data-set-state), and the page's menus (data-overlay: no page scrolling behind an open one, focus inside it).
// \`useInteractions()\` in App installs them once; everything is driven by the data attributes in the screens' markup.
${body}`;
}

const isTap = (i: SceneInteraction | undefined, kind: SceneInteraction["onTap"]) =>
  !!i && i.onTap === kind && !!i.target;
/** Markup of app state and motion (fromDsl: data-app-vars / -text / -show / -id, data-motion, data-counter; below: data-app-act). */
const APP_ATTRS = [
  "data-app-act",
  "data-app-vars",
  "data-app-text",
  "data-app-show",
  "data-motion",
  "data-counter",
];

/** An interaction the app-state runtime runs: variables, a sequence / branch, or a state switch of an app region. */
function appAct(i: SceneInteraction | undefined, appIds: ReadonlySet<string>): boolean {
  if (!i?.onTap) return false;
  if (i.onTap === "set-variable" || i.onTap === "conditional") return true;
  return (i.onTap === "set-state" || i.onTap === "scroll-to") && !!i.target && appIds.has(i.target);
}
/** The parts of an interaction the runtime reads (no editor extras), as JSON. */
function actJson(i: SceneInteraction): string {
  const strip = (a: SceneInteraction): Record<string, unknown> => {
    const o: Record<string, unknown> = { onTap: a.onTap };
    for (const k of ["target", "state", "url", "variable", "if"] as const)
      if (a[k] !== undefined) o[k] = a[k];
    if (a.then) o.then = a.then.map(strip);
    if (a.else) o.else = a.else.map(strip);
    return o;
  };
  return JSON.stringify(strip(i));
}

/** The page uses the runtime: a slider, a slider arrow, a region state or a menu. */
export function usesInteractions(ir: IrElement): boolean {
  let any = false;
  walkIr(ir, (n) => {
    if (
      !any &&
      ("data-scroller" in n.attrs ||
        "data-scroll-by" in n.attrs ||
        "data-set-state" in n.attrs ||
        "data-states" in n.attrs ||
        "data-scroll-shift" in n.attrs ||
        APP_ATTRS.some((k) => k in n.attrs))
    )
      any = true;
  });
  return any;
}

/**
 * Mark a screen's IR for the runtime (in place, idempotent): horizontal scrolling frames `data-scroller`, regions with
 * states `data-states`, slider arrows `data-scroll-by` (+ `data-scroll-page`, `data-scroll-target`), state taps
 * `data-set-state` (+ `data-state-target`). Controls that are no `<button>` get the button role.
 */
export function markInteractions(ir: IrElement): IrElement {
  const parent = new Map<IrElement, IrElement | null>();
  const byId = new Map<string, IrElement>();
  const all: IrElement[] = [];
  walkIr(ir, (n, p) => {
    parent.set(n, p);
    all.push(n);
    if (n.id && !byId.has(n.id)) byId.set(n.id, n);
  });
  // a copy's elements carry its instance prefix (`inst__u3k`); its taps still name the main's ids (`u3k`): the copy
  // of that id nearest to the tap (longest shared prefix)
  const last = (id: string) => {
    const j = id.lastIndexOf("__");
    return j < 0 ? id : id.slice(j + 2);
  };
  const bySuffix = new Map<string, string[]>();
  for (const k of byId.keys()) {
    const l = last(k);
    const list = bySuffix.get(l);
    if (list) list.push(k);
    else bySuffix.set(l, [k]);
  }
  const resolve = (id: string, from: IrElement): IrElement | null => {
    const hit = byId.get(id);
    if (hit) return hit;
    const own = from.id ?? "";
    let best: string | null = null,
      score = -1;
    for (const k of bySuffix.get(last(id)) ?? []) {
      if (!k.endsWith(`__${id}`)) continue;
      let s = 0;
      while (s < k.length && s < own.length && k[s] === own[s]) s++;
      if (s > score) {
        score = s;
        best = k;
      }
    }
    return best ? byId.get(best)! : null;
  };
  // app state: taps the runtime runs from their JSON (variables, sequences, app regions' states)
  const appIds = new Set(all.map((n) => n.attrs["data-app-id"]).filter((x): x is string => !!x));
  for (const n of all) {
    if (!appAct(n.interaction, appIds)) continue;
    // a sequence that ends on another page (a start-over that resets the choices, then opens the app's start): the
    // runtime runs the state part, the page link stays the element's own (data-href / data-nav / onNavigate)
    const i = n.interaction!;
    const go =
      i.onTap === "conditional" && !i.if
        ? i.then?.find((a) => a.onTap === "navigate" || a.onTap === "back" || a.onTap === "open-url")
        : undefined;
    n.attrs = {
      ...n.attrs,
      "data-app-act": actJson(go ? { ...i, then: i.then!.filter((a) => a !== go) } : i),
    };
    if (go) n.interaction = go;
    // (the runtime makes it focusable: a tabindex attribute types badly in JSX)
    if (n.tag !== "button" && n.tag !== "a" && !n.attrs.role) n.attrs = { ...n.attrs, role: "button" };
  }
  const targets = new Map<IrElement, { i: SceneInteraction; target: IrElement | null }>();
  for (const n of all) {
    if ("data-app-act" in n.attrs) continue;
    const i = n.interaction;
    if (isTap(i, "scroll-by")) targets.set(n, { i: i!, target: resolve(i!.target!, n) });
    else if (isTap(i, "set-state") && i!.state) targets.set(n, { i: i!, target: resolve(i!.target!, n) });
  }
  const scrolls = (n: IrElement, axis: "x" | "y") =>
    /^(auto|scroll)$/.test(n.style[`overflow-${axis}`] ?? "");
  // what is moved first (the links count them)
  for (const n of all) {
    if (scrolls(n, "x") && !scrolls(n, "y")) n.attrs = { ...n.attrs, "data-scroller": "x" };
    if (n.children.some((c) => c.kind === "el" && "data-pt-state" in c.attrs))
      n.attrs = { ...n.attrs, "data-states": "" };
  }
  // a vertical frame an arrow moves; a target that does not scroll is no frame (a stale id matched by suffix): the
  // runtime pairs such arrows with the nearest frame
  for (const t of targets.values()) {
    if (t.i.onTap !== "scroll-by" || !t.target || "data-scroller" in t.target.attrs) continue;
    if (scrolls(t.target, "y")) t.target.attrs = { ...t.target.attrs, "data-scroller": "y" };
    else t.target = null;
  }
  const ancestors = (n: IrElement) => {
    const out: IrElement[] = [];
    for (let a: IrElement | null = n; a; a = parent.get(a) ?? null) out.push(a);
    return out;
  };
  // document order: the k-th element with an attribute inside an ancestor = how many come between the two
  const order = new Map(all.map((n, k) => [n, k]));
  const ranks = (attr: string) => all.filter((n) => attr in n.attrs).map((n) => order.get(n)!);
  const ranked: Record<string, number[]> = {
    "data-scroller": ranks("data-scroller"),
    "data-states": ranks("data-states"),
  };
  /** `<up>:<n>` from `from` to `to` among the elements with attribute `attr` (`<up>` alone: `to` is that ancestor) */
  const link = (from: IrElement, to: IrElement, attr: "data-scroller" | "data-states"): string | null => {
    const up = ancestors(from);
    const toUp = new Set(ancestors(to));
    const k = up.findIndex((a) => toUp.has(a));
    if (k < 0) return null;
    const common = up[k]!;
    if (common === to) return String(k);
    const lo = order.get(common)!,
      hi = order.get(to)!;
    return `${k}:${ranked[attr]!.filter((r) => r > lo && r < hi).length}`;
  };
  for (const [n, { i, target }] of targets) {
    const attrs: Record<string, string> = { ...n.attrs };
    if (i.onTap === "scroll-by") {
      attrs["data-scroll-by"] = i.direction === "prev" ? "prev" : "next";
      if (i.by === "page") attrs["data-scroll-page"] = "";
      const spec = target ? link(n, target, "data-scroller") : null;
      if (spec) attrs["data-scroll-target"] = spec;
    } else {
      // (a target the ids no longer name: the runtime takes the region around the tap, else the nearest one)
      const spec = target && "data-states" in target.attrs ? link(n, target, "data-states") : null;
      attrs["data-set-state"] = i.state!;
      if (spec) attrs["data-state-target"] = spec;
    }
    // a control that is no button is one for assistive tech (a drop-down's own <select> is); the runtime makes it
    // focusable
    if (n.tag !== "button" && n.tag !== "a" && !i.options?.length && !attrs.role) attrs.role = "button";
    n.attrs = attrs;
  }
  return ir;
}
