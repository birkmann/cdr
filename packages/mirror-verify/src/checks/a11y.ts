import type { Issue } from "@harness/mirror-core";
import type { Page } from "playwright";
import { loadForCapture, newCaptureContext, type ViewportSpec } from "../capture.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, notRun, notRunIssue } from "./util.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * axe-core with the page-level "has a <main> / an <h1>" checks judged on the page itself. By default they pass while a
 * modal is open (`passForModal`): live ibm.com shows its TrustArc consent overlay, so the original "passed"
 * landmark-one-main and the new site (no consent overlay) failed it, although neither has a main landmark. Old and
 * new must be judged alike, whatever overlay happens to be open. undefined (stock axe) when axe-core can't be read.
 */
const NO_MODAL_PASS_CHECKS = [
  { id: "page-has-main", rule: "landmark-one-main", selector: "main:not([role]), [role='main']" },
  { id: "page-has-heading-one", rule: "page-has-heading-one", selector: "h1:not([role], [aria-level]), :is(h1, h2, h3, h4, h5, h6):not([role])[aria-level=1], [role=heading][aria-level=1]" },
];
let axeSource: string | undefined | null = null;
export function a11yAxeSource(): string | undefined {
  if (axeSource !== null) return axeSource;
  try {
    const req = createRequire(createRequire(import.meta.url).resolve("@axe-core/playwright"));
    const cfg = {
      checks: NO_MODAL_PASS_CHECKS.map((c) => ({ id: c.id, options: { selector: c.selector, passForModal: false } })),
      // the rules carry their own check options (passForModal: true) that override the check's: reference by id only
      rules: NO_MODAL_PASS_CHECKS.map((c) => ({ id: c.rule, all: [c.id] })),
    };
    axeSource = `${readFileSync(req.resolve("axe-core/axe.min.js"), "utf8")}\n;axe.configure(${JSON.stringify(cfg)});`;
  } catch {
    axeSource = undefined;
  }
  return axeSource;
}

type Violations = Record<string, { impact: string; nodes: number; help: string }>;

async function violations(page: Page, url: string, vp: ViewportSpec, exclude: string[]): Promise<Violations | undefined> {
  const status = await loadForCapture(page, url, vp);
  if (!status || status >= 400) return undefined;
  const axeSource = a11yAxeSource();
  const { AxeBuilder } = await import("@axe-core/playwright");
  let b = new AxeBuilder({ page: page as never, ...(axeSource ? { axeSource } : {}) });
  for (const e of exclude) b = b.exclude(e);
  const res = await b.analyze();
  return Object.fromEntries(res.violations.map((v) => [v.id, { impact: v.impact ?? "unknown", nodes: v.nodes.length, help: v.help }]));
}

/** axe-core on old and new per POC url; gate = no new rules / more nodes on the new site. */
export async function accessibility(cx: VerifyContext): Promise<CheckResult> {
  const viewports: ViewportSpec[] = (cx.options.viewports as ViewportSpec[] | undefined) ?? cx.site.crawl.viewports;
  const vp = viewports.find((v) => v.name === "desktop") ?? viewports[viewports.length - 1] ?? { name: "desktop", width: 1440, height: 900 };
  const browser = await cx.browser();
  const ctx = await newCaptureContext(browser, vp, cx.capture);
  const issues: Issue[] = [];
  const rows: Array<Record<string, unknown>> = [];
  let newCount = 0;
  try {
    const page = await ctx.newPage();
    for (const path of cx.urls) {
      const o = await violations(page, cx.oldBaseUrl + path, vp, cx.mask).catch(() => undefined);
      const n = await violations(page, cx.newBaseUrl + path, vp, cx.mask).catch(() => undefined);
      if (!n) {
        issues.push({ severity: "error", code: "A11Y_NOT_RUN", message: `${path}: new page could not be analysed (counted as a new violation)`, ref: path, actionable: true });
        newCount++;
        rows.push({ path, error: "new page failed" });
        continue;
      }
      const base = o ?? {};
      if (!o) issues.push({ severity: "warning", code: "A11Y_NO_BASELINE", message: `${path}: old page not analysed; all violations count as new`, ref: path });
      const diff = (ob: Violations, nb: Violations) =>
        Object.entries(nb)
          .filter(([id, v]) => !ob[id] || v.nodes > ob[id].nodes)
          .map(([id, v]) => ({ id, impact: v.impact, help: v.help, nodes: v.nodes, oldNodes: ob[id]?.nodes ?? 0 }));
      let added = diff(base, n);
      // late-rendering web components (ibm.com's footer locale button) flip a rule on either side between loads:
      // a regression must show up again when both sides are analysed a second time
      let flaky: string[] = [];
      if (added.length && o) {
        const o2 = await violations(page, cx.oldBaseUrl + path, vp, cx.mask).catch(() => undefined);
        const n2 = await violations(page, cx.newBaseUrl + path, vp, cx.mask).catch(() => undefined);
        if (o2 && n2) {
          const again = new Set(diff(o2, n2).map((a) => a.id));
          flaky = added.filter((a) => !again.has(a.id)).map((a) => a.id);
          added = added.filter((a) => again.has(a.id));
          if (flaky.length) issues.push({ severity: "info", code: "A11Y_FLAKY", message: `${path}: ${flaky.join(", ")} differed on one analysis only (timing), not counted`, ref: path });
        }
      }
      const fixed = Object.keys(base).filter((id) => !n[id]);
      newCount += added.length;
      for (const a of added)
        issues.push({ severity: "error", code: "A11Y_REGRESSION", message: `${path}: ${a.id} (${a.impact}) ${a.oldNodes} → ${a.nodes} nodes — ${a.help}`, ref: path, actionable: true });
      rows.push({ path, old: o, new: n, added, fixed, ...(flaky.length ? { flaky } : {}) });
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
  const analysed = rows.filter((r) => !r.error).length;
  if (!analysed) issues.push(notRunIssue("a11y", `none of the ${cx.urls.length} new pages could be analysed`));
  return finish(cx, "a11y", {
    gates: { newViolations: analysed ? { pass: newCount === 0, value: newCount, threshold: 0 } : notRun(0) },
    stats: { pages: cx.urls.length, analysed, notRun: rows.length - analysed, newViolations: newCount, viewport: vp.name },
    issues,
    details: { pages: rows },
  });
}
