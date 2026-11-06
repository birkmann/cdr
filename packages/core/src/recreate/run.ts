// `cdr recreate` and POST /recreate run the pipeline inside a session, so every stage is an event in its log (the
// CLI renders them, the web app reduces them) and model calls count towards the session's usage.
import type { RecreateRequest } from "@harness/protocol";
import { runRecreate, type RecreateResult } from "@harness/recreate";
import type { Session } from "../session.js";
import type { ToolContext } from "../tools/types.js";
import { recreateHost } from "./host.js";

export interface SessionRecreateOptions {
  /** answer the consent gate automatically (`--yes`), logged as permission.resolved { auto: true } */
  yes?: boolean;
  /** check each section while building (default true) */
  sectionChecks?: boolean;
  /** run `npm install && npm run build` in converted outputs */
  runBuilds?: (dir: string) => Promise<{ ok: boolean; output: string }>;
  /** stop after this stage (`cdr recreate capture`) */
  stopAfter?: import("@harness/protocol").RecreateStage;
}

export async function recreateInSession(
  session: Session,
  request: RecreateRequest,
  o: SessionRecreateOptions = {},
): Promise<RecreateResult> {
  // the run holds the session like an agent run does: project lock, status, and Stop (session.cancel()) aborts it
  return session.runExclusive(() => recreateRun(session, request, o));
}

async function recreateRun(
  session: Session,
  request: RecreateRequest,
  o: SessionRecreateOptions,
): Promise<RecreateResult> {
  const modelOk = !session.modelProblem(["executor"]);
  const ctx: ToolContext = {
    projectRoot: session.projectRoot,
    config: session.config,
    signal: session.signal,
    emit: (e) => session.emit(e),
    ask: (q, opts) => session.ask(q, opts),
    todos: [],
    secretEnv: session.secretEnv,
    requestPermission: (t, a, r, reason) => session.requestPermission(t, a, r, reason),
    permissionMode: () => session.info().permissionMode ?? "ask",
    autoApprovesPermissions: () => !!session.autoApprove.permissions,
    // naming, vision and repair only with a configured, reachable model; the deterministic stages need none
    ...(modelOk ? { complete: (role, messages, opts) => session.complete(role, messages, opts) } : {}),
  };
  const host = {
    ...recreateHost(ctx, { consentArgs: request, yes: o.yes, sectionChecks: o.sectionChecks }),
    ...(o.runBuilds ? { runBuilds: o.runBuilds } : {}),
  };
  // repair is opt-in: without `repair: true` no model call patches the output
  if (request.repair !== true) delete (host as { repair?: unknown }).repair;
  const r = await runRecreate(request, host, { stopAfter: o.stopAfter });
  // gates that miss are a result, not a broken job: the page was built and measured, every stage finished. The run
  // keeps its status (CLI exit code, evals); the session's job is done, nothing to continue
  const measuredBelowGates =
    r.status === "failed" &&
    r.outputs.length > 0 &&
    !Object.values(r.manifest.stages).some((st) => st?.status === "failed");
  const status = measuredBelowGates ? "success" : r.status;
  session.emit({ type: "done", status, summary: r.summary });
  session.emit({
    type: "status",
    status: status === "success" ? "done" : status === "cancelled" ? "cancelled" : "failed",
  });
  return r;
}
