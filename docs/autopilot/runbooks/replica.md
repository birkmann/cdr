# Runbook: replica

Rebuilds the captured page in Next.js from the design system's components: composites from `@<prefix>-ds/site` and primitives from `@<prefix>-ds/react`. Written to `out/replica` from a vendored template, built with `next build`, served locally without provider keys.

## Inputs and outputs

- Inputs: the design system from the previous stage, the rebuild pipeline's scene (`scene/sections.json`, `screens.json`).
- Outputs: `out/replica/` in the site's project folder, and the stage's `summary.json`.

## Re-run

```bash
pnpm autopilot run --sites bvg --stages replica --cycle <N>
```

## The swap contract

Replacing a measured box with a generic primitive changes pixels. A swap is kept only if the section's parity does not drop below its gate. Otherwise the composite keeps the measured styles for that box and the swap is recorded as `DS_SWAP_REVERTED` with the diff crop. A reverted swap is not a defect in itself: it is the price of keeping parity.

## Known causes

| Code                                | Cause                                                          | Usual fix                                                                  |
| ----------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `next build` fails (`BUILD_FAILED`) | the emitted app does not compile                               | the replica template and the section emitter                               |
| `DS_COVERAGE_LOW`                   | too few painted boxes are rendered by design-system components | improve the swap rules. Never the measurement                              |
| `DS_SWAP_REVERTED` on most boxes    | a primitive differs too much from the measured box             | the primitive's styling or its mapping from the scene, not the parity gate |
