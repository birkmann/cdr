import type { HarnessConfig, PermissionDecision, Risk } from "@harness/protocol";
import type { Tool, ToolContext } from "./tools/types.js";
import { wildcardMatch } from "./util.js";

/** Commands that are always refused, in every mode (including yolo). */
const HARD_DENY: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|\.\.)(\s|$)/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^|]*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bgit\s+push\b[^\n]*(--force|-f\b|--mirror)/,
  /\bchmod\s+-R\s+[0-7]*777\s+\//,
  />\s*\/dev\/sd[a-z]/,
  /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
];

/** Commands that need confirmation in `auto` mode. */
const RISKY: RegExp[] = [
  /\brm\b/,
  /\bsudo\b/,
  /\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|rebase|filter-branch|branch\s+-D)/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bchmod\b|\bchown\b/,
  /\bdocker\b|\bkubectl\b|\bterraform\b/,
  /\bkill(all)?\b|\bpkill\b/,
  /\b(curl|wget)\b/,
  /\bssh\b|\bscp\b|\brsync\b/,
  /\bmv\s+[^\n]*\s\/(?!dev\/null)/,
];

const READONLY_CMDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "pwd",
  "tree",
  "file",
  "stat",
  "du",
  "df",
  "echo",
  "printf",
  "sort",
  "uniq",
  "cut",
  "tr",
  "which",
  "whoami",
  "date",
  "env",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "less",
  "more",
  "diff",
  "cmp",
  "jq",
  "true",
  "false",
  "test",
  "[",
  "nl",
  "column",
  "awk",
  "md5sum",
  "sha256sum",
  "uname",
  "id",
  "type",
  "command",
  // looking at what runs on this machine
  "cd",
  "sleep",
  "ps",
  "pgrep",
  "ss",
  "netstat",
  "lsof",
  "uptime",
  "hostname",
  "nproc",
  "free",
]);
const READONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "ls-files",
  "rev-parse",
  "blame",
  "remote",
  "describe",
  "shortlog",
  "grep",
  "config",
]);

const LOOPBACK_HOST = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])`;
const LOOPBACK_URL = new RegExp(
  String.raw`^(?:https?://)?${LOOPBACK_HOST}(?::(\d+|\$\w+|\$\{\w+\}))?(?:/\S*)?$`,
);
const VAR_REF = /\$(?:(\w+)|\{(\w+)\})/g;

type LoopVars = Map<string, "port" | "url" | "path">;

/** `for` variables that only ever hold port numbers, loopback URLs or paths (`for p in 8081 8082`). */
function loopVars(command: string): LoopVars {
  const vars: LoopVars = new Map();
  const unsafe = new Set<string>();
  for (const m of command.matchAll(/\bfor\s+(\w+)\s+in\s+([^;\n]*)/g)) {
    const words = m[2].trim().split(/\s+/).filter(Boolean);
    const kind = !words.length
      ? undefined
      : words.every((w) => /^\d+$/.test(w))
        ? "port"
        : words.every((w) => !w.includes("$") && LOOPBACK_URL.test(w))
          ? "url"
          : words.every((w) => /^\/[\w./-]*$/.test(w))
            ? "path"
            : undefined;
    if (!kind || unsafe.has(m[1]) || (vars.has(m[1]) && vars.get(m[1]) !== kind)) {
      unsafe.add(m[1]);
      vars.delete(m[1]);
    } else vars.set(m[1], kind);
  }
  return vars;
}

/** Words of one simple command; undefined when the quoting is too clever to judge (escapes, open quotes). */
function shellWords(segment: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\") {
      return undefined;
    } else if (/\s/.test(ch)) {
      if (started || word) words.push(word);
      word = "";
      started = false;
    } else word += ch;
  }
  if (quote) return undefined;
  if (started || word) words.push(word);
  return words;
}

/** The simple commands of a command line: split at `;`, `&&`, `||`, `|` and newlines, but not inside quotes. */
function splitCommands(command: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && command[i + 1] === "&")) {
      if (command[i + 1] === ch && ch !== ";" && ch !== "\n") i++;
      parts.push(part);
      part = "";
      continue;
    }
    part += ch;
  }
  parts.push(part);
  return parts.map((s) => s.trim()).filter(Boolean);
}

const CURL_FLAGS = "sSfLkiIvN46";
const CURL_VALUE_FLAGS = "owmHA";
const CURL_LONG_FLAGS = new Set([
  "--silent",
  "--show-error",
  "--fail",
  "--location",
  "--insecure",
  "--include",
  "--head",
  "--verbose",
  "--no-buffer",
  "--compressed",
  "--retry-connrefused",
]);
const CURL_LONG_VALUE_FLAGS = new Set([
  "--output",
  "--write-out",
  "--max-time",
  "--connect-timeout",
  "--header",
  "--user-agent",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
]);

/**
 * A `curl` that only reads from this machine: every URL is a loopback address, nothing is uploaded and nothing
 * is saved (`-o /dev/null` is fine). Checking that a local dev server answers needs no confirmation.
 */
function isLocalCurl(words: string[], vars: LoopVars): boolean {
  // variables may only be loop variables with known harmless values
  for (const w of words.slice(1)) {
    const refs = [...w.matchAll(VAR_REF)];
    if (refs.length !== (w.match(/\$/g)?.length ?? 0)) return false;
    if (refs.some((r) => !vars.has(r[1] ?? r[2]))) return false;
  }
  const isUrl = (w: string): boolean => {
    const bare = /^\$(?:(\w+)|\{(\w+)\})$/.exec(w);
    if (bare) return vars.get(bare[1] ?? bare[2]) === "url";
    const m = LOOPBACK_URL.exec(w);
    if (!m) return false;
    const port = m[1] && /^\$\{?(\w+)\}?$/.exec(m[1]);
    return !port || vars.get(port[1]) === "port";
  };
  const valueOk = (flag: string, value: string | undefined) =>
    value !== undefined && (!["o", "--output"].includes(flag) || value === "/dev/null");
  let urls = 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      if (CURL_LONG_FLAGS.has(name) && eq < 0) continue;
      if (!CURL_LONG_VALUE_FLAGS.has(name)) return false;
      if (!valueOk(name, eq < 0 ? words[++i] : w.slice(eq + 1))) return false;
    } else if (w.startsWith("-") && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        if (CURL_FLAGS.includes(w[j])) continue;
        if (!CURL_VALUE_FLAGS.includes(w[j])) return false;
        if (!valueOk(w[j], w.slice(j + 1) || words[++i])) return false;
        break;
      }
    } else if (isUrl(w)) urls++;
    else return false;
  }
  return urls > 0;
}

/** Heuristic: true if every pipeline segment is a known read-only command without redirection to files. */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/`|\$\(/.test(cmd)) return false;
  const withoutSafeRedirects = cmd.replace(/\d?>\s*\/dev\/null|2>&1|>&2/g, "");
  if (/[^<]>|>>/.test(" " + withoutSafeRedirects) || /\btee\b/.test(cmd)) return false;
  const segments = splitCommands(withoutSafeRedirects);
  const vars = loopVars(cmd);
  for (const raw of segments) {
    // loop and branch keywords: judge the command they introduce
    const seg = raw.replace(/^(?:(?:do|then|else|if|elif|while|until)(?:\s+|$))+/, "");
    if (!seg || /^for\s+\w+\s+in(\s|$)/.test(seg) || seg === "done" || seg === "fi") continue;
    const words = seg.replace(/^(\w+=\S*\s+)+/, "").split(/\s+/);
    const w0 = words[0];
    if (w0 === "curl") {
      const exact = shellWords(seg);
      if (!exact || !isLocalCurl(exact, vars)) return false;
      continue;
    }
    if (w0 === "git") {
      const sub = words.find((w, i) => i > 0 && !w.startsWith("-"));
      if (!sub || !READONLY_GIT.has(sub)) return false;
      if (sub === "branch" && words.some((w) => /^-[dDmM]$|^--delete|^--move/.test(w))) return false;
      if (sub === "config" && !words.includes("--get") && !words.includes("--list") && !words.includes("-l"))
        return false;
      continue;
    }
    if (w0 === "find") {
      if (words.some((w) => /^-(delete|exec|execdir|ok|fprint)/.test(w))) return false;
      continue;
    }
    if (w0 === "sed") {
      if (words.some((w) => /^-i|^--in-place/.test(w))) return false;
      continue;
    }
    if (w0 === "awk" && /system\s*\(|>\s*"/.test(seg)) return false;
    if (!READONLY_CMDS.has(w0)) return false;
  }
  return true;
}

export interface PermissionCheck {
  decision: "allow" | "deny" | "ask";
  risk: Risk;
  reason?: string;
}

export class PermissionPolicy {
  private readonly grants = new Set<string>();
  constructor(
    private readonly cfg: HarnessConfig,
    public mode: "ask" | "auto" | "yolo" = cfg.permissions?.mode ?? "ask",
  ) {}

  private grantKey(tool: string, args: any): string {
    if (tool === "bash") {
      const words = String(args?.command ?? "")
        .trim()
        .split(/\s+/);
      return `bash:${words.slice(0, 2).join(" ")}`;
    }
    // "always" for an app start covers that command, not every program
    if (tool === "run_app") return `run_app:${String(args?.command ?? "").trim()}`;
    return tool;
  }

  check(tool: Tool, args: any, ctx?: ToolContext): PermissionCheck {
    const risk: Risk = tool.risk ? tool.risk(args, ctx as ToolContext) : tool.readOnly ? "low" : "medium";
    // bash, and tools that start a shell command of their own (run_app)
    const command = tool.name === "bash" ? String(args?.command ?? "") : tool.shellCommand?.(args, ctx);
    if (command !== undefined) {
      if (HARD_DENY.some((re) => re.test(command)))
        return { decision: "deny", risk: "high", reason: "Command matches a built-in deny rule." };
      const deny = this.cfg.permissions?.bash?.deny ?? [];
      const segments = [command, ...command.split(/\|\||&&|;|\||\n/).map((s) => s.trim())];
      if (deny.some((p) => segments.some((s) => wildcardMatch(p, s))))
        return { decision: "deny", risk: "high", reason: "Command matches permissions.bash.deny." };
    }
    const toolRule = this.cfg.permissions?.tools?.[tool.name];
    if (toolRule === "deny")
      return { decision: "deny", risk, reason: `Tool ${tool.name} is denied by config.` };
    if (toolRule === "allow") return { decision: "allow", risk };
    // the tool asks for itself (a consent gate): never pre-empted, never granted "always"
    if (tool.selfGated) return { decision: "allow", risk };
    if (this.mode === "yolo") return { decision: "allow", risk };
    if (command !== undefined) {
      const allow = this.cfg.permissions?.bash?.allow ?? [];
      // Every segment of a compound command must be allow-listed ("pnpm test && rm -rf x" is not).
      const segments = command
        .split(/\|\||&&|;|\||\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        allow.length &&
        /`|\$\(/.test(command) === false &&
        segments.every((s) => allow.some((p) => wildcardMatch(p, s)))
      )
        return { decision: "allow", risk };
    }
    if (this.grants.has(this.grantKey(tool.name, args))) return { decision: "allow", risk };
    if (toolRule === "ask") return { decision: "ask", risk };
    // `risk` defaults to low for read-only tools; an explicit higher risk (e.g. a user-wide memory write) still asks.
    if (risk === "low") return { decision: "allow", risk };
    if (this.mode === "auto") {
      // Inside the bwrap sandbox the shell can only write to the project, so "risky" commands need no prompt.
      if (command !== undefined && this.cfg.sandbox !== "bwrap") {
        if (RISKY.some((re) => re.test(command)))
          return { decision: "ask", risk: "high", reason: "Potentially destructive command." };
      }
      return { decision: "allow", risk };
    }
    // a command the call does not spell out (run_app restarting the remembered one): show what would run
    if (command && tool.name !== "bash" && !args?.command)
      return { decision: "ask", risk, reason: `Runs: ${command}` };
    return { decision: "ask", risk };
  }

  record(tool: string, args: any, decision: PermissionDecision): void {
    if (decision === "always") this.grants.add(this.grantKey(tool, args));
  }
}
