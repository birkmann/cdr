import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "@web/app-state";
import { enterCodeView, openFile, openFolder } from "../file-actions";
import { useStudio, type SideView } from "../store";
import type { HarnessStatus } from "../ipc";
import { Splitter, usePanelSize } from "./Splitter";
import { IBranch, IFiles, ISearch, ISettings } from "./icons";
import { TitleBar } from "./TitleBar";
import { Explorer } from "./Explorer";
import { SearchPanel } from "./SearchPanel";
import { GitPanel } from "./GitPanel";
import { ConversationList } from "./ConversationList";
import { ProjectRail } from "./ProjectRail";
import { ChatFilePane } from "./ChatFilePane";
import { EditorArea } from "./EditorArea";
import { BottomPanel } from "./BottomPanel";
import { AgentPanel } from "./AgentPanel";
import { StatusBar } from "./StatusBar";
import { Palette, type PaletteMode } from "./Palette";
import { SettingsDialog, type SettingsSection } from "./SettingsDialog";
import { CloneDialog } from "./CloneDialog";
import { Toasts } from "./Toasts";
import { useApprovals } from "./approvals";
import { DialogHost } from "./dialogs";
import { dragKind, useActiveDrag } from "./dnd";
import { useFocusProject, useFollowConversationFolder } from "./ConversationFolder";

const VIEWS: { id: SideView; label: string; icon: ReactNode; key: string }[] = [
  { id: "files", label: "Explorer", icon: <IFiles size={22} />, key: "Ctrl+Shift+E" },
  { id: "search", label: "Search", icon: <ISearch size={22} />, key: "Ctrl+Shift+F" },
  { id: "git", label: "Source control", icon: <IBranch size={22} />, key: "Ctrl+Shift+G" },
];

const focusComposer = () =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".st-agent textarea")?.focus());
const focusConversationSearch = () =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".st-conv-search")?.focus());

export type Dialog = null | "settings" | "clone";

export function Shell({ harnessStatus }: { harnessStatus: HarnessStatus }) {
  const st = useStudio();
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  // A command for the terminal (task, palette, chat launch button) opens the panel, which then starts it.
  useEffect(() => {
    const h = () => {
      if (st.bottom !== "terminal" || st.mode === "chat") st.setBottom("terminal");
    };
    window.addEventListener("studio:run-in-terminal", h);
    return () => window.removeEventListener("studio:run-in-terminal", h);
  });
  useEffect(() => {
    const open = (e: Event) => {
      setSettingsSection((e as CustomEvent<SettingsSection | undefined>).detail);
      setDialog("settings");
    };
    window.addEventListener("cdr:open-settings", open);
    return () => window.removeEventListener("cdr:open-settings", open);
  }, []);
  const sideSize = usePanelSize("cdr.studio.side", 280, 180, 560);
  const agentSize = usePanelSize("cdr.studio.agent", 460, 320, 900);
  const bottomSize = usePanelSize("cdr.studio.bottom", 260, 120, 700);
  const listSize = usePanelSize("cdr.studio.conversations", 300, 220, 480);
  const railSize = usePanelSize("cdr.studio.rail", 320, 260, 520);
  // Thousandths of the space right of the conversation list, so an even split stays even as the window resizes.
  const fileShare = usePanelSize("cdr.studio.filepane", 500, 250, 750);
  const approvals = useApprovals((sessionId) => {
    st.setMode("chat");
    st.setSessionId(sessionId);
  });
  const focus = useFocusProject();
  const chat = st.mode === "chat";
  const previewSession =
    chat && st.sessionId && st.chatPreview?.sessionId === st.sessionId ? st.sessionId : undefined;
  const showFiles = chat && !!focus.path && (st.filePane || !!previewSession);
  const beside = Math.max(1, window.innerWidth - listSize.size);
  useFollowConversationFolder();
  const chordUntil = useRef(0);
  const drag = useActiveDrag();
  const [dockOver, setDockOver] = useState<"left" | "right" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (["control", "meta", "shift"].includes(k)) return;
      const chord = chordUntil.current > Date.now();
      chordUntil.current = 0;
      if (chord && mod && !e.shiftKey && k === "o") {
        e.preventDefault();
        setPalette(null);
        void openFolder(st);
        return;
      }
      if (k === "f1" && !mod && !e.shiftKey) return void (e.preventDefault(), setPalette("commands"));
      if (!mod) return;
      /** In the code view a side panel toggles; from the chat view its shortcut goes to that panel. */
      const toggleSide = (v: SideView) => {
        if (st.mode === "code") return st.setSide(st.side === v ? null : v);
        void enterCodeView(st, focus.path);
        st.setSide(v);
      };
      const inCode = st.mode === "code";
      if (e.shiftKey && k === "p") return void (e.preventDefault(), setPalette("commands"));
      if (!e.shiftKey && k === "p") return void (e.preventDefault(), setPalette("files"));
      if (!e.shiftKey && k === "k") {
        e.preventDefault();
        chordUntil.current = Date.now() + 1500;
        return;
      }
      if (!e.shiftKey && k === "o") {
        e.preventDefault();
        setPalette(null);
        void openFile(st);
        return;
      }
      if (e.shiftKey && k === "e") return void (e.preventDefault(), toggleSide("files"));
      if (e.shiftKey && k === "f") {
        e.preventDefault();
        if (!inCode) void enterCodeView(st, focus.path);
        return st.setSide("search");
      }
      if (e.shiftKey && k === "g") return void (e.preventDefault(), toggleSide("git"));
      if (e.shiftKey && k === "a") return void (e.preventDefault(), st.revealRailSection("agents"));
      if (e.shiftKey && k === "j") return void (e.preventDefault(), st.revealRailSection("goals"));
      if (e.shiftKey && k === "u") {
        e.preventDefault();
        if (inCode) st.setMode("chat");
        else void enterCodeView(st, focus.path);
        return;
      }
      if (!e.shiftKey && k === "r") {
        e.preventDefault();
        st.setMode("chat");
        focusConversationSearch();
        return;
      }
      if (!e.shiftKey && k === "b" && inCode)
        return void (e.preventDefault(), st.setSide(st.side ? null : "files"));
      if (!e.shiftKey && (k === "`" || k === "j")) {
        e.preventDefault();
        if (inCode) return st.setBottom(st.bottom === "terminal" ? null : "terminal");
        void enterCodeView(st, focus.path);
        return st.setBottom("terminal");
      }
      if (!e.shiftKey && k === "l") {
        e.preventDefault();
        if (inCode) return st.setAgentPanel(!st.agentPanel);
        focusComposer();
        return;
      }
      if (!e.shiftKey && k === "i") {
        e.preventDefault();
        st.setAgentPanel(true);
        st.setSessionId(null);
        focusComposer();
        return;
      }
      if (!e.shiftKey && k === ",") return void (e.preventDefault(), setDialog("settings"));
      if (inCode && !e.shiftKey && k === "\\" && st.active && st.active !== "welcome")
        return void (e.preventDefault(), st.splitTab(st.active, st.focusedGroup + 1));
      if (inCode && !e.shiftKey && k === "w" && st.active)
        return void (e.preventDefault(), st.closeTab(st.active));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st, focus.path]);

  const agent = (
    <aside className={`st-agent dock-${st.agentDock}`} style={chat ? undefined : { width: agentSize.size }}>
      <AgentPanel />
    </aside>
  );

  useEffect(() => {
    document.title = st.workspace ? `${st.workspace.name} — CDR Studio` : "CDR Studio";
  }, [st.workspace]);

  return (
    <div className="st-app">
      <TitleBar
        onPalette={() => setPalette("files")}
        onClone={() => setDialog("clone")}
        approvals={approvals.length}
        onApprovals={() => {
          st.setMode("chat");
          if (approvals[0]) st.setSessionId(approvals[0].session.id);
        }}
      />
      <div className={`st-body mode-${st.mode} ${showFiles ? "files-open" : ""}`}>
        {chat && (
          <>
            <aside className="st-conversations" style={{ width: listSize.size }}>
              <ConversationList approvals={approvals} onSettings={() => setDialog("settings")} />
            </aside>
            <Splitter
              direction="vertical"
              size={listSize.size}
              onChange={listSize.set}
              onReset={listSize.reset}
              label="Resize conversation list"
            />
          </>
        )}
        <nav className="st-activity" aria-label="Views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`st-activity-btn ${st.side === v.id ? "on" : ""}`}
              title={`${v.label} (${v.key})`}
              aria-label={v.label}
              aria-pressed={st.side === v.id}
              onClick={() => st.setSide(st.side === v.id ? null : v.id)}
            >
              {v.icon}
              {v.id === "git" && !!st.status?.files.length && (
                <span className="st-badge">
                  {st.status.files.length > 99 ? "99+" : st.status.files.length}
                </span>
              )}
            </button>
          ))}
          <div className="st-grow" />
          <button
            className="st-activity-btn"
            title="Settings (Ctrl+,)"
            aria-label="Settings"
            onClick={() => setDialog("settings")}
          >
            <ISettings size={22} />
          </button>
        </nav>
        {st.side && (
          <>
            <aside className="st-side" style={{ width: sideSize.size }}>
              {st.side === "files" && <Explorer onClone={() => setDialog("clone")} />}
              {st.side === "search" && <SearchPanel />}
              {st.side === "git" && <GitPanel />}
            </aside>
            {!chat && (
              <Splitter
                direction="vertical"
                size={sideSize.size}
                onChange={sideSize.set}
                onReset={sideSize.reset}
                label="Resize side bar"
              />
            )}
          </>
        )}
        {(chat || st.agentPanel) && st.agentDock === "left" && (
          <>
            {agent}
            {!chat && (
              <Splitter
                direction="vertical"
                size={agentSize.size}
                onChange={agentSize.set}
                onReset={agentSize.reset}
                label="Resize agent panel"
              />
            )}
          </>
        )}
        <main className="st-center">
          <div className="st-editor-wrap">
            <EditorArea onClone={() => setDialog("clone")} onPalette={() => setPalette("files")} />
          </div>
          {st.bottom && (
            <>
              <Splitter
                direction="horizontal"
                size={bottomSize.size}
                onChange={bottomSize.set}
                onReset={bottomSize.reset}
                invert
                label="Resize panel"
              />
              <div className="st-bottom" style={{ height: bottomSize.size }}>
                <BottomPanel />
              </div>
            </>
          )}
        </main>
        {(chat || st.agentPanel) && st.agentDock === "right" && (
          <>
            {!chat && (
              <Splitter
                direction="vertical"
                size={agentSize.size}
                onChange={agentSize.set}
                onReset={agentSize.reset}
                invert
                label="Resize agent panel"
              />
            )}
            {agent}
          </>
        )}
        {showFiles && (
          <>
            <Splitter
              direction="vertical"
              size={(fileShare.size / 1000) * beside}
              onChange={(px) => fileShare.set((px / beside) * 1000)}
              onReset={fileShare.reset}
              invert
              label="Resize file pane"
            />
            <aside
              className="st-file-pane"
              style={{ width: `calc((100% - ${listSize.size}px) * ${fileShare.size / 1000})` }}
              aria-label="Files"
            >
              <ChatFilePane root={focus.path!} previewSession={previewSession} />
            </aside>
          </>
        )}
        {chat && st.rail && !showFiles && (
          <>
            <Splitter
              direction="vertical"
              size={railSize.size}
              onChange={railSize.set}
              onReset={railSize.reset}
              invert
              label="Resize project column"
            />
            <aside className="st-rail" style={{ width: railSize.size }} aria-label="Project">
              <ProjectRail />
            </aside>
          </>
        )}
        {drag === "panel" &&
          (["left", "right"] as const).map((side) => (
            <div
              key={side}
              className={`st-dock-zone ${side} ${dockOver === side ? "over" : ""}`}
              onDragOver={(e) => {
                if (dragKind(e) !== "panel") return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDockOver(side);
              }}
              onDragLeave={() => setDockOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDockOver(null);
                st.setAgentDock(side);
              }}
            >
              <span>Dock agent panel {side}</span>
            </div>
          ))}
      </div>
      <StatusBar harnessStatus={harnessStatus} onSettings={() => setDialog("settings")} />
      {palette && (
        <Palette
          key={palette}
          mode={palette}
          onClose={() => setPalette(null)}
          onDialog={(d) => {
            setPalette(null);
            setDialog(d);
          }}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog
          onClose={() => (setDialog(null), setSettingsSection(undefined))}
          harnessStatus={harnessStatus}
          initialSection={settingsSection}
        />
      )}
      {dialog === "clone" && <CloneDialog onClose={() => setDialog(null)} />}
      <Toasts />
      <DialogHost />
    </div>
  );
}
