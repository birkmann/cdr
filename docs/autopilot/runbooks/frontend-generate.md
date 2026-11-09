# Runbook: generate (the mirror's frontend-generate step)

The `generate` step of a mirror run: `design/` and the content model become a Next.js app at `out/mirror`, from the template in `packages/mirror-generate/templates`. Adapted from the source pipeline's runbook.

## Re-run

```bash
cdr recreate --run <id> --from generate
```

## Ownership

Generated output lives in the run folder and is regenerated on every run, so a fix belongs in the template or the generator (`packages/mirror-generate`), never in `out/mirror`. Runs are gitignored; an edit there cannot be kept.

## Known causes

| Symptom                                                | Cause                                                               | Fix                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `appbuild` fails                                       | the generator wrote invalid code, or the template lost a dependency | the bug bundle's `build.log`; fix the generator and add a generated-output test |
| 404 for a URL that was captured                        | the entry's path or locale prefix does not match                    | content model paths in `packages/mirror-transforms`                             |
| a page renders but its assets 404                      | asset paths or `CCM_DIR` are wrong                                  | asset path handling in the template                                             |
| a run differs from the one before with identical input | ordering or timestamps in the generator                             | `NONDETERMINISTIC` names the files; sort what is iterated                       |
