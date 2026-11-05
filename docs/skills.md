# Skills

A skill is a folder of expert instructions an agent can load for a specific kind of work. CDR uses the common Agent Skills format, so skills written for other agents work unchanged.

```
web-app/
  SKILL.md            frontmatter + instructions
  reference/          optional files the agent can read on demand
```

```markdown
---
name: web-app
description: Build a polished, responsive single-page web app… (one line, shown to every agent)
triggers:
  - \b(store|shop|landing ?page|dashboard|game)\b
auto: sandbox
---

# Instructions in Markdown
```

| Key | Meaning |
|---|---|
| `name` | Lowercase letters, digits and dashes. Required. |
| `description` | One line. Required. Listed in every system prompt. |
| `triggers` | Optional case-insensitive regular expressions matched against the task. |
| `auto` | Where a matching skill is loaded automatically: `sandbox` (default), `always` or `never`. |

Other keys, such as `allowed-tools` or `license`, are accepted and ignored.

## How agents use skills

Every agent sees a short **Skills** section listing each skill's name and description. It loads the full instructions with the `load_skill` tool, and reads a reference file with `load_skill { name, file }`. Reference files are confined to the skill folder; paths that escape it, including through symlinks, are refused.

When a skill's triggers match the task and its `auto` setting allows the session, CDR puts the full instructions straight into the system prompt. Small models are unreliable at deciding to load a skill themselves; adding it up front makes the result predictable. The step list shows "Skill web-app activated" when this happens.

## Where skills come from

Earlier locations win when two skills share a name:

1. `<project>/.harness/skills/<name>/`
2. folders listed in `skills.paths` in `cdr.config.json`
3. `~/.harness/skills/<name>/` (or `$CDR_HOME/skills`)
4. built-in skills shipped with CDR

```jsonc
{
  "skills": {
    "paths": ["../shared-skills"],   // extra folders that contain skill folders
    "disabled": ["web-app"],         // hide a skill by name
    "enabled": true                  // false turns skills off entirely
  }
}
```

## Built-in: web-app

`web-app` turns a short brief such as "Build Form, a responsive accessories store with a clean product grid, product details, and a working bag" into a deliberate, responsive single-file app. It loads automatically in sandbox chats whose brief mentions a store, page, site, dashboard, game, todo list or similar, and it covers:

- the build process: one `index.html`, `set_preview` at once, `check_preview` at 320 px and desktop width, then stop when no problems remain;
- a default editorial-minimal design direction with concrete values, plus a list of generic AI-generated tropes to avoid;
- responsive layout rules, realistic content, Unsplash photography with credits, and robust state with `localStorage`;
- a finish checklist that mirrors what the evals check.

Its reference folder contains the complete **Form** store, the same page the README screenshot shows, with an annotated map, and patterns for landing pages, dashboards, canvas games and todo apps.

## Checking the result

`check_preview` loads the page in headless Chrome at phone and desktop widths, or at the widths you list (`small` 320, `phone` 390, `tablet` 768, `desktop` 1280). It reports JavaScript errors, failed requests, horizontal overflow and the elements that cause it, broken images, and controls without an accessible name. It also clicks every visible button and reloads the page, which catches broken event handlers and corrupt saved state.

## Measuring a skill

The `apps` eval suite builds five apps in fresh sandboxes, exactly like a new web chat, and scores them with browser checks and a judge model:

```bash
pnpm build
node packages/cli/dist/bin.js eval --suite apps --model deepseek/deepseek-flash \
  --judge deepseek/deepseek-v4-pro --label "web-app skill"
HARNESS_BUILTIN_SKILLS=/nonexistent node packages/cli/dist/bin.js eval --suite apps \
  --model deepseek/deepseek-flash --judge deepseek/deepseek-v4-pro --label "no skill"
node scripts/evals/compare.mjs evals/results/*.json
```

See [evals/README.md](../evals/README.md) for the task format and the latest results.

## Real screenshots

```bash
node scripts/screenshots/capture.mjs web --real --model deepseek/deepseek-flash
```

This sends the README prompt to a real model through the web app and saves the workspace and the generated app at phone and desktop width. The images go to a temporary folder unless you pass `--out`. The README screenshot itself comes from the scripted demo model, which replays the skill's reference store.
