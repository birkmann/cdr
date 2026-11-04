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
import { app, fs, git, on, type FsChange, type GitStatus, type Workspace } from "./ipc";

export type SideView = "files" | "search" | "git" | "agents" | "goals";
export type BottomView = "terminal" | "problems" | "output";

export type Tab =
  | { key: string; kind: "welcome" }
  | { key: string; kind: "file"; path: string; line?: number; column?: number }
  | { key: string; kind: "diff"; path: string; staged: boolean }
  | { key: string; kind: "commit"; id: string }
  | { key: string; kind: "history" }
  | { key: string; kind: "goal"; id: string }
  | { key: string; kind: "conflict"; path: string };

type TabInput = Tab extends infer T ? (T extends Tab ? Omit<T, "key"> : never) : never;

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
}

interface Store {
  workspace: Workspace | null;
  openWorkspace(path: string): Promise<void>;
  closeWorkspace(): void;
  tabs: Tab[];
  active: string | null;
  openTab(t: TabInput, opts?: { preview?: boolean }): void;
  closeTab(key: string): void;
  setActive(key: string): void;
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
  side: SideView | null;
  setSide(v: SideView | null): void;
  bottom: BottomView | null;
  setBottom(v: BottomView | null): void;
  agentPanel: boolean;
  setAgentPanel(v: boolean): void;
  sessionId: string | null;
  setSessionId(id: string | null): void;
  toasts: Toast[];
  toast(text: string, kind?: Toast["kind"]): void;
  dismiss(id: number): void;
  /** Run an async action, reporting failures as a toast. */
  attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined>;
  /** Text queued for the agent composer (from "Ask agent" actions). */
  agentDraft: { text: string; nonce: number } | null;
  askAgent(text: string): void;
}

const Ctx = createContext<Store | null>(null);
const LAYOUT_KEY = "morrow.studio.layout.v1";

function readLayout(): { side: SideView | null; bottom: BottomView | null; agentPanel: boolean } {
  try {
    return {
      side: "files",
      bottom: null,
      agentPanel: true,
      ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}"),
    };
  } catch {
    return { side: "files", bottom: null, agentPanel: true };
  }
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ key: "welcome", kind: "welcome" }]);
  const [active, setActiveKey] = useState<string | null>("welcome");
  const buffers = useRef(new Map<string, Buffer>()).current;
  const [bufferVersion, setBufferVersion] = useState(0);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [isRepo, setIsRepo] = useState(false);
  const [fsVersion, setFsVersion] = useState(0);
  const layout = useMemo(readLayout, []);
  const [side, setSide] = useState<SideView | null>(layout.side);
  const [bottom, setBottom] = useState<BottomView | null>(layout.bottom);
  const [agentPanel, setAgentPanel] = useState(layout.agentPanel);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [agentDraft, setAgentDraft] = useState<Store["agentDraft"]>(null);
  const toastId = useRef(0);
  const wsRef = useRef<Workspace | null>(null);
  wsRef.current = workspace;

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ side, bottom, agentPanel }));
    } catch {
      /* storage unavailable */
    }
  }, [side, bottom, agentPanel]);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
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
    async (path: string) => {
      const ws = await app.openWorkspace(path);
      const prev = wsRef.current;
      if (prev && prev.root !== ws.root) void fs.unwatch(prev.root).catch(() => {});
      buffers.clear();
      setBufferVersion((v) => v + 1);
      setTabs([{ key: "welcome", kind: "welcome" }]);
      setActiveKey("welcome");
      setSessionId(null);
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
    setTabs([{ key: "welcome", kind: "welcome" }]);
    setActiveKey("welcome");
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

  const openTab = useCallback((t: TabInput) => {
    const key = tabKey(t);
    setTabs((tabs) => {
      const i = tabs.findIndex((x) => x.key === key);
      const next = { ...t, key } as Tab;
      if (i >= 0) {
        const copy = [...tabs];
        copy[i] = next;
        return copy;
      }
      return [...tabs.filter((x) => x.kind !== "welcome"), next];
    });
    setActiveKey(key);
  }, []);

  const closeTab = useCallback((key: string) => {
    setTabs((tabs) => {
      const i = tabs.findIndex((t) => t.key === key);
      if (i < 0) return tabs;
      const next = tabs.filter((t) => t.key !== key);
      setActiveKey((a) => (a === key ? (next[Math.min(i, next.length - 1)]?.key ?? null) : a));
      return next.length ? next : [{ key: "welcome", kind: "welcome" }];
    });
  }, []);

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
    tabs,
    active,
    openTab,
    closeTab,
    setActive: setActiveKey,
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
    side,
    setSide,
    bottom,
    setBottom,
    agentPanel,
    setAgentPanel,
    sessionId,
    setSessionId,
    toasts,
    toast,
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
