---
name: autopilot-fix
description: The method for fixing an autopilot finding in a goal worktree. Load it when your task is an autopilot finding with a signature.
auto: never
---

# Fixing an autopilot finding

You are a fixer goal of `cdr autopilot`. Your task names one finding by its signature, with its evidence and every earlier attempt. Your branch is only kept if a deterministic check says so. There is no way to argue with it.

## The rules that discard your branch

A policy check reads your diff before anything is built. Any of these discards the branch immediately:

- a hostname, URL or site id of the matrix anywhere under `packages/**`, tests included. The fix must be generic;
- a changed gate default: anything in `packages/protocol` `RecreateConfig` defaults, `packages/mirror-core` thresholds, or `recreate.gates` in a config;
- an added `mask`, `skip` or `exclude` in a site config or a verify call;
- an edit under `.harness/`, or of `autopilot/sites.yaml`, `autopilot/baseline.json`, `autopilot/registry.json`, or `packages/autopilot/src/policy.ts` and `decide.ts`;
- a new `@ts-ignore`, `@ts-nocheck` or disabled test; a deleted test file.

Then, mechanically: a rule and its guard must exist, the guard test must fail on the base branch and pass on yours, `pnpm build`, `pnpm test` and `pnpm lint` must be green, the finding must be gone on the site that produced it and on every other site where it appeared, and no gate anywhere may go from pass to fail, including on sites you cannot see.

## Method

1. **Read the cause before the code.** A dossier states its `ParityCause` (`MARKUP`, `CSS_MISSING`, `CSS_ORDER`, `ASSET`, `SCRIPT`, `CONTENT`, `DYNAMIC`, `UNKNOWN`) and evidence lines. A bug bundle has a README and the inputs that crashed the check. Start there, then open the runbook of the stage: `docs/autopilot/runbooks/<stage>.md`.
2. **Read the earlier attempts.** Each one says what was tried and why it was rejected. Do not try the same thing again.
3. **Reproduce before you touch anything.** Use the bug bundle's inputs or a local fixture. A fix you cannot reproduce is a guess.
4. **Write the test first.** It goes in `packages/<pkg>/test/`, it fails now, and it fails because of the bug. It must name what was wrong, not the site.
5. **Fix the rule or the pipeline step, never the numbers.** If a page is 0.91 against 0.97, the page is wrong. Find what made it wrong. Never edit generated output under `.harness/**`; the next cycle regenerates it.
6. **Prefer deterministic code to another model call.** A new model call on the hot path needs a finding that says a deterministic fix is impossible.
7. **Put the rule file last.** When the test passes and the build is green, write `autopilot/rules/<slug>.md` and add its entry to `autopilot/rules.json` as your task describes. Name the regression test exactly as it is declared. Add an output lint under `autopilot/lints/` when the same symptom could come from another code path, and name it too. Run `pnpm autopilot rules --check`.
8. **Check yourself.** After `pnpm build`, `pnpm autopilot verify --fast --goal <your goal id>` tells you whether the finding is gone and nothing else flipped, without touching your branch.

## When you finish

Your last message says, in a few lines, what the root cause was and what you changed. It goes into the report.

If the finding cannot be fixed generically, say so and leave the branch without a fake pass. A documented failure is a valid outcome. A faked pass is not, and it is discarded anyway.
