import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    ref.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - items.length * 30 - 16);
  return (
    <div ref={ref} className="st-menu st-context" style={{ left, top }} role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="st-menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            className={it.danger ? "danger" : ""}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
