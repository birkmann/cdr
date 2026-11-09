/**
 * Static style port (MIGRATION_PLAN.md §7.1 step 5).
 *
 * Per page, in document order: every `<link rel=stylesheet>` (Drupal aggregates `css_*.css?delta=N&include=…`,
 * theme/contrib files, third-party CSS) and inline `<style>`, with its media attribute. Each file is copied to
 * design/styles/ with
 *   - `@import`s inlined (recursively, wrapped in `@media` when the import has a media list),
 *   - every url() (fonts incl. `?v=…#iefix`/`#icomoon`, icon fonts, SVG sprites, theme images, relative paths)
 *     rewritten to the copied file under design/assets/<original path> (fragment kept, query dropped),
 *   - a media attribute other than all/screen kept as an `@media` wrapper.
 * Print-only stylesheets are excluded. Clickjacking guards (seckit `body{display:none}`, removed by its script at
 * DOMContentLoaded) are kept with their id: theme JS measuring elements before that moment depends on it.
 * Dark-mode CSS is kept: it is scoped (body.dark-mode / darkreader) and the default rendering stays light.
 * Content images (sites/default/files/styles|public) are NOT ported here — they are CCM assets.
 *
 * Different pages may load different aggregates (Drupal libraries per page) — the result keeps one ordered style
 * list per page (`pageStyles`); the caller groups them into asset sets.
 */
import { posix } from "node:path";
import type { Issue, Workspace } from "@harness/mirror-core";
import { dom, type AssetRecord } from "@harness/mirror-capture";
import { AssetLoader, NameRegistry, sha, type LoadedAsset } from "./assets.js";

export interface StylePage {
  path: string;
  tree: dom.Root;
  /** server HTML of the page: CSS-in-JS (styled-components, emotion) is server-rendered into <style> text, while the
   * browser moves it into the CSSOM and the rendered DOM shows an empty <style data-styled> */
  rawTree?: dom.Root;
}

const styleText = (el: dom.Element) => el.children.map((c) => (c.type === "text" ? c.value : "")).join("");
const cssInJsKey = (el: dom.Element) => Object.keys(el.properties ?? {}).filter((k) => /^data(Styled|Emotion|Jss)/.test(k)).sort().join(",");

/** data-styled / data-styled-version / data-emotion attributes of a server CSS-in-JS block (not client "active" copies) */
function cssInJsAttrs(el: dom.Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.properties ?? {})) {
    if (!/^data(Styled|Emotion)/.test(k) || k === "dataCmpCssom") continue;
    out[k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = Array.isArray(v) ? v.join(" ") : String(v);
  }
  if (!Object.keys(out).length || out["data-styled"] === "active" || "data-cmp-cssom" in (el.properties ?? {})) return undefined;
  return out;
}

/** server-rendered text of a CSS-in-JS <style> (by its data-styled/emotion key), or of an empty one at the same position */
function serverStyleText(el: dom.Element, page: StylePage): string {
  if (!page.rawTree) return "";
  const rendered = dom.selectAll("head style", page.tree);
  const raw = dom.selectAll("head style", page.rawTree);
  const key = cssInJsKey(el);
  const twin = key ? raw.find((r) => cssInJsKey(r) === key && styleText(r).trim()) : rendered.length === raw.length && !styleText(el).trim() ? raw[rendered.indexOf(el)] : undefined;
  return twin ? styleText(twin) : "";
}

export interface StyleEntry {
  /** design-relative path of the ported CSS */
  href: string;
  /** original href / "inline" */
  original: string;
  media?: string;
  /** attributes the theme JS relies on (e.g. dark_mode.js looks up `link.darkmode-css`) */
  attrs?: Record<string, string>;
  role?: "darkmode" | "vendor" | "theme" | "aggregate" | "inline" | "security";
}

export interface StylePortResult {
  stylesheets: string[]; // design-relative
  fonts: string[];
  images: string[];
  favicon?: string;
  /** font preloads (<link rel=preload as=font>) of the original pages, design-relative */
  preload: { href: string; as: "font"; type?: string; crossorigin?: string }[];
  /** ordered style entries per page path */
  pageStyles: Record<string, StyleEntry[]>;
  excluded: { original: string; reason: string }[];
  outputs: string[];
  issues: Issue[];
  // legacy field (scripts are ported by portScripts)
  scripts: { src: string; placement: "head" | "body"; original: string; role?: string }[];
}

const FONT_EXT = /\.(woff2?|ttf|otf|eot)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|cur)$/i;

const designAssetPath = (originalPath: string) => `assets/${originalPath.replace(/^\/+/, "").replace(/^__ext\//, "ext/")}`;

export async function portStyles(
  ws: Workspace,
  opts: { baseUrl: string; pages: StylePage[]; assets: AssetRecord[]; dryRun: boolean; rich?: boolean; loader?: AssetLoader },
): Promise<StylePortResult> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const loader = opts.loader ?? new AssetLoader(ws, base, opts.assets, { fetch: opts.rich === true });
  const res: StylePortResult = { stylesheets: [], fonts: [], images: [], preload: [], pageStyles: {}, excluded: [], scripts: [], outputs: [], issues: [] };
  const write = async (rel: string, data: string | Uint8Array) => {
    if (!opts.dryRun) await ws.writeText(`design/${rel}`, data);
    res.outputs.push(`design/${rel}`);
  };
  const assetNames = new NameRegistry("assets");
  const styleNames = new NameRegistry("styles");
  const copiedAsset = new Map<string, string>(); // abs url (no hash) -> design rel

  /** copy a same-origin (or replayed third-party) asset to design/assets/<path> */
  const copyAsset = async (absUrl: string): Promise<string | undefined> => {
    const key = absUrl.replace(/#.*$/, "");
    if (copiedAsset.has(key)) return copiedAsset.get(key);
    let a: LoadedAsset | undefined;
    if (loader.sameOrigin(key)) a = await loader.load(key);
    else {
      const ext = loader.extUrl(key);
      if (ext) a = await loader.load(ext);
    }
    if (!a) return undefined;
    const rel0 = designAssetPath(a.path);
    const { rel: named, fresh } = assetNames.name(rel0.slice("assets/".length), a.body);
    if (fresh) {
      await write(named, opts.dryRun ? new Uint8Array() : new Uint8Array(a.body));
      if (FONT_EXT.test(a.path) || /font/.test(a.mime)) res.fonts.push(named);
      else if (IMAGE_EXT.test(a.path) || a.mime.startsWith("image/")) res.images.push(named);
    }
    copiedAsset.set(key, named);
    return named;
  };

  /** rewrite url()s and inline @imports of one stylesheet */
  const missing = new Map<string, { from: Set<string>; count: number }>();
  const portCss = async (css: string, cssUrl: string, depth = 0): Promise<string> => {
    // 1. url() of this sheet (before @import inlining: imported sheets are rewritten relative to their own URL)
    const replacements = new Map<string, string>();
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const ref = m[2].trim();
      if (/^(data:|#|about:|%23)/.test(ref) || replacements.has(m[0])) continue;
      const abs = loader.abs(ref, cssUrl);
      if (!abs) continue;
      const hash = new URL(abs).hash;
      const rel = await copyAsset(abs);
      if (!rel) {
        if (loader.sameOrigin(abs) || loader.extUrl(abs)) {
          const k = new URL(abs).pathname;
          const e = missing.get(k) ?? { from: new Set<string>(), count: 0 };
          e.from.add(new URL(cssUrl).pathname);
          e.count++;
          missing.set(k, e);
        }
        continue;
      }
      replacements.set(m[0], `url("../${rel}${hash}")`);
    }
    // 2. @import (must come first in a sheet; inlining in place keeps the cascade order)
    const imports: { all: string; ref: string; media: string }[] = [];
    for (const m of css.matchAll(/@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/g)) imports.push({ all: m[0], ref: (m[2] ?? m[4]).trim(), media: (m[5] ?? "").trim() });
    const inlinedImports = new Map<string, string>();
    for (const imp of imports) {
      const abs = loader.abs(imp.ref, cssUrl);
      let inlined: string | undefined;
      if (abs && depth < 6) {
        const a = loader.sameOrigin(abs) ? await loader.load(abs) : loader.extUrl(abs) ? await loader.load(loader.extUrl(abs)!) : undefined;
        if (a) {
          const inner = await portCss(a.body.toString("utf8").replace(/^\uFEFF/, "").replace(/^@charset\s+[^;]+;\s*/i, ""), a.url, depth + 1);
          inlined = imp.media && !/^(all|screen)$/i.test(imp.media) ? `@media ${imp.media} {\n${inner}\n}` : inner;
        }
      }
      if (inlined !== undefined) inlinedImports.set(imp.all, `/* @import ${imp.ref} (inlined) */\n${inlined}\n`);
      else if (abs && !loader.sameOrigin(abs) && !loader.extUrl(abs)) continue; // cross-origin, not replayed: kept as is
      else res.issues.push({ severity: "warning", code: "STYLE_IMPORT_MISSING", message: `@import ${imp.ref} in ${new URL(cssUrl).pathname} could not be loaded`, ref: imp.ref });
    }
    // placeholders so the url() pass does not touch inlined content
    const tokens: [string, string][] = [];
    for (const [all, inl] of inlinedImports) {
      const t = `/*__cmp_import_${tokens.length}__*/`;
      tokens.push([t, inl]);
      css = css.split(all).join(t);
    }
    for (const [from, to] of replacements) css = css.split(from).join(to);
    for (const [t, inl] of tokens) css = css.split(t).join(inl);
    return css;
  };

  const ported = new Map<string, StyleEntry>(); // original abs url / inline sha -> entry
  const order: string[] = []; // union order (legacy top-level list)
  for (const page of opts.pages) {
    const list: StyleEntry[] = [];
    // <noscript> content is inert when JS runs (seckit's noscript_tag.css un-hides <body>): never port it
    const inNoscript = new Set(dom.selectAll("noscript *", page.tree));
    const els = (opts.rich
      ? dom.selectAll("link[rel~=stylesheet], style", page.tree)
      // also <style> in the body: the app's sanitizer drops it from CCM html, so it has to arrive as design CSS (bmw.de: AEM icons size themselves with a per-icon block next to the markup)
      : [...dom.selectAll("link[rel=stylesheet]", page.tree), ...dom.selectAll("style", page.tree)]
    ).filter((el) => !inNoscript.has(el));
    for (const el of els) {
      const media = dom.attr(el, "media");
      if (media && /^\s*print\s*$/i.test(media)) {
        res.excluded.push({ original: dom.attr(el, "href") ?? "inline <style>", reason: "print stylesheet" });
        continue;
      }
      if (el.tagName === "style") {
        // CSS-in-JS: the rendered block (CSSOM rules, client class names) and its server-rendered twin (server class
        // names) can differ; content may come from either HTML, so both are ported (each matches its own classes)
        const own = dom.text(el) ? styleText(el) : "";
        const twin = opts.rich ? "" : serverStyleText(el, page);
        for (const css of [...new Set([own, twin])]) {
          if (!css.trim()) continue;
          const key = `inline:${sha(css, 16)}`;
          let entry = ported.get(key);
          if (!entry) {
            const n = [...ported.values()].filter((e) => e.role === "inline").length + 1;
            const href = `styles/inline-${n}.css`;
            // url()s (fonts, backgrounds) are rewritten and their files ported for every site: CSS-in-JS blocks declare
            // @font-face with root-relative URLs (volkswagen.de) that the generated app does not serve at that path
            const body = await portCss(css, base + page.path);
            await write(href, media && !/^(all|screen)$/i.test(media) ? `@media ${media} {\n${body}\n}\n` : body);
            // CSS-in-JS runtimes rehydrate from their server <style data-styled|data-emotion> (rule order, ids): keep its marker
            const marker = css === own ? cssInJsAttrs(el) : undefined;
            entry = { href, original: "inline", role: "inline", ...(media ? { media } : {}), ...(marker ? { attrs: marker } : {}) };
            ported.set(key, entry);
          }
          if (!list.includes(entry)) list.push(entry);
        }
        continue;
      }
      const href = dom.attr(el, "href");
      if (!href) continue;
      const abs = loader.abs(href.replace(/&amp;/g, "&"));
      if (!abs) continue;
      let entry = ported.get(abs);
      if (!entry) {
        let a: LoadedAsset | undefined;
        if (loader.sameOrigin(abs)) a = await loader.load(abs);
        else if (loader.extUrl(abs)) a = await loader.load(loader.extUrl(abs)!);
        if (!a) {
          if (loader.sameOrigin(abs) || !opts.rich) res.issues.push({ severity: "warning", code: "STYLE_NOT_DOWNLOADED", message: `stylesheet ${loader.sameOrigin(abs) ? new URL(abs).pathname : abs} was not downloaded by the crawl`, ref: new URL(abs).pathname, actionable: true });
          if (!loader.sameOrigin(abs)) {
            // keep third-party CSS (fonts.googleapis…) as an external link
            entry = { href: abs, original: href, ...(media ? { media } : {}), role: "vendor" };
            ported.set(abs, entry);
            list.push(entry);
          }
          continue;
        }
        let css = a.body.toString("utf8").replace(/^﻿/, "");
        css = await portCss(css, a.url);
        if (media && !/^(all|screen)$/i.test(media)) css = `@media ${media} {\n${css}\n}\n`;
        const charset = /^@charset\s+[^;]+;\s*/i.exec(css)?.[0] ?? "";
        const header = `/* ported from ${a.path}${a.query ? a.query.slice(0, 60) + (a.query.length > 60 ? "…" : "") : ""} by @cmp/design — url()s point to design/assets/ */\n`;
        const out = charset + header + css.slice(charset.length);
        const { rel, fresh } = styleNames.name(posix.basename(a.path), Buffer.from(css));
        if (fresh) await write(rel, out);
        const cls = dom.attr(el, "className");
        const id = dom.attr(el, "id");
        const role: StyleEntry["role"] = /\/seckit\//.test(a.path) ? "security" : /darkmode|dark-mode|darkreader/i.test(a.path + (cls ?? "")) ? "darkmode" : /\/files\/css\/css_/.test(a.path) ? "aggregate" : /\/(themes)\//.test(a.path) && !/node_modules/.test(a.path) ? "theme" : "vendor";
        entry = { href: rel, original: href, ...(media ? { media } : {}), ...(cls || id ? { attrs: { ...(cls ? { class: cls } : {}), ...(id ? { id } : {}) } } : {}), ...(opts.rich ? { role } : {}) };
        ported.set(abs, entry);
      }
      list.push(entry);
    }
    res.pageStyles[page.path] = list;
    for (const e of list) if (!order.includes(e.href)) order.push(e.href);
    // font preloads
    for (const l of dom.selectAll("link[rel=preload][as=font]", page.tree)) {
      const h = dom.attr(l, "href");
      const abs = h ? loader.abs(h) : undefined;
      if (!abs) continue;
      const rel = await copyAsset(abs);
      if (rel && !res.preload.some((p) => p.href === rel)) res.preload.push({ href: rel, as: "font", ...(dom.attr(l, "type") ? { type: dom.attr(l, "type") } : {}), ...(dom.attr(l, "crossOrigin") !== undefined ? { crossorigin: dom.attr(l, "crossOrigin") || "anonymous" } : {}) });
    }
  }
  res.stylesheets = order;

  // fonts/icons the crawl downloaded but no ported CSS referenced (e.g. preloaded fonts)
  for (const a of opts.assets) if (a.kind === "font") await copyAsset(loader.abs(a.url) ?? a.url);

  // favicon
  const fav = opts.pages.map((p) => dom.attr(dom.select("link[rel~=icon]", p.tree), "href")).find(Boolean);
  if (fav) {
    const abs = loader.abs(fav);
    if (abs) res.favicon = await copyAsset(abs);
  }
  for (const [path, e] of [...missing].sort(([a], [b]) => a.localeCompare(b)))
    res.issues.push({ severity: "warning", code: "STYLE_ASSET_MISSING", message: `${path} (${e.count} url() reference(s) in ${[...e.from].join(", ")}) could not be loaded`, ref: path });
  res.fonts = [...new Set(res.fonts)].sort();
  res.images = [...new Set(res.images)].sort();
  return res;
}
