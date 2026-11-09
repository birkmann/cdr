/**
 * Handler selection and the deterministic code → owner table used by TASKS.md / REPORT.md (P6, §6).
 * Owner = handler id, "pipeline-bug" (P7 lane), "deterministic" (retry/port, no LLM) or "human".
 */
import { PIPELINE_BUG_CODES } from "./bugs.js";
import { HANDLERS } from "./handlers/index.js";
import { AUTOFIX_CODES, type Handler } from "./types.js";

export function selectHandlers(ids?: string[], all: Handler[] = HANDLERS): Handler[] {
  if (!ids?.length) return all;
  const unknown = ids.filter((id) => !all.some((h) => h.id === id));
  if (unknown.length) throw new Error(`unknown autofix handler(s): ${unknown.join(", ")} (known: ${all.map((h) => h.id).join(", ")})`);
  return all.filter((h) => ids.includes(h.id));
}

/** codes fixed by deterministic retry / port, without a handler (§6) */
const DETERMINISTIC = /^(ASSET_|CRAWL_|STYLE_|SCRIPT_|DESIGN_ASSET_)/;

export function ownerOf(code: string, all: Handler[] = HANDLERS): string {
  if ((PIPELINE_BUG_CODES as readonly string[]).includes(code) || code === AUTOFIX_CODES.PIPELINE_BUG) return "pipeline-bug";
  const h = [...all].sort((a, b) => a.priority - b.priority).find((x) => x.codes.includes(code));
  if (h) return h.id;
  if (DETERMINISTIC.test(code)) return "deterministic";
  return "human";
}
