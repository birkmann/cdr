import { describe, expect, it } from "vitest";
import { pageCompleteness, type NetworkEntry } from "../src/crawl.js";

const script = (url: string, extra: Partial<NetworkEntry> = {}): NetworkEntry => ({ url, method: "GET", resourceType: "script", thirdParty: false, ...extra });

describe("pageCompleteness", () => {
  it("flags a page whose lazy chunks are missing and whose app stayed on its fallback", () => {
    const network = [script("http://x/a.chunk.js", { status: 404 }), script("http://x/a.chunk.js", { failure: "net::ERR_ABORTED" }), script("http://x/app.js", { status: 200 })];
    const html = `<div><!--$!--><template></template><div data-testid="loading"></div><!--/$--><img srcset="undefined.transform/w-1440/img.jpg 1440w"></div>`;
    const r = pageCompleteness(network, html);
    expect(r.failedScripts).toEqual(["http://x/a.chunk.js"]); // 404 + abort of the same URL count once
    expect(r.signals).toHaveLength(2);
    expect(r.incomplete).toBe(true);
  });

  it("flags 3+ failed own scripts even without a render marker", () => {
    const r = pageCompleteness([1, 2, 3].map((n) => script(`http://x/${n}.js`, { status: 404 })), "<main>ok</main>");
    expect(r.incomplete).toBe(true);
  });

  it("tolerates a stray failed script, trackers, blocked and third-party requests", () => {
    const network = [
      script("http://x/forms2.min.js", { status: 404 }),
      script("http://x/__ext/tags.tiqcdn.com/utag.js", { status: 404 }),
      script("http://x/akam/13/688ba49", { status: 404 }), // Akamai Bot Manager sensor: never archived, not a render script
      script("http://x/blocked.js", { blocked: true, failure: "net::ERR_FAILED" }),
      script("https://cdn.other/lib.js", { thirdParty: true, status: 500 }),
      script("https://cdn.other/lib2.js", { thirdParty: true, status: 500 }),
    ];
    const r = pageCompleteness(network, "<main>ok</main>");
    expect(r.failedScripts).toEqual(["http://x/forms2.min.js"]);
    expect(r.incomplete).toBe(false);
  });
});
