import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { findChrome } from "@harness/capture";
import {
  buildWorkspace,
  normalizeSpec,
  readImages,
  readUrl,
  type BrandOverrides,
  type BrandSpec,
} from "@harness/design-system";
import type { ImagePart } from "@harness/protocol";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { rel, resolveInProject } from "./paths.js";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const MAX_IMAGES = 6;
const MAX_BYTES = 10 * 1024 * 1024;

interface DesignSystemArgs {
  url?: string;
  images?: string[];
  name?: string;
  prefix?: string;
  out?: string;
  overrides?: BrandOverrides;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 40) || "design-system";

function readBrand(dir: string): BrandSpec | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "brand.json"), "utf8")) as BrandSpec;
  } catch {
    return undefined;
  }
}

export const designSystemTool: Tool = {
  name: "design_system",
  description:
    "Generate a complete design system in the spirit of IBM Carbon from a URL or from images: design tokens with four " +
    "themes and enforced WCAG contrast, 25 accessible components as Lit web components, typed React components, Angular " +
    "directives with form value accessors, a docs site and tests, as an npm workspace. Pass `url` (reads the page's " +
    "styles) or `images` (project paths, e.g. chat attachments). Call it again with the same `out` and `overrides` to " +
    "change the brand reading (colours, fonts, radius, density…); with only `out` and `overrides` it regenerates from " +
    "the saved brand.json. It writes files only; build and test the workspace afterwards.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Page to read the brand from, e.g. https://example.com" },
      images: {
        type: "array",
        items: { type: "string" },
        description: `Image files in the project (png, jpg, webp, gif; at most ${MAX_IMAGES}) to read the brand from.`,
      },
      name: { type: "string", description: "Name of the design system (default: from the source)." },
      prefix: {
        type: "string",
        description:
          "Tag and CSS-variable prefix, 2–12 lowercase letters, e.g. acme → <acme-button>, --acme-… (default: from the name).",
      },
      out: {
        type: "string",
        description: "Folder for the workspace, relative to the project (default design-system/<name>).",
      },
      overrides: {
        type: "object",
        description:
          'Corrections to the brand reading, merged last, e.g. {"colors": {"primary": "#0f62fe"}, "fonts": {"sans": "IBM Plex Sans"}, ' +
          '"radius": {"control": 0, "container": 0}, "density": "compact", "theme": "dark", "controlHeight": 40, ' +
          '"buttons": {"secondary": "outline", "uppercase": false}, "elevation": "none"}.',
        properties: {
          colors: { type: "object" },
          fonts: { type: "object" },
          radius: { type: "object" },
          buttons: { type: "object" },
          theme: { type: "string", enum: ["light", "dark"] },
          density: { type: "string", enum: ["compact", "normal", "spacious"] },
          elevation: { type: "string", enum: ["none", "soft", "strong"] },
          controlHeight: { type: "integer" },
        },
      },
    },
  },
  readOnly: false,
  risk: (args: DesignSystemArgs) => (args?.url ? "medium" : "low"),
  async execute(args: DesignSystemArgs, ctx: ToolContext): Promise<ToolResult> {
    const url = args.url?.trim();
    const imagePaths = (args.images ?? []).map((p) => String(p).trim()).filter(Boolean);
    if (url && imagePaths.length) return { ok: false, output: "Give either `url` or `images`, not both." };

    // where the workspace goes; an existing one can be regenerated from its brand.json
    const outGiven = args.out?.trim();
    let outAbs = outGiven ? resolveInProject(ctx.projectRoot, outGiven) : undefined;
    const saved = outAbs ? readBrand(outAbs) : undefined;
    if (!url && !imagePaths.length && !saved)
      return {
        ok: false,
        output:
          "Nothing to read the brand from: give `url` or `images`, or `out` pointing at a design system generated before (with brand.json).",
      };

    let base: Partial<BrandSpec> = saved ?? {};
    const notes: string[] = [];
    const images: ImagePart[] = [];
    if (url) {
      const chrome = findChrome();
      if (!chrome)
        return { ok: false, output: "Reading a URL needs Chrome or Chromium (set HARNESS_CHROME)." };
      try {
        const r = await readUrl(url, {
          name: args.name,
          chrome,
          signal: ctx.signal,
          guard: { allowLocal: !!ctx.config.recreate?.allowLocal },
          respectRobots: ctx.config.recreate?.respectRobots !== false,
        });
        base = r.spec;
        if (r.skipped.length) notes.push(`Capture skipped: ${r.skipped.slice(0, 4).join(", ")}.`);
        if (r.shot)
          images.push({ mimeType: "image/png", data: r.shot.toString("base64"), name: "source-1440.png" });
      } catch (e) {
        return { ok: false, output: `Could not read ${url}: ${(e as Error).message}` };
      }
    } else if (imagePaths.length) {
      if (imagePaths.length > MAX_IMAGES) return { ok: false, output: `At most ${MAX_IMAGES} images.` };
      const parts: ImagePart[] = [];
      for (const p of imagePaths) {
        const abs = resolveInProject(ctx.projectRoot, p);
        if (!existsSync(abs) || statSync(abs).isDirectory())
          return { ok: false, output: `No such image: ${p}` };
        const mime = IMAGE_MIME[extname(abs).toLowerCase()];
        if (!mime) return { ok: false, output: `${p} is not a png, jpg, webp or gif image.` };
        const buf = readFileSync(abs);
        if (buf.length > MAX_BYTES) return { ok: false, output: `${p} is larger than 10 MB.` };
        parts.push({ mimeType: mime, data: buf.toString("base64"), name: p.split("/").pop() });
      }
      const model = ctx.config.designSystem?.model ?? "executor";
      try {
        const r = await readImages(parts, {
          name: args.name,
          chrome: findChrome() ?? undefined,
          signal: ctx.signal,
          ...(ctx.complete ? { complete: (m) => ctx.complete!(model, m, { maxTokens: 12_000 }) } : {}),
        });
        base = r.spec;
        if (r.note) notes.push(r.note);
        notes.push(
          r.method === "vision"
            ? `Roles, fonts and shapes read by the vision model${r.palette.length ? ` from ${r.palette.length} measured colours` : ""}.`
            : "Read from the measured colours only; fonts, radii and density are defaults (set a vision model with designSystem.model).",
        );
      } catch (e) {
        return { ok: false, output: (e as Error).message };
      }
    }

    const spec = normalizeSpec(
      { ...base, ...(args.name ? { name: args.name } : {}), ...(args.prefix ? { prefix: args.prefix } : {}) },
      args.overrides ?? {},
    );
    outAbs ??= resolveInProject(ctx.projectRoot, join("design-system", slug(spec.name)));
    const ws = buildWorkspace(spec);
    for (const [path, content] of Object.entries(ws.files)) {
      const f = join(outAbs, path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content);
    }
    const out = rel(ctx.projectRoot, outAbs);
    const foundations = `${out}/docs/foundations.html`;
    ctx.emit({ type: "preview.ready", path: foundations, title: `${spec.name} foundations` });

    const t = ws.tokens;
    const failing = t.contrast.filter((c) => !c.pass);
    const src = (k: string) => spec.sources?.[k] ?? "default";
    const lines = [
      `Wrote the ${spec.name} design system to ${out}/ (${Object.keys(ws.files).length} files; prefix "${spec.prefix}", packages ${ws.names.scope}/tokens, /web-components, /react, /angular, and docs).`,
      `Brand reading: primary ${spec.colors.primary} (${src("colors.primary")}, base step ${t.baseSteps.primary})` +
        `${spec.colors.secondary ? `, secondary ${spec.colors.secondary}` : ""}${spec.colors.accent ? `, accent ${spec.colors.accent}` : ""}; ` +
        `${spec.theme} source → default theme ${t.defaultTheme}; font ${spec.fonts.sans}${spec.fonts.display ? ` / ${spec.fonts.display}` : ""} (${src("fonts.sans")}); ` +
        `radius ${spec.radius.control >= 999 ? "fully rounded" : `${spec.radius.control}px`} controls, ${spec.radius.container}px containers; ` +
        `controls ${t.sizes.md}px, ${spec.density}; secondary buttons ${spec.buttons.secondary}; elevation ${spec.elevation}.`,
      ...(spec.notes ?? []).map((n) => `- ${n}`),
      ...notes.map((n) => `- ${n}`),
      failing.length
        ? `Contrast: ${failing.length} pair(s) below their minimum: ${failing
            .slice(0, 5)
            .map((c) => `${c.theme} ${c.fg} on ${c.bg} ${c.ratio}`)
            .join("; ")}.`
        : `Contrast: all ${t.contrast.length} checked pairs pass in all four themes.`,
      `The preview shows ${foundations} (no build needed).`,
      "Next: compare the foundations with the source and correct wrong roles with `overrides` (same `out`); then in " +
        `${out}: \`npm install\`, \`npm run build\`, \`npm test\`, \`npm run docs:build\`, and check docs/dist/index.html with check_preview ` +
        "(also with ?theme=darkest). Fix problems through `overrides`, not by editing generated files.",
    ];
    // no `edited`: afterEdit hooks (formatters) must not run over a hundred generated files
    return { ok: true, output: lines.join("\n"), ...(images.length ? { images } : {}) };
  },
};
