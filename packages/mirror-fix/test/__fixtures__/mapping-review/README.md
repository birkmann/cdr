Golden set for `mapping-review` (prompts/mapping-review.md). Each case: `<case>.mapping.yaml` (the mapping file),
`<case>.input.json` (the user payload the handler sends: dossier + findings, no content) and `<case>.expected.json`
(decisions the answer must contain: same path + decision, and value when given). Run live (costs < $0.01):
`CMP_LIVE_LLM=1 pnpm vitest run packages/autofix/src/__tests__/golden.test.ts`.
