// The modern recreation as an Angular project (standalone components, zoneless): one component per section with its
// markup as its template and its CSS beside it, the page's own wrappers in the page component, every route prerendered
// at build time (`outputMode: "static"`) and hydrated in the browser; the recreation's behaviour (menu, sliders, video,
// widgets) attached after the first render.
import { parseHtml, VOID_TAGS, type HNode } from "./htmltree.js";
import type { ModernDoc, ModernFiles } from "./emit.js";

export interface AngularPageOptions {
  projectName?: string;
  sourceUrl?: string;
  /** component selector prefix (default from the project name) */
  prefix?: string;
}

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
const pascal = (s: string) =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("")
    .replace(/^(\d)/, "S$1") || "Section";

/** characters an Angular template reads as syntax, as entities: blocks (@), interpolation and ICU braces */
const ngText = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/@/g, "&#64;");
const ngAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

/** markup as an Angular template (comments of the page's skeleton become the section components) */
export function toNgTemplate(nodes: HNode[], sub?: (id: string) => string | null): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "comment") {
      const m = /^section:([^ ]+)$/.exec(n.text);
      if (m && sub) out += sub(m[1]!) ?? "";
      continue;
    }
    if (n.type === "text") {
      out += ngText(n.text);
      continue;
    }
    const attrs = n.attrs.map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${ngAttr(v)}"`)).join("");
    out += VOID_TAGS.has(n.tag.toLowerCase())
      ? `<${n.tag}${attrs}>`
      : `<${n.tag}${attrs}>${toNgTemplate(n.children, sub)}</${n.tag}>`;
  }
  return out;
}

/** CSS urls of the page's files from a stylesheet `depth` folders below the project: Angular bundles them */
const fromPublic = (css: string, depth: number) =>
  css.replace(/url\("(assets|fonts|media)\//g, `url("${"../".repeat(depth)}public/$1/`);

export function emitAngularPage(
  doc: ModernDoc,
  modern: ModernFiles,
  o: AngularPageOptions = {},
): ModernFiles {
  const name = kebab(o.projectName ?? "recreation");
  const prefix = (
    o.prefix ??
    (name
      .split("-")[0]!
      .replace(/[^a-z]/g, "")
      .slice(0, 10) ||
      "app")
  ).replace(/^(?=[^a-z])/, "x");
  const files: ModernFiles = {};
  for (const [f, c] of Object.entries(modern))
    if (/^(assets|fonts|media)\//.test(f)) files[`public/${f}`] = c;
  const sections = doc.sections.filter((s) => s.html);
  const comps = new Map<string, { file: string; cls: string; selector: string }>();
  for (const s of sections) {
    let file = kebab(s.id);
    for (let i = 2; [...comps.values()].some((c) => c.file === file); i++) file = `${kebab(s.id)}-${i}`;
    comps.set(s.id, { file, cls: pascal(file), selector: `${prefix}-${file}` });
  }
  const pageCss = doc.sections.find((s) => !s.html)?.css ?? "";
  const hosts = [...comps.values()].map((c) => c.selector).join(", ");
  files["src/styles/base.css"] = fromPublic(
    `${doc.baseCss}\n${hosts ? `${hosts}, ${prefix}-page, app-root { display: contents; }\n` : ""}${pageCss}`,
    2,
  );
  let shared = String(modern["styles.css"] ?? "");
  if (shared.startsWith(doc.baseCss)) shared = shared.slice(doc.baseCss.length);
  for (const c of new Set(doc.sections.map((s) => s.css).filter(Boolean))) shared = shared.replace(c, "");
  files["src/styles/states.css"] = fromPublic(shared.trim() + "\n", 2);
  for (const s of sections) {
    const c = comps.get(s.id)!;
    files[`src/app/sections/${c.file}/${c.file}.html`] = toNgTemplate(parseHtml(s.html)) + "\n";
    files[`src/app/sections/${c.file}/${c.file}.css`] = fromPublic(s.css, 4) + "\n";
    files[`src/app/sections/${c.file}/${c.file}.ts`] =
      `import { ChangeDetectionStrategy, Component, ViewEncapsulation } from "@angular/core";

/** ${s.label} */
@Component({
  selector: "${c.selector}",
  templateUrl: "./${c.file}.html",
  styleUrl: "./${c.file}.css",
  // the page's classes style it as they style the whole page
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ${c.cls} {}
`;
  }
  const page = toNgTemplate(parseHtml(`${doc.prelude}${doc.skeleton}`), (id) => {
    const c = comps.get(id);
    return c ? `<${c.selector} />` : null;
  });
  files["src/app/page/page.html"] = page + "\n";
  files["src/app/page/page.ts"] =
    `import { afterNextRender, ChangeDetectionStrategy, Component } from "@angular/core";
${sections.map((s) => `import { ${comps.get(s.id)!.cls} } from "../sections/${comps.get(s.id)!.file}/${comps.get(s.id)!.file}";`).join("\n")}

/** The page: its sections inside the page's own wrappers. */
@Component({
  selector: "${prefix}-page",
  imports: [${sections.map((s) => comps.get(s.id)!.cls).join(", ")}],
  templateUrl: "./page.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Page {
  constructor() {
    // menu, sliders, video, widgets: in the browser, once the page is there
    afterNextRender(() => void import("../behaviour"));
  }
}
`;
  files["src/app/behaviour.ts"] =
    `// @ts-nocheck: the recreation's behaviour, plain DOM code (data attributes in the markup)\n${doc.runtime}\nexport {};\n`;
  files["src/app/app.ts"] = `import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

@Component({ selector: "app-root", imports: [RouterOutlet], template: "<router-outlet />" })
export class App {}
`;
  files["src/app/app.routes.ts"] = `import type { Routes } from "@angular/router";
import { Page } from "./page/page";

export const routes: Routes = [{ path: "", component: Page }];
`;
  files["src/app/app.routes.server.ts"] = `import { RenderMode, type ServerRoute } from "@angular/ssr";

/** every page is rendered at build time */
export const serverRoutes: ServerRoute[] = [{ path: "**", renderMode: RenderMode.Prerender }];
`;
  files["src/app/app.config.ts"] =
    `import { type ApplicationConfig, provideZonelessChangeDetection } from "@angular/core";
import { provideClientHydration, withEventReplay } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [provideZonelessChangeDetection(), provideRouter(routes), provideClientHydration(withEventReplay())],
};
`;
  files["src/app/app.config.server.ts"] =
    `import { mergeApplicationConfig, type ApplicationConfig } from "@angular/core";
import { provideServerRendering, withRoutes } from "@angular/ssr";
import { appConfig } from "./app.config";
import { serverRoutes } from "./app.routes.server";

export const config: ApplicationConfig = mergeApplicationConfig(appConfig, {
  providers: [provideServerRendering(withRoutes(serverRoutes))],
});
`;
  files["src/main.ts"] = `import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig } from "./app/app.config";

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
`;
  files["src/main.server.ts"] =
    `import { bootstrapApplication, type BootstrapContext } from "@angular/platform-browser";
import { App } from "./app/app";
import { config } from "./app/app.config.server";

const bootstrap = (context: BootstrapContext) => bootstrapApplication(App, config, context);
export default bootstrap;
`;
  files["src/index.html"] = `<!doctype html>
<html lang="${doc.lang}">
<head>
  ${doc.head.filter((h) => !/stylesheet|app\.js/.test(h)).join("\n  ")}
  <base href="./">
</head>
<body${doc.bodyClass ? ` class="${doc.bodyClass}"` : ""}>
<app-root></app-root>
</body>
</html>
`;
  files["angular.json"] =
    JSON.stringify(
      {
        $schema: "./node_modules/@angular/cli/lib/config/schema.json",
        version: 1,
        newProjectRoot: "projects",
        cli: { analytics: false },
        projects: {
          [name]: {
            projectType: "application",
            root: "",
            sourceRoot: "src",
            prefix,
            architect: {
              build: {
                builder: "@angular/build:application",
                options: {
                  browser: "src/main.ts",
                  server: "src/main.server.ts",
                  outputMode: "static",
                  index: "src/index.html",
                  tsConfig: "tsconfig.app.json",
                  assets: [{ glob: "**/*", input: "public" }],
                  styles: ["src/styles/base.css", "src/styles/states.css"],
                },
                configurations: {
                  production: { outputHashing: "all", budgets: [] },
                  development: { optimization: false, extractLicenses: false, sourceMap: true },
                },
                defaultConfiguration: "production",
              },
              serve: {
                builder: "@angular/build:dev-server",
                configurations: {
                  production: { buildTarget: `${name}:build:production` },
                  development: { buildTarget: `${name}:build:development` },
                },
                defaultConfiguration: "development",
              },
            },
          },
        },
      },
      null,
      2,
    ) + "\n";
  const ng = "^20.3.0";
  files["package.json"] =
    JSON.stringify(
      {
        name,
        private: true,
        version: "0.0.0",
        scripts: {
          start: "ng serve",
          build: "ng build",
          "copy-dist":
            "node -e \"require('fs').cpSync('dist/" + name + "/browser','dist',{recursive:true})\"",
          postbuild: "npm run copy-dist",
        },
        dependencies: {
          "@angular/common": ng,
          "@angular/compiler": ng,
          "@angular/core": ng,
          "@angular/platform-browser": ng,
          "@angular/platform-server": ng,
          "@angular/router": ng,
          "@angular/ssr": ng,
          rxjs: "~7.8.0",
          tslib: "^2.8.0",
        },
        devDependencies: {
          "@angular/build": ng,
          "@angular/cli": ng,
          "@angular/compiler-cli": ng,
          typescript: "~5.9.3",
        },
      },
      null,
      2,
    ) + "\n";
  files["tsconfig.json"] =
    JSON.stringify(
      {
        compileOnSave: false,
        compilerOptions: {
          strict: true,
          noImplicitOverride: true,
          skipLibCheck: true,
          isolatedModules: true,
          experimentalDecorators: true,
          target: "ES2022",
          module: "preserve",
        },
        angularCompilerOptions: {
          strictInjectionParameters: true,
          strictInputAccessModifiers: true,
          strictTemplates: true,
        },
      },
      null,
      2,
    ) + "\n";
  files["tsconfig.app.json"] =
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: { outDir: "./out-tsc/app", types: [] },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n";
  files[".gitignore"] = "node_modules\ndist\n.angular\nout-tsc\n";
  files["README.md"] = `# ${o.projectName ?? "Recreation"} (Angular)

A recreation of ${o.sourceUrl ?? "a live page"} as standalone Angular components: one component per section in
\`src/app/sections/\` (its markup as its template, its styles beside it), the page's wrappers in \`src/app/page/\`,
global styles in \`src/styles/\`, the behaviour (menu, sliders, video, widgets) in \`src/app/behaviour.ts\`.

\`\`\`bash
npm install
npm start        # development server
npm run build    # prerenders every route (dist/${name}/browser, copied to dist/)
\`\`\`
`;
  return files;
}
