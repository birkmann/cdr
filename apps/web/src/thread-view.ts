export interface ThreadView {
  top?: number;
  following?: boolean;
  tab?: "preview" | "changes" | "files" | "tasks" | "history" | "compare" | "document";
  panel?: boolean;
  activity?: string[];
  /** turns whose run summary is open */
  reports?: string[];
  /** the uploaded file shown in the document column (a path + name, never its content) */
  doc?: { path: string; name: string; mimeType: string };
}

// Only layout preferences are stored across reloads, never conversation content.
export function readThreadView(key: string): ThreadView {
  try {
    const value = JSON.parse(sessionStorage.getItem(`cdr.thread-view:${key}`) ?? "{}");
    if (!value || typeof value !== "object") return {};
    return {
      top: Number.isFinite(value.top) && value.top >= 0 ? value.top : undefined,
      following: typeof value.following === "boolean" ? value.following : undefined,
      panel: typeof value.panel === "boolean" ? value.panel : undefined,
      tab: ["preview", "changes", "files", "tasks", "history", "compare", "document"].includes(value.tab)
        ? value.tab
        : undefined,
      doc:
        value.doc &&
        typeof value.doc.path === "string" &&
        typeof value.doc.name === "string" &&
        typeof value.doc.mimeType === "string"
          ? { path: value.doc.path, name: value.doc.name, mimeType: value.doc.mimeType }
          : undefined,
      activity: Array.isArray(value.activity)
        ? value.activity.filter((id: unknown) => typeof id === "string").slice(-100)
        : undefined,
      reports: Array.isArray(value.reports)
        ? value.reports.filter((id: unknown) => typeof id === "string").slice(-100)
        : undefined,
    };
  } catch {
    return {};
  }
}

export function saveThreadView(key: string, patch: ThreadView) {
  try {
    sessionStorage.setItem(`cdr.thread-view:${key}`, JSON.stringify({ ...readThreadView(key), ...patch }));
  } catch {
    /* Storage may be unavailable. */
  }
}
