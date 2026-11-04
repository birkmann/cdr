import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Harness, MockProvider, searchUnsplashTool, useUnsplashPhotoTool } from "@harness/core";
import { MOCK_MODELS, tempProject, toolCtx } from "./helpers.js";

const accessKey = "test-unsplash-access-key";
const secretKey = "test-unsplash-secret-key";
const location = "https://api.unsplash.com/photos/photo_123/download?ixid=tracking-id";
const photo = {
  id: "photo_123",
  width: 2400,
  height: 1600,
  alt_description: "A forest in the mist",
  urls: {
    regular: "https://images.unsplash.com/photo-123?ixid=tracking-id&w=1080",
    small: "https://images.unsplash.com/photo-123?ixid=tracking-id&w=400",
  },
  user: { name: "Test Photographer", links: { html: "https://unsplash.com/@photographer" } },
  links: { html: "https://unsplash.com/photos/photo_123", download_location: location },
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("UNSPLASH_ACCESS_KEY", accessKey);
  vi.stubEnv("UNSPLASH_SECRET_KEY", secretKey);
  fetchMock = vi.fn().mockImplementation(async () => Response.json({ results: [photo] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Unsplash tools", () => {
  it("searches with server-side auth and returns hotlinks and attribution", async () => {
    const result = await searchUnsplashTool.execute(
      { query: "misty forest", orientation: "landscape", count: 3 },
      toolCtx(tempProject()),
    );
    expect(result.ok).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.origin).toBe("https://api.unsplash.com");
    expect(url.pathname).toBe("/search/photos");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "misty forest",
      orientation: "landscape",
      per_page: "3",
      content_filter: "high",
    });
    expect(options.headers.Authorization).toBe(`Client-ID ${accessKey}`);
    expect(options.redirect).toBe("error");
    const output = JSON.parse(result.output);
    expect(output.photos[0].image_url).toBe(photo.urls.regular);
    expect(output.photos[0].attribution.photographer_url).toBe(
      "https://unsplash.com/@photographer?utm_source=cdr&utm_medium=referral",
    );
    expect(output.photos[0].download_location).toBe(location);
    expect(result.output).not.toContain(accessKey);
    expect(result.output).not.toContain(secretKey);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Search never records unselected photos.
  });

  it("records only the selected photo through its download endpoint", async () => {
    fetchMock.mockResolvedValue(Response.json({ url: photo.urls.regular }));
    const result = await useUnsplashPhotoTool.execute(
      { download_location: location },
      toolCtx(tempProject()),
    );
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0].href).toBe(location);
    expect(useUnsplashPhotoTool.readOnly).toBe(false);
  });

  it.each([
    "http://api.unsplash.com/photos/id/download",
    "https://evil.example/photos/id/download",
    "https://api.unsplash.com.evil.example/photos/id/download",
    "https://user:pass@api.unsplash.com/photos/id/download",
    "https://api.unsplash.com:444/photos/id/download",
    "https://api.unsplash.com/me",
    "https://api.unsplash.com/photos/id/download?client_id=leak",
  ])("rejects untrusted download URL %s before sending credentials", async (download_location) => {
    const result = await useUnsplashPhotoTool.execute({ download_location }, toolCtx(tempProject()));
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates search inputs without making requests", async () => {
    for (const args of [
      { query: " " },
      { query: "x", count: 11 },
      { query: "x", count: 1.5 },
      { query: "x", orientation: "wide" },
    ]) {
      expect((await searchUnsplashTool.execute(args, toolCtx(tempProject()))).ok).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains missing keys and does not use the OAuth secret as a fallback", async () => {
    vi.stubEnv("UNSPLASH_ACCESS_KEY", "");
    const result = await searchUnsplashTool.execute({ query: "forest" }, toolCtx(tempProject()));
    expect(result).toMatchObject({ ok: false, output: expect.stringContaining("Set UNSPLASH_ACCESS_KEY") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])("returns safe actionable HTTP %s errors", async (status) => {
    fetchMock.mockResolvedValue(new Response(`sensitive body ${accessKey}`, { status }));
    const result = await searchUnsplashTool.execute({ query: "forest" }, toolCtx(tempProject()));
    expect(result.ok).toBe(false);
    expect(result.output).toContain(`HTTP ${status}`);
    expect(result.output).not.toContain(accessKey);
  });

  it("handles empty results, malformed responses and network errors", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [] }));
    expect(
      JSON.parse((await searchUnsplashTool.execute({ query: "forest" }, toolCtx(tempProject()))).output)
        .photos,
    ).toEqual([]);
    fetchMock.mockResolvedValueOnce(Response.json({ results: null }));
    expect((await searchUnsplashTool.execute({ query: "forest" }, toolCtx(tempProject()))).ok).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error(`Network failure ${accessKey}`));
    const result = await searchUnsplashTool.execute({ query: "forest" }, toolCtx(tempProject()));
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain(accessKey);
  });

  it("propagates cancellation to the network request", async () => {
    const abort = new AbortController();
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const pending = searchUnsplashTool.execute(
      { query: "forest" },
      { ...toolCtx(tempProject()), signal: abort.signal },
    );
    abort.abort();
    expect(await pending).toEqual({ ok: false, output: "Unsplash request cancelled." });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("works through the agent loop and keeps both keys out of shell tools and events", async () => {
    const mock = new MockProvider({
      replies: [
        { toolCalls: [{ name: "search_unsplash", args: { query: "forest" } }] },
        { toolCalls: [{ name: "use_unsplash_photo", args: { download_location: location } }] },
        {
          toolCalls: [
            {
              name: "bash",
              args: {
                command: 'printf "%s %s" "${UNSPLASH_ACCESS_KEY:-unset}" "${UNSPLASH_SECRET_KEY:-unset}"',
              },
            },
          ],
        },
        { text: `Done ${accessKey} ${secretKey}` },
      ],
    });
    const h = new Harness({
      providers: { mock },
      loadEnv: false,
      skipGlobalConfig: true,
      configOverrides: MOCK_MODELS,
    });
    const s = h.createSession({ projectPath: tempProject(), permissionMode: "auto" });
    expect((await s.chat("Build a page with a forest photo")).status).toBe("completed");
    expect(mock.calls[0].messages[0].content).toContain("search_unsplash");
    const results = s.events.filter((e) => e.type === "tool.result");
    expect(results).toHaveLength(3);
    expect(results.every((e) => e.ok)).toBe(true);
    expect(results[2].output).toContain("unset unset");
    const events = JSON.stringify(s.events);
    expect(events).not.toContain(accessKey);
    expect(events).not.toContain(secretKey);
    expect(events).toContain("[REDACTED]");
  });
});
