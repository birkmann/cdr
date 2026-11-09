import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiteConfig, Workspace, type Logger } from "@harness/mirror-core";
import { buildVerifyContext, linkCheck } from "../src/index.js";

// the live original (old base = site baseUrl, not a replay); .invalid never resolves, nothing is contacted
const PROD = "https://www.prod.invalid";

let server: Server;
let base = "";
const dirs: string[] = [];
const log: Logger = { info() {}, warn() {}, error() {}, debug() {} };

beforeAll(async () => {
  const page = `<!doctype html><html><head><title>t</title></head><body>
<a href="${PROD}/solutions/streamhouse?lnk=hpls1us">out of scope, production</a>
<a href="${PROD}/us-en">migrated page, absolute</a>
<a href="http://localhost:4490/de/x">replay leak</a>
</body></html>`;
  server = createServer((req, res) => {
    res.writeHead(req.url === "/us-en" ? 200 : 404, { "content-type": "text/html" });
    res.end(req.url === "/us-en" ? page : "nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("links: absolute links to a live original's production origin (ibm.com LINK_HOST_LEAK)", () => {
  it("accepts out-of-scope production links, flags absolute links to migrated pages and replay/localhost hosts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmp-links-prod-"));
    dirs.push(dir);
    const ws = new Workspace("t", dir);
    await ws.init();
    const site = SiteConfig.parse({ site: "t", baseUrl: PROD, urls: ["/us-en"], crawl: { viewports: [{ name: "desktop", width: 800, height: 600 }] } });
    const cx = await buildVerifyContext({ site, ws, log }, { newBaseUrl: base, productionOrigin: undefined });
    try {
      const r = await linkCheck(cx);
      const leaks = (r.details as { hostLeaks: Array<{ href: string }> }).hostLeaks.map((l) => l.href).sort();
      expect(leaks).toEqual(["http://localhost:4490/de/x", `${PROD}/us-en`]);
      expect(r.stats.productionLinks).toBe(1);
      expect(r.issues.find((i) => i.code === "LINK_TO_PRODUCTION")?.message).toContain("/solutions/streamhouse");
    } finally {
      await cx.close();
    }
  });
});
