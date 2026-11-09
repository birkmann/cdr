/**
 * Optional LLM refinement of mined components (MIGRATION_PLAN.md §10.1). Structure-only by default: the model sees the
 * DOM skeleton (template with every static text node replaced by "…"), never page text unless site.llm.sendContent.
 * It may only rename the component (name/description); ids, templates and props stay deterministic.
 * Any failure (no client, network, invalid JSON) falls back silently to the heuristic result.
 */
import { tryLlmJson, type Issue, type StepContext } from "@harness/mirror-core";
import type { ComponentDef } from "./mine.js";

export function skeletonOf(template: string, sendContent: boolean): string {
  if (sendContent) return template;
  return template.replace(/>([^<]+)</g, (all, txt: string) => {
    const t = txt.trim();
    if (!t || t.startsWith("{{")) return all;
    return txt.replace(t, "…").replace(/^/, ">").concat("<");
  }).replace(/(alt|title|aria-label)="(?!\{\{)[^"]*"/g, '$1="…"');
}

export async function refineWithLlm(ctx: StepContext, components: ComponentDef[]): Promise<{ refined: number; issues: Issue[] }> {
  const issues: Issue[] = [];
  if (!ctx.llm) return { refined: 0, issues };
  const sendContent = ctx.site.llm?.sendContent ?? false;
  let refined = 0;
  for (const c of components) {
    const res = await tryLlmJson<{ name: string; description?: string }>(
      ctx.llm,
      {
        step: "design-extract",
        temperature: 0,
        messages: [
          { role: "system", content: "You name UI components mined from a website. Reply with JSON {\"name\": string (2-4 words, Title case), \"description\": string (one sentence)}. Do not invent props." },
          { role: "user", content: JSON.stringify({ id: c.id, kind: c.kind, ccmType: c.ccmType, props: c.props.map((p) => `${p.name}:${p.type}`), skeleton: skeletonOf(c.template, sendContent).slice(0, 6000) }) },
        ],
      },
      (x) => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" && (x as { name: string }).name.length < 60 ? (x as { name: string; description?: string }) : undefined),
      (e) => issues.push({ severity: "info", code: "LLM_FALLBACK", message: `component ${c.id}: ${e.message} — heuristic name kept`, ref: c.id }),
    );
    if (!res) continue;
    c.name = res.name;
    if (res.description) (c as ComponentDef & { description?: string }).description = res.description;
    c.source = "llm";
    refined++;
  }
  ctx.log.info(`llm refinement: ${refined}/${components.length} component(s) renamed (sendContent=${sendContent})`);
  return { refined, issues };
}
