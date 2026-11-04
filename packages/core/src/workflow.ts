import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatMessage,
  CriterionResult,
  Finding,
  ImagePart,
  Phase,
  PhaseDef,
  WorkflowDef,
} from "@harness/protocol";
import type { Session } from "./session.js";
import type { AgentResult } from "./loop.js";
import { formatVerifyFailure, type VerifyOutcome } from "./verify.js";
import { commitOnBranch, workingTreeDiff } from "./git.js";
import { unifiedDiff } from "./diff.js";
import { slugify } from "./util.js";

export const WORKFLOW_PRESETS: Record<string, WorkflowDef> = {
  default: {
    name: "default",
    description: "plan (approval) → execute → verify → review → finish",
    phases: [
      { phase: "plan", model: "planner", gate: true },
      { phase: "execute", model: "executor" },
      { phase: "verify" },
      { phase: "review", model: "reviewer" },
      { phase: "finish" },
    ],
  },
  "quick-fix": {
    name: "quick-fix",
    description: "execute → verify → finish",
    phases: [{ phase: "execute", model: "executor" }, { phase: "verify" }, { phase: "finish" }],
  },
  "plan-only": {
    name: "plan-only",
    description: "plan → finish (no edits)",
    phases: [{ phase: "plan", model: "planner", gate: false }, { phase: "finish" }],
  },
  "review-only": {
    name: "review-only",
    description: "review the current git diff → finish",
    phases: [{ phase: "review", model: "reviewer" }, { phase: "finish" }],
  },
  autonomous: {
    name: "autonomous",
    description:
      "unattended: plan (no approval) → execute (fresh context per step) → verify → review with acceptance criteria → finish",
    freshContextPerStep: true,
    phases: [
      { phase: "plan", model: "planner", gate: false },
      { phase: "execute", model: "executor" },
      { phase: "verify" },
      { phase: "review", model: "reviewer" },
      { phase: "finish" },
    ],
  },
  "no-review": {
    name: "no-review",
    description: "plan (approval) → execute → verify → finish",
    phases: [
      { phase: "plan", model: "planner", gate: true },
      { phase: "execute", model: "executor" },
      { phase: "verify" },
      { phase: "finish" },
    ],
  },
};

export function getWorkflow(name: string, custom: Record<string, WorkflowDef> = {}): WorkflowDef {
  const w = custom[name] ?? WORKFLOW_PRESETS[name];
  if (!w)
    throw new Error(
      `Unknown workflow "${name}". Available: ${[...new Set([...Object.keys(WORKFLOW_PRESETS), ...Object.keys(custom)])].join(", ")}`,
    );
  return w;
}

export interface RunOptions {
  workflow?: string;
  /** Skip the plan phase (CLI --no-plan). */
  noPlan?: boolean;
  /** Commit the result on a harness/<slug> branch. */
  commit?: boolean;
  /** Acceptance criteria the review phase must evaluate (goals); results land in RunResult.criteria. */
  acceptance?: string[];
  /** Images attached to the task (given to the planner and to fresh executor contexts). */
  images?: ImagePart[];
  /** Recovered from this session's event log by continueJob(). */
  continuation?: {
    fromSeq: number;
    plan?: string;
    planPath?: string;
    messages: ChatMessage[];
    context: string;
    edited: string[];
    diffs: string[];
  };
}

export interface RunResult {
  status: "success" | "failed" | "cancelled";
  summary: string;
  plan?: string;
  planPath?: string;
  verify?: VerifyOutcome;
  findings?: Finding[];
  /** Acceptance-criteria evaluation (only when RunOptions.acceptance was given and the review ran). */
  criteria?: CriterionResult[];
  reportPath?: string;
  branch?: string;
  edited: string[];
}

/** Parse `criteria` from a reviewer reply; criteria the reviewer skipped count as unmet. */
export function parseCriteria(text: string, acceptance: string[]): CriterionResult[] {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const candidates = [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(
    (x): x is string => !!x && x.includes("{"),
  );
  let raw: any[] = [];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (Array.isArray(obj?.criteria)) {
        raw = obj.criteria;
        break;
      }
    } catch {
      /* try next */
    }
  }
  return acceptance.map((criterion, i) => {
    const hit =
      raw.find((r) => r && typeof r.criterion === "string" && r.criterion.trim() === criterion.trim()) ??
      (raw.length === acceptance.length ? raw[i] : undefined);
    return hit && typeof hit === "object"
      ? {
          criterion,
          met: hit.met === true,
          ...(typeof hit.evidence === "string" && hit.evidence ? { evidence: hit.evidence } : {}),
        }
      : { criterion, met: false, evidence: "not evaluated by the reviewer" };
  });
}

export function extractSteps(plan: string): string[] {
  const m = /^##\s*Steps\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/im.exec(plan);
  const section = m ? m[1] : plan;
  const steps: string[] = [];
  let cur: string | null = null;
  for (const line of section.split("\n")) {
    const item = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (item) {
      if (cur) steps.push(cur.trim());
      cur = item[2];
    } else if (cur !== null && /^\s{2,}\S/.test(line)) cur += "\n" + line.trim();
  }
  if (cur) steps.push(cur.trim());
  return steps;
}

export function parseReview(text: string): { summary: string; findings: Finding[]; parsed: boolean } {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const candidates = [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(
    (x): x is string => !!x && x.includes("{"),
  );
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      const raw: any[] = Array.isArray(obj) ? obj : (obj.findings ?? []);
      const findings: Finding[] = raw
        .filter((f) => f && typeof f.issue === "string")
        .map((f) => ({
          severity: ["blocking", "major", "minor", "nit"].includes(f.severity) ? f.severity : "minor",
          file: typeof f.file === "string" ? f.file : undefined,
          line: Number.isInteger(f.line) ? f.line : undefined,
          issue: f.issue,
          suggestion: typeof f.suggestion === "string" ? f.suggestion : undefined,
        }));
      return { summary: typeof obj.summary === "string" ? obj.summary : "", findings, parsed: true };
    } catch {
      /* try next */
    }
  }
  return { summary: text.trim(), findings: [], parsed: false };
}

const READ_ONLY_TOOLS = [
  "read_file",
  "glob",
  "grep",
  "list_dir",
  "bash",
  "ask_user",
  "todo",
  "search_unsplash",
];

/** Orchestrates the phases of a workflow on a session. */
export async function runWorkflow(session: Session, task: string, opts: RunOptions = {}): Promise<RunResult> {
  const def = getWorkflow(opts.workflow ?? session.workflow, session.config.workflows);
  const phases = def.phases.filter((p) => !((opts.noPlan || opts.continuation?.plan) && p.phase === "plan"));
  const slug = `${new Date().toISOString().slice(0, 10)}-${slugify(task)}${opts.continuation ? `-continue-${session.events.at(-1)?.seq ?? 0}` : ""}`;
  const root = session.projectRoot;
  const state: {
    plan?: string;
    planPath?: string;
    exec?: AgentResult;
    execMessages?: ChatMessage[];
    verify?: VerifyOutcome;
    findings?: Finding[];
    criteria?: CriterionResult[];
    reviewSummary?: string;
    failed?: string;
    cancelled?: boolean;
    edited: Set<string>;
    snapshots: Map<string, string>;
  } = {
    edited: new Set(opts.continuation?.edited),
    snapshots: session.snapshots,
    plan: opts.continuation?.plan,
    planPath: opts.continuation?.planPath,
    execMessages: opts.continuation?.messages.length ? opts.continuation.messages : undefined,
  };
  session.snapshots.clear();

  const phaseDef = (p: Phase) => phases.find((x) => x.phase === p);
  const isCancelled = () => session.signal.aborted;

  // ---------------------------------------------------------------- phase impls
  const doPlan = async (pd: PhaseDef) => {
    let feedback: string | undefined;
    for (let round = 1; round <= 3; round++) {
      session.emit({ type: "phase.start", phase: "plan", round, agent: "planner" });
      const user = feedback
        ? `Task:\n${task}\n\nYour previous plan:\n${state.plan}\n\nThe user rejected it with this feedback:\n${feedback}\n\nProduce a revised plan.`
        : `Task:\n${task}`;
      const r = await session.runPhaseAgent({
        agent: "planner",
        phase: "plan",
        role: pd.model ?? "planner",
        user,
        images: opts.images,
        toolNames: pd.tools ?? READ_ONLY_TOOLS,
        readOnly: true,
        extraSystem: pd.prompt,
      });
      session.emit({ type: "phase.end", phase: "plan", round, ok: r.status === "completed" });
      if (r.status === "cancelled") return void (state.cancelled = true);
      if (r.status !== "completed" || !r.finalText.trim())
        return void (state.failed = `planner failed: ${r.error ?? "empty plan"}`);
      state.plan = r.finalText.trim();
      const dir = join(root, ".harness", "plans");
      mkdirSync(dir, { recursive: true });
      state.planPath = join(dir, `${slug}.md`);
      writeFileSync(state.planPath, state.plan + "\n");
      if (!pd.gate) return;
      const d = await session.requestPlanDecision(state.plan, state.planPath);
      if (d.decision === "approve") return;
      if (d.decision === "edit" && d.markdown) {
        state.plan = d.markdown;
        writeFileSync(state.planPath, state.plan + "\n");
        return;
      }
      if (d.decision === "reject" && d.feedback && round < 3) {
        feedback = d.feedback;
        continue;
      }
      state.cancelled = true;
      return;
    }
  };

  const execute = async (pd: PhaseDef, user: string, fresh: boolean, round?: number) => {
    session.emit({ type: "phase.start", phase: "execute", round, agent: "executor" });
    const r = await session.runPhaseAgent({
      agent: "executor",
      phase: "execute",
      role: pd.model ?? "executor",
      user,
      images: fresh ? opts.images : undefined,
      toolNames: pd.tools,
      continueFrom: fresh ? undefined : state.execMessages,
      extraSystem: pd.prompt,
    });
    session.emit({ type: "phase.end", phase: "execute", round, ok: r.status === "completed" });
    state.exec = r;
    state.execMessages = r.messages;
    r.edited.forEach((f) => state.edited.add(f));
    if (r.status === "cancelled") state.cancelled = true;
    else if (r.status !== "completed") state.failed = `executor stopped: ${r.error ?? r.status}`;
    return r;
  };

  const doExecute = async (pd: PhaseDef) => {
    const planBlock = state.plan ? `\n\nApproved plan (follow it):\n${state.plan}` : "";
    if (opts.continuation) {
      await execute(
        pd,
        `Task:\n${task}${planBlock}\n\nContinue the interrupted job. Inspect current files before editing. Preserve completed work and finish only what remains, then verify the result.\n\n${opts.continuation.context}`,
        !state.execMessages,
      );
      return;
    }
    const steps = state.plan && def.freshContextPerStep ? extractSteps(state.plan) : [];
    if (steps.length > 1) {
      for (let i = 0; i < steps.length && !state.failed && !state.cancelled; i++) {
        const done = steps
          .slice(0, i)
          .map((s, j) => `${j + 1}. ${s.split("\n")[0]} (done)`)
          .join("\n");
        await execute(
          pd,
          `Task:\n${task}${planBlock}\n\nSteps already completed in earlier rounds:\n${done || "(none)"}\n\nNow implement ONLY step ${i + 1}:\n${steps[i]}\n\nInspect the current state of the files first (earlier steps changed them). Stop when this step is done.`,
          true,
          i + 1,
        );
      }
      return;
    }
    await execute(pd, `Task:\n${task}${planBlock}`, true);
  };

  const doVerify = async () => {
    const runner = session.verifyRunner;
    const exec = phaseDef("execute");
    for (let attempt = 1; ; attempt++) {
      session.emit({ type: "phase.start", phase: "verify", round: attempt });
      const v = await runner.run(attempt, session.signal);
      session.emit({ type: "phase.end", phase: "verify", round: attempt, ok: v.ok });
      state.verify = v;
      if (v.skipped) {
        session.emit({
          type: "log",
          level: "warn",
          message: "No build/test/lint commands configured or detected – verification skipped.",
        });
        return;
      }
      if (v.ok || isCancelled()) return;
      if (!exec || attempt >= runner.maxAttempts) {
        state.failed = `verification failed after ${attempt} attempt(s)`;
        return;
      }
      await execute(exec, formatVerifyFailure(v), false, attempt + 1);
      if (state.failed || state.cancelled) return;
    }
  };

  const reviewDiff = (): string => {
    const g = workingTreeDiff(root);
    if (g !== null && g.trim()) return g;
    // Not a git repo: diff the files snapshotted before their first edit in this run.
    const parts: string[] = [];
    for (const [f, before] of state.snapshots) {
      try {
        parts.push(unifiedDiff(f, before, session.readProjectFile(f) ?? ""));
      } catch {
        /* ignore */
      }
    }
    return (
      [...(opts.continuation?.diffs ?? []), ...parts].filter(Boolean).join("\n") || "(no changes detected)"
    );
  };

  const doReview = async (pd: PhaseDef) => {
    session.emit({ type: "phase.start", phase: "review", agent: "reviewer" });
    const verifyText = state.verify
      ? state.verify.skipped
        ? "No verification commands configured."
        : state.verify.steps.map((s) => `${s.kind}: ${s.command} → exit ${s.exitCode}`).join("\n")
      : "Not run.";
    const user = [
      `Task:\n${task}`,
      state.plan ? `Plan:\n${state.plan}` : "",
      `Diff:\n\`\`\`diff\n${reviewDiff()}\n\`\`\``,
      `Verification:\n${verifyText}`,
      opts.acceptance?.length
        ? `Acceptance criteria:\n${opts.acceptance.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nAlso evaluate every acceptance criterion against the diff, the files and the verification output. Add to your JSON object a "criteria" array with one entry per criterion, in order: {"criterion": "<exact text>", "met": true|false, "evidence": "<file, command output or reason>"}. Mark a criterion met only with concrete evidence.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const r = await session.runPhaseAgent({
      agent: "reviewer",
      phase: "review",
      role: pd.model ?? "reviewer",
      user,
      toolNames: pd.tools ?? READ_ONLY_TOOLS.filter((t) => t !== "todo"),
      readOnly: true,
      includeRepoMap: false,
      extraSystem: pd.prompt,
    });
    session.emit({ type: "phase.end", phase: "review", ok: r.status === "completed" });
    if (r.status === "cancelled") return void (state.cancelled = true);
    if (r.status !== "completed") {
      session.emit({
        type: "log",
        level: "warn",
        message: `review did not complete: ${r.error ?? r.status}`,
      });
      return;
    }
    const parsed = parseReview(r.finalText);
    if (!parsed.parsed)
      session.emit({
        type: "log",
        level: "warn",
        message: "Reviewer did not return JSON; treating reply as summary.",
      });
    state.findings = parsed.findings;
    state.reviewSummary = parsed.summary;
    if (opts.acceptance?.length) state.criteria = parseCriteria(r.finalText, opts.acceptance);
    session.emit({
      type: "review.findings",
      findings: parsed.findings,
      summary: parsed.summary || undefined,
    });
  };

  // ---------------------------------------------------------------- run
  session.emit({
    type: "run.start",
    runId: slug,
    task,
    workflow: def.name,
    ...(opts.noPlan ? { noPlan: true } : {}),
    ...(opts.commit ? { commit: true } : {}),
    ...(opts.continuation ? { continuedFrom: opts.continuation.fromSeq } : {}),
  });
  let reviewedOnce = false;
  for (const pd of phases) {
    if (state.failed || state.cancelled || isCancelled()) break;
    switch (pd.phase) {
      case "plan":
        await doPlan(pd);
        break;
      case "execute":
        await doExecute(pd);
        break;
      case "verify":
        await doVerify();
        break;
      case "review": {
        await doReview(pd);
        const blocking = state.findings?.filter((f) => f.severity === "blocking") ?? [];
        const exec = phaseDef("execute");
        if (blocking.length && exec && !reviewedOnce && !state.cancelled) {
          reviewedOnce = true;
          const list = blocking
            .map(
              (f, i) =>
                `${i + 1}. ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.issue}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ""}`,
            )
            .join("\n");
          await execute(exec, `A code review found blocking problems. Fix them:\n${list}`, false, 99);
          if (!state.failed && !state.cancelled && phaseDef("verify")) await doVerify();
          if (!state.failed) state.findings = state.findings?.filter((f) => f.severity !== "blocking");
        }
        break;
      }
      case "finish":
        break;
    }
  }
  if (isCancelled()) state.cancelled = true;

  const blockingLeft = state.findings?.some((f) => f.severity === "blocking");
  const status: RunResult["status"] = state.cancelled
    ? "cancelled"
    : state.failed || blockingLeft || (state.verify && !state.verify.ok)
      ? "failed"
      : "success";
  const summary =
    status === "cancelled"
      ? "Cancelled."
      : state.failed
        ? `Failed: ${state.failed}`
        : def.phases.every((p) => p.phase === "plan" || p.phase === "finish")
          ? "Plan created."
          : def.phases.every((p) => p.phase === "review" || p.phase === "finish")
            ? state.reviewSummary || `Review complete: ${state.findings?.length ?? 0} findings.`
            : state.exec?.finalText.trim() || "Done.";

  // finish
  let branch: string | undefined;
  if (status === "success" && (opts.commit || def.commit) && state.edited.size) {
    const c = commitOnBranch(root, slugify(task), `harness: ${task.split("\n")[0].slice(0, 72)}`);
    if (c.ok) branch = c.branch;
    else session.emit({ type: "log", level: "warn", message: `commit failed: ${c.error}` });
  }
  session.emit({ type: "phase.start", phase: "finish" });
  const reportPath = writeReport(root, slug, {
    task,
    workflow: def.name,
    status,
    summary,
    ...state,
    edited: [...state.edited],
    branch,
    usage: session.budget,
  });
  session.emit({ type: "phase.end", phase: "finish", ok: status === "success" });
  return {
    status,
    summary,
    plan: state.plan,
    planPath: state.planPath,
    verify: state.verify,
    findings: state.findings,
    ...(state.criteria ? { criteria: state.criteria } : {}),
    reportPath,
    branch,
    edited: [...state.edited],
  };
}

function writeReport(
  root: string,
  slug: string,
  r: {
    task: string;
    workflow: string;
    status: string;
    summary: string;
    plan?: string;
    planPath?: string;
    verify?: VerifyOutcome;
    findings?: Finding[];
    reviewSummary?: string;
    edited: string[];
    branch?: string;
    usage: { inputTokens: number; outputTokens: number; cost: number; turns: number; startedAt: number };
  },
): string {
  const dir = join(root, ".harness", "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  const lines = [
    `# Harness execution report`,
    ``,
    `- **Task:** ${r.task.split("\n")[0]}`,
    `- **Workflow:** ${r.workflow}`,
    `- **Status:** ${r.status}`,
    `- **Date:** ${new Date().toISOString()}`,
    `- **Duration:** ${((Date.now() - r.usage.startedAt) / 1000).toFixed(1)} s, ${r.usage.turns} model turns`,
    `- **Tokens:** ${r.usage.inputTokens} in / ${r.usage.outputTokens} out${r.usage.cost ? `, cost $${r.usage.cost.toFixed(4)}` : ""}`,
    r.branch ? `- **Branch:** ${r.branch}` : "",
    ``,
    `## Summary`,
    r.summary,
    ``,
    `## Files changed`,
    r.edited.length ? r.edited.map((f) => `- ${f}`).join("\n") : "(none via file tools)",
    ``,
    `## Verification`,
    !r.verify
      ? "Not run."
      : r.verify.skipped
        ? "No commands configured."
        : r.verify.steps.map((s) => `- ${s.kind}: \`${s.command}\` → exit ${s.exitCode}`).join("\n"),
    ``,
    `## Review`,
    r.findings
      ? (r.reviewSummary ? r.reviewSummary + "\n\n" : "") +
        (r.findings.length
          ? r.findings
              .map(
                (f) =>
                  `- **${f.severity}** ${f.file ?? ""}${f.line ? `:${f.line}` : ""} – ${f.issue}${f.suggestion ? ` _(→ ${f.suggestion})_` : ""}`,
              )
              .join("\n")
          : "No findings.")
      : "Not run.",
    ``,
    r.plan ? `## Plan\n${r.planPath ? `(${r.planPath})\n\n` : ""}${r.plan}` : "",
  ];
  writeFileSync(path, lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n");
  return path;
}
