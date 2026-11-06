// Brand guide (DESIGN.md) — public API of the brandmd modules (ported from an earlier private project by the
// same author). Facts are measured deterministically; prose is optional and goes through a
// host-supplied model function.
export { brandFacts, peerContrasts, type BrandFactsInput } from "./facts.js";
export { writeDesignMd, SECTION_ORDER, mockupsOf } from "./write.js";
export {
  writeProse,
  proseTasks,
  parseJsonLoose,
  NO_MODEL,
  PROSE_ATTEMPTS,
  type ProseModel,
  type ProseRequest,
} from "./prose.js";
export { SLOT_GROUPS, COMPONENT_BATCH, proseMessages, retryMessage, type ChatMessage } from "./prompts.js";
export { validateSlot, groundText, wordCount } from "./validate.js";
export {
  lintDesignMd,
  parseDesignMdYaml,
  splitDesignMd,
  bodySections,
  type LintFinding,
  type LintResult,
} from "./lint.js";
export {
  emitDesignMd,
  generateBrandGuide,
  designMdFacts,
  type DesignMdInput,
  type DesignMdOptions,
} from "./emit.js";
