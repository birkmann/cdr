// `cdr mcp recreate`: the recreate stages as an MCP server over
// stdio, so Claude Code, an IDE agent or a script can capture → build → measure → convert. A minimal, dependency-free
// JSON-RPC 2.0 server (newline-delimited messages, MCP 2025-06-18): initialize, ping, tools/list, tools/call,
// logging/setLevel, notifications/initialized and notifications/cancelled. The tools are the agent tools of
// recreate/tools.ts, run with a ToolContext this server builds; their progress events go out as
// `notifications/message` (and `notifications/progress` when the call carries a progressToken), redacted.
//
// Consent. An MCP client cannot answer CDR's permission prompt: there is no channel back to
// a CDR UI. The choices were (a) auto-consent from the session's permission mode, or (b) an explicit argument. We
// require (b): `recreate_capture` takes `consent: true`, documented as "only after the user agreed to <reason>", and
// records it as `{ by: "user", mode: "ask" }` — the MCP client shows its own approval prompt for the call, with the
// argument visible, so the user's yes is part of the call they approve. A call without `consent: true` captures
// nothing and answers with the text the user must agree to. (a) is kept only for an explicit opt-in: `yes` (the CLI's
// `--yes`) answers the gate automatically and records `{ by: "auto", mode: "yes" }`, exactly like `cdr recreate --yes`.
import { HARNESS_VERSION, type EventBody, type HarnessConfig } from "@harness/protocol";
import { CONSENT_REASON } from "@harness/recreate";
import type { Session } from "../session.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { redactValue } from "../util.js";
import {
  recreateBuildTool,
  recreateCaptureTool,
  recreateComponentsTool,
  recreateConvertTool,
  recreateMeasureTool,
} from "./tools.js";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface RecreateMcpOptions {
  projectRoot: string;
  config: HarnessConfig;
  /** model calls for naming / vision / repair (absent: deterministic stages only) */
  complete?: ToolContext["complete"];
  secretEnv?: string[];
  /** answer the consent gate automatically (`cdr mcp recreate --yes`) */
  yes?: boolean;
  signal?: AbortSignal;
  /** the tools to expose (default: capture, build, measure, components, convert) */
  tools?: Tool[];
  /** session events (the recreate.* progress), e.g. into a session log */
  onEvent?(e: EventBody): void;
}

type Id = string | number;
interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
}
type Reply = Record<string, unknown>;

const err = (id: Id | null, code: number, message: string): Reply => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const ok = (id: Id, result: unknown): Reply => ({ jsonrpc: "2.0", id, result });

/** recreate_capture's schema plus the explicit consent argument. */
function withConsent(t: Tool): Tool {
  const p = t.parameters as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...t,
    description: `${t.description} Over MCP: pass consent: true only after the user agreed to this notice: "${CONSENT_REASON("<url>")}"`,
    parameters: {
      ...p,
      properties: {
        ...p.properties,
        consent: {
          type: "boolean",
          description:
            "true = the user has read the consent notice for this URL and agreed to the recreation. Required.",
        },
      },
      required: [...(p.required ?? []), "consent"],
    },
  };
}

export class RecreateMcpServer {
  readonly tools: Tool[];
  private readonly calls = new Map<Id, AbortController>();
  private send: (m: Reply) => void = () => {};

  constructor(private readonly o: RecreateMcpOptions) {
    const base = o.tools ?? [
      recreateCaptureTool,
      recreateBuildTool,
      recreateMeasureTool,
      recreateComponentsTool,
      recreateConvertTool,
    ];
    this.tools = base.map((t) => (t.name === "recreate_capture" ? withConsent(t) : t));
  }

  /** Where replies and notifications go (set by `serve`; tests may set it directly). */
  output(send: (m: Reply) => void): void {
    this.send = send;
  }

  private notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private context(
    id: Id,
    args: Record<string, unknown>,
    signal: AbortSignal,
    progressToken?: unknown,
  ): ToolContext {
    let progress = 0;
    return {
      projectRoot: this.o.projectRoot,
      config: this.o.config,
      signal,
      todos: [],
      secretEnv: this.o.secretEnv ?? [],
      toolCallId: String(id),
      // nobody to ask over MCP: questions get an empty answer (the recreate tools ask nothing but the consent)
      ask: async () => "",
      emit: (e) => {
        this.o.onEvent?.(e);
        if (!e.type.startsWith("recreate.")) return;
        const data = redactValue(e);
        this.notify("notifications/message", { level: "info", logger: "cdr-recreate", data });
        if (progressToken !== undefined && (e.type === "recreate.stage" || e.type === "recreate.section"))
          this.notify("notifications/progress", {
            progressToken,
            progress: ++progress,
            message:
              e.type === "recreate.stage"
                ? `${e.stage}: ${e.status}`
                : `section ${e.index + 1}/${e.total} ${e.label}: ${e.status}`,
          });
      },
      // see the header: consent = the explicit argument (ask mode), or `yes` (auto)
      permissionMode: () => (this.o.yes ? "yolo" : "ask"),
      requestPermission: async (tool) =>
        tool === "recreate_capture" && args.consent === true ? "allow" : "deny",
      ...(this.o.complete ? { complete: this.o.complete } : {}),
    };
  }

  private async call(id: Id, params: Record<string, unknown>): Promise<Reply> {
    const name = params.name;
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return err(id, -32602, `unknown tool: ${String(name)}`);
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
      string,
      unknown
    >;
    if (tool.name === "recreate_capture" && args.consent !== true && !this.o.yes)
      return ok(id, {
        content: [
          {
            type: "text",
            text: `Consent required: nothing was captured. Show the user this notice and call again with consent: true only if they agree:\n${CONSENT_REASON(String(args.url ?? "the page"))}`,
          },
        ],
        isError: true,
      });
    const ac = new AbortController();
    this.calls.set(id, ac);
    const signal = this.o.signal ? AbortSignal.any([this.o.signal, ac.signal]) : ac.signal;
    const meta = params._meta as { progressToken?: unknown } | undefined;
    try {
      const r: ToolResult = await tool.execute(args, this.context(id, args, signal, meta?.progressToken));
      const content: unknown[] = [{ type: "text", text: redactValue(r.output) }];
      for (const img of r.images ?? [])
        content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      return ok(id, { content, isError: !r.ok });
    } catch (e) {
      return ok(id, {
        content: [{ type: "text", text: redactValue(`${tool.name} failed: ${(e as Error).message}`) }],
        isError: true,
      });
    } finally {
      this.calls.delete(id);
    }
  }

  /** One JSON-RPC message → its reply (null for notifications). */
  async handle(msg: unknown): Promise<Reply | null> {
    if (!msg || typeof msg !== "object" || Array.isArray(msg))
      return err(null, -32600, "invalid request (batches are not supported)");
    const m = msg as Message;
    const isRequest = m.id !== undefined && m.id !== null;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string")
      return isRequest ? err(m.id as Id, -32600, "invalid request") : null;
    const params = m.params && typeof m.params === "object" ? m.params : {};
    if (!isRequest) {
      if (m.method === "notifications/cancelled") this.calls.get(params.requestId as Id)?.abort();
      return null;
    }
    const id = m.id as Id;
    switch (m.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return ok(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: "cdr-recreate", version: HARNESS_VERSION },
          instructions:
            "1:1 recreation of a live web page (CDR). Start with recreate_capture (needs the user's consent: true), then recreate_build, recreate_measure; recreate_components and recreate_convert for projects, design-system packages and the DESIGN.md brand guide. Every tool after capture takes the run id it returned.",
        });
      }
      case "ping":
        return ok(id, {});
      case "logging/setLevel":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
            annotations: {
              readOnlyHint: t.readOnly,
              destructiveHint: false,
              openWorldHint: t.name === "recreate_capture",
            },
          })),
        });
      case "tools/call":
        return this.call(id, params);
      default:
        return err(id, -32601, `method not found: ${m.method}`);
    }
  }

  /**
   * Serve newline-delimited JSON-RPC on `input` → `output` until the input ends. Requests run concurrently (a long
   * tools/call does not block ping or cancellation); in-flight calls finish before this resolves.
   */
  async serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
    this.output((m) => {
      output.write(JSON.stringify(m) + "\n");
    });
    const pending = new Set<Promise<void>>();
    let buf = "";
    const line = (text: string) => {
      if (!text.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        this.send(err(null, -32700, "parse error"));
        return;
      }
      const p = this.handle(msg)
        .then((r) => {
          if (r) this.send(r);
        })
        .catch((e) => this.send(err(null, -32603, (e as Error).message)))
        .finally(() => pending.delete(p));
      pending.add(p);
    };
    input.setEncoding("utf8");
    for await (const chunk of input) {
      buf += chunk as string;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
      }
    }
    line(buf);
    await Promise.all([...pending]);
  }
}

/** `cdr mcp recreate`: a server for a session's project, config and models; serves until stdin ends. */
export async function serveRecreateMcp(
  session: Session,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  o: { yes?: boolean } = {},
): Promise<void> {
  const modelOk = !session.modelProblem(["executor"]);
  const server = new RecreateMcpServer({
    projectRoot: session.projectRoot,
    config: session.config,
    secretEnv: session.secretEnv,
    signal: session.signal,
    yes: o.yes,
    onEvent: (e) => session.emit(e),
    ...(modelOk ? { complete: (role, messages, opts) => session.complete(role, messages, opts) } : {}),
  });
  await server.serve(input, output);
}
