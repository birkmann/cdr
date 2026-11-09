// Resolves what the user typed into the source to crawl: follows redirects hop by hop and reads the page's languages.
// A site that blocks automated requests is reported, never worked around.
import { guardedFetch } from "@harness/mirror-core";

export interface MirrorSource {
  origin: string;
  path: string;
  locales: string[];
  redirectedFrom?: string;
}

export class SourceBlocked extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`${host} blocks automated requests (${reason}). Mirror mode does not get past such blocks.`);
    this.name = "SourceBlocked";
  }
}

const CRAWLER_UA = "cmp-crawler";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const MAX_HOPS = 5;
const REQUEST_TIMEOUT_MS = 10_000;

const cloudflare = (r: Response, text: string) =>
  (r.status === 403 || r.status === 503) &&
  (r.headers.has("cf-mitigated") || /Just a moment|__cf_chl/i.test(text));

/** A bot-management answer instead of the site itself. A CDN's plain 404/410 is a missing page, not a block. */
export function blockReason(r: Response, html: string): string | undefined {
  if (cloudflare(r, html)) return "Cloudflare challenge";
  const server = r.headers.get("server") ?? "";
  const vendor =
    r.headers.has("x-datadome") || /captcha-delivery\.com/i.test(html)
      ? "DataDome"
      : /px-captcha|perimeterx/i.test(html)
        ? "PerimeterX"
        : r.headers.has("x-iinfo") || /Incapsula incident|_Incapsula_Resource/i.test(html)
          ? "Imperva"
          : r.headers.has("x-amzn-waf-action")
            ? "AWS WAF"
            : r.headers.has("x-sucuri-id")
              ? "Sucuri"
              : /akamai/i.test(server) || /Reference&#32;#\d|Reference #\d+\.[0-9a-f]+/i.test(html)
                ? "Akamai"
                : undefined;
  if (r.status === 403 || r.status === 429) return `${vendor ? `${vendor}, ` : ""}HTTP ${r.status}`;
  const refused = r.status >= 400 && r.status !== 404 && r.status !== 410;
  const challenge = r.status === 200 && html.length < 20_000 && /captcha|challenge|access denied/i.test(html);
  if (vendor && (refused || challenge)) return `${vendor}, HTTP ${r.status}`;
  return undefined;
}

/** Page languages: the document's own first, then hreflang alternates. */
export function pageLocales(html: string): string[] {
  const own = /<html[^>]*lang=["']([^"']+)/i.exec(html)?.[1] ?? "en";
  const alternates = Array.from(html.matchAll(/hreflang=["']([^"']+)/gi), (m) => m[1]).filter(
    (l) => l !== "x-default",
  );
  return [...new Set([own, ...alternates])];
}

export async function resolveSource(input: string): Promise<MirrorSource> {
  let url = new URL(input);
  url.hash = "";
  const entered = url.href;
  const request = (target: URL, ua: string) =>
    guardedFetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": ua, "Accept-Language": ACCEPT_LANGUAGE },
    });
  let page: Response | undefined;
  for (let hops = 0; !page;) {
    const r = await request(url, "CDR-Mirror/1.0");
    if (r.status < 300 || r.status >= 400) {
      page = r;
      break;
    }
    const location = r.headers.get("location");
    await r.body?.cancel();
    if (!location) throw new Error(`The source answered HTTP ${r.status} without a redirect target`);
    if (++hops > MAX_HOPS) throw new Error(`The source redirects more than ${MAX_HOPS} times`);
    url = new URL(location, url);
    url.hash = "";
  }
  const html = (await page.text()).slice(0, 2_000_000);
  const blocked = blockReason(page, html);
  if (blocked) throw new SourceBlocked(url.hostname, blocked);
  if (!page.ok) throw new Error(`The source returned HTTP ${page.status}`);
  // some origins answer a person-facing probe but refuse the declared crawler; its identity is never changed
  const crawler = await request(url, CRAWLER_UA);
  const body = crawler.status >= 400 ? (await crawler.text()).slice(0, 200_000) : "";
  if (crawler.status < 400) await crawler.body?.cancel();
  const refused = blockReason(crawler, body);
  if (refused) throw new SourceBlocked(url.hostname, `crawler refused, ${refused}`);
  return {
    origin: url.origin,
    path: url.pathname || "/",
    locales: pageLocales(html),
    ...(url.href !== entered ? { redirectedFrom: entered } : {}),
  };
}
