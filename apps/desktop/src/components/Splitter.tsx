import { useRef, useState } from "react";

/** Persisted panel size with a drag handle. `side` says which edge of the panel the handle sits on. */
export function usePanelSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    try {
      const n = Number(localStorage.getItem(key));
      return Number.isFinite(n) && n >= min ? Math.min(n, max) : initial;
    } catch {
      return initial;
    }
  });
  const set = (n: number) => {
    const v = Math.round(Math.max(min, Math.min(max, n)));
    setSize(v);
    try {
      localStorage.setItem(key, String(v));
    } catch {
      /* ignore */
    }
  };
  return { size, set, reset: () => set(initial) };
}

export function Splitter({
  direction,
  size,
  onChange,
  onReset,
  invert = false,
  label,
}: {
  direction: "vertical" | "horizontal";
  size: number;
  onChange(n: number): void;
  onReset?(): void;
  /** Panel grows when dragging towards the start (right/bottom panels). */
  invert?: boolean;
  label: string;
}) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const horizontal = direction === "horizontal";
  return (
    <>
      <div
        className={`st-splitter ${horizontal ? "h" : "v"} ${dragging ? "dragging" : ""}`}
        role="separator"
        aria-label={label}
        aria-orientation={horizontal ? "horizontal" : "vertical"}
        tabIndex={0}
        onDoubleClick={onReset}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16;
          const dec = horizontal ? "ArrowUp" : "ArrowLeft";
          const inc = horizontal ? "ArrowDown" : "ArrowRight";
          if (e.key === dec) onChange(size + (invert ? step : -step));
          if (e.key === inc) onChange(size + (invert ? -step : step));
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { pos: horizontal ? e.clientY : e.clientX, size };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const delta = (horizontal ? e.clientY : e.clientX) - start.current.pos;
          onChange(start.current.size + (invert ? -delta : delta));
        }}
        onPointerUp={() => {
          start.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDragging(false);
        }}
      />
      {dragging && <div className={`st-drag-shield ${horizontal ? "h" : "v"}`} />}
    </>
  );
}
