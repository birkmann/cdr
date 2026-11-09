/**
 * URL rewriting for the replay server + tracker list + Wayback artefact stripping.
 * Ported from the source pipeline's capture package; the tracker test also takes the mirror crawl's own list.
 *
 * Text bodies are processed as latin1 strings: every replacement is ASCII, so a latin1 round trip is
 * byte-preserving for any charset (UTF-8 included).
 */

/** Analytics / tracking / session-recording hosts. Requests to these are answered 204 by the replay. */
export const TRACKER_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
  "adservice.google.com",
  "adobedtm.com",
  "omtrdc.net",
  "demdex.net",
  "everesttech.net",
  "2o7.net",
  "hotjar.com",
  "hotjar.io",
  "connect.facebook.net",
  "bat.bing.com",
  "clarity.ms",
  "snap.licdn.com",
  "px.ads.linkedin.com",
  "analytics.twitter.com",
  "static.ads-twitter.com",
  "t.co",
  "newrelic.com",
  "nr-data.net",
  "lytics.io",
  "igodigital.com",
  "serving-sys.com",
  "outbrain.com",
  "adsrvr.org",
  "betrad.com",
  "evidon.com",
  "gbqofs.com",
  "gbqofs.io",
  "qualtrics.com",
  "usabilla.com",
  "analyze.ly",
  "adsymptotic.com",
  "pump.to",
  "tiktok.com/i18n/pixel",
  "analytics.tiktok.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "quantserve.com",
  "scorecardresearch.com",
  // the archive itself must never be reached by a replayed page
  "web.archive.org",
  "web-static.archive.org",
  "archive.org",
];

/** Same-origin tracker loaders (Drupal google_tag module, Cloudflare + Akamai bot sensors etc.): answered 204 as well. */
export const TRACKER_PATHS = [
  /\/modules\/contrib\/google_tag\/js\//,
  /\/modules\/contrib\/google_analytics\//,
  /\/_static\//,
  /\/cdn-cgi\/(rum|challenge-platform|scripts\/.*insights)/,
  /\/akam\/\d+\//,
];

import { isTrackerUrl as isCrawlTrackerUrl } from "@harness/mirror-capture";

export function isTrackerHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return TRACKER_HOSTS.some((t) => !t.includes("/") && (h === t || h.endsWith("." + t)));
}

export function isTrackerUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (isTrackerHost(url.host)) return true;
  if (isCrawlTrackerUrl(u)) return true;
  if (TRACKER_HOSTS.some((t) => t.includes("/") && (url.host + url.pathname).includes(t))) return true;
  return TRACKER_PATHS.some((re) => re.test(url.pathname));
}

export interface RewriteOptions {
  /** original origin, e.g. https://www.nestle.com */
  origin: string;
  /** replay base, e.g. http://localhost:4401 (no trailing slash) */
  replayBase: string;
  /** third-party hosts served under /__ext/<host>/ (captured + tracker hosts) */
  extHosts: Iterable<string>;
  /** an `<a href>` this answers true for keeps its original URL: the snapshot has no such page to send it to */
  keepLink?: (href: string) => boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Compiled {
  re: RegExp;
  originHosts: Set<string>;
  extHosts: Set<string>;
  /** quoted scheme-less "host/path" string literals of captured third-party hosts (JS only) */
  bare?: RegExp;
}
const cache = new Map<string, Compiled>();

function compile(o: RewriteOptions): Compiled {
  const originHost = new URL(o.origin).host.toLowerCase();
  const originHosts = new Set([originHost]);
  if (originHost.startsWith("www.")) originHosts.add(originHost.slice(4));
  const ext = new Set([...o.extHosts].map((h) => h.toLowerCase()).filter((h) => !originHosts.has(h)));
  const key = [...originHosts].join(",") + "|" + [...ext].sort().join(",");
  let c = cache.get(key);
  if (!c) {
    // tracker domains match with any subdomain (www.googletagmanager.com → 204 via /__ext/)
    const trackers = TRACKER_HOSTS.filter((t) => !t.includes("/")).map((t) => `(?:[a-z0-9-]+\\.)*${esc(t)}`);
    const hosts = [...[...originHosts, ...ext].sort((a, b) => b.length - a.length).map(esc), ...trackers];
    // (scheme)? then // or \/\/ (JSON-escaped), then a known host, followed by a URL boundary
    c = {
      re: new RegExp(`(https?:)?(//|\\\\/\\\\/)(${hosts.join("|")})(?![A-Za-z0-9.-])(:\\d+)?`, "gi"),
      originHosts,
      extHosts: ext,
      bare: ext.size
        ? new RegExp(
            `(["'\`])(${[...ext]
              .sort((a, b) => b.length - a.length)
              .map(esc)
              .join("|")})(?=/)`,
            "g",
          )
        : undefined,
    };
    cache.set(key, c);
  }
  return c;
}

function rewriteChunk(s: string, o: RewriteOptions, c: Compiled, allowExt: boolean): string {
  const base = new URL(o.replayBase);
  return s.replace(c.re, (m, scheme: string | undefined, slashes: string, host: string) => {
    const h = host.toLowerCase();
    const escaped = slashes !== "//";
    const sl = escaped ? "\\/\\/" : "//";
    const pre = scheme ? `${base.protocol}${sl}${base.host}` : `${sl}${base.host}`;
    if (c.originHosts.has(h)) return pre;
    if (!allowExt || (!c.extHosts.has(h) && !isTrackerHost(h))) return m;
    return `${pre}${escaped ? "\\/" : "/"}__ext${escaped ? "\\/" : "/"}${h}`;
  });
}

/** Rewrite absolute origin URLs → replay, third-party captured hosts → /__ext/<host>. */
export function rewriteText(text: string, o: RewriteOptions): string {
  return rewriteChunk(text, o, compile(o), true);
}

/**
 * JS variant: additionally rewrites scheme-less host literals of captured third-party hosts
 * (`proto + "//" + "cdnjs.cloudflare.com/ajax/…"` → `"localhost:4401/__ext/cdnjs.cloudflare.com/ajax/…"`).
 */
export function rewriteJs(text: string, o: RewriteOptions): string {
  const c = compile(o);
  const s = rewriteChunk(text, o, c, true);
  if (!c.bare) return s;
  const host = new URL(o.replayBase).host;
  return s.replace(c.bare, (_m, q: string, h: string) => `${q}${host}/__ext/${h}`);
}

/**
 * AEM experience-fragment toggles ship their default variant hidden: a component script fetches the variant from a
 * personalisation servlet per visitor and only then reveals it. A capture cannot contain that response, so the block
 * would stay empty (bmw.de "Finden Sie Ihren BMW."). Serve the default variant visible and without the component, as
 * a visitor without a personalisation cookie sees it. `data-hide-if-empty` toggles really are empty by default: left alone.
 */
export function openXfToggles(html: string): string {
  const tagRest = `(?:[^>"']|"[^"]*"|'[^']*')*`;
  const re = new RegExp(
    `<div\\b${tagRest}\\bdata-component-path=["']xftoggle-[^"']*["']${tagRest}>\\s*<div\\b${tagRest}\\bclass=["']cmp-xftoggle hidden["']${tagRest}>`,
    "gi",
  );
  return html.replace(re, (m) => {
    if (/\sdata-hide-if-empty(?!=["']false["'])/i.test(m)) return m;
    return m
      .replace(/\s(?:data-loader|data-component-path)=(?:"[^"]*"|'[^']*')/gi, "")
      .replace(/cmp-xftoggle hidden/i, "cmp-xftoggle");
  });
}

/**
 * HTML variant: origin URLs are rewritten everywhere; third-party hosts everywhere except inside `<a …>`
 * tags (outbound links stay outbound links, only subresources move under /__ext/).
 */
export function rewriteHtml(html: string, o: RewriteOptions): string {
  const c = compile(o);
  let out = "";
  let last = 0;
  const aTag = /<a\b[^>]*>/gi;
  for (let m = aTag.exec(html); m; m = aTag.exec(html)) {
    out += rewriteChunk(html.slice(last, m.index), o, c, true);
    const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    out += href && o.keepLink?.(href.replace(/&amp;/g, "&")) ? m[0] : rewriteChunk(m[0], o, c, false);
    last = m.index + m[0].length;
  }
  return out + rewriteChunk(html.slice(last), o, c, true);
}

export function isTextMime(mime: string): boolean {
  return /^text\/|javascript|ecmascript|json|xml|svg|x-www-form-urlencoded/.test(mime);
}

export function kindOf(mime: string): "html" | "css" | "js" | "text" | "binary" {
  if (/html/.test(mime)) return "html";
  if (/css/.test(mime)) return "css";
  if (/javascript|ecmascript/.test(mime)) return "js";
  return isTextMime(mime) ? "text" : "binary";
}

// ---------------------------------------------------------------- Wayback artefacts

const WB_PREFIX =
  /(?:(?:https?:)?\/\/web\.archive\.org)?\/web\/\d{1,14}(?:[a-z]{2}_)?\/(?=(?:https?:)?\/\/|https?%3A)/gi;

/**
 * Remove everything the Wayback Machine adds to an archived resource: toolbar, wombat/_static includes,
 * `__wm` init, archive comments, and `web.archive.org/web/<ts>xx_/` URL prefixes. `id_` captures are
 * normally clean already; this is the safety net for anything else (and for HAR files saved while
 * browsing web.archive.org).
 */
export function stripWaybackArtefacts(text: string, kind: "html" | "css" | "js" | "text" = "html"): string {
  let s = text;
  if (kind === "html") {
    s = s.replace(
      /<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi,
      "",
    );
    s = s.replace(/<script[^>]*>[^<]*?(?:__wm\.|wombat|RufflePlayer|_____WB\$)[\s\S]*?<\/script>\s*/gi, "");
    s = s.replace(
      /<script[^>]*\bsrc=["'][^"']*(?:archive\.org\/(?:_static|includes)\/|\/_static\/js\/|wombat\.js|athena\.js|ruffle\.js|bundle-playback\.js)[^"']*["'][^>]*>\s*<\/script>\s*/gi,
      "",
    );
    s = s.replace(
      /<link[^>]*\bhref=["'][^"']*(?:archive\.org\/_static\/|\/_static\/css\/)[^"']*["'][^>]*>\s*/gi,
      "",
    );
    s = s.replace(/<!--\s*End Wayback Rewrite JS Include\s*-->\s*/gi, "");
    s = s.replace(/<!--\s*FILE ARCHIVED ON[\s\S]*?-->\s*/gi, "");
    s = s.replace(/<!--\s*playback timings \(ms\):[\s\S]*?-->\s*/gi, "");
    s = s.replace(/<div[^>]*id=["']wm-ipp[^"']*["'][\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi, "");
  }
  if (kind === "js" && s.startsWith("var _____WB$wombat")) {
    s = s.replace(
      /^var _____WB\$wombat\$assign\$function_____[\s\S]*?let opener = _____WB\$wombat\$assign\$function_____\("opener"\);\s*/,
      "",
    );
    s = s.replace(/\s*\}\s*(\/\*\s*FILE ARCHIVED ON[\s\S]*?\*\/\s*)?$/, "\n");
  }
  if (kind === "js" || kind === "html") s = s.replace(/\.__WB_pmw\(self(?:\.window)?\)/g, "");
  if (kind !== "html") s = s.replace(/\/\*\s*FILE ARCHIVED ON[\s\S]*?\*\/\s*$/i, "");
  s = s.replace(WB_PREFIX, "");
  return s;
}

/** True when a body still contains Wayback artefacts (used by checks/tests). */
export function hasWaybackArtefacts(text: string): boolean {
  return /web\.archive\.org|WAYBACK TOOLBAR|__wm\.|_____WB\$wombat|web-static\.archive\.org/.test(text);
}

/** Cloudflare challenge / bot wall page (archived 403s): never store these as content. */
export function isChallengePage(text: string): boolean {
  return /<title>Just a moment\.\.\.<\/title>|cf-browser-verification|window\._cf_chl_opt|Enable JavaScript and cookies to continue/.test(
    text.slice(0, 30000),
  );
}
