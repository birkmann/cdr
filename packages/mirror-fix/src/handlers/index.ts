/**
 * Handler registry (docs/DEEPSEEK_ONLY_PLAN.md §6). Order = priority (content before design before parity).
 * profile-infer is owned by W1-A, parity-fix by W1-B; the others by W1-C.
 */
import type { Handler } from "../types.js";
import { designVariantHandler } from "./design-variant.js";
import { mappingReviewHandler } from "./mapping-review.js";
import { parityFixHandler } from "./parity-fix.js";
import { profileInferHandler } from "./profile-infer.js";
import { seoRuleHandler } from "./seo-rule.js";

export { designVariantHandler, mappingReviewHandler, parityFixHandler, profileInferHandler, seoRuleHandler };

export const HANDLERS: Handler[] = [mappingReviewHandler, profileInferHandler, designVariantHandler, seoRuleHandler, parityFixHandler].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
