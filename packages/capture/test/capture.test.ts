import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CaptureError,
  CdpCaptureDriver,
  DOM_CAPTURE_HASH,
  DOM_CAPTURE_SOURCE,
  PERSONALIZATION_BLOCKLIST,
  cropRows,
  cssImports,
  dataUrl,
  decodePng,
  encodePng,
  findChrome,
  fontFaces,
  isBlockedIp,
  latinRange,
  parseRobots,
  robotsAllow,
  sniff,
  stripOnLoadOverlays,
  unifyAltImages,
  validateUrl,
  wwwVariant,
} from "@harness/capture";
import { serveSite } from "./sites/serve.js";

const asset = (p: string) => readFileSync(new URL(`../assets/${p}`, import.meta.url), "utf8");

describe("embedded capture script", () => {
  it("is in sync with assets/ (run scripts/recreate/embed.mjs after editing them)", () => {
    const script = asset("domCapture.js");
    const blocked = JSON.parse(asset("personalization.json")).urls;
    expect(DOM_CAPTURE_SOURCE).toBe(script);
    expect(PERSONALIZATION_BLOCKLIST).toEqual(blocked);
    const hash = createHash("sha256")
      .update(script)
      .update(JSON.stringify(blocked))
      .digest("hex")
      .slice(0, 16);
    expect(DOM_CAPTURE_HASH).toBe(hash);
    expect(DOM_CAPTURE_SOURCE).toContain("(async function figCapture(opts)");
  });
});

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.20.0.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "fd00::1",
    ])
      expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "2606:4700::1111"]) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it("refuses local hosts, credentials and other schemes unless allowLocal", () => {
    expect(() => validateUrl("http://localhost:3000/")).toThrow(/local host name/);
    expect(() => validateUrl("http://127.0.0.1/")).toThrow(/not a public address/);
    expect(() => validateUrl("https://user:pw@example.com/")).toThrow(/credentials/);
    expect(() => validateUrl("file:///etc/passwd")).toThrow(/only http and https/);
    expect(validateUrl("http://127.0.0.1:8080/", { allowLocal: true }).port).toBe("8080");
    // cloud metadata stays blocked even then
    expect(() => validateUrl("http://169.254.169.254/", { allowLocal: true })).toThrow();
  });
});

describe("robots.txt", () => {
  const rules = parseRobots(
    "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/ok$\nDisallow: /*.pdf$\n",
  );
  it("applies the * group, longest match wins, Allow wins ties", () => {
    expect(robotsAllow(rules, new URL("https://x.de/"))).toBe(true);
    expect(robotsAllow(rules, new URL("https://x.de/private/a"))).toBe(false);
    expect(robotsAllow(rules, new URL("https://x.de/private/ok"))).toBe(true);
    expect(robotsAllow(rules, new URL("https://x.de/doc.pdf"))).toBe(false);
  });
});

describe("asset helpers", () => {
  it("sniffs content, parses @import and @font-face, keeps latin subsets", () => {
    expect(sniff(Buffer.from("wOF2xxxx"))).toBe("font/woff2");
    expect(dataUrl("application/octet-stream", Buffer.from("<svg></svg>"))).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
    expect(
      cssImports(`@import url("a.css"); @import 'https://cdn.x/b.css';`, "https://site.de/css/"),
    ).toEqual(["https://site.de/css/a.css", "https://cdn.x/b.css"]);
    const faces = fontFaces(
      `@font-face { font-family: "Brand"; src: url(f.woff2) format("woff2"), url(f.woff) format('woff'); font-weight: 700; unicode-range: U+0000-00FF; }`,
      "https://site.de/",
    );
    expect(faces[0]).toMatchObject({
      family: "Brand",
      weight: "700",
      src: [{ url: "https://site.de/f.woff2", format: "woff2" }, { format: "woff" }],
    });
    expect(latinRange("U+0000-00FF")).toBe(true);
    expect(latinRange("U+0400-04FF")).toBe(false);
    expect(wwwVariant(new URL("https://bmw.de/x"))?.toString()).toBe("https://www.bmw.de/x");
  });

  it("reuses the capture's image in alt walks when only the resolution differs", () => {
    const snap = {
      root: { id: 1, src: "https://x/a-1200.jpg", natural: { w: 1200, h: 600 } },
      alt: [
        { root: { id: 9, base: 1, src: "https://x/a-600.jpg", natural: { w: 600, h: 300 } } },
        { root: { id: 9, base: 1, src: "https://x/a-crop.jpg", natural: { w: 600, h: 600 } } },
      ],
    };
    unifyAltImages(snap);
    expect(snap.alt[0].root.src).toBe("https://x/a-1200.jpg");
    expect(snap.alt[1].root.src).toBe("https://x/a-crop.jpg");
  });
});

describe("stripOnLoadOverlays", () => {
  it("removes fixed dialogs from the walk at load, keeps headers and small widgets", () => {
    const snap = {
      page: { width: 1280 },
      root: {
        tag: "body",
        children: [
          { tag: "header", layout: { position: "sticky" }, rect: { w: 1280, h: 60 }, children: [] },
          {
            tag: "div",
            attrs: { role: "dialog" },
            layout: { position: "fixed" },
            rect: { w: 560, h: 300 },
            children: [],
          },
          { tag: "dialog", layout: { position: "fixed" }, rect: { w: 400, h: 200 }, children: [] },
          {
            tag: "div",
            attrs: { role: "dialog" },
            layout: { position: "fixed" },
            rect: { w: 60, h: 60 },
            children: [],
          },
        ],
      },
      alt: [
        {
          root: {
            tag: "body",
            children: [
              {
                tag: "div",
                attrs: { role: "alertdialog" },
                layout: { position: "fixed" },
                rect: { w: 500, h: 400 },
              },
            ],
          },
        },
      ],
    };
    expect(stripOnLoadOverlays(snap)).toBe(3);
    expect(snap.root.children.map((c) => c.tag)).toEqual(["header", "div"]);
    expect(snap.alt[0].root.children).toEqual([]);
  });
});

describe("PNG codec", () => {
  it("round-trips packed RGB and crops rows", () => {
    const img = { width: 3, height: 4, data: Uint8Array.from({ length: 36 }, (_, i) => (i * 7) % 256) };
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(3);
    expect([...back.data]).toEqual([...img.data]);
    expect(cropRows(img, 1, 2).data.length).toBe(18);
  });
});

const chrome = findChrome();

describe.skipIf(!chrome)("CDP capture driver (fixture site, headless Chrome)", () => {
  it("captures the fixture with its menu, drill-down level, alt walk, webfont, images and a live shot", async () => {
    const site = await serveSite("acme");
    try {
      const d = new CdpCaptureDriver();
      const r = await d.capture(
        site.url,
        { width: 390, alt: [600] },
        { guard: { allowLocal: true }, respectRobots: false, shotWidths: [390] },
      );
      expect(r.snapshot.root).toBeTruthy();
      expect((r.snapshot.states ?? []).map((s: { kind: string }) => s.kind)).toEqual(["menu", "submenu"]);
      expect(r.snapshot.alt).toHaveLength(1);
      expect(r.snapshot.alt[0].width).toBe(600);
      expect(Object.keys(r.snapshot.assets).length).toBeGreaterThanOrEqual(5);
      expect(r.snapshot.embeddedFonts.map((f: { family: string }) => f.family)).toContain("Acme Sans");
      expect(r.shots).toHaveLength(1);
      expect(r.shots[0].width).toBe(390);
      expect(r.shots[0].texts).toContain("Gear for every trail");
      expect(r.shots[0].overflowPx).toBe(0);
      // the consent banner was dismissed before the shot
      expect(r.shots[0].texts).not.toContain("We use cookies to improve your visit.");
    } finally {
      await site.close();
    }
  }, 120_000);

  it("dismisses on-load overlays (a late region switcher, a newsletter modal) in the capture and the live shot", async () => {
    const site = await serveSite("overlays");
    try {
      const r = await new CdpCaptureDriver().capture(
        site.url,
        { width: 1280 },
        { guard: { allowLocal: true }, respectRobots: false, shotWidths: [1280] },
      );
      const json = JSON.stringify(r.snapshot.root);
      expect(json).toContain("Willkommen auf der Seite");
      expect(json).not.toContain("Ihre aktuelle Region");
      expect(json).not.toContain("Newsletter abonnieren");
      const texts = r.shots[0].texts ?? [];
      expect(texts).toContain("Willkommen auf der Seite");
      expect(texts.some((t) => /Ihre aktuelle Region|Newsletter abonnieren/.test(t))).toBe(false);
      // the header and navigation stay
      expect(json).toContain("Produkte");
    } finally {
      await site.close();
    }
  }, 120_000);

  it("bypasses the page's own CSP: a stylesheet it refuses (served from another host) still styles the capture", async () => {
    const site = await serveSite("csp");
    try {
      const r = await new CdpCaptureDriver().capture(
        site.url,
        { width: 800 },
        { guard: { allowLocal: true }, respectRobots: false, shotWidths: [] },
      );
      expect(JSON.stringify(r.snapshot.root)).toContain("rgb(18, 52, 86)");
    } finally {
      await site.close();
    }
  }, 120_000);

  it("refuses private addresses without allowLocal", async () => {
    const site = await serveSite("acme");
    try {
      await expect(
        new CdpCaptureDriver().capture(site.url, { width: 390 }, { respectRobots: false }),
      ).rejects.toBeInstanceOf(CaptureError);
    } finally {
      await site.close();
    }
  });
});
