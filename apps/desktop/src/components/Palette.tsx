import { useEffect, useMemo, useRef, useState } from "react";
import { openFile, openFolder, openSessionFolder } from "../file-actions";
import { useApp } from "@web/app-state";
import { THEMES } from "@web/themes";
import { fs, git, harness } from "../ipc";
import { useStudio } from "../store";
import { fuzzyFilter } from "./fuzzy";
import { zoomIn, zoomOut, zoomReset } from "../zoom";
import { runInTerminal } from "./BottomPanel";
import type { Dialog } from "./Shell";
import { IFile } from "./icons";
import { promptDialog } from "./dialogs";
import { FileIcon } from "./FileIcon";
import { isHtmlPath } from "../browser-preview";
import { useOpenInBrowser } from "./open-in-browser";

export type PaletteMode = "files" | "commands";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run(): void | Promise<unknown>;
  when?: boolean;
}

export function Palette({
  mode: initial,
  onClose,
  onDialog,
}: {
  mode: PaletteMode;
  onClose(): void;
  onDialog(d: Dialog): void;
}) {
  const st = useStudio();
  const { updateSettings, sessions } = useApp();
  const openInBrowser = useOpenInBrowser();
  const activeTab = st.tabs.find((t) => t.key === st.active);
  const activePath = activeTab?.kind === "file" ? activeTab.path : undefined;
  const sessionPath = st.sessionId ? sessions.find((x) => x.id === st.sessionId)?.projectPath : undefined;
  const [query, setQuery] = useState(initial === "commands" ? ">" : "");
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [scripts, setScripts] = useState<string[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const root = st.workspace?.root;
  const isCommands = query.startsWith(">");

  useEffect(() => {
    if (!root) return;
    void fs
      .listFiles(root)
      .then(setFiles)
      .catch(() => {});
    void detectScripts(root).then(setScripts);
  }, [root]);

  const commands: Command[] = useMemo(() => {
    const ws = !!root;
    const repo = ws && st.isRepo;
    const c: Command[] = [
      { id: "openfile", label: "File: Open file…", hint: "Ctrl+O", run: () => openFile(st) },
      {
        id: "open",
        label: "Open folder…",
        hint: "Ctrl+K Ctrl+O",
        run: () => openFolder(st),
      },
      { id: "clone", label: "Git: Clone repository…", run: () => onDialog("clone") },
      { id: "close", label: "Close folder", when: ws, run: () => st.closeWorkspace() },
      {
        id: "newchat",
        label: "Agent: New conversation",
        hint: "Ctrl+I",
        run: () => (st.setSessionId(null), st.setAgentPanel(true)),
      },
      {
        id: "newchattab",
        label: "Agent: New conversation in editor tab",
        run: () => st.openTab({ kind: "chat", sessionId: null, draft: Date.now() }),
      },
      {
        id: "newchatside",
        label: "Agent: New conversation to the side",
        run: () => st.openTab({ kind: "chat", sessionId: null, draft: Date.now() }, { group: st.groupCount }),
      },
      {
        id: "chattab",
        label: "Agent: Move conversation to editor tab",
        when: !!st.sessionId,
        run: () => (st.openTab({ kind: "chat", sessionId: st.sessionId }), st.setSessionId(null)),
      },
      {
        id: "split",
        label: "View: Split editor right",
        hint: "Ctrl+\\",
        when: !!st.active && st.active !== "welcome",
        run: () => st.splitTab(st.active!, st.focusedGroup + 1),
      },
      {
        id: "agentpanel",
        label: "View: Toggle agent panel",
        hint: "Ctrl+L",
        run: () => st.setAgentPanel(!st.agentPanel),
      },
      { id: "agents", label: "View: Agents", hint: "Ctrl+Shift+A", run: () => st.setSide("agents") },
      { id: "goals", label: "View: Goals", hint: "Ctrl+Shift+J", run: () => st.setSide("goals") },
      {
        id: "newgoal",
        label: "Goals: New goal…",
        when: repo,
        run: () => (st.setSide("goals"), window.dispatchEvent(new Event("studio:new-goal"))),
      },
      { id: "explorer", label: "View: Explorer", hint: "Ctrl+Shift+E", run: () => st.setSide("files") },
      { id: "search", label: "View: Search in files", hint: "Ctrl+Shift+F", run: () => st.setSide("search") },
      { id: "scm", label: "View: Source control", hint: "Ctrl+Shift+G", run: () => st.setSide("git") },
      {
        id: "terminal",
        label: "View: Toggle terminal",
        hint: "Ctrl+J",
        run: () => st.setBottom(st.bottom ? null : "terminal"),
      },
      { id: "newterm", label: "Terminal: New terminal", when: ws, run: () => runInTerminal("") },
      { id: "problems", label: "View: Problems", run: () => st.setBottom("problems") },
      {
        id: "dockagent",
        label: `View: Move agent panel ${st.agentDock === "right" ? "left" : "right"}`,
        run: () => (st.setAgentPanel(true), st.setAgentDock(st.agentDock === "right" ? "left" : "right")),
      },
      {
        id: "browserpreview",
        label: "View: Open in browser (live preview)",
        when: !!activePath && isHtmlPath(activePath),
        run: () => void openInBrowser(activePath!),
      },
      {
        id: "preview",
        label: "View: Open preview in editor",
        when: !!st.sessionId,
        run: () => st.openTab({ kind: "preview", sessionId: st.sessionId! }),
      },
      {
        id: "sessionfolder",
        label: "Agent: Open conversation folder",
        when: !!sessionPath && sessionPath !== root,
        run: () => openSessionFolder(st, st.sessionId!, sessionPath!),
      },
      { id: "log", label: "View: Harness log", run: () => st.setBottom("output") },
      { id: "history", label: "Git: Show history", when: repo, run: () => st.openTab({ kind: "history" }) },
      {
        id: "fetch",
        label: "Git: Fetch",
        when: repo,
        run: () => st.attempt(() => git.fetch(root!), "Fetched").then(st.refreshGit),
      },
      {
        id: "pull",
        label: "Git: Pull",
        when: repo,
        run: () =>
          st
            .attempt(async () => {
              const r = await git.pull(root!);
              if (!r.ok) throw new Error(r.message);
            }, "Pulled")
            .then(st.refreshGit),
      },
      {
        id: "push",
        label: "Git: Push",
        when: repo,
        run: () =>
          st
            .attempt(() => git.push(root!, { setUpstream: !st.status?.upstream }), "Pushed")
            .then(st.refreshGit),
      },
      {
        id: "branch",
        label: "Git: Create branch…",
        when: repo,
        run: async () => {
          const n = await promptDialog("New branch name");
          if (n)
            return st.attempt(() => git.createBranch(root!, n.trim()), `Created ${n}`).then(st.refreshGit);
        },
      },
      {
        id: "stash",
        label: "Git: Stash all changes",
        when: repo,
        run: () => st.attempt(() => git.stashPush(root!, undefined, true), "Stashed").then(st.refreshGit),
      },
      {
        id: "init",
        label: "Git: Initialize repository",
        when: ws && !st.isRepo,
        run: () => st.attempt(() => git.init(root!)).then(st.refreshGit),
      },
      {
        id: "save",
        label: "File: Save",
        hint: "Ctrl+S",
        when: !!st.active?.startsWith("file:"),
        run: () => st.attempt(() => st.saveBuffer(st.active!.slice(5))),
      },
      {
        id: "saveall",
        label: "File: Save all",
        when: ws,
        run: async () => {
          for (const b of st.buffers.values())
            if (b.content !== b.saved) await st.attempt(() => st.saveBuffer(b.path));
        },
      },
      {
        id: "newfile",
        label: "File: New file…",
        when: ws,
        run: async () => {
          const p = await promptDialog("New file path (relative to the folder)");
          if (!p) return;
          await st.attempt(() => fs.create(root!, p.trim()));
          st.openTab({ kind: "file", path: p.trim() });
        },
      },
      { id: "settings", label: "Preferences: Settings", hint: "Ctrl+,", run: () => onDialog("settings") },
      ...THEMES.map((t) => ({
        id: `theme-${t.id}`,
        label: `Preferences: Theme ${t.name}`,
        run: () => updateSettings({ theme: t.id }),
      })),
      { id: "restart", label: "Harness: Restart server", run: () => harness.restart() },
      { id: "zoomin", label: "View: Zoom in", hint: "Ctrl++", run: () => zoomIn() },
      { id: "zoomout", label: "View: Zoom out", hint: "Ctrl+-", run: () => zoomOut() },
      { id: "zoomreset", label: "View: Reset zoom", hint: "Ctrl+0", run: () => zoomReset() },
      ...scripts.map((s) => ({ id: `run-${s}`, label: `Run: ${s}`, run: () => runInTerminal(s) })),
    ];
    return c.filter((x) => x.when !== false);
  }, [root, st, scripts, onDialog, updateSettings, sessionPath, activePath]);

  const items = isCommands
    ? fuzzyFilter(commands, query.slice(1), (c) => c.label).map((c) => ({
        key: c.id,
        label: c.label,
        hint: c.hint,
        run: c.run,
        file: false,
      }))
    : fuzzyFilter(files, query, (f) => f, 60).map((f) => ({
        key: f,
        label: f,
        hint: undefined as string | undefined,
        run: () => st.openTab({ kind: "file", path: f }),
        file: true,
      }));

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    void it.run();
  };

  return (
    <div className="st-modal-backdrop top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-palette" role="dialog" aria-label={isCommands ? "Command palette" : "Quick Open"}>
        <input
          className="st-input"
          autoFocus
          value={query}
          placeholder={root ? "Type a file name, or > for commands" : "> Type a command"}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown")
              (e.preventDefault(), setIndex((i) => Math.min(items.length - 1, i + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
            if (e.key === "Enter") (e.preventDefault(), choose(index));
          }}
          aria-label="Search"
        />
        <div className="st-palette-list" ref={list} role="listbox">
          {items.map((it, i) => (
            <button
              key={it.key}
              data-i={i}
              role="option"
              aria-selected={i === index}
              className={i === index ? "on" : ""}
              onMouseMove={() => setIndex(i)}
              onClick={() => choose(i)}
            >
              {it.file && <FileIcon path={it.label} />}
              <span className="st-ellipsis">
                {it.file ? (
                  <>
                    {it.label.split("/").pop()} <span className="muted small">{it.label}</span>
                  </>
                ) : (
                  it.label
                )}
              </span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ))}
          {!items.length && (
            <div className="st-empty small">
              {!root && !isCommands ? "Open a folder to search files." : "No matches."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Build/test/lint commands from package.json scripts, Cargo, or a Makefile. */
async function detectScripts(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const pkg = JSON.parse((await fs.read(root, "package.json")).content);
    let pm = "npm run";
    for (const [lock, cmd] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun run"],
    ])
      if (
        await fs.read(root, lock).then(
          () => true,
          () => false,
        )
      ) {
        pm = cmd;
        break;
      }
    for (const name of Object.keys(pkg.scripts ?? {}).slice(0, 30)) out.push(`${pm} ${name}`);
  } catch {
    /* no package.json */
  }
  if (
    await fs.read(root, "Cargo.toml").then(
      () => true,
      () => false,
    )
  )
    out.push("cargo build", "cargo test", "cargo clippy");
  if (
    await fs.read(root, "go.mod").then(
      () => true,
      () => false,
    )
  )
    out.push("go build ./...", "go test ./...");
  if (
    await fs.read(root, "Makefile").then(
      () => true,
      () => false,
    )
  )
    out.push("make", "make test");
  return out;
}
