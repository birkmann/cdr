<p align="center">
  <img src="docs/images/logo.svg" width="76" height="76" alt="CDR logo" />
</p>

<h1 align="center">CDR</h1>

<p align="center">
  AI coding agent with terminal, web, and native desktop interfaces.<br />
  TypeScript · Node.js · React · Tauri 2 · Rust
</p>

<p align="center">
  <a href="https://github.com/birkmann/cdr/actions/workflows/ci.yml"><img src="https://github.com/birkmann/cdr/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022-339933.svg" alt="Node.js 22 or newer" />
</p>

- **Providers:** DeepSeek, Anthropic, OpenRouter, Ollama, and OpenAI-compatible APIs; separate models per workflow role.
- **Workflows:** planning, file edits, shell tools, build/test verification, and review; skills, MCP tools, subagents, and autonomous goals.
- **Permissions:** approval modes, project-confined file tools, optional bubblewrap sandboxing, and secret redaction.
- **Integration:** HTTP + SSE, typed session events, JSON schemas, TypeScript SDK, and React hooks.

## Install and run

[Download releases](https://github.com/birkmann/cdr/releases) for desktop installers and terminal/web archives. Node.js 22+ is required.

To build from source, install Node.js 22+, pnpm 11, and Git:

```bash
git clone https://github.com/birkmann/cdr.git
cd cdr
pnpm install
pnpm build
cp .env.example .env  # set credentials for your provider

pnpm cdr             # terminal
pnpm cdr serve       # web app; open the printed URL
pnpm desktop:dev     # desktop; also requires Rust and Tauri prerequisites
```

See [desktop prerequisites](docs/desktop.md#run-it). `pnpm desktop:build` writes installers to `target/release/bundle/`.

For a global command, run `pnpm --filter @harness/cli link --global`:

```bash
cdr                       # open the current project
cdr run "Fix failing tests" # run a workflow; add --json for JSONL events
cdr init                  # create project configuration and AGENTS.md
```

Configure providers, model roles, permissions, and verification commands in `cdr.config.json`; see [Configuration](docs/configuration.md). Provider keys can also go in `~/.harness/.env` or the desktop settings (system keychain). Local Ollama models do not require an API key.

## Interfaces

**Desktop:** editor, project search, language-server diagnostics, terminals, Git staging and history, and agent approvals.

<p align="center">
  <img src="docs/images/desktop-editor.png" width="100%" alt="CDR Studio editor and agent panel" />
</p>

<!-- Proportional widths keep the 1480×860 and 1600×1000 screenshots at the same displayed height. -->
<p align="center">
  <img src="docs/images/desktop-git.png" width="51%" alt="Git diff and staging" />
  <img src="docs/images/desktop-history.png" width="47.4%" alt="Commit history and details" />
</p>

**Web:** chat, project sandboxes, attachments, file changes, and live previews.

<p align="center">
  <img src="docs/images/web-preview.png" alt="Web workspace with a live product catalogue preview" />
</p>

**Terminal:** streaming responses, tool diffs, approvals, and scripted workflows.

<p align="center">
  <img src="docs/images/terminal.png" alt="Terminal workspace running a task and tests" />
</p>

## Development

```bash
pnpm build
pnpm test       # mock providers; no network
pnpm lint
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Core packages live in `packages/`, interfaces in `apps/`, and the desktop backend in `crates/studio-*`. See [Contributing](CONTRIBUTING.md) for end-to-end tests and releases.

## Documentation

- [Desktop](docs/desktop.md) · [Web](docs/web.md) · [CLI](docs/cli.md)
- [Configuration](docs/configuration.md) · [Workflows](docs/workflows.md) · [Skills](docs/skills.md)
- [Architecture](docs/architecture.md) · [Protocol](docs/protocol.md) · [SDK](docs/sdk.md)
- [Security](SECURITY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

[MIT](LICENSE)
