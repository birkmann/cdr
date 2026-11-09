/** Applies the generated SEO tag rules (src/generated/seo.json — ported Drupal metatag defaults) to an entry. */
import seo from "../generated/seo.json";
import type { AssetView, EntryView, SettingsView } from "./data/types";

type Rule =
  | { from: "title" | "description" | "canonical" | "siteName" | "image" }
  | { perLocale: Record<string, string> }
  | { perType: Record<string, string> }
  | { const: string };
const SEO = seo as { rules: Record<string, Rule>; order: string[] };

function isAsset(v: unknown): v is AssetView {
  return !!v && typeof v === "object" && (v as AssetView)._kind === "asset";
}

/** first asset of the entry's own fields, else of its referenced components (same rule the generator inferred with) */
export function primaryImage(entry: EntryView): AssetView | undefined {
  const flat = (v: unknown) => (Array.isArray(v) ? v : [v]);
  for (const v of Object.values(entry.fields)) for (const x of flat(v)) if (isAsset(x)) return x;
  for (const v of Object.values(entry.fields))
    for (const x of flat(v))
      if (x && typeof x === "object" && (x as EntryView)._kind === "entry")
        for (const cv of Object.values((x as EntryView).fields)) for (const y of flat(cv)) if (isAsset(y)) return y;
  return undefined;
}

export function inferredTags(entry: EntryView, s: { title: string; description?: string; canonical: string; settings: SettingsView; origin: string }) {
  const out: Record<string, string> = {};
  for (const key of SEO.order) {
    const r = SEO.rules[key];
    let v: string | undefined;
    if ("const" in r) v = r.const;
    else if ("perLocale" in r) v = r.perLocale[entry.locale];
    else if ("perType" in r) v = r.perType[entry.type];
    else if (r.from === "title") v = s.title;
    else if (r.from === "description") v = s.description;
    else if (r.from === "canonical") v = s.canonical;
    else if (r.from === "siteName") v = s.settings.siteName;
    else if (r.from === "image") {
      const img = primaryImage(entry);
      v = img ? (/^https?:/.test(img.url) ? img.url : s.origin + img.url) : undefined;
    }
    if (v) out[key] = v;
  }
  return out;
}

export interface HeadTag {
  attr: "property" | "name";
  key: string;
  content: string;
}

/**
 * og:* / twitter:* / article:* tags of a page, exactly as on the original: explicit CCM meta wins over the inferred
 * metatag defaults. Rendered by the root layout (not the metadata API, which synthesises extra twitter:* tags).
 */
export function socialTags(
  entry: EntryView,
  s: { title: string; description?: string; canonical: string; settings: SettingsView; origin: string; og?: Record<string, string>; twitter?: Record<string, string>; rehost: (u: string) => string },
): HeadTag[] {
  const inferred = inferredTags(entry, s);
  const merged: Record<string, string> = { ...inferred, ...(s.og ?? {}), ...(s.twitter ?? {}) };
  const order = [...SEO.order.filter((k) => k in merged), ...Object.keys(merged).filter((k) => !SEO.order.includes(k))];
  return order.map((key) => {
    const raw = merged[key];
    const content = /^(og:url|og:image|og:image:url|og:image:secure_url|twitter:image)$/.test(key) ? s.rehost(raw) : raw;
    return { attr: key.startsWith("twitter:") ? "name" : "property", key, content };
  });
}
