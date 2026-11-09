import type { Issue } from "@harness/mirror-core";
import { blockedHosts, newCaptureContext, type ViewportSpec } from "../capture.js";
import type { CheckResult, VerifyContext } from "../types.js";
import { finish, notRun, notRunIssue } from "./util.js";

/**
 * Embedded players on the new site, loaded as a visitor sees them (no reduced motion, timers running).
 *
 * The visual check captures with prefers-reduced-motion, where players stay on their thumbnail, so a player that
 * cannot play on the new domain (ibm.com hero: Kaltura SITE_RESTRICTED, "This content is unavailable in this domain")
 * passes parity while every other visitor gets a blank box. This check loads each POC URL with motion on and lists
 * the players in an error state:
 * - covered by the app's fallback (`data-cmp-player-fallback="thumbnail|poster"`, lib/render/player-fallback.ts):
 *   warning PLAYER_PLAYBACK_RESTRICTED (the domain still has to be allowed on the video platform)
 * - not covered: error PLAYER_BLANK, gate `playback.blank` = 0
 */

/** page-side probe (string: runs in the browser, tsx/esbuild helpers must not leak into it) */
export const PLAYER_PROBE_JS = `(() => {
  var SEL = ".playkit-error-overlay.playkit-active, .video-js.vjs-error, .jw-state-error";
  var BOX = ".playkit-player, .video-js, .jwplayer";
  var up = function (n) { if (n.parentElement) return n.parentElement; var r = n.getRootNode && n.getRootNode(); return r && r.host ? r.host : null; };
  var describe = function (el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    var c = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (c.length) s += "." + c.join(".");
    return s;
  };
  var out = [];
  var seen = new Set();
  var add = function (el) {
    var box = (el.closest && el.closest(BOX)) || (el.tagName === "VIDEO" ? el.parentElement || el : el);
    var mark = null, player = null;
    for (var n = el, i = 0; n && i < 15; n = up(n), i++) {
      if (!n.getAttribute) continue;
      if (!mark && n.hasAttribute("data-cmp-player-fallback")) mark = n;
      if (!player && n.tagName.indexOf("-") > 0 && /video|player/i.test(n.tagName)) player = n;
    }
    var top = mark || player || box;
    if (seen.has(top)) return;
    seen.add(top);
    var r = top.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return; // not rendered (closed modal, hidden tab)
    var msgEl = el.querySelector && el.querySelector(".playkit-error-message, .vjs-modal-dialog-content, .jw-error-text");
    var msg = (mark && mark.getAttribute("data-cmp-player-error")) || (msgEl && msgEl.textContent) || (el.error && el.error.message) || "";
    out.push({
      player: describe(player || box),
      fallback: mark ? mark.getAttribute("data-cmp-player-fallback") : null,
      message: msg.replace(/\\s+/g, " ").trim().slice(0, 200),
      x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height),
    });
  };
  document.querySelectorAll(SEL).forEach(add);
  document.querySelectorAll("video").forEach(function (v) { if (v.error && !v.getAttribute("poster")) add(v); });
  return out;
})()`;

export interface PlayerFinding {
  player: string;
  fallback: string | null;
  message: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function playback(cx: VerifyContext): Promise<CheckResult> {
  const issues: Issue[] = [];
  const vps = cx.site.crawl.viewports;
  if (!vps.length || !cx.urls.length) {
    issues.push(notRunIssue("playback", "no viewport or POC url configured"));
    return finish(cx, "playback", { gates: { blank: notRun(0) }, issues });
  }
  const vp: ViewportSpec = [...vps].sort((a, b) => b.width - a.width)[0]!;
  const settleMs = Number(cx.options.playbackSettleMs ?? 6000);
  const browser = await cx.browser();
  const ctx = await newCaptureContext(browser, vp, cx.capture, { motion: true });
  const rows: Array<{ path: string; status: number; players: PlayerFinding[] }> = [];
  let blank = 0;
  let restricted = 0;
  try {
    const page = await ctx.newPage();
    for (const path of cx.urls) {
      let status = 0;
      try {
        const res = await page.goto(cx.newBaseUrl + path, { waitUntil: "load", timeout: 45_000 });
        status = res?.status() ?? 0;
      } catch (e) {
        if (!/timeout/i.test(String(e))) {
          rows.push({ path, status: 0, players: [] });
          continue;
        }
      }
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      // players fetch their entry, then fail asynchronously; scroll once so intersection-started players start too
      await page.evaluate(`(async () => { var h = document.documentElement.scrollHeight; for (var y = 0; y < h && y < 30000; y += innerHeight) { scrollTo(0, y); await new Promise(function (r) { setTimeout(r, 100); }); } scrollTo(0, 0); })()`).catch(() => undefined);
      await page.waitForTimeout(settleMs);
      const players = ((await page.evaluate(PLAYER_PROBE_JS).catch(() => [])) as PlayerFinding[]) ?? [];
      rows.push({ path, status, players });
      for (const p of players) {
        const where = `${path} @${vp.name}: ${p.player} at y${p.y} (${p.w}×${p.h})`;
        const why = p.message ? ` — player says "${p.message}"` : "";
        if (!p.fallback || p.fallback === "none") {
          blank++;
          issues.push({
            severity: "error",
            code: "PLAYER_BLANK",
            message: `${where} cannot play on ${cx.newBaseUrl} and shows nothing${why}. Visitors without reduced motion see an empty box; give the player a poster/thumbnail the app's player fallback can use, or allow the new domain on the video platform`,
            ref: path,
            actionable: true,
          });
        } else {
          restricted++;
          issues.push({
            severity: "warning",
            code: "PLAYER_PLAYBACK_RESTRICTED",
            message: `${where} cannot play on ${cx.newBaseUrl}${why}; the app shows its ${p.fallback} instead. Allow the new domain on the video platform (e.g. the Kaltura access-control profile) to get the motion back`,
            ref: path,
            actionable: true,
          });
        }
      }
    }
  } finally {
    const blocked = blockedHosts(ctx);
    if (blocked.length) issues.push({ severity: "info", code: "PLAYBACK_HOSTS_BLOCKED", message: `requests to non-local hosts aborted: ${blocked.join(", ")}` });
    await ctx.close().catch(() => undefined);
  }
  const loaded = rows.filter((r) => r.status > 0 && r.status < 400).length;
  if (!loaded) issues.push(notRunIssue("playback", `no POC url loaded on ${cx.newBaseUrl}`));
  return finish(cx, "playback", {
    gates: { blank: loaded ? { pass: blank === 0, value: blank, threshold: 0 } : notRun(0) },
    stats: { viewport: vp.name, pages: rows.length, players: blank + restricted, blank, restricted },
    issues,
    details: { viewport: vp, results: rows },
  });
}
