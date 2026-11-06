// Pure helpers of the capture driver: content sniffing, data URLs, stylesheet parsing and snapshot walks. Ported
// from the earlier project's api/_lib/capture.ts and crates/fig-server/src/capture.rs (unify_alt_images).
type Json = any;

/** Visit every element node of a snapshot tree. */
export function visit(n: Json, f: (n: Json) => void) {
  if (!n || typeof n !== "object") return;
  f(n);
  for (const k of Array.isArray(n.children) ? n.children : []) visit(k, f);
}

export function sniff(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "\x89PNG") return "image/png";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  const head = b.subarray(0, 4).toString("latin1");
  if (head.startsWith("GIF")) return "image/gif";
  if (head === "wOF2") return "font/woff2";
  if (head === "wOFF") return "font/woff";
  if (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return "font/ttf";
  if (head === "OTTO") return "font/otf";
  if (b.length > 12 && b.subarray(4, 12).toString("latin1") === "ftypavif") return "image/avif";
  if (b.subarray(0, 512).toString("utf8").includes("<svg")) return "image/svg+xml";
  return null;
}

export function dataUrl(type: string, body: Buffer): string {
  const mime = sniff(body) ?? (type.split(";")[0]?.trim() || "application/octet-stream");
  return `data:${mime};base64,${body.toString("base64")}`;
}

/** `data:` URL → (mime, bytes). */
export function decodeDataUrl(u: string): { mime: string; body: Buffer } | null {
  const comma = u.indexOf(",");
  if (!u.startsWith("data:") || comma < 0) return null;
  const meta = u.slice(5, comma);
  const data = u.slice(comma + 1);
  const mime = (meta.split(";")[0] ?? "").toLowerCase();
  try {
    return {
      mime,
      body: meta.endsWith(";base64")
        ? Buffer.from(data.trim(), "base64")
        : Buffer.from(decodeURIComponent(data), "latin1"),
    };
  } catch {
    return { mime, body: Buffer.from(data, "latin1") };
  }
}

/** Does a CSS unicode-range cover Latin letters? (subsets for other scripts are skipped) */
export function latinRange(range: string): boolean {
  return range.split(",").some((part) => {
    const p = part
      .trim()
      .replace(/^[Uu]\+?/, "")
      .replace(/^\+/, "");
    const [a, b] = p.split("-");
    const lo = parseInt((a ?? "").replace(/\?/g, "0"), 16);
    const hi = b !== undefined ? parseInt(b, 16) : parseInt((a ?? "").replace(/\?/g, "f"), 16);
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
    return (lo <= 0x7a && hi >= 0x41) || (lo <= 0xfc && hi >= 0xc0);
  });
}

const absolute = (raw: string, base: string): string | null => {
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
};

/** `@import url(…)` / `@import "…"` targets of a stylesheet, absolute (http(s) only). */
export function cssImports(css: string, base: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@import\s+([^;]*)/g)) {
    const stmt = m[1].trim();
    const target = /^url\(\s*([^)]*?)\s*\)/.exec(stmt)?.[1] ?? /^(["'])(.*?)\1/.exec(stmt)?.[2];
    const abs = target ? absolute(target.trim().replace(/^["']|["']$/g, ""), base) : null;
    if (abs && /^https?:/.test(abs)) out.push(abs);
  }
  return out;
}

export interface FontFaceRule {
  family: string;
  weight: string;
  style: string;
  unicodeRange: string | null;
  stretch: string | null;
  src: { url: string; format: string | null }[];
}

/**
 * A stylesheet's `font-weight` descriptor, validated: a number 1–1000, a range of two, or normal / bold / lighter /
 * bolder (whitespace collapsed, lower-cased); anything else → null. Weights reach file names and CSS downstream.
 */
export function cssFontWeight(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(normal|bold|lighter|bolder)$/.test(t)) return t;
  const parts = t.split(" ");
  return parts.length <= 2 && parts.every((p) => /^\d{1,4}(\.\d+)?$/.test(p) && +p >= 1 && +p <= 1000)
    ? t
    : null;
}

/** `@font-face` blocks of a stylesheet. */
export function fontFaces(css: string, base: string): FontFaceRule[] {
  const out: FontFaceRule[] = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const block = m[1];
    const get = (prop: string) => {
      for (const d of block.split(";")) {
        const i = d.indexOf(":");
        if (i > 0 && d.slice(0, i).trim().toLowerCase() === prop) return d.slice(i + 1).trim();
      }
      return null;
    };
    const family = get("font-family")?.replace(/^["']|["']$/g, "");
    if (!family) continue;
    const srcText = block.slice(Math.max(0, block.indexOf("src")));
    const src: FontFaceRule["src"] = [];
    for (const u of srcText.matchAll(/url\(\s*([^)]*?)\s*\)(\s*format\(\s*([^)]*?)\s*\))?/g)) {
      const abs = absolute(u[1].replace(/^["']|["']$/g, ""), base);
      if (abs) src.push({ url: abs, format: u[3] ? u[3].replace(/["'\s]/g, "") : null });
    }
    out.push({
      family,
      weight: cssFontWeight(get("font-weight")) ?? "400",
      style: get("font-style") ?? "normal",
      unicodeRange: get("unicode-range"),
      stretch: get("font-stretch"),
      src,
    });
  }
  return out;
}

/** Every image URL a snapshot draws, with the largest box (CSS px) it is drawn into. */
export function imageUses(snap: Json, uses: Map<string, [number, number]>) {
  visit(snap?.root, (n) => {
    const w = Number(n.rect?.w) || 0,
      h = Number(n.rect?.h) || 0;
    const add = (u: unknown) => {
      if (typeof u !== "string" || !u.startsWith("http")) return;
      const e = uses.get(u) ?? [0, 0];
      uses.set(u, [Math.max(e[0], w), Math.max(e[1], h)]);
    };
    add(n.src);
    add(n.poster);
    if (n.style?.mask?.url === true) add(n.style.mask.image);
    for (const l of Array.isArray(n.style?.bgLayers) ? n.style.bgLayers : [])
      if (l?.url === true) add(l.image);
  });
}

/**
 * The walks at other widths (`alt`) show the capture's image where theirs is only another resolution of it (a srcset
 * candidate: same proportions): no second file. A picture's other crop (art direction) stays.
 */
export function unifyAltImages(snap: Json) {
  const main = new Map<number, [string, number]>();
  visit(snap.root, (n) => {
    if (typeof n.id !== "number" || typeof n.src !== "string") return;
    const w = Number(n.natural?.w) || 0,
      h = Number(n.natural?.h) || 0;
    main.set(n.id, [n.src, h > 0 ? w / h : 0]);
  });
  const unify = (n: Json) => {
    if (typeof n.base !== "number" || typeof n.src !== "string") return;
    const m = main.get(n.base);
    if (!m || m[0] === n.src || !n.src.startsWith("http")) return;
    const w = Number(n.natural?.w) || 0,
      h = Number(n.natural?.h) || 0;
    const own = h > 0 ? w / h : 0;
    if (m[1] > 0 && own > 0 && Math.abs(own / m[1] - 1) > 0.02) return;
    n.src = m[0];
  };
  for (const a of Array.isArray(snap.alt) ? snap.alt : []) {
    visit(a.root, unify);
    if (a.menuState?.snapshot) visit(a.menuState.snapshot.root, unify);
  }
}

/** Navigation errors a `www.` host often does not have. */
export const retryWww = (err: string) =>
  /ERR_CERT_|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_|ERR_SSL_|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT/.test(err);

/** `https://bmw.de/x` → `https://www.bmw.de/x` (domain names with a dot only, not already `www.`). */
export function wwwVariant(url: URL): URL | null {
  const host = url.hostname;
  if (host.startsWith("www.") || !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":"))
    return null;
  const u = new URL(url);
  u.hostname = `www.${host}`;
  return u;
}

/** First language tag of an Accept-Language header, if it looks like one. */
export function primaryLang(accept: string): string | null {
  const tag = accept.split(/[,;]/)[0]?.trim() ?? "";
  return tag && tag.length <= 20 && /^[A-Za-z][A-Za-z0-9-]*$/.test(tag) ? tag : null;
}

/**
 * Default hiding of on-load overlays in a snapshot (the page as walked at load, and its alt walks; never the menu /
 * widget states, whose open panels are often `role="dialog"` on purpose): a fixed dialog box (`role=dialog |
 * alertdialog`, `<dialog>`) covering more than a small corner is removed, so a recreation never starts with a modal
 * the capture failed to dismiss. → number of nodes removed.
 */
export function stripOnLoadOverlays(snap: Json, viewportHeight = 900): number {
  const width = Number(snap?.page?.width) || 1280;
  const isOverlay = (n: Json) => {
    if (!n || typeof n !== "object" || n.kind === "text") return false;
    const role = String(n.attrs?.role ?? "");
    const dialog = role === "dialog" || role === "alertdialog" || n.tag === "dialog";
    if (!dialog || n.layout?.position !== "fixed") return false;
    const w = Number(n.rect?.w) || 0,
      h = Number(n.rect?.h) || 0;
    return w * h >= width * viewportHeight * 0.12 || h > 120;
  };
  let removed = 0;
  const prune = (n: Json) => {
    if (!n || !Array.isArray(n.children)) return;
    const before = n.children.length;
    n.children = n.children.filter((c: Json) => !isOverlay(c));
    removed += before - n.children.length;
    for (const c of n.children) prune(c);
  };
  prune(snap?.root);
  for (const a of Array.isArray(snap?.alt) ? snap.alt : []) prune(a.root);
  return removed;
}
