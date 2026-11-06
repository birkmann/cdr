import { useApp } from "@web/app-state";
import { Preview, useEditCount } from "@web/components/CodePanel";
import { useSession } from "@harness/react";

/** A conversation's live preview, full-size in an editor tab. */
export function SessionPreview({ sessionId }: { sessionId: string }) {
  const { client, sessions } = useApp();
  const state = useSession(client, sessionId);
  const info = sessions.find((x) => x.id === sessionId);
  const s = { ...state, externalRun: info?.externalRun ?? state.externalRun };
  const editCount = useEditCount(s);
  if (!client) return <div className="st-empty">Connecting…</div>;
  return (
    <div className="st-preview-tab">
      <Preview s={s} sessionId={sessionId} refreshKey={editCount} />
    </div>
  );
}
