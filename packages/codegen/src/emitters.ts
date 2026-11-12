// Emitters of the recreate pipeline: one interface, registered by id, so a project or a
// skill can add its own (`recreate.emitters`). The built-in ones wrap the earlier project's exporters (export/*).
import type { SceneDesignSystem, SceneScreen } from "@harness/protocol";
import type { ProjectFont } from "@harness/scene";
import type { FileMap } from "./export/bundle.js";
import { exportDesignHtml, exportDesignReact } from "./export/design.js";
import { reactViteProject } from "./export/reactLayout.js";
import { buildDesignSystemPackage, type DsFramework } from "./export/ds/index.js";
import { tokensJson, tokenVars, tokensCss, tailwindConfig } from "./export/tokens.js";
import type { FontFace } from "./export/tokens.js";
import { emitDesignMd } from "./brandmd/emit.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type { FileMap };

/** Where captured third-party assets go (config `recreate.assets`). */
export type AssetsPolicy = "run-dir" | "project" | "none";
/** How webfonts are used (config `recreate.fonts`). */
export type FontsPolicy = "reference" | "embed" | "system";

export interface EmitInput {
  /** the page's screens: variants (ascending width) and their menu overlays */
  screens: SceneScreen[];
  /** the page's webfonts */
  fonts?: readonly ProjectFont[];
  /** component sets, tokens and styles (components / system stages) */
  system?: SceneDesignSystem;
  /** the page name */
  page?: string;
}

export interface EmitOptions {
  /** the live page (provenance in README / credits.json) */
  sourceUrl?: string;
  capturedAt?: string;
  assets?: AssetsPolicy;
  fonts?: FontsPolicy;
  /** react-vite: styling of the components */
  style?: "tailwind" | "css-modules" | "vanilla";
  /** ds-*: npm package name */
  packageName?: string;
}

export interface Emitter {
  id: string;
  description: string;
  emit(input: EmitInput, o: EmitOptions): FileMap;
}

/** The rights notice every output carries (README + credits.json). */
export function rightsNotice(sourceUrl?: string): string {
  return [
    `This is a recreation of ${sourceUrl ?? "a live web page"}, measured from its public DOM.`,
    "The layout, text, photos, fonts and logos belong to their owners and may be protected by copyright and trademark law.",
    "Use it for your own evaluation and prototyping, or with the rights holder's permission. You are responsible for how you use it.",
  ].join(" ");
}

/** credits.json + RECREATION.md: where the recreation comes from, the asset and font policy, the rights notice */
export function provenance(input: EmitInput, o: EmitOptions, what: string): FileMap {
  const credits = {
    source: o.sourceUrl ?? null,
    capturedAt: o.capturedAt ?? null,
    generator: "CDR recreate",
    assets: o.assets ?? "run-dir",
    fonts: (input.fonts ?? []).map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      source: f.sourceUrl ?? null,
      policy: o.fonts ?? "reference",
    })),
    notice: rightsNotice(o.sourceUrl),
  };
  return {
    "credits.json": JSON.stringify(credits, null, 2) + "\n",
    "RECREATION.md": `# ${input.page ?? "Recreated page"}\n\n${what}\n\n${rightsNotice(o.sourceUrl)}\n\n- Source: ${o.sourceUrl ?? "unknown"}\n- Captured: ${o.capturedAt ?? "unknown"}\n- Assets: ${o.assets ?? "run-dir"} · Fonts: ${o.fonts ?? "reference"}\n`,
  };
}

/** Webfonts by policy: embedded (data in fonts/), referenced (@font-face → the site's URL) or none (fallback stacks). */
function fontPlan(fonts: readonly ProjectFont[] | undefined, policy: FontsPolicy) {
  const list = fonts ?? [];
  if (policy === "embed") return { embed: list, faces: [] as FontFace[] };
  if (policy === "system") return { embed: [], faces: [] as FontFace[] };
  return {
    embed: [],
    faces: list
      .filter((f) => f.sourceUrl)
      .map((f): FontFace => ({
        family: f.family,
        file: f.sourceUrl!,
        weight: f.weight,
        style: f.style,
        format: f.format,
        ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
      })),
  };
}

/** Single-page bundles: the page itself is index.html (the earlier project writes `<slug>.html` + an index listing pages). */
function singlePage(files: FileMap): FileMap {
  const pages = Object.keys(files).filter(
    (f) => f.endsWith(".html") && f !== "index.html" && !f.includes("/"),
  );
  if (pages.length !== 1) return files;
  const out: FileMap = { ...files, "index.html": files[pages[0]] };
  delete out[pages[0]];
  return out;
}

/** Referenced faces go into tokens.css as @font-face rules pointing at their source URLs. */
function withFaces(files: FileMap, faces: FontFace[], key = "tokens.css"): FileMap {
  if (!faces.length || typeof files[key] !== "string") return files;
  const rules = tokensCss({}, faces)
    .split(":root")[0]
    .replace(/^\/\*.*\*\/\n/, "");
  return { ...files, [key]: `${rules}\n${files[key]}` };
}

export const staticEmitter: Emitter = {
  id: "static",
  description: "index.html + styles.css + tokens.css + nav.js (menus, sliders) + assets/",
  emit(input, o) {
    const plan = fontPlan(input.fonts, o.fonts ?? "reference");
    const files = exportDesignHtml(
      { name: input.page, screens: input.screens, fonts: plan.embed },
      {
        semantic: true,
        cssVars: true,
        images: (o.assets ?? "run-dir") !== "none",
        attribution: false,
        projectName: input.page,
        includeFonts: plan.embed.length > 0,
      },
    );
    return {
      ...withFaces(singlePage(files), plan.faces),
      ...provenance(input, o, "A static recreation: open index.html in a browser."),
    };
  },
};

export const reactViteEmitter: Emitter = {
  id: "react-vite",
  description:
    "Vite + React + TypeScript project (components, sections, pages, data, tokens, interactions); style tailwind (default) | css-modules | vanilla",
  emit(input, o) {
    const plan = fontPlan(input.fonts, o.fonts ?? "reference");
    const style = o.style ?? "tailwind";
    const files = reactViteProject(
      exportDesignReact(
        { name: input.page, screens: input.screens, fonts: plan.embed, designSystem: input.system },
        {
          semantic: true,
          cssVars: true,
          images: (o.assets ?? "run-dir") !== "none",
          attribution: false,
          projectName: input.page,
          includeFonts: plan.embed.length > 0,
        },
      ),
      {
        style,
        projectName: input.page,
        sourceUrl: o.sourceUrl,
        capturedAt: o.capturedAt,
        notice: rightsNotice(o.sourceUrl),
        cssVars: true,
      },
    );
    return {
      ...withFaces(files, plan.faces, "src/styles/tokens.css"),
      ...provenance(
        input,
        o,
        `A React + Vite + TypeScript recreation (styles: ${style}): \`npm install && npm run dev\`.`,
      ),
    };
  },
};

function dsEmitter(fw: DsFramework): Emitter {
  return {
    id: `ds-${fw}`,
    description: `design-system package for ${fw}`,
    emit(input, o) {
      if (!input.system?.componentSets?.length)
        throw new Error(`ds-${fw} needs component sets: run the components stage first`);
      const files = buildDesignSystemPackage(input.system, fw, { packageName: o.packageName });
      return { ...files, ...provenance(input, o, `A ${fw} design-system package extracted from the page.`) };
    },
  };
}

export const tokensEmitter: Emitter = {
  id: "tokens",
  description: "design tokens: W3C JSON, CSS custom properties, Tailwind config",
  emit(input) {
    const tokens = input.system?.tokens ?? input.screens[0]?.tokens;
    const vars = tokenVars(tokens);
    return {
      "tokens.json": tokensJson(tokens, input.system?.name ?? input.page ?? "Design system"),
      "tokens.css": tokensCss(vars),
      "tailwind.config.js": tailwindConfig(vars, true),
    };
  },
};

export const designMdEmitter: Emitter = {
  id: "design-md",
  description:
    "brand guide: DESIGN.md (Google's DESIGN.md format) + brand.json (the measured facts) + lint.json",
  emit(input, o) {
    // deterministic: facts from the design system, screens and their BrandCapture; prose slots are written by the
    // host's model through generateBrandGuide (brandmd/emit.ts), never here
    return {
      ...emitDesignMd(
        { screens: input.screens, system: input.system, page: input.page },
        { sourceUrl: o.sourceUrl, capturedAt: o.capturedAt },
      ),
      ...provenance(input, o, "A brand guide (DESIGN.md) measured from the page."),
    };
  },
};

const registry = new Map<string, Emitter>();
for (const e of [
  staticEmitter,
  reactViteEmitter,
  dsEmitter("react"),
  dsEmitter("lit"),
  dsEmitter("angular"),
  tokensEmitter,
  designMdEmitter,
])
  registry.set(e.id, e);

/** Add (or replace) an emitter, e.g. one loaded from `recreate.emitters`. */
export function registerEmitter(e: Emitter): void {
  if (!e || typeof e.id !== "string" || typeof e.emit !== "function") throw new Error("not an emitter");
  registry.set(e.id, e);
}

export function getEmitter(id: string): Emitter | undefined {
  return registry.get(id);
}

export function emitterIds(): string[] {
  return [...registry.keys()];
}

/** An emitter module's export: `export default { id, emit }` or `export const emitter = { id, emit }`. */
function emitterOf(mod: Record<string, unknown>): Emitter | null {
  for (const c of [mod.default, mod.emitter]) {
    const e = c as Partial<Emitter> | null | undefined;
    if (e && typeof e === "object" && typeof e.id === "string" && e.id.trim() && typeof e.emit === "function")
      return { ...e, description: typeof e.description === "string" ? e.description : e.id } as Emitter;
  }
  return null;
}

/**
 * Load emitter plugins (config `recreate.emitters`, e.g. `["./tools/emit-vue.mjs"]`): each path is resolved against
 * the project root and must stay inside it (symlinks included), is imported, and its default or `emitter` export is
 * registered by id (replacing a built-in of the same id). Never throws: failures are returned per path.
 */
export async function loadEmitters(
  paths: readonly string[],
  projectRoot: string,
): Promise<{ loaded: string[]; errors: Array<{ path: string; error: string }> }> {
  const loaded: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const root = await realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const inside = (p: string) => {
    const rel = path.relative(root, p);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  for (const p of paths) {
    try {
      if (typeof p !== "string" || !p.trim()) throw new Error("not a path");
      const abs = path.resolve(root, p);
      if (!inside(abs)) throw new Error("outside the project root");
      const real = await realpath(abs).catch(() => {
        throw new Error("file not found");
      });
      if (!inside(real)) throw new Error("outside the project root (symlink)");
      const mod = (await import(pathToFileURL(real).href)) as Record<string, unknown>;
      const e = emitterOf(mod);
      if (!e) throw new Error("no emitter export (default or `emitter` with { id, emit })");
      registerEmitter(e);
      loaded.push(e.id);
    } catch (err) {
      errors.push({ path: String(p), error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { loaded, errors };
}
