import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CaptureStore,
  checkReplay,
  importHar,
  isTrackerUrl,
  missKind,
  rewriteHtml,
  rewriteText,
  settleBodies,
  startReplayServer,
  stripWaybackArtefacts,
  type ReplayServer,
} from "@harness/mirror-replay";

const ORIGIN = "https://www.example.test";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452deadbeef", "hex");
const FONT = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const HTML = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><img src="/logo.png"><a href="https://outbound.test/x">out</a><script src="https://cdn.other.test/lib.js"></script></body></html>`;
const CSS = `body{background:url(/logo.png)}`;

let dir: string;
let server: ReplayServer | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdr-replay-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function recordedCrawl(): Promise<CaptureStore> {
  const store = await CaptureStore.open(dir, {
    site: "fixture",
    origin: ORIGIN,
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  await store.put({
    url: `${ORIGIN}/`,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "x=y" },
    body: HTML,
    from: "live:crawl",
  });
  await store.put({
    url: `${ORIGIN}/app.css`,
    status: 200,
    headers: { "content-type": "text/css" },
    body: CSS,
    from: "live:crawl",
  });
  await store.put({
    url: `${ORIGIN}/logo.png`,
    status: 200,
    headers: { "content-type": "image/png" },
    body: PNG,
    from: "live:crawl",
  });
  await store.put({
    url: `${ORIGIN}/font.woff2`,
    status: 200,
    headers: { "content-type": "font/woff2" },
    body: FONT,
    from: "live:crawl",
  });
  await store.put({
    url: `https://cdn.other.test/lib.js`,
    status: 200,
    headers: { "content-type": "text/javascript" },
    body: "window.lib=1",
    from: "live:crawl",
  });
  await store.put({
    url: `${ORIGIN}/old`,
    status: 301,
    headers: { location: `${ORIGIN}/` },
    body: "",
    from: "live:chain",
  });
  await store.save(true);
  return store;
}

describe("capture store", () => {
  it("writes the snapshot layout: an index in raw/ and bodies in assets/, without response cookies", async () => {
    const store = await recordedCrawl();
    const idx = JSON.parse(await readFile(join(dir, "raw/index.json"), "utf8"));
    expect(idx.source).toBe("live");
    expect(idx.entries.map((e: { url: string }) => e.url)).toContain(`${ORIGIN}/logo.png`);
    const png = store.get(`${ORIGIN}/logo.png`)!;
    expect(png.bodyFile).toMatch(/^assets\/[0-9a-f]{64}$/);
    expect((await readFile(join(dir, png.bodyFile))).equals(PNG)).toBe(true);
    expect(store.get(`${ORIGIN}/`)!.headers["set-cookie"]).toBeUndefined();
  });

  it("falls back to the same path with another query string", async () => {
    const store = await CaptureStore.open(dir, { site: "s", origin: ORIGIN });
    await store.put({
      url: `${ORIGIN}/a.js?v=1`,
      status: 200,
      body: "a",
      mime: "text/javascript",
      from: "live:crawl",
    });
    expect(store.lookup(`${ORIGIN}/a.js?v=1`)!.exact).toBe(true);
    expect(store.lookup(`${ORIGIN}/a.js?v=2`)).toMatchObject({
      exact: false,
      entry: { url: `${ORIGIN}/a.js?v=1` },
    });
    expect(store.lookup(`${ORIGIN}/missing.js`)).toBeUndefined();
  });
});

describe("capture store", () => {
  it("stores identical bodies arriving together", async () => {
    const store = await CaptureStore.open(dir, {
      site: "fixture",
      origin: ORIGIN,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const put = (name: string) =>
      store.put({
        url: `${ORIGIN}/${name}.png`,
        status: 200,
        headers: { "content-type": "image/png" },
        body: PNG,
        from: "live:crawl",
      });
    await expect(Promise.all(["a", "b", "c", "d"].map(put))).resolves.toEqual([true, true, true, true]);
  });
});

describe("settleBodies", () => {
  it("does not wait for a body that never ends", async () => {
    await expect(settleBodies([new Promise(() => undefined)], 10)).resolves.toBe(false);
  });
  it("reports every body settled, failed ones included", async () => {
    await expect(settleBodies([Promise.resolve(1), Promise.reject(new Error("x"))], 1000)).resolves.toBe(
      true,
    );
  });
});

describe("replay server", () => {
  it("serves a recorded crawl byte for byte", async () => {
    await recordedCrawl();
    server = await startReplayServer({ captureDir: dir });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const img = await fetch(`${server.url}/logo.png`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    const font = await fetch(`${server.url}/font.woff2`);
    expect(Buffer.from(await font.arrayBuffer()).equals(FONT)).toBe(true);
    // no URL to rewrite: a text body comes back unchanged too
    expect(await (await fetch(`${server.url}/app.css`)).text()).toBe(CSS);
    const store = await CaptureStore.load(dir);
    expect(await checkReplay(store, server.url)).toMatchObject({ total: 6, served: 6, mismatches: [] });
  });

  it("rewrites the origin to the replay and third-party hosts under /__ext/", async () => {
    await recordedCrawl();
    await writeFile(join(dir, "x"), "");
    server = await startReplayServer({ captureDir: dir });
    const html = await (await fetch(`${server.url}/`)).text();
    expect(html).toContain(`${server.url}/__ext/cdn.other.test/lib.js`);
    expect(html).toContain('href="https://outbound.test/x"');
    expect(await (await fetch(`${server.url}/__ext/cdn.other.test/lib.js`)).text()).toBe("window.lib=1");
    const redirect = await fetch(`${server.url}/old`, { redirect: "manual" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe(`${server.url}/`);
  });

  it("answers 204 for trackers and 404, logged, for anything never captured", async () => {
    await recordedCrawl();
    const missesLog = join(dir, "misses.jsonl");
    server = await startReplayServer({ captureDir: dir, missesLog });
    const tracker = await fetch(`${server.url}/__ext/www.google-analytics.com/collect`);
    expect(tracker.status).toBe(204);
    const miss = await fetch(`${server.url}/never/captured.css`, { headers: { "sec-fetch-dest": "style" } });
    expect(miss.status).toBe(404);
    const probe = await fetch(`${server.url}/also/missing`, { method: "HEAD" });
    expect(probe.status).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    const lines = (await readFile(missesLog, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({ method: "GET", url: `${ORIGIN}/never/captured.css`, kind: "stylesheet" }),
      expect.objectContaining({ method: "HEAD", url: `${ORIGIN}/also/missing`, kind: "probe" }),
    ]);
    expect(server.misses.size).toBe(2);
    expect(await (await fetch(`${server.url}/__replay/status`)).json()).toMatchObject({
      origin: ORIGIN,
      entries: 6,
    });
  });

  it("marks every answer as a replay, which the crawl reads as `not captured` on a 404", async () => {
    await recordedCrawl();
    server = await startReplayServer({ captureDir: dir });
    const r = await fetch(`${server.url}/nope`);
    expect(r.headers.get("x-replay")).toBe("1");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

describe("classification", () => {
  it("names what a missed request was for", () => {
    expect(missKind(`${ORIGIN}/a.css`, "GET", "style")).toBe("stylesheet");
    expect(missKind(`${ORIGIN}/a.woff2`, "GET", "font")).toBe("font");
    expect(missKind(`${ORIGIN}/api`, "GET", "empty")).toBe("fetch");
    expect(missKind(`${ORIGIN}/a.css`, "HEAD")).toBe("probe");
    expect(missKind(`${ORIGIN}/page`, "GET")).toBe("probe");
    expect(missKind(`${ORIGIN}/a.js`, "GET")).toBe("script");
  });

  it("treats tracker hosts and sensor paths as trackers", () => {
    expect(isTrackerUrl("https://www.googletagmanager.com/gtm.js")).toBe(true);
    expect(isTrackerUrl(`${ORIGIN}/akam/13/pixel`)).toBe(true);
    expect(isTrackerUrl(`${ORIGIN}/app.js`)).toBe(false);
  });
});

describe("rewrite", () => {
  const opts = { origin: ORIGIN, replayBase: "http://127.0.0.1:4000", extHosts: ["cdn.other.test"] };
  it("rewrites origin and captured third-party URLs, also JSON-escaped ones", () => {
    expect(rewriteText(`url(https://www.example.test/a.png)`, opts)).toBe("url(http://127.0.0.1:4000/a.png)");
    expect(rewriteText(`"https:\\/\\/cdn.other.test\\/lib.js"`, opts)).toBe(
      `"http:\\/\\/127.0.0.1:4000\\/__ext\\/cdn.other.test\\/lib.js"`,
    );
    expect(rewriteHtml(`<a href="https://cdn.other.test/x">y</a>`, opts)).toBe(
      `<a href="https://cdn.other.test/x">y</a>`,
    );
  });
  it("keeps a link the snapshot cannot serve on the original site", () => {
    const keepLink = (href: string) => href.endsWith("/en");
    expect(
      rewriteHtml(
        `<a href="https://www.example.test/en">en</a><a href="https://www.example.test/de">de</a>`,
        {
          ...opts,
          keepLink,
        },
      ),
    ).toBe(`<a href="https://www.example.test/en">en</a><a href="http://127.0.0.1:4000/de">de</a>`);
  });
  it("strips Wayback artefacts", () => {
    const body = stripWaybackArtefacts(
      `<!-- BEGIN WAYBACK TOOLBAR INSERT --><div>wm</div><!-- END WAYBACK TOOLBAR INSERT --><img src="/web/20260101000000im_/https://www.example.test/a.png">`,
    );
    expect(body).toBe(`<img src="https://www.example.test/a.png">`);
  });
});

describe("HAR import", () => {
  it("imports bodies and redirects and drops cookies and non-http entries", async () => {
    const har = {
      log: {
        entries: [
          {
            startedDateTime: "2026-11-01T10:00:00Z",
            request: { method: "GET", url: `${ORIGIN}/` },
            response: {
              status: 200,
              headers: [
                { name: "Content-Type", value: "text/html" },
                { name: "Set-Cookie", value: "a=b" },
              ],
              content: { mimeType: "text/html", text: "<html></html>" },
            },
          },
          {
            startedDateTime: "2026-11-01T10:00:01Z",
            request: { method: "GET", url: `${ORIGIN}/logo.png` },
            response: {
              status: 200,
              headers: [],
              content: { mimeType: "image/png", text: PNG.toString("base64"), encoding: "base64" },
            },
          },
          {
            startedDateTime: "2026-11-01T10:00:02Z",
            request: { method: "GET", url: `${ORIGIN}/old` },
            response: { status: 301, headers: [], redirectURL: `${ORIGIN}/`, content: {} },
          },
          {
            startedDateTime: "2026-11-01T10:00:03Z",
            request: { method: "GET", url: "data:image/png;base64,AAAA" },
            response: { status: 200, headers: [], content: {} },
          },
        ],
      },
    };
    const file = join(dir, "site.har");
    await writeFile(file, JSON.stringify(har));
    const store = await CaptureStore.open(join(dir, "cap"), { site: "s", origin: ORIGIN });
    const r = await importHar(store, file);
    expect(r.imported).toBe(3);
    expect(r.skipped.scheme).toBe(1);
    expect((await store.readBody(store.get(`${ORIGIN}/logo.png`)!)).equals(PNG)).toBe(true);
    expect(store.get(`${ORIGIN}/old`)).toMatchObject({ status: 301, headers: { location: `${ORIGIN}/` } });
    expect(store.get(`${ORIGIN}/`)!.headers["set-cookie"]).toBeUndefined();
  });
});
