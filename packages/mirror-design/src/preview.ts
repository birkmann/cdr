/**
 * Design-only preview: renders a crawled page purely from design/ (layout + variants, content-type template,
 * components with their observed instance values, the page's asset set: ported CSS, drupalSettings, scripts).
 * Nested entities are rendered recursively through their own components (by entity id), so the HTML exercises
 * every mined template. This is the reference rendering a generator should reach with CCM data; it is used by the
 * design self-check (pixel parity of design/ alone) and to debug parity findings without the generated app.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { renderTemplate, escapeHtml } from "./render.js";
import type { ComponentDef, LayoutDef, TemplateDef } from "./mine.js";
import type { DesignManifest } from "./index.js";

export interface DesignBundle {
  manifest: DesignManifest;
  components: Map<string, ComponentDef>;
  templates: Map<string, TemplateDef>;
  layout?: LayoutDef;
}

export async function loadDesign(designDir: string): Promise<DesignBundle> {
  const manifest = JSON.parse(await readFile(join(designDir, "manifest.json"), "utf8")) as DesignManifest;
  const components = new Map<string, ComponentDef>();
  for (const c of manifest.components) components.set(c.id, JSON.parse(await readFile(join(designDir, c.file), "utf8")));
  const templates = new Map<string, TemplateDef>();
  for (const t of manifest.templates) templates.set(t.contentType, JSON.parse(await readFile(join(designDir, t.file), "utf8")));
  const lf = manifest.layouts?.[0]?.file;
  const layout = lf ? (JSON.parse(await readFile(join(designDir, lf), "utf8")) as LayoutDef) : undefined;
  void readdir;
  return { manifest, components, templates, layout };
}

const attrsHtml = (a: Record<string, string | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escapeHtml(v!)}"`))
    .join("");

/** Full HTML document for a crawled page path. `designUrl` = URL prefix under which design/ is served. */
export async function renderDesignPage(designDir: string, path: string, opts: { designUrl?: string; bundle?: DesignBundle } = {}): Promise<string> {
  const d = opts.bundle ?? (await loadDesign(designDir));
  const prefix = (opts.designUrl ?? "/_design").replace(/\/+$/, "");
  const url = (rel: string) => (/^(https?:)?\/\//.test(rel) || rel.startsWith("/") ? rel : `${prefix}/${rel}`);
  const pd = d.manifest.pages?.[path];
  const type = pd?.contentType ?? [...d.templates.keys()][0];
  const tpl = d.templates.get(type!);
  if (!tpl) throw new Error(`no content-type template for ${path}`);
  const pick = (base: string) => pd?.components?.[base] ?? base;

  /** component instance rendering; nested entities (list items with entityId) through their own components */
  const byEntity = (type: string | undefined, entityId: string): ComponentDef | undefined => {
    for (const c of d.components.values()) if ((c.id === type || c.variantOf === type || !type) && c.instanceKey === "entityId" && c.instanceProps?.[entityId]) return c;
    return undefined;
  };
  const renderComp = (c: ComponentDef, key: string, depth = 0): string => {
    const values = structuredClone(c.instanceProps?.[key] ?? c.exampleProps) as Record<string, unknown>;
    for (const p of c.props) {
      if (p.component) {
        const sub = d.components.get(pick(p.component));
        if (sub) values[p.name] = renderComp(sub, key, depth + 1);
      } else if (p.type === "list" && Array.isArray(values[p.name]) && depth < 12) {
        values[p.name] = (values[p.name] as Record<string, unknown>[]).map((it) => {
          if (!it || typeof it !== "object" || typeof it.entityId !== "string") return it;
          const sub = byEntity(it.type as string | undefined, it.entityId);
          if (!sub) return it;
          const inner = renderComp(sub, it.entityId, depth + 1);
          // keep the whitespace around the entity (componentList items carry the field--item inner HTML)
          const html = typeof it.html === "string" ? it.html : "";
          const m = /^(\s*)[\s\S]*?(\s*)$/.exec(html)!;
          return { ...it, html: `${m[1]}${inner}${m[2]}` };
        });
      }
    }
    return renderTemplate(c.template, values);
  };

  const chrome: Record<string, string> = {};
  const resolve = (id: string) => {
    const base = d.components.get(id)?.variantOf ?? id;
    return d.components.get(pd?.components?.[base] ?? id) ?? d.components.get(base);
  };
  for (const base of d.layout?.chrome ?? tpl.chrome) {
    const c = resolve(tpl.chrome.find((x) => (d.components.get(x)?.variantOf ?? x) === base) ?? base);
    if (c) chrome[base] = renderComp(c, path);
  }
  const regions: Record<string, string> = {};
  const own = pd?.template;
  for (const s of own?.slots ?? tpl.slots) {
    const c = resolve(s.component);
    if (!c) continue;
    const r = s.region ?? "content";
    regions[r] = (regions[r] ?? "") + renderComp(c, path);
  }
  const wrapperHtml = own?.wrapperHtml ?? tpl.wrapperHtml;
  // UI strings of the type wrapper for this page's locale ({{t.<key>}}, multilingual templates)
  const loc = pd?.locale ?? d.manifest.defaultLocale ?? "en";
  const t = !own?.wrapperHtml && tpl.i18n ? Object.fromEntries(Object.entries(tpl.i18n).map(([k, m]) => [k, m[loc] ?? Object.values(m)[0] ?? ""])) : undefined;
  const main = wrapperHtml ? renderTemplate(wrapperHtml, { regions, ...(t ? { t } : {}) }) : Object.values(regions).join("");
  const layoutVariant = pd?.layoutVariant ? d.layout?.variants?.find((v) => v.id === pd.layoutVariant) : undefined;
  const layoutTpl = layoutVariant?.template ?? d.layout?.template ?? "{{{chrome.siteHeader}}}{{{main}}}{{{chrome.siteFooter}}}";
  const layoutValues = { ...(layoutVariant?.exampleProps ?? d.layout?.instanceProps?.[path] ?? d.layout?.exampleProps ?? {}), chrome, main };
  const body = renderTemplate(layoutTpl, layoutValues);

  const set = pd?.assetSet ? d.manifest.assetSets?.[pd.assetSet] : undefined;
  const head: string[] = ['<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1.0">'];
  const tail: string[] = [];
  for (const p of d.manifest.preload ?? []) head.push(`<link rel="preload" as="font" href="${url(p.href)}"${p.type ? ` type="${p.type}"` : ""}${p.crossorigin !== undefined ? ` crossorigin="${p.crossorigin}"` : ""}>`);
  for (const s of set?.stylesheets ?? d.manifest.stylesheets.map((e) => ({ href: typeof e === "string" ? e : e.href, media: undefined, attrs: undefined }))) head.push(`<link rel="stylesheet"${attrsHtml({ media: s.media, ...(s.attrs ?? {}) })} href="${url(s.href)}">`);
  const scripts = set?.scripts ?? d.manifest.scripts.map((s) => ({ ...s, role: "theme" as const, type: undefined, attrs: undefined }));
  for (const s of scripts) {
    let tag: string;
    if (s.role === "settings") tag = `<script type="application/json" data-drupal-selector="drupal-settings-json">${(await readFile(join(designDir, s.src), "utf8")).replace(/<\//g, "<\\/")}</script>`;
    else tag = `<script src="${url(s.src)}"${attrsHtml(s.attrs ?? {})}></script>`;
    (s.placement === "head" ? head : tail).push(tag);
  }
  const lang = d.manifest.pages?.[path]?.locale ?? d.manifest.defaultLocale ?? "en";
  const dir = d.layout?.htmlAttrs?.dir ?? "ltr";
  return `<!DOCTYPE html>\n<html lang="${lang}" dir="${dir}">\n<head>\n${head.join("\n")}\n</head>\n<body${pd?.bodyClass ? ` class="${escapeHtml(pd.bodyClass)}"` : ""}>\n${body}\n${tail.join("\n")}\n</body>\n</html>\n`;
}

const MIME: Record<string, string> = { ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject" };

/**
 * Serve the design-only preview: crawled page paths -> renderDesignPage, /_design/* -> design/ files, everything
 * else (content images, ajax) proxied to `fallbackOrigin` (the original site / replay). For parity debugging:
 *   pnpm tsx packages/design/src/preview.ts workspace/nestle/design http://localhost:4401 4431
 */
export async function startDesignPreview(designDir: string, opts: { port: number; fallbackOrigin?: string; host?: string }): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer, request } = await import("node:http");
  const { extname } = await import("node:path");
  const bundle = await loadDesign(designDir);
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    try {
      if (u.pathname.startsWith("/_design/")) {
        const f = join(designDir, decodeURIComponent(u.pathname.slice("/_design/".length)).replace(/\.\.+/g, ""));
        const b = await readFile(f);
        res.writeHead(200, { "content-type": MIME[extname(f).toLowerCase()] ?? "application/octet-stream" });
        return void res.end(b);
      }
      if (bundle.manifest.pages?.[u.pathname]) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return void res.end(await renderDesignPage(designDir, u.pathname, { bundle }));
      }
    } catch {
      res.writeHead(404);
      return void res.end();
    }
    if (!opts.fallbackOrigin) {
      res.writeHead(404);
      return void res.end();
    }
    const target = new URL(req.url ?? "/", opts.fallbackOrigin);
    const p = request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    p.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(p);
  });
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((r) => srv.listen(opts.port, host, r));
  return { url: `http://${host}:${opts.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

if (process.argv[1] && /preview\.ts$/.test(process.argv[1])) {
  const [dir, origin, port = "4431"] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: tsx packages/design/src/preview.ts <design dir> [fallback origin] [port]");
    process.exit(2);
  }
  startDesignPreview(dir, { port: Number(port), fallbackOrigin: origin }).then((s) => console.log(`design preview on ${s.url} (fallback ${origin ?? "none"})`));
}
