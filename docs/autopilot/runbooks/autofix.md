# Runbook: autofix (the mirror's own fix step)

`@harness/mirror-fix`, the `fix` step inside a mirror run. Adapted from the source pipeline's runbook. Autopilot's goal-level loop is the same idea lifted one level, from one run's output to the pipeline code.

## What it does

```
collect open tasks (the reports and verify/<check>.json)
  → group per handler, order by handler priority
  per group: measure before → propose (rule candidates first, then the model)
    per candidate: back up → write the patch (data files only) → re-run the steps → measure after
      accept iff the metric improved and no gate went pass → fail; else restore and re-run
```

Each run is budgeted (`recreate.mirror.fix.budgetUsd`, default 3.9 USD). Without a key or budget, only the rule candidates run.

| Handler             | Codes                                      | Re-runs                                    |
| ------------------- | ------------------------------------------ | ------------------------------------------ |
| `parity-fix`        | visual and height differences              | design, generate, appbuild, verify(visual) |
| `design-variant`    | component variant and instance differences | design, generate                           |
| `seo-rule`          | SEO differences                            | generate, appbuild, verify(seo)            |
| `mapping-review`    | mapping and field issues                   | the transform                              |
| `PIPELINE_BUG` lane | crashes of the code rather than bad data   | writes a bug bundle                        |

## Reading it

- `autofix/attempts/<seq>-<handler>.json`: the candidate, its `before` and `after` metrics, whether it was accepted, and why (`improved -3 -> 0`, `gate visual.parity regressed …`, `no improvement …`, `rerun failed: …`). Identical patches are never retried, also across runs.
- `autofix/dossiers/`: what a person needs for a `NEEDS_HUMAN` task.
- `autofix/bugs/<n>/`: a bug bundle. `README.md` (command, step, message, stack), `inputs/`, `snippet.html`, `candidate.json` when a candidate's data crashed a step. The same failure maps to the same bundle.

## Known causes

| Symptom                    | What to do                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOFIX_NEEDS_HUMAN`      | no candidate improved the metric without regressing a gate. As a fixer goal, read the dossier and find what the handler or the data model cannot express |
| `PIPELINE_BUG`             | the pipeline crashed. Turn the bundle into a regression test in the owning package                                                                       |
| `AUTOFIX_BUDGET_EXHAUSTED` | the run's budget is spent. Cached answers replay at no cost                                                                                              |
| `AUTOFIX_STALLED`          | several rejected attempts in a row. Usually a gate that data patches cannot move                                                                         |
| `AUTOFIX_PATCH_REFUSED`    | a candidate wrote outside its allowed paths. That is a handler bug                                                                                       |
