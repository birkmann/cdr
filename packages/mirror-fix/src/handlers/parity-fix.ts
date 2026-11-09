/**
 * parity-fix (P5, docs/DEEPSEEK_ONLY_PLAN.md §5.6). Codes: VISUAL_DIFF, BBOX_DIFF, HEIGHT_DIFF. One group per shot
 * (URL × viewport); the metric covers ALL viewports of that URL (a CSS fix at one breakpoint can break another).
 *
 * propose():
 *  1. the text-only diagnosis dossier of the shot (verify/diagnosis/<vp>/<page>.json, written by verify; rebuilt with
 *     diagnoseShot when missing or older than verify/visual.json),
 *  2. deterministic candidates from the classifier (origin "rule"): lazy-src → assets.json keepRawLazySrc,
 *     noscript/extra stylesheet → assets.json remove, missing element → pages.json slotsInsert of the mined component,
 *     extra wrapper inside a prop container → component propsPatch inline, CSS rule only on old → site.css,
 *     proven-unstable region → crawl.mask proposal (sites/<site>.yaml),
 *  3. once every rule candidate was tried (or there is none): deepseek-v4-pro (effort high) → ≤ 3 typed patches in
 *     the design override schema (prompts/parity-fix.md, schemaId parity-fix@1). Patches are validated with the
 *     @cmp/design Zod schemas and mechanically checked (templateReplace.find must occur in the template) before they
 *     become candidates.
 * Patches only ever touch design/overrides/** (and a crawl.mask proposal in sites/<site>.yaml): never pipeline code.
 */
import { readFile, stat } from "node:fs/promises";
import { safeId, type Workspace } from "@harness/mirror-core";
import { AssetsOverride, ComponentOverride, PageOverride, ScriptsOverride, skeletonOf } from "@harness/mirror-design";
import { assetKey, diagnoseShot, launchBrowser, type ParityDossier } from "@harness/mirror-verify";
import YAML from "yaml";
import { z } from "zod";
import type { AttemptRecord, AutofixContext, AutofixTask, Candidate, FilePatch, Handler, Metrics } from "../types.js";
import { llmJson, loadPrompt } from "./common.js";

export const PARITY_FIX_CODES = ["VISUAL_DIFF", "BBOX_DIFF", "HEIGHT_DIFF"];
export const PARITY_MODEL = "deepseek-v4-pro";
const SCHEMA_ID = "parity-fix@1";

type Json = Record<string, any>;

// ------------------------------------------------------------------ task / shot helpers

export interface Shot {
  path: string;
  viewport: string;
}

/** URL + viewport of a visual task (task.data from the loop, else the message prefix "<vp> <path>:"). */
export function shotOf(t: AutofixTask): Shot | undefined {
  const d = (t.data ?? {}) as { url?: string; viewport?: string };
  const m = /^([A-Za-z0-9_-]+)\s+(\/\S*):/.exec(t.message);
  const path = d.url ?? t.ref ?? m?.[2];
  const viewport = d.viewport ?? m?.[1];
  return path && viewport ? { path, viewport } : undefined;
}

async function readJsonOr<T>(ws: Workspace, rel: string, fallback: T): Promise<T> {
  try {
    return await ws.readJson<T>(rel);
  } catch {
    return fallback;
  }
}
async function mtime(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

interface VisualRow {
  viewport: string;
  path: string;
  parity?: number;
  pass?: boolean;
  parityPass?: boolean;
  bboxPass?: boolean;
  heightPass?: boolean;
  bbox?: { maxDelta?: number | string };
  height?: { delta?: number };
  diagnosis?: { file: string; cause: string };
}

/** Shot score in [0, 1]: parity minus small penalties for box / height deltas (so bbox-only fixes count). */
export function shotScore(r: VisualRow | undefined): number {
  if (!r || typeof r.parity !== "number") return 0;
  const bb = r.bbox?.maxDelta === "missing" ? 100 : Number(r.bbox?.maxDelta ?? 0) || 0;
  const hd = Math.abs(Number(r.height?.delta ?? 0)) || 0;
  return r.parity - 0.01 * Math.min(1, bb / 100) - 0.01 * Math.min(1, hd / 100);
}

/**
 * Primary metric of a URL: Σ shot scores over every viewport of the URL, −1 for each OTHER viewport that fails
 * (a fix for one breakpoint must not break another).
 */
export function urlMetric(rows: VisualRow[], shot: Shot): { primary: number; detail: Record<string, unknown> } {
  const mine = rows.filter((r) => r.path === shot.path);
  let primary = 0;
  const detail: Record<string, unknown> = {};
  for (const r of mine) {
    const s = shotScore(r);
    primary += s;
    if (r.viewport !== shot.viewport && r.pass === false) primary -= 1;
    detail[r.viewport] = { parity: r.parity, pass: r.pass, bbox: r.bbox?.maxDelta, dh: r.height?.delta, score: Math.round(s * 1e5) / 1e5 };
  }
  return { primary: Math.round(primary * 1e6) / 1e6, detail };
}

// ------------------------------------------------------------------ design context

interface DesignCtx {
  manifest: Json;
  components: Map<string, Json>;
}

async function loadDesign(ws: Workspace): Promise<DesignCtx> {
  const manifest = await readJsonOr<Json>(ws, "design/manifest.json", {});
  const components = new Map<string, Json>();
  for (const c of (manifest.components ?? []) as Json[]) {
    const doc = await readJsonOr<Json | undefined>(ws, `design/${c.file}`, undefined);
    if (doc) components.set(String(c.id), doc);
  }
  return { manifest, components };
}

/** tag + classes + id of a template's root element */
export function templateRoot(tpl: string): { tag: string; id?: string; cls: string[] } | undefined {
  const m = /^\s*<([a-zA-Z][\w-]*)([^>]*)>/.exec(tpl);
  if (!m) return undefined;
  const attrs = m[2];
  const cls = /\sclass="([^"]*)"/.exec(attrs)?.[1].split(/\s+/).filter((c) => c && !c.includes("{{")) ?? [];
  const id = /\sid="([^"{}]*)"/.exec(attrs)?.[1];
  return { tag: m[1].toLowerCase(), ...(id ? { id } : {}), cls };
}

/** element label "div#x.a.b" → parts */
export function parseLabel(label: string): { tag: string; id?: string; cls: string[] } {
  const m = /^([a-z0-9-]+)(?:#([^.]+))?((?:\.[^.]+)*)$/i.exec(label.trim());
  if (!m) return { tag: label, cls: [] };
  return { tag: m[1].toLowerCase(), ...(m[2] ? { id: m[2] } : {}), cls: (m[3] ?? "").split(".").filter(Boolean) };
}

/** Page template slots as rendered for a path (page template, else content-type template). */
function pageSlots(d: DesignCtx, ws: Workspace, path: string): Promise<{ slots: Json[]; source: "page" | "contentType" | "none"; contentType?: string }> {
  const pg = d.manifest.pages?.[path] as Json | undefined;
  if (pg?.template?.slots) return Promise.resolve({ slots: pg.template.slots, source: "page", contentType: pg.contentType });
  const ct = pg?.contentType as string | undefined;
  if (!ct) return Promise.resolve({ slots: [], source: "none" });
  return readJsonOr<Json>(ws, `design/templates/${ct}.json`, {}).then((t) => ({ slots: (t.slots as Json[]) ?? [], source: "contentType" as const, contentType: ct }));
}

/**
 * The variant family of a component: its base (`variantOf` chain root) and every component that is a variant of that
 * base (e.g. siteFooter + siteFooterV2), each with the POC pages that use it. A fix for one member usually applies to
 * all of them; the accept rule verifies every POC page, so a patch that leaves a sibling broken loses (N5-05 / W2-H).
 */
export function variantFamily(d: DesignCtx, id: string): { base: string; members: { id: string; pages: string[] }[] } {
  let base = id;
  for (let i = 0; i < 5 && d.components.get(base)?.variantOf; i++) base = String(d.components.get(base)!.variantOf);
  const members = [...d.components]
    .filter(([cid, c]) => cid === base || c.variantOf === base || (c.variantOf && d.components.get(String(c.variantOf))?.variantOf === base))
    .map(([cid, c]) => ({ id: cid, pages: ((c.pages ?? []) as string[]).slice().sort() }))
    .sort((a, b) => (a.id === base ? -1 : b.id === base ? 1 : a.id.localeCompare(b.id)));
  return { base, members };
}

/**
 * A component patch extended to the other members of its variant family where it applies as-is (its templateReplace
 * finds occur in the member's template, its props exist): one candidate covers every variant.
 */
export function familyPatches(spec: PatchSpec, d: DesignCtx, dossier: ParityDossier): PatchSpec[] {
  if (spec.kind !== "component" || !spec.component) return [spec];
  const out = [spec];
  for (const m of variantFamily(d, spec.component.id).members) {
    if (m.id === spec.component.id) continue;
    const sib: PatchSpec = { ...spec, component: { id: m.id, override: { ...spec.component.override, variantOf: undefined } } };
    delete (sib.component!.override as Json).variantOf;
    if ((sib.component!.override as Json).create || (sib.component!.override as Json).template) continue; // full replacements stay per component
    if (!checkPatch(sib, d, dossier)) out.push(sib);
  }
  return out;
}

/** Components whose template mentions the divergence element / component path (class or id), best first. */
export function relevantComponents(d: DesignCtx, dossier: ParityDossier, max = 3): string[] {
  const fd = dossier.firstDivergence;
  if (!fd) return [];
  const labels = [fd.element, ...[...fd.componentPath].reverse()];
  const score = new Map<string, number>();
  labels.forEach((l, rank) => {
    const p = parseLabel(l);
    const tokens = [...(p.id ? [`id="${p.id}"`] : []), ...p.cls.map((c) => c)];
    for (const [id, c] of d.components) {
      const tpl = String(c.template ?? "");
      let s = 0;
      for (const t of tokens) if (t.startsWith("id=") ? tpl.includes(t) : new RegExp(`class="[^"]*\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(tpl)) s += 1;
      if (s) score.set(id, (score.get(id) ?? 0) + s / (1 + rank));
    }
  });
  return [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([id]) => id);
}

// ------------------------------------------------------------------ override file merging

async function readOverride(ws: Workspace, rel: string): Promise<Json | undefined> {
  return readJsonOr<Json | undefined>(ws, rel, undefined);
}
const jsonText = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

export function mergeComponentOverride(cur: Json | undefined, add: Json): Json {
  const out: Json = { ...(cur ?? {}) };
  for (const [k, v] of Object.entries(add)) {
    if (k === "templateReplace") out.templateReplace = [...(out.templateReplace ?? []), ...(v as Json[])];
    else if (k === "propsPatch") {
      const p = (out.propsPatch ??= {});
      const a = v as Json;
      if (a.set) p.set = { ...(p.set ?? {}), ...Object.fromEntries(Object.entries(a.set as Json).map(([n, x]) => [n, { ...(p.set?.[n] ?? {}), ...(x as Json) }])) };
      if (a.add) p.add = [...(p.add ?? []), ...a.add];
      if (a.remove) p.remove = [...new Set([...(p.remove ?? []), ...a.remove])];
    } else if (k === "exampleProps" || k === "instanceProps") out[k] = { ...(out[k] ?? {}), ...(v as Json) };
    else out[k] = v;
  }
  return out;
}

export function mergePageOverride(cur: Json | undefined, add: Json): Json {
  const out: Json = { ...(cur ?? {}) };
  for (const [k, v] of Object.entries(add)) {
    if (k === "slotsInsert" || k === "wrapperReplace") out[k] = [...(out[k] ?? []), ...(v as Json[])];
    else if (k === "slotsRemove") out[k] = [...new Set([...(out[k] ?? []), ...(v as string[])])];
    else if (k === "components") out[k] = { ...(out[k] ?? {}), ...(v as Json) };
    else out[k] = v;
  }
  return out;
}

export function mergeAssetsOverride(cur: Json | undefined, add: Json): Json {
  const out: Json = JSON.parse(JSON.stringify(cur ?? {}));
  for (const kind of ["stylesheets", "scripts"] as const) {
    const a = add[kind] as Json | undefined;
    if (!a) continue;
    const o = (out[kind] ??= {});
    for (const k of ["add", "remove", "order"] as const) if (a[k]) o[k] = k === "add" ? [...(o[k] ?? []), ...a[k]] : [...new Set([...(o[k] ?? []), ...a[k]])];
    if (a.sets) o.sets = [...new Set([...(o.sets ?? []), ...a.sets])];
  }
  if (add.images) {
    const i = (out.images ??= {});
    const k = add.images.keepRawLazySrc;
    if (k === true || i.keepRawLazySrc === true) i.keepRawLazySrc = true;
    else if (Array.isArray(k)) i.keepRawLazySrc = [...new Set([...(Array.isArray(i.keepRawLazySrc) ? i.keepRawLazySrc : []), ...k])].sort();
    if (add.images.placeholder) i.placeholder = add.images.placeholder;
  }
  if (add.note) out.note = add.note;
  return out;
}

export interface PatchSpec {
  kind: "component" | "page" | "assets" | "scripts" | "siteCss" | "mask";
  component?: { id: string; override: Json };
  page?: { path: string; override: Json };
  assets?: Json;
  scripts?: Json;
  siteCss?: string;
  mask?: { selector: string };
}

/** Turn a typed patch into full-content file writes (merged over the current override files). */
export async function patchFiles(ws: Workspace, siteFile: string, p: PatchSpec, tag: string, repoRoot?: string): Promise<FilePatch[]> {
  switch (p.kind) {
    case "component": {
      const rel = `design/overrides/components/${p.component!.id}.json`;
      return [{ path: rel, content: jsonText(mergeComponentOverride(await readOverride(ws, rel), { ...p.component!.override, note: tag })) }];
    }
    case "page": {
      const rel = "design/overrides/pages.json";
      const cur = (await readOverride(ws, rel)) ?? {};
      return [{ path: rel, content: jsonText({ ...cur, [p.page!.path]: mergePageOverride(cur[p.page!.path], { ...p.page!.override, note: tag }) }) }];
    }
    case "assets": {
      const rel = "design/overrides/assets.json";
      return [{ path: rel, content: jsonText(mergeAssetsOverride(await readOverride(ws, rel), { ...p.assets!, note: tag })) }];
    }
    case "scripts": {
      const rel = "design/overrides/scripts.json";
      const cur = (await readOverride(ws, rel)) ?? {};
      const add = Object.fromEntries(Object.entries(p.scripts!).map(([k, v]) => [k, { ...(cur[k] ?? {}), ...(v as Json), note: tag }]));
      return [{ path: rel, content: jsonText({ ...cur, ...add }) }];
    }
    case "siteCss": {
      const rel = "design/overrides/site.css";
      const cur = await readFile(ws.path(rel), "utf8").catch(() => "");
      return [{ path: rel, content: `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}/* ${tag.replace(/\*\//g, "")} */\n${p.siteCss!.trim()}\n` }];
    }
    case "mask": {
      const text = await readFile(repoRoot ? `${repoRoot.replace(/\/+$/, "")}/${siteFile}` : ws.path("..", "..", siteFile), "utf8");
      const doc = YAML.parseDocument(text);
      const mask = (doc.getIn(["crawl", "mask"]) as YAML.YAMLSeq | undefined)?.toJSON?.() as string[] | undefined;
      if (mask?.includes(p.mask!.selector)) return [];
      if (doc.hasIn(["crawl", "mask"])) (doc.getIn(["crawl", "mask"]) as YAML.YAMLSeq).add(p.mask!.selector);
      else doc.setIn(["crawl", "mask"], [p.mask!.selector]);
      return [{ path: siteFile, content: doc.toString() }];
    }
  }
}

// ------------------------------------------------------------------ deterministic candidates

export interface RuleProposal {
  title: string;
  rationale: string;
  patch: PatchSpec;
}

/** Classifier → deterministic patches (no LLM). Pure apart from the design context. */
export function ruleProposals(
  dossier: ParityDossier,
  d: DesignCtx,
  slots: { slots: Json[]; source: string; contentType?: string },
  opts: { path: string; sitePath?: string; inlineSources?: (selectors: string[], rules: number) => string[] } = { path: dossier.path },
): RuleProposal[] {
  const c = dossier.classification;
  const fd = dossier.firstDivergence;
  const out: RuleProposal[] = [];
  const ev = c.evidence.join("; ").slice(0, 400);
  if (c.cause === "ASSET" && c.subtype === "lazy-src") {
    const a = dossier.attributes.find((x) => x.attr === "src");
    const resolved = [a?.new, a?.old].find((v) => v && !v.startsWith("data:"));
    const needle = resolved?.split("?")[0];
    const ids = needle ? [...d.components].filter(([, x]) => String(x.template ?? "").includes(`src="${needle}`)).map(([id]) => id).sort() : [];
    out.push({
      title: `keep the raw lazy-image placeholder src (${ids.length ? ids.join(", ") : "all components"})`,
      rationale: `ASSET/lazy-src: ${ev}. The original keeps src = placeholder + data-src (the ported lazy loader decides at runtime); the template resolved src.`,
      patch: { kind: "assets", assets: { images: { keepRawLazySrc: ids.length ? ids : true } } },
    });
  }
  if (c.cause === "CSS_ORDER" || c.cause === "CSS_MISSING") {
    const ss = dossier.assets.stylesheets;
    // inline <style> sheets only on new → the asset-set entries (original "inline") whose CSS has those selectors
    const inlineFiles = (ss.inlineOnlyNew ?? []).flatMap((x) => opts.inlineSources?.(x.selectors, x.rules) ?? []);
    const extra = [...new Set([...(ss.noscriptLoadedOnNew.length ? ss.noscriptLoadedOnNew : ss.onlyNew.filter((h) => !h.startsWith("inline:"))), ...inlineFiles])].filter((h) => !/site-overrides\.css|\/_next\//.test(h));
    if (extra.length)
      out.push({
        title: `remove stylesheet(s) the original does not apply: ${extra.map(assetKey).join(", ")}`,
        rationale: `${c.cause}/${c.subtype}: ${ev}`,
        patch: { kind: "assets", assets: { stylesheets: { remove: extra.map(assetKey) } } },
      });
  }
  if (c.cause === "MARKUP" && c.subtype === "missing-element" && fd) {
    const el = parseLabel(fd.element);
    const match = [...d.components].find(([, x]) => {
      const r = templateRoot(String(x.template ?? ""));
      return r && r.tag === el.tag && (el.id ? r.id === el.id : true) && el.cls.every((k) => r.cls.includes(k));
    });
    const used = new Set(slots.slots.map((s) => String(s.component)));
    if (match && !used.has(match[0])) {
      const [id] = match;
      // position: after the slot whose component root matches the closest previous sibling on the original
      const regionLabel = [...fd.path].reverse().find((l) => /\.region-([a-z0-9-]+)/.test(l));
      const regionName = regionLabel ? /\.region-([a-z0-9-]+)/.exec(regionLabel)![1].replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase()) : undefined;
      const inRegion = slots.slots.filter((s) => !regionName || s.region === regionName);
      const after = inRegion.length ? String(inRegion[inRegion.length - 1].component) : undefined;
      out.push({
        title: `insert the mined component ${id} into ${opts.path}${regionName ? ` (region ${regionName})` : ""}`,
        rationale: `MARKUP/missing-element: ${ev}. Component ${id} renders exactly that root (${fd.element}) but the page template has no slot for it.`,
        patch: { kind: "page", page: { path: opts.path, override: { ...(slots.source !== "page" && slots.contentType ? { contentType: slots.contentType } : {}), slotsInsert: [{ slot: { component: id, ...(regionName ? { region: regionName } : {}) }, ...(after ? { after } : {}) }] } } },
      });
    }
  }
  if (c.cause === "MARKUP" && c.subtype === "extra-wrapper" && fd) {
    // the container = parent of the extra element: last path entry before the element itself
    const parent = fd.path[fd.path.length - 2];
    const pl = parent ? parseLabel(parent) : undefined;
    for (const [id, x] of [...d.components].sort(([a], [b]) => a.localeCompare(b))) {
      const tpl = String(x.template ?? "");
      for (const k of pl?.cls ?? []) {
        const re = new RegExp(`<${pl!.tag}\\b[^>]*class="[^"]*\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^"]*"[^>]*>\\s*\\{\\{\\{\\s*([\\w.]+)\\s*\\}\\}\\}`);
        const m = re.exec(tpl);
        const prop = m?.[1];
        const def = prop ? ((x.props ?? []) as Json[]).find((p) => p.name === prop) : undefined;
        if (prop && def && !def.inline && (def.type === "richText" || def.type === "html")) {
          out.push({
            title: `render ${id}.${prop} without a block wrapper (inline: true)`,
            rationale: `MARKUP/extra-wrapper: ${ev}. ${parent} holds {{{${prop}}}} directly on the original (text + inline markup, no <${fd.element.split(/[.#]/)[0]}>).`,
            patch: { kind: "component", component: { id, override: { propsPatch: { set: { [prop]: { inline: true } } } } } },
          });
          break;
        }
      }
    }
  }
  if (c.cause === "CSS_MISSING" && c.subtype === "rule-missing") {
    const decls: string[] = [];
    for (const r of dossier.matchedRules) {
      const wo = r.old.find((q) => q.wins);
      if (!wo || wo.origin === "user-agent" || wo.href === "inline style" || /url\(|var\(|…/.test(wo.value)) continue;
      if (r.new.some((q) => q.selector === wo.selector && assetKey(q.href) === assetKey(wo.href))) continue;
      if (wo.selector.length > 200 || /[{}]/.test(wo.selector)) continue;
      decls.push(`${wo.selector} { ${r.prop}: ${wo.value}${wo.important ? " !important" : ""}; }`);
    }
    if (decls.length)
      out.push({
        title: `site.css: restore ${decls.length} rule(s) only the original applies`,
        rationale: `CSS_MISSING/rule-missing (last resort, scoped to the original selectors): ${ev}`,
        patch: { kind: "siteCss", siteCss: [...new Set(decls)].join("\n") },
      });
  }
  if (c.cause === "DYNAMIC" && opts.sitePath)
    for (const mc of dossier.instability?.maskCandidates ?? [])
      out.push({ title: `mask the unstable region ${mc.selector}`, rationale: `DYNAMIC (self-test proof): ${mc.proof}`, patch: { kind: "mask", mask: { selector: mc.selector } } });
  return out;
}

// ------------------------------------------------------------------ LLM proposal schema

const LlmPatch = z
  .object({
    title: z.string().min(3).max(200),
    rationale: z.string().max(1200).optional(),
    kind: z.enum(["component", "page", "assets", "scripts", "siteCss", "mask"]),
    component: z.object({ id: z.string().min(1), override: ComponentOverride }).strict().optional(),
    page: z.object({ path: z.string().startsWith("/"), override: PageOverride }).strict().optional(),
    assets: AssetsOverride.optional(),
    scripts: ScriptsOverride.optional(),
    siteCss: z.string().max(4000).optional(),
    mask: z.object({ selector: z.string().min(1).max(200) }).strict().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const need: Record<string, unknown> = { component: p.component, page: p.page, assets: p.assets, scripts: p.scripts, siteCss: p.siteCss, mask: p.mask };
    if (need[p.kind] === undefined) ctx.addIssue({ code: "custom", message: `kind "${p.kind}" requires the "${p.kind}" field` });
  });
export const ParityFixResponse = z
  .object({
    diagnosis: z.string().max(2000),
    cause: z.enum(["MARKUP", "CSS_MISSING", "CSS_ORDER", "ASSET", "SCRIPT", "CONTENT", "DYNAMIC", "UNKNOWN"]).optional(),
    patches: z.array(LlmPatch).max(3),
  })
  .strict();
export type ParityFixResponse = z.infer<typeof ParityFixResponse>;

const zmsg = (e: z.ZodError) => e.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** Mechanical checks a model patch must pass before it becomes a candidate (no build needed to reject these). */
export function checkPatch(p: PatchSpec, d: DesignCtx, dossier: ParityDossier): string | undefined {
  if (p.kind === "component") {
    const c = d.components.get(p.component!.id);
    const o = p.component!.override as Json;
    if (!c && !o.create) return `unknown component ${p.component!.id}`;
    for (const r of (o.templateReplace ?? []) as Json[]) {
      if (String(r.find).includes("…")) return "templateReplace.find contains a skeleton ellipsis";
      if (c && !String(c.template ?? "").includes(r.find)) return `templateReplace.find not in ${p.component!.id}'s template`;
    }
    for (const n of Object.keys((o.propsPatch?.set ?? {}) as Json)) if (c && !((c.props ?? []) as Json[]).some((x) => x.name === n)) return `component ${p.component!.id} has no prop ${n}`;
  }
  if (p.kind === "page") for (const s of ((p.page!.override.slotsInsert ?? []) as Json[])) if (!d.components.has(String(s.slot?.component))) return `slot component ${s.slot?.component} is not a design component`;
  if (p.kind === "mask" && !(dossier.instability?.maskCandidates ?? []).some((m) => m.selector === p.mask!.selector)) return "mask proposed without instability proof for that selector";
  if (p.kind === "siteCss" && /@import|url\(\s*["']?https?:/i.test(p.siteCss!)) return "site.css may not import or load remote resources";
  return undefined;
}

// ------------------------------------------------------------------ dossier for the prompt

/** The dossier trimmed for the prompt (≤ ~25k chars). Text-free by construction (verify/diagnose.ts). */
export function promptDossier(d: ParityDossier): Json {
  return {
    path: d.path,
    viewport: d.viewport,
    parity: { value: d.parity.value, heightDelta: d.parity.height.delta, regions: d.parity.regions.slice(0, 4) },
    firstDivergence: d.firstDivergence,
    classification: d.classification,
    styleDiff: d.styleDiff.slice(0, 4),
    matchedRules: d.matchedRules.slice(0, 8),
    attributes: d.attributes.slice(0, 12),
    markup: { componentRoot: d.markup.componentRoot, old: d.markup.old.slice(0, 5000), new: d.markup.new.slice(0, 5000) },
    stylesheets: { onlyOld: d.assets.stylesheets.onlyOld, onlyNew: d.assets.stylesheets.onlyNew, orderDiffers: d.assets.stylesheets.orderDiffers, noscriptOld: d.assets.stylesheets.noscriptOld, noscriptLoadedOnNew: d.assets.stylesheets.noscriptLoadedOnNew, inlineOnlyOld: d.assets.stylesheets.inlineOnlyOld, inlineOnlyNew: d.assets.stylesheets.inlineOnlyNew },
    scripts: { onlyOld: d.assets.scripts.onlyOld, onlyNew: d.assets.scripts.onlyNew, orderDiffers: d.assets.scripts.orderDiffers },
    failedRequestsOnlyNew: d.assets.failedRequests.onlyNew.slice(0, 8),
    consoleErrorsOnlyNew: d.assets.consoleErrors.onlyNew.slice(0, 6),
    instability: d.instability ? { parity: d.instability.parity, divergenceUnstable: d.instability.divergenceUnstable, maskCandidates: d.instability.maskCandidates } : undefined,
  };
}

// ------------------------------------------------------------------ handler

async function dossierFor(ctx: AutofixContext, shot: Shot): Promise<ParityDossier | undefined> {
  const rel = `verify/diagnosis/${shot.viewport}/${safeId(shot.path)}.json`;
  // fresh = referenced by the current verify/visual.json row (verify writes the dossiers of a run before visual.json)
  const v = await readJsonOr<{ details?: { results?: VisualRow[] } }>(ctx.ws, "verify/visual.json", {});
  const row = (v.details?.results ?? []).find((r) => r.path === shot.path && r.viewport === shot.viewport);
  const fresh = row?.diagnosis?.file === rel || (await mtime(ctx.ws.path(rel))) >= (await mtime(ctx.ws.path("verify/visual.json"))) - 1000;
  if (fresh) {
    const d = await readJsonOr<ParityDossier | undefined>(ctx.ws, rel, undefined);
    if (d) return d;
  }
  if (!ctx.newBaseUrl) return undefined;
  // the app under test may be down between loop steps (the loop starts it on "build"): never diagnose an error page
  const up = await fetch(ctx.newBaseUrl.replace(/\/+$/, "") + shot.path, { signal: AbortSignal.timeout(10_000) }).then(
    (r) => r.status < 400,
    () => false,
  );
  if (!up) {
    ctx.log.warn(`parity-fix ${shot.path}@${shot.viewport}: no fresh dossier and ${ctx.newBaseUrl} is not serving the page — not diagnosing an error page`);
    return undefined;
  }
  const vp = ctx.site.crawl.viewports.find((v) => v.name === shot.viewport);
  if (!vp) return undefined;
  const browser = await launchBrowser();
  try {
    const old = ctx.oldBaseUrl.replace(/\/+$/, "");
    const neu = ctx.newBaseUrl.replace(/\/+$/, "");
    const hosts = [...new Set([new URL(old).host, new URL(neu).host, new URL(old).hostname, new URL(neu).hostname])];
    const d: ParityDossier = await diagnoseShot(browser, { path: shot.path, oldUrl: old + shot.path, newUrl: neu + shot.path, viewport: vp, mask: ctx.site.crawl.mask ?? [], capture: { allowHosts: hosts }, componentClassPrefixes: ctx.site.parity.componentClassPrefixes });
    if (d.new.status === 0 || d.new.status >= 400) return undefined;
    if (!ctx.dryRun) await ctx.ws.writeJson(rel, d);
    return d;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function candidate(shot: Shot, viewports: string[], title: string, rationale: string, files: FilePatch[], origin: "rule" | "llm", kind: PatchSpec["kind"]): Candidate {
  if (kind === "mask") return { title, rationale, files, origin, rerun: ["verify"], verify: { checks: ["visual"], urls: [shot.path], viewports } };
  return {
    title,
    rationale,
    files,
    origin,
    rerun: ["design-extract", "frontend-generate", "build", "verify"],
    stepOptions: { "design-extract": { applyOverridesOnly: true } },
    verify: { checks: ["visual"], urls: [shot.path], viewports },
  };
}

/**
 * Inline asset-set stylesheets (`original: "inline"`, rendered as <style>) of the page → matcher: the file names whose
 * CSS contains every given selector (the dossier knows inline sheets only by hash + selectors).
 */
async function inlineStyleSources(ws: Workspace, d: DesignCtx, path: string): Promise<(selectors: string[], rules: number) => string[]> {
  const setId = d.manifest.pages?.[path]?.assetSet as string | undefined;
  const list = ((setId ? d.manifest.assetSets?.[setId]?.stylesheets : undefined) ?? []) as Json[];
  const files: { href: string; css: string }[] = [];
  for (const e of list)
    if (e.original === "inline" || e.role === "inline") {
      const css = await readFile(ws.path("design", String(e.href)), "utf8").catch(() => "");
      if (css) files.push({ href: String(e.href), css: css.replace(/\s+/g, " ") });
    }
  const esc = (x: string) => x.replace(/\s+/g, " ").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // a file matches when it declares every selector as a rule; several matches → the one with the same rule count; still
  // ambiguous → nothing (no guessing)
  return (selectors, rules) => {
    if (!selectors.length) return [];
    const hit = files.filter((f) => selectors.every((sel) => new RegExp(`(^|[},])\\s*${esc(sel)}\\s*\\{`).test(f.css.replace(/\/\*.*?\*\//g, ""))));
    const exact = hit.length > 1 ? hit.filter((f) => (f.css.replace(/\/\*.*?\*\//g, "").match(/\{/g) ?? []).length === rules) : hit;
    return exact.length === 1 ? [exact[0].href.split("/").pop()!] : [];
  };
}

/** The page's ordered stylesheet list for the prompt: file name, original path, role; inline ones with their selectors. */
async function assetSetStyles(ws: Workspace, d: DesignCtx, path: string): Promise<Json[]> {
  const setId = d.manifest.pages?.[path]?.assetSet as string | undefined;
  const list = ((setId ? d.manifest.assetSets?.[setId]?.stylesheets : undefined) ?? []) as Json[];
  const out: Json[] = [];
  for (const e of list) {
    const file = String(e.href).split("/").pop();
    const item: Json = { file, original: String(e.original ?? "").split("?")[0], ...(e.role ? { role: e.role } : {}), ...(e.media && e.media !== "all" ? { media: e.media } : {}) };
    if (e.original === "inline" || e.role === "inline") {
      const css = await readFile(ws.path("design", String(e.href)), "utf8").catch(() => "");
      item.renderedAs = "inline <style>";
      item.selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:^|})\s*([^{}@]+?)\s*\{/g)].slice(0, 6).map((m) => m[1].trim().slice(0, 80));
    }
    out.push(item);
  }
  return out;
}

function siteFileOf(ctx: AutofixContext): string {
  return `sites/${ctx.site.site}.yaml`;
}

export const parityFixHandler: Handler = {
  id: "parity-fix",
  codes: PARITY_FIX_CODES,
  priority: 50,
  groupKey(t) {
    const s = shotOf(t);
    return s ? `parity:${s.path}@${s.viewport}` : `parity:${t.id}`;
  },

  async measure(ctx: AutofixContext, tasks: AutofixTask[]): Promise<Metrics> {
    const shot = tasks.map(shotOf).find(Boolean);
    const v = await readJsonOr<{ details?: { results?: VisualRow[] } }>(ctx.ws, "verify/visual.json", {});
    if (!shot) return { primary: 0, gates: {} };
    const m = urlMetric(v.details?.results ?? [], shot);
    return { primary: m.primary, gates: {}, detail: { shot, ...m.detail } };
  },

  async propose(ctx: AutofixContext, tasks: AutofixTask[], previous: AttemptRecord[]): Promise<Candidate[]> {
    const shot = tasks.map(shotOf).find(Boolean);
    if (!shot) return [];
    const viewports = ctx.site.crawl.viewports.map((v) => v.name);
    const dossier = await dossierFor(ctx, shot);
    if (!dossier) {
      ctx.log.warn(`parity-fix ${shot.path}@${shot.viewport}: no dossier (no --new-base-url and no verify/diagnosis file)`);
      return [];
    }
    const design = await loadDesign(ctx.ws);
    const slots = await pageSlots(design, ctx.ws, shot.path);
    const tag = `autofix parity-fix ${shot.path}@${shot.viewport}`;
    // CMP_PARITY_RULES=0: skip the deterministic candidates (LLM-only benchmark runs)
    const inlineSources = await inlineStyleSources(ctx.ws, design, shot.path);
    const rules = process.env.CMP_PARITY_RULES === "0" ? [] : ruleProposals(dossier, design, slots, { path: shot.path, sitePath: siteFileOf(ctx), inlineSources });
    const out: Candidate[] = [];
    for (const r of rules) {
      const files = await patchFiles(ctx.ws, siteFileOf(ctx), r.patch, `${tag}: ${r.title}`, ctx.repoRoot);
      if (files.length) out.push(candidate(shot, viewports, r.title, r.rationale, files, "rule", r.patch.kind));
    }
    const triedTitles = new Set(previous.map((a) => a.candidate.title));
    const untriedRules = out.filter((c) => !triedTitles.has(c.title));
    if (untriedRules.length) return untriedRules;
    if (dossier.classification.cause === "PAGE_MISSING") {
      ctx.log.info(`parity-fix ${shot.path}@${shot.viewport}: PAGE_MISSING/${dossier.classification.subtype} → routing / content track (no design patch)`);
      return [];
    }
    if (dossier.classification.lane === "content") {
      ctx.log.info(`parity-fix ${shot.path}@${shot.viewport}: ${dossier.classification.cause}/${dossier.classification.subtype} → content lane (no design patch)`);
      return [];
    }
    if (!ctx.llm) return out; // deterministic path: the (tried) rules only → the loop marks NEEDS_HUMAN
    // ---- DeepSeek: ≤ 3 typed patches
    const prompt = loadPrompt("parity-fix");
    const sendContent = ctx.site.llm?.sendContent ?? false;
    const rel = relevantComponents(design, dossier, 3);
    // the relevant components plus their variant siblings (same role, other pages): patch all members in one go
    const fams = [...new Map(rel.map((id) => { const f = variantFamily(design, id); return [f.base, f] as const; })).values()];
    const withSiblings = [...new Set([...rel, ...fams.flatMap((f) => f.members.map((m) => m.id))])].slice(0, 6);
    const comps = withSiblings.map((id) => {
      const c = design.components.get(id)!;
      return { id, kind: c.kind, variantOf: c.variantOf, pages: ((c.pages ?? []) as string[]).slice(0, 12), props: ((c.props ?? []) as Json[]).map((p) => ({ name: p.name, type: p.type, ...(p.inline ? { inline: true } : {}), ...(p.ccmField ? { ccmField: p.ccmField } : {}) })), templateSkeleton: skeletonOf(String(c.template ?? ""), sendContent).slice(0, 6000) };
    });
    const catalog = [...design.components].map(([id, c]) => {
      const r = templateRoot(String(c.template ?? ""));
      return `${id} (${c.kind}${c.variantOf ? `, variantOf ${c.variantOf}` : ""}): <${r?.tag ?? "?"}${r?.id ? `#${r.id}` : ""}${r?.cls.length ? "." + r.cls.slice(0, 3).join(".") : ""}>`;
    });
    const overrides = {
      pages: (await readOverride(ctx.ws, "design/overrides/pages.json")) ?? {},
      assets: (await readOverride(ctx.ws, "design/overrides/assets.json")) ?? {},
      scripts: (await readOverride(ctx.ws, "design/overrides/scripts.json")) ?? {},
      components: Object.fromEntries(await Promise.all(withSiblings.map(async (id) => [id, (await readOverride(ctx.ws, `design/overrides/components/${id}.json`)) ?? null]))),
    };
    const user = {
      dossier: promptDossier(dossier),
      page: { path: shot.path, templateSource: slots.source, contentType: slots.contentType, slots: slots.slots, assetSet: design.manifest.pages?.[shot.path]?.assetSet, stylesheets: await assetSetStyles(ctx.ws, design, shot.path) },
      relevantComponents: comps,
      variantFamilies: fams.filter((f) => f.members.length > 1),
      componentCatalog: catalog,
      currentOverrides: overrides,
      previousAttempts: previous.slice(-6).map((a) => ({ title: a.candidate.title, origin: a.candidate.origin, accepted: a.accepted, reason: a.reason })),
    };
    const res = await llmJson<ParityFixResponse>(ctx, "parity-fix", {
      system: prompt.text,
      user,
      schemaId: SCHEMA_ID,
      model: PARITY_MODEL,
      effort: "high",
      maxTokens: 16000,
      validate: (x) => {
        const r = ParityFixResponse.safeParse(x);
        if (!r.success) throw new Error(`response does not match ${SCHEMA_ID}: ${zmsg(r.error)}`);
        return r.data;
      },
    });
    if (!res) return out;
    for (const p of res.patches) {
      const spec = p as unknown as PatchSpec;
      const why = checkPatch(spec, design, dossier);
      if (why) {
        ctx.log.info(`parity-fix: LLM patch "${p.title}" dropped: ${why}`);
        continue;
      }
      if (spec.kind === "mask" && !dossier.instability?.maskCandidates.length) continue;
      // the same fix for every variant of the component it applies to (one candidate, one verify)
      const specs = familyPatches(spec, design, dossier);
      const files = (await Promise.all(specs.map((x) => patchFiles(ctx.ws, siteFileOf(ctx), x, `${tag}: ${p.title} (deepseek)`, ctx.repoRoot)))).flat();
      const title = specs.length > 1 ? `${p.title} (+ variant${specs.length > 2 ? "s" : ""} ${specs.slice(1).map((x) => x.component!.id).join(", ")})` : p.title;
      if (files.length) out.push(candidate(shot, viewports, title, `${res.diagnosis}${p.rationale ? ` — ${p.rationale}` : ""} [prompt ${prompt.sha}]`, files, "llm", spec.kind));
    }
    return out.filter((c) => c.origin === "llm" || !triedTitles.has(c.title));
  },

  async dossier(ctx: AutofixContext, tasks: AutofixTask[]) {
    const shot = tasks.map(shotOf).find(Boolean);
    if (!shot) return undefined;
    const d = await readJsonOr<ParityDossier | undefined>(ctx.ws, `verify/diagnosis/${shot.viewport}/${safeId(shot.path)}.json`, undefined);
    return d ? { file: `verify/diagnosis/${shot.viewport}/${safeId(shot.path)}.json`, classification: d.classification, firstDivergence: d.firstDivergence } : undefined;
  },
};
