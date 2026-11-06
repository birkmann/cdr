import { useEffect, useState } from "react";
import { PANEL_MIME, TAB_MIME, type TabInput } from "../store";

export type DragKind = "tab" | "panel";

/** What an editor-tab drag carries: an open tab to move, or a tab to open. */
export type TabDrag = { key: string } | { open: TabInput };

export function startTabDrag(e: React.DragEvent, payload: TabDrag) {
  e.dataTransfer.setData(TAB_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copyMove";
}

export function readTabDrag(e: React.DragEvent): TabDrag | null {
  try {
    const v = JSON.parse(e.dataTransfer.getData(TAB_MIME)) as TabDrag;
    return v && ("key" in v || "open" in v) ? v : null;
  } catch {
    return null;
  }
}

export function dragKind(e: { dataTransfer: DataTransfer | null }): DragKind | null {
  const types = e.dataTransfer?.types ?? [];
  if (types.includes(TAB_MIME)) return "tab";
  if (types.includes(PANEL_MIME)) return "panel";
  return null;
}

/**
 * The studio drag in progress, if any. While one runs, iframes and editors stop taking pointer
 * events (`st-dragging`) so drop zones over them receive the drag.
 */
export function useActiveDrag(): DragKind | null {
  const [kind, setKind] = useState<DragKind | null>(null);
  useEffect(() => {
    let active = false;
    const start = (e: DragEvent) => {
      const k = dragKind(e);
      if (!k) return;
      active = true;
      // Changing the DOM inside dragstart can cancel the drag in Chromium/WebKit; defer it.
      requestAnimationFrame(() => {
        if (!active) return;
        setKind(k);
        document.body.classList.add("st-dragging");
      });
    };
    const end = () => {
      active = false;
      setKind(null);
      document.body.classList.remove("st-dragging");
    };
    // Capture phase: drop targets stop propagation, and a dragged tab that moved has left the DOM.
    const opts = { capture: true };
    window.addEventListener("dragstart", start, opts);
    window.addEventListener("dragend", end, opts);
    window.addEventListener("drop", end, opts);
    return () => {
      window.removeEventListener("dragstart", start, opts);
      window.removeEventListener("dragend", end, opts);
      window.removeEventListener("drop", end, opts);
      document.body.classList.remove("st-dragging");
    };
  }, []);
  return kind;
}
