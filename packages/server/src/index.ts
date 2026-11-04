import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { bodyLimit } from "hono/body-limit";
import { sessionFileScope } from "./session-files.js";
import { preparePreviewHtml } from "./preview-document.js";
import type {
  BrowseResponse,
  CreateGoalRequest,
  UpdateGoalRequest,
  SessionSettingsRequest,
  CreateSessionRequest,
  HarnessEvent,
  ModelListEntry,
  ModelRole,
  PermissionAnswer,
  PlanAnswer,
  QuestionAnswer,
  SendMessageRequest,
} from "@harness/protocol";
import { HARNESS_VERSION } from "@harness/protocol";
import {
  ATTACHMENT_LIMITS,
  generateCommitMessage,
  GoalError,
  GoalStore,
  Harness,
  deleteGoal,
  discardGoal,
  mergeGoal,
  pauseGoal,
  requestGoalChanges,
  startGoal,
  harnessHome,
  parseModelRef,
  resolveInProject,
  workingTreeDiff,
  WORKFLOW_PRESETS,
  type Session,
} from "@harness/core";

export interface ServerOptions {
  harness?: Harness;
  /** Bearer token. Default: persisted random token in ~/.harness/server-token. */
  token?: string;
  /** Allowed CORS origins (default: localhost dev ports). Use ["*"] to allow any. */
  origins?: string[];
  /** If set, sessions may only be created for projects under these directories. */
  allowedRoots?: string[];
  /** SSE keep-alive interval (ms). */
  keepAliveMs?: number;
  /** Serve a built web UI (e.g. apps/web/dist) at "/". */
  staticDir?: string;
  /** Goal storage (default: per-repo files indexed in ~/.harness/goals-index.json). */
  goals?: GoalStore;
}

const API_PREFIXES = ["/health", "/models", "/sessions", "/browse", "/preview", "/commit-message", "/goals"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".map": "application/json",
};

export const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** Load or create the persistent server token. Returns {token, created}. */
export function loadOrCreateToken(): { token: string; created: boolean; path: string } {
  const path = join(harnessHome(), "server-token");
  if (existsSync(path)) return { token: readFileSync(path, "utf8").trim(), created: false, path };
  mkdirSync(harnessHome(), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return { token, created: true, path };
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(opts: ServerOptions = {}): { app: Hono; harness: Harness; token: string } {
  const harness = opts.harness ?? new Harness();
  const token = opts.token ?? loadOrCreateToken().token;
  const origins = opts.origins ?? DEFAULT_ORIGINS;
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (origins.includes("*") ? origin : origins.includes(origin) ? origin : null),
      allowHeaders: ["authorization", "content-type", "last-event-id"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof GoalError)
      return c.json(
        { error: err.message, ...(err.conflicts ? { conflicts: err.conflicts } : {}) },
        err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400,
      );
    return c.json({ error: err.message }, 500);
  });

  /** Unguessable per-session path segment so preview iframes can load relative assets without the token. */
  const previewKey = (id: string) =>
    `${id}~${createHmac("sha256", token).update(`preview:${id}`).digest("hex").slice(0, 24)}`;

  // Live preview of project files (HTML/JS/CSS/images) – authorised by the signed path, not the bearer token.
  app.get("/preview/:key/*", (c) => {
    const key = c.req.param("key");
    const id = key.split("~")[0];
    if (!safeEqual(key, previewKey(id))) return c.text("not found", 404);
    let s: Session;
    try {
      s = harness.getSession(id);
    } catch {
      return c.text("not found", 404);
    }
    const prefix = `/preview/${key}/`;
    const relPath = decodeURIComponent(c.req.path.slice(prefix.length)) || "index.html";
    let abs: string;
    try {
      const scope = sessionFileScope(s);
      abs = scope.resolve(relPath);
      if (existsSync(abs) && statSync(abs).isDirectory()) abs = scope.resolve(join(abs, "index.html"));
    } catch {
      return c.text("forbidden", 403);
    }
    if (!existsSync(abs) || relPath.split("/").some((p) => p === ".git" || p === ".harness"))
      return c.text("not found", 404);
    const extension = extname(abs).toLowerCase();
    const contents = readFileSync(abs);
    const body =
      extension === ".html" || extension === ".htm"
        ? Buffer.from(preparePreviewHtml(contents.toString("utf8")))
        : contents;
    return c.body(body, 200, {
      "content-type": MIME[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
      // The iframe is sandboxed (opaque origin); module scripts/fetches from it need CORS.
      "access-control-allow-origin": "*",
    });
  });

  app.get("/health", (c) =>
    c.json({ ok: true, version: HARNESS_VERSION, sessions: harness.liveSessions().length }),
  );

  // Static web UI (no auth: it contains no data; the token is entered in / passed to the UI).
  if (opts.staticDir && existsSync(opts.staticDir)) {
    const root = resolve(opts.staticDir);
    app.use("*", async (c, next) => {
      if (
        c.req.method !== "GET" ||
        API_PREFIXES.some((p) => c.req.path === p || c.req.path.startsWith(p + "/"))
      )
        return next();
      let file = resolve(root, "." + decodeURIComponent(c.req.path));
      if (!file.startsWith(root)) return c.text("not found", 404);
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA fallback
      if (!existsSync(file)) return next();
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      return c.body(readFileSync(file), 200, {
        "content-type": type,
        "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      });
    });
  }

  // auth for everything else
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/health" || c.req.path.startsWith("/preview/"))
      return next();
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("token") ?? "");
    if (!provided || !safeEqual(provided, token)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  const session = (c: Context): Session => {
    const id = c.req.param("id")!;
    try {
      return harness.getSession(id);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  };

  const body = async <T>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
  };

  app.use(
    "*",
    bodyLimit({ maxSize: 80 * 1024 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }),
  );

  /** One-shot commit message for a repository's staged (or all) changes. */
  app.post("/commit-message", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string; model?: string };
    if (!body.projectPath || typeof body.projectPath !== "string")
      return c.json({ error: "projectPath is required" }, 400);
    const root = resolve(body.projectPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) return c.json({ error: "Folder not found" }, 404);
    if (
      opts.allowedRoots?.length &&
      !opts.allowedRoots.some((r) => root === resolve(r) || root.startsWith(resolve(r) + sep))
    )
      return c.json({ error: "Folder is outside the allowed roots" }, 403);
    try {
      const { config, registry } = harness.providerRegistry(root);
      const ref = body.model || config.models.executor;
      if (!ref) return c.json({ error: "No model is configured" }, 400);
      const { provider, model } = registry.resolve(ref);
      const result = await generateCommitMessage({
        root,
        provider,
        model,
        signal: AbortSignal.timeout(90_000),
      });
      return c.json({ ...result, model: ref });
    } catch (e) {
      const message = (e as Error).message;
      return c.json({ error: message }, /no changes/i.test(message) ? 400 : 500);
    }
  });

  app.get("/models", async (c) => {
    const projectPath = c.req.query("projectPath") || process.cwd();
    const { config, registry } = harness.providerRegistry(projectPath);
    if (c.req.query("remote") === "true") {
      const available: Record<string, { models: string[]; error?: string }> = {};
      await Promise.all(
        Object.keys(config.providers).map(async (id) => {
          if (!registry.isConfigured(id)) return;
          try {
            const p = registry.get(id);
            if (!p.listModels) return;
            available[id] = { models: await p.listModels(AbortSignal.timeout(6000)) };
          } catch (e) {
            available[id] = { models: [], error: (e as Error).message.slice(0, 200) };
          }
        }),
      );
      return c.json({ available });
    }
    const out: ModelListEntry[] = [];
    for (const [role, ref] of Object.entries(config.models)) {
      if (!ref) continue;
      const { provider } = parseModelRef(ref);
      out.push({ role: role as ModelRole, id: ref, provider, configured: registry.isConfigured(provider) });
    }
    const selectedRef = c.req.query("model") || config.models.executor;
    let reasoningEfforts: import("@harness/protocol").ReasoningEffort[] = [];
    if (selectedRef) {
      const { provider, model } = parseModelRef(selectedRef);
      if (registry.isConfigured(provider))
        reasoningEfforts = registry.get(provider).capabilities(model).reasoningEfforts ?? [];
    }
    return c.json({
      reasoningEfforts,
      models: out,
      providers: Object.keys(config.providers).map((p) => ({ id: p, configured: registry.isConfigured(p) })),
      workflows: Object.keys({ ...WORKFLOW_PRESETS, ...(config.workflows ?? {}) }),
    });
  });

  app.post("/sessions", async (c) => {
    const req = await body<CreateSessionRequest>(c);
    if (
      req.reasoningEffort !== undefined &&
      !["auto", "none", "low", "medium", "high", "max"].includes(req.reasoningEffort)
    )
      throw new HttpError(400, "invalid thinking effort");
    if (req.permissionMode && !["ask", "auto", "yolo"].includes(req.permissionMode))
      throw new HttpError(400, "invalid permissionMode");
    if (!req.projectPath || req.sandbox) {
      // New sandbox workspace under ~/.harness/sandboxes
      try {
        const s = harness.createSession({
          sandbox: typeof req.sandbox === "object" ? req.sandbox : true,
          workflow: req.workflow,
          models: req.models,
          reasoningEffort: req.reasoningEffort,
          permissionMode: req.permissionMode,
          title: req.title,
        });
        return c.json(s.info(), 201);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    const projectPath = resolve(req.projectPath);
    if (
      opts.allowedRoots?.length &&
      !opts.allowedRoots.some((r) => projectPath === resolve(r) || projectPath.startsWith(resolve(r) + sep))
    ) {
      throw new HttpError(403, "projectPath is not under an allowed root");
    }
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory())
      throw new HttpError(400, `projectPath does not exist: ${projectPath}`);
    if (req.permissionMode && !["ask", "auto", "yolo"].includes(req.permissionMode))
      throw new HttpError(400, "invalid permissionMode");
    let s: Session;
    try {
      s = harness.createSession({
        projectPath,
        workflow: req.workflow,
        models: req.models,
        reasoningEffort: req.reasoningEffort,
        permissionMode: req.permissionMode,
        title: req.title,
      });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return c.json(s.info(), 201);
  });

  app.get("/sessions", (c) => {
    const parent = c.req.query("parent");
    return c.json({ sessions: harness.listSessions(parent ? { parent } : {}) });
  });

  app.get("/sessions/:id/tree", (c) => {
    const id = c.req.param("id");
    try {
      return c.json(harness.sessionTree(id));
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });

  app.get("/sessions/:id", (c) => {
    const s = session(c);
    const includeEvents = c.req.query("events") !== "false";
    const after = Number(c.req.query("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "invalid event cursor");
    const includeInternal = c.req.query("internal") !== "false";
    return c.json({
      ...s.info(),
      previewBase: `/preview/${previewKey(s.id)}/`,
      pending: s.pendingRequests(),
      todos: s.todos,
      ...(includeEvents
        ? {
            events: s.events.filter(
              (e) =>
                e.seq > after &&
                (includeInternal || (e.type !== "context.append" && e.type !== "context.replace")),
            ),
          }
        : {}),
    });
  });

  app.post("/sessions/:id/messages", async (c) => {
    const s = session(c);
    const req = await body<SendMessageRequest>(c);
    if (!req.text?.trim()) throw new HttpError(400, "text is required");
    if (s.isRunning) throw new HttpError(409, "session is already running");
    const attachments = req.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > ATTACHMENT_LIMITS.maxFiles)
      throw new HttpError(400, `at most ${ATTACHMENT_LIMITS.maxFiles} attachments`);
    for (const a of attachments) {
      if (typeof a?.name !== "string" || typeof a?.data !== "string")
        throw new HttpError(400, "invalid attachment");
      if ((a.data.length * 3) / 4 > ATTACHMENT_LIMITS.maxBytes)
        throw new HttpError(400, `${a.name} is larger than 10 MB`);
    }
    const p =
      req.mode === "task"
        ? s.run(req.text, { workflow: req.workflow, attachments })
        : s.chat(req.text, attachments);
    p.catch((e) => s.emit({ type: "error", message: (e as Error).message, recoverable: true }));
    return c.json({ accepted: true, mode: req.mode ?? "chat" }, 202);
  });

  app.post("/sessions/:id/continue", (c) => {
    const s = session(c);
    if (s.isRunning || !["failed", "cancelled"].includes(s.status))
      throw new HttpError(409, "Only a failed or stopped job can be continued");
    const p = s.continueJob();
    p.catch((e) => s.emit({ type: "error", message: (e as Error).message, recoverable: true }));
    return c.json({ accepted: true }, 202);
  });

  app.get("/sessions/:id/events", (c) => {
    const s = session(c);
    const lastId = c.req.header("last-event-id") ?? c.req.query("after");
    const after = lastId !== undefined && lastId !== "" ? Number(lastId) : 0;
    const includeInternal = c.req.query("internal") === "true";
    return streamSSE(c, async (stream) => {
      const queue: HarnessEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = s.subscribe(
        (e) => {
          queue.push(e);
          wake?.();
        },
        Number.isFinite(after) ? after : 0,
      );
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      const ping = setInterval(() => {
        queue.push({ type: "__ping" } as unknown as HarnessEvent);
        wake?.();
      }, opts.keepAliveMs ?? 15_000);
      try {
        while (!closed) {
          while (queue.length) {
            const e = queue.shift()!;
            if ((e as { type: string }).type === "__ping") {
              await stream.write(": ping\n\n");
              continue;
            }
            if (!includeInternal && (e.type === "context.append" || e.type === "context.replace")) continue;
            await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
          }
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      } finally {
        clearInterval(ping);
        unsubscribe();
      }
    });
  });

  app.post("/sessions/:id/permissions/:reqId", async (c) => {
    const s = session(c);
    if (s.isExternalRun)
      throw new HttpError(409, "This run is controlled in its terminal; output is mirrored here.");
    const { decision } = await body<PermissionAnswer>(c);
    if (!["allow", "deny", "always"].includes(decision))
      throw new HttpError(400, "decision must be allow|deny|always");
    if (!s.resolvePermission(c.req.param("reqId"), decision))
      throw new HttpError(404, "no such pending permission request");
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/answers/:qId", async (c) => {
    const s = session(c);
    if (s.isExternalRun)
      throw new HttpError(409, "This run is controlled in its terminal; output is mirrored here.");
    const { answer } = await body<QuestionAnswer>(c);
    if (typeof answer !== "string") throw new HttpError(400, "answer must be a string");
    if (!s.answerQuestion(c.req.param("qId"), answer)) throw new HttpError(404, "no such pending question");
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/plans/:planId", async (c) => {
    const s = session(c);
    if (s.isExternalRun)
      throw new HttpError(409, "This run is controlled in its terminal; output is mirrored here.");
    const a = await body<PlanAnswer>(c);
    if (!["approve", "reject", "edit"].includes(a.decision))
      throw new HttpError(400, "decision must be approve|reject|edit");
    if (!s.decidePlan(c.req.param("planId"), a.decision, a.markdown, a.feedback))
      throw new HttpError(404, "no such pending plan");
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/cancel", (c) => {
    const s = session(c);
    if (s.isExternalRun)
      throw new HttpError(409, "This run is controlled in its terminal; output is mirrored here.");
    s.cancel();
    return c.json({ ok: true, wasRunning: s.isRunning });
  });

  // read-only helpers for UIs (scoped to the session's project)
  app.get("/sessions/:id/files", (c) => {
    const s = session(c);
    const path = c.req.query("path");
    try {
      const scope = sessionFileScope(s);
      if (!path || path === ".") return c.json({ files: scope.list() });
      const abs = scope.resolve(path);
      if (!existsSync(abs)) throw new HttpError(404, "not found");
      if (statSync(abs).isDirectory()) return c.json({ files: scope.list(path) });
      if (statSync(abs).size > 2_000_000) throw new HttpError(400, "file too large");
      return c.json({ path, content: readFileSync(abs, "utf8") });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(403, (e as Error).message);
    }
  });

  app.get("/sessions/:id/diff", (c) => {
    const s = session(c);
    return c.json({ diff: workingTreeDiff(s.projectRoot) ?? "" });
  });

  /** Raw file bytes (e.g. image attachments for <img src>), scoped to the session's project. */
  app.get("/sessions/:id/raw", (c) => {
    const s = session(c);
    const path = c.req.query("path");
    if (!path) throw new HttpError(400, "path is required");
    let abs: string;
    try {
      abs = sessionFileScope(s).resolve(path, true);
    } catch (e) {
      throw new HttpError(403, (e as Error).message);
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) throw new HttpError(404, "not found");
    if (statSync(abs).size > 20_000_000) throw new HttpError(400, "file too large");
    return c.body(readFileSync(abs), 200, {
      "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    });
  });

  app.post("/sessions/:id/settings", async (c) => {
    const s = session(c);
    const req = await body<SessionSettingsRequest>(c);
    if (s.isRunning && (req.models || req.reasoningEffort !== undefined))
      throw new HttpError(409, "cannot change models or thinking effort while running");
    try {
      s.updateSettings(req);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return c.json(s.info());
  });

  app.delete("/sessions/:id", (c) => {
    const id = c.req.param("id");
    if (!harness.store.exists(id)) throw new HttpError(404, "no such session");
    try {
      harness.deleteSession(id);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- goals
  const goals = opts.goals ?? new GoalStore();
  const insideAllowedRoots = (path: string) =>
    !opts.allowedRoots?.length ||
    opts.allowedRoots.some((r) => path === resolve(r) || path.startsWith(resolve(r) + sep));
  const goalRun = (started: ReturnType<typeof startGoal>) => {
    started.done.catch(() => undefined);
    return started.goal;
  };

  app.get("/goals", (c) => {
    const repo = c.req.query("repo");
    return c.json({ goals: goals.list(repo || undefined).filter((g) => insideAllowedRoots(g.repo)) });
  });

  app.post("/goals", async (c) => {
    const req = await body<CreateGoalRequest>(c);
    if (typeof req?.repo !== "string" || !req.repo) throw new HttpError(400, "repo is required");
    if (!insideAllowedRoots(resolve(req.repo))) throw new HttpError(403, "repo is not under an allowed root");
    return c.json(goals.create(req), 201);
  });

  app.get("/goals/:id", (c) => c.json(goals.require(c.req.param("id"))));

  app.put("/goals/:id", async (c) => {
    const req = await body<UpdateGoalRequest>(c);
    return c.json(goals.update(c.req.param("id"), req));
  });

  app.post("/goals/:id/run", (c) =>
    c.json(goalRun(startGoal(harness, c.req.param("id"), { store: goals })), 202),
  );

  app.post("/goals/:id/pause", (c) => {
    const r = pauseGoal(c.req.param("id"), goals);
    return c.json({ ok: true, wasRunning: r.wasRunning });
  });

  app.post("/goals/:id/discard", (c) => c.json(discardGoal(c.req.param("id"), goals)));

  app.post("/goals/:id/merge", (c) => c.json(mergeGoal(c.req.param("id"), goals)));

  app.post("/goals/:id/changes", async (c) => {
    const { feedback } = await body<{ feedback?: string }>(c);
    if (typeof feedback !== "string" || !feedback.trim()) throw new HttpError(400, "feedback is required");
    return c.json(goalRun(requestGoalChanges(harness, c.req.param("id"), feedback, { store: goals })), 202);
  });

  app.delete("/goals/:id", (c) => {
    deleteGoal(c.req.param("id"), goals);
    return c.json({ ok: true });
  });

  /** Directory browser for picking a project (directories only; limited to allowedRoots or the home dir). */
  app.get("/browse", (c) => {
    const roots = (opts.allowedRoots?.length ? opts.allowedRoots : [homedir()]).map((r) => resolve(r));
    const requested = resolve(c.req.query("path") || roots[0]);
    const inside = (p: string) => roots.some((r) => p === r || p.startsWith(r + sep));
    if (!inside(requested)) throw new HttpError(403, "outside the allowed roots");
    if (!existsSync(requested) || !statSync(requested).isDirectory())
      throw new HttpError(404, "not a directory");
    const showHidden = c.req.query("hidden") === "true";
    const dirs = readdirSync(requested, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (showHidden || !d.name.startsWith(".")) && d.name !== "node_modules")
      .map((d) => ({
        name: d.name,
        path: join(requested, d.name),
        isGit: existsSync(join(requested, d.name, ".git")),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(requested);
    const res: BrowseResponse = {
      path: requested,
      parent: parent !== requested && inside(parent) ? parent : null,
      home: roots[0],
      dirs,
    };
    return c.json(res);
  });

  return { app, harness, token };
}

export interface StartedServer {
  url: string;
  /** The bound port (useful with port 0). */
  port: number;
  token: string;
  server: ServerType;
  harness: Harness;
  close(): Promise<void>;
}

export function startServer(
  opts: ServerOptions & { port?: number; host?: string } = {},
): Promise<StartedServer> {
  const { app, harness, token } = createApp(opts);
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolvePromise) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 8787, hostname: host }, (info) => {
      resolvePromise({
        url: `http://${host.includes(":") ? `[${host}]` : host}:${info.port}`,
        port: info.port,
        token,
        server,
        harness,
        close: () =>
          new Promise<void>((r) => {
            harness.closeAll();
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}
