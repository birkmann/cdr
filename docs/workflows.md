# Workflows

A workflow is data: a list of phases, each optionally with a model role (or explicit `provider/model`), a tool allow-list, a gate and extra system-prompt text.

| Preset | Phases |
|---|---|
| `default` | plan (gate) → execute → verify → review → finish |
| `quick-fix` | execute → verify → finish |
| `plan-only` | plan → finish |
| `review-only` | review → finish |
| `no-review` | plan (gate) → execute → verify → finish |
| `autonomous` | plan (no gate, plan saved) → execute (fresh context per step) → verify → review with acceptance criteria → finish; used by goals |

## Phase behaviour

- **plan** – read-only tools (`read_file`, `glob`, `grep`, `list_dir`, read-only `bash`, `ask_user`, `todo`). The final reply is the plan; it is saved to `.harness/plans/<date>-<slug>.md`. With `gate: true` the user approves, edits, or rejects with feedback (up to 3 re-plans).
- **execute** – all tools. Gets the task and the approved plan. With `freshContextPerStep: true` each numbered step under `## Steps` runs in a fresh context.
- **verify** – runs `verify.build/test/lint` (configured or detected). On failure the output goes back to the executor conversation; up to `verify.maxAttempts` attempts. The build failing skips tests.
- **review** – a separate agent sees task, plan, full diff (git, or snapshots in non-git projects) and verification results, and returns JSON findings. Blocking findings trigger one execute + verify round.
- **finish** – writes `.harness/reports/<date>-<slug>.md`; with `--commit` (or `commit: true`) commits on `harness/<slug>`.

A run is `success` only if nothing failed, verification passed (or no commands exist) and no blocking findings remain.

## Autonomous workflow and goals

`autonomous` runs unattended. When a run is given acceptance criteria (`RunOptions.acceptance`, set by the goal runner), the review prompt lists them and asks for an extra `criteria` array in the reviewer's JSON: `{"criterion", "met", "evidence"}` per criterion. Criteria the reviewer omits count as unmet (`parseCriteria`).

A goal (`cdr goal new "<title>" --criteria "…"`, or `POST /goals`) runs through `runGoal` / `startGoal` (`packages/core/src/goals.ts`):

1. A worktree `<repo>/.harness/worktrees/<goal-id>` on branch `cdr/goal-<slug>` from `baseBranch` (`.harness/` is added to `.git/info/exclude`).
2. A session in that worktree with `goalId` set, permission mode from `policy.permissionMode` (default `auto`; `yolo` is refused when a schedule is set), `policy.bash` added to the bash allow/deny lists, plans auto-approved and `ask_user` answered with "decide yourself".
3. Each round emits `goal.started` and runs `autonomous`. The session's limits are set to the goal's remaining budget (`maxCost`, `maxTokens`, `timeoutMs` are totals across rounds and runs).
4. A successful round is committed (`goal.checkpoint` with the criteria). All criteria met → `goal.finished` success, goal status `review`.
5. Otherwise the next round gets the unmet criteria (and reviewer evidence) as its task. A round that fails only verification also continues. Stops: budget or `maxRounds` (default 4 per run) → `goal.paused` `budget`, status `needs-attention`; cancel/pause → `goal.paused` `user`, `needs-attention`; any other failure → `goal.paused` `error` + `goal.finished` failed, status `failed`.

Actions: `pauseGoal`, `discardGoal` (removes worktree and branch), `mergeGoal` (checks out `baseBranch` in the main checkout if needed, `git merge --no-ff`, removes the worktree, keeps the branch; status `done`), `requestGoalChanges(feedback)` (another run with the feedback), `deleteGoal`. The harness never pushes or opens pull requests; `deliverable` is recorded for the desktop app, which does that.

## Custom workflow

```json
{
  "workflows": {
    "careful": {
      "name": "careful",
      "freshContextPerStep": true,
      "phases": [
        { "phase": "plan", "model": "planner", "gate": true },
        { "phase": "execute", "model": "executor", "prompt": "Write tests first." },
        { "phase": "verify" },
        { "phase": "review", "model": "anthropic/claude-sonnet-5-5" },
        { "phase": "finish" }
      ]
    }
  }
}
```

`harness run "…" -w careful`
