// The `flow` gate: CSS that only holds at the widths it was checked at. A recreation must flow (document flow, flex,
// grid, fluid values) so it holds at every width; these rules find what fits measured numbers instead: a media query
// around one width, a value that jumps between widths, scaling, and in CSS added after the build (a repair) boxes
// taken out of the flow, fixed heights, unscoped selectors and `!important`. Pure: CSS text in, findings out.
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";

export type FlowRule =
  | "media-pin"
  | "value-pin"
  | "zoom"
  | "added-out-of-flow"
  | "added-fixed-size"
  | "added-unscoped"
  | "added-important"
  | "parse";

export interface FlowViolation {
  rule: FlowRule;
  selector?: string;
  prop?: string;
  value?: string;
  /** the media query around the rule, if any */
  media?: string;
  /** the declaration is in CSS added after the build */
  added: boolean;
  detail: string;
}

export interface FlowLintResult {
  violations: FlowViolation[];
  counts: Partial<Record<FlowRule, number>>;
  /** style rules in the stylesheet / of them added after the build */
  rules: number;
  added: number;
}

export interface FlowLintOptions {
  css: string;
  /**
   * What counts as added after the build: a string is the stylesheet the build wrote (rules not in it are added),
   * null means every rule is added (a proposed patch), undefined none (the emitter's own output).
   */
  baseline?: string | null;
  /** selectors of added rules must name one of these (a section's classes, or `[data-section="ID"]` for these ids) */
  scope?: { ids: string[]; classes: string[] };
  /** classes of images, videos and other media: a fixed height on them is their size, not a pin */
  mediaClasses?: Iterable<string>;
  /** widths the emitter's own variants switch at: media queries at them are breakpoints, not pins */
  boundaries?: number[];
  /** classes of sections the emitter kept at their fitted geometry (reported, not flagged) */
  exempt?: Iterable<string>;
}

/** A media query range narrower than this is a pin around one width, not a layout range. */
export const MEDIA_PIN_PX = 16;

const MEDIA_TAGS = /(^|[\s>+~])(img|video|picture|svg|iframe|canvas|source)(?=$|[\s.#:[>+~])/i;

/** `(min-width: 768px)` / `(max-width: 1023.98px)` / `(width: 1440px)` / `(600px <= width < 700px)` → bounds. */
export function mediaWidths(params: string): { min?: number; max?: number; exact?: number } | null {
  const q = params.toLowerCase();
  if (!/width/.test(q) || /device-width/.test(q)) return null;
  const px = (v: string, unit: string) => Number(v) * (unit === "em" || unit === "rem" ? 16 : 1);
  const out: { min?: number; max?: number; exact?: number } = {};
  for (const m of q.matchAll(/\(\s*(min-|max-)?width\s*:\s*(-?\d*\.?\d+)(px|em|rem)\s*\)/g)) {
    const v = px(m[2]!, m[3]!);
    if (m[1] === "min-") out.min = Math.max(out.min ?? -Infinity, v);
    else if (m[1] === "max-") out.max = Math.min(out.max ?? Infinity, v);
    else out.exact = v;
  }
  // range syntax: (a < width), (width <= b), (a <= width < b)
  for (const m of q.matchAll(
    /\(\s*(?:(-?\d*\.?\d+)(px|em|rem)\s*(<=?|>=?)\s*)?width\s*(?:(<=?|>=?)\s*(-?\d*\.?\d+)(px|em|rem))?\s*\)/g,
  )) {
    if (m[1] !== undefined) {
      const v = px(m[1], m[2]!);
      if (m[3]!.startsWith("<")) out.min = Math.max(out.min ?? -Infinity, v);
      else out.max = Math.min(out.max ?? Infinity, v);
    }
    if (m[5] !== undefined) {
      const v = px(m[5], m[6]!);
      if (m[4]!.startsWith("<")) out.max = Math.min(out.max ?? Infinity, v);
      else out.min = Math.max(out.min ?? -Infinity, v);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Is `@media params` an exact width or a range narrower than MEDIA_PIN_PX (other than at the variants' boundaries)? */
export function isMediaPin(params: string, boundaries: number[] = []): boolean {
  const w = mediaWidths(params);
  if (!w) return false;
  if (w.exact !== undefined) return true;
  if (w.min === undefined || w.max === undefined) return false;
  if (w.max - w.min >= MEDIA_PIN_PX) return false;
  // the emitter's own ranges start and end at its boundaries (max is the next boundary − 0.02)
  const near = (v: number) => boundaries.some((b) => Math.abs(b - v) <= 0.05);
  return !(near(w.min) && near(w.max + 0.02));
}

/**
 * A value that jumps: a large factor on a viewport term (`(100vw − 768px) * 1000` inside clamp() is a step of a few
 * px within a thousandth of a px of one width; `1000 * max(…)` is loose everywhere but at one width).
 */
export function isValuePin(value: string): boolean {
  if (!/(vw|vi|vmin|vmax|cqw|cqi|%)/.test(value)) return false;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)\s*\*|\*\s*(\d+(?:\.\d+)?)/g)) {
    const n = Number(m[1] ?? m[2]);
    if (n >= 100) return true;
  }
  return false;
}

const negative = (v: string) => /(^|[\s(,])-\d*\.?\d+(px|em|rem|%|vw)/.test(v);

const classesOf = (selector: string) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);

/** The flow findings of a stylesheet (see the module comment). */
export function flowLint(o: FlowLintOptions): FlowLintResult {
  const violations: FlowViolation[] = [];
  let root: postcss.Root;
  try {
    root = postcss.parse(o.css);
  } catch (e) {
    return {
      violations: [{ rule: "parse", added: true, detail: `the CSS does not parse: ${(e as Error).message}` }],
      counts: { parse: 1 },
      rules: 0,
      added: 0,
    };
  }
  const baseline = typeof o.baseline === "string" ? ruleKeys(o.baseline) : null;
  const allAdded = o.baseline === null;
  const media = new Set(o.mediaClasses ?? []);
  const exempt = new Set(o.exempt ?? []);
  const boundaries = o.boundaries ?? [];
  let rules = 0,
    added = 0;
  const push = (v: FlowViolation) => violations.push(v);
  const mediaOf = (n: postcss.Node): string | undefined => {
    for (let p = n.parent as postcss.Node | undefined; p; p = p.parent as postcss.Node | undefined)
      if (p.type === "atrule" && (p as AtRule).name === "media") return (p as AtRule).params;
    return undefined;
  };
  root.walkAtRules("media", (a) => {
    if (!isMediaPin(a.params, boundaries)) return;
    const isAdded = allAdded || (baseline !== null && !baseline.has(atKey(a)));
    // a pinned query around the emitter's exempt (fitted) sections only is reported by the rules inside
    const sels: string[] = [];
    a.walkRules((r) => {
      sels.push(r.selector);
    });
    if (!isAdded && sels.length && sels.every((s) => classesOf(s).some((c) => exempt.has(c)))) return;
    push({
      rule: "media-pin",
      media: a.params,
      added: isAdded,
      detail: `@media ${a.params} holds at a single width (or a range under ${MEDIA_PIN_PX}px)`,
    });
  });
  root.walkRules((r: Rule) => {
    // keyframe steps are not style rules
    if (r.parent?.type === "atrule" && /keyframes$/i.test((r.parent as AtRule).name)) return;
    rules++;
    const isAdded = allAdded || (baseline !== null && !baseline.has(ruleKey(r)));
    if (isAdded) added++;
    const cls = classesOf(r.selector);
    if (!isAdded && cls.some((c) => exempt.has(c))) return;
    const isMedia = r.selector
      .split(",")
      .every((s) => MEDIA_TAGS.test(s.trim()) || classesOf(s).some((c) => media.has(c)));
    const at = mediaOf(r);
    const base = { selector: r.selector, added: isAdded, ...(at ? { media: at } : {}) };
    if (isAdded && o.scope) {
      const ids = new Set(o.scope.ids),
        ok = new Set(o.scope.classes);
      const scoped = r.selector.split(",").every((s) => {
        const attr = [...s.matchAll(/\[data-section\s*=\s*["']?([^"'\]]+)["']?\s*\]/g)].some((m) =>
          ids.has(m[1]!),
        );
        return attr || classesOf(s).some((c) => ok.has(c));
      });
      if (!scoped)
        push({
          ...base,
          rule: "added-unscoped",
          detail: `"${r.selector}" is not scoped to the section (its classes or [data-section="ID"])`,
        });
    }
    let sticky = false;
    r.walkDecls("position", (d) => {
      if (/sticky/i.test(d.value)) sticky = true;
    });
    r.walkDecls((d: Declaration) => {
      const prop = d.prop.toLowerCase();
      const value = d.value;
      const v = { ...base, prop, value };
      if (isValuePin(value))
        push({ ...v, rule: "value-pin", detail: `${prop}: ${short(value)} jumps between widths` });
      if (prop === "zoom" && !/^(1|normal|reset|100%)$/i.test(value.trim()))
        push({
          ...v,
          rule: "zoom",
          detail: `zoom: ${short(value)} scales the layout instead of reflowing it`,
        });
      if (!isAdded) return;
      if (d.important) push({ ...v, rule: "added-important", detail: `${prop}: … !important` });
      if (prop === "position" && /^(absolute|fixed)$/i.test(value.trim()))
        push({ ...v, rule: "added-out-of-flow", detail: `position: ${value} takes the box out of the flow` });
      if (
        /^(margin|margin-(top|right|bottom|left|block|inline)(-start|-end)?)$/.test(prop) &&
        negative(value)
      )
        push({ ...v, rule: "added-out-of-flow", detail: `${prop}: ${value} pulls the box into place` });
      if ((prop === "transform" && /translate/i.test(value)) || prop === "translate")
        push({
          ...v,
          rule: "added-out-of-flow",
          detail: `${prop}: ${short(value)} moves the box into place`,
        });
      if (
        !sticky &&
        (prop === "inset" || /^(top|left|right|bottom)$/.test(prop)) &&
        /\d(px|em|rem)/.test(value) &&
        !/^0(px)?$/.test(value.trim())
      )
        push({ ...v, rule: "added-out-of-flow", detail: `${prop}: ${value} places the box by coordinates` });
      if (
        /^(height|max-height|block-size|max-block-size)$/.test(prop) &&
        /\d(px|em|rem)/.test(value) &&
        !isMedia
      )
        push({
          ...v,
          rule: "added-fixed-size",
          detail: `${prop}: ${short(value)} fixes a box's height instead of letting it follow its content`,
        });
    });
  });
  const counts: Partial<Record<FlowRule, number>> = {};
  for (const x of violations) counts[x.rule] = (counts[x.rule] ?? 0) + 1;
  return { violations, counts, rules, added };
}

const short = (v: string) => (v.length > 80 ? `${v.slice(0, 77)}…` : v);

/** A rule's identity across two versions of a stylesheet: its media context, selector and declarations. */
function ruleKey(r: Rule): string {
  const ctx: string[] = [];
  for (
    let p: postcss.Node | undefined = r.parent as postcss.Node | undefined;
    p;
    p = p.parent as postcss.Node | undefined
  )
    if (p.type === "atrule") ctx.push(`@${(p as AtRule).name} ${(p as AtRule).params}`);
  const decls: string[] = [];
  r.walkDecls((d) => {
    decls.push(`${d.prop}:${d.value}${d.important ? "!" : ""}`);
  });
  return `${ctx.join("|")}{${r.selector}}${decls.join(";")}`;
}
function atKey(a: AtRule): string {
  const inner: string[] = [];
  a.walkRules((r) => {
    inner.push(ruleKey(r));
  });
  return `@${a.name} ${a.params}{${inner.join("\n")}}`;
}

function ruleKeys(css: string): Set<string> {
  const out = new Set<string>();
  try {
    const root = postcss.parse(css);
    root.walkRules((r) => {
      out.add(ruleKey(r));
    });
    root.walkAtRules("media", (a) => {
      out.add(atKey(a));
    });
  } catch {
    /* an unreadable baseline: everything counts as added */
  }
  return out;
}

/** Rules that fail the gate (the others are counted): CSS added after the build may never do these. */
export const ADDED_RULES: FlowRule[] = [
  "added-out-of-flow",
  "added-fixed-size",
  "added-unscoped",
  "added-important",
  "parse",
];
/** What a proposed repair is checked for before it is written. */
export const REPAIR_RULES: FlowRule[] = [...ADDED_RULES, "media-pin", "value-pin", "zoom"];

/** Classes of the elements of each `<!-- section:ID -->` block, and the classes of media elements. */
export function sectionClasses(html: string): { sections: Map<string, Set<string>>; media: Set<string> } {
  const sections = new Map<string, Set<string>>();
  for (const m of html.matchAll(/<!-- section:([^ ]+) -->([\s\S]*?)<!-- \/section -->/g)) {
    const set = sections.get(m[1]!) ?? new Set<string>();
    for (const c of m[2]!.matchAll(/class="([^"]+)"/g)) for (const k of c[1]!.split(/\s+/)) if (k) set.add(k);
    sections.set(m[1]!, set);
  }
  const media = new Set<string>();
  for (const m of html.matchAll(/<(img|video|picture|svg|iframe|canvas)\b[^>]*\sclass="([^"]+)"/gi))
    for (const k of m[2]!.split(/\s+/)) if (k) media.add(k);
  return { sections, media };
}
