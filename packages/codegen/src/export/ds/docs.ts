// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// The catalog page of a design-system package (docs/index.html: every component in every variant, grouped by
// category, drawn with the package's own CSS — static, works offline) and the same layout for each framework's demo
// app, plus the README. Pure.
import { escAttr, escHtml } from "../ir.js";
import { luminance, onColor } from "@harness/scene";
import type { FileMap } from "../bundle.js";
import { htmlDocument } from "../html.js";
import { CATEGORY_ORDER } from "@harness/extract";
import { baseCss, componentCss } from "./css.js";
import { propRows } from "./common.js";
import type { DsModel, DsSpec } from "./model.js";
import { renderHtml, showcase, type ShowcaseItem } from "./render.js";

/** Chrome of the catalog (docs page, demo apps): `dsx-` classes only, nothing the components inherit but the theme. */
export const SHOWCASE_CSS = `body.dsx { margin: 0; background: #f4f4f6; color: #1b1b1f; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
.dsx-head { padding: 40px 48px 24px; }
.dsx-head h1 { margin: 0 0 4px; font-size: 28px; letter-spacing: -0.01em; }
.dsx-head p { margin: 0; color: #66666e; }
.dsx-nav { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 16px; }
.dsx-nav a { color: #4b46c8; text-decoration: none; }
.dsx-cat { padding: 8px 48px 32px; }
.dsx-cat > h2 { font-size: 20px; margin: 24px 0 12px; border-bottom: 1px solid #dcdce2; padding-bottom: 8px; }
.dsx-comp { background: #fff; border: 1px solid #e2e2e8; border-radius: 12px; padding: 20px 24px; margin: 0 0 20px; }
.dsx-comp > h3 { margin: 0; font-size: 16px; }
.dsx-comp > .dsx-meta { color: #66666e; margin: 2px 0 12px; font-size: 13px; }
.dsx-comp code, .dsx-comp pre { font: 12px/1.5 ui-monospace, 'SF Mono', Menlo, monospace; }
.dsx-comp pre { background: #f6f6f9; border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 0 0 12px; white-space: pre-wrap; word-break: break-all; }
.dsx-props { border-collapse: collapse; margin: 0 0 14px; font-size: 12px; }
.dsx-props th, .dsx-props td { text-align: left; padding: 3px 12px 3px 0; border-bottom: 1px solid #ececf1; vertical-align: top; }
.dsx-variant { margin: 0 0 16px; }
.dsx-label { font-size: 12px; color: #66666e; margin: 0 0 6px; }
.dsx-scroll { overflow-x: auto; max-width: 100%; }
.dsx-stage { display: flex; flex-direction: column; align-items: flex-start; position: relative; outline: 1px dashed #c9c9d3; }
`;

export interface ShowcaseOptions {
  title: string;
  subtitle?: string;
  /** content of one stage (the component in one variant) */
  stage: (item: ShowcaseItem, index: number) => string;
  /** usage line shown per component */
  usage?: (spec: DsSpec) => string;
  /** per component props table */
  props?: boolean;
}

/** WCAG 2 contrast ratio of two colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** The token pairs text is set in, with their contrast and WCAG level (W7: instead of a dark-mode preview). */
export function contrastRows(
  ds: DsModel["ds"],
): { fg: string; bg: string; ratio: number; level: "AAA" | "AA" | "AA large" | "fail" }[] {
  const t = ds.tokens;
  const pairs: [string, string, string | undefined, string | undefined][] = [
    ["text", "background", t.text, t.background],
    ["textMuted", "background", t.textMuted, t.background],
    ["text", "surface", t.text, t.surface],
    ["textMuted", "surface", t.textMuted, t.surface],
    ["on primary", "primary", t.primary ? onColor(t.primary) : undefined, t.primary],
    ["primary", "background", t.primary, t.background],
    ["accent", "background", t.accent, t.background],
  ];
  return pairs
    .filter(
      (p): p is [string, string, string, string] =>
        !!p[2] && !!p[3] && !p[2].startsWith("$") && !p[3].startsWith("$"),
    )
    .map(([fgName, bgName, fg, bg]) => {
      const ratio = contrastRatio(fg, bg);
      return {
        fg: `${fgName} ${fg}`,
        bg: `${bgName} ${bg}`,
        ratio,
        level: ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "fail",
      };
    });
}

function contrastTable(model: DsModel): string {
  const rows = contrastRows(model.ds);
  if (!rows.length) return "";
  return `<section class="dsx-cat" id="contrast"><h2>Contrast</h2><table class="dsx-props"><tr><th>Text</th><th>On</th><th>Ratio</th><th>WCAG</th></tr>${rows.map((r) => `<tr><td><code>${escHtml(r.fg)}</code></td><td><code>${escHtml(r.bg)}</code></td><td>${r.ratio}:1</td><td>${r.level === "fail" ? "<strong>fail</strong>" : r.level}</td></tr>`).join("")}</table></section>`;
}

/** Body of the catalog: categories → components → variants on stages. */
export function showcaseBody(model: DsModel, o: ShowcaseOptions): string {
  const items = showcase(model);
  const bySpec = new Map<DsSpec, Array<{ item: ShowcaseItem; i: number }>>();
  items.forEach((item, i) => bySpec.set(item.spec, [...(bySpec.get(item.spec) ?? []), { item, i }]));
  const cats = CATEGORY_ORDER.map((c) => ({ c, specs: model.specs.filter((s) => s.category === c) })).filter(
    (g) => g.specs.length,
  );
  const nav = cats
    .map((g) => `<a href="#cat-${g.c}">${escHtml(g.specs[0]!.categoryLabel)} (${g.specs.length})</a>`)
    .join("");
  const sections = cats
    .map((g) => {
      const comps = g.specs
        .map((spec) => {
          const rows = o.props ? propRows(spec) : [];
          const table = rows.length
            ? `<table class="dsx-props"><tr><th>Prop</th><th>Type</th><th>Default</th><th></th></tr>${rows.map((r) => `<tr><td><code>${escHtml(r.name)}</code></td><td><code>${escHtml(r.type)}</code></td><td><code>${escHtml(r.def)}</code></td><td>${escHtml(r.doc)}</td></tr>`).join("")}</table>`
            : "";
          const variants = (bySpec.get(spec) ?? [])
            .map(
              ({ item, i }) =>
                `<div class="dsx-variant"><div class="dsx-label">${escHtml(item.label)}${item.width ? ` · ${item.width}px` : ""}</div><div class="dsx-scroll"><div class="dsx-stage ${model.prefix}-theme" data-stage="${i}" data-component="${escAttr(spec.name)}" style="${item.width ? `width: ${item.width}px; ` : ""}background: ${item.background}">${o.stage(item, i)}</div></div></div>`,
            )
            .join("\n");
          const usage = o.usage ? `<pre>${escHtml(o.usage(spec))}</pre>` : "";
          return `<article class="dsx-comp" id="${escAttr(spec.name)}"><h3>${escHtml(spec.name)}</h3><div class="dsx-meta">${escHtml(spec.kindLabel)} · ${escHtml(spec.def.name)}${spec.description ? ` — ${escHtml(spec.description)}` : ""}</div>${usage}${table}\n${variants}</article>`;
        })
        .join("\n");
      return `<section class="dsx-cat" id="cat-${g.c}"><h2>${escHtml(g.specs[0]!.categoryLabel)}</h2>\n${comps}</section>`;
    })
    .join("\n");
  return `<header class="dsx-head"><h1>${escHtml(o.title)}</h1>${o.subtitle ? `<p>${escHtml(o.subtitle)}</p>` : ""}<nav class="dsx-nav">${nav}<a href="#contrast">Contrast</a></nav></header>\n${sections}\n${contrastTable(model)}`;
}

/** All component CSS for light DOM pages (the docs page, the React / Angular packages). */
export const globalCss = (model: DsModel) =>
  `${baseCss(model.prefix, "global")}\n${model.specs.map((s) => componentCss(s, "global")).join("\n")}`;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** data URL → bytes + extension */
export function dataUrlFile(url: string): { ext: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  try {
    const mime = (m[1] || "application/octet-stream").toLowerCase();
    if (/;base64/i.test(m[2] ?? "")) {
      const bin = atob((m[3] ?? "").replace(/\s+/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { ext: EXT[mime] ?? "bin", bytes };
    }
    return { ext: EXT[mime] ?? "bin", bytes: new TextEncoder().encode(decodeURIComponent(m[3] ?? "")) };
  } catch {
    return null;
  }
}

/** docs/: index.html (static render of every component with the package CSS), docs.css, images. */
export function docsFiles(
  model: DsModel,
  o: { title: string; usage: (spec: DsSpec) => string; tokensHref?: string },
): FileMap {
  const files: FileMap = {};
  const urls = new Map<string, string>();
  for (const [name, url] of model.assets) {
    const f = dataUrlFile(url);
    if (!f) {
      urls.set(name, url);
      continue;
    }
    const path = `assets/${name.toLowerCase().replace(/_/g, "-")}.${f.ext}`;
    files[`docs/${path}`] = f.bytes;
    urls.set(name, path);
  }
  const assetUrl = (name: string) => urls.get(name) ?? "";
  files["docs/docs.css"] = `${SHOWCASE_CSS}\n${globalCss(model)}`;
  const body = showcaseBody(model, {
    title: o.title,
    subtitle: `${model.specs.length} components · rendered with the package's CSS (tokens.css + docs.css)`,
    props: true,
    usage: o.usage,
    stage: (item) => renderHtml(item.spec, item.props, model, { assetUrl }),
  });
  files["docs/index.html"] = htmlDocument({
    title: o.title,
    body,
    stylesheets: [o.tokensHref ?? "../tokens.css", "docs.css"],
    bodyAttrs: { class: "dsx" },
  });
  return files;
}

/** README: install, setup (tokens, theme), then per category every component with its tag / props. */
export function readme(
  model: DsModel,
  o: {
    packageName: string;
    framework: string;
    install: string;
    setup: string;
    usage: (spec: DsSpec) => string;
    build: string;
  },
): string {
  const byCat = CATEGORY_ORDER.map((c) => model.specs.filter((s) => s.category === c)).filter(
    (l) => l.length,
  );
  const comps = byCat
    .map(
      (list) =>
        `### ${list[0]!.categoryLabel}\n\n${list
          .map((spec) => {
            const rows = propRows(spec);
            const table = rows.length
              ? `\n| Prop | Type | Default | |\n| --- | --- | --- | --- |\n${rows.map((r) => `| \`${r.name}\` | \`${r.type.replace(/\|/g, "\\|")}\` | \`${r.def.replace(/\|/g, "\\|")}\` | ${r.doc} |`).join("\n")}\n`
              : "\n_No props._\n";
            return `#### ${spec.name}\n\n${spec.description ? `${spec.description}\n\n` : ""}From the set “${spec.def.name}” (${spec.kindLabel}${spec.variants.length > 1 ? `, ${spec.variants.length} variants` : ""}).\n\n\`\`\`\n${o.usage(spec)}\n\`\`\`\n${table}`;
          })
          .join("\n")}`,
    )
    .join("\n");
  return `# ${o.packageName}

${model.name} as a ${o.framework} component library: ${model.specs.length} components, typed props, variants as props, design tokens as CSS custom properties. Generated by CDR.

## Install

\`\`\`sh
${o.install}
\`\`\`

## Setup

${o.setup}

Design tokens live in \`tokens.css\` (\`--t-*\` custom properties, the bundled fonts' \`@font-face\` rules). Put the \`${model.prefix}-theme\` class on \`<body>\` (or a wrapper) for the page defaults the designs assume (font, text colour, size).

## Build

\`\`\`sh
${o.build}
\`\`\`

## Catalog

\`docs/index.html\` shows every component in every variant (open it in a browser, works offline).

## Components

${comps}
`;
}
