import { useState } from "react";
import { basename, relativeTime, useApp } from "../app-state";
import { Composer, type PendingFile } from "./Composer";
import { EffortPicker, ModelPicker, ModePicker, PermissionPicker, ProjectPicker, type Mode } from "./Pickers";
import { CDRMark } from "./Brand";
import { IconFolder, IconCode, IconTerminal, IconFile, IconChevronRight } from "./icons";

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const SANDBOX_SUGGESTIONS = [
  "Create a snake game in the browser",
  "Build a pomodoro timer web app",
  "Write a Python script that renames photos by date",
  "Make an interactive chart of random data",
];
const PROJECT_SUGGESTIONS = [
  "Explain how this project is structured",
  "Find and fix the failing tests",
  "Add input validation and tests",
  "Review my uncommitted changes",
];

export function Home({ projectPath }: { projectPath?: string }) {
  const { client, settings, updateSettings, navigate, refreshSessions, rememberProject, sessions } = useApp();
  // "" = create a new sandbox workspace for this chat
  const [project, setProject] = useState(projectPath ?? "");
  const [mode, setMode] = useState<Mode>("chat");
  const [error, setError] = useState<string>();
  const [seed, setSeed] = useState<string>();

  const start = async (text: string, files: PendingFile[]) => {
    if (!client) return false;
    setError(undefined);
    try {
      const ref = settings.model;
      const info = await client.createSession({
        ...(project ? { projectPath: project } : { sandbox: { name: text.slice(0, 40) } }),
        // sandboxes are throwaway folders: let the agent edit freely unless the user chose full access
        permissionMode: !project && settings.permissionMode === "ask" ? "auto" : settings.permissionMode,
        reasoningEffort: settings.reasoningEffort,
        models: ref ? { executor: ref, planner: ref, reviewer: ref, summarizer: ref } : undefined,
      });
      if (project) rememberProject(info.projectPath);
      await client.send(info.id, text, {
        mode: mode === "chat" ? "chat" : "task",
        workflow: mode === "chat" ? undefined : mode,
        attachments: files.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
      });
      navigate({ name: "chat", id: info.id });
      void refreshSessions();
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const recent = [...sessions]
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .filter((s) => !s.projectMissing)
    .slice(0, 3);

  return (
    <div className="home">
      <div className="home-topline">
        <span>Your code. Your models. Your workspace.</span>
        <span className="local-badge">
          <span className="conn ok" /> Local workspace
        </span>
      </div>
      <div className="home-center">
        <div className="home-eyebrow">CODE. BUILD. SHIP.</div>
        <h1 className="greeting">
          <span className="greeting-mark" aria-hidden="true">
            <CDRMark size={42} />
          </span>
          {greeting()}
        </h1>
        <Composer
          draft={seed}
          large
          autoFocus
          placeholder="What would you like to build?"
          onSend={start}
          left={
            <>
              <ProjectPicker
                value={project}
                onChange={(p) => (
                  setProject(p),
                  updateSettings({ reasoningEffort: "auto" }),
                  setError(undefined)
                )}
              />
              <ModePicker value={mode} onChange={setMode} />
            </>
          }
          right={
            <>
              <ModelPicker
                value={settings.model}
                projectPath={project || undefined}
                onChange={(m) => updateSettings({ model: m, reasoningEffort: "auto" })}
              />
              <EffortPicker
                value={settings.reasoningEffort}
                model={settings.model}
                projectPath={project || undefined}
                onChange={(reasoningEffort) => updateSettings({ reasoningEffort })}
              />
              <PermissionPicker
                value={settings.permissionMode}
                onChange={(m) => updateSettings({ permissionMode: m })}
              />
            </>
          }
        />
        {error && <div className="home-error">{error}</div>}
        <div className="suggestions">
          {(project ? PROJECT_SUGGESTIONS : SANDBOX_SUGGESTIONS).map((t) => (
            <button key={t} className="chip" onClick={() => setSeed(t)}>
              {t.includes("script") || t.includes("tests") ? (
                <IconTerminal size={14} />
              ) : (
                <IconCode size={14} />
              )}{" "}
              {t}
            </button>
          ))}
        </div>
        <p className="composer-hint">Start something new, or choose a project to work with your files.</p>
        {recent.length > 0 && (
          <div className="recent">
            <div className="recent-head">
              <span>Pick up where you left off</span>
              <button className="ghost tiny" onClick={() => navigate({ name: "chats" })}>
                View all <IconChevronRight size={12} />
              </button>
            </div>
            <div className="recent-grid">
              {recent.map((s) => (
                <button
                  key={s.id}
                  className="recent-card"
                  onClick={() => navigate({ name: "chat", id: s.id })}
                >
                  <span className="recent-art">
                    <IconFile size={28} />
                    <span>{s.sandbox ? "EXPERIMENT" : "PROJECT"}</span>
                  </span>
                  <span className="recent-title">{s.title ?? "Untitled"}</span>
                  <span className="recent-sub">
                    <IconFolder size={12} /> {basename(s.projectPath)} ·{" "}
                    {relativeTime(s.updatedAt || s.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!recent.length && (
          <div className="first-step">
            <CDRMark size={20} />
            <div>
              <strong>Start with code. Finish with something real.</strong>
              <p>
                Build an app, explore a codebase, or work through a problem. Your conversations and creations
                will be right here.
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="home-footer">
        Code. Build. Ship.<span>CDR can make mistakes. Review changes before using them.</span>
      </div>
    </div>
  );
}
