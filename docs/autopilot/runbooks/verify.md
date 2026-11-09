# Runbook: verify (the mirror's check, also used by final)

Old side against new side. Writes one report per check to `verify/` and the gates to `verify/summary.json`. Adapted from the source pipeline's runbook.

## Inputs

The original side (the snapshot's replay URL), the new side (the generated app on its own port), the content model, the verify baseline captured after the crawl, and the site's parity settings: `screenshotThreshold`, `bboxTolerancePx`, `textSimilarity` and `crawl.mask`.

## Re-run

```bash
cdr recreate --run <id> --from verify
```

## Checks and gates

| Check                                 | Gate                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| content completeness                  | `content.*`: nothing missing                                  |
| rich text fidelity                    | `fidelity.similarity` ≥ 0.99                                  |
| links                                 | `links.*`: nothing broken                                     |
| redirects                             | `redirects.failed`: all correct                               |
| visual, per URL and viewport          | `visual.parity` ≥ 0.97, `visual.bbox` ≤ 4 px, `visual.height` |
| media                                 | `media.missing`: none                                         |
| embedded video players with motion on | `playback.blank`: none                                        |
| SEO, a11y, performance, cleanliness   | advisory: reported, never a failure                           |

## Reading it

`verify/<check>.json` holds rows per page and viewport with a score and a pass flag; `verify/summary.json` the gates. `SOURCE_DRIFT` means the live page changed since the crawl: that is information, never a finding.

## Known causes

| Symptom                                | Cause                                                | Fix                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| visual low on one viewport             | a CSS or component difference                        | read the dossier; [mirror.md](mirror.md) lists the causes                                                                   |
| visual scores differ between runs      | animations, consent banner, dates                    | parity is measured twice per viewport and the minimum kept. A mask needs the `DYNAMIC` proof, and a fixer may never add one |
| broken links                           | missing entries or redirects                         | the transform's link handling and the redirect list                                                                         |
| `LINK_HOST_LEAK`                       | absolute links to a replay or local host             | only links to migrated pages or to the replay are leaks; fix the link rewrite                                               |
| `SEO_DIFF` on a canonical that exists  | a `>` inside a quoted head attribute cut the tag     | head parsing must be quote-aware                                                                                            |
| `HEIGHT_DIFF` in a consent footer slot | a cross-origin consent script was dropped            | static sites keep such scripts as remote script tags                                                                        |
| `PLAYER_BLANK`                         | the video platform only plays on the original domain | the app's player fallback shows the poster; a lasting fix needs the platform to allow the domain                            |

A failing check is not licence to change its threshold. Thresholds are policed, and they are why a pass means something.
