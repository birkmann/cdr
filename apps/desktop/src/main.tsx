import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "@web/app-state";
import "@web/styles.css";
import "./studio.css";
import { harness, isTauri, on, type HarnessStatus } from "./ipc";
import { StudioProvider } from "./store";
import { installZoom } from "./zoom";
import { Shell } from "./components/Shell";
import { CDRMark } from "@web/components/Brand";

const SETTINGS_KEY = "harness.settings.v1";

/** The web components read their server and token from the web app's settings. */
function injectConnection(url: string, token: string) {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, server: url, token }));
  } catch {
    /* storage unavailable: AppProvider falls back to defaults */
  }
}

function Boot() {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    void harness.status().then(setStatus);
    return on<HarnessStatus>("harness://status", setStatus);
  }, []);
  const ready =
    status && (status.state === "ready" || status.state === "attached") && status.url && status.token;
  if (ready) injectConnection(status.url!, status.token!);

  if (!isTauri())
    return (
      <div className="st-boot">
        <CDRMark size={40} />
        <h1>CDR Studio</h1>
        <p>
          This interface runs inside the desktop app. Start it with <code>pnpm desktop:dev</code>.
        </p>
      </div>
    );
  if (!ready)
    return (
      <div className="st-boot">
        <CDRMark size={40} />
        <h1>CDR Studio</h1>
        {status?.state === "failed" ? (
          <>
            <p className="st-error">{status.error ?? "The harness server could not start."}</p>
            <div className="st-row">
              <button onClick={() => void harness.restart()}>Try again</button>
              <button className="ghost" onClick={() => void harness.logs().then(setLogs)}>
                Show log
              </button>
            </div>
            {logs.length > 0 && <pre className="st-log">{logs.join("\n")}</pre>}
          </>
        ) : (
          <p className="muted">
            {status?.state === "restarting" ? "Restarting the harness…" : "Starting the harness…"}
          </p>
        )}
      </div>
    );
  // Remount everything when the server (and its token) changes after a restart.
  return (
    <AppProvider key={status.token} origin="desktop">
      <StudioProvider>
        <Shell harnessStatus={status} />
      </StudioProvider>
    </AppProvider>
  );
}

installZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
