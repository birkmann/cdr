# Recreate a page 1:1

CDR can rebuild a live web page as code you own: measured from its real DOM, block by block, at every width, with its menus and sliders working, and compared with the live page afterwards.

This is **opt-in only**. A plain brief such as "example.com" still goes to the `web-app` skill, which designs an original page. A recreation starts only from `cdr recreate`, the web app's **Recreate 1:1** or **Rebuild as code** button or `/recreate`, or a chat message that asks for an exact copy of a URL ("recreate … 1:1", "clone this page", "pixel-perfect").

Every run asks for consent first: a high-risk permission request that names what is copied. The layout, text, photos, fonts and logos belong to their owners. Use a recreation for your own evaluation and prototyping, or with the rights holder's permission. Captured assets stay in the gitignored run folder unless you configure otherwise. A denied request captures nothing and leaves no run folder. No logins, paywalls or captchas are bypassed. The capture runs as an anonymous visitor in a fresh browser profile.

## Command line

```bash
cdr recreate https://www.example.com/            # static recreation at the page's own layout ranges
cdr recreate example.com --widths 390,768,1440   # explicit widths
cdr recreate example.com --to static,react-vite --style css-modules
cdr recreate example.com --to ds-react,ds-lit,tokens
cdr recreate example.com --out ./site            # copy the outputs into ./site when done
cdr recreate --run <id> --from components --to ds-angular   # re-run later stages of an earlier run
cdr recreate capture example.com --out ./snapshots          # capture only (snapshots + live shots)
```

| Flag                        | Meaning                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--widths a,b,c`            | Capture widths. Each one is also walked across its own layout range (up to the next given width or the page's next layout switch; the widest one up to 1920 px). The default is the page's own layout ranges (`@media`, `@container` and script switches), one variant per range. If the probe fails, 390, 768 and 1440 are used. |
| `--to …`                    | Outputs: `static` (default), `react-vite` (`react` is accepted too), `ds-react`, `ds-lit`, `ds-angular`, `tokens`, `design-md`.                                                                                                                                                                                                   |
| `--style`                   | Styling for `react-vite`: `tailwind`, `css-modules` or `vanilla`.                                                                                                                                                                                                                                                                 |
| `--repair`                  | Lets the configured model repair sections below their threshold (opt-in: at most two passes, a few sections at a time, each re-scored). Without it the run makes no model call while building.                                                                                                                                    |
| `--no-checks`               | Skips the section scores while building (one output shot per width). The final measurement still runs.                                                                                                                                                                                                                            |
| `--build`                   | Runs `npm install && npm run build` in converted projects as a gate. This needs the network.                                                                                                                                                                                                                                      |
| `--from <stage> --run <id>` | Resumes a run from a stage (`build`, `measure`, `components`, `convert` …). No URL is needed: the run's stored URL is used. Consent is kept. The run keeps its targets unless `--to` names others; a stage the targets skip resumes at the next one they run.                                                                     |
| `--out <folder>`            | Copies the outputs into a folder of the project when done. It must be relative and stay inside the project (no `..`, no symlink out, not `.git`).                                                                                                                                                                                 |
| `--yes`                     | Answers the consent prompt. The log still records `permission.resolved { auto: true }` and the consent as `by: "auto"`. A session that auto-approves permissions (`cdr run --yes`, `autoApprove.permissions`) records it the same way.                                                                                            |
| `--json`                    | Streams the events as JSONL for scripts.                                                                                                                                                                                                                                                                                          |

The command prints one line per stage and per section, the numbers per width, the gates, and the path of the compare page.

## What a run does

```
consent → probe → capture → scene → build → measure  [→ components → system → convert / ds-export]
```

1. **probe** finds the page's layout switches and plans one variant per layout range (`recreate.capturePlan: "devices"`: one per device class). Each variant is also walked at other widths of its own range: steps of at most 240 px, common device widths, and 24 px inside both ends of the range, so a value that turns near a breakpoint (type reaching its `clamp()` bound, a column reaching its max-width) is measured on both sides of the turn.
2. **capture** loads the page in headless Chrome over the DevTools protocol. It dismisses on-load overlays the way a visitor would: cookie banners, region and language switchers, newsletter and app modals. Whatever cannot be closed is hidden, together with its backdrop and scroll lock. This happens after load, again right before the walk, and in the live-shot tab. A fixed dialog that still gets through is left out of the snapshot, so a recreation never opens with a modal. It walks the DOM with the shared in-page script, opens the navigation menu and its drill-down levels, opens widgets that change in place, embeds images at display size and webfonts, and finally takes the live reference shots in a second tab of the same browser. In a third tab it takes the page's layout facts (no screenshots) at every width of the responsive sweep's grid, resizing the page in place as a visitor resizes a window. Each variant is also walked once in a viewport 200 px taller: boxes whose height follows the viewport's (a `100vh` stage, a `min-height: 50vh` hero) grow there and are recorded (`vh`, `viewportProbe`). The device classes are captured at the same time, each in its own browser (`recreate.captureParallel`, default 3).
3. **scene** converts the snapshots into screens: breakpoint variants, menu overlays, fluid geometry between the measured widths, and the page's ordered **sections** (header, hero, bands, footer). The conversion is **flow first**: boxes the page lays out in flow stay in flow (columns with the page's margins, rows, wrapping flex rows rebuilt from the page's own gaps, grids, slide tracks), boxes are as tall as their content, single lines with room left on them wrap, and a box at its `max-width` fills its parent up to that cap. Only boxes the page positions itself stay positioned. A z-indexed box the capture moved to its stacking context for paint order goes back to its place in the flow when the page keeps it in flow (relative) and it stays inside its parent's box. A box sized by the viewport is written in `vh`: as tall as the viewport on a phone and on a tablet alike, whatever the captured device's height was. A box that clips a picture as wide as itself keeps its clip (the picture keeps its proportions as the width changes and can outgrow the box). A text with small boxes on its last line right after it (an info icon, a footnote button) is one block of inline content, so the boxes follow the text's end at every width.
4. **build** writes the whole `out/static/index.html` at once (and keeps the stylesheet it wrote as `build/styles.base.css`), then shoots it once per width and compares every section's band with the live band. Every value between measured widths is continuous: a constant, a line, or a line with at most two turns, never a step or a value that only holds at one width. With `gates.fittedSections` above 0, a section whose band misses the live page may keep its fitted geometry instead (see below). With `--repair`, sections below their threshold, or whose layout breaks between the captured widths, get up to two repair passes by the configured model (see [Repairs](#repairs)).
5. **measure** compares the output with the live page at every captured width, checks it at about 60 more widths between and beyond them (the responsive gate), lints its stylesheet (the flow gate), and writes the compare page. On screens wider than the widest measurement, a variant measured across its range keeps following the page's own lines (a centred column keeps centring, a full-bleed band keeps spanning the window); the responsive gate checks this at 2560 px. A page with no measured widths keeps its layout, centred. The compare page shows a width wider than the window scaled down to fit.
6. **components / system / convert / ds-export** run only for project and design-system outputs. They extract component sets, merge twins, name the sets (with the model, validated, with a deterministic fallback), lint them, complete the design system, and run the emitters.

## Gates

| Gate           | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pixel          | ≤ 1 % of pixels differ per width, after a 1 px shift tolerance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| text           | no visible string is missing or extra (content the live page changed since the capture counts as drift, not as an error)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| layout         | no horizontal scroll, and page height within 3 % of the live page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| interactions   | menu, drill-down, slider arrows and pinned header work wherever the live page has them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| responsive     | at about 60 widths between and beyond the captures: every 24 px below 1024 px and every 48 px above, up to the widest measurement, and 2560 px; both sides of every variant boundary; and 6 widths that change with every measurement of a run. At each: no content over other content (text over text, over an image, under a control), no text cut off by its box, no text outside the screen and no horizontal scroll that the live page does not have at that width (compared by what overlaps, not by how many), and the page height within 5 % of the live page's. Where the live page was screenshotted (320 px, the middle of every gap, 1920 and 2560 px), pixels within 5 % too. A width outside every variant's measured range reports height and pixel differences as notes: the site has a layout there that was not captured |
| flow           | the output's CSS holds at every width: no media query around one width, no value that jumps between widths, no `zoom`, and no text placed by coordinates that the live page keeps in its flow. CSS added after the build (a repair, the agent's patch) also may not position boxes, use negative margins or `translate` to place them, fix a height on anything but an image or video, use `!important` or leave its section's scope. Sections kept at their fitted geometry are listed and counted against `gates.fittedSections`                                                                                                                                                                                                                                                                                                         |
| components     | no twins, no numbered names or props, naming complete, sets within the page budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| build:<target> | `npm run build` exits 0 (only with `--build`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

A run with a failing gate ends as `failed` and says which gate failed. The thresholds are configurable (see below).

## The run folder

```
.harness/recreate/<run-id>/          (added to .git/info/exclude)
  manifest.json                      request, consent, stages (status, time, skipped parts), outputs, gates
  capture/<width>.snapshot.json      one per variant; capture/live/<width>.png + .json (texts, overflow, layout facts)
                                     capture/live/<width>.json alone: layout facts at a sweep width (no screenshot)
  scene/screens.json · sections.json · fonts.json · page.json
  scene/screens.fitted.json          the fitted conversion (only with gates.fittedSections > 0)
  build/styles.base.css              the stylesheet as the build wrote it (what is added later is linted on its own)
  components/sets.json · naming.json · lint.json · screens.json
  design-system/system.json
  out/static/ · out/react-vite/ · out/ds-<fw>/ · out/tokens/
  measure/<target>/<width>/{live,out,diff}.png · measure/<target>/report.json (sweep, sweepPlan, flow)
  measure/<target>/sweep/<width>.png  the output at the screenshotted sweep widths and the worst failing ones
  out/static/fitted.json             sections kept at their fitted geometry, if any
  compare/index.html                 side by side, swipe, overlay, difference, the live output in an iframe; a strip
                                     with every sweep width (issues on hover) and a slider that sets the output's width
```

Every output carries `credits.json` and `RECREATION.md` with the source, the capture time, the asset and font policy, and the rights notice.

## Mirror mode

In the web and desktop apps this is what **Recreate 1:1**, `/recreate` and a chat request for an exact copy run; **Rebuild as code** runs the measured rebuild described above. On the command line it is `cdr recreate <url> --mirror`, and agents use the `recreate_mirror` tool. The rebuild measures the live DOM and rebuilds it as code you own. Mirror mode copies the page's own markup, stylesheets, scripts, images and fonts and re-serves them from a generated Next.js app, then holds that app to a strict verify suite. It gets closer to the original because it is the original's files, and for the same reason the output is not code you own: it is a verbatim copy.

```
consent → crawl → ccm → design → generate → appbuild → serve → verify → fix → reverify → report
```

- **crawl** loads the page in Playwright Chromium at 375, 768 and 1440 px with its timers, carousels and media held still, scrolls it so lazy content loads, writes CSS-in-JS into the DOM, and downloads same-origin assets, including CSS `url()`s and srcset candidates. Trackers are blocked. If scripts of the page failed to load, the gate `crawl.pagesComplete` stops the run: a capture that never finished rendering is no baseline.
- **ccm, design, generate** split the page into sections, port its styles and scripts, and write the app to `out/mirror`. Sites built on web components or their own JavaScript are re-served as static islands: the original head and body with their scripts in order. Client-rendered Next.js sources use the rendered DOM. Third-party images are served from local copies; scripts and links keep their hosts.
- **appbuild, serve** install the app's dependencies (once per dependency set, kept in `.harness/recreate/.mirror-deps`; this needs the network), run `next build` and start the app on a free local port, without your provider keys in its environment.
- **verify** captures both sides with the same routine and judges them, using a baseline of the live page taken with that routine right after the crawl. A live page that changed since the crawl is reported as `SOURCE_DRIFT` and the copy is judged against the crawl-time capture instead, so a changed news ticker is not counted as a defect. Every failing shot gets a text dossier under `verify/diagnosis/`.
- **fix** tries rule-based patches first and the configured model last (the `repair` role; budget `recreate.mirror.fix.budgetUsd`, default 3.9 USD). A patch is kept only if the metric improves and no gate regresses. Without a model, only the rules run. `--no-fix` skips it.

| Gate                                            | Passes when                                                |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `crawl.pagesComplete`, `crawl.pocUrls`          | the page rendered completely and was captured              |
| `ccm.valid`                                     | the content model is valid                                 |
| `visual.parity`, `visual.bbox`, `visual.height` | ≥ 0.97 of pixels match per viewport; key boxes within 4 px |
| `fidelity.similarity`, `content.*`              | text similarity ≥ 0.99, no missing content                 |
| `links.*`, `redirects.failed`, `media.missing`  | no broken links, failing redirects or missing media        |
| `playback.blank`                                | no video player is blank when motion is on                 |

`seo.*`, `a11y.*`, `performance.*` and `cleanliness.*` are reported as notes and do not fail a run. A mirror holds raw HTML by design.

The preview pane, the compare page and the snapshot's own address opened in a browser tab show the run's real app: `cdr serve` starts it on a loopback port of its own when the page is opened (at most three at a time, without your provider keys in its environment), so the page's scripts, menus and sliders behave as in the app that was verified. Files the crawl never saw are fetched from the original site at that moment. When the app cannot be started, or the server is reached from another machine, the pane falls back to `out/preview/index.html`, a static snapshot in which code the page loads at runtime does not run. Run the app yourself with `CCM_DIR=<run>/ccm npx next start` in `out/mirror`. Resume with `--from <stage> --run <id>`. `--pages N` also crawls links the page leads to, up to N pages (default 1).

A site that answers automated requests with a bot-management block is reported and the run stops: mirror mode does not get past such blocks, and it does not read blocked sites from web archives. `robots.txt`, private-address and consent rules are the same as in the default mode, and they apply to every request of the crawl and of verify. `recreate.assets: "none"` cannot be combined with mirror mode.

## Replica

The `replica-nextjs` target (used by `cdr autopilot`) rebuilds the page in Next.js from its design system. Like `react-vite`, it runs the `components` and `system` stages; it also keeps the page's h1 to h3, which the scene otherwise merges into plain text, so the verify suite can compare them with the original's.

- Each section is a composite from `@<prefix>-ds/site`, in the page's own flow-first layout with its measured fluid geometry. The app is written to `out/replica`, built with `next build` and started on a free port without your provider keys in its environment.
- **Swap contract.** A set that maps to a primitive (`Button`, `Link`, `Tag`) is first rendered by the primitive of `@<prefix>-ds/react`, with the page's values set through the primitive's own tokens. A swap stays only while every section it appears in keeps parity of at least 0.97 at every viewport. Otherwise that set keeps its measured markup and the swap is recorded as `DS_SWAP_REVERTED` with its diff crop.
- **DS coverage** is the share of painted boxes rendered by a primitive or by a repeated component of the site package, at the viewport where it is lowest. Boxes that belong only to a one-off section composite do not count, because every box on the page sits inside one. `final/coverage.json` also gives the primitive-only share and the share with section composites included.
- **Final check.** `verifyStep` runs against the replica with the snapshot as the old side, at the same thresholds as the mirror, followed by this pipeline's responsive sweep and flow lint. The flow lint reads the composites' CSS as emitted, before their values became tokens. Results are in `final/verify/*.json`, `final/sweep.json`, `final/flow.json`, `final/coverage.json` and `final/compare/index.html`.

## In a chat

When you ask for an exact copy of a URL, the agent loads the `recreate-url` skill and uses the tools `recreate_capture`, `recreate_build`, `recreate_measure`, `recreate_section`, `recreate_components` and `recreate_convert`. The progress appears as `recreate.*` events: stage rows, section rows, numbers per width, and a compare card. While the page is probed and captured, the Preview tab shows the live page: its first screen right after load, then each full-page live shot as it is taken (`recreate.shot`). Once the build starts, the coded page replaces the screenshot section by section from the top: each `recreate.section` carries its band on the live page per width (`bands`), and the Preview tab moves the boundary between the coded page (above) and the screenshot (below) down one section at a time, then hands over to the regular preview. The capture ignores the page's own Content-Security-Policy (the request guard still decides what loads), so a site whose CSP refuses its own stylesheets (`www.` page, assets on the bare domain) is captured styled. Videos and canvases on the live page (a hero animation never shows the same frame twice) are painted out of both images in every pixel comparison: the gate, the section checks and the responsive sweep. A run whose stages all finished but whose gates miss shows “Gates missed” in amber, and the chat job counts as done: the page is there to look at or repair. `cdr mcp recreate` exposes the same stages to other MCP clients.

## Repairs

A repair, by the model in the build stage or by the agent in a chat, has to fix the layout rule the live page uses (a wrapping row, a grid with `minmax()`, `clamp()` type, a box as tall as its text), not the numbers at the captured widths:

- A section is sent to repair when its pixels at the captured widths miss its threshold (`reason: "pixel"`), when its layout breaks between them (`responsive`: overlaps or cut text the live page does not have), or when it places text by coordinates that the live page keeps in flow (`flow`).
- A proposed patch is linted before it is written. A patch that positions boxes, pins a value or a media query to one width, fixes a text's height, uses `!important`, `zoom`, style attributes or selectors outside its section is not written, and the reasons go to the next attempt.
- After each pass the output is checked again at the captured widths and at the sweep widths the live page has facts for. A patch stays only if the section's pixels improved (for a pixel repair), it added no overlap or cut text at any width, and it did not move the page's height further from the live page's. Otherwise that section's patch is undone (`recreate.section` reports `reverted`).
- The agent's own patches (`patch_file`) are held to the same rules by the responsive and flow gates. `recreate_section` lists what the last measurement found for the section between the captured widths and in its CSS, and `recreate_measure` adds a crop of the worst failing width between them.

## Fitted sections

`gates.fittedSections` (default 0) lets the build keep that many sections at their fitted geometry: the conversion that places every box where it was measured. Only sections whose flow version misses their band are tried, worst first, and a section is kept fitted only when that brings it closer to the live page. A section holding a menu or a widget control always stays in flow. Kept sections are listed in `out/static/fitted.json`; the flow gate leaves their CSS out and fails when there are more of them than allowed. Fitted sections follow their measured geometry between the captured widths, but they do not reflow.

## Configuration

```jsonc
{
  "recreate": {
    "enabled": true, // false hides the tools, the command and the UI entry points
    "assets": "run-dir", // run-dir (gitignored) | project (copied into outputs) | none (placeholders)
    "fonts": "embed", // embed (font files in the output, default) | reference (@font-face at the site; most sites block cross-origin fonts) | system (fallbacks)
    "respectRobots": true, // refuse URLs robots.txt disallows for every crawler
    "allowLocal": false, // allow localhost / private-network URLs (your own site)
    "captureParallel": 3, // device-class captures at once, each in its own browser
    "budgets": {
      "totalMs": 200000,
      "menuMs": 25000,
      "submenuMs": 45000,
      "submenus": 3,
      "regionMs": 70000,
      "altMs": 120000,
      "rasters": 80,
      "probeMs": 90000, // the live page's layout facts at the sweep widths
    },
    "gates": {
      "pixel": 0.01,
      "text": 0,
      "heightPct": 3,
      "responsivePixel": 0.05,
      "sweepHeightPct": 5, // page height at every sweep width, against the live page's
      "fittedSections": 0, // sections the build may keep at their fitted geometry (they do not reflow)
    },
    "capturePlan": "ranges", // ranges: one variant per layout range (every range measured) | devices: one per device class
    "models": { "naming": "planner", "vision": "executor", "repair": "executor" },
    "emitters": ["./tools/emit-vue.mjs"], // extra emitters (default export or `emitter`)
    "driver": "cdp", // cdp (local Chrome) | remote (a capture service at remoteUrl)
    "remoteUrl": "http://localhost:8790",
  },
}
```

Chrome is found the same way as for `check_preview`, and `HARNESS_CHROME` overrides it. Without a configured model, every deterministic stage still runs. In that case naming falls back to deterministic names and is reported as incomplete, there is no vision verdict, and nothing is repaired.

## Limits

- Glyph rendering differs slightly between the live page and the output, mostly in text advances. That is most of the residual pixel difference on text-heavy bands.
- Hover, focus and active states are captured only from stylesheet rules.
- Live content (news, tickers) drifts between capture and measurement. Text drift is detected; pixel bands with live content can be excluded from the gate.
- The capture skips what its budgets do not allow on heavy pages and records each skipped part in the manifest. `--from capture` re-runs it.
- Between two measured widths a value follows the simplest continuous line through its measurements. A value that turns between two measurements with only one measured width past the turn can be off between them (the extra walks 24 px inside each range's ends catch the common case of a turn close to a breakpoint).
- `transform: scale()` on a box is not reproduced: its children come out placed at their scaled positions, which the flow gate reports as text out of flow.
- `capturePlan: "devices"` measures only each device variant's own range: ranges between them (an auto-fit grid changing its column count, a container query) are not captured and are reported as notes.

## Development

- Fixture site: `packages/capture/test/sites/acme`. Recorded snapshots and live shots in `…/acme/recorded` let the scene, extract, codegen, measure and pipeline tests run without a browser. Tests that need Chrome skip when there is none.
- Evals: `cdr eval --suite recreate`. The fixture task serves the site locally.
- The in-page capture script and the interactions runtime are embedded as generated modules. Run `node scripts/recreate/embed.mjs` after changing `packages/capture/assets/*` or `packages/codegen/src/export/interactionsRuntime.ts` (a test checks both).
- To re-record the fixture after changing `test/sites/acme`, run a capture with `allowLocal` (see `packages/recreate/test/pipeline.test.ts` for the setup) and copy `capture/*.snapshot.json` and `capture/live/*` into `test/sites/acme/recorded/`.
- Tests that need no browser: scene, extract, codegen, measure and the pipeline with a fake driver. Tests that need Chrome: the capture driver, the layout probe, the end-to-end pipeline cases (including the acceptance test that checks the fixture sites every 24 px from 320 to 1920 px), `cdr recreate` in the CLI tests and the web e2e suite.
- More fixture sites: `fluid` (an auto-fit grid, `clamp()` type and spacing, a wrapping navigation, long unbreakable words, `aspect-ratio` media, text over a picture, a container query) and `acme-drift` (a section drawn with `transform: scale()`, for the repair eval). `packages/measure/test/sites/pinned` is a page fitted to the widths a gate checks.
- `node scripts/recreate/sweep.mjs` (after `pnpm build:packages`) loads a page at many widths and prints the layout facts per width against another page or a run's live facts: `--fixture` builds the acme fixture from its recordings and compares it with the fixture site, `--fixture --pipeline [--site fluid] [--capture 390,1440]` runs the whole pipeline on a fixture site, `--run <folder>` checks a run's output against the facts it captured.
