import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AvailableModels,
  BrowseResponse,
  ModelDetail,
  ModelListEntry,
  ReasoningEffort,
} from "@harness/client";
import { basename, useApp, useKnownProjects, type PermissionMode } from "../app-state";
import { IconCheck, IconChevron, IconFolder, IconGit, IconSparkle, IconUp, IconX } from "./icons";

export function Popover({
  label,
  title,
  children,
  align = "left",
  className = "",
  disabled,
}: {
  label: ReactNode;
  title?: string;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`popover-wrap ${className}`} ref={ref}>
      <button
        type="button"
        className="pill"
        title={title}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      >
        {label}
        <IconChevron size={13} />
      </button>
      {open && <div className={`popover ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

function Option({
  active,
  onClick,
  title,
  desc,
}: {
  active?: boolean;
  onClick(): void;
  title: ReactNode;
  desc?: ReactNode;
}) {
  return (
    <button type="button" className={`option ${active ? "active" : ""}`} onClick={onClick}>
      <span className="option-check">{active && <IconCheck size={14} />}</span>
      <span className="option-body">
        <span className="option-title">{title}</span>
        {desc && <span className="option-desc">{desc}</span>}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ project

export function ProjectPicker({ value, onChange }: { value: string; onChange(p: string): void }) {
  const projects = useKnownProjects();
  const [browsing, setBrowsing] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <>
      <Popover
        title={value || "A new sandbox folder is created for this chat"}
        label={
          <>
            {value ? <IconFolder size={14} /> : <IconSparkle size={14} />}
            <span className="pill-text">{value ? basename(value) : "New sandbox"}</span>
          </>
        }
      >
        {(close) => (
          <div className="picker">
            <div className="picker-head">Where should the agent work?</div>
            <Option
              active={!value}
              title={
                <>
                  <IconSparkle size={13} /> New sandbox
                </>
              }
              desc="Fresh empty folder in ~/.harness/sandboxes – for new apps, games, experiments"
              onClick={() => {
                onChange("");
                close();
              }}
            />
            {projects.length > 0 && <div className="group-head">Existing projects</div>}
            <div className="picker-list">
              {projects.map((p) => (
                <Option
                  key={p}
                  active={p === value}
                  title={basename(p)}
                  desc={p}
                  onClick={() => {
                    onChange(p);
                    close();
                  }}
                />
              ))}
            </div>
            <div className="picker-foot">
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typed.trim()) {
                    onChange(typed.trim());
                    setTyped("");
                    close();
                  }
                }}
              >
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="/path/to/project"
                />
                <button type="submit" className="secondary" disabled={!typed.trim()}>
                  Use
                </button>
              </form>
              <button
                type="button"
                className="secondary wide"
                onClick={() => {
                  close();
                  setBrowsing(true);
                }}
              >
                <IconFolder size={14} /> Browse folders…
              </button>
            </div>
          </div>
        )}
      </Popover>
      {browsing && (
        <DirBrowser
          start={value}
          onClose={() => setBrowsing(false)}
          onPick={(p) => {
            onChange(p);
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}

export function DirBrowser({
  start,
  onClose,
  onPick,
}: {
  start?: string;
  onClose(): void;
  onPick(p: string): void;
}) {
  const { client } = useApp();
  const [data, setData] = useState<BrowseResponse>();
  const [err, setErr] = useState<string>();
  const load = (path?: string) =>
    client
      ?.browse(path)
      .then((d) => (setData(d), setErr(undefined)))
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    void load(start || undefined)?.catch(() => load());
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Choose a project folder">
        <div className="modal-head">
          <h3>Choose a project folder</h3>
          <button className="ghost icon" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        {data && (
          <div className="crumbs">
            <button
              className="ghost tiny"
              disabled={!data.parent}
              onClick={() => data.parent && load(data.parent)}
              aria-label="Up"
            >
              <IconUp size={14} />
            </button>
            <code>{data.path}</code>
          </div>
        )}
        {err && <div className="error pad">{err}</div>}
        <div className="dir-list">
          {data?.dirs.length === 0 && <div className="muted pad">No sub-folders.</div>}
          {data?.dirs.map((d) => (
            <button
              key={d.path}
              className="dir"
              onClick={() => load(d.path)}
              onDoubleClick={() => onPick(d.path)}
            >
              <IconFolder size={15} /> <span>{d.name}</span>
              {d.isGit && (
                <span className="badge">
                  <IconGit size={12} /> git
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="modal-foot">
          <span className="muted">Click to open, double-click to choose.</span>
          <button disabled={!data} onClick={() => data && onPick(data.path)}>
            Use {data ? basename(data.path) : "this folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ model

export function ModelPicker({
  value,
  defaultLabel,
  onChange,
  projectPath,
  disabled,
}: {
  value: string;
  defaultLabel?: string;
  onChange(ref: string): void;
  projectPath?: string;
  disabled?: boolean;
}) {
  const { client } = useApp();
  const [configuredDefault, setConfiguredDefault] = useState("");
  useEffect(() => {
    let live = true;
    setConfiguredDefault("");
    if (!client || defaultLabel) return;
    void client
      .models(projectPath)
      .then((r) => {
        if (live) setConfiguredDefault(r.models.find((m) => m.role === "executor")?.id || "");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, projectPath, defaultLabel]);
  const shown = value || defaultLabel || configuredDefault || "Choose model";
  return (
    <Popover
      className="pick-model"
      align="right"
      disabled={disabled}
      title={`Model: ${shown}`}
      label={<span className="pill-text">{shown.split("/").slice(1).join("/") || shown}</span>}
    >
      {(close) => (
        <ModelMenu
          value={value}
          defaultLabel={defaultLabel || configuredDefault}
          projectPath={projectPath}
          onPick={(ref) => {
            onChange(ref);
            close();
          }}
        />
      )}
    </Popover>
  );
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  auto: "Default",
  none: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};
const EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  auto: "Use the provider’s default thinking behavior",
  none: "Respond without extended thinking",
  low: "Less thinking for quicker responses",
  medium: "Balance depth and response time",
  high: "More thinking for complex tasks",
  max: "Most thinking; may take longer and use more tokens",
};

export function EffortPicker({
  value,
  model,
  projectPath,
  disabled,
  onChange,
}: {
  value: ReasoningEffort;
  model: string;
  projectPath?: string;
  disabled?: boolean;
  onChange(value: ReasoningEffort): void;
}) {
  const { client } = useApp();
  const [options, setOptions] = useState<ReasoningEffort[]>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    setOptions(undefined);
    setError(false);
    client
      ?.models(projectPath, model)
      .then((r) => {
        if (live) setOptions(r.reasoningEfforts ?? []);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [client, model, projectPath]);
  const selected = !options || value === "auto" || options.includes(value) ? value : "auto";
  return (
    <Popover
      className="pick-effort"
      align="right"
      disabled={disabled}
      title="Thinking effort"
      label={
        <span className="pill-text">
          <span className="effort-prefix">Thinking: </span>
          {EFFORT_LABELS[selected]}
        </span>
      }
    >
      {(close) => (
        <div className="picker">
          <div className="picker-head">Thinking effort</div>
          <p className="muted small pad-x">
            Higher effort can improve complex answers, but takes longer and uses more tokens.
          </p>
          {error ? (
            <div className="muted pad">Could not load model options.</div>
          ) : !options ? (
            <div className="muted pad">Loading options…</div>
          ) : (
            <>
              {(["auto", ...options] as ReasoningEffort[]).map((effort) => (
                <Option
                  key={effort}
                  title={EFFORT_LABELS[effort]}
                  desc={EFFORT_DESCRIPTIONS[effort]}
                  active={selected === effort}
                  onClick={() => {
                    onChange(effort);
                    close();
                  }}
                />
              ))}
              {!options.length && (
                <div className="muted pad small">This model does not expose an effort control in CDR.</div>
              )}
            </>
          )}
        </div>
      )}
    </Popover>
  );
}

/** Configured models (from the role settings) as provider groups, before full discovery answers. */
function groupConfigured(models: ModelListEntry[]): Record<string, AvailableModels> {
  const groups: Record<string, AvailableModels> = {};
  for (const m of models) {
    const entry = (groups[m.provider] ??= { models: [] });
    const name = m.id.slice(m.provider.length + 1);
    if (!entry.models.includes(name)) entry.models.push(name);
    if (!m.configured) entry.error = "Provider needs configuration";
  }
  return groups;
}

/** Context size as providers advertise it: 128000 is "128K", 262144 is "256K", 1000000 is "1M". */
export function contextLabel(tokens: number): string {
  const short = (n: number, unit: number, suffix: string) => {
    const v = n / unit;
    return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
  };
  // Powers of two (32768, 131072, 262144) are binary sizes; everything else is decimal.
  const binary = tokens >= 1024 && tokens % 1024 === 0;
  if (tokens >= 1_000_000) return `${short(tokens, binary ? 1024 * 1024 : 1_000_000, "M")} context`;
  if (tokens >= 1000) return `${short(tokens, binary ? 1024 : 1000, "K")} context`;
  return `${tokens} context`;
}

/** Discovery answers per project, so reopening the picker does not contact every provider again. */
const discovered = new Map<string, Record<string, AvailableModels>>();

/** Discovered providers win; configured ones that discovery skips (no model listing, not configured) stay. */
function mergeModels(
  configured: Record<string, AvailableModels> | undefined,
  found: Record<string, AvailableModels> | undefined,
): Record<string, AvailableModels> | undefined {
  if (!configured && !found) return undefined;
  return { ...configured, ...found };
}

/** Capability badges for one model: vision, tools, thinking and context size, when known. */
function ModelBadges({ detail }: { detail?: ModelDetail }) {
  const caps = detail?.capabilities ?? [];
  const items: ReactNode[] = [];
  if (caps.includes("vision"))
    items.push(
      <span key="vision" className="cap vision">
        vision
      </span>,
    );
  if (caps.includes("tools"))
    items.push(
      <span key="tools" className="cap">
        tools
      </span>,
    );
  if (caps.includes("thinking"))
    items.push(
      <span key="thinking" className="cap">
        thinking
      </span>,
    );
  if (detail?.contextWindow)
    items.push(
      <span key="context" className="cap quiet">
        {contextLabel(detail.contextWindow)}
      </span>,
    );
  return items.length ? <span className="cap-list">{items}</span> : null;
}

function ModelMenu({
  value,
  defaultLabel,
  projectPath,
  onPick,
}: {
  value: string;
  defaultLabel?: string;
  projectPath?: string;
  onPick(ref: string): void;
}) {
  const { client } = useApp();
  const key = projectPath ?? "";
  const [configured, setConfigured] = useState<Record<string, AvailableModels>>();
  const [found, setFound] = useState<Record<string, AvailableModels> | undefined>(() => discovered.get(key));
  const available = mergeModels(configured, found);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  // Only the latest request may update the list, so a slow answer cannot overwrite a newer one.
  const latest = useRef(0);
  const refresh = () => {
    if (!client) return;
    const mine = ++latest.current;
    setLoading(true);
    setFailed(false);
    client
      .availableModels(projectPath)
      .then((r) => {
        discovered.set(key, r);
        if (mine === latest.current) setFound(r);
      })
      .catch(() => {
        if (mine === latest.current) setFailed(true);
      })
      .finally(() => {
        if (mine === latest.current) setLoading(false);
      });
  };
  useEffect(() => {
    if (!client) return;
    let live = true;
    latest.current++; // an answer still in flight for the previous project must not land here
    setLoading(false);
    setFailed(false);
    // A different project has different models: drop the old list instead of showing it until the new one answers.
    setConfigured(undefined);
    setFound(discovered.get(key));
    // Configured models show straight away; discovery (with capabilities) adds to them. Discovery contacts every
    // provider, so it runs once per project; the Refresh button runs it again.
    void client
      .models(projectPath)
      .then((r) => live && setConfigured(groupConfigured(r.models)))
      .catch(() => {});
    if (!discovered.has(key)) refresh();
    return () => {
      live = false;
    };
    // refresh is recreated each render; it only needs to run when the client or project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectPath]);
  const f = filter.trim().toLowerCase();
  const groups = Object.entries(available ?? {}).flatMap(([provider, entry]) => {
    const byId = new Map((entry.details ?? []).map((d) => [d.id, d]));
    const models = entry.models.flatMap((name) => {
      const detail = byId.get(name);
      const caps = detail?.capabilities ?? [];
      // Embedding-only models cannot chat, so they are not offered.
      if (caps.includes("embedding")) return [];
      const searchable = `${provider}/${name} ${caps.join(" ")}`.toLowerCase();
      return searchable.includes(f) ? [{ name, detail }] : [];
    });
    if (!models.length && !entry.error) return [];
    return [{ provider, entry, models }];
  });
  const offered = groups.reduce((n, g) => n + g.models.length, 0);
  const anyError = Object.values(available ?? {}).some((e) => !!e.error);
  return (
    <div className="picker wide">
      <div className="picker-head">Model</div>
      <div className="pad-x">
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter or type provider/model…"
        />
      </div>
      <div className="model-status">
        <span className="muted small">
          {loading
            ? "Checking providers…"
            : failed
              ? "Could not reach the providers."
              : available
                ? `${offered} model${offered === 1 ? "" : "s"}`
                : ""}
        </span>
        <button className="ghost tiny" disabled={loading} onClick={refresh}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="picker-list tall">
        <Option
          active={!value}
          title="Project default"
          desc={defaultLabel ?? "Use this project’s configured model"}
          onClick={() => onPick(defaultLabel || "")}
        />
        {filter.includes("/") && (
          <Option
            title={`Use “${filter.trim()}”`}
            desc="custom model reference"
            onClick={() => onPick(filter.trim())}
          />
        )}
        {!available && <div className="muted pad">Loading models from providers…</div>}
        {groups.map(({ provider, entry, models }) => (
          <div key={provider}>
            <div className="group-head">{provider}</div>
            {entry.error && <div className="muted pad small">{entry.error}</div>}
            {models.map(({ name, detail }) => {
              const ref = `${provider}/${name}`;
              return (
                <Option
                  key={ref}
                  active={value === ref}
                  title={name}
                  desc={<ModelBadges detail={detail} />}
                  onClick={() => onPick(ref)}
                />
              );
            })}
          </div>
        ))}
        {available && !offered && !anyError && (
          <div className="muted pad small">No model matches “{filter.trim()}”.</div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ mode & permissions

export type Mode = "chat" | "default" | "quick-fix" | "plan-only" | "review-only";

export const MODES: { id: Mode; title: string; desc: string }[] = [
  { id: "chat", title: "Chat", desc: "Talk to the agent; it can read, edit and run commands directly." },
  { id: "default", title: "Plan & build", desc: "Plan → your approval → implement → verify → review." },
  { id: "quick-fix", title: "Quick fix", desc: "Implement → verify, no plan or review." },
  { id: "plan-only", title: "Plan only", desc: "Investigate and write a plan; no edits." },
  { id: "review-only", title: "Review changes", desc: "Review the current git diff." },
];

export function ModePicker({
  value,
  onChange,
  disabled,
}: {
  value: Mode;
  onChange(m: Mode): void;
  disabled?: boolean;
}) {
  const cur = MODES.find((m) => m.id === value)!;
  return (
    <Popover
      className="pick-mode"
      label={<span className="pill-text">{cur.title}</span>}
      title="How the agent works"
      disabled={disabled}
    >
      {(close) => (
        <div className="picker wide">
          <div className="picker-head">Mode</div>
          {MODES.map((m) => (
            <Option
              key={m.id}
              active={m.id === value}
              title={m.title}
              desc={m.desc}
              onClick={() => (onChange(m.id), close())}
            />
          ))}
        </div>
      )}
    </Popover>
  );
}

const PERMS: { id: PermissionMode; title: string; desc: string }[] = [
  { id: "ask", title: "Ask", desc: "Ask before editing files or running commands." },
  { id: "auto", title: "Auto", desc: "Edit files freely; ask only for risky commands." },
  { id: "yolo", title: "Full access", desc: "Never ask (dangerous commands are still blocked)." },
];

export function PermissionPicker({
  value,
  onChange,
}: {
  value: PermissionMode;
  onChange(m: PermissionMode): void;
}) {
  const cur = PERMS.find((p) => p.id === value) ?? PERMS[0];
  return (
    <Popover
      className="pick-perm"
      align="right"
      label={<span className={`pill-text perm-${value}`}>{cur.title}</span>}
      title="Permissions"
    >
      {(close) => (
        <div className="picker wide">
          <div className="picker-head">Permissions</div>
          {PERMS.map((p) => (
            <Option
              key={p.id}
              active={p.id === value}
              title={p.title}
              desc={p.desc}
              onClick={() => (onChange(p.id), close())}
            />
          ))}
        </div>
      )}
    </Popover>
  );
}
