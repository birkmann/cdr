import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/** Layout preferences belong to the browser, independently of conversation events. */
export function useColumnWidth(
  key: string,
  options: {
    initial: (available: number) => number;
    min: number;
    max: (available: number) => number;
    /** Measure the container's height instead of its width (for stacked layouts). */
    axis?: "x" | "y";
  },
) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem(key);
      const n = saved === null ? NaN : Number(saved);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setAvailable(options.axis === "y" ? rect.height : rect.width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, options.axis]);
  const max = Math.max(options.min, options.max(available));
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(options.min, value)));
  const width = clamp(preferred ?? options.initial(available));
  const change = (value: number | null) => {
    const next = value === null ? null : clamp(value);
    setPreferred(next);
    try {
      if (next === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(next));
    } catch {
      // Resizing still works when storage is unavailable.
    }
  };
  return { ref: setNode, width, min: options.min, max, change, axis: options.axis ?? "x" };
}

export function ColumnResize({
  label,
  className,
  size,
}: {
  label: string;
  className: string;
  size: ReturnType<typeof useColumnWidth>;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const vertical = size.axis === "y";
  const pos = (e: PointerEvent<HTMLDivElement>) => (vertical ? e.clientY : e.clientX);
  const [active, setActive] = useState(false);
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setActive(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const keydown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const next = {
      [vertical ? "ArrowUp" : "ArrowLeft"]: size.width - step,
      [vertical ? "ArrowDown" : "ArrowRight"]: size.width + step,
      Home: size.min,
      End: size.max,
      Enter: null,
    }[e.key] as number | null | undefined;
    if (next === undefined) return;
    e.preventDefault();
    size.change(next);
  };
  return (
    <>
      <div
        className={`column-resize ${vertical ? "row " : ""}${className}${active ? " dragging" : ""}`}
        style={vertical ? { top: size.width } : { left: size.width }}
        role="separator"
        aria-label={label}
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuemin={size.min}
        aria-valuemax={size.max}
        aria-valuenow={size.width}
        aria-valuetext={`${size.width} pixels`}
        tabIndex={0}
        title={`${label} · Drag or use arrow keys · Double-click or Enter to reset`}
        onKeyDown={keydown}
        onDoubleClick={() => size.change(null)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: pos(e), width: size.width };
          setActive(true);
        }}
        onPointerMove={(e) => {
          if (drag.current?.id !== e.pointerId) return;
          size.change(drag.current.width + pos(e) - drag.current.x);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={() => {
          drag.current = null;
          setActive(false);
        }}
      />
      {active && <div className={`column-resize-shield${vertical ? " row" : ""}`} />}
    </>
  );
}
