# Protocol

Types: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts). JSON schemas: [`events.schema.json`](../packages/protocol/schema/events.schema.json), [`config.schema.json`](../packages/protocol/schema/config.schema.json) (regenerate with `pnpm --filter @harness/protocol schema`).

## Event envelope

```json
{ "v": 1, "seq": 42, "ts": "2026-11-04T15:00:00.000Z", "sessionId": "20261104150000-abc123", "type": "tool.call", "...": "..." }
```

`seq` is monotonic per session and is the SSE `id`, so `Last-Event-ID` / `?after=<seq>` resumes a stream without gaps.

## Event types

| Type | Meaning |
|---|---|
| `session.created` | projectPath, workflow, title, models, permissionMode, `parentSessionId` (subagent), `goalId` (goal run) |
| `session.settings` | model / permission / title changes (re-applied on resume) |
| `preview.ready` | the agent called `set_preview` (path of an HTML file in the project) |
| `run.start` | a workflow run started (task, workflow) |
| `phase.start` / `phase.end` | plan, execute, verify, review, finish (+ round, ok) |
| `message.start` / `message.delta` / `message.end` | streamed assistant text (`role: "user"` for user input; `message.end.text` is the full text) |
| `reasoning.delta` | reasoning tokens (DeepSeek reasoner, Claude thinking, Ollama thinking) |
| `tool.call` / `tool.result` | id, name, args / ok, output (truncated, redacted), diff |
| `permission.request` / `permission.resolved` | id, tool, args, risk / decision (`auto` when auto-approved) |
| `question` / `question.answered` | `ask_user` |
| `plan.proposed` / `plan.decision` | plan gate (approve, reject + feedback → re-plan, edit + markdown) |
| `todo.update` | the agent's checklist |
| `verify.result` | kind, command, exitCode, output, attempt |
| `review.findings` | `{severity, file, line, issue, suggestion}[]` |
| `usage` | input/output tokens, cost (if prices configured), model |
| `memory.saved` | fact saved via `remember` |
| `skill.activated` | skill injected because its triggers matched the task (`name`, `description`, `source`, `content`, `files`) |
| `status` | idle, running, waiting, done, failed, cancelled |
| `log` / `error` | diagnostics |
| `done` | success, failed, cancelled + summary, reportPath |
| `context.append` / `context.replace` | internal (resume); hidden from SSE by default |
| `agent.spawned` | (parent log) a subagent started: agentId, child `sessionId`, `parentToolCallId`, task, role, isolation `shared`\|`worktree`, worktree?, branch? |
| `agent.status` | (parent log) child status change, phase change, or usage update (at most once per second): status, phase?, usage? |
| `agent.finished` | (parent log) status (success/failed/cancelled), summary (child's final message), diffStat? (worktree children) |
| `goal.started` | (goal session) a round started: goalId, title, worktree, branch, round |
| `goal.checkpoint` | (goal session) checkpoint commit after a successful round: commit, step (`round N`), summary, criteria `{criterion, met, evidence?}[]` |
| `goal.paused` | (goal session) reason `budget` (incl. maxRounds), `permission` (waiting for an approval in `ask` mode; the run continues once answered), `user`, `error`; detail? |
| `goal.finished` | (goal session) status, branch, summary, prUrl? (never set by the harness; push/PR happen outside) |

A child session has its own full log; answer its `permission.request`/`question` events through the child's session id (`POST /sessions/<childId>/permissions/:reqId`). While a child waits, the parent's `agent.status` shows `waiting`.

## HTTP API

All endpoints except `/health` require `Authorization: Bearer <token>` (or `?token=`).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/health` | | `{ ok, version, sessions }` |
| GET | `/models` | `?projectPath=` | `{ models, providers, workflows }` |
| POST | `/sessions` | `{ projectPath, workflow?, models?, permissionMode?, title? }` | `SessionInfo` (201) |
| GET | `/sessions` | `?parent=<id>` (only direct subagents of that session) | `{ sessions }` |
| GET | `/sessions/:id/tree` | | `{ session, children: [{ session, children }…] }` (subagents, recursive) |
| GET | `/sessions/:id` | `?events=false` | `SessionInfo + { pending, todos, events }` |
| POST | `/sessions/:id/messages` | `{ text, mode?: "chat"\|"task", workflow? }` | 202; 409 if running |
| GET | `/sessions/:id/events` | `Last-Event-ID` or `?after=`, `?internal=true` | SSE stream (`event: <type>`, `id: <seq>`) |
| POST | `/sessions/:id/permissions/:reqId` | `{ decision: "allow"\|"deny"\|"always" }` | `{ ok }` |
| POST | `/sessions/:id/answers/:qId` | `{ answer }` | `{ ok }` |
| POST | `/sessions/:id/plans/:planId` | `{ decision: "approve"\|"reject"\|"edit", markdown?, feedback? }` | `{ ok }` |
| POST | `/sessions/:id/cancel` | | `{ ok }` |
| GET | `/sessions/:id/files` | `?path=` | `{ files }` or `{ path, content }` |
| GET | `/sessions/:id/diff` | | `{ diff }` (git working tree vs HEAD + untracked) |
| GET | `/sessions/:id/raw` | `?path=` | file bytes (e.g. image attachments) |
| POST | `/sessions/:id/settings` | `{ models?, permissionMode?, title? }` | `SessionInfo` (recorded as `session.settings`) |
| DELETE | `/sessions/:id` | | `{ ok }` (409 while running) |
| GET | `/preview/<id>~<sig>/<path>` | | project files for the live preview; authorised by the HMAC-signed path (no token), `previewBase` comes from `GET /sessions/:id` |
| POST | `/commit-message` | `{ projectPath, model? }` | `{ message, scope: "staged"\|"all", model }`: a commit message for the staged changes (or all changes when none are staged); 400 when there are no changes |
| GET | `/browse` | `?path=` | `{ path, parent, home, dirs[] }` – folder picker, limited to `allowedRoots` or the home dir |
| GET | `/models` | `?remote=true` | `{ available: { provider: { models, error? } } }` |
| GET | `/goals` | `?repo=` | `{ goals: GoalInfo[] }` (every repo in `~/.harness/goals-index.json`, filtered by `allowedRoots`) |
| POST | `/goals` | `CreateGoalRequest` (`GoalDef` without `id`; `title`, `repo` required) | `GoalInfo` (201), status `draft` or `scheduled` |
| GET | `/goals/:id` | | `GoalInfo` |
| PUT | `/goals/:id` | `UpdateGoalRequest` (any `GoalDef` field except `id`, `repo`) | `GoalInfo`; 409 while running or when done/discarded |
| POST | `/goals/:id/run` | | `GoalInfo` (202, status `running`, `sessionId` set); runs in the background |
| POST | `/goals/:id/pause` | | `{ ok, wasRunning }` (cancels the goal's session; status `needs-attention`) |
| POST | `/goals/:id/discard` | | `GoalInfo` (worktree and branch removed, status `discarded`) |
| POST | `/goals/:id/merge` | | `GoalInfo` (status `done`); 409 `{ error, conflicts? }` on merge conflict |
| POST | `/goals/:id/changes` | `{ feedback }` | `GoalInfo` (202): another run with the feedback |
| DELETE | `/goals/:id` | | `{ ok }` (removes the goal file and its worktree, keeps the branch) |

Goal errors: 400 invalid input, 404 unknown goal, 409 state conflict. Goals are stored as `<repo>/.harness/goals/<id>.json`; follow a run by subscribing to `GET /sessions/<goal.sessionId>/events`.

`POST /sessions` without `projectPath` (or with `sandbox: { name }`) creates a sandbox workspace. `POST /sessions/:id/messages` also accepts `attachments: [{ name, mimeType, data(base64) }]` (≤ 20 files, ≤ 10 MB each). `GET /` and other non-API paths serve the web app when the server has a `staticDir`.

## Sidecar mode

`cdr serve --port 0 --token-env CDR_TOKEN --ready-json [--static <dir>] [--origin tauri://localhost --origin http://tauri.localhost]` binds a random port, reads the bearer token from the named environment variable (never printed, nothing persisted), and prints exactly one line on stdout once listening: `{"ready":true,"url":"http://127.0.0.1:<port>","port":<port>}`. All other output goes to stderr. `--origin` replaces the default CORS allow-list.
