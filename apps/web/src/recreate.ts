// 1:1 recreation entry points: URL detection, `/recreate <url>`, and the HTTP call that
// starts a run. Progress comes back as recreate.* events in the session state, like every other step.
import { useCallback, useEffect, useState } from "react";
import type { RecreateRequest } from "@harness/client";
import { useApp } from "./app-state";

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i;

/** First http(s) URL in a text (trailing punctuation trimmed), if any. */
export function findUrl(text: string): string | undefined {
  const m = URL_RE.exec(text);
  if (!m) return;
  const raw = m[0].replace(/[),.;:!?\]}]+$/, "");
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : undefined;
  } catch {
    return;
  }
}

/** A message that is nothing but a web address (`ibm.com`, `www.ibm.com/us-en`, a full URL) → the URL. */
export function bareAddress(text: string): string | undefined {
  const t = text.trim();
  if (!t || /\s/.test(t)) return;
  if (/^https?:\/\//i.test(t)) return findUrl(t);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(t) ? `https://${t}` : undefined;
}

/** The run of a mirror run's static snapshot. The snapshot cannot run what the page loads at runtime; the run's app can. */
export function mirrorSnapshotRun(path: string): string | undefined {
  return /^\.harness\/recreate\/([^/]+)\/out\/preview\/index\.html$/.exec(path)?.[1];
}

/** The real app behind a mirror snapshot. No URL (and not starting) means: show the snapshot. */
export function useMirrorApp(sessionId: string, runId: string | undefined, nonce = 0) {
  const { client } = useApp();
  const [app, setApp] = useState<{ runId: string; url?: string }>();
  useEffect(() => {
    if (!client || !runId) return;
    let cancelled = false;
    client
      .recreateApp(sessionId, runId)
      .then((r) => !cancelled && setApp({ runId, url: r.url }))
      .catch(() => !cancelled && setApp({ runId }));
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, runId, nonce]);
  const current = app?.runId === runId ? app : undefined;
  return { url: current?.url, starting: !!runId && !!client && !current };
}

/** `/recreate <url>` → the URL; undefined when the text is not the command; "" when the URL is missing. */
export function parseRecreateCommand(text: string): string | undefined {
  const m = /^\/recreate(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return;
  return findUrl(m[1] ?? "") ?? "";
}

/** Start a run in a session (POST /sessions/:id/recreate). Throws with the server's message on failure. */
export async function postRecreate(
  server: string,
  token: string,
  sessionId: string,
  req: RecreateRequest,
): Promise<void> {
  const res = await fetch(`${server.replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}/recreate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Could not start the recreation (${res.status})`);
  }
}

/** Start a recreation in an existing session, or in a new one (a project or a sandbox) when none is given. */
export function useStartRecreate() {
  const { client, settings, navigate, refreshSessions, rememberProject } = useApp();
  return useCallback(
    async (
      url: string,
      target: { sessionId?: string; projectPath?: string } = {},
      mode: "mirror" | "rebuild" = "mirror",
    ) => {
      if (!client) throw new Error("Not connected");
      let id = target.sessionId;
      if (!id) {
        const ref = settings.model;
        let host = "page";
        try {
          host = new URL(url).hostname;
        } catch {
          /* validated by the server */
        }
        const info = await client.createSession({
          ...(target.projectPath
            ? { projectPath: target.projectPath }
            : { sandbox: { name: `recreate ${host}`.slice(0, 40) } }),
          permissionMode: settings.permissionMode,
          reasoningEffort: settings.reasoningEffort,
          models: ref ? { executor: ref, planner: ref, reviewer: ref, summarizer: ref } : undefined,
          title: `Recreate ${host}`,
        });
        if (target.projectPath) rememberProject(info.projectPath);
        id = info.id;
      }
      await postRecreate(settings.server, settings.token, id, { url, mode });
      if (!target.sessionId) navigate({ name: "chat", id, preview: true });
      void refreshSessions();
    },
    [client, settings, navigate, refreshSessions, rememberProject],
  );
}

export interface SessionLinks {
  previewBase?: string;
  /** false when the project's config turns recreation off (hides the entry points) */
  recreateEnabled: boolean;
}

/** previewBase (signed iframe path) and whether recreation is enabled, from GET /sessions/:id. */
export function useSessionLinks(sessionId: string): SessionLinks {
  const { client } = useApp();
  const [links, setLinks] = useState<SessionLinks>({ recreateEnabled: true });
  useEffect(() => {
    let cancelled = false;
    client
      ?.getSession(sessionId, { events: false })
      .then((d) => {
        if (cancelled) return;
        const extra = d as typeof d & { recreateEnabled?: boolean };
        setLinks({ previewBase: d.previewBase, recreateEnabled: extra.recreateEnabled !== false });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, sessionId]);
  return links;
}
