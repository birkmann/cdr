import type { AgentOutcome, SpawnAgentRequest, Tool } from "./types.js";

/** Text returned to the parent model for a finished subagent. */
export function formatAgentOutcome(o: AgentOutcome): string {
  const usage = `${o.usage.inputTokens} in / ${o.usage.outputTokens} out tokens${o.usage.cost ? `, $${o.usage.cost.toFixed(4)}` : ""}`;
  return [
    `Subagent ${o.agentId} (session ${o.sessionId}) finished: ${o.status} · ${usage}`,
    o.worktree
      ? `Worktree: ${o.worktree}\nBranch: ${o.branch} (changes are committed there; merge with \`git merge ${o.branch}\`)`
      : "",
    o.diffStat ? `Diff stat:\n${o.diffStat}` : o.worktree ? "Diff stat: (no changes)" : "",
    `Final message:\n${o.summary || "(empty)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const spawnAgentTool: Tool = {
  name: "spawn_agent",
  description:
    "Delegate a self-contained task to a subagent with its own context, log and budget. " +
    'isolation "shared" runs a read-only research agent in this checkout (it can read and search, never edit). ' +
    'isolation "worktree" runs a worker in its own git worktree and branch; its edits are committed on that branch and ' +
    "you merge them back with `git merge <branch>`. Give the subagent everything it needs in `task`: it does not see " +
    "your conversation. Returns the subagent's final message. With wait=false it returns an agent id immediately; " +
    "collect results with wait_agents.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Complete, self-contained instructions for the subagent." },
      role: {
        type: "string",
        description:
          'Model role: "executor" (default), "planner", "reviewer", or an explicit "provider/model".',
      },
      isolation: {
        type: "string",
        enum: ["shared", "worktree"],
        description: '"shared" (default, read-only) or "worktree" (may edit files on its own branch).',
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Optional further restriction of the subagent's tool names.",
      },
      budget: {
        type: "object",
        description: "Optional limits; capped by your own remaining budget.",
        properties: {
          maxTurns: { type: "integer" },
          maxTokens: { type: "integer" },
          maxCost: { type: "number" },
          timeoutMs: { type: "integer" },
        },
      },
      wait: { type: "boolean", description: "Wait for the result (default true)." },
    },
    required: ["task"],
  },
  readOnly: false,
  // The child's own tool calls go through its permission policy; spawning itself is harmless.
  risk: () => "low",
  async execute(args: SpawnAgentRequest & { wait?: boolean }, ctx) {
    if (!ctx.agents) return { ok: false, output: "Subagents are not available in this session." };
    if (typeof args.task !== "string" || !args.task.trim())
      return { ok: false, output: "spawn_agent needs a non-empty task." };
    if (args.isolation && !["shared", "worktree"].includes(args.isolation))
      return { ok: false, output: 'isolation must be "shared" or "worktree".' };
    let handle;
    try {
      handle = await ctx.agents.spawn(args, ctx.toolCallId ?? "");
    } catch (e) {
      return { ok: false, output: `Could not spawn subagent: ${(e as Error).message}` };
    }
    if (args.wait === false)
      return {
        ok: true,
        output: `Started subagent ${handle.agentId} (session ${handle.sessionId})${handle.branch ? ` on branch ${handle.branch}` : ""}. Collect its result with wait_agents.`,
      };
    const [outcome] = await ctx.agents.wait([handle.agentId]);
    return { ok: outcome.status === "success", output: formatAgentOutcome(outcome) };
  },
};

export const waitAgentsTool: Tool = {
  name: "wait_agents",
  description:
    "Wait for subagents started with spawn_agent(wait=false) and return their results. Omit agentIds to wait for all uncollected ones.",
  parameters: {
    type: "object",
    properties: { agentIds: { type: "array", items: { type: "string" } } },
  },
  readOnly: false,
  risk: () => "low",
  async execute(args: { agentIds?: string[] }, ctx) {
    if (!ctx.agents) return { ok: false, output: "Subagents are not available in this session." };
    let outcomes: AgentOutcome[];
    try {
      outcomes = await ctx.agents.wait(args.agentIds?.length ? args.agentIds : undefined);
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
    if (!outcomes.length) return { ok: true, output: "No subagents to wait for." };
    return {
      ok: outcomes.every((o) => o.status === "success"),
      output: outcomes.map(formatAgentOutcome).join("\n\n---\n\n"),
    };
  },
};
