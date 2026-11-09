# Keeping agents under control

This document explains what an "agent" is in CDR, where each one comes from, what it costs while it runs and after it stops, and how to stop, inspect and clean it up. It also lists the places where the user does not yet have full control, the rules we hold ourselves to, and how to run many agents at once (a swarm) without losing track of them.

It describes the code as of November 2026. Sections 1 to 6 are how things work today. Section 7 lists the gaps and which are closed. Sections 8 to 10 are the rules and the plan.

## 1. The short answer

- **A row in the conversation list is a saved conversation, not a running program.** Each row is one JSONL event log in `~/.harness/sessions/`. A row with a green dot is finished or idle: it uses no CPU, no memory and no tokens. It only takes disk space.
- **Only rows under "Running" are active**: a pulsing dot (running) or an amber dot (waiting for you). The status bar's "N agents working" counts exactly those, and the Running section lists all of them, in any folder.
- **Nothing creates conversations on its own.** Every row was started by a person sending a message, by an agent calling `spawn_agent`, or by a goal. Section 3 lists every path.
- **All agents of one app window run inside one Node process**, the harness server (`cdr serve`) that the desktop app starts. There is not one process per agent. Quitting the app stops that server and every run in it.
- **The list never shrinks by itself.** Delete conversations you no longer need with the × on their row in the chat view's list (section 5). With no folder open, every new conversation creates a new sandbox, so the list grows quickly.

## 2. Terms

| Term | What it is | Where it lives |
| --- | --- | --- |
| **Conversation** (session) | One event log. Everything an agent did is an event in it. | `~/.harness/sessions/<id>.jsonl` |
| **Run** | One period in which a conversation's agent loop is working: from a user message (or goal round) until it finishes, fails or is stopped. A conversation has many runs over its life, at most one at a time. | In memory, in the harness server |
| **Agent** | The model loop of a run. "Agent" in the UI usually means "conversation". | [`core/src/loop.ts`](../packages/core/src/loop.ts) |
| **Subagent** (helper) | A child conversation created by `spawn_agent`. It has its own log with `parentSessionId` set and lives only as long as its parent's run. | [`core/src/agents.ts`](../packages/core/src/agents.ts) |
| **Goal** | An unattended job with acceptance criteria and a budget. It runs rounds of the `autonomous` workflow in its own conversation and worktree. | [`core/src/goals.ts`](../packages/core/src/goals.ts), `<repo>/.harness/goals/` |
| **Sandbox** | A fresh folder created for a conversation that was started with no folder open. | `~/.harness/sandboxes/<slug>-<id>/` |
| **Worktree** | A second checkout of a repository on its own branch, used by writing subagents and by goals. | `<repo>/.harness/worktrees/` |
| **Harness server** | The Node process that owns runs. The desktop app starts one per window; `cdr` in a terminal is another. | [`server/src/index.ts`](../packages/server/src/index.ts), [`studio-app/src/sidecar.rs`](../crates/studio-app/src/sidecar.rs) |

## 3. Where agents come from

These are all the ways a conversation is created. There is no background job that adds any.

| Origin | Trigger | How to recognise it | Folder it works in |
| --- | --- | --- | --- |
| You, with a folder open | First message of a new conversation | No parent, no goal, `projectPath` is the folder | The open folder |
| You, with no folder open | First message of a new conversation | `sandbox: true` | A new sandbox. Every new conversation gets its own. |
| You, duplicating or branching | "Duplicate" or "Branch from here" | `forkedFrom` is set, title ends in "(copy)" or "(branch)" | Same folder as the original |
| An agent | `spawn_agent` tool call during a run | `parentSessionId` is set, title starts with the role (`executor: …`) | Parent's folder (read-only helper) or a new worktree (writing helper) |
| A goal | The Goals section of the chat view's project column, `cdr goal run`, or its schedule | `goalId` is set, "goal" badge | A worktree on `cdr/goal-<slug>` |
| The CLI or the web app | `cdr`, `cdr run`, `cdr serve` | Same log folder, so it appears in the desktop app too | The folder the command ran in |
| Tests and scripts | e2e runs or any script that uses the harness against the real `~/.harness` | Often a project path that no longer exists | Usually a temp folder |

Scheduled goals start only while the desktop app is open. Subagents can only be created during a run, and only by an agent that has the `spawn_agent` tool.

## 4. What an agent costs

### 4.1 Status

| Dot | Status | Meaning | Active? |
| --- | --- | --- | --- |
| Pulsing accent | `running` | The agent loop is working | Yes |
| Amber | `waiting` | The run is paused on a permission request, a question or a plan approval | Yes, it holds its lock and waits for you |
| Green | `idle`, `done` | Nothing is running | No |
| Red | `failed` | The last run ended with an error | No |
| Grey | `cancelled` | The last run was stopped | No |

A log whose last status says `running` but whose owner process is gone is shown as `idle`. The harness checks the project lock and whether its process is alive ([`session-store.ts`](../packages/core/src/session-store.ts), [`lock.ts`](../packages/core/src/lock.ts)), so a crash never leaves a conversation that looks alive.

### 4.2 Resources

| Resource | While running | After it stops |
| --- | --- | --- |
| Process | None of its own. It is an async loop inside the harness server. | None |
| CPU and memory | Low for the loop itself, which mostly waits on the model's response. Shell commands the agent starts are real child processes, and a preview check starts a headless browser for its duration. | The conversation's events stay in the server's memory until it has been idle for 10 minutes with no open view, then they are released (`unloadIdleMs`) |
| Tokens and money | Every model call. This is the main cost, and it is per agent: three helpers spend three times as fast. | None |
| Project lock | A writing run holds `~/.harness/locks/<hash>.lock` for its folder, so two agents never edit the same tree | Released. After a crash the file stays, but it is ignored because its process is gone. |
| MCP servers | Connected at the first turn, one set per conversation | Closed when the conversation is released from memory (after 10 idle minutes) or deleted |
| Disk: log | Grows with every event | Stays. Long jobs reach 10 to 20 MB each. |
| Disk: sandbox | Whatever the agent builds, including `node_modules` | Stays until you delete the conversation and choose "Delete folder" |
| Disk: checkpoints | One snapshot per turn in `~/.harness/checkpoints/<project hash>/` | Stays indefinitely, except a sandbox's, which goes with its folder (gap G4) |
| Disk: worktree and branch | One per writing subagent or goal | Goal worktrees are removed on merge or discard. Subagent worktrees are removed, and their branches deleted once merged, when the parent conversation is deleted. |

When a run is stopped, shell commands are killed with their whole process group and subagents are cancelled with their parent ([`shell.ts`](../packages/core/src/shell.ts), `AgentManager.shutdown`).

### 4.3 Limits in force

| Limit | Default | Where to change it |
| --- | --- | --- |
| Turns per agent | 150 | `limits.maxTurns` |
| Active time per run | 3 hours | `limits.timeoutMs` |
| Tokens per run | No cap | `limits.maxTokens` |
| Cost per run | No cap | `limits.maxCost` |
| Running subagents per parent | 3 | `agents.maxConcurrent` |
| Subagent depth | 2 | `agents.maxDepth` |
| Writing runs per folder | 1 (project lock) | Fixed |
| Runs per conversation | 1 | Fixed |
| Running agents per server, checked when an agent spawns a subagent | 8 | `agents.maxActive` (0 turns the check off). Conversations you start are never refused. |
| Goal budget | Per goal: cost, tokens, time, rounds (4 per run) | The goal's form or `cdr goal new --budget-cost …` |

A subagent's budget is what it asked for, capped by what its parent has left. Token and cost limits already given to running siblings are reserved, so children running at the same time can never spend more than the parent has left. A child that asks for no token or cost limit gets an equal share: the remainder divided by the free slots (`agents.maxConcurrent` minus the running children). Its usage is added to the parent's budget when it finishes. All of these are set in `cdr.config.json` (see [configuration.md](configuration.md)).

With the defaults, one top-level run can have at most 3 helpers, and each writing helper can have 3 of its own: at most 12 helper agents under one run.

## 5. Controls you have today

| What you want | Desktop app | CLI or API |
| --- | --- | --- |
| See what is active | The chat view's list, **Working** and **Waiting**: every conversation with a running or waiting agent in any folder, with its origin and elapsed time. The project column (Ctrl+Shift+A) adds subagents, model and tokens. Status bar shows "N agents working". | `cdr sessions`, `GET /sessions` (`runStartedAt`, `usage`, `runner`) |
| See where a conversation came from | Origin label on its row: app, web, terminal, API, subagent, goal, copy or branch. Hover it for details. | `origin`, `parentSessionId`, `goalId`, `forkedFrom` in `GET /sessions` |
| Stop one agent | Stop button on its row, or in the conversation | `POST /sessions/:id/cancel` |
| Stop all agents | "Stop all" in the Running section | `POST /sessions/cancel-all` |
| Stop a helper tree | Stop the parent. Children never outlive their parent's run. | Same |
| Continue a run cut off by a crash or quit | The row shows "interrupted"; open it and click "Continue job" | `POST /sessions/:id/continue` |
| Answer what agents are waiting for | Under the conversation in the **Waiting** group of the chat view's list | In the terminal that owns the run |
| Limit what an agent may do | Permission mode per conversation (Ask, Auto, Yolo), allow and deny lists | `permissions` in `cdr.config.json` |
| Limit what it may spend | No control in the UI for conversations. Goals have a budget form. | `limits` in `cdr.config.json` |
| Pause, discard or merge a goal | The Goals section of the chat view's project column (Ctrl+Shift+J) | `cdr goal merge` / `discard` |
| Undo an agent's file changes | "Restore files to here" on any message | `/rewind` |
| Delete a conversation | × on its row in the chat view's list. Conversations whose folder was deleted are listed under "Folder deleted". | Web app sidebar, or `DELETE /sessions/:id[?folder=true]` |
| Delete every conversation | "Delete all" at the bottom of the chat view's list. Running conversations are kept. | "Delete all" on the web app's Conversations page |
| Stop everything | "Stop all", or quit the app. The harness server is killed with it. | Ctrl+C in the terminal |

Deleting a conversation also deletes its subagents' logs, removes their worktrees, and deletes their branches once they are merged. A worktree with uncommitted changes and an unmerged branch are kept, and the app says so. For a sandbox conversation the app then asks whether to delete the sandbox folder and its checkpoints too; it only offers this when no other conversation uses the folder, and never for a folder outside `~/.harness/sandboxes`. A running conversation cannot be deleted.

A run that belongs to another process (a second app window, or `cdr` in a terminal) is mirrored read-only. Its row says "runs in another process (pid N)". It has no Stop button here, "Stop all" does not stop it, and it must be stopped where it runs.

## 6. Auditing by hand

Until the app shows this itself, these commands answer "what exists, and what is running":

```bash
cdr sessions                                   # every conversation with its status and folder
ls ~/.harness/locks/                           # one file per folder that has (or last had) a writing run
ps -eo pid,etimes,rss,args | grep "cdr.mjs serve"   # harness servers: one per app window
du -sh ~/.harness/sessions ~/.harness/sandboxes ~/.harness/checkpoints
git worktree list                              # in a repository: agent and goal worktrees
git branch --list 'cdr/*'                      # branches left by subagents and goals
```

A lock file names the process and conversation that took it. If that process is no longer alive, the lock is stale and harmless.

Cleaning up by hand is safe when nothing is running, with two cautions. Several conversations can share one sandbox folder, so check `cdr sessions` before removing one. Removing a checkpoint store removes every "Restore files to here" point of that project.

### Example: one developer machine, 6 November 2026

The Agents view showed 24 rows with no folder open. On disk there were 35 conversation logs (160 MB), 24 of them sandbox conversations, which are the 24 rows. None was a subagent and none was running. Two logs still ended in `running` from processes that had died a day earlier; both were shown as idle, and are now marked interrupted. Disk use: 1.1 GB in 28 sandbox folders (one of them 536 MB), and 2.4 GB of checkpoints for a single project. The status bar showed "1 agent working" for a run that was real but not in the list (gap G2, now closed).

## 7. Gaps

Each gap is a place where the user could not see or control something, ordered by how much it hurt. The status column says what has been done.

| # | Gap | Status |
| --- | --- | --- |
| G1 | The Agents view listed conversations and called them agents, with no origin, and idle rows looked like successful ones. | **Closed.** Running agents are a separate section; every row carries an origin label. Older conversations created before `origin` was recorded show no label. |
| G2 | With no folder open, the view listed only sandbox conversations while the status bar counted every run, so a run in a project folder was counted but could not be found or stopped. | **Closed.** The Running section lists active runs from every folder, sandbox and worktree. |
| G3 | The desktop app could not delete a conversation. | **Closed.** × on each row, with confirmation. |
| G4 | Deleting a conversation removed only its log. Sandbox folders, checkpoints and subagent logs stayed, with no retention policy. | **Partly closed.** Subagent logs go with their parent; a sandbox folder and its checkpoints go when you choose. Still open: checkpoint retention for real projects, and a page that shows how much each kind of data takes. |
| G5 | Subagent worktrees and their `cdr/<parent>/<task>` branches were never removed. | **Closed** on delete of the parent conversation (merged branches only; dirty worktrees are kept). Still open: removing them right after a merge, while the conversation lives on. |
| G6 | No cap on running agents in total. | **Partly closed.** `agents.maxActive` (default 8) caps spawning per server process. Not covered: several app windows (one server each), and conversations you start yourself, which are never refused or queued. |
| G7 | Concurrent children could each spend the parent's whole remaining budget. | **Closed.** Children's token and cost limits are reserved from the parent's remainder when they start. The parent's own spending while children run is not reserved, so it can still exceed its cap by what it spends in that time. |
| G8 | Every conversation that was opened stayed loaded in the server, with its MCP servers connected, until the server exited. | **Closed.** Released after 10 idle minutes with no open view; reloaded on the next request. |
| G9 | A run owned by another process was mirrored without saying who owned it. | **Closed.** The row shows the owning process id. |
| G10 | Conversations whose folder was deleted were hidden from every desktop list. | **Closed.** Listed under "Folder deleted" with "Delete all". |
| G11 | No tokens, cost, elapsed time or model per agent, and no "Stop all". | **Closed.** Cost appears only for models with known prices. |
| G12 | A run cut off by a crash or quit became `idle`, and could not be continued. | **Closed.** It is marked `interrupted` and "Continue job" is offered. |

## 8. Control rules

These are the rules the product must satisfy. New agent features are checked against them.

1. **Every agent has a visible origin.** The user can always see who started it (themselves, which parent agent, which goal, which process) and when.
2. **Active and stored are never confused.** A running or waiting agent looks different from history at a glance, and the count of active agents matches what is listed.
3. **Everything counted can be reached.** If the status bar says an agent is working, one click shows it, wherever it runs.
4. **Everything running can be stopped.** One agent, one tree, or all of them, from one place. Where a run belongs to another process, the app says which one.
5. **No agent outlives its owner.** Subagents end with their parent's run, and runs end with their server. Nothing keeps working after the user believes it stopped.
6. **Spending has a ceiling.** A swarm runs under one budget that its members share, and the ceiling holds even when they run at the same time.
7. **Concurrency has a ceiling.** There is a limit on active agents per machine, not only per parent.
8. **Agents clean up after themselves.** Worktrees, branches, sandboxes, checkpoints and loaded state are removed when their conversation is removed, or by a stated retention policy. The user can see what is kept and how large it is.
9. **Agents ask rather than assume.** Anything outside a conversation's permission mode goes to the approvals inbox. Unattended runs (goals) never get more permission than their policy states.

The repository's own conventions still apply: every step is an event, UIs only render events, and no UI-only state goes into core (see [AGENTS.md](../AGENTS.md)). Origin, ownership and usage must therefore come from events, not from the app's memory.

## 9. Orchestration and swarms

There is no separate "swarm mode" yet. A swarm today is a parent agent that calls `spawn_agent` several times with `wait: false` and collects the results with `wait_agents`. The building blocks are:

| Building block | Use |
| --- | --- |
| `isolation: "shared"` | Read-only helper in the parent's checkout. Cannot edit. Takes no lock, so any number can read at once. |
| `isolation: "worktree"` | Writing helper on its own branch and checkout. Its work is committed there and the parent merges it. |
| `role` | Which model the helper uses: `executor`, `planner`, `reviewer`, or an explicit `provider/model` |
| `budget` | Turns, tokens, cost and time for that helper |
| `tools` | A narrower tool list for the helper |
| Goals | The unattended form: rounds of plan, execute, verify and review against acceptance criteria |

### 9.1 Patterns

| Pattern | Shape | Good for | Watch out for |
| --- | --- | --- | --- |
| **Scouts** | Several read-only helpers, each answering one question | Exploring a large codebase, gathering facts before a plan | Cheap. Use a small model. The parent pays to read each answer. |
| **Parallel writers** | Several worktree helpers on tasks that touch different files | Independent features, per-package migrations | Overlapping files cause merge conflicts that the parent must resolve. Split by directory. |
| **Writer and reviewer** | One writer, then a read-only reviewer with a different model | Risky changes | The `default` workflow already does this in one conversation |
| **Pipeline** | Stages run one after another, each helper given the previous result | Plan, then build, then verify | No speed gain. Use it to keep each context small. |
| **Unattended** | A goal per deliverable | Work that should finish without you | Starts only while the app is open, or from `cdr goal run` |

### 9.2 Running a swarm efficiently

- **A helper starts with no context.** It does not see the parent's conversation, so the task text must be complete. Every helper pays again to read the files it needs. Splitting a small task makes it slower and more expensive.
- **Split only work that is independent.** Parallel writers pay off when their tasks touch different files and can be verified separately.
- **Prefer read-only helpers.** They need no worktree, no lock and no merge.
- **Match the model to the job.** Scouts and mechanical edits on a small model, planning and review on a strong one.
- **Keep the tree flat.** For a swarm, set `agents.maxDepth` to 1 so helpers cannot start their own helpers. Raise `agents.maxConcurrent` instead.
- **Set a budget before starting.** Without `limits.maxCost` or `limits.maxTokens` the only stops are 150 turns and 3 hours per agent. With a parent limit, helpers that ask for none get an equal share of what is left.
- **Stay under the provider's rate limit.** More concurrent agents than the limit allows only produces retries.
- **Merge as helpers finish**, not all at the end. Conflicts are smaller and later helpers can be given the merged state.

A starting configuration for a swarm of six flat helpers under a five-dollar ceiling per run:

```json
{
  "agents": { "maxConcurrent": 6, "maxDepth": 1, "maxActive": 8 },
  "limits": { "maxTurns": 150, "maxCost": 5, "timeoutMs": 3600000 }
}
```

Keep `maxActive` above `maxConcurrent`: the parent's own run counts toward it.

### 9.3 What a real swarm mode needs

The budget reservation, the per-server cap, the live view with Stop all, and worktree cleanup on delete are in place. A swarm still cannot be handed to a user as a one-click feature, because it needs:

1. A queue instead of a refusal when `agents.maxActive` is reached, and one limit across app windows (G6).
2. A swarm summary on the parent's row: members, spend against the ceiling, and Stop for the tree. Today the tree is visible and the parent's Stop stops it, but spend is shown per row.
3. Removal of a helper's worktree and branch as soon as it is merged, not only when the conversation is deleted (G5).
4. A merge step that reports conflicts per helper instead of leaving them to the parent's judgement.

## 10. Work plan

Done (November 2026):

1. ~~List every active run in the Agents view regardless of the open folder (G2).~~
2. ~~Label each row with its origin and separate Running from history (G1). `session.created` records `origin`.~~
3. ~~"Stop all", and model, elapsed time, tokens and cost per running row (G11).~~
4. ~~Delete in the desktop app, including conversations whose folder is gone (G3, G10).~~
5. ~~Show the owning process for runs that belong to another window or terminal (G9).~~
6. ~~Delete subagent logs with their parent; offer to remove an unused sandbox folder (G4).~~
7. ~~Remove subagent worktrees and merged branches when their parent conversation is deleted (G5).~~
8. ~~Release idle conversations from the server and close their MCP connections (G8).~~
9. ~~Reserve child budgets at spawn time and cap running agents per server (G6, G7).~~
10. ~~Mark interrupted runs and offer to continue them (G12).~~

Next:

11. Checkpoint retention for real projects, and a storage page with the size of logs, sandboxes, checkpoints and worktrees (G4).
12. Remove a helper's worktree and branch right after its branch is merged (G5).
13. Queue spawns at the cap instead of refusing them, and count runs across app windows (G6).
14. Swarm mode from section 9.3.
