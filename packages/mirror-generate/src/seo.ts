/**
 * SEO tag rules inferred from the crawled original pages (raw/html) — ports Drupal metatag defaults (og:*, twitter:*)
 * that are not in the CCM Entry.meta. A rule is only kept when it reproduces the tag on EVERY crawled page that maps to a
 * CCM entry (absent where the rule yields nothing, equal where it yields a value). Deterministic, no LLM.
 *
 * Rule kinds: { from: "title" | "description" | "canonical" | "siteName" | "image" } | { perLocale: {en: …} } | { const: … }
 * The app applies them in generateMetadata when entry.meta has no value for the key.
 */
import { parseHtml, type HElement, type HNode } from "./template-html-parse.js";

export type SeoRule =
  | { from: "title" | "description" | "canonical" | "siteName" | "image" }
  | { perLocale: Record<string, string> }
  | { perType: Record<string, string> }
  | { const: string };

export interface SeoInput {
  path: string;
  locale: string;
  /** CCM content type of the entry at this path */
  type?: string;
  html: string;
  /** CCM-derived values the app will have at runtime */
  title?: string;
  description?: string;
  canonicalPath?: string;
  siteName?: string;
  /** public path of the entry's primary image (first asset reference in its fields / first section) */
  imagePath?: string;
  /** keys already present in entry.meta (og / twitter) → not inferred for this page */
  known: Set<string>;
}

function headTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (ns: HNode[]) => {
    for (const n of ns) {
      if (n.type !== "element") continue;
      const el = n as HElement;
      if (el.name === "meta") {
        const a = new Map(el.attrs.map(([k, v]) => [k.toLowerCase(), v ?? ""]));
        const key = a.get("property") ?? a.get("name");
        if (key && /^(og|twitter|article):/.test(key) && !out.has(key)) out.set(key, a.get("content") ?? "");
      }
      if (el.name !== "body") walk(el.children);
    }
  };
  walk(parseHtml(html));
  return out;
}

const pathOf = (v: string) => {
  try {
    const u = new URL(v, "http://x");
    return u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  } catch {
    return v;
  }
};

export function inferSeoRules(pages: SeoInput[]): { rules: Record<string, SeoRule>; order: string[]; rejected: string[] } {
  const tags = pages.map((p) => ({ p, t: headTags(p.html) }));
  const keys: string[] = [];
  for (const { t } of tags) for (const k of t.keys()) if (!keys.includes(k)) keys.push(k);
  const rules: Record<string, SeoRule> = {};
  const rejected: string[] = [];
  for (const key of keys) {
    const rows = tags.filter(({ p }) => !p.known.has(key));
    if (!rows.length) continue;
    const cands: SeoRule[] = [{ from: "title" }, { from: "description" }, { from: "canonical" }, { from: "siteName" }, { from: "image" }];
    const perLocale: Record<string, string> = {};
    let perLocaleOk = true;
    for (const { p, t } of rows) {
      const v = t.get(key);
      if (v === undefined) perLocaleOk = false;
      else if (perLocale[p.locale] === undefined) perLocale[p.locale] = v;
      else if (perLocale[p.locale] !== v) perLocaleOk = false;
    }
    const values = Object.values(perLocale);
    if (perLocaleOk && values.length) cands.push(values.every((v) => v === values[0]) ? { const: values[0] } : { perLocale });
    const perType: Record<string, string> = {};
    let perTypeOk = rows.every(({ p }) => p.type);
    for (const { p, t } of rows) {
      const v = t.get(key);
      if (v === undefined || !p.type) perTypeOk = false;
      else if (perType[p.type] === undefined) perType[p.type] = v;
      else if (perType[p.type] !== v) perTypeOk = false;
    }
    if (perTypeOk && Object.keys(perType).length > 1) cands.push({ perType });
    const produce = (r: SeoRule, p: SeoInput): string | undefined => {
      if ("const" in r) return r.const;
      if ("perLocale" in r) return r.perLocale[p.locale];
      if ("perType" in r) return p.type ? r.perType[p.type] : undefined;
      switch (r.from) {
        case "title":
          return p.title;
        case "description":
          return p.description;
        case "canonical":
          return p.canonicalPath;
        case "siteName":
          return p.siteName;
        case "image":
          return p.imagePath;
      }
    };
    const urlish = (r: SeoRule) => "from" in r && (r.from === "canonical" || r.from === "image");
    const ok = (r: SeoRule) =>
      rows.every(({ p, t }) => {
        const want = t.get(key);
        const got = produce(r, p);
        if (want === undefined || want === "") return got === undefined || got === "";
        if (got === undefined) return false;
        return urlish(r) ? pathOf(want) === pathOf(got) : want === got;
      });
    // a value-copy rule needs at least one page where it is not trivially empty
    const rule = cands.find((r) => ok(r) && rows.some(({ p }) => produce(r, p)));
    if (rule) rules[key] = rule;
    else rejected.push(key);
  }
  return { rules, order: keys.filter((k) => rules[k]), rejected };
}

/**
 * Explicit rules from `mapping/seo.yaml` (`rules: { "<og:|twitter:|article:tag>": SeoRule }`, reviewed; written by
 * humans or the autofix seo-rule handler) merged over the inferred ones: an explicit rule wins per tag, new tags are
 * appended to the order and leave `rejected`. Invalid entries are skipped and returned in `invalid`.
 */
export function mergeSeoRules(
  inferred: { rules: Record<string, SeoRule>; order: string[]; rejected: string[] },
  explicit: unknown,
): { rules: Record<string, SeoRule>; order: string[]; rejected: string[]; applied: string[]; invalid: string[] } {
  const rules = { ...inferred.rules };
  const order = [...inferred.order];
  const applied: string[] = [];
  const invalid: string[] = [];
  const src = explicit && typeof explicit === "object" ? (explicit as { rules?: unknown }).rules : undefined;
  const isStrMap = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x) && Object.values(x as object).every((v) => typeof v === "string");
  const valid = (r: unknown): r is SeoRule => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return false;
    const o = r as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== 1) return false;
    if ("from" in o) return ["title", "description", "canonical", "siteName", "image"].includes(String(o.from));
    if ("const" in o) return typeof o.const === "string";
    if ("perLocale" in o) return isStrMap(o.perLocale);
    if ("perType" in o) return isStrMap(o.perType);
    return false;
  };
  if (src && typeof src === "object")
    for (const tag of Object.keys(src as object).sort()) {
      const r = (src as Record<string, unknown>)[tag];
      if (!/^(og|twitter|article):[a-z_:]+$/.test(tag) || !valid(r)) {
        invalid.push(tag);
        continue;
      }
      rules[tag] = r;
      if (!order.includes(tag)) order.push(tag);
      applied.push(tag);
    }
  return { rules, order, rejected: inferred.rejected.filter((t) => !applied.includes(t)), applied, invalid };
}
