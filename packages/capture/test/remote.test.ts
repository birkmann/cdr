// The remote capture driver against a local fake capture service (node:http on 127.0.0.1; no network).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaptureError, RemoteCaptureDriver, type CaptureDriver, type Shot } from "@harness/capture";

type Handler = (body: any, req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const seen: Array<{ route: string; body: any; auth?: string }> = [];
let server: Server;
let base = "";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ route: req.url ?? "", body, auth: req.headers.authorization });
      const h = req.method === "POST" ? routes.get(req.url ?? "") : undefined;
      if (!h) return json(res, 404, { message: "not found" });
      h(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const SNAPSHOT = {
  url: "https://example.com/",
  finalUrl: "https://example.com/en/",
  root: { kind: "element", tag: "body", children: [] },
};

describe("RemoteCaptureDriver", () => {
  it("probes the layout through /api/import/url/layout", async () => {
    routes.set("/api/import/url/layout", (b, _q, res) =>
      json(res, 200, {
        breakpoints: [{ px: 768, rules: 12, source: "media" }, { px: 1024 }, { nope: 1 }],
        samples: 7,
      }),
    );
    const d = new RemoteCaptureDriver(base, { token: "t0k" });
    expect(d.id).toBe("remote");
    const p = await d.probe("https://example.com");
    expect(p.breakpoints.map((b) => b.px)).toEqual([768, 1024]);
    expect(p.breakpoints[1]).toMatchObject({ rules: 0, source: "media" });
    expect(p.samples).toBe(7);
    const last = seen.at(-1)!;
    expect(last.body).toMatchObject({ url: "https://example.com/", width: 1440 });
    expect(last.auth).toBe("Bearer t0k");
  });

  it("captures through /api/import/url with alt / menus / brand, and skips live shots without a local browser", async () => {
    routes.set("/api/import/url", (_b, _q, res) => json(res, 200, SNAPSHOT));
    const d = new RemoteCaptureDriver(base);
    const r = await d.capture(
      "https://example.com/",
      { width: 1440, alt: [1280], menus: [1280] },
      { shotWidths: [1280, 1440] },
    );
    expect(seen.at(-1)!.body).toEqual({
      url: "https://example.com/",
      width: 1440,
      alt: [1280],
      menus: [1280],
      brand: true,
    });
    expect(r.snapshot).toEqual(SNAPSHOT);
    expect(r.finalUrl).toBe("https://example.com/en/");
    expect(r.shots).toEqual([]);
    expect(r.skipped.join(" ")).toMatch(/live shots/);
  });

  it("takes live shots through the optional /api/shoot route (base64 PNGs → Buffers)", async () => {
    routes.set("/api/shoot", (b, _q, res) =>
      json(res, 200, {
        shots: b.widths.map((w: number) => ({
          width: w,
          height: 900,
          png: Buffer.from(`png${w}`).toString("base64"),
          texts: ["Hi"],
        })),
      }),
    );
    const local: CaptureDriver = {
      id: "fake-local",
      probe: async () => ({ url: "", breakpoints: [], samples: 0, ms: 0 }),
      capture: async () => {
        throw new Error("unused");
      },
      shoot: async (_u, widths): Promise<Shot[]> =>
        widths.map((w) => ({ width: w, height: 1, png: Buffer.from("local") })),
    };
    const d = new RemoteCaptureDriver(base, { local });
    const r = await d.capture("https://example.com/", { width: 1440 }, { shotWidths: [390, 1440] });
    expect(r.shots.map((s) => [s.width, s.png.toString()])).toEqual([
      [390, "png390"],
      [1440, "png1440"],
    ]);
    expect(r.shots[0].texts).toEqual(["Hi"]);
    // the recreated output (file://) goes to the local browser
    const out = await d.shoot("file:///tmp/out/index.html", [390], { guard: false });
    expect(out[0].png.toString()).toBe("local");
    routes.delete("/api/shoot");
  });

  it("shoot without the route or for local files: a clear browser_unavailable", async () => {
    const d = new RemoteCaptureDriver(base);
    await expect(d.shoot("https://example.com/", [390])).rejects.toMatchObject({
      code: "browser_unavailable",
      message: expect.stringMatching(/\/api\/shoot/),
    });
    await expect(d.shoot("file:///x/index.html", [390], { guard: false })).rejects.toMatchObject({
      code: "browser_unavailable",
    });
  });

  it("maps the service's error envelope and refuses private targets before sending", async () => {
    routes.set("/api/import/url", (_b, _q, res) =>
      json(res, 403, { error: { code: "robots", message: "disallowed by robots.txt" } }),
    );
    const d = new RemoteCaptureDriver(base);
    const err = await d.capture("https://example.com/", { width: 390 }).catch((e) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ code: "robots", message: expect.stringContaining("disallowed") });
    routes.set("/api/import/url", (_b, _q, res) =>
      json(res, 504, { error: { code: "upstream_timeout", message: "slow" } }),
    );
    await expect(d.capture("https://example.com/", { width: 390 })).rejects.toMatchObject({
      code: "load_failed",
    });
    const n = seen.length;
    await expect(d.capture("http://127.0.0.1:9/", { width: 390 })).rejects.toMatchObject({
      code: "blocked_address",
    });
    await expect(d.probe("ftp://example.com/")).rejects.toMatchObject({ code: "invalid_url" });
    expect(seen.length).toBe(n);
  });

  it("an unreachable service is browser_unavailable; an aborted run is cancelled", async () => {
    const dead = new RemoteCaptureDriver("http://127.0.0.1:1/");
    await expect(dead.probe("https://example.com/")).rejects.toMatchObject({ code: "browser_unavailable" });
    const ac = new AbortController();
    ac.abort();
    await expect(
      new RemoteCaptureDriver(base).capture("https://example.com/", { width: 390 }, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(() => new RemoteCaptureDriver("not a url")).toThrow(CaptureError);
  });
});
