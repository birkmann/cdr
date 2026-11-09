# Runbook: mirror

Runs `cdr recreate <replay-url> --mirror --yes --json` against the snapshot, in the site's project folder. The chain is

```
consent → crawl → ccm → design → generate → appbuild → serve → verify → fix → reverify → report
```

See [../../recreate.md](../../recreate.md) for what each step does.

## Inputs and outputs

- Input: the replay URL from freeze.
- Output: `.harness/autopilot/cycles/<N>/<site>/project/.harness/recreate/<run>/`, which holds `manifest.json` (stages and gates), `verify/*.json`, `verify/summary.json`, `verify/diagnosis/*` (a dossier per failing shot), `autofix/attempts/*`, `autofix/bugs/*`, `REPORT.md`, and the generated app in `out/mirror`.
- The stage folder links `screens/<viewport>/{original,new,diff}.png` to the run's verify output.

## Re-run

One stage of the pipeline, from the cached earlier ones, with the run id from `summary.json`, in the site's project folder:

```bash
cdr recreate --run <id> --from verify
```

Or the whole stage for one site: `pnpm autopilot run --sites bvg --stages mirror --cycle <N>`.

## Reading it

Failing gates are the first thing in `summary.json`. For a failing shot, open the dossier under `verify/diagnosis/`: it names a cause, the evidence lines and the crops. For a crash, open the bundle under `autofix/bugs/<n>/`: `README.md` has the failing command, step and stack, and `inputs/` has what it ran on.

## Known causes

The `ParityCause` of a dossier:

| Cause         | What it means                                           | Usual fix                                                                                             |
| ------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MARKUP`      | the generated markup differs from the original's        | the section split or the transform in `packages/mirror-transforms`, `packages/mirror-generate`        |
| `CSS_MISSING` | a stylesheet did not arrive or is inert                 | style porting in `packages/mirror-design`, the head order in the template                             |
| `CSS_ORDER`   | the rules arrive in a different order                   | style and head order in `packages/mirror-design`, `packages/mirror-generate`                          |
| `ASSET`       | an image, font or file is missing or wrong              | asset rewrite and download in `packages/mirror-capture`, `packages/mirror-transforms`                 |
| `SCRIPT`      | a script is missing or fails on the new side            | script order, the static-island decision                                                              |
| `CONTENT`     | the text differs                                        | content transform in `packages/mirror-transforms`                                                     |
| `DYNAMIC`     | the region differs between two captures of the original | not a defect of the mirror. Masking a region needs this proof and is decided by the autofix loop only |
| `UNKNOWN`     | no cause could be read                                  | improve the dossier first (`packages/mirror-verify`), then fix what it shows                          |

Also: `PIPELINE_BUG` means the code crashed rather than the page being wrong; `AUTOFIX_NEEDS_HUMAN` means the run's own fix step gave up (see [autofix.md](autofix.md)); `NEW_PAGE_ERROR` and `REQUEST_FAILED` are console errors and failed requests on the new side only.

The `packages/mirror-*` packages are vendored from the source pipeline. Keep a fix there small, so it can still be compared with the original.
