# Runbook: freeze

Captures a site once into a snapshot and serves it locally for every later stage, so runs are repeatable and the live site is contacted once.

## Inputs and outputs

- Input: the site's URL from `autopilot/sites.yaml`.
- Output: `.harness/autopilot/snapshots/<site>/<timestamp>/{crawl.json, raw/, assets/, screens/<viewport>.png, replay.json}` and a `current` link. `replay.json` records the final URL after redirects and the live-vs-snapshot parity at capture time.
- Later stages get a `http://127.0.0.1:<port>/…` replay URL in their `StageContext`.

## Re-run

```bash
pnpm autopilot freeze --sites bvg            # reuses a snapshot younger than freeze.maxAgeDays
pnpm autopilot freeze --sites bvg --refresh  # captures again
pnpm autopilot freeze --sites bmw --wayback bmw
```

## Reading it

Gates in `freeze/summary.json`: `crawl.pagesComplete`, and that the replay serves what was captured. `replay.parity` compares the replay with the live page as captured, so later drift can be told from a defect. `snapshot.source` says when a snapshot came from a web archive.

## Known causes

| Code                  | Cause                                                     | Usual fix                                                                                                                                                       |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_BLOCKED`         | a bot-management page answered the crawl                  | a site with `freeze: { wayback: true }` uses a Wayback capture. Otherwise it stays a documented failure. Autopilot never gets past a login, paywall or captcha. |
| `SNAPSHOT_INCOMPLETE` | the crawl lost pages or assets                            | read `crawl.json` for what was unresolved; fix the capture step in `packages/mirror-capture`, and add a fixture for the shape of page that failed               |
| `REPLAY_404`          | a later stage requested a URL the snapshot never captured | the requests are in `replay-misses.jsonl`. If the page needs it, the crawl must capture it; if only the pipeline asks for it, the pipeline should stop asking   |
