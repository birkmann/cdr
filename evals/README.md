# Evals

Small, reproducible coding tasks used to measure the harness (models, prompts, tool wording, workflows).

- `fixtures/<name>/` – starting repositories (copied to a temp dir and `git init`-ed per task).
- `tasks/*.json` – `{ id, fixture, task, workflow?, checks[] }`.
  Check types: `command` (exit 0), `fileContains` / `fileNotContains` (regex), `onlyChanged` (globs; `.harness/` ignored).
- `results/` – one JSON summary per run (git-ignored).

```bash
pnpm build
node packages/cli/dist/bin.js eval --model deepseek/deepseek-flash            # quick-fix workflow (default)
node packages/cli/dist/bin.js eval --model deepseek/deepseek-flash -w default # full workflow
node packages/cli/dist/bin.js eval --model local/qwen3.8:latest --filter 02
```

Runs are non-interactive: permissions mode `auto`, plans auto-approved.
