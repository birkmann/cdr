// Finding signatures (plan §4.1): `<stage>:<code>[:<cause>][:<normalised-message-hash>]`, the same for the same code
// path on any site, in any cycle.
import { createHash } from "node:crypto";
import type { StageIssue } from "./types.js";

const VIEWPORTS = /\b(mobile|phone|tablet|desktop)\b/gi;
const VIEWPORT_SIZE = /\b\d{3,4}\s*[x×]\s*\d{3,4}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const IP_PORT = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const LOCALHOST = /\blocalhost(?::\d+)?\b/gi;
const HOSTNAME = /\b(?:[a-z0-9-]+\.)+(?:com|de|net|org|io|co|uk|fr|eu|app|dev|info|at|ch)\b(?::\d+)?/gi;
const ABS_PATH = /(?:^|[\s"'(=:])(?:\/[\w.@%+~-]+)+\/?/g;
const WIN_PATH = /[a-z]:\\[^\s"']+/gi;
const REL_FILE = /\b[\w.-]+(?:\/[\w.@%+~-]+)+\.[a-z0-9]{1,8}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_ID = /\b[0-9a-f]{8,}\b/gi;
const RUN_ID = /\b\d{8}-\d{6}-[a-z0-9-]+\b/gi;
const NUMBER = /\b\d+(?:\.\d+)?(?:px|ms|s|%)?\b/g;

/**
 * What the two sites' messages have in common once everything site-specific is gone: paths, URLs, ids, numbers,
 * hostnames and viewport names become placeholders.
 */
export function normaliseMessage(message: string, siteIds: string[] = []): string {
  let m = message.split("\n")[0]!.toLowerCase();
  m = m.replace(URL_RE, "<url>");
  m = m.replace(WIN_PATH, "<path>");
  m = m.replace(ABS_PATH, (s) => `${/^[\s"'(=:]/.test(s) ? s[0] : ""}<path>`);
  m = m.replace(REL_FILE, "<path>");
  m = m.replace(UUID, "<id>");
  m = m.replace(RUN_ID, "<id>");
  m = m.replace(IP_PORT, "<host>");
  m = m.replace(LOCALHOST, "<host>");
  m = m.replace(HOSTNAME, "<host>");
  m = m.replace(VIEWPORT_SIZE, "<viewport>");
  m = m.replace(VIEWPORTS, "<viewport>");
  m = m.replace(HEX_ID, "<id>");
  m = m.replace(NUMBER, "<n>");
  for (const site of siteIds)
    if (site)
      m = m.replace(new RegExp(`\\b${site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "<site>");
  return m.replace(/\s+/g, " ").trim();
}

export function messageHash(message: string, siteIds: string[] = []): string {
  return createHash("sha256").update(normaliseMessage(message, siteIds)).digest("hex").slice(0, 8);
}

/** A verify gate id such as `visual.parity` is already specific; an upper-case code without a cause is not. */
const needsHash = (code: string, cause: string | undefined) =>
  !cause && code === code.toUpperCase() && !NO_HASH_CODES.has(code);

/** Codes whose message varies per occurrence (a URL, a count) but which mean one thing. */
const NO_HASH_CODES = new Set(["BOT_BLOCKED", "SNAPSHOT_INCOMPLETE", "REPLAY_404", "STAGE_SLOW", "TIMEOUT"]);

export function signatureOf(
  stage: string,
  issue: Pick<StageIssue, "code" | "cause" | "message">,
  siteIds: string[] = [],
): string {
  const parts = [stage, issue.code];
  if (issue.cause) parts.push(issue.cause);
  if (needsHash(issue.code, issue.cause)) parts.push(messageHash(issue.message, siteIds));
  return parts.join(":");
}
