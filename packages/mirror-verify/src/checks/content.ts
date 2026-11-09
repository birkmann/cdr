import type { ContentType, Entry, Issue, RichTextDoc } from "@harness/mirror-core";
import { pageText } from "../html.js";
import { squash } from "../text.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, mapLimit, notRun, notRunIssue } from "./util.js";

export interface KeyText {
  field: string;
  text: string;
}

const isDoc = (v: unknown): v is RichTextDoc => !!v && typeof v === "object" && (v as { type?: unknown }).type === "doc";

function refId(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && (o.kind === "entry" || o.kind === undefined)) return o.id;
    if (typeof o.ccmId === "string") return o.ccmId;
    if (o.ref) return refId(o.ref);
  }
  return undefined;
}

function truncateWords(s: string, max = 80): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return sp > 20 ? cut.slice(0, sp) : cut;
}

/** Key texts expected on the rendered page of a routable entry (title, short text fields, rich-text lead, embedded components). */
export function keyTexts(cx: VerifyContext, entry: Entry, depth = 0): KeyText[] {
  const types = new Map<string, ContentType>((cx.ccm.schema?.contentTypes ?? []).map((t) => [t.id, t]));
  const type = types.get(entry.type);
  const out: KeyText[] = [];
  const display = type?.displayField ?? "title";
  const add = (field: string, raw: string) => {
    const t = cx.normalizeText(raw);
    if (t.length >= 2) out.push({ field, text: t });
  };
  if (depth === 0 && typeof entry.fields[display] === "string") add(display, entry.fields[display] as string);
  for (const [k, v] of Object.entries(entry.fields)) {
    const def = type?.fields.find((f) => f.id === k);
    if (k === display && depth === 0) continue;
    if (isDoc(v)) {
      add(k, truncateWords(cx.normalizeText(cx.plainText(v))));
      continue;
    }
    if (def?.type === "text" && typeof v === "string" && v.length <= 200) add(k, v);
    if (depth === 0 && (def?.type === "component" || def?.type === "componentList")) {
      for (const item of Array.isArray(v) ? v : [v]) {
        const id = refId(item);
        if (!id) continue;
        const child = cx.ccm.entries.find((e) => e.ccmId === id && e.locale === entry.locale) ?? cx.ccm.entries.find((e) => e.ccmId === id);
        if (child) for (const kt of keyTexts(cx, child, depth + 1)) out.push({ field: `${k}.${child.type}.${kt.field}`, text: kt.text });
      }
    }
  }
  return out;
}

export async function contentCompleteness(cx: VerifyContext): Promise<CheckResult> {
  const issues: Issue[] = [];
  const rows = await mapLimit(cx.routable, 6, async (entry) => {
    const path = entry.path!;
    const [np, op] = await Promise.all([cx.fetchPage("new", path), cx.fetchPage("old", path)]);
    const row = { path, ccmId: entry.ccmId, locale: entry.locale, status: np.status, missingTexts: [] as KeyText[], notOnOld: [] as KeyText[] };
    if (np.status !== 200) {
      issues.push({ severity: "error", code: "PAGE_MISSING", message: `${path} returned ${np.status || np.error} on the new site`, ref: path, actionable: true });
      return row;
    }
    const newText = squash(cx.normalizeText(pageText(np.html, cx.mask)));
    const oldText = op.status === 200 && op.html ? squash(cx.normalizeText(pageText(op.html, cx.mask))) : undefined;
    for (const kt of keyTexts(cx, entry)) {
      const k = squash(kt.text);
      if (newText.includes(k)) continue;
      if (oldText !== undefined && !oldText.includes(k)) {
        row.notOnOld.push(kt);
        continue;
      }
      row.missingTexts.push(kt);
      issues.push({ severity: "error", code: "TEXT_MISSING", message: `${path}: ${kt.field} "${kt.text.slice(0, 60)}" not rendered`, ref: path, actionable: true });
    }
    return row;
  });
  // POC URLs without a CCM document (listing pages, pages the content track missed) must still be served
  const entryPaths = new Set(cx.routable.map((e) => e.path!.replace(/\/+$/, "") || "/"));
  const extra = cx.urls.filter((u) => !entryPaths.has(u.replace(/\/+$/, "") || "/"));
  const urlRows = await mapLimit(extra, 6, async (path) => {
    const np = await cx.fetchPage("new", path);
    if (np.status !== 200) issues.push({ severity: "error", code: "PAGE_MISSING", message: `${path} returned ${np.status || np.error} on the new site (POC URL without a CCM entry)`, ref: path, actionable: true });
    return { path, status: np.status };
  });
  const missingPages = rows.filter((r) => r.status !== 200).length + urlRows.filter((r) => r.status !== 200).length;
  const missingTexts = rows.reduce((n, r) => n + r.missingTexts.length, 0);
  const compared = rows.filter((r) => r.status === 200).length;
  if (!rows.length) issues.push(notRunIssue("content", "0 routable CCM entries (empty or unroutable ccm/)"));
  else if (!compared) issues.push(notRunIssue("content", `none of the ${rows.length} CCM pages answered 200 on the new site`));
  return finish(cx, "content", {
    gates: {
      missing: rows.length ? { pass: missingPages === 0, value: missingPages, threshold: 0 } : notRun(0),
      missingTexts: compared ? { pass: missingTexts === 0, value: missingTexts, threshold: 0 } : notRun(0),
    },
    stats: { entries: rows.length, compared, pocUrlsWithoutEntry: extra.length, missingPages, missingTexts },
    issues,
    details: { pages: rows, pocUrlsWithoutEntry: urlRows },
  });
}
