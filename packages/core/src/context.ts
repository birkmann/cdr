import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platform, release } from "node:os";
import type { ChatMessage, HarnessConfig, Phase, ReasoningEffort } from "@harness/protocol";
import { detectStack } from "./verify.js";
import { listProjectFiles, renderTree } from "./tools/paths.js";
import { harnessHome } from "./config.js";
import { estimateTokens } from "./util.js";
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
  if (memory) parts.push(`# Memory (facts saved in earlier sessions)\n${memory}`);
  if (opts.extra) parts.push(opts.extra);
  return parts.join("\n\n");
}

// ------------------------------------------------------------------ compaction

/**
 * Index at which history may be cut so that no tool result is separated from its assistant tool call.
 * Returns the index of the first message to keep verbatim.
 */
export function safeCutIndex(messages: ChatMessage[], desiredKeep: number): number {
  let cut = Math.max(1, messages.length - desiredKeep);
  while (cut < messages.length && messages[cut].role === "tool") cut++;
  return cut;
}

export function needsCompaction(
  messages: ChatMessage[],
  contextWindow: number,
  threshold: number,
  count = estimateTokens,
): boolean {
  return count(messages) > contextWindow * threshold;
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

/** Summarise the older part of the conversation, keeping the system prompt and the most recent messages verbatim. */
export async function compactMessages(
  messages: ChatMessage[],
  opts: {
    provider: Provider;
    model: string;
    keepRecent: number;
    signal?: AbortSignal;
    reasoningEffort?: ReasoningEffort;
  },
): Promise<{ messages: ChatMessage[]; summary: string } | null> {
  const system = messages[0]?.role === "system" ? [messages[0]] : [];
  const body = messages.slice(system.length);
  const cut = safeCutIndex(body, opts.keepRecent);
  // keep the first user message (the task) verbatim as well
  const firstUser = body.findIndex((m) => m.role === "user");
  const head = firstUser >= 0 && firstUser < cut ? [body[firstUser]] : [];
  const old = body.slice(0, cut).filter((_, i) => i !== firstUser);
  if (old.length < 2) return null;
  const transcript = renderTranscript(old);
  const res = await collect(
    opts.provider.stream({
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      signal: opts.signal,
      messages: [
        {
          role: "system",
          content:
            "You compress the working history of a coding agent. Produce a dense summary that lets the agent continue without the original messages: decisions made, files read/changed (with key facts about their contents), commands run and their results, errors encountered, and what remains to do. Use bullet points. Do not invent facts.",
        },
        { role: "user", content: transcript.slice(0, 200_000) },
      ],
    }),
  );
  const summary = res.text.trim() || "(summary unavailable)";
  const compacted: ChatMessage[] = [
    ...system,
    ...head,
    {
      role: "user",
      content: `[Context was compacted. Summary of earlier work in this session:]\n${summary}`,
    },
    ...(body[cut]?.role === "assistant"
      ? []
      : [{ role: "assistant" as const, content: "Understood. Continuing from the summary." }]),
    ...body.slice(cut),
  ];
  return { messages: compacted, summary };
}
