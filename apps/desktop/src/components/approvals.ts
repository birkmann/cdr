import { useEffect, useRef, useState } from "react";
import { useApp } from "@web/app-state";
import type { HarnessEvent, SessionInfo } from "@harness/client";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface Approval {
  session: SessionInfo;
  event: HarnessEvent;
}

async function notify(id: number, title: string, body: string) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ id, title, body });
  } catch {
    /* notifications unavailable */
  }
}

/**
 * Pending permission requests, questions, and plan approvals across all sessions (the approvals inbox).
 * `onOpen` receives the conversation whose system notification the user clicked.
 */
export function useApprovals(onOpen: (sessionId: string) => void): Approval[] {
  const { client, sessions } = useApp();
  const [items, setItems] = useState<Approval[]>([]);
  const seen = useRef(new Set<string>());
  const notified = useRef(new Map<number, string>());
  const nextId = useRef(1);
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void onAction((e) => {
      const id = e.notification?.id;
      const sessionId = id === undefined ? undefined : notified.current.get(id);
      if (e.actionId === "tap" && sessionId) open.current(sessionId);
    })
      .then((listener) => {
        stop = () => void listener.unregister();
        if (!live) stop();
      })
      .catch(() => {
        /* notifications unavailable */
      });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  const waiting = sessions.filter((s) => s.status === "waiting" && !s.externalRun);
  const key = waiting.map((s) => `${s.id}:${s.lastSeq}`).join(",");
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      const out: Approval[] = [];
      for (const s of waiting) {
        try {
          const d = await client.getSession(s.id, { events: false });
          for (const e of d.pending) out.push({ session: s, event: e });
        } catch {
          /* session vanished */
        }
      }
      if (cancelled) return;
      setItems(out);
      for (const a of out) {
        const k = `${a.session.id}:${(a.event as { id?: string }).id}`;
        if (seen.current.has(k)) continue;
        seen.current.add(k);
        if (!document.hasFocus()) {
          const what =
            a.event.type === "permission.request"
              ? `wants to run ${a.event.tool}`
              : a.event.type === "plan.proposed"
                ? "proposed a plan"
                : "has a question";
          const id = nextId.current++;
          notified.current.set(id, a.session.id);
          void notify(id, "CDR Studio", `${a.session.title ?? "An agent"} ${what}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return items;
}
