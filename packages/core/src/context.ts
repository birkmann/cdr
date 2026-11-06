import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platform, release } from "node:os";
import type { ChatMessage, HarnessConfig, Phase, ReasoningEffort } from "@harness/protocol";
import { detectStack } from "./verify.js";
import { listProjectFiles, renderTree } from "./tools/paths.js";
import { harnessHome } from "./config.js";
import { estimateTokens, isAbortError, redact, truncateMiddle } from "./util.js";
import type { Provider } from "./providers/types.js";
import { collect } from "./providers/types.js";

const RULE_FILES = ["AGENTS.md", "CLAUDE.md"];

/** Load AGENTS.md / CLAUDE.md from the project root and its parents (outermost first). */
export function loadProjectRules(projectRoot: string): { path: string; content: string }[] {
  const found: { path: string; content: string }[] = [];
  let dir = resolve(projectRoot);
  const home = process.env.HOME ? resolve(process.env.HOME) : "";
  while (true) {
    for (const f of RULE_FILES) {
      const p = join(dir, f);
      if (existsSync(p)) found.unshift({ path: p, content: readFileSync(p, "utf8").slice(0, 40_000) });
    }
    const parent = dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return found;
}

export function loadMemory(projectRoot: string): string {
  const parts: string[] = [];
  for (const [label, dir] of [
    ["user", join(harnessHome(), "memory")],
    ["project", join(projectRoot, ".harness", "memory")],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      const text = readFileSync(join(dir, f), "utf8").trim();
      if (text) parts.push(`<!-- ${label} memory: ${f} -->\n${text.slice(0, 20_000)}`);
    }
  }
  return parts.join("\n\n");
}

function git(root: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function environmentBlock(projectRoot: string): string {
  const stack = detectStack(projectRoot);
  const branch = git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = branch !== null ? git(projectRoot, ["status", "--short"]) : null;
  const lines = [
    `- Project root (cwd): ${projectRoot}`,
    `- OS: ${platform()} ${release()}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- Git: ${branch === null ? "not a git repository" : `branch ${branch}, ${status ? `${status.split("\n").length} changed files` : "clean"}`}`,
    `- Detected stack: ${stack.languages.join(", ") || "unknown"}${stack.packageManager ? ` (${stack.packageManager})` : ""}`,
  ];
  const c = stack.commands;
  if (c.build || c.test || c.lint)
    lines.push(
      `- Detected commands: ${Object.entries(c)
        .map(([k, v]) => `${k}=\`${v}\``)
        .join(", ")}`,
    );
  return lines.join("\n");
}

export function repoMap(projectRoot: string, depth: number): string {
  const files = listProjectFiles(projectRoot);
  if (!files.length) return "(empty project)";
  return `${files.length} files\n${renderTree(files, depth, 300)}`;
}

const TOOL_ETIQUETTE = `## How to work
- Use tools to act. Never just describe changes – make them.
- Read a file before editing it. Prefer \`patch_file\` (exact search/replace) over \`write_file\` for existing files.
- Keep changes minimal and focused on the task; follow existing conventions in the codebase.
- Use \`grep\`/\`glob\` to find code instead of guessing paths.
- When building a page that benefits from photography, use \`search_unsplash\` for suitable real images. Before embedding each selected photo, call \`use_unsplash_photo\` with its download_location. Hotlink the returned image_url unchanged and include visible photographer and Unsplash credit links from the result. Never expose credentials, invent image URLs, or use shell commands to read API keys. If search is unavailable, continue without photos and explain the limitation.
- After making changes, run the relevant build/tests (\`run_verification\` or \`bash\`). Never claim success without evidence.
- To run or start the project's app or dev server, use \`run_app\`, never \`bash\`: it starts the program in the background, waits until it answers and returns its URL. Call it without a command first (it restarts the command used before in this project); if none is known, find the start command quickly (README, package.json scripts, a start script, Makefile) and pass it. Once it reports a URL, give the user the URL and finish: do not re-check ports, processes or pages afterwards.
- If a tool call fails, read the error and adjust; do not repeat the same failing call.
- When finished, reply with a short summary of what you changed and how you verified it, and make no further tool calls.`;

const PHASE_PROMPTS: Record<Phase | "chat", string> = {
  chat: `You are a software engineering agent working inside the user's project through a coding harness. You have tools for reading, searching and editing files and running shell commands.\n\n${TOOL_ETIQUETTE}`,
  plan: `You are the PLANNER in a coding harness. Investigate the codebase with read-only tools and produce an implementation plan. Do NOT modify any files.

Your final reply must be ONLY the plan in Markdown with these sections:
# Plan: <short title>
## Context
(what you found: relevant files, conventions)
## Steps
1. <concrete step, naming files/functions to touch>
2. ...
## Files to touch
- path – why
## Verification
- the exact command(s) that prove the change works
## Risks
- ...

Keep it concise and concrete. Steps must be small enough to implement one at a time.`,
  execute: `You are the EXECUTOR in a coding harness. Implement the task (following the approved plan, if one is given) by editing files with tools.\n\n${TOOL_ETIQUETTE}`,
  verify: "",
  review: `You are a meticulous code REVIEWER in a coding harness. You get the task, the plan, the git diff and the verification output. You may use read-only tools to inspect files for more context. Look for: bugs, missed requirements, broken edge cases, security problems, and changes outside the task scope. Ignore pure style preferences.

Reply with ONLY a JSON object in a \`\`\`json fenced block:
{"summary": "<one paragraph>", "findings": [{"severity": "blocking|major|minor|nit", "file": "path", "line": 12, "issue": "...", "suggestion": "..."}]}
Use "blocking" only for problems that make the change incorrect or unsafe to merge. An empty findings array is fine.`,
  finish: "",
};

export interface SystemPromptOptions {
  projectRoot: string;
  phase: Phase | "chat";
  config: HarnessConfig;
  extra?: string;
  includeRepoMap?: boolean;
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const parts = [PHASE_PROMPTS[opts.phase] || PHASE_PROMPTS.chat];
  parts.push(`# Environment\n${environmentBlock(opts.projectRoot)}`);
  if (opts.includeRepoMap !== false) {
    parts.push(
      `# Repository map\n\`\`\`\n${repoMap(opts.projectRoot, opts.config.context?.repoMapDepth ?? 3)}\n\`\`\``,
    );
  }
  const rules = loadProjectRules(opts.projectRoot);
  if (rules.length) {
    parts.push(
      `# Project rules\nFollow these instructions from the project (they override defaults):\n\n${rules.map((r) => `<!-- ${r.path} -->\n${r.content}`).join("\n\n")}`,
    );
  }
  const memory = loadMemory(opts.projectRoot);
  if (memory)
    parts.push(
      `# Memory (facts saved in earlier sessions; correct outdated ones with remember.replaces or forget)\n${memory}`,
    );
  if (opts.extra) parts.push(opts.extra);
  return parts.join("\n\n");
}

// ------------------------------------------------------------------ compaction

/**
 * Index at which history may be cut so that no tool result is separated from its assistant tool call.
 * Returns the index of the first message to keep verbatim. The cut moves backward to the assistant
 * message owning the tool results at the boundary, so the recent tail is kept (never folded away) and
 * starts with a well-formed tool_use/tool_result group.
 */
export function safeCutIndex(messages: ChatMessage[], desiredKeep: number): number {
  let cut = Math.max(1, messages.length - desiredKeep);
  while (cut > 0 && cut < messages.length && messages[cut].role === "tool") cut--;
  return cut;
}

/** Token budget the working context must stay under: the model window, optionally capped by `maxContext`. */
export function contextLimit(contextWindow: number, maxContext?: number): number {
  return maxContext && maxContext > 0 ? Math.min(contextWindow, maxContext) : contextWindow;
}

/**
 * Tokens of the context that the next model call would send. `measured` is the provider-reported input of
 * the last call, which covered `messages[0..measured.count)`; only messages added since are estimated.
 */
export function contextTokens(
  messages: ChatMessage[],
  measured?: { tokens: number; count: number },
  count = estimateTokens,
): number {
  if (!measured || measured.tokens <= 0 || measured.count > messages.length) return count(messages);
  return measured.tokens + count(messages.slice(measured.count));
}

export function needsCompaction(
  messages: ChatMessage[],
  contextWindow: number,
  threshold: number,
  count = estimateTokens,
  measured?: { tokens: number; count: number },
): boolean {
  return contextTokens(messages, measured, count) > contextWindow * threshold;
}

export function renderTranscript(messages: ChatMessage[], perMessage = 4000): string {
  return messages
    .map((m) => {
      if (m.role === "assistant") {
        const calls = m.toolCalls?.map((c) => `  → ${c.name}(${c.arguments.slice(0, 500)})`).join("\n") ?? "";
        return `ASSISTANT: ${m.content.slice(0, perMessage)}${calls ? "\n" + calls : ""}`;
      }
      if (m.role === "tool") return `TOOL ${m.name} RESULT: ${m.content.slice(0, perMessage)}`;
      const imgs = m.role === "user" && m.images?.length ? ` [${m.images.length} image(s)]` : "";
      return `${m.role.toUpperCase()}: ${m.content.slice(0, perMessage)}${imgs}`;
    })
    .join("\n\n");
}

/** Marks the user message that carries the execution brief produced by compaction. */
export const BRIEF_MARKER = "[harness] Context was compacted. Execution brief for continuing the task:";
const BRIEF_ACK = "Understood. Continuing from the brief.";
const TRIM_MARKER = "[harness] trimmed during compaction";
const SKILLS_MARKER = "\n[harness] Skill instructions loaded earlier (kept verbatim):\n";
const POINTER_MARKER = "\n[harness] Raw earlier";
/** Tool results that are instructions, not observations: never trimmed or summarised away. */
const PRESERVED_TOOLS = new Set(["load_skill"]);
const isPreserved = (m: ChatMessage) => m.role === "tool" && PRESERVED_TOOLS.has(m.name);
/** Old tool results outside the recent tail are cut to this many characters before anything else. */
export const PRUNE_TOOL_CHARS = 2000;

/**
 * Compaction prompt. Following "You don't need long context" (arXiv:2611.05306, Appendix A): the best
 * compactions are hand-off briefs selecting what the remaining work needs, not balanced summaries.
 */
export const BRIEF_PROMPT = `You compress the working history of an agent into an execution brief. The conversation will continue from the system prompt, the original task, your brief and the most recent messages only, so the brief must contain everything the next stretch of work needs. It is a hand-off for future work, not a narrative of the past: select facts that matter for the remaining work instead of summarising everything evenly.

Write these sections as terse Markdown bullets:
1. Objective - one line describing the required result.
2. Established facts - exact paths, symbols, commands, observed values and important errors/output, plus every id or handle later steps must pass back to tools (run ids, session ids, branch names, URLs). Separate verified observations from unverified ideas.
3. Applied changes - each changed/created file, what changed, and whether it was verified.
4. Verification - exact checks run and their outcomes, obstacles and workarounds.
5. Dead ends - failed approaches that must not be repeated.
6. User instructions - preferences or corrections the user gave during the work (verbatim when short).
7. Remaining plan - outstanding subgoals in execution order (for a multi-stage job: stages done, the current stage, stages left), the immediate next command or edit, and the condition for completion.

If a previous brief is given, update it with the new history: keep what is still true and relevant, correct what changed, drop what is obsolete. Never invent facts or observations. Omit empty sections.`;

/** Where raw history removed by compaction is kept, so the agent can grep it instead of keeping it in context. */
export interface HistoryLog {
  /** Absolute path of the log file. */
  file: string;
  /** Path shown to the agent (relative to the project root). */
  ref: string;
}

function appendHistory(history: HistoryLog | undefined, messages: ChatMessage[]): void {
  if (!history || !messages.length) return;
  try {
    const dir = dirname(history.file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "*\n");
    }
    const stamp = new Date().toISOString();
    appendFileSync(
      history.file,
      `\n===== removed from context at ${stamp} =====\n\n${redact(renderTranscript(messages, Number.MAX_SAFE_INTEGER))}\n`,
    );
  } catch {
    // The log is a convenience for recovery; compaction must not fail because of it.
  }
}

const isBrief = (m: ChatMessage) => m.role === "user" && m.content.startsWith(BRIEF_MARKER);
const isAck = (m: ChatMessage) => m.role === "assistant" && m.content === BRIEF_ACK && !m.toolCalls?.length;

/**
 * Cheap, mostly lossless shrinking: outside the recent tail, cut long tool results and drop images
 * (except those of the task message). Originals go to the history log. Returns null when nothing changed.
 */
export function pruneMessages(
  messages: ChatMessage[],
  keepRecent: number,
  history?: HistoryLog,
  maxChars = PRUNE_TOOL_CHARS,
): ChatMessage[] | null {
  const sys = messages[0]?.role === "system" ? 1 : 0;
  const cut = sys + safeCutIndex(messages.slice(sys), keepRecent);
  const firstUser = messages.findIndex((m) => m.role === "user");
  const pointer = history ? `; full text in ${history.ref}` : "";
  const removed: ChatMessage[] = [];
  let changed = false;
  const out = messages.map((m, i) => {
    if (i < sys || i >= cut || i === firstUser) return m;
    if (
      m.role === "tool" &&
      !isPreserved(m) &&
      m.content.length > maxChars &&
      !m.content.includes(TRIM_MARKER)
    ) {
      removed.push(m);
      changed = true;
      return { ...m, content: `${truncateMiddle(m.content, maxChars).text}\n${TRIM_MARKER}${pointer}` };
    }
    if (m.role === "user" && m.images?.length) {
      changed = true;
      const { images, ...rest } = m;
      return {
        ...rest,
        content: `${m.content}\n[harness] ${images.length} image(s) removed during compaction`,
      };
    }
    return m;
  });
  if (!changed) return null;
  appendHistory(history, removed);
  return out;
}

export interface CompactionResult {
  messages: ChatMessage[];
  /** The execution brief ("" when only pruning was needed). */
  summary: string;
  method: "prune" | "brief";
  /** Tokens spent by the compaction model call. */
  usage: { input: number; output: number };
}

/**
 * Shrink the working context. First prunes old tool output and images; if that brings the context under
 * `targetTokens`, no model call is made. Otherwise the older history is replaced by an execution brief,
 * keeping the system prompt, the task message and the most recent messages verbatim. A previous brief is
 * updated rather than summarised again, so repeated compactions don't compound their losses.
 */
export async function compactMessages(
  messages: ChatMessage[],
  opts: {
    provider: Provider;
    model: string;
    keepRecent: number;
    signal?: AbortSignal;
    reasoningEffort?: ReasoningEffort;
    /** Accept a prune-only result at or below this many tokens. Omit to always write a brief. */
    targetTokens?: number;
    /** Tokens the request costs besides the messages (tool definitions, provider framing). */
    overhead?: number;
    history?: HistoryLog;
    count?: (messages: ChatMessage[]) => number;
    /** Tokens spent by the summariser call, reported even when its brief is empty and unused. */
    onUsage?: (usage: { input: number; output: number }) => void;
    /** The summariser call failed (not aborted); compaction falls back to the prune-only result. */
    onError?: (error: Error) => void;
  },
): Promise<CompactionResult | null> {
  const count = opts.count ?? estimateTokens;
  const pruned = pruneMessages(messages, opts.keepRecent, opts.history);
  const pruneOnly: CompactionResult | null = pruned
    ? { messages: pruned, summary: "", method: "prune", usage: { input: 0, output: 0 } }
    : null;
  if (pruned && opts.targetTokens && count(pruned) + (opts.overhead ?? 0) <= opts.targetTokens)
    return pruneOnly;

  const current = pruned ?? messages;
  const system = current[0]?.role === "system" ? [current[0]] : [];
  const body = current.slice(system.length);
  const cut = safeCutIndex(body, opts.keepRecent);
  // keep the first user message (the task) verbatim as well
  const firstUser = body.findIndex((m) => m.role === "user");
  const head = firstUser >= 0 && firstUser < cut ? [body[firstUser]] : [];
  const older = body.slice(0, cut).filter((_, i) => i !== firstUser);
  const prior = [...older].reverse().find(isBrief);
  const old = older.filter((m) => !isBrief(m) && !isAck(m));
  if (old.length < 2) return pruneOnly;

  const priorBody = prior ? prior.content.slice(BRIEF_MARKER.length).split(POINTER_MARKER)[0] : "";
  const [priorText, priorSkills = ""] = priorBody.split(SKILLS_MARKER);
  // Loaded skills keep their full text across compactions; the agent would otherwise lose its instructions.
  const skills = [...(priorSkills.trim() ? [priorSkills.trim()] : [])];
  for (const m of old)
    if (
      isPreserved(m) &&
      !m.content.startsWith("Unknown skill") &&
      !skills.some((k) => k.includes(m.content.trim()))
    )
      skills.push(m.content.trim());
  const task = firstUser >= 0 ? body[firstUser].content : "";
  const input = [
    task ? `# Original task\n${task.slice(0, 8000)}` : "",
    priorText.trim() ? `# Previous brief (update it)\n${priorText.trim()}` : "",
    `# History since then\n${renderTranscript(old)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  let res: Awaited<ReturnType<typeof collect>>;
  try {
    res = await collect(
      opts.provider.stream({
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        signal: opts.signal,
        messages: [
          { role: "system", content: BRIEF_PROMPT },
          { role: "user", content: input.slice(0, 200_000) },
        ],
      }),
    );
  } catch (e) {
    if (opts.signal?.aborted || isAbortError(e)) throw e;
    // A failing summariser must not fail the run: keep whatever pruning achieved.
    opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    return pruneOnly;
  }
  const usage = { input: res.usage.input, output: res.usage.output };
  opts.onUsage?.(usage);
  const summary = res.text.trim();
  // Without a brief, dropping the history would lose it outright; keep whatever pruning achieved.
  if (!summary) return pruneOnly && { ...pruneOnly, usage };
  appendHistory(
    opts.history,
    old.filter((m) => !m.content.includes(TRIM_MARKER)),
  );
  const pointer = opts.history
    ? `\n[harness] Raw earlier history is kept in ${opts.history.ref}; search it with grep or read_file if a detail you need is missing here.`
    : "";
  const compacted: ChatMessage[] = [
    ...system,
    ...head,
    {
      role: "user",
      content: `${BRIEF_MARKER}\n${summary}${skills.length ? `${SKILLS_MARKER}${skills.join("\n\n")}` : ""}${pointer}`,
    },
    // The ack keeps roles alternating before a recent user message; the context never ends on it
    // (that would ask the model to continue its own synthetic reply).
    ...(cut < body.length && body[cut].role !== "assistant"
      ? [{ role: "assistant" as const, content: BRIEF_ACK }]
      : []),
    ...body.slice(cut),
  ];
  return { messages: compacted, summary, method: "brief", usage };
}

/** System-prompt note for chats whose new files go to an output folder instead of the project. */
export function outputPrompt(dir: string | undefined): string {
  if (!dir) return "";
  return `# Output folder
Files you create in this chat (poems, notes, drafts, exports) are saved in ${dir}, outside the project, so the repository stays clean. Give them plain relative names such as \`notes.md\`; \`write_file\` returns the full path to tell the user. read_file, patch_file, list_dir, glob and grep accept that full path; \`bash\` runs in the project, so \`cd\` into the folder to run a script you created there. Files that already exist in the project, and new files in a folder the project already has (such as \`src/\`), are written in the project with the usual approval. Only create a file when the user asks for one: a short answer, poem or explanation belongs in your reply. If the user wants to build something in the project, suggest Build mode.`;
}
