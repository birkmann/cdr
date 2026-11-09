/**
 * design-variant (P4). Codes: COMPONENT_VARIANT, COMPONENT_INSTANCE_DIFFERS, COMPONENT_NOT_REPRODUCIBLE,
 * TEMPLATE_UNKNOWN_COMPONENT.
 *
 * Mining stays deterministic (mine.ts). This handler records the review decisions the miner cannot make, as
 * `design/overrides/components/<id>.json` in W1-B's ComponentOverride schema (@cmp/design):
 *  - merge-as-variant vs keep-separate for a structural variant, with a human-readable name (DeepSeek, skeletons only);
 *  - prop → CCM field binding for props without `ccmField` (rule: exact field-id match; DeepSeek for the rest);
 *  - a slot component the templates reference but design/components lacks → alias of the nearest mined component (rule);
 *  - not reproducible → exact-substring template edits (DeepSeek), accepted only if the design gate improves.
 * Rerun: design-extract (fast path applyOverridesOnly when no re-mining is needed) → frontend-generate.
 * Metric: -(notReproducible·100 + unknownTemplateComponents·10 + undecided variants/props of the task components).
 */
import { ComponentOverride, skeletonOf } from "@harness/mirror-design";
import type { StepReport, Workspace } from "@harness/mirror-core";
import { z } from "zod";
import { nearest } from "../validators/mapping.js";
import type { AttemptRecord, AutofixContext, AutofixTask, Candidate, Handler, Metrics } from "../types.js";
import { contentFree, llmJson, loadPrompt } from "./common.js";

export const DESIGN_VARIANT_CODES = ["COMPONENT_VARIANT", "COMPONENT_INSTANCE_DIFFERS", "COMPONENT_NOT_REPRODUCIBLE", "TEMPLATE_UNKNOWN_COMPONENT"];
const NOTE = "design-variant:";

interface PropDef {
  name: string;
  type: string;
  ccmField?: string;
  inline?: boolean;
  [k: string]: unknown;
}
interface ComponentDoc {
  id: string;
  name?: string;
  kind?: "chrome" | "section" | "document";
  ccmType?: string;
  variantOf?: string;
  template?: string;
  props?: PropDef[];
  exampleHtml?: string;
  instances?: number;
  pages?: string[];
  [k: string]: unknown;
}

async function readJsonOr<T>(ws: Workspace, rel: string, fallback: T): Promise<T> {
  try {
    return await ws.readJson<T>(rel);
  } catch {
    return fallback;
  }
}

async function component(ws: Workspace, id: string): Promise<ComponentDoc | undefined> {
  return (await readJsonOr<ComponentDoc | undefined>(ws, `design/components/${id}.json`, undefined)) ?? (await readJsonOr<ComponentDoc | undefined>(ws, `design/base/components/${id}.json`, undefined));
}

async function componentIds(ws: Workspace): Promise<string[]> {
  return (await ws.list("design/components", ".json")).map((f) => f.split(/[/\\]/).pop()!.replace(/\.json$/, "")).sort();
}

async function override(ws: Workspace, id: string): Promise<ComponentOverride> {
  return readJsonOr<ComponentOverride>(ws, `design/overrides/components/${id}.json`, {} as ComponentOverride);
}

async function ccmFields(ws: Workspace, type?: string): Promise<{ id: string; type: string }[]> {
  if (!type) return [];
  const schema = await readJsonOr<{ contentTypes?: { id: string; fields: { id: string; type: string }[] }[] }>(ws, "ccm/schema/content-types.json", {});
  return (schema.contentTypes?.find((c) => c.id === type)?.fields ?? []).map((f) => ({ id: f.id, type: f.type }));
}

/** prop type ↔ CCM field type compatibility for a binding */
const COMPAT: Record<string, string[]> = {
  text: ["text", "slug", "enum", "date", "number"],
  richText: ["richText"],
  html: ["richText", "text"],
  asset: ["reference"],
  link: ["link"],
  list: ["componentList", "reference"],
  reference: ["reference", "component"],
};

function unbound(c: ComponentDoc | undefined): PropDef[] {
  return (c?.props ?? []).filter((p) => !p.ccmField && !p.inline && !p.valueType);
}

function targetId(t: AutofixTask): string | undefined {
  if (t.code === "TEMPLATE_UNKNOWN_COMPONENT") return /slot component (\S+) not in/.exec(t.message)?.[1];
  return t.ref;
}

async function issuesOf(ws: Workspace, step: string, code: string): Promise<number> {
  const r = await readJsonOr<StepReport | undefined>(ws, `reports/${step}.json`, undefined);
  return r ? r.issues.filter((i) => i.code === code).length : 0;
}

const decided = (o: ComponentOverride) => typeof o.note === "string" && o.note.includes(NOTE);

function mergeOverride(prev: ComponentOverride, add: ComponentOverride): ComponentOverride {
  const set = { ...(prev.propsPatch?.set ?? {}), ...(add.propsPatch?.set ?? {}) };
  const merged: ComponentOverride = { ...prev, ...add };
  if (Object.keys(set).length || prev.propsPatch) merged.propsPatch = { ...(prev.propsPatch ?? {}), ...(add.propsPatch ?? {}), ...(Object.keys(set).length ? { set } : {}) };
  if (prev.templateReplace || add.templateReplace) merged.templateReplace = [...(prev.templateReplace ?? []), ...(add.templateReplace ?? [])];
  if (prev.note && add.note && !prev.note.includes(add.note)) merged.note = `${prev.note} | ${add.note}`;
  return ComponentOverride.parse(merged);
}

const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

// ------------------------------------------------------------------ LLM schemas

export const VariantDecision = z.object({
  decision: z.enum(["variant", "separate"]),
  name: z.string().min(2).max(60),
  reason: z.string().min(1).max(400),
  props: z.array(z.object({ prop: z.string(), ccmField: z.string().nullable(), reason: z.string().max(200).optional() })).max(40).default([]),
});
export type VariantDecision = z.infer<typeof VariantDecision>;

export const TemplateEdits = z.object({
  edits: z.array(z.object({ find: z.string().min(1).max(2000), replace: z.string().max(2000) })).min(1).max(8),
  reason: z.string().min(1).max(400),
});

export function checkVariantDecision(x: unknown, props: PropDef[], fields: { id: string; type: string }[]): VariantDecision {
  const d = VariantDecision.parse(x);
  const names = new Set(props.map((p) => p.name));
  const fids = new Set(fields.map((f) => f.id));
  const errs: string[] = [];
  for (const p of d.props) {
    if (!names.has(p.prop)) errs.push(`unknown prop "${p.prop}" (unbound props: ${[...names].join(", ") || "none"})`);
    if (p.ccmField !== null && !fids.has(p.ccmField)) errs.push(`ccmField "${p.ccmField}" is not a field of the content type (${[...fids].join(", ") || "none"})`);
  }
  if (errs.length) throw new Error(errs.join("; "));
  return d;
}

export function checkTemplateEdits(x: unknown, template: string) {
  const d = TemplateEdits.parse(x);
  let t = template;
  for (const [i, e] of d.edits.entries()) {
    if (!t.includes(e.find)) throw new Error(`edits[${i}].find does not occur in the template (exact substring required)`);
    t = t.replace(e.find, e.replace);
  }
  return d;
}

// ------------------------------------------------------------------ handler

export const designVariantHandler: Handler = {
  id: "design-variant",
  codes: DESIGN_VARIANT_CODES,
  priority: 30,
  groupKey: (t) => targetId(t) ?? t.id,

  async measure(ctx: AutofixContext, tasks: AutofixTask[]): Promise<Metrics> {
    const ws = ctx.ws;
    const notRepro = await issuesOf(ws, "design-extract", "COMPONENT_NOT_REPRODUCIBLE");
    const unknownTpl = await issuesOf(ws, "frontend-generate", "TEMPLATE_UNKNOWN_COMPONENT");
    let undecided = 0;
    for (const id of new Set(tasks.map(targetId).filter((x): x is string => !!x))) {
      const c = await component(ws, id);
      if (!c) continue;
      const o = await override(ws, id);
      if (tasks.some((t) => targetId(t) === id && (t.code === "COMPONENT_VARIANT" || t.code === "COMPONENT_INSTANCE_DIFFERS")) && !decided(o)) undecided++;
      if (c.ccmType && !decided(o)) undecided += unbound(c).length;
    }
    return { primary: 0 - (notRepro * 100 + unknownTpl * 10 + undecided), gates: {}, detail: { notReproducible: notRepro, unknownTemplateComponents: unknownTpl, undecided } };
  },

  async propose(ctx: AutofixContext, tasks: AutofixTask[], previous: AttemptRecord[]): Promise<Candidate[]> {
    const ws = ctx.ws;
    const id = targetId(tasks[0]);
    if (!id) return [];
    const send = !!ctx.site.llm?.sendContent;
    const codes = new Set(tasks.map((t) => t.code));
    const prev = await override(ws, id);
    const fast = { "design-extract": { applyOverridesOnly: true } };
    const out: Candidate[] = [];

    // (1) template references a component design/ lacks → alias of the nearest mined one (rule)
    if (codes.has("TEMPLATE_UNKNOWN_COMPONENT")) {
      const ids = await componentIds(ws);
      if (!ids.includes(id)) {
        const near = nearest(id, ids, 4);
        const src = near ? await component(ws, near) : undefined;
        if (near && src?.template && src.kind) {
          const o = ComponentOverride.parse({ id, create: true, kind: src.kind, template: src.template, props: (src.props ?? []) as never, variantOf: near, name: src.name, ...(src.ccmType ? { ccmType: src.ccmType } : {}), note: `${NOTE} alias of ${near} (template slot referenced ${id})` });
          out.push({ title: `alias ${id} → ${near}`, origin: "rule", rationale: `nearest mined component id to "${id}"`, files: [{ path: `design/overrides/components/${id}.json`, content: json(o) }], rerun: ["design-extract", "frontend-generate"], stepOptions: fast });
        }
      }
      return out;
    }

    const c = await component(ws, id);
    if (!c) return [];
    const fields = await ccmFields(ws, c.ccmType);
    const free = unbound(c);

    // (2) props whose name is a field of the component's content type (rule)
    const ruleSet: Record<string, { ccmField: string }> = {};
    for (const p of free) {
      const f = fields.find((x) => x.id === p.name);
      if (f && (COMPAT[p.type] ?? []).includes(f.type)) ruleSet[p.name] = { ccmField: f.id };
    }
    if (Object.keys(ruleSet).length) {
      const o = mergeOverride(prev, { propsPatch: { set: ruleSet } });
      out.push({ title: `bind ${Object.keys(ruleSet).join(", ")} of ${id} to CCM fields`, origin: "rule", rationale: "prop name = CCM field id of the component's content type", files: [{ path: `design/overrides/components/${id}.json`, content: json(o) }], rerun: ["design-extract", "frontend-generate"], stepOptions: fast });
    }

    // (3) DeepSeek: merge-as-variant vs keep-separate + naming + remaining bindings (skeletons only)
    const base = c.variantOf ? await component(ws, c.variantOf) : undefined;
    const rest = free.filter((p) => !ruleSet[p.name]);
    if ((codes.has("COMPONENT_VARIANT") || codes.has("COMPONENT_INSTANCE_DIFFERS") || rest.length) && !decided(prev) && ctx.llm) {
      const prompt = loadPrompt("design-variant");
      const res = await llmJson(ctx, "design-variant", {
        system: prompt.text,
        schemaId: "design-variant@1",
        user: {
          component: { id: c.id, name: c.name, kind: c.kind, ccmType: c.ccmType, instances: c.instances, pages: c.pages?.length, template: skeletonOf(c.template ?? "", send).slice(0, 6000) },
          base: base ? { id: base.id, name: base.name, template: skeletonOf(base.template ?? "", send).slice(0, 6000) } : undefined,
          issues: tasks.map((t) => ({ code: t.code, message: contentFree(t.message, send) })),
          unboundProps: rest.map((p) => ({ name: p.name, type: p.type })),
          ccmFields: fields,
          previousAttempts: previous.slice(-4).map((a) => ({ title: a.candidate.title, accepted: a.accepted, reason: a.reason })),
        },
        validate: (x) => checkVariantDecision(x, rest, fields),
      });
      if (res) {
        const set: Record<string, { ccmField: string }> = { ...ruleSet };
        for (const p of res.props) if (p.ccmField) set[p.prop] = { ccmField: p.ccmField };
        const add: ComponentOverride = {
          name: res.name,
          ...(res.decision === "variant" && base ? { variantOf: base.id } : {}),
          ...(Object.keys(set).length ? { propsPatch: { set } } : {}),
          note: `${NOTE} ${res.decision === "variant" ? `variant of ${base?.id ?? c.variantOf ?? "?"}` : "kept separate"} — ${res.reason}${res.props.some((p) => !p.ccmField) ? `; instance-bound: ${res.props.filter((p) => !p.ccmField).map((p) => p.prop).join(", ")}` : ""}`.slice(0, 600),
        };
        out.push({ title: `${id}: ${res.decision === "variant" ? `variant of ${base?.id ?? c.variantOf}` : "separate"} "${res.name}"`, origin: "llm", rationale: res.reason, files: [{ path: `design/overrides/components/${id}.json`, content: json(mergeOverride(prev, add)) }], rerun: ["design-extract", "frontend-generate"], stepOptions: fast });
      }
    }

    // (4) not reproducible → exact template edits (DeepSeek). Full design-extract: the gate is computed by the miner.
    if (codes.has("COMPONENT_NOT_REPRODUCIBLE") && c.template && ctx.llm) {
      const prompt = loadPrompt("design-variant");
      const res = await llmJson(ctx, "design-variant", {
        system: prompt.text + "\n\nMODE: template-edits. Answer {\"edits\": [{\"find\": \"<exact substring of template>\", \"replace\": \"…\"}], \"reason\": \"…\"}.",
        schemaId: "design-variant-edits@1",
        user: { mode: "template-edits", component: { id: c.id, kind: c.kind }, template: skeletonOf(c.template, send).slice(0, 8000), original: skeletonOf(c.exampleHtml ?? "", send).slice(0, 8000), issues: tasks.map((t) => contentFree(t.message, send)) },
        validate: (x) => checkTemplateEdits(x, send ? c.template! : skeletonOf(c.template!, false)),
      });
      // edits were computed on the skeleton: only keep those that also match the real template
      const edits = res?.edits.filter((e) => c.template!.includes(e.find));
      if (res && edits?.length) out.push({ title: `${id}: ${edits.length} template edit(s)`, origin: "llm", rationale: res.reason, files: [{ path: `design/overrides/components/${id}.json`, content: json(mergeOverride(prev, { templateReplace: edits, note: `${NOTE} template edits — ${res.reason}`.slice(0, 600) })) }], rerun: ["design-extract", "frontend-generate"] });
    }
    return out;
  },

  async dossier(ctx: AutofixContext, tasks: AutofixTask[]) {
    const id = targetId(tasks[0]);
    const c = id ? await component(ctx.ws, id) : undefined;
    const send = !!ctx.site.llm?.sendContent;
    return {
      component: c ? { id: c.id, kind: c.kind, ccmType: c.ccmType, variantOf: c.variantOf, pages: c.pages, template: skeletonOf(c.template ?? "", send).slice(0, 8000), unboundProps: unbound(c).map((p) => ({ name: p.name, type: p.type })) } : { id, missing: true },
      override: id ? await override(ctx.ws, id) : undefined,
      ccmFields: await ccmFields(ctx.ws, c?.ccmType),
    };
  },
};
