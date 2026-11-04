# Custom Coding Harness – Implementation Plan

Status: **implemented M0–M4 + most of M5/M6** (2026-11-04) – see "Implementation status" below.
This is the original design document for the harness. The current behaviour is described in [architecture.md](architecture.md) and the other pages in this folder.

---

## Implementation status (2026-11-04)

Language decision: TypeScript (as recommended). Docs: [README.md](../README.md) and the other pages in this folder.

| Milestone | State | Evidence |
|---|---|---|
| M0 skeleton | ✅ | pnpm workspace, tsc project refs, vitest, prettier, `.gitignore` (incl. `.env`), `AGENTS.md`; `pnpm build && pnpm test && pnpm lint` green |
| M1 loop + CLI | ✅ | OpenAI-compatible provider, all v1 tools, AgentLoop, JSONL sessions + resume/fork, CLI interactive + `run`. **Done-when met:** "add a /hello endpoint" on the sample project succeeded with `deepseek/deepseek-flash` (full workflow) and with local Ollama `local/qwen3.8:latest` (quick-fix) – tests 4/4 green in both |
| M2 verify/permissions/context | ✅ | Stack detection, verify loop with retries, ask/auto/yolo + allow/deny + hard-deny, path & symlink confinement, secret redaction, AGENTS.md/CLAUDE.md, env block, repo map, memory + `remember`, compaction, fresh-context rounds, `afterEdit`/`onStop` hooks. Self-correction within 3 attempts and refused outside writes covered by tests |
| M3 server/client/web | ✅ | Hono + SSE (Last-Event-ID replay), bearer token, CORS allow-list, per-project lock, `@harness/client`, `@harness/react`, `apps/web` (Claude-style app: home composer, attachments, history, code panel; served by `harness serve` with a login link), `harness serve`. **Done-when met:** test asserts CLI and server runs of the same task produce identical event logs; headless-Chrome e2e drives the web demo through plan approval + permission dialog |
| M4 multi-agent workflow | ✅ | Workflow engine, presets `default`/`quick-fix`/`plan-only`/`review-only`/`no-review`, custom workflows, plan gate (approve/edit/reject+feedback), reviewer JSON findings with one fix round, report + optional branch commit |
| M5 robustness | ◐ | Done: text-protocol tool fallback (incl. auto-detect on "does not support tools"), Anthropic adapter (mocked-HTTP tests only, no key available), model-role routing, cost tracking (needs `inputPrice`/`outputPrice` in provider model config), MCP client (stdio tested; HTTP transport implemented but untested), bwrap sandbox. **Not done:** Docker runner, Ink TUI, VS Code/Electron examples |
| M6 evals | ✅ | 5 tasks in `evals/` + `harness eval`. `deepseek/deepseek-flash`: quick-fix 5/5 (71k tokens); default workflow 4/5 on first run – the planner also edited the tests in task 05 whose check forbids that; the task text now says so explicitly and passes |

Deviations: UI file/diff helpers are session-scoped (`/sessions/:id/files|diff`) instead of `/projects/:id/...`; plan decisions have their own endpoint `POST /sessions/:id/plans/:planId`. DeepSeek's current model ids are `deepseek-flash` (`deepseek-chat` is an alias) and `deepseek-v4-pro`, so defaults use those.

---

## 1. Goal

Build a **provider-agnostic coding harness** that turns a plain chat model (DeepSeek, Ollama Cloud/local, OpenRouter, later Anthropic/OpenAI) into a working software engineering agent, and that can be driven from

1. the **command line** (interactive TUI-ish session and one-shot "run this task" mode), and
2. **custom frontend apps** (browser/React, Electron, VS Code webview) over a stable HTTP + streaming API.

The harness, not the model, is responsible for: context, tools, verification, permissions, workflow, memory, and observability. The same core must power both surfaces so behaviour never diverges.

### Why the raw APIs feel weak today (from the inputs)

| Missing piece | Symptom | Harness answer |
|---|---|---|
| No tools | Model only *describes* changes | File/shell tools + tool-call loop |
| No project context | Guesses stack, conventions | AGENTS.md, repo map, memory files |
| No verification | "Looks good" but doesn't compile | Build/test/lint loop with retries |
| No workflow | Runaway or half-finished changes | Plan → execute → verify → review phases |
| No memory | Re-explain everything each session | Persistent sessions + memory files |
| No guardrails | Deletes a database | Permission policy + sandbox |

Composio's comparison in the video (same model, 17 vs 22 of 25 tasks across harnesses) is the justification: harness quality is worth real engineering effort.

---

## 2. Key decisions (recommendations)

| Decision | Choice | Reason |
|---|---|---|
| Language | **TypeScript (Node ≥ 22)** monorepo | One language for core, CLI, server and frontend SDK; shared types end-to-end; frontends are JS anyway. (Python/FastAPI from the chat sketch is viable but forces a second language and duplicated types.) |
| Package manager / build | pnpm workspaces + tsup/tsc, vitest | Fast, standard. |
| Provider protocol | **OpenAI-compatible Chat Completions with tool calling** as the primary adapter | Covers DeepSeek (`https://api.deepseek.com`), Ollama (`http://localhost:11434/v1`, cloud `https://ollama.com/v1`), OpenRouter, LM Studio, vLLM. Anthropic Messages adapter later. |
| Embeddability | Core is a **library** (`@harness/core`) with no I/O assumptions about UI | CLI imports it in-process; server wraps it for remote frontends. |
| Remote transport | HTTP REST for commands + **SSE** for the event stream (WebSocket optional later) | SSE is simple, proxy-friendly, works with `fetch` everywhere. |
| Event model | Every agent step is an **append-only typed event** persisted as JSONL per session | Drives the CLI renderer, the web UI, resumability and debugging from one source of truth. |
| Edits | `patch_file` (search/replace) + `write_file`, never whole-file rewrites by default | Cheaper, safer for weak models, diffable. |
| Config | `harness.config.(json|ts)` in project + `~/.harness/config` global; `.env` for secrets | Mirrors tools like OpenCode/Claude Code; project rules in `AGENTS.md`. |

Note on `.env`: it may contain unrelated keys. The harness reads **only** the keys it is configured for and never logs them; `.env` is git-ignored.

---

## 3. Architecture

```
 ┌───────────────────────┐       ┌────────────────────────────┐
 │  CLI  (@harness/cli)  │       │ Frontend app (React/other) │
 │  in-process core      │       │ uses @harness/client       │
 └──────────┬────────────┘       └─────────────┬──────────────┘
            │ direct import                    │ HTTP + SSE (JSON events)
            ▼                                  ▼
 ┌──────────────────────┐          ┌────────────────────────────┐
 │   @harness/core      │◄─────────│   @harness/server (Hono)   │
 │                      │          │  sessions, auth, streaming │
 │  AgentLoop           │          └────────────────────────────┘
 │  Workflow (phases)   │
 │  ToolRegistry        │──► FileSystem tools (read/write/patch/glob/grep)
 │  PermissionPolicy    │──► Shell tool (bash, build, test) + sandbox
 │  ContextManager      │──► AGENTS.md, repo map, memory, compaction
 │  SessionStore        │──► ~/.harness/sessions/<id>.jsonl
 │  Providers           │──► DeepSeek / Ollama / OpenRouter / Anthropic
 │  Hooks               │──► pre/post tool, on-stop, on-edit (run tests)
 │  MCP client (later)  │──► external tool servers
 └──────────────────────┘
```

### 3.1 The agent loop (core primitive)

```
loop:
  1. ContextManager assembles messages (system prompt + rules + memory + history, compacted if needed)
  2. Provider.stream(messages, tools)  → text deltas + tool_calls
  3. for each tool_call:
       PermissionPolicy.check(call)   → allow | ask(UI) | deny
       ToolRegistry.execute(call)     → result (truncated/summarised if huge)
       Hooks.afterTool(call, result)  → may inject extra messages (e.g. test output)
  4. append results, emit events, repeat
  until: no tool calls AND stop condition satisfied (or max turns / budget hit)
```

Everything the loop does is emitted as events (`message.delta`, `tool.call`, `tool.result`, `permission.request`, `phase.change`, `verify.result`, `usage`, `error`, `done`). UIs are pure renderers of this stream.

### 3.2 Workflow phases (the "harness engineering" layer)

Default workflow for a task, each phase a separate agent run with its own system prompt and tool subset:

1. **Plan** – read-only tools (read/glob/grep/shell read-only). Output: a Markdown plan with numbered steps, files to touch, verification command. Written to `.harness/plans/<task>.md`. **User gate**: approve / edit / reject (CLI prompt or UI button). Can be skipped with `--no-plan` for small tasks.
2. **Execute** – full tools. Works through the plan step by step. Optionally **one step per fresh context** (video's "one feature per round" pattern) for long tasks: each round reloads the plan + current git state.
3. **Verify** – harness-driven, not model-driven: runs configured `build`, `test`, `lint` commands (auto-detected from `package.json`, `pyproject`, `Cargo.toml`, `go.mod`...). On failure, feeds stdout/stderr back to the execute agent. Max N attempts (default 3), then stops and reports.
4. **Review** – separate agent (ideally a stronger/reasoning model) gets: task, plan, `git diff`, verify output. Returns structured findings (`{severity, file, line, issue, suggestion}`). Blocking findings go back to Execute (one round), otherwise done.
5. **Finish** – summary, optional commit on a branch (`harness/<task-slug>`), execution report `.harness/reports/<task>.md` (the chat sketch's `harness_execution_report.md`).

Workflows are data (`workflow.ts` defining phases, tools, models, gates) so users can define their own: "quick-fix" (execute+verify only), "review-only", "plan-only", etc.

### 3.3 Tools (v1)

| Tool | Notes |
|---|---|
| `read_file(path, offset?, limit?)` | Line-numbered output, size cap. |
| `write_file(path, content)` | Creates/overwrites; confined to project root. |
| `patch_file(path, search, replace, replace_all?)` | Fails loudly on 0 or >1 matches; returns a unified diff of what changed. |
| `glob(pattern)` / `grep(pattern, path?, glob?)` | Uses ripgrep if available, fallback to JS. |
| `list_dir(path)` | Depth-limited tree. |
| `bash(command, timeout?)` | Runs in project cwd; output truncated with head/tail; denied patterns (rm -rf /, git push --force, etc.). |
| `run_verification()` | Runs configured build/test/lint; structured result. |
| `ask_user(question, options?)` | Emits a `question` event; blocks until UI answers. |
| `todo(update)` | Plan/checklist state the UI can render. |

Tool descriptions are part of the harness quality; they will be iterated using the eval set (section 7).

### 3.4 Context management

- **System prompt** per phase (short, explicit about tool etiquette: patch over rewrite, read before edit, verify before claiming done).
- **Project rules**: `AGENTS.md` (also honours `CLAUDE.md` if present) loaded from project root and parent dirs.
- **Environment block**: cwd, OS, git branch/status, detected stack, date.
- **Repo map**: on first turn, a compact directory tree (depth-limited, ignores from `.gitignore`) so the model doesn't guess paths.
- **Memory**: `.harness/memory/*.md` (project) and `~/.harness/memory/*.md` (user). The model can call `remember(fact)`; an index file is loaded each session.
- **Compaction**: token estimate per message; when > ~70 % of model context, summarise the oldest span with the model and keep the last K tool results verbatim. Also hard-truncate tool outputs (keep head+tail) before they ever enter context.
- **Fresh-context rounds** for long plans (see 3.2).

### 3.5 Permissions and safety

- Policy modes: `ask` (default), `auto` (allow reads, ask for writes outside project / risky shell), `yolo` (allow all, explicit flag).
- Rules in config: allow/deny lists per tool (`bash: allow ["npm test", "git status"], deny ["rm -rf", "git push"]`).
- Path confinement: every file tool resolves and rejects paths outside the project root (and symlink escapes).
- Shell sandbox (phase 2): optional `bwrap`/`firejail` on Linux, Docker runner, or at minimum a network-off + cwd-limited env.
- Secrets: provider keys read from env only; redact known key patterns in logs/events.
- Budgets: max turns, max tokens/cost per run, wall-clock timeout; emitted as `usage` events.

### 3.6 Providers

```ts
interface Provider {
  id: string;
  stream(req: { model, messages, tools, temperature, maxTokens }): AsyncIterable<ProviderEvent>;
  countTokens?(messages): number;   // fallback: heuristic
  capabilities: { tools: boolean; json: boolean; reasoning?: boolean; contextWindow: number };
}
```

- `openai-compatible` adapter parameterised by `baseURL`, `apiKey`, model list → covers DeepSeek, Ollama (local + cloud), OpenRouter, LM Studio, vLLM, Copilot-via-proxy.
- `anthropic` adapter (later) – Messages API, native tool use, prompt caching.
- Model roles in config: `planner`, `executor`, `reviewer`, `summarizer` can each point to a different provider/model (e.g. DeepSeek V3 for execute, a reasoning model for review, a small local model for summaries).
- Fallbacks: if a model lacks native tool calling, a **text-protocol fallback** (fenced JSON tool blocks) parsed by the harness. Important for weaker/local models.
- Retries with backoff on 429/5xx; streaming abort on cancel.

### 3.7 Sessions and events

- `SessionStore`: one JSONL file per session with every event; `resume(sessionId)` rebuilds messages. Supports `fork`.
- Event schema versioned (`v: 1`). Shared `@harness/protocol` package exports the TypeScript types + JSON schema so frontends get typed events.

### 3.8 Server (for frontends)

Framework: Hono (tiny, runs on Node/Bun/Deno). Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions` | create session `{ projectPath, workflow?, models? }` |
| `GET` | `/sessions` / `/sessions/:id` | list / inspect (events, status) |
| `POST` | `/sessions/:id/messages` | send a user message / task |
| `GET` | `/sessions/:id/events` | **SSE** stream (supports `Last-Event-ID` for reconnect) |
| `POST` | `/sessions/:id/permissions/:reqId` | answer allow/deny/always |
| `POST` | `/sessions/:id/answers/:qId` | answer `ask_user` |
| `POST` | `/sessions/:id/cancel` | abort current run |
| `GET` | `/projects/:id/files?path=` / `/diff` | read-only helpers for UI (tree, file, git diff) |
| `GET` | `/health`, `/models` | status, configured models |

- Auth: bearer token (generated on first start, printed once) – required since the server can edit files and run shell. Bind to `127.0.0.1` by default. CORS allow-list for frontend origins.
- Multiple concurrent sessions, one worker per session, per-project lock to avoid two agents editing the same tree.

### 3.9 Client SDK + frontend integration

- `@harness/client`: `createClient({ baseUrl, token })` → `createSession()`, `send()`, `events()` (async iterator over typed events, auto-reconnect), `answerPermission()`, `cancel()`. Works in browser and Node.
- `@harness/react` (thin): `useSession(id)` returning `{ messages, toolCalls, pendingPermissions, status, send }` reduced from events. Headless – no UI components, so it fits any design.
- Example app: `apps/web` (Vite + React) with chat pane, live tool-call timeline, diff viewer, permission dialog, plan approval. Serves as reference for custom frontends.

### 3.10 CLI

`harness` binary (`@harness/cli`), built on the core directly (no server needed):

- `harness` – interactive session in current dir (streamed output, tool calls collapsed/expandable, permission prompts).
- `harness run "task"` – one-shot, runs the full workflow, exits non-zero on failure; `--no-plan`, `--yes`, `--workflow quick-fix`, `--json` (emit raw events for scripting).
- `harness plan "task"` / `harness review` (review current diff) / `harness resume <id>` / `harness sessions`.
- `harness serve [--port 8787]` – starts the HTTP server for frontends.
- `harness models` / `harness config` / `harness init` (writes `harness.config.json` + `AGENTS.md` template after detecting stack).
- Rendering: Ink (React for CLIs) or a plain streaming renderer first; Ink later if interactivity is needed.

---

## 4. Repository layout

```
harness-engineering/
├─ docs/implementation-plan.md
├─ AGENTS.md                      # rules for agents working on this repo (dogfooding)
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json
├─ packages/
│  ├─ protocol/    # event + API types, JSON schemas (no runtime deps)
│  ├─ core/        # agent loop, workflow, tools, context, permissions, providers, sessions
│  ├─ server/      # Hono HTTP+SSE server wrapping core
│  ├─ client/      # browser/node SDK
│  ├─ react/       # hooks (optional, small)
│  └─ cli/         # `harness` binary
├─ apps/
│  └─ web/         # web app (served by `harness serve`)
├─ evals/          # task set + runner (section 7)
├─ docs/           # architecture, protocol, writing workflows
```

---

## 5. Milestones

Each milestone ends with something runnable. Estimates assume one developer working part-time; adjust freely.

### M0 – Skeleton (½ day)
- pnpm monorepo, TS config, vitest, eslint/prettier, `.gitignore` (incl. `.env`, `.harness/sessions`).
- `protocol` package with the event and config types.
- `AGENTS.md` for this repo.
- **Done when**: `pnpm build && pnpm test` passes on empty packages.

### M1 – Single-agent loop + CLI (2–3 days)
- `openai-compatible` provider with streaming + tool calls; config loader + `.env`; DeepSeek and Ollama verified.
- Tools: read/write/patch/glob/grep/list_dir/bash.
- AgentLoop with event emission, max-turn budget, output truncation.
- SessionStore (JSONL) + resume.
- CLI: interactive mode and `run`, plain streaming renderer, `ask` permissions in terminal.
- **Done when**: `harness run "add a hello endpoint"` on a sample project edits files correctly using DeepSeek and using a local Ollama model.

### M2 – Verification, permissions, context (2–3 days)
- Stack detection + `run_verification`; verify loop with retries fed back to the model.
- PermissionPolicy modes + config allow/deny, path confinement, bash deny patterns, secret redaction.
- AGENTS.md / CLAUDE.md loading, env block, repo map, memory files + `remember` tool.
- Compaction + fresh-context rounds.
- Hooks: `afterEdit → run tests` (configurable), `onStop`.
- **Done when**: a task that initially breaks the build gets self-corrected within 3 attempts; writes outside the project are refused.

### M3 – Server + client SDK + web demo (3–4 days)
- Hono server, SSE with reconnect, token auth, CORS, per-project locks.
- `@harness/client` + `@harness/react`.
- `apps/web`: chat, tool timeline, plan approval, permission dialog, diff view.
- `harness serve`.
- **Done when**: the same task can be driven from the web demo and from the CLI with identical event logs.

### M4 – Multi-agent workflow (2–3 days)
- Workflow engine with phases, gates, per-phase models/tools.
- Planner (read-only, Markdown plan, user gate), Reviewer (structured findings on `git diff`), Finish (report + optional branch/commit).
- Workflow presets: `default`, `quick-fix`, `plan-only`, `review-only`; custom workflows in config.
- **Done when**: `harness run` shows plan → approval → execute → verify → review → report end-to-end.

### M5 – Robustness & extensibility (ongoing)
- Text-protocol tool fallback for models without native tool calling.
- Anthropic provider; model-role routing; cost tracking.
- MCP client (stdio + HTTP) so external tool servers appear as normal tools.
- Sandbox runner (bwrap / Docker).
- Ink-based TUI polish; VS Code webview / Electron example using `@harness/client`.

### M6 – Evaluation loop (parallel from M2 on)
- See section 7. The eval numbers decide prompt/tool wording and defaults.

---

## 6. Protocol sketch (shared types)

```ts
type Event =
  | { type: "session.created"; sessionId; projectPath; workflow }
  | { type: "phase.start" | "phase.end"; phase: "plan"|"execute"|"verify"|"review"|"finish"; round?: number }
  | { type: "message.start"; role: "assistant"|"user"; id }
  | { type: "message.delta"; id; text }
  | { type: "message.end"; id }
  | { type: "tool.call"; id; name; args }
  | { type: "tool.result"; id; ok: boolean; output; truncated?: boolean; diff?: string }
  | { type: "permission.request"; id; tool; args; risk: "low"|"medium"|"high" }
  | { type: "permission.resolved"; id; decision: "allow"|"deny"|"always" }
  | { type: "question"; id; text; options? }
  | { type: "plan.proposed"; markdown; path }
  | { type: "plan.decision"; decision: "approve"|"reject"|"edit"; markdown? }
  | { type: "verify.result"; command; exitCode; output; attempt }
  | { type: "review.findings"; findings: Finding[] }
  | { type: "usage"; inputTokens; outputTokens; cost? }
  | { type: "error"; message; recoverable }
  | { type: "done"; status: "success"|"failed"|"cancelled"; reportPath? };
```

Config (`harness.config.json`):

```jsonc
{
  "providers": {
    "deepseek": { "type": "openai-compatible", "baseURL": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY" },
    "ollama":   { "type": "openai-compatible", "baseURL": "https://ollama.com/v1",     "apiKeyEnv": "OLLAMA_API_KEY" },
    "local":    { "type": "openai-compatible", "baseURL": "http://localhost:11434/v1" }
  },
  "models": {
    "executor": "deepseek/deepseek-chat",
    "planner":  "deepseek/deepseek-reasoner",
    "reviewer": "deepseek/deepseek-reasoner",
    "summarizer": "local/qwen3:8b"
  },
  "verify": { "build": "pnpm build", "test": "pnpm test", "lint": "pnpm lint", "maxAttempts": 3 },
  "permissions": { "mode": "ask", "bash": { "allow": ["pnpm *", "git status", "git diff*"], "deny": ["rm -rf *", "git push*"] } },
  "workflow": "default",
  "limits": { "maxTurns": 60, "maxTokens": 400000 }
}
```

---

## 7. Evaluation (how we know the harness is good)

- `evals/tasks/*.json`: 15–25 small, reproducible tasks on fixture repos (add endpoint, fix failing test, refactor, write tests, multi-file feature), each with a programmatic check (tests pass, file contains X, no diff outside allowed paths).
- `harness eval --model deepseek/deepseek-chat --workflow default` runs them in isolated temp copies, records pass rate, turns, tokens, wall time, cost → `evals/results/<date>.json`.
- Use it to compare: models, system-prompt wording, tool descriptions, plan vs no-plan, verify attempts. This mirrors the Composio comparison from the video and prevents "feels better" regressions.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Weak models mis-format tool calls | Text-protocol fallback, strict arg validation with helpful error returned to the model, `patch_file` that reports near-miss context. |
| Context rot on long tasks | Fresh-context rounds per plan step, aggressive tool-output truncation, plan/memory in files. |
| Agent damages the machine | Path confinement, deny lists, `ask` default, sandbox runner, git branch per task. |
| Server exposes file/shell access | Localhost bind + bearer token by default; document the threat model before any remote deployment. |
| Scope creep (MCP, TUI, VS Code) | Everything after M4 is optional; core + CLI + server + SDK is the deliverable. |
| Provider API drift / rate limits | Thin adapters, retries, model-role routing so one provider outage doesn't block all phases. |

---

## 9. Immediate next steps

1. Confirm the language choice (TypeScript recommended; Python possible with the same architecture).
2. Add `.gitignore` with `.env`, commit M0 skeleton.
3. Implement M1 against DeepSeek first (keys already present), then verify with Ollama local.
4. Write 5 eval tasks early (M2) so every later change is measured.
