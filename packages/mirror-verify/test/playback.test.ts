import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiteConfig, Workspace, type Logger } from "@harness/mirror-core";
import { buildVerifyContext, playback, resolveCheckIds, type PlayerFinding } from "../src/index.js";

// the app template is its own TS project: load the shim the generated apps emit at runtime
const SHIM = new URL("../../mirror-generate/templates/nextjs-contentful/src/lib/render/player-fallback.ts", import.meta.url).href;

const POSTER = "/poster.svg";
const POSTER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#36c"/></svg>';

/**
 * A Kaltura playkit player as ibm.com's hero renders it on a foreign domain: the error overlay turns active
 * asynchronously (after the entry request), the poster stays empty.
 */
const playkit = (msg = "This content is unavailable in this domain.") => `
<style>.playkit-overlay{display:none}.playkit-overlay.playkit-active{display:block}</style>
<div class="playkit-player" style="width:400px;height:300px;background:transparent">
  <div class="playkit-poster"></div>
  <div class="playkit-overlay playkit-error-overlay"><div class="playkit-error-message">${msg}</div></div>
</div>
<script>setTimeout(function () { document.querySelector(".playkit-overlay").classList.add("playkit-active"); }, 300);</script>`;

/** web-component player with a thumbnail state (Carbon for IBM.com <c4d-video-player>): reflects contentState */
const FAKE_C4D = `<script>
customElements.define("fake-video-player", class extends HTMLElement {
  static get observedAttributes() { return ["content-state"]; }
  get contentState() { return this.getAttribute("content-state"); }
  set contentState(v) { this.setAttribute("content-state", v); }
  connectedCallback() { this.style.display = "block"; }
});
</script>`;

function html(body: string, shim: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}${shim ? `<script>${shim}</script>` : ""}</body></html>`;
}

let server: Server;
let base = "";
const dirs: string[] = [];
const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

beforeAll(async () => {
  const { PLAYER_FALLBACK_JS } = (await import(SHIM)) as { PLAYER_FALLBACK_JS: string };
  const pages: Record<string, string> = {
    "/blank": html(playkit(), ""),
    "/poster": html(`<div data-poster="${POSTER}">${playkit()}</div>`, PLAYER_FALLBACK_JS),
    "/no-poster": html(playkit(), PLAYER_FALLBACK_JS),
    "/thumbnail": html(`${FAKE_C4D}<fake-video-player content-state="video" style="width:400px;height:300px">${playkit()}</fake-video-player>`, PLAYER_FALLBACK_JS),
    "/plays": html(`<div class="playkit-player" style="width:400px;height:300px"><div class="playkit-overlay playkit-error-overlay"></div></div>`, PLAYER_FALLBACK_JS),
  };
  server = createServer((req, res) => {
    if (req.url === POSTER) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return void res.end(POSTER_SVG);
    }
    const body = pages[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body ?? "nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function run(urls: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "cmp-playback-"));
  dirs.push(dir);
  const ws = new Workspace("t", dir);
  await ws.init();
  const site = SiteConfig.parse({ site: "t", baseUrl: "http://127.0.0.1:1", urls, crawl: { viewports: [{ name: "desktop", width: 800, height: 600 }] } });
  const cx = await buildVerifyContext({ site, ws, log, options: { playbackSettleMs: 800 } }, { newBaseUrl: base });
  try {
    const r = await playback(cx);
    const players = (r.details as { results: Array<{ path: string; players: PlayerFinding[] }> }).results.flatMap((x) => x.players.map((p) => ({ path: x.path, ...p })));
    return { r, players };
  } finally {
    await cx.close();
  }
}

describe("playback check (ibm.com hero: Kaltura video restricted to ibm.com)", () => {
  it("is part of the default verify run", () => {
    expect(resolveCheckIds()).toContain("playback");
    expect(resolveCheckIds(["players"])).toEqual(["playback"]);
  });

  it("fails on a player that errors without a fallback (the blank hero the reduced-motion screenshots never show)", async () => {
    const { r, players } = await run(["/blank"]);
    expect(r.gates.blank).toEqual({ pass: false, value: 1, threshold: 0 });
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ fallback: null, message: "This content is unavailable in this domain.", w: 400, h: 300 });
    expect(r.issues.find((i) => i.code === "PLAYER_BLANK")).toMatchObject({ severity: "error", actionable: true, ref: "/blank" });
  });

  it("passes when the app's fallback covers the player, and still reports the restriction as a task", async () => {
    const { r, players } = await run(["/poster", "/thumbnail", "/plays"]);
    expect(r.gates.blank).toEqual({ pass: true, value: 0, threshold: 0 });
    expect(players.map((p) => [p.path, p.fallback])).toEqual([
      ["/poster", "poster"],
      ["/thumbnail", "thumbnail"],
    ]);
    const warn = r.issues.filter((i) => i.code === "PLAYER_PLAYBACK_RESTRICTED");
    expect(warn).toHaveLength(2);
    expect(warn.every((i) => i.severity === "warning" && i.actionable && i.message.includes("unavailable in this domain"))).toBe(true);
  });

  it("a player without any poster source stays a failure (fallback 'none')", async () => {
    const { r, players } = await run(["/no-poster"]);
    expect(players[0]?.fallback).toBe("none");
    expect(r.gates.blank.pass).toBe(false);
  });
});

describe("player fallback shim (templates/nextjs-contentful lib/render/player-fallback.ts)", () => {
  it("switches a thumbnail-capable web-component player back to its thumbnail, paints a poster otherwise", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(base + "/thumbnail");
      await page.waitForSelector("[data-cmp-player-fallback]", { state: "attached" });
      expect(await page.getAttribute("fake-video-player", "content-state")).toBe("thumbnail");
      expect(await page.getAttribute("fake-video-player", "data-cmp-player-error")).toBe("This content is unavailable in this domain.");

      await page.goto(base + "/poster");
      await page.waitForSelector("img[data-cmp-player-fallback]", { state: "attached" });
      const img = await page.$eval("img[data-cmp-player-fallback]", (el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, src: new URL((el as HTMLImageElement).src).pathname };
      });
      expect(img).toEqual({ w: 400, h: 300, src: POSTER });
      expect(await page.$eval(".playkit-overlay", (el) => getComputedStyle(el).display)).toBe("none");
    } finally {
      await browser.close();
    }
  });
});
