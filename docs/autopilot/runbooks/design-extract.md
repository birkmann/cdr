# Runbook: design (the mirror's design-extract step)

The `design` step of a mirror run: tokens, mined components, page templates and ported styles and fonts, from the crawl's output. Adapted from the source pipeline's runbook. Code: `packages/mirror-design`.

## Inputs and outputs

- Inputs: the crawl's raw HTML and screenshots, the content model.
- Outputs, under the run: `design/manifest.json`, `design/tokens.json`, `design/styles/*.css` (with `url()`s rewritten to `design/assets/…`), `design/assets/**`, `design/components/<id>.json`, `design/templates/<type>.json`.

## Re-run

```bash
cdr recreate --run <id> --from design
```

## Known causes

| Symptom                                         | Cause                              | Fix                                                                                              |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| no raw HTML or screenshots                      | the crawl did not finish           | look at the crawl step, not at this one                                                          |
| a component without field bindings              | the heuristic could not match it   | fix the matching in `packages/mirror-design` with a fixture of the shape that failed             |
| fonts missing                                   | licensing or a cross-origin block  | check `credits.json`; `recreate.fonts` decides how fonts are carried                             |
| model failure                                   | key or model                       | heuristic components are produced; they are marked `source: "heuristic"`                         |
| a stylesheet only in `<noscript>` shows up live | a `<noscript>` link kept as active | such a link must stay inert. Guard it with an output lint: the symptom can come from other paths |
