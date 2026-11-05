# Evals

Small, reproducible coding tasks used to measure the harness (models, prompts, tool wording, workflows).

- `fixtures/<name>/` – starting repositories (copied to a temp dir and `git init`-ed per task).
- `tasks/*.json` – `{ id, fixture?, task, workflow?, suite?, sandbox?, checks[] }`.
  Check types: `command` (exit 0), `fileContains` / `fileNotContains` (regex), `onlyChanged` (globs; `.harness/` ignored), `maxFiles`, `preview` and `judge` (below).
- Suites: tasks without `suite` belong to `code` (the default). `--suite apps` runs the app-building tasks, `--suite all` runs everything.
- `results/` – one JSON summary per run (git-ignored).

```bash
pnpm build
node packages/cli/dist/bin.js eval --model deepseek/deepseek-flash            # quick-fix workflow (default)
node packages/cli/dist/bin.js eval --model deepseek/deepseek-flash -w default # full workflow
node packages/cli/dist/bin.js eval --model local/qwen3.8:latest --filter 02
```

Runs are non-interactive: permissions mode `auto`, plans auto-approved.

## App suite

`20-…` to `24-…` build a store, a landing page, a dashboard, a snake game and a todo app. Each task has `sandbox: true`, so it runs exactly like a new web chat: an empty sandbox, the sandbox prompt, matching skills, and a single chat turn (`workflow` defaults to `"chat"`).

- `preview` loads the page in headless Chrome at the listed viewports (`small` 320, `phone` 390, `tablet` 768, `desktop` 1280), clicks every visible button and reloads. It fails on JavaScript errors, errors while clicking, horizontal overflow, broken images, unnamed controls, and too few buttons or loaded images. `imagesRequireEnv` only enforces the image count when, for example, `UNSPLASH_ACCESS_KEY` is set. Without Chrome the check fails instead of passing silently.
- `judge` sends the brief, the browser report and the HTML to a judge model, which scores seven dimensions from 1 to 5: visual design, restraint, responsiveness, functionality, content, accessibility and craft. The check passes when the mean reaches `minScore` (default 4). Use `--judge` to pick a stronger model than the one being evaluated; `vision: true` adds phone and desktop screenshots for vision models.

```bash
pnpm build
node packages/cli/dist/bin.js eval --suite apps --model deepseek/deepseek-flash --judge deepseek/deepseek-v4-pro --label "web-app skill"
node packages/cli/dist/bin.js eval --suite apps --filter 20 --repeat 4 --model deepseek/deepseek-flash --judge deepseek/deepseek-v4-pro
node scripts/evals/compare.mjs evals/results/*.json   # task × run table: passed/runs · mean judge score
```

Set `HARNESS_BUILTIN_SKILLS` to an empty folder to measure the harness without built-in skills.

Latest results (2026-11-05, `deepseek/deepseek-flash`, judge `deepseek/deepseek-v4-pro`): with the `web-app` skill all five app tasks pass with judge scores of 4.14 to 5.00 and about 1.9M tokens in total. Without skills the scores are 4.43 to 4.71 at 5.5M tokens. Details are in [docs/app-quality-plan.md](../docs/app-quality-plan.md#implementation-status-2026-11-05).
