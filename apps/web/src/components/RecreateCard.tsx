// 1:1 recreation: the progress card in the timeline and the Compare tab. Both render only
// from `state.recreate.runs`, which the client reduces from recreate.* events.
import { useEffect, useRef, useState } from "react";
import type { RecreateRunView } from "@harness/client";
import type { UseSessionResult } from "@harness/react";
import { useApp } from "../app-state";
import { useMirrorApp, useSessionLinks } from "../recreate";
import { IconAlert, IconCheck, IconCopy, IconExternal, IconRefresh, IconX } from "./icons";

const STAGE_ORDER = [
  "consent",
  "probe",
  "capture",
  "scene",
  "build",
  "measure",
  "components",
  "system",
  "convert",
  "ds-export",
  "repair",
  "crawl",
  "ccm",
  "design",
  "generate",
  "appbuild",
  "serve",
  "verify",
  "fix",
  "reverify",
  "report",
];
const STAGE_LABEL: Record<string, string> = {
  consent: "Consent",
  probe: "Probe",
  capture: "Capture",
  scene: "Scene",
  build: "Build",
  measure: "Measure",
  components: "Components",
  system: "Design system",
  convert: "Convert",
  "ds-export": "Design-system export",
  repair: "Repair",
  crawl: "Crawl",
  ccm: "Content",
  design: "Design",
  generate: "Generate app",
  appbuild: "Build app",
  serve: "Start app",
  verify: "Verify",
  fix: "Fix loop",
  reverify: "Verify again",
  report: "Report",
};
const SECTION_LABEL: Record<RecreateRunView["sections"][number]["status"], string> = {
  building: "building",
  checking: "checking",
  ok: "ok",
  "below-threshold": "below threshold",
  repaired: "repaired",
};

const REASON_LABEL: Record<NonNullable<RecreateRunView["sections"][number]["reason"]>, string> = {
  pixel: "pixels at the captured widths",
  responsive: "layout between the captured widths",
  flow: "CSS that does not flow",
};

export const pct = (n: number | undefined) => (n === undefined ? "" : `${(n * 100).toFixed(2)} %`);
const secs = (ms: number | undefined) =>
  ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

/** Runs in the order they started. */
export function recreateRuns(s: Pick<UseSessionResult, "recreate">): RecreateRunView[] {
  return Object.values(s.recreate?.runs ?? {});
}

/** The page the latest run is building (shown in the Preview tab while it grows). */
export function recreatePreviewPath(s: Pick<UseSessionResult, "recreate">): string | undefined {
  const run = recreateRuns(s)
    .filter((r) => r.dir && (r.mode === "mirror" ? r.stages.report?.status === "done" : r.stages.build))
    .at(-1);
  return run ? `${run.dir}/out/${run.mode === "mirror" ? "preview" : "static"}/index.html` : undefined;
}

export type RecreateShot = RecreateRunView["shots"][number];
type SectionRow = RecreateRunView["sections"][number];

/** The shot to show at `width`: a full-page live shot closest to it wins over a first-screen peek. */
function pickShot(run: RecreateRunView, width?: number): RecreateShot | undefined {
  const shots = run.shots ?? [];
  const live = shots.filter((x) => x.kind === "live");
  const pool = live.length ? live : shots.filter((x) => x.kind === "peek");
  if (!pool.length) return;
  return pool.reduce((best, x) =>
    width === undefined
      ? x.width > best.width
        ? x
        : best
      : Math.abs(x.width - width) < Math.abs(best.width - width)
        ? x
        : best,
  );
}

/** What the run is doing right now, in words (the build view's status bar). */
function activityOf(run: RecreateRunView): string {
  const live = (run.shots ?? []).filter((x) => x.kind === "live").length;
  const running = STAGE_ORDER.find((k) => run.stages[k]?.status === "running");
  switch (running) {
    case "consent":
      return "Waiting for consent";
    case "probe":
      return "Finding the page's layout switches";
    case "capture":
      return live
        ? `Capturing the page · ${live} reference shot${live === 1 ? "" : "s"} taken`
        : "Capturing the page: walking the DOM, menus, images and fonts";
    case "scene":
      return "Splitting the page into sections";
    case "build":
      return run.sections.length ? "Checking each section against the live page" : "Writing the page";
    case "measure":
      return "Measuring the page against the live site";
    case undefined:
      return "Preparing";
    default:
      return STAGE_LABEL[running] ?? running;
  }
}

/**
 * The latest run, while it is running: the live page's screenshot, replaced section by section by the built page.
 * Undefined when there is no running run or nothing to show yet (no screenshot).
 */
export function recreateBuild(
  s: Pick<UseSessionResult, "recreate">,
  width?: number,
): { run: RecreateRunView; shot: RecreateShot; activity: string; page?: string } | undefined {
  const run = recreateRuns(s).at(-1);
  if (!run || run.status !== "running") return;
  const shot = pickShot(run, width);
  if (!shot) return;
  // the build writes the whole page before its first section event: from then on the page can be shown
  const page =
    run.dir && run.stages.build && run.sections.length ? `${run.dir}/out/static/index.html` : undefined;
  return { run, shot, activity: activityOf(run), page };
}

/** Bands of the sections at the shot's width, in page order (sections the width lacks are left out). */
function bandsAt(sections: SectionRow[], width: number) {
  return sections
    .map((x) => ({ row: x, band: x.bands?.find((b) => b.width === width) }))
    .filter((x): x is { row: SectionRow; band: { width: number; y: number; h: number } } => !!x.band);
}

/** Reveal pace: one section per step, the whole page in at most ~5 s. */
const revealStep = (n: number) => Math.max(120, Math.min(450, 5000 / Math.max(1, n)));

/**
 * The live page while it is captured, then the recreation placed over it section by section from the top (the
 * screenshot below the boundary, the built page above it). `onRevealed` fires once the whole page is the built one.
 */
export function RecreateBuildView({
  run,
  shot,
  shotSrc,
  pageSrc,
  activity,
  onRevealed,
}: {
  run: RecreateRunView;
  shot: RecreateShot;
  shotSrc: string;
  pageSrc?: string;
  activity: string;
  onRevealed?(runId: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / shot.width);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shot.width]);
  useEffect(() => {
    setLoaded(false);
    setShown(0);
  }, [pageSrc]);
  const placed = bandsAt(run.sections, shot.width);
  const total = run.sections[0]?.total ?? run.sections.length;
  const target = pageSrc && loaded ? placed.length : 0;
  useEffect(() => {
    if (shown >= target) return;
    const t = setTimeout(() => setShown((n) => n + 1), revealStep(placed.length));
    return () => clearTimeout(t);
  }, [shown, target, placed.length]);
  const all = !!pageSrc && loaded && shown >= placed.length;
  useEffect(() => {
    if (!all) return;
    const t = setTimeout(() => onRevealed?.(run.runId), 900);
    return () => clearTimeout(t);
  }, [all, run.runId]);
  // the boundary: everything above it is the built page
  const edge = all
    ? shot.height
    : shown
      ? Math.max(...placed.slice(0, shown).map((x) => x.band.y + x.band.h))
      : 0;
  const current = placed[Math.min(shown, placed.length) - 1];
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const status = pageSrc
    ? all
      ? "Recreation in place"
      : `Placing sections · ${shown} / ${placed.length || total}`
    : activity;
  return (
    <div className="recreate-live" role="status" aria-live="polite">
      <div className="recreate-live-bar">
        {!all && <span className="spinner" aria-hidden="true" />}
        {all && <IconCheck size={13} aria-hidden="true" />}
        <span>
          <strong>{pageSrc ? "Recreation" : "Live page"}</strong> · {shot.width} px
          {shot.kind === "peek" ? " · first screen" : ""}
        </span>
        {pageSrc && (
          <span className="recreate-live-legend small">
            <i className="built" /> coded <i className="shot" /> screenshot
          </span>
        )}
        <span className="muted recreate-live-status">
          {status}
          {!all && "…"}
        </span>
      </div>
      <div className="recreate-live-scroll">
        <div
          ref={host}
          className="recreate-live-page"
          style={{ maxWidth: shot.width, minHeight: scale ? shot.height * scale : undefined }}
        >
          {pageSrc && scale > 0 && (
            <iframe
              className="recreate-live-frame"
              src={pageSrc}
              title="Recreated page"
              tabIndex={-1}
              aria-hidden="true"
              sandbox="allow-scripts"
              scrolling="no"
              onLoad={() => setLoaded(true)}
              style={{ width: shot.width, height: shot.height, transform: `scale(${scale})` }}
            />
          )}
          <img
            src={shotSrc}
            alt={`Screenshot of the live page at ${shot.width} px`}
            className={reduced ? "" : "animated"}
            style={{ clipPath: `inset(${(edge / shot.height) * 100}% 0 0 0)` }}
          />
          {!all &&
            placed
              .slice(shown)
              .map(({ row, band }) => (
                <i
                  key={row.id}
                  className="recreate-live-band"
                  aria-hidden="true"
                  style={{ top: band.y * scale }}
                />
              ))}
          {shot.kind === "peek" && !pageSrc && (
            <div className="recreate-live-rest" aria-hidden="true" style={{ top: shot.height * scale }}>
              <i />
              <i />
              <i />
              <span className="muted small">The rest of the page appears with the full-page capture</span>
            </div>
          )}
          {!pageSrc && <i className="recreate-live-scan" aria-hidden="true" />}
          {pageSrc && !all && (
            <div className={`recreate-live-edge${reduced ? "" : " animated"}`} style={{ top: edge * scale }}>
              <span>
                {current ? (
                  <>
                    <IconCheck size={11} /> {current.row.label}
                  </>
                ) : (
                  "Loading the recreation"
                )}
              </span>
            </div>
          )}
        </div>
      </div>
      <p className="recreate-live-note muted small">
        {pageSrc
          ? "Above the line: the coded page. Below it: the screenshot of the live page it replaces."
          : "The coded page replaces this screenshot once the build starts, section by section from the top."}
      </p>
    </div>
  );
}

/** Sections that have finished checking, a counter that grows as the page grows. */
export function recreateProgress(s: Pick<UseSessionResult, "recreate">): number {
  return recreateRuns(s).reduce(
    (n, r) =>
      n +
      r.sections.filter((x) => x.status !== "building" && x.status !== "checking").length +
      Object.values(r.stages).filter((x) => x.status === "done").length,
    0,
  );
}

function StageIcon({ status }: { status: string }) {
  if (status === "running") return <span className="spinner" aria-label="running" />;
  if (status === "failed") return <IconX size={13} aria-label="failed" />;
  if (status === "pending") return <i className="recreate-pending" aria-label="pending" />;
  if (status === "skipped")
    return (
      <span className="recreate-skip" aria-label="skipped">
        –
      </span>
    );
  return <IconCheck size={13} aria-label="done" />;
}

/** Stages every run goes through; the others (components, convert …) appear when they start. */
const CORE_STAGES = ["consent", "probe", "capture", "scene", "build", "measure"];
const MIRROR_STAGES = [
  "consent",
  "crawl",
  "ccm",
  "design",
  "generate",
  "appbuild",
  "serve",
  "verify",
  "fix",
  "reverify",
  "report",
];

const clock = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** A ticking clock while `on` (re-renders once a second). */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

function MirrorSummary({ run }: { run: RecreateRunView }) {
  const gates = Object.values(run.verify ?? {});
  const required = gates.filter((g) => !g.advisory);
  const failing = required.filter((g) => !g.pass);
  const advisory = gates.filter((g) => g.advisory && !g.pass);
  const drift = gates.reduce((n, g) => Math.max(n, g.drift ?? 0), 0);
  const kept = (run.fixes ?? []).filter((f) => f.accepted).length;
  return (
    <p className="muted small">
      Verify: {required.length - failing.length} of {required.length} gates pass
      {failing.length ? ` · failing: ${failing.map((g) => g.gate).join(", ")}` : ""}
      {advisory.length ? ` · notes: ${advisory.map((g) => g.gate).join(", ")}` : ""}
      {drift ? ` · source changed since the crawl on ${drift} shot${drift === 1 ? "" : "s"}` : ""}
      {run.fixes?.length ? ` · fix loop kept ${kept} of ${run.fixes.length}` : ""}
    </p>
  );
}

export function RecreateCard({ run, onCompare }: { run: RecreateRunView; onCompare(runId: string): void }) {
  const running = run.status === "running";
  const now = useNow(running);
  const present = Object.keys(run.stages);
  const last = Math.max(-1, ...present.map((k) => STAGE_ORDER.indexOf(k)));
  // while running, the core stages still ahead are listed as pending so the way to the end is visible
  const names = [
    ...new Set([
      ...present,
      ...(running
        ? (run.mode === "mirror" ? MIRROR_STAGES : CORE_STAGES).filter((k) => STAGE_ORDER.indexOf(k) > last)
        : []),
    ]),
  ].sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
  const stages = names.map((name) => ({ name, st: run.stages[name] }));
  const finished = stages.filter((x) => x.st && x.st.status !== "running").length;
  const progress = run.status === "success" ? 1 : stages.length ? finished / stages.length : 0;
  const started = Object.values(run.stages)
    .map((x) => (x.startedAt ? Date.parse(x.startedAt) : NaN))
    .filter((x) => !Number.isNaN(x));
  const elapsed = running && started.length ? clock(now - Math.min(...started)) : "";
  const done = run.sections.filter((x) => !["building", "checking"].includes(x.status)).length;
  const total = run.sections[0]?.total ?? 0;
  const below = run.sections.filter((x) => x.status === "below-threshold").length;
  // built and measured, every stage done, some gates missed: a result to look at, not a broken run
  const gatesMissed =
    run.status === "failed" &&
    Object.keys(run.measured).length > 0 &&
    !Object.values(run.stages).some((x) => x.status === "failed");
  const look = gatesMissed ? "gates" : run.status;
  const statusLabel = running
    ? "Running"
    : run.status === "success"
      ? "Done"
      : run.status === "cancelled"
        ? "Stopped"
        : gatesMissed
          ? "Gates missed"
          : "Failed";
  return (
    <section className={`card recreate-card ${look}`} role="region" aria-label="Recreation progress">
      <div className="recreate-head">
        <span className="preview-icon">
          <IconCopy size={14} />
        </span>
        <div className="recreate-title">
          <b>Recreate 1:1</b>
          <a className="small" href={run.url} target="_blank" rel="noreferrer noopener" title={run.url}>
            {hostOf(run.url)} <IconExternal size={11} />
          </a>
        </div>
        <span
          className={`status-pill ${run.status === "success" ? "done" : gatesMissed ? "waiting" : run.status}`}
        >
          {statusLabel}
          {elapsed && <span className="recreate-clock"> · {elapsed}</span>}
        </span>
      </div>
      <div
        className="recreate-progress"
        role="progressbar"
        aria-label="Stages done"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <i style={{ width: `${progress * 100}%` }} />
      </div>
      {stages.length > 0 && (
        <ol className="recreate-stages" aria-label="Stages">
          {stages.map(({ name, st }) => {
            const status: string = st?.status ?? "pending";
            const time =
              status === "running" && st?.startedAt
                ? clock(now - Date.parse(st.startedAt))
                : status === "pending"
                  ? ""
                  : secs(st?.ms);
            const detail =
              status === "running" ? `${activityOf(run)}…` : name === "consent" ? consentOf(run) : st?.detail;
            return (
              <li key={name} className={`recreate-stage ${status}`}>
                <StageIcon status={status} />
                <span className="recreate-stage-name">{STAGE_LABEL[name] ?? name}</span>
                <span className="muted small recreate-detail" title={detail}>
                  {detail}
                </span>
                <span className="muted small recreate-time">{time}</span>
                {!!st?.skipped?.length && (
                  <span className="recreate-skipped small" title={st.skipped.join(", ")}>
                    skipped: {st.skipped.join(", ")}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {run.mode === "mirror" && run.verify && <MirrorSummary run={run} />}
      {run.sections.length > 0 && (
        <details className="recreate-sections">
          <summary>
            <span className="group-head">
              Sections {total ? `${done} / ${total}` : ""}
              {below ? <span className="recreate-below"> · {below} below threshold</span> : null}
            </span>
            <span className="recreate-segments" aria-hidden="true">
              {run.sections.map((x) => (
                <i
                  key={x.id}
                  className={x.status}
                  title={`${x.label}: ${SECTION_LABEL[x.status]}${x.reason && x.status !== "ok" ? ` (${REASON_LABEL[x.reason]})` : ""}${x.reverted ? ", repair undone" : ""}`}
                />
              ))}
            </span>
          </summary>
          <table aria-label="Sections">
            <tbody>
              {run.sections.map((x) => (
                <tr key={x.id} className={`recreate-section ${x.status}`}>
                  <td className="muted small">{x.index + 1}</td>
                  <td>
                    {x.label} <span className="muted small">{x.kind}</span>
                  </td>
                  <td>
                    <span className={`recreate-chip ${x.status}`}>{SECTION_LABEL[x.status]}</span>
                    {x.reason && x.status !== "ok" ? (
                      <span className="small muted"> {REASON_LABEL[x.reason]}</span>
                    ) : null}
                    {x.reverted ? <span className="small muted"> · repair undone</span> : null}
                  </td>
                  <td className="mono small num">{pct(x.pixel)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {Object.values(run.measured).map((m) => (
        <div key={m.target} className="recreate-measured">
          <div className="group-head">Measured · {m.target}</div>
          <table aria-label={`Measured ${m.target}`}>
            <thead>
              <tr>
                <th>width</th>
                <th>pixel</th>
                <th>text</th>
                <th>height out / live</th>
                <th>h-scroll</th>
              </tr>
            </thead>
            <tbody>
              {m.widths.map((w) => (
                <tr key={w.width}>
                  <td className="mono small">{w.width}px</td>
                  <td className="mono small num">{pct(w.pixel)}</td>
                  <td className="mono small num">
                    {w.textReal}
                    {w.textDrift ? <span className="muted"> ({w.textDrift} drift)</span> : null}
                  </td>
                  <td className="mono small num">
                    {w.height.out} / {w.height.live}px
                  </td>
                  <td className="mono small num">{w.hscroll ? `${w.hscroll}px` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.gates.length > 0 && (
            <div className="recreate-gates">
              {m.gates.map((g) => (
                <span
                  key={g.name}
                  className={`recreate-chip ${g.pass ? "ok" : "below-threshold"}`}
                  title={g.detail}
                >
                  {g.pass ? <IconCheck size={11} /> : <IconAlert size={11} />} {g.name}{" "}
                  {g.pass ? "pass" : "fail"}
                </span>
              ))}
            </div>
          )}
          {m.interactions && <div className="muted small">{m.interactions}</div>}
        </div>
      ))}
      {run.components && (
        <div className="muted small">
          {run.components.sets.length} component sets · lint {run.components.lint.pass ? "pass" : "issues"}
          {run.components.sets.length
            ? ` · ${run.components.sets
                .slice(0, 6)
                .map((x) => x.name)
                .join(", ")}`
            : ""}
        </div>
      )}
      {run.outputs.length > 0 && (
        <div className="recreate-outputs">
          <div className="group-head">Outputs</div>
          {run.outputs.map((o) => (
            <div key={`${o.target}:${o.path}`} className="small">
              <span className="badge">{o.target}</span> <span className="mono">{o.path}</span>
            </div>
          ))}
        </div>
      )}
      {run.summary && <div className="small">{run.summary}</div>}
      {run.comparePath && (
        <div className="row">
          <button className="secondary" onClick={() => onCompare(run.runId)}>
            Compare with live page
          </button>
        </div>
      )}
    </section>
  );
}

/** Who consented, and the outputs asked for (the consent stage's detail line). */
function consentOf(run: RecreateRunView): string {
  const by = !run.consent
    ? ""
    : run.consent.by === "auto"
      ? `automatic (${run.consent.mode})`
      : "given by you";
  return [by, run.targets.length ? `→ ${run.targets.join(", ")}` : ""].filter(Boolean).join(" ");
}

/** The Compare tab: the run's compare page (live vs output vs diff per width) in a sandboxed iframe. */
export function ComparePanel({
  s,
  sessionId,
  runId,
  setRunId,
}: {
  s: UseSessionResult;
  sessionId: string;
  runId?: string;
  setRunId(id: string): void;
}) {
  const { client } = useApp();
  const { previewBase } = useSessionLinks(sessionId);
  const runs = recreateRuns(s).filter((r) => r.comparePath);
  const run = runs.find((r) => r.runId === runId) ?? runs.at(-1);
  const [nonce, setNonce] = useState(0);
  useEffect(() => setNonce((n) => n + 1), [run?.comparePath, run?.status]);
  const mirrorApp = useMirrorApp(sessionId, run?.mode === "mirror" ? run.runId : undefined, nonce);
  const page =
    client && previewBase && run?.comparePath && !mirrorApp.starting
      ? client.previewUrl(previewBase, run.comparePath)
      : "";
  const url = page && mirrorApp.url ? `${page}?app=${encodeURIComponent(mirrorApp.url)}` : page;
  return (
    <div className="preview">
      <div className="panel-toolbar">
        <select
          value={run?.runId ?? ""}
          disabled={!runs.length}
          onChange={(e) => setRunId(e.target.value)}
          aria-label="Recreation run"
        >
          {!runs.length && <option value="">No compare page yet</option>}
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.url} · {r.runId}
            </option>
          ))}
        </select>
        <button
          className="ghost preview-reload"
          onClick={() => setNonce((n) => n + 1)}
          disabled={!url}
          aria-label="Reload compare page"
        >
          <IconRefresh size={15} /> Reload
        </button>
        {url && (
          <a className="ghost-link" href={url} target="_blank" rel="noreferrer" title="Open in a new tab">
            <IconExternal size={15} />
          </a>
        )}
      </div>
      {url ? (
        <iframe
          key={`${url}#${nonce}`}
          className="preview-frame"
          src={url}
          title="Compare with live page"
          sandbox="allow-scripts allow-popups"
        />
      ) : (
        <div className="muted pad">
          {recreateRuns(s).length
            ? "The compare page appears here once the run has measured its output against the live page."
            : "Recreate a page 1:1 (paste a URL in the composer and choose “Recreate 1:1”) to compare it with the live page here."}
        </div>
      )}
    </div>
  );
}
