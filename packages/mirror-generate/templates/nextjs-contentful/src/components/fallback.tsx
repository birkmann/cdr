/**
 * Plain semantic renderers used when no design component/template exists for a content type
 * (template build without design/, or new content types added after generation).
 */
import { Fragment, type ReactNode } from "react";
import type { RichTextDoc } from "../lib/ccm-types";
import type { AssetView, CollectionView, EntryView, LinkView, TermView } from "../lib/data/types";
import { RichText } from "../lib/richtext/RichText";
import type { NavItemState, RenderCtx } from "../lib/render/runtime";
import { formatDate } from "../lib/render/runtime";

const SKIP = new Set(["title", "name", "slug"]);

function Value({ v, ctx }: { v: unknown; ctx: RenderCtx }): ReactNode {
  if (v == null || v === "") return null;
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T/.test(v) ? <time dateTime={v}>{formatDate(v, ctx.locale)}</time> : <p>{v}</p>;
  if (typeof v === "number" || typeof v === "boolean") return <p>{String(v)}</p>;
  if (Array.isArray(v)) return v.map((x, i) => <Value key={i} v={x} ctx={ctx} />);
  const o = v as { _kind?: string; type?: string };
  if (o.type === "doc") return <RichText doc={v as RichTextDoc} hooks={{ renderEntry: (e) => ctx.renderEntry(e), renderAsset: ctx.renderAsset }} />;
  switch (o._kind) {
    case "asset": {
      const a = v as AssetView;
      return a.mime.startsWith("image/") ? <img src={a.url} alt={a.alt} width={a.width} height={a.height} /> : <a href={a.url}>{a.title || a.fileName}</a>;
    }
    case "link": {
      const l = v as LinkView;
      return <a href={l.href}>{l.label || l.href}</a>;
    }
    case "term": {
      const t = v as TermView;
      return t.path ? <a href={t.path}>{t.name}</a> : <span>{t.name}</span>;
    }
    case "entry":
      return ctx.renderEntry(v as EntryView);
    case "collection":
      return <Teasers items={(v as CollectionView).items} ctx={ctx} />;
  }
  return null;
}

function Teasers({ items, ctx }: { items: EntryView[]; ctx: RenderCtx }) {
  return (
    <ul className="cmp-teasers">
      {items.map((e) => (
        <li key={e.ccmId} className={`cmp-teaser cmp-teaser--${e.type}`}>
          {e.path ? <a href={e.path}>{String(e.fields.title ?? e.path)}</a> : String(e.fields.title ?? "")}
        </li>
      ))}
    </ul>
  );
}

function Entry({ entry, ctx }: { entry: EntryView; ctx: RenderCtx }) {
  return (
    <section className={`cmp-component cmp-component--${entry.type}`}>
      {Object.entries(entry.fields).map(([k, v]) =>
        k === "title" || k === "heading" ? (
          <h2 key={k}>{String(v)}</h2>
        ) : (
          <Fragment key={k}>
            <Value v={v} ctx={ctx} />
          </Fragment>
        ),
      )}
    </section>
  );
}

function Nav({ items, label }: { items: NavItemState[]; label: string }) {
  if (!items.length) return null;
  const ul = (xs: NavItemState[]) => (
    <ul>
      {xs.map((i) => (
        <li key={i.id} className={i.activeTrail ? "is-active-trail" : undefined}>
          <a href={i.href} aria-current={i.active ? "page" : undefined}>
            {i.label}
          </a>
          {i.children.length ? ul(i.children) : null}
        </li>
      ))}
    </ul>
  );
  return <nav aria-label={label}>{ul(items)}</nav>;
}

function Page({ entry, ctx }: { entry: EntryView; ctx: RenderCtx }) {
  const c = ctx.chrome;
  const title = String(entry.fields.title ?? entry.fields.name ?? "");
  return (
    <>
      <header className="cmp-header">
        <a href={c.homeHref} rel="home">
          {c.logo ? <img src={c.logo.url} alt={c.logo.alt} width={c.logo.width} height={c.logo.height} /> : null}
          {c.siteName}
        </a>
        {c.slogan ? <p>{c.slogan}</p> : null}
        <Nav items={c.nav.main ?? []} label="Main navigation" />
        <ul className="cmp-languages">
          {c.languages.map((l) => (
            <li key={l.code}>
              <a href={l.href} hrefLang={l.code} aria-current={l.active ? "page" : undefined}>
                {l.name}
              </a>
            </li>
          ))}
        </ul>
      </header>
      <main>
        <h1>{title}</h1>
        {Object.entries(entry.fields)
          .filter(([k]) => !SKIP.has(k))
          .map(([k, v]) => (
            <Fragment key={k}>{k === "items" && Array.isArray(v) ? <Teasers items={v as EntryView[]} ctx={ctx} /> : <Value v={v} ctx={ctx} />}</Fragment>
          ))}
      </main>
      <footer className="cmp-footer">
        <Nav items={c.nav.footer ?? []} label="Footer" />
        {c.footerText ? <p>{c.footerText}</p> : null}
      </footer>
    </>
  );
}

export const Fallback = { Page, Entry, Value, Teasers };
