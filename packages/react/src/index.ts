import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  initialSessionState,
  reduceSession,
  type HarnessClient,
  type HarnessEvent,
  type PermissionDecision,
  type PlanDecision,
  type SessionState,
} from "@harness/client";

export { initialSessionState, reduceSession };
export type { SessionState };

// Cache only in memory and isolate entries by authenticated client instance.
const sessionCache = new WeakMap<HarnessClient, Map<string, SessionState>>();
function cached(client: HarnessClient | null, id: string | null) {
  return client && id ? sessionCache.get(client)?.get(id) : undefined;
}
function remember(client: HarnessClient, id: string, state: SessionState) {
  let cache = sessionCache.get(client);
  if (!cache) sessionCache.set(client, (cache = new Map()));
  cache.delete(id);
  cache.set(id, state);
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
}

export interface UseSessionResult extends SessionState {
  connected: boolean;
  /** True until the first complete history snapshot is ready. */
  loading: boolean;
  send(text: string, mode?: "chat" | "task", workflow?: string): Promise<void>;
  answerPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  answerQuestion(questionId: string, answer: string): Promise<void>;
  decidePlan(
    planId: string,
    decision: PlanDecision,
    opts?: { markdown?: string; feedback?: string },
  ): Promise<void>;
  cancel(): Promise<void>;
  continueJob(): Promise<void>;
  error?: string;
}

/** Headless hook: subscribes to a session's event stream and reduces it to UI state. */
export function useSession(client: HarnessClient | null, sessionId: string | null): UseSessionResult {
  const [view, setView] = useState<{
    client: HarnessClient | null;
    id: string | null;
    state?: SessionState;
    connected: boolean;
    error?: string;
  }>(() => ({ client, id: sessionId, state: cached(client, sessionId), connected: false }));
  const matches = view.client === client && view.id === sessionId;
  const state = (matches ? view.state : undefined) ?? cached(client, sessionId);
  const idRef = useRef(sessionId);
  idRef.current = sessionId;

  useEffect(() => {
    if (!client || !sessionId) return;
    const ctrl = new AbortController();
    let current = cached(client, sessionId) ?? initialSessionState();
    let queue: HarnessEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (render = true) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const event of queue) current = reduceSession(current, event);
      queue = [];
      remember(client, sessionId, current);
      if (render && !ctrl.signal.aborted) setView({ client, id: sessionId, state: current, connected: true });
    };
    (async () => {
      try {
        // Reduce history off-screen in one pass; never replay it as live animation.
        const snapshot = await client.getSession(sessionId, {
          after: current.lastSeq,
          internal: false,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        for (const event of snapshot.events ?? []) current = reduceSession(current, event);
        current = {
          ...current,
          status: snapshot.status,
          externalRun: snapshot.externalRun,
          lastSeq: snapshot.lastSeq,
          projectPath: snapshot.projectPath,
          title: snapshot.title,
          todos: snapshot.todos,
          permissionMode: snapshot.permissionMode,
          reasoningEffort: snapshot.reasoningEffort,
          sandbox: snapshot.sandbox,
        };
        publish();
        // Subscribe after the snapshot watermark; events created during the HTTP request
        // are replayed by the server, without losing or double-counting them.
        for await (const event of client.events(sessionId, { after: current.lastSeq, signal: ctrl.signal })) {
          if (ctrl.signal.aborted) break;
          queue.push(event);
          if (!timer) timer = setTimeout(publish, 32);
        }
        if (!ctrl.signal.aborted) {
          publish();
          setView((v) => ({ ...v, connected: false }));
        }
      } catch (error) {
        if (!ctrl.signal.aborted) {
          if (queue.length) publish();
          setView({
            client,
            id: sessionId,
            state: cached(client, sessionId),
            connected: false,
            error: (error as Error).message,
          });
        }
      }
    })();
    return () => {
      ctrl.abort();
      if (queue.length) publish(false);
      if (timer) clearTimeout(timer);
    };
  }, [client, sessionId]);

  const need = useCallback(() => {
    if (!client || !idRef.current) throw new Error("no session");
    return { client, id: idRef.current };
  }, [client]);

  const actions = useMemo(
    () => ({
      send: async (text: string, mode: "chat" | "task" = "chat", workflow?: string) => {
        const { client: c, id } = need();
        await c.send(id, text, { mode, workflow });
      },
      answerPermission: async (rid: string, d: PermissionDecision) => {
        const { client: c, id } = need();
        await c.answerPermission(id, rid, d);
      },
      answerQuestion: async (qid: string, answer: string) => {
        const { client: c, id } = need();
        await c.answerQuestion(id, qid, answer);
      },
      decidePlan: async (pid: string, d: PlanDecision, o?: { markdown?: string; feedback?: string }) => {
        const { client: c, id } = need();
        await c.decidePlan(id, pid, d, o);
      },
      cancel: async () => {
        const { client: c, id } = need();
        await c.cancel(id);
      },
      continueJob: async () => {
        const { client: c, id } = need();
        await c.continueJob(id);
      },
    }),
    [need],
  );

  return {
    ...(state ?? initialSessionState()),
    ...actions,
    connected: matches && view.connected,
    loading: !!client && !!sessionId && !state && !(matches && view.error),
    error: matches ? view.error : undefined,
  };
}
