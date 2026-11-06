---
name: recreate-url
description: Recreate a live web page 1:1 from its real DOM (static HTML, then optionally React + Vite or design-system packages), measured against the live page. Only after the user explicitly asked for an exact copy of a URL.
auto: never
---

# Recreate a page 1:1

This skill rebuilds **that page**: measured from its live DOM, block by block, at every captured width, with menus and sliders working. It is never your own idea.

## When to use it (and when not)

Use it when the user's message asks for an exact copy of a URL in words that leave no doubt, for example *recreate exactly*, *1:1*, *pixel-perfect*, *clone this page*, *copy this site as it is*, together with a URL. If the user selected this skill themselves, that is the request: a URL or domain alone ("nestle.com") means recreate that page.

A URL works with or without a scheme: `nestle.com`, `www.nestle.com/brands` and `https://www.nestle.com` are all valid; pass it to `recreate_capture` as written, it adds `https://` itself.

Do **not** use it (unless the user selected it) for "like bvg.de", "inspired by", "in the style of", "something similar to": those go to the `web-app` skill, which designs an original page. When in doubt, ask the user which they want.

## Stages

1. `recreate_capture { url, widths? }`: asks the user for consent (always), probes the page's layout ranges, captures it per device class and converts it to sections. Keep the run id.
2. `recreate_build { run }`: writes the whole `out/static/index.html` at once and scores every section against the live page. Nothing is repaired automatically unless the run was started with `repair: true`.
3. `recreate_measure { run }`: pixel, text, layout and interaction gates per width, the compare page, and crops of the worst bands as images.
4. Only if the user asked for a project or a design system: `recreate_components { run }`, then `recreate_convert { run, to: "react-vite" | "ds-react" | "ds-lit" | "ds-angular" | "tokens", style? }`.

Default widths are the page's own layout ranges; pass `widths` only when the user names them.

## Repair rules

If `recreate_measure` still reports failing bands and the user wants them fixed:

- Look at the section first: `recreate_section { run, id }` shows its markup between `<!-- section:ID -->` and `<!-- /section -->` and the live / recreation crops.
- Patch **only inside those markers** (or add CSS rules scoped to the section's classes / `[data-section="ID"]` to `styles.css`) with `patch_file`.
- Never change copy, never swap, add or remove photos, never add scripts.
- At most two attempts per section, then measure again and report what is left.
- See reference/repair-patterns.md for the usual causes (fluid CSS, sticky offsets, font fallback metrics).
- Loop on `recreate_section` → patch → `recreate_measure`; these reuse a warm browser. For a check they do not cover (computed styles, font metrics), write one small script that connects to the running browser at `$CDR_CDP_URL` (mention `CDR_CDP_URL` in the command), reuse it, and never `pkill` or restart that Chrome. Inside the sandbox `$CDR_CDP_URL` is not set: start one headless browser in the script and close it when done.
- Keep going until every width passes its gates or each failing section has had its two attempts; the run continues past turn checkpoints as long as you keep changing files.

## Summary for the user

Say, in this order: where the output is (`.harness/recreate/<run>/out/static/index.html`, or the converted project), the numbers per width (pixel %, missing/extra texts, height, interactions) and which gates pass, the compare page path, what the capture skipped, and this notice: *the layout, text, photos, fonts and logos belong to their owners; use the recreation for your own evaluation and prototyping, or with the rights holder's permission.* Captured assets stay in the gitignored run folder unless the user chose `recreate.assets: "project"`.

When the user later edits a converted React project, follow reference/react-structure.md so the edits fit its structure.
