# Runbook: design-system

Builds a design system from the snapshot: tokens with four themes, Lit web components, React wrappers, docs, plus the page's own composites as a `@<prefix>-ds/site` package. See [../../design-system.md](../../design-system.md).

## Inputs and outputs

- Inputs: the snapshot (brand reading and component sets come from it, not from the live page).
- Output: `out/design-system/` in the site's project folder, a buildable npm workspace, and `design-system/report.json`: brand reading with provenance per value, contrast table, test results, preview reports.

## Re-run

```bash
pnpm autopilot run --sites bvg --stages design-system --cycle <N>
```

Directly, from a saved brand reading:

```bash
cdr design-system --run <id> --out <dir> --frameworks react --yes
```

## Hard checks

`npm install`, `npm run build`, `npm test` and `npm run docs:build` exit 0; `tsc` is clean; every contrast pair passes in every theme; no raw colour or size in component CSS; every element registered once with a React wrapper; the docs render at phone and desktop in light and darkest without a console error or overflow.

## Known causes

| Code                              | Cause                                                                                                           | Usual fix                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILD_FAILED`                    | the emitted workspace does not build; the cause (`install`, `build`, `test`, `docs`, `tsc`) is in the signature | the templates in `packages/design-system/templates/**`; run `node scripts/design-system/embed.mjs` after editing them                             |
| `CONTRAST_FAIL`                   | a brand colour fails contrast in a theme                                                                        | the token derivation adjusts until it passes; a fixed brand value must never be silently changed, so the reading and the derivation need to agree |
| `RAW_VALUE_IN_CSS`                | a component uses a literal colour or size                                                                       | use the tokens; the lint is the guard                                                                                                             |
| preview console error or overflow | a docs page breaks at a width                                                                                   | the docs templates; reproduce at the failing width and theme                                                                                      |
