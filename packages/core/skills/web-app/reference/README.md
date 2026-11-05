# web-app reference files

## form.html: a complete store

A responsive concept store ("Form") written to the rules in `SKILL.md`. Use it for structure and technique. Do not reuse its products, copy or photo URLs: they belong to that demo, and photos must come from your own `search_unsplash` + `use_unsplash_photo` calls.

| Lines | What it shows |
|---|---|
| 9–20 | `:root` tokens: ink, muted, hairline, one accent; system font stack |
| 67–135 | Masthead (menu button, text nav, wordmark), display `h1` with `clamp()`, intro row with meta label, toolbar with filter and bag trigger |
| 175–285 | Catalogue grid: `minmax(0, 1fr)` columns, full-width lead tile, flat grey tiles, `object-fit`, badge, hover arrow |
| 338–470 | `<dialog>` styling: product detail with size buttons (`aria-pressed`), expandable `<details>`, primary button disabled until a size is chosen |
| 470–580 | Bag lines with quantity controls, total, notes, mobile menu, toast |
| 582–640 | `min-width: 760px`: four-column asymmetric grid, desktop navigation |
| 641–790 | Small phones, sticky mobile add action, reduced motion, tablet adjustments |
| 793–900 | Markup: SVG `<symbol>` sprite, header, main, footer with credits and demo note, three dialogs |
| 901–1060 | Data: photos (with credit links) and products (id, category, sizes, price, copy) |
| 1060–1146 | State: currency formatter, validated `localStorage` load, `persist()`, `toast()`, `renderProducts()`, `openProduct()`, `renderBag()` |
| 1147–1228 | One delegated click handler for every `data-*` action, filter `change`, demo checkout confirmation |

Behaviour that is verified for this file: filtering, size selection, bag totals, persistence across reloads, demo checkout, mobile navigation, item removal, Escape closing dialogs, no JavaScript errors, no overflow at 320, 390, 768 and 1280 px, and a visible add action on a 390 × 844 phone.
