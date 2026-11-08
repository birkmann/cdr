# Plan: design-system pipeline (from a URL or from images)

Status: implemented. The user guide is [../design-system.md](../design-system.md); section 11 records what is in and what is left.

## 1. Goal

From one input, a **URL** or **one or more images** (screenshots, mockups, a mood board), CDR builds a complete, buildable, tested design system in the spirit of IBM Carbon:

- **Design tokens.** Primitive colour palettes, semantic tokens in four themes, type, spacing, sizes, radii, elevation, motion, breakpoints and grid. Exported as DTCG JSON, CSS custom properties, SCSS, JS/TS and a Tailwind preset.
- **Web components in Lit.** These are the single implementation of every component: behaviour, accessibility, keyboard support, form participation, events and theming.
- **React components.** Typed wrappers over the web components (`@lit/react`), with React props and `onX` events.
- **Angular components.** Standalone directives over the web components, with typed inputs and outputs, and a `ControlValueAccessor` so form controls work with `ngModel` and reactive forms.
- **Documentation.** A docs site with every component in every theme, the foundations (palettes, contrast table, type, spacing), and usage code for each framework. Also a foundations page that works without a build.
- **Tests.** Behaviour and accessibility tests for the components, and contrast checks for the tokens.

The pipeline runs **autonomously inside a chat** through a skill and a tool. Section 8 has the exact loop.

## 2. What exists, and why it is not enough

The recreate pipeline (`docs/recreate.md`) already does a lot from a URL. It captures the page, reads the brand's foundations (`@harness/extract` `brandFoundations`: colours by role, type scale, radii, spacing, control look), generates about 35 essential components in the brand's look (`completeDesignSystem`), and emits `ds-react`, `ds-lit`, `ds-angular` and `tokens`.

Those packages are **visual snapshots** of the page's layers. State is a variant prop: a checkbox is `state="checked"`, and clicking it does nothing. There is no keyboard support, no form participation, no events, no focus management and no themes. That is right for a 1:1 recreation and wrong for a design system.

The new pipeline therefore **reuses the brand reading** (capture → scene → `brandFoundations`) and adds a new generator, `@harness/design-system`. Components in that generator are hand-written and behave correctly; the brand reaches them **only through tokens**, the way Carbon's components are themed only by tokens.

## 3. Architecture

```
input ──► brand spec ──► token system ──► packages ──► build · test · look ──► fix overrides ──► repeat
 URL        brand.json     palettes, themes,  tokens, web-components,   npm install, build,
 images                    contrast fixes     react, angular, docs      test, check_preview
```

1. **Source → `BrandSpec`** (`brand.json`). The spec is small and readable, and the agent and the user can edit it:
   - name, prefix
   - colours: primary (required), secondary, accent, neutral tint, success, warning, danger, info, plus the background, surface and text colours seen
   - theme of the source: light or dark
   - fonts: sans, mono, display
   - radii: control and container
   - control height and density: compact, normal or spacious
   - button style: filled or outline secondary, uppercase labels
   - elevation: none, soft or strong
   - source notes: where each value came from
2. **`BrandSpec` → `TokenSystem`.** This step is deterministic and pure (section 5).
3. **`TokenSystem` + component templates → files.** Also deterministic and pure (section 6).
4. **Verification** happens inside the tool (static checks) and through the agent (build, tests, visual review), as described in section 8.

There is one implementation per component (Lit) and the other frameworks wrap it. This is the approach Carbon's own web components (`@carbon/web-components` ships React wrappers), Shoelace and Ionic use. It guarantees that the three frameworks look and behave the same, and keeps the generator maintainable. The cost is that React server rendering shows the elements before they upgrade; the README says so.

## 4. Inputs

### 4.1 From a URL

- The page is captured with `@harness/capture` `CdpCaptureDriver`, at one desktop width (1440). Its request guard and `robots.txt` handling apply, it uses a fresh anonymous profile, and on-load overlays are dismissed.
- `pageScreens` then `brandFoundations` turn the capture into tokens (primary, background, surface, text, muted text, status colours, radius, font) and a summary (fonts, type scale, control height, radius, outline or tonal secondary, uppercase labels, spacing).
- These map onto a `BrandSpec`, with every value recorded as `site`.
- Only styles are read. No copy, photos, logos or font files go into the output.
- The permission request names the URL. It is medium risk: a network fetch of a public page.

### 4.2 From images

- The images are project paths, for example chat attachments under `.harness/attachments/…` or files in the project. Supported formats are PNG, JPEG, WebP and GIF, at most 6 images and 10 MB each.
- **Pixel palette, deterministic.** Each image is drawn to a canvas in headless Chrome and its colours are clustered (k-means in Lab space, k = 8, on a 160 px thumbnail). This gives the dominant colours with their share of the image.
- **Roles, from a vision model.** The model is `designSystem.model`, falling back to the executor. It gets the images, the pixel palette and a strict JSON schema of `BrandSpec`. It assigns roles (which colour is primary, background, text…) and judges the rest: fonts, as the nearest common family, radii, density, button style and elevation.
- **Snapping.** Any colour the model names is snapped to the nearest pixel-palette colour when the two are within ΔE 6, so hex values are measured, not guessed.
- **Without a vision model,** the pixel palette alone fills the spec. The most chromatic frequent colour becomes primary, the most frequent light or dark colour becomes the background, and the rest uses defaults. Each such value is recorded as a default.

### 4.3 Overrides

`overrides` (a partial `BrandSpec`) is merged last. It is how the agent fixes what the review found ("primary should be the darker blue") and how the user asks for changes ("rounder buttons", "Inter for body text").

## 5. Token system

All of this lives in `packages/design-system/src/tokens/`.

**Colour space.** OKLCH, with conversions to and from sRGB and WCAG relative luminance written in-house, with no dependencies.

**Primitive palettes.** Ten steps, 10 to 100, Carbon-style, where 10 is lightest. There is one palette per brand hue (primary, plus secondary and accent when they are given), and one each for `gray` (tinted towards the neutral tint), `red`, `green`, `yellow` and `blue`. The status palettes use the brand's status colours when given, otherwise standard hues.

**The brand colour keeps its value.** It is placed at the step whose lightness is closest, and the other steps are interpolated around it in lightness, with chroma eased towards the ends.

**Semantic tokens.** Carbon's set, renamed where Carbon's names are internal:

| Group | Tokens |
| --- | --- |
| Background and layers | `background`, `background-hover`, `background-active`, `background-inverse`, `background-brand`, `layer-01..03` (each with `-hover`, `-active`), `layer-accent-01` |
| Fields | `field-01`, `field-02`, `field-hover` |
| Borders | `border-subtle-01`, `border-strong-01`, `border-interactive`, `border-disabled` |
| Text | `text-primary`, `text-secondary`, `text-placeholder`, `text-helper`, `text-error`, `text-on-color`, `text-inverse`, `text-disabled` |
| Links | `link-primary`, `link-primary-hover`, `link-visited` |
| Icons | `icon-primary`, `icon-secondary`, `icon-on-color`, `icon-disabled` |
| Buttons | `button-primary` (`-hover`, `-active`), `button-secondary` (…), `button-tertiary` (…), `button-danger` (…), `button-disabled` |
| Support | `support-error`, `support-success`, `support-warning`, `support-info`, plus a subtle background for each |
| Focus, overlays, misc | `focus`, `focus-inset`, `interactive`, `overlay`, `skeleton`, `highlight`, `toggle-off`, `shadow` |

**Themes.** Carbon's four, renamed:

| Theme | Carbon name | Base |
| --- | --- | --- |
| `light` | White | white |
| `light-alt` | Gray 10 | gray 10 |
| `dark` | Gray 90 | gray 90 |
| `darkest` | Gray 100 | gray 100 |

The theme of the source is the default theme.

**Contrast is enforced, not hoped for.** For every theme, each pair below is checked:

| Pair | Minimum ratio |
| --- | --- |
| text on its background | 4.5 |
| secondary text | 4.5 |
| on-colour text on the button and interactive colours | 4.5 |
| focus colour against the background | 3 |
| strong borders and control outlines | 3 |

A pair below its target moves along its palette, then switches to the other end (white or black text), until it passes. The result is a **contrast report** (`tokens/contrast.json`) and a table in the docs. A test asserts that every pair passes in every theme.

**Type.** Families are `sans`, `mono` and `display`, with system fallbacks. The tokens are `label-01`, `helper-text-01`, `body-compact-01/02`, `body-01/02`, `heading-compact-01/02`, `heading-01..05` and `display-01..02`, each with a size, weight, line height and letter spacing. They are derived from the source's scale when one was read, otherwise from a 1.125 or 1.25 ratio depending on density.

**Spacing.** `spacing-01..13`: Carbon's 2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160, multiplied by the density factor (0.875 for compact, 1 for normal, 1.125 for spacious) and rounded to whole pixels.

**Sizes.** Control heights `size-sm`, `size-md` and `size-lg` (default 32, 40, 48), with `md` taken from the brand's control height.

**Radii and elevation.** Radii are `radius-control`, `radius-container` and `radius-pill`. Elevation is `shadow-01..03`, from the brand's elevation setting.

**Motion.** Durations `duration-fast-01/02`, `duration-moderate-01/02` and `duration-slow-01/02`, and easings `easing-standard`, `easing-entrance` and `easing-exit`, both in productive and expressive variants. `prefers-reduced-motion` sets every duration to 0.

**Breakpoints and grid.**

| Breakpoint | Min width | Columns |
| --- | --- | --- |
| sm | 320 | 4 |
| md | 672 | 8 |
| lg | 1056 | 16 |
| xlg | 1312 | 16 |
| max | 1584 | 16 |

Gutters are 32 px, with a 16 px margin. A dependency-free `grid.css` provides `.<p>-grid`, `.<p>-col-<bp>-<n>` and `.<p>-grid--narrow` / `--condensed`.

**Outputs:**

```
tokens.json        DTCG ($value/$type), all tiers and themes
css/tokens.css     :root = default theme, [data-<p>-theme="…"] per theme, plus .<p>-theme--… classes
css/grid.css
scss/_tokens.scss  maps and variables
js/index.js, .d.ts typed token objects, themes and breakpoints
tailwind.preset.js colours, spacing, radii and fonts as var() references
contrast.json
```

## 6. Components

The tag prefix comes from the brand, for example `acme-` gives `acme-button`. CSS properties are `--<prefix>-…`. Every component meets the requirements below.

### 6.1 Requirements for every component

- **Shadow DOM**, with styles that only use token variables: no raw colours or sizes except 0, 1 px hairlines and percentages.
- **Reflected attributes** and properties typed in TypeScript, with JSDoc that `custom-elements.json` and the docs read. Every `@csspart`, `@slot` and `@fires` is documented.
- **Accessibility:**
  - the correct role, or a native element underneath
  - every `aria-*` state kept in sync
  - a label for every control
  - focus visible through `focus` tokens (2 px outline, `:focus-visible`)
  - disabled controls cannot be focused or activated, except where the WAI-ARIA Authoring Practices Guide (APG) says they should stay focusable
- **Keyboard** behaviour as in the APG pattern of each component (table below).
- **Form controls are form-associated** (`ElementInternals`): they have a value, take part in form submission and reset, report validity, and carry `name`, `required` and `disabled`.
- **Events:** native `change` and `input` events where the platform has them. Otherwise `<prefix>-<name>` custom events (`bubbles`, `composed`) with a typed `detail`.
- **Motion** uses motion tokens and respects reduced motion.

### 6.2 The set (25 elements)

| Element | Purpose | Key behaviour |
| --- | --- | --- |
| `button` | Action | kinds primary, secondary, tertiary, ghost, danger; sizes sm, md, lg; `href` renders a link; submit and reset inside forms; disabled |
| `icon-button` | Icon-only action | required `label` (aria-label and tooltip) |
| `link` | Navigation | inline or standalone, visited, disabled |
| `text-input` | One line | label, helper, invalid with message, warn, disabled, readonly, size, `type`; form-associated |
| `textarea` | Several lines | as `text-input`, plus rows and a counter with `maxlength` |
| `select` | Native select, styled | label, helper, invalid, options as slotted `<option>`; form-associated |
| `dropdown` | Custom listbox | APG select-only combobox: Space, Enter and Alt+↓ open it; ↑/↓, Home and End move; typing a letter jumps; Esc closes; form-associated |
| `checkbox` | Yes or no | checked, indeterminate, disabled, invalid; Space toggles; form-associated |
| `radio-group` and `radio` | One of several | roving tabindex, arrow keys move and select, required; the group is form-associated |
| `toggle` | On or off switch | `role=switch`, Space and Enter, on and off labels; form-associated |
| `search` | Search field | clear button, Esc clears, `<p>-search` event on Enter |
| `tag` | Label, filter | types (gray and the support colours), filter type with a dismiss button and a `<p>-dismiss` event |
| `notification` | Inline status | kinds error, success, warning, info; low contrast; closable (`<p>-close`); `role=status` or `alert`; `toast` variant |
| `modal` | Dialog | native `<dialog>`; focus trap, Esc, focus returns afterwards; sizes; danger; `<p>-close`; primary and secondary buttons |
| `tabs` and `tab` | Views | APG tabs: ←/→, Home and End; automatic activation; `aria-controls`; `<p>-change` event |
| `accordion` and `accordion-item` | Disclosure | button with `aria-expanded`, Enter and Space |
| `tooltip` | Hint | appears on hover and focus; Esc hides it; `role=tooltip`, `aria-describedby` |
| `progress-bar` | Progress | value and max, indeterminate, label, helper, status; `role=progressbar` |
| `loading` | Spinner | small or large, label, reduced motion |
| `breadcrumb` and `breadcrumb-item` | Location | `nav` with `aria-label`; current page `aria-current` |
| `pagination` | Pages | previous, next, page select, page size; `<p>-page-change` event |
| `tile` | Container | static, clickable (a link) and selectable (checkbox semantics) |
| `data-table` | Tabular data | `columns` and `rows` properties, sortable headers (`aria-sort`), zebra, sizes, a caption; `<p>-sort` event |

### 6.3 Icons

About 16 own SVG paths on a 16 or 20 px grid: close, chevron (down, up, left, right), check, subtract, search, info, warning, error, success, add, menu and overflow. They are exported as an `icons` module, and an `icon` element renders them by name.

### 6.4 React

There is one `createComponent` wrapper per element (`@lit/react`). Events map to `onChange`, `onInput`, `onDismiss` and so on, props are typed from the element classes, and `forwardRef` reaches the element. A `Theme` component sets `data-<p>-theme`.

### 6.5 Angular

There is one standalone directive per element, with the selector set to the tag. Inputs are set as properties and outputs are re-emitted custom events. Form elements get a `ControlValueAccessor` that keeps the value or `checked` in sync, `touched` on blur, and `disabled`. `<P>Module` exports them all, together with `CUSTOM_ELEMENTS_SCHEMA` usage notes. The library builds with `ng-packagr`.

## 7. Generated workspace

```
<out>/
  package.json                 npm workspaces; scripts: build, test, docs, dev
  README.md                    install, theming, per-framework usage, how to regenerate
  DESIGN.md                    principles, the brand reading (what came from the source, what was derived), token tiers
  brand.json                   the BrandSpec (edit it and regenerate)
  packages/tokens/             @<scope>/tokens: section 5 outputs; no build needed
  packages/web-components/     @<scope>/web-components: src/components/*.ts, src/icons.ts, src/index.ts,
                               test/*.test.ts (vitest + happy-dom), tsconfig, custom-elements manifest config
  packages/react/              @<scope>/react: src/index.ts (wrappers), tsconfig
  packages/angular/            @<scope>/angular: src/lib/*.ts, src/public-api.ts, ng-package.json
  docs/                        vite app: index.html, main.ts (imports the web components); foundations, components,
                               a theme switcher and code tabs (Lit, React, Angular)
  docs/foundations.html        static: palettes, themes, contrast, type, spacing (works before any install)
```

The package scope is `@<prefix>-ds`, for example `@acme-ds/web-components`. The version is `0.1.0`, with `peerDependencies` on lit, react or angular.

## 8. The autonomous loop

This is the skill, `design-system`.

1. **Source.**
   - **URL:** `design_system { url }`. With "like", "inspired by" or a brand name, the agent asks whether the URL should be read.
   - **Images:** `design_system { images: [paths] }`.
   - The tool writes the workspace, `brand.json` and the reading report, and emits a preview of `docs/foundations.html`.
2. **Check the reading.** `check_preview docs/foundations.html`. With a vision model, the agent compares the source (the images, or the live shot the tool returns) with the foundations, and fixes wrong roles through `overrides`, rerunning step 1 with the same `out`. At most two rounds.
3. **Build and test.** `bash`: `npm install`, then `npm run build`, then `npm test`, in `<out>`. This needs the network, and the skill says so. A failure is fixed in the generator inputs (`overrides`), never by editing generated files by hand. A real generator bug is reported to the user.
4. **Look at the components.** `npm run docs:build`, then `set_preview docs/dist/index.html`, then `check_preview` at phone and desktop widths, in the light and dark themes (`?theme=`).
5. **Finish** with a summary: where the system is, what was read from the source and what was derived, the contrast result, the test result, how to use each framework, and how to regenerate.

**Stop rules.** Stop when the build and tests pass and `check_preview` reports no problems, or after two override rounds. No polishing loops.

## 9. CDR integration

| Area | Change |
| --- | --- |
| Package | `packages/design-system` (`@harness/design-system`), which depends on protocol, capture, scene and extract |
| Core tool | `design_system` in `packages/core/src/tools/design-system.ts`. It confines paths with `resolveInProject` and returns `{ ok, output }` without throwing. Risk is medium: it writes files, and a URL fetches the network |
| Skill | `packages/core/skills/design-system/SKILL.md`, which loads automatically on "design system", "component library" or "like Carbon" in sandbox chats |
| Config | `designSystem.model`, the vision model for image readings (default: the executor). Schemas are regenerated |
| UI | Tool labels in the web app and the step category in the run report |
| Events | No new event types. Tool calls and `preview.ready` are events already |
| Docs | `docs/design-system.md` (user guide), `docs/skills.md`, CHANGELOG |

## 10. Tests

These run in CDR's own suite; none of them call a model or the network.

- **Colour maths.** sRGB ↔ OKLCH round trips, WCAG contrast, ΔE.
- **Palettes.** Ten monotonic steps, and the brand colour appears exactly at its step.
- **Themes.** Every semantic token exists in every theme, and every contrast pair passes in every theme, including for hostile brands: yellow primary, very dark primary, a grey brand.
- **Token outputs.** `tokens.json` is valid DTCG, the CSS has every variable for every theme, and the SCSS, JS and Tailwind outputs agree.
- **BrandSpec readers.** URL: the recorded Acme fixture snapshot goes through `brandFoundations` to a spec (no browser). Images: pixel clustering on a generated PNG, the vision reply parser, snapping, and the fallback without vision.
- **Generator.** The file tree, valid `package.json` files, every element registered once, every element having a React wrapper and an Angular directive, no raw colours in component CSS, and the prefix applied everywhere.
- **TypeScript.** The generated web components and React wrappers typecheck with `tsc` against lit, `@lit/react` and react, which are dev dependencies of `@harness/design-system`.
- **Behaviour, in headless Chrome** (skipped without Chrome). The generated web components are bundled with esbuild and checked for:
  - roles and ARIA on every element
  - checkbox click and Space; form value and reset
  - radio arrow keys
  - tabs arrow keys
  - modal Esc and returning focus
  - dropdown keyboard selection
  - toggle
  - tag dismiss event
  - text input value in `FormData`
  - contrast of the computed styles in the default theme
- **Tool.** Images in, workspace out (a fake vision `complete`); path confinement; a missing input gives a model-readable error.
- **Skill.** It loads on its triggers.
- **Optional real builds:** `CDR_DS_BUILD=1` runs `npm install`, `npm run build` and `npm test` in a generated workspace, including Angular's `ng-packagr`. This needs the network and is off by default.

## 11. Scope of this implementation

**Done:**
- sections 4 to 10, with the 25 elements in section 6.2
- tokens with four themes and contrast enforcement
- the Lit, React and Angular packages, the docs app, the static foundations page, the tool, the skill and the tests

**Left for later:**
- a `cdr design-system` CLI command; in the meantime use a chat, or `cdr run` with the skill
- a Figma variables export
- date picker, combo box with filtering, multiselect, number input, slider, file uploader, structured list, tree view, side nav, header/UI shell, overflow menu and popover
- a component visual-regression baseline
- reading a font from an image by OCR, rather than the vision model's nearest family
