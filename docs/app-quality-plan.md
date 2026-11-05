# Plan: generating Form-quality apps with real models

Status: **M1–M4 and M6 implemented, M5 first iteration done** (2026-11-05). See [Implementation status](#implementation-status-2026-11-05) at the end. Companion to [implementation-plan.md](implementation-plan.md) and [desktop-plan.md](desktop-plan.md).

---

## 1. Where we stand

The README preview (`docs/images/web-preview.png`) is a **scripted run**. `scripts/screenshots/demo-model.mjs` replays a hand-written, 1 230-line `fixtures/form.html` through the real harness (real `write_file`, real `set_preview`, real sandbox) but no model writes a single line. `scripts/screenshots/fixtures/README.md` says so; the README itself does not.

What a real model gets today when a user types *"Build Form, a responsive accessories store…"* into the web app:

| Piece | Today | Gap vs. the screenshot |
|---|---|---|
| Prompt | `chat` phase prompt + `TOOL_ETIQUETTE` + `SANDBOX_PROMPT` (`packages/core/src/context.ts`, `sandbox.ts`), ~25 lines | No design guidance, no reference, no quality checklist. Says "build, preview, check once" and nothing about *what good looks like* |
| Knowledge | `AGENTS.md`/`CLAUDE.md` project rules, memory files | A sandbox is empty, so the model gets nothing. There is **no skills mechanism** in core (no match for "skill" anywhere in `packages/`) |
| Perception | `check_preview`: headless Chrome at 1024×768, `--dump-dom`, reports JS errors and 400 chars of text | Cannot see layout, overflow, broken images, missing button names, or phone widths. The model cannot fix what it cannot observe |
| Photography | `search_unsplash` / `use_unsplash_photo` with credit rules | Good. Keep; the skill must tell the model *when* and *how* to lay photos out |
| Measurement | `evals/` with 5 code tasks; checks are `command`, `fileContains`, `onlyChanged` | No app-building task, no UI check, no quality score. We cannot tell whether a prompt change helps |
| Workflow | `quick-fix` / `default` presets; reviewer looks for bugs in a diff | No design review round |

Expected failure modes with the default executor (`deepseek/deepseek-flash`) and local models, based on how unguided models build pages: the generic "AI look" (purple gradient hero, centred cards with drop shadows, emoji icons), placeholder or invented image URLs, horizontal overflow on phones, state that does not persist or a bag without quantities, icon buttons without accessible names, several files where one was better, and "it works" without calling `check_preview`.

## 2. Goal and definition of done

"Form quality" means a page that would pass the capture script's own checks (`scripts/screenshots/capture.mjs`: filtering, size selection, totals, reload persistence, Escape, no overflow at 320/390/768/1280 px, images loaded) **and** reads as designed rather than generated.

Done when:

1. A new `apps` eval suite exists with automated preview checks and an LLM-judged design rubric (section 4, M4).
2. With the exact README prompt, the default executor produces a preview that passes every automated check and scores ≥ 4/5 on the rubric in at least 3 of 4 runs. A stronger model (`deepseek/deepseek-v4-pro` or `anthropic/claude-sonnet-5-5`) does so in 4 of 4.
3. The suite's other prompts (landing page, dashboard, game, todo) reach ≥ 80 % automated pass rate with the default executor.
4. The README either shows a screenshot from a **real** run or states that the image comes from the scripted demo.

## 3. Approach: a skill, a feedback loop, and a yardstick

Three levers, in order of leverage. Each is independently useful and shippable.

**A. Skill (knowledge).** Add a skills mechanism to core, compatible with the open Agent Skills format (a folder with `SKILL.md`, YAML frontmatter `name` + `description`, optional reference files), and ship one built-in skill, `web-app`, that distils what makes `form.html` good into rules a model can follow. Because the format is the common one, a user can also drop community skills such as Anthropic's `frontend-design` into `~/.harness/skills/`.

**B. Perception (feedback).** Upgrade `check_preview` so it reports what a designer would see: overflow per viewport, image load failures, unnamed buttons, title/h1, plus a screenshot for vision models. Without this the skill is advice the model cannot verify.

**C. Yardstick (evals).** App-building eval tasks with automated checks and a rubric judge, run across models, so every prompt or skill change is measured rather than eyeballed.

**D. (optional) Workflow.** A `build-app` preset with a design-review round, decided after C produces data.

## 4. Milestones

### M1 – Skills mechanism in core

- **Discovery** (`packages/core/src/skills.ts`): load `SKILL.md` from, in precedence order, `<project>/.harness/skills/*/`, `~/.harness/skills/*/` (`harnessHome()`), and built-in `packages/core/skills/*/` (copied to `dist/skills` by the build; the desktop bundle in `scripts/bundle-harness.mjs` must include it). Parse frontmatter: `name`, `description` (≤ 1 line, shown in the index), optional `triggers` (regex list matched against the first user message), optional `auto` (`sandbox` | `always` | `never`), optional `allowed-tools` (ignored for now, kept for format compatibility). Unknown keys are ignored.
- **Progressive disclosure**: `buildSystemPrompt` gets a `# Skills` section listing name + description for every discovered skill, plus one line: *"Call `load_skill` before starting work that a skill covers."* A new read-only tool `load_skill { name, file? }` returns the full `SKILL.md` body, or a named reference file from the skill folder. Reference reads are confined to the skill directory with the same symlink-safe logic as `resolveInProject` (`tools/paths.ts`), never the project.
- **Auto-activation**: when a sandbox session starts and a skill's `triggers` match the task (or `auto: sandbox`), the full `SKILL.md` body is appended to the system prompt via the existing `extra` path in `Session.runPhaseAgent`. Reason: small models are unreliable at deciding to call `load_skill`; injection is deterministic. Model-invoked loading stays for project sessions.
- **Config** (`packages/protocol`, `HarnessConfig.skills?: { paths?: string[]; disabled?: string[] }`), schema regenerated with `pnpm --filter @harness/protocol schema`.
- **Events**: emit `log` (level `info`, `skill web-app activated`) when a skill is auto-injected or loaded, so the web and desktop step views show it. A dedicated `skill.activated` event type can come later if the UI wants a chip; follow the AGENTS.md rule (add to `EventBody`, `reduceSession`, CLI `Renderer`, schemas) when it does.
- **Tests** (`packages/core/test/skills.test.ts`): precedence between the three locations, frontmatter parsing and bad frontmatter, index rendering in the system prompt, `load_skill` confinement (a `../` or symlinked reference is refused), trigger matching and auto-injection observed through `MockProvider` (assert the system message contains the skill body).
- **Done when**: `pnpm build && pnpm test && pnpm lint` green; a sandbox session's system message in the JSONL log contains the skill.

### M2 – The `web-app` skill

`packages/core/skills/web-app/SKILL.md` (target ≤ 3 500 tokens so it fits small context windows) plus `reference/`.

Content, derived from what `form.html` actually does:

- **Process**: read the brief, decide on one `index.html` with inline CSS and JS, write it with a single `write_file`, call `set_preview` immediately, call `check_preview`, fix only real problems, finish with a short summary. No frameworks or packages unless asked. No screenshots, test scripts, or browser installs in the project.
- **Design system** (concrete values, not adjectives): one system typeface stack; a white or near-white canvas; ink, muted, hairline and *one* accent colour as CSS custom properties; a display heading at 10–12 vw clamped; hairlines instead of shadows; grey product tiles behind photos; generous whitespace. Explicit bans: gradients as decoration, emoji as icons, glassmorphism, centred-card heroes, Inter-on-everything, drop shadows on cards.
- **Layout**: mobile first; breakpoints at ≤ 700, ≥ 760 and ≥ 1000 px like the fixture; 16 px gutters; no horizontal overflow at 320 px; a fixed primary action on phones; touch targets ≥ 44 px; `prefers-reduced-motion` respected.
- **Content**: realistic names, prices and copy; no lorem ipsum; demos labelled as demos (*"Checkout is a demo — no order is placed"*).
- **Photography**: the Unsplash flow from `TOOL_ETIQUETTE`; `<img>` with `width`/`height`, `alt`, `loading="lazy"`, `object-fit`; a tinted background while loading; visible photographer credit; continue without photos when search is unavailable, never invent URLs.
- **Interaction**: one state object, pure render functions, `localStorage` behind `try/catch` (the preview iframe may block storage, see [web.md](web.md#preview-storage)), `<dialog>` for bag and menu, Escape closes, focus returned, `aria-label` on every icon button, `role="status"` for confirmations.
- **Finish checklist** mirroring M4's automated checks, so the model can self-check before it stops.
- **Reference files**: `reference/form.html` becomes the single source of the fixture (the screenshot script reads it from here), with a 30-line annotated map of its sections at the top of `reference/README.md`; `reference/patterns.md` with short snippets for other briefs (landing page, dashboard with a chart, canvas game loop, todo list) so the skill generalises beyond stores.

Done when: a reviewer reads the skill and can point at the line that prevents each failure mode in section 1; token count measured with `estimateTokens`.

### M3 – `check_preview` v2 (perception)

Keep the tool dependency-free (core must not depend on Playwright).

- **Viewports**: run Chrome at 390×844 and 1280×900 (320×740 optional via `viewports` arg). Report per viewport.
- **Probes**: horizontal overflow (`scrollWidth > innerWidth`), images total / failed (`naturalWidth === 0` after load), buttons and links without an accessible name, `document.title`, first `h1`, counts as today, JS errors and failed resource loads.
- **Mechanism**: `--dump-dom` cannot run our probes, so write a temporary wrapper page into the Chrome profile dir that loads the target in an iframe at the viewport size, runs the probes after `load` plus the virtual-time budget, and writes a JSON report into its own DOM; run Chrome on the wrapper with `--allow-file-access-from-files`. Fallback if that proves flaky: Chrome DevTools Protocol over `--remote-debugging-pipe` with a minimal client (≈100 lines). Spike both in the first half day, pick one.
- **Screenshots**: `--screenshot` per viewport into the temp dir. Phase 1 returns the paths in the text report. Phase 2 attaches them to the conversation for vision-capable models: `ChatMessage` tool results have no `images` field today, so either extend the protocol (`tool` message `images?`) or have `runAgent` append a user message `[check_preview screenshot]` with the image. Decide in M3; the text probes carry most of the value for text-only models.
- **Prompt**: `SANDBOX_PROMPT` tells the model to check at phone and desktop widths and to fix overflow and failed images before finishing.
- **Tests**: `tools.test.ts` gets two fixture pages (one overflowing with an unnamed icon button, one clean); skipped when no Chrome is installed, as today.

### M4 – `apps` eval suite (yardstick)

- **Task shape** (`packages/core/src/eval.ts`): add `sandbox?: true` (empty workspace, `isSandbox` prompt, same code path as the web app) and new checks:
  - `preview { path, viewports?, noOverflow, noJsErrors, minImagesLoaded?, minButtons?, namedButtons }` reusing the M3 probe runner;
  - `judge { rubric, minScore, model? }`: an LLM-as-judge call using the `reviewer` role (or an explicit model) that receives the HTML, the preview report and the task, and returns JSON scores 1–5 per dimension with a one-line rationale each;
  - `maxFiles { count }`.
- **Rubric dimensions**: visual hierarchy and typography; restraint (no AI-look traits); responsiveness; working interactions (state, persistence, dialogs); content realism; accessibility; photography and credit.
- **Tasks** (`evals/tasks/20-…`): `20-form-store` with the exact README prompt and checks lifted from `capture.mjs`; `21-landing-page`; `22-dashboard`; `23-snake-game`; `24-todo-app`.
- **Runner**: `cdr eval --suite apps --model …` (suite = task id prefix or a `suite` field); results keep judge scores and rationales; `scripts/evals/compare.mjs` prints a model × task table from `evals/results/*.json`.
- **Baseline first**: run the suite on the current prompt *before* M2 lands and keep that result file, so the skill's effect is a number, not an impression.
- **Models**: `deepseek/deepseek-flash` (default), `deepseek/deepseek-v4-pro`, `anthropic/claude-sonnet-5-5` if a key is available, one local Ollama model as the realism floor. `UNSPLASH_ACCESS_KEY` is configured locally; the demo tier allows 50 requests/hour, so `minImagesLoaded` must tolerate "no key" and runs should be spaced.

### M5 – Tune until the numbers hold

Iterate: run the suite, read the lowest-scoring rationales, change the skill or sandbox prompt, re-run. Keep a dated table of prompt version → score in `evals/README.md`. Expected adjustments: forcing single-file output, capping turns for sandbox builds, stricter "no placeholder images" wording, moving the checklist to the end of the skill where small models weigh it more.

If the data shows the executor writes good first drafts but does not fix what `check_preview` reports, add the `build-app` workflow preset: execute (with skill) → verify (`check_preview`) → review with the design rubric by the reviewer model → one fix round → finish, and make it the default for sandbox sessions started from the web app.

### M6 – Proof and documentation

- Add `--real --model <ref>` to `scripts/screenshots/capture.mjs web` so the README screenshot can come from a real run that passed the checks; if we keep the scripted image, add one sentence under it in `README.md` and `docs/web.md` saying it is produced by the scripted demo model.
- `docs/skills.md`: locations, frontmatter, triggers, auto-activation, writing your own; `docs/configuration.md`: `skills` section; `CHANGELOG.md` entry.
- The desktop app and CLI get skills for free through core; the web step view shows the activation log line.

## 5. Files to touch

| Path | Change |
|---|---|
| `packages/core/src/skills.ts` (new) | discovery, frontmatter, index, trigger matching |
| `packages/core/src/tools/builtin.ts` | `load_skill` tool; `check_preview` v2 |
| `packages/core/src/context.ts` | `# Skills` index in the system prompt |
| `packages/core/src/sandbox.ts` | `SANDBOX_PROMPT` viewport wording; skill injection hook |
| `packages/core/src/session.ts` | auto-activation via `extraSystem`; activation log event |
| `packages/core/src/eval.ts`, `packages/cli/src/commands.ts` | `sandbox`, `preview`, `judge`, `maxFiles` checks; `--suite` |
| `packages/protocol/src/*.ts` + schemas | `skills` config; optional tool-result images |
| `packages/core/skills/web-app/` (new) | `SKILL.md`, `reference/form.html`, `reference/README.md`, `reference/patterns.md` |
| `packages/core/package.json`, `scripts/bundle-harness.mjs` | ship `skills/` with `dist` and the desktop sidecar |
| `scripts/screenshots/demo-model.mjs`, `fixtures/` | read the fixture from the skill reference; `--real` mode |
| `evals/tasks/2x-*.json`, `evals/README.md`, `scripts/evals/compare.mjs` | app suite and comparison table |
| `packages/core/test/skills.test.ts`, `tools.test.ts`, `eval.test.ts` | tests above |
| `docs/skills.md`, `docs/configuration.md`, `docs/web.md`, `README.md`, `CHANGELOG.md` | documentation |

## 6. Verification

```bash
pnpm build && pnpm test && pnpm lint
pnpm --filter @harness/protocol schema && git diff --exit-code packages/protocol/schemas
node packages/cli/dist/bin.js eval --suite apps --model deepseek/deepseek-flash      # baseline, then after M2
node packages/cli/dist/bin.js eval --suite apps --model deepseek/deepseek-v4-pro
node scripts/evals/compare.mjs evals/results/*.json
node scripts/screenshots/capture.mjs web                                              # scripted demo still passes
node scripts/screenshots/capture.mjs web --real --model deepseek/deepseek-flash       # M6
```

## 7. Risks and open questions

- **Token budget.** Skill + reference in the prompt is roughly 4–8 k tokens. Fine at 128 k; for local 8B models inject only `SKILL.md`, never the reference, and let `load_skill` fetch it on demand.
- **Small models ignore long instructions.** Mitigated by auto-injection, the end-of-skill checklist, the `check_preview` feedback loop, and if needed the review round in M5. The eval suite tells us which of these is needed.
- **Headless Chrome availability.** `check_preview` already degrades to "review the code carefully" without Chrome; the eval `preview` check must fail loudly instead, since a missing browser would otherwise look like a pass.
- **Judge variance and bias.** Use a stronger model as judge than as executor, run each task twice, keep rationales, and never let the executor's own model judge itself.
- **Unsplash rate limits** during eval runs (50/h on demo apps). Space runs; keep image checks tolerant of "no key".
- **Format drift.** Keep our frontmatter a superset of the Agent Skills format and ignore unknown keys so third-party skills load unchanged.
- **Honesty of the README.** Until M6, the screenshot is a scripted demo and should be labelled as such.

Decisions needed from the owner before M1 starts:

1. Auto-inject matching skills in sandbox sessions **and** offer `load_skill` (recommended), or model-invoked loading only.
2. Ship `web-app` as a built-in skill (recommended) or as an installable example under `docs/`.
3. Which models to target first for the ≥ 3 of 4 bar: default `deepseek-flash` only, or also `deepseek-v4-pro`.
4. Real-run README screenshot (M6) or keep the scripted one with a label.

Rough effort: M1 one day, M2 one day, M3 one day, M4 one day, M5 one to two days of iteration, M6 half a day.

---

## Implementation status (2026-11-05)

Decisions taken (the recommended options): matching skills are auto-injected in sandbox sessions **and** `load_skill` is offered everywhere; `web-app` ships as a built-in skill; the first target model is `deepseek/deepseek-flash`; the README keeps the scripted screenshot, now labelled, and `capture.mjs web --real` reproduces it with a real model.

| Milestone | State | Evidence |
|---|---|---|
| M1 skills | ✅ | `packages/core/src/skills.ts`, `tools/skill.ts`, `skills` config + schema, `log` event "Skill … activated"; `skills.test.ts` (12 tests). Bundles ship `skills/` next to `cdr.mjs` (verified with an esbuild bundle) |
| M2 web-app skill | ✅ | `packages/core/skills/web-app/` (SKILL.md ≈ 2.2k tokens, Form reference + map, patterns). The screenshot demo reads the same reference file |
| M3 check_preview v2 | ✅ text, ◐ images | `tools/browser.ts`: Chrome over `--remote-debugging-pipe`, viewports, overflow culprits, broken images, unnamed controls, failed requests, click-through + reload. Screenshots are captured for eval judges (`vision: true`) but not yet attached to agent turns: tool messages carry no images and the default executor has no vision |
| M4 apps evals | ✅ | `--suite/--judge/--repeat/--label`, `sandbox` tasks in chat mode, `preview`/`judge`/`maxFiles` checks, glob paths for content checks, `scripts/evals/compare.mjs`; `app-evals.test.ts` |
| M5 tuning | ◐ | One iteration: added a stop rule after "No problems found" (a smoke run used 18 turns and 1.1M tokens polishing) and a no-wrap rule for button labels. Not yet run with `--repeat 4` |
| M6 proof + docs | ✅ | Real web-app run of the README prompt: 236 s, no JS errors, no overflow, no broken images, layout matching the scripted screenshot. `docs/skills.md`, configuration, web, README, CHANGELOG, evals README |

Results with `deepseek/deepseek-flash` as builder and `deepseek/deepseek-v4-pro` as judge, one run per task:

| Task | No skill | web-app skill | Skill + Unsplash photos |
|---|---|---|---|
| 20-form-store | 4.71 | 4.86 | 4.86 |
| 21-landing-page | 4.57 | 5.00 | 4.14 |
| 22-dashboard | 4.57 | 4.86 | 5.00 |
| 23-snake-game | 4.43 | 4.71 | 4.57 |
| 24-todo-app | 4.71 | 5.00 | 5.00 |
| Checks passed | 3/5 (5/5 after the glob fix below) | 5/5 | 5/5 |
| Tokens | 5.54M | 1.76M | 1.93M |

Findings:

- The baseline's two failures came from content checks that only read `index.html` while it split CSS and JS into separate files. Content checks now accept glob paths; with that fix the baseline passes all automated checks too.
- The skill's measurable gains are a consistent target aesthetic (the baseline store used a warm serif look unlike the screenshot), slightly higher judge scores, and about a third of the tokens.
- The judge is lenient: no run scored below 4.1. Raise `minScore` or use a stricter or vision-capable judge before relying on it to separate good from great.
- `cdr eval --model …` did not load the project `.env`, so Unsplash was unavailable in the first two runs and the image check was skipped. Fixed; the third run used real photos.

Open items: run `--repeat 4` on the store task for the "3 of 4" bar; try `deepseek-v4-pro` and a local model; attach `check_preview` screenshots for vision models; set the lead tile's `object-position` guidance (one store cropped into empty background on desktop).
