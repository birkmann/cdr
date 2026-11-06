import { useState } from "react";
import {
  STEP_CATEGORIES,
  TOKEN_ROWS,
  formatCost,
  formatMs,
  formatTokens,
  turnReportMarkdown,
  type ReportStage,
  type StageKind,
  type StepCategory,
  type TurnReport,
} from "@harness/client";
import { IconAlert, IconCheck, IconCopy, IconSparkle, IconX } from "./icons";

const CATEGORY_LABEL = Object.fromEntries(STEP_CATEGORIES.map((c) => [c.id, c.label])) as Record<
  StepCategory,
  string
>;
const color = (k: StageKind) => `var(--viz-${k})`;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** A human-readable account of one turn: how the result came about, where time and tokens went, what to improve. */
export function RunReport({ report: r, request, id }: { report: TurnReport; request?: string; id?: string }) {
  const [copied, setCopied] = useState<"ok" | "failed">();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turnReportMarkdown(r, request));
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };
  const tokens = r.totals.inputTokens + r.totals.outputTokens;
  return (
    <section className="run-report" id={id} aria-label="Run summary">
      <header className="rr-head">
        <h3>Run summary</h3>
        <button className="ghost tiny" onClick={copy} title="Copy this summary as Markdown">
          <IconCopy size={12} /> {copied === "ok" ? "Copied" : "Copy as Markdown"}
        </button>
      </header>
      {copied === "failed" && <p className="muted small rr-pad">Copying is not available here.</p>}

      <dl className="rr-kpis">
        <Kpi label="Time" value={formatMs(r.durationMs)} />
        <Kpi label="Model calls" value={String(r.totals.modelCalls)} />
        <Kpi
          label="Tool calls"
          value={String(r.totals.toolCalls)}
          sub={r.totals.failedTools ? `${r.totals.failedTools} failed` : undefined}
          bad={r.totals.failedTools > 0}
        />
        <Kpi
          label="Tokens"
          value={formatTokens(tokens)}
          sub={`${formatTokens(r.totals.inputTokens)} in · ${formatTokens(r.totals.outputTokens)} out`}
        />
        {r.totals.cost > 0 && <Kpi label="Est. cost" value={formatCost(r.totals.cost)} />}
      </dl>

      <Section title="How it got there">
        <ol className="rr-stages">
          {r.stages.map((s, i) => (
            <Stage key={i} s={s} total={r.durationMs} />
          ))}
        </ol>
        {(r.skills.length > 0 || r.models.length > 0) && (
          <p className="rr-note">
            {r.models.length > 0 && <>Model {r.models.join(", ")}. </>}
            {r.skills.length > 0 && <>Skills used: {r.skills.join(", ")}.</>}
          </p>
        )}
      </Section>

      {(r.files.length > 0 || r.checks.length > 0) && (
        <Section title="What changed and how it was checked">
          <div className="rr-cols">
            {r.files.length > 0 && (
              <ul className="rr-list">
                {r.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>
                    <span className="muted">
                      {[
                        f.created ? "written" : "",
                        f.edits ? `${f.edits} ${f.edits === 1 ? "edit" : "edits"}` : "",
                        f.failedEdits ? `${f.failedEdits} failed` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {r.checks.length > 0 && (
              <ul className="rr-list rr-checks">
                {r.checks.map((c, i) => (
                  <li key={i} className={c.ok ? "ok" : "bad"}>
                    {c.ok ? <IconCheck size={13} /> : <IconX size={13} />}
                    <span>
                      {c.label}
                      {c.detail && <span className="muted"> — {c.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      )}

      <Section title="Where the time went">
        <TimeStrip r={r} />
      </Section>

      <Section title="Where the tokens went">
        <CallChart r={r} />
        <Breakdown
          rows={TOKEN_ROWS.map(([key, label]) => ({
            label,
            value: r.tokens[key].inputTokens + r.tokens[key].outputTokens,
            note: `${formatTokens(r.tokens[key].inputTokens)} in · ${formatTokens(r.tokens[key].outputTokens)} out · ${r.tokens[key].calls} ${r.tokens[key].calls === 1 ? "call" : "calls"}${r.tokens[key].cost ? ` · ${formatCost(r.tokens[key].cost)}` : ""}`,
          })).filter((x) => x.value > 0)}
          total={tokens}
          format={formatTokens}
        />
        {r.consumers.some((c) => c.carriedTokens > 0) && (
          <>
            <h5 className="rr-sub">Largest tool results</h5>
            <p className="rr-note">
              Every later model call re-sends earlier tool output, so a large result costs input tokens again
              and again (estimated at four characters per token).
            </p>
            <table className="rr-table">
              <thead>
                <tr>
                  <th scope="col">Tool result</th>
                  <th scope="col">Size</th>
                  <th scope="col">Re-sent</th>
                  <th scope="col">Input cost</th>
                </tr>
              </thead>
              <tbody>
                {r.consumers
                  .filter((c) => c.carriedTokens > 0)
                  .slice(0, 5)
                  .map((c) => (
                    <tr key={c.toolId}>
                      <td>{c.label}</td>
                      <td>~{formatTokens(c.outputTokens)}</td>
                      <td>{c.carriedCalls}×</td>
                      <td>~{formatTokens(c.carriedTokens)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section title="What could be better">
        <ul className="rr-insights">
          {r.insights.map((i, n) => (
            <li key={n} className={i.level}>
              <span className="rr-insight-icon" aria-hidden="true">
                {i.level === "warn" ? (
                  <IconAlert size={14} />
                ) : i.level === "tip" ? (
                  <IconSparkle size={14} />
                ) : (
                  <IconCheck size={14} />
                )}
              </span>
              <div>
                <strong>
                  <span className="visually-hidden">
                    {i.level === "warn" ? "Problem: " : i.level === "tip" ? "Tip: " : "Note: "}
                  </span>
                  {i.title}
                </strong>
                <p>{i.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </section>
  );
}

function Kpi({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className="rr-kpi">
      <dt>{label}</dt>
      <dd>
        {value}
        {sub && <span className={bad ? "bad" : undefined}>{sub}</span>}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rr-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function Stage({ s, total }: { s: ReportStage; total: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? s.decisions : s.decisions.slice(0, 3);
  const span =
    s.calls.length > 1 ? `calls ${s.calls[0]}–${s.calls[s.calls.length - 1]}` : `call ${s.calls[0]}`;
  return (
    <li className="rr-stage">
      <span className="rr-dot" style={{ background: color(s.kind) }} aria-hidden="true" />
      <div>
        <div className="rr-stage-head">
          <strong>{s.title}</strong>
          <span className="muted">
            {formatMs(s.endMs - s.startMs)}
            {total > 0 && ` · ${pct(s.endMs - s.startMs, total)}%`} · {formatTokens(s.tokens)} tokens · {span}
          </span>
        </div>
        <p className="rr-stage-detail">
          {s.detail}
          {s.failures > 0 && <span className="bad"> · {s.failures} failed</span>}
        </p>
        {shown.length > 0 && (
          <ul className="decisions rr-decisions">
            {shown.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
        {s.decisions.length > 3 && (
          <button className="ghost tiny rr-more" onClick={() => setAll(!all)}>
            {all
              ? "Fewer decisions"
              : `${s.decisions.length - 3} more ${s.decisions.length === 4 ? "decision" : "decisions"}`}
          </button>
        )}
      </div>
    </li>
  );
}

/** The turn's wall time as one strip: each model call and tool run, colored by what it was doing. */
function TimeStrip({ r }: { r: TurnReport }) {
  const [hover, setHover] = useState<number>();
  const d = r.durationMs || 1;
  const h = hover !== undefined ? r.segments[hover] : undefined;
  const rows = [
    ...STEP_CATEGORIES.map((c) => ({ key: c.id as StageKind | "idle", label: c.label, value: r.time[c.id] })),
    { key: "idle" as const, label: "Waiting & overhead", value: r.time.idle },
  ].filter((x) => x.value > 0);
  return (
    <>
      <div
        className="rr-strip"
        role="img"
        aria-label={`Timeline of ${r.segments.length} steps over ${formatMs(r.durationMs)}`}
        onMouseLeave={() => setHover(undefined)}
      >
        {r.segments.map((s, i) => (
          <span
            key={i}
            className={`rr-seg${s.ok === false ? " failed" : ""}${hover === i ? " hover" : ""}`}
            style={{
              left: `${(s.start / d) * 100}%`,
              width: `max(2px, ${((s.end - s.start) / d) * 100}%)`,
              background: color(s.category),
            }}
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </div>
      <div className="rr-axis" aria-hidden="true">
        <span>0s</span>
        <span>{formatMs(r.durationMs / 2)}</span>
        <span>{formatMs(r.durationMs)}</span>
      </div>
      <p className="rr-readout" aria-live="polite">
        {h ? (
          <>
            <strong>{h.label}</strong> · {CATEGORY_LABEL[h.category]} · {formatMs(h.end - h.start)} at{" "}
            {formatMs(h.start)}
            {h.ok === false && <span className="bad"> · failed</span>}
          </>
        ) : (
          <span className="muted">Point at the strip to see each step.</span>
        )}
      </p>
      <Breakdown
        rows={rows.map((x) => ({
          label: x.label,
          value: x.value,
          swatch: x.key === "idle" ? undefined : color(x.key),
        }))}
        total={r.durationMs}
        format={formatMs}
      />
    </>
  );
}

/** Tokens of each model call, input and output stacked: shows how the context grew and which calls were costly. */
function CallChart({ r }: { r: TurnReport }) {
  const [hover, setHover] = useState<number>();
  const calls = r.calls.filter((c) => c.inputTokens || c.outputTokens);
  if (calls.length < 2) return null;
  const max = Math.max(...calls.map((c) => c.inputTokens + c.outputTokens + c.thinkingTokens), 1);
  const c = hover !== undefined ? calls[hover] : undefined;
  return (
    <div className="rr-calls">
      <div className="rr-legend" aria-hidden="true">
        <span>
          <i style={{ background: "var(--viz-in)" }} /> Input (context sent)
        </span>
        <span>
          <i style={{ background: "var(--viz-out)" }} /> Output
        </span>
        <span>
          <i style={{ background: "var(--viz-think)" }} /> Thinking summary
        </span>
        {calls.some((x) => x.compactedBefore) && (
          <span>
            <i className="rr-compact-key" /> Context compacted
          </span>
        )}
      </div>
      <div
        className="rr-bars"
        role="img"
        aria-label={`Tokens per model call for ${calls.length} calls; the largest used ${formatTokens(max)}.`}
        onMouseLeave={() => setHover(undefined)}
      >
        {calls.map((x, i) => {
          const h = (n: number) => `${(n / max) * 100}%`;
          return (
            <div
              key={x.messageId}
              className={`rr-bar${hover === i ? " hover" : ""}${x.compactedBefore ? " compacted" : ""}`}
              onMouseEnter={() => setHover(i)}
            >
              <span style={{ height: h(x.thinkingTokens), background: "var(--viz-think)" }} />
              <span style={{ height: h(x.outputTokens), background: "var(--viz-out)" }} />
              <span style={{ height: h(x.inputTokens), background: "var(--viz-in)" }} />
            </div>
          );
        })}
      </div>
      <div className="rr-axis" aria-hidden="true">
        <span>call 1</span>
        <span>peak {formatTokens(max)}</span>
        <span>call {calls[calls.length - 1].index}</span>
      </div>
      <p className="rr-readout" aria-live="polite">
        {c ? (
          <>
            <strong>Call #{c.index}</strong> · {formatTokens(c.inputTokens)} in ·{" "}
            {formatTokens(c.outputTokens)} out
            {c.thinkingTokens > 0 && ` · ${formatTokens(c.thinkingTokens)} thinking summary`} ·{" "}
            {formatMs(c.durationMs)}
            {c.tools.length > 0 && ` · ${c.tools.length} ${c.tools.length === 1 ? "tool" : "tools"}`}
            {c.decisions[0] && <span className="muted"> — {c.decisions[0]}</span>}
          </>
        ) : (
          <span className="muted">Point at a bar to see that model call.</span>
        )}
      </p>
    </div>
  );
}

function Breakdown({
  rows,
  total,
  format,
}: {
  rows: { label: string; value: number; note?: string; swatch?: string }[];
  total: number;
  format(n: number): string;
}) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((x) => x.value), 1);
  return (
    <table className="rr-breakdown">
      <tbody>
        {rows.map((x) => (
          <tr key={x.label}>
            <th scope="row">
              {x.swatch && <i className="rr-swatch" style={{ background: x.swatch }} aria-hidden="true" />}
              {x.label}
            </th>
            <td className="rr-bar-cell">
              <span
                style={{ width: `${(x.value / max) * 100}%`, background: x.swatch ?? "var(--viz-neutral)" }}
              />
            </td>
            <td className="rr-num">
              {format(x.value)} <span className="muted">{pct(x.value, total)}%</span>
              {x.note && <div className="muted rr-row-note">{x.note}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
