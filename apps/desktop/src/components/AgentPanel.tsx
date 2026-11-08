import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CDRMark } from "@web/components/Brand";
import { useApp } from "@web/app-state";
import { Composer, useSkills, type PendingFile } from "@web/components/Composer";
import {
  EffortPicker,
  ModePicker,
  ModelPicker,
  PermissionPicker,
  Popover,
  type Mode,
} from "@web/components/Pickers";
import { ModelNotice } from "@web/components/ModelNotice";
import { FileLinksContext, type FileLinks } from "@web/components/Markdown";
import type { SessionInfo } from "@harness/client";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { openFileInCode, openFolder, openSessionFolder } from "../file-actions";
import { resolveFileRef } from "../file-refs";
import { app, git, lsp, type RecentRepo } from "../ipc";
import { basename, PANEL_MIME, useStudio, type Tab } from "../store";
import { startTabDrag } from "./dnd";
import { runInTerminal } from "./BottomPanel";
import { SessionSwitcher } from "./SessionSwitcher";
import { projectKey, projectRoot } from "../sessions";
import { FileIcon } from "./FileIcon";
import { useFileIndex } from "./project-files";
import { IExternal, IFolder, IPlus, ISplit } from "./icons";

const ChatView = lazy(() => import("@web/components/ChatView").then((m) => ({ default: m.ChatView })));

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Remembers the folder of the last conversation shown, so "New conversation" from a conversation in
 * a folder starts in that folder again, even when it is not open in the editor.
 */
function useLastFolder(current?: SessionInfo, initial?: string): string | undefined {
  const last = useRef<string | undefined>(initial);
  const root = useStudio().workspace?.root;
  const seenRoot = useRef(root);
  // Opening a folder is a newer choice than the conversation left before it.
  if (seenRoot.current !== root) {
    seenRoot.current = root;
    last.current = initial;
  }
  if (current?.projectPath && !current.sandbox && !current.projectMissing) last.current = current.projectPath;
  return last.current;
}

export function AgentPanel() {
  const st = useStudio();
  const { sessions } = useApp();
  const current = st.sessionId ? sessions.find((s) => s.id === st.sessionId) : undefined;
  const lastFolder = useLastFolder(current);
  const chat = st.mode === "chat";

  // A draft from "Ask agent" opens a new conversation with the text prefilled.
  useEffect(() => {
    if (st.agentDraft) st.setSessionId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.agentDraft?.nonce]);

  /** Move the panel's conversation into an editor tab, freeing the panel for another one. */
  const toEditor = () => {
    st.openTab({ kind: "chat", sessionId: st.sessionId, draft: Date.now(), folder: lastFolder });
    if (st.sessionId) st.setSessionId(null);
  };
  const dock = (e: React.DragEvent) => {
    e.dataTransfer.setData(PANEL_MIME, "agent");
    e.dataTransfer.effectAllowed = "move";
  };
  const actions = (
    <HeadActions
      current={current}
      value={st.sessionId}
      onPick={st.setSessionId}
      newHint="Ctrl+I"
      onNew={() => st.setSessionId(null)}
      newTitle="New conversation (Ctrl+I)"
      navigation={!chat}
      split={
        <button
          className="ghost icon tiny"
          title={
            st.sessionId
              ? "Move this conversation to an editor tab (or drag this button beside an editor)"
              : "New conversation in an editor tab"
          }
          aria-label={
            st.sessionId ? "Move conversation to an editor tab" : "New conversation in an editor tab"
          }
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            startTabDrag(e, {
              open: { kind: "chat", sessionId: st.sessionId, draft: Date.now(), folder: lastFolder },
            });
          }}
          onDragEnd={(e) => {
            if (e.dataTransfer.dropEffect !== "none" && st.sessionId) st.setSessionId(null);
          }}
          onClick={toEditor}
        >
          <IExternal size={15} />
        </button>
      }
    />
  );

  return (
    <div className="st-agent-inner">
      {!st.sessionId && !chat && (
        <div
          className="st-agent-head"
          draggable
          title="Drag to dock the agent panel on the other side"
          onDragStart={dock}
        >
          {actions}
        </div>
      )}
      <div className="st-agent-body">
        <Conversation
          sessionId={st.sessionId}
          onSession={st.setSessionId}
          folder={lastFolder}
          draft={st.agentDraft}
          onMention={(text) => st.askAgent(text)}
          headActions={actions}
          onHeadDragStart={chat ? undefined : dock}
          onTarget={st.setDraftFolder}
        />
      </div>
    </div>
  );
}

/**
 * Conversation header buttons, shared by the panel and editor tabs. On the new-conversation screen
 * they fill their own row with the history menu; with a conversation open they sit at the end of
 * its header, with history as an icon, so there is one header row as in VS Code.
 */
function HeadActions({
  current,
  value,
  onPick,
  newHint,
  onNew,
  newTitle,
  split,
  navigation = true,
}: {
  current?: SessionInfo;
  value: string | null;
  onPick(id: string | null): void;
  newHint?: string;
  onNew(): void;
  newTitle: string;
  split: React.ReactNode;
  /** History and new-conversation buttons; the chat view has the conversation list for those. */
  navigation?: boolean;
}) {
  const switcher = (
    <SessionSwitcher current={current} value={value} onPick={onPick} newHint={newHint} compact={!!value} />
  );
  const buttons = (
    <span className="st-agent-head-actions">
      {value && navigation && switcher}
      {split}
      {navigation && (
        <button className="ghost icon tiny" title={newTitle} aria-label="New conversation" onClick={onNew}>
          <IPlus size={15} />
        </button>
      )}
    </span>
  );
  return value ? (
    buttons
  ) : (
    <>
      {switcher}
      {buttons}
    </>
  );
}

/** An agent conversation in an editor tab; several can sit side by side in split editor groups. */
export function ChatTab({ tab, group }: { tab: Extract<Tab, { kind: "chat" }>; group: number }) {
  const st = useStudio();
  const { sessions } = useApp();
  const current = tab.sessionId ? sessions.find((s) => s.id === tab.sessionId) : undefined;
  const lastFolder = useLastFolder(current, tab.folder);
  const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null);
  const show = (id: string | null) =>
    st.replaceTab(
      tab.key,
      id
        ? { kind: "chat", sessionId: id }
        : { kind: "chat", sessionId: null, draft: Date.now(), folder: lastFolder },
    );
  const actions = (
    <HeadActions
      current={current}
      value={tab.sessionId}
      onPick={show}
      onNew={() => show(null)}
      newTitle="New conversation in this tab"
      split={
        <button
          className="ghost icon tiny"
          title="New conversation to the side"
          aria-label="New conversation to the side"
          onClick={() =>
            st.openTab(
              { kind: "chat", sessionId: null, draft: Date.now(), folder: lastFolder },
              { group: group + 1 },
            )
          }
        >
          <ISplit size={15} />
        </button>
      }
    />
  );

  return (
    <div className="st-agent-inner st-chat-tab">
      {!tab.sessionId && <div className="st-agent-head">{actions}</div>}
      <div className="st-agent-body">
        <Conversation
          sessionId={tab.sessionId}
          onSession={show}
          folder={lastFolder}
          draft={draft}
          onMention={(text) => setDraft({ text, nonce: Date.now() })}
          headActions={actions}
        />
      </div>
    </div>
  );
}

/** A conversation, or the new-conversation screen while `sessionId` is null. */
function Conversation({
  sessionId,
  onSession,
  folder,
  draft,
  onMention,
  headActions,
  onHeadDragStart,
  onTarget,
}: {
  sessionId: string | null;
  onSession(id: string | null): void;
  /** Where a new conversation works unless another folder is picked. */
  folder?: string;
  /** Text to prefill a new conversation with; a new nonce replaces the composer text. */
  draft?: { text: string; nonce: number } | null;
  /** Put an @mention into the new-conversation composer. */
  onMention(text: string): void;
  /** Buttons at the end of the conversation header. */
  headActions?: React.ReactNode;
  onHeadDragStart?(e: React.DragEvent): void;
  /** Told where a new conversation would work (null for a new sandbox). */
  onTarget?(folder: string | null): void;
}) {
  const st = useStudio();
  const { sessions } = useApp();
  const session = sessionId ? sessions.find((x) => x.id === sessionId) : undefined;
  const root = session && !session.projectMissing ? projectRoot(session.projectPath) : undefined;
  const index = useFileIndex(root, `${session?.status}:${st.fsVersion}`);
  const stRef = useRef(st);
  stRef.current = st;
  const fileLinks = useMemo<FileLinks | null>(
    () =>
      root
        ? {
            resolve: (ref) => resolveFileRef(ref, index, root),
            open: (path, line) =>
              stRef.current.mode === "chat"
                ? stRef.current.openChatFile(root, path, line)
                : void openFileInCode(stRef.current, root, path, line),
            icon: (path) => <FileIcon path={path} size={14} />,
          }
        : null,
    [root, index],
  );
  if (!sessionId)
    return (
      <NewConversation
        lastFolder={folder}
        draft={draft}
        onMention={onMention}
        onStarted={onSession}
        onTarget={onTarget}
      />
    );
  return (
    <Suspense fallback={<div className="st-empty">Loading…</div>}>
      <FileLinksContext.Provider value={fileLinks}>
        <ChatView
          key={sessionId}
          id={sessionId}
          onOpenSession={(id) => onSession(id)}
          headActions={headActions}
          onHeadDragStart={onHeadDragStart}
          previewHost={{
            // The chat view shows previews beside the conversation; only the user leaves it for the code view.
            open: (automatic, live) => {
              if (st.mode === "code") st.openTab({ kind: "preview", sessionId });
              // Selecting a conversation that published a page earlier leaves its project column in place.
              else if (!automatic || (live && sessionId === st.sessionId)) st.openChatPreview(sessionId);
            },
            dragStart:
              st.mode === "code"
                ? (e) => startTabDrag(e, { open: { kind: "preview", sessionId } })
                : undefined,
          }}
          launchHost={{
            run: (command, cwd, title) => {
              const root = st.workspace?.root;
              if (!root) return st.toast("Open a folder to launch programs in the terminal.");
              const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
              const inside = norm(cwd) === norm(root) || norm(cwd).startsWith(`${norm(root)}/`);
              // Terminals start inside the open workspace; elsewhere (a sandbox) the shell changes folder first.
              if (inside) runInTerminal(command, { cwd, title });
              else runInTerminal(`cd "${cwd.replace(/"/g, '\\"')}" && ${command}`, { title });
            },
          }}
          folderHost={{
            open: (path) => {
              const s = sessions.find((x) => x.id === sessionId);
              // In the chat view the project name narrows the list instead of leaving for the explorer.
              if (st.mode === "chat" && s) st.setProjectFilter(projectKey(s));
              else void openSessionFolder(st, path);
            },
            reveal: (path) => void st.attempt(() => revealItemInDir(path)),
          }}
        />
      </FileLinksContext.Provider>
    </Suspense>
  );
}

let tipIndex = 0;
/** Tips that are about the editor, for the code view only. */
const CODE_TIPS: ReactNode[] = [
  <>
    Press <kbd>Ctrl+\</kbd> to split the editor and run a conversation in each column.
  </>,
];
const TIPS: ReactNode[] = [
  <>Ctrl+click a conversation in the list to open it in an editor tab and watch it beside your code.</>,
  <>Plan & build edits your files, runs your tests and reviews the change before it says it is done.</>,
  <>@ Context attaches the open file, the uncommitted diff or the Problems list.</>,
  <>Subagents work in their own Git worktrees, so parallel changes never collide.</>,
];

/** Shown while the editor is split: parallel agents need separate folders. */
const SPLIT_TIP = (
  <>
    Each column runs its own agent. Give each one its own folder or checkout: two agents never edit the same
    folder at once.
  </>
);

const SANDBOX_DIR = /[\\/]\.harness[\\/]sandboxes[\\/]/;

/**
 * Where a new conversation works, or a sandbox. The code view is about the open folder; the chat view is
 * about the conversation just left, which may be in another project.
 */
function useTarget(lastFolder?: string) {
  const st = useStudio();
  const open = st.workspace?.root;
  const [chosen, setChosen] = useState<string | null>();
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  useEffect(() => {
    void app
      .recent()
      .then(setRecent)
      .catch(() => {});
  }, [open]);
  // Opening another folder in the editor makes it the target again.
  useEffect(() => setChosen(undefined), [open]);
  const preferred = st.mode === "chat" ? (lastFolder ?? open) : (open ?? lastFolder);
  const target = chosen === undefined ? (preferred ?? null) : chosen;
  const folders = [
    ...new Set([
      ...(open ? [open] : []),
      ...(lastFolder ? [lastFolder] : []),
      ...recent.filter((r) => r.exists && !SANDBOX_DIR.test(r.path)).map((r) => r.path),
    ]),
  ].slice(0, 8);
  return { target, setTarget: setChosen, folders, open };
}

function TargetPicker({
  target,
  folders,
  open,
  onChange,
}: {
  target: string | null;
  folders: string[];
  open?: string;
  onChange(path: string | null): void;
}) {
  const st = useStudio();
  return (
    <Popover
      className="st-target"
      title="Choose where this conversation works"
      label={
        <span className="st-target-btn">
          <IFolder size={14} />
          <span className="st-target-name">{target ? basename(target) : "New sandbox"}</span>
        </span>
      }
    >
      {(close) => (
        <div className="st-menu wide">
          <div className="st-menu-label">Work in</div>
          {folders.map((f) => (
            <button
              key={f}
              className={f === target ? "on" : ""}
              title={f}
              onClick={() => (close(), onChange(f))}
            >
              <span>
                <IFolder size={14} />
                {basename(f)}
              </span>
              <span className="muted small">
                {f === open ? "open in editor" : f.replace(/^\/home\/[^/]+/, "~")}
              </span>
            </button>
          ))}
          <button className={target === null ? "on" : ""} onClick={() => (close(), onChange(null))}>
            <span>New sandbox</span>
            <span className="muted small">empty folder under ~/.harness/sandboxes</span>
          </button>
          <button onClick={() => (close(), void openFolder(st))}>
            <span>Open another folder…</span>
          </button>
        </div>
      )}
    </Popover>
  );
}

function NewConversation({
  lastFolder,
  draft,
  onMention,
  onStarted,
  onTarget,
}: {
  lastFolder?: string;
  draft?: { text: string; nonce: number } | null;
  onMention(text: string): void;
  onStarted(id: string): void;
  onTarget?(folder: string | null): void;
}) {
  const st = useStudio();
  const { client, settings, updateSettings, refreshSessions } = useApp();
  const [mode, setMode] = useState<Mode>("chat");
  const [error, setError] = useState<string>();
  const [extra, setExtra] = useState<PendingFile[]>([]);
  const { target, setTarget, folders, open } = useTarget(lastFolder);
  const root = target ?? undefined;
  useEffect(() => onTarget?.(target), [target, onTarget]);
  // git diff / problems come from the folder open in the editor
  const editorRoot = open && open === target ? open : undefined;
  // The file shown in the focused editor group, else in any group (a chat tab may have the focus).
  const shown = [st.active, ...st.activeIn].map((k) => st.tabs.find((t) => t.key === k));
  const activeFile = shown.find((t) => t?.kind === "file") as { path: string } | undefined;

  const addDiff = async () => {
    if (!editorRoot) return;
    const text = await st.attempt(() => git.diffText(editorRoot, false));
    if (!text?.trim()) return st.toast("There are no uncommitted changes.");
    setExtra((x) => [
      ...x.filter((f) => f.name !== "uncommitted.diff"),
      attachment("uncommitted.diff", text),
    ]);
  };
  const addProblems = async () => {
    if (!editorRoot) return;
    const d = (await st.attempt(() => lsp.diagnostics(editorRoot))) ?? [];
    if (!d.length) return st.toast("No problems reported by language servers.");
    const text = d.map((x) => `${x.severity} ${x.path}:${x.line}:${x.column} ${x.message}`).join("\n");
    setExtra((x) => [...x.filter((f) => f.name !== "problems.txt"), attachment("problems.txt", text)]);
  };

  const skills = useSkills(root ?? undefined);
  // Each new-conversation screen shows the next tip.
  const [nextTip] = useState(() => {
    const tips = st.mode === "code" ? [...CODE_TIPS, ...TIPS] : TIPS;
    return tips[tipIndex++ % tips.length];
  });
  const tip = st.groupCount > 1 ? SPLIT_TIP : nextTip;

  const start = async (text: string, files: PendingFile[], skillNames: string[]) => {
    if (!client) return false;
    setError(undefined);
    try {
      const ref = settings.model;
      const info = await client.createSession({
        ...(root ? { projectPath: root } : { sandbox: { name: text.slice(0, 40) } }),
        permissionMode: !root && settings.permissionMode === "ask" ? "auto" : settings.permissionMode,
        reasoningEffort: settings.reasoningEffort,
        models: ref ? { executor: ref, planner: ref, reviewer: ref, summarizer: ref } : undefined,
        title: text.split("\n")[0].slice(0, 80),
      });
      await client.send(info.id, text, {
        ...(skillNames.length ? { skills: skillNames } : {}),
        mode: mode === "chat" ? "chat" : "task",
        workflow: mode === "chat" ? undefined : mode,
        attachments: [...extra, ...files].map(({ name, mimeType, data }) => ({ name, mimeType, data })),
      });
      setExtra([]);
      onStarted(info.id);
      void refreshSessions();
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <div className="st-new-chat">
      <div className="st-new-chat-intro">
        <CDRMark size={40} />
        <h2>{root ? `What should we do in ${basename(root)}?` : "Start in a new sandbox"}</h2>
        <p className="muted small">
          {root
            ? "Chat answers questions. Plan & build edits, runs the checks and reviews the change."
            : "The agent works in a fresh, empty folder under ~/.harness/sandboxes."}
        </p>
        <TargetPicker target={target} folders={folders} open={open} onChange={setTarget} />
        <div className="st-tip" role="note">
          <span className="st-tip-label">Tip</span>
          <span>{tip}</span>
        </div>
      </div>
      {(extra.length > 0 || activeFile) && (
        <div className="st-context-chips">
          {activeFile && (
            <button
              className="chip"
              title="Mention the open file"
              onClick={() => onMention(`@${activeFile.path} `)}
            >
              @{basename(activeFile.path)}
            </button>
          )}
          {extra.map((f) => (
            <span key={f.name} className="chip on">
              {f.name}
              <button
                className="ghost tiny"
                aria-label={`Remove ${f.name}`}
                onClick={() => setExtra((x) => x.filter((y) => y.name !== f.name))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Composer
        key={draft?.nonce ?? 0}
        draft={draft?.text}
        autoFocus
        placeholder={mode === "chat" ? "Ask anything about this code…" : "Describe the task…"}
        onSend={start}
        skills={skills}
        left={
          <>
            <ModePicker value={mode} onChange={setMode} />
            {editorRoot && (
              <Popover
                className="pick-context"
                label={
                  <span className="st-title-btn small">
                    @<span className="pick-label"> Context</span>
                  </span>
                }
                title="Add context"
              >
                {(close) => (
                  <div className="st-menu">
                    <button
                      disabled={!activeFile}
                      onClick={() => (close(), activeFile && onMention(`@${activeFile.path} `))}
                    >
                      Current file
                    </button>
                    <button onClick={() => (close(), void addDiff())}>Uncommitted changes</button>
                    <button onClick={() => (close(), void addProblems())}>Problems</button>
                  </div>
                )}
              </Popover>
            )}
          </>
        }
        right={
          <>
            <ModelPicker
              value={settings.model}
              projectPath={root}
              onChange={(m) => updateSettings({ model: m, reasoningEffort: "auto" })}
            />
            <EffortPicker
              value={settings.reasoningEffort}
              model={settings.model}
              projectPath={root}
              onChange={(reasoningEffort) => updateSettings({ reasoningEffort })}
            />
            <PermissionPicker
              value={settings.permissionMode}
              onChange={(m) => updateSettings({ permissionMode: m })}
            />
          </>
        }
      />
      <ModelNotice
        model={settings.model}
        projectPath={root}
        onConnect={() => window.dispatchEvent(new CustomEvent("cdr:open-settings", { detail: "providers" }))}
      />
      {error && <div className="home-error">{error}</div>}
    </div>
  );
}

function attachment(name: string, text: string): PendingFile {
  return { id: name, name, mimeType: "text/plain", data: b64(text), size: text.length };
}
