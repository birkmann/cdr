# Plan: recreation fidelity — motion, interaction and modern-output quality

Status: implemented (see [Implementation status](#implementation-status)) · Owner: harness team · Reference run: ibmix.de, 2026-11-12

## Why

The ibmix.de run passes today's gates (pixel, text, layout, responsive, flow) and still is visibly
not the live page, and the Lit conversion is not code we would ship:

1. **The hero video is a still.** The capture seeks every `<video>` to its first frame
   (`packages/capture/src/inpage.ts:79`) and the pixel gate paints video and canvas regions out of
   every comparison (`docs/recreate.md`, "In a chat"). So a page whose first screen *is* a video
   scores well as a static image and no gate ever says "the hero should move".
2. **Sliders only half work.** The interactions gate checks exactly one thing per carousel: the
   visible "next" arrow moves its scroll track (`packages/measure/src/interactions.ts`,
   `OUTPUT_PROBE_JS`). Dots, swipe, keyboard, looping, autoplay, slide snapping and the slides the
   capture never scrolled to are all unchecked and mostly unbuilt.
3. **Hover is captured but not reproduced or measured.** The capture forces pseudo-states and
   hovers with a real pointer (`packages/capture/src/driver.ts:874`), yet the output gets hover
   styles only where the live page declared them in stylesheets (`docs/recreate.md`, Limits).
   JS-driven hover (class toggles, GSAP tweens, cursor effects) is lost, and no gate compares
   hover states live-vs-output, so regressions are invisible.
4. **The converted output is breakpoint-cloned DOM, not modern HTML.** `ds-lit` (and the static
   responsive layer it builds on, `packages/codegen/src/export/responsive.ts`) emits one full DOM
   copy per captured breakpoint (`<ix-page data-bp="0|768|1024|1312|1921">`), shows one and hides
   the rest. On ibmix.de that is ~5× the content: 482 kB CSS + 434 kB JS, generic names
   (`div.section-46`), fixed px heights on spacers, duplicated text for assistive tech and search
   engines. That can never reach "flawless responsive, perfect accessibility, best Lighthouse".
5. **Nothing measures what "modern perfect" means.** There is no axe/a11y gate, no Lighthouse
   gate, no semantic-HTML or DOM-weight lint anywhere in `@harness/measure`.

Goal: a recreation matches the live page **in motion and under the pointer**, and the converted
project is a **single-DOM, semantic, token-driven codebase** that scores ≥ 95 on every Lighthouse
category and has zero serious axe violations — without copying the live page's CSS 1:1 (the flow
gate's "layout rule, not numbers" philosophy already points the right way; this plan extends it to
markup, media and interaction).

Non-goals: bypassing logins/paywalls, reproducing WebGL/canvas simulations beyond a recorded
fallback, matching the live page's own (often bad) Lighthouse scores downward.

---

## Workstream A — measure what's missing (gates first)

We cannot improve what no gate sees. New checks land first, initially as **reported, non-failing**
(`gates.*: "report"`), flipped to failing per gate once the pipeline passes them on the eval set.

### A1. `motion` gate (new, `packages/measure/src/motion.ts`)

- Capture records, per section: `media: { kind: "video" | "canvas" | "css-animation" | "none",
  autoplay, loop, muted, controlsVisible, pausable }` (see B1).
- Output probe: for every live region with `kind: "video"`, the output must contain a playing
  `<video>` (`!paused && currentTime` advancing over 500 ms) of matching geometry; `pausable`
  requires a working pause control; `prefers-reduced-motion: reduce` must stop it (checked by
  re-probing with emulated media feature over CDP).
- Two frames 600 ms apart inside the media box must differ on both sides ("it moves as live"),
  reusing the existing masked-pixel plumbing in `packages/measure/src/pixel.ts` inverted.

### A2. `interactions` gate, extended (`packages/measure/src/interactions.ts`)

Per carousel, as-live (only required where the capture saw it on the live page):

- arrows move the track **and wrap/disable at the ends the way the live one does**;
- dots exist, reflect position, and clicking dot *n* reaches slide *n*;
- pointer drag / touch swipe moves one snap position (dispatch synthetic pointer events);
- keyboard: track or active slide reachable by Tab, arrows move it;
- autoplay advances within `interval × 1.5` and pauses on hover/focus and under reduced motion;
- all captured slides exist in the output (count check against B2's slide inventory).

Menu checks gain: Escape closes, focus is trapped while open, focus returns to the opener.

### A3. `a11y` gate (new, `packages/measure/src/a11y.ts`)

- Run **axe-core** (vendored, injected over CDP into the warm browser — no network, consistent
  with "no test calls the network") against the output at each captured width, plus once with the
  menu open.
- Fail on any `critical`/`serious` violation; `moderate` reported. Baseline trick: also run axe on
  the *live* page and report its violations alongside, so "we are strictly better than live" is
  visible, but our gate never inherits live's failures as an excuse.
- Deterministic extras axe doesn't cover well: exactly one `<h1>`, no heading-level jumps, one
  `<main>`, `lang` on `<html>`, every image `alt` (copied from live or empty-alt when decorative),
  visible focus indicator on sampled controls (computed-style diff under forced `:focus-visible`).

### A4. `lighthouse` gate (new, `packages/measure/src/lighthouse.ts`)

- Run Lighthouse programmatically against the built output served from the run folder (static:
  `out/static/`, conversions: their `dist/` — this extends `--build`), desktop + mobile configs,
  on the warm Chrome.
- Thresholds in config, defaults: performance ≥ 90, accessibility ≥ 95, best-practices ≥ 95,
  SEO ≥ 90. Scores and the failing audits go into `measure/<target>/report.json` and the compare
  page.
- Offline caveat: Lighthouse runs fully local here (the output has no third-party requests once
  assets are embedded). Where the sandbox forbids it, the gate reports `skipped`, never `pass`.

### A5. `markup` lint (new, lives next to the flow gate in `packages/measure/src/flow.ts` or its
own `markup.ts`)

The flow gate lints CSS; this lints the DOM the same way:

- **No duplicated page content**: the rendered-text multiset of hidden subtrees may not repeat
  the visible page (kills the `data-bp` clone pattern mechanically, not by convention);
- DOM weight: node count ≤ live × 1.3 (configurable), depth ≤ live max + 3;
- landmark presence, button-vs-link correctness (`href` ⇒ `<a>`, handler ⇒ `<button>`),
  list markup for repeated siblings, `<figure>`/`<figcaption>` where live pairs image+caption;
- asset hygiene: `loading="lazy"` below the fold, `fetchpriority="high"` + `preload` for the LCP
  image/poster, `font-display: swap`, explicit `width`/`height` or `aspect-ratio` on media
  (CLS = 0 feeds A4).

### A6. Wiring (per AGENTS.md conventions)

- New `EventBody` members in `@harness/protocol` (`recreate.motion`, extended
  `recreate.interactions`, `recreate.quality` carrying axe + Lighthouse summaries), handled in
  `reduceSession` and the CLI `Renderer`, schemas regenerated
  (`pnpm --filter @harness/protocol schema`).
- Gates table in `docs/recreate.md` + `recreate-url/SKILL.md` summary updated; compare page
  (`packages/measure/src/compare.ts`) gets a "Quality" tab: axe findings, Lighthouse scores,
  hover/motion strips.
- Config: `recreate.gates.{motion, a11y, lighthouse, markup}` with `"report" | "fail"` and
  thresholds; `MockProvider`-based tests with fixture snapshots, no network.

**Acceptance A:** re-running the stored ibmix.de run's measure stage reports (red) the missing
video, the partial sliders, duplicated-DOM markup findings and Lighthouse scores — i.e. today's
output now visibly fails the new checks.

---

## Workstream B — capture what the page really does

### B1. Media capture (`packages/capture`)

- Inventory every `<video>`, `<canvas>` sized ≥ 200×120, and elements with running CSS/WAAPI
  animations: geometry, `object-fit`, autoplay/loop/muted, `poster`, source list with codecs,
  visible play/pause control (the live ibmix hero has one), and whether
  `prefers-reduced-motion` already disables it live.
- Download the video sources under the existing asset policy (`recreate.assets`), with a new
  budget `recreate.budgets.mediaBytes` (default ~25 MB) and `recreate.media:
  "full" | "trimmed" | "poster"` — `trimmed` (default) stores the first N seconds re-muxed for
  looping; `poster` keeps today's behaviour. Streamed sources (HLS/DASH): record ~8 s of the
  compositor via CDP screencast into a WebM as a loop asset, flagged in the manifest.
- Canvas/WebGL heroes: screencast-recorded loop as fallback asset + the poster frame; the
  manifest records `reproduced: "recorded-loop"` so the summary is honest about it.
- Keep first-frame seeking for the *screenshot* path (pixel comparability) — the inventory and
  asset download are separate from the shot.

### B2. Slider deep-capture (`packages/capture/src/driver.ts`, in-page walker)

- During the widget walk, detect carousels (scroll-snap tracks, transform tracks, known patterns)
  and **step through every slide** (arrow click or programmatic scroll), snapshotting each
  slide's subtree and geometry — budgeted (`budgets.sliderMs`, `slides` cap ~12), recorded as
  skipped when the budget cuts it off.
- Record behaviour facts: snap type, loop (does "next" on the last slide reach the first?),
  autoplay interval (watch the track for 8 s), dots↔slides mapping, drag resistance, per-slide
  `aria` labels.
- Store as `widgets.carousels[]` in the snapshot → scene keeps them as first-class
  `slider` nodes with children = all slides (today only the visible slides survive).

### B3. Hover/JS-state capture (`packages/capture/src/driver.ts`)

Extend the existing forced-pseudo walk (≤ 150 controls) to also catch what JS does:

- While hovering with the real pointer, run a MutationObserver on the control and its subtree:
  class/attribute/style mutations within 400 ms are recorded as the control's **hover delta**
  (computed-style diff per changed node), same for `focusin`.
- Record transition/animation metadata of the delta (`transition-property/duration/timing`) so
  the output can reproduce the *feel*, not only the end state.
- Cursor changes (`cursor` computed under hover) and hover-revealed children (opacity/visibility
  flips, e.g. card arrows) become part of the delta.
- Serialize into the snapshot as `states: { hover?, focus?, active? }` per node — the scene DSL
  (`packages/scene/src/dsl/styles.ts`) already carries per-node style; add a states layer.

**Acceptance B:** the ibmix.de capture manifest lists the hero video asset (or recorded loop),
every slider with its full slide set + behaviour facts, and hover deltas for teasers, buttons and
nav items.

---

## Workstream C — emit modern interaction & media (static output)

### C1. Media emission (`packages/codegen/src/export/html.ts` + `interactionsRuntime.ts`)

- Live video region ⇒
  `<video autoplay muted loop playsinline preload="metadata" poster="…" aria-hidden="true">`
  (or labelled when live labels it), sized by `aspect-ratio`, `object-fit` as captured.
- Always emit the pause/play control when live has one (and *add* one when live autoplays
  without — WCAG 2.2.2 — noted in the summary as an intentional improvement).
- `@media (prefers-reduced-motion: reduce)`: no autoplay, poster shown; runtime respects it too.
- LCP handling: `preload` the poster, `fetchpriority="high"`, no lazy on the first screen.

### C2. Slider runtime (`packages/codegen/src/export/interactionsRuntime.ts`)

One accessible, dependency-free runtime (plain JS today, reused by the Lit emitter as a
controller) driven entirely by B2's behaviour facts:

- CSS scroll-snap track as the engine (no transform math), `scroll-behavior: smooth`,
  arrows/dots/keyboard/drag wired to `scrollTo`; loop via edge-clone or rewind per captured
  behaviour; autoplay with `IntersectionObserver` (only while visible), paused on
  hover/focus-within and under reduced motion.
- ARIA pattern: `role="region"` + `aria-roledescription="carousel"`, labelled controls, slides as
  `role="group"` with position labels, `aria-live="polite"` while not auto-rotating.

### C3. Hover/focus emission

- B3's hover deltas become generated CSS: `:hover`/`:focus-visible` rules on the control's class
  (delta ⇒ declarations; hover-revealed children ⇒ descendant rules), with the captured
  transition metadata. JS-only effects that CSS can express (class-toggle styles) are thus
  *converted to CSS*, not scripted — modern output, same feel.
- Only effects CSS cannot express (e.g. magnetic cursors) fall back to a small runtime handler,
  listed in the manifest.

**Acceptance C:** on the rebuilt ibmix.de static output, the new A-gates pass: hero plays and
pauses, every slider passes the extended checks, sampled hover states match live.

---

## Workstream D — one semantic DOM instead of breakpoint clones

The structural core of "modern perfect HTML and CSS, responsive flawless".

### D1. Variant unification pass (`packages/scene`, new `unify.ts`)

- Match boxes **across breakpoint variants** (the fluid-geometry machinery in
  `packages/codegen/src/export/responsive.ts` already matches them for interpolation — lift that
  matching into scene so emitters see one tree).
- Output: a single section tree where each node carries a base style + per-range deltas. Classify
  each section: **congruent** (same structure, different numbers → one DOM + media/container
  queries + `clamp()`/`minmax()`/`auto-fit`), or **divergent** (different structure, e.g. phone
  burger nav vs desktop nav bar → per-range subtrees, the inactive one `hidden` + `inert`, never
  text-duplicating whole pages — A5 polices this).
- Express deltas as modern CSS first: fluid type/space via `clamp()` (the fluid lines are already
  computed), wrapping rows via flex/`gap`, grids via `repeat(auto-fit, minmax())`, container
  queries for section-local switches; a raw media query is the last resort, and never around one
  width (flow gate already forbids that).

### D2. Semantic naming & landmarks (scene → codegen)

- Replace `section-46`-style names: reuse the existing model-assisted naming stage (components
  stage already names sets with deterministic fallback) to name **sections and key boxes**
  (`hero`, `teaser-grid`, `logo-wall`…), validated against the same lint (no numbered names).
- Landmark/semantics inference in the emitter: `header/nav/main/section[aria-labelledby]/footer`,
  heading levels normalized to a strict outline (visual size preserved separately via classes —
  live pages often misuse `h3` for style; we keep the look, fix the structure), `<ul>` for
  repeated card rows, `<address>`, `<time>` where recognizable.

### D3. Token-driven CSS

- The tokens the design-system stage already extracts (`packages/codegen/src/export/tokens.ts`)
  become the *only* source of color/space/type in every emitter (static included): custom
  properties on `:root`, semantic tiers (`--color-primary`, `--space-*`, fluid `--step-*` type
  scale), logical properties (`margin-inline`, `padding-block`), `gap` over margins between
  siblings, `aspect-ratio` on media, no fixed px heights except media (flow gate already fails
  them post-build; D makes the build itself comply).
- Size budget: emitted CSS for ibmix.de-class pages targeted < 120 kB uncompressed (vs 482 kB
  today), enforced as a report in A5.

### D4. Lit emitter overhaul (`packages/codegen/src/export/ds/emitLit.ts`)

- One component per *component set* (already extracted), rendered **once**, responsive via its
  own CSS — not one copy per breakpoint. Prefer light-DOM rendering (or declarative shadow DOM
  with shared `adoptedStyleSheets` from the token sheet) so the page is SSR-able, crawlable and
  styleable; no `height: 0` collapsing, no `data-bp` page clones.
- Static-first: a component whose live behaviour is static emits a template with no JS beyond
  registration; sliders/menus use C2's runtime as a shared reactive controller.
- `npm run build` of the Lit project is part of `--build`, and A4 runs against its `dist/`.
- React/Angular emitters follow the same unified tree (smaller change, same renderers).

**Acceptance D:** ibmix.de `ds-lit` output is a single-DOM page; JS and CSS each < 25 % of
today's size; A3 zero serious violations; A4 ≥ 95/95/95/90; pixel/responsive/flow gates stay
green (no fidelity traded for cleanliness — measure runs on the converted output, not only on
static, which also closes today's gap where only `out/static` is measured).

---

## Workstream E — skill, repair loop, evals

- `recreate-url/SKILL.md` + `reference/repair-patterns.md`: new gate list; repair recipes for
  motion ("live hero is a video → check the media inventory, never fake it with a GIF"), slider
  behaviours, hover deltas; the existing hard rules (no `!important`, no absolute positioning,
  patch only inside section markers) stay and now also apply to generated JS (no `setTimeout`
  layout hacks).
- `recreate_section` output gains the section's media/interaction/hover facts and the new checks'
  findings, so the agent repairs against facts instead of screenshots.
- Evals (`evals/`): add a fixture suite of 4 local pages served from fixtures (video hero;
  looping autoplay slider; JS-hover cards; breakpoint-divergent nav) + keep one live-URL smoke
  (ibmix.de-class) outside CI. Each eval asserts gate outcomes end-to-end with the pipeline's own
  tools (tests themselves stay `MockProvider`/local per AGENTS.md).

---

## Order & estimates

| Phase | Content | Size |
| ----- | ------- | ---- |
| 1 | A1–A6 gates in `report` mode + compare-page Quality tab | ~1.5 wk |
| 2 | B1 + C1 media (video hero end-to-end), `motion` → fail mode | ~1 wk |
| 3 | B2 + C2 sliders, extended `interactions` → fail mode | ~1 wk |
| 4 | B3 + C3 hover parity | ~1 wk |
| 5 | D1–D3 single-DOM static output; `a11y`/`markup`/`lighthouse` → fail for static | ~2 wk |
| 6 | D4 Lit (then React/Angular) emitter on the unified tree; gates fail for conversions | ~1.5 wk |
| 7 | E skill/evals/docs polish | ~0.5 wk |

Phases 2–4 are independent of 5–6 and can run in parallel. Nothing in 5–6 may regress the
existing gates: every phase re-runs the full eval suite.

## Risks

- **Video rights/weight**: media assets follow the existing assets policy (gitignored run dir by
  default) and the rights notice; `mediaBytes` budget caps downloads; streamed/DRM sources fall
  back to recorded loops or poster, stated in the summary.
- **Variant unification wrongly merges divergent structures** → layout breaks between widths.
  Mitigation: congruence is judged per section, the responsive sweep (60 widths) is the safety
  net, and a section that fails unified falls back to per-range subtrees (still A5-clean).
- **Lighthouse variance** in CI/sandbox: run 3× median, performance gate on the median, report
  the spread; `skipped` (never `pass`) where Chrome can't run it.
- **Heading normalization changes the visual look** → visual size is carried by classes, pixel
  gate catches any slip.
- **Capture budget growth** (slider stepping, hover mutation watch, media download): each has its
  own budget knob and a `skipped` record in the manifest, like every existing budget.

---

## Implementation status

Implemented on branch `recreation-fidelity`. The plan's structure held; a few designs changed while building:

- **D (one DOM) is a new target, not a rewrite of `static`.** `--to modern` builds the page from the live DOM itself:
  the walker now records each box's live-DOM key (`SnapNode.key`) and DOM order (`ord`), so the walks at every width
  and inside every width's range unify into one tree (`packages/codegen/src/modern/unify.ts`). CSS is fitted across
  those walks (`fit.ts`, `infer.ts`): constants, container shares, `min()` / `max()` / `clamp()` plateaus, `vh`
  heights, grid tracks and areas, flex shares, visual `order`. The scene-based `static` page stays as it was
  (React / design-system outputs still build on it).
- **D4 Lit is a page project (`--to lit`), not the `ds-lit` package.** One light-DOM Lit component per section,
  controllers for menu / slider / video / marquee, every section prerendered by `@lit-labs/ssr` at build time and
  hydrated in the browser (`lit.ts`).
- **A gates live in `packages/measure/src/quality.ts` and `lighthouse.ts`** (one probe instead of separate
  motion / a11y / markup modules): `a11y` (axe-core 4.11, embedded), `markup`, `motion`, `behaviour`, `hover`,
  `lighthouse` (optional dependency). They gate `modern` and `lit`; `static` is unchanged.
- **B capture additions**: video facts and downloads (`capture/media/`), slider facts (library options or an autoplay
  interval read by watching the slider), hover deltas by a real pointer (CSS `:hover` and script-driven), visually
  hidden texts, head facts, transparent / hidden boxes with entrance-animation hints, texts clipped out of view,
  transitions, ARIA attributes, grid areas, `order`.
- **Not done**: recorded loops for streamed video (a stream keeps its poster), region states (tabs, accordions) in the
  modern page, React / Angular page emitters on the unified tree, a repair loop specific to the modern page (the
  agent patches `out/modern/styles.css` under the existing rules).

### Results

Fixture `packages/capture/test/sites/motion` (video hero, autoplay slider with dots, CSS and script hover, burger
menu): the modern page passes every gate — pixel ≤ 0.99 % at 390 / 768 / 1440 px, text, layout, interactions,
responsive, flow, a11y, markup, motion, behaviour, hover; Lighthouse 100 / 99 / 100 / 100. The `static` page fails
pixel, text, interactions, responsive and flow on the same fixture.

ibmix.de (live; 390 / 768 / 1280 / 1440 / 2560 px), `--to modern,lit --build`:

| | first modern run | final | live page itself |
| --- | --- | --- | --- |
| pixel | 72 / 67 / 66 / 67 / 63 % | 5.5 / 19.3 / 3.4 / 2.7 / 2.2 % | |
| page height vs live | +29 … +74 %, up to 1327 px sideways scroll | 0.9 – 3.3 %, no sideways scroll | |
| text missing / extra | 2 – 16 | 0 (1 at 768 px) | |
| a11y (axe serious) | 4 | 0 at 2560 px; 1 rule at 390 px (target-size of 4 submenu toggles) | 1 |
| Lighthouse modern (mobile / desktop) | 77/89/100/100 · 99/85/96/100 | 96/96/100/100 · 100/100/100/100 | |
| Lighthouse Lit build | 71/89/100/91 · 98/85/96/91 | 99/96/100/100 · 100/100/100/100 | |
| video, sliders, hover | still image, 0 sliders, CSS-only hover | video plays with pause control, 2 sliders + logo marquee, 17/20 hover looks | |

The Lit project builds (`tsc`, Vite, `@lit-labs/ssr` prerender) and measures the same as the modern page.

### Follow-up pass (open items closed)

- **768 px heading wrap** (ibmix.de): the live heading holds a `<br>` the page hides at tablet widths; the modern page now
  keeps a class on `<br>` elements so their per-range `display` applies (a `<br>` carries nothing else).
- **Slider peek**: a row of slides the page clips at an outer box (a full-width section) gets a scroll track that reaches
  that edge (negative right margin, the same padding inside, fitted per range), so the next slide shows past the
  container as on the live page.
- **Flow check at 320 px**: a closed menu panel is `visibility: hidden` at rest (visible in its open state); its texts
  no longer count as content out of flow, and its links no longer take focus while it is closed.
- **Target size**: small icon buttons grow their hit area into free space only (padding taken back by margin, never
  over a neighbour), with the look unchanged; slider dots are a pointer shortcut beside the arrows and keys (WCAG 2.5.8's
  equivalent-control exception) and no longer tab stops.
- **Tabs and accordions**: widget states become regions (`data-region`, `data-state`, CSS per state, including what a
  state hides; a control's `aria-controls` target is in its region; the capture restores a tab group to the tab
  selected before). Gated by the behaviour check.
- **Streamed video**: recorded in the page (`captureStream` + `MediaRecorder`, WebM) and played as a loop; fixture
  `packages/capture/test/sites/stream`.
- **React and Angular pages**: `--to react-page` (React + Vite, `react-dom/server` prerender, hydration) and
  `--to angular-page` (standalone, zoneless Angular 20, `outputMode: "static"`, hydration), both built and measured.
- Labels the recreation adds are written in the page's language (German, English).
