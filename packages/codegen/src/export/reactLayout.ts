// The react-vite emitter's project: the React exporter's files (reactProject.ts:
// flat src/components, src/screens, Tailwind) laid out for a recreation and styled as asked:
//
//   src/components/<Set>/<Set>.tsx   a component set (typed props, looks as a `variant` union, lists as typed arrays)
//   src/sections/<Name>/<Name>.tsx   a page section (a component whose markup is one of the page's `data-section`s)
//   src/pages/<Page>.tsx             the page: its breakpoint variants composing sections and components
//   src/data/<module>.ts             the captured content of lists (copy as data, typed by the component's props)
//   src/styles/tokens.css            design tokens (+ @font-face), src/styles/index.css the reset and runtime CSS
//   src/lib/interactions.ts          useInteractions(): menus, sliders, region states (driven by data-* attributes)
//
// Styles: `tailwind` (the exporter's classes), `css-modules` or `vanilla` (reactStyles.ts).
import type { FileMap } from "./bundle.js";
import { addImport, convertReactStyles, type ReactStyle } from "./reactStyles.js";
import type { VarMap } from "./tokens.js";

export interface ReactViteOptions {
  style?: ReactStyle;
  projectName?: string;
  /** provenance for the README */
  sourceUrl?: string;
  capturedAt?: string;
  /** the rights notice the README carries */
  notice?: string;
  cssVars?: boolean;
  vars?: VarMap;
}

const TAILWIND_DEPS = ["tailwindcss", "postcss", "autoprefixer"];
const text = (v: FileMap[string] | undefined) =>
  typeof v === "string" ? v : v ? new TextDecoder().decode(v) : "";

/** The React exporter's project → the react-vite layout in the asked style. */
export function reactViteProject(input: FileMap, o: ReactViteOptions = {}): FileMap {
  const style = o.style ?? "tailwind";
  let files: FileMap = { ...input };
  if (style !== "tailwind") {
    files = convertReactStyles(files, { style, cssVars: o.cssVars, vars: o.vars });
    files = withoutTailwind(files, style);
  }
  files = withDataModules(files);
  const plan = layoutPlan(files);
  files = moved(files, plan);
  files["README.md"] = readme(files, plan, style, o);
  return files;
}

/* ------------------------------------------------------------------ no Tailwind */

function withoutTailwind(files: FileMap, style: Exclude<ReactStyle, "tailwind">): FileMap {
  const out = { ...files };
  delete out["tailwind.config.js"];
  delete out["postcss.config.js"];
  if (typeof out["package.json"] === "string") {
    const pkg = JSON.parse(out["package.json"]) as { devDependencies?: Record<string, string> };
    for (const d of TAILWIND_DEPS) delete pkg.devDependencies?.[d];
    out["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;
  }
  if (typeof out["src/index.css"] === "string")
    out["src/index.css"] = out["src/index.css"]
      .replace(
        /^\/\* Tailwind preflight is off[^\n]*\n/,
        "/* The page reset (the HTML export's), menus and the interactions runtime's CSS */\n",
      )
      .replace(/^@tailwind [a-z]+;\n?/gm, "")
      .replace(/\n{3,}/g, "\n\n");
  if (style === "vanilla" && typeof out["src/main.tsx"] === "string")
    out["src/main.tsx"] = out["src/main.tsx"].replace(
      "import './index.css'\n",
      "import './index.css'\nimport './styles.css'\n",
    );
  return out;
}

/* ------------------------------------------------------------------ data modules */

/** A module's top-level list of captured content: `const links: HeaderLink[] = [ … ]`. */
const LIST_DECL = /^const ([A-Za-z_$][\w$]*): ([A-Za-z_$][\w$]*)\[\] = \[\n[\s\S]*?\n\]\n/gm;
const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

/**
 * Lists of captured content (items' texts, links, images) move to `src/data/<module>.ts`, typed by the component's
 * props: copy is data. Lists that hold code (handlers, JSX) stay in their module.
 */
function withDataModules(files: FileMap): FileMap {
  const out = { ...files };
  for (const path of Object.keys(files).filter((p) => /^src\/(components|screens)\/[^/]+\.tsx$/.test(p))) {
    let src = text(files[path]);
    const name = path.replace(/^.*\//, "").replace(/\.tsx$/, "");
    const decls: Array<{ name: string; type: string; body: string }> = [];
    for (const m of src.matchAll(LIST_DECL)) {
      const body = m[0];
      if (/=>|\bonNavigate\b|\bonBack\b|\bsetOverlay\b|:\s*<[A-Za-z]/.test(body)) continue;
      decls.push({ name: m[1]!, type: m[2]!, body });
    }
    if (!decls.length) continue;
    for (const d of decls) src = src.replace(d.body, "");
    const dataPath = `src/data/${kebab(name)}.ts`;
    const imports = new Map<string, Set<string>>();
    const need = (from: string, what: string) => {
      const s = imports.get(from) ?? new Set();
      s.add(what);
      imports.set(from, s);
    };
    const self = relative("src/data", path.replace(/\.tsx$/, ""));
    for (const t of new Set(decls.map((d) => d.type))) {
      if (new RegExp(`^export (interface|type) ${t}\\b`, "m").test(src)) need(self, t);
      else if (new RegExp(`^(interface|type) ${t}\\b`, "m").test(src)) {
        src = src.replace(new RegExp(`^(interface|type) ${t}\\b`, "m"), (x) => `export ${x}`);
        need(self, t);
      } else {
        const imp = new RegExp(`^import [^\\n]*\\b${t}\\b[^\\n]* from '([^']+)'`, "m").exec(src);
        if (imp) need(relative("src/data", join(dirOf(path), imp[1]!)), t);
        // a type the module only used for its lists: no longer imported there
        const uses = src.match(new RegExp(`\\b${t}\\b`, "g"))?.length ?? 0;
        if (imp && uses === 1)
          src = src
            .replace(new RegExp(`, \\{ type ${t} \\}`), "")
            .replace(new RegExp(`^import type \\{ ${t} \\} from '[^']+'\\n`, "m"), "");
      }
    }
    const usesStyles = decls.some((d) => /\bstyles[.[]/.test(d.body));
    const head = [
      `// The captured content of ${name}'s lists: copy as data (edit it here; the markup stays in ${name}.tsx)`,
      ...[...imports].map(([from, ts]) => `import type { ${[...ts].sort().join(", ")} } from '${from}'`),
      ...(usesStyles ? [`import styles from '${self}.module.css'`] : []),
    ];
    out[dataPath] = `${head.join("\n")}\n\n${decls.map((d) => `export ${d.body}`).join("\n")}`;
    src = addImport(src, `import { ${decls.map((d) => d.name).join(", ")} } from '../data/${kebab(name)}'`);
    out[path] = src.replace(/\n{3,}/g, "\n\n");
  }
  return out;
}

/* ------------------------------------------------------------------ layout */

interface Plan {
  /** old path → new path */
  moves: Map<string, string>;
  components: string[];
  sections: string[];
  pages: string[];
}

function layoutPlan(files: FileMap): Plan {
  const moves = new Map<string, string>();
  const components: string[] = [],
    sections: string[] = [],
    pages: string[] = [];
  for (const p of Object.keys(files)) {
    const comp = /^src\/components\/([^/]+)\.tsx$/.exec(p);
    if (comp) {
      const name = comp[1]!;
      const section = /\bdata-section="/.test(text(files[p]));
      const dir = `src/${section ? "sections" : "components"}/${name}`;
      (section ? sections : components).push(name);
      moves.set(p, `${dir}/${name}.tsx`);
      for (const ext of [".css", ".module.css"])
        if (files[`src/components/${name}${ext}`] !== undefined)
          moves.set(`src/components/${name}${ext}`, `${dir}/${name}${ext}`);
      continue;
    }
    const screen = /^src\/screens\/([^/]+)\.(tsx|css|module\.css)$/.exec(p);
    if (screen) {
      moves.set(p, `src/pages/${screen[1]}.${screen[2]}`);
      if (screen[2] === "tsx") pages.push(screen[1]!);
    }
  }
  moves.set("src/tokens.css", "src/styles/tokens.css");
  moves.set("src/index.css", "src/styles/index.css");
  return { moves, components: components.sort(), sections: sections.sort(), pages: pages.sort() };
}

const dirOf = (p: string) => p.replace(/\/?[^/]*$/, "");
function relative(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let k = 0;
  while (k < a.length && k < b.length - 1 && a[k] === b[k]) k++;
  const up = a.length - k;
  const rest = b.slice(k).join("/");
  return up ? `${"../".repeat(up)}${rest}` : `./${rest}`;
}
function join(dir: string, spec: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const s of spec.split("/")) {
    if (s === ".") continue;
    if (s === "..") parts.pop();
    else parts.push(s);
  }
  return parts.join("/");
}

/** Files at their new paths, relative imports pointing at them (a component folder is imported by its index.ts). */
function moved(files: FileMap, plan: Plan): FileMap {
  const out: FileMap = {};
  const at = (p: string) => plan.moves.get(p) ?? p;
  const barrels = new Map<string, string>();
  for (const name of [...plan.components, ...plan.sections]) {
    const main = at(`src/components/${name}.tsx`);
    barrels.set(main, dirOf(main));
  }
  for (const [p, v] of Object.entries(files)) {
    const to = at(p);
    if (!/\.tsx?$/.test(p) || typeof v !== "string") {
      out[to] = v;
      continue;
    }
    const resolve = (spec: string): string => {
      if (!spec.startsWith(".")) return spec;
      const base = join(dirOf(p), spec);
      const old = [base, `${base}.tsx`, `${base}.ts`].find((c) => files[c] !== undefined);
      if (!old) return spec;
      const target = at(old);
      const barrel = barrels.get(target);
      if (barrel && dirOf(to) !== barrel) return relative(dirOf(to), barrel);
      return relative(dirOf(to), target).replace(/\.tsx?$/, "");
    };
    out[to] = v
      .replace(
        /(\bfrom\s+|\bimport\s+)'(\.[^']*)'/g,
        (_, kw: string, spec: string) => `${kw}'${resolve(spec)}'`,
      )
      .replace(
        /(\bfrom\s+|\bimport\s+)"(\.[^"]*)"/g,
        (_, kw: string, spec: string) => `${kw}"${resolve(spec)}"`,
      )
      .replace(/\bsrc\/screens\b/g, "src/pages");
  }
  for (const [main, dir] of barrels) {
    const name = main.replace(/^.*\//, "").replace(/\.tsx$/, "");
    out[`${dir}/index.ts`] = `export { default } from './${name}'\nexport * from './${name}'\n`;
  }
  return out;
}

/* ------------------------------------------------------------------ README */

function readme(files: FileMap, plan: Plan, style: ReactStyle, o: ReactViteOptions): string {
  const has = (p: string) => files[p] !== undefined;
  const data = Object.keys(files)
    .filter((p) => p.startsWith("src/data/"))
    .sort();
  const list = (xs: string[], max = 10) =>
    xs.length ? `${xs.slice(0, max).join(", ")}${xs.length > max ? ", …" : ""}` : "";
  const styleText: Record<ReactStyle, string> = {
    tailwind:
      "Tailwind CSS 3 classes. Values without a Tailwind scale are arbitrary values (`w-[312px]`) or arbitrary properties (`[mask-image:…]`); breakpoint looks are `min-[…]:` / `max-[…]:` classes. Tailwind's preflight is off: `src/styles/index.css` holds the HTML export's reset, so both render alike.",
    "css-modules":
      "CSS Modules. Every component, section and page imports its own `<Name>.module.css` as `styles` and uses `className={styles.box}`; one generated class per element (or per look of a component), breakpoint looks as `@media` rules at the end of the module. No Tailwind.",
    vanilla:
      "Plain CSS. One global `src/styles.css` (imported once in `src/main.tsx`) holds a generated class per element, prefixed with its module (`.home__box`, `.header__nav`); breakpoint looks as `@media` rules at its end. No Tailwind.",
  };
  const tree = [
    "src/",
    "  main.tsx                 entry: tokens, reset, <App />",
    "  App.tsx                  shows the page; installs the interactions runtime once",
    "  types.ts                 ScreenKey / ScreenProps (+ the design-system components' props)",
    ...(plan.pages.length
      ? [`  pages/<Page>.tsx         ${list(plan.pages)}: the breakpoint variants of the page`]
      : []),
    ...(plan.sections.length
      ? [`  sections/<Name>/         ${list(plan.sections)}: the page's sections`]
      : []),
    ...(plan.components.length ? [`  components/<Set>/        ${list(plan.components)}`] : []),
    ...(data.length ? ["  data/<module>.ts         captured content of lists (texts, links, images)"] : []),
    ...(has("src/lib/interactions.ts")
      ? ["  lib/interactions.ts      useInteractions(): menus, sliders, region states"]
      : []),
    ...(has("src/lib/cn.ts") ? ["  lib/cn.ts                joins class names"] : []),
    "  styles/tokens.css        design tokens as CSS custom properties (+ webfonts)",
    "  styles/index.css         page reset, menu overlays, runtime CSS",
    ...(style === "vanilla" ? ["  styles.css               every generated class (global)"] : []),
    "public/                    images and font files",
  ];
  return `# ${o.projectName ?? "Recreated page"}

React 18 + TypeScript, built with Vite. Styles: **${style}**.

\`\`\`bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-checks, then writes dist/ (npm run preview serves it)
\`\`\`

## Provenance

- Source: ${o.sourceUrl ?? "unknown"}
- Captured: ${o.capturedAt ?? "unknown"}
- Generator: CDR recreate (react-vite emitter)

${o.notice ?? ""}

## Layout

\`\`\`
${tree.join("\n")}
\`\`\`

- Components take typed props: looks as a \`variant\` union, list items as typed arrays (\`items: Item[]\`), content
  (texts, images, links) as props; \`className\` / \`style\` place an instance on the page.
- The pages render one variant per measured breakpoint (\`<div data-bp="768">\`); exactly one shows at any width.
- Keep the \`data-*\` attributes (\`data-overlay\`, \`data-open-overlay\`, \`data-scroll-by\`, \`data-scroller\`,
  \`data-section\`): \`useInteractions()\` (src/lib/interactions.ts) drives menus and sliders through them.

## Styles

${styleText[style]}

Colours, radii, shadows and fonts come from \`src/styles/tokens.css\`. Per-page CSS the classes cannot carry (scaling a
page narrower than measured, menu panels, pseudo elements) lives next to the page as \`<Page>.css\`.
`;
}
