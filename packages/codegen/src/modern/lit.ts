// The modern recreation as a Lit + Vite project: one Lit component per section (its template is the source of truth,
// its CSS beside it), behaviour as Lit reactive controllers (menu, slider, video), and a build that prerenders every
// section into dist/index.html with @lit-labs/ssr and hydrates it on the client. The shipped page is complete HTML
// (fast first paint, crawlable, works before scripts run); Lit takes over without re-rendering.
import type { ModernDoc, ModernFiles } from "./emit.js";

export interface LitOptions {
  projectName?: string;
  sourceUrl?: string;
  /** custom element prefix (default: from the project name, e.g. `ix`) */
  prefix?: string;
}

const pascal = (s: string) =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("") || "Section";

/** markup as the body of a lit `html` template literal */
function templateLiteral(markup: string): string {
  return markup.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** relative asset paths of the static page → paths from the site root (Vite serves public/ there) */
function rooted(text: string): string {
  return text
    .replace(/(src|poster|href)="(assets|fonts|media)\//g, '$1="/$2/')
    .replace(
      /(srcset)="([^"]*)"/g,
      (_m, k: string, v: string) => `${k}="${v.replace(/(^|,\s*)(assets\/)/g, "$1/$2")}"`,
    )
    .replace(/url\("(assets|fonts|media)\//g, 'url("/$1/');
}

export function emitLit(doc: ModernDoc, modern: ModernFiles, o: LitOptions = {}): ModernFiles {
  const name =
    (o.projectName ?? "recreation")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "recreation";
  const prefix = (
    o.prefix ??
    (name
      .split("-")[0]!
      .replace(/[^a-z]/g, "")
      .slice(0, 10) ||
      "x")
  ).replace(/^(?=[^a-z])/, "x");
  const files: ModernFiles = {};
  // static files the page refers to: public/ (copied to dist as they are)
  for (const [f, c] of Object.entries(modern))
    if (/^(assets|fonts|media)\//.test(f)) files[`public/${f}`] = c;
  const sections = doc.sections.filter((s) => s.html);
  const tags = new Map<string, string>();
  for (const s of sections) {
    let tag = `${prefix}-${s.id}`.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    if (!/-/.test(tag)) tag = `${tag}-section`;
    for (let i = 2; [...tags.values()].includes(tag); i++) tag = `${prefix}-${s.id}-${i}`;
    tags.set(s.id, tag);
  }
  const pageCss = doc.sections.find((s) => !s.html)?.css ?? "";
  // the section elements lay out as if they were not there: the section inside is the page's box
  const hosts = `${[...tags.values()].join(", ")} { display: contents; }`;
  files["src/styles/base.css"] = rooted(`${doc.baseCss}\n${hosts}\n${pageCss}`);
  // the state and hover rules span sections: one file
  const styles = String(modern["styles.css"] ?? "");
  const sectionCss = new Set(doc.sections.map((s) => s.css).filter(Boolean));
  let shared = styles;
  if (shared.startsWith(doc.baseCss)) shared = shared.slice(doc.baseCss.length);
  for (const c of sectionCss) shared = shared.replace(c, "");
  files["src/styles/states.css"] = rooted(shared.trim() + "\n");
  // one component per section
  const imports: string[] = [];
  const templates: string[] = [];
  for (const s of sections) {
    const tag = tags.get(s.id)!;
    const cls = pascal(s.id);
    const controllers: string[] = [];
    if (/data-slider\b/.test(s.html)) controllers.push("SliderController");
    if (/data-video-toggle|<video|data-marquee/.test(s.html)) controllers.push("VideoController");
    if (/data-menu-open|data-menu-panel|data-menu-close/.test(s.html)) controllers.push("MenuController");
    if (/data-region-toggle|data-region-set/.test(s.html)) controllers.push("RegionController");
    files[`src/sections/${s.id}.template.ts`] = `import { html } from "lit";

/** ${s.label}: its markup (rendered on the server by the build, hydrated in the browser) */
export const template = () => html\`${templateLiteral(s.html)}\`;
`;
    files[`src/sections/${s.id}.css`] = rooted(s.css) + "\n";
    files[`src/sections/${s.id}.ts`] = `import { RecreatedSection } from "../lib/section.js";
${controllers.length ? `import { ${controllers.join(", ")} } from "../lib/controllers.js";\n` : ""}import { template } from "./${s.id}.template.js";
import "./${s.id}.css";

/** <${tag}>: the "${s.label}" section${controllers.length ? ` (${controllers.join(", ")})` : ""} */
export class ${cls} extends RecreatedSection {
  constructor() {
    super();
${controllers.map((c) => `    new ${c}(this);`).join("\n")}
  }

  override template() {
    return template();
  }
}

if (!customElements.get("${tag}")) customElements.define("${tag}", ${cls});
`;
    imports.push(`import "./sections/${s.id}.js";`);
    templates.push(`  ["${tag}", () => import("./sections/${s.id}.template.js").then((m) => m.template())],`);
  }
  files["src/main.ts"] =
    `// Hydration support first: sections prerendered by the build keep their DOM, Lit takes it over.
import "./lib/hydrate.js";
import "./styles/base.css";
import "./styles/states.css";
${imports.join("\n")}
`;
  files["src/lib/hydrate.ts"] =
    `// Nothing to set up for light-DOM sections (RecreatedSection hydrates its own prerendered markup);
// kept as the one place where global hydration support would go.
export {};
`;
  files["src/lib/section.ts"] = `import { ReactiveElement, render, type TemplateResult } from "lit";
import { hydrate } from "@lit-labs/ssr-client";

/**
 * A section of the page in the light DOM (the page's own styles apply, the markup is crawlable). The build prerenders
 * its template into index.html and marks it \`ssr\`; the first update hydrates that markup instead of rendering it
 * again, later updates render as usual.
 */
export abstract class RecreatedSection extends ReactiveElement {
  protected override createRenderRoot() {
    return this;
  }

  abstract template(): TemplateResult;

  protected override update(changed: Map<PropertyKey, unknown>) {
    super.update(changed);
    const t = this.template();
    if (this.hasAttribute("ssr")) {
      hydrate(t, this, { host: this });
      this.removeAttribute("ssr");
    } else render(t, this, { host: this });
  }
}
`;
  files["src/lib/controllers.ts"] = CONTROLLERS_TS;
  files["src/prerender.ts"] =
    `// Build step (node): every section's template rendered to HTML with @lit-labs/ssr (lit-html hydration markers).
import { render } from "@lit-labs/ssr";
import { collectResult } from "@lit-labs/ssr/lib/render-result.js";
import type { TemplateResult } from "lit";

export const sections: [string, () => Promise<TemplateResult>][] = [
${templates.join("\n")}
];

export async function renderSections(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [tag, t] of sections) out[tag] = await collectResult(render(await t()));
  return out;
}
`;
  files["scripts/prerender.mjs"] = PRERENDER_MJS;
  const body = sections.map((s) => `<${tags.get(s.id)!}></${tags.get(s.id)!}>`);
  files["index.html"] = `<!doctype html>
<html lang="${doc.lang}">
<head>
  ${doc.head
    .filter((h) => !/stylesheet|app\.js/.test(h))
    .map(rooted)
    .join("\n  ")}
  <script type="module" src="/src/main.ts"></script>
</head>
<body${doc.bodyClass ? ` class="${doc.bodyClass}"` : ""}>
${doc.prelude}${doc.skeleton ? rooted(doc.skeleton).replace(/<!--section:([^ ]+?)-->/g, (_m, id: string) => (tags.has(id) ? `<${tags.get(id)!}></${tags.get(id)!}>` : "")) : layoutBody(doc, body)}
</body>
</html>
`;
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
        dependencies: { lit: "^3.3.1", "@lit-labs/ssr-client": "^1.1.7" },
        devDependencies: { "@lit-labs/ssr": "^3.3.1", typescript: "^5.9.3", vite: "^7.1.12" },
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
          strict: true,
          useDefineForClassFields: false,
          skipLibCheck: true,
          noEmit: true,
          types: ["vite/client"],
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n";
  files["vite.config.ts"] = `import { defineConfig } from "vite";

export default defineConfig({
  // relative paths: the build works wherever it is served (a sub-folder, a preview)
  base: "./",
  build: { target: "es2022", cssCodeSplit: false, assetsInlineLimit: 0 },
});
`;
  files[".gitignore"] = "node_modules\ndist\n";
  files["README.md"] = `# ${o.projectName ?? "Recreation"} (Lit + Vite)

A recreation of ${o.sourceUrl ?? "a live page"} as Lit components: one light-DOM component per section in \`src/sections/\`
(its template in \`*.template.ts\`, its styles in \`*.css\`), behaviour as reactive controllers in \`src/lib/controllers.ts\`
(menu, sliders, video), global styles in \`src/styles/\`.

\`\`\`bash
npm install
npm run dev      # development server
npm run build    # type check, bundle, prerender every section into dist/index.html
npm run preview  # serve dist/
\`\`\`

The build renders each section on the server (\`@lit-labs/ssr\`), so \`dist/index.html\` is the complete page; in the browser
each section hydrates its own markup. Images, fonts and videos live in \`public/\`.
`;
  return files;
}

/** the page body: the live page's own wrappers are flattened to its landmarks, sections in order */
function layoutBody(doc: ModernDoc, tags: string[]): string {
  const secs = doc.sections.filter((s) => s.html);
  const parts: string[] = [];
  let inMain = false;
  secs.forEach((s, k) => {
    const isEdge =
      s.tag === "header" || s.tag === "footer" || /^(header|footer|menu-panel|navigation)/.test(s.id);
    if (!isEdge && !inMain) {
      parts.push('<main id="main">');
      inMain = true;
    }
    if (isEdge && inMain && s.tag === "footer") {
      parts.push("</main>");
      inMain = false;
    }
    parts.push(tags[k]!);
  });
  if (inMain) parts.push("</main>");
  return parts.join("\n");
}

const PRERENDER_MJS = `// After \`vite build\`: every section's template rendered on the server into dist/index.html (\`<x-… ssr>…</x-…>\`).
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { renderSections } = await vite.ssrLoadModule("/src/prerender.ts");
  const html = await renderSections();
  const file = "dist/index.html";
  let page = readFileSync(file, "utf8");
  for (const [tag, markup] of Object.entries(html)) page = page.replace(\`<\${tag}></\${tag}>\`, \`<\${tag} ssr>\${markup}</\${tag}>\`);
  writeFileSync(file, page);
  console.log(\`prerendered \${Object.keys(html).length} sections into \${file}\`);
} finally {
  await vite.close();
}
`;

const CONTROLLERS_TS = `import type { ReactiveController, ReactiveControllerHost } from "lit";

type Host = ReactiveControllerHost & HTMLElement;
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The navigation menu: [data-menu-open] opens it (:root[data-menu]), [data-menu-close] and Escape close it,
 * [data-menu-back] goes back a level; focus stays inside the open panel and returns to the opener.
 */
export class MenuController implements ReactiveController {
  private opener: HTMLElement | null = null;
  constructor(private host: Host) {
    host.addController(this);
  }
  hostConnected() {
    this.host.addEventListener("click", this.onClick);
    document.addEventListener("keydown", this.onKey);
  }
  hostDisconnected() {
    this.host.removeEventListener("click", this.onClick);
    document.removeEventListener("keydown", this.onKey);
  }
  private panel(name: string) {
    return document.querySelector<HTMLElement>(\`[data-menu-panel="\${name}"]\`) ?? document.querySelector<HTMLElement>("[data-menu-panel]");
  }
  private focusables(el: HTMLElement) {
    return [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.getClientRects().length);
  }
  open(name: string, from: HTMLElement) {
    if (!document.documentElement.hasAttribute("data-menu")) this.opener = from;
    document.documentElement.setAttribute("data-menu", name);
    for (const t of document.querySelectorAll("[data-menu-open]")) t.setAttribute("aria-expanded", String(t.getAttribute("data-menu-open") === name || (name !== "menu" && t.getAttribute("data-menu-open") === "menu")));
    requestAnimationFrame(() => this.focusables(this.panel(name) ?? this.host).find((x) => x.getAttribute("data-menu-open") !== "menu")?.focus());
  }
  close() {
    if (!document.documentElement.hasAttribute("data-menu")) return;
    document.documentElement.removeAttribute("data-menu");
    for (const t of document.querySelectorAll("[data-menu-open]")) t.setAttribute("aria-expanded", "false");
    this.opener?.focus();
    this.opener = null;
  }
  private onClick = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-menu-open], [data-menu-close], [data-menu-back]");
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute("data-menu-close")) return this.close();
    if (t.hasAttribute("data-menu-back")) return this.open("menu", t);
    const name = t.getAttribute("data-menu-open")!;
    if (document.documentElement.getAttribute("data-menu") === name && name === "menu") this.close();
    else this.open(name, t);
  };
  private onKey = (e: KeyboardEvent) => {
    const open = document.documentElement.getAttribute("data-menu");
    if (!open) return;
    if (e.key === "Escape") return this.close();
    if (e.key !== "Tab") return;
    const list = this.focusables(this.panel(open) ?? this.host);
    if (!list.length) return;
    if (e.shiftKey && document.activeElement === list[0]) {
      e.preventDefault();
      list[list.length - 1]!.focus();
    } else if (!e.shiftKey && document.activeElement === list[list.length - 1]) {
      e.preventDefault();
      list[0]!.focus();
    }
  };
}

/**
 * Sliders in the host: a scroll-snap track ([data-slider]) moved by its steps ([data-slider-step]), dots
 * ([data-slider-dot]), the arrow keys and autoplay ([data-autoplay] ms; only while visible, never under reduced motion,
 * paused while the pointer or focus is on it). [data-loop] wraps around at the ends.
 */
export class SliderController implements ReactiveController {
  private cleanups: (() => void)[] = [];
  constructor(private host: Host) {
    host.addController(this);
  }
  hostUpdated() {
    if (this.cleanups.length) return;
    for (const track of this.host.querySelectorAll<HTMLElement>("[data-slider]")) this.cleanups.push(this.wire(track));
  }
  hostDisconnected() {
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }
  private wire(track: HTMLElement): () => void {
    const slides = () => [...track.children].filter((c): c is HTMLElement => (c as HTMLElement).offsetWidth > 0);
    const loop = track.hasAttribute("data-loop");
    const ctl = (sel: string) => [...document.querySelectorAll<HTMLElement>(\`\${sel}[aria-controls="\${track.id}"]\`)];
    const dots = ctl("[data-slider-dot]"),
      steps = ctl("[data-slider-step]");
    const atEnd = () => track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    const index = () => {
      const s = slides();
      let k = 0;
      s.forEach((c, i) => {
        if (c.offsetLeft - s[0]!.offsetLeft <= track.scrollLeft + 2) k = i;
      });
      return k;
    };
    const go = (k: number) => {
      const s = slides();
      if (!s.length) return;
      if (k < 0) k = loop ? s.length - 1 : 0;
      if (k >= s.length || (k > index() && atEnd())) k = loop ? 0 : s.length - 1;
      track.scrollTo({ left: s[k]!.offsetLeft - s[0]!.offsetLeft, behavior: reduced() ? "auto" : "smooth" });
    };
    const sync = () => {
      const k = index();
      dots.forEach((d, i) => d.setAttribute("aria-current", String(i === k)));
      if (!loop) for (const b of steps) b.setAttribute("aria-disabled", String(Number(b.dataset.sliderStep) < 0 ? track.scrollLeft <= 2 : atEnd()));
    };
    const off: (() => void)[] = [];
    const on = (el: EventTarget, ev: string, f: EventListener, opt?: AddEventListenerOptions) => {
      el.addEventListener(ev, f, opt);
      off.push(() => el.removeEventListener(ev, f));
    };
    for (const b of steps) on(b, "click", () => go(index() + Number(b.dataset.sliderStep)));
    dots.forEach((d) => on(d, "click", () => go(Number(d.dataset.sliderDot))));
    on(track, "keydown", ((e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        go(index() + (e.key === "ArrowRight" ? 1 : -1));
      }
    }) as EventListener);
    // dragging with a mouse, as the live slider lets one (touch and trackpads scroll natively): the track follows the
    // pointer, keeps some momentum when let go, and a click that ends a drag opens nothing
    let drag: { x: number; left: number; moved: boolean; lastX: number; lastT: number; v: number } | null = null;
    on(track, "dragstart", (e) => e.preventDefault());
    on(track, "pointerdown", ((e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      drag = { x: e.clientX, left: track.scrollLeft, moved: false, lastX: e.clientX, lastT: performance.now(), v: 0 };
    }) as EventListener);
    on(window, "pointermove", ((e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        track.setAttribute("data-dragging", "");
      }
      track.scrollLeft = drag.left - dx;
      const now = performance.now();
      drag.v = (e.clientX - drag.lastX) / Math.max(1, now - drag.lastT);
      drag.lastX = e.clientX;
      drag.lastT = now;
    }) as EventListener);
    on(window, "pointerup", () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.moved) return;
      const stop = (ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      track.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => track.removeEventListener("click", stop, { capture: true }), 0);
      track.removeAttribute("data-dragging");
      if (!reduced()) track.scrollBy({ left: -d.v * 320, behavior: "smooth" });
    });
    let t = 0;
    on(track, "scroll", () => {
      clearTimeout(t);
      t = window.setTimeout(sync, 80);
    }, { passive: true });
    sync();
    const delay = Number(track.dataset.autoplay) || 0;
    if (delay) {
      let timer = 0,
        visible = false,
        held = false;
      const region = track.closest("section") ?? track.parentElement ?? track;
      const run = () => {
        clearInterval(timer);
        if (visible && !held && !reduced()) timer = window.setInterval(() => go(index() + 1), delay);
      };
      const io = new IntersectionObserver((es) => {
        visible = !!es[0]?.isIntersecting;
        run();
      });
      io.observe(track);
      off.push(() => io.disconnect(), () => clearInterval(timer));
      for (const [ev, v] of [["pointerenter", true], ["pointerleave", false], ["focusin", true], ["focusout", false]] as const)
        on(region, ev, () => {
          held = v;
          run();
        });
    }
    return () => off.forEach((f) => f());
  }
}

/**
 * Widgets that switch in place (tabs, accordions, a toggle that swaps an icon): a control sets data-state on its
 * region ([data-region-toggle] switches its state on and off, [data-region-set] selects it); the CSS shows each state.
 */
export class RegionController implements ReactiveController {
  constructor(private host: Host) {
    host.addController(this);
  }
  hostConnected() {
    this.host.addEventListener("click", this.onClick);
  }
  hostDisconnected() {
    this.host.removeEventListener("click", this.onClick);
  }
  private onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-region-toggle], [data-region-set]");
    if (!b) return;
    const toggle = b.hasAttribute("data-region-toggle");
    const [id, state] = (b.dataset.regionToggle ?? b.dataset.regionSet ?? ":").split(":");
    const region = document.querySelector<HTMLElement>(\`[data-region="\${id}"]\`);
    if (!region) return;
    // a toggle switches its state on and off; a selection sets its state ("" = the widget at rest)
    const on = toggle ? region.dataset.state !== state : true;
    if (on && state) region.dataset.state = state;
    else delete region.dataset.state;
    for (const c of document.querySelectorAll<HTMLElement>(\`[data-region-toggle^="\${id}:"], [data-region-set^="\${id}:"]\`)) {
      const mine = (c.dataset.regionToggle ?? c.dataset.regionSet) === \`\${id}:\${state}\`;
      const attr = c.hasAttribute("aria-selected")
        ? "aria-selected"
        : c.hasAttribute("aria-checked")
          ? "aria-checked"
          : c.hasAttribute("aria-expanded")
        ? "aria-expanded"
        : c.hasAttribute("aria-pressed") && !c.dataset.videoToggle && !c.dataset.marqueeToggle
          ? "aria-pressed"
          : null;
      if (attr) c.setAttribute(attr, String(mine && on));
    }
  };
}

/**
 * Background videos and marquees in the host: no autoplay under reduced motion; [data-video-toggle] pauses and plays a
 * video, [data-marquee-toggle] a marquee.
 */
export class VideoController implements ReactiveController {
  constructor(private host: Host) {
    host.addController(this);
  }
  hostConnected() {
    this.host.addEventListener("click", this.onClick);
  }
  hostDisconnected() {
    this.host.removeEventListener("click", this.onClick);
  }
  private started = false;
  hostUpdated() {
    // background videos start once the page has loaded (their posters paint first), never under reduced motion
    if (!this.started) {
      this.started = true;
      const start = () => {
        for (const v of this.host.querySelectorAll<HTMLVideoElement>("video[data-autoplay]")) {
          if (reduced()) continue;
          v.muted = true;
          new IntersectionObserver((es) => {
            for (const e of es) {
              if (e.isIntersecting && !v.dataset.userPaused) void v.play().catch(() => {});
              else if (!e.isIntersecting) v.pause();
            }
          }).observe(v);
        }
      };
      if (document.readyState === "complete") start();
      else window.addEventListener("load", start, { once: true });
    }
    for (const b of this.host.querySelectorAll<HTMLElement>("[data-video-toggle]")) {
      const v = document.getElementById(b.dataset.videoToggle!) as HTMLVideoElement | null;
      if (!v || b.dataset.wired) continue;
      b.dataset.wired = "";
      const sync = () => {
        b.setAttribute("aria-pressed", String(v.paused));
        b.setAttribute("aria-label", v.paused ? (b.dataset.playLabel ?? "Play video") : (b.dataset.pauseLabel ?? "Pause video"));
      };
      v.addEventListener("play", sync);
      v.addEventListener("pause", sync);
      sync();
    }
  }
  private onClick = (e: Event) => {
    // a marquee's pause control
    const mt = (e.target as HTMLElement).closest<HTMLElement>("[data-marquee-toggle]");
    const m = mt && document.querySelector<HTMLElement>(\`[data-marquee="\${mt.dataset.marqueeToggle}"]\`);
    if (mt && m) {
      const paused = !m.hasAttribute("data-paused");
      m.toggleAttribute("data-paused", paused);
      mt.setAttribute("aria-pressed", String(paused));
      mt.setAttribute("aria-label", paused ? (mt.dataset.playLabel ?? "Play animation") : (mt.dataset.pauseLabel ?? "Pause animation"));
      return;
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-video-toggle]");
    const v = b && (document.getElementById(b.dataset.videoToggle!) as HTMLVideoElement | null);
    if (!v) return;
    if (v.paused) {
      delete v.dataset.userPaused;
      void v.play();
    } else {
      v.dataset.userPaused = "1";
      v.pause();
    }
  };
}
`;
