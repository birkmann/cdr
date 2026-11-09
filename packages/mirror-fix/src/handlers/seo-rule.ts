/**
 * seo-rule. Codes: SEO_DIFF, SEO_RULE_UNRESOLVED, HREFLANG_SELF_MISSING.
 *
 * Head tags the generator could not infer a consistent rule for (generators/nextjs-contentful/src/seo.ts) become
 * explicit rules in `mapping/seo.yaml` (`rules: { "<tag>": SeoRule }`, same rule kinds as the generator:
 * from title|description|canonical|siteName|image, const, perLocale, perType), reviewed + committed like the mapping.
 *
 * Evidence comes from verify/seo.json (old vs new head per page). Values never go to the model: DeepSeek sees, per
 * tag and page, which page value the original equals (title / description / canonical / og:site_name / og:image) and
 * value classes ("A", "B"…); the chosen rule's constant values are filled in locally.
 * Rerun: frontend-generate → build → verify(seo) on the affected URLs. Metric: -(SEO diffs + unresolved tags).
 */
import type { StepReport, Workspace } from "@harness/mirror-core";
import YAML from "yaml";
import { z } from "zod";
import type { AttemptRecord, AutofixContext, AutofixTask, Candidate, Handler, Metrics } from "../types.js";
import { llmJson, loadPrompt } from "./common.js";

export const SEO_RULE_CODES = ["SEO_DIFF", "SEO_RULE_UNRESOLVED", "HREFLANG_SELF_MISSING"];
export const SEO_RULES_PATH = "mapping/seo.yaml";
const RULE_TAG = /^(og|twitter|article):[a-z_:]+$/;

export type SeoRule = { from: "title" | "description" | "canonical" | "siteName" | "image" } | { const: string } | { perLocale: Record<string, string> } | { perType: Record<string, string> };

interface SeoData {
  og?: Record<string, string>;
  twitter?: Record<string, string>;
  title?: string;
  description?: string;
  canonical?: string;
  lang?: string;
}
interface SeoPage {
  path: string;
  skipped?: boolean;
  diffs?: { field: string }[];
  old?: SeoData;
  new?: SeoData;
}

async function seoPages(ws: Workspace): Promise<SeoPage[]> {
  try {
    const d = await ws.readJson<{ details?: { pages?: SeoPage[] } }>("verify/seo.json");
    return d.details?.pages ?? [];
  } catch {
    return [];
  }
}

const tagOf = (d: SeoData | undefined, k: string) => (k.startsWith("twitter:") ? d?.twitter?.[k] : d?.og?.[k]);
const pathOf = (v: string) => {
  try {
    const u = new URL(v, "http://x");
    return u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  } catch {
    return v;
  }
};

/** page → { locale, type } from ccm entries (path match) */
async function pageMeta(ws: Workspace): Promise<Map<string, { locale: string; type: string }>> {
  const out = new Map<string, { locale: string; type: string }>();
  for (const f of await ws.list("ccm/entries", ".json")) {
    try {
      const e = await ws.readJson<{ path?: string; locale: string; type: string }>(f);
      if (e.path && !out.has(e.path)) out.set(e.path, { locale: e.locale, type: e.type });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** tags under consideration: from SEO_DIFF fields (og:/twitter:) and SEO_RULE_UNRESOLVED messages */
export function tagsOf(tasks: AutofixTask[]): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    if (t.code === "SEO_DIFF") {
      const m = /^\S+ ((?:og|twitter|article):[a-z_:]+):/.exec(t.message);
      if (m) out.add(m[1]);
    }
    if (t.code === "SEO_RULE_UNRESOLVED") for (const m of t.message.matchAll(/((?:og|twitter|article):[a-z_:]+)/g)) out.add(m[1]);
  }
  return [...out].filter((k) => RULE_TAG.test(k)).sort();
}

export interface TagEvidence {
  tag: string;
  pages: { path: string; locale?: string; type?: string; present: boolean; cls?: string; equals: string[]; newPresent: boolean }[];
}

/** content-free evidence per tag (value classes + equality with other head values of the same original page) */
export async function evidence(ws: Workspace, tags: string[]): Promise<{ ev: TagEvidence[]; values: Map<string, Map<string, string>> }> {
  const pages = (await seoPages(ws)).filter((p) => !p.skipped && p.old);
  const meta = await pageMeta(ws);
  const values = new Map<string, Map<string, string>>();
  const ev: TagEvidence[] = [];
  for (const tag of tags) {
    const classes = new Map<string, string>();
    const vals = new Map<string, string>();
    const rows: TagEvidence["pages"] = [];
    for (const p of pages) {
      const v = tagOf(p.old, tag);
      const m = meta.get(p.path);
      const equals: string[] = [];
      if (v !== undefined) {
        vals.set(p.path, v);
        if (!classes.has(v)) classes.set(v, String.fromCharCode(65 + (classes.size % 26)) + (classes.size >= 26 ? Math.floor(classes.size / 26) : ""));
        if (v === p.old?.title) equals.push("title");
        if (v === p.old?.description) equals.push("description");
        if (p.old?.canonical && pathOf(v) === pathOf(p.old.canonical)) equals.push("canonical");
        if (v === p.old?.og?.["og:site_name"] && tag !== "og:site_name") equals.push("siteName");
        if (p.old?.og?.["og:image"] && pathOf(v) === pathOf(p.old.og["og:image"]) && tag !== "og:image") equals.push("image");
      }
      rows.push({ path: p.path, locale: m?.locale, type: m?.type, present: v !== undefined, cls: v !== undefined ? classes.get(v) : undefined, equals, newPresent: tagOf(p.new, tag) !== undefined });
    }
    values.set(tag, vals);
    ev.push({ tag, pages: rows });
  }
  return { ev, values };
}

/** deterministic rule when one kind explains every page that has the tag */
export function ruleFor(e: TagEvidence, values: Map<string, string>): SeoRule | undefined {
  const have = e.pages.filter((p) => p.present);
  if (!have.length) return undefined;
  for (const from of ["title", "description", "canonical", "siteName", "image"] as const) if (have.every((p) => p.equals.includes(from))) return { from };
  const vs = [...new Set(have.map((p) => values.get(p.path)!))];
  if (vs.length === 1 && have.length === e.pages.length) return { const: vs[0] };
  const byLocale = materialize("perLocale", e, values);
  if (byLocale && have.length === e.pages.length) return byLocale;
  return undefined;
}

function materialize(kind: "perLocale" | "perType" | "const", e: TagEvidence, values: Map<string, string>): SeoRule | undefined {
  const have = e.pages.filter((p) => p.present);
  if (kind === "const") {
    const vs = [...new Set(have.map((p) => values.get(p.path)!))];
    return vs.length ? { const: vs.sort()[0] } : undefined;
  }
  const keyOf = (p: TagEvidence["pages"][number]) => (kind === "perLocale" ? p.locale : p.type);
  const m: Record<string, string> = {};
  for (const p of have) {
    const k = keyOf(p);
    if (!k) return undefined;
    const v = values.get(p.path)!;
    if (m[k] !== undefined && m[k] !== v) return undefined;
    m[k] = v;
  }
  return Object.keys(m).length ? (kind === "perLocale" ? { perLocale: m } : { perType: m }) : undefined;
}

export const SeoChoice = z.object({
  rules: z.array(z.object({ tag: z.string(), kind: z.enum(["title", "description", "canonical", "siteName", "image", "const", "perLocale", "perType", "none"]), reason: z.string().max(300) })).max(40),
});

async function seoDiffs(ws: Workspace): Promise<number> {
  try {
    const d = await ws.readJson<{ gates?: { diffs?: { value?: number } } }>("verify/seo.json");
    return typeof d.gates?.diffs?.value === "number" ? d.gates.diffs.value : 0;
  } catch {
    return 0;
  }
}

async function unresolvedTags(ws: Workspace): Promise<number> {
  try {
    const r = await ws.readJson<StepReport>("reports/frontend-generate.json");
    const i = r.issues.find((x) => x.code === "SEO_RULE_UNRESOLVED");
    return i ? (i.message.match(/(?:og|twitter|article):[a-z_:]+/g) ?? []).length : 0;
  } catch {
    return 0;
  }
}

async function currentRules(ws: Workspace): Promise<Record<string, SeoRule>> {
  try {
    const y = YAML.parse(await ws.readText(SEO_RULES_PATH)) as { rules?: Record<string, SeoRule> } | null;
    return y?.rules ?? {};
  } catch {
    return {};
  }
}

function seoYaml(rules: Record<string, SeoRule>, reasons: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)));
  return (
    "# Explicit SEO head-tag rules (autofix seo-rule, docs/runbooks/autofix.md); override the rules the generator infers.\n" +
    "# Kinds: {from: title|description|canonical|siteName|image} | {const} | {perLocale: {<lc>: v}} | {perType: {<type>: v}}. Reviewed + committed.\n" +
    YAML.stringify({ version: 1, rules: sorted, reasons: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b))) })
  );
}

export const seoRuleHandler: Handler = {
  id: "seo-rule",
  codes: SEO_RULE_CODES,
  priority: 40,
  groupKey: () => "seo",

  async measure(ctx: AutofixContext): Promise<Metrics> {
    const diffs = await seoDiffs(ctx.ws);
    const unresolved = await unresolvedTags(ctx.ws);
    return { primary: 0 - (diffs + unresolved), gates: {}, detail: { seoDiffs: diffs, unresolvedTags: unresolved } };
  },

  async propose(ctx: AutofixContext, tasks: AutofixTask[], previous: AttemptRecord[]): Promise<Candidate[]> {
    const tags = tagsOf(tasks);
    if (!tags.length || !ctx.newBaseUrl) return [];
    const existing = await currentRules(ctx.ws);
    const todo = tags.filter((t) => !existing[t]);
    if (!todo.length) return [];
    const { ev, values } = await evidence(ctx.ws, todo);
    const urls = [...new Set(tasks.filter((t) => t.ref?.startsWith("/")).map((t) => t.ref!))];
    const rerun = { rerun: ["frontend-generate", "build"] as Candidate["rerun"], verify: { checks: ["seo"], ...(urls.length ? { urls } : {}) } };
    const out: Candidate[] = [];

    const ruleSet: Record<string, SeoRule> = {};
    const reasons: Record<string, string> = {};
    for (const e of ev) {
      const r = ruleFor(e, values.get(e.tag)!);
      if (r) {
        ruleSet[e.tag] = r;
        reasons[e.tag] = `rule: ${Object.keys(r)[0]} explains every original page`;
      }
    }
    if (Object.keys(ruleSet).length) out.push({ title: `seo rules ${Object.keys(ruleSet).join(", ")}`, origin: "rule", rationale: "one rule kind reproduces the tag on every compared page", files: [{ path: SEO_RULES_PATH, content: seoYaml({ ...existing, ...ruleSet }, reasons) }], ...rerun });

    const rest = ev.filter((e) => !ruleSet[e.tag]);
    if (rest.length && ctx.llm) {
      const prompt = loadPrompt("seo-rule");
      const res = await llmJson(ctx, "seo-rule", {
        system: prompt.text,
        schemaId: "seo-rule@1",
        user: { tags: rest, previousAttempts: previous.slice(-4).map((a) => ({ title: a.candidate.title, accepted: a.accepted, reason: a.reason })) },
        validate: (x) => {
          const d = SeoChoice.parse(x);
          const bad = d.rules.filter((r) => !rest.some((e) => e.tag === r.tag));
          if (bad.length) throw new Error(`unknown tags: ${bad.map((b) => b.tag).join(", ")} (only: ${rest.map((e) => e.tag).join(", ")})`);
          return d;
        },
      });
      if (res) {
        const llmRules: Record<string, SeoRule> = {};
        const llmReasons: Record<string, string> = { ...reasons };
        for (const c of res.rules) {
          if (c.kind === "none") continue;
          const e = rest.find((x) => x.tag === c.tag)!;
          const r = c.kind === "const" || c.kind === "perLocale" || c.kind === "perType" ? materialize(c.kind, e, values.get(c.tag)!) : { from: c.kind };
          if (r) {
            llmRules[c.tag] = r as SeoRule;
            llmReasons[c.tag] = `llm: ${c.reason}`;
          }
        }
        if (Object.keys(llmRules).length) out.push({ title: `seo rules (llm) ${Object.keys(llmRules).join(", ")}`, origin: "llm", rationale: res.rules.map((r) => `${r.tag}: ${r.kind} — ${r.reason}`).join("; "), files: [{ path: SEO_RULES_PATH, content: seoYaml({ ...existing, ...ruleSet, ...llmRules }, llmReasons) }], ...rerun });
      }
    }
    return out;
  },

  async dossier(ctx: AutofixContext, tasks: AutofixTask[]) {
    const tags = tagsOf(tasks);
    return { tags, evidence: (await evidence(ctx.ws, tags)).ev, rules: await currentRules(ctx.ws), note: "mapping/seo.yaml must be consumed by the generator (frontend-generate) for these rules to take effect" };
  },
};
