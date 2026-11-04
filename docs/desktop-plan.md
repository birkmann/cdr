# CDR Studio – Native Desktop App Plan

Status: **implemented D0–D6, D7 partly** (2026-11-04). User and developer guide: [desktop.md](desktop.md). Deviations: `studio-git` uses the git CLI instead of gix/git2; Rust/TypeScript bindings are hand-written in `apps/desktop/src/ipc.ts` instead of tauri-specta; the web components are imported from `apps/web/src` through a Vite alias instead of a separate `packages/ui`; signing, auto-update and crash reporting are not done.
Scope: a native desktop coding app (Rust) on top of the existing harness, combining the agent workspace of Cursor / VS Code with the repository management of GitHub Desktop, plus multi-agent and autonomous-goal features that neither has.
Companions: [implementation-plan.md](implementation-plan.md) (harness), [architecture.md](architecture.md), [protocol.md](protocol.md), [workflows.md](workflows.md).

---

## 1. Goals and non-goals

**Goals**

1. A fast, installable desktop app (Linux first, then macOS/Windows) that opens any repository, edits code, runs the harness agent, and shows every step as it happens.
2. GitHub Desktop-class repository management: clone, changes, staging, commit, history, branches, push/pull, pull requests, conflicts.
3. Agents as first-class objects: several sessions at once, subagents spawned by the agent, each visible in a tree with its own log, diff, cost and status.
4. Goals that run autonomously: define a goal with acceptance criteria and a budget, let it run unattended in an isolated worktree, and review checkpoints and the resulting pull request.
5. One source of truth: the app renders harness events; it never keeps agent state that the harness does not have (AGENTS.md rule).

**Non-goals (v1)**

- Rewriting the harness core in Rust. The TypeScript core stays; the app drives it over the existing HTTP+SSE API.
- Full VS Code extension compatibility. We ship a focused editor, not an extension host.
- Cloud sync, accounts, or hosted agents. Everything runs locally.

---

## 2. Architecture decision: Rust shell, web UI, harness sidecar

Three options were weighed:

| Option | Pros | Cons |
|---|---|---|
| **A. Tauri 2 (Rust backend + webview UI)** | Reuses `@harness/client`, `@harness/react` and most of `apps/web`; mature editor (CodeMirror 6) and diff views exist; Rust owns everything that must be native (git, PTY, file watching, LSP proxy, keychain, process supervision); small installers; Linux/macOS/Windows from one tree | UI is HTML, not native widgets; two languages in the app |
| B. Pure-Rust GUI (gpui / iced / Dioxus native) | Single language, maximal control, Zed-like performance | No reusable code editor of VS Code quality outside Zed's own crates; every view (markdown, diff, chat, pickers) is rewritten from zero; 3–5× the effort before feature parity with the web app |
| C. Rust rewrite of the harness + GUI | One binary | Discards a working, tested core and its event log compatibility |

**Decision: Option A.** The native layer is Rust and does the work that a browser cannot (git, terminals, file system, processes, credentials). The UI reuses the CDR design and components. If a pure-Rust UI is wanted later, the Rust backend and the IPC contract carry over unchanged; only the webview is replaced. See open decision D1.

### 2.1 Process layout

```
┌──────────────────────────── CDR Studio (Tauri 2, one process) ────────────────────────────┐
│  Webview (React, @harness/react, CodeMirror 6)                                                │
│     │ Tauri IPC (commands + events)                 HTTP + SSE (@harness/client)             │
│  Rust core ──────────────────────────────┐             │                                      │
│   crates/studio-git      (gix / git2)    │             │                                      │
│   crates/studio-pty      (portable-pty)  │             ▼                                      │
│   crates/studio-watch    (notify)        │   ┌──────────────────────────────┐                 │
│   crates/studio-lsp      (JSON-RPC proxy)│   │ harness server (Node sidecar)│                 │
│   crates/studio-index    (SQLite, tantivy)│  │ @harness/server + core       │                 │
│   crates/studio-goals    (scheduler)     │   │ sessions, tools, workflows   │                 │
│   crates/studio-keys     (keyring)       │   └──────────────────────────────┘                 │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The **harness server** runs as a Tauri sidecar on `127.0.0.1:<random port>` with a per-launch token. The Rust side spawns it, health-checks it, restarts it, and stops it on quit. In development the app can attach to an already running `cdr serve` instead.
- **Rust commands** are exposed to the UI via Tauri `#[tauri::command]` functions and typed with `specta`/`tauri-specta` so the TypeScript bindings are generated, mirroring how `@harness/protocol` generates JSON schemas.
- **Agents never call Rust directly.** Agent tools stay in `@harness/core`; the app's Rust git layer serves the human UI. Git actions the agent needs are ordinary `bash`/tool calls under the existing permission policy.

### 2.2 Repository layout

```
crates/                      # Cargo workspace (new)
  studio-app/                # Tauri app: main.rs, commands, sidecar supervisor, menus, tray
  studio-git/                # clone, status, stage, commit, log graph, branches, remotes, worktrees, conflicts
  studio-pty/                # terminals
  studio-watch/              # file-system watcher → debounced change events
  studio-lsp/                # language-server supervisor and JSON-RPC bridge
  studio-index/              # file index, symbol search, recent repos (SQLite)
  studio-goals/              # autonomous goal scheduler and budget enforcement (thin; truth lives in harness events)
  studio-keys/               # OS keychain for provider keys, GitHub tokens, harness token
apps/desktop/                # Webview UI (Vite + React), shares code with apps/web via packages/ui
packages/ui/                 # React components extracted from apps/web (chat, steps, diff, pickers, themes)
packages/protocol/           # extended with agent.* and goal.* events (section 6)
packages/core/               # spawn_agent tool, goal workflow, child sessions (section 6)
packages/server/             # new endpoints (section 6)
```

`pnpm build` gains `pnpm --filter desktop build`; `cargo build --release -p studio-app` builds the native binary; `pnpm desktop:dev` runs `tauri dev` against the local server.

---

## 3. Product surface

### 3.1 Window layout

```
┌ title bar: repo switcher ▾ │ branch ▾ │ ⟳ fetch │ agents ● 2 running │ ⌘K ────────────────────┐
│ activity ─┬ explorer / search / git / agents / goals ─┬── editor tabs ───────────┬ agent panel ┐│
│  ▣ files  │ ▸ src/                                     │ index.html  ✎ app.ts    │ Chat ▾ model││
│  ⌕ search │   components/                              │ 1  <!doctype html>      │ ─────────── ││
│  ⑂ git    │   main.tsx                                 │ 2  <html>               │ steps…      ││
│  ⚙ agents │                                            │ …                       │ diff cards  ││
│  ◎ goals  │                                            │                         │ approvals   ││
│           │                                            ├─ terminal │ preview │ problems ─────┤│
│           │                                            │ $ pnpm test                        ││
└ status: main ↑1 ↓0 │ 3 changes │ deepseek-flash │ 3.6k in · 1k out │ $0.00 │ ⏳ verify ───────┘
```

Every column is resizable (reuse `ColumnResize`), themes come from `apps/web/src/themes.ts`, keyboard model follows the web app (⌘K palette, ⌘B sidebar, ⌘⇧O new chat) plus editor bindings.

### 3.2 Feature map

| Area | Features | Backed by |
|---|---|---|
| **Repositories** | Clone (HTTPS/SSH, GitHub picker), open folder, recent list, multiple windows, per-repo settings | `studio-git`, `studio-index`, GitHub API |
| **Editor** | Tabs, split, CodeMirror 6, syntax for common languages, search/replace, go-to-file, minimap off by default, inline diff decorations for agent edits with Accept / Reject per hunk, diagnostics gutter | CodeMirror 6, `studio-lsp`, agent `tool.result.diff` |
| **Changes** | Working tree list, per-file and per-hunk stage/unstage/discard, commit with co-author line for agent commits, amend, sign-off, pre-commit hook output | `studio-git` |
| **History** | Commit log with graph, file history, blame, compare branches, search commits | `studio-git` |
| **Branches** | Create, switch, rename, delete, merge, rebase, cherry-pick, stash, worktrees list (agents use them) | `studio-git` |
| **Remotes & PRs** | Fetch/pull/push, upstream tracking, GitHub device-flow login, create PR from branch, PR list with checks, open in browser | `studio-git`, GitHub REST/GraphQL |
| **Conflicts** | Three-way conflict editor, "ask agent to resolve" action | editor + agent session with a conflict prompt |
| **Agent panel** | Modes Chat / Build / Plan / Quick fix / Review (as in CLI and web), model and thinking pickers, permission mode, `@file` `@selection` `@diff` `@problems` context chips, attachments, streaming steps, approvals inline, plan editor, Continue job | `@harness/client`, existing event reducer |
| **Agents view** | Tree of sessions and subagents per repo: status, phase, cost, worktree, diff size; focus one; cancel; approval inbox across all agents | `agent.*` events, `GET /sessions` |
| **Goals** | Goal list (draft / scheduled / running / review / done / failed), goal editor (description, acceptance criteria, budget, base branch, policy, schedule), timeline of checkpoints, resulting PR, run again | `goal.*` events, `studio-goals` |
| **Terminal** | Tabs, split, runs in repo or worktree, agent `bash` calls can open in a read-only terminal tab | `studio-pty` |
| **Preview** | Same live preview as the web app (signed `/preview/` paths) in a tab, device sizes | harness server |
| **Problems** | Diagnostics from LSP, verify failures, review findings; click to jump | `studio-lsp`, `verify.result`, `review.findings` |
| **Notifications** | OS notifications for approvals, goal checkpoints, finished runs; tray badge | Tauri notification plugin |
| **Settings** | Providers and keys (keychain), default models per role, permission defaults, verify commands, editor prefs, themes, keybindings | `cdr.config.json` + keychain |

### 3.3 Modes compared with Cursor

Cursor's Agent / Plan / Debug / Ask map onto Build / Plan / Quick fix / Chat. Review is extra. We keep CDR names and show the Cursor names as palette aliases so the muscle memory works.

---

## 4. Agents and subagents

### 4.1 Model

- A **session** is what the harness already has: one project path, one event log, one run at a time.
- A **subagent** is a child session created by the parent agent through a new `spawn_agent` tool. It has its own event log, context and budget, and is linked to the parent through `parentSessionId` and the parent's `tool.call` id.
- The UI shows an **agent tree** per repository. Selecting a node shows its conversation; the parent's conversation shows a collapsed card per child with live status and the returned summary.

### 4.2 Isolation rules

The harness holds a per-project lock (one run per project). That is right for one agent; for several it means:

| Subagent kind | Where it runs | Why |
|---|---|---|
| **Research** (read-only tools) | same checkout, no lock needed | no writes, safe to run in parallel with the parent |
| **Worker** (writes files) | its own `git worktree` under `.harness/worktrees/<session>` on a branch `cdr/<parent-slug>/<child-slug>` | writes never collide; the parent merges results back with `git merge` or by cherry-picking |
| **Verifier / reviewer** | the worker's worktree, read-only | reviews the diff where it was produced |

`spawn_agent` therefore takes `isolation: "shared" | "worktree"` and the core enforces that `shared` children get the read-only tool set. Worktree creation and merge-back are core functions (TypeScript, `git` CLI) because the agent needs them even in the CLI; the Rust git layer only displays them.

### 4.3 Tool contract

```jsonc
spawn_agent({
  task: "Add unit tests for packages/core/src/git.ts",
  role: "executor" | "planner" | "reviewer",       // picks the model role; explicit "provider/model" allowed
  isolation: "shared" | "worktree",
  tools?: ["read_file", "grep", …],                 // further restriction
  budget?: { maxTurns?: 30, maxTokens?: 200000, maxCost?: 0.5, timeoutMs?: 600000 },
  wait?: true                                        // false → returns an agent id; collect with wait_agents([...])
})
→ { ok, output: "<child's final message>", agentId, sessionId, worktree?, branch?, usage }
```

Limits: default `maxConcurrentAgents: 3`, depth ≤ 2, child budgets capped by the parent's remaining budget. Cancelling a parent cancels its children. All of this is configurable under `agents` in `HarnessConfig`.

### 4.4 Events (added to `EventBody`)

```ts
| { type: "agent.spawned"; agentId: string; sessionId: string; parentToolCallId: string; task: string; role: string; isolation: "shared" | "worktree"; worktree?: string; branch?: string }
| { type: "agent.status"; agentId: string; status: SessionStatus; phase?: Phase; usage?: { inputTokens: number; outputTokens: number; cost?: number } }
| { type: "agent.finished"; agentId: string; status: RunStatus; summary: string; diffStat?: string }
```

The child session emits its own full log; these three events live in the parent log so the parent's UI card and the tree can render without opening the child. `reduceSession` and the CLI `Renderer` learn them; schemas are regenerated.

---

## 5. Goals and autonomous runs

### 5.1 What a goal is

```jsonc
{
  "id": "goal-20261104-abc",
  "title": "Add CSV export to reports",
  "description": "…free text, may reference files…",
  "acceptance": ["pnpm test passes", "GET /reports.csv returns 200 with headers", "README documents the flag"],
  "repo": "/home/you/code/app", "baseBranch": "main",
  "budget": { "maxCost": 2.0, "maxTokens": 2000000, "timeoutMs": 7200000, "maxRounds": 6 },
  "policy": { "permissionMode": "auto", "bash": { "deny": ["git push*"] }, "network": false },
  "models": { "executor": "deepseek/deepseek-flash", "reviewer": "deepseek/deepseek-v4-pro" },
  "deliverable": "pull-request" | "branch" | "patch",
  "schedule": null | { "at": "2026-11-05T02:00:00Z" } | { "cron": "0 2 * * 1-5" }
}
```

Goals are files in `.harness/goals/<id>.json` next to sessions, so the CLI (`cdr goal run <file>`) and the desktop app share them.

### 5.2 Runner

1. Create a worktree `.harness/worktrees/<goal-id>` on branch `cdr/goal-<slug>` from `baseBranch`.
2. Create a session in that worktree with the goal's policy and models; emit `goal.started`.
3. Run the **`autonomous` workflow**: plan (no gate, but the plan is saved and shown), execute with fresh context per step, verify, review. The review phase additionally checks each acceptance criterion and returns `{ criterion, met, evidence }`.
4. After each verified step commit a **checkpoint** on the goal branch; emit `goal.checkpoint { commit, step, summary, usage }`. Checkpoints are the unit the UI shows on the timeline and the unit a user can roll back to.
5. If criteria are unmet and budget remains, start another round with the unmet criteria as the task. Stop on: all criteria met, budget exhausted, `maxRounds`, an unrecoverable error, or a human pause.
6. Finish: write the report, push the branch and open a draft PR when `deliverable` is `pull-request` and the user has connected GitHub (push happens from the Rust side with the user's credentials, never from the agent), emit `goal.finished`.
7. The user reviews in the **Goal review** screen: timeline, diff per checkpoint, verify and review output, cost; actions Merge, Request changes (starts another round with feedback), Discard (removes worktree and branch).

### 5.3 Guard rails

- Autonomous goals always run in a worktree, never in the user's checkout, and never push except through the explicit deliverable step.
- Budgets are enforced by the existing loop budgets plus a goal-level total; exceeding any budget pauses the goal in state `needs-attention`, it never silently continues.
- Permission mode `ask` inside a goal turns a permission request into a notification and pauses the goal; `auto` is the default, `yolo` is refused for scheduled goals.
- Every goal event is in the session log; the Rust scheduler only decides *when* to start, the harness decides *what* happens.

### 5.4 Events and API

```ts
| { type: "goal.started"; goalId: string; title: string; worktree: string; branch: string; round: number }
| { type: "goal.checkpoint"; goalId: string; commit: string; step: string; summary: string; criteria: { criterion: string; met: boolean; evidence?: string }[] }
| { type: "goal.paused"; goalId: string; reason: "budget" | "permission" | "user" | "error"; detail?: string }
| { type: "goal.finished"; goalId: string; status: RunStatus; prUrl?: string; branch: string; summary: string }
```

Server: `GET/POST /goals`, `GET /goals/:id`, `POST /goals/:id/{run,pause,resume,discard}`, `GET /goals/:id/events` (SSE, same envelope). Scheduling (`at`, `cron`) is done in Rust while the app runs; a later milestone adds `cdr goals daemon` so goals run without the app open.

---

## 6. Harness changes required (TypeScript)

| Change | Package | Notes |
|---|---|---|
| `agent.*`, `goal.*` event types; `agents` and `goals` config; `parentSessionId` on `SessionInfo` | protocol | regenerate schemas |
| `spawn_agent`, `wait_agents` tools; child session creation; worktree helpers (`createWorktree`, `removeWorktree`, `mergeWorktree`) in `git.ts`; concurrency and depth limits; cancel propagation | core | tests with `MockProvider`: child receives task, parent gets summary, lock not taken for `shared`, worktree created for `worktree` |
| `autonomous` workflow; acceptance-criteria review prompt; checkpoint commits; goal runner (`runGoal`) | core | reuse `runWorkflow`; criteria result is structured JSON like review findings |
| `/goals` endpoints; `GET /sessions?parent=`; `GET /sessions/:id/tree`; random port + token passed via env for sidecar mode (`--port 0 --token-env`) ; `--print-port` | server | token still never logged |
| `reduceSession` handles new events; agent tree selector; goal selectors | client / react | |
| CLI `Renderer` shows subagent cards; `cdr goal new|run|list|review`; `cdr serve --sidecar` | cli | the CLI remains a full client of every feature so nothing is desktop-only |
| Extract `apps/web/src/components/*` into `packages/ui` | web | the web app keeps working; the desktop imports the same package |

---

## 7. Rust components

| Crate | Key dependencies | Responsibilities | Tests |
|---|---|---|---|
| `studio-app` | tauri 2, tauri-plugin-shell, -store, -notification, -updater, tauri-specta, tokio | window and menu, sidecar supervisor (spawn, health poll, restart with backoff, kill on exit), command registry, event bridging to the webview, deep links `cdr://clone?url=` | integration test that starts a mock sidecar and verifies restart |
| `studio-git` | gix (gitoxide) for read paths, git2 for write paths until gix covers them, `git` CLI fallback for clone/push/fetch with credential helpers | status with rename detection, hunk-level stage/unstage, commit graph pagination, blame, branches/remotes/stash/worktrees, conflict markers parsing, credential helper bridge to `studio-keys` | fixtures repos built in temp dirs; property tests for hunk application |
| `studio-pty` | portable-pty, vt100 (server-side) or xterm.js (webview) | shells per repo/worktree, resize, scrollback, kill | spawn echo, resize, kill |
| `studio-watch` | notify, ignore (gitignore-aware) | debounced change events for explorer, editor reload, git status invalidation | create/modify/delete, ignore `.git` and `node_modules` |
| `studio-lsp` | tokio, lsp-types, serde_json | start language servers from a registry (typescript-language-server, rust-analyzer, pyright, gopls), route JSON-RPC between editor and server, diagnostics cache for the Problems view and for `@problems` context | fake LSP server over stdio |
| `studio-index` | rusqlite, tantivy (phase 2), ignore | recent repos, open tabs per repo, file list cache, fuzzy file search; later symbol index | temp DB tests |
| `studio-goals` | tokio, cron parser, reqwest (GitHub API) | goal scheduler, GitHub device flow, PR creation, notifications | mocked GitHub via local HTTP server |
| `studio-keys` | keyring | store provider keys, GitHub token, harness token; export them to the sidecar's environment only | round trip with the in-memory backend |

Secrets: keys live in the OS keychain, are injected into the sidecar's environment at spawn, and are never written to config files or logs. The harness already strips provider keys from shell environments and redacts them from events.

---

## 8. Milestones

Each milestone ends with `pnpm build && pnpm test && pnpm lint && cargo test` green and a short demo recorded in `docs/desktop.md`.

| # | Milestone | Deliverables | Done when |
|---|---|---|---|
| **D0** | Skeleton | Cargo workspace, `studio-app` with an empty window, Vite webview, `tauri-specta` bindings, CI job for Linux, sidecar supervisor starting `@harness/server` on a random port with a token in env, `packages/ui` extracted and `apps/web` still green | The app opens, shows the web Home screen from `packages/ui`, creates a sandbox session and runs "create a snake game" end to end through the sidecar |
| **D1** | Repository & editor | Open folder, recent repos, explorer with watcher, CodeMirror editor with tabs and search, terminal tab, command palette, status bar | Edit a file and run `pnpm test` in the built-in terminal; agent `@file` and `@selection` chips send the right context |
| **D2** | Git: changes, commit, history | `studio-git` status/stage/hunks/commit/log graph/blame, Changes and History views, agent edits shown as inline diffs with Accept/Reject | A full agent run's edits can be reviewed hunk by hunk and committed from the app; history shows the commit with the graph |
| **D3** | Git: remotes, branches, GitHub | Clone dialog (URL, GitHub picker after device-flow login), fetch/pull/push, branch create/switch/merge/rebase, stash, PR create and PR list, conflict editor with "ask agent to resolve" | Clone a GitHub repo, let the agent make a change on a branch, push and open a PR without leaving the app |
| **D4** | Subagents | `spawn_agent`/`wait_agents` in core with tests, worktree isolation, `agent.*` events, agent tree view, approvals inbox, cancel propagation, CLI rendering | A Build task that spawns two worker subagents in worktrees completes, the parent merges both branches, the tree shows all three with cost and status; identical event logs from CLI and app |
| **D5** | Goals | Goal files, `autonomous` workflow, acceptance-criteria review, checkpoints, goal runner in core, `/goals` API, Goals view and Goal review screen, scheduler and notifications in Rust, `cdr goal` CLI | A goal with three criteria runs unattended under a cost budget in a worktree, produces checkpoints, opens a draft PR, and the review screen allows Merge / Request changes / Discard |
| **D6** | Language intelligence & polish | `studio-lsp` with TypeScript and Rust servers, Problems view, `@problems` context, diagnostics to the agent after edits (`afterEdit` hook output already exists), themes and keybindings settings, split editors | Diagnostics appear while typing and after agent edits; the agent receives failing diagnostics in tool results |
| **D7** | Release | Auto-update, code signing (macOS notarisation, Windows), AppImage/deb/dmg/msi, crash reporting opt-in, onboarding (keys, GitHub, first repo), docs | Fresh machine: download, install, connect a provider key, clone a repo, run a goal |

Rough effort with one engineer plus the harness: D0–D2 about 4 weeks, D3–D5 about 6 weeks, D6–D7 about 4 weeks. Subagents (D4) can start as soon as D0 is done because they are mostly harness work.

---

## 9. Testing strategy

- **Rust**: unit tests per crate; git tests build throwaway repos; LSP and GitHub tests use fake servers on localhost. No test touches the network.
- **Harness**: new behaviour tested with `MockProvider` as today. Event-log equivalence test extended: the same subagent task from CLI and from the app yields identical logs.
- **UI**: `packages/ui` components tested with the existing vitest setup; the desktop app gets a WebDriver (`tauri-driver`) suite on Linux covering open repo, run agent, approve permission, stage and commit, create goal.
- **Evals**: `evals/tasks` gains multi-agent and goal tasks so model regressions in planning subagents show up in `cdr eval`.

---

## 10. Security and safety

- Sidecar binds `127.0.0.1`, random port, per-launch token held in memory and the keychain; the webview gets the token through Tauri IPC, never through a URL.
- Tauri capability allow-list: the webview may call only the registered commands; `shell:open` for URLs only; file-system access goes through Rust commands that enforce the repo root.
- Agents remain confined by the harness: `resolveInProject`, permission policy, bwrap where available. Worktrees sit inside `.harness/` of the repo, which is gitignored by `cdr init`.
- Push, PR creation, and credential use happen only on explicit user action or an explicit goal deliverable step, from Rust, with the user's token.
- Preview iframe keeps its opaque origin; CSP on the webview forbids remote scripts except the preview frame.

---

## 11. Open decisions

| # | Question | Recommendation |
|---|---|---|
| D1 | Tauri webview versus pure-Rust GUI | Tauri now; the IPC contract and Rust crates are UI-agnostic, so a gpui/Dioxus front end later is possible |
| D2 | How to ship the Node sidecar | Bundle a Node 22 runtime per platform plus built `dist/` (about 50 MB). Alternative: Node single-executable build. Requiring a system Node is acceptable for the first Linux builds only |
| D3 | Editor: CodeMirror 6 versus Monaco | CodeMirror 6: smaller, better touch and theming, LSP client available; Monaco gives VS Code feel but is heavier and fights the webview CSP |
| D4 | Git library: gix versus git2 | gix for reads (fast status, log), git2 for writes until gix stabilises them; shell out to `git` for clone/fetch/push to reuse the user's credential helpers and SSH agent |
| D5 | Subagent persistence | Child sessions as separate JSONL logs (chosen) versus inlined in the parent log; separate logs keep resume and the per-project lock simple |
| D6 | Goal scheduling without the app | Later `cdr goals daemon`; desktop scheduler first |
| D7 | Name | "CDR Studio" for the app, `cdr-studio` binary; keep `cdr` for the CLI |

---

## 12. First steps

1. Confirm D1 and D2 with the maintainer.
2. D0: Cargo workspace, Tauri shell, sidecar supervisor, `packages/ui` extraction (web app unchanged in behaviour).
3. In parallel, harness work for D4: protocol events, `spawn_agent` with `MockProvider` tests, worktree helpers.
4. Write `docs/desktop.md` as the living user and developer guide once D0 lands.
