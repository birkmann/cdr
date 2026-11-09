/**
 * CCM reading + validation (gate "ccm.valid", MIGRATION_PLAN.md §8).
 *
 * validateCcm(ws) checks, for every file under ccm/:
 *  1. JSON parses and matches its Zod schema (ccm.ts)                         → CCM_INVALID_JSON / CCM_INVALID_FILE
 *  2. schema sanity (duplicate types/fields, unknown allowedTypes, displayField) → CCM_SCHEMA_*
 *  3. entries: type exists, locale known, required fields present, value shapes match FieldDef,
 *     cardinality, unknown fields, duplicate (ccmId, locale), duplicate path per locale, canonical file path
 *  4. referential integrity: every Reference anywhere (fields, rich text, nav, settings, term parents) points to an
 *     existing entry / asset / term, and typed reference fields respect `allowedTypes`  → CCM_DANGLING_REF / CCM_REF_NOT_ALLOWED
 *  5. locales (exactly one default, fallbacks exist), redirects, collections (type exists)
 * `ok` = no error-severity issues.
 */
import {
  Asset,
  CcmSchemaFile,
  Collection,
  Entry,
  LinkValue,
  Locale,
  Navigation,
  Redirect,
  Reference,
  RichTextDocSchema,
  SiteSettings,
  Taxonomy,
  type ContentType,
  type FieldDef,
  type NavItem,
} from "./ccm.js";
import type { Issue } from "./contracts.js";
import { Workspace } from "./workspace.js";
import type { z } from "zod";

export interface CcmBundle {
  schema: CcmSchemaFile;
  entries: Entry[];
  assets: Asset[];
  taxonomies: Taxonomy[];
  navigation: Navigation[];
  redirects: Redirect[];
  locales: Locale[];
  collections: Collection[];
  settings: SiteSettings | undefined;
}

export interface CcmValidationResult {
  ok: boolean;
  issues: Issue[];
  stats: Record<string, number>;
}

type Loaded<T> = { file: string; data: T };

interface LoadResult {
  bundle: CcmBundle;
  entryFiles: Loaded<Entry>[];
  issues: Issue[];
  files: number;
}

function zodMessage(e: z.ZodError): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ") + (e.issues.length > 5 ? `; … ${e.issues.length - 5} more` : "");
}

async function loadAll(ws: Workspace): Promise<LoadResult> {
  const issues: Issue[] = [];
  let files = 0;
  const read = async <T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> => {
    files++;
    let raw: unknown;
    try {
      raw = JSON.parse(await ws.readText(file));
    } catch (e) {
      issues.push({ severity: "error", code: "CCM_INVALID_JSON", message: `cannot parse JSON: ${(e as Error).message}`, ref: file, actionable: true });
      return undefined;
    }
    const res = schema.safeParse(raw);
    if (!res.success) {
      issues.push({ severity: "error", code: "CCM_INVALID_FILE", message: zodMessage(res.error), ref: file, actionable: true });
      return undefined;
    }
    return res.data;
  };
  const readMany = async <T>(dir: string, schema: z.ZodType<T>): Promise<Loaded<T>[]> => {
    const out: Loaded<T>[] = [];
    for (const f of await ws.list(dir, ".json")) {
      const d = await read(f, schema);
      if (d !== undefined) out.push({ file: f, data: d });
    }
    return out;
  };

  let schema: CcmSchemaFile = { contentTypes: [] };
  if (await ws.exists(Workspace.SCHEMA_PATH)) {
    schema = (await read(Workspace.SCHEMA_PATH, CcmSchemaFile)) ?? schema;
  } else {
    issues.push({ severity: "error", code: "CCM_MISSING_SCHEMA", message: `${Workspace.SCHEMA_PATH} not found (run transform)`, ref: Workspace.SCHEMA_PATH, actionable: true });
  }
  // other files in ccm/schema are unexpected but harmless
  for (const f of await ws.list("ccm/schema", ".json")) {
    if (f !== Workspace.SCHEMA_PATH) issues.push({ severity: "warning", code: "CCM_UNEXPECTED_FILE", message: "unexpected file in ccm/schema", ref: f });
  }

  let locales: Locale[] = [];
  if (await ws.exists(Workspace.LOCALES_PATH)) locales = (await read(Workspace.LOCALES_PATH, Locale.array())) ?? [];
  else issues.push({ severity: "error", code: "CCM_MISSING_LOCALES", message: `${Workspace.LOCALES_PATH} not found`, ref: Workspace.LOCALES_PATH, actionable: true });

  let redirects: Redirect[] = [];
  if (await ws.exists(Workspace.REDIRECTS_PATH)) redirects = (await read(Workspace.REDIRECTS_PATH, Redirect.array())) ?? [];

  let settings: SiteSettings | undefined;
  if (await ws.exists(Workspace.SETTINGS_PATH)) settings = await read(Workspace.SETTINGS_PATH, SiteSettings);
  else issues.push({ severity: "warning", code: "CCM_MISSING_SETTINGS", message: `${Workspace.SETTINGS_PATH} not found`, ref: Workspace.SETTINGS_PATH });

  const entryFiles = await readMany("ccm/entries", Entry);
  const assets = await readMany("ccm/assets", Asset);
  const taxonomies = await readMany("ccm/taxonomies", Taxonomy);
  const navigation = await readMany("ccm/navigation", Navigation);
  const collections = await readMany("ccm/collections", Collection);

  return {
    bundle: {
      schema,
      entries: entryFiles.map((e) => e.data),
      assets: assets.map((a) => a.data),
      taxonomies: taxonomies.map((t) => t.data),
      navigation: navigation.map((n) => n.data),
      redirects,
      locales,
      collections: collections.map((c) => c.data),
      settings,
    },
    entryFiles,
    issues,
    files,
  };
}

export class CcmReadError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`CCM is invalid (${issues.length} file errors): ${issues.slice(0, 3).map((i) => `${i.ref}: ${i.message}`).join(" | ")}`);
    this.name = "CcmReadError";
  }
}

/**
 * Read the whole ccm/ directory into a bundle (Zod-parsed, defaults applied).
 * strict (default): throws CcmReadError if any file fails to parse/validate. Non-strict: skips invalid files.
 * Does NOT run cross-file checks — use validateCcm for the gate.
 */
export async function readCcm(ws: Workspace, opts: { strict?: boolean } = {}): Promise<CcmBundle> {
  const { bundle, issues } = await loadAll(ws);
  const fileErrors = issues.filter((i) => i.severity === "error" && (i.code === "CCM_INVALID_JSON" || i.code === "CCM_INVALID_FILE" || i.code === "CCM_MISSING_SCHEMA"));
  if ((opts.strict ?? true) && fileErrors.length) throw new CcmReadError(fileErrors);
  return bundle;
}

// ------------------------------------------------------------------ helpers

const REF_KINDS = new Set(["entry", "asset", "term"]);
function isReference(x: unknown): x is Reference {
  return !!x && typeof x === "object" && !Array.isArray(x) && REF_KINDS.has((x as Reference).kind) && typeof (x as Reference).id === "string";
}

/** Collect every Reference-shaped object nested anywhere in a value, with a dotted path. */
export function collectReferences(value: unknown, path = ""): { path: string; ref: Reference }[] {
  const out: { path: string; ref: Reference }[] = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") {
      if (isReference(v)) out.push({ path: p, ref: v });
      for (const [k, x] of Object.entries(v)) if (x && typeof x === "object") walk(x, p ? `${p}.${k}` : k);
    }
  };
  walk(value, path);
  return out;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object" && (v as { type?: string }).type === "doc") return !((v as { children?: unknown[] }).children?.length);
  return false;
}

/** Check one (non-array) value against a field type. Returns an error message or undefined. */
function checkScalar(def: FieldDef, v: unknown): string | undefined {
  switch (def.type) {
    case "text":
    case "slug":
      return typeof v === "string" ? undefined : `expected string, got ${typeof v}`;
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? undefined : `expected number, got ${typeof v}`;
    case "boolean":
      return typeof v === "boolean" ? undefined : `expected boolean, got ${typeof v}`;
    case "date":
      return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? undefined : `expected ISO date string, got ${JSON.stringify(v)?.slice(0, 40)}`;
    case "enum":
      if (typeof v !== "string") return `expected enum string, got ${typeof v}`;
      return def.options && !def.options.includes(v) ? `value "${v}" not in options [${def.options.join(", ")}]` : undefined;
    case "richText": {
      const r = RichTextDocSchema.safeParse(v);
      return r.success ? undefined : `invalid rich text: ${zodMessage(r.error)}`;
    }
    case "link": {
      const r = LinkValue.safeParse(v);
      if (!r.success) return `invalid link: ${zodMessage(r.error)}`;
      return r.data.href || r.data.ref ? undefined : "link needs href or ref";
    }
    case "reference":
      return isReference(v) ? undefined : "expected Reference {kind, id}";
    case "component":
    case "componentList":
      if (!isReference(v)) return "expected Reference {kind:'entry', id} to a component entry";
      return v.kind === "entry" ? undefined : `component reference must be kind "entry", got "${v.kind}"`;
    case "json":
      return undefined;
  }
}

interface Index {
  types: Map<string, ContentType>;
  entryTypes: Map<string, string>; // ccmId -> type
  entryLocales: Map<string, Set<string>>;
  assets: Set<string>;
  terms: Map<string, string>; // term ccmId -> taxonomy id
  taxonomies: Set<string>;
}

function checkRef(ref: Reference, idx: Index, where: string, issues: Issue[], allowed?: string[]): void {
  if (ref.kind === "entry") {
    const t = idx.entryTypes.get(ref.id);
    if (!t) {
      issues.push({ severity: "error", code: "CCM_DANGLING_REF", message: `${where}: entry "${ref.id}" does not exist`, ref: ref.id, actionable: true });
      return;
    }
    const typeAllowed = allowed?.filter((a) => a !== "asset" && !a.startsWith("term:"));
    if (typeAllowed && typeAllowed.length && !typeAllowed.includes(t)) {
      issues.push({ severity: "error", code: "CCM_REF_NOT_ALLOWED", message: `${where}: entry "${ref.id}" has type "${t}", allowed [${typeAllowed.join(", ")}]`, ref: ref.id, actionable: true });
    } else if (allowed && allowed.length && !typeAllowed?.length) {
      issues.push({ severity: "error", code: "CCM_REF_NOT_ALLOWED", message: `${where}: entry reference not allowed (allowed: [${allowed.join(", ")}])`, ref: ref.id, actionable: true });
    }
  } else if (ref.kind === "asset") {
    if (!idx.assets.has(ref.id)) {
      issues.push({ severity: "error", code: "CCM_DANGLING_REF", message: `${where}: asset "${ref.id}" does not exist`, ref: ref.id, actionable: true });
    } else if (allowed && allowed.length && !allowed.includes("asset")) {
      issues.push({ severity: "error", code: "CCM_REF_NOT_ALLOWED", message: `${where}: asset reference not allowed (allowed: [${allowed.join(", ")}])`, ref: ref.id, actionable: true });
    }
  } else {
    const tax = idx.terms.get(ref.id);
    if (!tax) {
      issues.push({ severity: "error", code: "CCM_DANGLING_REF", message: `${where}: term "${ref.id}" does not exist`, ref: ref.id, actionable: true });
    } else if (allowed && allowed.length) {
      const termAllowed = allowed.filter((a) => a.startsWith("term:"));
      if (!termAllowed.includes(`term:${tax}`)) {
        issues.push({ severity: "error", code: "CCM_REF_NOT_ALLOWED", message: `${where}: term "${ref.id}" of taxonomy "${tax}" not allowed (allowed: [${allowed.join(", ")}])`, ref: ref.id, actionable: true });
      }
    }
  }
}

function walkNav(items: NavItem[], cb: (i: NavItem, p: string) => void, p = "items"): void {
  items.forEach((it, n) => {
    cb(it, `${p}[${n}]`);
    walkNav(it.children ?? [], cb, `${p}[${n}].children`);
  });
}

// ------------------------------------------------------------------ main

export async function validateCcm(ws: Workspace): Promise<CcmValidationResult> {
  const { bundle: b, entryFiles, issues, files } = await loadAll(ws);

  // ---- schema
  const types = new Map<string, ContentType>();
  for (const ct of b.schema.contentTypes) {
    if (types.has(ct.id)) issues.push({ severity: "error", code: "CCM_SCHEMA_DUPLICATE_TYPE", message: `content type "${ct.id}" defined twice`, ref: ct.id, actionable: true });
    types.set(ct.id, ct);
    const fids = new Set<string>();
    for (const f of ct.fields) {
      if (fids.has(f.id)) issues.push({ severity: "error", code: "CCM_SCHEMA_DUPLICATE_FIELD", message: `field "${f.id}" defined twice in "${ct.id}"`, ref: `${ct.id}.${f.id}`, actionable: true });
      fids.add(f.id);
      if (f.type === "enum" && !f.options?.length) issues.push({ severity: "warning", code: "CCM_SCHEMA_ENUM_NO_OPTIONS", message: `enum field without options`, ref: `${ct.id}.${f.id}` });
    }
    if (ct.displayField && !fids.has(ct.displayField)) issues.push({ severity: "warning", code: "CCM_SCHEMA_DISPLAY_FIELD", message: `displayField "${ct.displayField}" is not a field of "${ct.id}"`, ref: ct.id });
  }
  const taxonomies = new Set(b.taxonomies.map((t) => t.id));
  for (const ct of b.schema.contentTypes) {
    for (const f of ct.fields) {
      for (const a of f.allowedTypes ?? []) {
        const ok = a === "asset" || (a.startsWith("term:") ? taxonomies.has(a.slice(5)) : types.has(a));
        if (!ok) issues.push({ severity: "warning", code: "CCM_SCHEMA_UNKNOWN_ALLOWED_TYPE", message: `allowedTypes entry "${a}" does not exist`, ref: `${ct.id}.${f.id}` });
      }
    }
  }

  // ---- locales
  const localeCodes = new Set(b.locales.map((l) => l.code));
  if (b.locales.length) {
    const defaults = b.locales.filter((l) => l.default);
    if (defaults.length !== 1) issues.push({ severity: "error", code: "CCM_LOCALE_DEFAULT", message: `expected exactly one default locale, found ${defaults.length}`, ref: Workspace.LOCALES_PATH, actionable: true });
    const seen = new Set<string>();
    for (const l of b.locales) {
      if (seen.has(l.code)) issues.push({ severity: "error", code: "CCM_LOCALE_DUPLICATE", message: `locale "${l.code}" listed twice`, ref: Workspace.LOCALES_PATH, actionable: true });
      seen.add(l.code);
      if (l.fallback && !localeCodes.has(l.fallback)) issues.push({ severity: "error", code: "CCM_LOCALE_FALLBACK", message: `locale "${l.code}" falls back to unknown "${l.fallback}"`, ref: Workspace.LOCALES_PATH, actionable: true });
    }
  }

  // ---- index
  const idx: Index = { types, entryTypes: new Map(), entryLocales: new Map(), assets: new Set(), terms: new Map(), taxonomies };
  for (const { data: e, file } of entryFiles) {
    const prev = idx.entryTypes.get(e.ccmId);
    if (prev && prev !== e.type) issues.push({ severity: "error", code: "CCM_ENTRY_TYPE_CONFLICT", message: `ccmId "${e.ccmId}" has types "${prev}" and "${e.type}" in different locales`, ref: file, actionable: true });
    idx.entryTypes.set(e.ccmId, e.type);
    const ls = idx.entryLocales.get(e.ccmId) ?? new Set();
    if (ls.has(e.locale)) issues.push({ severity: "error", code: "CCM_DUPLICATE_ENTRY", message: `duplicate entry ${e.ccmId} (${e.locale})`, ref: file, actionable: true });
    ls.add(e.locale);
    idx.entryLocales.set(e.ccmId, ls);
  }
  for (const a of b.assets) {
    if (idx.assets.has(a.ccmId)) issues.push({ severity: "error", code: "CCM_DUPLICATE_ASSET", message: `duplicate asset ${a.ccmId}`, ref: a.ccmId, actionable: true });
    idx.assets.add(a.ccmId);
    if (a.alt) for (const loc of Object.keys(a.alt)) if (localeCodes.size && !localeCodes.has(loc)) issues.push({ severity: "warning", code: "CCM_UNKNOWN_LOCALE", message: `asset alt for unknown locale "${loc}"`, ref: a.ccmId });
  }
  for (const t of b.taxonomies) {
    for (const term of t.terms) {
      if (idx.terms.has(term.ccmId)) issues.push({ severity: "error", code: "CCM_DUPLICATE_TERM", message: `duplicate term ${term.ccmId}`, ref: term.ccmId, actionable: true });
      idx.terms.set(term.ccmId, t.id);
    }
  }

  // ---- entries
  const paths = new Map<string, string>(); // locale|path -> ccmId
  let refCount = 0;
  for (const { data: e, file } of entryFiles) {
    const expected = ws.entryPath(e.type, e.ccmId, e.locale);
    if (file !== expected) issues.push({ severity: "warning", code: "CCM_PATH_MISMATCH", message: `entry file should be at ${expected}`, ref: file });
    if (localeCodes.size && !localeCodes.has(e.locale)) issues.push({ severity: "error", code: "CCM_UNKNOWN_LOCALE", message: `entry locale "${e.locale}" not in ${Workspace.LOCALES_PATH}`, ref: file, actionable: true });
    if (e.path !== undefined) {
      const key = `${e.locale}|${e.path}`;
      const other = paths.get(key);
      if (other && other !== e.ccmId) issues.push({ severity: "error", code: "CCM_DUPLICATE_PATH", message: `path "${e.path}" (${e.locale}) used by ${other} and ${e.ccmId}`, ref: file, actionable: true });
      paths.set(key, e.ccmId);
      if (!e.path.startsWith("/")) issues.push({ severity: "warning", code: "CCM_PATH_FORMAT", message: `path "${e.path}" should start with "/"`, ref: file });
    }
    const ct = types.get(e.type);
    if (!ct) {
      issues.push({ severity: "error", code: "CCM_UNKNOWN_TYPE", message: `entry type "${e.type}" not in schema`, ref: file, actionable: true });
    } else {
      if (ct.kind === "document" && e.path === undefined) issues.push({ severity: "warning", code: "CCM_DOCUMENT_NO_PATH", message: `document entry of type "${ct.id}" has no path`, ref: file });
      const defs = new Map(ct.fields.map((f) => [f.id, f]));
      for (const f of ct.fields) {
        const v = e.fields[f.id];
        if (f.required && isEmpty(v)) {
          issues.push({ severity: "error", code: "CCM_REQUIRED_FIELD_MISSING", message: `required field "${f.id}" is empty`, ref: file, actionable: true });
          continue;
        }
        if (v === undefined || v === null) continue;
        if (f.cardinality === 1 && Array.isArray(v) && f.type !== "json" && f.type !== "componentList") {
          issues.push({ severity: "error", code: "CCM_FIELD_CARDINALITY", message: `field "${f.id}" has cardinality 1 but value is an array`, ref: file, actionable: true });
          continue;
        }
        const multi = f.type === "componentList" || (f.cardinality !== 1 && f.type !== "json");
        if (multi && !Array.isArray(v)) {
          issues.push({ severity: "error", code: "CCM_FIELD_CARDINALITY", message: `field "${f.id}" (${f.type}, cardinality ${f.cardinality}) expects an array`, ref: file, actionable: true });
          continue;
        }
        const values = multi ? (v as unknown[]) : [v];
        if (multi && f.cardinality > 1 && values.length > f.cardinality) issues.push({ severity: "error", code: "CCM_FIELD_CARDINALITY", message: `field "${f.id}" has ${values.length} values, max ${f.cardinality}`, ref: file, actionable: true });
        values.forEach((x, i) => {
          const msg = checkScalar(f, x);
          if (msg) issues.push({ severity: "error", code: "CCM_FIELD_TYPE", message: `field "${f.id}"${multi ? `[${i}]` : ""}: ${msg}`, ref: file, actionable: true });
        });
        if (f.type === "reference" || f.type === "component" || f.type === "componentList") {
          for (const x of values) if (isReference(x)) checkRef(x, idx, `${e.ccmId}(${e.locale}).${f.id}`, issues, f.allowedTypes);
        }
      }
      for (const k of Object.keys(e.fields)) {
        if (!defs.has(k)) issues.push({ severity: "warning", code: "CCM_UNKNOWN_FIELD", message: `field "${k}" is not defined on type "${ct.id}"`, ref: file, actionable: true });
      }
    }
    // generic referential integrity (rich text, links, json, nested) — typed reference fields were checked above
    for (const { path, ref } of collectReferences(e.fields)) {
      refCount++;
      const top = path.split(/[.[]/)[0];
      const def = ct?.fields.find((f) => f.id === top);
      if (def && (def.type === "reference" || def.type === "component" || def.type === "componentList") && /^[^.]+(\[\d+\])?$/.test(path)) continue;
      checkRef(ref, idx, `${e.ccmId}(${e.locale}).${path}`, issues);
    }
  }

  // ---- taxonomies (parents)
  for (const t of b.taxonomies) {
    for (const term of t.terms) {
      if (term.parent && !idx.terms.has(term.parent)) issues.push({ severity: "error", code: "CCM_DANGLING_REF", message: `term ${term.ccmId}: parent "${term.parent}" does not exist`, ref: term.parent, actionable: true });
      if (term.parent && !t.hierarchical) issues.push({ severity: "warning", code: "CCM_TERM_PARENT_FLAT", message: `term ${term.ccmId} has a parent but taxonomy "${t.id}" is not hierarchical`, ref: term.ccmId });
    }
  }

  // ---- navigation
  for (const n of b.navigation) {
    walkNav(n.items, (it, p) => {
      if (it.ref) {
        refCount++;
        checkRef(it.ref, idx, `navigation ${n.id}.${p}`, issues);
      }
      if (!it.ref && !it.href) issues.push({ severity: "warning", code: "CCM_NAV_NO_TARGET", message: `navigation ${n.id}.${p} has neither ref nor href`, ref: n.id });
    });
  }

  // ---- settings
  if (b.settings) {
    for (const { path, ref } of collectReferences(b.settings)) {
      refCount++;
      checkRef(ref, idx, `settings.${path}`, issues);
    }
  }

  // ---- collections
  for (const c of b.collections) {
    const ct = types.get(c.type);
    if (!ct) {
      issues.push({ severity: "error", code: "CCM_UNKNOWN_TYPE", message: `collection "${c.id}" queries unknown type "${c.type}"`, ref: c.id, actionable: true });
      continue;
    }
    const known = new Set([...ct.fields.map((f) => f.id), "path", "slug", "locale", "status", "sourceChangedAt", "ccmId"]);
    for (const f of [...c.filters.map((x) => x.field), ...c.sort.map((x) => x.field)]) {
      if (!known.has(f.split(".")[0])) issues.push({ severity: "warning", code: "CCM_COLLECTION_FIELD", message: `collection "${c.id}" uses unknown field "${f}"`, ref: c.id });
    }
  }

  // ---- redirects
  const froms = new Map<string, string>();
  for (const r of b.redirects) {
    if (!r.from.startsWith("/")) issues.push({ severity: "warning", code: "CCM_REDIRECT_FORMAT", message: `redirect from "${r.from}" should start with "/"`, ref: r.from });
    if (r.from === r.to) issues.push({ severity: "error", code: "CCM_REDIRECT_LOOP", message: `redirect ${r.from} points to itself`, ref: r.from, actionable: true });
    const prev = froms.get(r.from);
    if (prev !== undefined && prev !== r.to) issues.push({ severity: "error", code: "CCM_REDIRECT_CONFLICT", message: `redirect ${r.from} → ${prev} and → ${r.to}`, ref: r.from, actionable: true });
    froms.set(r.from, r.to);
  }

  const stats = {
    files,
    contentTypes: b.schema.contentTypes.length,
    entries: b.entries.length,
    entryIds: idx.entryTypes.size,
    assets: b.assets.length,
    taxonomies: b.taxonomies.length,
    terms: idx.terms.size,
    navigation: b.navigation.length,
    redirects: b.redirects.length,
    locales: b.locales.length,
    collections: b.collections.length,
    references: refCount,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
  return { ok: stats.errors === 0, issues, stats };
}
