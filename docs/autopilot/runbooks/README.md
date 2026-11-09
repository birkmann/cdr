# Autopilot runbooks

Reference for a fixer goal (and anyone reading a failing stage by hand). One page per stage: where its inputs and outputs live, how to re-run it alone, how to read what it leaves, and the known causes with their usual fixes.

| Stage         | Runbook                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| freeze        | [freeze.md](freeze.md)                                                                                                                                                               |
| mirror        | [mirror.md](mirror.md), with [verify.md](verify.md), [autofix.md](autofix.md), [design-extract.md](design-extract.md) and [frontend-generate.md](frontend-generate.md) for its steps |
| design-system | [design-system.md](design-system.md)                                                                                                                                                 |
| replica       | [replica.md](replica.md)                                                                                                                                                             |
| final         | [final.md](final.md)                                                                                                                                                                 |

The runbooks for verify, autofix, design-extract and frontend-generate are adapted from the source pipeline's `docs/runbooks/`.

In every stage folder, `.harness/autopilot/cycles/<N>/<site>/<stage>/`:

- `summary.json`: status, wall clock, gates, issues, the paths of its outputs;
- `errors.json`: every error of the stage with its code and the file of its dossier or bug bundle;
- `log.txt`: stdout and stderr with timestamps; `events.jsonl`: the harness event stream of the run.

Re-run one stage of one site from what is already on disk:

```bash
pnpm autopilot run --sites bvg --stages mirror --cycle 3
```

Never fix a stage by editing what it generated, and never by changing a threshold. Both are discarded, the first by the next run and the second by the policy check.
