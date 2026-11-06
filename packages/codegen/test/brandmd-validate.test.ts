// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// The prose validator (PLAN.md §6.4): shapes, lengths and each grounding rule, with a good and a bad example.
import { describe, expect, it } from "vitest";
import { sampleFacts } from "./brandmd-sample-facts.js";
import { groundText, validateSlot, wordCount } from "@harness/codegen";

const F = sampleFacts();
const errs = (text: string, facts = F) => groundText(text, facts, "t");

describe("grounding rules", () => {
  it("hex values must be measured colours (3-digit shorthand counts)", () => {
    expect(errs("Corporate blue `{colors.primary}` (#1c69d4) on #FFF.")).toEqual([]);
    expect(errs("Accent #ff0000 for alerts.")).toEqual([expect.stringContaining("#ff0000")]);
  });

  it("px values must be measured (tokens, rhythm, container, widths, component props; 0px / 1px always)", () => {
    expect(
      errs(
        "80px rhythm, 14px 32px padding, 48px tall, 1440px container, 1px hairline, letter-spacing 1.5px, 64px → 40px at 390px.",
      ),
    ).toEqual([]);
    expect(errs("Cards sit 36px apart.")).toEqual([expect.stringContaining("36px")]);
  });

  it("weights must be measured; absent weights only in an absence claim", () => {
    expect(errs("The 700/300 contrast is the signature. Weight 500 is deliberately absent.")).toEqual([]);
    expect(errs("Body copy runs at weight 500.")).toEqual([expect.stringContaining("weight 500")]);
    expect(errs("Titles use weight 800.")).toEqual([expect.stringContaining("weight 800")]);
    expect(errs("Weight 700 is absent from the scale.")).toEqual([
      expect.stringContaining("weight 700 is used"),
    ]);
  });

  it("font names must be in the facts (families, stacks, substitutes)", () => {
    expect(
      errs(
        "Inter or Saira Condensed stand in for BMW Type Next Latin; the stack falls back to Segoe UI and Roboto.",
      ),
    ).toEqual([]);
    expect(errs("Helvetica Neue is a fine substitute.")).toEqual([expect.stringContaining("Helvetica Neue")]);
    expect(errs("Use Roboto Mono for code.")).toEqual([expect.stringContaining("Roboto Mono")]);
  });

  it("token refs must exist ({component.x} and {components.x} both resolve)", () => {
    expect(
      errs(
        "`{colors.primary}`, `{typography.button}`, `{rounded.none}`, `{spacing.section}`, `{component.button-primary}`, `{components.top-nav}`, reference {token.refs}.",
      ),
    ).toEqual([]);
    expect(errs("`{colors.brand-blue}` and `{shadow.small}`.")).toEqual([
      expect.stringContaining("{colors.brand-blue}"),
      expect.stringContaining("{shadow.small}"),
    ]);
  });

  it("quoted strings must be captured text (case and whitespace normalised; code spans ignored)", () => {
    expect(
      errs(
        'Inline links read "LEARN MORE", the hero says “THE  iX3”, German quotes „Models“. Stack: `"Segoe UI"`.',
      ),
    ).toEqual([]);
    expect(errs('A "Configure now" button.')).toEqual([expect.stringContaining("configure now")]);
    expect(errs("The voice is “engineered precision”.")).toEqual([
      expect.stringContaining("engineered precision"),
    ]);
  });

  it("peer brands only from the facts, in a sentence about the computed contrast", () => {
    expect(errs("Where Apple pills its corners, BMW stays rectangular at 0px.")).toEqual([]);
    expect(errs("Where Airbnb rounds, BMW squares off.")).toEqual([expect.stringContaining("Airbnb")]);
    expect(errs("Apple uses a brighter blue.")).toEqual([
      expect.stringContaining("does not match a computed contrast"),
    ]);
    // the brand itself and "Google Fonts" are not peers
    expect(errs("BMW Type Next Latin is not on Google Fonts.")).toEqual([]);
    // a brand the site itself names is content, not a comparison
    expect(
      errs("The footer links to Google Play.", sampleFacts({ texts: ["Get it on Google Play"] })),
    ).toEqual([]);
    expect(errs("The footer links to Google Play.")).toEqual([
      expect.stringContaining("Google is not one of the peers"),
    ]);
    // a typeface named after a brand is a font, not a peer comparison
    const plex = sampleFacts();
    plex.fonts = plex.fonts.map((f) => ({ ...f, substitutes: [{ family: "IBM Plex Sans", score: 0.96 }] }));
    expect(errs("IBM Plex Sans is the closest open substitute.", plex)).toEqual([]);
    expect(errs("Unlike IBM, BMW squares off.")).toEqual([
      expect.stringContaining("IBM is not one of the peers"),
    ]);
  });

  it("no absence claims the facts contradict", () => {
    expect(errs("The system never uses a drop shadow.")).toEqual([]);
    const shadowed = sampleFacts({
      elevation: {
        shadows: [{ value: "0 4px 12px rgba(0,0,0,.1)", count: 3, kinds: ["card"] }],
        gradients: ["linear-gradient(#0066b1, #e22718)"],
      },
    });
    expect(errs("The system never uses a drop shadow.", shadowed)).toEqual([
      expect.stringContaining("no shadows"),
    ]);
    expect(errs("There are no gradients.", shadowed)).toEqual([expect.stringContaining("no gradients")]);
    expect(errs("No border, depth comes from a soft shadow.", shadowed)).toEqual([]);
    // scoped to parts without a shadow, or qualified: true claims
    const iconOnly = sampleFacts({
      elevation: {
        shadows: [{ value: "0 6px 20px rgba(0,0,0,.16)", count: 3, kinds: ["icon-button"] }],
        gradients: [],
      },
    });
    expect(errs("Cards and buttons carry no shadow.", iconOnly)).toEqual([]);
    expect(errs("There are no drop shadows except on the floating icon button.", iconOnly)).toEqual([]);
    expect(errs("Cards carry no shadow.", shadowed)).toEqual([expect.stringContaining("no shadows")]);
    expect(errs("The system has no drop shadows.", iconOnly)).toEqual([
      expect.stringContaining("no shadows"),
    ]);
    expect(errs("The type never goes uppercase.")).toEqual([expect.stringContaining("no uppercase")]);
    expect(errs("There are no dark bands.")).toEqual([expect.stringContaining("no dark bands")]);
  });
});

describe("validateSlot", () => {
  const words = (n: number, w = "plate") => Array.from({ length: n }, () => w).join(" ");

  it("accepts a well-formed, grounded list and returns it", () => {
    const iteration = [
      "Start from `{colors.canvas}` and `{spacing.section}` (80px) between bands.",
      "Reuse `{component.button-primary}` for every CTA.",
      "Keep `{rounded.none}` (0px) on cards.",
      "Set body copy in `{typography.body-md}` at 16px.",
      "Use 4-up model grids at 1280px.",
    ];
    expect(validateSlot("iteration", iteration, F)).toEqual({ value: iteration, errors: [] });
  });

  it("rejects wrong shapes, counts and lengths", () => {
    expect(validateSlot("dos", "Use blue.", F).errors).toEqual([
      expect.stringContaining("expected an array"),
    ]);
    expect(validateSlot("dos", ["Use `{colors.primary}` for CTAs."], F).errors).toEqual([
      expect.stringContaining("1 items, expected 7–9"),
    ]);
    expect(validateSlot("description", "Too short.", F).errors).toEqual([
      expect.stringContaining("too short"),
    ]);
    expect(validateSlot("description", words(200), F).errors).toEqual([expect.stringContaining("too long")]);
    expect(validateSlot("mockups", ["marketing-hero", "pricing-table"], F).errors).toEqual([
      expect.stringContaining("pricing-table"),
    ]);
  });

  it("a grounding error rejects the slot (no value)", () => {
    const r = validateSlot(
      "elevationNote",
      "Depth comes from colour blocks: `{colors.surface-dark}` (#1a2129) bands against #f0f0f0 canvas plates and photography.",
      F,
    );
    expect(r.value).toBeUndefined();
    expect(r.errors).toEqual([expect.stringContaining("#f0f0f0")]);
  });

  it("record slots: every key of the facts, nothing else (or the batch asked for)", () => {
    const roles = Object.fromEntries(F.colors.map((c) => [c.key, `The ${c.key} colour of the system.`]));
    expect(validateSlot("colorRoles", roles, F).errors).toEqual([]);
    const { canvas: _c, ...missing } = roles;
    expect(validateSlot("colorRoles", missing, F).errors).toEqual([
      expect.stringContaining("missing canvas"),
    ]);
    expect(validateSlot("colorRoles", { ...roles, "m-red": "The M stripe red." }, F).errors).toEqual([
      expect.stringContaining('"m-red" is not a key'),
    ]);
    const para =
      'The primary CTA: `{colors.primary}` background, `{colors.on-primary}` text, `{rounded.none}`, padding 14px 32px, 48px tall, reads "Learn more".';
    expect(
      validateSlot("components", { "button-primary": para }, F, { expectKeys: ["button-primary"] }).errors,
    ).toEqual([]);
  });

  it("seo: fixed question ids, five highlights, three opening paragraphs", () => {
    const hl = (s: string) => `${s} — ${words(16, "measured")} at \`{spacing.section}\` (80px).`;
    const answer = (id: string) => ({
      id,
      title: `What about ${id} on BMW?`,
      answer: `${words(60, "value")} \`{colors.primary}\` (#1c69d4).`,
    });
    const seo = {
      title: "BMW Design Tokens: Corporate Blue and Square Corners",
      metaDescription:
        "Corporate Blue #1c69d4 on every CTA, BMW Type Next Latin at 700 and 300, 0px corners and 2 components. A measured token set for builders.",
      tags: ["Automotive"],
      highlights: ["a", "b", "c", "d", "e"].map(hl),
      opening: [words(80, "one"), words(80, "two"), words(80, "three")].join("\n\n"),
      questions: ["primary-color", "typography", "rectangular-buttons", "use-in-project", "known-gaps"].map(
        answer,
      ),
    };
    expect(validateSlot("seo", seo, F)).toEqual({ value: seo, errors: [] });
    const bad = validateSlot("seo", { ...seo, opening: words(250), questions: seo.questions.slice(0, 4) }, F);
    expect(bad.value).toBeUndefined();
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1 paragraphs"),
        expect.stringContaining("4 questions"),
        expect.stringContaining("known-gaps"),
      ]),
    );
  });

  it("wordCount ignores punctuation-only tokens", () => {
    expect(wordCount("BMW — rectangular, 0px corners.")).toBe(4);
  });
});
