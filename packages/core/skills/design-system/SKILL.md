---
name: design-system
description: Build a complete design system (tokens with themes, Lit web components, React and Angular components, docs, tests) from a URL or from images, in the spirit of IBM Carbon, Material or Spectrum.
triggers:
  - \bdesign[- ]?systems?\b
  - \bcomponent (library|kit)\b
  - \b(ui|component) kit\b
  - \b(carbon|material|spectrum|polaris|fluent|primer)\b.*\b(like|style|similar|clone)\b
  - \b(like|style of|similar to)\b.*\b(carbon|material design|spectrum|polaris|fluent|primer)\b
  - \bdesign tokens?\b
auto: sandbox
---

# Design system

Builds a full design system as an npm workspace with the `design_system` tool:
- **Tokens:** palettes, four themes, enforced WCAG contrast, type, spacing, motion and grid.
- **Lit web components:** 25 accessible, form-associated elements.
- **React components:** typed wrappers.
- **Angular directives:** with `ControlValueAccessor`s.
- **Docs and tests.**

When the user asked for a design system, this skill takes precedence over `web-app`. Do **not** hand-write components or an `index.html`; the tool generates them.

## 1. Source

- **URL:** `design_system { url }`. The tool reads only the page's styles: colours by role, fonts, radii, control size and button style. It copies no text, photos, logos or font files.
  - If the user names a brand or says "like X" without a URL, ask whether to read a specific URL, or use images.
  - Reading someone else's brand is fine for exploration. Say in the summary that logos, names and fonts belong to their owners.
- **Images:** `design_system { images: [paths] }`, with the paths of the attached images, as listed under "Attachments" (`.harness/attachments/…`) or as files in the project. At most 6.
- Pass `name` when the user gave one. Pass `prefix` only when they asked for a specific tag prefix.
- Keep the `out` folder the tool reports. Every later call uses the same `out`.

## 2. Check the brand reading

The tool shows `docs/foundations.html` in the preview (no build needed). For a URL, it returns a screenshot of the source page.

- Compare the reported reading with the source:
  - Is the primary colour really the brand or action colour?
  - Is the theme right?
  - Are the fonts and radii plausible? Fully rounded buttons are radius 999.
  - Is the density right?
- When something is wrong, call `design_system { out, overrides: {…} }` with only the corrections, for example `{"colors": {"primary": "#0043ce"}}`, `{"radius": {"control": 0, "container": 0}}`, `{"fonts": {"sans": "IBM Plex Sans"}}` or `{"theme": "dark"}`. It regenerates from the saved `brand.json`.
- Apply the user's own wishes ("rounder", "more compact", "use our green #00a651") the same way.
- Do at most two correction rounds.

## 3. Build and test

Run these one after another with `bash`, inside `out`. They need the network for `npm install`.

```bash
npm install
npm run build
npm test
npm run docs:build
```

- If the user asked for Angular explicitly, also run `npm run build:angular`. It installs nothing extra but takes longer.
- When a step fails, read the error.
  - A problem in the brand reading (for example an unreadable colour) is fixed through `overrides`.
  - Never edit the generated files by hand: the next generation overwrites them.
  - A real generator bug is reported to the user, with the error output.

## 4. Look at it

1. `set_preview { path: "<out>/docs/dist/index.html" }`.
2. `check_preview { path: "<out>/docs/dist/index.html" }`, then `check_preview { path: "<out>/docs/dist/index.html?theme=darkest" }`.
3. Fix what they report through `overrides` and rerun steps 3 and 4. Stop when there are no problems.

## 5. Summary

Keep it short:
- **Where it is:** the folder and its packages (`@<prefix>-ds/tokens`, `/web-components`, `/react`, `/angular`, docs).
- **What came from the source and what was derived.** Quote the brand reading.
- **Results:** the contrast result and the test results, with numbers.
- **How to use it:** one line per framework, and how to switch themes (`data-<prefix>-theme="dark"`).
- **How to change the brand:** edit `brand.json`, or ask again with corrections.
- **Rights:** for another company's brand, say that its logos, names and fonts belong to its owner.
