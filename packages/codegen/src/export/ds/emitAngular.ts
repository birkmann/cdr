// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Angular package of a design system: one standalone component per set (`<prefix-name>`, typed @Input()s, template +
// stylesheet, the host `display: contents` so the root lays out like the design), public-api.ts, an ng-packagr build
// (templates type-checked: strictTemplates) and a demo app. Styles are not encapsulated: classes are scoped by name
// (`<prefix>-<component>__<layer>`), which lets an outer component place the components it nests. Pure.
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

const NG = "20.3.4";
export const ANGULAR_DS_DEPS = {
  peer: {
    "@angular/common": ">=19.0.0",
    "@angular/core": ">=19.0.0",
    "@angular/platform-browser": ">=19.0.0",
  },
  deps: { tslib: "2.8.1" },
  dev: {
    "@angular/common": NG,
    "@angular/compiler": NG,
    "@angular/compiler-cli": NG,
    "@angular/core": NG,
    "@angular/platform-browser": NG,
    "ng-packagr": "20.3.0",
    rxjs: "7.8.2",
    typescript: "5.9.3",
    vite: "7.1.9",
  },
};

export const ngClassName = (spec: DsSpec) => `${spec.name}Component`;
const getter = (p: string) => `r${p.charAt(0).toUpperCase()}${p.slice(1)}`;

/** Text / attribute value in an Angular template: HTML-escaped, `{` `}` `@` as entities (interpolation, ICU, blocks). */
const ngText = (s: string) =>
  escHtml(s).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;").replace(/@/g, "&#64;");
const ngAttr = (s: string) => escAttr(s).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

interface NgCtx {
  tests: string[];
  html: string[];
}

function template(spec: DsSpec, ctx: NgCtx): string {
  const multi = hasVariants(spec);
  const test = (t: Test): string => {
    if (t.k === "truthy") return getter(t.p);
    if (t.k === "v") return t.vs.map((x) => `v === ${js(x).replace(/"/g, "'")}`).join(" || ");
    ctx.tests.push(`${getter(t.p)} === ${js(t.v)}`);
    return `t${ctx.tests.length - 1}`;
  };
  const el = (n: TEl): string => {
    let attrs = "";
    if (n.root) attrs += ` [class]="rootClass"${multi ? ' [attr.data-v]="v"' : ""}`;
    else if (n.cls) attrs += ` class="${n.cls}"`;
    for (const [k, a] of n.attrs) {
      if (a.k === "prop") attrs += ` [attr.${k}]="${getter(a.p)}"`;
      else if (a.k === "asset") attrs += ` [attr.${k}]="${a.a}"`;
      else attrs += ` ${k}="${ngAttr(a.v)}"`;
    }
    if (n.html !== undefined) {
      ctx.html.push(n.html);
      return `<${n.tag}${attrs} [innerHTML]="html${ctx.html.length - 1}"></${n.tag}>`;
    }
    if (VOID_TAGS.has(n.tag) && !n.svg) return `<${n.tag}${attrs}>`;
    // compact: whitespace between tags would be text nodes the design does not have
    return `<${n.tag}${attrs}>${n.children.map(child).join("")}</${n.tag}>`;
  };
  const nested = (n: Extract<TNode, { t: "use" }>): string => {
    let attrs = n.place && hasPlacement(n) ? ` styleClass="${n.place}"` : "";
    for (const [k, a] of Object.entries(n.props)) {
      if (typeof a === "boolean") attrs += ` [${k}]="${a}"`;
      else if (a.k === "asset") attrs += ` [${k}]="${a.a}"`;
      else if (a.k === "prop") attrs += ` [${k}]="${getter(a.p)}"`;
      else attrs += ` ${k}="${ngAttr(a.v)}"`;
    }
    return `<${n.spec.tag}${attrs}></${n.spec.tag}>`;
  };
  const ifBlock = (n: Extract<TNode, { t: "if" }>): string => {
    const els =
      n.else.length === 1 && n.else[0]!.t === "if"
        ? ` @else ${ifBlock(n.else[0] as Extract<TNode, { t: "if" }>).slice(1)}`
        : n.else.length
          ? ` @else {${n.else.map(child).join("")}}`
          : "";
    return `@if (${test(n.test)}) {${n.then.map(child).join("")}}${els}`;
  };
  const child = (n: TNode): string => {
    switch (n.t) {
      case "text":
        return ngText(n.v);
      case "prop":
        return `{{ ${getter(n.p)} }}`;
      case "el":
        return el(n);
      case "use":
        return nested(n);
      case "if":
        return ifBlock(n);
    }
  };
  return child(spec.template);
}

/** src/lib/components/<file>.component.{ts,html,css} */
export function angularComponentFiles(
  spec: DsSpec,
  model: DsModel,
): { ts: string; html: string; css: string } {
  const multi = hasVariants(spec);
  const ctx: NgCtx = { tests: [], html: [] };
  const html = template(spec, ctx);
  const used = usedProps(spec);
  const deps = [...spec.uses].sort((a, b) => a.file.localeCompare(b.file));
  const core = [
    "ChangeDetectionStrategy",
    "Component",
    "Input",
    "ViewEncapsulation",
    ...(spec.props.some((p) => p.type === "boolean") ? ["booleanAttribute"] : []),
    ...(ctx.html.length ? ["inject"] : []),
  ];
  const imports = [
    `import { ${core.sort().join(", ")} } from '@angular/core'`,
    ...(ctx.html.length ? [`import { DomSanitizer } from '@angular/platform-browser'`] : []),
    `import { cx${multi ? ", pickVariant" : ""} } from '../variants'`,
    assetImports(spec, "../assets").trim(),
    ...deps.map((d) => `import { ${ngClassName(d)} } from './${d.file}.component'`),
  ].filter(Boolean);
  const inputs = spec.props.map((p) => {
    const src = p.api.source;
    const doc =
      src.kind === "axis"
        ? `Variant "${src.axis}"`
        : src.kind === "property"
          ? `Property "${src.property}"`
          : `${src.field === "text" ? "Text" : src.field === "image" ? "Image URL" : src.field === "href" ? "Link" : "Shows"} “${p.api.label}”`;
    return `  /** ${doc.replace(/\*\//g, "* /")} */\n  @Input(${p.type === "boolean" ? "{ transform: booleanAttribute }" : ""}) ${p.name}?: ${p.tsType}`;
  });
  const axes = spec.props.filter((p) => p.axis);
  const members: string[] = [];
  for (const a of spec.assets) members.push(`  protected readonly ${a} = ${a}`);
  ctx.html.forEach((h, i) =>
    members.push(`  protected readonly html${i} = inject(DomSanitizer).bypassSecurityTrustHtml(${js(h)})`),
  );
  if (multi)
    members.push(
      `  protected get v(): string { return pickVariant(VARIANTS, ${js(spec.defaultV)}, { ${axes.map((p) => `${js(p.axis!)}: this.${p.name}`).join(", ")} }) }`,
    );
  members.push(
    `  protected get rootClass(): string { return cx(${js(`${model.prefix}-c ${spec.cls}`)}, this.styleClass) }`,
  );
  for (const p of spec.props)
    if (used.has(p.name))
      members.push(
        `  protected get ${getter(p.name)}(): ${p.tsType} { return this.${p.name} ?? ${defaultExpr(spec, p, "this.v")} }`,
      );
  ctx.tests.forEach((t, i) => members.push(`  protected get t${i}(): boolean { return this.${t} }`));
  const desc = (spec.description || `${spec.kindLabel} from the set “${spec.def.name}”.`).replace(
    /\*\//g,
    "* /",
  );
  const ts = `${imports.join("\n")}
${multi ? `\nconst VARIANTS = ${variantTable(spec)} as const\n` : ""}
/** ${desc} */
@Component({
  selector: ${js(spec.tag).replace(/"/g, "'")},
  standalone: true,
  imports: [${deps.map(ngClassName).join(", ")}],
  templateUrl: './${spec.file}.component.html',
  styleUrls: ['../base.css', './${spec.file}.component.css'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
})
export class ${ngClassName(spec)} {
${[...inputs, "  /** extra class names on the root element */\n  @Input() styleClass?: string"].join("\n")}

${members.join("\n")}
}
`;
  return { ts, html: `${html}\n`, css: componentCss(spec, "global") };
}

const attrPair = (name: string, x: string | boolean) =>
  typeof x === "boolean"
    ? ` [${name}]="${x}"`
    : ` ${name}="${ngAttr(x.length > 200 ? `${x.slice(0, 197)}…` : x)}"`;

export function angularUsage(
  spec: DsSpec,
  values: Record<string, string | boolean>,
  packageName: string,
): string {
  const attrs = snippetValues(spec, values)
    .map(([p, x]) => attrPair(p.name, x))
    .join("");
  return `import { ${ngClassName(spec)} } from '${packageName}'\n// @Component({ imports: [${ngClassName(spec)}], … })\n\n<${spec.tag}${attrs}></${spec.tag}>`;
}

export function angularPackage(
  model: DsModel,
  o: { packageName: string; fonts: readonly DsFont[]; version?: string },
): FileMap {
  const files: FileMap = { ...tokenFiles(model, o.fonts) };
  for (const spec of model.specs) {
    const f = angularComponentFiles(spec, model);
    files[`src/lib/components/${spec.file}.component.ts`] = f.ts;
    files[`src/lib/components/${spec.file}.component.html`] = f.html;
    files[`src/lib/components/${spec.file}.component.css`] = f.css;
  }
  files["src/lib/variants.ts"] = VARIANTS_TS;
  files["src/lib/assets.ts"] = assetsTs(model);
  files["src/lib/base.css"] =
    `/* Reset inside the components + rules the designs rely on (zero specificity: component classes win) */\n${baseCss(model.prefix, "global")}`;
  files["src/public-api.ts"] =
    `// ${model.name}: Angular standalone components\n${model.specs.map((s) => `export { ${ngClassName(s)} } from './lib/components/${s.file}.component'`).join("\n")}\n\n/** Every component (for an \`imports: [...]\` list) */\n${model.specs.map((s) => `import { ${ngClassName(s)} as _${ngClassName(s)} } from './lib/components/${s.file}.component'`).join("\n")}\nexport const ${pascalCase(model.prefix, "Ds")}Components = [${model.specs.map((s) => `_${ngClassName(s)}`).join(", ")}] as const\n`;
  files["package.json"] = `${JSON.stringify(
    {
      name: o.packageName,
      version: o.version ?? "0.1.0",
      description: `${model.name} — Angular components`,
      scripts: {
        build: "ng-packagr -p ng-package.json -c tsconfig.lib.json",
        demo: "vite --config vite.demo.config.ts",
        "build:demo": "vite build --config vite.demo.config.ts",
      },
      peerDependencies: ANGULAR_DS_DEPS.peer,
      dependencies: ANGULAR_DS_DEPS.deps,
      devDependencies: ANGULAR_DS_DEPS.dev,
      sideEffects: false,
    },
    null,
    2,
  )}\n`;
  files["ng-package.json"] =
    `${JSON.stringify({ $schema: "./node_modules/ng-packagr/ng-package.schema.json", dest: "dist", lib: { entryFile: "src/public-api.ts" }, assets: ["tokens.css", "fonts/**/*", "README.md"] }, null, 2)}\n`;
  const compilerOptions = {
    target: "ES2022",
    lib: ["ES2022", "DOM"],
    module: "ES2022",
    moduleResolution: "bundler",
    strict: true,
    noImplicitOverride: true,
    noUnusedLocals: true,
    experimentalDecorators: true,
    useDefineForClassFields: false,
    skipLibCheck: true,
    declaration: true,
    importHelpers: true,
  };
  files["tsconfig.json"] =
    `${JSON.stringify({ compilerOptions, angularCompilerOptions: { strictTemplates: true, strictInjectionParameters: true, strictInputAccessModifiers: true } }, null, 2)}\n`;
  files["tsconfig.lib.json"] =
    `${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "./out-tsc", declarationMap: false, inlineSources: true }, angularCompilerOptions: { compilationMode: "partial" }, include: ["src/**/*.ts"] }, null, 2)}\n`;
  // demo: the built library (dist/) rendered by a JIT-compiled app (npm run build && npm run demo)
  const stage = (it: ShowcaseItem) =>
    `<${it.spec.tag}${Object.entries(it.props)
      .map(([k, x]) => attrPair(k, x))
      .join("")}></${it.spec.tag}>`;
  const body = showcaseBody(model, {
    title: `${model.name} — Angular`,
    subtitle: `${model.specs.length} standalone components`,
    stage,
  });
  files["demo/index.html"] =
    `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escHtml(model.name)} — Angular</title>\n  <style>\n${SHOWCASE_CSS}\n  </style>\n</head>\n<body class="dsx">\n<demo-root></demo-root>\n<script type="module" src="./main.ts"></script>\n</body>\n</html>\n`;
  files["demo/demo.html"] =
    `${body.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;").replace(/@/g, "&#64;")}\n`;
  files["demo/main.ts"] = `import '@angular/compiler'
import { Component, ViewEncapsulation, provideZonelessChangeDetection } from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import { ${pascalCase(model.prefix, "Ds")}Components } from '../dist'
import '../tokens.css'
import template from './demo.html?raw'

@Component({ selector: 'demo-root', standalone: true, imports: [...${pascalCase(model.prefix, "Ds")}Components], template, encapsulation: ViewEncapsulation.None })
class DemoComponent {}

bootstrapApplication(DemoComponent, { providers: [provideZonelessChangeDetection()] }).then(() => document.body.setAttribute('data-ready', ''))
`;
  files["demo/env.d.ts"] = `declare module '*.html?raw' { const s: string; export default s }\n`;
  files["vite.demo.config.ts"] =
    `import { defineConfig } from 'vite'\n\n// Demo page: every component in every variant, JIT-compiled from the built library (npm run build first)\nexport default defineConfig({ root: 'demo', base: './', build: { outDir: '../demo-dist', emptyOutDir: true, assetsInlineLimit: 100_000_000, target: 'es2022' }, esbuild: { target: 'es2022' }, server: { fs: { allow: ['..'] } } })\n`;
  Object.assign(
    files,
    docsFiles(model, {
      title: `${model.name} — components`,
      usage: (s) => angularUsage(s, {}, o.packageName),
    }),
  );
  files["README.md"] = readme(model, {
    packageName: o.packageName,
    framework: "Angular",
    install: `npm install ${o.packageName}`,
    build:
      "npm install\nnpm run build      # dist/: the Angular package (ng-packagr, partial compilation)\nnpm run demo       # every component in every variant",
    setup: `Add the tokens to your global styles (angular.json → \`styles\`): \`node_modules/${o.packageName}/tokens.css\`, and the \`${model.prefix}-theme\` class to \`<body>\`.\n\n\`\`\`ts\nimport { ${model.specs[0] ? ngClassName(model.specs[0]) : "Component"} } from '${o.packageName}'\n\n@Component({ standalone: true, imports: [${model.specs[0] ? ngClassName(model.specs[0]) : ""}], template: \`…\` })\n\`\`\`\n\nComponents are standalone; \`${pascalCase(model.prefix, "Ds")}Components\` lists them all. Every component takes \`styleClass\` (extra classes on its root). Styles are not encapsulated: class names are scoped by prefix.`,
    usage: (s) => angularUsage(s, {}, o.packageName),
  });
  return files;
}
