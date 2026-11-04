# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org/) from 1.0 onwards.

## Unreleased

- Rename Morrow to CDR across the terminal, web, and desktop apps, with a new geometric logo, graphite/lime identity, and technical typography.
- Add `cdr`, `cdr.config.json`, and `CDR_*` environment settings while retaining legacy command, configuration, credential, and workspace compatibility.

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
