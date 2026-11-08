import { elements, reactEventName, type ElementInfo } from "../components/registry.js";
import { contrast } from "../tokens/color.js";
import { STEPS, THEMES, THEME_LABELS, type TokenSystem } from "../tokens/system.js";
import { fill, type PackageNames } from "./packages.js";
import { tokensCss, type FileMap } from "./tokens.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pascal = (s: string) => s.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase());

/** The docs' own chrome (not part of the design system): layout, swatches, tables, code. */
export function docsCss(p: string): string {
  const v = (n: string) => `var(--${p}-${n})`;
  return `* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: ${v("font-sans")}; background: ${v("background")}; color: ${v("text-primary")}; }
.docs { display: grid; grid-template-columns: 15rem minmax(0, 1fr); min-height: 100vh; }
.docs > * { min-width: 0; }
.docs nav.side { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 1.5rem 1rem; background: ${v("layer-01")}; border-right: 1px solid ${v("border-subtle-01")}; }
.docs nav.side h1 { font-size: 1rem; margin: 0 0 1.5rem; }
.docs nav.side h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: ${v("text-secondary")}; margin: 1.25rem 0 0.5rem; }
.docs nav.side a { display: block; padding: 0.25rem 0.5rem; color: ${v("text-primary")}; text-decoration: none; font-size: 0.875rem; border-radius: 4px; }
.docs nav.side a:hover { background: ${v("layer-01-hover")}; }
main { padding: 2rem clamp(1rem, 4vw, 3rem) 6rem; max-width: 72rem; min-width: 0; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 2rem; }
.top h1 { font-family: ${v("font-display")}; font-size: 2.5rem; font-weight: 400; margin: 0; }
.lead { color: ${v("text-secondary")}; max-width: 40rem; }
section.doc { padding: 2.5rem 0; border-top: 1px solid ${v("border-subtle-01")}; }
section.doc > h2 { font-size: 1.75rem; font-weight: 400; margin: 0 0 0.5rem; }
section.doc > p.summary { color: ${v("text-secondary")}; margin: 0 0 1.5rem; }
.stage { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; padding: 2rem; background: ${v("background")}; border: 1px solid ${v("border-subtle-01")}; border-radius: ${v("radius-container")}; }
.stage p { margin: 0; }
.stage > * { max-width: 100%; min-width: 0; }
.stage.column { flex-direction: column; align-items: stretch; }
.stage.column > * { max-width: min(28rem, 100%); }
.code { margin-top: 1rem; }
.code [role="tablist"] { display: flex; gap: 0.25rem; }
.code button.code-tab { font: inherit; font-size: 0.8125rem; padding: 0.375rem 0.75rem; border: 0; border-radius: 4px 4px 0 0; background: transparent; color: ${v("text-secondary")}; cursor: pointer; }
.code button.code-tab[aria-selected="true"] { background: ${v("layer-01")}; color: ${v("text-primary")}; }
pre { margin: 0; padding: 1rem; overflow: auto; background: ${v("layer-01")}; border-radius: 0 4px 4px 4px; font: 0.8125rem/1.5 ${v("font-mono")}; }
.table-wrap { overflow-x: auto; margin-top: 1.5rem; }
table.api { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
section.doc > table.api { margin-top: 1.5rem; display: block; overflow-x: auto; }
.summary code, .lead code { font-family: ${v("font-mono")}; font-size: 0.875em; }
table.api th, table.api td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid ${v("border-subtle-01")}; vertical-align: top; }
table.api code { font-family: ${v("font-mono")}; font-size: 0.8125rem; }
.swatches { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 2px; margin: 0.5rem 0 1.5rem; }
.swatch { aspect-ratio: 1.4; border-radius: 4px; display: flex; align-items: flex-end; padding: 0.25rem; font: 0.6875rem ${v("font-mono")}; }
.palette-name { font-size: 0.875rem; font-weight: 600; margin-top: 1rem; }
.themes { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; }
.theme-card { padding: 1rem; border-radius: ${v("radius-container")}; border: 1px solid ${v("border-subtle-01")}; }
.theme-card .row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; margin: 0.25rem 0; }
.theme-card .dot { width: 1rem; height: 1rem; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(127,127,127,0.4); flex: none; }
.type-row { display: grid; grid-template-columns: 11rem minmax(0, 1fr); gap: 1rem; align-items: baseline; padding: 0.5rem 0; border-bottom: 1px solid ${v("border-subtle-01")}; }
.type-row code { font: 0.75rem ${v("font-mono")}; color: ${v("text-secondary")}; }
.space-row { display: flex; align-items: center; gap: 1rem; font: 0.75rem ${v("font-mono")}; margin: 0.25rem 0; }
.space-row span.bar { height: 1rem; background: ${v("interactive")}; border-radius: 2px; }
.pass { color: ${v("support-success")}; }
.fail { color: ${v("support-error")}; font-weight: 600; }
@media (max-width: 800px) { .docs { grid-template-columns: minmax(0, 1fr); } .stage { padding: 1rem; } .top h1 { font-size: 1.75rem; } .type-row { grid-template-columns: minmax(0, 1fr); gap: 0.25rem; } .docs nav.side { position: static; height: auto; } .swatches { grid-template-columns: repeat(5, minmax(0, 1fr)); } }`;
}

/** Palettes, themes, contrast, type, spacing, radii and elevation as HTML (works with tokens.css alone). */
export function foundationsHtml(t: TokenSystem): string {
  const p = t.spec.prefix;
  const pal = Object.entries(t.palettes)
    .map(
      ([
        name,
        steps,
      ]) => `<div class="palette-name">${esc(name)}${t.baseSteps[name] ? ` <small>(base ${t.baseSteps[name]})</small>` : ""}</div>
<div class="swatches">${STEPS.map(
        (s) =>
          `<div class="swatch" style="background:${steps[s]};color:${contrast(steps[s], "#000") > contrast(steps[s], "#fff") ? "#000" : "#fff"}" title="${name} ${s}: ${steps[s]}">${s}</div>`,
      ).join("")}</div>`,
    )
    .join("\n");
  const keyTokens = [
    "background",
    "layer-01",
    "text-primary",
    "text-secondary",
    "interactive",
    "button-primary",
    "link-primary",
    "border-strong-01",
    "focus",
    "support-error",
    "support-success",
    "support-warning",
  ] as const;
  const themes = THEMES.map(
    (
      n,
    ) => `<div class="theme-card" data-${p}-theme="${n}"><strong>${THEME_LABELS[n]}${n === t.defaultTheme ? " (default)" : ""}</strong>
${keyTokens.map((k) => `<div class="row"><span class="dot" style="background:${t.themes[n][k]}"></span><code>${k}</code> ${t.themes[n][k]}</div>`).join("")}</div>`,
  ).join("\n");
  const failing = t.contrast.filter((c) => !c.pass);
  const contrastRows = t.contrast
    .filter((c) => c.theme === t.defaultTheme)
    .map(
      (c) =>
        `<tr><td><code>${c.fg}</code></td><td><code>${c.bg}</code></td><td>${c.ratio.toFixed(2)}</td><td>${c.min}</td><td class="${c.pass ? "pass" : "fail"}">${c.pass ? "pass" : "fail"}</td></tr>`,
    )
    .join("");
  const type = Object.entries(t.type)
    .map(
      ([n, tok]) =>
        `<div class="type-row"><code>${n}<br>${tok.size}px / ${tok.weight} / ${tok.lineHeight}</code><span style="font-family:var(--${p}-${n}-font-family);font-size:var(--${p}-${n}-font-size);font-weight:var(--${p}-${n}-font-weight);line-height:var(--${p}-${n}-line-height);letter-spacing:var(--${p}-${n}-letter-spacing)">The quick brown fox jumps</span></div>`,
    )
    .join("\n");
  const spacing = Object.entries(t.spacing)
    .map(
      ([n, px]) =>
        `<div class="space-row"><code style="width:7rem">${n}</code><span class="bar" style="width:${px}px"></span>${px}px</div>`,
    )
    .join("\n");
  return `<section class="doc" id="colors"><h2>Colour</h2><p class="summary">Primitive palettes (10 lightest … 100 darkest). The brand colour keeps its exact value at its base step.</p>${pal}</section>
<section class="doc" id="themes"><h2>Themes</h2><p class="summary">Four themes from the same palettes. Set one with <code>data-${p}-theme="…"</code> on any element.</p><div class="themes">${themes}</div></section>
<section class="doc" id="contrast"><h2>Contrast</h2><p class="summary">${failing.length ? `<span class="fail">${failing.length} pair(s) below their minimum.</span>` : `Every pair passes WCAG 2.x in all ${THEMES.length} themes (${t.contrast.length} checks).`} Default theme shown.</p>
<table class="api"><thead><tr><th>Foreground</th><th>Background</th><th>Ratio</th><th>Minimum</th><th></th></tr></thead><tbody>${contrastRows}</tbody></table></section>
<section class="doc" id="type"><h2>Type</h2><p class="summary">${esc(t.fonts.sans)}${t.fonts.display !== t.fonts.sans ? `, ${esc(t.fonts.display)} for display` : ""}, ${esc(t.fonts.mono)} for code.</p>${type}</section>
<section class="doc" id="spacing"><h2>Spacing, size and shape</h2><p class="summary">Controls are ${t.sizes.sm} / ${t.sizes.md} / ${t.sizes.lg} px high; radius ${t.radii.control}px on controls, ${t.radii.container}px on containers.</p>${spacing}
<div class="stage" style="margin-top:1.5rem">${(["01", "02", "03"] as const).map((s) => `<div style="width:8rem;height:5rem;background:var(--${p}-layer-01);border-radius:var(--${p}-radius-container);box-shadow:var(--${p}-shadow-${s});display:grid;place-items:center;font-size:.75rem">shadow-${s}</div>`).join("")}</div></section>`;
}

/** docs/foundations.html: no build needed (tokens.css inline). */
export function foundationsPage(t: TokenSystem): string {
  const p = t.spec.prefix;
  return `<!doctype html>
<html lang="en" data-${p}-theme="${t.defaultTheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.spec.name)} — foundations</title>
<style>
${tokensCss(t)}
${docsCss(p)}
</style>
</head>
<body>
<main>
<div class="top"><div><h1>${esc(t.spec.name)}</h1><p class="lead">Foundations of the design system: colour, themes, contrast, type and spacing. Run <code>npm run docs</code> for the components.</p></div>
<label>Theme <select onchange="document.documentElement.setAttribute('data-${p}-theme', this.value)">${THEMES.map((n) => `<option value="${n}"${n === t.defaultTheme ? " selected" : ""}>${THEME_LABELS[n]}</option>`).join("")}</select></label></div>
${foundationsHtml(t)}
</main>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ code snippets */

/** HTML example → JSX for the React tab. */
export function toReact(html: string, p: string): { code: string; imports: string[] } {
  const imports = new Set<string>();
  const code = html
    .replace(new RegExp(`<(/?)${p}-([a-z-]+)`, "g"), (_, slash: string, tag: string) => {
      const name = pascal(tag);
      imports.add(name);
      return `<${slash}${name}`;
    })
    .replace(
      /\s([a-z]+(?:-[a-z]+)+)(=|(?=[\s>/]))/g,
      (_, attr: string, eq: string) => ` ${attr.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())}${eq}`,
    )
    .replace(
      /\s(disabled|checked|open|indeterminate|inline|filter|toast|danger|zebra|invalid|current|lowContrast)(?=[\s>/])/g,
      " $1",
    )
    .replace(/\sclass=/g, " className=")
    .replace(/\sonclick="this\.nextElementSibling\.show\(\)"/g, " onClick={() => setOpen(true)}")
    .replace(/\svalue="(\d+)"/g, " value={$1}")
    .replace(/\s(totalItems|pageSize|maxlength)="(\d+)"/g, " $1={$2}");
  return { code, imports: [...imports].sort() };
}

function snippets(e: ElementInfo, p: string, n: PackageNames) {
  const html = fill(e.example ?? "", p);
  const r = toReact(html, p);
  const react = `import { ${r.imports.join(", ")} } from '${n.react}'\n\n${r.code}`;
  const angular = `// component.ts\nimport { CUSTOM_ELEMENTS_SCHEMA, Component } from '@angular/core'\nimport { ${pascal(p).toUpperCase()}_COMPONENTS } from '${n.angular}'\n\n@Component({ imports: [...${pascal(p).toUpperCase()}_COMPONENTS], schemas: [CUSTOM_ELEMENTS_SCHEMA], template: \`\n${html
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n")}\n\` })`;
  const lit = `import '${n.wc}'\n\n${html}`;
  return { html, lit, react, angular };
}

/* ------------------------------------------------------------------ docs app */

export function docsApp(t: TokenSystem, n: PackageNames): FileMap {
  const p = t.spec.prefix;
  const els = elements();
  const shown = els.filter((e) => !e.child);
  const children = (e: ElementInfo) => els.filter((c) => c.child && c.file === e.file && c !== e);
  const groups = [...new Set(shown.map((e) => e.group))];
  const sections = shown.map((e) => {
    const s = snippets(e, p, n);
    const api = [e, ...children(e)];
    const propRows = api
      .flatMap((x) =>
        x.props.map(
          (a) =>
            `<tr><td><code>${api.length > 1 ? `${p}-${x.tag} ` : ""}${a.attribute}</code></td><td><code>${esc(a.type)}</code></td><td>${esc(a.description)}</td></tr>`,
        ),
      )
      .join("");
    const eventRows = api
      .flatMap((x) =>
        x.events.map(
          (ev) =>
            `<tr><td><code>${esc(fill(ev.name, p))}</code></td><td><code>${reactEventName(ev.name)}</code></td><td>${esc(ev.description)}</td></tr>`,
        ),
      )
      .join("");
    const column =
      e.group === "Forms" ||
      ["notification", "progress-bar", "accordion", "tabs", "data-table", "pagination", "tile"].includes(
        e.tag,
      );
    return `<section class="doc" id="${e.tag}">
<h2>${esc(pascal(e.tag).replace(/([a-z])([A-Z])/g, "$1 $2"))}</h2>
<p class="summary">${esc(e.summary).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>
<div class="stage${column ? " column" : ""}">${s.html}</div>
<div class="code" data-code>
<div role="tablist" aria-label="Code for ${e.tag}">${["HTML / Lit", "React", "Angular"].map((l, i) => `<button class="code-tab" role="tab" aria-selected="${i === 0}" data-i="${i}">${l}</button>`).join("")}</div>
<pre data-i="0"><code>${esc(s.lit)}</code></pre><pre data-i="1" hidden><code>${esc(s.react)}</code></pre><pre data-i="2" hidden><code>${esc(s.angular)}</code></pre>
</div>
${propRows ? `<div class="table-wrap"><table class="api"><thead><tr><th>Attribute</th><th>Type</th><th>Description</th></tr></thead><tbody>${propRows}</tbody></table></div>` : ""}
${eventRows ? `<div class="table-wrap"><table class="api"><thead><tr><th>Event</th><th>React</th><th>Description</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : ""}
</section>`;
  });
  const nav = `<h1>${esc(t.spec.name)}</h1>
<h2>Foundations</h2>${["colors:Colour", "themes:Themes", "contrast:Contrast", "type:Type", "spacing:Spacing"].map((x) => `<a href="#${x.split(":")[0]}">${x.split(":")[1]}</a>`).join("")}
${groups
  .map(
    (g) =>
      `<h2>${g}</h2>${shown
        .filter((e) => e.group === g)
        .map((e) => `<a href="#${e.tag}">${esc(pascal(e.tag).replace(/([a-z])([A-Z])/g, "$1 $2"))}</a>`)
        .join("")}`,
  )
  .join("\n")}`;
  const body = `<div class="docs">
<nav class="side" aria-label="Contents">${nav}</nav>
<main>
<div class="top"><div><h1>${esc(t.spec.name)}</h1><p class="lead">Tokens, ${shown.length} components for Lit, React and Angular, and the foundations they are built on.</p></div>
<${p}-select label="Theme" id="theme-select" style="min-width:12rem">${THEMES.map((th) => `<option value="${th}"${th === t.defaultTheme ? " selected" : ""}>${THEME_LABELS[th]}</option>`).join("")}</${p}-select></div>
${foundationsHtml(t)}
${sections.join("\n")}
</main>
</div>`;
  const main = `import '${n.tokens}/tokens.css'
import '${n.tokens}/grid.css'
import '${n.wc}'
import './docs.css'

const root = document.documentElement
const params = new URLSearchParams(location.search)
const theme = params.get('theme')
if (theme) root.setAttribute('data-${p}-theme', theme)

const select = document.getElementById('theme-select') as HTMLElement & { value: string }
if (theme) select.value = theme
select.addEventListener('change', () => {
  root.setAttribute('data-${p}-theme', select.value)
  const u = new URL(location.href)
  u.searchParams.set('theme', select.value)
  history.replaceState(null, '', u)
})

// code tabs
for (const box of document.querySelectorAll<HTMLElement>('[data-code]')) {
  const tabs = [...box.querySelectorAll<HTMLButtonElement>('.code-tab')]
  const pres = [...box.querySelectorAll<HTMLElement>('pre')]
  for (const tab of tabs)
    tab.addEventListener('click', () => {
      for (const t of tabs) t.setAttribute('aria-selected', String(t === tab))
      for (const pre of pres) pre.hidden = pre.dataset.i !== tab.dataset.i
    })
}

// the data table's rows are properties
const table = document.querySelector('${p}-data-table') as (HTMLElement & { columns: unknown; rows: unknown }) | null
if (table) {
  table.columns = [
    { key: 'id', header: 'Order', sortable: true },
    { key: 'customer', header: 'Customer', sortable: true },
    { key: 'status', header: 'Status' },
    { key: 'total', header: 'Total (€)', sortable: true, align: 'end' },
  ]
  table.rows = [
    { id: 'A-1042', customer: 'Lena Fischer', status: 'Shipped', total: 129.9 },
    { id: 'A-1041', customer: 'Omar Haddad', status: 'Processing', total: 54 },
    { id: 'A-1040', customer: 'Mia Novak', status: 'Delivered', total: 312.5 },
    { id: 'A-1039', customer: 'Jonas Berg', status: 'Cancelled', total: 18.2 },
    { id: 'A-1038', customer: 'Aiko Tan', status: 'Delivered', total: 76.4 },
  ]
}
`;
  return {
    "package.json": `${JSON.stringify(
      {
        name: `${n.scope}/docs`,
        private: true,
        version: n.version,
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { [n.tokens]: n.version, [n.wc]: n.version },
        devDependencies: { vite: "^6.3.5", typescript: "^5.9.3" },
      },
      null,
      2,
    )}\n`,
    "index.html": `<!doctype html>
<html lang="en" data-${p}-theme="${t.defaultTheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.spec.name)} — design system</title>
</head>
<body>
${body}
<script type="module" src="./main.ts"></script>
</body>
</html>
`,
    "main.ts": main,
    "docs.css": `${docsCss(p)}\n`,
    "vite.config.ts": `import { defineConfig } from 'vite'\n\n// relative asset paths: dist/index.html also opens from the file system and in CDR's preview\nexport default defineConfig({ base: './' })\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM", "DOM.Iterable"], strict: true, noEmit: true, skipLibCheck: true, types: ["vite/client"] }, include: ["main.ts"] }, null, 2)}\n`,
    "foundations.html": foundationsPage(t),
  };
}
