# @harness/measure

Live page vs recreated output: PNG diff, text, layout, interactions, vision prompt, compare page.

Part of CDR's 1:1 page recreation; see [docs/recreate.md](../../docs/recreate.md).

## Origin

The pixel diff, text comparison and vision check follow an earlier private project by the same author. They run in Node with the PNG codec from @harness/capture, with no browser and no Playwright.

The ported code is released under CDR's MIT licence; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
