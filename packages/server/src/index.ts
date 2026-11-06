import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { bodyLimit } from "hono/body-limit";
import { sessionFileScope, sessionReferencedFiles } from "./session-files.js";
import { preparePreviewHtml } from "./preview-document.js";
import type {
  BrowseResponse,
  CreateGoalRequest,
  UpdateGoalRequest,
  SessionSettingsRequest,
  CreateSessionRequest,
  HarnessEvent,
  AvailableModels,
  ModelListEntry,
  ModelRole,
  PermissionAnswer,
  PlanAnswer,
  QuestionAnswer,
  RecreateRequest,
  SendMessageRequest,
  SessionLogResponse,
  SkillInfo,
  StorageInfo,
} from "@harness/protocol";
import { HARNESS_VERSION } from "@harness/protocol";
import {
  ATTACHMENT_LIMITS,
  generateCommitMessage,
  generateProjectSummary,
  GoalError,
  GoalStore,
  Harness,
  deleteGoal,
  discoverSkills,
  discardGoal,
  mergeGoal,
  pauseGoal,
  requestGoalChanges,
  startGoal,
  harnessHome,
  parseModelRef,
  recreateInSession,
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

const API_PREFIXES = [
  "/health",
  "/models",
  "/skills",
  "/sessions",
  "/browse",
  "/preview",
  "/commit-message",
  "/goals",
  "/storage",
];

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

const RECREATE_TARGETS = ["static", "react-vite", "ds-react", "ds-lit", "ds-angular", "tokens", "design-md"];
const RECREATE_STAGES = [
  "consent",
  "probe",
  "capture",
  "scene",
  "build",
  "measure",
  "components",
  "system",
  "convert",
  "ds-export",
  "repair",
];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validate a POST /sessions/:id/recreate body; returns the request or an error message. */
export function parseRecreateRequest(raw: unknown): RecreateRequest | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || !r.url.trim()) return "url is required";
  let url: URL;
  try {
    url = new URL(r.url.trim());
  } catch {
    return "url is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "url must be http(s)";
  const out: RecreateRequest = { url: url.href };
  if (r.widths !== undefined) {
    if (!Array.isArray(r.widths) || r.widths.length === 0 || r.widths.length > 8)
      return "widths must be a list of 1–8 widths";
    for (const w of r.widths)
      if (typeof w !== "number" || !Number.isInteger(w) || w < 320 || w > 2560)
        return "widths must be integers between 320 and 2560";
    out.widths = [...new Set(r.widths as number[])];
  }
  if (r.to !== undefined) {
    if (!Array.isArray(r.to) || r.to.length === 0 || r.to.some((t) => typeof t !== "string" || !t.trim()))
      return "to must be a list of target names";
    const to = (r.to as string[]).map((t) => (t.trim() === "react" ? "react-vite" : t.trim()));
    const unknown = to.find((t) => !RECREATE_TARGETS.includes(t));
    if (unknown) return `unknown target: ${unknown}`;
    out.to = [...new Set(to)];
  }
  if (r.style !== undefined) {
    if (!["tailwind", "css-modules", "vanilla"].includes(r.style as string))
      return "style must be tailwind, css-modules or vanilla";
    out.style = r.style as RecreateRequest["style"];
  }
  if (r.repair !== undefined) {
    if (typeof r.repair !== "boolean") return "repair must be a boolean";
    out.repair = r.repair;
  }
  if (r.run !== undefined) {
    if (typeof r.run !== "string" || !RUN_ID.test(r.run)) return "run must be a run id";
    out.run = r.run;
  }
  if (r.from !== undefined) {
    if (typeof r.from !== "string" || !RECREATE_STAGES.includes(r.from)) return "from must be a stage name";
    if (!out.run) return "from needs run";
    out.from = r.from as RecreateRequest["from"];
  }
  if (r.out !== undefined) {
    if (typeof r.out !== "string" || !r.out.trim()) return "out must be a folder path";
    // a folder inside the project: relative, no `..`, not .git (the pipeline checks symlinks too)
    const parts = r.out.trim().split(/[\\/]+/);
    if (
      isAbsolute(r.out.trim()) ||
      /^[a-z]:/i.test(r.out.trim()) ||
      parts.includes("..") ||
      parts[0] === ".git"
    )
      return "out must be a relative folder inside the project";
    out.out = r.out.trim();
  }
  return out;
}

/** Run ids this session has started (only those run folders are served through its preview key). */
function sessionRunIds(s: Session): Set<string> {
  const ids = new Set<string>();
  for (const e of s.events) if (e.type === "recreate.started") ids.add(e.runId);
  return ids;
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
    // 1:1 recreation run folders (.harness/recreate/<runId>/…): read-only, only runs of this session, confined to
    // the run folder, so the compare page and the growing output work in the preview iframe.
    const run = /^\.harness\/recreate\/([^/]+)(?:\/(.*))?$/.exec(relPath);
    if (run) return serveRunFile(c, s, run[1], run[2] ?? "");
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

  const serveRunFile = (c: Context, s: Session, runId: string, rest: string) => {
    if (!RUN_ID.test(runId) || !sessionRunIds(s).has(runId)) return c.text("not found", 404);
    const runRoot = join(s.projectRoot, ".harness", "recreate", runId);
    if (!existsSync(runRoot)) return c.text("not found", 404);
    let abs: string;
    try {
      abs = resolveInProject(runRoot, rest || ".");
      if (existsSync(abs) && statSync(abs).isDirectory())
        abs = resolveInProject(runRoot, join(abs, "index.html"));
    } catch {
      return c.text("forbidden", 403);
    }
    if (!existsSync(abs) || statSync(abs).isDirectory()) return c.text("not found", 404);
    const extension = extname(abs).toLowerCase();
    const contents = readFileSync(abs);
    const body =
      extension === ".html" || extension === ".htm"
        ? Buffer.from(preparePreviewHtml(contents.toString("utf8")))
        : contents;
    return c.body(body, 200, {
      "content-type": MIME[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      // recreated pages and the compare page are third-party markup: opened in a tab of their own they still get an
      // opaque origin, so they never reach the app's storage (the bearer token)
      "content-security-policy": "sandbox allow-scripts allow-popups allow-forms",
    });
  };

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

  /** One-shot AI title and summary for a project folder (from its listing, README, manifests and chats). */
  app.post("/project-summary", async (c) => {
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
      const conversationTitles = harness
        .listSessions()
        .filter((s) => resolve(s.projectPath) === root && s.title)
        .map((s) => s.title as string);
      const result = await generateProjectSummary({
        root,
        provider,
        model,
        conversationTitles,
        signal: AbortSignal.timeout(60_000),
      });
      return c.json({ ...result, model: ref });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  /** Skills a user can select for a message in this project (or in a new sandbox when projectPath is omitted). */
  app.get("/skills", (c) => {
    const projectPath = c.req.query("projectPath");
    // Without a project (a new sandbox) only built-in, user and global-config skills apply.
    const root = projectPath ? resolve(projectPath) : join(harnessHome(), "sandboxes", ".none");
    const config = harness.config(projectPath ? root : homedir());
    const skills: SkillInfo[] = discoverSkills(root, config).map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      ...(s.userOnly ? { userOnly: true } : {}),
      ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
    }));
    return c.json({ skills });
  });

  app.get("/models", async (c) => {
    const projectPath = c.req.query("projectPath") || process.cwd();
    const { config, registry } = harness.providerRegistry(projectPath);
    if (c.req.query("remote") === "true") {
      const available: Record<string, AvailableModels> = {};
      await Promise.all(
        Object.keys(config.providers).map(async (id) => {
          if (!registry.isConfigured(id)) return;
          try {
            const p = registry.get(id);
            const signal = AbortSignal.timeout(6000);
            if (p.listModelDetails) {
              const details = await p.listModelDetails(signal);
              available[id] = { models: details.map((d) => d.id), details };
            } else if (p.listModels) {
              available[id] = { models: await p.listModels(signal) };
            }
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
      // Tell the user to connect a model now, instead of creating a chat whose first turn can only fail.
      const modelProblem = harness.modelProblem({ models: req.models });
      if (modelProblem) throw new HttpError(400, modelProblem);
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
    const modelProblem = harness.modelProblem({ projectPath, models: req.models });
    if (modelProblem) throw new HttpError(400, modelProblem);
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

  app.get("/storage", (c) =>
    c.json({ home: harnessHome(), sessionsDir: harness.store.dir } satisfies StorageInfo),
  );

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
      recreateEnabled: s.config.recreate?.enabled !== false,
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
    const modelProblem = s.modelProblem(
      req.mode === "task" ? ["executor", "planner", "reviewer"] : ["executor"],
    );
    if (modelProblem) throw new HttpError(400, modelProblem);
    const attachments = req.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > ATTACHMENT_LIMITS.maxFiles)
      throw new HttpError(400, `at most ${ATTACHMENT_LIMITS.maxFiles} attachments`);
    for (const a of attachments) {
      if (typeof a?.name !== "string" || typeof a?.data !== "string")
        throw new HttpError(400, "invalid attachment");
      if ((a.data.length * 3) / 4 > ATTACHMENT_LIMITS.maxBytes)
        throw new HttpError(400, `${a.name} is larger than 10 MB`);
    }
    const skillNames = req.skills ?? [];
    if (!Array.isArray(skillNames) || skillNames.some((n) => typeof n !== "string") || skillNames.length > 10)
      throw new HttpError(400, "skills must be a list of at most 10 skill names");
    try {
      s.resolveSkills(skillNames);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const p =
      req.mode === "task"
        ? s.run(req.text, { workflow: req.workflow, attachments, skills: skillNames })
        : s.chat(req.text, attachments, { skills: skillNames });
    p.catch((e) => s.emit({ type: "error", message: (e as Error).message, recoverable: true }));
    return c.json({ accepted: true, mode: req.mode ?? "chat" }, 202);
  });

  /** Start a 1:1 recreation run in this session; consent arrives as permission.request. */
  const recreating = new Set<string>();
  app.post("/sessions/:id/recreate", async (c) => {
    const s = session(c);
    if (s.config.recreate?.enabled === false)
      throw new HttpError(403, "recreate is disabled in this project's config");
    const req = parseRecreateRequest(await body<unknown>(c));
    if (typeof req === "string") throw new HttpError(400, req);
    if (s.isRunning || recreating.has(s.id)) throw new HttpError(409, "session is already running");
    recreating.add(s.id);
    recreateInSession(s, req)
      .catch((e) => {
        s.emit({ type: "error", message: (e as Error).message, recoverable: true });
        s.emit({ type: "status", status: "failed" });
      })
      .finally(() => recreating.delete(s.id));
    return c.json({ ok: true }, 202);
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

  app.get("/sessions/:id/checkpoints/:cpId", async (c) => {
    const s = session(c);
    try {
      return c.json({ files: await s.previewCheckpoint(c.req.param("cpId")) });
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });

  app.post("/sessions/:id/checkpoints/:cpId/restore", async (c) => {
    const s = session(c);
    if (s.isRunning) throw new HttpError(409, "Stop the session before restoring a checkpoint");
    try {
      const r = await s.restoreCheckpoint(c.req.param("cpId"));
      return c.json({ ok: true, backupId: r.backupId, changed: r.files.length });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
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

  /** The conversation's stored JSONL event log (already redacted when written) and the files it referenced. */
  app.get("/sessions/:id/log", (c) => {
    const s = session(c);
    const path = harness.store.path(s.id);
    if (!existsSync(path)) throw new HttpError(404, "no stored log for this session");
    const { bytes, mtime, records, content, truncated } = readLogTail(path, LOG_LIMIT);
    return c.json({
      path,
      bytes,
      modifiedAt: mtime.toISOString(),
      records,
      content,
      truncated,
      files: sessionReferencedFiles(s),
    } satisfies SessionLogResponse);
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
    const isPdf = extname(abs).toLowerCase() === ".pdf";
    return c.body(readFileSync(abs), 200, {
      "content-type": MIME[extname(abs).toLowerCase()] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      // A PDF is shown by the browser's built-in viewer inside the UI's side column, which a
      // `default-src 'none'` policy would block. It may be framed by this origin, the Vite dev server
      // and the desktop webview (cross-origin to the API); the unguessable token is still required.
      "content-security-policy": isPdf
        ? "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* tauri://localhost http://tauri.localhost https://tauri.localhost"
        : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      ...(isPdf ? { "content-disposition": "inline" } : {}),
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

const LOG_LIMIT = 4_000_000;

/** The file's size and record count, and its last complete records that fit in `limit` bytes. */
function readLogTail(path: string, limit: number) {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    const buffer = Buffer.alloc(st.size);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (!n) break;
      length += n;
    }
    const data = buffer.subarray(0, length);
    let records = 0;
    for (let i = data.indexOf(10), start = 0; i !== -1; start = i + 1, i = data.indexOf(10, start))
      if (i > start) records++;
    if (data.length && data[data.length - 1] !== 10) records++; // torn last record
    if (data.length <= limit)
      return { bytes: st.size, mtime: st.mtime, records, content: data.toString("utf8"), truncated: false };
    // Start after a newline so the tail holds only whole records (and whole UTF-8 characters).
    const start = data.indexOf(10, data.length - limit) + 1;
    return {
      bytes: st.size,
      mtime: st.mtime,
      records,
      content: start > 0 ? data.subarray(start).toString("utf8") : "",
      truncated: true,
    };
  } finally {
    closeSync(fd);
  }
}
