# Runbook: final

Runs the mirror's verify suite against the replica with the snapshot as the old side, then the rebuild pipeline's responsive sweep and flow lint on the replica. Writes `final/verify/*.json`, `final/sweep.json`, `final/flow.json`, `final/coverage.json`, screenshots, dossiers and `compare/index.html`.

## Re-run

```bash
pnpm autopilot run --sites bvg --stages final --cycle <N>
```

## Hard gates

`visual.parity` ≥ 0.97 per viewport, `visual.bbox` ≤ 4 px, `visual.height`, `fidelity.similarity` ≥ 0.99, `content.*`, `links.*`, `media.missing`, the responsive sweep, the flow lint, and DS coverage at or above the current target. The target starts at 0.5 and rises by 0.1 after each cycle every site passes it, up to 0.9. The next run's target is in `state.json`.

## Known causes

| Code              | Cause                                                            | Usual fix                                                                                  |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `OVERLAP`         | content overlaps at a width between the captured ones            | layout must hold between captures: flow rules in the emitter, never a width-specific patch |
| `CUT_TEXT`        | a fixed height or overflow clips text                            | keep the box as tall as its content                                                        |
| `SIDEWAYS_SCROLL` | an element is wider than the viewport where the original was not | responsive widths in the emitter                                                           |
| `HEIGHT_DRIFT`    | the page's height differs by more than 5 % at a width            | spacing and wrapping between captures                                                      |
| a flow lint code  | CSS that only holds where it was measured                        | see the flow lint's message; a width-specific fix is what it exists to reject              |

For parity causes, read the dossiers as in [mirror.md](mirror.md) and [verify.md](verify.md).
