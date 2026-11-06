import { useApp } from "@web/app-state";
import type { HarnessStatus } from "../ipc";
import { useStudio } from "../store";
import type { ProviderBalance } from "@harness/protocol";
import { useEffect, useRef, useState } from "react";
import { getZoom, onZoomChange, zoomReset } from "../zoom";
import { openGithubSettings, useGithubUser } from "../github-account";
import { IBranch, IDown, IGithub, IUp, IWarn } from "./icons";

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

const SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };
const money = (currency: string, n: number) =>
  `${SYMBOLS[currency] ?? ""}${n.toFixed(2)}${SYMBOLS[currency] ? "" : ` ${currency}`}`;
const LOW_BALANCE: Record<string, number> = { USD: 2, CNY: 14 };

/** Provider account balance (e.g. DeepSeek), like the terminal UI's: refreshed on start, after each run and every 5 min. */
function Balance({ model, projectPath, running }: { model?: string; projectPath?: string; running: number }) {
  const { client } = useApp();
  const provider = model?.split("/")[0] ?? "";
  const [state, setState] = useState<{
    provider: string;
    items: ProviderBalance[];
    start?: ProviderBalance[];
    error?: boolean;
  } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5 * 60_000);
    return () => clearInterval(id);
  }, []);
  // a run finishing changes the balance
  const prevRunning = useRef(running);
  useEffect(() => {
    if (running < prevRunning.current) setTick((t) => t + 1);
    prevRunning.current = running;
  }, [running]);

  useEffect(() => {
    if (!client) return;
    let live = true;
    client
      .balance({ model, projectPath })
      .then((r) => {
        if (!live) return;
        setState((prev) => {
          if (!r.items) return null;
          const same = prev?.provider === r.provider;
          return { provider: r.provider, items: r.items, start: same ? (prev?.start ?? r.items) : r.items };
        });
      })
      .catch(() => {
        if (live) setState((prev) => (prev && prev.provider === provider ? { ...prev, error: true } : null));
      });
    return () => {
      live = false;
    };
  }, [client, model, projectPath, provider, tick]);

  if (!state || (provider && state.provider !== provider)) return null;
  if (!state.items.length)
    return state.error ? <span className="st-sb muted">balance unavailable</span> : null;
  const main = state.items[0]!;
  const low = main.total < (LOW_BALANCE[main.currency] ?? 0);
  const details = [`${state.provider} account balance`];
  for (const item of state.items) {
    details.push(money(item.currency, item.total));
    const before = state.start?.find((x) => x.currency === item.currency)?.total;
    if (before !== undefined && before - item.total >= 0.005)
      details.push(`spent ${money(item.currency, before - item.total)} since the app started`);
  }
  if (main.granted !== undefined && main.toppedUp !== undefined && (main.granted > 0 || main.toppedUp > 0))
    details.push(
      `granted ${money(main.currency, main.granted)}`,
      `topped up ${money(main.currency, main.toppedUp)}`,
    );
  if (state.error) details.push("last refresh failed");
  return (
    <button
      className={`st-sb ${low ? "bad" : "muted"}`}
      title={details.join("\n")}
      onClick={() => setTick((t) => t + 1)}
    >
      Balance {state.items.map((i) => money(i.currency, i.total)).join(" · ")}
    </button>
  );
}

/** GitHub account: who git pushes and pull requests act as. Opens Settings → GitHub. */
function GithubAccount() {
  const user = useGithubUser();
  if (user === undefined) return null;
  return user ? (
    <button
      className="st-sb"
      onClick={openGithubSettings}
      title={`Signed in to GitHub as @${user.login}. Pushes and pull requests use this account.`}
    >
      {user.avatarUrl ? <img className="st-sb-avatar" src={user.avatarUrl} alt="" /> : <IGithub size={12} />}@
      {user.login}
    </button>
  ) : (
    <button
      className="st-sb warn"
      onClick={openGithubSettings}
      title="Sign in to push to GitHub and open pull requests"
    >
      <IGithub size={12} /> Sign in to GitHub
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
        <GithubAccount />
        {current?.model && <span className="st-sb muted">{current.model}</span>}
        <Balance
          model={current?.model}
          projectPath={current?.projectPath ?? st.workspace?.root}
          running={running}
        />
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
