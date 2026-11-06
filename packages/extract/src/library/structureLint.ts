// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Structure checks of a component library (plan-component-quality §Q5 / §Q6): twins, single-use sets over budget,
// sections vs parts, sets still on their built-in " / " names, numbered / filler names, names that are page copy or a
// site's CSS classes, numbered props, pictures stored as text props. Pure: the design-system flow runs it between
// extraction and the finished library (dsflow/actions.ts checkComponents) and the app-run measuring imports this very
// file (scripts/lib/app-run/dsmetrics.mjs, Node strips the types) — so the module imports types only.
import type { SceneComponentDef, SceneElement, SceneScreen } from "@harness/protocol";

/** The flow stage that can fix a failing check (dsflow/actions.ts re-runs it with the findings as hints). */
export type LintStage = "extract" | "naming" | "props";

export type LintCheckId =
  | "twins"
  | "single-use"
  | "budget"
  | "ratio"
  | "unnamed"
  | "numbered-names"
  | "filler-names"
  | "page-copy"
  | "css-class"
  | "numbered-props"
  | "image-text";

export interface LintCheck {
  id: LintCheckId;
  /** what is checked, for the flow panel and the compare page */
  label: string;
  ok: boolean;
  /** what was found (sets, groups, props) */
  count: number;
  /** the most allowed */
  limit: number;
  /** one line: the numbers behind the verdict */
  detail: string;
  /** the sets (or props, "Set.prop"; twins "A = B") that fail it */
  sets: string[];
  /** their ids (for a retry of just these sets) */
  ids: string[];
  stage: LintStage;
}

export interface StructureLint {
  ok: boolean;
  checks: LintCheck[];
  counts: {
    sets: number;
    extracted: number;
    /** extracted page sections (header, hero, section, footer, menu) */
    sections: number;
    /** extracted parts that are not sections, icons or logos */
    parts: number;
    icons: number;
    /** extracted sets used in one place of one page (each width counted once) */
    singleUse: number;
    singleUseSections: number;
    singleUseParts: number;
    /** extracted sets nothing uses */
    unused: number;
    /** distinct section slots across every captured page and its menus (a set recurring on pages counted once) */
    pageSections: number;
    /** extracted sets the screens justify: section slots + parts used more than once + icons + allowed single-use parts */
    budget: number;
  };
}

export interface LintBudget {
  /** sections / parts above this fails the ratio check (default 1: a system has more parts than sections) */
  ratio: number;
  /** share of the extracted parts that may be single-use (default 0.1) */
  singleUseParts: number;
}

export interface LintInput {
  sets: SceneComponentDef[];
  /** the source screens: pages and their menu overlays (not the Components frame) */
  screens: Array<Pick<SceneScreen, "id" | "root"> & { responsive?: SceneScreen["responsive"] }>;
  /** ids of the sets this run made: naming and prop checks look at these (default: every extracted set) */
  scope?: string[];
  /** the prop names of a set's API (catalog.ts componentApi labels); default: its properties + named slots */
  apiProps?: (def: SceneComponentDef) => string[];
  /**
   * The naming step's outcome (dsflow/namingRun.ts NamingOutcome, as ids): sets it left on built-in names or gave only
   * a fallback name count as unnamed / to retry; only `complete` is a finished naming step.
   */
  naming?: { status: string; unnamed?: string[]; fallback?: string[] };
  /** the numbered props of a set (catalog.ts numberedProps labels); default: numberedPropNames of `apiProps` */
  numberedProps?: (def: SceneComponentDef) => string[];
  /** a set flagged numbered by its namer (extract.ts uniqueName): counted as numbered even without a trailing digit */
  numbered?: (def: SceneComponentDef) => boolean;
  /** a section the extraction marked as a genuinely unique section (vs a failed merge): not counted single-use */
  uniqueSection?: (def: SceneComponentDef) => boolean;
  /** framework class prefixes besides the built-in list */
  classPrefixes?: string[];
  budget?: Partial<LintBudget>;
}

export const DEFAULT_BUDGET: LintBudget = { ratio: 1, singleUseParts: 0.1 };

/**
 * A lone section whose nearest miss (extract.ts ExtractionNotes.nearest, similarity 0–1; merge at 0.85) is at least this
 * close is a failed merge — a near-miss twin — not a unique section.
 */
export const NEAR_MISS = 0.7;
/** extract.ts ExtractionNotes as the def carries them (`extraction`), read without importing extract.ts */
const notesOf = (d: SceneComponentDef) =>
  (d as SceneComponentDef & { extraction?: { single?: boolean; nearest?: number; nameClash?: string } })
    .extraction;
/** a section the extraction found once and matched to nothing near: unique, not a defect */
export const uniqueSectionByNotes = (d: SceneComponentDef) => {
  const n = notesOf(d);
  return !!n?.single && (n.nearest ?? 0) < NEAR_MISS;
};

/* ------------------------------------------------------------------ name tests (dsmetrics.mjs uses the same) */

/** a name ending in a number ("Icon 2", "ButtonOutlineLight2") */
export const numberedName = (n: string) =>
  /(^|[^\d])\d+$/.test(String(n).trim()) && !/^(h[1-6]|[A-Z]\d)$/.test(String(n).trim());
/** a name with a filler suffix instead of saying what differs ("AppLinksListAlt", "Card variant") */
export const fillerName = (n: string) =>
  /(?:\b|[a-z])(Alt|Alternative|Variant|Other|Copy|New)$/.test(String(n).trim());
/** a prop name ending in a number (`link1`, `teaserText8`, `Title 2`) */
export const numberedProp = (n: string) => /\d$/.test(String(n).trim());
/** what one item of a list is called (catalog.ts ITEM_NOUN; "Item" for anything else) */
const ITEM_NOUNS = new Set([
  "item",
  "card",
  "teaser",
  "link",
  "stat",
  "quote",
  "button",
  "tag",
  "badge",
  "picture",
  "logo",
  "avatar",
]);
/**
 * The numbered ones among a set's prop names, as catalog.ts `numberedProps` counts them: a list's entries ("Item 1",
 * "Item 2"… — they start at 1, where flat numbering starts at the bare name) and item slots (`cards[0].title`) are
 * grouped per item, not a hit.
 */
export function numberedPropNames(names: readonly string[]): string[] {
  const entry = /^([A-Za-z]+) ?(\d+)$/;
  const firsts = new Set(
    names
      .map((n) => entry.exec(n.trim()))
      .filter((m) => m && m[2] === "1")
      .map((m) => m![1]!.toLowerCase()),
  );
  return names.filter((n) => {
    if (!numberedProp(n) || /\[\d+\]/.test(n)) return false;
    const m = entry.exec(n.trim());
    return !(m && ITEM_NOUNS.has(m[1]!.toLowerCase()) && firsts.has(m[1]!.toLowerCase()));
  });
}
/** the extraction's own name ("Section / Hero", "Card / with image 2"): the AI naming step did not rename it */
export const builtinName = (n: string) => String(n).includes(" / ");

/** Page sections (the extraction's `section` sets); icons and logos are budgeted on their own. */
export const SECTION_KINDS = new Set<string>(["header", "footer", "hero", "section", "menu"]);
const ICON_KINDS = new Set<string>(["icon", "logo"]);

/** Class prefixes of CSS frameworks and component libraries a capture's layer names carry ("cds--card" → "Cds card"). */
export const CLASS_PREFIXES = [
  "cds",
  "bx",
  "dds",
  "c4d",
  "swiper",
  "owl",
  "slick",
  "splide",
  "glide",
  "flickity",
  "mdc",
  "mat",
  "mui",
  "ant",
  "chakra",
  "elementor",
  "wp",
  "vc",
  "et",
  "uk",
  "js",
  "jsx",
  "css",
  "sc",
  "tw",
  "btn",
  "cmp",
  "comp",
  "aem",
  "coral",
  "spectrum",
  "bs",
  "fa",
  "icn",
  "ico",
  "gl",
  "cq",
];

/** words of a name: segments split at " / ", camelCase and non-letters; lower case, accents stripped */
export function nameWords(name: string): string[] {
  return String(name)
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** a text's words for page-copy matching (same normalisation as nameWords, without the camelCase split) */
const textWords = (t: string) =>
  t
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** words that say what a part is, not what it says: dropped before matching a name against page copy */
const HEAD_NOUNS = new Set([
  "section",
  "card",
  "hero",
  "header",
  "footer",
  "menu",
  "teaser",
  "tile",
  "wrapper",
  "block",
  "group",
  "list",
  "item",
  "link",
  "links",
  "button",
  "icon",
  "logo",
  "banner",
  "band",
  "grid",
  "row",
  "nav",
  "navigation",
  "bar",
  "cta",
  "heading",
  "title",
  "text",
  "image",
  "media",
  "stat",
  "quote",
  "carousel",
  "slider",
  "tabs",
  "tab",
  "accordion",
  "form",
  "input",
  "badge",
  "tag",
  "alert",
  "modal",
  "video",
  "container",
  "content",
  "with",
  "large",
  "small",
]);

/** The words of a name that are copy, not its kind ("Section / Schulungen für die Zukunft" → schulungen fur die zukunft). */
function copyWords(name: string): string[][] {
  const segments = String(name).split(" / ");
  return segments.map((s) => nameWords(s).filter((w) => !HEAD_NOUNS.has(w)));
}

/** a name that repeats a captured text of ≥ 3 words (its heading, its button label) */
export function pageCopyName(name: string, texts: ReadonlySet<string> | string[]): boolean {
  for (const words of copyWords(name)) {
    if (words.length < 3) continue;
    const needle = ` ${words.join(" ")} `;
    for (const t of texts) if (t.includes(needle)) return true;
  }
  return false;
}

/** captured texts of ≥ 3 words, normalised (` word word word `) for pageCopyName */
export function pageTexts(roots: Array<SceneElement | undefined>): Set<string> {
  const out = new Set<string>();
  const walk = (e: SceneElement | undefined) => {
    if (!e) return;
    if (typeof e.text === "string") {
      const w = textWords(e.text);
      if (w.length >= 3) out.add(` ${w.join(" ")} `);
    }
    e.children?.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/** a name made of a site's CSS classes: a framework prefix ("Cds card content", "SwiperSlide") or a hash-like token */
export function cssClassName(name: string, prefixes: readonly string[] = CLASS_PREFIXES): boolean {
  const set = new Set(prefixes);
  const words = nameWords(name);
  if (words.some((w) => set.has(w))) return true;
  // CSS-in-JS / module hashes: letters and digits mixed ("jxm3yrc", "1q2w3e"), or a long run without a vowel
  return words.some(
    (w) =>
      (w.length >= 4 &&
        /\d/.test(w) &&
        /[a-z]/.test(w) &&
        !/^\d+(px|x|k|m|s|d)$/.test(w) &&
        !/^(h[1-6]|[a-z]\d)$/.test(w)) ||
      (w.length >= 5 && /^[a-z]+$/.test(w) && !/[aeiouy]/.test(w)),
  );
}

/* ------------------------------------------------------------------ structure */

const CONTENT = new Set([
  "id",
  "name",
  "text",
  "runs",
  "svg",
  "icon",
  "image",
  "interaction",
  "meta",
  "instance",
  "children",
]);
/** a main's structure without its content (copy, icon, picture, link, layer names) */
export function mainShape(e: SceneElement): string {
  const rec = e as unknown as Record<string, unknown>;
  return `${JSON.stringify(
    Object.entries(rec)
      .filter(([k]) => !CONTENT.has(k))
      .sort(),
  )}[${(e.children ?? []).map(mainShape).join(",")}]`;
}

/**
 * Groups of extracted sets whose default mains are the same but for their content. Icons and logos are left out: their
 * glyph is what they are (two arrows that differ only in their path are two icons, not twins).
 */
export function twinGroups(sets: SceneComponentDef[]): SceneComponentDef[][] {
  const byShape = new Map<string, SceneComponentDef[]>();
  for (const d of sets) {
    if (d.origin === "generated" || d.origin === "manual" || ICON_KINDS.has(d.kind ?? "")) continue;
    const m = d.variants?.[d.defaultVariant];
    if (!m) continue;
    const k = `${d.kind}|${mainShape(m)}`;
    byShape.set(k, [...(byShape.get(k) ?? []), d]);
  }
  return [...byShape.values()].filter((g) => g.length > 1);
}

export interface SetUse {
  /** page groups (a responsive page at all its widths is one; a menu belongs to its page) it appears on */
  pages: number;
  /** most copies on one screen */
  perScreen: number;
  /** other sets whose mains hold it */
  parents: number;
}

/** Where every set is used: the screens' instances (nested ones too) and the other sets' mains. */
export function setUses(sets: SceneComponentDef[], screens: LintInput["screens"]): Map<string, SetUse> {
  const out = new Map<string, { pages: Set<string>; perScreen: number; parents: Set<string> }>();
  const get = (id: string) => {
    let u = out.get(id);
    if (!u) out.set(id, (u = { pages: new Set(), perScreen: 0, parents: new Set() }));
    return u;
  };
  const byId = new Map(screens.map((s) => [s.id, s]));
  const groupOf = (s: LintInput["screens"][number]): string => {
    const host = s.root?.meta?.overlayOf;
    const h = typeof host === "string" ? byId.get(host) : undefined;
    return h ? (h.responsive?.group ?? h.id) : (s.responsive?.group ?? s.id);
  };
  for (const s of screens) {
    const counts = new Map<string, number>();
    const walk = (e: SceneElement) => {
      if (e.instance) counts.set(e.instance.componentId, (counts.get(e.instance.componentId) ?? 0) + 1);
      e.children?.forEach(walk);
    };
    if (s.root) walk(s.root);
    const g = groupOf(s);
    for (const [id, n] of counts) {
      const u = get(id);
      u.pages.add(g);
      u.perScreen = Math.max(u.perScreen, n);
    }
  }
  for (const d of sets) {
    for (const v of Object.values(d.variants ?? {})) {
      const walk = (e: SceneElement, root: boolean) => {
        if (!root && e.instance && e.instance.componentId !== d.id)
          get(e.instance.componentId).parents.add(d.id);
        e.children?.forEach((c) => walk(c, false));
      };
      walk(v, true);
    }
  }
  return new Map(
    [...out].map(([id, u]) => [id, { pages: u.pages.size, perScreen: u.perScreen, parents: u.parents.size }]),
  );
}

/**
 * Distinct section slots across every captured page: per page (a responsive group; its menus as a page of their own)
 * the sections at the width that shows the most — section instances plus top-level layers that are no section and hold
 * none; summed over the pages with a section set counted once wherever it recurs (the header and footer every page
 * shares are two slots, not 2×N); plus the section sets nested in other sets' mains (a mobile menu inside the nav bar).
 */
function sectionSlots(
  screens: LintInput["screens"],
  sets: SceneComponentDef[],
  sectionIds: ReadonlySet<string>,
): number {
  const byId = new Map(screens.map((s) => [s.id, s]));
  const groupOf = (s: LintInput["screens"][number]): string => {
    const host = s.root?.meta?.overlayOf;
    const h = typeof host === "string" ? byId.get(host) : undefined;
    return h ? `${h.responsive?.group ?? h.id}#menus` : (s.responsive?.group ?? s.id);
  };
  const pages = new Map<string, { ids: Map<string, number>; raw: number }>();
  for (const s of screens) {
    const ids = new Map<string, number>();
    const walk = (e: SceneElement) => {
      if (e.instance) {
        if (sectionIds.has(e.instance.componentId))
          ids.set(e.instance.componentId, (ids.get(e.instance.componentId) ?? 0) + 1);
        return;
      }
      e.children?.forEach(walk);
    };
    if (s.root) walk(s.root);
    // a top-level layer that is no section and holds none (a section the extraction left raw); a wrapper around
    // sections (`main`) is not a slot of its own
    const holds = (e: SceneElement): boolean =>
      e.instance ? sectionIds.has(e.instance.componentId) : (e.children ?? []).some(holds);
    const raw = (s.root?.children ?? []).filter(
      (c) => c.meta?.hidden !== true && !c.instance && !holds(c) && !!c.children?.length,
    ).length;
    // the width with the most section positions stands for the page: one slot shown by two sets at two widths is
    // one slot (the extra set is a failed breakpoint merge, not a section of its own)
    const g = groupOf(s);
    const total = raw + [...ids.values()].reduce((a, b) => a + b, 0);
    const cur = pages.get(g);
    if (!cur || total > cur.raw + [...cur.ids.values()].reduce((a, b) => a + b, 0))
      pages.set(g, { ids, raw });
  }
  const slots = new Map<string, number>();
  let raw = 0;
  for (const p of pages.values()) {
    raw += p.raw;
    for (const [id, n] of p.ids) slots.set(id, Math.max(slots.get(id) ?? 0, n));
  }
  for (const d of sets) {
    for (const v of Object.values(d.variants ?? {})) {
      const walk = (e: SceneElement, root: boolean) => {
        if (
          !root &&
          e.instance &&
          e.instance.componentId !== d.id &&
          sectionIds.has(e.instance.componentId) &&
          !slots.has(e.instance.componentId)
        )
          slots.set(e.instance.componentId, 1);
        e.children?.forEach((c) => walk(c, false));
      };
      walk(v, true);
    }
  }
  return raw + [...slots.values()].reduce((a, b) => a + b, 0);
}

/** the prop names of a set: its properties and the names given to its content slots */
export const defaultApiProps = (d: SceneComponentDef) => [
  ...(d.properties ?? []).map((p) => p.name),
  ...Object.values(d.propNames ?? {}),
];

const list = (names: string[], n = 6) =>
  names.length ? `: ${names.slice(0, n).join(", ")}${names.length > n ? ` +${names.length - n}` : ""}` : "";

/** Run every check. */
export function structureLint(input: LintInput): StructureLint {
  const budgetOpt = { ...DEFAULT_BUDGET, ...input.budget };
  const sets = input.sets;
  // the sets the screens made (generated essentials and sets made by hand are not the extraction's)
  const extracted = sets.filter((d) => d.origin !== "generated" && d.origin !== "manual");
  const inScope = input.scope ? new Set(input.scope) : null;
  const scoped = inScope ? extracted.filter((d) => inScope.has(d.id)) : extracted;
  const isSection = (d: SceneComponentDef) => SECTION_KINDS.has(d.kind ?? "");
  const isIcon = (d: SceneComponentDef) => ICON_KINDS.has(d.kind ?? "");
  const names = (ds: SceneComponentDef[]) => ds.map((d) => d.name);
  const ids = (ds: SceneComponentDef[]) => ds.map((d) => d.id);
  const sections = extracted.filter(isSection);
  const parts = extracted.filter((d) => !isSection(d) && !isIcon(d));
  const icons = extracted.filter(isIcon);
  const uses = setUses(sets, input.screens);
  const use = (d: SceneComponentDef): SetUse => uses.get(d.id) ?? { pages: 0, perScreen: 0, parents: 0 };
  const places = (u: SetUse) => u.pages + u.parents;
  const unused = extracted.filter((d) => places(use(d)) === 0);
  const unique = input.uniqueSection ?? uniqueSectionByNotes;
  const single = extracted.filter(
    (d) => !isIcon(d) && places(use(d)) === 1 && use(d).perScreen <= 1 && !unique(d),
  );
  const nearMiss = extracted.filter((d) => notesOf(d)?.single && (notesOf(d)?.nearest ?? 0) >= NEAR_MISS);
  const singleSections = single.filter(isSection);
  const singleParts = single.filter((d) => !isSection(d));
  const pageSecs = sectionSlots(input.screens, extracted, new Set(ids(sections)));
  const repeatedParts = parts.filter((d) => !single.includes(d) && places(use(d)) > 0).length;
  const partsAllowed = Math.floor(parts.length * budgetOpt.singleUseParts);
  // the page budget: every section slot, the parts that repeat, the icons, and the single-use parts the single-use
  // allowance admits (a skip link, a chat button: one per site, not bloat)
  const singleAllowed = Math.min(singleParts.length, partsAllowed);
  const budget = pageSecs + repeatedParts + icons.length + singleAllowed;
  const texts = pageTexts([
    ...input.screens.map((s) => s.root),
    ...extracted.flatMap((d) => Object.values(d.variants ?? {})),
  ]);
  const checks: LintCheck[] = [];
  const add = (c: Omit<LintCheck, "ok"> & { ok?: boolean }) =>
    checks.push({ ...c, ok: c.ok ?? c.count <= c.limit });

  const twins = twinGroups(extracted);
  add({
    id: "twins",
    label: "No twins",
    count: twins.length,
    limit: 0,
    stage: "extract",
    detail: `${twins.length} group${twins.length === 1 ? "" : "s"} of sets that differ only in content`,
    sets: twins.map((g) => names(g).join(" = ")),
    ids: twins.flat().map((d) => d.id),
  });
  const overSections = Math.max(0, singleSections.length - pageSecs);
  const overParts = Math.max(0, singleParts.length - partsAllowed);
  add({
    id: "single-use",
    label: "Single-use sets within budget",
    count: single.length,
    limit: pageSecs + partsAllowed,
    ok: !overSections && !overParts,
    stage: "extract",
    detail: `${singleSections.length} single-use section${singleSections.length === 1 ? "" : "s"} (≤ ${pageSecs}) · ${singleParts.length} single-use part${singleParts.length === 1 ? "" : "s"} (≤ ${partsAllowed})${nearMiss.length ? ` · ${nearMiss.length} near-miss twin${nearMiss.length === 1 ? "" : "s"}${list(names(nearMiss), 3)}` : ""}`,
    sets: [...(overSections ? names(singleSections) : []), ...names(singleParts)],
    ids: [...(overSections ? ids(singleSections) : []), ...ids(singleParts)],
  });
  add({
    id: "budget",
    label: "Sets within the page budget",
    count: extracted.length,
    limit: budget,
    stage: "extract",
    detail: `${extracted.length} extracted of ${budget} (${pageSecs} section slots + ${repeatedParts} repeated parts + ${icons.length} icons + ${singleAllowed} single-use parts)${unused.length ? ` · ${unused.length} unused${list(names(unused), 4)}` : ""}`,
    sets: names(unused),
    ids: ids(unused),
  });
  const ratio = parts.length ? sections.length / parts.length : sections.length ? Infinity : 0;
  add({
    id: "ratio",
    label: "More parts than sections",
    count: Math.round(ratio * 100) / 100,
    limit: budgetOpt.ratio,
    ok: ratio <= budgetOpt.ratio,
    stage: "extract",
    detail: `${sections.length} sections : ${parts.length} parts`,
    sets: [],
    ids: [],
  });

  const nm = input.naming;
  const leftIds = new Set(nm?.unnamed ?? []);
  const fallbackIds = new Set(nm?.fallback ?? []);
  const builtin = scoped.filter((d) => builtinName(d.name) || leftIds.has(d.id));
  const fallback = scoped.filter((d) => fallbackIds.has(d.id) && !builtin.includes(d));
  const unfinished = !!nm && nm.status !== "complete" && nm.status !== "skipped";
  add({
    id: "unnamed",
    label: "Every set named",
    count: builtin.length,
    limit: 0,
    ok: !builtin.length && !fallback.length && !unfinished,
    stage: "naming",
    detail:
      [
        builtin.length
          ? `${builtin.length} set${builtin.length === 1 ? "" : "s"} still on the built-in name`
          : "",
        fallback.length ? `${fallback.length} with a fallback name only` : "",
        unfinished ? `naming ${nm!.status}` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "naming complete",
    sets: [...names(builtin), ...fallback.map((d) => `${d.name} (fallback)`)],
    ids: [...ids(builtin), ...ids(fallback)],
  });
  const numbered = scoped.filter((d) => numberedName(d.name) || !!input.numbered?.(d));
  add({
    id: "numbered-names",
    label: "No numbered names",
    count: numbered.length,
    limit: 0,
    stage: "naming",
    detail: `${numbered.length} numbered`,
    sets: names(numbered),
    ids: ids(numbered),
  });
  const filler = scoped.filter((d) => fillerName(d.name));
  add({
    id: "filler-names",
    label: "No filler suffixes",
    count: filler.length,
    limit: 0,
    stage: "naming",
    detail: `${filler.length} with Alt / Variant / Copy…`,
    sets: names(filler),
    ids: ids(filler),
  });
  const copy = scoped.filter((d) => pageCopyName(d.name, texts));
  add({
    id: "page-copy",
    label: "No page copy in names",
    count: copy.length,
    limit: 0,
    stage: "naming",
    detail: `${copy.length} named after a captured text`,
    sets: names(copy),
    ids: ids(copy),
  });
  const prefixes = [...CLASS_PREFIXES, ...(input.classPrefixes ?? [])];
  const css = scoped.filter((d) => cssClassName(d.name, prefixes));
  add({
    id: "css-class",
    label: "No CSS-class names",
    count: css.length,
    limit: 0,
    stage: "naming",
    detail: `${css.length} named after the site's CSS classes`,
    sets: names(css),
    ids: ids(css),
  });

  const apiProps = input.apiProps ?? defaultApiProps;
  const numberedOf =
    input.numberedProps ?? ((d: SceneComponentDef) => numberedPropNames([...new Set(apiProps(d))]));
  const numberedProps = scoped.flatMap((d) => numberedOf(d).map((p) => ({ d, p })));
  add({
    id: "numbered-props",
    label: "No numbered props",
    count: numberedProps.length,
    limit: 0,
    stage: "props",
    detail: `${numberedProps.length} numbered prop${numberedProps.length === 1 ? "" : "s"} (Title 2…)`,
    sets: numberedProps.map((x) => `${x.d.name}.${x.p}`),
    ids: [...new Set(numberedProps.map((x) => x.d.id))],
  });
  const imageText = scoped.flatMap((d) =>
    (d.properties ?? [])
      .filter(
        (p) =>
          p.type === "text" &&
          typeof p.default === "string" &&
          /^data:|^(https?:)?\/\/\S+\.(png|jpe?g|webp|avif|gif|svg)(\?\S*)?$/i.test(p.default.trim()),
      )
      .map((p) => ({ d, p: p.name })),
  );
  add({
    id: "image-text",
    label: "Pictures are image props",
    count: imageText.length,
    limit: 0,
    stage: "props",
    detail: `${imageText.length} picture${imageText.length === 1 ? "" : "s"} stored as a text prop`,
    sets: imageText.map((x) => `${x.d.name}.${x.p}`),
    ids: [...new Set(imageText.map((x) => x.d.id))],
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    counts: {
      sets: sets.length,
      extracted: extracted.length,
      sections: sections.length,
      parts: parts.length,
      icons: icons.length,
      singleUse: single.length,
      singleUseSections: singleSections.length,
      singleUseParts: singleParts.length,
      unused: unused.length,
      pageSections: pageSecs,
      budget,
    },
  };
}

/** "components: 38 sets · 0 twins · 0 numbered · naming complete" — the flow panel's one-line summary */
export function lintSummary(l: StructureLint): string {
  const c = (id: LintCheckId) => l.checks.find((x) => x.id === id);
  const unnamed = c("unnamed")!;
  return `${l.counts.extracted} set${l.counts.extracted === 1 ? "" : "s"} · ${c("twins")!.count} twins · ${c("numbered-names")!.count} numbered · ${unnamed.count ? `${unnamed.count} unnamed` : "naming complete"}`;
}
