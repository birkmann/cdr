/** Reader for workspace/<site>/design/ (written by @cmp/design, see docs/AGENT_WORKPLAN.md "Design output"). */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Issue } from "@harness/mirror-core";

export interface DesignProp {
  name: string;
  type: string;
  ccmField?: string;
  component?: string;
  itemComponent?: string;
  itemFields?: Record<string, string>;
  valueType?: "boolean";
  i18n?: Record<string, string>;
  format?: { kind: "date"; options: Record<string, unknown>; locales: Record<string, string> };
}
export interface DesignComponent {
  id: string;
  name?: string;
  kind: "chrome" | "section" | "document";
  ccmType?: string;
  viewMode?: string;
  template: string;
  props: DesignProp[];
  exampleHtml?: string;
  exampleProps?: Record<string, unknown>;
  verified?: boolean;
}
export interface DesignTemplate {
  contentType: string;
  layout?: string;
  chrome: string[];
  slots: { component: string; field?: string; repeat?: boolean; region?: string; props?: Record<string, unknown> }[];
  bodyClass?: string;
  wrapperHtml?: string;
  /** UI strings of the wrapper ({{t.<key>}}), key -> value per locale (multilingual sites) */
  i18n?: Record<string, Record<string, string>>;
}
export interface DesignLayout {
  id: string;
  /** static render mode: original <head> / end-of-body items and Drupal settings (see static.ts) */
  head?: unknown;
  bodyEnd?: unknown;
  drupalSettings?: unknown;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
  template: string;
  chrome: string[];
  props: DesignProp[];
  exampleProps?: Record<string, unknown>;
}
export interface DesignManifest {
  baseUrl?: string;
  viewports?: unknown[];
  /** design-relative hrefs; static sites: CSS-in-JS blocks as { href, role: "inline", attrs } */
  stylesheets: (string | { href: string; role?: string; original?: string; attrs?: Record<string, string> })[];
  fonts?: string[];
  /** `original`: the URL the source page loaded the script from (root-relative for same-origin scripts) */
  scripts?: { src: string; placement: "head" | "body"; original?: string; type?: string }[];
  components?: { id: string; file: string }[];
  templates?: { contentType: string; file: string }[];
  layout?: string | { file: string };
  layouts?: { id: string; file: string }[];
  richText?: { embeddedAsset?: string; listItemParagraphs?: boolean };
  tokensFile?: string;
  icon?: string;
  favicon?: string;
  /** "static" = static islands (original JS runs against server markup), "react" = compiled TSX; default: detected */
  renderMode?: "static" | "react";
  drupalSettings?: unknown;
  head?: unknown;
  bodyEnd?: unknown;
  pages?: Record<string, unknown>;
}
export interface Design {
  dir: string;
  manifest: DesignManifest;
  components: DesignComponent[];
  templates: DesignTemplate[];
  layout?: DesignLayout;
  tokens?: Record<string, unknown>;
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}
async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

/** Loads design/; tolerant to a missing manifest (falls back to scanning components/ + templates/). */
export async function readDesign(dir: string, issues: Issue[]): Promise<Design | undefined> {
  if (!(await exists(dir))) return undefined;
  const manifestPath = join(dir, "manifest.json");
  const manifest: DesignManifest = (await exists(manifestPath)) ? await readJson(manifestPath) : { stylesheets: [] };
  if (!(await exists(manifestPath))) issues.push({ severity: "warning", code: "DESIGN_NO_MANIFEST", message: "design/manifest.json missing — scanning design/components and design/templates" });
  manifest.stylesheets ??= [];

  const componentFiles = manifest.components?.length ? manifest.components.map((c) => c.file) : (await listJson(join(dir, "components"))).map((f) => `components/${f}`);
  const components: DesignComponent[] = [];
  for (const f of componentFiles) {
    try {
      const c = await readJson<DesignComponent>(join(dir, f));
      if (!c.id || typeof c.template !== "string") throw new Error("missing id/template");
      c.props ??= [];
      components.push(c);
    } catch (e) {
      issues.push({ severity: "error", code: "DESIGN_COMPONENT_INVALID", message: `${f}: ${(e as Error).message}`, ref: f, actionable: true });
    }
  }
  const templateFiles = manifest.templates?.length ? manifest.templates.map((t) => t.file) : (await listJson(join(dir, "templates"))).map((f) => `templates/${f}`);
  const templates: DesignTemplate[] = [];
  for (const f of templateFiles) {
    try {
      const t = await readJson<DesignTemplate>(join(dir, f));
      t.chrome ??= [];
      t.slots ??= [];
      templates.push(t);
    } catch (e) {
      issues.push({ severity: "error", code: "DESIGN_TEMPLATE_INVALID", message: `${f}: ${(e as Error).message}`, ref: f, actionable: true });
    }
  }
  let layout: DesignLayout | undefined;
  const lf = typeof manifest.layout === "string" ? manifest.layout : (manifest.layout?.file ?? (manifest.layouts?.find((l) => l.id === "default") ?? manifest.layouts?.[0])?.file);
  for (const cand of [lf, "layout.json", "layouts/default.json"].filter((x): x is string => !!x)) {
    if (await exists(join(dir, cand))) {
      layout = await readJson<DesignLayout>(join(dir, cand));
      layout.props ??= [];
      layout.chrome ??= [];
      break;
    }
  }
  const tf = join(dir, manifest.tokensFile ?? "tokens.json");
  const tokens = (await exists(tf)) ? await readJson<Record<string, unknown>>(tf) : undefined;
  components.sort((a, b) => a.id.localeCompare(b.id));
  templates.sort((a, b) => a.contentType.localeCompare(b.contentType));
  return { dir, manifest, components, templates, layout, tokens };
}

/** W3C design tokens → CSS custom properties (:root { --color-primary: …; }) */
export function tokensToCss(tokens: Record<string, unknown>): string {
  const lines: string[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if ("$value" in o) {
      const v = o.$value;
      const css = typeof v === "string" || typeof v === "number" ? String(v) : Array.isArray(v) ? v.join(", ") : JSON.stringify(v);
      lines.push(`  --${path.map((p) => p.replace(/[^a-zA-Z0-9_-]/g, "-")).join("-")}: ${css};`);
      return;
    }
    for (const k of Object.keys(o).sort()) if (!k.startsWith("$")) walk(o[k], [...path, k]);
  };
  walk(tokens, []);
  return `/* GENERATED from design/tokens.json — do not edit */\n:root {\n${lines.join("\n")}\n}\n`;
}
