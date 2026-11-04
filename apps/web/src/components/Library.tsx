import { useEffect, useMemo, useState } from "react";
import { basename, relativeTime, useApp, useKnownProjects } from "../app-state";
import { IconCode, IconFile, IconFolder, IconPlus, IconSearch, IconChevronRight } from "./icons";
import { ProjectPicker } from "./Pickers";

export function Library({ kind }: { kind: "projects" | "chats" | "artifacts" }) {
  const { client, sessions, navigate, rememberProject } = useApp();
  const projects = useKnownProjects();
  const [query, setQuery] = useState("");
  const [artifacts, setArtifacts] = useState<
    { sessionId: string; path: string; title: string; time: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sessionKey = sessions.map((s) => `${s.id}:${s.lastSeq}`).join(",");
  useEffect(() => {
    if (kind !== "artifacts" || !client) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    // Read saved preview events, not guessed filenames or placeholder creations.
    const recent = [...sessions]
      .filter((s) => !s.projectMissing)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
      .slice(0, 40);
    void (async () => {
      const found: typeof artifacts = [];
      let failures = 0;
      // Bound concurrency for larger session libraries.
      for (let i = 0; i < recent.length; i += 4) {
        const batch = await Promise.allSettled(
          recent.slice(i, i + 4).map(async (s) => {
            const detail = await client.getSession(s.id, { events: true });
            const previews = new Map<string, string>();
            for (const e of detail.events ?? [])
              if (e.type === "preview.ready") previews.set(e.path, e.title || basename(e.path));
            return [...previews].map(([path, title]) => ({
              sessionId: s.id,
              path,
              title,
              time: s.updatedAt || s.createdAt,
            }));
          }),
        );
        if (cancelled) return;
        for (const item of batch)
          if (item.status === "fulfilled") found.push(...item.value);
          else failures++;
      }
      setArtifacts(found);
      setLoading(false);
      if (failures)
        setError(
          `Couldn't load creations from ${failures} conversations. Try again when the server is available.`,
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [client, kind, sessionKey]);
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const chats = useMemo(
    () =>
      [...sessions].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt)),
    [sessions],
  );
  const title =
    kind === "projects" ? "Your projects" : kind === "artifacts" ? "Your creations" : "Conversations";
  const subtitle =
    kind === "projects"
      ? "A little context goes a long way. Pick a workspace and keep building."
      : kind === "artifacts"
        ? "The things you've made, ready for another look. From your 40 most recent conversations."
        : "Good ideas have a history. Find yours here.";
  const count =
    kind === "projects"
      ? projects.filter(matches).length
      : kind === "artifacts"
        ? artifacts.filter((a) => matches(`${a.title} ${a.path}`)).length
        : chats.filter((s) => matches(`${s.title} ${s.projectPath}`)).length;
  return (
    <section className="library">
      <div className="library-head">
        <div>
          <div className="eyebrow">YOUR WORKSPACE</div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {kind === "projects" ? (
          <ProjectPicker
            value=""
            onChange={(path) => {
              if (path) rememberProject(path);
              navigate({ name: "home", projectPath: path });
            }}
          />
        ) : (
          <button className="secondary" onClick={() => navigate({ name: "home" })}>
            <IconPlus /> New chat
          </button>
        )}
      </div>
      <label className="library-search">
        <IconSearch />
        <input
          aria-label={`Search ${title.toLowerCase()}`}
          placeholder={`Search ${title.toLowerCase()}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading && (
        <div className="muted pad" role="status">
          Finding your creations…
        </div>
      )}
      <div className={`library-grid ${kind === "chats" ? "conversation-list" : ""}`}>
        {kind === "projects" &&
          projects.filter(matches).map((path) => (
            <button
              className="library-card"
              key={path}
              onClick={() => navigate({ name: "home", projectPath: path })}
            >
              <span className="library-icon">
                <IconFolder size={24} />
              </span>
              <strong>{basename(path)}</strong>
              <span className="muted small path">{path}</span>
              <span className="card-bottom">
                {sessions.filter((s) => s.projectPath === path).length} conversations{" "}
                <IconChevronRight size={14} />
              </span>
            </button>
          ))}
        {kind === "chats" &&
          chats
            .filter((s) => matches(`${s.title} ${s.projectPath}`))
            .map((s) => (
              <button
                className="library-card"
                disabled={s.projectMissing}
                key={s.id}
                onClick={() => navigate({ name: "chat", id: s.id })}
              >
                <IconFile size={20} />
                <div>
                  <strong>{s.title || "Untitled conversation"}</strong>
                  <span className="muted small">
                    {s.projectMissing ? "Project folder unavailable" : basename(s.projectPath)}
                  </span>
                </div>
                <time>{relativeTime(s.updatedAt || s.createdAt)}</time>
                <IconChevronRight size={14} />
              </button>
            ))}
        {kind === "artifacts" &&
          artifacts
            .filter((a) => matches(`${a.title} ${a.path}`))
            .map((a) => (
              <button
                key={`${a.sessionId}:${a.path}`}
                className="library-card creation-card"
                onClick={() => navigate({ name: "chat", id: a.sessionId, preview: true })}
              >
                <span className="creation-cover">
                  <IconCode size={40} />
                  <span>{a.path}</span>
                </span>
                <strong>{a.title}</strong>
                <span className="muted small">{relativeTime(a.time)} · Open conversation & preview</span>
              </button>
            ))}
      </div>
      {!loading && !count && (
        <div className="library-empty">
          <IconFolder size={32} />
          <h2>
            {query
              ? "Nothing found just yet"
              : kind === "artifacts"
                ? "Your next creation starts with an idea"
                : "Room for something new"}
          </h2>
          <p>
            {query
              ? "Try a different name or project path."
              : kind === "artifacts"
                ? "Ask CDR to build a page or an app. Saved previews appear here."
                : "Start a conversation or choose a project folder to get going."}
          </p>
          <button className="secondary" onClick={() => navigate({ name: "home" })}>
            <IconPlus /> Start a conversation
          </button>
        </div>
      )}
    </section>
  );
}
