#!/usr/bin/env node
// Compare eval runs: one row per task, one column per result file (model, suite, label).
//   node scripts/evals/compare.mjs evals/results/*.json
// Cells show passed/total runs and, for judged tasks, the mean judge score.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const files = process.argv.slice(2).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.error("usage: node scripts/evals/compare.mjs <results.json> [...]");
  process.exit(2);
}
const runs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, "utf8")) }));
const tasks = [...new Set(runs.flatMap((r) => r.results.map((x) => x.id)))].sort();
const header = runs.map((r) => `${r.label ?? r.model}${r.suite ? ` [${r.suite}]` : ""}`);
const cell = (run, id) => {
  const rs = run.results.filter((x) => x.id === id);
  if (!rs.length) return "–";
  const passed = rs.filter((x) => x.passed).length;
  const scores = rs.flatMap((x) => x.checks.filter((c) => typeof c.score === "number").map((c) => c.score));
  const mean = scores.length ? ` · ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}` : "";
  return `${passed}/${rs.length}${mean}`;
};
const rows = [
  ["task", ...header],
  ...tasks.map((id) => [id, ...runs.map((r) => cell(r, id))]),
  [
    "pass rate",
    ...runs.map((r) => `${r.passed}/${r.total} (${Math.round(r.passRate * 100)}%)`),
  ],
  [
    "tokens",
    ...runs.map((r) => String(r.results.reduce((n, x) => n + x.inputTokens + x.outputTokens, 0))),
  ],
  ["file", ...runs.map((r) => basename(r.file))],
];
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
const line = (r) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
console.log(line(rows[0]));
console.log(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
for (const r of rows.slice(1)) console.log(line(r));
