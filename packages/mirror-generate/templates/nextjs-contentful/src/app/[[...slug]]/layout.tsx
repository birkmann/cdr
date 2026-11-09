/**
 * Root layout (lives in the catch-all segment so <html lang> and <body class> follow the page's locale/content type).
 * Ports the original site's <head>: design stylesheets (public/_design), favicon, site scripts (cookie consent, analytics).
 * Design renderMode "static" (Drupal JS sites): the whole document is rendered by lib/render/static.ts instead.
 */
import type { ReactNode } from "react";
import design from "../../generated/design.json";
import { bodyClassFor, buildChrome } from "../../lib/render/page";
import { domProps, isStaticMode, staticDocument } from "../../lib/render/static";
import { pathFromSlug, resolveRoute, seoContext, type SlugParams } from "../../lib/route";
import { socialTags } from "../../lib/seo";
import type { SiteScript } from "../../lib/ccm-types";
import { NavInteractions, type ViewportInteractions } from "../../components/NavInteractions";
import { PLAYER_FALLBACK_JS } from "../../lib/render/player-fallback";

type PageAttrs = { html: Record<string, string>; body: Record<string, string> };
type DesignJson = {
  stylesheets: string[];
  scripts: { src: string; placement: "head" | "body"; type?: string }[];
  icon?: string;
  htmlAttrs?: Record<string, string>;
  /** crawled <html>/<body> attributes per path (react mode): site CSS keys layout on them */
  pageAttrs?: Record<string, PageAttrs>;
  /** header/nav toggles recorded by the crawl per path and viewport (react mode): replayed by NavInteractions */
  interactions?: Record<string, ViewportInteractions>;
};

/** attributes every crawled page shares: the fallback for pages that were not crawled */
function commonAttrs(all: PageAttrs[], key: keyof PageAttrs): Record<string, string> {
  if (!all.length) return {};
  return Object.fromEntries(Object.entries(all[0]![key]).filter(([k, v]) => all.every((a) => a[key][k] === v)));
}

function scriptKey(src: string): string {
  try {
    return new URL(src, "http://x").pathname.split("/").pop() ?? src;
  } catch {
    return src;
  }
}

function Scripts({ list }: { list: SiteScript[] }) {
  return (
    <>
      {list.map((s) =>
        s.src ? (
          // async scripts are hoisted/deduped by React; plain ones stay in place (original order)
          /^https?:\/\//.test(s.src) ? <script key={s.id} async src={s.src} type={s.type} /> : <script key={s.id} src={s.src} type={s.type} />
        ) : s.inline ? (
          <script key={s.id} id={s.id} dangerouslySetInnerHTML={{ __html: s.inline }} />
        ) : null,
      )}
    </>
  );
}

/**
 * Next renders its metadata outlet (`<div hidden>` + Suspense, app-router <Head>) before the root layout; React
 * hydrates document-level elements from body.firstChild, so that element must come first in the static body —
 * exactly where Next puts it in react mode. Hidden, no layout effect.
 */
const NEXT_HEAD_SLOT = '<div hidden=""><!--$--><!--/$--></div>';

export default async function RootLayout({ children, params }: { children: ReactNode; params: Promise<SlugParams> }) {
  const { slug } = await params;
  const path = pathFromSlug(slug);
  const { data, entry, locale } = await resolveRoute(path);
  if (isStaticMode() && entry) {
    // static islands (lib/render/static.ts): head + body markup as HTML strings — React hydrates only the three
    // document elements, the original scripts run against untouched server markup. `children` (the page segment and
    // Next's metadata outlet) is intentionally not rendered: the page component has nothing to add in this mode.
    const chrome = await buildChrome(data, entry, locale, path);
    const doc = await staticDocument(data, entry, path, locale, chrome);
    return (
      <html {...domProps(doc.htmlAttrs)} suppressHydrationWarning>
        {/* Captured head is opaque HTML; site scripts and extensions (e.g. Dark Reader) may mutate it before hydration. */}
        <head suppressHydrationWarning dangerouslySetInnerHTML={{ __html: doc.head }} />
        <body {...domProps(doc.bodyAttrs)} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: NEXT_HEAD_SLOT + doc.body }} />
      </html>
    );
  }
  const d = design as unknown as DesignJson;
  const settings = await data.getSettings(locale);
  // design manifest scripts first (theme JS), then SiteSettings scripts not already covered (consent/analytics)
  const seen = new Set<string>();
  const all: SiteScript[] = [];
  for (const s of d.scripts) {
    seen.add(scriptKey(s.src));
    all.push({ id: `design-${all.length}`, src: s.src, placement: s.placement, ...(s.type ? { type: s.type } : {}) });
  }
  for (const s of settings.scripts) if (!s.src || !seen.has(scriptKey(s.src))) all.push(s);
  const isFront = path === (data.prefixOf(locale) || "/");
  const bodyClass = entry ? bodyClassFor(entry, isFront) : undefined;
  let social: ReturnType<typeof socialTags> = [];
  if (entry) {
    const sc = await seoContext(data, entry, path, locale);
    social = socialTags(entry, { ...sc, description: sc.meta.description, og: sc.meta.og, twitter: sc.meta.twitter });
  }
  const crawled = Object.values(d.pageAttrs ?? {});
  const page = d.pageAttrs?.[path] ?? { html: commonAttrs(crawled, "html"), body: commonAttrs(crawled, "body") };
  const { class: crawledBodyClass, ...bodyAttrs } = page.body;
  return (
    <html lang={locale} dir="ltr" {...(d.htmlAttrs ?? {})} {...domProps(page.html)}>
      <head>
        {social.map((t) => (t.attr === "property" ? <meta key={t.key} property={t.key} content={t.content} /> : <meta key={t.key} name={t.key} content={t.content} />))}
        {d.icon ? <link rel="icon" href={d.icon} /> : null}
        {d.stylesheets.map((href) => (
          <link key={href} rel="stylesheet" media="all" href={href} />
        ))}
        <Scripts list={all.filter((s) => s.placement === "head")} />
      </head>
      <body {...domProps(bodyAttrs)} className={[bodyClass, crawledBodyClass].filter(Boolean).join(" ") || undefined}>
        {children}
        <NavInteractions sets={d.interactions?.[path]} />
        <Scripts list={all.filter((s) => s.placement !== "head")} />
        <script data-cmp="player-fallback" dangerouslySetInnerHTML={{ __html: PLAYER_FALLBACK_JS }} />
      </body>
    </html>
  );
}
