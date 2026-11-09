/**
 * Design overrides layer (docs/DEEPSEEK_ONLY_PLAN.md §5.6.2): reviewed DATA patches merged deterministically over the
 * mined design, so a parity fix survives every re-run of `design extract` and `frontend generate` (the app stays 100 %
 * generated). Written by humans or by `migrate autofix` handlers (parity-fix, design-variant), never by the miner.
 *
 *   design/base/{manifest.json,components/*.json,templates/*.json,layouts/default.json}   pristine mined result
 *   design/overrides/components/<id>.json   ComponentOverride (partial ComponentDef patch)
 *   design/overrides/pages.json             { "<path>": PageOverride }
 *   design/overrides/assets.json            AssetsOverride (stylesheet/script add/remove/order, lazy-image rule)
 *   design/overrides/scripts.json           { "<src substring>": ScriptRule }
 *   design/overrides/site.css               scoped CSS, copied to design/styles/site-overrides.css, loaded LAST
 *   design/overrides-applied.json           what was applied (+ issues), written on every merge
 *
 * `design extract` = mine → write base → apply. Fast path (no crawl, no mining): `applyDesignOverrides(ws)` /
 * `migrate design apply-overrides <site>`.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Issue, Workspace } from "@harness/mirror-core";
import { normalizeHtml } from "./mine.js";
import { renderTemplate } from "./render.js";

// ------------------------------------------------------------------ schema

const Replace = z.object({ find: z.string().min(1), replace: z.string(), all: z.boolean().optional() }).strict();
export type TextReplace = z.infer<typeof Replace>;

const PropDefSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["text", "richText", "asset", "link", "list", "html", "reference"]),
    ccmField: z.string().optional(),
    component: z.string().optional(),
    itemComponent: z.string().optional(),
    itemFields: z.record(z.string(), z.string()).optional(),
    valueType: z.literal("boolean").optional(),
    i18n: z.record(z.string(), z.string()).optional(),
    format: z.unknown().optional(),
    derive: z.literal("ccmIdTail").optional(),
    inline: z.boolean().optional(),
    plainText: z.boolean().optional(),
  })
  .strict();

export const ComponentOverride = z
  .object({
    id: z.string().optional(),
    /** true = a component the miner does not produce (template + kind required) */
    create: z.boolean().optional(),
    name: z.string().optional(),
    selector: z.string().optional(),
    kind: z.enum(["chrome", "section", "document"]).optional(),
    ccmType: z.string().optional(),
    variantOf: z.string().optional(),
    /** full template replacement (applied before templateReplace) */
    template: z.string().optional(),
    /** exact-substring replacements on the template, in order; a find that matches nothing is an error */
    templateReplace: z.array(Replace).optional(),
    /** full props replacement */
    props: z.array(PropDefSchema).optional(),
    propsPatch: z
      .object({
        set: z.record(z.string(), PropDefSchema.partial().strict()).optional(),
        add: z.array(PropDefSchema).optional(),
        remove: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    exampleProps: z.record(z.string(), z.unknown()).optional(),
    instanceProps: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    note: z.string().optional(),
    attempt: z.string().optional(),
  })
  .strict();
export type ComponentOverride = z.infer<typeof ComponentOverride>;

const Slot = z
  .object({ component: z.string().min(1), field: z.string().optional(), repeat: z.boolean().optional(), region: z.string().optional(), props: z.record(z.string(), z.unknown()).optional() })
  .strict();

export const PageOverride = z
  .object({
    contentType: z.string().optional(),
    bodyClass: z.string().optional(),
    assetSet: z.string().optional(),
    layoutVariant: z.string().optional(),
    /** base component id -> variant id for this page (merged) */
    components: z.record(z.string(), z.string()).optional(),
    /** full replacement of the page's own template */
    template: z.object({ slots: z.array(Slot), wrapperHtml: z.string().optional() }).strict().optional(),
    /** slot ops on the page template (or a copy of the content-type template when the page has none) */
    slotsInsert: z.array(z.object({ slot: Slot, after: z.string().optional(), before: z.string().optional() }).strict()).optional(),
    slotsRemove: z.array(z.string()).optional(),
    wrapperReplace: z.array(Replace).optional(),
    note: z.string().optional(),
    attempt: z.string().optional(),
  })
  .strict();
export type PageOverride = z.infer<typeof PageOverride>;
export const PagesOverride = z.record(z.string(), PageOverride);

const ListOps = <T extends z.ZodTypeAny>(entry: T) =>
  z
    .object({
      add: z.array(entry).optional(),
      /** substring of href/src or of the original URL (query ignored) */
      remove: z.array(z.string().min(1)).optional(),
      /** these entries first, in this order (substring match); the rest keep their relative order */
      order: z.array(z.string().min(1)).optional(),
      /** asset set ids to apply to (default: all sets + the top-level lists) */
      sets: z.array(z.string()).optional(),
    })
    .strict();

const StyleAdd = z
  .object({ href: z.string().min(1), media: z.string().optional(), attrs: z.record(z.string(), z.string()).optional(), after: z.string().optional(), before: z.string().optional(), sets: z.array(z.string()).optional() })
  .strict();
const ScriptAdd = z
  .object({
    src: z.string().min(1),
    placement: z.enum(["head", "body"]).optional(),
    role: z.string().optional(),
    type: z.string().optional(),
    attrs: z.record(z.string(), z.string()).optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    sets: z.array(z.string()).optional(),
  })
  .strict();

export const AssetsOverride = z
  .object({
    stylesheets: ListOps(StyleAdd).optional(),
    scripts: ListOps(ScriptAdd).optional(),
    images: z
      .object({
        /** restore the lazy placeholder `src` of `<img data-src>` whose src was resolved to the lazy source (all components, or these ids) */
        keepRawLazySrc: z.union([z.literal(true), z.array(z.string())]).optional(),
        placeholder: z.string().optional(),
      })
      .strict()
      .optional(),
    note: z.string().optional(),
  })
  .strict();
export type AssetsOverride = z.infer<typeof AssetsOverride>;

export const ScriptRule = z
  .object({
    placement: z.enum(["head", "body"]).optional(),
    role: z.string().optional(),
    exclude: z.boolean().optional(),
    stub: z.boolean().optional(),
    order: z.number().int().optional(),
    note: z.string().optional(),
  })
  .strict();
export const ScriptsOverride = z.record(z.string().min(1), ScriptRule);
export type ScriptsOverride = z.infer<typeof ScriptsOverride>;

export interface DesignOverrides {
  components: Record<string, ComponentOverride>;
  pages: Record<string, PageOverride>;
  assets?: AssetsOverride;
  scripts?: ScriptsOverride;
  siteCss?: string;
}

export const SITE_CSS_HREF = "styles/site-overrides.css";
export const BASE_DIR = "design/base";
export const OVERRIDES_DIR = "design/overrides";

// ------------------------------------------------------------------ read

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
const zodMsg = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** Read + validate design/overrides/. Invalid files are skipped with a DESIGN_OVERRIDE_INVALID error. */
export async function readOverrides(designDir: string): Promise<{ overrides: DesignOverrides; issues: Issue[]; files: string[] }> {
  const dir = join(designDir, "overrides");
  const issues: Issue[] = [];
  const files: string[] = [];
  const ov: DesignOverrides = { components: {}, pages: {} };
  const parse = async <T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> => {
    const p = join(dir, rel);
    if (!(await exists(p))) return undefined;
    files.push(`overrides/${rel}`);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(p, "utf8"));
    } catch (e) {
      issues.push({ severity: "error", code: "DESIGN_OVERRIDE_INVALID", message: `design/overrides/${rel}: invalid JSON (${(e as Error).message})`, ref: `design/overrides/${rel}`, actionable: true });
      return undefined;
    }
    const r = schema.safeParse(raw);
    if (!r.success) {
      issues.push({ severity: "error", code: "DESIGN_OVERRIDE_INVALID", message: `design/overrides/${rel}: ${zodMsg(r.error)}`, ref: `design/overrides/${rel}`, actionable: true });
      return undefined;
    }
    return r.data;
  };
  let compFiles: string[] = [];
  try {
    compFiles = (await readdir(join(dir, "components"))).filter((f) => f.endsWith(".json")).sort();
  } catch {
    /* none */
  }
  for (const f of compFiles) {
    const c = await parse(`components/${f}`, ComponentOverride);
    if (!c) continue;
    const id = f.replace(/\.json$/, "");
    if (c.id && c.id !== id) {
      issues.push({ severity: "error", code: "DESIGN_OVERRIDE_INVALID", message: `design/overrides/components/${f}: id "${c.id}" does not match the file name`, ref: `design/overrides/components/${f}`, actionable: true });
      continue;
    }
    ov.components[id] = c;
  }
  ov.pages = (await parse("pages.json", PagesOverride)) ?? {};
  ov.assets = await parse("assets.json", AssetsOverride);
  ov.scripts = await parse("scripts.json", ScriptsOverride);
  if (await exists(join(dir, "site.css"))) {
    files.push("overrides/site.css");
    ov.siteCss = await readFile(join(dir, "site.css"), "utf8");
  }
  return { overrides: ov, issues, files };
}

// ------------------------------------------------------------------ apply (pure)

/** Loosely typed design documents (manifest / ComponentDef / TemplateDef as written by design extract). */
type Json = Record<string, unknown>;
export interface DesignDocs {
  manifest: Json;
  components: Json[];
  templates: Json[];
  layout?: Json;
}

function replaceAll(text: string, reps: TextReplace[], where: string, issues: Issue[], ref: string): string {
  let out = text;
  for (const r of reps) {
    if (!out.includes(r.find)) {
      issues.push({ severity: "error", code: "DESIGN_OVERRIDE_NO_MATCH", message: `${where}: replace find ${JSON.stringify(r.find.slice(0, 80))} matches nothing`, ref, actionable: true });
      continue;
    }
    out = r.all ? out.split(r.find).join(r.replace) : out.replace(r.find, () => r.replace);
  }
  return out;
}

const stripQ = (s: string) => s.split("?")[0];
const entryKeys = (e: Json) => [String(e.href ?? e.src ?? ""), String(e.original ?? "")].filter(Boolean).map(stripQ);
const matches = (e: Json, needle: string) => entryKeys(e).some((k) => k.includes(stripQ(needle)));

function listOps(list: Json[], ops: { add?: Json[]; remove?: string[]; order?: string[] }, kind: "href" | "src", setId: string | undefined): Json[] {
  let out = [...list];
  for (const a of ops.add ?? []) {
    const sets = a.sets as string[] | undefined;
    if (sets && (!setId || !sets.includes(setId))) continue;
    const { after, before, sets: _s, ...entry } = a as Json & { after?: string; before?: string; sets?: string[] };
    const item: Json = { ...entry, original: String(entry.original ?? `override:${entry[kind]}`) };
    if (out.some((e) => e[kind] === item[kind])) continue;
    let at = out.length;
    if (before) {
      const i = out.findIndex((e) => matches(e, before));
      if (i >= 0) at = i;
    } else if (after) {
      const i = out.findIndex((e) => matches(e, after));
      if (i >= 0) at = i + 1;
    }
    out.splice(at, 0, item);
  }
  for (const r of ops.remove ?? []) out = out.filter((e) => !matches(e, r));
  if (ops.order?.length) {
    const first: Json[] = [];
    for (const o of ops.order) for (const e of out) if (!first.includes(e) && matches(e, o)) first.push(e);
    // ordered entries take the slots of the matched ones, in the given order; others stay where they were
    const slots = out.map((e, i) => (first.includes(e) ? i : -1)).filter((i) => i >= 0);
    const res = [...out];
    slots.forEach((slot, k) => (res[slot] = first[k]));
    out = res;
  }
  return out;
}

const PLACEHOLDER_GIF = "data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** `<img … data-src="X" … src="X">` (src resolved to the lazy source) -> src = placeholder. Returns [html, count]. */
export function restoreLazySrc(html: string, placeholder = PLACEHOLDER_GIF): [string, number] {
  let n = 0;
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const ds = /\sdata-src="([^"]*)"/i.exec(tag)?.[1];
    const src = /\ssrc="([^"]*)"/i.exec(tag)?.[1];
    if (!ds || src === undefined || src.startsWith("data:") || src.includes("{{")) return tag;
    if (stripQ(src).replace(/&amp;/g, "&") !== stripQ(ds).replace(/&amp;/g, "&") && src.replace(/&amp;/g, "&") !== ds.replace(/&amp;/g, "&")) return tag;
    n++;
    return tag.replace(/(\s)src="[^"]*"/i, (_m, sp: string) => `${sp}src="${placeholder}"`);
  });
  return [out, n];
}

/** Most common `data:` src of lazy images in the mined templates (the theme's own placeholder). */
function detectPlaceholder(components: Json[]): string | undefined {
  const count = new Map<string, number>();
  for (const c of components)
    for (const m of String(c.template ?? "").matchAll(/<img\b[^>]*\ssrc="(data:[^"]+)"[^>]*\sdata-src=/gi)) count.set(m[1], (count.get(m[1]) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

export interface ApplyResult extends DesignDocs {
  applied: string[];
  issues: Issue[];
}

/**
 * Merge overrides over the mined design (pure, deterministic: same inputs → same output). Order: components
 * (template, templateReplace, props, propsPatch, fields) → lazy-image rule → pages → asset sets (assets.json, then
 * scripts.json rules) → site.css appended LAST to every stylesheet list.
 */
export function applyOverrides(base: DesignDocs, ov: DesignOverrides): ApplyResult {
  const issues: Issue[] = [];
  const applied: string[] = [];
  const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
  const manifest = clone(base.manifest);
  const components = clone(base.components);
  const templates = clone(base.templates);
  const layout = clone(base.layout);

  // ---- components
  for (const id of Object.keys(ov.components).sort()) {
    const o = ov.components[id];
    const ref = `design/overrides/components/${id}.json`;
    let c = components.find((x) => x.id === id);
    if (!c) {
      if (!o.create || o.template === undefined || !o.kind) {
        issues.push({ severity: "error", code: "DESIGN_OVERRIDE_UNKNOWN_COMPONENT", message: `${ref}: no mined component "${id}" (set create: true with template + kind to add one)`, ref, actionable: true });
        continue;
      }
      c = { id, name: o.name ?? id, selector: o.selector ?? "", kind: o.kind, template: o.template, props: [], exampleHtml: "", exampleProps: {}, source: "heuristic", instances: 0, pages: [], locales: [], verified: true };
      components.push(c);
      const list = (manifest.components ??= []) as Json[];
      if (!list.some((x) => x.id === id)) list.push({ id, file: `components/${id}.json`, kind: o.kind, ...(o.ccmType ? { ccmType: o.ccmType } : {}) });
    }
    if (o.template !== undefined) c.template = o.template;
    if (o.templateReplace?.length) c.template = replaceAll(String(c.template), o.templateReplace, `${ref} templateReplace`, issues, ref);
    if (o.props) c.props = clone(o.props);
    if (o.propsPatch) {
      let props = (c.props as Json[] | undefined) ?? [];
      for (const r of o.propsPatch.remove ?? []) props = props.filter((p) => p.name !== r);
      for (const [name, patch] of Object.entries(o.propsPatch.set ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const p = props.find((x) => x.name === name);
        if (!p) {
          issues.push({ severity: "error", code: "DESIGN_OVERRIDE_NO_MATCH", message: `${ref}: propsPatch.set: component ${id} has no prop "${name}"`, ref, actionable: true });
          continue;
        }
        Object.assign(p, patch);
      }
      for (const a of o.propsPatch.add ?? []) if (!props.some((p) => p.name === a.name)) props.push(clone(a));
      c.props = props;
    }
    for (const k of ["name", "selector", "kind", "ccmType", "variantOf"] as const) if (o[k] !== undefined) c[k] = o[k];
    if (o.exampleProps) c.exampleProps = { ...((c.exampleProps as Json) ?? {}), ...o.exampleProps };
    if (o.instanceProps) {
      const ip = ((c.instanceProps as Record<string, Json>) ??= {});
      for (const [k, v] of Object.entries(o.instanceProps)) ip[k] = { ...(ip[k] ?? {}), ...v };
    }
    c.overridden = true;
    // reproducibility re-check: the patched template must still render the canonical instance's original markup
    if (typeof c.exampleHtml === "string" && c.exampleHtml && (o.template !== undefined || o.templateReplace?.length || o.props || o.propsPatch || o.exampleProps)) {
      let ok = false;
      try {
        ok = normalizeHtml(renderTemplate(String(c.template), c.exampleProps ?? {})) === normalizeHtml(c.exampleHtml);
      } catch {
        ok = false;
      }
      c.verified = ok;
    }
    const ml = (manifest.components as Json[] | undefined)?.find((x) => x.id === id);
    if (ml && o.kind) ml.kind = o.kind;
    applied.push(`component:${id}`);
  }

  // ---- lazy images (assets.json images.keepRawLazySrc)
  const keep = ov.assets?.images?.keepRawLazySrc;
  if (keep) {
    const ph = ov.assets?.images?.placeholder ?? detectPlaceholder(components) ?? PLACEHOLDER_GIF;
    let total = 0;
    for (const c of components) {
      if (Array.isArray(keep) && !keep.includes(String(c.id))) continue;
      const [t, n] = restoreLazySrc(String(c.template), ph);
      if (n) {
        c.template = t;
        total += n;
        if (typeof c.exampleHtml === "string" && c.exampleHtml)
          try {
            c.verified = normalizeHtml(renderTemplate(t, c.exampleProps ?? {})) === normalizeHtml(c.exampleHtml);
          } catch {
            c.verified = false;
          }
      }
    }
    applied.push(`images:keepRawLazySrc(${total})`);
    if (!total) issues.push({ severity: "warning", code: "DESIGN_OVERRIDE_NO_MATCH", message: "assets.json images.keepRawLazySrc: no resolved lazy <img> found in the selected templates", ref: "design/overrides/assets.json" });
  }

  // ---- pages
  const pages = (manifest.pages ??= {}) as Record<string, Json>;
  for (const path of Object.keys(ov.pages).sort()) {
    const o = ov.pages[path];
    const ref = `design/overrides/pages.json#${path}`;
    const pg = (pages[path] ??= { locale: manifest.defaultLocale ?? "en", components: {} });
    for (const k of ["contentType", "bodyClass", "assetSet", "layoutVariant"] as const) if (o[k] !== undefined) pg[k] = o[k];
    if (o.components) pg.components = { ...((pg.components as Json) ?? {}), ...o.components };
    if (o.template) pg.template = clone(o.template);
    if (o.slotsInsert?.length || o.slotsRemove?.length || o.wrapperReplace?.length) {
      let t = pg.template as { slots: Json[]; wrapperHtml?: string } | undefined;
      if (!t) {
        const ct = templates.find((x) => x.contentType === (pg.contentType ?? o.contentType));
        if (!ct) {
          issues.push({ severity: "error", code: "DESIGN_OVERRIDE_NO_MATCH", message: `${ref}: page has no template and no content-type template to copy`, ref, actionable: true });
          continue;
        }
        t = { slots: clone((ct.slots as Json[]) ?? []), ...(ct.wrapperHtml ? { wrapperHtml: String(ct.wrapperHtml) } : {}) };
      }
      for (const r of o.slotsRemove ?? []) t.slots = t.slots.filter((s) => s.component !== r);
      for (const ins of o.slotsInsert ?? []) {
        let at = t.slots.length;
        if (ins.before) {
          const i = t.slots.findIndex((s) => s.component === ins.before);
          if (i >= 0) at = i;
          else issues.push({ severity: "warning", code: "DESIGN_OVERRIDE_NO_MATCH", message: `${ref}: slotsInsert before "${ins.before}" not found — appended`, ref });
        } else if (ins.after) {
          const i = t.slots.findIndex((s) => s.component === ins.after);
          if (i >= 0) at = i + 1;
          else issues.push({ severity: "warning", code: "DESIGN_OVERRIDE_NO_MATCH", message: `${ref}: slotsInsert after "${ins.after}" not found — appended`, ref });
        }
        t.slots.splice(at, 0, clone(ins.slot));
      }
      if (o.wrapperReplace?.length && t.wrapperHtml !== undefined) t.wrapperHtml = replaceAll(t.wrapperHtml, o.wrapperReplace, `${ref} wrapperReplace`, issues, ref);
      pg.template = t;
    }
    for (const s of ((pg.template as { slots?: Json[] } | undefined)?.slots ?? []) as Json[])
      if (!components.some((c) => c.id === s.component) && s.component !== "richText")
        issues.push({ severity: "warning", code: "DESIGN_OVERRIDE_UNKNOWN_COMPONENT", message: `${ref}: slot component "${String(s.component)}" is not a design component`, ref });
    applied.push(`page:${path}`);
  }

  // ---- asset sets
  const sets = (manifest.assetSets ?? {}) as Record<string, { stylesheets?: Json[]; scripts?: Json[] }>;
  const a = ov.assets;
  const applyLists = (setId: string | undefined, holder: { stylesheets?: Json[]; scripts?: Json[] }, topLevel: boolean) => {
    if (a?.stylesheets && (!a.stylesheets.sets || (setId && a.stylesheets.sets.includes(setId)))) {
      const cur = topLevel ? ((holder.stylesheets as unknown as string[]) ?? []).map((h) => ({ href: h })) : (holder.stylesheets ?? []);
      const next = listOps(cur, a.stylesheets as never, "href", setId);
      holder.stylesheets = (topLevel ? next.map((e) => e.href) : next) as Json[];
    }
    if (a?.scripts && (!a.scripts.sets || (setId && a.scripts.sets.includes(setId)))) holder.scripts = listOps(holder.scripts ?? [], a.scripts as never, "src", setId);
  };
  if (a?.stylesheets || a?.scripts) {
    for (const id of Object.keys(sets).sort()) applyLists(id, sets[id], false);
    applyLists(undefined, manifest as never, true);
    applied.push("assets");
  }
  // scripts.json rules
  const rules = ov.scripts ?? {};
  const ruleKeys = Object.keys(rules).sort();
  if (ruleKeys.length) {
    const excluded = ((manifest.excluded ??= []) as Json[]);
    const applyRules = (list: Json[] | undefined): Json[] | undefined => {
      if (!list) return list;
      let out: Json[] = [];
      for (const e of list) {
        const key = ruleKeys.find((k) => matches(e, k));
        const r = key ? rules[key] : undefined;
        if (!r) {
          out.push(e);
          continue;
        }
        if (r.exclude || r.stub) {
          if (!excluded.some((x) => x.original === (e.original ?? e.src))) excluded.push({ original: String(e.original ?? e.src), reason: `override scripts.json${r.stub ? " (stub)" : ""}${r.note ? `: ${r.note}` : ""}`, ...(e.placement ? { placement: e.placement } : {}) });
          if (r.stub && !list.some((x) => x.role === "tracker-stub")) out.push({ src: "scripts/tracker-stub.js", placement: e.placement ?? "head", original: "tracker-stub", role: "tracker-stub" });
          continue;
        }
        out.push({ ...e, ...(r.placement ? { placement: r.placement } : {}), ...(r.role ? { role: r.role } : {}) });
      }
      const ordered = out.map((e, i) => ({ e, i, o: rules[ruleKeys.find((k) => matches(e, k)) ?? ""]?.order }));
      if (ordered.some((x) => x.o !== undefined)) {
        // entries with an `order` are sorted among themselves into the slots they occupy
        const slots = ordered.filter((x) => x.o !== undefined);
        const sorted = [...slots].sort((x, y) => x.o! - y.o! || x.i - y.i);
        out = ordered.map((x) => x.e);
        slots.forEach((s, k) => (out[s.i] = sorted[k].e));
      }
      return out;
    };
    for (const id of Object.keys(sets).sort()) sets[id].scripts = applyRules(sets[id].scripts);
    manifest.scripts = applyRules(manifest.scripts as Json[] | undefined);
    applied.push("scripts");
  }

  // ---- site.css: last in every stylesheet list
  if (ov.siteCss !== undefined) {
    for (const id of Object.keys(sets).sort()) {
      const l = (sets[id].stylesheets ??= []).filter((e) => e.href !== SITE_CSS_HREF);
      l.push({ href: SITE_CSS_HREF, original: "design/overrides/site.css", media: "all", role: "theme" });
      sets[id].stylesheets = l;
    }
    const top = ((manifest.stylesheets as string[] | undefined) ?? []).filter((h) => h !== SITE_CSS_HREF);
    top.push(SITE_CSS_HREF);
    manifest.stylesheets = top;
    applied.push("site.css");
  }
  if (applied.length) manifest.overrides = { applied, hash: overridesHash(ov) };
  return { manifest, components, templates, layout, applied, issues };
}

export function overridesHash(ov: DesignOverrides): string {
  return createHash("sha256").update(JSON.stringify(ov)).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------ workspace I/O

const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

/** Write the pristine mined design to design/base/ (input of every later override merge). */
export async function writeDesignBase(ws: Workspace, docs: DesignDocs): Promise<string[]> {
  const out: string[] = [];
  const root = ws.path(BASE_DIR);
  await rm(root, { recursive: true, force: true });
  const put = async (rel: string, data: unknown) => {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, json(data));
    out.push(`${BASE_DIR}/${rel}`);
  };
  await put("manifest.json", docs.manifest);
  for (const c of docs.components) await put(`components/${String(c.id)}.json`, c);
  for (const t of docs.templates) await put(`templates/${String(t.contentType)}.json`, t);
  if (docs.layout) await put("layouts/default.json", docs.layout);
  return out;
}

async function readDocs(dir: string): Promise<DesignDocs | undefined> {
  const mp = join(dir, "manifest.json");
  if (!(await exists(mp))) return undefined;
  const manifest = JSON.parse(await readFile(mp, "utf8")) as Json;
  const read = async (rel: string) => JSON.parse(await readFile(join(dir, rel), "utf8")) as Json;
  const components: Json[] = [];
  for (const c of (manifest.components as Json[] | undefined) ?? []) if (await exists(join(dir, String(c.file)))) components.push(await read(String(c.file)));
  const templates: Json[] = [];
  for (const t of (manifest.templates as Json[] | undefined) ?? []) if (await exists(join(dir, String(t.file)))) templates.push(await read(String(t.file)));
  const lf = ((manifest.layouts as Json[] | undefined) ?? [])[0]?.file;
  const layout = lf && (await exists(join(dir, String(lf)))) ? await read(String(lf)) : undefined;
  return { manifest, components, templates, layout };
}

/** Strip the merge markers so a design/ written before the base existed can serve as the base. */
function unmerged(d: DesignDocs): DesignDocs {
  const manifest = { ...d.manifest };
  delete manifest.overrides;
  return { ...d, manifest, components: d.components.map((c) => { const x = { ...c }; delete x.overridden; return x; }) };
}

export interface ApplyDesignOverridesResult {
  issues: Issue[];
  outputs: string[];
  stats: Record<string, number | string | boolean>;
  /** `design.componentsReproducible` over the MERGED components (overridden templates re-checked) */
  gates: Record<string, { pass: boolean; value: number; threshold: number }>;
}

/**
 * Merge design/overrides over design/base and write design/{manifest.json,components,templates,layouts},
 * design/styles/site-overrides.css and design/overrides-applied.json. With `base` given (design extract), the base is
 * written first; without (fast path) it is read from design/base/ — bootstrapped from the current design/ once when
 * missing (refused if that design/ already carries applied overrides).
 */
export async function applyDesignOverrides(ws: Workspace, opts: { base?: DesignDocs; dryRun?: boolean } = {}): Promise<ApplyDesignOverridesResult> {
  const issues: Issue[] = [];
  const outputs: string[] = [];
  const designDir = ws.path("design");
  let base = opts.base;
  if (base) {
    if (!opts.dryRun) outputs.push(...(await writeDesignBase(ws, base)));
  } else {
    base = await readDocs(ws.path(BASE_DIR));
    if (!base) {
      const cur = await readDocs(designDir);
      if (!cur) throw new Error("design/ has no manifest.json — run `migrate design extract` first");
      if (cur.manifest.overrides) throw new Error("design/base/ is missing but design/manifest.json already has overrides applied — run a full `migrate design extract`");
      base = unmerged(cur);
      if (!opts.dryRun) outputs.push(...(await writeDesignBase(ws, base)));
      issues.push({ severity: "info", code: "DESIGN_BASE_BOOTSTRAPPED", message: "design/base/ created from the current design/ (no overrides were applied to it)" });
    }
  }
  const { overrides, issues: readIssues, files } = await readOverrides(designDir);
  issues.push(...readIssues);
  const res = applyOverrides(base, overrides);
  issues.push(...res.issues);
  if (!opts.dryRun) {
    const put = async (rel: string, data: unknown) => {
      await mkdir(dirname(join(designDir, rel)), { recursive: true });
      await writeFile(join(designDir, rel), json(data));
      outputs.push(`design/${rel}`);
    };
    for (const c of res.components) await put(`components/${String(c.id)}.json`, c);
    for (const t of res.templates) await put(`templates/${String(t.contentType)}.json`, t);
    if (res.layout) await put("layouts/default.json", res.layout);
    await put("manifest.json", res.manifest);
    const cssOut = join(designDir, SITE_CSS_HREF);
    if (overrides.siteCss !== undefined) {
      await mkdir(dirname(cssOut), { recursive: true });
      await copyFile(join(designDir, "overrides", "site.css"), cssOut);
      outputs.push(`design/${SITE_CSS_HREF}`);
    } else await rm(cssOut, { force: true });
    await put("overrides-applied.json", { files, applied: res.applied, hash: overridesHash(overrides), issues: res.issues.concat(readIssues) });
  }
  const unverified = res.components.filter((c) => c.verified === false).map((c) => String(c.id));
  for (const id of unverified.filter((u) => res.components.find((c) => c.id === u)?.overridden))
    issues.push({ severity: "warning", code: "DESIGN_OVERRIDE_NOT_REPRODUCIBLE", message: `component ${id}: the overridden template no longer renders its canonical instance's original markup`, ref: `design/overrides/components/${id}.json` });
  return {
    issues,
    outputs,
    stats: { overrideFiles: files.length, overridesApplied: res.applied.length, overrideErrors: issues.filter((i) => i.severity === "error").length },
    gates: { "design.componentsReproducible": { pass: unverified.length === 0, value: res.components.length - unverified.length, threshold: res.components.length } },
  };
}
