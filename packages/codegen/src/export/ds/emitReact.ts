// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// React package of a design system: one TSX component per set (typed props, the variant its enum props select as
// the root's `data-v`, CSS classes from css.ts), src/index.ts, a Vite library build (ES module + styles.css + d.ts),
// a demo page rendering every component (npm run demo). Pure.
import type { FileMap } from "../bundle.js";
import { jsxAttr, jsxText, styleProp } from "../react.js";
import { escHtml, type StyleMap } from "../ir.js";
import { baseCss, componentCss, hasPlacement } from "./css.js";
import {
  assetImports,
  assetsTs,
  defaultExpr,
  hasVariants,
  js,
  snippetValues,
  tokenFiles,
  VARIANTS_TS,
  variantTable,
  type DsFont,
} from "./common.js";
import { walkT, type DsModel, type DsSpec, type TEl, type TNode, type Test } from "./model.js";
import { docsFiles, readme, SHOWCASE_CSS, showcaseBody } from "./docs.js";
import { showcase } from "./render.js";

export const REACT_DS_DEPS = {
  peer: { react: ">=18.2.0", "react-dom": ">=18.2.0" },
  dev: {
    react: "19.2.0",
    "react-dom": "19.2.0",
    "@types/react": "19.2.2",
    "@types/react-dom": "19.2.2",
    "@vitejs/plugin-react": "5.0.4",
    typescript: "5.9.3",
    vite: "7.1.9",
  },
};

const parseStyle = (s: string): StyleMap => {
  const out: StyleMap = {};
  for (const d of s.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
};

const testExpr = (t: Test) =>
  t.k === "truthy"
    ? t.p
    : t.k === "eq"
      ? `${t.p} === ${js(t.v)}`
      : t.vs.length === 1
        ? `v === ${js(t.vs[0]!)}`
        : `(${t.vs.map((x) => `v === ${js(x)}`).join(" || ")})`;

/** Props a template reads (their resolved values become locals). */
export function usedProps(spec: DsSpec): Set<string> {
  const out = new Set<string>();
  walkT(spec.template, (n) => {
    if (n.t === "prop") out.add(n.p);
    if (n.t === "if" && n.test.k !== "v") out.add(n.test.p);
    if (n.t === "el") for (const [, a] of n.attrs) if (a.k === "prop") out.add(a.p);
  });
  return out;
}

function jsxOf(spec: DsSpec, model: DsModel) {
  const multi = hasVariants(spec);
  const el = (n: TEl, pad: string): string => {
    const attrs: string[] = [];
    const unknown: string[] = [];
    if (n.root)
      attrs.push(
        `className={cx(${js(`${model.prefix}-c ${spec.cls}`)}, props.className)}`,
        "style={props.style}",
        ...(multi ? ["data-v={v}"] : []),
      );
    else if (n.cls) attrs.push(`className=${js(n.cls)}`);
    // an SVG <title> / <desc> is typed as HTML's in JSX: its (captured, meaningless) presentation attributes go
    const attrList = n.svg && (n.tag === "title" || n.tag === "desc") ? [] : n.attrs;
    for (const [k, a] of attrList) {
      if (a.k === "prop") {
        attrs.push(`${k}={${a.p}}`);
        continue;
      }
      if (a.k === "asset") {
        attrs.push(`${k}={${a.a}}`);
        continue;
      }
      if (k === "style") {
        const sp = styleProp(parseStyle(a.v));
        if (sp) attrs.push(sp);
        continue;
      }
      if (k === "class" && !n.svg) continue;
      if (n.tag === "input" && k === "value") {
        attrs.push(`defaultValue=${js(a.v)}`);
        continue;
      }
      if (n.tag === "input" && k === "checked") {
        attrs.push("defaultChecked");
        continue;
      }
      if (!/^[A-Za-z_][\w-]*(:[A-Za-z_][\w-]*)?$/.test(k)) continue;
      unknown.push(...jsxAttr(k, a.v, !!n.svg, attrs));
    }
    if (unknown.length) attrs.push(`{...({ ${unknown.join(", ")} } as Record<string, string>)}`);
    if (n.html !== undefined) attrs.push(`dangerouslySetInnerHTML={{ __html: ${js(n.html)} }}`);
    const open = `<${n.tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
    const kids =
      n.html !== undefined ? [] : n.children.map((c) => child(c, `${pad}  `)).filter((s) => s.trim());
    if (!kids.length) return `${open} />`;
    if (n.children.every((c) => c.t === "text" || c.t === "prop"))
      return `${open}>${kids.map((k) => k.trim()).join("")}</${n.tag}>`;
    return `${open}>\n${kids.join("\n")}\n${pad}</${n.tag}>`;
  };
  const nested = (n: Extract<TNode, { t: "use" }>): string => {
    const attrs: string[] = [];
    if (n.place && hasPlacement(n)) attrs.push(`className=${js(n.place)}`);
    for (const [k, a] of Object.entries(n.props))
      attrs.push(
        typeof a === "boolean"
          ? `${k}={${a}}`
          : a.k === "asset"
            ? `${k}={${a.a}}`
            : a.k === "prop"
              ? `${k}={${a.p}}`
              : `${k}={${js(a.v)}}`,
      );
    return `<${n.spec.name}${attrs.length ? ` ${attrs.join(" ")}` : ""} />`;
  };
  /** a list of nodes as one JSX expression */
  const expr = (nodes: TNode[], pad: string): string => {
    if (!nodes.length) return "null";
    if (nodes.length === 1) {
      const n = nodes[0]!;
      if (n.t === "el") return el(n, pad);
      if (n.t === "use") return nested(n);
      if (n.t === "if")
        return `${testExpr(n.test)} ? (\n${pad}  ${expr(n.then, `${pad}  `)}\n${pad}) : (\n${pad}  ${expr(n.else, `${pad}  `)}\n${pad})`;
    }
    return `<>\n${nodes.map((c) => child(c, `${pad}  `)).join("\n")}\n${pad}</>`;
  };
  const child = (n: TNode, pad: string): string => {
    switch (n.t) {
      case "text": {
        const t = jsxText(n.v);
        return t ? pad + (t.startsWith("{") ? t : `{${js(n.v)}}`) : "";
      }
      case "prop":
        return `${pad}{${n.p}}`;
      case "el":
        return pad + el(n, pad);
      case "use":
        return pad + nested(n);
      case "if":
        return `${pad}{${testExpr(n.test)} ? (\n${pad}  ${expr(n.then, `${pad}  `)}\n${pad}) : ${n.else.length ? `(\n${pad}  ${expr(n.else, `${pad}  `)}\n${pad})` : "null"}}`;
    }
  };
  return (pad: string) => expr([spec.template], pad);
}

/** src/components/<Name>.tsx */
export function reactComponentSource(spec: DsSpec, model: DsModel): string {
  const multi = hasVariants(spec);
  const used = usedProps(spec);
  const deps = [...spec.uses].sort((a, b) => a.name.localeCompare(b.name));
  const imports = [
    `import type { CSSProperties } from 'react'`,
    `import { cx${multi ? ", pickVariant" : ""} } from '../lib/variants'`,
    assetImports(spec, "../assets").trim(),
    ...deps.map((d) => `import { ${d.name} } from './${d.name}'`),
    `import './${spec.name}.css'`,
  ].filter(Boolean);
  const props = spec.props.map((p) => {
    const src = p.api.source;
    const doc =
      src.kind === "axis"
        ? `Variant "${src.axis}"`
        : src.kind === "property"
          ? `Property "${src.property}"`
          : `${src.field === "text" ? "Text" : src.field === "image" ? "Image URL" : src.field === "href" ? "Link" : "Shows"} “${p.api.label}”`;
    return `  /** ${doc.replace(/\*\//g, "* /")} */\n  ${p.name}?: ${p.tsType}`;
  });
  const axes = spec.props.filter((p) => p.axis);
  const body: string[] = [];
  if (multi)
    body.push(
      `  const v = pickVariant(VARIANTS, ${js(spec.defaultV)}, { ${axes.map((p) => `${js(p.axis!)}: props.${p.name}`).join(", ")} })`,
    );
  for (const p of spec.props)
    if (used.has(p.name)) body.push(`  const ${p.name} = props.${p.name} ?? ${defaultExpr(spec, p)}`);
  const desc = (spec.description || `${spec.kindLabel} from the set “${spec.def.name}”.`).replace(
    /\*\//g,
    "* /",
  );
  return `${imports.join("\n")}
${multi ? `\nconst VARIANTS = ${variantTable(spec)} as const\n` : ""}
export interface ${spec.name}Props {
${[...props, "  /** extra class names on the root element */\n  className?: string", "  /** inline styles on the root element */\n  style?: CSSProperties"].join("\n")}
}

/** ${desc} */
export function ${spec.name}(props: ${spec.name}Props) {
${body.join("\n")}${body.length ? "\n" : ""}  return (
    ${jsxOf(spec, model)("    ")}
  )
}
`;
}

/** How to use a component (import + JSX) with the given prop values. */
export function reactUsage(
  spec: DsSpec,
  values: Record<string, string | boolean>,
  packageName: string,
): string {
  const attrs = snippetValues(spec, values).map(([p, x]) =>
    typeof x === "boolean"
      ? x
        ? p.name
        : `${p.name}={false}`
      : `${p.name}=${/["\n{}]/.test(x) || x.length > 80 ? `{${js(x.length > 200 ? `${x.slice(0, 197)}…` : x)}}` : js(x)}`,
  );
  return `import { ${spec.name} } from '${packageName}'\n\n<${spec.name}${attrs.length ? ` ${attrs.join(" ")}` : ""} />`;
}

export function reactPackage(
  model: DsModel,
  o: { packageName: string; fonts: readonly DsFont[]; version?: string },
): FileMap {
  const files: FileMap = { ...tokenFiles(model, o.fonts) };
  for (const spec of model.specs) {
    files[`src/components/${spec.name}.tsx`] = reactComponentSource(spec, model);
    files[`src/components/${spec.name}.css`] = componentCss(spec, "global");
  }
  files["src/lib/variants.ts"] = VARIANTS_TS;
  files["src/assets.ts"] = assetsTs(model);
  files["src/base.css"] =
    `/* Reset inside the components + rules the designs rely on (zero specificity: component classes win) */\n${baseCss(model.prefix, "global")}`;
  files["src/vite-env.d.ts"] = `/// <reference types="vite/client" />\n`;
  files["src/index.ts"] =
    `// ${model.name}: React components (import '${o.packageName}/styles.css' and '${o.packageName}/tokens.css' once)\nimport './base.css'\n${model.specs.map((s) => `export { ${s.name}, type ${s.name}Props } from './components/${s.name}'`).join("\n")}\n`;
  files["package.json"] = `${JSON.stringify(
    {
      name: o.packageName,
      version: o.version ?? "0.1.0",
      description: `${model.name} — React components`,
      type: "module",
      sideEffects: ["*.css"],
      main: "./dist/index.js",
      module: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./styles.css": "./dist/styles.css",
        "./tokens.css": "./tokens.css",
        "./fonts/*": "./fonts/*",
      },
      files: ["dist", "tokens.css", "fonts", "docs", "README.md"],
      scripts: {
        build: "vite build && tsc -p tsconfig.build.json",
        typecheck: "tsc --noEmit",
        demo: "vite --config vite.demo.config.ts",
        "build:demo": "vite build --config vite.demo.config.ts",
      },
      peerDependencies: REACT_DS_DEPS.peer,
      devDependencies: REACT_DS_DEPS.dev,
    },
    null,
    2,
  )}\n`;
  const compilerOptions = {
    target: "ES2020",
    lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: true,
    isolatedModules: true,
    esModuleInterop: true,
    noEmit: true,
  };
  files["tsconfig.json"] = `${JSON.stringify({ compilerOptions, include: ["src", "demo"] }, null, 2)}\n`;
  files["tsconfig.build.json"] =
    `${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: "dist", rootDir: "src" }, include: ["src"] }, null, 2)}\n`;
  files["vite.config.ts"] = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Library build: dist/index.js (ES module, React external), dist/styles.css (every component's CSS)
export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index', cssFileName: 'styles' },
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'] },
    assetsInlineLimit: 100_000_000,
  },
})
`;
  files["vite.demo.config.ts"] = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Demo page: every component in every variant (npm run demo)
export default defineConfig({ root: 'demo', base: './', plugins: [react()], build: { outDir: '../demo-dist', emptyOutDir: true }, server: { fs: { allow: ['..'] } } })
`;
  const items = showcase(model);
  files["demo/index.html"] = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(model.name)} — React</title>
  <style>
${SHOWCASE_CSS}
  </style>
</head>
<body class="dsx">
${showcaseBody(model, { title: `${model.name} — React`, subtitle: `${model.specs.length} components rendered by React`, stage: () => "" })}
<script type="module" src="./main.tsx"></script>
</body>
</html>
`;
  files["demo/main.tsx"] = `import { createRoot } from 'react-dom/client'
import type { ComponentType } from 'react'
import '../tokens.css'
import * as DS from '../src'

// every stage of the page: [component, props]
const stages: Array<[string, Record<string, unknown>]> = ${JSON.stringify(items.map((it) => [it.spec.name, it.props]))}

stages.forEach(([name, props], i) => {
  const el = document.querySelector('[data-stage="' + i + '"]')
  const C = (DS as unknown as Record<string, ComponentType<Record<string, unknown>>>)[name]
  if (el && C) createRoot(el).render(<C {...props} />)
})
document.body.setAttribute('data-ready', '')
`;
  Object.assign(
    files,
    docsFiles(model, { title: `${model.name} — components`, usage: (s) => reactUsage(s, {}, o.packageName) }),
  );
  files["README.md"] = readme(model, {
    packageName: o.packageName,
    framework: "React",
    install: `npm install ${o.packageName}`,
    build:
      "npm install\nnpm run build      # dist/: ES module, styles.css, type declarations\nnpm run demo       # every component in every variant",
    setup: `\`\`\`tsx\nimport '${o.packageName}/tokens.css'\nimport '${o.packageName}/styles.css'\n\ndocument.body.classList.add('${model.prefix}-theme')\n\`\`\`\n\nEvery component takes \`className\` and \`style\` for its root element. Enum props pick the variant; text and image props replace the design's content (their defaults are the design's).`,
    usage: (s) => reactUsage(s, {}, o.packageName),
  });
  return files;
}
