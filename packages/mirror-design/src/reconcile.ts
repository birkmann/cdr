/**
 * Bind mined props to the CCM produced by the content track (when workspace ccm/ exists).
 *
 * The miner names props after the markup (Drupal field classes, BEM elements); the content track names CCM fields
 * after its own extraction. Both see the same instances, so the binding is decided by VALUE: for every component
 * instance that has a CCM entry (matched by Drupal entity id: `drupal:paragraph:<pid>` / `source.id`, or by page
 * path for document parts), a prop binds to the field whose value equals the prop's value on every matched instance
 * (text, rich text as plain text, asset by original path, link by URL, entity lists by referenced entity ids,
 * booleans/enums). The component's ccmType becomes the CCM type of its matched entries.
 * Props that match no field lose their ccmField: a renderer then uses the instance value (instanceProps, by entity
 * id) or the example value — never an empty binding.
 */
import { readCcm, type Issue, type Workspace } from "@harness/mirror-core";
import { richTextToPlainText } from "@harness/mirror-transforms";
import type { RichTextDoc } from "@harness/mirror-core";
import { dom } from "@harness/mirror-capture";
import { detectDateFormat, type ComponentDef, type PropDef } from "./mine.js";
import { detectPhpDate } from "./php-date.js";

type Entry = Awaited<ReturnType<typeof readCcm>>["entries"][number];

export interface ReconcileStats {
  ccmEntries: number;
  componentsMatched: number;
  propsBound: number;
  propsUnbound: number;
  typesAligned: number;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const htmlText = (h: string) => norm(dom.text(dom.parseFragment(h) as unknown as dom.Element));
const urlPath = (u: string) => {
  try {
    return decodeURIComponent(new URL(u, "http://x").pathname);
  } catch {
    return u.split("?")[0];
  }
};

function isDoc(v: unknown): v is RichTextDoc {
  return !!v && typeof v === "object" && (v as { type?: string }).type === "doc";
}
function isRef(v: unknown): v is { kind: string; id: string } {
  return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && typeof (v as { id?: unknown }).id === "string";
}

export async function reconcileWithCcm(ws: Workspace, components: ComponentDef[], opts: { locale: string }): Promise<{ stats: ReconcileStats; issues: Issue[] } | undefined> {
  if (!(await ws.exists("ccm/schema/content-types.json"))) return undefined;
  let bundle;
  try {
    bundle = await readCcm(ws, { strict: false });
  } catch {
    return undefined;
  }
  const issues: Issue[] = [];
  const entries = bundle.entries.filter((e) => e.locale === opts.locale);
  const byEntity = new Map<string, Entry>();
  const byCcmId = new Map<string, Entry>();
  const byPath = new Map<string, Entry>();
  for (const e of entries) {
    byCcmId.set(e.ccmId, e);
    const tail = /^drupal:(?:paragraph|node):(\d+)$/.exec(e.ccmId)?.[1] ?? (/^\d+$/.test(String(e.source?.id ?? "")) ? String(e.source.id) : undefined);
    if (tail && !byEntity.has(tail)) byEntity.set(tail, e);
    if (e.path && !byPath.has(e.path)) byPath.set(e.path, e);
  }
  // every locale's entries by path (paths carry the locale prefix): the crawled instances of other locales show how the
  // source printed number/enum values there (display mapping only; bindings are decided on the default locale)
  const byPathAll = new Map<string, Entry>();
  for (const e of bundle.entries) if (e.path && !byPathAll.has(e.path)) byPathAll.set(e.path, e);
  const enumField = new Set(bundle.schema.contentTypes.flatMap((ct) => ct.fields.filter((f) => f.type === "enum").map((f) => `${ct.id}.${f.id}`)));
  // source labels of enum keys (default language; source-drupal: FieldDef.sourceMeta.optionLabels) for keys no crawled
  // instance shows
  const optionLabels = new Map<string, Record<string, string>>();
  // translated labels (source config translations, e.g. Drupal language/<lc>/field.storage.*: "Fácil"), per locale
  const optionLabelsByLocale = new Map<string, Record<string, Record<string, string>>>();
  for (const ct of bundle.schema.contentTypes)
    for (const f of ct.fields) {
      const sm = f.sourceMeta as { optionLabels?: Record<string, string>; optionLabelsByLocale?: Record<string, Record<string, string>> } | undefined;
      if (f.type === "enum" && sm?.optionLabels && typeof sm.optionLabels === "object") optionLabels.set(`${ct.id}.${f.id}`, sm.optionLabels);
      if (f.type === "enum" && sm?.optionLabelsByLocale && typeof sm.optionLabelsByLocale === "object") optionLabelsByLocale.set(`${ct.id}.${f.id}`, sm.optionLabelsByLocale);
    }
  const assetPath = new Map<string, string>();
  for (const a of bundle.assets) if (a.originalPath) assetPath.set(a.ccmId, decodeURIComponent(a.originalPath));
  const entityIdOfRef = (id: string) => {
    const e = byCcmId.get(id);
    if (!e) return undefined;
    return /^drupal:(?:paragraph|node):(\d+)$/.exec(e.ccmId)?.[1] ?? (e.source?.id !== undefined ? String(e.source.id) : undefined);
  };

  /** does CCM field value `f` represent the mined prop value `v`? */
  /** strict: same markup/string; loose: same text (markup differs) */
  const eq = (p: PropDef, v: unknown, f: unknown, strict = false): boolean => {
    if (v === undefined || v === null || f === undefined || f === null) return false;
    if (p.valueType === "boolean" || typeof v === "boolean") return typeof f === "boolean" && f === v;
    if (p.type === "asset" && v && typeof v === "object") {
      const url = (v as { url?: string }).url;
      if (!url) return false;
      const ref = Array.isArray(f) ? f[0] : f;
      return isRef(ref) && ref.kind === "asset" && assetPath.get(ref.id) === urlPath(url);
    }
    if (p.type === "link" && v && typeof v === "object") {
      const url = (v as { url?: string }).url ?? "";
      const cand = typeof f === "string" ? f : f && typeof f === "object" ? ((f as Record<string, unknown>).url ?? (f as Record<string, unknown>).href ?? (f as Record<string, unknown>).path) : undefined;
      return typeof cand === "string" && (cand === url || urlPath(cand) === urlPath(url));
    }
    if (p.type === "list" && Array.isArray(v)) {
      const ids = v.map((x) => (x && typeof x === "object" ? (x as { entityId?: string }).entityId : undefined));
      if (!Array.isArray(f) || f.length !== v.length) return false;
      // only lists of entities bind to a reference list (repeated markup items have no CCM counterpart)
      return ids.every(Boolean) && f.every((x, i) => isRef(x) && entityIdOfRef(x.id) === ids[i]);
    }
    if (typeof v === "object") return false;
    const sv = String(v);
    if (isDoc(f)) return !strict && norm(richTextToPlainText(f)) === (p.type === "richText" || p.type === "html" ? htmlText(sv) : norm(sv));
    if (typeof f === "string") return norm(f) === norm(sv) || (!strict && (p.type === "richText" || p.type === "html") && htmlText(f) === htmlText(sv));
    if (typeof f === "number") return String(f) === sv.trim();
    return false;
  };

  /** a text prop and a same-named plain-string CCM field that disagree (e.g. "40 minutes" vs the field wrapper's
   * "Preparation time 40 minutes"): not a representation difference, the binding would render the wrong text */
  const plainTextConflict = (p: PropDef, vs: { v: unknown; f: unknown }[]) =>
    p.type === "text" && !p.valueType && vs.some((x) => typeof x.v === "string" && x.v !== "") && vs.every((x) => typeof x.v !== "string" || x.v === "" || ((typeof x.f === "string" || typeof x.f === "number") && norm(String(x.f)) !== norm(x.v)));

  /** a text prop the crawl shows while the same-named CCM field is empty on every such instance (e.g. a crawl-only
   * `uid: []` the content track could not extract): binding it would render nothing, the instance value is the truth */
  const isEmpty = (f: unknown) => f === undefined || f === null || f === "" || (Array.isArray(f) && !f.length);
  const shownButEmpty = (p: PropDef, vs: { v: unknown; f: unknown }[]) =>
    p.type === "text" && !p.valueType && vs.some((x) => typeof x.v === "string" && norm(x.v) !== "") && vs.every((x) => typeof x.v !== "string" || norm(x.v) === "" || isEmpty(x.f));

  /** the display mapping of text prop `p` to number/enum field `fname`, if every crawled instance agrees with one */
  const displayOf = (c: ComponentDef, p: PropDef, fname: string): PropDef["display"] | undefined => {
    // only the field the prop is named after (Drupal field class → CCM field id): a formatter changes the value's
    // text, so value equality alone can't pick the field
    if (c.kind !== "document" || !c.instanceProps || (fname !== p.name && fname !== p.ccmField)) return undefined;
    const affix: Record<string, [string, string]> = {};
    const labels: Record<string, Record<string, string>> = {};
    let n = 0;
    let enumKey: string | undefined;
    for (const [key, values] of Object.entries(c.instanceProps)) {
      const e = byPathAll.get(key);
      const v = values[p.name];
      const f = e?.fields[fname];
      if (!e || typeof v !== "string" || !norm(v) || f === undefined || f === null) continue;
      const sv = norm(v);
      if (typeof f === "number") {
        const i = sv.indexOf(String(f));
        if (i < 0 || sv.lastIndexOf(String(f)) !== i) return undefined;
        const a: [string, string] = [sv.slice(0, i), sv.slice(i + String(f).length)];
        if (/\d/.test(a.join("")) || (!a[0] && !a[1])) return undefined; // only text around the number; equal = plain binding
        const prev = affix[e.locale];
        if (prev && (prev[0] !== a[0] || prev[1] !== a[1])) return undefined;
        affix[e.locale] = a;
      } else if (typeof f === "string" && enumField.has(`${e.type}.${fname}`)) {
        if (sv === f) return undefined;
        const m = (labels[e.locale] ??= {});
        if (m[f] !== undefined && m[f] !== sv) return undefined;
        m[f] = sv;
        enumKey = `${e.type}.${fname}`;
      } else return undefined;
      n++;
    }
    if (!n) return undefined;
    if (Object.keys(affix).length && Object.keys(labels).length) return undefined;
    if (Object.keys(affix).length) return { affix };
    const ol = enumKey ? optionLabels.get(enumKey) : undefined;
    // the source labels must agree with what the crawl shows in the default locale, else they are not the printed ones
    if (ol && Object.entries(labels[opts.locale] ?? {}).every(([k, v]) => ol[k] === undefined || ol[k] === v)) labels[opts.locale] = { ...ol, ...(labels[opts.locale] ?? {}) };
    addTranslatedLabels(labels, enumKey);
    return { labels };
  };

  /** the source's translated option labels for keys no crawled instance of that locale shows (when they agree with the crawl) */
  const addTranslatedLabels = (labels: Record<string, Record<string, string>>, enumKey: string | undefined) => {
    const tr = enumKey ? optionLabelsByLocale.get(enumKey) : undefined;
    for (const [lc, m] of Object.entries(tr ?? {})) {
      if (lc === opts.locale) continue;
      if (Object.entries(labels[lc] ?? {}).every(([k, v]) => m[k] === undefined || m[k] === v)) labels[lc] = { ...m, ...(labels[lc] ?? {}) };
    }
  };

  /**
   * A list bound to a reference field renders the referenced entries: its item keys must be THEIR field ids. The miner
   * names item keys after the markup (`downloadLink` from `.downloads-item__download_link`), the content track may
   * name the field otherwise (`downloadLinkLabel`): a text key whose crawled values the same-named field does not
   * hold is renamed to the one item field that holds them on every crawled item (template, examples, instances).
   */
  const remapItemKeys = (c: ComponentDef, p: PropDef, lists: { mined: unknown; refs: unknown }[]) => {
    const rows: { mined: Record<string, unknown>; entry: Entry }[] = [];
    for (const { mined, refs } of lists) {
      if (!Array.isArray(mined) || !Array.isArray(refs) || mined.length !== refs.length) continue;
      refs.forEach((r, i) => {
        const e = isRef(r) && r.kind === "entry" ? byCcmId.get(r.id) : undefined;
        const m = mined[i];
        if (e && m && typeof m === "object" && !Array.isArray(m)) rows.push({ mined: m as Record<string, unknown>, entry: e });
      });
    }
    if (!rows.length) return;
    const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && norm(a) === norm(b);
    for (const k of Object.keys(p.itemFields!)) {
      if (p.itemFields![k] !== "text") continue;
      const vals = rows.filter((r) => typeof r.mined[k] === "string" && norm(r.mined[k] as string));
      if (!vals.length || vals.every((r) => same(r.mined[k], r.entry.fields[k]))) continue;
      const cands = [...new Set(vals.flatMap((r) => Object.keys(r.entry.fields)))].filter((f) => !(f in p.itemFields!) && vals.every((r) => same(r.mined[k], r.entry.fields[f])));
      if (cands.length !== 1) continue;
      const f = cands[0];
      c.template = renameItemKey(c.template, p.name, k, f);
      const rename = (list: unknown) => {
        if (Array.isArray(list)) for (const it of list) if (it && typeof it === "object" && k in it) {
          (it as Record<string, unknown>)[f] = (it as Record<string, unknown>)[k];
          delete (it as Record<string, unknown>)[k];
        }
      };
      rename(c.exampleProps[p.name]);
      for (const v of Object.values(c.instanceProps ?? {})) rename(v[p.name]);
      p.itemFields = Object.fromEntries(Object.entries(p.itemFields!).map(([x, t]) => [x === k ? f : x, t]));
      issues.push({ severity: "info", code: "DESIGN_ITEM_KEY_BOUND", message: `${c.id}.${p.name}: item key ${k} → field ${f} of the referenced entries (by value)`, ref: c.id });
    }
  };

  const stats: ReconcileStats = { ccmEntries: entries.length, componentsMatched: 0, propsBound: 0, propsUnbound: 0, typesAligned: 0 };
  for (const c of components) {
    if (!c.instanceProps) continue;
    const pairs: { values: Record<string, unknown>; entry: Entry }[] = [];
    for (const [key, values] of Object.entries(c.instanceProps)) {
      const entry = c.instanceKey === "entityId" ? byEntity.get(key) : c.kind === "document" ? byPath.get(key) : undefined;
      if (entry) pairs.push({ values, entry });
    }
    if (!pairs.length) continue;
    stats.componentsMatched++;
    const types = [...new Set(pairs.map((x) => x.entry.type))];
    if (c.kind !== "document" && types.length === 1 && c.ccmType !== types[0]) {
      issues.push({ severity: "info", code: "DESIGN_CCM_TYPE_ALIGNED", message: `${c.id}: ccmType ${c.ccmType ?? "(none)"} -> ${types[0]} (from ${pairs.length} matched CCM entr${pairs.length === 1 ? "y" : "ies"})`, ref: c.id });
      c.ccmType = types[0];
      stats.typesAligned++;
    }
    for (const p of c.props) {
      if (p.i18n || p.component || p.derive || p.name.startsWith("t.")) continue;
      const fieldNames = [...new Set(pairs.flatMap((x) => Object.keys(x.entry.fields)))];
      const get = (vals: Record<string, unknown>, path: string) => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), vals);
      const ordered = [p.ccmField, p.name, ...fieldNames].filter((x, i, a): x is string => !!x && a.indexOf(x) === i && fieldNames.includes(x));
      const matches = (fname: string, strict: boolean) => {
        const vs = pairs.map((x) => ({ v: get(x.values, p.name), f: x.entry.fields[fname] }));
        const present = vs.filter((x) => x.v !== undefined && x.v !== "" && !(Array.isArray(x.v) && !x.v.length));
        return present.length > 0 && present.every((x) => eq(p, x.v, x.f, strict));
      };
      // exact markup first (e.g. `titleHtml` over plain `title`), then same text
      const hit = ordered.find((f) => matches(f, true)) ?? ordered.find((f) => matches(f, false));
      // number / enum fields printed through a Drupal formatter: "40 minutes" for 40 (prefix/suffix), "Medium" for the
      // enum key "medium" → bind + `display` per locale (learned from every crawled instance incl. other locales)
      const disp = !hit && p.type === "text" && !p.valueType ? ordered.map((f) => [f, displayOf(c, p, f)] as const).find(([, d]) => d) : undefined;
      if (disp) {
        p.ccmField = disp[0];
        p.display = disp[1]!;
        stats.propsBound++;
      } else if (hit) {
        if (p.ccmField !== hit) p.ccmField = hit;
        if (p.type === "text" && pairs.some((x) => isDoc(x.entry.fields[hit]))) p.plainText = true;
        stats.propsBound++;
      } else if (p.ccmField && fieldNames.includes(p.ccmField) && !plainTextConflict(p, pairs.map((x) => ({ v: get(x.values, p.name), f: x.entry.fields[p.ccmField!] }))) && !shownButEmpty(p, pairs.map((x) => ({ v: get(x.values, p.name), f: x.entry.fields[p.ccmField!] })))) {
        stats.propsBound++; // same field name, representation differs (e.g. rich text vs html): keep the binding
      } else if (p.ccmField && !/^(settings|navigation|route|translations|collection|path)\b/.test(p.ccmField)) {
        delete p.ccmField;
        stats.propsUnbound++;
      }
      if (p.type === "list" && p.ccmField && p.itemFields) remapItemKeys(c, p, pairs.map((x) => ({ mined: get(x.values, p.name), refs: x.entry.fields[p.ccmField!] })));
    }
  }
  // the same enum/number shown by other components (teaser cards of the entity type): a same-named text prop whose
  // every crawled value is one of the learned labels gets the same binding + display
  const displays = new Map<string, NonNullable<PropDef["display"]>>();
  for (const c of components) for (const p of c.props) if (p.display && p.ccmField === p.name) displays.set(p.name, p.display);
  for (const c of components)
    for (const p of c.props) {
      const d = displays.get(p.name);
      if (!d?.labels || p.display || p.type !== "text" || p.valueType || (p.ccmField && p.ccmField !== p.name)) continue;
      const known = new Set(Object.values(d.labels).flatMap((m) => Object.values(m)));
      const keys = new Set(Object.values(d.labels).flatMap((m) => Object.keys(m)));
      const vals = Object.values(c.instanceProps ?? {}).map((v) => v[p.name]).filter((v): v is string => typeof v === "string");
      // labels (seen in another locale's crawl or the source's option labels), never the raw keys
      if (vals.some((v) => known.has(norm(v))) && vals.every((v) => known.has(norm(v)) || !keys.has(norm(v)))) {
        p.ccmField = p.name;
        p.display = d;
      }
    }

  // teaser instances (cards) link to their entity: the enum labels they print per locale (e.g. "Fácil" on the es
  // listing cards) complete the learned labels of every component sharing that display
  for (const c of components)
    for (const p of c.props) {
      // its own display, or that of the same-named enum binding (a card whose labels no other component shows yet)
      const d = p.display ?? (p.type === "text" && !p.valueType && (!p.ccmField || p.ccmField === p.name) ? displays.get(p.name) : undefined);
      if (!d?.labels) continue;
      const field = p.ccmField ?? p.name;
      const links = c.props.filter((q) => q.type === "link").map((q) => q.name);
      let learned = 0;
      for (const vals of Object.values(c.instanceProps ?? {})) {
        const v = vals[p.name];
        if (typeof v !== "string" || !norm(v)) continue;
        const e = links.map((l) => (vals[l] as { url?: unknown } | undefined)?.url).map((u) => (typeof u === "string" ? byPathAll.get(urlPath(u)) : undefined)).find(Boolean);
        const key = e?.fields[field];
        if (!e || typeof key !== "string" || !enumField.has(`${e.type}.${field}`)) continue;
        const m = (d.labels[e.locale] ??= {});
        if (m[key] === undefined) m[key] = norm(v);
        if (m[key] === norm(v)) learned++;
      }
      if (!p.display && learned) {
        p.ccmField = field;
        p.display = d;
      }
    }

  // dates printed as plain text (Drupal's "submitted" line: "by Umami 25th October 2026", no <time>): a text or UI-string
  // prop whose every crawled value is the matched entry's date field in one known format (Intl options or a PHP date()
  // pattern such as "jS F Y") binds to that field with the format, so uncrawled entries print their own date
  const dateFields = new Map(bundle.schema.contentTypes.map((ct) => [ct.id, ct.fields.filter((f) => f.type === "date").map((f) => f.id)]));
  for (const c of components) {
    if (c.kind !== "document" || c.instanceKey !== "path" || !c.instanceProps) continue;
    for (const p of [...c.props]) {
      if (p.type !== "text" || p.component || p.derive || p.valueType || p.format || p.display || (p.ccmField && !p.i18n)) continue;
      const obs: { key: string; e: Entry; shown: string }[] = [];
      let ok = true;
      for (const key of Object.keys(c.instanceProps)) {
        const e = byPathAll.get(key);
        if (!e) continue;
        const shown = p.i18n ? p.i18n[e.locale] : c.instanceProps[key][p.name];
        if (typeof shown !== "string" || !/\d/.test(shown)) ok = false;
        else obs.push({ key, e, shown: norm(shown) });
      }
      if (!ok || !obs.length) continue;
      const fields = [...new Set(obs.flatMap((o) => dateFields.get(o.e.type) ?? []))];
      let found: { f: string; format: NonNullable<PropDef["format"]> } | undefined;
      for (const f of fields) {
        let sig: string | undefined;
        const format: NonNullable<PropDef["format"]> = { kind: "date", options: {}, locales: {} };
        for (const o of obs) {
          const iso = o.e.fields[f];
          if (typeof iso !== "string") {
            sig = undefined;
            break;
          }
          const intl = detectDateFormat(iso, o.shown, o.e.locale);
          const php = intl ? undefined : detectPhpDate(iso, o.shown, o.e.locale);
          const s2 = intl ? `intl:${JSON.stringify(intl.options)}` : php ? `php:${php.pattern}` : "";
          const tag = intl?.tag ?? php?.tag;
          if (!s2 || (sig !== undefined && sig !== s2) || (format.locales[o.e.locale] && format.locales[o.e.locale] !== tag) || (format.locales[o.e.locale] && (format.case?.[o.e.locale] ?? "") !== (php?.case ?? ""))) {
            sig = undefined;
            break;
          }
          sig = s2;
          format.locales[o.e.locale] = tag!;
          if (intl) format.options = intl.options;
          if (php) {
            format.pattern = php.pattern;
            if (php.case) (format.case ??= {})[o.e.locale] = php.case;
          }
        }
        if (sig) {
          found = { f, format };
          break;
        }
      }
      if (!found) continue;
      const name = c.props.some((q) => q !== p && q.name === found!.f) ? `${found.f}Date` : found.f;
      const old = p.name;
      c.template = c.template.split(`{{${old}}}`).join(`{{${name}.formatted}}`);
      // canonical example value (what exampleHtml shows) → { iso, formatted }
      const ex = old.startsWith("t.") ? (c.exampleProps.t as Record<string, unknown> | undefined)?.[old.slice(2)] : c.exampleProps[old];
      if (old.startsWith("t.") && c.exampleProps.t && typeof c.exampleProps.t === "object") delete (c.exampleProps.t as Record<string, unknown>)[old.slice(2)];
      else delete c.exampleProps[old];
      const canon = obs.find((o) => o.shown === norm(String(ex ?? ""))) ?? obs[0];
      c.exampleProps[name] = { iso: canon.e.fields[found.f], formatted: typeof ex === "string" ? ex : canon.shown };
      for (const o of obs) {
        const vals = c.instanceProps[o.key];
        delete vals[old];
        vals[name] = { iso: o.e.fields[found.f], formatted: o.shown };
      }
      p.name = name;
      p.ccmField = found.f;
      delete p.i18n;
      p.format = found.format;
      issues.push({ severity: "info", code: "DESIGN_DATE_BOUND", message: `${c.id}.${name}: printed date bound to CCM field ${found.f} (${found.format.pattern ? `PHP pattern "${found.format.pattern}"` : "Intl options"}, ${Object.entries(found.format.locales).map(([l, t]) => `${l}=${t}`).join(", ")})`, ref: c.id });
      stats.propsBound++;
    }
  }

  // embedded Views blocks (rows of teasers inside a node or block, not the page's own listing): bind the row list to the
  // CCM collection of that view display, so pages that were not crawled show their own rows (contextual filters);
  // after the field binding: only row lists no CCM field holds
  const collectionIds = new Set(bundle.collections.map((c) => c.id));
  // (chrome too: Views blocks in a sidebar region of the content-type wrapper; their row lists carry no ccmField)
  for (const c of components) {
    for (const p of c.props) {
      if (p.type !== "list" || p.ccmField || p.collection || !p.itemFields?.html) continue;
      const at = c.template.indexOf(`{{#each ${p.name}}}`);
      if (at < 0) continue;
      const views = [...c.template.slice(0, at).matchAll(/\bview-id-([\w-]+)\s+view-display-id-([\w-]+)/g)];
      const last = views[views.length - 1];
      const id = last ? `${last[1]}--${last[2]}` : undefined;
      if (id && collectionIds.has(id) && !bundle.collections.find((x) => x.id === id)!.path) {
        p.collection = id;
        // the teaser component the crawled rows were mined as (rows' `type`): renders the collection's entries
        const types = Object.values(c.instanceProps ?? {}).flatMap((v) => (Array.isArray(v[p.name]) ? (v[p.name] as { type?: unknown }[]) : []).map((r) => r?.type)).filter((t): t is string => typeof t === "string");
        const row = [...new Set(types)];
        if (!p.itemComponent && row.length === 1 && components.some((x) => x.id === row[0])) p.itemComponent = row[0];
        // Drupal prints no block for a Views block without results (no empty text in the POC views): the block element
        // around the rows renders only when the collection has rows
        const span = enclosingElement(c.template, at, (tag) => /\bclass="[^"]*\bblock-views\b/.test(tag)) ?? enclosingElement(c.template, at, (tag) => /\bclass="[^"]*\bviews-element-container\b/.test(tag));
        if (span) c.template = `${c.template.slice(0, span[0])}{{#if ${p.name}}}${c.template.slice(span[0], span[1])}{{/if}}${c.template.slice(span[1])}`;
        issues.push({ severity: "info", code: "DESIGN_COLLECTION_BOUND", message: `${c.id}.${p.name}: rows of the embedded view ${last![1]}.${last![2]} bound to collection ${id}`, ref: c.id });
      }
    }
  }
  // unbound text props whose crawled values depend on the locale only (block titles like "Related recipes" /
  // "Recetas relacionadas" inside a node): UI strings → i18n, so uncrawled pages of a locale show its own string
  // instead of the canonical (default-locale) example
  for (const c of components) {
    if (c.kind !== "document" || c.instanceKey !== "path" || !c.instanceProps) continue;
    for (const p of c.props) {
      if (p.type !== "text" || p.ccmField || p.i18n || p.component || p.derive || p.valueType || p.name.startsWith("t.")) continue;
      const per: Record<string, Set<string>> = {};
      for (const [key, vals] of Object.entries(c.instanceProps)) {
        const loc = byPathAll.get(key)?.locale;
        const v = vals[p.name];
        if (!loc || typeof v !== "string" || !v.trim()) continue;
        (per[loc] ??= new Set()).add(v);
      }
      const locs = Object.keys(per);
      if (locs.length < 2 || locs.some((l) => per[l].size !== 1) || new Set(locs.map((l) => [...per[l]][0])).size < 2) continue;
      p.i18n = Object.fromEntries(locs.sort().map((l) => [l, [...per[l]][0]]));
    }
  }
  return { stats, issues };
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** [start, end) of the innermost element around template offset `at` whose opening tag passes `test` */
export function enclosingElement(tpl: string, at: number, test: (openTag: string) => boolean): [number, number] | undefined {
  const re = /<(\/?)([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  const stack: { name: string; start: number; tag: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl)) && m.index < at) {
    const [tag, close, name, self] = m;
    if (VOID_TAGS.has(name.toLowerCase()) || self) continue;
    if (close) {
      const i = stack.map((x) => x.name).lastIndexOf(name);
      if (i >= 0) stack.length = i;
    } else stack.push({ name, start: m.index, tag });
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!test(stack[i].tag)) continue;
    let depth = stack.length - i;
    re.lastIndex = at;
    while ((m = re.exec(tpl))) {
      const [tag, close, name, self] = m;
      if (VOID_TAGS.has(name.toLowerCase()) || self) continue;
      depth += close ? -1 : 1;
      if (depth === 0) return [stack[i].start, m.index + tag.length];
    }
    return undefined;
  }
  return undefined;
}

/** `this.<from>` → `this.<to>` inside the `{{#each <list>}}…{{/each}}` blocks of a template */
export function renameItemKey(tpl: string, list: string, from: string, to: string): string {
  const open = `{{#each ${list}}}`;
  let out = "";
  let pos = 0;
  for (let at = tpl.indexOf(open, pos); at >= 0; at = tpl.indexOf(open, pos)) {
    const re = /\{\{(#each\b[^}]*|\/each)\}\}/g;
    re.lastIndex = at + open.length;
    let depth = 1;
    let end = tpl.length;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tpl))) {
      depth += m[1] === "/each" ? -1 : 1;
      if (!depth) {
        end = m.index;
        break;
      }
    }
    const body = tpl.slice(at, end).replace(new RegExp(`(\\{\\{\\{?\\s*(?:#if\\s+|#unless\\s+)?)this\\.${from}(?=[\\s}.])`, "g"), `$1this.${to}`);
    out += tpl.slice(pos, at) + body;
    pos = end;
  }
  return out + tpl.slice(pos);
}
