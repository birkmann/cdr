# @harness/capture

Headless-Chrome page capture for 1:1 recreation: CDP driver + in-page DOM walker → Snapshot.

Part of CDR's 1:1 page recreation; see [docs/recreate.md](../../docs/recreate.md).

## Origin

The in-page DOM walker (`assets/domCapture.js`) and the capture logic are ported from an earlier private project by the same author. The CDP driver runs on the dependency-free CDP-over-pipe transport that `check_preview` already uses.

The ported code is released under CDR's MIT licence; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
