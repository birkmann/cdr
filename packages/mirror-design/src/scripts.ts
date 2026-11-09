/**
 * Script port: the original page's scripts in document order, so Drupal behaviours run exactly as on the source.
 *
 *   drupalSettings  <script type="application/json" data-drupal-selector="drupal-settings-json"> -> design/drupal/settings-<set>.json
 *   jQuery 4, core/misc/drupal.js, once, drupalSettingsLoader … (inside the aggregated js_*.js bundles, kept in order)
 *   theme/contrib/vendor scripts (darkreader, popper, waypoints, SearchStax, Cloudflare email decode) -> design/scripts/
 *   inline scripts that are not trackers -> design/scripts/inline-<sha>.js
 * Excluded (listed in the result): tracker/analytics LOADERS (google_tag gtag.js/gtm.js, GTM/GA/… hosts). They are
 * replaced by one local stub (window.dataLayer + window.gtag no-ops) at the position of the first excluded loader, so
 * behaviours that push events keep working. Inline dataLayer bootstraps are data only (no network) and are kept.
 * Clickjacking guards (seckit: CSS hides <body> until its script runs at DOMContentLoaded) are KEPT: theme JS that
 * measures elements before that moment sees display:none, and the original rendering depends on it.
 * Third-party scripts are loaded through the replay's /__ext/<host>/ path when the site is a replay; otherwise their
 * absolute URL is kept.
 */
import { posix } from "node:path";
import type { Issue, Workspace } from "@harness/mirror-core";
import { dom, isTrackerUrl } from "@harness/mirror-capture";
import { AssetLoader, NameRegistry, sha } from "./assets.js";

export interface ScriptEntry {
  /** design-relative (scripts/…), "drupal/settings-….json" for the settings block, or an absolute URL */
  src: string;
  placement: "head" | "body";
  original: string;
  role: "settings" | "jquery" | "aggregate" | "core" | "vendor" | "theme" | "darkmode" | "search" | "cloudflare" | "inline" | "consent" | "security" | "datalayer" | "tracker-stub";
  /** for role settings: render as <script type="application/json" data-drupal-selector="drupal-settings-json"> */
  type?: string;
  attrs?: Record<string, string>;
}

export interface ScriptPortResult {
  pageScripts: Record<string, ScriptEntry[]>;
  /** drupalSettings per page (design-relative file) */
  pageSettings: Record<string, string>;
  excluded: { original: string; reason: string; placement: "head" | "body" }[];
  /** legacy top-level list: same-origin script files in first-seen order */
  scripts: { src: string; placement: "head" | "body"; original: string; role?: string }[];
  outputs: string[];
  issues: Issue[];
}

const TRACKER = /google_tag\/js\/(gtag|gtm)\.js|googletagmanager\.com|google-analytics\.com|\/gtag\/js|connect\.facebook\.net|hotjar|clarity\.ms|segment\.(io|com)|doubleclick|adobedtm|newrelic|nr-data|bat\.bing|linkedin\.com\/insight|snap\.licdn/i;
/** inline snippets that load trackers (network) — dataLayer pushes alone are data and stay */
const TRACKER_INLINE = /googletagmanager\.com|google-analytics\.com|GoogleAnalyticsObject|connect\.facebook\.net|fbq\(|_satellite|NREUM|static\.hotjar|clarity\.ms/;
const SECURITY = /seckit\//;
const TRACKER_STUB = `/* @cmp/design: stands in for the excluded tracker loaders (no network) */
window.dataLayer = window.dataLayer || [];
window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
`;

/**
 * Attributes of an original <script> worth keeping: loading flags (async/defer/module, crossorigin, priority), id, and
 * its inline load/error handlers — a bootstrap such as bmw.de's `onload="epaas.api.initialize({tenant: …})"` is the
 * only thing that starts the consent controller; without it the script loads and does nothing.
 */
function scriptAttrs(props: Record<string, unknown>): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const k of ["async", "defer", "noModule", "crossOrigin", "fetchPriority", "dataCfasync", "id", "onLoad", "onError"]) {
    const v = props[k];
    if (v === true || v === "") attrs[k === "dataCfasync" ? "data-cfasync" : k.toLowerCase()] = "";
    else if (typeof v === "string") attrs[k === "dataCfasync" ? "data-cfasync" : k.toLowerCase()] = v;
  }
  return attrs;
}

function roleOf(path: string): ScriptEntry["role"] {
  if (/\/core\/assets\/vendor\/jquery\//.test(path)) return "jquery";
  if (/\/files\/js\/js_/.test(path)) return "aggregate";
  if (/^\/core\//.test(path)) return "core";
  if (/dark[-_]?(mode|reader)/i.test(path)) return "darkmode";
  if (/searchstax|searchstudio/i.test(path)) return "search";
  if (/\/cdn-cgi\//.test(path)) return "cloudflare";
  if (SECURITY.test(path)) return "security";
  if (/cookie|consent|onetrust/i.test(path)) return "consent";
  if (/^\/themes\//.test(path) && !/node_modules/.test(path)) return "theme";
  return "vendor";
}

const LITERAL = String.raw`(?:'[^'\\\n]*'|"[^"\\\n]*"|-?\d+(?:\.\d+)?|true|false|null)`;
const CONFIG_STATEMENT = String.raw`(?:window\.|(?:var|let|const)\s+)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*=\s*${LITERAL}\s*;?`;
const CONFIG_ONLY = new RegExp(String.raw`^\s*(?:${CONFIG_STATEMENT}\s*)+$`);
/**
 * An inline script that only assigns literal values to globals (`window.CARBON_LOADER_PATH = '/etc…/resources/';`).
 * Safe to run in the generated app (no calls, no DOM, no framework runtime such as `self.__next_f.push(…)`).
 */
export function isConfigAssignment(body: string): boolean {
  return body.length <= 4000 && CONFIG_ONLY.test(body);
}

export async function portScripts(ws: Workspace, opts: { baseUrl: string; pages: { path: string; tree: dom.Root }[]; loader: AssetLoader; dryRun: boolean; rich: boolean; inline?: boolean }): Promise<ScriptPortResult> {
  const { loader } = opts;
  const res: ScriptPortResult = { pageScripts: {}, pageSettings: {}, excluded: [], scripts: [], outputs: [], issues: [] };
  const write = async (rel: string, data: string | Uint8Array) => {
    if (!opts.dryRun) await ws.writeText(`design/${rel}`, data);
    res.outputs.push(`design/${rel}`);
  };
  const names = new NameRegistry("scripts");
  const settingsNames = new Map<string, string>(); // json sha -> rel
  const ported = new Map<string, ScriptEntry>();
  const exclude = (original: string, reason: string, placement: "head" | "body") => {
    if (!res.excluded.some((x) => x.original === original)) res.excluded.push({ original, reason, placement });
  };

  let stubWritten = false;
  const stub = async (list: ScriptEntry[], placement: "head" | "body") => {
    if (!opts.rich || list.some((e) => e.role === "tracker-stub")) return;
    if (!stubWritten) await write("scripts/tracker-stub.js", TRACKER_STUB);
    stubWritten = true;
    list.push({ src: "scripts/tracker-stub.js", placement, original: "(excluded tracker loaders)", role: "tracker-stub" });
  };
  for (const page of opts.pages) {
    const head = dom.select("head", page.tree);
    const headScripts = new Set(head ? dom.selectAll("script", head) : []);
    const list: ScriptEntry[] = [];
    const inNoscript = new Set(dom.selectAll("noscript *", page.tree));
    for (const s of dom.selectAll("script", page.tree).filter((x) => !inNoscript.has(x))) {
      const placement = headScripts.has(s) ? "head" : "body";
      const type = dom.attr(s, "type");
      const src = dom.attr(s, "src");
      const body = s.children.map((c) => (c.type === "text" ? c.value : "")).join("");
      if (type === "application/json" && dom.attr(s, "dataDrupalSelector") === "drupal-settings-json") {
        const h = sha(body, 16);
        let rel = settingsNames.get(h);
        if (!rel) {
          rel = `drupal/settings-${posix.basename(safe(page.path))}.json`;
          if ([...settingsNames.values()].includes(rel)) rel = `drupal/settings-${posix.basename(safe(page.path))}-${h.slice(0, 6)}.json`;
          let pretty = body;
          try {
            pretty = JSON.stringify(JSON.parse(body), null, 1);
          } catch {
            res.issues.push({ severity: "warning", code: "DRUPAL_SETTINGS_INVALID", message: `drupalSettings on ${page.path} is not valid JSON`, ref: page.path });
          }
          await write(rel, pretty);
          settingsNames.set(h, rel);
        }
        res.pageSettings[page.path] = rel;
        list.push({ src: rel, placement, original: "drupal-settings-json", role: "settings", type: "application/json", attrs: { "data-drupal-selector": "drupal-settings-json" } });
        continue;
      }
      if (type && !/^(text|application)\/(javascript|ecmascript)$|^module$/i.test(type)) continue; // data blocks (JSON, templates) stay in the markup
      if (!src) {
        if (!body.trim()) continue;
        if (TRACKER_INLINE.test(body)) {
          exclude(`inline:${sha(body)}`, "tracker loader (inline)", placement);
          await stub(list, placement);
          continue;
        }
        // legacy: inline scripts stay with the page settings — except loader configuration (`window.LOADER_PATH = '…'`)
        // that the ported same-origin scripts read when they run (AEM clientlib loaders, webpack public paths)
        // static-rendered sites (opts.inline: web components, JS apps) run their own scripts against the server HTML and
        // need every inline bootstrap (state, nav JSON) like a rich Drupal theme does
        if (!opts.rich && !opts.inline && !isConfigAssignment(body)) continue;
        const key = `inline:${sha(body, 16)}`;
        let e = ported.get(key);
        if (!e) {
          const rel = `scripts/inline-${sha(body)}.js`;
          await write(rel, body);
          e = { src: rel, placement, original: "inline", role: "inline" };
          ported.set(key, e);
          // non-rich manifests list res.scripts (document order): the config must run before the loader that reads it
          if (!opts.rich) res.scripts.push({ src: rel, placement, original: "inline", role: "inline" });
        }
        list.push({ ...e, placement, ...(/dataLayer/.test(body) && opts.rich ? { role: "datalayer" as const } : {}) });
        continue;
      }
      const abs = loader.abs(src.replace(/&amp;/g, "&"));
      if (!abs) continue;
      // the crawler's list (tag managers, RUM beacons, ad/analytics hosts) as well: those are never loaded by a capture
      if (TRACKER.test(abs) || isTrackerUrl(abs)) {
        exclude(src, "tracker/analytics loader (replaced by scripts/tracker-stub.js)", placement);
        await stub(list, placement);
        continue;
      }
      let e = ported.get(abs);
      if (!e) {
        const same = loader.sameOrigin(abs);
        const a = same ? await loader.load(abs) : opts.rich && loader.extUrl(abs) ? await loader.load(loader.extUrl(abs)!) : undefined;
        if (!a) {
          if (same) res.issues.push({ severity: "warning", code: "SCRIPT_NOT_DOWNLOADED", message: `script ${new URL(abs).pathname} could not be loaded`, ref: new URL(abs).pathname, actionable: opts.rich });
          if (!same && opts.rich) {
            e = { src: abs, placement, original: src, role: "vendor" };
            ported.set(abs, e);
            list.push(e);
          } else if (!same && opts.inline) {
            // static-rendered sites (web components, JS apps) run the original page against its own vendor scripts:
            // the site's CDN bundles and its consent bootstrap (ibm.com: 1.www.s81c.com/common/stats/ibm-common.js
            // loads TrustArc, which fills the footer's "Cookie Preferences" slot and shows the consent notice).
            // Referenced remotely as on the original, with the original async/defer; trackers were excluded above.
            const vattrs = scriptAttrs(s.properties);
            const consent = /cookie|consent|stats\/ibm-common/i.test(abs);
            e = { src: abs, placement, original: src, role: consent ? "consent" : "vendor", ...(/^module$/i.test(type ?? "") ? { type: "module" } : {}), ...(Object.keys(vattrs).length ? { attrs: vattrs } : {}) };
            ported.set(abs, e);
            list.push(e);
            if (!opts.rich && !res.scripts.some((x) => x.src === abs)) res.scripts.push({ src: abs, placement, original: src, role: e.role, ...(e.type ? { type: e.type } : {}), ...(e.attrs ? { attrs: e.attrs } : {}) });
          }
          continue;
        }
        const path = a.path.replace(/^\/__ext\/[^/]+/, "");
        const { rel, fresh } = names.name(posix.basename(a.path), a.body);
        if (fresh) await write(rel, opts.dryRun ? "" : a.body.toString("utf8"));
        const attrs = scriptAttrs(s.properties);
        // ES modules (`import …`) only run as <script type="module"> (web-component design systems, Vite bundles)
        const module = /^module$/i.test(type ?? "");
        e = { src: rel, placement, original: src, role: opts.rich ? roleOf(path) : /cookie|consent/i.test(path) ? "consent" : "theme", ...(module ? { type: "module" } : {}), ...(Object.keys(attrs).length ? { attrs } : {}) };
        ported.set(abs, e);
        if (!res.scripts.some((x) => x.src === rel) && same) res.scripts.push({ src: rel, placement, original: src, ...(e.role === "consent" ? { role: "consent" } : opts.rich ? { role: e.role } : {}), ...(module ? { type: "module" } : {}), ...(e.attrs ? { attrs: e.attrs } : {}) });
      }
      list.push(e.placement === placement ? e : { ...e, placement });
    }
    res.pageScripts[page.path] = list;
  }
  return res;
}

const safe = (p: string) => (p === "/" ? "home" : p.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9._-]+/g, "_"));
