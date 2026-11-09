# profile-infer golden inputs (W1-A, P2)

- `promo-list.html`: synthetic paragraph (wrapped in the Acme node template by the tests) that the deterministic
  pre-pass leaves partly uncovered (repeated unclassed `<li>`); DeepSeek must propose a `textList` slot. Used by the
  fake-fetch unit test and the opt-in live golden (`CMP_LIVE_LLM=1`), expected: covered-text ratio 1.0, ccm.valid.
- The Acme paragraph goldens live in `packages/adapters/source-html/__fixtures__/acme/{paragraphs,expected}`.
