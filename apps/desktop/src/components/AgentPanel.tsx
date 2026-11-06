import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
import type { SessionInfo } from "@harness/client";
import { git, lsp } from "../ipc";
import { basename, useStudio } from "../store";
import { IChat, IPlus } from "./icons";

const ChatView = lazy(() => import("@web/components/ChatView").then((m) => ({ default: m.ChatView })));

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Sessions that belong to the open workspace, including agent worktrees inside it. */
export function useWorkspaceSessions(): SessionInfo[] {
  const { sessions } = useApp();
  const st = useStudio();
  const root = st.workspace?.root;
  return useMemo(
    () =>
      sessions
        .filter(
          (s) =>
            !s.projectMissing &&
            (root ? s.projectPath === root || s.projectPath.startsWith(root + "/") : s.sandbox),
        )
        .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)),
    [sessions, root],
  );
}

export function AgentPanel() {
  const st = useStudio();
  const list = useWorkspaceSessions();
  const top = list.filter((s) => !s.parentSessionId);
  const current = st.sessionId ? list.find((s) => s.id === st.sessionId) : undefined;

  // A draft from "Ask agent" opens a new conversation with the text prefilled.
  useEffect(() => {
    if (st.agentDraft) st.setSessionId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.agentDraft?.nonce]);

  return (
    <div className="st-agent-inner">
      <div className="st-agent-head">
        <Popover
          className="st-session-menu"
          label={
            <span className="st-title-btn">
              <IChat size={14} />
              <span className="st-ellipsis">
                {st.sessionId ? (current?.title ?? "Conversation") : "New conversation"}
              </span>
            </span>
          }
        >
          {(close) => (
            <div className="st-menu wide">
              <button onClick={() => (close(), st.setSessionId(null))}>
                <span>
                  <IPlus size={12} /> New conversation
                </span>
              </button>
              {top.length > 0 && (
                <div className="st-menu-label">{st.workspace ? st.workspace.name : "Sandboxes"}</div>
              )}
              <div className="st-menu-scroll">
                {top.map((s) => (
                  <button
                    key={s.id}
                    className={s.id === st.sessionId ? "on" : ""}
                    onClick={() => (close(), st.setSessionId(s.id))}
                  >
                    <span className="st-ellipsis">{s.title ?? "Untitled"}</span>
                    <span className={`st-status-dot ${s.status}`} title={s.status} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </Popover>
        <button
          className="ghost icon tiny"
          title="New conversation (Ctrl+I)"
          aria-label="New conversation"
          onClick={() => st.setSessionId(null)}
        >
          <IPlus size={15} />
        </button>
      </div>
      <div className="st-agent-body">
        {st.sessionId ? (
          <Suspense fallback={<div className="st-empty">Loading…</div>}>
            <ChatView key={st.sessionId} id={st.sessionId} />
          </Suspense>
        ) : (
          <NewConversation />
        )}
      </div>
    </div>
  );
}

function NewConversation() {
  const st = useStudio();
  const { client, settings, updateSettings, refreshSessions } = useApp();
  const [mode, setMode] = useState<Mode>("chat");
  const [error, setError] = useState<string>();
  const [extra, setExtra] = useState<PendingFile[]>([]);
  const root = st.workspace?.root;
  const activeFile = st.tabs.find((t) => t.key === st.active && t.kind === "file") as
    { path: string } | undefined;

  const addDiff = async () => {
    if (!root) return;
    const text = await st.attempt(() => git.diffText(root, false));
    if (!text?.trim()) return st.toast("There are no uncommitted changes.");
    setExtra((x) => [
      ...x.filter((f) => f.name !== "uncommitted.diff"),
      attachment("uncommitted.diff", text),
    ]);
  };
  const addProblems = async () => {
    if (!root) return;
    const d = (await st.attempt(() => lsp.diagnostics(root))) ?? [];
    if (!d.length) return st.toast("No problems reported by language servers.");
    const text = d.map((x) => `${x.severity} ${x.path}:${x.line}:${x.column} ${x.message}`).join("\n");
    setExtra((x) => [...x.filter((f) => f.name !== "problems.txt"), attachment("problems.txt", text)]);
  };

  const skills = useSkills(root ?? undefined);

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
      st.setSessionId(info.id);
      void refreshSessions();
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <div className="st-new-chat">
      <div className="st-new-chat-intro">
        <h2>{root ? `What should we do in ${basename(root)}?` : "Start in a new sandbox"}</h2>
        <p className="muted small">
          {root
            ? "Chat answers questions. Plan & build edits, verifies, and reviews. Agents may spawn subagents in their own worktrees."
            : "Without an open folder, the agent works in a fresh sandbox workspace."}
        </p>
      </div>
      {(extra.length > 0 || activeFile) && (
        <div className="st-context-chips">
          {activeFile && (
            <button
              className="chip"
              title="Mention the open file"
              onClick={() => st.askAgent(`@${activeFile.path} `)}
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
        key={st.agentDraft?.nonce ?? 0}
        draft={st.agentDraft?.text}
        autoFocus
        placeholder={mode === "chat" ? "Ask anything about this code…" : "Describe the task…"}
        onSend={start}
        skills={skills}
        left={
          <>
            <ModePicker value={mode} onChange={setMode} />
            {root && (
              <Popover label={<span className="st-title-btn small">@ Context</span>} title="Add context">
                {(close) => (
                  <div className="st-menu">
                    <button
                      disabled={!activeFile}
                      onClick={() => (close(), activeFile && st.askAgent(`@${activeFile.path} `))}
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
