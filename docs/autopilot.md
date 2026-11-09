# Autopilot

Autopilot runs the chain **URL → mirror → design system → 1:1 replica** across a list of sites, collects what went wrong as findings with stable signatures, starts fixer agents in git worktrees, and keeps a fix only if the whole matrix does not regress, the finding is gone and the fix leaves a guard behind. Everything is a terminal command. The design and the reasoning are in [plans/autopilot-self-improving-pipeline.md](plans/autopilot-self-improving-pipeline.md).

```bash
pnpm build
pnpm autopilot freeze --sites bvg,vw,ibm,bmw       # capture each site once
pnpm autopilot run --stages mirror                 # run the matrix (about 2 hours)
pnpm autopilot inspect                             # FINDINGS.md: what is broken, and where
pnpm autopilot loop --max-cycles 5 --budget-usd 50 # or: let it fix things overnight
```

## Before you start

| You need                                                       | Why                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 22, pnpm, Chrome                                          | the build, the runs and the browser checks                                                                                                           |
| `pnpm build`                                                   | `pnpm autopilot` runs the built CLI, and every candidate branch is rebuilt the same way                                                              |
| A provider key (`.env` or `~/.harness/.env`)                   | mirror fixes, naming and every fixer goal call models                                                                                                |
| The pipeline **committed**                                     | fixers work in git worktrees, so anything uncommitted is missing from them. `fix` and `loop` refuse to start while `packages/autopilot` is untracked |
| A checkout on a branch, with no edits to the files fixes touch | accepted fixes are merged into that branch with `git merge --no-ff`, and autopilot commits its own bookkeeping there                                 |
| `autopilot/sites.yaml`                                         | the matrix and the holdout. Change it to run other sites                                                                                             |

**The sites.** Every site has an owner. Snapshots, mirrors and replicas stay in the gitignored `.harness/` and are for evaluating the pipeline. Autopilot answers the consent gate with `--yes`, as `cdr recreate --yes` does, and logs it.

## Commands

All of them exit 0 only when their own verdict is good, so they compose in scripts. `--cwd <dir>` names the repository root.

| Command                                                                                                                         | What it does                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freeze --sites a,b [--refresh] [--wayback a]`                                                                                  | Captures each site once into a replayable snapshot; later stages read the replay, so runs are repeatable and offline. Reused until `freeze.maxAgeDays` (default 7). |
| `run --sites a,b [--stages mirror,…] [--parallel 2] [--cycle N] [--keep-cache]`                                                 | Runs the matrix, two sites at a time, each in its own project folder and ports.                                                                                     |
| `inspect [--cycle N]`                                                                                                           | Writes `findings.json` and `FINDINGS.md`: each finding new, recurring, regressed or fixed. Exit 1 when something is new or regressed.                               |
| `fix [--cycle N] [--max 5] [--budget-usd 20] [--model p/m] [--dry-run]`                                                         | One fixer goal per finding group, one after another. `--dry-run` writes each generated task to `cycles/N/fix-drafts/` and starts nothing.                           |
| `verify [--cycle N] [--goal id] [--fast] [--budget-usd n]`                                                                      | Judges fixer branches. `--fast` is what a fixer runs on itself: the policy check and the fast lane, with nothing merged, discarded or recorded.                     |
| `loop [--sites a,b] [--stages x] [--max-cycles 20] [--budget-usd 200] [--until-green] [--stable 2] [--fix-max 5] [--model p/m]` | `freeze → run → inspect → fix → verify → rules`, repeated.                                                                                                          |
| `status`                                                                                                                        | Cycle, step, per-site gates, spent budget, running goals.                                                                                                           |
| `report --cycle N [--open]`                                                                                                     | `REPORT.md`, `report.json` and a static `index.html`.                                                                                                               |
| `rules [--check]`                                                                                                               | Lists rules. `--check` fails on a rule whose test or lint is gone.                                                                                                  |
| `diff --cycle N --against M`                                                                                                    | Gates and findings that changed between two cycles. Exit 1 when a gate went from pass to fail.                                                                      |
| `clean --keep 3`                                                                                                                | Drops old cycles' apps, screenshots and logs, and keeps their reports. Snapshots are never touched.                                                                 |

**Stopping conditions of `loop`.** With `--until-green`, it stops when the matrix has been green for `--stable` cycles in a row (default 2), and that is the only case that exits 0. Without it, `loop` runs `--max-cycles` cycles even when green and exits 0 if the last cycle was green. A nightly `loop --max-cycles 1` is the second form.

## What happens in a cycle

1. **freeze, run, inspect.** The matrix runs on the accepted commit. The collector turns everything the stages left on disk into findings. Output lints under `autopilot/lints/` run over every produced app.
2. **Is it green?** Green means every site's hard gates pass and no finding of rank 0 to 2 remains. Advisory findings never block. The second green cycle reuses cached model answers and must match the first: same gate results and byte-identical generated code apart from timestamps, otherwise `NONDETERMINISTIC`.
3. **fix.** The findings are ranked (what blocks the chain, then hard gates, then health, then advisory; more sites first). Each group becomes a goal on `cdr/goal-autopilot-<signature>` with a generated task: the evidence, the related rules, and every earlier attempt with its reason.
4. **verify.** Each branch is judged in order of cost, one at a time, on top of whatever was merged before it:
   - the policy check on the diff (no matrix hostname, site id or URL in `packages/**`; no gate default or threshold changed; no mask, skip or exclude added; no protected path; no `@ts-ignore` or disabled test);
   - the rule and its guard exist, and the guard test **fails on the base branch and passes on the branch**;
   - `pnpm build`, `pnpm test`, `pnpm lint`;
   - the **fast lane**: the affected stage on the originating site and a fixture, from cached inputs;
   - the **slow lane**: the whole matrix plus the holdout.

   A fix is accepted only if no gate anywhere went from pass to fail against `baseline.json`, its signature is gone on every site where it appeared, and no new `PIPELINE_BUG` appeared. Accepted branches are merged and the baseline moves. Anything else discards the branch and records the attempt.

5. **rules, and repeat.** The rule the fixer left behind stays in the repository and is checked by `pnpm test` from then on. Three discarded attempts on one signature mark it `NEEDS_HUMAN`, and the loop carries on with the rest.

## What each thing is

Committed, under `autopilot/`:

| File                       | What it is                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sites.yaml`               | The matrix and the holdout. The holdout is never shown to a fixer; a regression there still discards a fix.                                                   |
| `registry.json`            | Every signature ever seen: first and last cycle, sites, status, the guarding rule, and all attempts with reasons. Read it to see what was tried.              |
| `baseline.json`            | The last accepted matrix result. Regressions are judged against this, not against the previous attempt.                                                       |
| `rules.json`, `rules/*.md` | One rule per fixed finding: symptom, root cause, invariant, and the guard that keeps it fixed.                                                                |
| `lints/*.mjs`              | Output lints. Each default-exports `({ appDir, site, stage }) => [{ message, file? }]`, runs on every produced app and is a finding when it reports anything. |

Not committed, under `.harness/autopilot/`:

| Path                                                                          | What it is                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `state.json`                                                                  | The loop's position: cycle, next step, spending, green streak, coverage target, why it stopped.                                |
| `snapshots/<site>/`                                                           | The frozen captures.                                                                                                           |
| `cycles/<N>/<site>/<stage>/`                                                  | One stage of one site: `log.txt`, `events.jsonl`, `summary.json`, `errors.json`, `screens/<viewport>/{original,new,diff}.png`. |
| `cycles/<N>/{matrix.json, findings.json, FINDINGS.md, REPORT.md, index.html}` | The cycle's results and report.                                                                                                |
| `goals/<id>.json`                                                             | One fixer: its finding, branch, verdict and why, at which step, and its cost.                                                  |

## Reading a report

Start with `cycles/N/index.html` (`pnpm autopilot report --cycle N --open`) or `REPORT.md`: stage table, gate table, findings with links, model usage, and what changed since the previous cycle. Then:

- **`FINDINGS.md`** is the list to read first. It is ordered new, recurring, regressed, fixed, and each entry links its evidence: dossiers (`verify/diagnosis/*`, with a cause such as `CSS_MISSING`), crops and bug bundles.
- **A signature** reads `<stage>:<code>[:<cause>][:<hash>]`, such as `mirror:visual.parity:CSS_MISSING`. It is the same for every site that hits the same code path.
- **To see why a fix was rejected**, read its entry in `autopilot/registry.json` or `.harness/autopilot/goals/<id>.json`. `decidedAt` is where it stopped (`policy`, `guard`, `build`, `fast`, `slow`, `merge`). A rejected branch and its worktree are deleted.
- **`NEEDS_HUMAN`** is a finding three fixers could not solve. The loop prints each with its attempts when it stops. Fix it by hand, or set its status to `accepted-advisory` in the registry to leave it.
- **`pnpm autopilot diff --cycle N --against M`** answers "what changed".

## Stopping and resuming

**Ctrl+C once** pauses after the step in progress. **Ctrl+C twice** stops that step now, and it runs again on resume. A stage that was running is discarded, not continued.

Run `loop` again with the same flags and it continues from `state.json`, spending included. A crash resumes the same way. After a `budget` stop, raise `--budget-usd` and run it again. The loop always leaves a report when it stops.

A run that finished (`green`, or `max-cycles`) does not carry its spending over: the next `loop` starts a new budget, in the next cycle. A green run also forgets its streak, so stability is proved from blank again; a `max-cycles` run keeps it, so two nightly runs can add up.

## Costs and timing

Estimates from the design, not measurements. Budgets are hard limits; the figures below are what they are set to.

| Item                              | Time          | Budget                      |
| --------------------------------- | ------------- | --------------------------- |
| One mirror run                    | up to 40 min  | 3.9 USD for its fix step    |
| A matrix of 4 sites, 2 at a time  | about 2 hours | the sum of the above        |
| A fixer goal                      | up to 45 min  | 10 USD, one round           |
| A cycle's fixers                  |               | `--fix-max` 5, 60 USD       |
| A cycle with fixes and both lanes | 3 to 5 hours  |                             |
| The loop                          | days          | `--budget-usd`, default 200 |

The fixer budget is enforced per goal: each one is capped at what is left of the step's budget, so a step cannot overspend. A matrix run is checked before it starts, against what the previous matrix run cost; the very first run has no estimate, so its cost is bounded only by the per-site budgets inside the pipeline. The slow lane of a candidate is a whole matrix, so a cycle with five accepted candidates can cost far more than five times one run.

**Scheduling.** A nightly run: `docs/autopilot/nightly.plist.example` for launchd, or with cron:

```cron
0 2 * * * cd /path/to/cdr && git pull --ff-only && pnpm build && pnpm autopilot loop --max-cycles 1 --budget-usd 60 >> ~/autopilot-nightly.log 2>&1
```

## Honest limits

- A green matrix proves the sites in `sites.yaml` plus the holdout from their snapshots. It says nothing about a site the loop never saw, or about what a live site does after the snapshot.
- Fixers are models. Attempt memory, the holdout, the baseline and the three-strike rule make wasted effort visible and bounded, not impossible. A cycle can spend real money and accept nothing.
- `NEEDS_HUMAN` is a valid result. So is a site that stays red because of a bot wall or a page that cannot be captured.
- The policy check is pattern matching on a diff. It stops the obvious ways to pass by lowering the bar, and a test or a code review still catches the rest; do not treat it as a security boundary.
- Site ids that are also CSS units (`vw`) are only caught next to a word like `site` or `host`, so that real unit lists are not rejected.
- A repeat cycle with no accepted fix still runs the whole matrix, because nothing tells it the code did not change.
- Every check of a fixer's branch that needs the repository runs against a fresh `pnpm install`. Pipeline code that is not committed is not in a fixer's worktree at all, which is why `fix` refuses to start on such a checkout.
- Autopilot commits on your branch and merges into it (only for accepted fixes). Run it on a branch you are happy to have changed, and read the merges with `git log --merges`.
- Scheduled runs only work where the machine is on and the sites' snapshots are fresh, and they need the provider key in the scheduled environment.
