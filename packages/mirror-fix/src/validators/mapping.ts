/**
 * Deterministic mapping validators (P3): the checklist of the former `mapping-reviewer` agent as code.
 * Inputs are structure only (mapping yaml + analysis/inventory.json), never content.
 *
 *   MAP_COVERAGE_GAP          inventory bundle / paragraph type / field neither mapped nor in `ignored` with a reason
 *   MAP_NOT_CAMEL_CASE        type or field id is not camelCase
 *   MAP_FIELD_TYPE_UNKNOWN    field type is not a CCM FieldType
 *   MAP_ALLOWED_TYPE_UNKNOWN  allowedTypes entry is not "asset", "term:<vocabulary>" or a mapped type   (rule fix: nearest id)
 *   MAP_ALLOWED_TYPES_MISSING reference / component / componentList without allowedTypes
 *   MAP_CARDINALITY           componentList with cardinality 1, or cardinality differs from the Drupal field (rule fix)
 *   MAP_TOO_MANY_FIELDS       > 50 fields in one type (Contentful limit, docs/capabilities.md)
 *   MAP_DISPLAY_FIELD_UNKNOWN displayField is not a field of the type
 */
import { FieldType } from "@harness/mirror-core";

export const CONTENTFUL_MAX_FIELDS = 50;

export interface MappingFieldDoc {
  source?: string;
  type?: string;
  cardinality?: number;
  allowedTypes?: string[];
  [k: string]: unknown;
}
export interface MappingTypeDoc {
  kind?: string;
  source?: { drupal?: string; [k: string]: unknown } | string;
  fields?: Record<string, MappingFieldDoc>;
  displayField?: string;
  [k: string]: unknown;
}
export interface MappingDoc {
  contentTypes?: Record<string, MappingTypeDoc>;
  types?: Record<string, MappingTypeDoc>;
  taxonomies?: Record<string, unknown>;
  ignored?: { source: string; reason?: string }[];
  [k: string]: unknown;
}

export interface InventoryField {
  name: string;
  type?: string;
  cardinality?: number;
  translatable?: boolean;
  required?: boolean;
  usagePct?: number;
}
export interface Inventory {
  contentTypes?: { bundle: string; ccmType?: string; fields?: InventoryField[] }[];
  paragraphTypes?: { type: string; ccmType?: string; fields?: InventoryField[] }[];
  vocabularies?: { vid: string }[];
}

/** One structural edit of the mapping yaml. `path` is the yaml key path. */
export type MappingFix =
  | { op: "set"; path: (string | number)[]; value: unknown }
  | { op: "ignore"; source: string; reason: string };

export interface Finding {
  rule: string;
  /** dotted yaml path, e.g. "contentTypes.landingPage.fields.sections.allowedTypes" (or the inventory source for gaps) */
  path: string;
  message: string;
  severity: "error" | "warning";
  /** deterministic fix, when there is exactly one sensible one */
  fix?: MappingFix;
}

const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const FIELD_TYPES = new Set<string>(FieldType.options);

export function typesKey(doc: MappingDoc): "contentTypes" | "types" {
  return doc.contentTypes ? "contentTypes" : "types";
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** the unique closest candidate within maxDist (case-insensitive tie-break), else undefined */
export function nearest(x: string, cands: string[], maxDist = 3): string | undefined {
  const scored = cands.map((c) => ({ c, d: Math.min(levenshtein(x, c), levenshtein(x.toLowerCase(), c.toLowerCase())) })).sort((a, b) => a.d - b.d || a.c.localeCompare(b.c));
  if (!scored.length || scored[0].d > maxDist) return undefined;
  if (scored[1] && scored[1].d === scored[0].d) return undefined;
  return scored[0].c;
}

function srcOf(t: MappingTypeDoc): string | undefined {
  return typeof t.source === "string" ? t.source : t.source?.drupal;
}

export function validateMapping(doc: MappingDoc, inv?: Inventory): Finding[] {
  const out: Finding[] = [];
  const key = typesKey(doc);
  const types = (doc[key] ?? {}) as Record<string, MappingTypeDoc>;
  const typeIds = Object.keys(types);
  const vocabs = new Set([...(inv?.vocabularies ?? []).map((v) => v.vid), ...Object.keys(doc.taxonomies ?? {})]);
  const ignored = new Set((doc.ignored ?? []).filter((i) => i && typeof i.source === "string" && (i.reason ?? "").trim()).map((i) => i.source));

  for (const [tid, t] of Object.entries(types)) {
    const base = `${key}.${tid}`;
    if (!CAMEL.test(tid)) out.push({ rule: "MAP_NOT_CAMEL_CASE", path: base, message: `type id "${tid}" is not camelCase`, severity: "error" });
    const fields = t.fields ?? {};
    const n = Object.keys(fields).length;
    if (n > CONTENTFUL_MAX_FIELDS) out.push({ rule: "MAP_TOO_MANY_FIELDS", path: `${base}.fields`, message: `${n} fields > Contentful limit ${CONTENTFUL_MAX_FIELDS}`, severity: "error" });
    if (t.displayField && !fields[t.displayField]) out.push({ rule: "MAP_DISPLAY_FIELD_UNKNOWN", path: `${base}.displayField`, message: `displayField "${t.displayField}" is not a field of ${tid}`, severity: "warning" });
    for (const [fid, f] of Object.entries(fields)) {
      const fp = `${base}.fields.${fid}`;
      if (!f || typeof f !== "object") continue;
      if (!CAMEL.test(fid)) out.push({ rule: "MAP_NOT_CAMEL_CASE", path: fp, message: `field id "${tid}.${fid}" is not camelCase`, severity: "error" });
      if (f.type !== undefined && !FIELD_TYPES.has(String(f.type))) out.push({ rule: "MAP_FIELD_TYPE_UNKNOWN", path: `${fp}.type`, message: `field type "${f.type}" is not a CCM type (${[...FIELD_TYPES].join(", ")})`, severity: "error" });
      const refy = f.type === "reference" || f.type === "component" || f.type === "componentList";
      if (refy && !(f.allowedTypes ?? []).length) out.push({ rule: "MAP_ALLOWED_TYPES_MISSING", path: `${fp}.allowedTypes`, message: `${f.type} field ${tid}.${fid} has no allowedTypes`, severity: "warning" });
      (f.allowedTypes ?? []).forEach((a, i) => {
        if (a === "asset") return;
        if (a.startsWith("term:")) {
          if (vocabs.size && !vocabs.has(a.slice(5))) {
            const near = nearest(a.slice(5), [...vocabs]);
            out.push({ rule: "MAP_ALLOWED_TYPE_UNKNOWN", path: `${fp}.allowedTypes.${i}`, message: `vocabulary "${a.slice(5)}" in ${tid}.${fid} does not exist`, severity: "error", ...(near ? { fix: { op: "set" as const, path: [key, tid, "fields", fid, "allowedTypes", i], value: `term:${near}` } } : {}) });
          }
          return;
        }
        if (!types[a]) {
          const near = nearest(a, typeIds.filter((x) => !(f.allowedTypes ?? []).includes(x)));
          out.push({ rule: "MAP_ALLOWED_TYPE_UNKNOWN", path: `${fp}.allowedTypes.${i}`, message: `allowedTypes entry "${a}" of ${tid}.${fid} is not a mapped type`, severity: "error", ...(near ? { fix: { op: "set" as const, path: [key, tid, "fields", fid, "allowedTypes", i], value: near } } : {}) });
        }
      });
      if (f.type === "componentList" && f.cardinality === 1)
        out.push({ rule: "MAP_CARDINALITY", path: `${fp}.cardinality`, message: `componentList ${tid}.${fid} has cardinality 1`, severity: "warning", fix: { op: "set", path: [key, tid, "fields", fid, "cardinality"], value: -1 } });
    }
  }

  // coverage + cardinality against the Drupal inventory
  if (inv && key === "contentTypes") {
    const bySource = new Map(Object.entries(types).map(([id, t]) => [srcOf(t), { id, t }]));
    const check = (kind: "node" | "paragraph", bundle: string, fields: InventoryField[] = []) => {
      const src = `${kind}.${bundle}`;
      const m = bySource.get(src);
      if (!m) {
        if (!ignored.has(src)) out.push({ rule: "MAP_COVERAGE_GAP", path: src, message: `${src} is neither mapped nor ignored with a reason`, severity: "error" });
        return;
      }
      const mapped = new Map(Object.entries(m.t.fields ?? {}).map(([fid, f]) => [f.source, { fid, f }]));
      for (const f of fields) {
        const fsrc = `${src}.${f.name}`;
        const mf = mapped.get(f.name);
        if (!mf) {
          if (!ignored.has(fsrc)) out.push({ rule: "MAP_COVERAGE_GAP", path: fsrc, message: `field ${fsrc} (${f.type ?? "?"}) is neither mapped nor ignored with a reason`, severity: "error" });
          continue;
        }
        if (typeof f.cardinality === "number" && typeof mf.f.cardinality === "number" && mf.f.type !== "componentList" && mf.f.type !== "json" && f.cardinality !== mf.f.cardinality)
          out.push({ rule: "MAP_CARDINALITY", path: `contentTypes.${m.id}.fields.${mf.fid}.cardinality`, message: `${m.id}.${mf.fid}: cardinality ${mf.f.cardinality} but Drupal field ${f.name} has ${f.cardinality}`, severity: "warning", fix: { op: "set", path: ["contentTypes", m.id, "fields", mf.fid, "cardinality"], value: f.cardinality } });
      }
    };
    for (const ct of inv.contentTypes ?? []) check("node", ct.bundle, ct.fields);
    for (const pt of inv.paragraphTypes ?? []) check("paragraph", pt.type, pt.fields);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
}
