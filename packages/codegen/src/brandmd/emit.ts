// The `design-md` emitter's work: the recreate run's design system + screens (each
// with the BrandCapture of its snapshot as `screen.capture`) → measured facts (brand.json) → DESIGN.md in Google's
// format (design-md--generator/spec/format.md). Deterministic by default: every token, table and fact line comes from
// the facts, the prose slots stay empty. `generateBrandGuide` adds the optional prose step: a host-supplied model writes
// the slots from the facts only, each slot validated (validate.ts) before it is used.
import {
  DEFAULT_TOKENS,
  type BrandFacts,
  type BrandGuide,
  type ProseSlots,
  type SceneDesignSystem,
  type SceneScreen,
  type SlotReport,
  type VisionNotes,
} from "@harness/protocol";
import type { FileMap } from "../export/bundle.js";
import { brandFacts } from "./facts.js";
import { lintDesignMd, type LintResult } from "./lint.js";
import { writeProse, type ProseModel } from "./prose.js";
import { writeDesignMd } from "./write.js";

export interface DesignMdInput {
  screens: SceneScreen[];
  system?: SceneDesignSystem;
  page?: string;
}

export interface DesignMdOptions {
  /** the live page (website + provenance) */
  sourceUrl?: string;
  capturedAt?: string;
  /** brand name (default: from the capture's marks, the title or the host) */
  name?: string;
  vision?: VisionNotes;
  /** prose slots written elsewhere (already validated) */
  slots?: Partial<ProseSlots>;
}

/** A design system for facts when the run has none yet: the first screen's tokens, no sets. */
function systemOf(input: DesignMdInput): SceneDesignSystem {
  if (input.system) return input.system;
  return {
    version: 1,
    name: input.page ?? "Design system",
    tokens: input.screens[0]?.tokens ?? DEFAULT_TOKENS,
  } as SceneDesignSystem;
}

/** The measured facts behind DESIGN.md (brand.json). */
export function designMdFacts(input: DesignMdInput, o: DesignMdOptions = {}): BrandFacts {
  return brandFacts({
    ds: systemOf(input),
    screens: input.screens,
    url: o.sourceUrl,
    name: o.name,
    capturedAt: o.capturedAt,
    vision: o.vision,
  });
}

function files(facts: BrandFacts, markdown: string, lint: LintResult, slots?: SlotReport[]): FileMap {
  return {
    "DESIGN.md": markdown,
    "brand.json": JSON.stringify(facts, null, 2) + "\n",
    "lint.json":
      JSON.stringify(
        {
          errors: lint.errors,
          warnings: lint.warnings,
          info: lint.info,
          findings: lint.findings,
          stats: lint.stats,
          ...(slots ? { slots } : {}),
        },
        null,
        2,
      ) + "\n",
  };
}

/** DESIGN.md + brand.json + lint.json, deterministic (no model): facts only, prose slots empty unless given. */
export function emitDesignMd(input: DesignMdInput, o: DesignMdOptions = {}): FileMap {
  const facts = designMdFacts(input, o);
  const markdown = writeDesignMd(facts, o.slots ?? {});
  return files(facts, markdown, lintDesignMd(markdown, { facts }));
}

/**
 * The full brand guide: facts, then (when `model` is given) the prose slots written by the model from the facts only
 * and validated slot by slot, then DESIGN.md and its lint. Without a model the result is the deterministic guide and
 * `ok` is false (the prose slots are reported as not written).
 */
export async function generateBrandGuide(
  input: DesignMdInput,
  o: DesignMdOptions & {
    model?: ProseModel | null;
    signal?: AbortSignal;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<{ guide: BrandGuide; files: FileMap; lint: LintResult }> {
  const facts = designMdFacts(input, o);
  const prose = o.model
    ? await writeProse(facts, { model: o.model, signal: o.signal, onProgress: o.onProgress })
    : { slots: {}, reports: [] as SlotReport[], model: undefined };
  const slots = { ...prose.slots, ...(o.slots ?? {}) };
  const markdown = writeDesignMd(facts, slots);
  const lint = lintDesignMd(markdown, { facts });
  const guide: BrandGuide = {
    markdown,
    facts,
    slots: prose.reports,
    ok: !!o.model && prose.reports.length > 0 && prose.reports.every((r) => r.ok),
    ...(prose.model ? { model: prose.model } : {}),
    generatedAt: new Date().toISOString(),
  };
  return { guide, files: files(facts, markdown, lint, prose.reports), lint };
}
