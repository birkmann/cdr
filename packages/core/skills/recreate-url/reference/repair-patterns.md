# Repair patterns

Typical causes of a section that misses its pixel threshold, and the smallest fix. Always prefer a CSS rule scoped to
the section (`[data-section="ID"] .cls { … }`) over editing markup.

## Text wraps differently (heights drift)

- The webfont did not load (fonts policy `system`, or a blocked font URL): the fallback is wider or narrower. Fix the
  `@font-face` in `tokens.css` if the font file is in the output, else tune `letter-spacing` / `font-size` of the
  fallback stack slightly; never change the copy.
- A heading balanced on the live page: `text-wrap: balance`.

## Boxes shift between widths

- The fluid CSS interpolates linearly between measured widths. A box that steps (columns 2 → 3) needs a `@media`
  rule at the switch width instead of interpolation: add one scoped to the section.
- `max-width` + `margin-inline: auto` containers: check the computed `width` at the widest variant.

## Sticky or fixed header offsets

- A pinned header that overlaps the next section: the section needs `scroll-margin-top` / `padding-top` equal to the
  header height, or the header `position: sticky; top: 0` instead of `fixed`.
- A band above the header that slides away (`data-scroll-shift`): keep the attribute; the runtime moves it.

## Images

- Wrong crop: `object-fit` / `object-position` of the `<img>`; the live page's focal point is in its computed style.
- Art direction: a `<picture>` with `<source media>`; keep both sources.

## Carousels

- Arrows that do not move: the arrow needs `data-scroll-by="next|prev"` and its track `data-scroller="x"`; the
  runtime in `nav.js` does the rest.
