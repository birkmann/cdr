import type { Provider } from "./providers/types.js";
import { git, hasHead, isGitRepo, workingTreeDiff } from "./git.js";
import { redact, truncateMiddle } from "./util.js";

export interface CommitMessageResult {
  message: string;
  /** Which changes the message describes. */
  scope: "staged" | "all";
}

const SYSTEM = `You write git commit messages.
Rules:
- First line: a concise summary in the imperative mood, at most 72 characters, no trailing period.
- If the change is not trivial, add a blank line and a short body (plain sentences or "- " bullets) explaining what changed and why.
- Match the style of the repository's recent commit subjects (for example a "feat:" prefix only if they use one).
- Describe only what the diff shows. Do not invent tickets, issue numbers, or co-authors.
- Reply with the commit message only: no code fences, quotes, or commentary.`;

/** Changes to describe: the staged diff, or the whole working tree when nothing is staged. */
export function commitDiff(
  root: string,
  maxChars = 40_000,
): { diff: string; scope: "staged" | "all" } | null {
  if (!isGitRepo(root)) return null;
  const staged = git(root, ["diff", "--cached", "--no-color", "--", ".", ":(exclude).harness"]).out;
  if (staged.trim()) return { diff: truncateMiddle(staged, maxChars).text, scope: "staged" };
  const all = workingTreeDiff(root, maxChars);
  return all?.trim() ? { diff: all, scope: "all" } : null;
}

export function recentSubjects(root: string, n = 12): string[] {
  if (!hasHead(root)) return [];
  return git(root, ["log", `-${n}`, "--format=%s"])
    .out.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Remove fences, surrounding quotes, and a "Commit message:" preamble some models add. */
export function cleanCommitMessage(text: string): string {
  let t = text.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(commit message|message)\s*:\s*/i, "").trim();
  if (/^(["'`]).*\1$/s.test(t) && !t.slice(1, -1).includes("\n")) t = t.slice(1, -1).trim();
  const lines = t.split("\n").map((l) => l.replace(/\s+$/, ""));
  // Keep a blank line between subject and body.
  if (lines.length > 1 && lines[1] !== "") lines.splice(1, 0, "");
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function generateCommitMessage(o: {
  root: string;
  provider: Provider;
  model: string;
  signal?: AbortSignal;
}): Promise<CommitMessageResult> {
  const changes = commitDiff(o.root);
  if (!changes) throw new Error("There are no changes to describe.");
  const subjects = recentSubjects(o.root);
  const user = [
    subjects.length
      ? `Recent commit subjects in this repository:\n${subjects.map((s) => `- ${s}`).join("\n")}`
      : "",
    `Diff (${changes.scope === "staged" ? "staged changes" : "all uncommitted changes"}):\n${redact(changes.diff)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  let text = "";
  for await (const ev of o.provider.stream({
    model: o.model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    maxTokens: 400,
    reasoningEffort: "none",
    signal: o.signal,
  })) {
    if (ev.type === "text") text += ev.text;
  }
  const message = redact(cleanCommitMessage(text));
  if (!message) throw new Error("The model returned an empty commit message.");
  return { message, scope: changes.scope };
}
