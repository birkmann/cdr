import { useEffect, useRef, useState } from "react";
import { useApp } from "@web/app-state";
import type { HarnessEvent, SessionInfo } from "@harness/client";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

export interface Approval {
  session: SessionInfo;
  event: HarnessEvent;
}

async function notify(title: string, body: string) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch {
    /* notifications unavailable */
  }
}

/** Pending permission requests, questions, and plan approvals across all sessions (the approvals inbox). */
export function useApprovals(): Approval[] {
  const { client, sessions } = useApp();
  const [items, setItems] = useState<Approval[]>([]);
  const seen = useRef(new Set<string>());
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
          void notify("CDR Studio", `${a.session.title ?? "An agent"} ${what}`);
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
