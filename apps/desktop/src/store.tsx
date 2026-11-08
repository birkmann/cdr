import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { chatFileOps, type ChatFiles } from "./file-refs";
import { app, fs, git, on, type FsChange, type GitStatus, type Workspace } from "./ipc";

export type SideView = "files" | "search" | "git";
/** Chat view: conversations, the conversation, its project. Code view: files, editors, the conversation. */
export type ShellMode = "chat" | "code";
export type RailSection = "project" | "repo" | "agents" | "changes" | "goals" | "preview";
export type BottomView = "terminal" | "problems" | "output";
export type DockSide = "left" | "right";
/** Editor groups are numbered from 0 (leftmost); splitting adds a group. */
export type Group = number;
/** The most editor groups shown side by side. */
export const MAX_GROUPS = 4;

export type Tab =
  | { key: string; kind: "welcome" }
  | { key: string; kind: "file"; path: string; line?: number; column?: number }
  | { key: string; kind: "diff"; path: string; staged: boolean }
  | { key: string; kind: "commit"; id: string }
  | { key: string; kind: "history" }
  | { key: string; kind: "goal"; id: string }
  | { key: string; kind: "conflict"; path: string }
  | { key: string; kind: "preview"; sessionId: string }
  /**
   * An agent conversation in the editor. `sessionId` is null until the first message starts it;
   * `draft` tells new-conversation tabs apart and `folder` is where a new one works by default.
   */
  | { key: string; kind: "chat"; sessionId: string | null; draft?: number; folder?: string };

export type TabInput = Tab extends infer T ? (T extends Tab ? Omit<T, "key"> : never) : never;

/** Drag payload type for editor tabs (and tab-openers such as the chat's Preview button). */
export const TAB_MIME = "application/x-cdr-tab";
/** Drag payload type for dockable panels. */
export const PANEL_MIME = "application/x-cdr-panel";

export function tabKey(t: TabInput): string {
  switch (t.kind) {
    case "file":
      return `file:${t.path}`;
    case "diff":
      return `diff:${t.staged ? "s" : "w"}:${t.path}`;
    case "commit":
      return `commit:${t.id}`;
    case "goal":
      return `goal:${t.id}`;
    case "conflict":
      return `conflict:${t.path}`;
    case "preview":
      return `preview:${t.sessionId}`;
    case "chat":
      return t.sessionId ? `chat:${t.sessionId}` : `chat:new:${t.draft ?? 0}`;
    default:
      return t.kind;
  }
}

export interface Buffer {
  path: string;
  /** Last content loaded from or written to disk. */
  saved: string;
  /** Current editor content. */
  content: string;
  mtime: number;
  binary?: boolean;
  tooLarge?: boolean;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
  /** How many times this same message was raised while it was showing. */
  count: number;
}

interface Store {
  workspace: Workspace | null;
  /** Open a folder. The conversation shown is cleared unless `keepSession` is set. */
  openWorkspace(path: string, opts?: { keepSession?: boolean }): Promise<void>;
  closeWorkspace(): void;
  /** All open tabs; their order is the order within each group. */
  tabs: Tab[];
  /** Which group each tab is in (missing means group 0). */
  tabGroup(key: string): Group;
  /** Number of editor groups side by side (1 when not split). */
  groupCount: number;
  /** The group that receives newly opened tabs. */
  focusedGroup: Group;
  focusGroup(g: Group): void;
  /** Active tab per group. */
  activeIn: (string | null)[];
  /** Active tab of the focused group. */
  active: string | null;
  /** Open a tab; `group: groupCount` opens it in a new group on the right. */
  openTab(t: TabInput, opts?: { group?: Group }): void;
  closeTab(key: string): void;
  /** Swap a tab for another in the same place. */
  replaceTab(key: string, t: TabInput): void;
  /** Move a tab into a new group inserted at `at`. */
  splitTab(key: string, at: Group): void;
  setActive(key: string): void;
  /** Move a tab to a group, before another tab (or to the group's end). */
  moveTab(key: string, group: Group, before?: string): void;
  buffers: Map<string, Buffer>;
  bufferVersion: number;
  loadBuffer(path: string): Promise<Buffer>;
  updateBuffer(path: string, content: string): void;
  saveBuffer(path: string): Promise<void>;
  isDirty(path: string): boolean;
  status: GitStatus | null;
  isRepo: boolean;
  refreshGit(): Promise<void>;
  fsVersion: number;
  /** A folder or file the explorer should expand to and select (the nonce repeats a request). */
  reveal: { path: string; nonce: number } | null;
  revealInExplorer(path: string): void;
  mode: ShellMode;
  setMode(m: ShellMode): void;
  /** Whether the chat view shows files beside the conversation, in place of the project column. */
  filePane: boolean;
  setFilePane(v: boolean): void;
  /** The conversation whose preview the chat view has open beside it, and whether it is in front of the files. */
  chatPreview: { sessionId: string; front: boolean } | null;
  /** Show a conversation's preview beside it, in the chat view. */
  openChatPreview(sessionId: string): void;
  closeChatPreview(): void;
  /** Close everything beside the conversation, which brings the project column back. */
  closeChatPane(): void;
  /** The file tabs of the chat view, by project. */
  chatFiles: ChatFiles;
  openChatFile(root: string, path: string, line?: number): void;
  closeChatFile(root: string, path: string): void;
  activateChatFile(root: string, path: string): void;
  /** Whether the file pane shows its folder tree. */
  fileTree: boolean;
  setFileTree(v: boolean): void;
  /** Whether the chat view shows the project column. */
  rail: boolean;
  setRail(v: boolean): void;
  railCollapsed: Partial<Record<RailSection, boolean>>;
  toggleRailSection(id: RailSection): void;
  /** Show the chat view with a section of the project column open and in sight. */
  revealRailSection(id: RailSection): void;
  railFocus: { id: RailSection; nonce: number } | null;
  /** The conversation list's project filter (a folder or `SANDBOX_PROJECT`), or null for all. */
  projectFilter: string | null;
  setProjectFilter(v: string | null): void;
  /** Where the next conversation works: null for a new sandbox, undefined before it was chosen. */
  draftFolder: string | null | undefined;
  setDraftFolder(v: string | null): void;
  side: SideView | null;
  setSide(v: SideView | null): void;
  bottom: BottomView | null;
  setBottom(v: BottomView | null): void;
  agentPanel: boolean;
  setAgentPanel(v: boolean): void;
  agentDock: DockSide;
  setAgentDock(v: DockSide): void;
  sessionId: string | null;
  setSessionId(id: string | null): void;
  toasts: Toast[];
  toast(text: string, kind?: Toast["kind"]): void;
  dismiss(id: number): void;
  /** Pause (hover) or restart a toast's auto-dismiss timer. */
  holdToast(id: number, hold: boolean): void;
  /** Run an async action, reporting failures as a toast. */
  attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined>;
  /** Text queued for the agent composer (from "Ask agent" actions). */
  agentDraft: { text: string; nonce: number } | null;
  askAgent(text: string): void;
}

const Ctx = createContext<Store | null>(null);
const LAYOUT_KEY = "cdr.studio.layout.v1";

export interface Layout {
  side: SideView | null;
  bottom: BottomView | null;
  agentPanel: boolean;
  agentDock: DockSide;
  mode: ShellMode;
  rail: boolean;
  railCollapsed: Partial<Record<RailSection, boolean>>;
  fileTree: boolean;
}
export const DEFAULT_LAYOUT: Layout = {
  side: "files",
  bottom: null,
  agentPanel: true,
  agentDock: "right",
  mode: "chat",
  rail: true,
  railCollapsed: {},
  fileTree: true,
};

const SIDE_VIEWS: readonly (SideView | null)[] = ["files", "search", "git", null];

/** Reads a saved layout; older ones can name the Agents and Goals side panels, which no longer exist. */
export function parseLayout(raw: string | null): Layout {
  try {
    const saved = JSON.parse(raw ?? "{}") as Partial<Layout>;
    const layout = { ...DEFAULT_LAYOUT, ...saved };
    return {
      ...layout,
      side: SIDE_VIEWS.includes(layout.side) ? layout.side : "files",
      mode: layout.mode === "code" ? "code" : "chat",
      railCollapsed:
        layout.railCollapsed && typeof layout.railCollapsed === "object" ? layout.railCollapsed : {},
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function readLayout(): Layout {
  try {
    return parseLayout(localStorage.getItem(LAYOUT_KEY));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const WELCOME: Tab = { key: "welcome", kind: "welcome" };

export interface Tabs {
  tabs: Tab[];
  /** Group of each tab (missing means group 0). */
  groups: Record<string, Group>;
  /** Active tab per group; its length is the number of groups. */
  activeIn: (string | null)[];
  focused: Group;
}

export const INITIAL_TABS: Tabs = { tabs: [WELCOME], groups: {}, activeIn: ["welcome"], focused: 0 };

const groupOf = (s: Tabs, key: string): Group => s.groups[key] ?? 0;
const inGroup = (s: Tabs, g: Group) => s.tabs.filter((t) => groupOf(s, t.key) === g);
/** A group to put a tab in: an existing one, or one new group to the right while there is room. */
const clampGroup = (s: Tabs, g: Group) => Math.max(0, Math.min(g, s.activeIn.length, MAX_GROUPS - 1));

/**
 * Keeps the invariants: groups are numbered 0..n-1 without gaps and none is empty (an emptied
 * group closes and the groups right of it move left), each group's active tab is in it, and the
 * focused group exists.
 */
function normalize(s: Tabs): Tabs {
  const tabs = s.tabs.length ? s.tabs : [WELCOME];
  const count = Math.max(s.activeIn.length, ...tabs.map((t) => groupOf(s, t.key) + 1));
  const used = new Set(tabs.map((t) => groupOf(s, t.key)));
  const remap: number[] = [];
  let n = 0;
  for (let g = 0; g < count; g++) remap[g] = used.has(g) ? n++ : -1;
  const groups: Record<string, Group> = {};
  for (const t of tabs) {
    const g = remap[groupOf(s, t.key)];
    if (g) groups[t.key] = g;
  }
  const activeIn: (string | null)[] = [];
  for (let old = 0; old < count; old++) {
    const g = remap[old];
    if (g < 0) continue;
    const members = tabs.filter((t) => (groups[t.key] ?? 0) === g);
    const a = s.activeIn[old];
    activeIn[g] = members.some((t) => t.key === a) ? (a ?? null) : (members.at(-1)?.key ?? null);
  }
  // A closed focused group passes focus to its left neighbour.
  let focused = 0;
  for (let old = Math.min(s.focused, count - 1); old >= 0; old--)
    if (remap[old] >= 0) {
      focused = remap[old];
      break;
    }
  return { tabs, groups, activeIn, focused };
}

/** Pure tab-state transitions (exported for tests). */
export const tabOps = {
  /** Open (or show) a tab; `group` may be one past the last group to split it off to the right. */
  open(s: Tabs, t: TabInput, group?: Group): Tabs {
    const key = tabKey(t);
    const next = { ...t, key } as Tab;
    const i = s.tabs.findIndex((x) => x.key === key);
    if (i >= 0 && group === undefined) {
      const tabs = [...s.tabs];
      tabs[i] = next;
      const g = groupOf(s, key);
      const activeIn = [...s.activeIn];
      activeIn[g] = key;
      return normalize({ ...s, tabs, activeIn, focused: g });
    }
    const g = clampGroup(s, group ?? s.focused);
    const tabs = [...s.tabs.filter((x) => x.key !== key && x.kind !== "welcome"), next];
    const groups = { ...s.groups, [key]: g };
    const activeIn = [...s.activeIn];
    activeIn[g] = key;
    return normalize({ tabs, groups, activeIn, focused: g });
  },
  close(s: Tabs, key: string): Tabs {
    const i = s.tabs.findIndex((t) => t.key === key);
    if (i < 0) return s;
    const g = groupOf(s, key);
    const activeIn = [...s.activeIn];
    if (activeIn[g] === key) {
      // Activate the neighbour in the same group, as editors do.
      const members = inGroup(s, g);
      const j = members.findIndex((t) => t.key === key);
      activeIn[g] = (members[j + 1] ?? members[j - 1])?.key ?? null;
    }
    const groups = { ...s.groups };
    delete groups[key];
    return normalize({ ...s, tabs: s.tabs.filter((t) => t.key !== key), groups, activeIn });
  },
  activate(s: Tabs, key: string): Tabs {
    if (!s.tabs.some((t) => t.key === key)) return s;
    const g = groupOf(s, key);
    const activeIn = [...s.activeIn];
    activeIn[g] = key;
    return { ...s, activeIn, focused: g };
  },
  /**
   * Swap a tab for another in the same place (a new-conversation tab becoming its conversation).
   * If the other tab is already open, this tab closes and that one is shown.
   */
  replace(s: Tabs, oldKey: string, t: TabInput): Tabs {
    const i = s.tabs.findIndex((x) => x.key === oldKey);
    if (i < 0) return tabOps.open(s, t);
    const key = tabKey(t);
    const tabs = [...s.tabs];
    if (key === oldKey) {
      tabs[i] = { ...t, key } as Tab;
      return { ...s, tabs };
    }
    if (s.tabs.some((x) => x.key === key)) return tabOps.activate(tabOps.close(s, oldKey), key);
    tabs[i] = { ...t, key } as Tab;
    const g = groupOf(s, oldKey);
    const groups = { ...s.groups };
    delete groups[oldKey];
    if (g) groups[key] = g;
    const activeIn = s.activeIn.map((a) => (a === oldKey ? key : a));
    return normalize({ ...s, tabs, groups, activeIn });
  },
  /**
   * Keep only the tabs that do not depend on the open folder (conversations and their previews), for a
   * folder switch: file, diff and history tabs belong to the folder being left.
   */
  keepConversations(s: Tabs): Tabs {
    const keep = (t: Tab) => t.kind === "chat" || t.kind === "preview";
    if (!s.tabs.some(keep)) return INITIAL_TABS;
    return normalize({ ...s, tabs: s.tabs.filter(keep) });
  },
  /**
   * Make previews follow the current conversation: each group showing another conversation's preview
   * opens this conversation's preview right after it (the old one stays open beside it).
   */
  followPreview(s: Tabs, sessionId: string): Tabs {
    const key = tabKey({ kind: "preview", sessionId });
    let out = s;
    for (let g = 0; g < out.activeIn.length; g++) {
      const shown = out.tabs.find((t) => t.key === out.activeIn[g]);
      if (shown?.kind !== "preview" || shown.sessionId === sessionId) continue;
      const activeIn = [...out.activeIn];
      if (out.tabs.some((t) => t.key === key)) {
        activeIn[groupOf(out, key)] = key;
        out = { ...out, activeIn };
        continue;
      }
      const at = out.tabs.indexOf(shown) + 1;
      const tabs = [
        ...out.tabs.slice(0, at),
        { kind: "preview", sessionId, key } as Tab,
        ...out.tabs.slice(at),
      ];
      activeIn[g] = key;
      out = normalize({ ...out, tabs, groups: { ...out.groups, [key]: g }, activeIn });
    }
    return out;
  },
  /** Move a tab into a group (one past the last group splits it off), before another tab or to the end. */
  move(s: Tabs, key: string, group: Group, before?: string): Tabs {
    const tab = s.tabs.find((t) => t.key === key);
    if (!tab || before === key) return s;
    group = clampGroup(s, group);
    const from = groupOf(s, key);
    const rest = s.tabs.filter((t) => t.key !== key);
    let at = before ? rest.findIndex((t) => t.key === before) : -1;
    if (at < 0) {
      // End of the target group: after its last member.
      const last = rest.reduce((n, t, i) => (groupOf(s, t.key) === group ? i : n), -1);
      at = last < 0 ? rest.length : last + 1;
    }
    const tabs = [...rest.slice(0, at), tab, ...rest.slice(at)];
    const groups = { ...s.groups, [key]: group };
    const activeIn = [...s.activeIn];
    if (from !== group && activeIn[from] === key) {
      const members = inGroup({ ...s, tabs: rest }, from);
      activeIn[from] = members.at(-1)?.key ?? null;
    }
    activeIn[group] = key;
    return normalize({ tabs, groups, activeIn, focused: group });
  },
  /**
   * Move a tab into a new group inserted at index `at` (groups from `at` on move right). With
   * MAX_GROUPS open, the tab moves into the existing group nearest that place instead.
   */
  split(s: Tabs, key: string, at: Group): Tabs {
    if (!s.tabs.some((t) => t.key === key)) return s;
    at = Math.max(0, Math.min(at, s.activeIn.length));
    if (s.activeIn.length >= MAX_GROUPS) return tabOps.move(s, key, Math.min(at, s.activeIn.length - 1));
    const shift = (g: Group) => (g >= at ? g + 1 : g);
    const groups: Record<string, Group> = {};
    for (const t of s.tabs) groups[t.key] = shift(groupOf(s, t.key));
    const activeIn = [...s.activeIn.slice(0, at), null, ...s.activeIn.slice(at)];
    return tabOps.move({ tabs: s.tabs, groups, activeIn, focused: shift(s.focused) }, key, at);
  },
};

export function StudioProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tabState, setTabState] = useState<Tabs>(INITIAL_TABS);
  const buffers = useRef(new Map<string, Buffer>()).current;
  const [bufferVersion, setBufferVersion] = useState(0);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [isRepo, setIsRepo] = useState(false);
  const [fsVersion, setFsVersion] = useState(0);
  const [reveal, setReveal] = useState<Store["reveal"]>(null);
  const revealInExplorer = useCallback((path: string) => {
    setSide("files");
    setReveal({ path, nonce: Date.now() });
  }, []);
  const layout = useMemo(readLayout, []);
  const [mode, setMode] = useState<ShellMode>(layout.mode);
  const [filePane, setFilePaneOpen] = useState(false);
  const [chatPreview, setChatPreview] = useState<Store["chatPreview"]>(null);
  const [chatFiles, setChatFiles] = useState<ChatFiles>({});
  const [fileTree, setFileTree] = useState(layout.fileTree);
  const [rail, setRail] = useState(layout.rail);
  const [railCollapsed, setRailCollapsed] = useState(layout.railCollapsed);
  const [railFocus, setRailFocus] = useState<Store["railFocus"]>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [draftFolder, setDraftFolder] = useState<string | null | undefined>(undefined);
  const [side, setSide] = useState<SideView | null>(layout.side);
  const [bottom, setBottom] = useState<BottomView | null>(layout.bottom);
  const [agentPanel, setAgentPanel] = useState(layout.agentPanel);
  const [agentDock, setAgentDock] = useState<DockSide>(layout.agentDock === "left" ? "left" : "right");
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  const setSessionId = useCallback((id: string | null) => {
    setSessionIdState(id);
    if (id) setTabState((s) => tabOps.followPreview(s, id));
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [agentDraft, setAgentDraft] = useState<Store["agentDraft"]>(null);
  const toastId = useRef(0);
  const wsRef = useRef<Workspace | null>(null);
  wsRef.current = workspace;

  useEffect(() => {
    try {
      const saved: Layout = { side, bottom, agentPanel, agentDock, mode, rail, railCollapsed, fileTree };
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(saved));
    } catch {
      /* storage unavailable */
    }
  }, [side, bottom, agentPanel, agentDock, mode, rail, railCollapsed, fileTree]);

  const toastTimers = useRef(new Map<number, { timer?: ReturnType<typeof setTimeout>; ms: number }>());
  // Kept in sync synchronously so two toasts raised in one tick still dedupe.
  const toastsRef = useRef<Toast[]>([]);
  const setToastList = useCallback((next: Toast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);
  const dismiss = useCallback(
    (id: number) => {
      const t = toastTimers.current.get(id);
      if (t?.timer) clearTimeout(t.timer);
      toastTimers.current.delete(id);
      setToastList(toastsRef.current.filter((x) => x.id !== id));
    },
    [setToastList],
  );
  const armToast = useCallback(
    (id: number) => {
      const t = toastTimers.current.get(id);
      if (!t) return;
      if (t.timer) clearTimeout(t.timer);
      t.timer = setTimeout(() => dismiss(id), t.ms);
    },
    [dismiss],
  );
  const toast = useCallback(
    (text: string, kind: Toast["kind"] = "info") => {
      // The same message again while it is still showing bumps a counter instead of stacking a copy.
      const same = toastsRef.current.find((x) => x.text === text && x.kind === kind);
      if (same) {
        setToastList(toastsRef.current.map((x) => (x.id === same.id ? { ...x, count: x.count + 1 } : x)));
        armToast(same.id);
        return;
      }
      const id = ++toastId.current;
      const ms = kind === "error" ? 9000 : 4000;
      toastTimers.current.set(id, { ms });
      const next = [...toastsRef.current, { id, kind, text, count: 1 }];
      for (const old of next.slice(0, -4)) {
        const t = toastTimers.current.get(old.id);
        if (t?.timer) clearTimeout(t.timer);
        toastTimers.current.delete(old.id);
      }
      setToastList(next.slice(-4));
      armToast(id);
    },
    [armToast, setToastList],
  );
  const holdToast = useCallback(
    (id: number, hold: boolean) => {
      const t = toastTimers.current.get(id);
      if (!t) return;
      if (hold) {
        if (t.timer) clearTimeout(t.timer);
        t.timer = undefined;
      } else armToast(id);
    },
    [armToast],
  );
  const attempt = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string) => {
      try {
        const r = await fn();
        if (success) toast(success, "success");
        return r;
      } catch (e) {
        toast((e as Error).message, "error");
        return undefined;
      }
    },
    [toast],
  );

  const refreshGit = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws) return;
    try {
      const repo = await git.isRepo(ws.root);
      setIsRepo(repo);
      setStatus(repo ? await git.status(ws.root) : null);
    } catch {
      setStatus(null);
    }
  }, []);

  const openWorkspace = useCallback(
    async (path: string, opts?: { keepSession?: boolean }) => {
      const ws = await app.openWorkspace(path);
      const prev = wsRef.current;
      if (prev && prev.root !== ws.root) void fs.unwatch(prev.root).catch(() => {});
      buffers.clear();
      setBufferVersion((v) => v + 1);
      setTabState(tabOps.keepConversations);
      setReveal(null);
      if (!opts?.keepSession) setSessionId(null);
      wsRef.current = ws;
      setWorkspace(ws);
      setSide((s) => s ?? "files");
      void fs.watch(ws.root).catch(() => {});
      await refreshGit();
    },
    [buffers, refreshGit],
  );

  const closeWorkspace = useCallback(() => {
    const prev = wsRef.current;
    if (prev) void fs.unwatch(prev.root).catch(() => {});
    wsRef.current = null;
    setWorkspace(null);
    setStatus(null);
    setIsRepo(false);
    buffers.clear();
    setTabState(tabOps.keepConversations);
    setReveal(null);
    setSessionId(null);
  }, [buffers]);

  // File system and git changes from the watcher.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return on<FsChange>("fs://changed", (c) => {
      const ws = wsRef.current;
      if (!ws || c.root !== ws.root) return;
      setFsVersion((v) => v + 1);
      // Reload clean buffers whose files changed on disk (agent edits, git checkout).
      for (const p of c.paths) {
        const b = buffers.get(p);
        if (b && b.content === b.saved)
          void fs
            .read(ws.root, p)
            .then((f) => {
              const cur = buffers.get(p);
              if (cur && cur.content === cur.saved && f.content !== cur.saved) {
                buffers.set(p, { ...cur, saved: f.content, content: f.content, mtime: f.mtime });
                setBufferVersion((v) => v + 1);
              }
            })
            .catch(() => {});
      }
      clearTimeout(timer);
      timer = setTimeout(() => void refreshGit(), 250);
    });
  }, [buffers, refreshGit]);

  // Poll git status as a fallback (remote changes, watcher limits).
  useEffect(() => {
    const t = setInterval(() => void refreshGit(), 15000);
    return () => clearInterval(t);
  }, [refreshGit]);

  // Tabs, side panels and the bottom panel live in the code view, so asking for one goes there.
  const openTab = useCallback((t: TabInput, opts?: { group?: Group }) => {
    setMode("code");
    setTabState((s) => tabOps.open(s, t, opts?.group));
  }, []);
  const showSide = useCallback((v: SideView | null) => {
    if (v) setMode("code");
    setSide(v);
  }, []);
  const showBottom = useCallback((v: BottomView | null) => {
    if (v) setMode("code");
    setBottom(v);
  }, []);
  const setFilePane = useCallback((open: boolean) => {
    setFilePaneOpen(open);
    if (open) setChatPreview((p) => p && { ...p, front: false });
  }, []);
  const openChatPreview = useCallback(
    (previewSession: string) => setChatPreview({ sessionId: previewSession, front: true }),
    [],
  );
  const closeChatPreview = useCallback(() => setChatPreview(null), []);
  const closeChatPane = useCallback(() => {
    setFilePaneOpen(false);
    setChatPreview(null);
  }, []);
  const openChatFile = useCallback(
    (root: string, path: string, line?: number) => {
      setFilePane(true);
      setChatFiles((f) => chatFileOps.open(f, root, path, line));
    },
    [setFilePane],
  );
  const closeChatFile = useCallback((root: string, path: string) => {
    setChatFiles((f) => chatFileOps.close(f, root, path));
  }, []);
  const activateChatFile = useCallback((root: string, path: string) => {
    setChatPreview((p) => p && { ...p, front: false });
    setChatFiles((f) => chatFileOps.activate(f, root, path));
  }, []);
  const toggleRailSection = useCallback(
    (id: RailSection) => setRailCollapsed((c) => ({ ...c, [id]: !c[id] })),
    [],
  );
  const revealRailSection = useCallback((id: RailSection) => {
    setMode("chat");
    setFilePaneOpen(false);
    setChatPreview(null);
    setRail(true);
    setRailCollapsed((c) => ({ ...c, [id]: false }));
    setRailFocus({ id, nonce: Date.now() });
  }, []);
  const closeTab = useCallback((key: string) => setTabState((s) => tabOps.close(s, key)), []);
  const setActive = useCallback((key: string) => setTabState((s) => tabOps.activate(s, key)), []);
  const moveTab = useCallback(
    (key: string, group: Group, before?: string) => setTabState((s) => tabOps.move(s, key, group, before)),
    [],
  );
  const replaceTab = useCallback(
    (key: string, t: TabInput) => setTabState((s) => tabOps.replace(s, key, t)),
    [],
  );
  const splitTab = useCallback((key: string, at: Group) => setTabState((s) => tabOps.split(s, key, at)), []);
  const focusGroup = useCallback(
    (g: Group) => setTabState((s) => (s.focused === g || g >= s.activeIn.length ? s : { ...s, focused: g })),
    [],
  );
  const tabGroup = useCallback((key: string) => groupOf(tabState, key), [tabState]);

  const loadBuffer = useCallback(
    async (path: string) => {
      const ws = wsRef.current;
      if (!ws) throw new Error("No workspace open");
      const existing = buffers.get(path);
      if (existing) return existing;
      const f = await fs.read(ws.root, path);
      const b: Buffer = {
        path,
        saved: f.content,
        content: f.content,
        mtime: f.mtime,
        binary: f.binary,
        tooLarge: f.tooLarge,
      };
      buffers.set(path, b);
      setBufferVersion((v) => v + 1);
      return b;
    },
    [buffers],
  );

  const updateBuffer = useCallback(
    (path: string, content: string) => {
      const b = buffers.get(path);
      if (!b) return;
      const wasDirty = b.content !== b.saved;
      b.content = content;
      if (wasDirty !== (content !== b.saved)) setBufferVersion((v) => v + 1);
    },
    [buffers],
  );

  const saveBuffer = useCallback(
    async (path: string) => {
      const ws = wsRef.current;
      const b = buffers.get(path);
      if (!ws || !b) return;
      const content = b.content;
      const mtime = await fs.write(ws.root, path, content);
      b.saved = content;
      b.mtime = mtime;
      setBufferVersion((v) => v + 1);
    },
    [buffers],
  );

  const isDirty = useCallback(
    (path: string) => {
      const b = buffers.get(path);
      return !!b && b.content !== b.saved;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffers, bufferVersion],
  );

  const askAgent = useCallback((text: string) => {
    setAgentPanel(true);
    setAgentDraft({ text, nonce: Date.now() });
  }, []);

  const value: Store = {
    workspace,
    openWorkspace,
    closeWorkspace,
    tabs: tabState.tabs,
    tabGroup,
    groupCount: tabState.activeIn.length,
    focusedGroup: tabState.focused,
    focusGroup,
    activeIn: tabState.activeIn,
    active: tabState.activeIn[tabState.focused] ?? null,
    openTab,
    closeTab,
    replaceTab,
    splitTab,
    setActive,
    moveTab,
    buffers,
    bufferVersion,
    loadBuffer,
    updateBuffer,
    saveBuffer,
    isDirty,
    status,
    isRepo,
    refreshGit,
    fsVersion,
    reveal,
    revealInExplorer,
    mode,
    setMode,
    filePane,
    setFilePane,
    chatPreview,
    openChatPreview,
    closeChatPreview,
    closeChatPane,
    chatFiles,
    openChatFile,
    closeChatFile,
    activateChatFile,
    fileTree,
    setFileTree,
    rail,
    setRail,
    railCollapsed,
    toggleRailSection,
    revealRailSection,
    railFocus,
    projectFilter,
    setProjectFilter,
    draftFolder,
    setDraftFolder,
    side,
    setSide: showSide,
    bottom,
    setBottom: showBottom,
    agentPanel,
    setAgentPanel,
    agentDock,
    setAgentDock,
    sessionId,
    setSessionId,
    toasts,
    toast,
    holdToast,
    dismiss,
    attempt,
    agentDraft,
    askAgent,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStudio(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStudio outside StudioProvider");
  return v;
}

export function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function timeAgo(unixSeconds: number): string {
  const d = Date.now() / 1000 - unixSeconds;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
