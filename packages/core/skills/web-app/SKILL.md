---
name: web-app
description: Build a polished, responsive single-page web app, site or game (store, landing page, dashboard, tool, game) as one self-contained index.html with a live preview.
triggers:
  - \b(web ?app|website|web ?site|web ?page|landing ?page|homepage|single[- ]page|html|frontend|front-end)\b
  - \b(store|shop|e-?commerce|catalog(ue)?|storefront|checkout|cart|bag)\b
  - \b(dashboard|portfolio|blog|booking|calculator|todo|to-do|tracker|quiz|game|snake|tetris|pong|timer|gallery|responsive|page|site|ui)\b
auto: sandbox
---

# Web app

You are building a small product that a designer and a front-end engineer would both sign off on. The bar: it looks deliberate rather than generated, every visible control works, and it holds up from a 320 px phone to a 1440 px desktop.

## Process

1. Read the brief and decide the product: name, audience, 3–6 real pieces of content, the 2–4 interactions that matter. Do not ask questions you can answer with a sensible default.
2. If photography helps (products, food, places, people), call `search_unsplash` once per subject, pick the best result, then call `use_unsplash_photo` for each photo you embed. Search 3–6 subjects at most. If search fails, continue with typographic or CSS-drawn visuals and say so in your summary. Never invent image URLs and never copy URLs from the reference files.
3. Write everything into **one `index.html`** with inline `<style>` and `<script>` using a single `write_file` call. No frameworks, build steps, CDNs or packages unless the user asked for them.
4. Call `set_preview` with a short title right away.
5. Call `check_preview` with `viewports: ["small", "desktop"]`. Fix every reported problem (JavaScript errors, horizontal overflow, failed images, unnamed controls) with `patch_file`, then check once more.
6. **Stop as soon as `check_preview` reports "No problems found."** Do not keep polishing colours, spacing or wording, and do not re-read the whole file: every extra turn resends it. Get the design right in the first `write_file` instead.
7. Finish with a short summary: what it is, how to use it, what is demo-only. No file listing, no code.

## Design direction

Pick **one** direction that fits the brief and commit to it. When nothing in the brief says otherwise, use the editorial-minimal direction below; it suits stores, portfolios, product pages and tools.

Editorial-minimal:
- **Canvas**: white `#fff` or warm off-white; ink `#171717`; muted text `#626262`; hairlines `#d6d6d6`; **one** accent used sparingly (focus rings, a dot, a badge), e.g. `#d65300`. Put them in `:root` custom properties.
- **Type**: one system stack (`Arial, Helvetica, sans-serif` or `ui-sans-serif, system-ui`). Display heading large and tight: `font-size: clamp(44px, 7.5vw, 88px); font-weight: 400; letter-spacing: -0.055em; line-height: 1.02`. Body 14–16 px, captions 12–13 px in the muted colour. Weight contrast comes from size, not bold.
- **Structure**: hairline borders and whitespace separate things. Product tiles sit on flat grey `#ededed` with the photo `object-fit: cover` (or `contain` for objects shot on white, with `mix-blend-mode: multiply`). Small square-cornered labels ("New release") in white on the tile.
- **Layout**: a masthead with wordmark, quiet text navigation, a big heading with a one-line intro and a small meta label ("Collection 01 / 2026"), a toolbar row (filter left, bag or primary action right) above an asymmetric grid where the lead item spans two columns.

Other directions when the brief calls for them: a dark game canvas with one neon accent and a monospace HUD; a data-dense dashboard with a neutral grey UI, tabular numerals and one chart colour per series; a warm hospitality page with a serif display face and photography-led sections.

**Never**: decorative gradients or gradient text, purple-blue "AI" palettes, emoji as icons, glassmorphism, drop shadows on every card, rounded pill buttons everywhere, centred hero with three feature cards, stock phrases ("Elevate your…", "Seamless", "Unleash"), lorem ipsum, fake testimonials or reviews.

## Responsive layout

- Mobile first. Base styles target phones; add `@media (min-width: 760px)` for tablets/desktops and `@media (min-width: 1000px)` where wider layouts help. Use `@media (max-width: 420px)` to tighten the smallest phones.
- Gutters: 12–16 px on phones, 24–42 px on desktop. Wrap content in a `max-width: 1440px; margin: auto` shell.
- Grids use `repeat(N, minmax(0, 1fr))` and every grid or flex child that holds text gets `min-width: 0`. Long words get `overflow-wrap: anywhere`. Images get `max-width: 100%` and `display: block`.
- Phones: two-column catalogue with a full-width lead item; desktop: four columns, lead item `grid-column: span 2; grid-row: span 2`.
- Touch targets at least 44 × 44 px. Icon-only controls are buttons with `aria-label`. Button labels never wrap (`white-space: nowrap`); on phones shorten them or stack the row instead.
- On phones the main action of a detail view (e.g. "Add to bag") stays visible: `position: sticky; bottom: 0` or fixed inside the dialog, with a white background and a hairline above.
- `@media (prefers-reduced-motion: reduce)` turns transitions off. Keep motion subtle (≤ 400 ms, transform/opacity only).
- **No horizontal scrolling at 320 px.** This is checked.

## Content

- Write real, specific copy: product names, materials, colours, sizes, prices in one currency formatted with `Intl.NumberFormat`. 4–8 items is enough for a catalogue.
- Label anything simulated as a demo where the user meets it: "Checkout is a demo. No payment or order is submitted."
- Visible photo credit: a "Photography & credits" `<details>` in the footer with links to each photographer and Unsplash, using the links from `use_unsplash_photo`.
- `<html lang="en">`, a `<title>` with the product name, `<meta name="viewport" content="width=device-width, initial-scale=1">`, exactly one `<h1>`.

## Images

- `<img src="…" alt="Specific description" width="…" height="…">` with the returned `image_url` unchanged (keep its query string). Above-the-fold images load eagerly; others may use `loading="lazy"`.
- Put images inside a box with a fixed `aspect-ratio` and the tile background colour so the layout does not jump while they load.

## Interaction and state

- One plain state object (`let bag = []`), small render functions (`renderProducts()`, `renderBag()`), and one delegated click listener using `data-*` attributes. Re-render after every change.
- Persist meaningful state (bag, todos, scores, settings) with `localStorage` under a versioned key, wrapped in `try { … } catch {}` for both reads and writes, and validate what you read back. The preview iframe can block storage; the app must still work.
- Use `<dialog>` with `showModal()` for details, bag/cart and mobile menu. Close buttons have `aria-label`. Escape must close (native for `<dialog>`); clicking the backdrop may close too.
- Required choices (size, quantity) disable the primary button until made, and the button text says what is missing ("Select a size").
- Confirm actions with a small `role="status"` toast that hides after ~2 s.
- Filters update the list in place and show an empty state when nothing matches.
- Focus styles: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px }`.
- Inline SVG icons from one hidden `<symbol>` sprite, 24 px, `stroke: currentColor`, `aria-hidden="true"`.

For games: a `<canvas>` sized from its container with `devicePixelRatio`, a `requestAnimationFrame` loop with a fixed time step, keyboard **and** touch/button controls, pause/restart, and a persisted best score.

## Reference

- `reference/form.html` is a complete store built this way (catalogue, filters, product dialog with sizes, bag with quantities and persistence, mobile menu, demo checkout). Read it with `load_skill { name: "web-app", file: "reference/form.html" }` when building a store or catalogue; copy its structure and techniques, never its products, copy or photo URLs.
- `reference/patterns.md` has compact patterns for landing pages, dashboards, games and todo/tools.

## Finish checklist

Before your final message, confirm each point; `check_preview` reports most of them:
- [ ] `index.html` is self-contained; `set_preview` called.
- [ ] `check_preview`: no JavaScript errors, no overflow at phone or desktop width, no failed images, every button and link has an accessible name.
- [ ] Every visible control does something; state that should survive a reload does.
- [ ] One design direction, one accent colour, none of the "Never" items.
- [ ] Real copy, demo actions labelled, photo credits visible when photos are used.
