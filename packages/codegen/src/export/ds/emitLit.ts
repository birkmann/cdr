// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Lit package of a design system: one LitElement per set (`<prefix-name>`, reactive properties with attributes,
// shadow DOM with `static styles`, the root exposed as `part="root"` so an outer component places it), tokens as CSS
// custom properties (inherited through shadow roots), a tsc build and a demo page. Pure.
import type { FileMap } from "../bundle.js";
import { VOID_TAGS, escAttr, escHtml } from "../ir.js";
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
import type { DsModel, DsSpec, TEl, TNode, Test } from "./model.js";
import { docsFiles, readme, SHOWCASE_CSS, showcaseBody } from "./docs.js";
import type { ShowcaseItem } from "./render.js";
import { usedProps } from "./emitReact.js";
import { pascalCase } from "@harness/scene";

export const LIT_DS_DEPS = { deps: { lit: "3.3.1" }, dev: { typescript: "5.9.3", vite: "7.1.9" } };

/** Text inside a template literal (`\`, backtick and `${` escaped). */
const tl = (s: string) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

export const litClassName = (spec: DsSpec, model: DsModel) => `${pascalCase(model.prefix, "Ds")}${spec.name}`;

const testExpr = (t: Test) =>
  t.k === "truthy"
    ? t.p
    : t.k === "eq"
      ? `${t.p} === ${js(t.v)}`
      : `(${t.vs.map((x) => `v === ${js(x)}`).join(" || ")})`;

function template(spec: DsSpec, model: DsModel): string {
  const multi = hasVariants(spec);
  const el = (n: TEl, pad: string): string => {
    let attrs = "";
    if (n.root) attrs += ` class="${model.prefix}-c ${spec.cls}" part="root"${multi ? " data-v=${v}" : ""}`;
    else if (n.cls) attrs += ` class="${n.cls}"`;
    for (const [k, a] of n.attrs) {
      if (a.k === "prop") attrs += ` ${k}=\${${a.p}}`;
      else if (a.k === "asset") attrs += ` ${k}=\${${a.a}}`;
      else
        attrs +=
          a.v === "" && (k.startsWith("data-") || k === "hidden") ? ` ${k}` : ` ${k}="${tl(escAttr(a.v))}"`;
    }
    if (VOID_TAGS.has(n.tag) && !n.svg) return `<${n.tag}${attrs}>`;
    if (n.html !== undefined)
      return `<${n.tag}${attrs}>\${${n.svg ? "unsafeSVG" : "unsafeHTML"}(${js(n.html)})}</${n.tag}>`;
    if (!n.children.length) return n.svg ? `<${n.tag}${attrs}/>` : `<${n.tag}${attrs}></${n.tag}>`;
    // compact: whitespace between tags would be text nodes the design does not have
    return `<${n.tag}${attrs}>${n.children.map((c) => child(c, pad)).join("")}</${n.tag}>`;
  };
  const nested = (n: Extract<TNode, { t: "use" }>): string => {
    let attrs = n.place && hasPlacement(n) ? ` class="${n.place}"` : "";
    for (const [k, a] of Object.entries(n.props))
      attrs += ` .${k}=\${${typeof a === "boolean" ? String(a) : a.k === "asset" ? a.a : a.k === "prop" ? a.p : js(a.v)}}`;
    return `<${n.spec.tag}${attrs}></${n.spec.tag}>`;
  };
  const svgish = (nodes: TNode[]): boolean =>
    nodes.some(
      (c) =>
        (c.t === "el" && c.svg && c.tag !== "svg") || (c.t === "if" && (svgish(c.then) || svgish(c.else))),
    );
  const part = (nodes: TNode[], pad: string): string => {
    if (!nodes.length) return "nothing";
    if (nodes.length === 1 && nodes[0]!.t === "if")
      return ifExpr(nodes[0] as Extract<TNode, { t: "if" }>, pad);
    if (nodes.length === 1 && nodes[0]!.t === "prop") return nodes[0]!.p;
    return `${svgish(nodes) ? "svg" : "html"}\`${nodes.map((c) => child(c, pad)).join("")}\``;
  };
  const ifExpr = (n: Extract<TNode, { t: "if" }>, pad: string) =>
    `${testExpr(n.test)} ? ${part(n.then, pad)} : ${part(n.else, pad)}`;
  const child = (n: TNode, pad: string): string => {
    switch (n.t) {
      case "text":
        return tl(escHtml(n.v));
      case "prop":
        return `\${${n.p}}`;
      case "el":
        return el(n, pad);
      case "use":
        return nested(n);
      case "if":
        return `\${${ifExpr(n, pad)}}`;
    }
  };
  const root = spec.template;
  return root.t === "if" ? ifExpr(root, "    ") : `html\`${child(root, "    ")}\``;
}

/** src/components/<file>.ts */
export function litComponentSource(spec: DsSpec, model: DsModel): string {
  const multi = hasVariants(spec);
  const used = usedProps(spec);
  const cls = litClassName(spec, model);
  const tpl = template(spec, model);
  const needs = (s: string) => tpl.includes(s);
  const lit = [
    "LitElement",
    "css",
    "html",
    ...(needs("nothing") ? ["nothing"] : []),
    ...(needs("svg`") ? ["svg"] : []),
  ];
  const deps = [...spec.uses].sort((a, b) => a.file.localeCompare(b.file));
  const imports = [
    `import { ${lit.join(", ")} } from 'lit'`,
    ...(needs("unsafeHTML(") ? [`import { unsafeHTML } from 'lit/directives/unsafe-html.js'`] : []),
    ...(needs("unsafeSVG(") ? [`import { unsafeSVG } from 'lit/directives/unsafe-svg.js'`] : []),
    `import { baseStyles } from '../lib/base-styles.js'`,
    ...(multi ? [`import { pickVariant } from '../lib/variants.js'`] : []),
    assetImports(spec, "../assets.js").trim(),
    ...deps.map((d) => `import './${d.file}.js'`),
  ].filter(Boolean);
  const axes = spec.props.filter((p) => p.axis);
  const propsDecl = spec.props.map(
    (p) =>
      `    ${p.name}: { ${p.type === "boolean" ? "type: Boolean, converter: bool" : "type: String"}, attribute: ${js(p.attr)}${p.axis ? ", reflect: true" : ""} },`,
  );
  const fields = spec.props.map((p) => {
    const src = p.api.source;
    const doc =
      src.kind === "axis"
        ? `Variant "${src.axis}"`
        : src.kind === "property"
          ? `Property "${src.property}"`
          : `${src.field === "text" ? "Text" : src.field === "image" ? "Image URL" : src.field === "href" ? "Link" : "Shows"} “${p.api.label}”`;
    return `  /** ${doc.replace(/\*\//g, "* /")} (attribute \`${p.attr}\`) */\n  declare ${p.name}: ${p.tsType} | undefined`;
  });
  const body: string[] = [];
  if (multi)
    body.push(
      `    const v = pickVariant(VARIANTS, ${js(spec.defaultV)}, { ${axes.map((p) => `${js(p.axis!)}: this.${p.name}`).join(", ")} })`,
    );
  for (const p of spec.props)
    if (used.has(p.name)) body.push(`    const ${p.name} = this.${p.name} ?? ${defaultExpr(spec, p)}`);
  const desc = (spec.description || `${spec.kindLabel} from the set “${spec.def.name}”.`).replace(
    /\*\//g,
    "* /",
  );
  const hasBool = spec.props.some((p) => p.type === "boolean");
  return `${imports.join("\n")}
${multi ? `\nconst VARIANTS = ${variantTable(spec)} as const\n` : ""}${hasBool ? `\n/** \`show-image="false"\` reads as false */\nconst bool = { fromAttribute: (v: string | null) => v !== null && v !== 'false', toAttribute: (v: boolean) => (v ? '' : null) }\n` : ""}
/**
 * ${desc}
 * @element ${spec.tag}
 * @csspart root - the component's root element
 */
export class ${cls} extends LitElement {
  static override styles = [baseStyles, css\`
${tl(componentCss(spec, "shadow"))}\`]

  static override properties = {
${propsDecl.join("\n")}
  }
${fields.length ? `\n${fields.join("\n")}\n` : ""}
  override render() {
${body.join("\n")}${body.length ? "\n" : ""}    return ${tpl}
  }
}

if (!customElements.get(${js(spec.tag)})) customElements.define(${js(spec.tag)}, ${cls})

declare global {
  interface HTMLElementTagNameMap { ${js(spec.tag)}: ${cls} }
}
`;
}

/** Attribute value for a snippet / demo (strings escaped). */
const attrPair = (name: string, x: string | boolean) =>
  typeof x === "boolean"
    ? x
      ? ` ${name}`
      : ` ${name}="false"`
    : ` ${name}="${escAttr(x.length > 200 ? `${x.slice(0, 197)}…` : x)}"`;

export function litUsage(
  spec: DsSpec,
  values: Record<string, string | boolean>,
  packageName: string,
): string {
  const attrs = snippetValues(spec, values)
    .map(([p, x]) => attrPair(p.attr, x))
    .join("");
  return `import '${packageName}/${spec.file}.js'\n\n<${spec.tag}${attrs}></${spec.tag}>`;
}

export function litPackage(
  model: DsModel,
  o: { packageName: string; fonts: readonly DsFont[]; version?: string },
): FileMap {
  const files: FileMap = { ...tokenFiles(model, o.fonts) };
  for (const spec of model.specs) files[`src/components/${spec.file}.ts`] = litComponentSource(spec, model);
  files["src/lib/variants.ts"] = VARIANTS_TS;
  files["src/lib/base-styles.ts"] =
    `import { css } from 'lit'\n\n/** Reset inside every component's shadow root + rules the designs rely on (text trim, inline SVG boxes) */\nexport const baseStyles = css\`\n${tl(baseCss(model.prefix, "shadow"))}\`\n`;
  files["src/assets.ts"] = assetsTs(model);
  files["src/index.ts"] =
    `// ${model.name}: web components (Lit). Importing this module registers every element.\n${model.specs.map((s) => `export { ${litClassName(s, model)} } from './components/${s.file}.js'`).join("\n")}\n`;
  const exportsMap: Record<string, unknown> = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./tokens.css": "./tokens.css",
    "./fonts/*": "./fonts/*",
  };
  for (const s of model.specs)
    exportsMap[`./${s.file}.js`] = {
      types: `./dist/components/${s.file}.d.ts`,
      import: `./dist/components/${s.file}.js`,
    };
  files["package.json"] = `${JSON.stringify(
    {
      name: o.packageName,
      version: o.version ?? "0.1.0",
      description: `${model.name} — web components (Lit)`,
      type: "module",
      sideEffects: true,
      main: "./dist/index.js",
      module: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: exportsMap,
      files: ["dist", "tokens.css", "fonts", "docs", "README.md"],
      scripts: {
        build: "tsc -p tsconfig.build.json",
        typecheck: "tsc --noEmit",
        demo: "vite --config vite.demo.config.ts",
        "build:demo": "vite build --config vite.demo.config.ts",
      },
      dependencies: LIT_DS_DEPS.deps,
      devDependencies: LIT_DS_DEPS.dev,
    },
    null,
    2,
  )}\n`;
  const compilerOptions = {
    target: "ES2021",
    lib: ["ES2021", "DOM", "DOM.Iterable"],
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noImplicitOverride: true,
    useDefineForClassFields: false,
    skipLibCheck: true,
    isolatedModules: true,
    noEmit: true,
  };
  files["tsconfig.json"] = `${JSON.stringify({ compilerOptions, include: ["src"] }, null, 2)}\n`;
  files["tsconfig.build.json"] =
    `${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: false, declaration: true, outDir: "dist", rootDir: "src" }, include: ["src"] }, null, 2)}\n`;
  files["vite.demo.config.ts"] =
    `import { defineConfig } from 'vite'\n\n// Demo page: every component in every variant (npm run demo)\nexport default defineConfig({ root: 'demo', base: './', build: { outDir: '../demo-dist', emptyOutDir: true, assetsInlineLimit: 100_000_000 }, server: { fs: { allow: ['..'] } } })\n`;
  const stage = (it: ShowcaseItem) =>
    `<${it.spec.tag}${Object.entries(it.props)
      .map(([k, x]) => attrPair(it.spec.props.find((p) => p.name === k)?.attr ?? k, x))
      .join("")}></${it.spec.tag}>`;
  files["demo/index.html"] = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(model.name)} — Web components</title>
  <style>
${SHOWCASE_CSS}
  </style>
  <script type="module" src="./main.ts"></script>
</head>
<body class="dsx">
${showcaseBody(model, { title: `${model.name} — Web components`, subtitle: `${model.specs.length} custom elements (Lit, shadow DOM)`, stage: (it) => stage(it) })}
</body>
</html>
`;
  files["demo/main.ts"] =
    `import '../tokens.css'\nimport '../src/index.ts'\n\ncustomElements.whenDefined(${js(model.specs[0]?.tag ?? "div")}).then(() => document.body.setAttribute('data-ready', ''))\n`;
  Object.assign(
    files,
    docsFiles(model, { title: `${model.name} — components`, usage: (s) => litUsage(s, {}, o.packageName) }),
  );
  files["README.md"] = readme(model, {
    packageName: o.packageName,
    framework: "web component (Lit)",
    install: `npm install ${o.packageName}`,
    build:
      "npm install\nnpm run build      # dist/: ES modules + type declarations\nnpm run demo       # every component in every variant",
    setup: `\`\`\`html\n<link rel="stylesheet" href="node_modules/${o.packageName}/tokens.css">\n<body class="${model.prefix}-theme">\n<script type="module">import '${o.packageName}'</script>\n\`\`\`\n\nImporting the package (or one component's module) registers the custom elements. Components render in shadow DOM; tokens reach them as inherited CSS custom properties. Set props as attributes (\`kebab-case\`) or properties (\`.camelCase\` in Lit templates); boolean attributes take \`"false"\`. Each component's root is \`part="root"\` (style it with \`::part(root)\`).`,
    usage: (s) => litUsage(s, {}, o.packageName),
  });
  return files;
}
