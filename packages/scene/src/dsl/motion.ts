// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Motion of a layer (SceneElement.motion) in Preview and the exports: data attributes on the element + one stylesheet of
// keyframes. 'show' entrances replay whenever the layer is shown again (CSS restarts an animation when an element goes
// from display:none to shown — a step of a flow, a tab); 'view' entrances wait for `data-motion-in`, which the motion
// runtime (export/interactionsRuntime.ts installMotion) sets once the layer scrolls into view, and count-up numbers
// (`data-counter`) are counted there too; they wait only once that runtime is installed (`data-motion-ready` on its
// root), so a page whose scripts do not run shows everything. Never on the canvas.
import type { SceneMotion } from "@harness/protocol";

export const MOTION_CSS = `/* Motion: entrances (data-motion), on scroll into view (data-motion-trigger="view" + data-motion-in), counters */
@keyframes cdr-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes cdr-rise { from { opacity: 0; transform: translateY(24px) } to { opacity: 1; transform: none } }
@keyframes cdr-slide { from { opacity: 0; transform: translateX(32px) } to { opacity: 1; transform: none } }
@keyframes cdr-zoom { from { opacity: 0; transform: scale(.94) } to { opacity: 1; transform: none } }
@keyframes cdr-pop { 0% { opacity: 0; transform: scale(.86) } 70% { opacity: 1; transform: scale(1.03) } 100% { transform: none } }
[data-motion] { animation-duration: var(--motion-dur, 480ms); animation-delay: var(--motion-delay, 0ms); animation-timing-function: cubic-bezier(.2, .7, .2, 1); animation-fill-mode: both; }
[data-motion="fade"] { animation-name: cdr-fade; }
[data-motion="rise"] { animation-name: cdr-rise; }
[data-motion="slide"] { animation-name: cdr-slide; }
[data-motion="zoom"] { animation-name: cdr-zoom; }
[data-motion="pop"] { animation-name: cdr-pop; animation-timing-function: cubic-bezier(.3, 1.4, .5, 1); }
[data-motion-ready] [data-motion][data-motion-trigger="view"]:not([data-motion-in]) { animation-name: none; opacity: 0; }
@media (prefers-reduced-motion: reduce) { [data-motion] { animation: none !important; opacity: 1 !important; } }`;

/** The data attributes (and CSS custom properties) of a layer's motion; {} without one. */
/**
 * What a layer you act on keeps of its motion: no entrance on scroll (a control, an accordion row, an option is there and
 * tappable the moment it is on screen — never transparent while it rises in); its state changes still animate.
 */
type Acted = { interaction?: { onTap?: string }; meta?: Record<string, unknown> };
const actedOn = (el: Acted) =>
  (!!el.interaction?.onTap && el.interaction.onTap !== "none") ||
  el.meta?.app === "region" ||
  el.meta?.app === "form";

export function controlMotion(
  el: Acted & { motion?: SceneMotion; children?: readonly Acted[] },
): SceneMotion | undefined {
  const m = el.motion;
  if (!m || m.trigger !== "view") return m;
  // (and the item that wraps one: an agenda row's frame around its open / closed region)
  const acts = actedOn(el) || !!el.children?.some((c) => c.meta?.app === "region" || c.meta?.app === "form");
  if (!acts) return m;
  return m.counter ? { counter: true } : undefined;
}

export function motionAttrs(m: SceneMotion | undefined): {
  attrs: Record<string, string>;
  vars: Record<string, string>;
} {
  const attrs: Record<string, string> = {};
  const vars: Record<string, string> = {};
  if (!m) return { attrs, vars };
  if (m.enter) {
    attrs["data-motion"] = m.enter;
    if (m.trigger === "view") attrs["data-motion-trigger"] = "view";
    if (m.delay) vars["--motion-delay"] = `${Math.max(0, Math.round(m.delay))}ms`;
    if (m.duration) vars["--motion-dur"] = `${Math.max(0, Math.round(m.duration))}ms`;
  }
  if (m.counter) attrs["data-counter"] = "";
  return { attrs, vars };
}

let installed = false;
/** The motion stylesheet in this document (Preview), once. */
export function ensureMotionCss(
  doc: Document | undefined = typeof document === "undefined" ? undefined : document,
) {
  if (installed || !doc) return;
  installed = true;
  const style = doc.createElement("style");
  style.setAttribute("data-cdr-motion", "");
  style.textContent = MOTION_CSS;
  doc.head.appendChild(style);
}
