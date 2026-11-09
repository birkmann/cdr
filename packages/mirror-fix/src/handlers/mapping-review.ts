/**
 * mapping-review (P3, replaces the drupal-analyst / mapping-reviewer agents).
 * Codes: MAPPING_PROPOSED, CCM_FIELD_TYPE, CCM_FIELD_CARDINALITY, CCM_REF_NOT_ALLOWED, RAWHTML_SHARE.
 *
 * Deterministic validators first (validators/mapping.ts + fixes derived from the CCM validation errors); DeepSeek
 * (deepseek-flash, JSON) only decides what they flag without a unique fix. Input = mapping structure + inventory
 * structure, never content. Writes the mapping change (data only) + mapping/review.yaml; rerun ["transform"];
 * metric = -(validator findings + ccm.valid errors).
 */
import { safeId, type StepReport, type Workspace } from "@harness/mirror-core";
import YAML from "yaml";
import { z } from "zod";
import type { AttemptRecord, AutofixContext, AutofixTask, Candidate, Handler, Metrics } from "../types.js";
import { validateMapping, type Finding, type Inventory, type MappingDoc, type MappingFix, typesKey } from "../validators/mapping.js";
import { llmJson, loadPrompt, mainMapping, reviewYaml, sanitizeMessage, type ReviewEntry, type YamlFile } from "./common.js";

export const MAPPING_REVIEW_CODES = ["MAPPING_PROPOSED", "CCM_FIELD_TYPE", "CCM_FIELD_CARDINALITY", "CCM_REF_NOT_ALLOWED", "RAWHTML_SHARE"];
const SET_LEAVES = new Set(["type", "cardinality", "allowedTypes", "kind", "localized", "required"]);

async function readInventory(ws: Workspace): Promise<Inventory | undefined> {
  try {
    return await ws.readJson<Inventory>("analysis/inventory.json");
  } catch {
    return undefined;
  }
}

async function ccmErrors(ws: Workspace): Promise<number> {
  try {
    const r = await ws.readJson<StepReport>("reports/transform.json");
    const v = r.gates?.["ccm.valid"]?.value;
    if (typeof v === "number") return v;
    return r.issues.filter((i) => i.severity === "error" && i.code.startsWith("CCM_")).length;
  } catch {
    return 0;
  }
}

/** ccm/entries/<type>/<safeId(ccmId)>.<lc>.json → type */
async function typeOfEntry(ws: Workspace, ccmId: string): Promise<string | undefined> {
  const want = safeId(ccmId) + ".";
  for (const f of await ws.list("ccm/entries", ".json")) {
    const parts = f.split(/[/\\]/);
    if (parts[parts.length - 1].startsWith(want)) return parts[parts.length - 2];
  }
  return undefined;
}

interface CcmFix {
  fix: MappingFix;
  review: ReviewEntry;
}

/** deterministic fixes derived from CCM validation errors (cardinality, allowedTypes) */
export async function fixesFromCcm(ws: Workspace, doc: MappingDoc, tasks: AutofixTask[]): Promise<{ fixes: CcmFix[]; open: AutofixTask[] }> {
  const key = typesKey(doc);
  const types = (doc[key] ?? {}) as NonNullable<MappingDoc["types"]>;
  const fixes = new Map<string, CcmFix>();
  const open: AutofixTask[] = [];
  for (const t of tasks) {
    if (t.code === "CCM_FIELD_CARDINALITY") {
      const type = /ccm\/entries\/([^/]+)\//.exec(t.ref ?? "")?.[1];
      const fid = /field "([^"]+)"/.exec(t.message)?.[1];
      const f = type && fid ? types[type]?.fields?.[fid] : undefined;
      if (!type || !fid || !f) {
        open.push(t);
        continue;
      }
      const value = /cardinality 1 but value is an array|values, max/.test(t.message) ? -1 : /expects an array/.test(t.message) ? 1 : undefined;
      if (value === undefined || f.cardinality === value) {
        open.push(t);
        continue;
      }
      const path = [key, type, "fields", fid, "cardinality"];
      fixes.set(path.join("."), { fix: { op: "set", path, value }, review: { path: path.join("."), decision: "set", value, reason: `CCM_FIELD_CARDINALITY: values are ${value === -1 ? "lists" : "single"}`, origin: "rule" } });
    } else if (t.code === "CCM_REF_NOT_ALLOWED") {
      const m = /^(.+)\(([^)]+)\)\.([A-Za-z0-9_]+): entry "[^"]*" has type "([^"]+)"/.exec(t.message);
      if (!m) {
        open.push(t);
        continue;
      }
      const [, ccmId, , fid, refType] = m;
      const type = await typeOfEntry(ws, ccmId);
      const f = type ? types[type]?.fields?.[fid] : undefined;
      if (!type || !f || !types[refType]) {
        open.push(t);
        continue;
      }
      const path = [key, type, "fields", fid, "allowedTypes"];
      const prev = fixes.get(path.join("."));
      const cur = (prev?.fix.op === "set" ? (prev.fix.value as string[]) : undefined) ?? [...(f.allowedTypes ?? [])];
      if (cur.includes(refType)) continue;
      const value = [...cur, refType];
      fixes.set(path.join("."), { fix: { op: "set", path, value }, review: { path: path.join("."), decision: "set", value, reason: `CCM_REF_NOT_ALLOWED: entries of type ${refType} are referenced from ${type}.${fid}`, origin: "rule" } });
    } else if (t.code !== "MAPPING_PROPOSED") open.push(t);
  }
  return { fixes: [...fixes.values()], open };
}

export function applyFixes(y: YamlFile, fixes: MappingFix[]): string {
  const doc = y.doc.clone();
  for (const f of fixes) {
    if (f.op === "set") doc.setIn(f.path, f.value);
    else {
      if (!doc.has("ignored")) doc.set("ignored", doc.createNode([]));
      doc.addIn(["ignored"], doc.createNode({ source: f.source, reason: f.reason }));
    }
  }
  // lineWidth 0: keep one-line flow maps (the mapping files use one field per line)
  return doc.toString({ lineWidth: 0 });
}

// ------------------------------------------------------------------ LLM decision schema

export const MappingDecisions = z.object({
  decisions: z
    .array(
      z.object({
        path: z.string().min(1),
        decision: z.enum(["set", "skip", "keep"]),
        value: z.unknown().optional(),
        reason: z.string().min(1).max(400),
      }),
    )
    .max(60),
});
export type MappingDecisions = z.infer<typeof MappingDecisions>;

/** Validate decisions against the mapping (paths exist, leaves allowed, values well-typed). Throws with a message the model can act on. */
export function checkDecisions(x: unknown, doc: MappingDoc, gaps: Set<string>): MappingDecisions {
  const d = MappingDecisions.parse(x);
  const key = typesKey(doc);
  const types = (doc[key] ?? {}) as NonNullable<MappingDoc["types"]>;
  const typeIds = new Set(Object.keys(types));
  const errs: string[] = [];
  for (const [i, dec] of d.decisions.entries()) {
    if (dec.decision === "skip") {
      if (!gaps.has(dec.path)) errs.push(`decisions[${i}]: skip only for the listed coverage gaps, not "${dec.path}"`);
      continue;
    }
    if (dec.decision === "keep") continue;
    const parts = dec.path.split(".");
    const leaf = parts[parts.length - 1];
    if (parts[0] !== key || !typeIds.has(parts[1]) || !SET_LEAVES.has(leaf)) {
      errs.push(`decisions[${i}]: path must be ${key}.<type>[.fields.<field>].<${[...SET_LEAVES].join("|")}>, got "${dec.path}"`);
      continue;
    }
    if (parts.length === 5 && (parts[2] !== "fields" || !types[parts[1]].fields?.[parts[3]])) {
      errs.push(`decisions[${i}]: unknown field in "${dec.path}"`);
      continue;
    }
    const v = dec.value;
    const ok =
      leaf === "type"
        ? typeof v === "string" && ["text", "richText", "number", "boolean", "date", "reference", "link", "enum", "json", "slug", "component", "componentList"].includes(v)
        : leaf === "cardinality"
          ? Number.isInteger(v) && ((v as number) === -1 || (v as number) >= 1)
          : leaf === "allowedTypes"
            ? Array.isArray(v) && v.every((a) => typeof a === "string" && (a === "asset" || a.startsWith("term:") || typeIds.has(a)))
            : leaf === "kind"
              ? ["document", "component", "item"].includes(String(v))
              : typeof v === "boolean";
    if (!ok) errs.push(`decisions[${i}]: invalid value ${JSON.stringify(v)} for ${leaf}`);
  }
  if (errs.length) throw new Error(errs.join("; "));
  return d;
}

function decisionFixes(d: MappingDecisions): { fixes: MappingFix[]; review: ReviewEntry[] } {
  const fixes: MappingFix[] = [];
  const review: ReviewEntry[] = [];
  for (const dec of d.decisions) {
    if (dec.decision === "set") fixes.push({ op: "set", path: dec.path.split("."), value: dec.value });
    if (dec.decision === "skip") fixes.push({ op: "ignore", source: dec.path, reason: `${dec.reason} (autofix mapping-review, llm)` });
    review.push({ path: dec.path, decision: dec.decision, reason: dec.reason, origin: "llm", ...(dec.decision === "set" ? { value: dec.value } : {}) });
  }
  return { fixes, review };
}

function affectedTypes(findings: Finding[], tasks: AutofixTask[], key: string): Set<string> {
  const out = new Set<string>();
  for (const f of findings) {
    const p = f.path.split(".");
    if (p[0] === key) out.add(p[1]);
  }
  for (const t of tasks) {
    const m = /ccm\/entries\/([^/]+)\//.exec(t.ref ?? "");
    if (m) out.add(m[1]);
  }
  return out;
}

/** content-free dossier for the model and for humans */
export async function mappingDossier(ctx: AutofixContext, tasks: AutofixTask[]) {
  const y = await mainMapping(ctx.ws, ctx.site.source.adapter);
  if (!y) return undefined;
  const doc = y.data as MappingDoc;
  const inv = await readInventory(ctx.ws);
  const findings = validateMapping(doc, inv);
  const { fixes, open } = await fixesFromCcm(ctx.ws, doc, tasks);
  const key = typesKey(doc);
  const types = (doc[key] ?? {}) as NonNullable<MappingDoc["types"]>;
  const send = !!ctx.site.llm?.sendContent;
  const aff = affectedTypes(findings, open, key);
  const gaps = findings.filter((f) => f.rule === "MAP_COVERAGE_GAP").map((f) => f.path);
  const bundles = new Set(gaps.map((g) => g.split(".").slice(0, 2).join(".")));
  return {
    mappingFile: y.rel,
    typesKey: key,
    findings: findings.map(({ rule, path, message, severity, fix }) => ({ rule, path, message, severity, ruleFix: !!fix })),
    ruleFixesFromCcm: fixes.map((f) => f.review),
    ccmIssues: open.map((t) => ({ code: t.code, ref: t.ref, message: sanitizeMessage(t.message, send) })),
    types: Object.fromEntries(
      [...aff].filter((t) => types[t]).map((t) => [t, { kind: types[t].kind, source: types[t].source, fields: Object.fromEntries(Object.entries(types[t].fields ?? {}).map(([fid, f]) => [fid, { type: f.type, cardinality: f.cardinality, allowedTypes: f.allowedTypes, source: f.source, sourceType: f.sourceType, transform: f.transform }])) }]),
    ),
    typeIds: Object.keys(types),
    inventory: inv
      ? {
          contentTypes: (inv.contentTypes ?? []).filter((c) => bundles.has(`node.${c.bundle}`) || aff.has(c.ccmType ?? "")).map((c) => ({ bundle: c.bundle, ccmType: c.ccmType, fields: (c.fields ?? []).map(({ name, type, cardinality, translatable, required, usagePct }) => ({ name, type, cardinality, translatable, required, usagePct })) })),
          paragraphTypes: (inv.paragraphTypes ?? []).filter((p) => bundles.has(`paragraph.${p.type}`) || aff.has(p.ccmType ?? "")).map((p) => ({ type: p.type, ccmType: p.ccmType, fields: (p.fields ?? []).map(({ name, type, usagePct }) => ({ name, type, usagePct })) })),
          vocabularies: (inv.vocabularies ?? []).map((v) => v.vid),
        }
      : undefined,
    capabilities: {
      target: "contentful",
      maxFieldsPerType: 50,
      notes: ["rich text is a JSON document; tables/iframes/scripts become rawHtml (share must stay < 5 %)", "paragraphs become separate component entries (component/componentList + allowedTypes)", "taxonomy terms: reference with allowedTypes term:<vocabulary>", "media collapses into asset references (allowedTypes [asset])"],
    },
  };
}

export const mappingReviewHandler: Handler = {
  id: "mapping-review",
  codes: MAPPING_REVIEW_CODES,
  priority: 5,
  groupKey: (t) => (t.code === "RAWHTML_SHARE" ? "rawhtml" : "mapping"),

  async measure(ctx: AutofixContext): Promise<Metrics> {
    const y = await mainMapping(ctx.ws, ctx.site.source.adapter);
    const inv = await readInventory(ctx.ws);
    const findings = y ? validateMapping(y.data as MappingDoc, inv) : [];
    const errors = await ccmErrors(ctx.ws);
    return { primary: 0 - (findings.length + errors), gates: {}, detail: { findings: findings.length, ccmErrors: errors, rules: [...new Set(findings.map((f) => f.rule))] } };
  },

  async propose(ctx: AutofixContext, tasks: AutofixTask[], previous: AttemptRecord[]): Promise<Candidate[]> {
    if (tasks.every((t) => t.code === "RAWHTML_SHARE")) return []; // decision for a human (HTML field vs transform), dossier lists it
    const y = await mainMapping(ctx.ws, ctx.site.source.adapter);
    if (!y) return [];
    const doc = y.data as MappingDoc;
    const inv = await readInventory(ctx.ws);
    const findings = validateMapping(doc, inv);

    const ruleFixes: MappingFix[] = [];
    const ruleReview: ReviewEntry[] = [];
    for (const f of findings)
      if (f.fix) {
        ruleFixes.push(f.fix);
        ruleReview.push({ path: f.path, decision: "set", value: f.fix.op === "set" ? f.fix.value : undefined, reason: `${f.rule}: ${f.message}`, origin: "rule" });
      }
    // CCM-derived fixes on top of the validator fixes (a fixed typo may already allow the referenced type)
    const patched = ruleFixes.length ? (YAML.parse(applyFixes(y, ruleFixes)) as MappingDoc) : doc;
    const fromCcm = await fixesFromCcm(ctx.ws, patched, tasks);
    for (const c of fromCcm.fixes) {
      ruleFixes.push(c.fix);
      ruleReview.push(c.review);
    }
    const candidates: Candidate[] = [];
    const mk = async (title: string, fixes: MappingFix[], review: ReviewEntry[], origin: "rule" | "llm", rationale: string): Promise<Candidate> => ({
      title,
      rationale,
      origin,
      files: [
        { path: y.rel, content: applyFixes(y, fixes) },
        { path: "mapping/review.yaml", content: await reviewYaml(ctx.ws, review) },
      ],
      rerun: ["transform"],
    });
    if (ruleFixes.length) candidates.push(await mk(`mapping rules: ${ruleReview.map((r) => r.path).slice(0, 4).join(", ")}${ruleReview.length > 4 ? ` (+${ruleReview.length - 4})` : ""}`, ruleFixes, ruleReview, "rule", "deterministic validators (unique fix)"));

    // what the rules could not settle → DeepSeek
    const needLlm = findings.filter((f) => !f.fix);
    if ((needLlm.length || fromCcm.open.length) && ctx.llm) {
      const dossier = await mappingDossier(ctx, tasks);
      const gaps = new Set(needLlm.filter((f) => f.rule === "MAP_COVERAGE_GAP").map((f) => f.path));
      const prompt = loadPrompt("mapping-review");
      const res = await llmJson(ctx, "mapping-review", {
        system: prompt.text,
        user: { ...dossier, findings: dossier?.findings.filter((f) => !f.ruleFix), previousAttempts: previous.slice(-6).map((a) => ({ title: a.candidate.title, accepted: a.accepted, reason: a.reason })) },
        schemaId: "mapping-review@1",
        validate: (x) => checkDecisions(x, doc, gaps),
      });
      if (res && res.decisions.some((d) => d.decision !== "keep")) {
        const { fixes, review } = decisionFixes(res);
        candidates.push(await mk(`mapping review (llm): ${res.decisions.filter((d) => d.decision !== "keep").map((d) => `${d.decision} ${d.path}`).slice(0, 3).join(", ")}`, [...ruleFixes, ...fixes], [...ruleReview, ...review], "llm", res.decisions.map((d) => `${d.path}: ${d.reason}`).join("; ").slice(0, 1000)));
      }
    }
    return candidates;
  },

  dossier: mappingDossier,
};
