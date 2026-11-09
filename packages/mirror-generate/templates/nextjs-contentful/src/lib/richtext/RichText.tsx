/**
 * CCM rich-text AST → React. Contentful documents are converted to the same AST by the data layer
 * (contentful-normalize.ts → richTextFromContentful), so this is the only renderer.
 * Output mirrors plain Drupal text-format HTML (<p>, <h2>, <ul><li>, <strong>, <em>, <a>) so ported CSS applies 1:1.
 */
import { Fragment, type ReactNode } from "react";
import type { Mark, RichBlock, RichInline, RichTextDoc } from "../ccm-types";
import type { AssetView, EntryStub, EntryView } from "../data/types";
import { RawHtml } from "./RawHtml";

export interface RichTextHooks {
  /** embedded asset override (design component for media embeds); default: <img> */
  renderAsset?(asset: AssetView, caption?: string): ReactNode;
  /** embedded entry (component) renderer — registry-backed */
  renderEntry?(entry: EntryView): ReactNode;
}

const MARK_TAG: Record<Mark, string> = { bold: "strong", italic: "em", underline: "u", code: "code", superscript: "sup", subscript: "sub", strikethrough: "s" };
const MARK_ORDER: Mark[] = ["bold", "italic", "underline", "strikethrough", "code", "superscript", "subscript"];

function Inline({ n, hooks, k }: { n: RichInline; hooks: RichTextHooks; k: string }): ReactNode {
  switch (n.type) {
    case "text": {
      let node: ReactNode = n.value;
      const marks = [...(n.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(b) - MARK_ORDER.indexOf(a));
      for (const m of marks) {
        const Tag = MARK_TAG[m] as "strong";
        node = <Tag>{node}</Tag>;
      }
      if (n.abbr) node = <abbr title={n.abbr}>{node}</abbr>;
      return <Fragment key={k}>{node}</Fragment>;
    }
    case "break":
      return <br key={k} />;
    case "link":
      return (
        <a key={k} href={n.href ?? "#"} title={n.title}>
          {n.children.map((c, i) => Inline({ n: c, hooks, k: `${k}.${i}` }))}
        </a>
      );
    case "inlineEntry": {
      const e = n.entry as EntryView | EntryStub | undefined;
      if (e && e._kind === "entry" && hooks.renderEntry) return <Fragment key={k}>{hooks.renderEntry(e)}</Fragment>;
      if (e?.path) return <a key={k} href={e.path}>{e._kind === "entryStub" ? (e.title ?? e.path) : String(e.fields.title ?? e.path)}</a>;
      return null;
    }
  }
}

function inlines(children: RichInline[], hooks: RichTextHooks, k: string) {
  return children.map((c, i) => Inline({ n: c, hooks, k: `${k}.${i}` }));
}

function Block({ b, hooks, k }: { b: RichBlock; hooks: RichTextHooks; k: string }): ReactNode {
  switch (b.type) {
    case "paragraph":
      // implicit paragraph: the original markup had bare inline content (no <p>)
      if (b.implicit) return <Fragment key={k}>{inlines(b.children, hooks, k)}</Fragment>;
      return <p key={k}>{inlines(b.children, hooks, k)}</p>;
    case "heading": {
      const H = `h${b.level}` as "h2";
      return <H key={k}>{inlines(b.children, hooks, k)}</H>;
    }
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L key={k}>
          {b.children.map((li, i) => (
            <li key={`${k}.${i}`}>
              {/* tight list: a single paragraph renders inline (Drupal: <li>text</li>) */}
              {li.children.length === 1 && li.children[0].type === "paragraph"
                ? inlines(li.children[0].children, hooks, `${k}.${i}`)
                : li.children.map((c, j) => Block({ b: c, hooks, k: `${k}.${i}.${j}` }))}
            </li>
          ))}
        </L>
      );
    }
    case "blockquote":
      return <blockquote key={k}>{b.children.map((c, i) => Block({ b: c, hooks, k: `${k}.${i}` }))}</blockquote>;
    case "hr":
      return <hr key={k} />;
    case "embeddedAsset": {
      const a = b.asset as AssetView | null | undefined;
      if (!a) return null;
      if (hooks.renderAsset) return <Fragment key={k}>{hooks.renderAsset(a, b.caption)}</Fragment>;
      const img = <img src={a.url} alt={a.alt} width={a.width} height={a.height} loading="lazy" />;
      return b.caption ? (
        <figure key={k}>
          {img}
          <figcaption>{b.caption}</figcaption>
        </figure>
      ) : (
        <Fragment key={k}>{img}</Fragment>
      );
    }
    case "embeddedEntry": {
      const e = b.entry as EntryView | EntryStub | undefined;
      if (e && e._kind === "entry" && hooks.renderEntry) return <Fragment key={k}>{hooks.renderEntry(e)}</Fragment>;
      return null;
    }
    case "rawHtml":
      return <RawHtml key={k} html={b.html} />;
  }
}

export function RichText({ doc, hooks = {} }: { doc: RichTextDoc | null | undefined; hooks?: RichTextHooks }) {
  if (!doc?.children) return null;
  return <>{doc.children.map((b, i) => Block({ b, hooks, k: `b${i}` }))}</>;
}

export function richTextToPlainText(doc: RichTextDoc | null | undefined): string {
  if (!doc?.children) return "";
  const inl = (n: RichInline): string => (n.type === "text" ? n.value : n.type === "break" ? "\n" : n.type === "link" ? n.children.map(inl).join("") : "");
  const blk = (b: RichBlock): string => {
    switch (b.type) {
      case "paragraph":
      case "heading":
        return b.children.map(inl).join("");
      case "list":
        return b.children.map((li) => li.children.map(blk).join("\n")).join("\n");
      case "blockquote":
        return b.children.map(blk).join("\n");
      case "rawHtml":
        return b.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      default:
        return "";
    }
  };
  return doc.children.map(blk).filter(Boolean).join("\n\n");
}
