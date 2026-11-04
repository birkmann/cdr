import { useApp } from "@web/app-state";
import type { HarnessStatus } from "../ipc";
import { useStudio } from "../store";
import { useEffect, useState } from "react";
import { getZoom, onZoomChange, zoomReset } from "../zoom";
import { IBranch, IDown, IUp, IWarn } from "./icons";

function ZoomIndicator() {
  const [zoom, setZoom] = useState(getZoom);
  useEffect(() => onZoomChange(setZoom), []);
  if (Math.abs(zoom - 1) < 0.001) return null;
  return (
    <button
      className="st-sb"
      onClick={() => void zoomReset()}
      title="Zoom (Ctrl+mouse wheel, Ctrl +/−). Click to reset to 100% (Ctrl+0)."
    >
      {Math.round(zoom * 100)}%
    </button>
  );
}

export function StatusBar({
  harnessStatus,
  onSettings,
}: {
  harnessStatus: HarnessStatus;
  onSettings(): void;
}) {
  const st = useStudio();
  const { sessions, connection } = useApp();
  const s = st.status;
  const running = sessions.filter((x) => x.status === "running" || x.status === "waiting").length;
  const current = sessions.find((x) => x.id === st.sessionId);
  return (
    <footer className="st-statusbar">
      <div className="st-row tight">
        {st.workspace && st.isRepo && s && (
          <button className="st-sb" onClick={() => st.setSide("git")} title="Source control">
            <IBranch size={12} /> {s.detached ? `(${s.head})` : s.branch}
            {s.behind > 0 && (
              <>
                {" "}
                <IDown size={11} />
                {s.behind}
              </>
            )}
            {s.ahead > 0 && (
              <>
                {" "}
                <IUp size={11} />
                {s.ahead}
              </>
            )}
          </button>
        )}
        {st.workspace && s && s.files.length > 0 && (
          <button className="st-sb" onClick={() => st.setSide("git")}>
            {s.files.length} changed
          </button>
        )}
        {st.workspace && (
          <button className="st-sb" onClick={() => st.setBottom("problems")} title="Problems">
            <IWarn size={12} /> Problems
          </button>
        )}
      </div>
      <div className="st-row tight">
        {running > 0 && (
          <button className="st-sb" onClick={() => st.setSide("agents")}>
            <span className="st-spin small" /> {running} agent{running > 1 ? "s" : ""} working
          </button>
        )}
        <ZoomIndicator />
        {current?.model && <span className="st-sb muted">{current.model}</span>}
        <button
          className={`st-sb ${harnessStatus.state === "failed" || connection === "offline" ? "bad" : ""}`}
          onClick={onSettings}
          title={harnessStatus.url ?? ""}
        >
          <span className={`conn ${connection === "ok" ? "ok" : connection === "offline" ? "bad" : ""}`} />{" "}
          Harness {harnessStatus.state === "attached" ? "(attached)" : connection === "ok" ? "" : connection}
        </button>
      </div>
    </footer>
  );
}
