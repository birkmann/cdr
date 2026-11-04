// UI zoom like VS Code: Ctrl+mouse wheel, Ctrl+= / Ctrl++ / Ctrl+- and Ctrl+0 to reset.
// Scales the whole webview (text, editor, terminal), persisted per computer.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "./ipc";

const KEY = "morrow.studio.zoom";
const EVENT = "studio:zoom";
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.33, 1.5, 1.7, 2, 2.4, 3];

export function getZoom(): number {
  try {
    const z = Number(localStorage.getItem(KEY));
    return Number.isFinite(z) && z >= ZOOM_LEVELS[0] && z <= ZOOM_LEVELS.at(-1)! ? z : 1;
  } catch {
    return 1;
  }
}

/** Next zoom level up (+1) or down (-1) from the current one. */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((l) => l > current + 0.001) ?? ZOOM_LEVELS.at(-1)!;
  return [...ZOOM_LEVELS].reverse().find((l) => l < current - 0.001) ?? ZOOM_LEVELS[0];
}

export async function setZoom(level: number): Promise<void> {
  const z = Math.min(ZOOM_LEVELS.at(-1)!, Math.max(ZOOM_LEVELS[0], level));
  try {
    localStorage.setItem(KEY, String(z));
  } catch {
    /* not persisted */
  }
  if (isTauri()) await getCurrentWebview().setZoom(z);
  else document.documentElement.style.zoom = String(z);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: z }));
}

export const zoomIn = () => setZoom(stepZoom(getZoom(), 1));
export const zoomOut = () => setZoom(stepZoom(getZoom(), -1));
export const zoomReset = () => setZoom(1);

export function onZoomChange(fn: (z: number) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<number>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** Apply the saved zoom and install the keyboard and wheel shortcuts. Call once at startup. */
export function installZoom(): void {
  void setZoom(getZoom());
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // e.key is the typed character, so this works on any layout (German "+" key, US "=" key) and the numpad.
      const plus = e.key === "+" || e.key === "=" || e.code === "NumpadAdd";
      const minus = e.key === "-" || e.key === "_" || e.code === "NumpadSubtract";
      const zero = (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") && !e.shiftKey;
      if (!plus && !minus && !zero) return;
      e.preventDefault();
      e.stopPropagation();
      void (zero ? zoomReset() : plus ? zoomIn() : zoomOut());
    },
    { capture: true },
  );
  let last = 0;
  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // One step per wheel notch; touchpads send many small events.
      const now = Date.now();
      if (now - last < 60 || Math.abs(e.deltaY) < 1) return;
      last = now;
      void (e.deltaY < 0 ? zoomIn() : zoomOut());
    },
    { passive: false, capture: true },
  );
}
