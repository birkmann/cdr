import { useEffect, useState } from "react";
import { useApp } from "@web/app-state";
import { useSession } from "@harness/react";
import { ModelPicker } from "@web/components/Pickers";
import { Markdown } from "@web/components/Markdown";
import type { CreateGoalRequest, GoalInfo } from "@harness/client";
import { git, type Branch } from "../ipc";
import { useStudio } from "../store";
import { GOAL_STATUS_LABEL } from "./goals";
import { CreatePrDialog } from "./GitPanel";
import { ICheck, IX, IPlay, IPause, IPlus } from "./icons";
import { confirmDialog } from "./dialogs";

type Draft = {
  title: string;
  description: string;
  acceptance: string[];
  baseBranch: string;
  maxCost: string;
  maxTokens: string;
  timeoutMin: string;
  maxRounds: string;
  permissionMode: "ask" | "auto" | "yolo";
  deliverable: GoalInfo["deliverable"];
  executor: string;
  reviewer: string;
  scheduleKind: "none" | "at" | "cron";
  at: string;
  cron: string;
};

function toDraft(g?: GoalInfo, branch?: string): Draft {
  const s = g?.schedule;
  return {
    title: g?.title ?? "",
    description: g?.description ?? "",
    acceptance: g?.acceptance.length ? [...g.acceptance] : [""],
    baseBranch: g?.baseBranch ?? branch ?? "main",
    maxCost: g?.budget.maxCost ? String(g.budget.maxCost) : "2",
    maxTokens: g?.budget.maxTokens ? String(g.budget.maxTokens) : "",
    timeoutMin: g?.budget.timeoutMs ? String(Math.round(g.budget.timeoutMs / 60000)) : "60",
    maxRounds: g?.budget.maxRounds ? String(g.budget.maxRounds) : "4",
    permissionMode: g?.policy.permissionMode ?? "auto",
    deliverable: g?.deliverable ?? "pull-request",
    executor: g?.models?.executor ?? "",
    reviewer: g?.models?.reviewer ?? "",
    scheduleKind: !s ? "none" : "cron" in s ? "cron" : "at",
    at: s && "at" in s ? toLocalInput(s.at) : "",
    cron: s && "cron" in s ? s.cron : "0 2 * * 1-5",
  };
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDraft(d: Draft): Omit<CreateGoalRequest, "repo"> {
  const num = (v: string) => (v.trim() && Number(v) > 0 ? Number(v) : undefined);
  const models: Record<string, string> = {};
  if (d.executor) models.executor = models.planner = d.executor;
  if (d.reviewer) models.reviewer = d.reviewer;
  return {
    title: d.title.trim(),
    description: d.description.trim(),
    acceptance: d.acceptance.map((a) => a.trim()).filter(Boolean),
    baseBranch: d.baseBranch.trim(),
    budget: {
      maxCost: num(d.maxCost),
      maxTokens: num(d.maxTokens),
      timeoutMs: num(d.timeoutMin) ? num(d.timeoutMin)! * 60000 : undefined,
      maxRounds: num(d.maxRounds),
    },
    policy: { permissionMode: d.permissionMode },
    deliverable: d.deliverable,
    models: Object.keys(models).length ? models : undefined,
    schedule:
      d.scheduleKind === "none"
        ? null
        : d.scheduleKind === "at"
          ? { at: new Date(d.at).toISOString() }
          : { cron: d.cron.trim() },
  };
}

export function GoalPage({ id }: { id: string }) {
  const st = useStudio();
  const { client } = useApp();
  const [goal, setGoal] = useState<GoalInfo | null>(null);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(id === "new");
  const load = () => {
    if (!client || id === "new") return;
    void client
      .getGoal(id)
      .then((g) => {
        setGoal(g);
        setError(undefined);
      })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => {
    load();
    if (id === "new") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id]);

  if (error) return <div className="st-empty st-error">{error}</div>;
  if (id !== "new" && !goal) return <div className="st-empty">Loading goal…</div>;
  const isDraft = !goal || goal.status === "draft" || goal.status === "scheduled";
  return (
    <div className="st-goal-page">
      <div className="st-goal-inner">
        {editing || (isDraft && !goal) ? (
          <GoalEditor
            goal={goal ?? undefined}
            onCancel={goal ? () => setEditing(false) : () => st.closeTab("goal:new")}
            onSaved={(g, opened) => {
              window.dispatchEvent(new Event("studio:goals-changed"));
              if (id === "new") {
                st.closeTab("goal:new");
                st.openTab({ kind: "goal", id: g.id });
              } else {
                setGoal(g);
                setEditing(false);
              }
              if (opened) st.toast(`Goal "${g.title}" started`, "success");
            }}
          />
        ) : (
          <GoalReview goal={goal!} onEdit={() => setEditing(true)} reload={load} />
        )}
      </div>
    </div>
  );
}

function GoalEditor({
  goal,
  onSaved,
  onCancel,
}: {
  goal?: GoalInfo;
  onSaved(g: GoalInfo, started: boolean): void;
  onCancel(): void;
}) {
  const st = useStudio();
  const { client } = useApp();
  const root = st.workspace!.root;
  const [d, setD] = useState<Draft>(() => toDraft(goal, st.status?.branch));
  const [branches, setBranches] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(
    () =>
      void git
        .branches(root)
        .then((b) => setBranches(b.filter((x) => !x.isRemote)))
        .catch(() => {}),
    [root],
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const valid = d.title.trim() && d.acceptance.some((a) => a.trim()) && d.baseBranch.trim();
  const save = async (run: boolean) => {
    if (!client || !valid) return;
    if (d.scheduleKind !== "none" && d.permissionMode === "yolo")
      return st.toast("Scheduled goals cannot use full access. Choose Auto or Ask.", "error");
    if (d.scheduleKind === "at" && !d.at) return st.toast("Pick a start time.", "error");
    setBusy(true);
    try {
      const body = fromDraft(d);
      let g = goal
        ? await client.updateGoal(goal.id, body)
        : await client.createGoal({ ...body, repo: root });
      if (run) g = await client.runGoal(g.id);
      onSaved(g, run);
    } catch (e) {
      st.toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h1>{goal ? "Edit goal" : "New goal"}</h1>
      <p className="muted">
        The agent works on its own branch in a separate worktree, commits a checkpoint after each verified
        step, and keeps going until every criterion is met or the budget runs out. Nothing is merged or pushed
        without you.
      </p>
      <label className="st-field">
        Title
        <input
          className="st-input"
          autoFocus
          value={d.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Add CSV export to reports"
        />
      </label>
      <label className="st-field">
        Description
        <textarea
          className="st-input"
          rows={5}
          value={d.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="Context, constraints, files to look at, things to avoid…"
        />
      </label>
      <div className="st-field">
        Acceptance criteria
        <div className="st-list-input">
          {d.acceptance.map((a, i) => (
            <div key={i} className="st-row">
              <input
                className="st-input"
                value={a}
                placeholder={i === 0 ? "pnpm test passes" : "Another verifiable outcome"}
                onChange={(e) =>
                  set(
                    "acceptance",
                    d.acceptance.map((x, j) => (j === i ? e.target.value : x)),
                  )
                }
                onKeyDown={(e) => e.key === "Enter" && set("acceptance", [...d.acceptance, ""])}
              />
              <button
                className="ghost icon tiny"
                aria-label="Remove criterion"
                disabled={d.acceptance.length === 1}
                onClick={() =>
                  set(
                    "acceptance",
                    d.acceptance.filter((_, j) => j !== i),
                  )
                }
              >
                <IX size={13} />
              </button>
            </div>
          ))}
          <button
            className="ghost tiny"
            style={{ alignSelf: "flex-start" }}
            onClick={() => set("acceptance", [...d.acceptance, ""])}
          >
            <IPlus size={12} /> Add criterion
          </button>
        </div>
      </div>
      <div className="st-goal-grid">
        <label className="st-field">
          Base branch
          <select
            className="st-input"
            value={d.baseBranch}
            onChange={(e) => set("baseBranch", e.target.value)}
          >
            {!branches.some((b) => b.name === d.baseBranch) && (
              <option value={d.baseBranch}>{d.baseBranch}</option>
            )}
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="st-field">
          Deliverable
          <select
            className="st-input"
            value={d.deliverable}
            onChange={(e) => set("deliverable", e.target.value as Draft["deliverable"])}
          >
            <option value="pull-request">Pull request (after your review)</option>
            <option value="branch">Branch</option>
            <option value="patch">Patch</option>
          </select>
        </label>
        <label className="st-field">
          Cost limit (USD, uses configured prices)
          <input
            className="st-input"
            inputMode="decimal"
            value={d.maxCost}
            onChange={(e) => set("maxCost", e.target.value)}
          />
        </label>
        <label className="st-field">
          Token limit (input + output, optional)
          <input
            className="st-input"
            inputMode="numeric"
            value={d.maxTokens}
            onChange={(e) => set("maxTokens", e.target.value)}
          />
        </label>
        <label className="st-field">
          Active time limit (minutes)
          <input
            className="st-input"
            inputMode="numeric"
            value={d.timeoutMin}
            onChange={(e) => set("timeoutMin", e.target.value)}
          />
        </label>
        <label className="st-field">
          Rounds per run
          <input
            className="st-input"
            inputMode="numeric"
            value={d.maxRounds}
            onChange={(e) => set("maxRounds", e.target.value)}
          />
        </label>
        <label className="st-field">
          Permissions
          <select
            className="st-input"
            value={d.permissionMode}
            onChange={(e) => set("permissionMode", e.target.value as Draft["permissionMode"])}
          >
            <option value="auto">Auto: edits allowed, risky commands ask</option>
            <option value="ask">Ask: pause for every action</option>
            <option value="yolo">Full access (not for scheduled goals)</option>
          </select>
        </label>
        <div className="st-field">
          Schedule
          <div className="st-row">
            <select
              className="st-input"
              value={d.scheduleKind}
              onChange={(e) => set("scheduleKind", e.target.value as Draft["scheduleKind"])}
            >
              <option value="none">Run manually</option>
              <option value="at">Once at…</option>
              <option value="cron">Repeat (cron)</option>
            </select>
            {d.scheduleKind === "at" && (
              <input
                className="st-input"
                type="datetime-local"
                value={d.at}
                onChange={(e) => set("at", e.target.value)}
              />
            )}
            {d.scheduleKind === "cron" && (
              <input
                className="st-input"
                value={d.cron}
                onChange={(e) => set("cron", e.target.value)}
                placeholder="0 2 * * 1-5"
                title="minute hour day month weekday"
              />
            )}
          </div>
          {d.scheduleKind !== "none" && (
            <span className="muted small">Scheduled goals start while CDR Studio is open.</span>
          )}
        </div>
        <div className="st-field">
          Executor model
          <ModelPicker value={d.executor} projectPath={root} onChange={(m) => set("executor", m)} />
        </div>
        <div className="st-field">
          Reviewer model
          <ModelPicker value={d.reviewer} projectPath={root} onChange={(m) => set("reviewer", m)} />
        </div>
      </div>
      <div className="st-row end" style={{ marginTop: 16 }}>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="ghost" disabled={!valid || busy} onClick={() => void save(false)}>
          {d.scheduleKind === "none" ? "Save draft" : "Save schedule"}
        </button>
        <button disabled={!valid || busy} onClick={() => void save(true)}>
          <IPlay size={13} /> Save and run now
        </button>
      </div>
    </>
  );
}

function GoalReview({ goal, onEdit, reload }: { goal: GoalInfo; onEdit(): void; reload(): void }) {
  const st = useStudio();
  const { client } = useApp();
  const session = useSession(client, goal.sessionId ?? null);
  const view = session.goal;
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [pr, setPr] = useState(false);
  const root = st.workspace!.root;
  const criteria = view?.criteria?.length ? view.criteria : (goal.criteria ?? []);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    await st.attempt(fn, ok);
    setBusy(false);
    reload();
    window.dispatchEvent(new Event("studio:goals-changed"));
    void st.refreshGit();
  };
  const running = goal.status === "running";
  const usage = goal.usage ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
  return (
    <>
      <div className="st-row">
        <h1 className="st-grow">{goal.title}</h1>
        <span className={`st-goal-status ${goal.status}`}>
          {GOAL_STATUS_LABEL[goal.status] ?? goal.status}
        </span>
      </div>
      <p className="muted small">
        {goal.branch ? (
          <>
            Branch <code>{goal.branch}</code> from <code>{goal.baseBranch}</code>
          </>
        ) : (
          <>
            Base <code>{goal.baseBranch}</code>
          </>
        )}
        {" · "}
        {usage.inputTokens + usage.outputTokens > 0 &&
          `${Math.round((usage.inputTokens + usage.outputTokens) / 1000)}k tokens · `}
        {usage.cost
          ? `$${usage.cost.toFixed(2)} of ${goal.budget.maxCost ? `$${goal.budget.maxCost}` : "unlimited"}`
          : "no cost recorded"}
        {goal.round ? ` · round ${goal.round}` : ""}
      </p>
      <div className="st-row" style={{ flexWrap: "wrap" }}>
        {running ? (
          <button
            className="ghost"
            disabled={busy}
            onClick={() => client && void act(() => client.pauseGoal(goal.id), "Goal paused")}
          >
            <IPause size={13} /> Pause
          </button>
        ) : (
          ["draft", "scheduled", "needs-attention", "failed"].includes(goal.status) && (
            <button
              disabled={busy}
              onClick={() => client && void act(() => client.runGoal(goal.id), "Goal started")}
            >
              <IPlay size={13} />{" "}
              {goal.status === "draft" || goal.status === "scheduled" ? "Run now" : "Resume"}
            </button>
          )
        )}
        {goal.status === "review" && (
          <>
            <button
              disabled={busy}
              onClick={async () =>
                client &&
                (await confirmDialog(`Merge ${goal.branch} into ${goal.baseBranch} in your checkout?`, {
                  ok: "Merge",
                })) &&
                void act(() => client.mergeGoal(goal.id), "Merged")
              }
            >
              <ICheck size={13} /> Merge into {goal.baseBranch}
            </button>
            {goal.branch && (
              <button className="ghost" onClick={() => setPr(true)}>
                Open pull request
              </button>
            )}
          </>
        )}
        {goal.sessionId && (
          <button
            className="ghost"
            onClick={() => (st.setSessionId(goal.sessionId!), st.setAgentPanel(true))}
          >
            Open agent log
          </button>
        )}
        {goal.worktree && (
          <button className="ghost" onClick={() => void st.attempt(() => st.openWorkspace(goal.worktree!))}>
            Open worktree
          </button>
        )}
        {["draft", "scheduled", "needs-attention", "failed", "review"].includes(goal.status) && (
          <button className="ghost" onClick={onEdit}>
            Edit
          </button>
        )}
        {!["done", "discarded"].includes(goal.status) && (
          <button
            className="ghost danger"
            disabled={busy || running}
            onClick={async () =>
              client &&
              (await confirmDialog("Discard this goal? Its worktree and branch are deleted.", {
                danger: true,
                ok: "Discard",
              })) &&
              void act(() => client.discardGoal(goal.id), "Goal discarded")
            }
          >
            Discard
          </button>
        )}
        {["done", "discarded"].includes(goal.status) && (
          <button
            className="ghost danger"
            onClick={async () =>
              client &&
              (await confirmDialog("Delete this goal record?", { danger: true, ok: "Delete" })) &&
              void act(async () => {
                await client.deleteGoal(goal.id);
                st.closeTab(`goal:${goal.id}`);
              })
            }
          >
            Delete
          </button>
        )}
      </div>
      {view?.paused && (
        <div className="st-banner warn" style={{ margin: "12px 0" }}>
          <strong>Paused: {view.paused.reason}</strong>
          {view.paused.detail && <span>{view.paused.detail}</span>}
        </div>
      )}
      <div className="st-card">
        <h3>Acceptance criteria</h3>
        <ul className="st-criteria">
          {goal.acceptance.map((c) => {
            const r = criteria.find((x) => x.criterion === c);
            return (
              <li key={c}>
                {r?.met ? <ICheck size={15} className="met" /> : <span className="unmet">○</span>}
                <div>
                  <div>{c}</div>
                  {r?.evidence && <div className="muted small">{r.evidence}</div>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {goal.description && (
        <div className="st-card">
          <h3>Description</h3>
          <Markdown text={goal.description} />
        </div>
      )}
      <div className="st-card">
        <h3>Timeline</h3>
        {!view && !goal.sessionId && <p className="muted small">The goal has not run yet.</p>}
        {goal.sessionId && session.loading && <p className="muted small">Loading progress…</p>}
        <div className="st-timeline">
          {view && (
            <div className="st-timeline-item">
              <strong>Started round {view.round}</strong>
              <div className="muted small">
                Worktree <code>{view.worktree}</code>
              </div>
            </div>
          )}
          {view?.checkpoints.map((c) => (
            <div key={c.seq} className="st-timeline-item">
              <button className="st-link" onClick={() => st.openTab({ kind: "commit", id: c.commit })}>
                Checkpoint <code>{c.commit.slice(0, 7)}</code>: {c.step}
              </button>
              <div className="small">{c.summary}</div>
              {c.criteria.length > 0 && (
                <div className="muted small">
                  {c.criteria.filter((x) => x.met).length}/{c.criteria.length} criteria met
                </div>
              )}
            </div>
          ))}
          {running && session.phase && (
            <div className="st-timeline-item">
              <span className="st-spin small" /> Working: {session.phase}
              {session.todos.length > 0 && (
                <ul className="small">
                  {session.todos.map((t) => (
                    <li key={t.id} className={t.status === "done" ? "muted" : ""}>
                      {t.status === "done" ? "✓ " : t.status === "in_progress" ? "› " : ""}
                      {t.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {view?.status === "finished" && (
            <div className="st-timeline-item finished">
              <strong>Finished: {view.result}</strong>
              {view.summary && <Markdown text={view.summary} />}
            </div>
          )}
          {view?.paused && (
            <div className="st-timeline-item paused">
              <strong>Paused ({view.paused.reason})</strong>
            </div>
          )}
        </div>
        {!view && goal.lastSummary && <Markdown text={goal.lastSummary} />}
      </div>
      {["review", "needs-attention", "failed"].includes(goal.status) && (
        <div className="st-card">
          <h3>Request changes</h3>
          <textarea
            className="st-input"
            rows={4}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change? The agent runs another round on the same branch."
          />
          <div className="st-row end" style={{ marginTop: 8 }}>
            <button
              disabled={!feedback.trim() || busy}
              onClick={() =>
                client &&
                void act(async () => {
                  await client.requestGoalChanges(goal.id, feedback.trim());
                  setFeedback("");
                }, "Another round started")
              }
            >
              Send feedback and run
            </button>
          </div>
        </div>
      )}
      {pr && goal.branch && (
        <CreatePrDialog
          root={root}
          head={goal.branch}
          base={goal.baseBranch}
          pushBranch={goal.branch}
          title={goal.title}
          body={[
            goal.description,
            "",
            "## Acceptance criteria",
            ...goal.acceptance.map(
              (c) => `- [${criteria.find((x) => x.criterion === c)?.met ? "x" : " "}] ${c}`,
            ),
            "",
            view?.summary ?? goal.lastSummary ?? "",
            "",
            "Produced by a CDR Studio goal.",
          ].join("\n")}
          onClose={() => setPr(false)}
        />
      )}
    </>
  );
}
