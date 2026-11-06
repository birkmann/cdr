import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Cdp } from "@harness/capture";

/**
 * Page probe: headless Chrome driven over the DevTools protocol on a pipe (the transport is @harness/capture's Cdp). Loads a page at several
 * viewport sizes and reports what a reviewer would notice: script errors, failed loads,
 * horizontal overflow, broken images and controls without an accessible name.
 */

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

export const VIEWPORTS: Record<string, Viewport> = {
  small: { name: "small", width: 320, height: 740 },
  phone: { name: "phone", width: 390, height: 844 },
  tablet: { name: "tablet", width: 768, height: 1024 },
  desktop: { name: "desktop", width: 1280, height: 900 },
};

export interface ViewportReport {
  viewport: Viewport;
  /** Pixels the document is wider than the viewport (0 = fits). */
  overflowPx: number;
  /** Elements sticking out past the right edge (selector-like descriptions). */
  overflowing: string[];
  images: { total: number; loaded: number; failed: string[]; pending: number };
  /** Visible controls without an accessible name (short HTML excerpts). */
  unnamed: string[];
  counts: { buttons: number; links: number; inputs: number; canvas: number; svg: number; headings: number };
  title: string;
  h1: string[];
  text: string;
  /** PNG screenshot of the viewport (base64), when requested. */
  screenshot?: string;
}

export interface PageReport {
  ok: boolean;
  /** Uncaught exceptions and console.error output, deduplicated. */
  errors: string[];
  /** Other console output. */
  console: string[];
  /** Failed network loads (status or net::ERR). */
  failedRequests: string[];
  viewports: ViewportReport[];
  /** Interaction smoke test (opts.exercise): buttons clicked and errors raised while clicking or after a reload. */
  exercise?: { clicked: number; errors: string[] };
}

/** Runs inside the page: waits for images, then measures. Must be self-contained. */
const PROBE = String.raw`(async () => {
  const deadline = Date.now() + IMAGE_WAIT;
  const eager = () => [...document.images].filter((i) => i.loading !== "lazy" || i.getBoundingClientRect().top < innerHeight);
  while (Date.now() < deadline && eager().some((i) => !i.complete)) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  const de = document.documentElement;
  const width = de.clientWidth;
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += "." + cls.join(".");
    return s;
  };
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o !== "visible") return true;
    }
    return false;
  };
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const overflowPx = Math.max(0, Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0) - width);
  const overflowing = [];
  if (overflowPx > 0) {
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > width + 1 && !clipped(el) && getComputedStyle(el).position !== "fixed") {
        overflowing.push(describe(el) + " (right edge " + Math.round(r.right) + "px)");
        if (overflowing.length >= 5) break;
      }
    }
  }
  const imgs = [...document.images];
  const failed = imgs.filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.getAttribute("src"))).map((i) => (i.currentSrc || i.getAttribute("src")).slice(0, 160));
  const name = (el) => {
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (t) return t;
    }
    if (el.matches("input, select, textarea")) {
      if (el.id) {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l && l.textContent.trim()) return l.textContent.trim();
      }
      const wrap = el.closest("label");
      if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
      if (el.matches("input[type=submit], input[type=button], input[type=reset]") && el.value) return el.value;
      return (el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
    }
    const text = (el.innerText || el.textContent || "").trim();
    if (text) return text;
    const alt = [...el.querySelectorAll("img[alt], svg title")].map((x) => (x.getAttribute("alt") || x.textContent || "").trim()).find(Boolean);
    return alt || (el.getAttribute("title") || "").trim();
  };
  const controls = [...document.querySelectorAll("button, a[href], [role=button], input:not([type=hidden]), select, textarea")].filter(visible);
  const unnamed = controls.filter((el) => !name(el)).slice(0, 8).map((el) => el.outerHTML.replace(/\s+/g, " ").slice(0, 120));
  const count = (sel) => [...document.querySelectorAll(sel)].filter(visible).length;
  return {
    overflowPx,
    overflowing,
    images: { total: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length, failed: failed.slice(0, 8), pending: imgs.filter((i) => !i.complete && i.loading !== "lazy").length },
    unnamed,
    counts: { buttons: count("button, [role=button], input[type=submit], input[type=button]"), links: count("a[href]"), inputs: count("input:not([type=hidden]), select, textarea"), canvas: count("canvas"), svg: [...document.querySelectorAll("svg")].length, headings: count("h1, h2, h3") },
    title: document.title,
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim().replace(/\s+/g, " ")).slice(0, 3),
    text: (document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim().slice(0, 600),
  };
})()`;

/** Clicks every visible, enabled button (three rounds, so buttons revealed by earlier clicks are reached too). */
const EXERCISE = String.raw`(async () => {
  addEventListener("submit", (e) => e.preventDefault(), true);
  window.open = () => null;
  const seen = new WeakSet();
  let clicked = 0;
  const usable = (el) => el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && !el.disabled;
  for (let round = 0; round < 3; round++) {
    const buttons = [...document.querySelectorAll("button, [role=button], summary, input[type=checkbox], input[type=radio]")].filter((b) => usable(b) && !seen.has(b));
    for (const b of buttons.slice(0, 60)) {
      seen.add(b);
      if (!usable(b)) continue;
      b.click();
      clicked++;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  return clicked;
})()`;

function formatConsoleArg(a: any): string {
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  return a.description ?? a.unserializableValue ?? a.type ?? "";
}

/** Load `url` in headless Chrome at each viewport and measure it. */
export async function probePage(
  chrome: string,
  url: string,
  opts: {
    viewports?: Viewport[];
    screenshots?: boolean;
    imageWaitMs?: number;
    signal?: AbortSignal;
    /** After measuring, click through the page at the first viewport and reload it once. */
    exercise?: boolean;
  } = {},
): Promise<PageReport> {
  const viewports = opts.viewports?.length ? opts.viewports : [VIEWPORTS.phone, VIEWPORTS.desktop];
  const profile = mkdtempSync(join(tmpdir(), "harness-chrome-"));
  let child: ChildProcess | undefined;
  let closing = false;
  const kill = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  opts.signal?.addEventListener("abort", kill, { once: true });
  try {
    child = spawn(
      chrome,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        "--hide-scrollbars",
        "--disable-extensions",
        "--disable-background-networking",
        "--allow-file-access-from-files",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    const spawnError = new Promise<never>((_, reject) => child!.once("error", reject));
    const cdp = new Cdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
    const errors: string[] = [];
    const consoleLines: string[] = [];
    const failedRequests: string[] = [];
    const add = (list: string[], s: string) => {
      if (s && !list.includes(s) && list.length < 30) list.push(s);
    };
    const { targetId } = await Promise.race([
      cdp.send("Target.createTarget", { url: "about:blank" }),
      spawnError,
    ]);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const requests = new Map<string, string>();
    cdp.on((method, p, s) => {
      if (s !== sessionId) return;
      if (method === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails ?? {};
        const desc = (d.exception?.description ?? d.text ?? "Error").split("\n")[0];
        add(
          errors,
          `Uncaught ${desc.replace(/^Uncaught /, "")}${d.url ? `  (${d.url.split("/").pop()}:${(d.lineNumber ?? 0) + 1})` : ""}`,
        );
      } else if (method === "Runtime.consoleAPICalled") {
        const text = (p.args ?? []).map(formatConsoleArg).join(" ").slice(0, 300);
        add(p.type === "error" || p.type === "assert" ? errors : consoleLines, text);
      } else if (method === "Network.requestWillBeSent") requests.set(p.requestId, p.request?.url ?? "");
      else if (method === "Network.responseReceived" && p.response?.status >= 400)
        add(failedRequests, `HTTP ${p.response.status} ${String(p.response.url).slice(0, 160)}`);
      else if (method === "Network.loadingFailed" && !p.canceled)
        add(failedRequests, `${p.errorText} ${String(requests.get(p.requestId) ?? "").slice(0, 160)}`);
    });
    await Promise.all([
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
      // Native dialogs would block the headless page; answer them without user input.
      cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source:
            "window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; window.print = () => {};",
        },
        sessionId,
      ),
    ]);
    const reports: ViewportReport[] = [];
    for (const vp of viewports) {
      if (opts.signal?.aborted) throw new Error("Cancelled.");
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      const loaded = cdp.waitFor("Page.loadEventFired", sessionId, 20_000);
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      const res = await cdp.send(
        "Runtime.evaluate",
        {
          expression: PROBE.replace("IMAGE_WAIT", String(opts.imageWaitMs ?? 6000)),
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
        30_000,
      );
      if (res.exceptionDetails) throw new Error(`Probe failed: ${res.exceptionDetails.text}`);
      const report: ViewportReport = { viewport: vp, ...res.result.value };
      if (opts.screenshots) {
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        report.screenshot = shot.data;
      }
      reports.push(report);
    }
    let exercise: PageReport["exercise"];
    if (opts.exercise) {
      const before = errors.length;
      const vp = viewports[0];
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      const loaded = cdp.waitFor("Page.loadEventFired", sessionId, 20_000);
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
      const res = await cdp.send(
        "Runtime.evaluate",
        { expression: EXERCISE, awaitPromise: true, returnByValue: true },
        sessionId,
        60_000,
      );
      // Reload so state saved during the clicks is read back (catches corrupt persisted state).
      const reloaded = cdp.waitFor("Page.loadEventFired", sessionId, 20_000);
      await cdp.send("Page.reload", {}, sessionId);
      await reloaded;
      await new Promise((r) => setTimeout(r, 500));
      exercise = { clicked: res.result?.value ?? 0, errors: errors.slice(before) };
    }
    closing = true;
    await cdp.send("Browser.close").catch(() => undefined);
    const ok =
      errors.length === 0 &&
      reports.every((r) => r.overflowPx === 0 && r.images.failed.length === 0 && r.unnamed.length === 0);
    return {
      ok,
      errors,
      console: consoleLines,
      failedRequests,
      viewports: reports,
      ...(exercise ? { exercise } : {}),
    };
  } finally {
    opts.signal?.removeEventListener("abort", kill);
    // Wait for Chrome to exit before deleting its profile: it keeps writing into
    // the profile while shutting down, which makes rmdir fail with ENOTEMPTY.
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child!.once("exit", () => r()));
      const graceful =
        closing &&
        (await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 2_000)),
        ]));
      if (!graceful) {
        kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
      }
    }
    // Cleanup is best effort and must never replace the probe's result.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* leftover temp dir is harmless */
    }
  }
}

/** Model-readable summary of a probe, listing problems first. */
export function formatPageReport(r: PageReport, file: string, baseUrl?: string): string {
  const short = (u: string) => (baseUrl && u.startsWith(baseUrl) ? u.slice(baseUrl.length) : u);
  const problems: string[] = [];
  for (const e of r.errors) problems.push(`JavaScript error: ${e}`);
  for (const v of r.viewports) {
    const at = `${v.viewport.name} ${v.viewport.width}px`;
    if (v.overflowPx > 0)
      problems.push(
        `Horizontal overflow at ${at}: page is ${v.overflowPx}px wider than the screen. Widest: ${v.overflowing.join(", ") || "unknown"}.`,
      );
  }
  const failed = [...new Set(r.viewports.flatMap((v) => v.images.failed))];
  if (failed.length)
    problems.push(`${failed.length} image(s) failed to load: ${failed.map(short).join(", ")}`);
  const unnamed = [...new Set(r.viewports.flatMap((v) => v.unnamed))];
  if (unnamed.length)
    problems.push(
      `Controls without an accessible name (add text or aria-label): ${unnamed.slice(0, 6).join(" | ")}`,
    );
  const first = r.viewports[r.viewports.length - 1] ?? r.viewports[0];
  const lines = [
    `Checked ${file} at ${r.viewports.map((v) => `${v.viewport.name} ${v.viewport.width}×${v.viewport.height}`).join(", ")}.`,
    problems.length
      ? `Problems to fix (${problems.length}):\n${problems.map((p) => `- ${p}`).join("\n")}`
      : "No problems found.",
  ];
  if (first) {
    lines.push(
      `Title: ${first.title || "(missing <title>)"}; h1: ${first.h1.length ? first.h1.join(" | ") : "(none)"}.`,
      `Elements: ${first.counts.canvas} canvas, ${first.counts.buttons} buttons, ${first.counts.links} links, ${first.counts.inputs} inputs, ${first.counts.svg} svg, ${first.counts.headings} headings.`,
      `Images: ${r.viewports
        .map(
          (v) =>
            `${v.viewport.name} ${v.images.loaded}/${v.images.total} loaded${v.images.pending ? `, ${v.images.pending} still loading` : ""}`,
        )
        .join("; ")}.`,
      `Visible text: ${first.text.slice(0, 400) || "(none)"}`,
    );
  }
  if (r.exercise)
    lines.push(
      `Clicked ${r.exercise.clicked} controls and reloaded: ${r.exercise.errors.length ? `${r.exercise.errors.length} error(s) while interacting` : "no errors"}.`,
    );
  if (r.errors.length === 0) lines.push("No JavaScript errors.");
  if (r.failedRequests.length)
    lines.push(
      `Failed requests:\n${r.failedRequests
        .slice(0, 8)
        .map((l) => l.replace(baseUrl ?? "\0", ""))
        .join("\n")}`,
    );
  if (r.console.length) lines.push(`Console:\n${r.console.slice(0, 10).join("\n")}`);
  lines.push(
    r.exercise
      ? "Note: clicks only reveal errors, not wrong results; check that each control does the right thing by reading your code."
      : "Note: no user input was simulated; test interactions by reading your code carefully.",
  );
  return lines.join("\n");
}
