import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import { ColumnResize, useColumnWidth } from "./ColumnResize";
import { readThreadView, saveThreadView } from "../thread-view";
import {
  compactionLine,
  type CheckpointChange,
  type HarnessEvent,
  type TimelineItem,
  type ToolCallView,
} from "@harness/client";
import { useSession, type UseSessionResult } from "@harness/react";
import { basename, useApp } from "../app-state";
import { CDRMark } from "./Brand";
import { Composer, useSkills, type PendingFile } from "./Composer";
import { CodeBlock, FileLinksContext, Markdown, langForPath } from "./Markdown";
import { Decisions, Thinking } from "./Thinking";
import { EffortPicker, ModelPicker, ModePicker, PermissionPicker, type Mode } from "./Pickers";
import { CodePanel, type OpenDocument, type PreviewHost, type Tab } from "./CodePanel";
import { DiffBlock } from "./Diff";
import { RecreateCard } from "./RecreateCard";
import { RunReport } from "./RunReport";
import { frameworkIconUrl, frameworkName } from "./framework-icons";
import { buildTurnReport, turnItems, turnLaunches, type LaunchView } from "@harness/client";
import { useSessionLinks, useStartRecreate } from "../recreate";
import {
  IconAlert,
  IconChart,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconExternal,
  IconFile,
  IconFolder,
  IconGit,
  IconPanel,
  IconPlay,
  IconRefresh,
  IconSparkle,
  IconTerminal,
  IconTrash,
  IconX,
} from "./icons";

/** Lets a host app open a conversation's project folder. */
export interface FolderHost {
  open(path: string): void;
  reveal?(path: string): void;
}

/** Per-message edits (delete, branch) offered by the conversation around a message. */
interface MessageEdits {
  /** False while the conversation runs: the log cannot change under a run. */
  enabled: boolean;
  remove(messageId: string): Promise<void>;
  branch(messageId: string): Promise<void>;
}
const MessageEditsContext = createContext<MessageEdits | undefined>(undefined);

const ALL_ROLES = (ref: string) =>
  ref ? { executor: ref, planner: ref, reviewer: ref, summarizer: ref } : undefined;

export function ChatView({
  id,
  initialPreview = false,
  initialHistory = false,
  previewHost,
  folderHost,
  launchHost,
  onOpenSession,
  headActions,
  onHeadDragStart,
}: {
  id: string;
  initialPreview?: boolean;
  initialHistory?: boolean;
  /** Opens the preview outside this view (the desktop app's editor area) instead of the side panel. */
  previewHost?: PreviewHost;
  /** Lets the host app open the conversation's folder (the desktop app's explorer, the OS file manager). */
  folderHost?: FolderHost;
  /** Starts a native program the agent built (the desktop app runs it in a terminal); without it, the launch card copies the command. */
  launchHost?: LaunchHost;
  /** Shows another conversation (a new branch or duplicate); defaults to navigating the web app to it. */
  onOpenSession?(id: string): void;
  /** Extra buttons at the end of the conversation header (the desktop app's history, split and new). */
  headActions?: ReactNode;
  /** Makes the header draggable (the desktop app docks its agent panel by dragging it). */
  onHeadDragStart?(e: DragEvent): void;
}) {
  const { client, sessions, refreshSessions, settings, navigate } = useApp();
  const openSession = (sid: string) =>
    onOpenSession ? onOpenSession(sid) : navigate({ name: "chat", id: sid });
  const viewKey = `${settings.server || location.origin}:${id}`;
  const [savedView] = useState(() => readThreadView(viewKey));
  const state = useSession(client, id);
  const info = sessions.find((x) => x.id === id);
  const s = { ...state, externalRun: info?.externalRun ?? state.externalRun };
  // The conversation list (status bar, sidebars) polls; refresh it as soon as this run starts or ends.
  useEffect(() => {
    if (info && info.status !== state.status) void refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);
  const [mode, setMode] = useState<Mode>("chat");
  const [continuing, setContinuing] = useState(false);
  const [panel, setPanel] = useState(() => initialPreview || initialHistory || (savedView.panel ?? false));
  const [tab, setTab] = useState<Tab>(
    initialPreview && !previewHost
      ? "preview"
      : initialHistory
        ? "history"
        : (savedView.tab === "document" && !savedView.doc) || (savedView.tab === "preview" && previewHost)
          ? "changes"
          : (savedView.tab ?? "changes"),
  );
  const [doc, setDoc] = useState<OpenDocument | undefined>(savedView.doc);
  useEffect(() => {
    saveThreadView(viewKey, { panel, tab, doc });
  }, [viewKey, panel, tab, doc]);
  const openDocument = (d: OpenDocument) => {
    setDoc(d);
    setPanel(true);
    setTab("document");
  };
  const closeDocument = () => {
    setDoc(undefined);
    setTab((t) => (t === "document" ? "files" : t));
  };
  const columns = useColumnWidth("cdr.chat-width", {
    initial: (available) => available * 0.56,
    min: 360,
    max: (available) => available - 320,
  });
  // Stacked layouts (narrow windows, the desktop agent column) put the details panel under the chat.
  const rows = useColumnWidth("cdr.chat-height", {
    initial: (available) => available * 0.52,
    min: 200,
    max: (available) => available - 120,
    axis: "y",
  });
  const setColumnsNode = columns.ref;
  const setRowsNode = rows.ref;
  const layoutRef = useCallback(
    (node: HTMLDivElement | null) => {
      setColumnsNode(node);
      setRowsNode(node);
    },
    [setColumnsNode, setRowsNode],
  );
  // Jump to the preview whenever the agent publishes one.
  const seenPreview = useRef<number | undefined>(undefined);
  // Events after the loaded history are happening now, however quickly the run ends after them.
  const historyEnd = useRef<number | undefined>(undefined);
  if (historyEnd.current === undefined && s.connected) historyEnd.current = s.lastSeq;
  useEffect(() => {
    if (!s.preview) return;
    const live = historyEnd.current !== undefined && s.preview.seq > historyEnd.current;
    if (
      live ||
      (seenPreview.current !== undefined && seenPreview.current !== s.preview.seq) ||
      (seenPreview.current === undefined && !savedView.tab)
    )
      openPreview(true, live);
    seenPreview.current = s.preview.seq;
  }, [s.preview?.seq]);
  const openPreview = (automatic = false, live = false) => {
    if (previewHost) return previewHost.open(automatic, live);
    setPanel(true);
    setTab("preview");
  };
  const [compareRun, setCompareRun] = useState<string>();
  const openCompare = (runId: string) => {
    setCompareRun(runId);
    setPanel(true);
    setTab("compare");
  };
  const { recreateEnabled } = useSessionLinks(id);
  const startRecreate = useStartRecreate();
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const busy = s.status === "running" || s.status === "waiting";
  const projectPath = s.projectPath ?? info?.projectPath ?? "";
  const folderLabel = (
    <>
      {(s.sandbox ?? info?.sandbox) ? <span className="badge">sandbox</span> : <IconFolder size={12} />}{" "}
      {basename(projectPath)}
    </>
  );
  const model = s.models?.executor ?? info?.model ?? "";
  const permissionMode = s.permissionMode ?? info?.permissionMode ?? "ask";

  const skills = useSkills(projectPath);

  const send = async (text: string, files: PendingFile[], skillNames: string[]) => {
    if (!client) return false;
    await client.send(id, text, {
      ...(skillNames.length ? { skills: skillNames } : {}),
      mode: mode === "chat" ? "chat" : "task",
      workflow: mode === "chat" ? undefined : mode,
      attachments: files.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
    });
    void refreshSessions();
  };

  const forkedFrom = s.forkedFrom ?? info?.forkedFrom;
  const origin = forkedFrom ? sessions.find((x) => x.id === forkedFrom.sessionId) : undefined;
  const [editing, setEditing] = useState(false);
  /** Run one conversation edit at a time and report its failure in the notice. */
  const edit = async (fn: () => Promise<void>) => {
    if (!client || editing) return;
    setEditing(true);
    try {
      await fn();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setEditing(false);
    }
  };
  const duplicate = () =>
    edit(async () => {
      const copy = await client!.forkSession(id);
      await refreshSessions();
      openSession(copy.id);
    });
  const mergeBack = () =>
    edit(async () => {
      const r = await client!.mergeBranch(id);
      await refreshSessions();
      openSession(r.targetId);
    });
  const messageEdits: MessageEdits = {
    enabled: !busy && !s.externalRun && !editing,
    remove: (messageId) =>
      edit(async () => {
        await client!.deleteMessage(id, messageId);
        void refreshSessions();
      }),
    branch: (messageId) =>
      edit(async () => {
        const copy = await client!.forkSession(id, { messageId });
        await refreshSessions();
        openSession(copy.id);
      }),
  };

  const change = async (patch: Parameters<NonNullable<typeof client>["updateSettings"]>[1]) => {
    try {
      await client?.updateSettings(id, patch);
      void refreshSessions();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  if (s.loading || (s.error && !s.lastSeq))
    return (
      <div className="workspace-loading" role="status">
        {s.error ? `Could not load conversation: ${s.error}` : "Loading conversation…"}
      </div>
    );

  return (
    <div
      ref={layoutRef}
      style={{ "--chat-width": `${columns.width}px`, "--chat-height": `${rows.width}px` } as CSSProperties}
      className={`chat-layout ${panel ? "with-panel" : ""}`}
    >
      <section className="chat">
        <header
          className="chat-head"
          draggable={onHeadDragStart ? true : undefined}
          onDragStart={onHeadDragStart}
        >
          <div className="chat-title">
            {renaming ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (titleDraft.trim()) void change({ title: titleDraft.trim() });
                  setRenaming(false);
                }}
              >
                <input
                  className="rename-input"
                  aria-label="Conversation title"
                  autoFocus
                  value={titleDraft}
                  maxLength={160}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  onBlur={() => setRenaming(false)}
                />
              </form>
            ) : (
              <button
                className="chat-rename"
                title="Rename conversation"
                aria-label="Rename conversation"
                onClick={() => {
                  setTitleDraft(s.title ?? info?.title ?? "");
                  setRenaming(true);
                }}
              >
                <h2>{s.title ?? info?.title ?? "New chat"}</h2>
                <span>⌄</span>
              </button>
            )}
            <span className="muted small chat-folder" title={folderHost ? undefined : projectPath}>
              {folderHost ? (
                <button
                  className="chat-folder-open"
                  title={`Open ${projectPath} in the explorer`}
                  onClick={() => folderHost.open(projectPath)}
                >
                  {folderLabel}
                </button>
              ) : (
                folderLabel
              )}
              {folderHost?.reveal && (
                <button
                  className="ghost icon tiny chat-folder-reveal"
                  title="Reveal in file manager"
                  aria-label="Reveal in file manager"
                  onClick={() => folderHost.reveal!(projectPath)}
                >
                  <IconExternal size={11} />
                </button>
              )}
              {forkedFrom && (
                <button
                  className="chat-branch-of"
                  disabled={!origin}
                  title={origin ? `Open the conversation this one came from` : "The original was deleted"}
                  onClick={() => origin && openSession(origin.id)}
                >
                  <IconGit size={11} /> {forkedFrom.messageId ? "Branch" : "Copy"} of{" "}
                  {origin?.title ?? "a deleted conversation"}
                </button>
              )}
            </span>
          </div>
          <div className="chat-head-right">
            {forkedFrom && origin && (
              <button
                className="ghost tiny"
                disabled={!messageEdits.enabled}
                onClick={() => void mergeBack()}
                title={`Add the messages written here to “${origin.title ?? "the original"}”`}
              >
                <IconGit size={13} /> Merge back
              </button>
            )}
            <button
              className="ghost icon"
              disabled={!messageEdits.enabled}
              onClick={() => void duplicate()}
              title="Duplicate conversation"
              aria-label="Duplicate conversation"
            >
              <IconCopy size={16} />
            </button>
            <StatusPill status={s.status} phase={s.phase} planOnly={s.workflow === "plan-only"} />
            <span className="muted small tokens" title="tokens in / out">
              {fmtTokens(s.usage.inputTokens)} / {fmtTokens(s.usage.outputTokens)}
              {s.usage.cost ? ` · $${s.usage.cost.toFixed(3)}` : ""}
            </span>
            <button
              className={`ghost icon ${panel ? "on" : ""}`}
              onClick={() => setPanel((p) => !p)}
              title="Code panel"
              aria-label="Toggle code panel"
            >
              <IconPanel size={17} />
            </button>
            {headActions}
          </div>
        </header>
        <LaunchContext.Provider value={{ host: launchHost, projectPath }}>
          <MessageEditsContext.Provider value={messageEdits}>
            <Messages
              s={s}
              sessionId={id}
              viewKey={viewKey}
              onOpenPreview={() => openPreview()}
              onCompare={openCompare}
              onOpenDocument={openDocument}
            />
          </MessageEditsContext.Provider>
        </LaunchContext.Provider>
        <div className="chat-bottom">
          {(["failed", "cancelled"].includes(s.status) || (s.interrupted && !s.externalRun)) && (
            <div className="continue-job" role="region" aria-label="Job recovery">
              <div>
                <strong>
                  {s.status === "failed"
                    ? "This job didn’t finish"
                    : s.status === "cancelled"
                      ? "This job was stopped"
                      : "This job was interrupted when the app closed"}
                </strong>
                <p>Continue in this workspace using the saved plan and progress.</p>
              </div>
              <button
                disabled={continuing}
                onClick={async () => {
                  if (!client || continuing) return;
                  setContinuing(true);
                  try {
                    await client.continueJob(id);
                    void refreshSessions();
                  } catch (error) {
                    setNotice((error as Error).message);
                  } finally {
                    setContinuing(false);
                  }
                }}
              >
                <IconPlay size={14} />
                {continuing ? "Continuing…" : "Continue job"}
              </button>
            </div>
          )}
          {notice && (
            <div className="notice">
              {notice}
              <button className="ghost tiny" onClick={() => setNotice(undefined)}>
                <IconX size={12} />
              </button>
            </div>
          )}
          {busy && s.externalRun && (
            <div className="notice">
              Live from another terminal. Output and previews update here; respond to approvals or stop the
              run in that terminal.
            </div>
          )}
          <Composer
            busy={busy && !s.externalRun}
            disabled={busy && s.externalRun}
            disabledReason="This run is controlled in its terminal"
            onStop={() => client?.cancel(id)}
            placeholder={mode === "chat" ? "Reply…" : "Describe the task…"}
            onSend={send}
            skills={skills}
            onRecreate={
              recreateEnabled && !s.externalRun
                ? async (url) => {
                    await startRecreate(url, { sessionId: id });
                  }
                : undefined
            }
            left={<ModePicker value={mode} onChange={setMode} />}
            right={
              <>
                <ModelPicker
                  value={model}
                  defaultLabel={undefined}
                  projectPath={projectPath}
                  disabled={busy}
                  onChange={(ref) => ref && change({ models: ALL_ROLES(ref), reasoningEffort: "auto" })}
                />
                <EffortPicker
                  value={s.reasoningEffort ?? "auto"}
                  model={model}
                  projectPath={projectPath}
                  disabled={busy}
                  onChange={(reasoningEffort) => change({ reasoningEffort })}
                />
                <PermissionPicker value={permissionMode} onChange={(m) => change({ permissionMode: m })} />
              </>
            }
          />
          <p className="chat-disclaimer">CDR can make mistakes. Review code and changes before using them.</p>
        </div>
      </section>
      {panel && client && (
        <>
          <ColumnResize label="Resize chat and details" className="chat-resize" size={columns} />
          <ColumnResize label="Resize chat and details" className="chat-row-resize" size={rows} />
          <CodePanel
            s={s}
            sessionId={id}
            tab={tab}
            setTab={setTab}
            compareRun={compareRun}
            setCompareRun={setCompareRun}
            doc={doc}
            closeDoc={closeDocument}
            previewHost={previewHost}
          />
        </>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  return n > 9999 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

function StatusPill({ status, phase, planOnly }: { status: string; phase?: string; planOnly?: boolean }) {
  const label =
    status === "done" && planOnly
      ? "Plan ready"
      : status === "running"
        ? phase
          ? `${phase}…`
          : "working…"
        : status === "waiting"
          ? "needs you"
          : status;
  return <span className={`status-pill ${status}`}>{label}</span>;
}

// ------------------------------------------------------------------ message list

type Block =
  { kind: "message"; id: string } | { kind: "tools"; ids: string[] } | { kind: "event"; event: HarnessEvent };

function toBlocks(timeline: TimelineItem[], s: UseSessionResult): Block[] {
  const out: Block[] = [];
  for (const item of timeline) {
    if (item.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.ids.push(item.id);
      else out.push({ kind: "tools", ids: [item.id] });
    } else if (item.kind === "message") {
      const m = s.messages[item.id];
      if (m && m.role === "assistant" && !m.text && !m.streaming && !m.reasoning) continue;
      // The reviewer's final JSON is rendered as the review card instead.
      if (m && m.agent === "reviewer" && !m.streaming && /^\s*(```json|\{)/.test(m.text)) continue;
      out.push({ kind: "message", id: item.id });
    } else out.push({ kind: "event", event: item.event });
  }
  return out;
}

function conversationTurns(blocks: Block[], s: UseSessionResult) {
  const turns: { id: string; user?: Extract<Block, { kind: "message" }>; steps: Block[] }[] = [];
  for (const block of blocks) {
    if (block.kind === "message" && s.messages[block.id]?.role === "user")
      turns.push({ id: block.id, user: block, steps: [] });
    else {
      if (!turns.length) turns.push({ id: "history", steps: [] });
      turns[turns.length - 1].steps.push(block);
    }
  }
  return turns;
}

function TurnActivity({
  turnId,
  steps,
  s,
  sessionId,
  active,
  times,
  open,
  onToggle,
  reportOpen,
  onToggleReport,
  onOpenPreview,
  onCompare,
  recreateAnchors,
}: {
  /** The user message that started the turn (absent for history before the first one). */
  turnId?: string;
  steps: Block[];
  s: UseSessionResult;
  sessionId: string;
  active: boolean;
  times?: { start: string; end?: string };
  open: boolean;
  onToggle(): void;
  reportOpen: boolean;
  onToggleReport(): void;
  onOpenPreview(): void;
  onCompare(runId: string): void;
  /** seq of the recreate.started event each run's card is anchored at */
  recreateAnchors: Map<number, string>;
}) {
  const detailsId = useId();
  const reportId = useId();
  const now = useNow(active && !!times);
  const startMs = times ? Date.parse(times.start) : NaN;
  const endMs = times?.end ? Date.parse(times.end) : active ? now : NaN;
  const elapsed = Number.isFinite(startMs) && Number.isFinite(endMs) ? formatDuration(endMs - startMs) : "";
  const lastMessage = [...steps].reverse().find((b) => b.kind === "message" && s.messages[b.id]?.text);
  const lastTool = steps.reduce((last, b, i) => (b.kind === "tools" ? i : last), -1);
  const final =
    !active && lastMessage?.kind === "message" && steps.indexOf(lastMessage) > lastTool
      ? lastMessage.id
      : undefined;
  const details = steps.filter((b) => b.kind !== "message" || b.id !== final || s.messages[b.id]?.reasoning);
  const count = details.reduce(
    (n, b) =>
      n +
      (b.kind === "tools"
        ? b.ids.length
        : b.kind === "message"
          ? 1
          : [
                "phase.start",
                "verify.result",
                "review.findings",
                "error",
                "log",
                "memory.saved",
                "memory.removed",
                "plan.decision",
                "skill.activated",
              ].includes(b.event.type) ||
              (b.event.type === "done" && !!b.event.reportPath)
            ? 1
            : 0),
    0,
  );
  const canReport = !!turnId && !active && count > 0;
  // Built only while the summary is open; it reads the turn's whole event history.
  const report = useMemo(
    () =>
      canReport && reportOpen
        ? buildTurnReport({
            items: turnItems(s.timeline, s.messages, turnId!),
            messages: s.messages,
            tools: s.tools,
            overhead: s.turnOverhead?.[turnId!],
            agents: s.agents,
            times,
          })
        : undefined,
    [canReport, reportOpen, s.timeline, s.messages, s.tools, s.turnOverhead, s.agents, times, turnId],
  );
  // While working, keep the latest decisions from the model's thinking visible without opening the steps.
  const decisions = active
    ? steps.flatMap((b) => (b.kind === "message" ? (s.messages[b.id]?.decisions ?? []) : [])).slice(-3)
    : [];
  const recreateCards = steps.flatMap((b) =>
    b.kind === "event" && recreateAnchors.has(b.event.seq) ? [recreateAnchors.get(b.event.seq)!] : [],
  );
  const previews = new Map<string, HarnessEvent>();
  for (const b of steps)
    if (b.kind === "event" && b.event.type === "preview.ready") previews.set(b.event.path, b.event);
  const launches = active
    ? []
    : turnLaunches(
        steps.flatMap((b) => (b.kind === "event" && b.event.type === "launch.ready" ? [b.event] : [])),
        steps.flatMap((b) => (b.kind === "tools" ? b.ids.map((id) => s.tools[id]).filter(Boolean) : [])),
        s.projectPath,
      );
  const running = steps
    .flatMap((b) => (b.kind === "tools" ? b.ids.map((id) => s.tools[id]) : []))
    .reverse()
    .find((t) => t?.status === "running");
  const args = running?.args as { path?: string } | undefined;
  const action = running
    ? ((
        {
          read_file: "Reading",
          write_file: "Creating",
          patch_file: "Editing",
          bash: "Running a command",
          run_app: "Starting the app",
          stop_app: "Stopping the app",
          search_unsplash: "Finding photos",
          check_preview: "Checking the preview",
          check_app: "Play-testing the app",
          design_system: "Building the design system",
          load_skill: "Reading the skill",
          run_verification: "Checking the changes",
        } as Record<string, string>
      )[running.name] ?? "Working")
    : s.phase === "verify"
      ? "Checking the changes"
      : s.phase === "review"
        ? "Reviewing the work"
        : "Thinking";
  const stopped = steps.some(
    (b) => b.kind === "event" && b.event.type === "done" && b.event.status !== "success",
  );
  const label = active
    ? s.status === "waiting"
      ? "Waiting for you"
      : `${action}${typeof args?.path === "string" ? ` ${basename(args.path)}` : "…"}`
    : `${stopped ? "Stopped · " : ""}${count} ${count === 1 ? "step" : "steps"}`;
  return (
    <>
      {(count > 0 || active) && (
        <section className={`turn-activity${active ? " active" : ""}`}>
          <div className="activity-head">
            <button
              className="activity-toggle"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`${open ? "Hide" : "Show"} all steps`}
            >
              {active && s.status !== "waiting" ? (
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : stopped || (active && s.status === "waiting") ? (
                <IconAlert size={14} />
              ) : (
                <IconCheck size={14} />
              )}
              <span className="activity-label">{label}</span>
              {elapsed && <span className="activity-elapsed">{elapsed}</span>}
              <span className="activity-action">{open ? "Hide steps" : "View steps"}</span>
              <IconChevronRight size={13} className={`chev ${open ? "open" : ""}`} />
            </button>
            {canReport && (
              <button
                className={`report-toggle${reportOpen ? " on" : ""}`}
                onClick={onToggleReport}
                aria-expanded={reportOpen}
                aria-controls={reportId}
                title="A readable summary of how this result came about: stages, time, tokens and what to improve"
              >
                <IconChart size={13} /> Summary
              </button>
            )}
          </div>
          {report && <RunReport id={reportId} report={report} request={s.messages[turnId!]?.text} />}
          {!open && decisions.length > 0 && <Decisions items={decisions} live />}
          {open && (
            <div id={detailsId} className="activity-details" role="region" aria-label="All steps">
              {times && Number.isFinite(startMs) && (
                <div className="activity-times">
                  <span>
                    Started <time dateTime={times.start}>{formatClock(startMs)}</time>
                  </span>
                  {times.end ? (
                    <span>
                      Finished <time dateTime={times.end}>{formatClock(Date.parse(times.end))}</time>
                    </span>
                  ) : active ? (
                    <span>Still running</span>
                  ) : null}
                  {elapsed && <span>{elapsed} elapsed</span>}
                </div>
              )}
              {details.map((b, i) =>
                b.kind === "message" ? (
                  <MessageRow
                    key={b.id}
                    s={s}
                    id={b.id}
                    sessionId={sessionId}
                    reasoningOnly={b.id === final}
                  />
                ) : b.kind === "tools" ? (
                  <ToolGroup key={`t${b.ids[0]}`} tools={b.ids.map((id) => s.tools[id]).filter(Boolean)} />
                ) : (
                  <EventRow key={`e${b.event.seq}-${i}`} e={b.event} s={s} onOpenPreview={onOpenPreview} />
                ),
              )}
            </div>
          )}
        </section>
      )}
      {recreateCards.map((runId) =>
        s.recreate?.runs[runId] ? (
          <RecreateCard key={runId} run={s.recreate.runs[runId]} onCompare={onCompare} />
        ) : null,
      )}
      {[...previews.values()].map((e) => (
        <EventRow key={e.seq} e={e} s={s} onOpenPreview={onOpenPreview} />
      ))}
      {final && <MessageRow s={s} id={final} sessionId={sessionId} hideReasoning />}
      {launches.map((l) => (
        <LaunchCard key={`${l.cwd ?? ""}\n${l.command}`} launch={l} />
      ))}
      {steps
        .filter(
          (b) =>
            b.kind === "event" &&
            (b.event.type === "error" ||
              b.event.type === "checkpoint.restored" ||
              b.event.type === "branch.merged" ||
              (b.event.type === "done" && b.event.status !== "success") ||
              (b.event.type === "review.findings" &&
                b.event.findings.some((f) => ["blocking", "major"].includes(f.severity)))),
        )
        .map(
          (b) =>
            b.kind === "event" && (
              <EventRow key={b.event.seq} e={b.event} s={s} onOpenPreview={onOpenPreview} />
            ),
        )}
    </>
  );
}

function Messages({
  s,
  sessionId,
  viewKey,
  onOpenPreview,
  onCompare,
  onOpenDocument,
}: {
  s: UseSessionResult;
  sessionId: string;
  viewKey: string;
  onOpenPreview(): void;
  onCompare(runId: string): void;
  onOpenDocument(doc: OpenDocument): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pending = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  const [pendingBelow, setPendingBelow] = useState(false);
  const saved = useRef(readThreadView(viewKey));
  const [opened, setOpened] = useState<string[]>(() => saved.current.activity ?? []);
  const [reports, setReports] = useState<string[]>(() => saved.current.reports ?? []);
  const restored = useRef(false);
  const following = useRef(saved.current.following ?? true);
  const lastUser = useRef<string>();
  const blocks = useMemo(() => toBlocks(s.timeline, s), [s.timeline, s.messages]);
  const turns = useMemo(() => conversationTurns(blocks, s), [blocks, s.messages]);
  // One progress card per run, under the turn where the run started (a run's tool calls each emit started).
  const recreateAnchors = useMemo(() => {
    const anchors = new Map<number, string>();
    const seen = new Set<string>();
    for (const item of s.timeline)
      if (item.kind === "event" && item.event.type === "recreate.started" && !seen.has(item.event.runId)) {
        seen.add(item.event.runId);
        anchors.set(item.event.seq, item.event.runId);
      }
    return anchors;
  }, [s.timeline]);
  const latestUser = [...s.timeline]
    .reverse()
    .find((item) => item.kind === "message" && s.messages[item.id]?.role === "user");
  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 24);
    setPendingBelow(
      !!pending.current?.firstElementChild &&
        pending.current.getBoundingClientRect().top >= el.getBoundingClientRect().bottom - 24,
    );
    if (restored.current) saveThreadView(viewKey, { top: el.scrollTop, following: following.current });
  };
  const updateScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // Follow compact updates, but stop before a growing answer fills the viewport.
    // Once paused, later tool calls cannot silently pull the reader away again.
    const latest = [...(content.current?.children ?? [])]
      .reverse()
      .find(
        (node) =>
          !node.classList.contains("working") &&
          !(node.classList.contains("pending-anchor") && !node.firstElementChild),
      );
    if (latest && latest.getBoundingClientRect().height > el.clientHeight * 0.65) following.current = false;
    if (following.current) el.scrollTop = el.scrollHeight;
    measure();
  };
  const updateRef = useRef(updateScroll);
  updateRef.current = updateScroll;
  useLayoutEffect(() => {
    if (!restored.current) {
      restored.current = true;
      if (latestUser?.kind === "message") lastUser.current = latestUser.id;
      if (saved.current.top !== undefined && scroller.current) {
        scroller.current.scrollTop = saved.current.top;
        measure();
        return;
      }
    }
    if (latestUser?.kind === "message" && latestUser.id !== lastUser.current) {
      lastUser.current = latestUser.id;
      following.current = true;
    }
    updateScroll();
  }, [s.lastSeq]);
  useEffect(() => {
    const resize = new ResizeObserver(() => updateRef.current());
    if (scroller.current) resize.observe(scroller.current);
    if (content.current) resize.observe(content.current);
    return () => resize.disconnect();
  }, []);
  const jump = (review: boolean) => {
    const el = scroller.current;
    if (!el) return;
    if (review && pending.current)
      el.scrollTop += pending.current.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
    else el.scrollTop = el.scrollHeight;
    following.current = !review;
    measure();
  };
  const busy = s.status === "running";
  const last = blocks[blocks.length - 1];
  const streaming = last?.kind === "message" && s.messages[last.id]?.streaming;
  return (
    <div className="messages-area">
      <div
        className="messages"
        ref={scroller}
        onWheel={(e) => {
          if (e.deltaY < 0) following.current = false;
        }}
        onScroll={() => {
          const el = scroller.current;
          if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
          measure();
        }}
        tabIndex={0}
        role="region"
        aria-label="Conversation"
      >
        <div className="messages-inner" ref={content}>
          {blocks.length === 0 && s.lastSeq > 0 && <div className="muted center">No messages yet.</div>}
          {turns.map((turn, i) => (
            <div className="conversation-turn" key={turn.id}>
              {turn.user && (
                <MessageRow s={s} id={turn.user.id} sessionId={sessionId} onOpenDocument={onOpenDocument} />
              )}
              <TurnActivity
                turnId={turn.user?.id}
                steps={turn.steps}
                s={s}
                sessionId={sessionId}
                active={i === turns.length - 1 && ["running", "waiting"].includes(s.status)}
                times={turn.user ? s.turnTimes?.[turn.user.id] : undefined}
                open={opened.includes(turn.id)}
                onToggle={() => {
                  const next = opened.includes(turn.id)
                    ? opened.filter((id) => id !== turn.id)
                    : [...opened, turn.id];
                  setOpened(next);
                  saveThreadView(viewKey, { activity: next });
                }}
                reportOpen={reports.includes(turn.id)}
                onToggleReport={() => {
                  const next = reports.includes(turn.id)
                    ? reports.filter((id) => id !== turn.id)
                    : [...reports, turn.id];
                  setReports(next);
                  saveThreadView(viewKey, { reports: next });
                }}
                onOpenPreview={onOpenPreview}
                onCompare={onCompare}
                recreateAnchors={recreateAnchors}
              />
            </div>
          ))}
          <div className="pending-anchor" ref={pending}>
            {s.externalRun && ["running", "waiting"].includes(s.status) ? (
              s.status === "waiting" && (
                <div className="notice">Waiting for your response in the terminal.</div>
              )
            ) : (
              <Pending s={s} />
            )}
          </div>
          {busy && !streaming && !turns.length && (
            <div className="working">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              {s.phase ? `${s.phase}…` : "Working…"}
            </div>
          )}
          {s.errors.length > 0 && s.status === "failed" && !s.done && (
            <div className="error">{s.errors.at(-1)}</div>
          )}
        </div>
      </div>
      <div className="conversation-jumps" aria-hidden={!below}>
        <button
          type="button"
          tabIndex={below ? 0 : -1}
          className={`jump-latest ${busy ? "loading" : ""} ${below ? "visible" : ""}`}
          onClick={() => jump(pendingBelow)}
          title={pendingBelow ? (s.pendingPlan ? "Review plan" : "Review request") : "Scroll to latest"}
          aria-label={pendingBelow ? (s.pendingPlan ? "Review plan" : "Review request") : "Jump to latest"}
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function MessageRow({
  s,
  id,
  sessionId,
  hideReasoning = false,
  reasoningOnly = false,
  onOpenDocument,
}: {
  s: UseSessionResult;
  id: string;
  sessionId: string;
  hideReasoning?: boolean;
  reasoningOnly?: boolean;
  onOpenDocument?(doc: OpenDocument): void;
}) {
  const { client } = useApp();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const m = s.messages[id];
  if (!m) return null;
  if (m.role === "user") {
    return (
      <div className="msg user">
        {m.attachments && m.attachments.length > 0 && (
          <div className="msg-attachments">
            {m.attachments.map((a) => {
              const open = onOpenDocument
                ? () => onOpenDocument({ path: a.path, name: a.name, mimeType: a.mimeType })
                : undefined;
              if (!open) {
                // No side column to open into: fall back to a plain link / inert chip.
                return a.kind === "image" && client ? (
                  <a key={a.path} href={client.rawUrl(sessionId, a.path)} target="_blank" rel="noreferrer">
                    <img src={client.rawUrl(sessionId, a.path)} alt={a.name} />
                  </a>
                ) : (
                  <span key={a.path} className="file-chip" title={a.path}>
                    <IconFile size={14} /> {a.name}
                  </span>
                );
              }
              return a.kind === "image" && client ? (
                <button
                  key={a.path}
                  type="button"
                  className="attachment-thumb"
                  onClick={open}
                  title={`Open ${a.name} next to the chat`}
                >
                  <img src={client.rawUrl(sessionId, a.path)} alt={a.name} />
                </button>
              ) : (
                <button
                  key={a.path}
                  type="button"
                  className="file-chip clickable"
                  title={`Open ${a.name} next to the chat`}
                  onClick={open}
                >
                  <IconFile size={14} /> {a.name}
                </button>
              );
            })}
          </div>
        )}
        {m.skills && m.skills.length > 0 && (
          <div className="msg-skills">
            {m.skills.map((n) => (
              <span key={n} className="skill-chip" title={`Skill: ${n}`}>
                <IconSparkle size={12} /> {n}
              </span>
            ))}
          </div>
        )}
        <div className="bubble">{m.text}</div>
        {m.checkpoint ? (
          <RestoreCheckpoint s={s} sessionId={sessionId} checkpoint={m.checkpoint}>
            <MessageEditButtons id={id} role="user" />
          </RestoreCheckpoint>
        ) : (
          <div className="msg-actions user-actions">
            <MessageEditButtons id={id} role="user" />
          </div>
        )}
      </div>
    );
  }
  const label = m.agent && m.agent !== "chat" && m.agent !== "executor" ? m.agent : undefined;
  return (
    <div className="msg assistant">
      <div className="assistant-heading">
        <CDRMark size={22} /> CDR {label && <span className="badge">{label}</span>}
      </div>
      {!hideReasoning && (m.reasoning || (m.streaming && !m.text)) && (
        <Thinking
          text={m.reasoning || ""}
          active={m.streaming && !m.text && s.status === "running"}
          interrupted={m.streaming && (s.status === "cancelled" || s.status === "failed")}
          decisions={m.decisions}
        />
      )}
      {!reasoningOnly && m.text && <Markdown text={m.text} />}
      {!reasoningOnly && m.text && !m.streaming && (
        <div className="msg-actions">
          <button
            className="ghost tiny"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(m.text);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
            aria-label="Copy response"
          >
            {copied ? "Copied" : "Copy response"}
          </button>
          <MessageEditButtons id={id} role="assistant" />
          {copyError && <span className="muted small">Select the response to copy it.</span>}
        </div>
      )}
    </div>
  );
}

/** Branch and Delete for one message; Delete asks once inline before removing anything. */
function MessageEditButtons({ id, role }: { id: string; role: "user" | "assistant" }) {
  const edits = useContext(MessageEditsContext);
  const [confirming, setConfirming] = useState(false);
  if (!edits?.enabled) return null;
  if (confirming)
    return (
      <span className="msg-delete-confirm" role="group" aria-label="Confirm delete">
        <span className="small">
          {role === "user" ? "Delete this message and its replies?" : "Delete this reply and its steps?"}
        </span>
        <button
          className="tiny danger"
          onClick={() => {
            setConfirming(false);
            void edits.remove(id);
          }}
        >
          Delete
        </button>
        <button className="ghost tiny" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    );
  return (
    <>
      <button
        className="ghost tiny"
        onClick={() => void edits.branch(id)}
        title={
          role === "user"
            ? "Continue in a new conversation that ends after this exchange"
            : "Continue in a new conversation that ends after this reply"
        }
      >
        <IconGit size={12} /> Branch
      </button>
      <button
        className="ghost tiny"
        onClick={() => setConfirming(true)}
        title={
          role === "user"
            ? "Remove this message and its replies from the conversation and the model's memory"
            : "Remove this reply from the conversation and the model's memory"
        }
      >
        <IconTrash size={12} /> Delete
      </button>
    </>
  );
}

/** Current time, ticking every second while `live` (for running timers). */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m ${String(sec % 60).padStart(2, "0")}s`;
}

/** Clock time, with the date in front when it is not today. */
function formatClock(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function toolSummary(t: ToolCallView): string {
  const a = (t.args ?? {}) as Record<string, unknown>;
  switch (t.name) {
    case "read_file":
    case "write_file":
    case "patch_file":
      return String(a.path ?? "");
    case "bash":
    case "check_app":
      return String(a.command ?? "");
    case "design_system":
      return String(a.url ?? (Array.isArray(a.images) ? `${a.images.length} image(s)` : (a.out ?? "")));
    case "grep":
      return `${a.pattern}${a.path ? ` in ${a.path}` : ""}`;
    case "glob":
      return String(a.pattern ?? "");
    case "search_unsplash":
      return String(a.query ?? "");
    case "list_dir":
      return String(a.path ?? ".");
    case "todo":
      return "update checklist";
    case "set_preview":
    case "check_preview":
      return String(a.path ?? "index.html");
    case "remember":
    case "forget":
      return String(a.fact ?? "");
    case "load_skill":
      return a.file ? `${a.name} · ${a.file}` : String(a.name ?? "");
    default:
      return typeof t.args === "object" ? JSON.stringify(t.args).slice(0, 120) : String(t.args ?? "");
  }
}

const TOOL_VERB: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  patch_file: "Edit",
  bash: "Run",
  run_app: "Start app",
  check_app: "Play-test",
  design_system: "Design system",
  stop_app: "Stop app",
  grep: "Search",
  glob: "Find",
  list_dir: "List",
  run_verification: "Verify",
  ask_user: "Ask",
  todo: "Plan",
  remember: "Remember",
  forget: "Forget",
  set_preview: "Preview",
  check_preview: "Check",
  search_unsplash: "Find photos",
  use_unsplash_photo: "Use photo",
  load_skill: "Skill",
};

function ToolGroup({ tools }: { tools: ToolCallView[] }) {
  return (
    <div className="tool-group">
      {tools.map((t) => (
        <ToolRow key={t.id} t={t} />
      ))}
    </div>
  );
}

const FILE_TOOLS = new Set(["read_file", "write_file", "patch_file"]);

function ToolRow({ t }: { t: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const links = useContext(FileLinksContext);
  const file = FILE_TOOLS.has(t.name) ? links?.resolve(toolSummary(t)) : undefined;
  const isEdit = t.name === "write_file" || t.name === "patch_file";
  const stats = t.diff ? diffStats(t.diff) : undefined;
  return (
    <div className={`tool ${t.status}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-icon">
          {t.status === "running" ? (
            <span className="spinner" />
          ) : t.status === "error" ? (
            <IconAlert size={14} />
          ) : isEdit ? (
            <IconFile size={14} />
          ) : t.name === "bash" ? (
            <IconTerminal size={14} />
          ) : (
            <IconCheck size={14} />
          )}
        </span>
        <span className="tool-verb">{TOOL_VERB[t.name] ?? t.name}</span>
        <span
          className={`tool-arg mono ${file ? "tool-arg-file" : ""}`}
          title={file ? `Open ${file.path}` : undefined}
          onClick={
            file
              ? (e) => {
                  e.stopPropagation();
                  links?.open(file.path, file.line);
                }
              : undefined
          }
        >
          {toolSummary(t)}
        </span>
        {stats && (
          <span className="tool-stats">
            <span className="add">+{stats.add}</span> <span className="del">−{stats.del}</span>
          </span>
        )}
        <IconChevronRight size={14} className={`chev ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="tool-body">
          {t.diff ? (
            <DiffBlock diff={t.diff} />
          ) : t.name === "load_skill" && t.status === "ok" && t.output ? (
            <LoadedSkill t={t} />
          ) : (
            <pre className="tool-output">{t.output ?? "…"}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Splits load_skill output (`<skill name="…">body\n\nReference files (…): a, b\n</skill>`) for display. */
function parseSkillOutput(output: string): { content: string; files: string[] } {
  const m = /^<skill name="[^"]*">\n([\s\S]*?)\n<\/skill>\s*$/.exec(output);
  if (!m) return { content: output, files: [] };
  const refs = /\n\nReference files \([^)]*\): (.*)$/.exec(m[1]);
  return refs
    ? { content: m[1].slice(0, refs.index), files: refs[1].split(", ").filter(Boolean) }
    : { content: m[1], files: [] };
}

function LoadedSkill({ t }: { t: ToolCallView }) {
  const a = (t.args ?? {}) as { name?: string; file?: string };
  if (a.file) return <SkillBody name={String(a.name ?? "")} file={a.file} content={t.output ?? ""} />;
  const { content, files } = parseSkillOutput(t.output ?? "");
  return <SkillBody name={String(a.name ?? "")} content={content} files={files} />;
}

function SkillBody({
  name,
  file,
  note,
  description,
  content,
  files,
}: {
  name: string;
  file?: string;
  note?: string;
  description?: string;
  content: string;
  files?: string[];
}) {
  const lang = file ? langForPath(file) : "markdown";
  return (
    <div className="skill-body">
      <div className="skill-meta">
        <span>
          <b>{name}</b>
          {file && <span className="mono"> / {file}</span>}
          {note && <span className="muted"> · {note}</span>}
        </span>
        {description && <p className="muted small">{description}</p>}
      </div>
      {lang === "markdown" ? <Markdown text={content} /> : <CodeBlock code={content} lang={lang} />}
      {!!files?.length && (
        <div className="skill-files muted small">
          Reference files: <span className="mono">{files.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function ActivatedSkill({ e }: { e: Extract<HarnessEvent, { type: "skill.activated" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-group">
      <div className="tool ok">
        <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="tool-icon">
            <IconCheck size={14} />
          </span>
          <span className="tool-verb">Skill</span>
          <span className="tool-arg mono">
            {e.name} · {e.reason === "selected" ? "selected by you" : "loaded automatically"}
          </span>
          <IconChevronRight size={14} className={`chev ${open ? "open" : ""}`} />
        </button>
        {open && (
          <div className="tool-body">
            <SkillBody
              name={e.name}
              note={`${e.source} skill, ${e.reason === "selected" ? "selected for this message" : "matched the task"}`}
              description={e.description}
              content={e.content}
              files={e.files}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function diffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

const CHANGE_LABEL = { modified: "restored", deleted: "removed", added: "recreated" } as const;

/** "Restore files" on a user message: previews what changes, then resets the workspace to before that turn. */
function RestoreCheckpoint({
  s,
  sessionId,
  checkpoint,
  children,
}: {
  s: UseSessionResult;
  sessionId: string;
  checkpoint: string;
  /** More actions shown next to the restore button. */
  children?: ReactNode;
}) {
  const { client } = useApp();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<CheckpointChange[]>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const busy = ["running", "waiting"].includes(s.status) || !!s.externalRun;
  if (busy && !open) return children ? <div className="msg-actions user-actions">{children}</div> : null;
  const load = async () => {
    if (!client) return;
    setOpen(true);
    setFiles(undefined);
    setError(undefined);
    try {
      setFiles(await client.previewCheckpoint(sessionId, checkpoint));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const restore = async () => {
    if (!client || working) return;
    setWorking(true);
    try {
      await client.restoreCheckpoint(sessionId, checkpoint);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  if (!open)
    return (
      <div className="msg-actions user-actions">
        <button
          className="ghost tiny"
          onClick={load}
          title="Reset the workspace files to before this message"
        >
          <IconRefresh size={12} /> Restore files to here
        </button>
        {children}
      </div>
    );
  return (
    <div className="checkpoint-card" role="region" aria-label="Restore checkpoint">
      {error ? (
        <div className="small">{error}</div>
      ) : !files ? (
        <div className="muted small">Comparing with the current files…</div>
      ) : files.length === 0 ? (
        <div className="small">The files already match how they were before this message.</div>
      ) : (
        <>
          <div className="small">
            Restore <b>{files.length}</b> file{files.length === 1 ? "" : "s"} to how{" "}
            {files.length === 1 ? "it was" : "they were"} before this message? The current files are saved
            first, so you can undo this.
          </div>
          <ul className="checkpoint-files mono small">
            {files.slice(0, 50).map((f) => (
              <li key={f.path}>
                <span className={`change ${f.status}`}>{CHANGE_LABEL[f.status]}</span> {f.path}
              </li>
            ))}
            {files.length > 50 && <li className="muted">…and {files.length - 50} more</li>}
          </ul>
        </>
      )}
      <div className="checkpoint-buttons">
        <button className="ghost tiny" onClick={() => setOpen(false)}>
          {files?.length ? "Cancel" : "Close"}
        </button>
        {!!files?.length && (
          <button className="tiny" disabled={working || busy} onClick={restore}>
            {working ? "Restoring…" : "Restore files"}
          </button>
        )}
      </div>
    </div>
  );
}

function RestoredRow({
  e,
  s,
}: {
  e: Extract<HarnessEvent, { type: "checkpoint.restored" }>;
  s: UseSessionResult;
}) {
  const { client } = useApp();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const latest = [...s.timeline]
    .reverse()
    .find((i) => i.kind === "event" && i.event.type === "checkpoint.restored");
  const canUndo =
    latest?.kind === "event" &&
    latest.event.seq === e.seq &&
    !["running", "waiting"].includes(s.status) &&
    !s.externalRun;
  return (
    <div className="restored-row small">
      <IconRefresh size={13} />
      <span>
        {e.changed
          ? `Restored ${e.changed} file${e.changed === 1 ? "" : "s"} from a checkpoint.`
          : "Files already matched the checkpoint."}
      </span>
      {canUndo && e.changed > 0 && (
        <button
          className="ghost tiny"
          disabled={working}
          onClick={async () => {
            if (!client) return;
            setWorking(true);
            try {
              await client.restoreCheckpoint(e.sessionId, e.backupId);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setWorking(false);
            }
          }}
        >
          {working ? "Undoing…" : "Undo"}
        </button>
      )}
      {error && <span className="muted">{error}</span>}
    </div>
  );
}

export interface LaunchHost {
  /** Run `command` in `cwd` (an absolute folder) where the user can see and stop it. */
  run(command: string, cwd: string, title: string): void;
}

const LaunchContext = createContext<{ host?: LaunchHost; projectPath?: string }>({});

function joinPath(root: string, sub?: string): string {
  if (!sub || sub === ".") return root;
  return `${root.replace(/[\\/]+$/, "")}/${sub}`;
}

/** "Launch" button for a native program the agent built, with its language or framework's mark. */
function LaunchCard({ launch }: { launch: LaunchView }) {
  const { host, projectPath } = useContext(LaunchContext);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2500);
    return () => clearTimeout(t);
  }, [done]);
  const name = frameworkName(launch.framework);
  const icon = frameworkIconUrl(launch.framework);
  const title = launch.title || `${basename(projectPath || "") || "App"} · native ${name}`;
  const shown = `${launch.cwd && launch.cwd !== "." ? `cd ${launch.cwd} && ` : ""}${launch.command}`;
  const canRun = !!host && !!projectPath;
  const run = () => {
    if (canRun) host!.run(launch.command, joinPath(projectPath!, launch.cwd), title);
    else void navigator.clipboard?.writeText(shown);
    setDone(true);
  };
  return (
    <div
      className={`launch-card fw-${launch.framework ?? "other"}`}
      role="group"
      aria-label={`Launch ${title}`}
    >
      <span className="launch-icon" title={name}>
        {icon ? <img src={icon} alt="" width={22} height={22} /> : <IconTerminal size={18} />}
      </span>
      <span className="launch-text">
        <span className="launch-kicker">
          Native {name} app{launch.inferred ? " · detected" : ""}
        </span>
        <b>{title}</b>
        <code
          className="launch-command"
          title={launch.cwd ? `Runs in ${launch.cwd}` : "Runs in the project folder"}
        >
          {shown}
        </code>
      </span>
      <button
        className="launch-btn"
        onClick={run}
        title={canRun ? `Run ${shown} in a new terminal` : "Copy the command to run it in your terminal"}
      >
        {canRun ? <IconPlay size={14} /> : <IconCopy size={14} />}
        {done ? (canRun ? "Launched" : "Copied") : canRun ? `Launch ${name}` : "Copy command"}
      </button>
    </div>
  );
}

function EventRow({ e, s, onOpenPreview }: { e: HarnessEvent; s: UseSessionResult; onOpenPreview(): void }) {
  switch (e.type) {
    case "preview.ready":
      return (
        <button className="preview-card" onClick={onOpenPreview}>
          <span className="preview-icon">
            <IconPlay size={14} />
          </span>
          <span className="preview-text">
            <b>{e.title || "Preview ready"}</b>
            <span className="muted small mono">{e.path}</span>
          </span>
          <span className="muted small">Open preview</span>
        </button>
      );
    case "phase.start":
      if (e.phase === "finish") return null;
      return (
        <div className="phase-divider">
          <span>
            {e.phase}
            {e.round && e.round > 1 ? ` · round ${e.round}` : ""}
          </span>
        </div>
      );
    case "skill.activated":
      return <ActivatedSkill e={e} />;
    case "verify.result":
      return (
        <details className={`verify ${e.exitCode === 0 ? "ok" : "fail"}`}>
          <summary>
            {e.exitCode === 0 ? <IconCheck size={14} /> : <IconAlert size={14} />} {e.kind}:{" "}
            <code>{e.command}</code>
            <span className="muted"> exit {e.exitCode}</span>
          </summary>
          <pre className="tool-output">{e.output || "(no output)"}</pre>
        </details>
      );
    case "review.findings":
      return (
        <div className="card review">
          <div className="card-title">Review</div>
          {e.summary && <div className="small">{e.summary}</div>}
          {e.findings.length === 0 ? (
            <div className="muted">No findings – looks good.</div>
          ) : (
            e.findings.map((f, i) => (
              <div key={i} className={`finding ${f.severity}`}>
                <span className="sev">{f.severity}</span>
                <div>
                  {f.file && (
                    <code className="small">
                      {f.file}
                      {f.line ? `:${f.line}` : ""}
                    </code>
                  )}{" "}
                  {f.issue}
                  {f.suggestion && <div className="muted small">→ {f.suggestion}</div>}
                </div>
              </div>
            ))
          )}
        </div>
      );
    case "plan.proposed":
      // The planner's message already shows the plan; the pending one is an interactive card below.
      return null;
    case "run.start":
      return e.continuedFrom ? (
        <div className="muted small center">Continuing the job from saved progress</div>
      ) : null;
    case "checkpoint.restored":
      return <RestoredRow e={e} s={s} />;
    case "branch.merged":
      return (
        <div className="branch-merged" role="separator">
          <IconGit size={12} /> Merged {e.messages} message{e.messages === 1 ? "" : "s"} from branch{" "}
          {e.branchTitle ? `“${e.branchTitle}”` : e.branchSessionId}
        </div>
      );
    case "checkpoint.failed":
      return <div className="muted small center">Checkpoint not saved: {e.message}</div>;
    case "log":
      return e.level === "warn" ? <div className="muted small center">{e.message}</div> : null;
    case "context.compacted":
      return (
        <div
          className="muted small center"
          title={e.historyPath ? `Raw history: ${e.historyPath}` : undefined}
        >
          {compactionLine(e)}
        </div>
      );
    case "memory.saved":
      return (
        <div className="muted small center" title={e.path}>
          Remembered ({e.scope}): {e.fact}
          {e.replaced ? ` – replaces “${e.replaced}”` : ""}
        </div>
      );
    case "memory.removed":
      return (
        <div className="muted small center" title={e.path}>
          Forgot ({e.scope}): {e.fact}
        </div>
      );
    case "plan.decision":
      return (
        <div className="muted small center">
          Plan{" "}
          {e.decision === "approve" ? "approved" : e.decision === "edit" ? "edited & approved" : "rejected"}
          {e.feedback ? ` – “${e.feedback}”` : ""}
        </div>
      );
    case "error":
      return (
        <div className="error-row">
          <IconAlert size={14} /> {e.message}
        </div>
      );
    case "done":
      if (e.status === "success" && !e.reportPath) return null;
      return (
        <div className={`done-row ${e.status}`}>
          {e.status === "success" ? <IconCheck size={14} /> : <IconAlert size={14} />}
          {e.status === "success" ? "Done" : e.status === "cancelled" ? "Stopped" : "Failed"}
          {e.reportPath && (
            <span className="muted small">
              {" "}
              · report{" "}
              {e.reportPath.split("/.harness/")[1]
                ? `.harness/${e.reportPath.split("/.harness/")[1]}`
                : e.reportPath}
            </span>
          )}
        </div>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------ interactive cards

function Pending({ s }: { s: UseSessionResult }) {
  const plan = s.pendingPlan;
  const perm = s.pendingPermissions[0];
  const q = s.pendingQuestions[0];
  if (plan) return <PlanCard s={s} plan={plan} />;
  if (perm) return <PermissionCard s={s} perm={perm} />;
  if (q) return <QuestionCard s={s} q={q} />;
  return null;
}

function PlanCard({ s, plan }: { s: UseSessionResult; plan: NonNullable<UseSessionResult["pendingPlan"]> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  return (
    <div className="card plan pending" role="region" aria-label="Plan approval">
      <div className="card-title">Proposed plan – approve to start building</div>
      {editing !== null ? (
        <textarea
          className="plan-edit"
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          rows={18}
        />
      ) : (
        <Markdown text={plan.markdown} />
      )}
      <input
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Feedback for a revised plan (optional)"
      />
      <div className="row">
        {editing !== null ? (
          <button onClick={() => s.decidePlan(plan.id, "edit", { markdown: editing })}>
            Save &amp; build
          </button>
        ) : (
          <button onClick={() => s.decidePlan(plan.id, "approve")}>Approve</button>
        )}
        <button className="secondary" onClick={() => setEditing(editing === null ? plan.markdown : null)}>
          {editing === null ? "Edit" : "Discard edits"}
        </button>
        <span className="spacer" />
        <button
          className="secondary danger-text"
          onClick={() => s.decidePlan(plan.id, "reject", { feedback: feedback || undefined })}
        >
          {feedback ? "Revise plan" : "Reject"}
        </button>
      </div>
    </div>
  );
}

function PermissionCard({
  s,
  perm,
}: {
  s: UseSessionResult;
  perm: UseSessionResult["pendingPermissions"][number];
}) {
  const args = perm.args as Record<string, unknown>;
  const detail =
    perm.tool === "bash"
      ? String(args.command ?? "")
      : perm.tool === "write_file"
        ? `${args.path}\n\n${String(args.content ?? "").slice(0, 3000)}`
        : perm.tool === "patch_file"
          ? `${args.path}\n\n- ${String(args.search ?? "")
              .split("\n")
              .join("\n- ")}\n+ ${String(args.replace ?? "")
              .split("\n")
              .join("\n+ ")}`
          : JSON.stringify(perm.args, null, 2);
  // consent for a 1:1 recreation is given per run; there is no "always"
  const canAlways = perm.tool !== "recreate_capture";
  const alwaysScope =
    perm.tool === "bash"
      ? String(args.command ?? "")
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join(" ")
      : perm.tool;
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT")
        return;
      // With several conversations on screen (split editors), y/n answer only the one that has focus.
      if (
        document.querySelectorAll(".card.permission").length > 1 &&
        !cardRef.current?.closest(".chat-layout")?.contains(e.target as Node)
      )
        return;
      if (e.key === "y") void s.answerPermission(perm.id, "allow");
      if (e.key === "n") void s.answerPermission(perm.id, "deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [perm.id]);
  return (
    <div
      ref={cardRef}
      className={`card permission risk-${perm.risk}`}
      role="region"
      aria-label="Permission request"
    >
      <div className="card-title">
        Allow <code>{perm.tool}</code>? <span className={`risk ${perm.risk}`}>{perm.risk} risk</span>
      </div>
      {perm.reason && <div className="muted small">{perm.reason}</div>}
      {perm.tool === "patch_file" ? (
        <DiffBlock diff={detail.split("\n\n").slice(1).join("\n\n")} title={String(args.path)} />
      ) : (
        <pre className="tool-output">{detail}</pre>
      )}
      <div className={`perm-actions${canAlways ? "" : " two"}`}>
        <button onClick={() => s.answerPermission(perm.id, "allow")} title="Allow once (y)">
          Allow
        </button>
        {canAlways && (
          <button
            className="secondary"
            onClick={() => s.answerPermission(perm.id, "always")}
            title={`Always allow ${alwaysScope}`}
          >
            Always allow
          </button>
        )}
        <button
          className="secondary danger-text"
          onClick={() => s.answerPermission(perm.id, "deny")}
          title="Deny (n)"
        >
          Deny
        </button>
      </div>
      {canAlways && (
        <div className="perm-scope muted small">
          “Always allow” applies to {perm.tool === "bash" ? "commands starting with " : "every "}
          <code>{alwaysScope}</code>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ s, q }: { s: UseSessionResult; q: UseSessionResult["pendingQuestions"][number] }) {
  const [answer, setAnswer] = useState("");
  return (
    <div className="card question" role="region" aria-label="Question">
      <div className="card-title">{q.text}</div>
      {q.options && (
        <div className="row wrap">
          {q.options.map((o) => (
            <button key={o} className="secondary" onClick={() => s.answerQuestion(q.id, o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) void s.answerQuestion(q.id, answer.trim());
        }}
      >
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your answer"
          autoFocus
        />
        <button type="submit" disabled={!answer.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
