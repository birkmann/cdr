# Port the cms-migration 1:1 URL recreation pipeline into CDR

Status: implemented · 2026-11-08 (see §11 for what differs from this plan)
Source repo: `~/repos/cms-migration--pipeline` (branch `use-api--with-frontend`, referenced below as `cms:`)
Target repo: this one (`cdr`).

## 1. Goal

Bring the 1:1 URL recreation pipeline from the cms-migration repo — the one whose last
changes produced the very good results (bmw.de, ibm.com, bvg.de, vw.de at visual parity
0.97–1.0) — into CDR, behaviour-identical, integrated with CDR's session/event/tool
architecture. The existing `cdr recreate` pipeline stays; the ported pipeline becomes a
second, higher-fidelity mode.

## 2. The two pipelines are not variants of each other

Both are deterministic and "LLM-light", but they get to 1:1 by opposite routes:

| | CDR `recreate` (today) | cms-migration pipeline |
|---|---|---|
| Core idea | Measure the live DOM, **rebuild from scratch** (flow-first scene → static emitter). Output is clean code you own. | **Capture the original markup, CSS and JS and re-serve it** ("static islands" inside a generated Next.js app, or mined React components for Next.js sources). |
| Browser | Headless Chrome over CDP (`packages/capture`) | Playwright Chromium (`cms:packages/adapters/source-html/src/crawl.ts`) |
| Capture unit | Painted boxes, computed styles, text lines, layout intent per width | Rendered + raw HTML, all same-origin assets, network log, screenshots per viewport, redirect chains |
| Generation | Deterministic emitters from the scene; model only for naming/vision/opt-in repair | Deterministic Next.js generator (`cms:packages/generators/nextjs-contentful`); model only in autofix with deterministic fallbacks |
| Fidelity ceiling | Limited by reconstruction (glyph advances, `transform: scale()`, un-measured ranges) | Near-pixel-perfect, because it *is* the original CSS/JS; limited by third-party/network drift |
| Verify | pixel/text/layout/interactions/responsive/flow gates at many widths | content · fidelity · cleanliness · links · redirects · media · **playback** · seo · **visual parity ≥ 0.97** · a11y · performance, with **source-drift separation** |
| Fix loop | `--repair` (section CSS patches, lint-gated, revert on regression) | `autofix` loop: rule handlers first, then LLM; accept only if primary metric improves and no gate flips; else rollback |
| Output ownership | Code you own, assets per policy | A mirror of the original (raw HTML share = 1 accepted) — strictly a *copy* |

The cms pipeline's results are good **because** it re-serves the original. That cannot be
"merged into" the scene/emitter path; it has to come in as its own output mode.

## 3. What exactly made the cms results very good (the "last changes")

These are the changes to port faithfully, with their commits:

1. **Generic-section root fix + third-party image localization** — `cms:f87fb40`.
   `genericSectionRoot(main)` skips single wrappers below `<main>` (AEM `aem-Grid`) so grid
   wrappers stay in the page template; captured third-party resources are served from
   `public/__ext/<host>/…` and images/srcset/inline data rewritten to them at render time
   (scripts and links keep their hosts). Took bmw-s2 parity from 0.59/0.49/0.64 to
   0.985/0.972/0.933 (desktop/tablet/mobile).
2. **Source drift vs migration defects in verify** — `cms:a32ef39`.
   When the live original drifted since the crawl (`sourceDrifted`: live-vs-capture parity
   < 0.999), the new side is judged against the **crawl-time capture** instead, and a
   `SOURCE_DRIFT` issue is reported instead of a false failure. Same idea in fidelity
   (text) and links checks.
3. **Client-side rendered content** — `cms:a32ef39`.
   `preferRenderedContent()` (`cms:packages/adapters/source-html/src/content-source.ts`)
   picks the rendered DOM for client-rendered Next.js sources, used identically by the CCM
   build, text coverage and verify's old side, so all three see the same content.
4. **Crawl completeness gate** — `cms:a9ccdaf`.
   `pageCompleteness()` counts failed same-origin non-tracker scripts and client-render
   fallback signals; ≥3 failed scripts (or ≥1 + a signal) fails gate `crawl.pagesComplete`
   before anything downstream runs on a broken capture.
5. **Site-root redirect handling** — `cms:a9ccdaf` + `cms:cbfbbf4`.
   `/` is fetched, its chain collapsed to one hop to a crawled page; non-literal redirect
   destinations Next can't parse are dropped (`REDIRECT_INVALID_DESTINATION`).
6. **Blank-player detection and fallback** — `cms:25da6c2`.
   A `playback` verify check loads each URL with motion **on**; a player in error state is
   `PLAYER_BLANK` (gate fails) unless the injected `player-fallback.ts` has reset it to
   thumbnail/poster (`PLAYER_PLAYBACK_RESTRICTED` task).
7. **Faithful capture discipline** (base of everything): `STILL_TIMERS_JS` (timers ≥ 2.5 s
   never fire, media paused), `MATERIALIZE_CSSOM_JS` (CSS-in-JS written into the DOM),
   half-viewport settle scroll for lazy loaders, reduced motion, tracker blocklist,
   same-origin asset download incl. CSS `url()`s and `mediaRefsOf()` (srcset, `data-src`,
   icons, PDFs), quote-aware `headFromHtml`.
8. **Gate-verified autofix** (`cms:packages/autofix/src/loop.ts`): rule candidates first
   (lazy-src, extra stylesheet, site.css, mask-with-instability-proof), LLM last; a patch
   is kept only if the primary metric improves and no gate regresses; patches may only
   touch `design/overrides/**`, never pipeline code.
9. **Diagnosis dossiers** (`cms:packages/verify/src/diagnose.ts`): every failing shot gets
   a text-only dossier (first divergence, style/attribute diffs, missing stylesheets,
   new-side-only console errors, instability self-test → DYNAMIC) classified into
   MARKUP / CSS_MISSING / CSS_ORDER / ASSET / SCRIPT / CONTENT / DYNAMIC.

Quality bar achieved there (from `cms:docs/FINAL_CHECK_PLAN.md` §9 and per-site docs):
volkswagen-s2 parity 0.9986 (reference), bvg-s3 and ibm-s2 parity 1.0 and fidelity 1.0,
bmw-s3 mobile 0.9894 / tablet+desktop 1.0. Reruns with the LLM cache are bit-stable.

## 4. Decisions (recommended answers)

1. **New mode, not a replacement.** Ship it as `cdr recreate <url> --mode mirror` (working
   name; alternatives: `cdr mirror`). The existing measurement-based pipeline remains
   `--mode rebuild` (default unchanged). Rationale: the mirror output is a verbatim copy —
   great for evaluation/parity, but it is not "code you own", which is the existing
   pipeline's promise. The consent prompt must say which mode runs and what is copied.
2. **Vendor the cms packages nearly verbatim, keep Playwright.** The validated behaviour
   lives in that code; re-implementing it on CDR's CDP driver would forfeit "exactly the
   same" and re-open every bug it already fixed. Playwright becomes a dependency of the new
   packages only (the CDP capture stack is untouched). Later unification of the two browser
   stacks is explicitly out of scope.
3. **Drop the CMS half.** We port crawl → CCM(sectionGeneric) → design → generate → verify
   → autofix with `dataSource: ccm` on disk. Contentful loading, Drupal adapters, mapping
   review, Studio, Wayback/HAR capture-replay are **not** ported in phase 1 (Wayback/HAR is
   a candidate for a later phase for bot-blocked sites).
4. **Replace the DeepSeek client with CDR's provider layer.** The cms `llm.ts` (provider
   chain, `llm-cache/<sha256>.json`, budget, never-send-body-text) is swapped for CDR's
   configured models via the host callbacks, keeping: deterministic fallback for every
   call site, response caching in the run dir, and the `sendContent: false` default. The
   pipeline must stay fully functional with no model configured (it already is: in the
   final check "DeepSeek contributed almost nothing", total spend ~$0.05).
5. **Output format: generated Next.js app** (`out/mirror/` scaffolded from the vendored
   template), same as cms. A static-export variant can come later; the verify suite runs
   against the served app exactly as in cms.

If any of these should go the other way (especially 1 and 5), say so before phase 2 starts.

## 5. Package and file map (cms → cdr)

New workspace packages under `packages/mirror-*`, adapted to CDR conventions
(ESM/NodeNext, tests in `packages/*/test/*.test.ts` importing by name, tools return
`{ ok, output }`, paths confined with `resolveInProject`, secrets through `redactValue`):

| cms source | cdr destination | Notes |
|---|---|---|
| `packages/core/src/contracts.ts` (SiteConfig, viewports, thresholds), `validate.ts`, report/IdMap helpers | `packages/mirror-core` | SiteConfig shrinks: no Drupal/Contentful/locale-mapping fields. Thresholds land in `RecreateConfig.mirror` (protocol). |
| `packages/adapters/source-html/src/{crawl,browser,interactions,content-source,completeness,page,infer,profiles,to-ccm}.ts` | `packages/mirror-capture` | The heart: Playwright crawl, STILL_TIMERS/MATERIALIZE_CSSOM/settle, asset download, network log, completeness gate, redirect chains, sectionGeneric CCM build. |
| `packages/design/src/{mine,styles,scripts,tokens,assets,overrides}.ts` | `packages/mirror-design` | `genericSectionRoot`, `portStyles`, `portScripts` (tracker stub, kept `onload` attrs), render-mode decision (static / web-components / jsApp / react). |
| `packages/generators/nextjs-contentful/src/{generate,static,seo,compile}.ts` + `templates/nextjs-contentful/**` | `packages/mirror-generate` + `packages/mirror-generate/templates/` | Rename to drop "contentful"; `dataSource: ccm` only. Keep static islands (`staticDocument`, `localizeThirdParty`, `contentTypeHeaders`), `buildRedirects`, `player-fallback.ts`, `NavInteractions`. |
| `packages/verify/src/**` (index, capture, context, diagnose, checks/{visual,richtext,links,redirects,media,playback,seo,a11y,content,performance}) | `packages/mirror-verify` | Port whole. Keep `CAPTURE_SETTINGS`, `judgeDrifted`, `SOURCE_DRIFT` semantics, pixelmatch parity, bbox compare, dossiers. Thresholds stay 0.97 / 4 px / 0.99 — the cms final-check rule "never lower a threshold to pass" becomes a comment at the definition. |
| `packages/autofix/src/{loop,handlers/*}.ts` + `prompts/*.md` | `packages/mirror-fix` | Keep rule-first order and accept/rollback contract. `parity-fix` LLM lane goes through the host's `repair` model role. Patches confined to the run's `design/overrides/**`. |
| `packages/cli/src/fresh.ts` (`freshRun`, `FRESH_STEPS`) | `packages/mirror/src/pipeline.ts` | Becomes the mirror orchestrator, restructured like `packages/recreate/src/pipeline.ts`: a `Runner` with stages, manifest, `host.progress` events. |
| `fixtures/` (seed, serve.ts) | `packages/mirror/test/sites/` | Trim to the HTML-crawl fixture; serve locally in tests (pattern from `packages/recreate/test/pipeline.test.ts`). |

Not ported: `source-drupal`, `target-contentful`, `source-capture` (Wayback/HAR/replay —
phase 6 candidate), `studio`, `transforms` beyond what `to-ccm` needs, `compare-ui` (CDR
has `compare/index.html` + the web Preview; we generate the cms-style side-by-side data
into the existing compare page instead).

## 6. Pipeline shape inside CDR

Stage order for `--mode mirror` (mirrors `FRESH_STEPS`, expressed as CDR stages):

```
consent → crawl → ccm → design → generate → appbuild → serve → verify → fix → verify → report
```

- **consent**: same high-risk `permission.request` flow as today (`core/src/recreate/host.ts`),
  with mode-specific wording: "copies the page's markup, stylesheets, scripts, images and
  fonts into the run folder and the generated app".
- **Run folder**: `.harness/recreate/<runId>/` with `mode: "mirror"` in the manifest; new
  subdirs `crawl/` (raw+rendered html, assets, network log, screenshots), `ccm/`,
  `design/`, `verify/` (reports + dossiers), `out/mirror/` (the app). Gitignored as today.
- **serve/appbuild**: `npm install && next build && next start` on an ephemeral port via
  the existing `host.runBuilds` machinery; needs network for install (same caveat as
  `--build` today). The verify stage targets that port.
- **fix**: the autofix loop, bounded by iterations/patience/budget from config; off by
  default like `--repair`? **No** — in cms it is part of the standard run and is what
  clears the last gates; default it on, with `--no-fix` to skip and no model → rule
  handlers only.
- **Resume**: `--from <stage> --run <id>` works the same as rebuild mode.

### Events / protocol (AGENTS.md: every step is an event)

Reuse the `recreate.*` family — same cards, same CLI rendering, minimal new surface:

- `recreate.started` gains `mode: "rebuild" | "mirror"`.
- `recreate.stage` reused with the new stage names.
- New `recreate.verify` event: per check `{ check, gate, pass, value, threshold, issues }`
  (rendered like gate rows today; `SOURCE_DRIFT` shown as info, not failure).
- New `recreate.fix` event: `{ handler, target, accepted, before, after }` for the autofix
  loop (accepted and rolled-back patches both visible).
- `recreate.measured` reused for the final verify summary + compare path, so the existing
  compare card works unchanged.

Checklist per AGENTS.md: add to `EventBody` in `packages/protocol`, handle in
`reduceSession` (`packages/client`) and the CLI `Renderer`, regenerate schemas
(`pnpm --filter @harness/protocol schema`).

### Config

```jsonc
"recreate": {
  // existing keys unchanged …
  "mirror": {
    "viewports": [{ "width": 375, "height": 812 }, …],   // default: cms DEFAULT_VIEWPORTS
    "maxPages": 1,            // single-URL by default; >1 crawls followed links like cms
    "gates": { "parity": 0.97, "bboxPx": 4, "textSimilarity": 0.99 },
    "fix": { "enabled": true, "maxIterations": 3, "budgetUsd": 1 },
    "trackers": "default"     // the TRACKER_URL / TRACKER_HOSTS lists, extendable
  }
}
```

Model roles: reuse `recreate.models` (`repair` role drives parity-fix; `naming` unused in
mirror mode). Robots/SSRF/local-URL policy: the mirror crawl goes through the same
`validateUrl` / `checkRobots` guards as the CDP capture (port the guard calls into the
crawl's fetch + Playwright routing).

### Entry points

- CLI: `cdr recreate <url> --mode mirror` (+ `--no-fix`, `--pages N`).
- Chat: one new tool `recreate_mirror` (self-gated high-risk like `recreate_capture`,
  returns `{ok, output}`), running the whole chain; section-level agent repair does not
  apply to mirror output (patches go through the autofix contract instead).
- Server: `parseRecreateRequest` accepts `mode`.
- MCP: expose under `cdr mcp recreate` with explicit `consent: true` as today.

## 7. Verify suite scope in phase 1

Port all checks but gate initially on the ones the cms final check gated on:
`crawl.pagesComplete`, `ccm.valid`, `content`, `fidelity` (with SOURCE_DRIFT pass-through),
`links`, `redirects`, `media`, `playback.blank`, `visual.parity` / `bbox` / `height`.
`seo`, `a11y`, `performance` run and report but start as warnings (CDR has no SEO mapping
step; their cms gate semantics depend on it). Dossiers (`diagnose.ts`) are ported in phase
1 because the autofix loop and the human-readable report depend on them.

## 8. Phases

Each phase ends green on `pnpm build && pnpm test && pnpm lint`.

1. **Vendor + de-CMS (packages compile, unit tests pass).**
   Create the five `mirror-*` packages, strip Drupal/Contentful/locale machinery, swap the
   LLM client for a host-callback shim, carry over the cms unit tests that still apply
   (completeness, content-source, generator, verify incl. the a32ef39/25da6c2 regression
   tests, generic-sites). No CDR integration yet. ~Largest phase; mostly mechanical.
2. **Orchestrator + protocol.**
   `packages/mirror/src/pipeline.ts` runner, manifest `mode`, events, reducer, Renderer,
   schemas regenerated. `cdr recreate --mode mirror` works end to end against the local
   fixture with no model.
3. **Verify + compare integration.**
   Verify stage against the served app; results into `recreate.verify` /
   `recreate.measured`; dossier links in the report; compare page fed with crawl vs app
   screenshots.
4. **Autofix loop.**
   Rule handlers + model lane through host roles, accept/rollback, `recreate.fix` events,
   budget handling. Fixture negative-control test (injected letter-spacing must drop
   parity below gate and be caught — cms had parity 0.82 for this).
5. **Chat tool, web UI, docs.**
   `recreate_mirror` tool + consent wording, mode in the web Recreate card, `docs/recreate.md`
   section "Mirror mode" + this plan updated to "implemented", eval task
   `evals/tasks/3x-mirror-fixture.json` using the `recreateGate` pattern.
6. **(Optional, separate decision) Wayback/HAR capture-replay** for bot-blocked origins
   (`cms:packages/adapters/source-capture`), and cross-pollination into rebuild mode:
   the completeness gate, redirect-chain recording (rebuild mode records only `finalUrl`
   today), and the SOURCE_DRIFT idea for the pixel gate are all useful there too.

## 9. Testing

- All default tests: `MockProvider`, no network, no real model (AGENTS.md).
  The crawl/verify tests run against fixture sites served from `localhost` (Playwright is
  required for them the way Chrome is required for capture tests today — skip when absent).
- Carry over cms regression tests tied to the "last changes": completeness signals,
  `preferRenderedContent` bounds, `judgeDrifted`, quote-aware `headFromHtml`, playback
  probe, `REDIRECT_INVALID_DESTINATION`, third-party localization, generic-section root.
- Acceptance (manual, networked, not in CI): one from-blank run each on bvg.de, bmw.de
  (or their s-configs' URL lists) reaching the cms bar: parity ≥ 0.97 every viewport,
  fidelity ≥ 0.99, playback/links/redirect gates green, rerun with cached model answers
  gate-stable. The cms per-site expectations are in `cms:docs/final-check/*.md`.

## 10. Risks and open points

- **Rights and framing.** Mirror output embeds the original's markup, CSS, JS, images and
  fonts verbatim. The consent prompt, `RECREATION.md` and `credits.json` must state this;
  `recreate.assets: "none"` is incompatible with mirror mode (refuse with a clear message).
- **Two browser stacks** (CDP + Playwright) until/unless unified; adds install weight to
  the CLI. Mitigation: Playwright lives only in `mirror-*` packages and is lazy-loaded, so
  `cdr` without mirror use never needs it.
- **`next build`/`npm install` need the network** mid-pipeline — unlike rebuild mode's
  default path. Document it; cache `node_modules` per template version in the run parent.
- **Single-URL vs site.** cms was tuned on 1–10 URLs per site. CDR's recreate is page-
  scoped; mirror mode starts page-scoped (`maxPages: 1`) with link-follow opt-in.
- **Known cms caveats carry over** (`cms:docs/FINAL_CHECK_PLAN.md` §9.4): output is a
  high-fidelity mirror, not structured content; React `useId` makes builds not byte-
  identical; bbox is not checked on drifted shots; the Studio locale bug (not ported).
- **Naming** of the mode/flag (`mirror` vs `exact` vs `copy`) — pick before phase 2.

## 11. As built

Phases 1 to 5 are done. Phase 6 (Wayback/HAR capture-replay and carrying these ideas over to rebuild mode) was left as the separate decision it was planned to be, so sites that block automated requests stop with a clear message instead.

Where the implementation differs from the plan above:

- The CLI flag is `--mirror`, because `--mode` already selects the permission mode. The request field is `mode: "mirror"`.
- The vendored packages are not stripped of Drupal and Contentful code paths. Removing them would have changed files the good results depend on, for no behaviour gain: the pipeline only ever uses the HTML adapter and on-disk content.
- There is an eighth package, `mirror-transforms`, which `mirror-capture` and `mirror-verify` need.
- The fix loop keeps the source defaults (40 iterations, patience 5, 3.9 USD) rather than the `maxIterations: 3` sketched in §6.
- Tests built on real captures of third-party sites were not carried over; the remaining fixtures are synthetic or anonymised. The provider-chain tests went with the DeepSeek client they tested.
- Runtime additions to vendored code, all marked by `@harness/mirror-core`'s `runtime.ts`: the request guard for every crawl and verify request, a Chrome fallback when Playwright has no browser, and asset lookup next to the single-file bundle.
- The generated app's dependencies and Playwright are pinned to the exact versions of the source repo's reference runs.
- After the first real-site runs, two changes go beyond the source pipeline: mirror mode became what **Recreate 1:1** and chat requests run in the apps (the measured rebuild is **Rebuild as code**; `cdr recreate` on the command line keeps it as its default), and the crawl-time screenshots are retaken with verify's routine, because the crawl's own shots made a matching app fail as "source drift".
