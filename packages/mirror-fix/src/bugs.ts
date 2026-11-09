/**
 * P7 PIPELINE_BUG lane (docs/DEEPSEEK_ONLY_PLAN.md §5.8, decision §10.1): when the pipeline code itself is wrong
 * (CHECK_CRASHED, STEP_FAILED, BUILD_FAILED, NEW_PAGE_ERROR, or a re-run that crashes), the loop does not try data
 * patches. It writes a self-contained repro bundle autofix/bugs/<n>/ for a developer (and later a coding agent):
 * README.md (failing command, step, stack, what to attach as a regression test), bug.json, copies of the step's input
 * files, and a skeletonised HTML snippet of the affected page (text → "…", no page text unless llm.sendContent).
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SiteConfig, Workspace } from "@harness/mirror-core";

export const PIPELINE_BUG_CODES = ["CHECK_CRASHED", "STEP_FAILED", "BUILD_FAILED", "NEW_PAGE_ERROR"] as const;

export interface BugInput {
  /** code that triggered the bundle (one of PIPELINE_BUG_CODES or "RERUN_CRASHED") */
  code: string;
  /** pipeline step ("transform", "verify", "build", …) */
  step: string;
  /** verify check id for CHECK_CRASHED */
  check?: string;
  ref?: string;
  message: string;
  stack?: string;
  /** the candidate whose rerun crashed (title + touched files), when a candidate triggered it */
  candidate?: { title: string; handler: string; files: { path: string; content: string | null }[] };
  /** last lines of the build log for BUILD_FAILED */
  buildLog?: string;
}

export interface BugBundle {
  n: number;
  dir: string;
  signature: string;
  reused: boolean;
}

const MAX_COPY = 256 * 1024;
const MAX_SNIPPET = 24 * 1024;

/** Text-free HTML skeleton: script/style bodies dropped, text nodes and text-bearing attributes → "…". */
export function skeletonHtml(html: string, sendContent = false): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template)\b([^>]*)>[\s\S]*?<\/\1>/gi, (_m, tag: string, attrs: string) => `<${tag}${attrs}>…</${tag}>`);
  if (sendContent) return s;
  s = s.replace(/>([^<]+)</g, (all, txt: string) => (txt.trim() ? `>…<` : all));
  s = s.replace(/\s(alt|title|aria-label|aria-description|placeholder|content|value|data-[a-z0-9-]*text[a-z0-9-]*)="[^"]*"/gi, ' $1="…"');
  return s;
}

/** Body of the page (or the whole document) with whitespace collapsed, truncated. */
export function snippetOf(html: string, sendContent = false, max = MAX_SNIPPET): string {
  const body = /<body\b[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const sk = skeletonHtml(body, sendContent).replace(/\n\s*\n+/g, "\n").replace(/[ \t]{2,}/g, " ");
  return sk.length > max ? `${sk.slice(0, max)}\n<!-- … truncated (${sk.length} chars) -->` : sk;
}

/** Input files that reproduce a failing step (workspace-relative, or repo-relative for sites/). */
export function inputsFor(step: string, site: string, check?: string): string[] {
  const common = [`sites/${site}.yaml`];
  switch (step) {
    case "extract":
      return common;
    case "analyze":
      return [...common, "raw/html/crawl.json"];
    case "map":
    case "transform":
    case "validate":
      return [...common, "analysis/inventory.json", "mapping/*.yaml", "mapping/profiles.yaml"];
    case "load":
      return [...common, "ccm/schema/content-types.json", "idmap.json"];
    case "design-extract":
      return [...common, "raw/html/crawl.json", "design/overrides/**"];
    case "frontend-generate":
    case "build":
      return [...common, "design/manifest.json", "design/overrides/**", "ccm/schema/content-types.json"];
    case "verify":
      return [...common, ...(check ? [`verify/${check}.json`] : ["verify/summary.json"])];
    default:
      return common;
  }
}

function signatureOf(b: BugInput): string {
  const firstLine = b.message.split("\n")[0].replace(/^(apply|rollback): /, "").replace(/\d+(\.\d+)?/g, "#").slice(0, 200);
  return createHash("sha256").update([b.code, b.step, b.check ?? "", b.ref ?? "", firstLine].join("|")).digest("hex").slice(0, 16);
}

async function existing(ws: Workspace): Promise<{ n: number; signature: string }[]> {
  const out: { n: number; signature: string }[] = [];
  for (const f of await ws.list("autofix/bugs", "bug.json")) {
    try {
      const d = await ws.readJson<{ n: number; signature: string }>(f);
      if (typeof d.n === "number") out.push(d);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function expand(ws: Workspace, repoRoot: string, pattern: string): Promise<{ rel: string; abs: string }[]> {
  if (pattern.startsWith("sites/")) return [{ rel: pattern, abs: join(repoRoot, pattern) }];
  if (pattern.endsWith("/**")) {
    const dir = pattern.slice(0, -3);
    return (await ws.list(dir)).map((rel) => ({ rel, abs: ws.path(rel) }));
  }
  const star = /^(.*)\/\*(\.[a-z]+)$/.exec(pattern);
  if (star) return (await ws.list(star[1], star[2])).filter((r) => r.split("/").length === star[1].split("/").length + 1).map((rel) => ({ rel, abs: ws.path(rel) }));
  return [{ rel: pattern, abs: ws.path(pattern) }];
}

/** raw server HTML of a page path from raw/html/crawl.json, if crawled */
async function pageHtml(ws: Workspace, path: string): Promise<{ file: string; html: string } | undefined> {
  try {
    const idx = await ws.readJson<{ pages?: { path: string; id: string }[] }>("raw/html/crawl.json");
    const pg = idx.pages?.find((p) => p.path === path);
    if (!pg) return undefined;
    for (const f of [`raw/html/pages/${pg.id}.raw.html`, `raw/html/pages/${pg.id}.rendered.html`]) {
      if (await ws.exists(f)) return { file: f, html: await ws.readText(f) };
    }
  } catch {
    /* no crawl */
  }
  return undefined;
}

function commandFor(b: BugInput, site: string): string {
  switch (b.step) {
    case "build":
      return `pnpm migrate frontend generate ${site} && (cd apps/${site}-web && pnpm build)`;
    case "verify":
      return `pnpm migrate verify ${site} --new-base-url <url>${b.check ? ` --checks ${b.check}` : ""}`;
    case "design-extract":
      return `pnpm migrate design extract ${site}`;
    case "frontend-generate":
      return `pnpm migrate frontend generate ${site}`;
    default:
      return `pnpm migrate ${b.step} ${site}`;
  }
}

/** Write (or reuse, same signature) a repro bundle. Returns its number and workspace-relative dir. */
export async function writeBugBundle(ws: Workspace, site: SiteConfig, repoRoot: string, b: BugInput): Promise<BugBundle> {
  const signature = signatureOf(b);
  const prev = await existing(ws);
  const hit = prev.find((p) => p.signature === signature);
  if (hit) return { n: hit.n, dir: `autofix/bugs/${hit.n}`, signature, reused: true };
  const n = prev.reduce((m, p) => Math.max(m, p.n), 0) + 1;
  const dir = `autofix/bugs/${n}`;
  const sendContent = !!site.llm?.sendContent;

  const copied: { rel: string; bytes: number; skipped?: string }[] = [];
  for (const pat of inputsFor(b.step, site.site, b.check)) {
    for (const { rel, abs } of await expand(ws, repoRoot, pat)) {
      let size: number;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      if (size > MAX_COPY) {
        copied.push({ rel, bytes: size, skipped: `> ${MAX_COPY} bytes` });
        continue;
      }
      await ws.writeText(`${dir}/inputs/${rel}`, await readFile(abs));
      copied.push({ rel, bytes: size });
    }
  }
  let snippet: { file: string; path: string } | undefined;
  if (b.ref?.startsWith("/")) {
    const pg = await pageHtml(ws, b.ref);
    if (pg) {
      await ws.writeText(`${dir}/snippet.html`, snippetOf(pg.html, sendContent) + "\n");
      snippet = { file: pg.file, path: b.ref };
    }
  }
  if (b.candidate) await ws.writeJson(`${dir}/candidate.json`, b.candidate);
  if (b.buildLog) await ws.writeText(`${dir}/build.log`, b.buildLog.slice(-20_000));

  const bug = { n, signature, code: b.code, step: b.step, check: b.check, ref: b.ref, message: b.message, createdAt: new Date().toISOString(), inputs: copied, snippet, candidate: b.candidate ? { title: b.candidate.title, handler: b.candidate.handler } : undefined };
  await ws.writeJson(`${dir}/bug.json`, bug);
  const cmd = commandFor(b, site.site);
  const md = [
    `# PIPELINE_BUG ${n} — ${b.code} in \`${b.step}\`${b.check ? ` (check \`${b.check}\`)` : ""}`,
    "",
    `Signature \`${signature}\` · site \`${site.site}\` · ${bug.createdAt}`,
    "",
    "The pipeline code (not the site data) failed. Fix it in the owning package and turn this bundle into a regression",
    "test (docs/DEEPSEEK_ONLY_PLAN.md §5.8). No page text is included unless `llm.sendContent: true`.",
    "",
    "## Reproduce",
    "",
    "```sh",
    `# restore the inputs below into workspace/${site.site}/ (and sites/${site.site}.yaml), then:`,
    cmd,
    "```",
    "",
    "## Failure",
    "",
    `- code: \`${b.code}\``,
    `- step: \`${b.step}\``,
    ...(b.ref ? [`- ref: \`${b.ref}\``] : []),
    "",
    "```",
    b.message.slice(0, 4000),
    "```",
    "",
    ...(b.stack ? ["## Stack", "", "```", b.stack.slice(0, 8000), "```", ""] : []),
    ...(b.candidate ? ["## Triggered by an autofix candidate", "", `\`${b.candidate.handler}\`: ${b.candidate.title} — patch in \`candidate.json\`. A data file that passes the handler's schema must not crash the step.`, ""] : []),
    ...(b.buildLog ? ["## Build log", "", "Last 20 kB in `build.log`.", ""] : []),
    "## Inputs (copied under `inputs/`)",
    "",
    ...(copied.length ? copied.map((c) => `- \`${c.rel}\` (${c.bytes} B)${c.skipped ? ` — not copied: ${c.skipped}` : ""}`) : ["_none found_"]),
    "",
    ...(snippet ? ["## Page skeleton", "", `\`snippet.html\`: \`${snippet.file}\` (page \`${snippet.path}\`), text replaced by "…".`, ""] : []),
  ].join("\n");
  await ws.writeText(`${dir}/README.md`, md + "\n");
  return { n, dir, signature, reused: false };
}
