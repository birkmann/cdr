/** A small but complete, valid CCM bundle used by the validator tests. */
import type { Workspace } from "../workspace.js";
import { Workspace as WS } from "../workspace.js";

const src = (kind: string, id: string) => ({ system: "drupal", kind, id });

export const sampleSchema = {
  contentTypes: [
    {
      id: "page",
      name: "Page",
      kind: "document",
      displayField: "title",
      fields: [
        { id: "title", name: "Title", type: "text", required: true, localized: true },
        { id: "body", name: "Body", type: "richText", localized: true },
        { id: "image", name: "Image", type: "reference", allowedTypes: ["asset"] },
        { id: "tags", name: "Tags", type: "reference", cardinality: -1, allowedTypes: ["term:tags"] },
        { id: "sections", name: "Sections", type: "componentList", cardinality: -1, allowedTypes: ["sectionHero"] },
        { id: "cta", name: "CTA", type: "link" },
        { id: "published", name: "Published", type: "date" },
      ],
    },
    {
      id: "sectionHero",
      name: "Hero",
      kind: "component",
      fields: [
        { id: "title", name: "Title", type: "text", required: true, localized: true },
        { id: "style", name: "Style", type: "enum", options: ["light", "dark"] },
      ],
    },
  ],
};

export const sampleEntries = [
  {
    ccmId: "drupal:node:1",
    type: "page",
    locale: "en",
    path: "/",
    slug: "",
    fields: {
      title: "Home",
      body: {
        type: "doc",
        children: [
          { type: "paragraph", children: [{ type: "text", value: "Hi " }, { type: "link", ref: { kind: "entry", id: "drupal:node:2" }, children: [{ type: "text", value: "about" }] }] },
          { type: "embeddedAsset", ref: { kind: "asset", id: "drupal:media:21" } },
        ],
      },
      image: { kind: "asset", id: "drupal:media:21" },
      tags: [{ kind: "term", id: "drupal:taxonomy_term:1" }],
      sections: [{ kind: "entry", id: "drupal:paragraph:5" }],
      cta: { href: "https://example.com", label: "Go" },
      published: "2024-06-01T10:00:00+00:00",
    },
    source: src("node", "1"),
  },
  { ccmId: "drupal:node:1", type: "page", locale: "de", path: "/de", slug: "", fields: { title: "Start", sections: [{ kind: "entry", id: "drupal:paragraph:5" }] }, source: src("node", "1") },
  { ccmId: "drupal:node:2", type: "page", locale: "en", path: "/about-us", slug: "about-us", fields: { title: "About" }, source: src("node", "2") },
  { ccmId: "drupal:paragraph:5", type: "sectionHero", locale: "en", fields: { title: "Hero", style: "dark" }, source: src("paragraph", "5") },
  { ccmId: "drupal:paragraph:5", type: "sectionHero", locale: "de", fields: { title: "Held" }, source: src("paragraph", "5") },
];

export async function writeSampleCcm(ws: Workspace, mutate?: (d: { schema: typeof sampleSchema; entries: any[]; extra: Record<string, unknown> }) => void): Promise<void> {
  const d = { schema: structuredClone(sampleSchema), entries: structuredClone(sampleEntries) as any[], extra: {} as Record<string, unknown> };
  mutate?.(d);
  await ws.writeJson(WS.SCHEMA_PATH, d.schema);
  for (const e of d.entries) await ws.writeJson(ws.entryPath(e.type, e.ccmId, e.locale), e);
  await ws.writeJson(ws.assetPath("drupal:media:21"), {
    ccmId: "drupal:media:21",
    src: "raw/files/hero.jpg",
    originalPath: "/sites/default/files/2024-05/hero-breakfast.jpg",
    fileName: "hero-breakfast.jpg",
    mime: "image/jpeg",
    alt: { en: "Cereal", de: "Müsli" },
    source: src("media", "21"),
  });
  await ws.writeJson(ws.taxonomyPath("tags"), {
    id: "tags",
    name: "Tags",
    terms: [{ ccmId: "drupal:taxonomy_term:1", name: { en: "Breakfast", de: "Frühstück" }, source: src("taxonomy_term", "1") }],
  });
  await ws.writeJson(ws.navigationPath("main"), {
    id: "main",
    name: "Main",
    items: [{ id: "m1", label: { en: "About" }, ref: { kind: "entry", id: "drupal:node:2" }, children: [{ id: "m2", label: { en: "Ext" }, href: "https://x.test", children: [] }] }],
  });
  await ws.writeJson(WS.REDIRECTS_PATH, [{ from: "/node/2", to: "/about-us", status: 301 }]);
  await ws.writeJson(WS.LOCALES_PATH, [
    { code: "en", name: "English", default: true, pathPrefix: "" },
    { code: "de", name: "Deutsch", fallback: "en", pathPrefix: "de" },
  ]);
  await ws.writeJson(ws.collectionPath("articles--block_latest"), { id: "articles--block_latest", name: "Latest", type: "page", sort: [{ field: "published", direction: "desc" }], limit: 3 });
  await ws.writeJson(WS.SETTINGS_PATH, { siteName: { en: "Demo" }, baseUrl: "http://localhost:4400", logo: { kind: "asset", id: "drupal:media:21" } });
  for (const [rel, data] of Object.entries(d.extra)) await ws.writeJson(rel, data);
}
