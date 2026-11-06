# @harness/scene

Snapshot → Scene: conversion, fluid geometry, layout plan, sections (recreate pipeline).

Part of CDR's 1:1 page recreation; see [docs/recreate.md](../../docs/recreate.md).

## Origin

`importers/url/*`, `dsl/*`, `vector/*` and `lib/*` are ported from an earlier private project by the same author. The `Dsl*` types are renamed `Scene*`. `page.ts` (`pageScreens` without canvas placement, `pageSections`) is new.

The ported code is released under CDR's MIT licence; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
