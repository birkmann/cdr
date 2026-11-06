// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// The prose slots with a stubbed model: valid answers are accepted, an invented value is asked again once and then
// reported failed, and without a model every slot fails visibly (no template fallback).
import { beforeEach, describe, expect, it } from "vitest";
import {
  writeProse as writeProseImpl,
  NO_MODEL,
  PROSE_ATTEMPTS,
  SLOT_GROUPS,
  type ProseModel,
} from "@harness/codegen";
import type { BrandFacts, SlotName } from "@harness/protocol";
import { sampleFacts } from "./brandmd-sample-facts.js";

// CDR: the model is a host-supplied ProseModel (no provider resolution in codegen); the stub records each request.
type Req = {
  model: string;
  format?: unknown;
  options?: { temperature?: number };
  messages: Array<{ role: string; content: string }>;
};
const model = {
  available: true,
  calls: [] as Req[],
  answer: null as null | ((req: Req, n: number) => string),
};
const stub: ProseModel = {
  name: "design-model",
  async complete(r) {
    const req: Req = {
      model: "design-model",
      format: "json",
      options: { temperature: r.temperature },
      messages: r.messages,
    };
    model.calls.push(req);
    return model.answer ? model.answer(req, model.calls.length) : "{}";
  },
};
const writeProse = (facts: BrandFacts, o: { onProgress?: (m: string) => void } = {}) =>
  writeProseImpl(facts, { ...o, model: model.available ? stub : null });

/* ------------------------------------------------------------------ a model that answers every group well */

const SENTENCE =
  "Primary actions use `{colors.primary}` (#1c69d4) on `{colors.canvas}` with `{spacing.section}` (80px) between bands.";
const say = (n: number) => Array.from({ length: n }, () => SENTENCE).join(" ");
const bullets = (n: number, s = SENTENCE) => Array.from({ length: n }, () => s);

function goodAnswer(facts: BrandFacts, user: string): Record<string, unknown> {
  const shape = user.match(/JSON: (\{.*)/)?.[1] ?? "";
  const has = (k: string) => shape.includes(`"${k}"`);
  if (has("seo")) {
    return {
      seo: {
        title: "BMW Design Tokens: Corporate Blue and Square Corners",
        metaDescription:
          "Corporate Blue #1c69d4 on every CTA, BMW Type Next Latin at 700 and 300, 0px corners and 2 components. A measured token set for builders.",
        tags: ["Automotive"],
        highlights: bullets(5, say(2)),
        opening: [say(6), say(6), say(6)].join("\n\n"),
        questions: ["primary-color", "typography", "rectangular-buttons", "use-in-project", "known-gaps"].map(
          (id) => ({ id, title: `What is the ${id} of BMW?`, answer: say(5) }),
        ),
      },
    };
  }
  if (has("description"))
    return {
      description: say(6),
      overview: bullets(3, say(4)),
      keyCharacteristics: bullets(6),
      mockups: ["marketing-hero", "media-grid"],
    };
  if (has("colorRoles"))
    return {
      colorRoles: Object.fromEntries(
        facts.colors.map((c) => [c.key, `The ${c.key} role, measured on the home page.`]),
      ),
    };
  if (has("fontFamily"))
    return {
      fontFamily:
        "BMW Type Next Latin at 700 for display and buttons, 300 for body copy; fallback `system-ui, sans-serif`.",
      typePrinciples: bullets(4, "The 700/300 contrast is the signature; weight 500 is absent."),
      substitutes: [
        "Inter at 700/300 is the closest open substitute.",
        "Saira Condensed for a narrower feel.",
      ],
    };
  if (has("whitespace")) {
    return {
      whitespace: say(2),
      gridNotes: bullets(3),
      elevationNote:
        "The system never uses a drop shadow; depth comes from `{colors.surface-dark}` (#1a2129) bands.",
      decorativeDepth: bullets(2),
      radiusNote: say(1),
      photographyGeometry: bullets(3, "Hero photography runs full-bleed at 16:9."),
    };
  }
  if (has("components")) {
    const keys = shape.match(/exactly these keys: ([^\n]+)\./)?.[1]?.split(", ") ?? [];
    return {
      components: Object.fromEntries(
        keys.map((k) => [
          k,
          `The \`{component.${k}}\` component on \`{colors.canvas}\`, reading "Learn more" where it links.`,
        ]),
      ),
    };
  }
  if (has("dos"))
    return {
      dos: bullets(7),
      donts: bullets(7, "Don't round buttons; `{rounded.none}` (0px) is the dialect."),
      iteration: bullets(5),
    };
  if (has("touchTargets"))
    return {
      touchTargets: bullets(2, "Buttons stand 48px tall with 14px 32px padding."),
      collapsing: bullets(4, "Model grids go from 4 columns at 1280px to 1 at 390px."),
      imageBehavior: bullets(3, "Hero photography crops to 16:9."),
    };
  if (has("knownGaps")) return { knownGaps: bullets(2, "BMW Type Next Latin is licensed; Inter stands in.") };
  return {};
}

const userOf = (req: Req) => req.messages.find((m) => m.role === "user")!.content;
const allSlots = SLOT_GROUPS.flatMap((g) => g.slots);

let facts: BrandFacts;
beforeEach(() => {
  facts = sampleFacts();
  model.available = true;
  model.calls = [];
  model.answer = (req) => JSON.stringify(goodAnswer(facts, userOf(req)));
});

describe("writeProse", () => {
  it("accepts valid answers: every slot written and reported ok, design model, JSON, low temperature", async () => {
    const progress: string[] = [];
    const r = await writeProse(facts, { onProgress: (m) => progress.push(m) });
    expect(r.model).toBe("design-model");
    expect(r.reports.filter((x) => !x.ok)).toEqual([]);
    expect(r.reports.map((x) => x.slot).sort()).toEqual([...allSlots].sort());
    expect(Object.keys(r.slots).sort()).toEqual([...allSlots].sort());
    expect(r.slots.components).toEqual({
      "button-primary": expect.any(String),
      "top-nav": expect.any(String),
    });
    expect(r.reports.every((x) => x.attempts === 1 && x.model === "design-model")).toBe(true);
    // one request per group, the system prompt carries the rules and the data guard; facts go in as wrapped data
    expect(model.calls).toHaveLength(SLOT_GROUPS.length);
    for (const c of model.calls) {
      expect(c).toMatchObject({ model: "design-model", format: "json", options: { temperature: 0.2 } });
      expect(c.messages[0]!.content).toContain("Style sample");
      expect(c.messages[1]!.content).toContain("<document-data");
    }
    expect(progress.at(-1)).toMatch(/\d+\/\d+$/);
  });

  it("an invented hex is asked again with the errors, then the slot fails (others stay ok)", async () => {
    const base = model.answer!;
    model.answer = (req, n) =>
      userOf(req).includes('"knownGaps"')
        ? JSON.stringify({
            knownGaps: [
              "Hover states use #ff00ff, which was not captured.",
              "BMW Type Next Latin is licensed; Inter stands in.",
            ],
          })
        : base(req, n);
    const r = await writeProse(facts);
    const gaps = r.reports.find((x) => x.slot === "knownGaps")!;
    expect(gaps).toMatchObject({ ok: false, attempts: PROSE_ATTEMPTS });
    expect(gaps.errors.join("\n")).toContain("#ff00ff");
    expect(r.slots.knownGaps).toBeUndefined();
    expect(r.reports.filter((x) => !x.ok).map((x) => x.slot)).toEqual(["knownGaps"]);
    // the re-ask: same conversation + the previous answer + the error list
    const retries = model.calls.filter((c) => c.messages.length === 4);
    expect(retries).toHaveLength(1);
    expect(retries[0]!.messages[2]!.role).toBe("assistant");
    expect(retries[0]!.messages[3]!.content).toContain("#ff00ff");
    expect(retries[0]!.messages[3]!.content).toContain('"knownGaps"');
  });

  it("a slot that only came back too short gets two more tries and is told to write longer", async () => {
    const base = model.answer!;
    let seoCalls = 0;
    model.answer = (req, n) => {
      const user = userOf(req);
      if (!user.includes('"seo"')) return base(req, n);
      seoCalls++;
      const good = goodAnswer(facts, user) as { seo: { questions: Array<{ answer: string }> } };
      // too short on the first three asks, long enough on the fourth
      if (seoCalls <= PROSE_ATTEMPTS) good.seo.questions[1]!.answer = "Transit is the sole typeface here.";
      return JSON.stringify(good);
    };
    const r = await writeProse(facts);
    expect(r.reports.find((x) => x.slot === "seo")).toMatchObject({ ok: true, attempts: PROSE_ATTEMPTS + 1 });
    expect(
      model.calls.some((c) => c.messages.at(-1)!.content.includes("write it longer than the minimum")),
    ).toBe(true);
  });

  it("a slot fixed on the re-ask is accepted; only the rejected slots are asked again", async () => {
    const base = model.answer!;
    model.answer = (req, n) => {
      const user = userOf(req);
      if (!user.includes('"touchTargets"')) return base(req, n);
      const good = goodAnswer(facts, user);
      return JSON.stringify(
        req.messages.length === 2
          ? { ...good, touchTargets: ["Buttons stand 52px tall.", "Icon buttons are 40px."] }
          : { touchTargets: good.touchTargets },
      );
    };
    const r = await writeProse(facts);
    expect(r.reports.find((x) => x.slot === "touchTargets")).toMatchObject({
      ok: true,
      attempts: 2,
      errors: [],
    });
    expect(r.reports.find((x) => x.slot === "collapsing")).toMatchObject({ ok: true, attempts: 1 });
    expect(r.slots.touchTargets).toEqual(goodAnswer(facts, 'JSON: {"touchTargets"').touchTargets);
    expect(r.reports.every((x) => x.ok)).toBe(true);
  });

  it("no model available: nothing is called, every slot fails with the reason", async () => {
    model.available = false;
    const progress: string[] = [];
    const r = await writeProse(facts, { onProgress: (m) => progress.push(m) });
    expect(model.calls).toHaveLength(0);
    expect(r.slots).toEqual({});
    expect(r.model).toBeUndefined();
    expect(r.reports.map((x) => x.slot).sort()).toEqual([...allSlots].sort());
    expect(r.reports.every((x) => !x.ok && x.errors[0] === NO_MODEL)).toBe(true);
    expect(progress.join("\n")).toContain("no AI model");
  });

  it("a model that fails to answer is reported per slot, not hidden", async () => {
    model.answer = () => "not json at all";
    const r = await writeProse(facts);
    expect(r.reports.every((x) => !x.ok && x.attempts === PROSE_ATTEMPTS)).toBe(true);
    expect(r.reports[0]!.errors[0]).toContain("not a JSON object");
  });

  it("components go in batches; a failed batch fails the slot but keeps the passing batch", async () => {
    const many = sampleFacts({
      components: Array.from({ length: 14 }, (_, i) => ({
        key: `card-${i}`,
        base: `card-${i}`,
        kind: "card",
        group: "Cards & Containers",
        props: { backgroundColor: "{colors.canvas}" },
        texts: [],
        layout: [],
        source: "extracted" as const,
      })),
    });
    facts = many;
    const base = model.answer!;
    model.answer = (req, n) => {
      const user = userOf(req);
      if (user.includes("exactly these keys: card-12"))
        return JSON.stringify({
          components: { "card-12": "A card on #123456 plates.", "card-13": "A card on #123456 plates." },
        });
      return base(req, n);
    };
    const r = await writeProse(many);
    const comp = r.reports.find((x) => x.slot === ("components" as SlotName))!;
    expect(comp.ok).toBe(false);
    expect(comp.errors.join("\n")).toContain("#123456");
    expect(Object.keys(r.slots.components ?? {})).toHaveLength(12);
  });
});
