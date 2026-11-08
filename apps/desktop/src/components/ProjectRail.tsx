import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp } from "@web/app-state";
import { useSession } from "@harness/react";
import type { GoalInfo, SessionInfo } from "@harness/client";
import { ago, elapsed, formatUsage, isActive } from "../agents";
import { enterCodeView } from "../file-actions";
import type { FileStatus } from "../ipc";
import { inFolder, projectAgents } from "../sessions";
import { basename, useStudio, type RailSection } from "../store";
import { useFocusProject } from "./ConversationFolder";
import { GOAL_STATUS_LABEL, useGoals } from "./goals";
import { IBranch, IChevron, IDown, IExternal, IFolder, IPlus, IStop, IUp } from "./icons";
import { useProjectSummaries } from "./project-git";
import { BranchMenu, SyncButton } from "./TitleBar";

const MAX_CHANGES = 40;

function Section({
  id,
  title,
  count,
  action,
  children,
}: {
  id: RailSection;
  title: string;
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const st = useStudio();
  const open = !st.railCollapsed[id];
  const ref = useRef<HTMLElement>(null);
  const focus = st.railFocus;
  useEffect(() => {
    if (focus?.id === id) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focus, id]);
  return (
    <section className="st-rail-section" ref={ref} aria-label={title}>
      <div className="st-rail-head">
        <button className="st-rail-title" aria-expanded={open} onClick={() => st.toggleRailSection(id)}>
          <IChevron size={11} open={open} />
          {title}
          {count !== undefined && <span className="st-rail-count">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className="st-rail-body">{children}</div>}
    </section>
  );
}

function changeLetter(f: FileStatus): string {
  if (f.conflicted) return "!";
  const kind = f.worktree !== "unmodified" ? f.worktree : f.index;
  const letters: Record<string, string> = {
    modified: "M",
    added: "A",
    deleted: "D",
    renamed: "R",
    copied: "C",
    untracked: "U",
    typeChanged: "T",
    unmerged: "!",
  };
  return letters[kind] ?? "";
}

/** The chat view's right column: what the selected conversation's project looks like right now. */
export function ProjectRail() {
  const st = useStudio();
  const focus = useFocusProject();
  const { sessions } = useApp();
  const { path, session, conversation, sandbox } = focus;

  if (!path)
    return (
      <div className="st-rail-inner">
        <div className="st-rail-empty">
          <p>
            {conversation?.projectMissing
              ? "This conversation's folder no longer exists."
              : st.sessionId || st.draftFolder === undefined
                ? "Select a conversation or open a folder to see its project here."
                : "This conversation will get its own sandbox folder when you send the first message."}
          </p>
        </div>
      </div>
    );
  return (
    <Rail
      key={path}
      path={path}
      session={session}
      conversation={conversation}
      sandbox={sandbox}
      sessions={sessions}
    />
  );
}

function Rail({
  path,
  session,
  conversation,
  sandbox,
  sessions,
}: {
  path: string;
  session?: SessionInfo;
  conversation?: SessionInfo;
  sandbox: boolean;
  sessions: SessionInfo[];
}) {
  const st = useStudio();
  const { client } = useApp();
  const root = st.workspace?.root;
  const here = !!root && inFolder({ projectPath: path }, root);
  const [now, setNow] = useState(() => Date.now());
  const agents = useMemo(() => projectAgents(sessions, path, conversation), [sessions, path, conversation]);
  const activeAgents = agents.filter((a) => isActive(a.session)).length;
  // A finished turn usually means changed files; the watcher covers the folder open in the editor.
  const version = `${here ? st.fsVersion : 0}:${conversation?.status ?? ""}`;
  const summary = useProjectSummaries([path], version, 10_000)[path];
  const status = summary?.status ?? null;
  const live = useSession(client, session && !session.projectMissing ? session.id : null);
  const previewPath = live.preview?.path;
  const { goals, error: goalsError } = useGoals(summary?.isRepo ? path : undefined);
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    if (!activeAgents) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeAgents]);

  /** Open this project in the code view, then show something in it. */
  const inCode = async (then?: () => void) => {
    if (await enterCodeView(st, path)) then?.();
  };
  const openChange = (f: FileStatus) =>
    void inCode(() =>
      f.conflicted
        ? st.openTab({ kind: "conflict", path: f.path })
        : st.openTab({ kind: "diff", path: f.path, staged: f.worktree === "unmodified" }),
    );
  const openGoal = (id: string) => void inCode(() => st.openTab({ kind: "goal", id }));

  const files = status?.files ?? [];
  const openGoals = goals.filter((g) => !["done", "discarded"].includes(g.status));
  const closedGoals = goals.filter((g) => ["done", "discarded"].includes(g.status));
  const goalRow = (g: GoalInfo) => (
    <button key={g.id} className="st-rail-row" onClick={() => openGoal(g.id)} title={g.title}>
      <span className="st-ellipsis st-grow">{g.title}</span>
      <span className={`st-goal-status ${g.status}`}>{GOAL_STATUS_LABEL[g.status] ?? g.status}</span>
    </button>
  );

  return (
    <div className="st-rail-inner">
      <Section id="project" title="Project">
        <div className="st-rail-project">
          <IFolder size={15} />
          <span className="st-ellipsis st-rail-name" title={path}>
            {basename(path)}
          </span>
          {sandbox && <span className="st-sw-badge">sandbox</span>}
        </div>
        <div className="st-rail-path st-ellipsis" title={path}>
          {path}
        </div>
        <div className="st-rail-actions">
          <button className="tiny" onClick={() => void inCode()}>
            Open in Code view
          </button>
          <button className="ghost tiny" onClick={() => st.setFilePane(true)}>
            Browse files
          </button>
          <button
            className="ghost icon tiny"
            title="Show in file manager"
            aria-label="Show in file manager"
            onClick={() => void st.attempt(() => revealItemInDir(path))}
          >
            <IExternal size={14} />
          </button>
        </div>
      </Section>

      <Section id="repo" title="Repository">
        {!summary && <p className="st-rail-note">Reading the repository…</p>}
        {summary && !summary.isRepo && <p className="st-rail-note">This folder is not a Git repository.</p>}
        {summary?.isRepo && status && (
          <>
            {here ? (
              <div className="st-rail-branch">
                <BranchMenu align="right" />
                <SyncButton />
              </div>
            ) : (
              <div
                className="st-rail-branch-static"
                title="Open this project in the Code view to switch branches"
              >
                <IBranch size={14} />
                <span className="st-ellipsis">
                  {status.detached ? `detached ${status.head ?? ""}` : (status.branch ?? "no branch")}
                </span>
                {status.behind > 0 && (
                  <span className="st-rail-sync">
                    <IDown size={11} />
                    {status.behind}
                  </span>
                )}
                {status.ahead > 0 && (
                  <span className="st-rail-sync">
                    <IUp size={11} />
                    {status.ahead}
                  </span>
                )}
              </div>
            )}
            <div className="st-rail-commit">
              <span className="st-rail-stats">
                {files.length === 0 ? (
                  "No changes"
                ) : (
                  <>
                    <span className="st-add">+{summary.added}</span>{" "}
                    <span className="st-del">−{summary.deleted}</span>
                  </>
                )}
              </span>
              {files.length > 0 && (
                <button className="tiny" onClick={() => void inCode(() => st.setSide("git"))}>
                  Commit…
                </button>
              )}
            </div>
          </>
        )}
      </Section>

      <Section id="agents" title="Agents" count={activeAgents > 0 ? `${activeAgents} running` : undefined}>
        {agents.length === 0 && <p className="st-rail-note">No agent is running in this project.</p>}
        {agents.map(({ session: s, depth }) => {
          const active = isActive(s);
          const usage = formatUsage(s.usage);
          return (
            <div
              key={s.id}
              className={`st-rail-agent ${st.sessionId === s.id ? "on" : ""}`}
              style={{ paddingLeft: 4 + depth * 14 }}
            >
              <button className="st-rail-agent-main" onClick={() => st.setSessionId(s.id)} title={s.title}>
                <span className={`st-status-dot ${s.status}`} title={s.status} />
                <span className="st-rail-agent-text">
                  <span className="st-ellipsis">{s.title ?? (depth ? "Subagent" : "Conversation")}</span>
                  {active && (s.model || usage) && (
                    <span className="st-rail-agent-meta st-ellipsis">
                      {[s.model?.split("/").pop(), usage].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
                <span className="st-conv-when">
                  {active && s.runStartedAt
                    ? elapsed(s.runStartedAt, now)
                    : ago(s.updatedAt ?? s.createdAt, now)}
                </span>
              </button>
              {active && !s.externalRun && (
                <button
                  className="ghost icon tiny"
                  title="Stop this agent"
                  aria-label="Stop agent"
                  onClick={() => client && void st.attempt(() => client.cancel(s.id))}
                >
                  <IStop size={12} />
                </button>
              )}
            </div>
          );
        })}
      </Section>

      {summary?.isRepo && (
        <Section id="changes" title="Changes" count={files.length || undefined}>
          {files.length === 0 && <p className="st-rail-note">The working tree is clean.</p>}
          {files.slice(0, MAX_CHANGES).map((f) => (
            <button key={f.path} className="st-rail-row" title={f.path} onClick={() => openChange(f)}>
              <span className="st-rail-file st-ellipsis">{f.path}</span>
              <span className="st-rail-letter">{changeLetter(f)}</span>
            </button>
          ))}
          {files.length > MAX_CHANGES && (
            <button className="st-hint-btn" onClick={() => void inCode(() => st.setSide("git"))}>
              {files.length - MAX_CHANGES} more in Source control
            </button>
          )}
        </Section>
      )}

      <Section
        id="goals"
        title="Goals"
        count={openGoals.length || undefined}
        action={
          summary?.isRepo ? (
            <button
              className="ghost icon tiny"
              title="New goal"
              aria-label="New goal"
              onClick={() => openGoal("new")}
            >
              <IPlus size={13} />
            </button>
          ) : undefined
        }
      >
        {goalsError && <p className="st-rail-note st-error">{goalsError}</p>}
        {summary && !summary.isRepo && (
          <p className="st-rail-note">Goals run in Git worktrees, so they need a repository.</p>
        )}
        {summary?.isRepo && !openGoals.length && (
          <p className="st-rail-note">
            A goal is a task with acceptance criteria and a budget. It runs unattended on its own branch and
            waits for your review.
          </p>
        )}
        {openGoals.map(goalRow)}
        {closedGoals.length > 0 && (
          <button className="st-hint-btn" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "Hide" : "Show"} {closedGoals.length} closed
          </button>
        )}
        {showClosed && closedGoals.map(goalRow)}
      </Section>

      {session && previewPath && (
        <Section id="preview" title="Preview">
          <button className="st-rail-row" title={previewPath} onClick={() => st.openChatPreview(session.id)}>
            <span className="st-rail-file st-ellipsis">{previewPath}</span>
            <span className="st-rail-letter">Open</span>
          </button>
        </Section>
      )}
    </div>
  );
}
