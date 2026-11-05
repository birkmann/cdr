# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org/) from 1.0 onwards.

## Unreleased

- Rename Morrow to CDR across the terminal, web, and desktop apps, with a new geometric logo, graphite/lime identity, and technical typography.
- Add `cdr`, `cdr.config.json`, and `CDR_*` environment settings while retaining legacy command, configuration, credential, and workspace compatibility.
- Add **skills** in the Agent Skills format, from `.harness/skills`, `~/.harness/skills`, `skills.paths`, and a built-in set. Agents see a skills index and a `load_skill` tool, and matching skills load automatically in sandboxes.
- Add the built-in **web-app** skill with the Form store as its reference app and patterns for landing pages, dashboards, games, and todo apps.
- `check_preview` now checks phone and desktop widths. It reports overflow, broken images, unlabelled controls, failed requests, and errors raised while clicking through the page.
- Add the `apps` eval suite with sandbox tasks, `preview`, `judge`, and `maxFiles` checks, plus `cdr eval --suite`, `--judge`, `--repeat`, and `--label`. `scripts/evals/compare.mjs` compares runs.
- Add `capture.mjs web --real` to screenshot an app built by a real model.

## Unreleased

### Added

- **Morrow Studio**, a native desktop app built with Tauri 2 and Rust:
  - an editor with colorful file icons, a GitHub Desktop-style Git client, terminals, and language-server diagnostics;
  - the agent panel, an approvals inbox, and goals;
  - AI-generated commit messages and UI zoom;
  - `.deb`, `.rpm`, and AppImage bundles.
- **Subagents.** The `spawn_agent` and `wait_agents` tools add parallel helpers. Writing helpers work in their own Git worktrees.
- **Goals.** A goal has acceptance criteria and a budget, and runs unattended with the `autonomous` workflow and checkpoint commits. It comes with the `/goals` API and `morrow goal` commands.
- **Releases.** GitHub Actions builds installers for Linux, macOS, and Windows, plus a terminal and web app archive, for every version tag. `pnpm release:version` keeps one version across all packages.
- **API additions:**
  - `POST /commit-message`;
  - sidecar options for `morrow serve`: `--token-env`, `--ready-json`, `--port 0`, and a parent-process watchdog.

## 0.1.0

### Added

- **Harness:** a provider-agnostic agent loop with tools, permissions, verification, review, workflows, memory, MCP, and an event log.
- **Terminal workspace:** `morrow`.
- **Web app:** `morrow serve`, with sandboxes, live previews, and attachments.
- **SDK packages:** `@harness/client` and `@harness/react`.
