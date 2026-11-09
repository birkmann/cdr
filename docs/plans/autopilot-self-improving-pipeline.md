# Autopilot: a self-improving URL → mirror → design system → 1:1 replica pipeline

Status: as built · 2026-11-09 (phases 2 and 5; see "As built" at the end, and [../autopilot.md](../autopilot.md) for how to run it)
Related: [one-to-one-recreation-port.md](one-to-one-recreation-port.md) (mirror mode, implemented), [design-system-pipeline.md](design-system-pipeline.md) (design systems, implemented), [../recreate.md](../recreate.md), [../design-system.md](../design-system.md), [../workflows.md](../workflows.md) (goals).

## 0. Why

Today the loop is a person: run a site, read the failing gates, guess the cause, patch a prompt or a stage, run again. That does not converge, because

- every run is against a **live, drifting, bot-managed site**, so the same code gives different results and a fix cannot be told from luck;
- the failures are **not collected anywhere**: each run's manifest, verify JSON, dossiers and crash bundles are read once and forgotten;
- a fix is **not guarded**: nothing stops the same class of bug from coming back on the next site;
- the chain the user actually wants, **URL → 1:1 mirror → design system in a framework → the page rebuilt from that design system and checked 1:1**, does not exist end to end. The pieces exist (`cdr recreate --mirror`, the `design_system` tool, the `ds-react` emitter, the verify suite), but no command runs them in sequence and no gate judges the last step.

Autopilot replaces the person in that loop with a deterministic runner, a findings registry, fixer agents that work in worktrees under acceptance criteria, and a repo-level accept/reject rule: **a fix is kept only if the whole matrix does not regress and its finding is gone, and it must leave a guard behind (a test or a lint) so the finding cannot reappear silently.** This is the gate-verified hill climbing of `@harness/mirror-fix` lifted from one run's output to the pipeline code itself.

Everything runs from the terminal. The end state is `pnpm autopilot loop --until-green` running unattended until bvg.de, vw.de, ibm.com and bmw.de all pass every hard gate of every stage, twice in a row, from blank.

## 1. Goal and definition of done

**Input:** a URL (and a framework choice, Next.js first). **Output per site:**

1. `out/mirror/` — a verbatim mirror as a Next.js app, verified against the original (exists today).
2. `out/design-system/` — a complete, buildable, tested design system: tokens with four themes, Lit web components, React (and optionally Angular) wrappers, docs. Brand read from the site. The React package is the one the replica uses.
3. `out/replica/` — the page **rebuilt in Next.js from the design system's components**, served locally and verified against the original with the same verify routine as the mirror.
4. Logs, screenshots (original · new · diff at every viewport), gate tables, error lists and a compare page for every stage.

**Done ("green") means**, for all four sites, from blank, in two consecutive cycles:

| Stage | Hard gates (must pass) | Advisory (reported, never fail) |
| --- | --- | --- |
| freeze | snapshot complete (`crawl.pagesComplete`), replay serves every captured asset, replay-vs-live parity recorded | drift since last snapshot |
| mirror | `crawl.pagesComplete`, `ccm.valid`, `visual.parity ≥ 0.97` per viewport, `visual.bbox ≤ 4 px`, `visual.height`, `fidelity.similarity ≥ 0.99`, `content.*`, `links.*`, `redirects.failed`, `media.missing`, `playback.blank`; `appbuild` exit 0 | `seo.*`, `a11y.*`, `performance.*`, `cleanliness.*` |
| design-system | `npm install`, `npm run build`, `npm test`, `npm run docs:build` exit 0; `tsc` clean; every contrast pair passes in every theme; no raw colour/size in component CSS; every element registered once with a React wrapper; docs render at phone and desktop in light and darkest with no console error or overflow | Angular build (only when requested) |
| replica | `next build` exit 0; `visual.parity ≥ 0.97` per viewport, `visual.bbox ≤ 4 px`, `visual.height`, `fidelity.similarity ≥ 0.99`, `content.*`, `links.*`, `media.missing`; responsive sweep (no overlaps, no cut text, no sideways scroll the original lacks, height within 5 %) and flow lint from the rebuild pipeline; **DS coverage ≥ target** (share of painted boxes rendered by design-system components, starts at 0.5, raised per §6.4) | a11y, performance |
| reproducibility | second run from the same snapshot with cached model answers gives identical gate results and byte-identical generated code except timestamps | — |
| pipeline health | no `PIPELINE_BUG` bundle, no stage over 1.5× its median wall clock, no unhandled error in any log | — |

Thresholds are never lowered and masks are never added to reach green (rule inherited from the source pipeline's final check; enforced by the policy check in §5.5).

## 2. The chain per site

```
url ─► freeze ─► mirror ─► design-system ─► replica ─► final ─► report
         │          │            │              │          │
      snapshot   out/mirror   out/design-   out/replica  verify suite +
      + replay   + verify     system        (Next.js)    sweep + flow +
      server     + autofix    (tokens, Lit,              DS coverage
                              React, docs)
```

### 2.1 freeze (new)

Captures the site **once** into a replayable snapshot and serves it locally for every later stage. Without it the loop cannot converge: the live page changes between runs (news tickers, consent banners, A/B variants), bmw.de sits behind Akamai Bot Manager and only worked in the source pipeline through a Wayback replay, and twenty runs a day against four companies' home pages is not acceptable.

- Reuses the mirror crawl (`@harness/mirror-capture`: Playwright, frozen timers, CSS-in-JS materialised, settle scroll, same-origin assets, network log, redirect chains) and adds a **replay server** that answers every captured request from disk, 204 for tracker URLs, 404 for anything never captured (logged as a finding, see §4.2). This is the `source-capture` replay of the source repo (`replay.ts`, `store.ts`, `rewrite.ts`, `har.ts`), which the port plan left as its phase 6; it is ported now.
- The snapshot is the **source of truth for the cycle**: mirror, brand reading, replica and verify all point at `http://127.0.0.1:<port>/…`. `recreate.allowLocal` is set for the site's project folder; `respectRobots` stays on for the one live crawl.
- `--refresh` recrawls; otherwise a snapshot is reused until it is older than `freeze.maxAgeDays` (default 7). Each snapshot records live-vs-snapshot parity at capture time, so later drift is measurable and never counted as a defect.
- For a site that blocks the crawl (bot-management page detected, as mirror mode already does), freeze falls back to a Wayback capture of the same URL when `freeze.wayback: true` for that site, and the report says so. This is the only networked workaround; it never bypasses logins, paywalls or captchas.

Layout: `.harness/autopilot/snapshots/<site>/<timestamp>/{crawl.json, raw/, assets/, screens/<viewport>.png, replay.json}`, `current` symlink.

### 2.2 mirror (exists)

`cdr recreate <replay-url> --mirror --yes --json`, the whole `consent → crawl → … → fix → reverify → report` chain, in the site's project folder. Nothing changes in the pipeline; autopilot only reads its outputs: `manifest.json` (stages, gates), `verify/*.json`, `verify/summary.json`, `verify/diagnosis/*`, `autofix/attempts/*`, `autofix/bugs/*`, `REPORT.md`.

### 2.3 design-system (exists as a tool; gets a CLI and a snapshot reader)

- New command `cdr design-system <url|--run id> --out <dir> --frameworks react[,lit,angular] --name --prefix --yes`, the CLI the design-system plan left for later. It calls the same `design_system` tool path, then runs `npm install`, `npm run build`, `npm test`, `npm run docs:build`, then `check_preview` on the docs at phone and desktop in `light` and `darkest`, and writes `design-system/report.json` (brand reading with provenance per value, contrast table, test results, preview reports).
- Brand reading from the **snapshot**, not the live page, through the same `brandFoundations` path, so the reading is reproducible.
- The **page's own component sets** are read too: the rebuild pipeline's `components` stage (`cdr recreate --from capture --to ds-react` on the snapshot) extracts the sets the page actually uses (header, hero, bands, cards, footer) and names them. These composites are emitted **into the same workspace** as a second package `@<prefix>-ds/site` whose styles consume the tokens of `@<prefix>-ds/tokens`. Primitives (button, link, input, tag, accordion, tabs, …) come from the Carbon-like set; composites from the page. The replica needs both.

### 2.4 replica (new)

Builds a Next.js app that renders the captured page from the design system:

1. Sections and layout come from the rebuild pipeline's scene (`scene/sections.json`, `screens.json`, flow-first conversion, fluid geometry between widths), which already exists for `--to react-vite`.
2. Each section is a composite component from `@<prefix>-ds/site`. Inside a composite, a box that maps to a design-system primitive (a button set with variants, a link, a tag, an input, an accordion) is rendered by the primitive from `@<prefix>-ds/react`, themed by the brand tokens.
3. Assets (images, fonts) follow `recreate.assets` (default: served from the run folder). Text is the page's text.
4. The app is written to `out/replica/` from a vendored template (as `out/mirror` is), built with `next build`, started on a free port without provider keys in its environment (same `AppServer` machinery as mirror mode).

**Swap contract.** Replacing a measured box with a generic primitive changes pixels. A primitive swap is kept only if the section's parity does not drop below its gate; otherwise the composite keeps the measured styles for that box and the swap is recorded as `DS_SWAP_REVERTED` with the diff crop. This is the accept/rollback rule of the repair stage applied to component substitution. **DS coverage** (§1) counts the boxes rendered by design-system components over all painted boxes; it is the metric the loop raises over time without ever trading the parity gate for it.

### 2.5 final

The verify suite of `@harness/mirror-verify` (`verifyStep`) runs against the replica app with the snapshot as the old side: same capture routine, same thresholds, drift-aware judgement. Then the rebuild pipeline's responsive sweep and flow lint run on the replica (it is code we own, so it must hold between the captured widths too). The outputs are `final/verify/*.json`, `final/sweep.json`, `final/flow.json`, `final/coverage.json`, screenshots, dossiers and a compare page (`compare/index.html` side by side, swipe, overlay, diff, per viewport, plus the sweep strip).

### 2.6 report

`REPORT.md` and `report.json` per site per cycle: stage table (status, wall clock, budget), gate table with values and thresholds, findings (§4) with links to dossiers and crops, model usage (calls, cached, cost) and the paths of every artefact. A cycle report aggregates the four sites and adds the diff to the previous cycle (gates that flipped, findings that appeared or disappeared, wall clock and cost deltas). A static `index.html` dashboard per cycle links everything; no server needed.

## 3. The autopilot loop

```
cycle N
  1 run      matrix: 4 sites × chain (2 in parallel; each site its own project folder and ports)
  2 inspect  deterministic collector → findings.json (new · recurring · regressed · fixed), FINDINGS.md
  3 triage   rank, group by signature, cap per cycle (default 5 groups)
  4 fix      one fixer goal per group, in its own worktree, acceptance criteria generated from the finding
  5 verify   fast lane: the affected stage from cached inputs on the fixture + the originating site
             slow lane: the full matrix on the candidate branch
             accept iff the finding's signature is gone and no gate anywhere went pass → fail; else discard
  6 rules    accepted fix → rule entry + guard (test or lint) merged with it; attempt recorded either way
  7 stop?    green for K cycles (default 2) → done · budget or max cycles → paused with report · else cycle N+1
```

### 3.1 State

`.harness/autopilot/` (gitignored) holds `state.json` (current cycle, status, budgets spent), `cycles/<N>/<site>/…` (every run's folder, logs, screenshots, reports), `cycles/<N>/findings.json`, `cycles/<N>/REPORT.md`, `cycles/<N>/index.html`, `snapshots/`, `goals/` (the fixer goals' ids and verdicts).

`autopilot/` (committed) holds `sites.yaml` (§3.2), `rules.json` and `rules/*.md` (§5), `baseline.json` (the last accepted matrix result: gates and values per site, so regressions are judged against an accepted state, not against the previous attempt).

### 3.2 Sites

```yaml
# autopilot/sites.yaml
sites:
  bvg:
    url: https://www.bvg.de/de
    framework: nextjs
    viewports: [mobile, tablet, desktop]        # 375×812, 768×1024, 1440×900 (mirror defaults)
  vw:
    url: https://www.vw.de/                      # follows the redirect; the final URL is recorded in the snapshot
    framework: nextjs
  ibm:
    url: https://www.ibm.com/us-en
    framework: nextjs
  bmw:
    url: https://www.bmw.de/de/index.html
    framework: nextjs
    freeze: { wayback: true }                    # Akamai Bot Manager blocks the crawl; the source pipeline used a Wayback replay
holdout:                                          # never shown to fixer agents; guards against overfitting (§7)
  - fixture: acme
  - fixture: fluid
  - url: https://www.deutschebahn.com/de
```

Each site runs in `.harness/autopilot/cycles/<N>/<site>/project/`, an empty project with its own `.harness/config.json` (`recreate.allowLocal: true`, the snapshot replay URL, model roles), so `.harness/recreate/<run>` folders never mix.

### 3.3 Commands

All of them are `cdr autopilot …` (so `pnpm autopilot …` after `pnpm build`). Exit code 0 only when the command's own verdict is good, so they compose in shell scripts and CI.

```bash
pnpm autopilot freeze  --sites bvg,vw,ibm,bmw [--refresh] [--wayback bmw]
pnpm autopilot run     --sites bvg,vw,ibm,bmw [--stages mirror,design-system,replica,final] [--parallel 2] [--cycle N]
pnpm autopilot inspect --cycle N                        # findings.json + FINDINGS.md; exit 1 when new findings exist
pnpm autopilot fix     --cycle N [--max 5] [--budget-usd 20] [--model …]
pnpm autopilot verify  --cycle N [--goal id]            # fast lane, then slow lane; accept or discard each candidate
pnpm autopilot loop    --sites … --max-cycles 20 --budget-usd 200 --until-green [--stable 2] [--fix-max 5]
pnpm autopilot status                                   # cycle, stage, per-site gates, spent budget, running goals
pnpm autopilot report  --cycle N [--open]               # REPORT.md + index.html
pnpm autopilot rules   [--check]                        # list rules; --check verifies every rule has a live guard
pnpm autopilot diff    --cycle N --against M            # gates and findings that changed between two cycles
pnpm autopilot clean   --keep 3                         # drop old cycle folders, keep snapshots and reports
```

`loop` is `freeze → run → inspect → fix → verify → rules`, repeated. Every step is resumable from `state.json`; Ctrl+C pauses between steps and `loop` continues where it stopped. `--dry-run` on `fix` makes the fixers propose without writing (as the autofix loop's dry run).

### 3.4 Logging and evidence

Per stage, per site, always:

- `log.txt` — stdout and stderr with timestamps; `events.jsonl` — the `--json` event stream of the harness run (`recreate.*`, tool calls, permission events).
- `screens/<viewport>/{original,new,diff}.png` — Playwright shots with the verify routine (frozen timers, pinned sticky elements); the mirror's and replica's `verify/` folders are linked, not copied.
- `errors.json` — every error-level issue of the stage with its code, step, message, file path of its dossier or bug bundle.
- `summary.json` — status, wall clock, gates, model usage.

Nothing is redacted away that the collector needs, and nothing secret goes in: run logs pass through `redactValue` as every event does, and the generated apps never see provider keys (`secretEnv`), as today.

## 4. Findings

### 4.1 Signature

A finding is anything that keeps a site from green or that a developer would want to know. Each one gets a **stable signature** so it can be recognised across sites and cycles:

```
<stage>:<code>[:<cause>][:<normalised-message-hash>]
```

Examples: `mirror:visual.parity:CSS_MISSING`, `mirror:PIPELINE_BUG:CHECK_CRASHED:links`, `replica:flow:positioned-text`, `design-system:BUILD_FAILED:tsc`, `freeze:REPLAY_404:stylesheet`, `health:STAGE_SLOW:appbuild`. The message is normalised before hashing (paths, ids, numbers, hostnames and viewport names replaced), so `bvg` and `ibm` hitting the same code path produce the same signature.

### 4.2 Sources the collector reads

| Source | Codes |
| --- | --- |
| run manifests (`manifest.json`) | `STAGE_FAILED`, `STAGE_SKIPPED_PARTS` (budgets), failing gates with value and threshold |
| verify (`verify/*.json`, `summary.json`) | every failing check with its issues; `SOURCE_DRIFT` recorded as info, never as a finding |
| dossiers (`verify/diagnosis/*`) | the `ParityCause` (`MARKUP`, `CSS_MISSING`, `CSS_ORDER`, `ASSET`, `SCRIPT`, `CONTENT`, `DYNAMIC`, `UNKNOWN`) and its evidence lines |
| autofix (`autofix/attempts/*`, `autofix/bugs/*`) | `AUTOFIX_NEEDS_HUMAN`, `PIPELINE_BUG` bundles (with their README and inputs), `NEW_PAGE_ERROR` |
| process | non-zero exit, timeout, unhandled rejection, out of memory, Playwright or Chrome launch failure |
| browser | console errors and failed requests on the new side only (`NEW_PAGE_ERROR`, `REQUEST_FAILED`) |
| freeze | `REPLAY_404` (a request the snapshot cannot answer), `BOT_BLOCKED`, `SNAPSHOT_INCOMPLETE` |
| design-system | `BUILD_FAILED` (install, build, test, docs, tsc), `CONTRAST_FAIL`, `RAW_VALUE_IN_CSS`, preview console errors and overflow |
| replica | responsive sweep issues (`OVERLAP`, `CUT_TEXT`, `SIDEWAYS_SCROLL`, `HEIGHT_DRIFT`), flow lint codes, `DS_SWAP_REVERTED`, `DS_COVERAGE_LOW` |
| reproducibility | `NONDETERMINISTIC` with the differing files |
| health | `STAGE_SLOW`, `BUDGET_EXCEEDED`, `LLM_FAILED` (a model call that failed and fell back) |

### 4.3 Registry and status

`findings.json` per cycle; `autopilot/registry.json` (committed) keeps every signature ever seen with: first and last cycle, sites, count, status (`open`, `fixing <goal>`, `fixed <cycle>`, `regressed`, `accepted-advisory`), the rule that guards it when fixed, and the attempts (goal id, verdict, reason). `inspect` labels each finding **new**, **recurring**, **regressed** (fixed before, back now) or **fixed** (open before, gone now), and `FINDINGS.md` lists them in that order with their evidence paths and crops.

### 4.4 Triage

Order: blocks the chain (crash, build failure) → fails a hard gate → health → advisory. Within a rank, more sites first, then more cycles. Findings with the same signature form one group and go to one fixer. `--max` groups per cycle (default 5) keeps a cycle bounded; the rest wait.

## 5. Fixing

### 5.1 Fixer = a goal in a worktree

Each group becomes a `cdr goal` (`packages/core/src/goals.ts`): its own worktree on `cdr/goal-autopilot-<signature>`, the `autonomous` workflow, permission mode `auto`, `ask_user` answered automatically, a budget, checkpoint commits, and a reviewer that judges acceptance criteria. Autopilot generates:

- **Task:** the finding group with the full evidence: dossier text, bug bundle README and inputs, crops, the stage's log excerpt, the sites affected, the related rules (§5.4), and **every earlier attempt on this signature with its reject reason**, so a fixer never retries what already failed.
- **Acceptance criteria** (checked by the reviewer and, mechanically, by `verify`):
  1. a regression test under `packages/<pkg>/test/` fails on the base branch and passes on this branch (autopilot runs it on both);
  2. `pnpm build`, `pnpm test`, `pnpm lint` green;
  3. the fix is generic: no hostname, site id or URL of the matrix in `packages/**` (policy check);
  4. no gate threshold, mask or skip changed (policy check);
  5. a rule file `autopilot/rules/<signature>.md` and its `rules.json` entry exist and name the guard (§5.4);
  6. the fixer wrote a short note of root cause and change for the report.
- **Scope:** `packages/**`, `templates`, skills, docs; **never** run outputs (`.harness/**`), never `autopilot/sites.yaml`, never thresholds in `packages/protocol` defaults or `mirror-core` contracts.

The fixer gets the built-in skills (`diagnosing-bugs`, `tdd`, `implement`) and a new `autopilot-fix` skill (§5.3). It may run the fast lane itself (`pnpm autopilot verify --fast --goal <id>`) to see whether the finding is gone before finishing.

### 5.2 Verify lanes and the accept rule

- **Fast lane** (minutes): on the candidate branch, rebuild packages, run the unit tests, then re-run only the affected stage from cached inputs: `cdr recreate --run <id> --from <stage>` for mirror and rebuild stages (resume exists today), the design-system build on the saved `brand.json`, or the replica build from the saved scene. Runs on the fixture site (`acme` or `fluid`) and on the site that produced the finding. Verdict: finding signature gone, nothing else flipped.
- **Slow lane** (an hour or more): the full matrix from the snapshots on the candidate branch, plus the holdout. Verdict: **accept** iff the signature is absent on every site where it appeared, no gate went pass → fail anywhere (matrix or holdout) against `baseline.json`, and no new `PIPELINE_BUG`. Any other outcome **discards** the branch, records the attempt and reason in the registry, and the next fixer for that signature reads it.
- Accepted branches are merged with `mergeGoal` (`--no-ff`) and `baseline.json` is updated to the slow-lane result. Several accepted goals in one cycle are merged one after another, each re-verified with the fast lane on top of the previous merge; a conflict discards the later one.

The decision function is the one from `@harness/mirror-fix` (`decide(before, after)`: regressions first, then improvement), with "primary metric" = number of hard gates passing across the matrix and "regression" = any gate pass → fail.

### 5.3 The `autopilot-fix` skill

`packages/core/skills/autopilot-fix/SKILL.md`, `auto: never`, loaded by the fixer goals. It encodes the rules of §5.1 and the diagnosis method: read the dossier's cause first; reproduce with the bug bundle or the fixture before touching code; fix the layout rule or the pipeline step, never the numbers; write the test first; never edit generated output; never lower a threshold; put the rule file last. It points at the runbooks (§5.6) per stage.

### 5.4 Rules: a finding that cannot come back

A rule is the durable output of a fix. Format:

```markdown
# <signature>                                    autopilot/rules/mirror-visual.parity-CSS_MISSING-noscript.md
Seen: bvg (cycle 2), ibm (cycle 2) · Fixed: cycle 3 · Goal: goal-…
## Symptom
visual.parity 0.91 on mobile; dossier cause CSS_MISSING: a stylesheet loaded only inside <noscript> on the original is active on the new side.
## Root cause
portStyles kept <noscript> stylesheet links as live links.
## Invariant
A stylesheet that the original loads only in <noscript> is never emitted as an active <link>.
## Guard
test: packages/mirror-design/test/styles.test.ts "noscript stylesheets stay inert"
lint: autopilot/lints/noscript-stylesheet.mjs (runs on every out/mirror and out/replica)
```

`rules.json` holds the same fields machine-readably. **A rule without a live guard is rejected** (`pnpm autopilot rules --check` fails when a named test or lint does not exist; it runs in `pnpm test`). Guards come in two kinds: a regression test in the package, and an **output lint** under `autopilot/lints/` that runs on every produced app in every cycle (so a rule also catches the same symptom when it comes from a different code path). Rules are injected into fixer tasks when their symptom or stage matches, and the collector tags a recurring finding with the rule it violates.

### 5.5 Policy check

A deterministic check on every candidate diff, run before the fast lane: no matrix hostname or site id in `packages/**`; no change to gate defaults (`packages/protocol` `RecreateConfig` defaults, `mirror-core` thresholds, `recreate.gates` in any config); no `mask`, `skip`, `exclude` added to a site config or verify call; no edits under `.harness/`, `autopilot/sites.yaml`, `autopilot/baseline.json`, `autopilot/registry.json`; no new `// @ts-ignore` or disabled tests. A violation discards the candidate with the reason.

### 5.6 Runbooks

`docs/autopilot/runbooks/<stage>.md`: for each stage, where its inputs and outputs live, how to re-run it alone from cached inputs, how to read its report and dossiers, the known cause categories and their usual fixes. Ported and adapted from the source repo's `docs/runbooks/` (`verify.md`, `autofix.md`, `design-extract.md`, `frontend-generate.md`) plus new ones for freeze, design-system, replica and final. They are the fixers' reference material.

## 6. Making the matrix converge

### 6.1 Determinism

Snapshots (§2.1) remove source drift. Model answers are cached per run as today (`llm-cache`, the host client) and the reproducibility run uses `--keep-cache`, so a second run makes zero live calls. Playwright and Chrome versions are pinned (they are). Parity is measured twice per viewport and the minimum is kept; a region may be masked only with the `DYNAMIC` proof the autofix loop already requires (two captures of the original differ there).

### 6.2 Budgets

| Item | Default | Where |
| --- | --- | --- |
| a mirror run | 40 min, as today (`recreate.budgets`, `mirror.fix.budgetUsd` 3.9 USD) | pipeline |
| a design-system build | 15 min | `autopilot.budgets.designSystemMs` |
| a replica build and final check | 20 min | `autopilot.budgets.replicaMs` |
| a fixer goal | 45 min, 10 USD, 1 round of 4 | goal budget |
| a cycle | 5 fixer groups, 60 USD | `loop --fix-max --budget-usd` |
| the loop | 20 cycles, 200 USD, stop when green for 2 cycles | `loop` flags |

A matrix run is about 2 hours with two sites in parallel; a cycle with fixes and both verify lanes is 3 to 5 hours. Twenty cycles is three to four days of unattended running; the first findings list exists after the first `run` and `inspect`, in about two hours.

### 6.3 Parallelism and isolation

Two sites at a time (each run opens three browsers for the device classes plus the app server). Ports are allocated from a pool per cycle. Each site has its own project folder and `.harness/recreate`, so runs never share a folder, and fixer goals work in worktrees, so they never touch the checkout the matrix runs in. The matrix runs on the main checkout at the accepted commit; candidate verification runs in the goal's worktree.

### 6.4 Raising the bar over time

Parity, bbox, text and the sweep are fixed gates from day one. Two metrics climb instead:

- **DS coverage** (§2.4): starts as a hard gate at 0.5 and rises by 0.1 after every cycle in which all four sites pass it, up to 0.9. A raise that makes a site fail produces a `DS_COVERAGE_LOW` finding whose fixer improves the swap rules, never the measurement.
- **Model independence**: the number of live model calls per site per run is reported; the loop prefers deterministic fixes (rule handlers, emitter changes) and a fixer's acceptance criteria include "no new model call on the hot path" unless the finding says a deterministic fix is impossible.

## 7. Guarding against the loop fooling itself

- **Holdout** (§3.2): two fixture sites and one live site that fixers never see. A regression there discards a fix like any other.
- **No threshold changes, no masks, no site branches** (§5.5), mechanically.
- **Baseline, not previous attempt**: regressions are judged against the last accepted matrix result.
- **Stability**: green must hold for two consecutive cycles from blank, the second with `--keep-cache` proving reproducibility.
- **Attempts are memory**: a signature with three discarded attempts is marked `NEEDS_HUMAN` with every attempt's diff summary and reason, and the loop goes on with the rest. A documented failure is a valid outcome; a faked pass is not.
- **Budget stops are hard**: the loop never spends past its budget; it pauses with a report.

## 8. Implementation phases

Each phase ends green on `pnpm build && pnpm test && pnpm lint`, with docs updated. Tests use `MockProvider`, fixtures served locally, no network, Chrome and Playwright tests skipped where absent (as today).

### Phase 0 — matrix runner, collector, first findings list (1 to 2 days)

- `packages/autopilot` with `sites.yaml` loading, per-site project folders, port pool, `run` (mirror stage only at first, via `recreateInSession` with `--json` events to `events.jsonl`), `inspect` (collector over manifests, verify JSON, dossiers, bug bundles, logs), signatures, `findings.json`, `FINDINGS.md`, `report` (REPORT.md + static `index.html`), `status`.
- `cdr autopilot` in `packages/cli`, `pnpm autopilot` script.
- Tests: collector on recorded fixture runs (synthetic manifests and verify files from the acme fixture), signature normalisation, report rendering.
- **Value:** the manual bug hunting becomes a generated list after one command. Live sites are used directly in this phase (freeze comes next), with `RECREATE_LIVE=1` to make that explicit.

### Phase 1 — freeze and replay (2 to 3 days)

- Port `source-capture` (`replay.ts`, `store.ts`, `rewrite.ts`, `har.ts`, `wayback.ts`) into `packages/mirror-capture` or a new `packages/mirror-replay`, under the same request guard; `freeze` command; snapshots with `current` link and age; `REPLAY_404` and `BOT_BLOCKED` findings; `--keep-cache` reproducibility run.
- Tests: replay serves a recorded fixture crawl byte for byte; 204 for trackers; 404 logged; snapshot age logic.
- Matrix runs now hit only `127.0.0.1`.

### Phase 2 — registry, rules, policy check, fixer goals, verify lanes (3 to 4 days)

- `autopilot/registry.json`, `rules.json`, `rules/*.md`, `rules --check`, `autopilot/lints/` runner; policy check; `fix` (goal creation with generated task and criteria, `autopilot-fix` skill, runbooks); `verify` fast and slow lanes with the accept rule and `baseline.json`; `loop` with `state.json`, pause and resume, budgets, stop rules.
- Tests: policy check on crafted diffs; `decide` across matrix results; loop state machine with a fake runner and fake goals; rule guard check; a fixture end-to-end under `CDR_AUTOPILOT_E2E=1` (injects a known defect into a copy of the acme fixture, runs one cycle with a scripted "fixer", asserts accept and rule creation).

### Phase 3 — `cdr design-system` CLI and design-system stage (2 to 3 days)

- The CLI command; brand reading from the snapshot; the `components` stage of the rebuild pipeline run on the snapshot to extract the page's sets; `@<prefix>-ds/site` composites emitted into the workspace consuming the tokens; `design-system/report.json`; hard checks of §1 (build, test, docs, tsc, contrast, raw-value lint, preview at two widths and two themes).
- Tests: CLI argument handling, snapshot reader on the recorded fixture, composite emission into the workspace, lint of raw values; `CDR_DS_BUILD=1` real build stays optional.

### Phase 4 — replica and final check (4 to 6 days)

- The Next.js replica template; scene → sections → composites → page; primitive swap with the accept/rollback contract and `DS_SWAP_REVERTED`; coverage metric; `final` stage reusing `verifyStep`, the responsive sweep and flow lint on the replica app; compare page; findings for every new code.
- Tests: replica built from the acme recordings renders every section; swap reverted when parity drops (synthetic case); coverage counting; final-stage report shape; fixture end-to-end with Chrome.

### Phase 5 — loop hardening, scheduling, docs (1 to 2 days)

- Coverage ratchet, holdout handling, `diff`, `clean`, a `launchd`/cron example for a nightly `loop --max-cycles 1`, `docs/autopilot.md` user guide, this plan updated to "as built", CHANGELOG.

Phases 0 to 2 give the self-improving loop on the mirror stage alone, which is where the user's current pain is. Phases 3 and 4 extend the chain to the design system and the 1:1 replica, under the same loop.

## 9. CDR integration checklist

| Area | Change |
| --- | --- |
| Packages | `packages/autopilot` (runner, collector, registry, loop; depends on core, recreate, mirror, mirror-verify, design-system); replay in `packages/mirror-replay` |
| CLI | `cdr autopilot <freeze|run|inspect|fix|verify|loop|status|report|rules|diff|clean>`, `cdr design-system` |
| Protocol | `autopilot.*` events for the desktop and web apps later (`autopilot.cycle`, `autopilot.finding`, `autopilot.fix`); not needed for the terminal-first phases, added when the UI shows cycles. Schemas regenerated when added |
| Core | `recreateInSession` reused; `design_system` tool reused by the CLI; goals reused for fixers; a `replica` stage in `packages/recreate`'s runner behind a target `replica-nextjs` |
| Skills | `autopilot-fix`; `recreate-url` and `design-system` unchanged |
| Config | `autopilot: { budgets, parallel, freeze: { maxAgeDays, wayback }, coverage: { start, step, max }, holdout }` |
| Docs | `docs/autopilot.md`, `docs/autopilot/runbooks/*.md`, `docs/cli.md`, this plan |
| Repo | `autopilot/` committed (sites, rules, registry, baseline, lints); `.harness/autopilot/` ignored (already covered by `.harness/`) |

## 10. Risks and open points

- **Rights.** All four sites belong to their owners. Snapshots, mirrors and replicas stay in gitignored run folders and are used for evaluation of the pipeline only; `RECREATION.md` and `credits.json` keep saying so. The consent gate is answered with `--yes` and logged as `auto`, as `cdr recreate --yes` does today.
- **vw.de** redirects; the snapshot records the final URL and the chain is judged against it. If the final page is a locale chooser, `sites.yaml` gets the locale URL (as the source pipeline used volkswagen `de.html`).
- **bmw.de** behind bot management: freeze with Wayback is the only path; if Wayback has no usable capture, the site is reported `BOT_BLOCKED` and stays in the matrix as a documented failure.
- **1:1 from generic components is a tension.** Parity is the hard gate and coverage the climbing one; a replica can be green at 0.5 coverage and still be a real design-system app. The alternative, forcing full coverage, would make every site fail parity forever.
- **Fixers can thrash.** Attempt memory, three-strikes `NEEDS_HUMAN`, holdout and baseline make thrashing visible and bounded, not impossible. The report says what was tried.
- **Cost and time.** A cycle is hours and tens of dollars; the loop is a background job, not an interactive tool. Budgets are hard stops.
- **Two browser stacks** stay (CDP for rebuild and brand reading, Playwright for mirror, replay and verify). Unifying them is out of scope here as in the port plan.
- **Open:** whether the replica should also be emitted for `react-vite` (no Next.js) as a cheaper target; whether Angular belongs in the default matrix (build time); the holdout live site.

## 11. First week, concretely

1. Phase 0: `pnpm build && pnpm autopilot run --sites bvg,vw,ibm,bmw --stages mirror && pnpm autopilot inspect` → the first `FINDINGS.md`. Read it together; it replaces the current manual list.
2. Phase 1: `pnpm autopilot freeze --sites …` → every later run is deterministic and offline.
3. Phase 2: `pnpm autopilot loop --stages mirror --max-cycles 5 --budget-usd 50` overnight → the first accepted fixes and rules, or a documented `NEEDS_HUMAN` list.
4. Then phases 3 and 4 add the design system and the replica to the same loop.

## 12. As built

Phases 2 and 5, the self-improving half. Deviations and decisions the plan left open:

- **Candidates are verified on top of the previous merge from the start.** The base branch is merged into each worktree before the guard and test checks, so the fast and slow lanes both judge the code that would land, and each accepted goal is on the accepted state of the one before it. A conflict in `autopilot/rules.json` alone is resolved as the union of both entries, since every goal adds one; any other conflict discards the later goal.
- **`decide` from `@harness/mirror-fix` is reused, with one difference in the input.** The primary metric is hard gates passing minus the occurrences of the signature being fixed, so a finding that is no gate (a `NEW_PAGE_ERROR`) can still improve. Gates that disappeared count as failing: across a matrix, a fix that crashes a stage must not look clean (mirror-fix ignores a missing gate).
- **The policy check also protects `packages/autopilot/src/policy.ts` and `decide.ts`**, rejects deleted test files, and treats `@ts-expect-error` as a suppression outside tests. Site ids of real sites count; fixture ids do not (`fluid` is a layout word, and fixtures are ours). Site ids that are also CSS units are only caught next to a word such as `site` or `host`.
- **Bookkeeping is committed by the loop.** After each verdict, `registry.json`, `baseline.json` and the stamped `rules.json` are committed on the base branch (these paths only). The next merge needs a clean `rules.json`, and a verdict should survive a crash.
- **`--until-green` means "stop when green".** Without it `loop` runs its `--max-cycles` even when green, and exits 0 if the last cycle was green.
- **`--dry-run` writes the generated task** to `cycles/N/fix-drafts/` and starts nothing, instead of a read-only model run.
- **The first run also includes the holdout**, so the first baseline can judge a regression there. Holdout names are removed from fixer tasks and from every reject reason written to the committed registry.
- **Fixers run one after another**, not in parallel, so each goal's cost budget can be set to what is left of the cycle's budget.
- A fixer goal's "1 round of 4" was read as `maxRounds: 1`: the fixer does one round, and a discard makes the next cycle's fixer read the reason.
- A loop in which no finding can be taken by a fixer pauses instead of re-running an unchanged matrix. A repeat cycle where fixers ran but none was accepted still runs the matrix: the code may not have changed, and nothing tells the loop.
- The reproducibility check compares the coverage gate by value, because the ratchet can raise its threshold between two green cycles.
- The runbooks for verify, autofix, design-extract and frontend-generate are adapted from the source pipeline; the rest are new.
