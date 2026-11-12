---
name: recreate-url
description: Recreate a live web page 1:1 from its real DOM as one modern, accessible page (then optionally a Lit + Vite project, React + Vite or design-system packages), measured against the live page — pixels, text, layout, video, sliders, hover, accessibility, Lighthouse. Only after the user explicitly asked for an exact copy of a URL.
auto: never
---

# Recreate a page 1:1

This skill rebuilds **that page**: measured from its live DOM, block by block, at every captured width, with menus and sliders working. It is never your own idea.

## When to use it (and when not)

Use it when the user's message asks for an exact copy of a URL in words that leave no doubt, for example _recreate exactly_, _1:1_, _pixel-perfect_, _clone this page_, _copy this site as it is_, together with a URL. If the user selected this skill themselves, that is the request: a URL or domain alone ("nestle.com") means recreate that page.

A URL works with or without a scheme: `nestle.com`, `www.nestle.com/brands` and `https://www.nestle.com` are all valid; pass it to `recreate_capture` as written, it adds `https://` itself.

Do **not** use it (unless the user selected it) for "like bvg.de", "inspired by", "in the style of", "something similar to": those go to the `web-app` skill, which designs an original page. When in doubt, ask the user which they want.

## Stages

1. `recreate_capture { url, widths?, to }`: asks the user for consent (always), probes the page's layout ranges, captures it per device class (with its videos, sliders, hover looks, menus) and converts it to sections. Keep the run id. Pass `to: ["modern"]` for a recreation (the default to choose), add `"lit"`, `"react-page"` or `"angular-page"` when the user wants the page as a Lit, React or Angular project, and add `"static"` only when they also want `react-vite` or a design system later.
2. `recreate_build { run }`: writes the whole page at once. `modern` (`out/modern/`): one semantic DOM for every width, mobile-first CSS fitted from the measurements at the page's own breakpoints, the hero video playing (with a pause control), sliders as scroll-snap tracks with arrows / dots / keys / autoplay as on the live page, the hover looks as CSS, the menu, a skip link and names for icon controls. `lit` (`out/lit/`): the same page as a Lit + Vite project (one light-DOM component per section, controllers for menu / slider / video, every section prerendered by the build and hydrated). `static`: the earlier per-breakpoint page, scored section by section.
3. `recreate_measure { run }`: per output — pixel, text, layout and interaction gates per captured width; the responsive gate at about 50 widths between and beyond them; the flow gate; and for `modern` / `lit` the quality gates: **a11y** (axe-core: no serious or critical violation), **markup** (one h1, one main, no skipped heading levels, lang / title / description, images with alt and size, no hidden copies of the page), **motion** (the live page's videos play, each with a pause control), **behaviour** (sliders move by keys, dots, autoplay and loop where the live page's do), **hover** (the live page's hover looks are there) and **lighthouse** (phone and desktop: performance ≥ 90, accessibility ≥ 95, best practices ≥ 95, SEO ≥ 90). The Lit project is measured once it was built (`cdr recreate … --build`, or `npm install && npm run build` in `out/lit`).
4. Only if the user asked for a project or a design system: `recreate_convert { run, to: "lit" | "react-page" | "angular-page" }` (from the modern page), or `recreate_components { run }` then `recreate_convert { run, to: "react-vite" | "ds-react" | "ds-lit" | "ds-angular" | "tokens", style? }` (these need `static` in `to`).

Default widths are the page's own layout ranges; pass `widths` only when the user names them.

## Repair rules

Repair only when the user asked for the failing gates to be fixed. A URL or domain alone, or "recreate X", is not such a request: after the first `recreate_measure`, give the user the summary below and stop, whatever the gates say. When the user did ask:

- Look at the section first: `recreate_section { run, id }` shows its markup between `<!-- section:ID -->` and `<!-- /section -->`, the live / recreation crops, and what the last measurement found for it between the captured widths and in its CSS.
- Fix the **layout rule** the live page uses, so the section flows at every width: a flex row that wraps, a grid with `repeat(auto-fit, minmax(…))`, a `max-width` column with auto margins, type with `clamp()`, a box whose height follows its text (`height: auto`, `min-height`). Never fit numbers to the captured widths: every measurement checks widths between them that it did not check before.
- Patch **only inside those markers** (or add CSS rules scoped to the section's classes / `[data-section="ID"]` to `styles.css`) with `patch_file`, never with `bash` (sed, python, heredocs): those edits are not tracked as progress. In `out/modern/` the section's classes are its scope (it has no `data-section`).
- In `modern` and `lit` outputs never remove what the quality gates check: `alt`, `aria-*`, labels, the skip link, the video's pause control, `lang`, heading levels, `width` / `height` of images. A patch may add accessibility; it never trades it for pixels.
- Never add, in CSS added after the build: `position: absolute | fixed` or coordinates, negative margins, `transform: translate` to place a box, a px `height` / `max-height` on anything but an image or video, `!important`, `zoom`, a media query around one width, a value with a viewport term multiplied by 100 or more, unscoped selectors. The flow gate fails on each of them.
- Never change copy, never swap, add or remove photos, never add scripts.
- The responsive and flow gates are never traded for pixels at the captured widths. A patch that makes either of them fail, or adds an issue at any width, must be undone, even when the pixels got better.
- At most two attempts per section, then measure again and report what is left.
- See reference/repair-patterns.md for recipes per symptom.
- Loop on `recreate_section` → patch → `recreate_measure`; these reuse a warm browser. Do not write your own pixel diffs, screenshot or alignment scripts: `recreate_measure` and `recreate_section` already give the numbers and crops. For a check they do not cover (computed styles, font metrics), write one small script that connects to the running browser at `$CDR_CDP_URL` (mention `CDR_CDP_URL` in the command), reuse it, and never `pkill` or restart that Chrome. Inside the sandbox `$CDR_CDP_URL` is not set: start one headless browser in the script and close it when done.
- `recreate_measure` keeps the best version of the run: a measure that is worse puts the best output (and its measure files) back, and its result ends with what to do **Next**: follow it. After two measures without improvement it tells you to stop; after four it refuses to measure again until `recreate_build` starts over.
- Keep going while the gates improve and each failing section has attempts left. Stop when every gate passes, when each failing section has had its two attempts, or when `recreate_measure` says to stop, and report what is left.

## Summary for the user

Say, in this order: where the output is (`.harness/recreate/<run>/out/modern/index.html`, `out/lit/` for the Lit project, `out/static/index.html`, or the converted project), the numbers per width (pixel %, missing/extra texts, height, interactions), which gates pass — the quality gates (a11y, markup, motion, behaviour, hover, Lighthouse scores) with their lines — and how many of the in-between widths fail and why, the compare page path, what the capture skipped (videos not downloaded, budgets), and this notice: _the layout, text, photos, fonts and logos belong to their owners; use the recreation for your own evaluation and prototyping, or with the rights holder's permission._ Captured assets stay in the gitignored run folder unless the user chose `recreate.assets: "project"`.

When the user later edits a converted React project, follow reference/react-structure.md so the edits fit its structure.
