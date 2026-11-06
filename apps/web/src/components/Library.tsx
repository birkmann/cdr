import { useEffect, useMemo, useRef, useState } from "react";
import { basename, relativeTime, useApp, useKnownProjects } from "../app-state";
import { IconCode, IconFile, IconFolder, IconPlus, IconSearch, IconChevronRight } from "./icons";
import { ProjectPicker } from "./Pickers";
import { CopyButton } from "./History";
import {
  ProjectCard,
  ProjectsGuide,
  RemoveProjectDialog,
  useProjectConversations,
  useProjectSummaries,
} from "./Projects";

export function Library({ kind }: { kind: "projects" | "chats" | "artifacts" }) {
  const { client, sessions, navigate, rememberProject } = useApp();
  const projects = useKnownProjects();
  const [query, setQuery] = useState("");
  const projectSummaries = useProjectSummaries(kind === "projects" ? projects : []);
  const conversationCounts = useProjectConversations();
  const [removing, setRemoving] = useState<string>();
  const projectText = (path: string) => {
    const s = projectSummaries.summaries[path];
    return `${path} ${s?.title ?? ""} ${s?.summary ?? ""}`;
  };
  const [artifacts, setArtifacts] = useState<
    { sessionId: string; path: string; title: string; time: string; url?: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sessionsDir, setSessionsDir] = useState<string>();
  useEffect(() => {
    if (kind !== "chats" || !client) return;
    let cancelled = false;
    client
      .storage()
      .then((s) => !cancelled && setSessionsDir(s.sessionsDir))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, kind]);
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
              url: detail.previewBase ? client.previewUrl(detail.previewBase, path) : undefined,
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
      ? "A project is a folder CDR works in. Each card says what it's about, so you can pick up where you left off."
      : kind === "artifacts"
        ? "The things you've made, ready for another look. From your 40 most recent conversations."
        : "Good ideas have a history. Find yours here.";
  const count =
    kind === "projects"
      ? projects.filter((p) => matches(projectText(p))).length
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
      {kind === "projects" && <ProjectsGuide />}
      {kind === "chats" && sessionsDir && (
        <div className="storage-note">
          <span className="muted small">Stored on this machine, one JSONL file per conversation, in</span>
          <code title={sessionsDir}>{sessionsDir}</code>
          <CopyButton text={sessionsDir} label="Copy folder path" />
        </div>
      )}
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
          projects
            .filter((p) => matches(projectText(p)))
            .map((path) => (
              <ProjectCard
                key={path}
                path={path}
                summary={projectSummaries.summaries[path]}
                generating={projectSummaries.pending.has(path)}
                missing={projectSummaries.missing.has(path)}
                conversations={conversationCounts.get(path) ?? 0}
                onOpen={() => navigate({ name: "home", projectPath: path })}
                onRegenerate={() => projectSummaries.regenerate(path)}
                onRemove={() => setRemoving(path)}
              />
            ))}
        {kind === "chats" &&
          chats
            .filter((s) => matches(`${s.title} ${s.projectPath}`))
            .map((s) => (
              <div className="conversation-row" key={s.id}>
                <button
                  className="library-card"
                  disabled={s.projectMissing}
                  onClick={() => navigate({ name: "chat", id: s.id })}
                >
                  <IconFile size={20} />
                  <div>
                    <strong>{s.title || "Untitled conversation"}</strong>
                    <span className="muted small">
                      {s.projectMissing ? "Project folder unavailable" : basename(s.projectPath)}
                      {sessionsDir && <> · {s.id}.jsonl</>}
                    </span>
                  </div>
                  <time>{relativeTime(s.updatedAt || s.createdAt)}</time>
                  <IconChevronRight size={14} />
                </button>
                <button
                  className="secondary conversation-inspect"
                  disabled={s.projectMissing}
                  aria-label={`Inspect the stored log of ${s.title || "this conversation"}`}
                  title="Open its stored log and the files it used"
                  onClick={() => navigate({ name: "chat", id: s.id, history: true })}
                >
                  Inspect
                </button>
              </div>
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
                <CreationThumb url={a.url} path={a.path} />
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
      {removing && (
        <RemoveProjectDialog
          path={removing}
          title={projectSummaries.summaries[removing]?.title || basename(removing)}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </section>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
/** Desktop-sized viewport the page is laid out at before being scaled into the card. */
const THUMB_VIEWPORT = { width: 1280, height: 800 };

/**
 * Scaled-down live render of a creation. Loaded only once the card scrolls into view, sandboxed (opaque origin,
 * no access to the app's token) and inert (no pointer events, not focusable), so the card stays one button.
 */
function CreationThumb({ url, path }: { url?: string; path: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [scale, setScale] = useState(0.2);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !url) return;
    const fit = () => setScale(el.clientWidth / THUMB_VIEWPORT.width || 0.2);
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(el);
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          seen.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    seen.observe(el);
    return () => {
      resize.disconnect();
      seen.disconnect();
    };
  }, [url]);
  const showFrame = url && visible && !failed;
  return (
    <span ref={ref} className={`creation-cover ${showFrame && loaded ? "has-thumb" : ""}`}>
      {showFrame &&
        (IMAGE_EXT.test(path) ? (
          <img
            className="creation-thumb-img"
            src={url}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <iframe
            className="creation-thumb"
            src={url}
            title={`Preview of ${path}`}
            tabIndex={-1}
            aria-hidden="true"
            loading="lazy"
            // opaque origin: the generated code cannot read the app's token or storage
            sandbox="allow-scripts"
            style={{
              width: THUMB_VIEWPORT.width,
              height: THUMB_VIEWPORT.height,
              transform: `scale(${scale})`,
            }}
            onLoad={() => setLoaded(true)}
          />
        ))}
      {!(showFrame && loaded) && (
        <span className="creation-placeholder">
          <IconCode size={40} />
          <span>{path}</span>
        </span>
      )}
    </span>
  );
}
