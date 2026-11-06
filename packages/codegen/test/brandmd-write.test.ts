// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
import { describe, expect, it } from "vitest";
// the spec's own checker (design-md--generator/cli/lint.mjs): YAML subset parser, sections, ref resolution
// @ts-expect-error -- plain .mjs CLI module without type declarations
import { bodySections, lintDesignMd, splitDesignMd } from "@harness/codegen";
import { brandFacts } from "@harness/codegen";
import { fixtureDs, fixtureScreens } from "./brandmd-fixture-northwind.js";
import type { ProseSlots } from "@harness/protocol";
import { SECTION_ORDER, writeDesignMd } from "@harness/codegen";

interface Section {
  title: string;
  canonical: string | null;
  text: string;
  subsections: Array<{ title: string; text: string }>;
}
interface Finding {
  severity: string;
  rule: string;
  message: string;
}

const facts = brandFacts({ ds: fixtureDs, screens: fixtureScreens(), url: "northwind.example" });

/** Every slot filled with a marker the test can find again. */
function fullProse(): ProseSlots {
  const items = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${tag}-${i + 1}: uses {colors.primary} on every CTA.`);
  return {
    description:
      "DESC-1: a light canvas (#ffffff) with Northwind blue #1c69d4 on every CTA: Northwind Sans at 700 / 300.",
    seo: {
      title: "SEO-TITLE: Northwind blue and square corners",
      metaDescription: 'SEO-META: "quoted" #1c69d4 and 0px corners.',
      tags: ["Automotive"],
      highlights: items("HIGHLIGHT", 5),
      opening: "OPENING-1 first paragraph.\n\nOPENING-2 second paragraph.\n\nOPENING-3 third paragraph.",
      questions: ["primary-color", "typography", "square-corners", "use-in-project", "known-gaps"].map(
        (id) => ({ id, title: `Q-${id}?`, answer: `A-${id}: it is {colors.primary}.` }),
      ),
    },
    mockups: ["marketing-hero"],
    overview: ["OVERVIEW-1 paragraph.", "OVERVIEW-2 paragraph.", "OVERVIEW-3 paragraph."],
    keyCharacteristics: items("KEYCHAR", 6),
    colorRoles: Object.fromEntries(facts.colors.map((c) => [c.key, `ROLE-${c.key} sentence.`])),
    fontFamily: "FONTFAMILY-1 Northwind Sans in two cuts.",
    typePrinciples: items("PRINCIPLE", 4),
    substitutes: items("SUBST", 2),
    whitespace: "WHITESPACE-1 paragraph.",
    gridNotes: items("GRIDNOTE", 2),
    elevationNote: "ELEVATION-1 no shadows.",
    decorativeDepth: items("DEPTH", 2),
    radiusNote: "RADIUS-1 square everywhere.",
    photographyGeometry: items("PHOTO", 3),
    components: Object.fromEntries(facts.components.map((c) => [c.key, `COMP-${c.key} paragraph.`])),
    dos: items("DO", 7),
    donts: items("DONT", 7),
    touchTargets: items("TOUCH", 2),
    collapsing: items("COLLAPSE", 4),
    imageBehavior: items("IMAGE", 3),
    iteration: items("ITER", 5),
    knownGaps: items("GAP", 5),
  };
}

const sectionsOf = (md: string): Section[] => {
  const { body, bodyLine } = splitDesignMd(md);
  return bodySections(body, bodyLine);
};
const textOf = (md: string, title: string) => sectionsOf(md).find((s) => s.title === title)!.text;
const subOf = (md: string, title: string, sub: string) =>
  sectionsOf(md)
    .find((s) => s.title === title)!
    .subsections.find((x) => x.title === sub)?.text ?? "";

describe("writeDesignMd", () => {
  it("writes front matter that parses, with the tokens from the facts", () => {
    const md = writeDesignMd(facts, fullProse());
    expect(md.startsWith("---\nversion: alpha\n")).toBe(true);
    const fm = splitDesignMd(md).frontMatter;
    expect(Object.keys(fm)).toEqual([
      "version",
      "name",
      "website",
      "description",
      "seo",
      "mockups",
      "colors",
      "typography",
      "rounded",
      "spacing",
      "components",
    ]);
    expect(fm.name).toBe("Northwind");
    expect(fm.website).toBe("https://northwind.example");
    expect(fm.description).toBe(fullProse().description);
    expect(fm.seo.metaDescription).toBe('SEO-META: "quoted" #1c69d4 and 0px corners.');
    expect(fm.seo.opening.trim().split(/\n\n/)).toHaveLength(3);
    expect(fm.seo.questions.map((q: { id: string }) => q.id)).toEqual([
      "primary-color",
      "typography",
      "square-corners",
      "use-in-project",
      "known-gaps",
    ]);
    expect(fm.seo.author).toEqual({ name: "CDR" });
    expect(fm.seo.lastUpdated).toBe("2026-10-20");
    expect(Object.keys(fm.colors)).toEqual(facts.colors.map((c) => c.key));
    expect(fm.colors.primary).toBe("#1c69d4");
    expect(fm.typography["display-xl"]).toEqual({
      fontFamily: "'Northwind Sans', Helvetica, Arial, sans-serif",
      fontSize: "64px",
      fontWeight: 700,
      lineHeight: 1.05,
      letterSpacing: 0,
    });
    expect(fm.typography["label-uppercase"]).toMatchObject({
      letterSpacing: "1.5px",
      textTransform: "uppercase",
    });
    expect(fm.rounded.none).toBe("0px");
    expect(fm.spacing.section).toBe("80px");
    expect(fm.components["button-primary"]).toEqual({
      backgroundColor: "{colors.primary}",
      textColor: "{colors.on-primary}",
      typography: "{typography.button}",
      rounded: "{rounded.none}",
      padding: "14px 32px",
      height: "48px",
    });
  });

  it("writes the 11 sections in order", () => {
    expect(SECTION_ORDER).toHaveLength(11);
    for (const prose of [fullProse(), {}])
      expect(sectionsOf(writeDesignMd(facts, prose)).map((s) => s.title)).toEqual([...SECTION_ORDER]);
  });

  it("emits only refs that resolve, no literal hex in components, no lint errors", () => {
    for (const prose of [fullProse(), {}]) {
      const md = writeDesignMd(facts, prose);
      const findings = lintDesignMd(md, { facts }).findings as Finding[];
      expect(findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(findings.filter((f) => f.rule === "broken-ref")).toEqual([]);
      expect(findings.filter((f) => f.rule === "section-order")).toEqual([]);
    }
  });

  it("leaves missing slots empty — deterministic parts only, no placeholder text", () => {
    const md = writeDesignMd(facts, {});
    const fm = splitDesignMd(md).frontMatter;
    expect(fm.description).toBeUndefined();
    expect(fm.seo).toEqual({ lastUpdated: "2026-10-20", author: { name: "CDR" } });
    expect(fm.mockups).toEqual(["marketing-hero", "media-grid"]);
    expect(md).not.toMatch(/TODO|TBD|lorem|undefined|null|\[slot|placeholder/i);
    expect(textOf(md, "Overview").trim()).toBe("");
    expect(textOf(md, "Do's and Don'ts").trim()).toBe("");
    expect(textOf(md, "Iteration Guide").trim()).toBe("");
    // deterministic parts stay: bullet heads, tables, spacing line, component props, gaps
    expect(subOf(md, "Colors", "Brand & Accent")).toContain("- **Primary** (`{colors.primary}` — #1c69d4)\n");
    expect(subOf(md, "Typography", "Hierarchy")).toContain(
      "| `{typography.display-xl}` | 64px | 700 | 1.05 | 0 |",
    );
    expect(subOf(md, "Typography", "Principles")).toBe("");
    expect(subOf(md, "Layout", "Spacing System")).toContain(
      "- **Tokens:** `{spacing.xxs}` 4px · `{spacing.xs}` 8px",
    );
    expect(subOf(md, "Shapes", "Border Radius Scale")).toContain("| `{rounded.none}` | 0px |");
    expect(textOf(md, "Elevation & Depth")).toContain("| Level | Treatment | Use |");
    expect(subOf(md, "Responsive Behavior", "Breakpoints")).toContain(
      "| Mobile | < 768px | nav collapses to a menu button; h1 64→40px;",
    );
    expect(textOf(md, "Components")).toContain(
      "**`button-primary`** — Background `{colors.primary}` · text `{colors.on-primary}`",
    );
    expect(textOf(md, "Known Gaps")).toContain(facts.gaps[0]);
    const headings = sectionsOf(md).flatMap((s) => s.subsections.map((x) => x.title));
    for (const empty of [
      "Font Family",
      "Principles",
      "Whitespace Philosophy",
      "Decorative Depth",
      "Photography Geometry",
      "Do",
      "Don't",
      "Touch Targets",
      "Collapsing Strategy",
      "Image Behavior",
    ])
      expect(headings).not.toContain(empty);
  });

  it("puts every prose slot into its section", () => {
    const md = writeDesignMd(facts, fullProse());
    const where: Array<[string, string | undefined, RegExp]> = [
      [
        "Overview",
        undefined,
        /OVERVIEW-1[\s\S]*OVERVIEW-3[\s\S]*\*\*Key Characteristics:\*\*\n- KEYCHAR-1[\s\S]*KEYCHAR-6/,
      ],
      [
        "Colors",
        "Brand & Accent",
        /- \*\*Primary\*\* \(`\{colors\.primary\}` — #1c69d4\): ROLE-primary sentence\./,
      ],
      ["Colors", "Surface", /ROLE-canvas sentence\.[\s\S]*ROLE-surface-dark sentence\./],
      ["Colors", "Hairlines", /ROLE-hairline sentence/],
      ["Colors", "Text", /ROLE-ink sentence[\s\S]*ROLE-on-dark sentence/],
      ["Colors", "Semantic", /ROLE-error sentence/],
      ["Typography", "Font Family", /FONTFAMILY-1/],
      ["Typography", "Principles", /- PRINCIPLE-1[\s\S]*PRINCIPLE-4/],
      ["Typography", "Note on Font Substitutes", /- SUBST-1[\s\S]*SUBST-2/],
      ["Layout", "Grid & Container", /- GRIDNOTE-1/],
      ["Layout", "Whitespace Philosophy", /WHITESPACE-1/],
      ["Elevation & Depth", undefined, /\| Level \|[\s\S]*ELEVATION-1/],
      ["Elevation & Depth", "Decorative Depth", /- DEPTH-1[\s\S]*DEPTH-2/],
      ["Shapes", "Border Radius Scale", /RADIUS-1/],
      ["Shapes", "Photography Geometry", /- PHOTO-1/],
      ["Components", "Buttons", /\*\*`button-primary`\*\* — COMP-button-primary paragraph\./],
      ["Components", "Top Navigation", /COMP-top-nav/],
      ["Components", "CTA / Footer", /COMP-footer/],
      ["Do's and Don'ts", "Do", /- DO-1[\s\S]*DO-7/],
      ["Do's and Don'ts", "Don't", /- DONT-1[\s\S]*DONT-7/],
      ["Responsive Behavior", "Touch Targets", /- TOUCH-1/],
      ["Responsive Behavior", "Collapsing Strategy", /- COLLAPSE-1/],
      ["Responsive Behavior", "Image Behavior", /- IMAGE-1/],
      ["Iteration Guide", undefined, /^1\. ITER-1[\s\S]*^5\. ITER-5/m],
      ["Known Gaps", undefined, /- GAP-1[\s\S]*GAP-5/],
    ];
    for (const [title, sub, re] of where)
      expect(sub ? subOf(md, title, sub) : textOf(md, title), `${title} › ${sub ?? ""}`).toMatch(re);
    // the prose replaces the generated lists, it does not repeat them
    expect(textOf(md, "Known Gaps")).not.toContain(facts.gaps[0]);
    expect(subOf(md, "Typography", "Note on Font Substitutes")).not.toContain("metric match");
    // every component paragraph appears once, in its group
    for (const c of facts.components) expect(md.split(`**\`${c.key}\`** —`).length - 1, c.key).toBe(1);
    const fm = splitDesignMd(md).frontMatter;
    expect(fm.seo.highlights).toEqual(fullProse().seo.highlights);
    expect(fm.mockups).toEqual(["marketing-hero"]);
  });
});
