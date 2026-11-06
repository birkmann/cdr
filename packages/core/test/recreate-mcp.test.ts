// `cdr mcp recreate`: the JSON-RPC server in process (streams, no subprocess). The capture runs through the remote
// driver (config recreate.driver = "remote") against a local fake capture service replaying the recorded acme
// snapshots, so an MCP client runs capture → build → measure → convert without a browser or the network.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_CONFIG, type HarnessConfig } from "@harness/protocol";
import { RecreateMcpServer } from "@harness/core";
import { RunDir } from "@harness/recreate";
import { tempProject } from "./helpers.js";

const REC = new URL("../../capture/test/sites/acme/recorded/", import.meta.url);
let service: Server;
let base = "";
const hits: string[] = [];

beforeAll(async () => {
  service = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits.push(req.url ?? "");
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/import/url/layout")
        return res.end(
          JSON.stringify({
            breakpoints: [
              { px: 768, rules: 4, source: "media", structural: 0.4, shifted: 0.6 },
              { px: 1024, rules: 6, source: "media", structural: 0.5, shifted: 0.8 },
            ],
          }),
        );
      if (req.url === "/api/import/url")
        return res.end(readFileSync(new URL(`${body.width}.snapshot.json`, REC)));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => service.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => service.close(() => r())));

/** A tiny MCP client over in-process streams. */
function connect(server: RecreateMcpServer) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = server.serve(input, output);
  const replies = new Map<number, (m: any) => void>();
  const notes: any[] = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (m.id !== undefined && m.id !== null && replies.has(m.id)) replies.get(m.id)!(m);
      else notes.push(m);
    }
  });
  let next = 0;
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = ++next;
    return new Promise((resolve) => {
      replies.set(id, resolve);
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const call = async (name: string, args: unknown, meta?: unknown) =>
    (await request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result;
  return { request, call, notes, input, close: () => (input.end(), done) };
}

const config = (extra: Partial<HarnessConfig["recreate"]> = {}): HarnessConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  recreate: { driver: "remote", remoteUrl: base, ...extra },
});

describe("cdr mcp recreate (JSON-RPC over stdio)", () => {
  it("initializes, lists the stage tools and answers protocol errors", async () => {
    const c = connect(new RecreateMcpServer({ projectRoot: tempProject(), config: config() }));
    const init = await c.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "cdr-recreate" },
      capabilities: { tools: {} },
    });
    c.input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    expect((await c.request("ping")).result).toEqual({});
    const list = (await c.request("tools/list")).result.tools;
    expect(list.map((t: { name: string }) => t.name)).toEqual([
      "recreate_capture",
      "recreate_build",
      "recreate_measure",
      "recreate_components",
      "recreate_convert",
    ]);
    expect(list[0].inputSchema.required).toEqual(["url", "consent"]);
    // recreate_measure shoots the output and writes files
    expect(list[2].annotations.readOnlyHint).toBe(false);
    // a run id that is a path is refused (no file outside .harness/recreate is touched)
    const bad = (await c.request("tools/call", { name: "recreate_build", arguments: { run: "../../.." } }))
      .result;
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/not a run id/);
    expect((await c.request("nope/method")).error.code).toBe(-32601);
    expect((await c.request("tools/call", { name: "rm_rf" })).error.code).toBe(-32602);
    c.input.write("{not json\n");
    await c.close();
    expect(c.notes.some((n) => n.error?.code === -32700)).toBe(true);
    // the notification got no reply
    expect(c.notes.filter((n) => n.id === undefined && !n.method)).toHaveLength(0);
  });

  it("recreate_capture without consent: true captures nothing and returns the notice", async () => {
    const root = tempProject();
    const c = connect(new RecreateMcpServer({ projectRoot: root, config: config() }));
    const before = hits.length;
    const r = await c.call("recreate_capture", { url: "https://acme.example/" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Consent required[\s\S]*You are responsible/);
    const r2 = await c.call("recreate_capture", { url: "https://acme.example/", consent: "yes" });
    expect(r2.isError).toBe(true);
    expect(hits.length).toBe(before);
    await c.close();
  });

  it("an MCP client runs capture → build → measure → convert (design-md + a plugin emitter)", async () => {
    // vitest (vite-node) only imports modules under the workspace root: this project lives in node_modules/.cache
    const cache = fileURLToPath(new URL("../../../node_modules/.cache/", import.meta.url));
    mkdirSync(cache, { recursive: true });
    const root = mkdtempSync(join(cache, "recreate-mcp-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "tools"));
    writeFileSync(
      join(root, "tools/emit-hello.mjs"),
      'export default { id: "hello-mcp", description: "test", emit: (input) => ({ "hello.txt": `${input.screens.length} screens` }) };\n',
    );
    const c = connect(
      new RecreateMcpServer({ projectRoot: root, config: config({ emitters: ["./tools/emit-hello.mjs"] }) }),
    );
    await c.request("initialize", { protocolVersion: "2025-06-18" });
    const cap = await c.call(
      "recreate_capture",
      { url: "https://acme.example/", consent: true },
      { progressToken: "p1" },
    );
    expect(cap.isError, cap.content[0].text).toBe(false);
    const run = /Run (\S+) /.exec(cap.content[0].text)![1];
    const dir = new RunDir(root, run);
    expect(dir.manifest().consent).toMatchObject({ by: "user", mode: "ask" });
    expect(dir.exists("capture/1440.snapshot.json")).toBe(true);
    expect(hits).toContain("/api/import/url/layout");
    // progress went out as MCP notifications
    expect(
      c.notes.some((n) => n.method === "notifications/message" && n.params.data.type === "recreate.stage"),
    ).toBe(true);
    expect(
      c.notes.some((n) => n.method === "notifications/progress" && n.params.progressToken === "p1"),
    ).toBe(true);

    const build = await c.call("recreate_build", { run });
    expect(build.isError, build.content[0].text).toBe(false);
    expect(dir.exists("out/static/index.html")).toBe(true);
    // the remote service has no /api/shoot: no live shots, so measure reports it skipped
    const measure = await c.call("recreate_measure", { run });
    expect(measure.isError, measure.content[0].text).toBe(false);
    expect(dir.manifest().stages.measure?.status).toBe("skipped");

    const md = await c.call("recreate_convert", { run, to: "design-md" });
    // (isError follows the run's gates: the acme components lint fails with fallback names, the output is written)
    expect(md.content[0].text).toMatch(/Written to .*out\/design-md/);
    const text = readFileSync(dir.path("out/design-md/DESIGN.md"), "utf8");
    expect(text.startsWith("---\nversion: alpha\n")).toBe(true);
    const lint = JSON.parse(readFileSync(dir.path("out/design-md/lint.json"), "utf8"));
    expect(
      lint.errors,
      JSON.stringify(lint.findings.filter((f: { severity: string }) => f.severity === "error")),
    ).toBe(0);

    const hello = await c.call("recreate_convert", { run, to: "hello-mcp" });
    expect(hello.content[0].text).toMatch(/Written to .*out\/hello-mcp/);
    expect(readFileSync(dir.path("out/hello-mcp/hello.txt"), "utf8")).toMatch(/\d+ screens/);
    await c.close();
  }, 120_000);
});
