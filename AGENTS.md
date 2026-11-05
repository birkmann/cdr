# AGENTS.md

Rules for coding agents (including this harness itself) working in this repository.

## Layout
- pnpm workspace, TypeScript (ESM, NodeNext), Node ≥ 22.
- `crates/studio-*` (Rust, Tauri desktop app) → `apps/desktop` (its webview UI, reuses `apps/web/src` via the `@web` alias).
- `packages/protocol` (types only, no runtime deps) → `core` → `server` / `cli`; `client` → `react`; `apps/web` (served by `harness serve`).
- Built-in skills live in `packages/core/skills/<name>/SKILL.md` (shipped next to `dist` and in the desktop/CLI bundles); see docs/skills.md.
- Tests live in `packages/*/test/*.test.ts` and import packages by name (`@harness/core`); vitest aliases them to `src/`.

## Commands
- Build: `pnpm build` (tsc project references + web demo)
- Test: `pnpm test`
- Lint/format: `pnpm lint` / `pnpm format`
- Browser e2e: `pnpm --filter web test:e2e` (after `pnpm build`)
- Desktop app: `pnpm desktop:dev` / `pnpm desktop:build`; Rust: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`; desktop e2e: see docs/desktop.md
- Regenerate JSON schemas after changing protocol types: `pnpm --filter @harness/protocol schema`

## Conventions
- Every agent step is an event (`@harness/protocol` `EventBody`). UIs only render events; never add UI-only state to core.
- New event types: add to `EventBody`, handle in `reduceSession` (client) and the CLI `Renderer`, regenerate schemas.
- Tools must confine paths with `resolveInProject`, return `{ ok, output }` and never throw for expected failures.
- Tests use `MockProvider`; no test may call a real model or the network.
- Never log or emit secrets: events pass through `redactValue`; provider keys are stripped from shell environments.
