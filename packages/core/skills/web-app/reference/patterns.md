# Patterns for other briefs

Compact starting points that follow `SKILL.md`. Adapt names, content and colours to the brief.

## Landing page (product, service, event)

Sections, in order: masthead (wordmark, 2–4 text links, one primary action), hero (display heading, one-sentence promise, primary + secondary action, one strong photo or product shot), proof (3 concrete facts with numbers, not testimonials), how it works (3 numbered steps), detail band (photo + paragraph, alternating), pricing or sign-up, footer with credits.

```css
.hero { display: grid; gap: 24px; padding: 32px 16px; }
@media (min-width: 760px) { .hero { grid-template-columns: 1.1fr 0.9fr; align-items: end; padding: 64px 42px; } }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); border-top: 1px solid var(--line); }
.facts strong { display: block; font-size: clamp(32px, 5vw, 56px); font-weight: 400; letter-spacing: -0.04em; }
```

A sign-up form validates in the browser, shows inline errors next to fields, and confirms with a `role="status"` message. It never claims to have sent anything.

## Dashboard

Neutral grey UI, white panels with hairline borders, `font-variant-numeric: tabular-nums`. A top row of 3–4 stat tiles (label, value, change with direction word, not only colour), one main chart, one table. Draw charts with inline SVG computed from the data array; no chart libraries.

```js
function lineChart(svg, values, { w = 600, h = 200, pad = 24 } = {}) {
  const max = Math.max(...values), min = Math.min(...values);
  const x = (i) => pad + (i * (w - 2 * pad)) / (values.length - 1);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = `<path d="${values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")}" fill="none" stroke="currentColor" stroke-width="2"/>`;
}
```

SVGs scale with `width: 100%; height: auto`. Tables scroll inside their own container (`overflow-x: auto`) so the page never overflows. Filters (date range, segment) re-render everything from one state object.

## Canvas game

```js
const canvas = document.querySelector("canvas"), ctx = canvas.getContext("2d");
function resize() {
  const r = canvas.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.width * dpr; // square board
  canvas.style.height = r.width + "px"; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize); resize();
let last = 0, acc = 0; const STEP = 1000 / 12; // fixed logic rate
function frame(t) { acc += Math.min(t - last, 250); last = t; while (acc >= STEP) { update(); acc -= STEP; } draw(); requestAnimationFrame(frame); }
requestAnimationFrame((t) => { last = t; frame(t); });
```

Controls: arrow keys and WASD (`preventDefault` only for keys you handle), on-screen direction buttons with `aria-label` for touch, swipe on the canvas, Space/P to pause, a restart button. Show score and best score (persisted, `try/catch`). A start overlay explains the controls; a game-over overlay offers restart. The board fits a 320 px phone with the controls visible below it.

## Todo list or small tool

A single input with a visible label, Enter to add, an empty state, items with a checkbox (real `<input type="checkbox">` with label), edit on double-click or an Edit button, delete with an `aria-label`, filters (All / Active / Done) as buttons with `aria-pressed`, a count ("3 left"), clear completed, and persistence. Keyboard: everything reachable with Tab, Escape cancels editing.
