// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Brand guide (DESIGN.md) — the deterministic writer (design-md--generator/PLAN.md §6.3, spec/format.md). Facts +
// the model's prose slots → the full DESIGN.md in the examples' format: YAML front matter (version, name, website,
// description, seo, mockups, colors, typography, rounded, spacing, components) and the 11 body sections in order.
// Written from the facts alone: every token, the colour bullet heads (**Label** (`{colors.key}` — #hex)), the
// Hierarchy, Border Radius Scale, Elevation and Breakpoints tables, the spacing / grid fact lines, a component's
// resolved props when its paragraph is missing, the substitutes and the gaps. Everything else comes from `prose`; a
// missing slot leaves its place empty (no placeholder text), so a failed slot stays visible. Every ref the writer emits
// names a token it writes. Pure.
import { KIND_LABELS } from "@harness/extract";
import type { SceneComponentKind } from "@harness/protocol";
import { COMPONENT_GROUPS, PILL } from "./naming.js";
import type { BrandFacts, ColorGroup, ComponentFact, ProseSlots } from "@harness/protocol";
import { block, decimal, list, quoted, scalar } from "./yaml.js";

/** The 11 `##` sections in the order the examples (and the linters) expect. */
export const SECTION_ORDER: readonly string[] = [
  "Overview",
  "Colors",
  "Typography",
  "Layout",
  "Elevation & Depth",
  "Shapes",
  "Components",
  "Do's and Don'ts",
  "Responsive Behavior",
  "Iteration Guide",
  "Known Gaps",
];

const COLOR_SECTIONS: Array<[string, ColorGroup[]]> = [
  ["Brand & Accent", ["brand", "accent"]],
  ["Surface", ["surface"]],
  ["Hairlines", ["hairline"]],
  ["Text", ["text"]],
  ["Semantic", ["semantic"]],
  ["Brand Gradient", ["gradient"]],
];
const PROP_ORDER = [
  "backgroundColor",
  "textColor",
  "typography",
  "rounded",
  "padding",
  "size",
  "height",
  "width",
];
const PROP_LABELS: Record<string, string> = {
  backgroundColor: "background",
  textColor: "text",
  typography: "type",
  rounded: "rounded",
  padding: "padding",
  size: "size",
  height: "height",
  width: "width",
};

const px = (v: number) => `${Math.round(v * 10) / 10}px`;
const ls = (v: number) => (Math.abs(v) < 0.05 ? "0" : px(v));
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const isRef = (v: string) => /^\{[a-z]+\.[\w-]+\}$/.test(v);
const kindLabel = (k: string) => KIND_LABELS[k as SceneComponentKind] ?? k;
const has = <T>(xs: T[] | undefined): xs is T[] => !!xs && xs.length > 0;
const nonEmpty = (s: string | undefined): s is string => !!s && !!s.trim();

/** Mockup ids for the kinds the system has (prose may choose its own). */
export function mockupsOf(f: BrandFacts): string[] {
  const kinds = new Set(f.components.map((c) => c.kind));
  const out: string[] = [];
  if (kinds.has("hero") || f.images.some((i) => i.role === "hero")) out.push("marketing-hero");
  if (
    ["card", "teaser", "carousel", "image"].some((k) => kinds.has(k)) ||
    f.images.some((i) => ["card", "thumbnail", "product"].includes(i.role))
  )
    out.push("media-grid");
  if (f.typography.some((t) => t.key === "code")) out.push("code-editor-ide");
  return out;
}

/* ------------------------------------------------------------------ front matter */

function frontMatter(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const out = ["---", "version: alpha", `name: ${scalar(f.name)}`];
  if (f.website) out.push(`website: ${quoted(f.website)}`);
  if (nonEmpty(p.description))
    out.push(`description: ${scalar(p.description.trim().replace(/\s*\n\s*/g, " "))}`);
  out.push("", "seo:");
  const seo = p.seo;
  if (nonEmpty(seo?.title)) out.push(`  title: ${quoted(seo.title)}`);
  if (nonEmpty(seo?.metaDescription)) out.push(`  metaDescription: ${quoted(seo.metaDescription)}`);
  if (has(seo?.tags)) out.push(...list("tags", seo.tags, 2));
  if (has(seo?.highlights)) out.push(...list("highlights", seo.highlights, 2));
  out.push(`  lastUpdated: ${quoted(f.capturedAt)}`, "  author:", `    name: ${quoted("CDR")}`);
  if (nonEmpty(seo?.opening)) out.push(...block("opening", seo.opening, 2));
  if (has(seo?.questions)) {
    out.push("  questions:");
    for (const q of seo.questions)
      out.push(
        `    - id: ${quoted(q.id)}`,
        `      title: ${quoted(q.title)}`,
        `      answer: ${quoted(q.answer)}`,
      );
  }
  const mockups = p.mockups ?? mockupsOf(f);
  if (mockups.length) out.push("", ...list("mockups", mockups));
  out.push("", "colors:", ...f.colors.map((c) => `  ${c.key}: ${quoted(c.hex.toLowerCase())}`));
  out.push("", "typography:");
  for (const t of f.typography) {
    out.push(
      `  ${t.key}:`,
      `    fontFamily: ${quoted(t.fontFamily)}`,
      `    fontSize: ${px(t.fontSize)}`,
      `    fontWeight: ${t.fontWeight}`,
      `    lineHeight: ${decimal(t.lineHeight)}`,
      `    letterSpacing: ${ls(t.letterSpacing)}`,
    );
    if (t.textTransform) out.push(`    textTransform: ${t.textTransform}`);
  }
  out.push("", "rounded:", ...f.rounded.map((r) => `  ${r.key}: ${px(r.value)}`));
  out.push("", "spacing:", ...f.spacing.map((s) => `  ${s.key}: ${px(s.value)}`));
  out.push("", "components:");
  for (const c of f.components) {
    out.push(`  ${c.key}:`);
    const keys = [
      ...PROP_ORDER.filter((k) => c.props[k] !== undefined),
      ...Object.keys(c.props).filter((k) => !PROP_ORDER.includes(k)),
    ];
    for (const k of keys) {
      const v = c.props[k]!;
      out.push(`    ${k}: ${v.startsWith("{") ? quoted(v) : scalar(v)}`);
    }
    if (!keys.length) out.pop();
  }
  out.push("---");
  return out;
}

/* ------------------------------------------------------------------ body */

const bullets = (xs: string[] | undefined) =>
  (xs ?? []).filter(nonEmpty).map((x) => `- ${x.trim().replace(/^[-*]\s+/, "")}`);
const paragraphs = (xs: string[] | string | undefined) =>
  (typeof xs === "string" ? [xs] : (xs ?? [])).filter(nonEmpty).map((x) => x.trim());

/** `### heading` + content, only when there is content. */
function sub(title: string, lines: string[]): string[] {
  return lines.length ? [`### ${title}`, "", ...lines, ""] : [];
}

/** Paragraph blocks separated by blank lines; bullet runs stay together. */
function join(...blocks: string[][]): string[] {
  const out: string[] = [];
  for (const b of blocks.filter((x) => x.length)) {
    if (out.length) out.push("");
    out.push(...b);
  }
  return out;
}

function colors(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const out: string[] = [];
  for (const [title, groups] of COLOR_SECTIONS) {
    const cs = f.colors.filter((c) => groups.includes(c.group));
    const role = (k: string) => p.colorRoles?.[k]?.trim();
    out.push(
      ...sub(
        title,
        cs.map(
          (c) =>
            `- **${c.label}** (\`{colors.${c.key}}\` — ${c.hex.toLowerCase()})${role(c.key) ? `: ${role(c.key)}` : ""}`,
        ),
      ),
    );
  }
  return out;
}

function typography(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const rows = f.typography.map(
    (t) =>
      `| \`{typography.${t.key}}\` | ${px(t.fontSize)} | ${t.fontWeight} | ${decimal(t.lineHeight)} | ${ls(t.letterSpacing)} | ${cell([t.use.join(", "), t.mobileSize ? `${px(t.mobileSize)} at the narrowest width` : ""].filter(Boolean).join("; "))} |`,
  );
  const licensed = f.fonts.filter((x) => x.licensed && x.substitutes.length);
  const subs = has(p.substitutes)
    ? bullets(p.substitutes)
    : licensed.flatMap((x) =>
        x.substitutes.map((s) => `- **${s.family}** for ${x.family} (metric match ${s.score.toFixed(2)})`),
      );
  return [
    ...sub("Font Family", paragraphs(p.fontFamily)),
    ...sub(
      "Hierarchy",
      rows.length
        ? [
            "| Token | Size | Weight | Line Height | Letter Spacing | Use |",
            "|---|---|---|---|---|---|",
            ...rows,
          ]
        : [],
    ),
    ...sub("Principles", bullets(p.typePrinciples)),
    ...sub("Note on Font Substitutes", subs),
  ];
}

function layout(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const step = (v: number | undefined) =>
    f.spacing.find((s) => v !== undefined && s.key !== "section" && Math.abs(s.value - v) <= 1);
  const section = f.spacing.find((s) => s.key === "section");
  const card = step(f.cardPadding);
  const spacing = [
    `- **Base unit:** ${px(f.baseUnit)}.`,
    `- **Tokens:** ${f.spacing.map((s) => `\`{spacing.${s.key}}\` ${px(s.value)}`).join(" · ")}.`,
    ...(section ? [`- **Section padding:** \`{spacing.section}\` (${px(section.value)}).`] : []),
    ...(f.cardPadding !== undefined
      ? [
          `- **Card internal padding:** ${card ? `\`{spacing.${card.key}}\` (${px(f.cardPadding)})` : px(f.cardPadding)}.`,
        ]
      : []),
  ];
  const cols = (g: BrandFacts["grids"][number]) =>
    Object.entries(g.columnsByWidth)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([w, n]) => `${n}-up at ${w}px`)
      .join(", ");
  const grid = [
    ...(f.containerMax ? [`- **Max content width:** ${px(f.containerMax)}.`] : []),
    ...f.grids.map((g) => `- **${g.name}:** ${cols(g)}.`),
    ...bullets(p.gridNotes),
  ];
  return [
    ...sub("Spacing System", spacing),
    ...sub("Grid & Container", grid),
    ...sub("Whitespace Philosophy", paragraphs(p.whitespace)),
  ];
}

function elevation(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const kindsOf = (ks: string[]) => [...new Set(ks)].map(kindLabel).join(", ");
  const shadowKinds = new Set(f.elevation.shadows.flatMap((s) => s.kinds));
  const flat = [...new Set(f.components.map((c) => c.kind))].filter((k) => !shadowKinds.has(k));
  const bordered = f.components
    .filter((c) => c.layout.some((l) => l.startsWith("border ")))
    .map((c) => c.kind);
  const rows = [`| Flat | No shadow | ${cell(kindsOf(flat) || "Page bands")} |`];
  if (f.colors.some((c) => c.key === "hairline") && bordered.length)
    rows.push(`| Hairline | 1px \`{colors.hairline}\` border | ${cell(kindsOf(bordered))} |`);
  if (f.colors.some((c) => c.key === "surface-card"))
    rows.push(
      `| Card surface | \`{colors.surface-card}\` background | ${cell(kindsOf(f.components.filter((c) => c.props.backgroundColor === "{colors.surface-card}").map((c) => c.kind)) || "Cards")} |`,
    );
  f.elevation.shadows
    .slice(0, 4)
    .forEach((s, i) => rows.push(`| Level ${i + 1} | \`${cell(s.value)}\` | ${cell(kindsOf(s.kinds))} |`));
  if (f.images.some((i) => i.role === "hero"))
    rows.push("| Photographic | Full-bleed photography | Hero bands |");
  return join(
    ["| Level | Treatment | Use |", "|---|---|---|", ...rows],
    paragraphs(p.elevationNote),
    sub("Decorative Depth", bullets(p.decorativeDepth)).slice(0, -1),
  ).concat([""]);
}

function shapes(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const rows = f.rounded.map(
    (r) =>
      `| \`{rounded.${r.key}}\` | ${r.value >= PILL ? "9999px" : px(r.value)} | ${cell(r.kinds.map(kindLabel).join(", "))} |`,
  );
  return [
    ...sub(
      "Border Radius Scale",
      join(["| Token | Value | Use |", "|---|---|---|", ...rows], paragraphs(p.radiusNote)),
    ),
    ...sub("Photography Geometry", bullets(p.photographyGeometry)),
  ];
}

function propsLine(c: ComponentFact): string {
  const parts = PROP_ORDER.filter((k) => c.props[k] !== undefined).map((k) => {
    const v = c.props[k]!;
    return `${PROP_LABELS[k]} ${isRef(v) ? `\`${v}\`` : v}`;
  });
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) + "." : "";
}

function components(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const out: string[] = [];
  const groups = [...COMPONENT_GROUPS.map(([g]) => g), ...new Set(f.components.map((c) => c.group))].filter(
    (g, i, a) => a.indexOf(g) === i,
  );
  for (const g of groups) {
    const cs = f.components.filter((c) => c.group === g);
    const paras = cs.map((c) => {
      const text = p.components?.[c.key]?.trim() || propsLine(c);
      return [`**\`${c.key}\`**${text ? ` — ${text}` : ""}`];
    });
    out.push(...sub(g, join(...paras)));
  }
  return out;
}

function responsive(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const width = (b: BrandFacts["breakpoints"][number]) =>
    b.min !== undefined && b.max !== undefined
      ? `${b.min}–${b.max}px`
      : b.max !== undefined
        ? `< ${b.max + 1}px`
        : b.min !== undefined
          ? `≥ ${b.min}px`
          : "all";
  const rows = f.breakpoints.map(
    (b) => `| ${cell(b.name)} | ${width(b)} | ${cell(b.changes.join("; ") || "—")} |`,
  );
  return [
    ...sub("Breakpoints", rows.length ? ["| Name | Width | Key Changes |", "|---|---|---|", ...rows] : []),
    ...sub("Touch Targets", bullets(p.touchTargets)),
    ...sub("Collapsing Strategy", bullets(p.collapsing)),
    ...sub("Image Behavior", bullets(p.imageBehavior)),
  ];
}

function body(f: BrandFacts, p: Partial<ProseSlots>): string[] {
  const overview = join(
    paragraphs(p.overview),
    has(p.keyCharacteristics) ? ["**Key Characteristics:**", ...bullets(p.keyCharacteristics)] : [],
  );
  const dosDonts = [...sub("Do", bullets(p.dos)), ...sub("Don't", bullets(p.donts))];
  const iteration = (p.iteration ?? [])
    .filter(nonEmpty)
    .map((x, i) => `${i + 1}. ${x.trim().replace(/^\d+[.)]\s+/, "")}`);
  const gaps = has(p.knownGaps) ? bullets(p.knownGaps) : bullets(f.gaps);
  const sections: Record<string, string[]> = {
    Overview: overview.length ? [...overview, ""] : [],
    Colors: colors(f, p),
    Typography: typography(f, p),
    Layout: layout(f, p),
    "Elevation & Depth": elevation(f, p),
    Shapes: shapes(f, p),
    Components: components(f, p),
    "Do's and Don'ts": dosDonts,
    "Responsive Behavior": responsive(f, p),
    "Iteration Guide": iteration.length ? [...iteration, ""] : [],
    "Known Gaps": gaps.length ? [...gaps, ""] : [],
  };
  const out: string[] = [];
  for (const s of SECTION_ORDER) out.push(`## ${s}`, "", ...sections[s]!);
  return out;
}

/** The full DESIGN.md: front matter from the facts (+ description / seo / mockups prose), then the 11 sections. */
export function writeDesignMd(facts: BrandFacts, prose: Partial<ProseSlots>): string {
  const lines = [...frontMatter(facts, prose), "", ...body(facts, prose)];
  // no runs of blank lines, one trailing newline
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
