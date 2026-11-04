export interface ThreadView {
  top?: number;
  following?: boolean;
  tab?: "preview" | "changes" | "files" | "tasks";
  panel?: boolean;
  activity?: string[];
}

// Only layout preferences are stored across reloads, never conversation content.
export function readThreadView(key: string): ThreadView {
  try {
    const value = JSON.parse(sessionStorage.getItem(`morrow.thread-view:${key}`) ?? "{}");
    if (!value || typeof value !== "object") return {};
    return {
      top: Number.isFinite(value.top) && value.top >= 0 ? value.top : undefined,
      following: typeof value.following === "boolean" ? value.following : undefined,
      panel: typeof value.panel === "boolean" ? value.panel : undefined,
      tab: ["preview", "changes", "files", "tasks"].includes(value.tab) ? value.tab : undefined,
      activity: Array.isArray(value.activity)
        ? value.activity.filter((id: unknown) => typeof id === "string").slice(-100)
        : undefined,
    };
  } catch {
    return {};
  }
}

export function saveThreadView(key: string, patch: ThreadView) {
  try {
    sessionStorage.setItem(`morrow.thread-view:${key}`, JSON.stringify({ ...readThreadView(key), ...patch }));
  } catch {
    /* Storage may be unavailable. */
  }
}
