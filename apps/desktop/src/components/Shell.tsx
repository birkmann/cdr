import { useEffect, useRef, useState, type ReactNode } from "react";
import { openFile, openFolder } from "../file-actions";
import { useStudio, type SideView } from "../store";
import type { HarnessStatus } from "../ipc";
import { Splitter, usePanelSize } from "./Splitter";
import { IAgents, IBranch, IFiles, IGoal, ISearch, ISettings } from "./icons";
import { TitleBar } from "./TitleBar";
import { Explorer } from "./Explorer";
import { SearchPanel } from "./SearchPanel";
import { GitPanel } from "./GitPanel";
import { AgentsView } from "./AgentsView";
import { GoalsView } from "./GoalsView";
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

const VIEWS: { id: SideView; label: string; icon: ReactNode; key: string }[] = [
  { id: "files", label: "Explorer", icon: <IFiles size={22} />, key: "Ctrl+Shift+E" },
  { id: "search", label: "Search", icon: <ISearch size={22} />, key: "Ctrl+Shift+F" },
  { id: "git", label: "Source control", icon: <IBranch size={22} />, key: "Ctrl+Shift+G" },
  { id: "agents", label: "Agents", icon: <IAgents size={22} />, key: "Ctrl+Shift+A" },
  { id: "goals", label: "Goals", icon: <IGoal size={22} />, key: "Ctrl+Shift+J" },
];

export type Dialog = null | "settings" | "clone";

export function Shell({ harnessStatus }: { harnessStatus: HarnessStatus }) {
  const st = useStudio();
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  // A command for the terminal (task, palette, chat launch button) opens the panel, which then starts it.
  useEffect(() => {
    const h = () => {
      if (st.bottom !== "terminal") st.setBottom("terminal");
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
  const approvals = useApprovals();
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
      const toggleSide = (v: SideView) => st.setSide(st.side === v ? null : v);
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
      if (e.shiftKey && k === "f") return void (e.preventDefault(), st.setSide("search"));
      if (e.shiftKey && k === "g") return void (e.preventDefault(), toggleSide("git"));
      if (e.shiftKey && k === "a") return void (e.preventDefault(), toggleSide("agents"));
      if (e.shiftKey && k === "j") return void (e.preventDefault(), toggleSide("goals"));
      if (!e.shiftKey && k === "b") return void (e.preventDefault(), st.setSide(st.side ? null : "files"));
      if (!e.shiftKey && (k === "`" || k === "j")) {
        e.preventDefault();
        return st.setBottom(st.bottom === "terminal" ? null : "terminal");
      }
      if (!e.shiftKey && k === "l") return void (e.preventDefault(), st.setAgentPanel(!st.agentPanel));
      if (!e.shiftKey && k === "i") {
        e.preventDefault();
        st.setAgentPanel(true);
        return;
      }
      if (!e.shiftKey && k === ",") return void (e.preventDefault(), setDialog("settings"));
      if (!e.shiftKey && k === "\\" && st.active && st.active !== "welcome")
        return void (e.preventDefault(), st.splitTab(st.active, st.focusedGroup + 1));
      if (!e.shiftKey && k === "w" && st.active) return void (e.preventDefault(), st.closeTab(st.active));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st]);

  const agent = (
    <aside className={`st-agent dock-${st.agentDock}`} style={{ width: agentSize.size }}>
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
      />
      <div className="st-body">
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
              {v.id === "agents" && approvals.length > 0 && (
                <span className="st-badge warn">{approvals.length}</span>
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
              {st.side === "agents" && <AgentsView approvals={approvals} />}
              {st.side === "goals" && <GoalsView />}
            </aside>
            <Splitter
              direction="vertical"
              size={sideSize.size}
              onChange={sideSize.set}
              onReset={sideSize.reset}
              label="Resize side bar"
            />
          </>
        )}
        {st.agentPanel && st.agentDock === "left" && (
          <>
            {agent}
            <Splitter
              direction="vertical"
              size={agentSize.size}
              onChange={agentSize.set}
              onReset={agentSize.reset}
              label="Resize agent panel"
            />
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
        {st.agentPanel && st.agentDock === "right" && (
          <>
            <Splitter
              direction="vertical"
              size={agentSize.size}
              onChange={agentSize.set}
              onReset={agentSize.reset}
              invert
              label="Resize agent panel"
            />
            {agent}
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
