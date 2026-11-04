import { useState } from "react";
import { useApp, type PermissionMode } from "../app-state";
import { CDRMark } from "./Brand";
import { useDialog } from "./CommandPalette";
import { IconX } from "./icons";
import { THEMES } from "../themes";

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const { settings, updateSettings, connection, refreshSessions } = useApp();
  const dialog = useDialog(onClose);
  const [draft, setDraft] = useState(settings);
  const save = () => {
    updateSettings({
      server: draft.server.trim(),
      token: draft.token.trim(),
      name: draft.name.trim(),
      theme: draft.theme,
      permissionMode: draft.permissionMode,
    });
    setTimeout(() => void refreshSessions(), 0);
    onClose();
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Settings" aria-modal="true" ref={dialog}>
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="ghost icon" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        <div className="form">
          <fieldset className="appearance">
            <legend>Appearance</legend>
            <p className="muted small">Make yourself at home. Themes apply immediately.</p>
            <div className="theme-grid">
              {THEMES.map((theme) => (
                <label className="theme-choice" key={theme.id}>
                  <input
                    type="radio"
                    name="theme"
                    value={theme.id}
                    checked={draft.theme === theme.id}
                    onChange={() => {
                      setDraft({ ...draft, theme: theme.id });
                      updateSettings({ theme: theme.id });
                    }}
                  />
                  <span className="theme-swatches" aria-hidden="true">
                    {theme.colors.map((color) => (
                      <i key={color} style={{ background: color }} />
                    ))}
                  </span>
                  <strong>{theme.name}</strong>
                  <small>{theme.description}</small>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Your name <span className="muted">(for the greeting)</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Default permissions for new chats
            <select
              value={draft.permissionMode}
              onChange={(e) => setDraft({ ...draft, permissionMode: e.target.value as PermissionMode })}
            >
              <option value="ask">Ask before edits and commands</option>
              <option value="auto">Auto – ask only for risky commands</option>
              <option value="yolo">Full access</option>
            </select>
          </label>
          <label>
            Server URL <span className="muted">(empty = this page's server)</span>
            <input
              value={draft.server}
              placeholder="http://127.0.0.1:8787"
              onChange={(e) => setDraft({ ...draft, server: e.target.value })}
            />
          </label>
          <label>
            Access token{" "}
            <span className="muted">(printed by `cdr serve`, stored in ~/.harness/server-token)</span>
            <input
              type="password"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
            />
          </label>
          <div className="muted small">
            Connection: <b>{connection}</b>
          </div>
        </div>
        <div className="modal-foot">
          <span />
          <button onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

export function ConnectScreen() {
  const { settings, updateSettings, connection, refreshSessions } = useApp();
  const [token, setToken] = useState("");
  const [server, setServer] = useState(settings.server);
  return (
    <div className="connect">
      <div className="connect-card">
        <div className="brand big">
          <CDRMark size={36} /> CDR
        </div>
        {connection === "offline" ? (
          <p>
            Can't reach the cdr server{settings.server ? ` at ${settings.server}` : ""}. Start it with{" "}
            <code>cdr serve</code>.
          </p>
        ) : (
          <p>
            Open the link printed by <code>cdr serve</code>, or paste the token from{" "}
            <code>~/.harness/server-token</code>.
          </p>
        )}
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            updateSettings({ token: token.trim() || settings.token, server: server.trim() });
            setTimeout(() => void refreshSessions(), 0);
          }}
        >
          <label>
            Access token
            <input
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste token"
            />
          </label>
          <label>
            Server URL <span className="muted">(optional)</span>
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="same as this page"
            />
          </label>
          <button type="submit">Connect</button>
          {connection === "unauthorized" && settings.token && (
            <div className="error small">That token was rejected.</div>
          )}
        </form>
      </div>
    </div>
  );
}
