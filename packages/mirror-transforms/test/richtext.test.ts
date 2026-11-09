import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RichTextDocSchema, type Reference, type RichBlock } from "@harness/mirror-core";
import { htmlToRichText, richTextToPlainText, inspectHtml } from "../src/index.js";

const seed = JSON.parse(readFileSync(fileURLToPath(new URL("../../mirror/test/fixtures/seed.json", import.meta.url)), "utf8"));

const nodeByAlias: Record<string, string> = { "/about-us": "drupal:node:2", "/news/healthy-breakfast": "drupal:node:3" };
const resolveLink = (href: string): Reference | undefined => {
  const m = /^(?:\/de)?\/node\/(\d+)$/.exec(href);
  if (m) return { kind: "entry", id: `drupal:node:${m[1]}` };
  return nodeByAlias[href] ? { kind: "entry", id: nodeByAlias[href] } : undefined;
};
const resolveAsset = (key: string, kind: "img" | "media"): Reference | undefined => {
  for (const f of seed.files) {
    if (kind === "media" && f.media_uuid === key) return { kind: "asset", id: `drupal:media:${f.mid}` };
    if (kind === "img" && f.url === key) return { kind: "asset", id: `drupal:media:${f.mid}` };
  }
  return undefined;
};
const opts = { resolveLink, resolveAsset, baseUrl: "http://localhost:4400" };

const conv = (html: string, o: Parameters<typeof htmlToRichText>[1] = opts) => {
  const r = htmlToRichText(html, o);
  RichTextDocSchema.parse(r.doc);
  return r;
};

describe("htmlToRichText — seed bodies", () => {
  it("paragraph 102 (en): heading, marks, internal /node link", () => {
    const html = seed.nodes[0].field_sections[1].fields.field_body.en;
    const { doc, stats, issues } = conv(html);
    expect(doc.children).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", value: "Why breakfast matters" }] },
      {
        type: "paragraph",
        children: [
          { type: "text", value: "A balanced breakfast gives you " },
          { type: "text", value: "energy", marks: ["bold"] },
          { type: "text", value: " and helps you " },
          { type: "text", value: "focus", marks: ["italic"] },
          { type: "text", value: ". Learn more " },
          { type: "link", ref: { kind: "entry", id: "drupal:node:2" }, children: [{ type: "text", value: "about us" }] },
          { type: "text", value: "." },
        ],
      },
    ]);
    expect(stats.rawHtml).toBe(0);
    expect(stats.resolvedLinks).toBe(1);
    expect(issues).toEqual([]);
  });

  it("paragraph 102 (de): /de/node/2 resolves too", () => {
    const { doc } = conv(seed.nodes[0].field_sections[1].fields.field_body.de);
    const p = doc.children[1] as Extract<RichBlock, { type: "paragraph" }>;
    expect(p.children.find((c) => c.type === "link")).toMatchObject({ ref: { id: "drupal:node:2" } });
  });

  it("node 2 body: list, drupal-media, table as rawHtml, internal + external links", () => {
    const { doc, stats, issues } = conv(seed.nodes[1].translations.en.body.value);
    const types = doc.children.map((b) => b.type);
    expect(types).toEqual(["paragraph", "heading", "list", "embeddedAsset", "heading", "rawHtml", "paragraph"]);
    expect(doc.children[2]).toEqual({
      type: "list",
      ordered: false,
      children: ["Fresh ingredients", "Simple recipes", "Balanced nutrition"].map((v) => ({
        type: "listItem",
        children: [{ type: "paragraph", children: [{ type: "text", value: v }] }],
      })),
    });
    expect(doc.children[3]).toEqual({ type: "embeddedAsset", ref: { kind: "asset", id: "drupal:media:22" } });
    const rawB = doc.children[5] as Extract<RichBlock, { type: "rawHtml" }>;
    expect(rawB.reason).toBe("table");
    expect(rawB.html).toContain("<table><thead><tr><th>Day</th>");
    const last = doc.children[6] as Extract<RichBlock, { type: "paragraph" }>;
    expect(last.children).toEqual([
      { type: "text", value: "Read our article on " },
      { type: "link", ref: { kind: "entry", id: "drupal:node:3" }, children: [{ type: "text", value: "healthy breakfast" }] },
      { type: "text", value: " or visit " },
      { type: "link", href: "https://www.acme.com", children: [{ type: "text", value: "acme.com" }] },
      { type: "text", value: "." },
    ]);
    expect(stats.rawHtml).toBe(1);
    expect(stats.rawHtmlShare).toBeGreaterThan(0);
    expect(stats.rawHtmlShare).toBeLessThan(1);
    expect(stats.assets).toBe(1);
    expect(issues.filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("node 3 body: ordered list + blockquote", () => {
    const { doc } = conv(seed.nodes[2].translations.de.body.value);
    expect(doc.children.map((b) => b.type)).toEqual(["paragraph", "list", "blockquote"]);
    expect((doc.children[1] as any).ordered).toBe(true);
    expect((doc.children[1] as any).children).toHaveLength(5);
    expect(doc.children[2]).toEqual({
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Das Frühstück ist die wichtigste Mahlzeit des Tages." }] }],
    });
  });

  it("node 4 body: <p><img></p> becomes a single embeddedAsset (no empty paragraph)", () => {
    const { doc } = conv(seed.nodes[3].translations.en.body.value);
    expect(doc.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "Fruit adds " },
          { type: "text", value: "vitamins", marks: ["bold"] },
          { type: "text", value: " and fibre." },
        ],
      },
      { type: "embeddedAsset", ref: { kind: "asset", id: "drupal:media:23" } },
    ]);
  });

  it("all seed rich text converts to valid docs and round-trips its text", () => {
    const htmls: string[] = [];
    for (const n of seed.nodes) {
      for (const t of Object.values<any>(n.translations)) if (t.body) htmls.push(t.body.value);
      for (const p of n.field_sections ?? []) if (p.fields.field_body) htmls.push(p.fields.field_body.en, p.fields.field_body.de);
    }
    expect(htmls.length).toBe(8);
    for (const h of htmls) {
      const { doc } = conv(h);
      const plain = richTextToPlainText(doc).replace(/\s+/g, " ");
      const expected = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      for (const word of expected.split(" ").filter((w: string) => w.length > 3)) expect(plain).toContain(word.replace(/[.,]$/, ""));
    }
  });
});

describe("htmlToRichText — whitespace (browser rules)", () => {
  it("collapses runs and drops leading/trailing spaces of blocks", () => {
    const { doc } = conv("<p>\n   Hello\t\t  <b> big </b>  world \n</p>");
    expect(doc.children[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", value: "Hello " },
        { type: "text", value: "big ", marks: ["bold"] },
        { type: "text", value: "world" },
      ],
    });
  });

  it("removes spaces around <br> and a trailing <br>", () => {
    const { doc } = conv("<p>line one <br>  line two<br></p>");
    expect(doc.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "line one" }, { type: "break" }, { type: "text", value: "line two" }],
    });
  });

  it("keeps NBSP, drops empty and whitespace-only paragraphs, ignores inter-block whitespace", () => {
    const { doc } = conv("\n  <p>a&nbsp;&nbsp;b</p>\n\n  <p>   </p><p></p>\n<h3> x </h3>  ");
    expect(doc.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "a\u00a0\u00a0b" }] },
      { type: "heading", level: 3, children: [{ type: "text", value: "x" }] },
    ]);
  });

  it("collapses across element boundaries", () => {
    const { doc } = conv("<p>a <em> b</em> <a href='https://x.org'> c </a> d</p>");
    expect(doc.children[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", value: "a " },
        { type: "text", value: "b", marks: ["italic"] },
        { type: "text", value: " " },
        { type: "link", href: "https://x.org", children: [{ type: "text", value: "c " }] },
        { type: "text", value: "d" },
      ],
    });
  });

  it("preserves whitespace in <pre> as code + breaks", () => {
    const { doc } = conv("<pre>a  b\n  c</pre>");
    expect(doc.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "a  b", marks: ["code"] }, { type: "break" }, { type: "text", value: "  c", marks: ["code"] }],
    });
  });

  it("wraps bare text and inline content at top level into paragraphs", () => {
    const { doc } = conv("Hello <b>you</b><p>next</p>tail");
    expect(doc.children.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });
});

describe("htmlToRichText — marks, links, structure", () => {
  it("maps all marks and nests them in canonical order", () => {
    const { doc } = conv("<p><em><strong>x</strong></em><u>u</u><code>c</code><sup>1</sup><sub>2</sub><s>s</s><del>d</del><b><b>bb</b></b></p>");
    const p = doc.children[0] as Extract<RichBlock, { type: "paragraph" }>;
    expect(p.children).toEqual([
      { type: "text", value: "x", marks: ["bold", "italic"] },
      { type: "text", value: "u", marks: ["underline"] },
      { type: "text", value: "c", marks: ["code"] },
      { type: "text", value: "1", marks: ["superscript"] },
      { type: "text", value: "2", marks: ["subscript"] },
      { type: "text", value: "sd", marks: ["strikethrough"] },
      { type: "text", value: "bb", marks: ["bold"] },
    ]);
  });

  it("nested lists and hr", () => {
    const { doc } = conv("<ul><li>one<ul><li>sub</li></ul></li><li><p>two</p></li></ul><hr>");
    expect(doc.children[0]).toEqual({
      type: "list",
      ordered: false,
      children: [
        {
          type: "listItem",
          children: [
            { type: "paragraph", children: [{ type: "text", value: "one" }] },
            { type: "list", ordered: false, children: [{ type: "listItem", children: [{ type: "paragraph", children: [{ type: "text", value: "sub" }] }] }] },
          ],
        },
        { type: "listItem", children: [{ type: "paragraph", children: [{ type: "text", value: "two" }] }] },
      ],
    });
    expect(doc.children[1]).toEqual({ type: "hr" });
  });

  it("same-origin absolute links are resolved as paths, unresolved internal links warn", () => {
    const { doc, issues } = conv('<p><a href="http://localhost:4400/about-us" title="T">x</a> <a href="/missing">y</a> <a href="mailto:a@b.c">m</a></p>');
    const p = doc.children[0] as Extract<RichBlock, { type: "paragraph" }>;
    expect(p.children[0]).toEqual({ type: "link", ref: { kind: "entry", id: "drupal:node:2" }, title: "T", children: [{ type: "text", value: "x" }] });
    expect(p.children[2]).toMatchObject({ type: "link", href: "/missing" });
    expect(p.children[4]).toMatchObject({ type: "link", href: "mailto:a@b.c" });
    expect(issues.map((i) => i.code)).toEqual(["UNRESOLVED_INTERNAL_LINK"]);
  });

  it("without resolvers links stay hrefs and images become rawHtml with a warning", () => {
    const { doc, issues } = conv('<p><a href="/node/2">a</a></p><img src="/x.jpg">', {});
    expect((doc.children[0] as any).children[0]).toEqual({ type: "link", href: "/node/2", children: [{ type: "text", value: "a" }] });
    expect(doc.children[1]).toMatchObject({ type: "rawHtml", reason: "unresolved image" });
    expect(issues.some((i) => i.code === "UNRESOLVED_IMAGE")).toBe(true);
  });

  it("figure with figcaption becomes embeddedAsset with caption", () => {
    const { doc } = conv('<figure><img src="/sites/default/files/2024-05/oats.jpg" alt=""><figcaption> Rolled  oats </figcaption></figure>');
    expect(doc.children).toEqual([{ type: "embeddedAsset", ref: { kind: "asset", id: "drupal:media:22" }, caption: "Rolled oats" }]);
  });

  it("drupal-media with data-caption", () => {
    const { doc } = conv('<drupal-media data-entity-type="media" data-entity-uuid="m0000000-0000-4000-8000-000000000021" data-caption="Hero"></drupal-media>');
    expect(doc.children).toEqual([{ type: "embeddedAsset", ref: { kind: "asset", id: "drupal:media:21" }, caption: "Hero" }]);
  });

  it("iframes, scripts, tables and unknown elements become rawHtml with reasons; inline iframe splits the paragraph", () => {
    const { doc, stats } = conv('<p>before <iframe src="https://youtube.com/embed/x"></iframe> after</p><script>alert(1)</script><my-widget a="1">w</my-widget><table><tr><td>1</td></tr></table>');
    expect(doc.children.map((b) => (b.type === "rawHtml" ? `raw:${b.reason}` : b.type))).toEqual([
      "paragraph",
      "raw:iframe",
      "paragraph",
      "raw:script",
      "raw:unknown element <my-widget>",
      "raw:table",
    ]);
    expect((doc.children[0] as any).children).toEqual([{ type: "text", value: "before" }]);
    expect((doc.children[2] as any).children).toEqual([{ type: "text", value: "after" }]);
    expect(stats.rawHtml).toBe(4);
  });

  it("image inside a link splits the link around the asset, keeping order", () => {
    const { doc } = conv('<p><a href="https://x.org">pre <img src="/sites/default/files/2024-05/fruit.jpg"> post</a></p>');
    expect(doc.children).toEqual([
      { type: "paragraph", children: [{ type: "link", href: "https://x.org", children: [{ type: "text", value: "pre" }] }] },
      { type: "embeddedAsset", ref: { kind: "asset", id: "drupal:media:23" } },
      { type: "paragraph", children: [{ type: "link", href: "https://x.org", children: [{ type: "text", value: "post" }] }] },
    ]);
  });

  it("div/section wrappers are transparent, spans with style are dropped with an info issue", () => {
    const { doc, issues } = conv('<div class="x"><section><p><span style="color:red">red</span></p></section></div>');
    expect(doc.children).toEqual([{ type: "paragraph", children: [{ type: "text", value: "red" }] }]);
    expect(issues.map((i) => i.code)).toEqual(["INLINE_STYLE_DROPPED"]);
  });

  it("empty input gives empty doc", () => {
    expect(conv("").doc).toEqual({ type: "doc", children: [] });
    expect(conv("").stats.rawHtmlShare).toBe(0);
  });
});

describe("richTextToPlainText / inspectHtml", () => {
  it("renders plain text including table text", () => {
    const { doc } = conv(seed.nodes[1].translations.en.body.value);
    const t = richTextToPlainText(doc);
    expect(t.startsWith("We are a small team of food lovers.\n\nOur values\n\nFresh ingredients\nSimple recipes")).toBe(true);
    expect(t).toContain("Mon–Fri");
    expect(t).toContain("acme.com");
  });

  it("inspects html quality", () => {
    const q = inspectHtml('<p style="x">a</p><script></script><iframe></iframe><table></table><drupal-media></drupal-media><x-foo></x-foo><img src="a">');
    expect(q).toMatchObject({ inlineStyles: 1, scripts: 1, iframes: 1, tables: 1, drupalMedia: 1, images: 1, unknownElements: ["x-foo"] });
  });
});
