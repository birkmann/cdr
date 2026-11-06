# Architecture

```
 CLI (@harness/cli) ──in-process──┐            Frontend ── @harness/client ──HTTP+SSE──┐
                                  ▼                                                     ▼
                         @harness/core  ◄──────────────────────────────── @harness/server (Hono)
```

## Core objects

| Object | File | Role |
|---|---|---|
| `Harness` | `core/src/session.ts` | Creates/resumes sessions, loads `.env` + config, owns the `SessionStore`. |
| `Session` | `core/src/session.ts` | Event bus (`emit`/`subscribe` with replay), interactions (permission, question, plan gate), `chat()` and `run()`. One run at a time; per-project lock. |
| `runAgent` | `core/src/loop.ts` | The agent loop: compaction → stream → tool calls (validate → hooks → permission → execute → truncate/redact) → repeat. Budgets: turns, tokens, cost, wall clock. Repetition guard. |
| `runWorkflow` | `core/src/workflow.ts` | Phases: plan (read-only tools, gate), execute (optionally one fresh context per plan step), verify (harness-driven retries), review (structured JSON findings, one fix round for blocking ones), finish (report, optional branch commit). |
| `PermissionPolicy` | `core/src/permissions.ts` | `ask` / `auto` / `yolo`, config allow/deny (every segment of compound commands must be allowed), built-in hard-deny list, "always" grants. |
| Tools | `core/src/tools/builtin.ts` | `read_file`, `write_file`, `patch_file`, `glob`, `grep`, `list_dir`, `bash`, `run_verification`, `ask_user`, `todo`, `remember`, `forget` + `spawn_agent` / `wait_agents` (`tools/agents.ts`) + MCP tools (`mcp__<server>__<tool>`). |
| Context | `core/src/context.ts` | Phase system prompts, env block, repo map, AGENTS.md/CLAUDE.md, memory, compaction (budget from `context.maxContext` and measured usage; prune old tool output first, then an execution brief that updates the previous one; tool pairs kept intact; removed history logged to `.harness/history/`). |
| Providers | `core/src/providers/` | OpenAI-compatible (streaming tool calls, retries, auto text-protocol fallback), Anthropic Messages (prompt caching), Mock. |
| `SessionStore` | `core/src/session-store.ts` | JSONL per session in `~/.harness/sessions`; `rebuildMessages` for resume; `fork`. |

## Subagents and goals

- **Subagents** (`core/src/agents.ts`, tools in `core/src/tools/agents.ts`). The `spawn_agent` tool asks the session's `AgentManager` (reached through `ToolContext.agents`) to create a child session through the Harness's session factory, so each child has its own JSONL log with `parentSessionId` set. `isolation: "shared"` children run in the parent's checkout with the read-only tool set and skip the per-project lock; `isolation: "worktree"` children get `git worktree` `<repo>/.harness/worktrees/<parent>-<slug>` on `cdr/<parent-short-id>/<slug>` (from the parent's HEAD), take their own lock, and their edits are committed on that branch when they finish. A child is a single chat-style agent (`Session.runSubagent`) with the requested model role and a subagent prompt; its final message is the tool result, plus branch, worktree and diff stat. Child limits are the requested budget capped by the parent's remaining budget, and child usage is added to the parent's budget when it finishes. Limits: `agents.maxConcurrent` (default 3 running children per parent) and `agents.maxDepth` (default 2; a session at that depth has no `spawn_agent`). Cancelling the parent cancels its children, and children never outlive the parent's run. The parent's log gets `agent.spawned` / `agent.status` / `agent.finished`; `wait_agents` collects children started with `wait: false`.
- **Goals** (`core/src/goals.ts`). `GoalStore` keeps goal JSON in `<repo>/.harness/goals/` plus a repo index in `~/.harness/goals-index.json`. `startGoal` runs rounds of the `autonomous` workflow in a dedicated worktree session and records `goal.*` events in that session (see [workflows.md](workflows.md)). The server exposes `/goals`; the CLI has `cdr goal new|list|run|merge|discard`.

## 1:1 recreation

`recreate_*` tools, `cdr recreate` and `POST /sessions/:id/recreate` all drive `@harness/recreate`. The pipeline builds on packages that know nothing about providers or sessions: `@harness/capture` (CDP driver, in-page DOM walker, SSRF guard, live shots), `@harness/scene` (Snapshot → Scene, sections), `@harness/extract` (component sets, naming plans, lint), `@harness/codegen` (emitters) and `@harness/measure` (pixel, text, interactions, compare page). Core supplies the host: progress becomes `recreate.*` events, the consent gate is a self-gated `permission.request`, and naming, vision and repair calls go through `Session.complete` with the configured roles. See [recreate.md](recreate.md).

## Interactions are events

A permission prompt, `ask_user` question or plan approval is an event (`permission.request`, `question`, `plan.proposed`) plus a pending promise in the session. Whoever is attached answers it — the CLI via the terminal, the server via `POST /sessions/:id/permissions/:reqId`, `/answers/:qId`, `/plans/:planId`. `autoApprove` (CLI `--yes`, evals) answers automatically and still records the decision.

## Resume

Every message added to an agent's conversation is recorded as an internal `context.append` event (compaction records `context.replace`). `rebuildMessages(events, "chat")` reconstructs the conversation; incomplete trailing tool turns are dropped. The server hides internal events from SSE unless `?internal=true`.

## Safety

- Path confinement (realpath; rejects `..`, absolute and symlink escapes, writes into `.git`).
- Bash: hard-deny list in all modes, provider API keys removed from the child environment, process-group kill on timeout/cancel, optional `bwrap` sandbox (read-only root, writable project, no network).
- Secrets: loaded keys are registered and redacted, plus common key patterns, in every event and tool output.
- Sandboxes: `~/.harness/sandboxes/<slug>-<id>`, git-initialised; permission mode defaults to `auto`; shell runs under bwrap with network (package caches redirected to the tmpfs), and in that case risky-but-confined commands are not prompted.
- Preview: served from `/preview/<id>~<hmac>/…` and shown in an `<iframe sandbox="allow-scripts …">` without `allow-same-origin`, so generated code runs in an opaque origin and cannot read the app's token or call the API with it.
- Server: binds `127.0.0.1`, bearer token (persisted in `~/.harness/server-token`, shown once), CORS allow-list, optional `allowedRoots`.

## Deviations from the implementation plan

- File/diff helpers are scoped to a session (`/sessions/:id/files`, `/sessions/:id/diff`) instead of `/projects/:id/...` – a frontend can only read projects it has a session for.
- Plan decisions have their own endpoint (`POST /sessions/:id/plans/:planId`), not listed in the plan's table.
- Rendering is the plain streaming renderer; Ink TUI, VS Code/Electron examples are not built (M5 optional).
