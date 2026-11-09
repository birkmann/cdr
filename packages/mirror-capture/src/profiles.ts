/**
 * Paragraph profiles: how theme templates print paragraph values that are NOT wrapped in Drupal field markup
 * (`field--name-*`). Drupal field wrappers are mapped generically (to-ccm.ts); profiles add the theme-printed
 * values ("slots"), name loose child paragraphs, and declare entity roots that lack the `paragraph` class.
 *
 * Site knowledge is DATA (docs/DEEPSEEK_ONLY_PLAN.md §5.1), merged in three layers (higher wins):
 *   1. site      workspace/<site>/mapping/profiles.yaml        (reviewed + committed, written by humans or autofix)
 *   2. theme     packages/adapters/source-html/themes/<id>.yaml (detected from /themes/custom/<theme>/ asset paths)
 *   3. generic   GENERIC_PACK below                             (theme-agnostic class fields only)
 * `SiteConfig.source.themePack`: "auto" (default) | "none" | "<id>".
 *
 * Keys are Drupal machine names (paragraph type or, for nodes rendered in a view mode, the view mode). The CCM
 * type id stays the workplan id (`section<Pascal>`), so the Drupal DB import produces the same types.
 * Slot field ids are inferred names (marked `sourceMeta.inferred`) — the DB import may name them differently
 * (e.g. `field_title`), which mapping/html.yaml makes explicit.
 */
import { firstExistingPath } from "@harness/mirror-core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { selectAll } from "hast-util-select";

export type SlotKind =
  | "text" // plain text (+ `<id>Html` sibling when the element carries inline markup)
  | "richText"
  | "link" // { href, label?, ref? }
  | "links" // link[]  (cardinality -1)
  | "asset" // first <img> (+ `<id>Sources` for <picture>/srcset)
  | "assets" // every <img>
  | "textList" // string[]
  | "html" // outer HTML kept verbatim (forms, widgets)
  | "json" // JSON.parse(script text)
  | "bgImage" // url() of an inline background-image style
  | "classes" // class attribute of a wrapper (per-instance theme variants: grid columns, backgrounds)
  | "list"; // json list of every match, item fields per `item` spec (see ListItemSpec)
export const SLOT_KINDS: SlotKind[] = ["text", "richText", "link", "links", "asset", "assets", "textList", "html", "json", "bgImage", "classes", "list"];

/**
 * Item field spec for `list` slots: "@attr" attribute, "#@attr" numeric attribute, "?class" has-class flag,
 * "text" own text, ".sel" text of a descendant, "img" first <img> (-> { asset ref, src path, alt }),
 * { sel, item } nested list.
 */
export type ListItemSpec = Record<string, string | { sel: string; item: ListItemSpec }>;

export interface SlotDef {
  sel: string;
  kind: SlotKind;
  /** take the element's parent anchor (cards wrapped in <a class="card-item__link">) */
  parentLink?: boolean;
  /** first match with non-empty text (themes print empty placeholder headings) */
  nonEmpty?: boolean;
  /** link label from this selector (relative to the link) instead of the anchor text */
  labelSel?: string;
  /** item fields of a `list` slot */
  item?: ListItemSpec;
}

export interface ParagraphProfile {
  slots?: Record<string, SlotDef | string>;
  /** field id for child entities that are not inside a Drupal field wrapper (default "items") */
  items?: string;
  /** always keep the outer HTML as `html` (interactive widgets rebuilt by JS) */
  keepHtml?: boolean;
  /** boolean fields from root classes: field -> class */
  flags?: Record<string, string>;
}

export interface EntityRootDef {
  sel: string;
  type: string;
  entity: "paragraph" | "node" | "item";
}

export interface ClassFieldDef {
  re: RegExp;
  field: string;
}

/** Resolved, merged profile set (what to-ccm / analyze consume). */
export interface ProfileSet {
  /** e.g. "da_vinci_code", "none", "site+da_vinci_code" */
  id: string;
  /** theme pack id in use ("none" = generic only) */
  themePack: string;
  /** layers merged, highest first: "site:mapping/profiles.yaml", "theme:da_vinci_code", "generic" */
  sources: string[];
  profiles: Record<string, ParagraphProfile>;
  /** document-level slots per CCM document type id (selectors relative to the page's main content, outside paragraphs) */
  documents: Record<string, ParagraphProfile>;
  /** first match wins */
  entityRoots: EntityRootDef[];
  /** first match per field wins */
  classFields: ClassFieldDef[];
  componentClassPrefixes: string[];
}

// ------------------------------------------------------------------ Zod schema (theme packs, mapping/profiles.yaml, LLM output)

/** true when hast-util-select can parse the selector */
export function isValidSelector(sel: string): boolean {
  try {
    selectAll(sel, { type: "root", children: [] });
    return true;
  } catch {
    return false;
  }
}
const Selector = z.string().min(1).refine(isValidSelector, { message: "invalid CSS selector" });
const FieldId = z.string().regex(/^[a-z][A-Za-z0-9]*$/, { message: "field ids are camelCase ([a-z][A-Za-z0-9]*)" });
const MachineName = z.string().regex(/^[a-z0-9_]+$/, { message: "machine names are snake_case ([a-z0-9_]+)" });

export const ListItemSpecSchema: z.ZodType<ListItemSpec> = z.lazy(() => z.record(FieldId, z.union([z.string().min(1), z.object({ sel: Selector, item: ListItemSpecSchema }).strict()])));

export const SlotDefSchema = z
  .object({
    sel: Selector,
    kind: z.enum(SLOT_KINDS as [SlotKind, ...SlotKind[]]),
    parentLink: z.boolean().optional(),
    nonEmpty: z.boolean().optional(),
    labelSel: Selector.optional(),
    item: ListItemSpecSchema.optional(),
  })
  .strict()
  .refine((s) => s.kind !== "list" || !!s.item, { message: "list slots need an `item` spec" });

/** A slot: "<selector>" (text) | SlotDef | null (site layer: remove the slot of a lower layer). */
export const SlotSchema = z.union([Selector, SlotDefSchema, z.null()]);

export const ParagraphProfileSchema = z
  .object({
    slots: z.record(FieldId, SlotSchema).optional(),
    items: FieldId.optional(),
    keepHtml: z.boolean().optional(),
    flags: z.record(FieldId, z.string().min(1)).optional(),
  })
  .strict();

export const EntityRootSchema = z.object({ sel: Selector, type: MachineName, entity: z.enum(["paragraph", "node", "item"]) }).strict();

export const ClassFieldSchema = z
  .object({
    re: z.string().refine(
      (r) => {
        try {
          new RegExp(r);
          return /\(.+\)/.test(r);
        } catch {
          return false;
        }
      },
      { message: "re must be a valid regex with one capture group" },
    ),
    field: FieldId,
  })
  .strict();

/**
 * File format of `themes/<id>.yaml` and `workspace/<site>/mapping/profiles.yaml`. Every section is optional.
 * `profiles.<machine>: null` (site layer) removes a lower layer's profile.
 */
export const ProfilePackSchema = z
  .object({
    $comment: z.string().optional(),
    id: z.string().optional(),
    description: z.string().optional(),
    /** theme names (from /themes/custom/<theme>/ paths or drupalSettings.ajaxPageState.theme) this pack applies to; default [id] */
    detect: z.object({ themes: z.array(z.string().min(1)) }).strict().optional(),
    entityRoots: z.array(EntityRootSchema).optional(),
    classFields: z.array(ClassFieldSchema).optional(),
    componentClassPrefixes: z.array(z.string().min(1)).optional(),
    profiles: z.record(MachineName, ParagraphProfileSchema.nullable()).optional(),
    /** document-level slots: CCM document type id (camelCase, e.g. article, dsuComponentPage) -> profile (slots/flags) */
    documents: z.record(FieldId, ParagraphProfileSchema.nullable()).optional(),
  })
  .strict();
export type ProfilePack = z.infer<typeof ProfilePackSchema>;
/** Profile as stored in a pack (slots may be null = removal marker). */
export type PackProfile = z.infer<typeof ParagraphProfileSchema>;

// ------------------------------------------------------------------ packs on disk

export const THEMES_DIR = firstExistingPath(import.meta.url, ["../themes", "./mirror/themes"]);

/** Theme-agnostic layer: class modifiers common to Drupal themes. */
export const GENERIC_PACK: ProfilePack = {
  id: "generic",
  classFields: [
    { re: "^position-(left|right|center|top|bottom)$", field: "position" },
    { re: "^background--(.+)$", field: "background" },
    { re: "^container--(.+)$", field: "container" },
  ],
};

export function parseProfilePack(text: string, source = "profiles"): ProfilePack {
  const data = parseYaml(text) ?? {};
  const r = ProfilePackSchema.safeParse(data);
  if (!r.success) throw new Error(`${source}: invalid profile pack: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

const packCache = new Map<string, ProfilePack>();
/** Theme packs shipped with the adapter: id -> pack (themes/*.yaml, sorted by id). */
export function themePacks(dir = THEMES_DIR): Map<string, ProfilePack> {
  const out = new Map<string, ProfilePack>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort()) {
    const path = join(dir, f);
    let p = packCache.get(path);
    if (!p) {
      p = parseProfilePack(readFileSync(path, "utf8"), path);
      packCache.set(path, p);
    }
    out.set(p.id ?? f.replace(/\.yaml$/, ""), p);
  }
  return out;
}

export function themePack(id: string, dir = THEMES_DIR): ProfilePack | undefined {
  return themePacks(dir).get(id);
}

// ------------------------------------------------------------------ merge

const toSlotRecord = (slots: Record<string, SlotDef | string | null> | undefined) => slots ?? {};

/** Merge pack layers (highest precedence FIRST) into a ProfileSet. Deterministic. */
export function mergeProfilePacks(layers: { source: string; pack: ProfilePack }[], meta: { id?: string; themePack: string }): ProfileSet {
  const profiles = mergeProfileMaps(layers.map((l) => l.pack.profiles));
  const documents = mergeProfileMaps(layers.map((l) => l.pack.documents));
  const entityRoots: EntityRootDef[] = [];
  const classFields: ClassFieldDef[] = [];
  const prefixes: string[] = [];
  for (const { pack } of layers) {
    for (const r of pack.entityRoots ?? []) if (!entityRoots.some((x) => x.sel === r.sel)) entityRoots.push(r);
    for (const c of pack.classFields ?? []) if (!classFields.some((x) => x.re.source === c.re)) classFields.push({ re: new RegExp(c.re), field: c.field });
    for (const p of pack.componentClassPrefixes ?? []) if (!prefixes.includes(p)) prefixes.push(p);
  }
  return { id: meta.id ?? "custom", themePack: meta.themePack, sources: layers.map((l) => l.source), profiles, documents, entityRoots, classFields, componentClassPrefixes: prefixes };
}

/** merge profile maps (highest precedence FIRST); null removes a lower layer's profile / slot */
function mergeProfileMaps(maps: (Record<string, PackProfile | null> | undefined)[]): Record<string, ParagraphProfile> {
  const profiles: Record<string, ParagraphProfile> = {};
  // lowest layer first so higher layers override; slot order: lower layer's order, new slots appended
  for (const map of [...maps].reverse()) {
    for (const [machine, prof] of Object.entries(map ?? {})) {
      if (prof === null) {
        delete profiles[machine];
        continue;
      }
      const prev = profiles[machine];
      const slots: Record<string, SlotDef | string | null> = { ...toSlotRecord(prev?.slots), ...toSlotRecord(prof.slots as Record<string, SlotDef | string | null> | undefined) };
      for (const k of Object.keys(slots)) if (slots[k] === null) delete slots[k];
      const merged: ParagraphProfile = { ...(prev ?? {}), ...prof } as ParagraphProfile;
      if (prev?.flags || prof.flags) merged.flags = { ...(prev?.flags ?? {}), ...(prof.flags ?? {}) };
      if (Object.keys(slots).length || prev?.slots || prof.slots) merged.slots = slots as Record<string, SlotDef | string>;
      profiles[machine] = merged;
    }
  }
  return profiles;
}

/** Profile set for a theme pack id ("none" = generic only) plus an optional site pack on top. */
export function profileSetFor(themePackId: string, sitePack?: ProfilePack, siteSource = "site:mapping/profiles.yaml"): ProfileSet {
  const layers: { source: string; pack: ProfilePack }[] = [];
  if (sitePack) layers.push({ source: siteSource, pack: sitePack });
  if (themePackId !== "none") {
    const p = themePack(themePackId);
    if (!p) throw new Error(`theme pack "${themePackId}" not found in ${THEMES_DIR} (available: ${[...themePacks().keys()].join(", ") || "none"})`);
    layers.push({ source: `theme:${themePackId}`, pack: p });
  }
  layers.push({ source: "generic", pack: GENERIC_PACK });
  const id = [sitePack ? "site" : "", themePackId !== "none" ? themePackId : ""].filter(Boolean).join("+") || "none";
  return mergeProfilePacks(layers, { id, themePack: themePackId });
}

/** Generic only (themePack none, no site profiles): the baseline DeepSeek has to improve on. */
export const GENERIC_PROFILE_SET: ProfileSet = profileSetFor("none");

/**
 * Default for direct callers that do not resolve a set (unit tests, design mining): the da_vinci_code pack — the
 * behaviour of the former TS constants. The transform step resolves the real set (site > detected theme > generic).
 */
export const DEFAULT_PROFILE_SET: ProfileSet = profileSetFor("da_vinci_code");

/** @deprecated read from a ProfileSet; kept for callers of the former constants (= DEFAULT_PROFILE_SET). */
export const PARAGRAPH_PROFILES: Record<string, ParagraphProfile> = DEFAULT_PROFILE_SET.profiles;
/** @deprecated see PARAGRAPH_PROFILES */
export const ENTITY_ROOTS: EntityRootDef[] = DEFAULT_PROFILE_SET.entityRoots;
/** @deprecated see PARAGRAPH_PROFILES */
export const CLASS_FIELDS: ClassFieldDef[] = DEFAULT_PROFILE_SET.classFields;

// ------------------------------------------------------------------ detection

/** Theme names in HTML/asset paths: `/themes/custom/<theme>/` (and contrib `/themes/contrib/<theme>/`), most frequent first. */
export function detectThemes(texts: string[]): string[] {
  const n = new Map<string, number>();
  for (const t of texts) for (const m of t.matchAll(/\/themes\/(?:custom|contrib)\/([a-z0-9_]+)\//g)) n.set(m[1], (n.get(m[1]) ?? 0) + 1);
  for (const t of texts) for (const m of t.matchAll(/"ajaxPageState":\{[^}]*?"theme":"([a-z0-9_]+)"/g)) n.set(m[1], (n.get(m[1]) ?? 0) + 1000);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** Theme pack id for detected theme names (first pack whose `detect.themes` contains one), else "none". */
export function packForThemes(themes: string[]): string {
  const packs = themePacks();
  for (const t of themes) for (const [id, p] of packs) if ((p.detect?.themes ?? [id]).includes(t)) return id;
  return "none";
}

export function slotDef(s: SlotDef | string): SlotDef {
  return typeof s === "string" ? { sel: s, kind: "text" } : s;
}
