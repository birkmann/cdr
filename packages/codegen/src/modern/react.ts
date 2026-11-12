// The modern recreation as a React + Vite project: one component per section (JSX written from the page's markup), the
// page's own wrappers in App, every section prerendered by the build (react-dom/server) and hydrated in the browser, the
// recreation's behaviour (menu, sliders, video, widgets) attached once React has taken over.
import { parseHtml, VOID_TAGS, type HNode } from "./htmltree.js";
import type { ModernDoc, ModernFiles } from "./emit.js";

export interface ReactPageOptions {
  projectName?: string;
  sourceUrl?: string;
}

const pascal = (s: string) =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("")
    .replace(/^(\d)/, "S$1") || "Section";

/** HTML attribute → React prop name */
const PROPS: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  srcset: "srcSet",
  fetchpriority: "fetchPriority",
  crossorigin: "crossOrigin",
  playsinline: "playsInline",
  autoplay: "autoPlay",
  disablepictureinpicture: "disablePictureInPicture",
  readonly: "readOnly",
  maxlength: "maxLength",
  colspan: "colSpan",
  rowspan: "rowSpan",
  enctype: "encType",
  "accept-charset": "acceptCharset",
  "http-equiv": "httpEquiv",
  "xlink:href": "xlinkHref",
  "xml:space": "xmlSpace",
  "xmlns:xlink": "xmlnsXlink",
  "xml:lang": "xmlLang",
  value: "defaultValue",
  checked: "defaultChecked",
};

const camel = (s: string) => s.replace(/[-:]([a-z])/g, (_m, c: string) => c.toUpperCase());

function propName(name: string): string {
  const n = name.toLowerCase();
  if (PROPS[n]) return PROPS[n]!;
  if (/^(data|aria)-/.test(n)) return n;
  return /[-:]/.test(name) ? camel(name) : name;
}

function styleObject(css: string): string {
  const entries = css
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      const k = d.slice(0, i).trim(),
        v = d.slice(i + 1).trim();
      const key = k.startsWith("--") ? JSON.stringify(k) : camel(k.replace(/^-ms-/, "ms-"));
      return `${key}: ${JSON.stringify(v)}`;
    });
  return `{{ ${entries.join(", ")} }}`;
}

/** JSX of a node list (texts kept exactly, comments left out) */
export function toJsx(
  nodes: HNode[],
  indent = "",
  sub?: (n: HNode & { type: "el" }) => string | null,
): string {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "comment") {
      const m = /^section:([^ ]+)$/.exec(n.text);
      if (m && sub) {
        const r = sub({ type: "el", tag: `#section:${m[1]}`, attrs: [], children: [] });
        if (r) out.push(`${indent}${r}`);
      }
      continue;
    }
    if (n.type === "text") {
      if (!n.text) continue;
      if (/^\s+$/.test(n.text) && /\n/.test(n.text)) continue;
      out.push(`${indent}{${JSON.stringify(n.text)}}`);
      continue;
    }
    const r = sub?.(n);
    if (r) {
      out.push(`${indent}${r}`);
      continue;
    }
    // an SVG title / description paints nothing: the paint the capture wrote on every SVG node is left out there
    const attrs = /^(title|desc|metadata)$/.test(n.tag)
      ? n.attrs.filter(([k]) => /^(id|lang)$/.test(k))
      : n.attrs;
    const props = attrs.map(([k, v]) => {
      const p = propName(k);
      if (k.toLowerCase() === "style" && v !== null) return `style=${styleObject(v)}`;
      if (v === null) return /^(data|aria)-/.test(p) ? `${p}=""` : p;
      if (
        /^(tabIndex|colSpan|rowSpan|maxLength|minLength|size|rows|cols|span|start)$/.test(p) &&
        /^-?\d+$/.test(v)
      )
        return `${p}={${v}}`;
      return `${p}=${JSON.stringify(v)}`;
    });
    const open = `<${n.tag}${props.length ? ` ${props.join(" ")}` : ""}`;
    if (VOID_TAGS.has(n.tag.toLowerCase()) || !n.children.length) {
      out.push(`${indent}${open} />`);
      continue;
    }
    out.push(`${indent}${open}>`, toJsx(n.children, `${indent}  `, sub), `${indent}</${n.tag}>`);
  }
  return out.filter((x) => x !== "").join("\n");
}

const rooted = (text: string) =>
  text
    .replace(/(src|poster|href)="(assets|fonts|media)\//g, '$1="/$2/')
    .replace(
      /(srcset)="([^"]*)"/g,
      (_m, k: string, v: string) => `${k}="${v.replace(/(^|,\s*)(assets\/)/g, "$1/$2")}"`,
    )
    .replace(/url\("(assets|fonts|media)\//g, 'url("/$1/');

export function emitReactPage(doc: ModernDoc, modern: ModernFiles, o: ReactPageOptions = {}): ModernFiles {
  const name =
    (o.projectName ?? "recreation")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "recreation";
  const files: ModernFiles = {};
  for (const [f, c] of Object.entries(modern))
    if (/^(assets|fonts|media)\//.test(f)) files[`public/${f}`] = c;
  const sections = doc.sections.filter((s) => s.html);
  const names = new Map<string, string>();
  for (const s of sections) {
    let c = pascal(s.id);
    for (let i = 2; [...names.values()].includes(c); i++) c = `${pascal(s.id)}${i}`;
    names.set(s.id, c);
  }
  const pageCss = doc.sections.find((s) => !s.html)?.css ?? "";
  files["src/styles/base.css"] = rooted(`${doc.baseCss}\n${pageCss}`);
  let shared = String(modern["styles.css"] ?? "");
  if (shared.startsWith(doc.baseCss)) shared = shared.slice(doc.baseCss.length);
  for (const c of new Set(doc.sections.map((s) => s.css).filter(Boolean))) shared = shared.replace(c, "");
  files["src/styles/states.css"] = rooted(shared.trim() + "\n");
  for (const s of sections) {
    const c = names.get(s.id)!;
    files[`src/sections/${c}.css`] = rooted(s.css) + "\n";
    files[`src/sections/${c}.tsx`] = `import "./${c}.css";

/** ${s.label} */
export function ${c}() {
  return (
${toJsx(parseHtml(s.html), "    ")}
  );
}
`;
  }
  // the page's own wrappers around its sections, the skip link first
  const skeleton = parseHtml(`${doc.prelude}${doc.skeleton}`);
  const body = toJsx(skeleton, "      ", (n) => {
    const m = /^#section:(.+)$/.exec(n.tag);
    return m && names.has(m[1]!) ? `<${names.get(m[1]!)} />` : m ? "" : null;
  });
  files["src/App.tsx"] =
    `${sections.map((s) => `import { ${names.get(s.id)} } from "./sections/${names.get(s.id)}.js";`).join("\n")}

/** The page: its sections inside the page's own wrappers. */
export function App() {
  return (
    <>
${body}
    </>
  );
}
`;
  files["src/main.tsx"] = `import { StrictMode, startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/base.css";
import "./styles/states.css";

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);
// prerendered by the build: React takes the markup over; otherwise (dev) it renders it
// (in a transition: the work is split into short tasks, the page stays responsive while it hydrates)
if (root.hasChildNodes()) startTransition(() => void hydrateRoot(root, app));
else createRoot(root).render(app);
// menu, sliders, video, widgets: attached to the page once it is there
requestAnimationFrame(() => void import("./behaviour.js"));
`;
  files["src/entry-server.tsx"] = `import { renderToString } from "react-dom/server";
import { App } from "./App.js";

/** The page as HTML (the build writes it into dist/index.html). */
export const render = () => renderToString(<App />);
`;
  files["src/behaviour.js"] = `${doc.runtime}\nexport {};\n`;
  files["src/vite-env.d.ts"] = `/// <reference types="vite/client" />\ndeclare module "*.js";\n`;
  files["scripts/prerender.mjs"] =
    `// After \`vite build\`: the page rendered on the server into dist/index.html (React hydrates it in the browser).
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { render } = await vite.ssrLoadModule("/src/entry-server.tsx");
  const file = "dist/index.html";
  writeFileSync(file, readFileSync(file, "utf8").replace("<!--app-->", render()));
  console.log(\`prerendered the page into \${file}\`);
} finally {
  await vite.close();
}
`;
  files["index.html"] = `<!doctype html>
<html lang="${doc.lang}">
<head>
  ${doc.head
    .filter((h) => !/stylesheet|app\.js/.test(h))
    .map(rooted)
    .join("\n  ")}
  <script type="module" src="/src/main.tsx"></script>
</head>
<body${doc.bodyClass ? ` class="${doc.bodyClass}"` : ""}>
<div id="root"><!--app--></div>
</body>
</html>
`;
  files["src/styles/base.css"] += `\n#root { display: contents; }\n`;
  files["package.json"] =
    JSON.stringify(
      {
        name,
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: {
          dev: "vite",
          build: "tsc --noEmit && vite build && node scripts/prerender.mjs",
          preview: "vite preview",
        },
        dependencies: { react: "^19.1.0", "react-dom": "^19.1.0" },
        devDependencies: {
          "@types/react": "^19.1.0",
          "@types/react-dom": "^19.1.0",
          "@vitejs/plugin-react": "^5.0.0",
          typescript: "^5.9.3",
          vite: "^7.1.12",
        },
      },
      null,
      2,
    ) + "\n";
  files["tsconfig.json"] =
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          allowJs: true,
          noEmit: true,
          types: ["vite/client"],
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n";
  files["vite.config.ts"] = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // relative paths: the build works wherever it is served (a sub-folder, a preview)
  base: "./",
  build: { target: "es2022", cssCodeSplit: false, assetsInlineLimit: 0 },
});
`;
  files[".gitignore"] = "node_modules\ndist\n";
  files["README.md"] = `# ${o.projectName ?? "Recreation"} (React + Vite)

A recreation of ${o.sourceUrl ?? "a live page"} as React components: one component per section in \`src/sections/\`
(with its styles beside it), the page's wrappers in \`src/App.tsx\`, global styles in \`src/styles/\`, the behaviour
(menu, sliders, video, widgets) in \`src/behaviour.js\`.

\`\`\`bash
npm install
npm run dev      # development server
npm run build    # type check, bundle, prerender the page into dist/index.html
npm run preview  # serve dist/
\`\`\`
`;
  return files;
}
