// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// React + Tailwind export: a runnable Vite project (`npm install && npm run dev` / `npm run build`, nothing to scaffold).
// One component per page (a responsive group renders every breakpoint variant; Tailwind `min-[…]` classes show one)
// built from shared components with typed props (reactComponents.ts: src/components; with the design system, its
// instances are the sets' components: Header, Hero, Footer…), screen keys typed in
// src/types.ts; src/index.css = tokens + @font-face + the HTML export's reset (Tailwind preflight is off so both
// exports draw the same), images and fonts as files under public/.
import { escHtml, walkIr, type IrElement, type IrNode, type StyleMap } from "./ir.js";
import { BASE_CSS, safeLang } from "./html.js";
import {
  screenComponent,
  type ComponentOverlay,
  type ComponentVariant,
  type ReactEmitOptions,
} from "./react.js";
import { CN_SOURCE, sharedComponents, type SharedComponent } from "./reactComponents.js";
import { capWideCss, exportPages, fitZoomCss } from "./responsive.js";
import { createNamer, pascalCase, slugify } from "@harness/scene";
import { tokensCss, tailwindConfig, tailwindColorNames } from "./tokens.js";
import {
  adaptedCss,
  attributionMarkdown,
  matchScreen,
  overlayOpeners,
  overlayPanelCss,
  pinnedIr,
  withInteractionMarks,
  withOverlayScreens,
  type BundleOptions,
  type ExportScreen,
  type FileMap,
} from "./bundle.js";
import { INTERACTIONS_CSS, reactInteractionsModule } from "./interactions.js";

/**
 * Overlay layers (the pages' menus: an imported site's menu panel, the menu of a page reflowed for small screens):
 * mounted closed, `data-open` fades the layer / slides the panel in. Same look as the HTML export's (bundle.ts), the
 * same z-index too: above a captured page's own fixed layers (headers, chat cards at z 10000+).
 */
const OVERLAY_CSS = `/* Overlays (the pages' menus): the component toggles data-open */
[data-overlay] { position: fixed; inset: 0; z-index: 100000; display: flex; background: rgba(0, 0, 0, 0.4); opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 300ms ease-out, visibility 0s linear 300ms; }
[data-overlay][data-open] { opacity: 1; visibility: visible; pointer-events: auto; transition: opacity 300ms ease-out; }
[data-overlay] > [data-overlay-panel] { height: 100%; max-width: 100%; overflow-y: auto; transition: transform 300ms cubic-bezier(0, 0, 0.58, 1); transition-duration: inherit; }
[data-overlay-panel] > main { height: 100%; min-height: 100%; }
[data-overlay][data-placed] > [data-overlay-panel] { position: absolute; height: auto; overflow-x: hidden; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18); }
[data-overlay][data-placed] > [data-overlay-panel] > main { min-height: 0; }
[data-overlay][data-cutout] > [data-overlay-panel] { border-radius: 0; box-shadow: none; }
:where([aria-haspopup="dialog"]) { cursor: pointer; }
@media (prefers-reduced-motion: reduce) { [data-overlay], [data-overlay] > [data-overlay-panel] { transition: none; } }`;

/** The opener's duration also for the layer's hidden-after-fade (`visibility` flips once the fade out is done). */
function overlayTimingCss(
  sel: string,
  i: { duration?: number; overlay?: { enter?: string } } | undefined,
): string {
  if (i?.duration === undefined) return "";
  const ms = i.overlay?.enter === "none" ? 0 : Math.max(0, Math.min(5000, i.duration));
  return `${sel} { transition-duration: ${ms}ms, 0s; transition-delay: 0s, ${ms}ms; }\n${sel}[data-open] { transition-delay: 0s; }`;
}

/** Pinned toolchain of the generated project (React 18, Vite 5, Tailwind 3). */
export const REACT_PROJECT_DEPS = {
  dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
  devDependencies: {
    "@types/react": "18.3.12",
    "@types/react-dom": "18.3.1",
    "@vitejs/plugin-react": "4.3.4",
    autoprefixer: "10.4.20",
    postcss: "8.4.49",
    tailwindcss: "3.4.17",
    typescript: "5.6.3",
    vite: "5.4.11",
  },
};

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  const mime = (m[1] || "application/octet-stream").toLowerCase();
  const payload = m[3] ?? "";
  try {
    if (/;base64/i.test(m[2] ?? "")) {
      const bin = atob(payload.replace(/\s+/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

/** data: URLs → files under public/images (deduplicated); remote URLs stay. */
function assetWriter(files: FileMap) {
  const seen = new Map<string, string>();
  return (src: string): string => {
    if (!src.startsWith("data:")) return src;
    const hit = seen.get(src);
    if (hit) return hit;
    const d = decodeDataUrl(src);
    if (!d) return src;
    const path = `/images/image-${seen.size + 1}.${EXT[d.mime] ?? "bin"}`;
    files[`public${path}`] = d.bytes;
    seen.set(src, path);
    return path;
  };
}

const CSS_URL = /url\(\s*(?:(["'])(data:[\s\S]*?)\1|(data:[^)"'\s]+))\s*\)/g;
const rewriteCss = (v: string, put: (src: string) => string) =>
  v.includes("data:")
    ? v.replace(CSS_URL, (m, _q, a?: string, b?: string) => {
        const p = put(a ?? b ?? "");
        return p.startsWith("data:") ? m : `url(${p})`;
      })
    : v;
const rewriteMap = (s: StyleMap, put: (src: string) => string): StyleMap =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, rewriteCss(v, put)]));

/** Copy of the IR with style url(data:) values moved to files (a class name cannot carry them). */
function withFileUrls(node: IrElement, put: (src: string) => string): IrElement {
  const copy = (n: IrNode): IrNode =>
    n.kind === "text"
      ? n
      : {
          ...n,
          style: rewriteMap(n.style, put),
          ...(n.pseudo
            ? {
                pseudo: Object.fromEntries(
                  Object.entries(n.pseudo).map(([k, v]) => [k, v ? rewriteMap(v, put) : v]),
                ),
              }
            : {}),
          children: n.children.map(copy),
        };
  return copy(node) as IrElement;
}

const PKG_NAME = (s: string) => slugify(s, "app").slice(0, 60);
const hasInteractions = (ir: IrElement) => {
  let any = false;
  walkIr(ir, (n) => {
    if (n.interaction) any = true;
  });
  return any;
};

const MENU_LABELS = ["data-open-overlay", "data-swap-overlay", "data-close-overlay"];
/**
 * Inside a design-system instance a menu's opener / close button is a prop of its component (`onMenuClick`, `menuOpen`
 * → aria-expanded): no `data-*-overlay` label naming the page's menu, so the copies that open one and those that do
 * not stay one component (the screen's state opens the menu; the labels only name it).
 */
function unlabelComponentMenus(ir: IrElement) {
  const strip = (n: IrNode, inside: boolean) => {
    if (n.kind !== "el") return;
    const inInstance = inside || !!n.instance;
    if (inInstance && MENU_LABELS.some((k) => k in n.attrs)) {
      const attrs = { ...n.attrs };
      for (const k of MENU_LABELS) delete attrs[k];
      n.attrs = attrs;
    }
    for (const c of n.children) strip(c, inInstance);
  };
  strip(ir, false);
}

/** The React + Tailwind project as a file map. */
export function buildReactProject(all: ExportScreen[], o: BundleOptions): FileMap {
  // an imported page's menu screens open inside their variant: no screens of their own
  const screens = withOverlayScreens(all);
  // sliders, region states and menus: src/lib/interactions.ts, installed by App (useInteractions)
  const usesRuntime = withInteractionMarks(screens);
  if (o.designSystem?.componentSets?.length)
    for (const s of screens) for (const x of [s, ...(s.overlays ?? [])]) unlabelComponentMenus(x.ir);
  const files: FileMap = {};
  const colorNames = new Set(tailwindColorNames(o.vars));
  const put = assetWriter(files);
  const pages = exportPages(screens);
  const compNamer = createNamer("");
  const comps = pages.map((p) => compNamer(pascalCase(p.name)));
  const compOf = new Map<string, string>();
  pages.forEach((p, i) => {
    for (const s of p.screens) compOf.set(s.nodeId, comps[i]!);
  });
  // every variant of a group (also duplicates exportPages dropped) navigates to the group's component
  for (const s of screens)
    if (!compOf.has(s.nodeId)) {
      const p = pages.find((x) => x.responsive && x.screens[0]?.responsive?.group === s.responsive?.group);
      if (p) compOf.set(s.nodeId, comps[pages.indexOf(p)]!);
    }
  const resolveTarget = (t: string) => {
    const m = matchScreen(t, screens);
    return m ? (compOf.get(m.nodeId) ?? null) : null;
  };
  const imageSrc = (src: string) => (o.images ? put(src) : null);

  // every page's trees first: shared components are found across all of them
  const built = pages.map((page) => {
    const first = page.screens[0]!;
    const web = page.screens.every((s) => s.platform === "web");
    // the variant root carries the page slug: page CSS (fit-to-viewport zoom) selects it like the HTML export's does
    // pinned layers (an imported page's header) stay in place while the page scrolls
    const ir = (s: ExportScreen) => {
      const p = pinnedIr(s);
      const r = o.images ? withFileUrls(p, put) : { ...p };
      if (web) r.attrs = { ...r.attrs, "data-page": page.slug };
      return r;
    };
    const overlaysOf = (s: ExportScreen): ComponentOverlay[] => {
      const openers = overlayOpeners(s);
      return (s.overlays ?? []).map((x) => {
        const id = x.dslId ?? x.nodeId;
        const set = openers.get(id)?.overlay;
        return {
          id,
          root: o.images ? withFileUrls(x.ir, put) : x.ir,
          label: x.name,
          ...(set?.position === "manual" || set?.position === "top-left" ? { placed: true } : {}),
          ...(x.overlayOf ? { cutout: true } : {}),
          ...(set?.closeOnOutsideClick === false ? { modal: true } : {}),
        };
      });
    };
    const root: IrElement | ComponentVariant[] = page.responsive
      ? page.screens.map((s) => ({
          root: ir(s),
          minWidth: s.responsive?.minWidth ?? 0,
          overlays: overlaysOf(s),
        }))
      : first.overlays?.length
        ? [{ root: ir(first), overlays: overlaysOf(first) }]
        : ir(first);
    return { page, first, web, root };
  });
  const base: ReactEmitOptions = { colorNames, cssVars: o.cssVars, vars: o.vars, imageSrc, resolveTarget };
  const trees = new Map<IrElement, number>();
  // the menus a tree's variant opens (a design-system component's menu button / close button: props of it)
  const overlayIds = new Map<IrElement, ReadonlySet<string>>();
  const overlayTrees = new Set<IrElement>();
  for (const b of built)
    for (const v of Array.isArray(b.root) ? b.root : [{ root: b.root }]) {
      const ids = new Set((v.overlays ?? []).map((x) => x.id));
      for (const t of [v.root, ...(v.overlays ?? []).map((x) => x.root)]) {
        trees.set(t, v.minWidth ?? 0);
        overlayIds.set(t, ids);
      }
      for (const x of v.overlays ?? []) overlayTrees.add(x.root);
    }
  const ds = o.designSystem?.componentSets?.length
    ? {
        designSystem: o.designSystem,
        overlayIds: (t: IrElement) => overlayIds.get(t) ?? new Set<string>(),
        isOverlay: (t: IrElement) => overlayTrees.has(t),
        reserved: comps,
      }
    : undefined;
  const shared = sharedComponents([...trees.keys()], base, (t) => trees.get(t) ?? 0, ds);

  let usesOverlays = false;
  built.forEach(({ page, first, web, root }, i) => {
    const name = comps[i]!;
    const cssRules: string[] = [];
    const opts: ReactEmitOptions = { ...base, vars: first.vars, cssRules, cssPrefix: `${slugify(name)}-fx` };
    const imp = { decls: [] as string[], uses: new Set<SharedComponent>() };
    opts.hooks = shared.screenHooks(opts, imp);
    const sizes = page.screens.map((s) => `${s.width}×${s.height}`).join(", ");
    const main = (min: number) =>
      page.responsive
        ? `[data-bp="${min}"] > main[data-page="${page.slug}"]`
        : `main[data-page="${page.slug}"]`;
    const zoom = web ? [fitZoomCss(page, main), capWideCss(page, main)].filter(Boolean).join("\n") : "";
    // reflowed variants (as the HTML export): as tall as their content, their menus placed and sliding in per variant
    const reflow: string[] = [];
    for (const s of page.screens) {
      const min = s.responsive?.minWidth ?? 0;
      if (s.adapted) reflow.push(adaptedCss(main(min)));
      const openers = overlayOpeners(s);
      for (const x of s.overlays ?? []) {
        const id = x.dslId ?? x.nodeId;
        const i = openers.get(id);
        const sel = `${page.responsive ? `[data-bp="${min}"] ` : ""}[data-overlay="${id}"]`;
        reflow.push(
          overlayPanelCss(
            sel,
            x.width,
            i?.overlay?.enter ?? "right",
            i
              ? {
                  interaction: i,
                  pageWidth: s.width,
                  height: x.height,
                  fluid: s.responsive?.fluid,
                  spans: s.openerSpans?.[id],
                }
              : undefined,
          ),
        );
        const timing = overlayTimingCss(sel, i);
        if (timing) reflow.push(timing);
      }
    }
    if (page.screens.some((s) => s.overlays?.length)) usesOverlays = true;
    const imports = () => [
      // (a design-system component's shapes share its name)
      ...[...new Set([...imp.uses].map((c) => c.name))]
        .sort((a, b) => a.localeCompare(b))
        .map(
          (c) =>
            `import ${c}${imp.decls.some((d) => d.includes(`: ${c}Props[]`)) ? `, { type ${c}Props }` : ""} from '../components/${c}'`,
        ),
      ...(cssRules.length || zoom || reflow.length ? [`import './${name}.css'`] : []),
    ];
    const src = screenComponent(name, root, opts, {
      comment: `${page.name} — ${sizes}`,
      imports,
      decls: imp.decls,
    });
    if (cssRules.length || zoom || reflow.length) {
      files[`src/screens/${name}.css`] =
        [
          ...(zoom
            ? [`/* ${page.name}: narrower than designed → scaled to fit (as the HTML export) */`, zoom]
            : []),
          ...(reflow.length ? [`/* ${page.name}: reflowed for small screens, menus */`, ...reflow] : []),
          ...(cssRules.length
            ? [`/* ${page.name}: pseudo elements Tailwind classes cannot express */`, ...cssRules]
            : []),
        ].join("\n") + "\n";
    }
    files[`src/screens/${name}.tsx`] = src;
  });
  const componentFiles = shared.files(base);
  for (const f of componentFiles) {
    files[f.path] = f.source;
    if (f.css) files[f.path.replace(/\.tsx$/, ".css")] = f.css;
  }
  // the design-system components and their props, for code using them
  const dsTypes = shared.dsComponents
    .map((d) => ({
      d,
      source: componentFiles.find((f) => f.path === `src/components/${d.name}.tsx`)?.source ?? "",
    }))
    .map(({ d, source }) => ({
      name: d.name,
      set: d.def.name,
      types: [`${d.name}Props`, d.lookType, ...(d.axisProps ?? []).map((a) => a.type)].filter(
        (t) => source.includes(`export interface ${t} `) || source.includes(`export type ${t} `),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (shared.usesCn()) files["src/lib/cn.ts"] = CN_SOURCE;

  const firstScreen = screens.find((s) => s.flowStart) ?? screens[0];
  const firstComp = firstScreen ? compOf.get(firstScreen.nodeId) : comps[0];
  const usesNav = screens.some((s) => hasInteractions(s.ir));
  const imports = comps.map((c) => `import ${c} from './screens/${c}'`).join("\n");
  files["src/types.ts"] =
    `/** Every screen of the prototype: what \`onNavigate\` takes (src/App.tsx shows one at a time). */
export type ScreenKey = ${comps.length ? comps.map((c) => `'${c}'`).join(" | ") : "never"}

/** Props of every screen (src/screens): the prototype's links. */
export interface ScreenProps {
  /** a navigate interaction fired: show this screen */
  onNavigate?: (screen: ScreenKey) => void
  /** a "back" interaction fired: show the previous screen */
  onBack?: () => void
}
${
  dsTypes.some((t) => t.types.length)
    ? `
/* The design system's components (src/components): their props and looks */
${dsTypes
  .filter((t) => t.types.length)
  .map((t) => `export type { ${t.types.join(", ")} } from './components/${t.name}'`)
  .join("\n")}
`
    : ""
}`;
  if (usesRuntime) files["src/lib/interactions.ts"] = reactInteractionsModule();
  const runtimeImport = usesRuntime ? "import { useInteractions } from './lib/interactions'\n" : "";
  const runtimeCall = usesRuntime
    ? "  // slider arrows / dots / drag, region states, menus (src/lib/interactions.ts)\n  useInteractions()\n"
    : "";
  files["src/App.tsx"] =
    usesNav || comps.length > 1
      ? `import { useState, type ComponentType } from 'react'
import type { ScreenKey, ScreenProps } from './types'
${runtimeImport}${imports}

const SCREENS: Record<ScreenKey, ComponentType<ScreenProps>> = {
${comps.map((c) => `  ${c},`).join("\n")}
}

export default function App() {
${runtimeCall}  // the screens visited, the last one showing: onBack goes one back
  const [stack, setStack] = useState<ScreenKey[]>(['${firstComp ?? comps[0]}'])
  const Screen = SCREENS[stack[stack.length - 1]!]
  return (
    <Screen
      onNavigate={(screen) => {
        setStack((s) => [...s, screen])
        window.scrollTo(0, 0)
      }}
      onBack={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
    />
  )
}
`
      : `${runtimeImport}${imports}

export default function App() {
${runtimeCall}  return ${(firstComp ?? comps[0]) ? `<${firstComp ?? comps[0]} />` : "null"}
}
`;
  const web = screens.length > 0 && screens.every((s) => s.platform === "web");
  const fonts = o.fonts ?? [];
  for (const f of fonts) files[`public/${f.file}`] = f.data;
  files["src/tokens.css"] = tokensCss(
    o.vars,
    fonts.map((f) => ({ ...f, file: `/${f.file}` })),
  );
  // reset before the utilities (as styles.css: reset, then the generated rules) so utilities win specificity ties
  files["src/index.css"] =
    `/* Tailwind preflight is off: this is the HTML export's reset, so both exports render alike */
@tailwind base;
@tailwind components;

${BASE_CSS}
#root { display: contents; }
${usesOverlays ? `\n${OVERLAY_CSS}\n` : ""}${usesRuntime ? `\n${INTERACTIONS_CSS}\n` : ""}
@tailwind utilities;
`;
  files["src/main.tsx"] = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;
  files["src/vite-env.d.ts"] = '/// <reference types="vite/client" />\n';
  const lang = firstScreen?.lang ?? firstScreen?.ir.attrs.lang ?? "en";
  const title = o.projectName ?? firstScreen?.name ?? "Screens";
  files["index.html"] = `<!doctype html>
<html lang="${safeLang(lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escHtml(title)}</title>
  </head>
  <body${web ? "" : " data-frame"}>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  files["tailwind.config.js"] = tailwindConfig(o.vars, o.cssVars).replace(
    /\n {2}plugins: \[\],/,
    "\n  // the page reset lives in src/index.css (same as the HTML export)\n  corePlugins: { preflight: false },\n  plugins: [],",
  );
  files["postcss.config.js"] =
    "export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}\n";
  files["vite.config.ts"] = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // generated screens are large single modules: no Babel "deoptimised styling" note, no chunk size warning
  plugins: [react({ babel: { compact: false } })],
  build: { chunkSizeWarningLimit: 8192 },
})
`;
  files["tsconfig.json"] = `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        useDefineForClassFields: true,
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        moduleDetection: "force",
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
      },
      include: ["src", "vite.config.ts"],
    },
    null,
    2,
  )}\n`;
  files["package.json"] = `${JSON.stringify(
    {
      name: PKG_NAME(o.projectName ?? "design-export"),
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview", typecheck: "tsc" },
      ...REACT_PROJECT_DEPS,
    },
    null,
    2,
  )}\n`;
  files[".gitignore"] = "node_modules\ndist\n*.local\n";
  const found = shared.components.filter((c) => !c.ds);
  const dsReport = shared.dsReport();
  const dsList = dsTypes.length
    ? `- \`src/components/\` — ${dsTypes.length} design-system component${dsTypes.length > 1 ? "s" : ""} (${dsTypes
        .slice(0, 8)
        .map((t) => t.name)
        .join(
          ", ",
        )}${dsTypes.length > 8 ? ", …" : ""}): the component sets the pages' instances use, named and typed as in the design system (props: its properties, the content its instances differ in, lists as typed arrays; a component that is only laid out otherwise per breakpoint carries that in media-ranged classes, one that changes its structure takes \`variant\`). ${dsReport.instances} instance${dsReport.instances === 1 ? "" : "s"} use them${dsReport.inline.length ? `; ${dsReport.inline.length} a component cannot draw exactly ${dsReport.inline.length > 1 ? "are" : "is"} inline markup (${[...new Set(dsReport.inline.map((x) => x.set))].slice(0, 6).join(", ")}${new Set(dsReport.inline.map((x) => x.set)).size > 6 ? ", …" : ""})` : ""}\n${[
        ...new Map(dsReport.inline.map((x) => [`${x.set}: ${x.reason}`, x])).keys(),
      ]
        .slice(0, 8)
        .map((x) => `  - ${x}\n`)
        .join("")}`
    : "";
  const componentList =
    dsList +
    (found.length
      ? `- \`src/components/\` — ${found.length} shared component${found.length > 1 ? "s" : ""} (${found
          .slice(0, 6)
          .map((c) => c.name)
          .join(", ")}${found.length > 6 ? ", …" : ""}): parts that repeat, with typed props\n`
      : "");
  const list = pages
    .map(
      (p, i) =>
        `- \`src/screens/${comps[i]}.tsx\` — ${p.name}${p.responsive ? ` (responsive: ${p.screens.map((s) => `≥${s.responsive?.minWidth ?? 0}px`).join(", ")})` : ""}`,
    )
    .join("\n");
  files["README.md"] = `# ${o.projectName ?? "Exported screens"}

React 18 + TypeScript + Tailwind CSS 3, built with Vite.

\`\`\`bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-checks, then writes dist/ (npm run preview serves it)
\`\`\`

## Layout

${list}
${componentList}- \`src/types.ts\` — \`ScreenKey\` (every screen) and \`ScreenProps\` (\`onNavigate\` / \`onBack\`: the prototype links)${dsTypes.some((t) => t.types.length) ? ", the design-system components' props" : ""}
- \`src/App.tsx\` — shows the first screen and follows the links
${usesRuntime ? "- `src/lib/interactions.ts` — `useInteractions()`: slider arrows, dots and mouse drag, region states, menus (scroll lock, focus), driven by the `data-*` attributes in the screens\n" : ""}- \`src/index.css\` — design tokens (\`src/tokens.css\`${o.cssVars ? ", CSS variables" : ""}), webfonts, the page reset
- \`tailwind.config.js\` — the tokens as Tailwind colours / radii / shadows / fonts
- \`public/\` — images and font files

Styles are Tailwind classes; values without a Tailwind scale use arbitrary values (\`w-[312px]\`) or arbitrary properties
(\`[mask-image:…]\`), and the few declarations a class name cannot carry are inline \`style\` props. Tailwind's preflight is
off on purpose: \`src/index.css\` holds the same reset as the HTML export, so the page renders identically.
${pages.some((p) => p.responsive) ? "\nResponsive pages render one variant per breakpoint; `min-[…]:block` / `min-[…]:hidden` classes on the `data-bp` wrappers show exactly one.\n" : ""}${
    dsTypes.length
      ? `
Pages are compositions of the design system's components (\`<${dsTypes.find((t) => /^Header/.test(t.name))?.name ?? dsTypes[0]!.name} variant="…" />\`): each instance passes its own content as props
(texts, images, links, the nested component an instance swap shows), \`className\` / \`style\` place it on the page, and
\`variant\` picks the component's look at that breakpoint. A menu button takes \`menuOpen\` / \`onMenuClick\` from the page.
`
      : ""
  }`;
  if (o.attribution) {
    const md = attributionMarkdown(screens, o.projectName);
    if (md) files["ATTRIBUTION.md"] = md;
  }
  return files;
}
