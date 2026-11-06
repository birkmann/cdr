import type { Session } from "@harness/core";

/** Shared by help and readline completion, so every command is discoverable. */
export const COMMANDS = [
  ["/help", "Show commands and keyboard shortcuts"],
  ["/skills", "List skills; /<skill> <message> sends a message with that skill"],
  ["/run", "Plan, build, verify, and review a task"],
  ["/continue", "Continue the last failed or stopped job using saved progress"],
  ["/quick", "Build and verify a small change"],
  ["/plan", "Explore and plan without editing"],
  ["/review", "Review the working tree"],
  ["/attach", "Attach a project file or image to the next message"],
  ["/attachments", "List pending files; /attachments clear removes them"],
  ["/model", "Switch every role to provider/model"],
  ["/models", "List configured models; /models remote discovers more"],
  ["/mode", "Set permissions: ask, auto, or yolo"],
  ["/new", "Start a fresh conversation (or a fresh sandbox)"],
  ["/sessions", "List saved conversations"],
  ["/resume", "Resume a saved conversation by id"],
  ["/status", "Show project, model, permissions, and usage"],
  ["/diff", "Show uncommitted changes"],
  ["/rewind", "List checkpoints; /rewind <n> restores files to before turn n, /rewind undo reverts"],
  ["/terminal-design", "Switch the terminal look: default or classic (remembered)"],
  ["/clear", "Clear the terminal; retain the conversation"],
  ["/cost", "Show token usage and cost"],
  ["/session", "Show the current session id"],
  ["/exit", "Save and exit"],
] as const;

export function completeCommand(line: string, skills: string[] = []): [string[], string] {
  if (!line.startsWith("/") || /\s/.test(line)) return [[], line];
  const names = [...COMMANDS.map(([name]) => name), ...skills.map((s) => `/${s}`)];
  return [names.filter((name) => name.startsWith(line)), line];
}

const BUILTIN = new Set<string>([...COMMANDS.map(([name]) => name), "/quit", "/q", "/commands"]);

/**
 * `/tdd fix the parser` or `/grill-me /domain-modeling my plan`: leading `/<skill>` words select skills
 * for the message. Built-in commands win over skills of the same name. Returns undefined when the
 * line does not start with a skill.
 */
export function parseSkillCommand(
  line: string,
  skills: string[],
): { skills: string[]; text: string } | undefined {
  const known = new Set(skills);
  const picked: string[] = [];
  let rest = line.trimStart();
  while (true) {
    const m = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)\s*/.exec(rest);
    if (!m || BUILTIN.has(`/${m[1]}`) || !known.has(m[1])) break;
    picked.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  if (!picked.length) return undefined;
  const text = rest.trim() || `Use the ${picked.join(" and ")} skill${picked.length > 1 ? "s" : ""}.`;
  return { skills: picked, text };
}

export const REPL_HELP = `\n${COMMANDS.map(([name, help]) => `  ${name.padEnd(12)} ${help}`).join("\n")}\n\n  Tab complete · ↑/↓ history · end a line with \\ for multiline input\n  Ctrl+C cancel the current turn · Ctrl+D exit\n`;

/** Turn checkpoints of a session, newest first, each with the message whose turn it precedes. */
export function listCheckpoints(session: Session): { id: string; ts: string; message: string }[] {
  const out: { id: string; ts: string; message: string }[] = [];
  let pending: { id: string; ts: string } | undefined;
  const texts = new Map<string, string>();
  for (const e of session.events) if (e.type === "message.end") texts.set(e.id, e.text);
  for (const e of session.events) {
    if (e.type === "checkpoint.created" && e.reason === "turn" && e.messageId)
      out.push({ id: e.id, ts: e.ts, message: texts.get(e.messageId) ?? "" });
    else if (e.type === "checkpoint.created" && e.reason === "turn") pending = { id: e.id, ts: e.ts };
    else if (e.type === "message.start" && e.role === "user" && pending) {
      out.push({ ...pending, message: texts.get(e.id) ?? "" });
      pending = undefined;
    } else if (e.type === "done") pending = undefined;
  }
  return out.reverse();
}

/** `/rewind [n|id|undo]`: list checkpoints, or restore one. Returns the text to show. */
export async function rewindCommand(session: Session, arg: string): Promise<string> {
  const list = listCheckpoints(session);
  if (!arg) {
    if (!list.length) return "No checkpoints yet. One is saved before every turn.\n";
    return (
      list
        .slice(0, 15)
        .map(
          (cp, i) =>
            `  ${String(i + 1).padStart(2)}  ${cp.ts.slice(11, 16)}  ${cp.message.split("\n")[0].slice(0, 70) || "(no message)"}`,
        )
        .join("\n") + "\n\n  /rewind <n> restores the files to how they were before that message.\n"
    );
  }
  let id: string | undefined;
  if (arg === "undo") {
    const last = [...session.events].reverse().find((e) => e.type === "checkpoint.restored");
    if (last?.type !== "checkpoint.restored") return "Nothing to undo.\n";
    id = last.backupId;
  } else if (/^\d+$/.test(arg)) id = list[Number(arg) - 1]?.id;
  else id = arg;
  if (!id) return `No checkpoint ${arg}. /rewind lists them.\n`;
  const r = await session.restoreCheckpoint(id);
  return r.files.length
    ? `Restored ${r.files.length} file${r.files.length === 1 ? "" : "s"}. /rewind undo reverts this.\n`
    : "Files already match that checkpoint.\n";
}
