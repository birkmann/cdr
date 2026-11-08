# Repair patterns

Typical causes of a section that fails a gate, and the fix that holds at every width. The output is checked at the
captured widths and at about 50 widths between and beyond them (a different few every measurement), so a fix that only
matches the captured widths is found and undone. Always prefer a CSS rule scoped to the section
(`[data-section="ID"] .cls { … }`) over editing markup.

## Text overlaps other text between the captured widths

- A box placed by coordinates that its neighbour runs into when the width changes: put it back in the flow of its
  container (remove `position: absolute`, `top`, `left`) and let the container lay it out: `display: flex` with `gap`,
  `flex-direction: column`, or the grid the live page uses.
- A box whose height is fixed while its text wraps onto more lines: `height: auto` (keep the captured height as
  `min-height` only if the live page has a minimum).

## Text is cut off by its box

- `overflow: hidden` on a box with a px `height`: `height: auto`. If the live page truncates on purpose, it uses
  `text-overflow: ellipsis` or `-webkit-line-clamp`: use the same.

## The page's height drifts from the live page between the captured widths

- Usually the same cause as above, a fixed height somewhere in the section: find the box that does not grow with its
  text and make it `height: auto`.
- Media with a fixed px height: `aspect-ratio: W / H; height: auto` so it scales with its width.

## Columns change count between widths

- A grid whose column count follows the width without a breakpoint: `grid-template-columns: repeat(auto-fit,
minmax(240px, 1fr))` (the minimum is the narrowest column the live page shows).
- A row of cards that wraps: `display: flex; flex-wrap: wrap; gap: …` with `flex: 1 1 240px` on the items.
- A switch the live page makes at a breakpoint (2 columns → 3 at 768 px): a `@media (min-width: 768px)` rule at the
  page's own breakpoint, never a query around one width.

## A value grows with the viewport

- Type and spacing that scale: `clamp(min, a·vw + b, max)`, with the captured values as the ends.
- A column capped at a width: `max-width: 1200px; margin-inline: auto` and its padding, not a px width.

## Text wraps differently (heights drift at the captured widths)

- The webfont did not load (fonts policy `system`, or a blocked font URL): the fallback is wider or narrower. Fix the
  `@font-face` in `tokens.css` if the font file is in the output, else tune `letter-spacing` / `font-size` of the
  fallback stack slightly; never change the copy.
- A heading balanced on the live page: `text-wrap: balance`.

## Sticky or fixed header offsets

- A pinned header that overlaps the next section: the header `position: sticky; top: 0` instead of `fixed` (sticky
  stays in the flow), or `scroll-margin-top` on the section.
- A band above the header that slides away (`data-scroll-shift`): keep the attribute; the runtime moves it.

## Images

- Wrong crop: `object-fit` / `object-position` of the `<img>`; the live page's focal point is in its computed style.
- Art direction: a `<picture>` with `<source media>`; keep both sources.

## Carousels

- Arrows that do not move: the arrow needs `data-scroll-by="next|prev"` and its track `data-scroller="x"`; the
  runtime in `nav.js` does the rest.

## Rejected, and why

A repair with any of these is not written (the model's repair) or fails the flow gate (a patch of yours):

- `position: absolute | fixed`, `top` / `left` / `right` / `bottom` / `inset` offsets: coordinates fit one width.
- Negative margins, `transform: translate` / `translate`: they pull a box into place at one width.
- A px `height` or `max-height` on anything but an image or a video: text needs more room when it wraps.
- `!important`, `zoom`.
- A media query around one width: `(width: 1440px)` or a range narrower than 16 px.
- A value with a viewport term multiplied by 100 or more (`(100vw - 579px) * 1000`): it jumps between widths.
- A selector not scoped to the section's classes or `[data-section="ID"]`.
- Style attributes or a `<style>` block in replaced markup.
