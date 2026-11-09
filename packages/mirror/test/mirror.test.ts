import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostLlmClient,
  guardedFetch,
  testSiteConfig,
  tryLlmJson,
  withRunScope,
  Workspace,
  type HostComplete,
} from "@harness/mirror-core";
import { parseRecreateRequest } from "@harness/server";
import { reduceRecreate } from "@harness/client";
import { blockReason, MIRROR_CONSENT_REASON, MIRROR_STAGES, pageLocales, previewHtml, runMirror, type MirrorHost } from "@harness/mirror";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cdr-mirror-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const host = (o: Partial<MirrorHost> = {}): MirrorHost & { events: { type: string }[] } => {
  const events: { type: string }[] = [];
  return {
    projectRoot: root,
    config: {},
    progress: (e) => events.push(e),
    log: () => undefined,
    consent: async () => ({ by: "user", at: "now", mode: "ask" }),
    events,
    ...o,
  };
};

const answer = (text: string, costUsd = 0.01) => ({ text, promptTokens: 10, completionTokens: 5, costUsd });

describe("runMirror", () => {
  it("captures nothing and leaves no run folder when consent is denied", async () => {
    const h = host({ consent: async () => null });
    const r = await runMirror({ url: "https://example.com/", mode: "mirror" }, h);
    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/Consent was not given/);
    expect(existsSync(join(root, r.dir))).toBe(false);
    expect(h.events.some((e) => e.type === "recreate.finished")).toBe(true);
  });

  it("refuses a private address before any stage writes a site", async () => {
    const r = await runMirror({ url: "http://127.0.0.1:9/", mode: "mirror" }, host());
    expect(r.status).toBe("failed");
    expect(r.manifest.stages.crawl?.status).toBe("failed");
    expect(existsSync(join(root, r.dir, "sites"))).toBe(false);
  });

  it('refuses recreate.assets "none": a mirror re-serves the files', async () => {
    await expect(runMirror({ url: "https://example.com/", mode: "mirror" }, host({ config: { assets: "none" } }))).rejects.toThrow(/assets/);
  });

  it("names what is copied in the consent notice, and runs the stages in the source pipeline's order", () => {
    expect(MIRROR_CONSENT_REASON("https://x.de")).toMatch(/markup, stylesheets, scripts, images and fonts/);
    expect(MIRROR_STAGES).toEqual(["consent", "crawl", "ccm", "design", "generate", "appbuild", "serve", "verify", "fix", "reverify", "report"]);
  });
});

describe("source intake", () => {
  const res = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

  it("treats bot-management answers as blocks and a CDN's plain 404 as a missing page", () => {
    expect(blockReason(res(403, { "cf-mitigated": "challenge" }), "")).toBe("Cloudflare challenge");
    expect(blockReason(res(403), "")).toBe("HTTP 403");
    expect(blockReason(res(404, { server: "AkamaiGHost" }), "")).toBeUndefined();
    expect(blockReason(res(503, { server: "AkamaiGHost" }), "")).toBe("Akamai, HTTP 503");
    expect(blockReason(res(200), "<html>welcome</html>")).toBeUndefined();
  });

  it("reads the document language first, then hreflang alternates", () => {
    expect(pageLocales('<html lang="de"><link hreflang="en"><link hreflang="x-default"><link hreflang="de">')).toEqual(["de", "en"]);
    expect(pageLocales("<html>")).toEqual(["en"]);
  });
});

describe("guardedFetch", () => {
  it("checks every redirect hop", async () => {
    const fetchMock = vi.fn(async (u: URL) =>
      u.host === "public.test" ? new Response(null, { status: 302, headers: { location: "http://internal.test/" } }) : new Response("secret"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const guard = (u: URL) => u.host !== "internal.test";
    await expect(withRunScope({ guard }, () => guardedFetch("http://public.test/"))).rejects.toThrow(/refused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the redirect itself with redirect: manual", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 301, headers: { location: "http://b.test/" } })));
    const r = await withRunScope({ guard: () => true }, () => guardedFetch("http://a.test/", { redirect: "manual" }));
    expect(r.status).toBe(301);
  });
});

describe("host model client", () => {
  const ws = () => new Workspace("run", root);
  const site = (sendContent: boolean) => testSiteConfig({ site: "run", llm: { sendContent, stepModels: {} } });
  const req = { step: "t", messages: [{ role: "user" as const, content: "hi" }], json: true };

  it("has no client without a host model, so callers take their deterministic path", () => {
    expect(createHostLlmClient(ws(), site(false), undefined)).toBeUndefined();
  });

  it("caches validated answers, and a hit makes no call", async () => {
    const complete = vi.fn<HostComplete>(async () => answer('{"a":1}'));
    const llm = createHostLlmClient(ws(), site(false), complete)!;
    expect((await llm.complete(req)).parsed).toEqual({ a: 1 });
    const again = await llm.complete(req);
    expect(again.cached).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries once with the validator's error, then gives up without caching", async () => {
    const complete = vi.fn<HostComplete>(async () => answer('{"a":1}'));
    const llm = createHostLlmClient(ws(), site(false), complete)!;
    const validate = () => {
      throw new Error("nope");
    };
    await expect(llm.complete({ ...req, validate, schemaId: "s@1" })).rejects.toThrow(/validation twice/);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].at(-1)?.content).toMatch(/nope/);
    expect((await ws().list("llm-cache", ".json")).length).toBe(0);
  });

  it("sends images only with sendContent, and never logs the prompt text", async () => {
    const complete = vi.fn<HostComplete>(async () => answer('{"a":1}'));
    const png = "data:image/png;base64,AAAA";
    const withImage = { ...req, messages: [{ role: "user" as const, content: "secret page text", images: [png] }] };
    await createHostLlmClient(ws(), site(false), complete)!.complete({ ...withImage, cache: false });
    expect(complete.mock.calls[0][0][0].images).toBeUndefined();
    await createHostLlmClient(ws(), site(true), complete)!.complete({ ...withImage, cache: false });
    expect(complete.mock.calls[1][0][0].images).toEqual([png]);
    const logs = await ws().list("llm-log", ".json");
    expect(logs.length).toBe(2);
    for (const f of logs) expect(readFileSync(ws().path(f), "utf8")).not.toContain("secret page text");
  });

  it("tryLlmJson falls through to undefined when the model fails", async () => {
    const llm = createHostLlmClient(ws(), site(false), async () => {
      throw new Error("down");
    });
    expect(await tryLlmJson(llm, { step: "t", messages: [{ role: "user", content: "x" }] })).toBeUndefined();
  });
});

describe("mirror events and requests", () => {
  it("reduces verify gates and fix attempts into the run view", () => {
    const base = { seq: 1, ts: "t", sessionId: "s", runId: "r" };
    let st = reduceRecreate(undefined, { ...base, type: "recreate.started", url: "u", widths: [], targets: ["mirror"], mode: "mirror", dir: "d" } as never);
    const gate = { ...base, type: "recreate.verify", stage: "verify", check: "visual", gate: "visual.parity", issues: 0, advisory: false };
    st = reduceRecreate(st, { ...gate, pass: false, value: 0.5 } as never);
    st = reduceRecreate(st, { ...gate, stage: "reverify", pass: true, value: 0.99 } as never);
    st = reduceRecreate(st, { ...base, type: "recreate.fix", handler: "parity-fix", target: "t", accepted: true, reason: "improved" } as never);
    expect(st.runs.r.mode).toBe("mirror");
    expect(Object.keys(st.runs.r.verify!)).toEqual(["visual.parity"]);
    expect(st.runs.r.verify!["visual.parity"].pass).toBe(true);
    expect(st.runs.r.fixes).toHaveLength(1);
  });

  it("validates mode, fix and pages on POST /recreate", () => {
    expect(parseRecreateRequest({ url: "https://a.de", mode: "mirror", fix: false, pages: 3 })).toMatchObject({ mode: "mirror", fix: false, pages: 3 });
    expect(parseRecreateRequest({ url: "https://a.de", mode: "copy" })).toMatch(/mode/);
    expect(parseRecreateRequest({ url: "https://a.de", pages: 0 })).toMatch(/pages/);
    expect(parseRecreateRequest({ url: "https://a.de", fix: "no" })).toMatch(/fix/);
  });
});

describe("preview snapshot", () => {
  it("makes root-relative URLs relative and drops the Next.js runtime", () => {
    const out = previewHtml(
      '<link rel="stylesheet" href="/_next/static/css/a.css"><script src="/_next/static/chunks/b.js" async></script><script>self.__next_f.push([1,"x"])</script>' +
        '<img src="/a.png" srcset="/a.png 1x, /b.png 2x"><a href="//cdn.test/x">x</a><div style="background:url(/c.png)"></div><script src="/site.js"></script>',
    );
    expect(out).toContain('href="_next/static/css/a.css"');
    expect(out).not.toContain("chunks/b.js");
    expect(out).not.toContain("__next_f");
    expect(out).toContain('src="a.png" srcset="a.png 1x, b.png 2x"');
    expect(out).toContain('href="//cdn.test/x"');
    expect(out).toContain("url(c.png)");
    expect(out).toContain('src="site.js"');
  });
});
