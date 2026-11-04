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

/** Heuristic: true if every pipeline segment is a known read-only command without redirection to files. */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/`|\$\(/.test(cmd)) return false;
  const withoutSafeRedirects = cmd.replace(/\d?>\s*\/dev\/null|2>&1|>&2/g, "");
  if (/[^<]>|>>/.test(" " + withoutSafeRedirects) || /\btee\b/.test(cmd)) return false;
  const segments = withoutSafeRedirects
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    const words = seg.replace(/^(\w+=\S*\s+)+/, "").split(/\s+/);
    const w0 = words[0];
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
    return tool;
  }

  check(tool: Tool, args: any, ctx?: ToolContext): PermissionCheck {
    const risk: Risk = tool.risk ? tool.risk(args, ctx as ToolContext) : tool.readOnly ? "low" : "medium";
    if (tool.name === "bash") {
      const command = String(args?.command ?? "");
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
    if (this.mode === "yolo") return { decision: "allow", risk };
    if (tool.name === "bash") {
      const command = String(args?.command ?? "");
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
    if (tool.readOnly || risk === "low") return { decision: "allow", risk };
    if (this.mode === "auto") {
      // Inside the bwrap sandbox the shell can only write to the project, so "risky" commands need no prompt.
      if (tool.name === "bash" && this.cfg.sandbox !== "bwrap") {
        const command = String(args?.command ?? "");
        if (RISKY.some((re) => re.test(command)))
          return { decision: "ask", risk: "high", reason: "Potentially destructive command." };
      }
      return { decision: "allow", risk };
    }
    return { decision: "ask", risk };
  }

  record(tool: string, args: any, decision: PermissionDecision): void {
    if (decision === "always") this.grants.add(this.grantKey(tool, args));
  }
}
