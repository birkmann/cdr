import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useApp } from "@web/app-state";
import { useDialog } from "@web/components/CommandPalette";
import { THEMES } from "@web/themes";
import { app, github, harness, keys, type AppInfo, type GithubUser, type HarnessStatus } from "../ipc";
import { useStudio } from "../store";
import { IFile, IX } from "./icons";
import { fileIconName, iconUrl, setIconStyle, useIconStyle, type IconStyle } from "../fileIcons";

const PROVIDER_KEYS = [
  { name: "DEEPSEEK_API_KEY", label: "DeepSeek" },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter" },
  { name: "OLLAMA_API_KEY", label: "Ollama Cloud" },
  { name: "OPENAI_API_KEY", label: "OpenAI-compatible" },
  { name: "UNSPLASH_ACCESS_KEY", label: "Unsplash (photos)" },
];

type Section = "appearance" | "providers" | "github" | "harness" | "about";

export function SettingsDialog({
  onClose,
  harnessStatus,
}: {
  onClose(): void;
  harnessStatus: HarnessStatus;
}) {
  const ref = useDialog(onClose);
  const [section, setSection] = useState<Section>("appearance");
  return (
    <div className="st-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-modal st-settings" ref={ref} role="dialog" aria-label="Settings">
        <nav>
          <h2>Settings</h2>
          {(
            [
              ["appearance", "Appearance"],
              ["providers", "Model providers"],
              ["github", "GitHub"],
              ["harness", "Harness"],
              ["about", "About"],
            ] as [Section, string][]
          ).map(([id, label]) => (
            <button key={id} className={section === id ? "on" : ""} onClick={() => setSection(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="st-settings-body">
          <button className="ghost icon st-close" aria-label="Close settings" onClick={onClose}>
            <IX size={16} />
          </button>
          {section === "appearance" && <Appearance />}
          {section === "providers" && <Providers />}
          {section === "github" && <Github />}
          {section === "harness" && <HarnessSection status={harnessStatus} />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

function Appearance() {
  const { settings, updateSettings } = useApp();
  return (
    <>
      <h3>Theme</h3>
      <div className="st-themes">
        {THEMES.map((t) => (
          <button
            key={t.id}
            className={`st-theme ${settings.theme === t.id ? "on" : ""}`}
            onClick={() => updateSettings({ theme: t.id })}
          >
            <span className="st-swatches">
              {t.colors.map((c) => (
                <span key={c} style={{ background: c }} />
              ))}
            </span>
            <strong>{t.name}</strong>
            <span className="muted small">{t.description}</span>
          </button>
        ))}
      </div>
      <h3>File icons</h3>
      <IconStyleChoice />
      <h3>Your name</h3>
      <input
        className="st-input"
        value={settings.name}
        placeholder="Shown in greetings"
        onChange={(e) => updateSettings({ name: e.target.value })}
      />
    </>
  );
}

function IconStyleChoice() {
  const style = useIconStyle();
  const options: { id: IconStyle; name: string; desc: string; sample: string[] }[] = [
    {
      id: "colorful",
      name: "Colorful",
      desc: "Official file type icons, like VS Code",
      sample: ["index.html", "app.ts", "styles.css", "package.json"],
    },
    {
      id: "monochrome",
      name: "Monochrome",
      desc: "Simple outline icons",
      sample: ["index.html", "app.ts", "styles.css", "package.json"],
    },
  ];
  return (
    <div className="st-themes" role="radiogroup" aria-label="File icons">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={style === o.id}
          className={`st-theme ${style === o.id ? "on" : ""}`}
          onClick={() => setIconStyle(o.id)}
        >
          <span className="st-swatches">
            {o.sample.map((f) =>
              o.id === "colorful" ? (
                <img
                  key={f}
                  className="st-file-icon"
                  src={iconUrl(fileIconName(f))}
                  width={18}
                  height={18}
                  alt=""
                />
              ) : (
                <IFile key={f} size={18} />
              ),
            )}
          </span>
          <strong>{o.name}</strong>
          <span className="muted small">{o.desc}</span>
        </button>
      ))}
    </div>
  );
}

function Providers() {
  const st = useStudio();
  const [stored, setStored] = useState<{ name: string; backend: string }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState("");
  const load = () =>
    void keys
      .list()
      .then(setStored)
      .catch((e) => st.toast((e as Error).message, "error"));
  useEffect(load, []);
  const names = [
    ...PROVIDER_KEYS,
    ...stored
      .filter((s) => !PROVIDER_KEYS.some((p) => p.name === s.name))
      .map((s) => ({ name: s.name, label: s.name })),
  ];
  const save = async (name: string) => {
    const v = drafts[name]?.trim();
    if (!v) return;
    await st.attempt(() => keys.set(name, v), `${name} saved. The harness restarts to use it.`);
    setDrafts((d) => ({ ...d, [name]: "" }));
    load();
  };
  return (
    <>
      <h3>API keys</h3>
      <p className="muted small">
        Keys are stored in your system keychain{stored[0] ? ` (${stored[0].backend})` : ""} and passed only to
        the local harness process. Keys in a project <code>.env</code> or <code>~/.harness/.env</code> keep
        working and take precedence.
      </p>
      <div className="st-keys">
        {names.map((p) => {
          const has = stored.some((s) => s.name === p.name);
          return (
            <div key={p.name} className="st-key-row">
              <div>
                <strong>{p.label}</strong>
                <div className="muted small">
                  <code>{p.name}</code> {has && <span className="badge">stored</span>}
                </div>
              </div>
              <input
                className="st-input"
                type="password"
                autoComplete="off"
                placeholder={has ? "Replace key…" : "Paste key…"}
                value={drafts[p.name] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && void save(p.name)}
              />
              <button className="tiny" disabled={!drafts[p.name]?.trim()} onClick={() => void save(p.name)}>
                Save
              </button>
              {has && (
                <button
                  className="ghost tiny danger"
                  onClick={() => void st.attempt(() => keys.remove(p.name), `${p.name} removed`).then(load)}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="st-row">
        <input
          className="st-input"
          placeholder="Other variable name, e.g. MY_PROVIDER_KEY"
          value={custom}
          onChange={(e) => setCustom(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
        />
        <button
          className="ghost"
          disabled={!custom}
          onClick={() => {
            setDrafts((d) => ({ ...d, [custom]: "" }));
            setStored((s) =>
              s.some((x) => x.name === custom) ? s : [...s, { name: custom, backend: s[0]?.backend ?? "" }],
            );
            setCustom("");
          }}
        >
          Add
        </button>
      </div>
      <p className="muted small">
        Models and providers are configured in <code>cdr.config.json</code> or{" "}
        <code>~/.harness/config.json</code>.
      </p>
    </>
  );
}

function Github() {
  const st = useStudio();
  const [user, setUser] = useState<GithubUser | null | undefined>(undefined);
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<AppInfo>();
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);
  useEffect(() => {
    void github
      .status()
      .then(setUser)
      .catch(() => setUser(null));
    void app.info().then(setInfo);
  }, []);
  const deviceLogin = async () => {
    const d = await st.attempt(() => github.deviceStart());
    if (!d) return;
    setDevice(d);
    void openUrl(d.verificationUri);
    const deadline = Date.now() + d.expiresIn * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, d.interval * 1000));
      try {
        const u = await github.devicePoll(d.deviceCode);
        if (u) {
          setUser(u);
          setDevice(null);
          st.toast(`Signed in as ${u.login}`, "success");
          return;
        }
      } catch (e) {
        st.toast((e as Error).message, "error");
        break;
      }
    }
    setDevice(null);
  };
  if (user === undefined) return <p className="muted">Checking GitHub sign-in…</p>;
  return (
    <>
      <h3>GitHub</h3>
      {user ? (
        <div className="st-row">
          {user.avatarUrl && <img className="st-avatar" src={user.avatarUrl} alt="" />}
          <div className="st-grow">
            <strong>{user.name ?? user.login}</strong>
            <div className="muted small">@{user.login}</div>
          </div>
          <button
            className="ghost danger"
            onClick={() => void st.attempt(() => github.logout(), "Signed out").then(() => setUser(null))}
          >
            Sign out
          </button>
        </div>
      ) : (
        <>
          <p className="muted small">
            Sign in to list your repositories when cloning, open pull requests, and push over HTTPS. Pushing
            over SSH or with your own credential helper works without signing in.
          </p>
          {info?.githubClientId && (
            <button onClick={() => void deviceLogin()} disabled={!!device}>
              Sign in with browser
            </button>
          )}
          {device && (
            <p>
              Enter code <code className="st-code-big">{device.userCode}</code> at{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), void openUrl(device.verificationUri))}>
                {device.verificationUri}
              </a>
            </p>
          )}
          <button
            className="ghost"
            onClick={() => void st.attempt(() => github.importGh()).then((u) => u && setUser(u))}
          >
            Use GitHub CLI sign-in (gh)
          </button>
          <label className="st-field">
            Personal access token (repo scope)
            <div className="st-row">
              <input
                className="st-input"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… or github_pat_…"
              />
              <button
                disabled={!token.trim()}
                onClick={() =>
                  void st
                    .attempt(() => github.setToken(token))
                    .then((u) => {
                      if (u) {
                        setUser(u);
                        setToken("");
                        st.toast(`Signed in as ${u.login}`, "success");
                      }
                    })
                }
              >
                Save
              </button>
            </div>
          </label>
          <a
            href="#"
            className="small"
            onClick={(e) => (
              e.preventDefault(),
              void openUrl(
                "https://github.com/settings/tokens/new?scopes=repo,read:org&description=CDR%20Studio",
              )
            )}
          >
            Create a token on GitHub
          </a>
        </>
      )}
      <h3>Clone folder</h3>
      <div className="st-row">
        <code className="st-grow st-ellipsis">{info?.defaultCloneDir}</code>
        <button
          className="ghost"
          onClick={async () => {
            const d = await openDialog({ directory: true, title: "Default clone folder" });
            if (typeof d === "string") {
              await st.attempt(() => app.setCloneDir(d));
              setInfo(await app.info());
            }
          }}
        >
          Change…
        </button>
      </div>
    </>
  );
}

function HarnessSection({ status }: { status: HarnessStatus }) {
  const [logs, setLogs] = useState<string[]>([]);
  return (
    <>
      <h3>Harness server</h3>
      <dl className="st-dl">
        <dt>State</dt>
        <dd>{status.state}</dd>
        <dt>Address</dt>
        <dd>{status.url ?? "—"}</dd>
        <dt>Node.js</dt>
        <dd className="st-ellipsis">
          {status.node ?? (status.state === "attached" ? "external server" : "—")}
        </dd>
        <dt>Harness</dt>
        <dd className="st-ellipsis">{status.entry ?? "—"}</dd>
        <dt>Restarts</dt>
        <dd>{status.restarts}</dd>
      </dl>
      <p className="muted small">
        The harness runs agents, tools, workflows, and goals. It listens on 127.0.0.1 with a token generated
        at every launch.
      </p>
      <div className="st-row">
        <button onClick={() => void harness.restart()}>Restart harness</button>
        <button className="ghost" onClick={() => void harness.logs().then(setLogs)}>
          Show log
        </button>
      </div>
      {logs.length > 0 && <pre className="st-log">{logs.join("\n")}</pre>}
    </>
  );
}

function About() {
  const [info, setInfo] = useState<AppInfo>();
  useEffect(() => void app.info().then(setInfo), []);
  return (
    <>
      <h3>CDR Studio {info?.version}</h3>
      <p className="muted">
        A desktop coding workspace built on the CDR harness: editor, Git client, terminals, agents, subagents,
        and goals.
      </p>
      <dl className="st-dl">
        <dt>Platform</dt>
        <dd>{info?.platform}</dd>
        <dt>Settings</dt>
        <dd className="st-ellipsis">{info?.configDir}</dd>
      </dl>
    </>
  );
}
