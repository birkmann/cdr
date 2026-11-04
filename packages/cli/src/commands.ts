/** Shared by help and readline completion, so every command is discoverable. */
export const COMMANDS = [
  ["/help", "Show commands and keyboard shortcuts"],
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
  ["/clear", "Clear the terminal; retain the conversation"],
  ["/cost", "Show token usage and cost"],
  ["/session", "Show the current session id"],
  ["/exit", "Save and exit"],
] as const;

export function completeCommand(line: string): [string[], string] {
  if (!line.startsWith("/") || /\s/.test(line)) return [[], line];
  return [COMMANDS.map(([name]) => name).filter((name) => name.startsWith(line)), line];
}

export const REPL_HELP = `\n${COMMANDS.map(([name, help]) => `  ${name.padEnd(12)} ${help}`).join("\n")}\n\n  Tab complete · ↑/↓ history · end a line with \\ for multiline input\n  Ctrl+C cancel the current turn · Ctrl+D exit\n`;
