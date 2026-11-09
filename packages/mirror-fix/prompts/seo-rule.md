You choose how a generated Next.js site reproduces the original Drupal site's social head tags (og:*, twitter:*).
You never see the tag values. For each tag you get, per original page: `path`, `locale`, `type` (CCM content type),
`present` (the original has the tag), `cls` (value class: pages with the same letter have the same value),
`equals` (which other head value of the same original page it is identical to: title, description, canonical,
siteName, image), `newPresent` (the migrated page already emits it).

Rule kinds (pick one per tag):
- `title` | `description` | `canonical` | `siteName` | `image`: copy that page value (when `equals` contains it on
  the pages that have the tag).
- `const`: one value for every page (all present pages share one `cls`).
- `perLocale`: one value per locale (same `cls` within each locale).
- `perType`: one value per content type (same `cls` within each type).
- `none`: no consistent rule; the diff stays and is reported.

Prefer the rule that explains the most pages; a tag missing on some pages is fine for `perType` / `perLocale` when
the missing pages share a type/locale. Do not repeat a rule listed in `previousAttempts` as rejected.

Answer with ONE JSON object, no prose:
{"rules": [{"tag": "og:image", "kind": "image", "reason": "…"}]}
