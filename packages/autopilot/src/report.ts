// Reports per site and per cycle (plan §2.6): REPORT.md, report.json and a static index.html that needs no server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { formatGateValue, readJsonOr, readMatrix, siteDirsOf } from "./collect.js";
import { stageBudgetMs } from "./runner.js";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  STAGE_ORDER,
  type AutopilotConfig,
  type AutopilotPaths,
  type Finding,
  type FindingsFile,
  type Gate,
  type MatrixResult,
  type ModelUsage,
  type StageName,
  type StageStatus,
  type StageSummary,
} from "./types.js";

export interface StageRow {
  stage: StageName;
  status: StageStatus;
  wallClockMs: number;
  budgetMs: number;
  usage: ModelUsage;
}

export interface SiteReport {
  site: string;
  cycle: number;
  commit: string;
  /** Every stage that ran passed. */
  green: boolean;
  stages: StageRow[];
  gates: (Gate & { stage: StageName })[];
  findings: Finding[];
  usage: ModelUsage;
  wallClockMs: number;
  artifacts: Partial<Record<StageName, Record<string, string>>>;
}

export interface GateFlip {
  site: string;
  stage: StageName;
  id: string;
  viewport?: string;
  from: boolean;
  to: boolean;
}

export interface CycleDiff {
  against: number;
  gatesFlipped: GateFlip[];
  findingsAppeared: string[];
  findingsDisappeared: string[];
  wallClockDeltaMs: number;
  costDeltaUsd: number;
}

export interface CycleReport {
  cycle: number;
  commit: string;
  green: boolean;
  sites: SiteReport[];
  findings: Finding[];
  usage: ModelUsage;
  wallClockMs: number;
  diff?: CycleDiff;
}

const emptyUsage = (): ModelUsage => ({ calls: 0, cachedCalls: 0, costUsd: 0 });
const addUsage = (a: ModelUsage, b: ModelUsage | undefined) => {
  if (b) {
    a.calls += b.calls;
    a.cachedCalls += b.cachedCalls;
    a.costUsd += b.costUsd;
  }
  return a;
};

const stagesOfSite = (m: MatrixResult | undefined, site: string): StageSummary[] =>
  STAGE_ORDER.map((s) => m?.sites[site]?.[s]).filter((s): s is StageSummary => !!s);

function buildSiteReport(
  site: string,
  cycle: number,
  matrix: MatrixResult | undefined,
  findings: FindingsFile | undefined,
  config: AutopilotConfig,
): SiteReport {
  const summaries = stagesOfSite(matrix, site);
  const usage = emptyUsage();
  const gates: SiteReport["gates"] = [];
  const stages: StageRow[] = [];
  const artifacts: SiteReport["artifacts"] = {};
  let wallClockMs = 0;
  for (const s of summaries) {
    addUsage(usage, s.usage);
    wallClockMs += s.wallClockMs;
    stages.push({
      stage: s.stage,
      status: s.status,
      wallClockMs: s.wallClockMs,
      budgetMs: stageBudgetMs(s.stage, config),
      usage: s.usage ?? emptyUsage(),
    });
    for (const g of s.gates) gates.push({ ...g, stage: s.stage });
    if (Object.keys(s.artifacts).length) artifacts[s.stage] = s.artifacts;
  }
  return {
    site,
    cycle,
    commit: matrix?.commit ?? "unknown",
    green: summaries.length > 0 && summaries.every((s) => s.status === "passed"),
    stages,
    gates,
    findings: (findings?.findings ?? []).filter((f) => f.sites.includes(site)),
    usage,
    wallClockMs,
    artifacts,
  };
}

function gateKey(site: string, stage: string, g: Pick<Gate, "id" | "viewport">): string {
  return `${site}|${stage}|${g.id}|${g.viewport ?? ""}`;
}

export function diffCycles(
  current: { matrix?: MatrixResult; findings?: FindingsFile; usage: ModelUsage; wallClockMs: number },
  previous: {
    cycle: number;
    matrix?: MatrixResult;
    findings?: FindingsFile;
    usage: ModelUsage;
    wallClockMs: number;
  },
): CycleDiff {
  const before = new Map<string, boolean>();
  for (const [site, stages] of Object.entries(previous.matrix?.sites ?? {}))
    for (const [stage, s] of Object.entries(stages))
      for (const g of s?.gates ?? []) before.set(gateKey(site, stage, g), g.pass);
  const gatesFlipped: GateFlip[] = [];
  for (const [site, stages] of Object.entries(current.matrix?.sites ?? {}))
    for (const [stage, s] of Object.entries(stages))
      for (const g of s?.gates ?? []) {
        const from = before.get(gateKey(site, stage, g));
        if (from === undefined || from === g.pass) continue;
        gatesFlipped.push({
          site,
          stage: stage as StageName,
          id: g.id,
          ...(g.viewport ? { viewport: g.viewport } : {}),
          from,
          to: g.pass,
        });
      }
  const open = (f?: FindingsFile) =>
    new Set((f?.findings ?? []).filter((x) => x.status !== "fixed").map((x) => x.signature));
  const a = open(previous.findings);
  const b = open(current.findings);
  return {
    against: previous.cycle,
    gatesFlipped,
    findingsAppeared: [...b].filter((s) => !a.has(s)).sort(),
    findingsDisappeared: [...a].filter((s) => !b.has(s)).sort(),
    wallClockDeltaMs: current.wallClockMs - previous.wallClockMs,
    costDeltaUsd: current.usage.costUsd - previous.usage.costUsd,
  };
}

export function buildCycleReport(
  paths: AutopilotPaths,
  cycle: number,
  config: AutopilotConfig = DEFAULT_AUTOPILOT_CONFIG,
): CycleReport {
  const matrix = readMatrix(paths, cycle);
  const findings = readJsonOr<FindingsFile | undefined>(
    join(paths.cycleDir(cycle), "findings.json"),
    undefined,
  );
  const names = Object.keys(matrix?.sites ?? {}).length
    ? Object.keys(matrix!.sites)
    : siteDirsOf(paths, cycle);
  const sites = names.map((site) => buildSiteReport(site, cycle, matrix, findings, config));
  const usage = sites.reduce((acc, s) => addUsage(acc, s.usage), emptyUsage());
  const wallClockMs = sites.reduce((n, s) => n + s.wallClockMs, 0);
  const report: CycleReport = {
    cycle,
    commit: matrix?.commit ?? "unknown",
    green: sites.length > 0 && sites.every((s) => s.green),
    sites,
    findings: findings?.findings ?? [],
    usage,
    wallClockMs,
  };
  if (cycle > 1) {
    const prevMatrix = readMatrix(paths, cycle - 1);
    const prevFindings = readJsonOr<FindingsFile | undefined>(
      join(paths.cycleDir(cycle - 1), "findings.json"),
      undefined,
    );
    if (prevMatrix || prevFindings) {
      const prevSites = Object.keys(prevMatrix?.sites ?? {}).map((site) =>
        buildSiteReport(site, cycle - 1, prevMatrix, prevFindings, config),
      );
      report.diff = diffCycles(
        { matrix, findings, usage, wallClockMs },
        {
          cycle: cycle - 1,
          matrix: prevMatrix,
          findings: prevFindings,
          usage: prevSites.reduce((acc, s) => addUsage(acc, s.usage), emptyUsage()),
          wallClockMs: prevSites.reduce((n, s) => n + s.wallClockMs, 0),
        },
      );
    }
  }
  return report;
}

// ---------------------------------------------------------------- rendering

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const money = (usd: number) => `$${usd.toFixed(2)}`;

const usageLine = (u: ModelUsage) => `${u.calls} calls, ${u.cachedCalls} cached, ${money(u.costUsd)}`;

const signPrefix = (n: number) => (n >= 0 ? "+" : "");

export function renderSiteMarkdown(r: SiteReport, relTo?: string): string {
  const rel = (p: string) => (relTo ? relative(relTo, p) || p : p);
  const lines: string[] = [
    `# ${r.site}, cycle ${r.cycle}`,
    "",
    `Verdict: **${r.green ? "green" : "not green"}** · commit \`${r.commit}\` · ${seconds(r.wallClockMs)} · ${usageLine(r.usage)}`,
    "",
    "## Stages",
    "",
    "| Stage | Status | Wall clock | Budget | Model usage |",
    "| --- | --- | --- | --- | --- |",
    ...r.stages.map(
      (s) =>
        `| ${s.stage} | ${s.status} | ${seconds(s.wallClockMs)} | ${seconds(s.budgetMs)} | ${usageLine(s.usage)} |`,
    ),
    "",
    "## Gates",
    "",
    "| Stage | Gate | Viewport | Value | Hard | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.gates.map(
      (g) =>
        `| ${g.stage} | \`${g.id}\` | ${g.viewport ?? ""} | ${formatGateValue(g)} | ${g.hard ? "hard" : "advisory"} | ${g.pass ? "pass" : "**FAIL**"} |`,
    ),
    "",
    "## Findings",
    "",
  ];
  if (!r.findings.length) lines.push("None.", "");
  for (const f of r.findings) {
    lines.push(`- \`${f.signature}\` (${f.status}): ${f.message.split("\n")[0]!}`);
    for (const e of f.evidence.slice(0, 5)) lines.push(`  - \`${rel(e)}\``);
  }
  lines.push("", "## Artefacts", "");
  for (const [stage, artifacts] of Object.entries(r.artifacts))
    for (const [name, path] of Object.entries(artifacts)) lines.push(`- ${stage} ${name}: \`${rel(path)}\``);
  return `${lines.join("\n")}\n`;
}

export function renderCycleMarkdown(r: CycleReport, relTo?: string): string {
  const rel = (p: string) => (relTo ? relative(relTo, p) || p : p);
  const lines: string[] = [
    `# Cycle ${r.cycle}`,
    "",
    `Verdict: **${r.green ? "green" : "not green"}** · commit \`${r.commit}\` · ${seconds(r.wallClockMs)} · ${usageLine(r.usage)}`,
    "",
    "| Site | Verdict | Stages | Wall clock | Cost |",
    "| --- | --- | --- | --- | --- |",
    ...r.sites.map(
      (s) =>
        `| [${s.site}](${s.site}/REPORT.md) | ${s.green ? "green" : "not green"} | ${s.stages.map((x) => `${x.stage} ${x.status}`).join(", ")} | ${seconds(s.wallClockMs)} | ${money(s.usage.costUsd)} |`,
    ),
    "",
    "## Findings",
    "",
    `${r.findings.length} in total (see [FINDINGS.md](FINDINGS.md)).`,
    "",
  ];
  for (const f of r.findings.filter((x) => x.status !== "fixed").slice(0, 30))
    lines.push(`- \`${f.signature}\` (${f.status}, ${f.sites.join(", ")}): ${f.message.split("\n")[0]!}`);
  if (r.diff) {
    const d = r.diff;
    lines.push("", `## Changes since cycle ${d.against}`, "");
    lines.push(
      `Wall clock ${signPrefix(d.wallClockDeltaMs)}${seconds(d.wallClockDeltaMs)}, cost ${signPrefix(d.costDeltaUsd)}${money(d.costDeltaUsd)}.`,
      "",
    );
    lines.push(`Gates that flipped (${d.gatesFlipped.length}):`, "");
    if (!d.gatesFlipped.length) lines.push("- none");
    for (const g of d.gatesFlipped)
      lines.push(
        `- ${g.site} ${g.stage} \`${g.id}\`${g.viewport ? ` (${g.viewport})` : ""}: ${g.from ? "pass" : "fail"} to ${g.to ? "pass" : "fail"}`,
      );
    lines.push("", `Findings that appeared (${d.findingsAppeared.length}):`, "");
    for (const s of d.findingsAppeared) lines.push(`- \`${s}\``);
    lines.push("", `Findings that disappeared (${d.findingsDisappeared.length}):`, "");
    for (const s of d.findingsDisappeared) lines.push(`- \`${s}\``);
  }
  void rel;
  return `${lines.join("\n")}\n`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root { --bg: #fff; --fg: #1a1a1a; --mute: #667; --line: #e4e4ea; --pass: #1a7a4a; --fail: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #15171c; --fg: #ececf1; --mute: #99a; --line: #2c2f38; --pass: #57c48b; --fail: #ff8a80; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; }
h1 { font-size: 24px; } h2 { font-size: 18px; margin-top: 28px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
th { color: var(--mute); font-weight: 600; }
a { color: inherit; }
.pass { color: var(--pass); font-weight: 600; }
.fail { color: var(--fail); font-weight: 600; }
.mute { color: var(--mute); }
code { font-size: 12px; }
.table-scroll { overflow-x: auto; }
`;

const statusClass = (ok: boolean) => (ok ? "pass" : "fail");

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>\n`;
}

const fileLink = (absolute: string, relTo: string) => {
  const href = relative(relTo, absolute);
  return `<a href="${esc(href)}"><code>${esc(href)}</code></a>`;
};

function findingsTable(findings: Finding[], relTo: string): string {
  if (!findings.length) return `<p class="mute">No findings.</p>`;
  const rows = findings
    .map(
      (f) =>
        `<tr><td><code>${esc(f.signature)}</code></td><td>${esc(f.status)}</td><td>${esc(f.sites.join(", "))}</td><td>${esc(f.message.split("\n")[0]!)}</td><td>${f.evidence
          .slice(0, 4)
          .map((e) => fileLink(e, relTo))
          .join("<br>")}</td></tr>`,
    )
    .join("");
  return `<div class="table-scroll"><table><thead><tr><th>Signature</th><th>Status</th><th>Sites</th><th>Message</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderSiteHtml(r: SiteReport, relTo: string): string {
  const stages = r.stages
    .map(
      (s) =>
        `<tr><td>${esc(s.stage)}</td><td class="${statusClass(s.status === "passed")}">${esc(s.status)}</td><td>${seconds(s.wallClockMs)}</td><td>${seconds(s.budgetMs)}</td><td>${esc(usageLine(s.usage))}</td></tr>`,
    )
    .join("");
  const gates = r.gates
    .map(
      (g) =>
        `<tr><td>${esc(g.stage)}</td><td><code>${esc(g.id)}</code></td><td>${esc(g.viewport ?? "")}</td><td>${esc(formatGateValue(g))}</td><td>${g.hard ? "hard" : "advisory"}</td><td class="${statusClass(g.pass)}">${g.pass ? "pass" : "FAIL"}</td></tr>`,
    )
    .join("");
  const artefacts = Object.entries(r.artifacts)
    .flatMap(([stage, a]) =>
      Object.entries(a).map(
        ([name, path]) => `<li>${esc(stage)} ${esc(name)}: ${fileLink(path, relTo)}</li>`,
      ),
    )
    .join("");
  return page(
    `${r.site}, cycle ${r.cycle}`,
    `<p><a href="../index.html">Cycle ${r.cycle}</a></p><h1>${esc(r.site)}</h1><p class="${statusClass(r.green)}">${r.green ? "green" : "not green"}</p><p class="mute">commit <code>${esc(r.commit)}</code> · ${seconds(r.wallClockMs)} · ${esc(usageLine(r.usage))}</p>
<h2>Stages</h2><div class="table-scroll"><table><thead><tr><th>Stage</th><th>Status</th><th>Wall clock</th><th>Budget</th><th>Model usage</th></tr></thead><tbody>${stages}</tbody></table></div>
<h2>Gates</h2><div class="table-scroll"><table><thead><tr><th>Stage</th><th>Gate</th><th>Viewport</th><th>Value</th><th>Kind</th><th>Result</th></tr></thead><tbody>${gates}</tbody></table></div>
<h2>Findings</h2>${findingsTable(r.findings, relTo)}
<h2>Artefacts</h2><ul>${artefacts}</ul>
<p><a href="REPORT.md">REPORT.md</a> · <a href="report.json">report.json</a></p>`,
  );
}

export function renderCycleHtml(r: CycleReport, relTo: string): string {
  const sites = r.sites
    .map(
      (s) =>
        `<tr><td><a href="${esc(s.site)}/index.html">${esc(s.site)}</a></td><td class="${statusClass(s.green)}">${s.green ? "green" : "not green"}</td><td>${s.stages.map((x) => `${esc(x.stage)} <span class="${statusClass(x.status === "passed")}">${esc(x.status)}</span>`).join(" · ")}</td><td>${seconds(s.wallClockMs)}</td><td>${money(s.usage.costUsd)}</td></tr>`,
    )
    .join("");
  const diff = r.diff
    ? `<h2>Changes since cycle ${r.diff.against}</h2><p class="mute">wall clock ${signPrefix(r.diff.wallClockDeltaMs)}${seconds(r.diff.wallClockDeltaMs)}, cost ${signPrefix(r.diff.costDeltaUsd)}${money(r.diff.costDeltaUsd)}</p>
<p>${r.diff.gatesFlipped.length} gate(s) flipped; ${r.diff.findingsAppeared.length} finding(s) appeared, ${r.diff.findingsDisappeared.length} disappeared.</p>
<ul>${r.diff.gatesFlipped.map((g) => `<li>${esc(g.site)} ${esc(g.stage)} <code>${esc(g.id)}</code>${g.viewport ? ` (${esc(g.viewport)})` : ""}: ${g.from ? "pass" : "fail"} to ${g.to ? "pass" : "fail"}</li>`).join("")}</ul>`
    : "";
  return page(
    `Cycle ${r.cycle}`,
    `<h1>Cycle ${r.cycle}</h1><p class="${statusClass(r.green)}">${r.green ? "green" : "not green"}</p><p class="mute">commit <code>${esc(r.commit)}</code> · ${seconds(r.wallClockMs)} · ${esc(usageLine(r.usage))}</p>
<h2>Sites</h2><div class="table-scroll"><table><thead><tr><th>Site</th><th>Verdict</th><th>Stages</th><th>Wall clock</th><th>Cost</th></tr></thead><tbody>${sites}</tbody></table></div>
${diff}<h2>Findings</h2>${findingsTable(r.findings, relTo)}
<p><a href="REPORT.md">REPORT.md</a> · <a href="report.json">report.json</a> · <a href="FINDINGS.md">FINDINGS.md</a></p>`,
  );
}

/** Writes REPORT.md, report.json and index.html for the cycle and for each of its sites. */
export function writeReports(
  paths: AutopilotPaths,
  cycle: number,
  config: AutopilotConfig = DEFAULT_AUTOPILOT_CONFIG,
): CycleReport {
  const dir = paths.cycleDir(cycle);
  if (!existsSync(dir)) throw new Error(`cycle ${cycle} has no folder (${dir})`);
  const report = buildCycleReport(paths, cycle, config);
  const write = (file: string, body: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  for (const site of report.sites) {
    const siteDir = paths.siteDir(cycle, site.site);
    write(join(siteDir, "REPORT.md"), renderSiteMarkdown(site, siteDir));
    write(join(siteDir, "report.json"), `${JSON.stringify(site, null, 2)}\n`);
    write(join(siteDir, "index.html"), renderSiteHtml(site, siteDir));
  }
  write(join(dir, "REPORT.md"), renderCycleMarkdown(report, dir));
  write(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  write(join(dir, "index.html"), renderCycleHtml(report, dir));
  return report;
}

export const reportIndex = (paths: AutopilotPaths, cycle: number) =>
  join(paths.cycleDir(cycle), "index.html");

export function readReport(paths: AutopilotPaths, cycle: number): CycleReport | undefined {
  try {
    return JSON.parse(readFileSync(join(paths.cycleDir(cycle), "report.json"), "utf8")) as CycleReport;
  } catch {
    return undefined;
  }
}
