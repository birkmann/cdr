/**
 * Catch-all route: every live URL path is preserved exactly (default locale without prefix, others with `/de/...`).
 * Paths come from the data source (listPaths): CCM entry paths + taxonomy term pages + collection listing pages.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getData } from "../../lib/data";
import { buildChrome, makeCtx, PageBody } from "../../lib/render/page";
import { pathFromSlug, rehost, resolveRoute, seoContext, slugFromPath, type SlugParams } from "../../lib/route";
import { JsonLd } from "../../components/JsonLd";
import { isStaticMode } from "../../lib/render/static";

export const dynamicParams = true;

export async function generateStaticParams(): Promise<SlugParams[]> {
  const data = await getData(false);
  return (await data.listPaths()).map((p) => ({ slug: slugFromPath(p.path) }));
}

export async function generateMetadata({ params }: { params: Promise<SlugParams> }): Promise<Metadata> {
  const path = pathFromSlug((await params).slug);
  const { data, entry, locale } = await resolveRoute(path);
  if (!entry || isStaticMode()) return {}; // static mode: the layout renders the original head (title, meta, links)
  const { origin, olds, meta, title, canonicalLink: canonical } = await seoContext(data, entry, path, locale);
  const alternates = meta.hreflang?.length
    ? meta.hreflang.map((h) => ({ locale: h.locale, href: rehost(h.href, origin, olds) }))
    : (await data.getAlternates(entry.ccmId)).map((a) => ({ locale: a.locale, href: origin + a.path }));
  // other named meta tags of the original (keywords, news_keywords, abstract, site verification): `keywords` has its
  // own Metadata key, the rest go through `other` (both render as <meta name="…" content="…">)
  const { keywords, ...otherMeta } = meta.meta ?? {};
  return {
    title: { absolute: title },
    description: meta.description,
    robots: meta.robots,
    ...(keywords ? { keywords } : {}),
    ...(Object.keys(otherMeta).length ? { other: otherMeta } : {}),
    alternates: {
      canonical,
      languages: Object.fromEntries(alternates.map((a) => [a.locale, a.href])),
    },
  };
}

export default async function Page({ params }: { params: Promise<SlugParams> }) {
  const path = pathFromSlug((await params).slug);
  const { data, entry, locale } = await resolveRoute(path);
  if (!entry) notFound();
  if (isStaticMode()) return null; // rendered by the root layout as a static island (lib/render/static.ts)
  const chrome = await buildChrome(data, entry, locale, path);
  const ctx = makeCtx(chrome);
  return (
    <>
      <PageBody entry={entry} ctx={ctx} />
      <JsonLd data={entry.meta?.structuredData} />
    </>
  );
}
