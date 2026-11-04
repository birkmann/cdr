/**
 * Minimal MCP client (JSON-RPC 2.0) over stdio or streamable HTTP. External tools are exposed
 * to the agent as normal tools named `mcp__<server>__<tool>`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "@harness/protocol";
import type { Tool } from "./tools/types.js";
import { parseSSE } from "./providers/types.js";
import { HARNESS_VERSION } from "@harness/protocol";

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

const PROTOCOL = "2025-06-18";

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  private sessionId?: string;

  constructor(
    readonly name: string,
    private readonly cfg: McpServerConfig,
  ) {}

  async connect(timeoutMs = 20_000): Promise<void> {
    if (this.cfg.command) {
      this.child = spawn(this.cfg.command, this.cfg.args ?? [], {
        env: { ...process.env, ...(this.cfg.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stdout.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
      this.child.stderr.on("data", () => {});
      this.child.on("exit", () => {
        for (const p of this.pending.values()) p.reject(new Error(`MCP server ${this.name} exited`));
        this.pending.clear();
      });
    } else if (!this.cfg.url) throw new Error(`MCP server ${this.name}: needs command or url`);
    await withTimeout(
      this.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "cdr", version: HARNESS_VERSION },
      }),
      timeoutMs,
      `MCP ${this.name} initialize`,
    );
    await this.notify("notifications/initialized", {});
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        /* ignore non-JSON output */
      }
    }
  }

  private handleMessage(msg: any) {
    if (msg.id === undefined || !this.pending.has(msg.id)) return;
    const p = this.pending.get(msg.id)!;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP ${this.name}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  }

  async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    if (this.child) {
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.child!.stdin.write(JSON.stringify(payload) + "\n");
      });
    }
    return this.httpSend(payload, id);
  }

  async notify(method: string, params: unknown): Promise<void> {
    const payload = { jsonrpc: "2.0", method, params };
    if (this.child) this.child.stdin.write(JSON.stringify(payload) + "\n");
    else await this.httpSend(payload);
  }

  private async httpSend(payload: unknown, id?: number): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.cfg.url!, { method: "POST", headers, body: JSON.stringify(payload) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (id === undefined) return;
    if (!res.ok) throw new Error(`MCP ${this.name}: HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      for await (const ev of parseSSE(res.body!)) {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          if (msg.error) throw new Error(`MCP ${this.name}: ${msg.error.message}`);
          return msg.result;
        }
      }
      throw new Error(`MCP ${this.name}: no response`);
    }
    const msg = await res.json();
    if (msg.error) throw new Error(`MCP ${this.name}: ${msg.error.message}`);
    return msg.result;
  }

  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<{ ok: boolean; output: string }> {
    const r = await this.request("tools/call", { name, arguments: args ?? {} });
    const output = (r.content ?? [])
      .map((c: any) =>
        c.type === "text"
          ? c.text
          : c.type === "resource"
            ? (c.resource?.text ?? `[resource ${c.resource?.uri}]`)
            : `[${c.type} content]`,
      )
      .join("\n");
    return { ok: !r.isError, output: output || JSON.stringify(r.structuredContent ?? r) };
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  toTools(defs: McpToolDef[]): Tool[] {
    return defs.map((d) => ({
      name: `mcp__${this.name}__${d.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      description: `[MCP ${this.name}] ${d.description ?? d.name}`,
      parameters: d.inputSchema ?? { type: "object", properties: {} },
      readOnly: d.annotations?.readOnlyHint === true,
      risk: () => (d.annotations?.destructiveHint ? "high" : d.annotations?.readOnlyHint ? "low" : "medium"),
      execute: async (args: unknown) => this.callTool(d.name, args),
    }));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Connect all configured MCP servers; failures are reported, not fatal. */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  onError: (name: string, err: Error) => void,
): Promise<{ clients: McpClient[]; tools: Tool[] }> {
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const c = new McpClient(name, cfg);
      try {
        await c.connect();
        tools.push(...c.toTools(await c.listTools()));
        clients.push(c);
      } catch (e) {
        c.close();
        onError(name, e as Error);
      }
    }),
  );
  return { clients, tools };
}
