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
2. Decide the design source and write your design brief (see below). Look in the project for existing design files and at any attached images first.
3. If photography helps (products, food, places, people), call `search_unsplash` once per subject, pick the best result, then call `use_unsplash_photo` for each photo you embed. Search 3–6 subjects at most. If search fails, continue with typographic or CSS-drawn visuals and say so in your summary. Never invent image URLs and never copy URLs from the reference files.
4. Write everything into **one `index.html`** with inline `<style>` and `<script>` using a single `write_file` call. No frameworks, build steps, CDNs or packages unless the user asked for them (Google Fonts are the one exception).
5. Call `set_preview` with a short title right away.
6. Call `check_preview` with `viewports: ["small", "desktop"]`. Fix every reported problem (JavaScript errors, horizontal overflow, failed images, unnamed controls) with `patch_file`, then check once more.
7. **Stop as soon as `check_preview` reports "No problems found."** Do not keep polishing colours, spacing or wording, and do not re-read the whole file: every extra turn resends it. Get the design right in the first `write_file` instead.
8. Finish with a short summary: what it is, how to use it, what is demo-only. No file listing, no code.

## Design source: decide before you write

Every result must look like it was designed for *this* brief. Two different briefs must never come out in the same style, and no style is the default. Pick the first source that applies:

1. **Existing design.** The project or brief already has one: a `DESIGN.md`, design tokens, an existing stylesheet, a brand colour/font/logo the user names, or "match our site". Follow it exactly; only fill gaps in its spirit.
2. **Reference image.** The user attached a screenshot, mood board or photo. Read it as a design spec: colour palette (sample 4–6 colours), type character (serif/sans/mono, weight, case, tracking), corner radius, density, layout rhythm, imagery treatment. Rebuild that *feel* with the brief's own content. Do not trace it pixel for pixel or copy its logos and text.
3. **Original direction.** Nothing given: invent one from the brief's subject, audience and tone. Ask what this thing would look like if a good studio specialised in this field had made it. A transit operator looks like wayfinding signage (bold sans, saturated brand colour, line badges, high contrast). A bakery feels warm and tactile. A fintech tool is precise and calm. A kids' game is loud and chunky.

Then write a 5-line **design brief** for yourself (not in the page) and build to it:
- **Mood**: three adjectives.
- **Colour**: light or dark canvas, ink, 1–2 brand colours with a role each (primary action, highlights, status). Not a palette taken from another project.
- **Type**: a display face and a body face chosen for the mood. You may load 1–2 families from Google Fonts (`<link>` with `display=swap`) with a system fallback stack; system fonts are fine when they fit.
- **Shape**: corner radius (0, 6–12 px or fully rounded), borders vs. fills vs. shadows, icon style.
- **Layout**: the hero archetype and section rhythm (e.g. split hero with a tool panel, full-bleed photo with overlay, colour-block bands, bento grid, long editorial scroll, app-like shell).

Vary every axis independently. Directions to draw from, mixed and adapted, never copied wholesale:

| Direction | Signals |
|---|---|
| Civic / wayfinding | bold grotesk, saturated brand colour fields, coloured line/route badges, rounded controls, dark brand band in the hero |
| Editorial minimal | huge light-weight headline, hairlines, off-white canvas, small caps meta labels, square corners |
| Warm hospitality | serif display, cream or terracotta, photo-led, generous spacing, soft radius |
| Playful / bright | chunky rounded sans, 2–3 bold flat colours, large radius, sticker-like badges, bouncy micro-motion |
| Technical / dark | near-black UI, mono accents, one vivid signal colour, dense panels, thin borders |
| Swiss / data | strict grid, strong sans, primary colours, numbers as graphics |
| Soft / organic | muted pastels, rounded shapes, gentle shadows, humanist sans |
| Bold brutalist | heavy type, thick borders, raw colour blocks, visible grid, no radius |

Avoid editorial minimal (cream canvas, mono micro-labels, hairlines, square boxes) unless the brief really asks for quiet luxury or a magazine feel; it is the look generated pages slide into most easily.

**Never**: decorative purple-blue "AI" gradients or gradient text, emoji as icons, glassmorphism, the same shadow and radius on everything, centred hero over three identical feature cards, stock phrases ("Elevate your…", "Seamless", "Unleash"), lorem ipsum, fake testimonials or reviews.

## Responsive layout

- Mobile first. Base styles target phones; add `@media (min-width: 760px)` for tablets/desktops and `@media (min-width: 1000px)` where wider layouts help. Use `@media (max-width: 420px)` to tighten the smallest phones.
- Gutters: 12–16 px on phones, 24–48 px on desktop; wrap content in a max-width shell.
- Put colours, fonts, radii and spacing in `:root` custom properties so the direction stays consistent.
- Grids use `repeat(N, minmax(0, 1fr))` and every grid or flex child that holds text gets `min-width: 0`. Long words get `overflow-wrap: anywhere`. Images get `max-width: 100%` and `display: block`. Display headings use `clamp()`.
- Touch targets at least 44 × 44 px. Icon-only controls are buttons with `aria-label`. Button labels never wrap (`white-space: nowrap`); on phones shorten them or stack the row instead.
- On phones the main action of a detail view (e.g. "Add to bag") stays visible: `position: sticky; bottom: 0` or fixed inside the dialog, on the canvas colour.
- `@media (prefers-reduced-motion: reduce)` turns transitions off. Keep motion subtle (≤ 400 ms, transform/opacity only).
- **No horizontal scrolling at 320 px.** This is checked.

## Content

- Write real, specific copy: product names, materials, colours, sizes, prices in one currency formatted with `Intl.NumberFormat`. 4–8 items is enough for a catalogue.
- Label anything simulated as a demo where the user meets it: "Checkout is a demo. No payment or order is submitted."
- Visible photo credit: a "Photography & credits" `<details>` in the footer with links to each photographer and Unsplash, using the links from `use_unsplash_photo`.
- `<html lang>` matching the language of the brief, a `<title>` with the product name, `<meta name="viewport" content="width=device-width, initial-scale=1">`, exactly one `<h1>`.

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

- `reference/form.html` is a working store (catalogue, filters, product dialog with sizes, bag with quantities and persistence, mobile menu, demo checkout). Read it with `load_skill { name: "web-app", file: "reference/form.html" }` only for the **technique** of a store's state, dialogs and bag. Its look is one editorial-minimal direction: do not take its colours, type, tiles, grid or masthead unless that is the direction you chose. Never take its products, copy or photo URLs.
- `reference/patterns.md` has compact patterns for landing pages, dashboards, games and todo/tools.

## Finish checklist

Before your final message, confirm each point; `check_preview` reports most of them:
- [ ] `index.html` is self-contained; `set_preview` called.
- [ ] `check_preview`: no JavaScript errors, no overflow at phone or desktop width, no failed images, every button and link has an accessible name.
- [ ] Every visible control does something; state that should survive a reload does.
- [ ] The design follows the chosen source (existing design, reference image or your own brief), fits this subject, and avoids every "Never" item.
- [ ] Real copy, demo actions labelled, photo credits visible when photos are used.
