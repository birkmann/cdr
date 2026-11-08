# Design systems from a URL or images

CDR can build a complete design system in the spirit of IBM Carbon from a web page or from a few images: screenshots, mockups or a mood board. The result is an npm workspace you own:

| Package | Contents |
| --- | --- |
| `@<prefix>-ds/tokens` | Palettes, semantic tokens in four themes (`light`, `light-alt`, `dark`, `darkest`), type, spacing, sizes, radii, elevation, motion, breakpoints and grid. Exported as CSS variables, SCSS, JS/TS, DTCG JSON and a Tailwind preset. Comes with a contrast report |
| `@<prefix>-ds/web-components` | 25 accessible components as Lit custom elements (`<acme-button>` …). They follow the WAI-ARIA patterns, support the keyboard, take part in forms (`ElementInternals`) and are themed only by tokens |
| `@<prefix>-ds/react` | Typed React components over the web components (`@lit/react`), with `onChange`, `onDismiss` and so on |
| `@<prefix>-ds/angular` | Standalone directives with typed inputs and outputs, and `ControlValueAccessor`s for `ngModel` and reactive forms (built with ng-packagr) |
| `docs` | A docs site: foundations, every component with its props and events, a theme switcher, and code for Lit, React and Angular |

## In a chat

Ask for it, for example:
- "Create a design system like Carbon from https://example.com"
- "Build a component library from these screenshots", with images attached

The `design-system` skill then runs the whole pipeline on its own:

1. `design_system { url }` or `design_system { images }` reads the brand and writes the workspace. The preview shows `docs/foundations.html`, which needs no build.
2. The agent compares the reading with the source and corrects wrong roles: `design_system { out, overrides }`.
3. In the workspace it runs `npm install`, `npm run build`, `npm test` and `npm run docs:build`. This needs the network.
4. `check_preview` checks the docs at phone and desktop widths, in the light and dark themes.
5. The agent writes a summary: what came from the source and what was derived, the contrast and test results, and how to use each framework.

## How the brand is read

- **From a URL.** The page is captured once at 1440 px in headless Chrome, with the same request guard and `robots.txt` handling as `recreate`. The brand reader of the recreate pipeline then finds the colours by role, the fonts, the type scale, the radii, the control height and the button style. Only styles are read: no text, photos, logos or font files end up in the output. Fonts are named, but not bundled.
- **From images.** The dominant colours are measured from the pixels in headless Chrome (k-means in Lab space). A vision model then assigns roles and judges the fonts (as the nearest common family), radii, density, button style and elevation. Colours it names are snapped to the measured ones, so hex values come from the image. Without a vision model, the measured palette alone is used, and the rest uses defaults.
- **Overrides** correct the reading or apply the user's wishes. They are merged last and recorded as `override` in `brand.json`.

`brand.json` is the small, editable result. Every token, theme and package is derived from it deterministically, so the same `brand.json` always gives the same files.

## Tokens and contrast

Each colour gets a ten-step palette (10 lightest, 100 darkest) in OKLCH. The brand colour keeps its exact value at the step nearest in lightness.

Semantic tokens such as `interactive`, `text-secondary`, `layer-01`, `button-primary` and `support-error` take their values from the palettes in each of the four themes. Contrast is checked, not assumed:

| Pairs | Minimum |
| --- | --- |
| Text, links and button labels | 4.5:1 |
| Focus, borders, icons and status colours | 3:1 |

A colour that fails moves along its palette until it passes. The primary button keeps the brand colour whenever black or white text reads on it. `packages/tokens/contrast.json` lists every pair, and the tokens package's test fails if any pair is below its minimum.

## The components

These are the 25 elements:
- **Actions:** button, icon button, link
- **Forms:** text input, textarea, select, dropdown (listbox), checkbox, radio group with radio, toggle, search
- **Content:** tag, accordion with item, tile, icon
- **Feedback:** notification (inline and toast), modal, tooltip, progress bar, loading
- **Navigation:** tabs with tab, breadcrumb with item, pagination
- **Data:** data table

Every element:
- uses token variables only, so a new theme changes no component code
- reflects its state in ARIA
- shows a visible `:focus-visible` ring
- honours `prefers-reduced-motion`

The form controls submit, reset and report validity with their form. The tabs, radio groups and dropdown use the keyboard patterns of the WAI-ARIA Authoring Practices. The modal is a native `<dialog>`: focus is trapped inside it, Esc closes it, and focus returns to the element that opened it.

The React and Angular packages wrap the same elements, so all three frameworks look and behave the same. React server rendering shows the elements before they upgrade.

## Configuration

```jsonc
{
  "designSystem": {
    "model": "anthropic/claude-sonnet-5-5" // vision model for image readings (default: the executor)
  },
  "recreate": { "allowLocal": false, "respectRobots": true } // also apply to URL readings
}
```

## Development

- **Generator:** `packages/design-system`. The component sources are real TypeScript files under `packages/design-system/templates/`, with `__P__` standing for the prefix. After editing them, run `node scripts/design-system/embed.mjs`; a test checks that the embedded copy is current.
- **Tests:**
  - colour maths, palettes, and contrast for hard brand colours
  - token outputs
  - the readers (the recorded Acme fixture; images in Chrome)
  - the workspace structure
  - a `tsc` check of the generated web components and React wrappers
  - behaviour tests of the generated elements in headless Chrome, with real keyboard input
  - the core tool from images and from the fixture site
- **Real build:** `CDR_DS_BUILD=1 pnpm vitest run packages/design-system` runs `npm install`, `build`, `test`, `build:angular` and `docs:build` on a generated workspace. This needs the network.
- **Plan and scope:** [plans/design-system-pipeline.md](plans/design-system-pipeline.md).
