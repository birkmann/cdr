# Plan: recreations that flow at every width

Status: implemented (2026-11-07), on top of `main` at `1818ca4`. Written 2026-11-06 as a proposal; the sections below are the plan as written. [Implementation and results](#implementation-and-results) at the end says what was built, what was measured, and where the implementation departs from the plan.

## The problem in one paragraph

A recreation is scored at the widths it was captured at, and almost nowhere else. Everything that produces CSS is therefore rewarded for being exact at those widths and is free to be wrong between them. The repair model does this, and so does the deterministic emitter: it writes values that are constructed to equal the measured number at exactly one viewport width. The result matches at 390, 768 and 1440 px and overlaps, jumps or clips in between. The fix has three parts: measure at every width so point-fitting stops paying off, stop the repair loop from accepting point-fitted patches, and make the emitter write flow layout (document flow, flex, grid) instead of fitted geometry.

Terms used below:

- **Captured width**: a width that becomes a variant of the page (by default 390, 768, 1440).
- **Measured width**: another width the same capture walked the page at (`Snapshot.alt`), used to interpolate.
- **Sweep width**: a width where the output is checked but was not captured.
- **Pin**: a CSS value built so that it equals a measured number at one viewport width and is deliberately loose everywhere else.

## What the evidence shows

### The model is not the only source

The request describes the model faking results at the breakpoints. The code gives the model every reason to do that (see "Why the repair loop point-fits"), but I could not observe it: a repair run needs a model, a live site and consent. What I could measure is the output with no model involved, and it has the same defect.

I built the fixture site (`packages/capture/test/sites/acme`) from its recorded snapshots with repair off, then loaded the output and the original site in headless Chrome at 42 widths from 320 to 2458 px and ran the existing layout probe (`LAYOUT_CHECK_JS`) on both.

| Width | Overlapping text pairs, output | Same, original site | Page height, output | Page height, original |
| ----- | ------------------------------ | ------------------- | ------------------- | --------------------- |
| 468   | 3                              | 0                   | 2976                | 3170 (output −6.1 %)  |
| 505   | 1                              | 0                   | 3530                | 3273 (output +7.9 %)  |
| 579   | 0                              | 1                   | 3530                | 3530                  |
| 616   | 2                              | 0                   | 3530                | 3263 (output +8.2 %)  |
| 653   | 2                              | 0                   | 3530                | 3370 (output +4.7 %)  |
| 690   | 1                              | 0                   | 3699                | 3477 (output +6.4 %)  |
| 1023  | 3                              | 0                   | 1956                | 1956                  |
| 1104  | 0                              | 0                   | 1531                | 1565                  |

Three things follow:

1. The output has more overlapping text than the original at 468, 505, 616, 653, 690 and 1023 px.
2. The responsive gate checks this run at 320, 579, 1104, 1920 and 2560 px. I probed the output at exactly those five widths: zero overlaps at each, so the gate passes.
3. The output's height is a staircase. It stays at 3530 px from 505 to 653 px while the original moves from 3273 to 3530 to 3263 to 3370. Text boxes do not grow with their content; their heights switch between measured values.

The stylesheet explains why. The fixture's own CSS is 364 lines with 3 out-of-flow rules. The output's `styles.css` is 170 KB:

| In the output's 442 class rules            | Count | In the fixture's own CSS |
| ------------------------------------------ | ----- | ------------------------ |
| `position: absolute` or `fixed`            | 110   | 3                        |
| of those on `<p>`                          | 29    | 0                        |
| of those on `<img>`                        | 24    | 0                        |
| a `height` in px                           | 133   | 4 (icons and controls)   |
| a pin (`… * 1000 …` step or distance term) | 57    | 0                        |
| `display: grid`                            | 0     | 3 grids                  |

A typical emitted value:

```css
max-height: calc(
  616.09px + clamp(0px, (max(100vw, 320px) - 391.5px) * 1000, 1px) * 3 +
    clamp(0px, (max(100vw, 320px) - 402.5px) * 1000, 1px) * 19 + …
);
```

That is a step function that switches between measured heights halfway between two measured widths. It is exact at each measured width by construction and says nothing true about the widths between them.

### Why the emitter point-fits

- The scene converter places every element absolutely at its captured rectangle first and turns a frame into auto layout only where that reproduces every position within 1 px ([convert.ts:14](../packages/scene/src/importers/url/convert.ts#L14), [convert.ts:2158](../packages/scene/src/importers/url/convert.ts#L2158)). Whatever does not line up stays a coordinate.
- The capture records little layout intent. `layoutInfo` stores display, position, flex and grid container properties, padding, border, `align-self` and `flex-grow` ([domCapture.js:1515](../packages/capture/assets/domCapture.js#L1515)). It does not store margins, min and max sizes, `flex-basis`, `flex-shrink`, grid item placement or `aspect-ratio`, so the converter has to guess layout from rectangles.
- The fluid pass turns measured numbers into functions of the viewport that pass through every measured point: `stepCss` for heights that change where text wraps ([responsive.ts:771](../packages/codegen/src/export/responsive.ts#L771)), a `max-height` that is tight only at the design width ([responsive.ts:1117](../packages/codegen/src/export/responsive.ts#L1117)), and a narrowed text width that holds only at the capture width ([responsive.ts:650](../packages/codegen/src/export/responsive.ts#L650)).
- Below the narrowest fitted width the variant is scaled with `zoom` instead of reflowing ([responsive.ts:94](../packages/codegen/src/export/responsive.ts#L94)).

### Why the repair loop point-fits

- A section is scored only at the captured widths, and only by pixels ([pipeline.ts:591](../packages/recreate/src/pipeline.ts#L591), [pipeline.ts:631](../packages/recreate/src/pipeline.ts#L631)).
- The repair task carries only those widths: a pixel number and two crops each. The system prompt says to make the section "match the live page" and nothing about other widths ([host.ts:59](../packages/core/src/recreate/host.ts#L59)).
- The returned CSS is appended to `styles.css` after removing `@import` and remote `url()`. Nothing checks that its selectors are scoped to the section, and nothing rejects `@media (width: 1440px)`, absolute positions, fixed heights, negative margins or `!important` ([host.ts:117](../packages/core/src/recreate/host.ts#L117)).
- A patch that gets the section under the pixel threshold marks it `repaired`. It is not checked at any other width, and a patch that makes things worse is never reverted ([pipeline.ts:595](../packages/recreate/src/pipeline.ts#L595)).
- The agent in a chat gets the same incentive from the skill: "Keep going until every width passes its gates" ([SKILL.md:38](../packages/core/skills/recreate-url/SKILL.md#L38)), and `repair-patterns.md` recommends adding a `@media` rule at the switch width as the fix for boxes that shift.

### Why the responsive gate does not catch it

- It checks 320 px, the midpoint of each gap between captures, 1920 and 2560 px ([layout.ts:147](../packages/measure/src/layout.ts#L147)). That is five widths for a default run, and the midpoints are fixed and predictable.
- It only looks for text overlapping text, text off-screen and horizontal scroll ([layout.ts:7](../packages/measure/src/layout.ts#L7)). Text over an image or a button, text clipped by its box, and a page whose height does not follow its content are not checked.
- It compares counts, with one overlap of slack (`out > live + 1`, [layout.ts:114](../packages/measure/src/layout.ts#L114)). An output overlap can hide behind a different overlap on the live page.
- Pixels at a sweep width count only inside a variant's measured span ([report.ts:208](../packages/measure/src/report.ts#L208)).

## Goals

1. At every viewport width from 320 to 2560 px the output has no overlapping, clipped or off-screen content that the live page does not have at that width.
2. The page's height and the position of its content follow the live page continuously between captured widths, with no steps.
3. The output's CSS is flow layout: elements are out of flow only where the live page takes them out of flow, text boxes size to their content, and no value is a pin.
4. Neither the repair model nor the agent can raise a score by fitting the checked widths.
5. Fidelity at the captured widths stays a gate. Where it conflicts with flow, flow wins and the pixel miss is reported (see "Decisions for you").

Not in this plan: merging the per-variant DOM copies into one DOM with media queries, measuring converted outputs (`react-vite`, `ds-*`; only `static` is measured today), and hover or focus states.

## Work, in order

The order matters. Phase 1 makes the defect visible and gives every later change a number to move. Phase 2 closes the model's shortcut. Phase 3 is the real fix and the largest piece.

### Phase 0: baseline tool (small)

Add `scripts/recreate/sweep.mjs`: given a run folder, or a file or URL, load it at a list of widths and print per width the probe facts and the page height, as JSON and as a table. This is the script behind the table above. Record its output for the fixture in this document's table, and for three to five real sites you choose (they need consent and the network, so they are run by hand, not in tests).

Done when: the numbers above are reproducible with one command.

### Phase 1: measure at every width (medium)

**1.1 A dense sweep plan.** Replace `sweepWidths` in [layout.ts](../packages/measure/src/layout.ts) with `sweepPlan({ captured, measured, switches, seed })` that returns:

- a grid from 320 px to the widest measured width: every 24 px below 1024 px, every 48 px above, plus 2560 px (about 50 widths for a default run);
- both sides of every variant boundary (`minWidth − 1` and `minWidth`);
- six rotating widths drawn from a seeded generator, at least 8 px from any captured or measured width. The seed is the run id plus the number of measurements the run has had, so every `recreate_measure` checks widths the previous one did not. The widths are written to the report after the fact.

The output is a local file, so the output side of the sweep is a resize and a probe per width. Screenshots are taken only where there is a live screenshot to compare with.

**1.2 Live facts at the grid.** The live page needs the same facts so its own quirks are allowed. Add `probeWidths` to the capture options next to `shotWidths` ([driver.ts:1584](../packages/capture/src/driver.ts#L1584)): resize, run the probe, no PNG. Store as `capture/live/<width>.json`. Live screenshots stay at the captured widths and at the current five sweep widths. A rotating width has no live facts of its own; it is judged against the union of its two grid neighbours.

**1.3 A stronger probe.** Extend `LAYOUT_CHECK_JS` (keep the name and the existing fields, so older reports still read):

- `pairs`: overlapping content pairs with stable keys (text prefix for text, source basename or alt for media, role plus label for controls), each tagged with its `data-section` id in the output. Kinds: text over text (exists), text over media, and controls over text or controls. Ancestors, backgrounds and scroller contents stay excluded as today.
- `clipped`: text whose line boxes are cut by an ancestor with `overflow: hidden` or `clip`, except ellipsis and line-clamp.
- `outOfFlow`: keys of text blocks that have an absolute or fixed ancestor below `body`.
- `docHeight`, and `anchors`: key, x, y of up to 200 text blocks.

**1.4 Compare by identity, not by count.** In `layoutCheck`, an output pair, clipped text or off-screen text is an issue unless the live page has the same key at that width (or at a grid neighbour, for rotating widths). Remove the `+ 1` slack.

**1.5 Height tracking.** At every sweep width with live facts, the output's page height must be within `gates.sweepHeightPct` (default 5) of the live page. Report anchor drift (how far each text block's relative position is from the live page) but do not gate on it until real-site baselines show its noise level.

**1.6 A `flow` gate.** New pure module `packages/measure/src/flow.ts`, `flowLint({ css, baselineCss, sectionIds, variantBoundaries })`, built on `postcss` (already in the lockfile at 8.5.32 through Vite; add it as a direct dependency of `@harness/measure`). It reports:

| Rule                | Flags                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `media-pin`         | a width media query that is an exact width or a range under 16 px, other than the emitter's own variant boundaries    |
| `value-pin`         | a value with a `* 1000` step or distance term, or any discontinuous viewport function                                 |
| `zoom`              | `zoom` on page content                                                                                                |
| `added-out-of-flow` | in CSS added after the build: `position: absolute` or `fixed`, negative margins, `transform: translate` for placement |
| `added-fixed-size`  | in CSS added after the build: a px `height` or `max-height` on anything but media                                     |
| `added-unscoped`    | in CSS added after the build: a selector not scoped to a section's classes or `[data-section="ID"]`                   |
| `added-important`   | in CSS added after the build: `!important`                                                                            |

"Added after the build" is decided by diffing against the stylesheet the build wrote, so the build stores `out/static/styles.css` as `build/styles.base.css`. The `added-*` rules gate from the first day. `media-pin`, `value-pin` and `zoom` are counted for emitter output and become gating in Phase 3 when the emitter stops producing them.

The gate also takes the probe's `outOfFlow` set: a text block that is out of flow in the output and in flow on the live page at the same width is a violation. This is counted in Phase 1 and gating in Phase 3.

**1.7 Report and compare page.** Declare `sweep` on `MeasureReport` (it is written today but missing from the interface). Add `flow` to `GateResult["name"]`. In the compare page, add a strip with one cell per sweep width (pass, fail, issue on hover) and a width slider that resizes the output iframe, so a person can scrub through the widths.

**1.8 Configuration and docs.** `recreate.gates` gains `sweepHeightPct`; `docs/recreate.md` and `docs/configuration.md` describe the new gate row and the denser sweep. Regenerate the schemas.

Done when: on the fixture, the `responsive` gate fails and names grid widths between about 460 and 700 px and the boundary width 1023 px, each with its overlapping texts, and the `flow` gate reports the pin and out-of-flow counts from the table above. Runs will truthfully show "Gates missed" until Phase 3 lands (see "Decisions for you").

### Phase 2: a repair loop that cannot point-fit (medium)

**2.1 Validate before writing.** In `repairSection` ([host.ts](../packages/core/src/recreate/host.ts)), run `flowLint` on the proposed CSS with every `added-*` rule plus `media-pin` and `value-pin`. A patch with a violation is not written. The reasons go back to the model for its second attempt. Enforce the section scope that the prompt already asks for.

**2.2 Score at sweep widths, and revert.** In `build()` ([pipeline.ts:595](../packages/recreate/src/pipeline.ts#L595)), after each repair pass re-check the section at the captured widths and at the sweep widths (probe facts scoped to the section's pairs, plus pixels where a live screenshot exists). Keep a patch only if all of these hold:

- no new overlap, clipped or off-screen issue at any sweep width;
- the page height is no further from the live page at any sweep width;
- the captured-width pixel score improved.

Otherwise restore the files as they were before the pass. This needs the repair's writes to be reversible per section: the appended CSS block is already delimited by its `/* repair: section … */` comment, and markup is replaced between section markers, so the pipeline snapshots both files before a pass and restores the section's parts on rejection.

**2.3 Trigger on layout, not only pixels.** A section whose content appears in a failing sweep pair is sent to repair even when its captured-width pixels pass. `recreate.section` gets optional `reason` (`"pixel" | "responsive" | "flow"`) and `reverted` fields. That is a protocol change: `EventBody`, `reduceSession`, the CLI `Renderer`, regenerated schemas.

**2.4 Give the model the right task.** `RepairTask` gains `sweep` (per failing sweep width: the issues, and crops where a live screenshot exists) and `rejected` (reasons from the previous attempt). Rewrite `REPAIR_SYSTEM`: the goal is the layout rule the live page uses, so the section holds at every width; the patch is checked at widths the model is not shown; list what is allowed (flex, grid, `gap`, `minmax`, `fr`, `clamp`, `min`, `max`, `aspect-ratio`, auto margins, `flex-wrap`, `text-wrap`) and what is rejected and why.

**2.5 The agent in a chat.** The agent patches with `patch_file`, which does not go through `repairSection`, so the gates are what hold it:

- `recreate_measure` output adds the `flow` and `responsive` details and crops at the worst sweep width, not only the worst captured band.
- `recreate_section` adds the section's sweep issues and its `flow` violations.
- `SKILL.md`: replace "Keep going until every width passes its gates" with a rule that the `responsive` and `flow` gates are never traded for pixels at the captured widths, and that a patch which fails them must be undone.
- `repair-patterns.md`: remove the advice to add a `@media` rule at the switch width as the default; add recipes per symptom (text box too short: remove the height, keep `min-height`; columns that change count: `repeat(auto-fit, minmax())` or `flex-wrap`; a value that grows with the viewport: `clamp()`), and a list of rejected constructs.

Done when: every patch in the cheat corpus (see Tests) is rejected with a reason and leaves both files byte-identical, and a patch that passes at captured widths but adds an overlap at a sweep width is reverted.

### Phase 3: an emitter that writes flow (large)

This is where the defect is produced, so this is where it is fixed. The work is staged so each step is measurable with the Phase 1 gates on the fixture.

**3.1 Capture layout intent.** Extend `layoutInfo` ([domCapture.js:1515](../packages/capture/assets/domCapture.js#L1515)) with computed margins, min and max width and height, `flex-basis`, `flex-shrink`, grid item placement (column and row start and span), `aspect-ratio`, `float` and `box-sizing`. Per measured width, classify each in-flow box's width as filling its container, capped by its max-width, or sized by its content. Run `node scripts/recreate/embed.mjs` and re-record the fixture.

**3.2 Flow first in the scene converter.** Reverse the default in [convert.ts](../packages/scene/src/importers/url/convert.ts). An element that is in flow on the live page (`position` static, relative or sticky) stays in flow, in the mode its container uses on the live page: block flow, flex with the captured direction, wrap, alignment and gap, or grid with tracks. Its offsets become margins, padding and gaps. Only elements the live page positions absolutely or fixes stay positioned. The geometric inference in `tryAutoLayout` remains for containers that lay out by other means (floats, tables, inline-block rows).

**3.3 Sizes that follow content.** A box that holds wrapping text never gets a px height: `height: auto`, with `min-height` only where the live page computes one or the box is taller than its content at every measured width. Remove the `max-height` pins and the `data-narrowed` pin. Delete `stepCss`.

**3.4 Continuous fluid values.** Replace the per-property fitting with one builder, `fluidValue(points)`, that returns a constant, a `clamp(min, a·vw + b, max)`, or a continuous piecewise-linear value with at most two knots, whichever fits the measured points within 1 px. When nothing fits, it returns the constant of the nearest measured width for the variant's range. It never returns a discontinuous function.

**3.5 Grids and wrapping.** Keep `fluidGrid` for equal tracks. Add proportional tracks (`3fr 2fr` from tracks that scale together across measured widths) and track counts that change inside one variant's range (`repeat(auto-fit, minmax(Npx, 1fr))`, with N from the widths where the count changes). Honour the captured `flex-wrap`.

**3.6 Check each section and fall back.** After emitting, the build already shoots the output. Add a deterministic residual check: for every section, compare element rectangles in the output with the captured rectangles at every captured and measured width (the fixture has 7 measured widths for the phone variant, 4 for tablet, 8 for desktop). A section whose flow version is outside tolerance falls back one step at a time: first flow with fluid values, then today's fitted geometry for that section only. A fitted section is listed in the report, counted by the `flow` gate, and keeps `zoom` below its narrowest width. Every other section reflows without `zoom`.

**3.7 Turn the counted rules into gates.** `media-pin`, `value-pin`, `zoom` and the out-of-flow text comparison gate for every section that is not marked fitted. The number of fitted sections has a budget (`gates.fittedSections`, default 0 for the fixture's eval).

Done when, on the fixture: zero overlap pairs beyond the original at every sweep width; page height within 3 % of the original at every sweep width; zero pins; out-of-flow class rules at most 10 (110 today; the site has 3 plus the menu overlay); no px height on a text-bearing box; and the pixel, text, layout and interaction gates still pass at 390, 768 and 1440 px.

The React and design-system emitters call the same `fluidVariants` ([bundle.ts:712](../packages/codegen/src/export/bundle.ts#L712), `reactProject.ts`), so they inherit 3.3 to 3.5. Their tests need the same updates.

## Tests

All tests follow the repository rules: `MockProvider`, no network, no real model. Tests that need Chrome skip when there is none, like the existing ones.

### Without a browser

`packages/measure/test/measure.test.ts`

- `sweepPlan`: contains the grid, both sides of every variant boundary and six rotating widths; never contains a captured or measured width; the same seed gives the same widths and the next measurement count gives different ones. The existing `sweepWidths` expectations are replaced.
- `layoutCheck`: an output pair the live page also has passes; a different pair with the same count fails (this is the case the count comparison let through); clipped text fails unless the live page clips the same text; a rotating width is judged against both grid neighbours; height outside `sweepHeightPct` fails.
- `measure`: the `flow` gate appears in the report; `report.sweep` is typed.

`packages/measure/test/flow.test.ts` (new), driven by two folders of small CSS files:

- `test/corpus/cheat/`: one file per way to point-fit. `@media (width: 1440px)`, a 1 px media range, a `* 1000` step, an absolute position on a text element, a px height on a text box, a negative margin pulling a box into place, `transform: translate`, `!important`, an unscoped selector, `zoom`. Each must produce exactly its rule.
- `test/corpus/honest/`: `flex-wrap`, `repeat(auto-fit, minmax())`, `clamp()` type, auto margins with `max-width`, `aspect-ratio`, a media query at a variant boundary. None may be flagged.

`packages/core/test/recreate.test.ts`

- `repairSection` rejects every cheat-corpus patch, returns `false`, leaves `index.html` and `styles.css` byte-identical and passes the reasons to the second attempt's prompt (asserted on the `MockProvider` call).
- It accepts every honest-corpus patch.
- The rewritten prompt contains the sweep issues it was given.
- The client reducer and the CLI renderer handle `recreate.section` with `reason` and `reverted`.

`packages/recreate/test/pipeline.test.ts`

- Extend `fakeDriver` so `shoot` answers probe facts from a table per width instead of always "no overlaps" ([fake-driver.ts:46](../packages/recreate/test/fake-driver.ts#L46)).
- A repair that passes pixels at the captured width but adds an overlap at a sweep width is reverted: files restored, section ends `below-threshold` with `reverted: true`.
- A section with passing pixels and a failing sweep pair is sent to repair with `reason: "responsive"`.
- A run whose output overlaps at a sweep width but nowhere else ends with the `responsive` gate failed. With the old five-width sweep this run passed; the test documents that.
- The literal `shoot 320,579,1104,1920,2560` expectation is replaced by the new plan.

`packages/codegen/test/fluidVariants.test.ts`

- `fluidValue`: for generated point sets, evaluate the returned expression numerically across the range. It is within 1 px at every measured point, never changes by more than its largest slope between adjacent pixels (continuity), and is monotone when the points are. This needs a small evaluator for `calc`, `min`, `max` and `clamp` in the test, or the builder returning a structured value next to its string.
- Emitting the fixture's recorded snapshots produces CSS that passes `flowLint` and stays within the Phase 3 budgets (pins, out-of-flow rules, px heights on text boxes). This runs without Chrome and is the day-to-day regression test for the emitter.
- The `stepCss` and `data-narrowed` tests are removed with the code; the tests that assert "exactly the captured geometry at the design width" are rewritten to assert a tolerance.

`packages/scene/test/convert.test.ts`

- An in-flow flex row, a grid and a block column from a snapshot stay in flow with the captured mode; an authored absolute badge stays absolute; a float row still goes through `tryAutoLayout`.

### With Chrome

`packages/measure/test/probe.test.ts` (new): small local pages, one per probe fact. Text over text, text over an image that is not its background, a button over text, text cut by `overflow: hidden`, ellipsis (not flagged), a hero with text over its own background image (not flagged), text inside a slider track (not flagged).

`packages/measure/test/sites/pinned/` (new): a hand-written page that equals the fixture at 390, 768 and 1440 px and overlaps at about 500 and 1100 px. The new gate fails it; an assertion on the old five widths shows they would have passed. Next to it, an honest version that passes.

`packages/capture/test/sites/fluid/` (new fixture site). The existing fixture only changes layout at its two media queries, which is the easy case. This site has what point-fitting cannot follow:

- `repeat(auto-fit, minmax(240px, 1fr))`, so the column count changes with no media query;
- `clamp()` type and spacing;
- a navigation that wraps;
- long unbreakable words and a long heading;
- `aspect-ratio` media;
- a sticky header;
- text over an image by design;
- one container query.

`packages/recreate/test/pipeline.test.ts`, end to end with Chrome:

- Recreate `acme` and `fluid`, then sweep every 24 px from 320 to 1920 px: no issue beyond the original at any width, page height within 3 % everywhere, `flow` gate passes. This test fails today with the numbers in the table at the top and is the acceptance test for Phase 3.

`apps/web` e2e: the compare page's width slider resizes the iframe and the sweep strip shows the failing widths.

### Evals

Evals call a real model through `cdr eval`, so they are the only place the model's behaviour is tested.

- `30-recreate-fixture.json`: add `flow` to the required gates.
- `31-recreate-fluid.json` (new): the `fluid` site, required gates `responsive` and `flow`.
- `32-recreate-repair-honest.json` (new): a variant of the fixture whose build is broken at a captured width on purpose (a section with a wrong gap), run with `--repair`. Required: `pixel`, `responsive` and `flow` all pass afterwards, and `build/styles.base.css` differs from `styles.css` (a repair happened). This is the direct test of the reported problem: the model is given a reason to fix a captured width and must do it without breaking the widths between.

## Decisions for you

1. **Gate truthfully from Phase 1, or keep runs green until Phase 3?** Recommended: gate truthfully. The fixture overlaps today and a passing gate on an overlapping page is the defect. The cost is that runs, and eval 30, show "Gates missed" on `responsive` until Phase 3 lands. The alternative is a temporary report-only mode, which hides the number the work is meant to move.
2. **When flow and pixels conflict at a captured width, which wins?** Recommended: flow. A section that can only reach 1 % by being fitted is reported as a pixel miss, not shipped as fitted geometry, unless `gates.fittedSections` allows it. The alternative keeps today's fidelity numbers and today's behaviour between widths for those sections.
3. **Capture time.** Live facts at about 50 widths are 50 resizes and probes per run in the already loaded tab, with no screenshots. If that is too slow on heavy pages, the grid step can widen to 48 px everywhere; the rotating widths keep the check from becoming predictable.
4. **Is repair worth keeping on by flag once Phase 3 lands?** Decide after eval 32 has results. If the emitter's flow output passes without it, the repair loop is mostly risk.

## Implementation and results

### Results on the fixture sites

Measured with `node scripts/recreate/sweep.mjs` and the acceptance test (every 24 px from 320 to 1920 px against the live site), Chrome on macOS, no model involved.

| acme fixture                                          | Before               | After                                |
| ----------------------------------------------------- | -------------------- | ------------------------------------ |
| widths with overlaps, cut text or off-screen text     | 17 of 51             | 0 of 62                              |
| page height between captures, worst difference        | 9.0 %                | 0.7 %                                |
| value pins / media pins / `zoom` rules                | 64 / 0 / 5           | 0 / 0 / 0                            |
| `position: absolute` or `fixed` class rules           | 110                  | 6 (the slider arrows, absolute live) |
| texts out of flow that the live page keeps in flow    | 37                   | 0                                    |
| class rules with a px `height`                        | 133                  | 28                                   |
| …of them on boxes holding text                        | 86                   | 9 (the page's own 22 px badges)      |
| `styles.css`                                          | 170 KB               | 153 KB                               |
| pixel at 390 / 768 / 1440 px                          | 0.12 / 0.11 / 0.07 % | 0.12 / 0.11 / 0.06 %                 |
| full pipeline, all gates (now including the new ones) | responsive fails     | all pass                             |

The `fluid` fixture (auto-fit grid, `clamp()` type, wrapping navigation, container query, long words, text over a picture) passes every gate end to end at its six layout ranges (pixel 0.12–0.46 % at the captured widths, every sweep width within its gates). `acme-drift` (a section with `transform: scale()`) fails only the flow gate, by design: it is the repair eval's input.

### What was built, by step

- **Phase 0.** `scripts/recreate/sweep.mjs`: a page or a run folder against another page or the run's live facts, `--fixture` for the acme build from its recordings, `--fixture --pipeline [--site] [--capture]` for the whole pipeline on a fixture site.
- **1.1–1.5.** `sweepPlan` (grid, boundaries, six seeded rotating widths), live layout facts at the grid during the capture (`probeWidths`, a tab resized in place), the extended probe (content pairs by key, cut text, out-of-flow texts, page height, anchors, section heights), identity comparison, the height gate (`sweepHeightPct`, gated inside a variant's measured span, a note outside it).
- **1.6–1.8.** `flowLint` on postcss with the rule set of the plan, the baseline stylesheet, the flow gate, `report.sweep`/`sweepPlan`/`flow`, the compare page's sweep strip and width slider, config and schemas.
- **2.1–2.5.** Patches linted before they are written (rejected reasons to the next attempt, style attributes rejected), every pass re-checked at the sweep widths with per-section undo, the `pixel` / `responsive` / `flow` reasons, `reverted`, the rewritten prompt, the tool output, the skill and the repair patterns.
- **3.1.** Margins, min / max sizes, flex basis and shrink, grid placement, `aspect-ratio`, `float`, `box-sizing`, `white-space` and a picture's source media are captured. The acme recording got these fields merged in by node id; its other numbers were kept (a fresh capture differs by sub-pixel text widths, which would have shifted unrelated tests).
- **3.2.** Flow first (`UrlImportOptions.flow`, default on; `flow: false` is the fitted conversion): side margins in columns, wrapping flex rows rebuilt from the page's CSS (all `justify-content` values), the page root in flow, boxes at their `max-width` filling their parent up to it, slide tracks as rows, flex and grid containers kept as boxes, padding the page's CSS gives kept as padding, rows hugging their tallest child, equal lines stretched, single lines with room left on them wrapping, only `<br>` breaks kept (early breaks become `text-wrap: balance` / `pretty`), words the page breaks to fit their box left breakable.
- **3.3–3.4.** Heights that follow content (`height: auto`, never a `max-height` pin), a narrowed text's full box width, no `zoom` for measured variants or their menus, an art-directed image sizing its box, `fluidValue` (constant, a line, one knot at a measured width or where two lines meet, two such knots; 0.05 px tolerance for type, 1 px for boxes), `stepCss` removed. A pinned header in flow is `position: sticky` and the page clips with `overflow: clip`.
- **3.6–3.7.** The fitted fallback and the gating rules, see the deviations below.
- **Tests** as listed in [Tests](#tests); evals 30–32 as listed in [Evals](#evals).

### Where the implementation departs from the plan

- **Sweep widths and measured widths (1.1).** The plan said the sweep never contains a measured width. The fixture overlapped at 1023 px, which is a measured width, so the grid and the boundaries may include measured widths; only the rotating widths keep 8 px away from them.
- **Cut text (1.3).** Only vertical cuts count (a box too short for its text). Horizontal clipping is a slider's or a band's design too often to tell apart. Overlaps are checked on the visible part of each line (clipped by the boxes around it).
- **Grids that change their column count (3.5).** No `repeat(auto-fit, minmax())` is emitted. The probe already finds where such a grid changes its count, so the capture now takes **one variant per layout range** by default (`recreate.capturePlan: "ranges"`), and every range is walked 24 px inside both its ends as well. With the old one-variant-per-device plan the `fluid` fixture differed from the live page by 26–59 % in the ranges no variant measured; with the ranges plan it matches everywhere. `capturePlan: "devices"` keeps the old plan for pages where the extra variants cost too much capture time. Proportional tracks (`3fr 2fr`) come out as rows whose widths follow the measured ones continuously.
- **The residual check (3.6).** The fallback compares each section's pixels at the captured widths (the build's existing section check), not element rectangles at every measured width. Following decision 2 it only runs when `gates.fittedSections` is above 0 (default 0), keeps a section fitted only when that is closer to the live page, and never swaps a section holding a menu or widget control (their targets belong to the flow scene).
- **Explicit `--widths`.** Not in the plan: given widths are now walked across their own layout range (probed), not only at 1920 px for the widest, so they reach the flow export too; past the page's next switch a range counts as not captured.
- **A single capture** walked at other widths is a responsive page of one variant, for the same reason.
- **The `flow` repair reason (2.3)** is given to a section whose only problem is text placed by coordinates (probe anchors name their section).

### Fixes from real sites (bmw.de, bvg.de, ibm.com)

The fixture sites passed, real sites did not; these generator fixes came from them (each has a unit or browser test):

- **Pictures keep their proportions.** An image filling its box with the picture's own ratio is `object-fit: cover` in flow; a picture no other width measured (a video frame) keeps its ratio (`aspect-ratio`, width 100%); one measured at other widths with a fixed height keeps that height.
- **Full-bleed breakouts.** A box wider than its capped parent (a 1920 px stage in a 1728 px column) keeps its overhang as negative margins.
- **Viewport-tall boxes.** The capture walks each variant once more in a viewport 200 px taller (`SnapElement.vh`, `Snapshot.viewportProbe`); a box that grows with it, and not only because a child does, is exported in `vh` (`min-height` when it hugs its content). bmw.de's stage is 100vh: 844 px on a phone, 1024 px on a tablet.
- **Clips around pictures.** A box with `overflow: hidden` around a picture as wide as itself keeps its clip in flow (the picture can outgrow it at another width).
- **Boxes re-parented for paint order.** A relative, z-indexed box the capture moved to its stacking context goes back to its DOM parent when it stays inside its parent's box (bmw.de's teaser panels; the page root then flows instead of keeping a fixed height). Sticky boxes and boxes pulled over the band before them (bvg.de's trip planner) stay.
- **Inline icons.** A text and the small boxes on its last line right after it (info icons) are inline content of one block, with the text's line height as the block's strut.
- **Row padding.** In flow, a row's cross padding is the room every child leaves; a lower child gets its own margin (bvg.de's app teaser row was 91 px too tall and centred the page off by 46 px).
- **Pinned layers in wrappers.** A fixed header one wrapper below the page root is exported `position: fixed` too (ibm.com's masthead between 672 and 1055 px).

- **The checker keys text by its block.** A heading split over inline elements on one page and joined on the other is one text (`LAYOUT_CHECK_JS` keys by the nearest non-inline box's rendered text; keys compare without spaces); the pieces of a text the output keeps by line match the live block holding them, the nearest one. Before, these showed up as overlaps and out-of-flow texts the live page "does not have".
- **Negative margins.** A panel the page pulls up over the picture before it (`margin-top: -172px`) stays in the column with that margin.
- **Room below the flow.** Space a box keeps below its content (an empty last box's margin, a collapsed margin) stays as bottom padding when the export lets the box follow its content (`meta.below`), and a hugging row keeps its child's margins.
- **The page follows its content.** A page whose content flows is as tall as its content (it kept the captured height and clipped everything below it at other widths).
- **Viewport heights that are set, not minimums.** A viewport-tall box whose content overflows it (here or at another walked width) gets `height`, not `min-height`.
- **Inline runs after paragraphs.** The last line of a block (after block paragraphs) with an icon after it is its own inline block, spanning the block and keeping its alignment; the text keeps the page's CSS line height there.
- **Relative `<sup>`s** stay in their paragraph, which then rewraps as one text.
- **Absolute boxes moved for paint order** go back into their DOM parent when inside its box (teaser text panels on desktop).
- **CSS columns, inline-block rows and placed grid items** are taken from the page's CSS: `columns` (captured as `SnapLayout.columns`), inline-block children as a wrapping row, and a grid of equal tracks with numbered `grid-column` / `grid-row` placements (the outermost collapsed box's).

- **Boxes taller than their flowing content** (a card as tall as its grid row, its heading placed over it) keep their measured height; the export only lets a box follow its content when its flowing children can fill it.
- **Wrappers stay where the page nests them.** A block holding several items (a row of tags under a title) stays one box; dissolved, its items mixed with its siblings' and no line or column held them. CSS columns pass down to a wrapper that is the columns' only content.
- **Small offsets at the start of a line** are no reason to give up on the line: a glyph box a pixel or two above its line box, or a first child a negative margin pulls up (when a margin in it accounts for the offset).
- **Children spanning a row's height align to its start**, not its centre (all three fit the capture; centred, the whole page moved when one child came out a few pixels shorter).
- **Past the widest measurement**, a measured variant keeps following the page's lines: no cap at the widest measured layout (it cut full-width backgrounds) and no viewport term frozen there. The compare page scales a width wider than the window to fit.

Results (fresh captures with the viewport walk and the new probe; pixel difference at the captured widths):

| Site    | Before this round                                                                                                                     | Now                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bmw.de  | pixel 390 px 4.38 %, 25 texts out of flow, overlaps at 81 sweep widths, hero misplaced, images stretched, layout capped above 2400 px | pixel ≤ 0.45 % at every captured width, heights within 3 px, **pixel, layout, flow and interactions gates pass**, no overlaps at any sweep width, the same as the live page up to 3840 px; responsive fails only on pixels at 320 / 579 px (icons wrapping, a video frame) |
| bvg.de  | 1024 px 2.54 %, 116 texts out of flow                                                                                                 | 1024–1440 px 0.04–1.75 %, layout passes, 26 texts out of flow (the trip planner's buttons, disruption rows, news dates, the legal links); 390–768 px differ by ~16 % because the live page added a disruption between its walk and its screenshot                          |
| ibm.com | pixel 2.5–29 %, layout failing                                                                                                        | 720 px 1.5 %, 1024 px 1.0 %, 1920 px 1.6 %, 390 px 4.1 %, layout passes, 33 texts out of flow; 1440 px 5.7 % (product cards captured mid-animation in the live screenshot)                                                                                                 |

### What was verified, and what was not

- Verified by running it: every result above; the unit, pipeline, CLI and browser tests (`pnpm test`); the web e2e suite with its new compare-page steps, which passes once a check that already failed on `main` before this work is skipped (`no column divider in stacked mobile layout`, an unrelated layout assertion).
- Not run: the evals (30–32 call a real model), any real site (they need consent and the network), the React and design-system exports in a browser (they share the fluid pass and pass their unit tests).
- Known limits: a value that turns between two measured widths with only one measured width past the turn can be off between them; `transform: scale()` is not reproduced (the flow gate reports it); the fitted fallback is off by default and its sections do not reflow.
