/**
 * profile-infer (P2, docs/DEEPSEEK_ONLY_PLAN.md §5.3) — owner W1-A.
 *
 * Content lane: server-HTML text that no typed CCM field covers (SECTION_TEXT_UNMAPPED, TEXT_MISSING, …) is recovered by
 * writing paragraph profiles to `mapping/profiles.yaml` (site layer over the theme pack, see source-html profiles.ts).
 *
 * propose():
 *   1. deterministic pre-pass (`inferProfilesIterative`: BEM elements, images, classed anchors, repeated matches, entity
 *      roots for BEM blocks) → candidate origin "rule";
 *   2. DeepSeek (`deepseek-flash`, JSON, step "autofix-profile", schemaId "profile-infer@1") for the groups the rules
 *      leave uncovered. The dossier holds skeletons + selector paths + lengths, NEVER page text. The answer is
 *      validated with the ParagraphProfile Zod schema plus "every selector matches the skeletons"; a failure is retried
 *      once by the client. → candidate origin "llm" (rule pack + LLM slots), only when the simulation shows a gain.
 * Both candidates write `mapping/profiles.yaml` (+ `mapping/html.yaml` field entries with `inferred: true`) and re-run
 * `transform`. measure() = covered-text ratio of the group's paragraph types + the ccm.valid gate.
 */
import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import { validateCcm, type Workspace } from "@harness/mirror-core";
import {
  coverageRatio,
  pageCoverageRatio,
  dom,
  EntityRootSchema,
  inferProfilesIterative,
  loadCoverageInput,
  measureTextCoverage,
  mergeIntoSitePack,
  ParagraphProfileSchema,
  paragraphToType,
  resolveProfileSet,
  simulateCoverage,
  skeletonOf,
  documentDossierParts,
  SLOT_KINDS,
  slotDef,
  SITE_PROFILES_PATH,
  type CoverageAnalysis,
  type CoverageInput,
  type ProfilePack,
  type ToCcmResult,
  type UncoveredElement,
} from "@harness/mirror-capture";
import type { AttemptRecord, AutofixContext, AutofixTask, Candidate, FilePatch, Handler, Metrics } from "../types.js";
import { llmJson, loadPrompt, readYaml } from "./common.js";

export const PROFILE_INFER_CODES = ["SECTION_TEXT_UNMAPPED", "DOCUMENT_TEXT_UNMAPPED", "TEXT_MISSING", "TEXT_SKIPPED", "CCM_UNKNOWN_FIELD", "COMPONENT_TEXT_VARIES"];
export const PROFILE_INFER_SCHEMA_ID = "profile-infer@1";
/** LLM step name (llm-log, stepModels key) */
export const PROFILE_INFER_STEP = "autofix-profile";

// ------------------------------------------------------------------ grouping

/** CCM type id -> Drupal machine name: sectionStatementComponent -> statement_component, entitysliderHero -> entityslider_hero */
export function machineOfType(type: string): string {
  const t = type.startsWith("section") && /^section[A-Z0-9]/.test(type) ? type.slice(7) : type;
  return t
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Za-z])([0-9])/g, "$1_$2")
    .toLowerCase();
}

/** groupKey: paragraph machine name for type-scoped codes, `page:<path>` for page-scoped ones (TEXT_MISSING/SKIPPED). */
export function profileGroupKey(task: AutofixTask): string {
  if (task.code === "SECTION_TEXT_UNMAPPED") {
    const t = /^(\w+) on /.exec(task.message)?.[1];
    if (t) return machineOfType(t);
  }
  if (task.code === "DOCUMENT_TEXT_UNMAPPED") {
    // "document:<type> on <path>: …" (page-level text) | "<ccmType> on <path>: …" (field-wrapper text of a paragraph)
    const t = /^(document:\w+|\w+) on /.exec(task.message)?.[1];
    if (t) return t.startsWith("document:") ? t : machineOfType(t);
  }
  if (task.code === "CCM_UNKNOWN_FIELD") {
    const t = /type "(\w+)"/.exec(task.message)?.[1];
    if (t) return machineOfType(t);
  }
  if (task.code === "COMPONENT_TEXT_VARIES" && task.ref) return machineOfType(task.ref);
  if ((task.code === "TEXT_MISSING" || task.code === "TEXT_SKIPPED") && task.ref) return `page:${task.ref}`;
  return task.ref ? `ref:${task.ref}` : task.code;
}

/** machines (coverage groups) a task set targets; undefined = all groups */
export function targetMachines(a: CoverageAnalysis, tasks: AutofixTask[]): string[] | undefined {
  const keys = [...new Set(tasks.map(profileGroupKey))];
  const out = new Set<string>();
  for (const k of keys) {
    if (k.startsWith("page:")) {
      const path = k.slice(5);
      for (const g of a.coverage.groups) if (g.pages.includes(path) && g.ratio < 1) out.add(g.machine);
      continue;
    }
    // document groups are `document:<ccmType>`; paragraph groups match by machine name or CCM type
    const g = a.coverage.groups.find((x) => x.machine === k || (x.entity !== "document" && machineOfType(x.ccmType) === k));
    if (g) out.add(g.machine);
  }
  if (!out.size) return undefined;
  return [...out].sort();
}

/** pages a task set is about: "<type> on <path>:" (SECTION_TEXT_UNMAPPED), ref path (TEXT_*), else the target groups' pages */
export function taskPages(a: CoverageAnalysis, tasks: AutofixTask[]): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    const m = t.code === "SECTION_TEXT_UNMAPPED" || t.code === "DOCUMENT_TEXT_UNMAPPED" ? /^(?:document:)?\w+ on (\S+?):/.exec(t.message)?.[1] : undefined;
    if (m) out.add(m);
    else if ((t.code === "TEXT_MISSING" || t.code === "TEXT_SKIPPED") && t.ref) out.add(t.ref);
  }
  if (!out.size) {
    const ms = targetMachines(a, tasks);
    for (const g of a.coverage.groups) if (!ms || ms.includes(g.machine)) g.pages.forEach((p) => out.add(p));
  }
  return [...out].sort();
}

// ------------------------------------------------------------------ dossier (no text)

export interface ProfileDossier {
  machine: string;
  ccmType: string;
  entity: string;
  instances: number;
  skeletons: string[];
  existingProfile: unknown;
  mappedFields: string[];
  uncovered: UncoveredElement[];
  slotKinds: string[];
}

export function buildDossier(a: CoverageAnalysis, machine: string, ccm: Pick<ToCcmResult, "schema">, maxInstances = 3): ProfileDossier | undefined {
  const g = a.coverage.groups.find((x) => x.machine === machine);
  if (!g) return undefined;
  const isDoc = g.entity === "document";
  // documents: the whole page is too big → pruned skeleton of the main content around the uncovered elements
  const docParts = isDoc ? documentDossierParts(a, machine, maxInstances) : undefined;
  const skeletons: string[] = docParts?.skeletons ?? [];
  if (!isDoc)
    for (const ins of a.instances.get(machine) ?? []) {
      const s = skeletonOf(ins.root, 5000);
      if (!skeletons.includes(s)) skeletons.push(s);
      if (skeletons.length >= maxInstances) break;
    }
  const ct = ccm.schema.contentTypes.find((t) => t.id === g.ccmType);
  return {
    machine,
    ccmType: g.ccmType,
    entity: g.entity,
    instances: g.instances,
    skeletons,
    existingProfile: (isDoc ? a.ps.documents[g.ccmType] : a.ps.profiles[machine]) ?? {},
    mappedFields: (ct?.fields ?? []).filter((f) => f.id !== "html").map((f) => `${f.id}:${f.type}`),
    uncovered: (docParts?.uncovered ?? g.uncovered).map(({ inField, ...u }) => ({ ...u, ...(inField ? { inField } : {}) })),
    slotKinds: SLOT_KINDS,
  };
}

// ------------------------------------------------------------------ LLM response

export const LlmProfileResponse = z.object({
  profile: ParagraphProfileSchema,
  entityRoots: z.array(EntityRootSchema).optional(),
});
export type LlmProfileResponse = z.infer<typeof LlmProfileResponse>;

/** Zod + structural validation: every selector must match an own element in at least one instance of the machine. */
export function profileValidator(a: CoverageAnalysis, machine: string) {
  const roots = (a.instances.get(machine) ?? []).map((i) => i.root);
  const matchesSomewhere = (sel: string) =>
    roots.some((r) => {
      try {
        return dom.selectAll(sel, r).length > 0;
      } catch {
        return false;
      }
    });
  return (raw: unknown): LlmProfileResponse => {
    const r = LlmProfileResponse.safeParse(raw);
    if (!r.success) throw new Error(`schema: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const bad: string[] = [];
    for (const [id, s] of Object.entries(r.data.profile.slots ?? {})) {
      if (s === null) continue;
      const d = slotDef(s);
      if (!d.parentLink && !matchesSomewhere(d.sel)) bad.push(`slot "${id}": selector ${JSON.stringify(d.sel)} matches nothing in the skeletons`);
    }
    for (const e of r.data.entityRoots ?? []) if (!matchesSomewhere(e.sel)) bad.push(`entityRoot ${JSON.stringify(e.sel)} matches nothing`);
    if (bad.length) throw new Error(bad.join("; "));
    return r.data;
  };
}

/**
 * DeepSeek proposals for the machines the pack still leaves uncovered (largest gap first, at most `maxGroups`).
 * Returns the merged pack and per-machine answers. No client / failures → empty.
 */
export async function llmProfileProposals(
  ctx: Pick<AutofixContext, "llm" | "log" | "site" | "ws" | "repoRoot" | "oldBaseUrl" | "dryRun">,
  analysis: CoverageAnalysis,
  ccm: Pick<ToCcmResult, "schema">,
  machines: string[] | undefined,
  opts: { maxGroups?: number } = {},
): Promise<{ answers: { machine: string; response: LlmProfileResponse }[]; pack: ProfilePack }> {
  const prompt = loadPrompt("profile-infer");
  const groups = analysis.coverage.groups
    .filter((g) => g.machine !== "generic" && g.uncovered.length && (!machines || machines.includes(g.machine)))
    .sort((x, y) => y.totalChars - y.coveredChars - (x.totalChars - x.coveredChars) || x.machine.localeCompare(y.machine))
    .slice(0, opts.maxGroups ?? 4);
  const answers: { machine: string; response: LlmProfileResponse }[] = [];
  let pack: ProfilePack = {};
  for (const g of groups) {
    const dossier = buildDossier(analysis, g.machine, ccm);
    if (!dossier || !dossier.uncovered.length || !dossier.skeletons.length) continue;
    const response = await llmJson(ctx as AutofixContext, "profile", {
      system: prompt.text,
      user: dossier,
      schemaId: PROFILE_INFER_SCHEMA_ID,
      validate: profileValidator(analysis, g.machine),
      maxTokens: 8000,
      effort: "low",
    });
    if (!response) continue;
    answers.push({ machine: g.machine, response });
    pack = mergeIntoSitePack(pack, {
      ...(g.entity === "document" ? { documents: { [g.ccmType]: response.profile } } : { profiles: { [g.machine]: response.profile } }),
      ...(response.entityRoots?.length ? { entityRoots: response.entityRoots } : {}),
    });
  }
  return { answers, pack };
}

// ------------------------------------------------------------------ files

const HEADER = (site: string, theme: string) =>
  `# Paragraph profiles for ${site}: site layer over theme pack "${theme}" (packages/adapters/source-html/src/profiles.ts).\n# Written by autofix profile-infer; review + commit like mapping/html.yaml.\n`;

export function profilesYaml(site: string, theme: string, pack: ProfilePack): string {
  return HEADER(site, theme) + YAML.stringify(pack, { lineWidth: 140 });
}

/** mapping/html.yaml: add `inferred: true` field entries for new slot fields of the touched types (when the file exists). */
export async function htmlYamlPatch(ws: Workspace, ccm: Pick<ToCcmResult, "schema">, pack: ProfilePack): Promise<FilePatch | undefined> {
  const y = await readYaml(ws, "mapping/html.yaml");
  if (!y) return undefined;
  const touched = new Set([...[...Object.keys(pack.profiles ?? {}), ...(pack.entityRoots ?? []).map((r) => r.type)].map((m) => paragraphToType(m)), ...Object.keys(pack.documents ?? {})]);
  // pack-level class fields apply to every section type
  const everyType = !!pack.classFields?.length;
  let changed = false;
  for (const t of ccm.schema.contentTypes) {
    if (!touched.has(t.id) && !everyType) continue;
    for (const f of t.fields) {
      if (!f.sourceMeta?.inferred || y.doc.hasIn(["types", t.id, "fields", f.id])) continue;
      if (!y.doc.hasIn(["types"])) y.doc.setIn(["types"], y.doc.createNode({}));
      if (!y.doc.hasIn(["types", t.id])) y.doc.setIn(["types", t.id], y.doc.createNode({ kind: t.kind, fields: {} }));
      if (!y.doc.hasIn(["types", t.id, "fields"])) y.doc.setIn(["types", t.id, "fields"], y.doc.createNode({}));
      y.doc.setIn(["types", t.id, "fields", f.id], y.doc.createNode({
        type: f.type,
        // same shape as the map step's proposal (analyze.ts), so mapping-review's validators find nothing to fix later
        ...(f.allowedTypes ? { allowedTypes: f.allowedTypes } : {}),
        ...(f.localized ? { localized: true } : {}),
        ...(f.cardinality !== 1 ? { cardinality: f.cardinality } : {}),
        inferred: true,
        ...(f.sourceMeta.selector ? { source: String(f.sourceMeta.selector) } : {}),
      }));
      changed = true;
    }
  }
  return changed ? { path: "mapping/html.yaml", content: y.doc.toString({ lineWidth: 120 }) } : undefined;
}

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// ------------------------------------------------------------------ handler

async function ccmValidGate(ws: Workspace): Promise<boolean> {
  try {
    const r = await ws.readJson<{ gates?: Record<string, { pass: boolean }> }>("reports/transform.json");
    if (r.gates?.["ccm.valid"]) return r.gates["ccm.valid"].pass;
  } catch {
    /* no report: validate directly */
  }
  return (await validateCcm(ws)).ok;
}

/** profile-infer needs the html crawl (source-html adapter); other sources: no-op */
const hasHtmlCrawl = (ws: Workspace) => ws.exists("raw/html/crawl.json");

export async function measureProfileCoverage(ctx: Pick<AutofixContext, "ws" | "site">, tasks: AutofixTask[], input?: CoverageInput): Promise<Metrics> {
  if (!input && !(await hasHtmlCrawl(ctx.ws))) return { primary: 0, gates: { "ccm.valid": await ccmValidGate(ctx.ws) }, detail: { skipped: "no raw/html crawl (profile-infer needs the html adapter)" } };
  const a = await measureTextCoverage(ctx.ws, ctx.site, { input });
  const machines = targetMachines(a, tasks);
  const pages = taskPages(a, tasks);
  const r = pageCoverageRatio(a, pages);
  const grp = coverageRatio(a, machines);
  return {
    primary: r.ratio,
    gates: { "ccm.valid": await ccmValidGate(ctx.ws) },
    detail: {
      machines: machines ?? "all",
      pages,
      totalChars: r.totalChars,
      coveredChars: r.coveredChars,
      groupRatio: grp.ratio,
      siteRatio: a.coverage.ratio,
      uncoveredElements: a.coverage.groups.filter((g) => !machines || machines.includes(g.machine)).reduce((n, g) => n + g.uncovered.length, 0),
      profileSet: a.coverage.profileSet,
    },
  };
}

export async function proposeProfiles(ctx: AutofixContext, tasks: AutofixTask[], previous: AttemptRecord[] = [], opts: { maxLlmGroups?: number } = {}): Promise<Candidate[]> {
  if (!(await hasHtmlCrawl(ctx.ws))) return [];
  const input = await loadCoverageInput(ctx.ws);
  const { set, sitePack } = await resolveProfileSet(ctx.ws, ctx.site, input.crawl);
  const theme = set.themePack;
  const current = await simulateCoverage(input, theme, sitePack, ctx.site.locales);
  const machines = targetMachines(current.analysis, tasks);
  const tried = new Set(previous.map((p) => p.candidate.title));
  const out: Candidate[] = [];
  const pages = taskPages(current.analysis, tasks);
  const ratioOf = (a: CoverageAnalysis) => pageCoverageRatio(a, pages).ratio;
  const before = ratioOf(current.analysis);

  // 1. rule pre-pass (to a fixpoint)
  const rule = await inferProfilesIterative(input, theme, sitePack, { machines, rounds: 3, siteLocales: ctx.site.locales });
  const ruleRatio = ratioOf(rule.analysis);
  const candidateFor = async (pack: ProfilePack, ccm: ToCcmResult, origin: "rule" | "llm", what: string, rationale: string): Promise<Candidate> => {
    const yaml = profilesYaml(ctx.site.site, theme, pack);
    const files: FilePatch[] = [{ path: SITE_PROFILES_PATH, content: yaml }];
    const html = await htmlYamlPatch(ctx.ws, ccm, pack);
    if (html) files.push(html);
    return {
      title: `profile-infer ${origin}: ${what} [${shortHash(yaml)}]`,
      rationale,
      files,
      rerun: ["transform"],
      origin,
    };
  };
  const extras = [rule.classFields.length ? `${rule.classFields.length} class field(s)` : "", rule.flags.length ? `${rule.flags.length} flag(s)` : ""].filter(Boolean).join(", ");
  if ((rule.slots.length || rule.entityRoots.length || rule.classFields.length || rule.flags.length) && ruleRatio > before) {
    const c = await candidateFor(
      rule.pack,
      rule.ccm,
      "rule",
      `${rule.slots.length} slot(s), ${rule.entityRoots.length} entity root(s)${extras ? `, ${extras}` : ""} for ${machines?.join(", ") ?? "all paragraph types"}`,
      `deterministic pre-pass (${rule.rounds.length} round(s)); simulated covered-text ratio ${before} -> ${ruleRatio}`,
    );
    if (!tried.has(c.title)) out.push(c);
  }

  // 2. DeepSeek for what the rules leave uncovered (built on top of the rule pack)
  if (ctx.llm) {
    const base = ruleRatio > before ? rule : { pack: sitePack ?? {}, analysis: current.analysis, ccm: current.ccm };
    const llmMachines = machines && [...new Set([...machines, ...(base === rule ? rule.entityRoots.map((e) => e.type) : [])])];
    const llm = await llmProfileProposals(ctx, base.analysis, base.ccm, llmMachines, { maxGroups: opts.maxLlmGroups });
    if (llm.answers.length) {
      const pack = mergeIntoSitePack(base.pack, llm.pack);
      const sim = await simulateCoverage(input, theme, pack, ctx.site.locales);
      const baseRatio = ratioOf(base.analysis);
      const llmRatio = ratioOf(sim.analysis);
      if (llmRatio > baseRatio) {
        const c = await candidateFor(
          pack,
          sim.ccm,
          "llm",
          `DeepSeek slots for ${llm.answers.map((x) => x.machine).join(", ")}`,
          `DeepSeek (${PROFILE_INFER_SCHEMA_ID}, prompt profile-infer.md ${loadPrompt("profile-infer").sha}) over the rule pack; simulated covered-text ratio ${baseRatio} -> ${llmRatio}`,
        );
        if (!tried.has(c.title)) out.push(c);
      } else ctx.log.info(`profile-infer: DeepSeek proposals for ${llm.answers.map((x) => x.machine).join(", ")} did not improve the simulated coverage (${baseRatio} -> ${llmRatio})`);
    }
  }
  return out;
}

export const profileInferHandler: Handler = {
  id: "profile-infer",
  codes: PROFILE_INFER_CODES,
  priority: 10,
  groupKey: profileGroupKey,
  measure: (ctx, tasks) => measureProfileCoverage(ctx, tasks),
  propose: (ctx, tasks, previous) => proposeProfiles(ctx, tasks, previous),
};
