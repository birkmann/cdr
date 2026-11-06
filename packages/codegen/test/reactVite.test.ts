// react-vite emitter: project layout per style, generated CSS covering every class
// the modules use, and a type check of the generated project (in-memory stubs for react / react-dom / vite).
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOKENS, type SceneDesignSystem } from "@harness/protocol";
import { pageScreens, pageSections, tagSections } from "@harness/scene";
import { applyNamingPlan, extractComponents, fallbackNames } from "@harness/extract";
import { getEmitter, rightsNotice, type FileMap } from "@harness/codegen";
import { classLiterals, decodeClass } from "../src/export/reactStyles.js";

const recorded = (w: number) =>
  JSON.parse(
    readFileSync(
      new URL(`../../capture/test/sites/acme/recorded/${w}.snapshot.json`, import.meta.url),
      "utf8",
    ),
  );

/** The acme fixture at three widths; with `system`: its component sets (the components stage, fallback names). */
function input(system: boolean) {
  const ps = pageScreens([
    { width: 390, minWidth: 0, snap: recorded(390) },
    { width: 768, minWidth: 768, snap: recorded(768) },
    { width: 1440, minWidth: 1024, snap: recorded(1440) },
  ]);
  let screens = tagSections(ps.screens, pageSections(ps.screens));
  if (!system) return { screens, fonts: ps.fonts, page: ps.page };
  let ds: SceneDesignSystem = {
    version: 1,
    name: ps.page,
    tokens: { ...DEFAULT_TOKENS, theme: "light" },
    componentSets: [],
  };
  let n = 0;
  for (let round = 0; round < 3; round++) {
    const r = extractComponents(
      screens.map((s) => ({ nodeId: s.id, screen: s })),
      ds,
      { newId: () => `cmp-${++n}`, sections: round === 0 },
    );
    if (!r.components.length) break;
    ds = r.ds;
    screens = screens.map((s) => r.screens.get(s.id) ?? s);
  }
  const named = applyNamingPlan(ds, screens, fallbackNames(ds));
  return { screens: named.screens, fonts: ps.fonts, page: ps.page, system: named.ds };
}

const STYLES = ["tailwind", "css-modules", "vanilla"] as const;
const SOURCE = "https://acme.example/";
const asText = (v: FileMap[string] | undefined) =>
  typeof v === "string" ? v : v ? new TextDecoder().decode(v) : "";
const emit = (system: boolean, style: (typeof STYLES)[number]) =>
  getEmitter("react-vite")!.emit(input(system), { sourceUrl: SOURCE, style });

/* ------------------------------------------------------------------ type check */

const STUBS = `
declare module 'react' {
  export type ReactNode = unknown
  export type CSSProperties = { [property: string]: string | number | undefined }
  export type ComponentType<P = object> = (props: P) => ReactNode
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useRef<T>(initial: T): { current: T }
  export function useCallback<T>(fn: T, deps: readonly unknown[]): T
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T
  export function StrictMode(props: { children?: ReactNode }): ReactNode
}
interface DomEvent {
  target: EventTarget | null
  currentTarget: EventTarget | null
  key?: string
  preventDefault(): void
  stopPropagation(): void
}
type DomHandler = (event: DomEvent) => void
interface DomProps {
  [attr: string]: unknown
  onClick?: DomHandler
  onKeyDown?: DomHandler
  onPointerDown?: DomHandler
  onChange?: DomHandler
  onInput?: DomHandler
  onSubmit?: DomHandler
  onFocus?: DomHandler
  onBlur?: DomHandler
  onMouseEnter?: DomHandler
  onMouseLeave?: DomHandler
}
declare module 'react/jsx-runtime' {
  export const jsx: unknown
  export const jsxs: unknown
  export const Fragment: unknown
  export namespace JSX {
    type Element = unknown
    interface IntrinsicElements { [tag: string]: DomProps }
    interface IntrinsicAttributes { key?: string | number }
    interface ElementChildrenAttribute { children: object }
  }
}
declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: unknown): void }
}
declare module 'vite' { export function defineConfig(config: object): object }
declare module '@vitejs/plugin-react' { export default function react(options?: object): object }
declare module '*.module.css' { const classes: { readonly [key: string]: string }; export default classes }
declare module '*.css' {}
`;

/** Type errors of the generated project (its tsconfig: strict, no unused locals / parameters). */
function typeErrors(files: FileMap): string[] {
  const root = "/__react_vite_project__";
  const mem = new Map(
    Object.entries(files)
      .filter(
        ([p]) =>
          (p.startsWith("src/") || p === "vite.config.ts") && /\.tsx?$/.test(p) && !p.endsWith(".d.ts"),
      )
      .map(([p, v]) => [path.posix.join(root, p), asText(v)]),
  );
  mem.set(path.posix.join(root, "stubs.d.ts"), STUBS);
  const options: ts.CompilerOptions = {
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noFallthroughCasesInSwitch: true,
    noEmit: true,
    skipLibCheck: true,
    isolatedModules: true,
    types: [],
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2020,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile, directoryExists } = host;
  host.fileExists = (f) => mem.has(f) || (!f.startsWith(root) && fileExists(f));
  host.directoryExists = (d) =>
    [...mem.keys()].some((f) => f.startsWith(`${d}/`)) ||
    (!d.startsWith(root) && (directoryExists?.(d) ?? false));
  host.readFile = (f) => mem.get(f) ?? readFile(f);
  host.getSourceFile = (f, lang, ...rest) =>
    mem.has(f) ? ts.createSourceFile(f, mem.get(f)!, lang) : getSourceFile(f, lang, ...rest);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([...mem.keys()], options, host))
    .map(
      (d) =>
        `${d.file ? path.posix.relative(root, d.file.fileName) : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
}

/* ------------------------------------------------------------------ helpers */

const tsxFiles = (files: FileMap) => Object.keys(files).filter((p) => p.endsWith(".tsx"));
const selectors = (css: string) => new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!));
/** A class the exporter writes as Tailwind (`w-[12px]`, `[gap:4px]`, `min-[768px]:hidden`, `flex`). */
const looksTailwind = (c: string) => /[[\]:]/.test(c) || decodeClass(c) !== null;

describe.each([
  ["with component sets", true],
  ["without component sets", false],
] as const)("react-vite %s", (_label, system) => {
  const out = Object.fromEntries(STYLES.map((s) => [s, emit(system, s)])) as Record<
    (typeof STYLES)[number],
    FileMap
  >;

  it.each(STYLES)("%s: writes the react-vite layout", (style) => {
    const files = out[style];
    const keys = Object.keys(files);
    expect(keys).toEqual(
      expect.arrayContaining([
        "package.json",
        "index.html",
        "vite.config.ts",
        "tsconfig.json",
        "README.md",
        "credits.json",
        "RECREATION.md",
        "src/main.tsx",
        "src/App.tsx",
        "src/types.ts",
        "src/pages/Home.tsx",
        "src/styles/tokens.css",
        "src/styles/index.css",
        "src/lib/interactions.ts",
      ]),
    );
    // nothing left at the exporter's flat paths
    expect(
      keys.filter(
        (k) => /^src\/(screens\/|tokens\.css|index\.css)/.test(k) || /^src\/components\/[^/]+\.tsx$/.test(k),
      ),
    ).toEqual([]);
    // every component in its folder, imported through its index.ts
    for (const k of keys.filter((x) => /^src\/(components|sections)\/[^/]+\/[^/]+\.tsx$/.test(x))) {
      const [, kind, dir, file] = /^src\/(\w+)\/([^/]+)\/([^/]+)\.tsx$/.exec(k)!;
      expect(file).toBe(dir);
      expect(files[`src/${kind}/${dir}/index.ts`]).toContain(`export { default } from './${dir}'`);
    }
    expect(asText(files["src/App.tsx"])).toContain("from './pages/Home'");
    expect(asText(files["src/App.tsx"])).toContain("useInteractions()");
    const main = asText(files["src/main.tsx"]);
    expect(main).toContain("import './styles/tokens.css'");
    expect(main).toContain("import './styles/index.css'");
    expect(main.includes("import './styles.css'")).toBe(style === "vanilla");
    if (system) {
      // the page's sections are their own modules, composed by the page
      const sections = keys.filter((k) => /^src\/sections\/[^/]+\/[^/]+\.tsx$/.test(k));
      expect(sections.length).toBeGreaterThan(0);
      expect(asText(files["src/pages/Home.tsx"])).toMatch(/from '\.\.\/sections\/\w+'/);
      for (const s of sections) expect(asText(files[s])).toContain("data-section=");
      // captured list content as data
      const data = keys.filter((k) => k.startsWith("src/data/"));
      expect(data.length).toBeGreaterThan(0);
      for (const d of data) expect(asText(files[d])).toMatch(/^export const \w+: \w+\[\] = \[/m);
    }
    // every relative import resolves
    for (const [k, v] of Object.entries(files).filter(([p]) => /\.tsx?$/.test(p)))
      for (const m of asText(v).matchAll(/(?:from|import) '(\.[^']+)'/g)) {
        const target = path.posix.join(path.posix.dirname(k), m[1]!);
        const found = [target, `${target}.tsx`, `${target}.ts`, `${target}/index.ts`].some(
          (c) => files[c] !== undefined,
        );
        expect(found, `${k}: ${m[1]}`).toBe(true);
      }
  });

  it.each(STYLES)("%s: README states provenance and the rights notice", (style) => {
    const readme = asText(out[style]["README.md"]);
    expect(readme).toContain(`Source: ${SOURCE}`);
    expect(readme).toContain(rightsNotice(SOURCE));
    expect(readme).toContain(`Styles: **${style}**`);
  });

  it.each(STYLES)("%s: keeps the data-* attributes the interactions runtime needs", (style) => {
    const all = tsxFiles(out[style])
      .map((p) => asText(out[style][p]))
      .join("\n");
    const ref = tsxFiles(out.tailwind)
      .map((p) => asText(out.tailwind[p]))
      .join("\n");
    const count = (s: string, attr: string) => s.match(new RegExp(`${attr}=`, "g"))?.length ?? 0;
    for (const attr of ["data-overlay", "data-section", "data-bp"])
      expect(count(ref, attr), attr).toBeGreaterThan(0);
    for (const attr of [
      "data-overlay",
      "data-open-overlay",
      "data-scroll-by",
      "data-scroller",
      "data-section",
      "data-bp",
    ])
      expect(count(all, attr), attr).toBe(count(ref, attr));
  });

  it("tailwind: keeps Tailwind's toolchain and classes", () => {
    const files = out.tailwind;
    expect(asText(files["package.json"])).toContain('"tailwindcss"');
    expect(files["tailwind.config.js"]).toBeDefined();
    expect(files["postcss.config.js"]).toBeDefined();
    expect(asText(files["src/styles/index.css"])).toContain("@tailwind utilities;");
    expect(asText(files["src/pages/Home.tsx"])).toContain('className="block min-[768px]:hidden"');
  });

  it.each(["css-modules", "vanilla"] as const)("%s: no Tailwind anywhere", (style) => {
    const files = out[style];
    expect(files["tailwind.config.js"]).toBeUndefined();
    expect(files["postcss.config.js"]).toBeUndefined();
    const pkg = JSON.parse(asText(files["package.json"]));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toEqual(
      expect.arrayContaining(["tailwindcss"]),
    );
    expect(pkg.devDependencies.postcss).toBeUndefined();
    for (const [k, v] of Object.entries(files).filter(([p]) => p.endsWith(".css")))
      expect(asText(v), k).not.toMatch(/@tailwind|@apply/);
    // no Tailwind class left in a class string
    for (const p of [...tsxFiles(files), ...Object.keys(files).filter((k) => k.startsWith("src/data/"))])
      for (const lit of classLiterals(asText(files[p]))) {
        const left = lit.value.split(/\s+/).filter((c) => c && looksTailwind(c));
        expect(left, `${p}: ${lit.value}`).toEqual([]);
      }
  });

  it("css-modules: every module imports its own styles and uses only classes they define", () => {
    const files = out["css-modules"];
    let used = 0;
    for (const p of Object.keys(files).filter((k) => /\.tsx?$/.test(k))) {
      const src = asText(files[p]);
      const refs = [...src.matchAll(/\bstyles(?:\.([A-Za-z_$][\w$]*)|\["([^"]+)"\])/g)].map(
        (m) => m[1] ?? m[2]!,
      );
      if (!refs.length) continue;
      const imp = /^import styles from '([^']+\.module\.css)'$/m.exec(src);
      expect(imp, p).not.toBeNull();
      const cssPath = path.posix.join(path.posix.dirname(p), imp![1]!);
      if (!p.startsWith("src/data/")) expect(cssPath).toBe(p.replace(/\.tsx$/, ".module.css"));
      const defined = selectors(asText(files[cssPath]));
      for (const r of refs) expect(defined.has(r), `${p}: styles.${r}`).toBe(true);
      used += refs.length;
    }
    expect(used).toBeGreaterThan(20);
    // the page: breakpoint wrappers as @media rules of its module
    const page = asText(files["src/pages/Home.tsx"]);
    expect(page).toMatch(/<div data-bp="0" className=\{styles\.\w+\}>/);
    const pageCss = asText(files["src/pages/Home.module.css"]);
    expect(pageCss).toMatch(/@media \(min-width: 768px\) \{[\s\S]*display: none;/);
    expect(pageCss).toContain("100vw");
    // module CSS: classes, no element selectors or globals
    expect(Object.keys(files).some((k) => k.endsWith(".module.css") && k.startsWith("src/components/"))).toBe(
      true,
    );
  });

  it("vanilla: one global stylesheet defines every class the modules use", () => {
    const files = out.vanilla;
    const css = asText(files["src/styles.css"]);
    expect(Object.keys(files).some((k) => k.endsWith(".module.css"))).toBe(false);
    const defined = new Set<string>();
    for (const [k, v] of Object.entries(files))
      if (k.endsWith(".css")) for (const s of selectors(asText(v))) defined.add(s);
    let used = 0;
    for (const p of [...tsxFiles(files), ...Object.keys(files).filter((k) => k.startsWith("src/data/"))]) {
      expect(asText(files[p])).not.toMatch(/\bstyles\.(?!css')\w/);
      for (const lit of classLiterals(asText(files[p])))
        // (a look table's look names are no classes)
        if (!lit.strict || lit.value.includes("__"))
          for (const c of lit.value.split(/\s+/).filter(Boolean)) {
            expect(defined.has(c), `${p}: ${c}`).toBe(true);
            used++;
          }
    }
    expect(used).toBeGreaterThan(20);
    expect(asText(files["src/pages/Home.tsx"])).toMatch(/<div data-bp="0" className="home__[\w-]+">/);
    // breakpoint looks after the base rules
    const firstMedia = css.indexOf("\n@media ");
    expect(firstMedia).toBeGreaterThan(0);
    expect(css.slice(firstMedia)).not.toMatch(/^\.[\w-]+ \{/m);
    expect(css).toMatch(/@media \(min-width: 768px\) and \(max-width: 1023\.98px\)/);
  });

  it.each(STYLES)("%s: the generated project type-checks", (style) => {
    expect(typeErrors(out[style])).toEqual([]);
  });
});

describe("Tailwind classes read back as CSS", () => {
  it("decodes the exporter's utilities, arbitrary values, tokens, breakpoint and pseudo variants", () => {
    expect(decodeClass("flex")).toEqual({ decls: [["display", "flex"]] });
    expect(decodeClass("hidden")).toEqual({ decls: [["display", "none"]] });
    expect(decodeClass("flex-1")?.decls).toEqual([["flex", "1 1 0%"]]);
    expect(decodeClass("w-[312px]")?.decls).toEqual([["width", "312px"]]);
    expect(decodeClass("w-full")?.decls).toEqual([["width", "100%"]]);
    expect(decodeClass("px-[16px]")?.decls).toEqual([
      ["padding-left", "16px"],
      ["padding-right", "16px"],
    ]);
    expect(decodeClass("mx-auto")?.decls).toEqual([
      ["margin-left", "auto"],
      ["margin-right", "auto"],
    ]);
    expect(decodeClass("text-[15px]")?.decls).toEqual([["font-size", "15px"]]);
    expect(decodeClass("text-[rgb(27,_31,_29)]")?.decls).toEqual([["color", "rgb(27, 31, 29)"]]);
    expect(decodeClass("bg-primary")?.decls).toEqual([["background-color", "var(--t-primary)"]]);
    expect(decodeClass("bg-primary", { cssVars: false, vars: { "--t-primary": "#123456" } })?.decls).toEqual([
      ["background-color", "#123456"],
    ]);
    expect(decodeClass("rounded")?.decls).toEqual([["border-radius", "var(--t-radius)"]]);
    expect(decodeClass("rounded-full")?.decls).toEqual([["border-radius", "9999px"]]);
    expect(decodeClass("[font-family:'Acme_Sans',_my\\_font]")?.decls).toEqual([
      ["font-family", "'Acme Sans', my_font"],
    ]);
    expect(decodeClass("[--t-primary:rgb(15,_81,_50)]")?.decls).toEqual([["--t-primary", "rgb(15, 81, 50)"]]);
    expect(decodeClass("min-[768px]:max-[1023.98px]:left-[8px]")).toEqual({
      min: 768,
      max: 1023.98,
      decls: [["left", "8px"]],
    });
    expect(decodeClass("before:content-['']")).toEqual({ pseudo: "before", decls: [["content", "''"]] });
    expect(decodeClass("home-fx-1")).toBeNull();
    expect(decodeClass("sm-2")).toBeNull();
  });

  it("finds class strings in their code shapes and nowhere else", () => {
    const src = `// a comment with "flex" in it
const VARIANTS = {
  sm: { root: "flex w-[1px]", picture: "sm-2" },
  "md-2": { root: "hidden" },
} as const
const items = [{ className: "relative", label: "hidden" }]
export default function X() {
  return <div className={cn("flex", v.root)} style={{ display: "block" }}><p className="text-[12px]">{"don't \\"flex\\""}</p><svg overflow="hidden" /></div>
}
`;
    const lits = classLiterals(src).map((l) => [l.value, l.strict, l.base]);
    expect(lits).toEqual([
      ["flex w-[1px]", true, "smRoot"],
      ["sm-2", true, "smPicture"],
      ["hidden", true, "md2Root"],
      ["relative", false, "item"],
      ["flex", false, "box"],
      ["text-[12px]", false, "text"],
    ]);
  });
});
