# Recreate a page 1:1

CDR can rebuild a live web page as code you own: measured from its real DOM, block by block, at every width, with its menus and sliders working, and compared with the live page afterwards.

This is **opt-in only**. A plain brief such as "example.com" still goes to the `web-app` skill, which designs an original page. A recreation starts only from `cdr recreate`, the web app's **Recreate 1:1** button or `/recreate`, or a chat message that asks for an exact copy of a URL ("recreate … 1:1", "clone this page", "pixel-perfect").

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

| Flag                        | Meaning                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--widths a,b,c`            | Capture widths. The widest one is also walked at 1920 px. The default is the page's own layout ranges (`@media`, `@container` and script switches), one variant per device class. If the probe fails, 390, 768 and 1440 are used.                             |
| `--to …`                    | Outputs: `static` (default), `react-vite` (`react` is accepted too), `ds-react`, `ds-lit`, `ds-angular`, `tokens`, `design-md`.                                                                                                                               |
| `--style`                   | Styling for `react-vite`: `tailwind`, `css-modules` or `vanilla`.                                                                                                                                                                                             |
| `--repair`                  | Lets the configured model repair sections below their threshold (opt-in: at most two passes, a few sections at a time, each re-scored). Without it the run makes no model call while building.                                                               |
| `--no-checks`               | Skips the section scores while building (one output shot per width). The final measurement still runs.                                                                                                                                                       |
| `--build`                   | Runs `npm install && npm run build` in converted projects as a gate. This needs the network.                                                                                                                                                                  |
| `--from <stage> --run <id>` | Resumes a run from a stage (`build`, `measure`, `components`, `convert` …). No URL is needed: the run's stored URL is used. Consent is kept. The run keeps its targets unless `--to` names others; a stage the targets skip resumes at the next one they run. |
| `--out <folder>`            | Copies the outputs into a folder of the project when done. It must be relative and stay inside the project (no `..`, no symlink out, not `.git`).                                                                                                             |
| `--yes`                     | Answers the consent prompt. The log still records `permission.resolved { auto: true }` and the consent as `by: "auto"`. A session that auto-approves permissions (`cdr run --yes`, `autoApprove.permissions`) records it the same way.                        |
| `--json`                    | Streams the events as JSONL for scripts.                                                                                                                                                                                                                      |

The command prints one line per stage and per section, the numbers per width, the gates, and the path of the compare page.

## What a run does

```
consent → probe → capture → scene → build → measure  [→ components → system → convert / ds-export]
```

1. **probe** finds the page's layout switches and plans one capture per device class (phone, tablet, desktop). Each capture also walks the page at the other widths in its layout range.
2. **capture** loads the page in headless Chrome over the DevTools protocol. It dismisses on-load overlays the way a visitor would: cookie banners, region and language switchers, newsletter and app modals. Whatever cannot be closed is hidden, together with its backdrop and scroll lock. This happens after load, again right before the walk, and in the live-shot tab. A fixed dialog that still gets through is left out of the snapshot, so a recreation never opens with a modal. It walks the DOM with the shared in-page script, opens the navigation menu and its drill-down levels, opens widgets that change in place, embeds images at display size and webfonts, and finally takes the live reference shots in a second tab of the same browser. The device classes are captured at the same time, each in its own browser (`recreate.captureParallel`, default 3).
3. **scene** converts the snapshots into screens: breakpoint variants, menu overlays, fluid geometry between the measured widths, and the page's ordered **sections** (header, hero, bands, footer).
4. **build** writes the whole `out/static/index.html` at once, then shoots it once per width and compares every section's band with the live band. With `--repair`, sections below their threshold get up to two repair passes by the configured model, which may only add CSS for that section or replace its markup between its markers, and never its copy or pictures.
5. **measure** compares the output with the live page at every captured width, checks the output at the sweep widths between and beyond them (the responsive gate), and writes the compare page. On screens wider than the widest measurement, the output keeps that measured layout, centred, instead of stretching into a guessed one.
6. **components / system / convert / ds-export** run only for project and design-system outputs. They extract component sets, merge twins, name the sets (with the model, validated, with a deterministic fallback), lint them, complete the design system, and run the emitters.

## Gates

| Gate           | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pixel          | ≤ 1 % of pixels differ per width, after a 1 px shift tolerance                                                                                                                                                                                                                                                                                                                                                                        |
| text           | no visible string is missing or extra (content the live page changed since the capture counts as drift, not as an error)                                                                                                                                                                                                                                                                                                              |
| layout         | no horizontal scroll, and page height within 3 % of the live page                                                                                                                                                                                                                                                                                                                                                                     |
| interactions   | menu, drill-down, slider arrows and pinned header work wherever the live page has them                                                                                                                                                                                                                                                                                                                                                |
| responsive     | at the widths between and beyond the captures (320 px, the middle of every gap, 1920 and 2560 px): no text overlapping other text and no text outside the screen (no more of either than the live page has), no horizontal scroll, and within 5 % of the live page wherever the output has measured geometry around that width. Elsewhere a large difference is reported as a note: the site has a layout there that was not captured |
| components     | no twins, no numbered names or props, naming complete, sets within the page budget                                                                                                                                                                                                                                                                                                                                                    |
| build:<target> | `npm run build` exits 0 (only with `--build`)                                                                                                                                                                                                                                                                                                                                                                                         |

A run with a failing gate ends as `failed` and says which gate failed. The thresholds are configurable (see below).

## The run folder

```
.harness/recreate/<run-id>/          (added to .git/info/exclude)
  manifest.json                      request, consent, stages (status, time, skipped parts), outputs, gates
  capture/<width>.snapshot.json      one per variant; capture/live/<width>.png + .json (texts, overflow)
  scene/screens.json · sections.json · fonts.json · page.json
  components/sets.json · naming.json · lint.json · screens.json
  design-system/system.json
  out/static/ · out/react-vite/ · out/ds-<fw>/ · out/tokens/
  measure/<target>/<width>/{live,out,diff}.png · measure/<target>/report.json
  compare/index.html                 side by side, swipe, overlay, difference, the live output in an iframe
```

Every output carries `credits.json` and `RECREATION.md` with the source, the capture time, the asset and font policy, and the rights notice.

## In a chat

When you ask for an exact copy of a URL, the agent loads the `recreate-url` skill and uses the tools `recreate_capture`, `recreate_build`, `recreate_measure`, `recreate_section`, `recreate_components` and `recreate_convert`. The progress appears as `recreate.*` events: stage rows, section rows, numbers per width, and a compare card. While the page is probed and captured, the Preview tab shows the live page: its first screen right after load, then each full-page live shot as it is taken (`recreate.shot`). Once the build starts, the coded page replaces the screenshot section by section from the top: each `recreate.section` carries its band on the live page per width (`bands`), and the Preview tab moves the boundary between the coded page (above) and the screenshot (below) down one section at a time, then hands over to the regular preview. The capture ignores the page's own Content-Security-Policy (the request guard still decides what loads), so a site whose CSP refuses its own stylesheets (`www.` page, assets on the bare domain) is captured styled. Videos and canvases on the live page (a hero animation never shows the same frame twice) are painted out of both images in every pixel comparison: the gate, the section checks and the responsive sweep. A run whose stages all finished but whose gates miss shows “Gates missed” in amber, and the chat job counts as done: the page is there to look at or repair. `cdr mcp recreate` exposes the same stages to other MCP clients.

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
    },
    "gates": { "pixel": 0.01, "text": 0, "heightPct": 3, "responsivePixel": 0.05 },
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

## Development

- Fixture site: `packages/capture/test/sites/acme`. Recorded snapshots and live shots in `…/acme/recorded` let the scene, extract, codegen, measure and pipeline tests run without a browser. Tests that need Chrome skip when there is none.
- Evals: `cdr eval --suite recreate`. The fixture task serves the site locally.
- The in-page capture script and the interactions runtime are embedded as generated modules. Run `node scripts/recreate/embed.mjs` after changing `packages/capture/assets/*` or `packages/codegen/src/export/interactionsRuntime.ts` (a test checks both).
- To re-record the fixture after changing `test/sites/acme`, run a capture with `allowLocal` (see `packages/recreate/test/pipeline.test.ts` for the setup) and copy `capture/*.snapshot.json` and `capture/live/*` into `test/sites/acme/recorded/`.
- Tests that need no browser: scene, extract, codegen, measure and the pipeline with a fake driver. Tests that need Chrome: the capture driver, the end-to-end pipeline case, `cdr recreate` in the CLI tests and the web e2e suite.
