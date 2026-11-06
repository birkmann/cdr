# React project structure (recreate → react-vite)

The `react-vite` emitter writes a Vite + React 18 + TypeScript project. Styles: `tailwind` (default), `css-modules` or
`vanilla` (`recreate_convert { to: "react-vite", style }`). Follow this layout when editing it:

```
index.html                     Vite entry page
package.json                   react, react-dom; vite, typescript (+ tailwindcss, postcss, autoprefixer: tailwind only)
vite.config.ts, tsconfig.json  strict TypeScript, no unused locals / parameters
tailwind.config.js             tailwind only: the tokens as Tailwind colours / radii / shadows / fonts (preflight off)
postcss.config.js              tailwind only
README.md                      provenance (source URL, capture date), rights notice, layout, styles
RECREATION.md, credits.json    provenance and the fonts' sources
src/
  main.tsx                     imports styles/tokens.css, styles/index.css (vanilla: also styles.css), renders <App />
  App.tsx                      shows the page; calls useInteractions() once (when the page has menus / sliders)
  types.ts                     ScreenKey / ScreenProps (onNavigate, onBack) and the design-system components' props
  pages/<Page>.tsx             the page: one <div data-bp="…"> per measured breakpoint, exactly one visible at a time;
                               menus as <div data-overlay="…"> layers (useState in the page opens them)
  pages/<Page>.css             global page CSS: scaling below the narrowest measured width, menu panels, pseudo elements
  sections/<Name>/<Name>.tsx   a page section: a component whose markup carries data-section="…" (Header, Hero, Footer)
  sections/<Name>/index.ts     re-exports the component: import it as '../sections/<Name>'
  components/<Set>/<Set>.tsx   a component set: typed props, looks as `variant: 'sm' | 'md' | …`, list items as typed
                               arrays (`colsButtons: ColsTextBlockColsButton[]`), texts / images / links as props,
                               `className` / `style` to place an instance
  components/<Set>/index.ts    re-exports the component: import it as '../components/<Set>'
  components/<Set>/<Set>.css   pseudo-element rules a class cannot express (only when needed)
  data/<module>.ts             captured content of a module's lists (`export const links: HeaderLink[] = [...]`),
                               typed by the component's props; the module imports it from '../data/<module>'
  lib/interactions.ts          useInteractions(): menus (scroll lock, focus), slider arrows / dots / drag, region states
  lib/cn.ts                    cn(...classes): joins class names
  styles/tokens.css            design tokens as CSS custom properties (--t-primary, --t-radius, …) and @font-face rules
  styles/index.css             the page reset (same as the static export), menu overlay CSS, the runtime's CSS
                               (tailwind: also the @tailwind directives)
public/                        images (public/images) and font files
```

Per style:

- **tailwind**: classes in the markup (`className="flex gap-[12px] min-[768px]:hidden"`); values without a Tailwind
  scale are arbitrary values / properties; breakpoint looks are `min-[…]:` / `max-[…]:` classes.
- **css-modules**: every component, section and page has `<Name>.module.css` next to it, imported as
  `import styles from './<Name>.module.css'` and used as `className={styles.box}` (in look tables too:
  `root: styles.smRoot`). One generated class per element (or per look); breakpoint looks are `@media` rules at the end
  of the module. A data module whose items carry classes imports the owning module's CSS.
- **vanilla**: one global `src/styles.css` holds a class per element, prefixed with its module
  (`.home__box`, `.header__nav`, `.card__sm-root`); markup uses plain `className="home__box"`; `@media` rules at the end.

Classes the page CSS defines (`home-fx-1`: pseudo elements) stay global in every style.

Rules:

- Copy is data: change list content in `src/data/*.ts`, other text in the page or section props, not in shared components.
- Keep the `data-*` attributes (`data-overlay`, `data-open-overlay`, `data-scroll-by`, `data-scroller`, `data-section`,
  `data-bp`, `data-page`): the interactions runtime and the page CSS depend on them.
- New components go to `src/components/<Name>/<Name>.tsx` (+ `index.ts`, + `<Name>.module.css` for css-modules) with a
  PascalCase name that says what they are (`ProductCard`), never page copy or a number.
- Style edits go where the style keeps them: the class list (tailwind), the module's `.module.css` (css-modules) or
  `src/styles.css` (vanilla). Keep breakpoint rules inside their `@media` block.
- Colours, radii, shadows and fonts come from `src/styles/tokens.css` variables; do not hard-code them.
- Run `npm run build` after changes; `tsc` must stay clean.
