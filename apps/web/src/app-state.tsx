import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createClient,
  type HarnessClient,
  type SessionInfo,
  type ReasoningEffort,
  type SessionOrigin,
} from "@harness/client";
import { isTheme, type Theme } from "./themes";

export type PermissionMode = "ask" | "auto" | "yolo";

export interface Settings {
  reasoningEffort: ReasoningEffort;
  server: string; // "" = same origin
  token: string;
  name: string;
  permissionMode: PermissionMode;
  model: string; // "" = config default
  recentProjects: string[];
  /** Projects removed from the list; picking one again brings it back. */
  hiddenProjects: string[];
  /** AI-generated titles and summaries, cached per project path. */
  projectSummaries: Record<string, ProjectSummary>;
  theme: Theme;
  /** List conversations other tools ran unattended (goal runs, software-factory agents) next to your own. */
  showAutomated: boolean;
}

/**
 * A conversation no person started here: a goal's run, or one a tool created over the API (the software factory's
 * planners, judges and workers). Their output belongs to that tool, so lists hide them unless asked.
 */
export function isAutomated(s: SessionInfo): boolean {
  return s.origin === "api" || !!s.goalId;
}

export interface ProjectSummary {
  title: string;
  summary: string;
  /** When it was generated (ISO). */
  at: string;
  /** Conversation count at that time; a different count triggers a fresh summary. */
  conversations?: number;
}

const KEY = "harness.settings.v1";
const DEFAULTS: Settings = {
  reasoningEffort: "auto",
  server: "",
  token: "",
  name: "",
  permissionMode: "ask",
  model: "",
  recentProjects: [],
  hiddenProjects: [],
  projectSummaries: {},
  theme: "dark",
  showAutomated: false,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const settings = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    if (!["auto", "none", "low", "medium", "high", "max"].includes(settings.reasoningEffort))
      settings.reasoningEffort = "auto";
    if (!isTheme(settings.theme)) settings.theme = DEFAULTS.theme;
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

/** Pick up `#token=...&server=...` from the login link printed by `cdr serve`. */
function consumeHashLogin(s: Settings): Settings {
  const hash = window.location.hash.slice(1);
  if (!hash.includes("token=")) return s;
  const p = new URLSearchParams(hash);
  const next = { ...s, token: p.get("token") ?? s.token, server: p.get("server") ?? s.server };
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return next;
}

// ------------------------------------------------------------------ routing (history API)

export type Route =
  | { name: "home"; projectPath?: string }
  | { name: "chat"; id: string; preview?: boolean; history?: boolean }
  | { name: "projects" | "chats" | "artifacts" };

function parseRoute(): Route {
  const m = /^\/c\/([\w.-]+)/.exec(window.location.pathname);
  if (m) {
    const q = new URLSearchParams(window.location.search);
    return { name: "chat", id: m[1], preview: q.has("preview"), history: q.has("history") };
  }
  const name = window.location.pathname.slice(1);
  if (name === "projects" || name === "chats" || name === "artifacts") return { name };
  return {
    name: "home",
    projectPath: new URLSearchParams(window.location.search).get("project") || undefined,
  };
}

// ------------------------------------------------------------------ context

interface AppState {
  settings: Settings;
  /** Merge a patch, or a function computing one from the newest settings. */
  updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)): void;
  client: HarnessClient | null;
  connection: "unknown" | "ok" | "unauthorized" | "offline";
  sessions: SessionInfo[];
  /** True once the session list has been fetched at least once. */
  sessionsLoaded: boolean;
  refreshSessions(): Promise<void>;
  route: Route;
  navigate(route: Route): void;
  rememberProject(path: string): void;
  /** Remove a project from the list (its folder on disk is never touched). */
  forgetProject(path: string): void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({
  children,
  origin = "web",
}: {
  children: ReactNode;
  /** Recorded on conversations this app creates. */
  origin?: SessionOrigin;
}) {
  const [settings, setSettings] = useState<Settings>(() => {
    const s = consumeHashLogin(loadSettings());
    saveSettings(s);
    return s;
  });
  const [connection, setConnection] = useState<AppState["connection"]>("unknown");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [route, setRoute] = useState<Route>(parseRoute);

  const updateSettings = useCallback((patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => {
    setSettings((s) => {
      const next = { ...s, ...(typeof patch === "function" ? patch(s) : patch) };
      saveSettings(next);
      return next;
    });
  }, []);

  const client = useMemo(
    () =>
      settings.token
        ? createClient({ baseUrl: settings.server.replace(/\/$/, ""), token: settings.token, origin })
        : null,
    [settings.server, settings.token, origin],
  );

  const refreshSessions = useCallback(async () => {
    if (!client) {
      setConnection("unauthorized");
      return;
    }
    try {
      setSessions(await client.listSessions());
      setSessionsLoaded(true);
      setConnection("ok");
    } catch (e) {
      const status = (e as { status?: number }).status;
      setConnection(status === 401 ? "unauthorized" : "offline");
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
    const t = setInterval(() => void refreshSessions(), 5000);
    return () => clearInterval(t);
  }, [refreshSessions]);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        settings.theme === "system" ? (system.matches ? "dark" : "light") : settings.theme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    };
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [settings.theme]);

  const navigate = useCallback((r: Route) => {
    const path =
      r.name === "chat"
        ? `/c/${r.id}${r.preview ? "?preview=1" : r.history ? "?history=1" : ""}`
        : r.name === "home"
          ? r.projectPath
            ? `/?project=${encodeURIComponent(r.projectPath)}`
            : "/"
          : `/${r.name}`;
    if (window.location.pathname + window.location.search !== path) history.pushState(null, "", path);
    setRoute(r);
  }, []);

  const rememberProject = useCallback(
    (path: string) => {
      updateSettings((s) => ({
        recentProjects: [path, ...s.recentProjects.filter((p) => p !== path)].slice(0, 12),
        hiddenProjects: s.hiddenProjects.filter((p) => p !== path),
      }));
    },
    [updateSettings],
  );

  const forgetProject = useCallback(
    (path: string) => {
      updateSettings((s) => {
        const projectSummaries = { ...s.projectSummaries };
        delete projectSummaries[path];
        return {
          recentProjects: s.recentProjects.filter((p) => p !== path),
          hiddenProjects: [path, ...s.hiddenProjects.filter((p) => p !== path)].slice(0, 200),
          projectSummaries,
        };
      });
    },
    [updateSettings],
  );

  const value: AppState = {
    settings,
    updateSettings,
    client,
    connection,
    sessions,
    sessionsLoaded,
    refreshSessions,
    route,
    navigate,
    rememberProject,
    forgetProject,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Projects known from settings and from existing sessions, most recent first. */
export function useKnownProjects(): string[] {
  const { settings, sessions } = useApp();
  return useMemo(() => {
    const out: string[] = [];
    const live = sessions.filter((s) => !s.projectMissing && !s.sandbox).map((s) => s.projectPath);
    const sandboxes = new Set(sessions.filter((s) => s.sandbox).map((s) => s.projectPath));
    const hidden = new Set(settings.hiddenProjects);
    for (const p of [...settings.recentProjects, ...live])
      if (p && !out.includes(p) && !sandboxes.has(p) && !hidden.has(p)) out.push(p);
    return out;
  }, [settings.recentProjects, settings.hiddenProjects, sessions]);
}

export function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}
