import { alertDialog } from "./Dialogs";
import { useEffect, useRef, useState } from "react";
import { basename, useApp } from "../app-state";
import { findUrl, useStartRecreate } from "../recreate";
import { IconSearch, IconPlus, IconFolder, IconCode, IconSettings, IconFile, IconX, IconCopy } from "./icons";

/** Trap keyboard focus and restore it when a modal closes. */
export function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
      if (e.key !== "Tab" || !el) return;
      const nodes = [
        ...el.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, textarea, a[href], [tabindex="0"]',
        ),
      ].filter((n) => n.offsetParent !== null);
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return ref;
}

export function CommandPalette({ onClose, onSettings }: { onClose(): void; onSettings(): void }) {
  const { sessions, navigate, route } = useApp();
  const ref = useDialog(onClose);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const startRecreate = useStartRecreate();
  const url = findUrl(query);
  const current = route.name === "chat" ? sessions.find((s) => s.id === route.id) : undefined;
  const recreate = {
    id: "recreate",
    label: url ? `Recreate ${url} 1:1` : "Recreate a web page 1:1",
    detail: url
      ? current
        ? "In this conversation · asks for your consent first"
        : "In a new sandbox · asks for your consent first"
      : "Paste a URL to rebuild the page from its live DOM",
    icon: IconCopy,
    keepOpen: !url,
    always: true,
    run: () => {
      if (!url) {
        setQuery("https://");
        return;
      }
      void startRecreate(url, current ? { sessionId: current.id } : {}).catch(
        (e: Error) =>
          // the palette is closed by now; surface the error where the user looks next
          void alertDialog(e.message, { title: "Could not start the recreation" }),
      );
    },
  };
  const actions = [
    {
      id: "new",
      label: "New conversation",
      detail: "Start with an idea",
      icon: IconPlus,
      run: () => navigate({ name: "home" }),
    },
    {
      id: "projects",
      label: "Projects",
      detail: "Work with your files",
      icon: IconFolder,
      run: () => navigate({ name: "projects" }),
    },
    {
      id: "creations",
      label: "Creations",
      detail: "Open saved previews",
      icon: IconCode,
      run: () => navigate({ name: "artifacts" }),
    },
    {
      id: "settings",
      label: "Settings",
      detail: "Appearance and connection",
      icon: IconSettings,
      run: onSettings,
    },
    recreate,
    ...[...sessions]
      .filter((s) => !s.projectMissing)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
      .map((s) => ({
        id: s.id,
        label: s.title || "Untitled conversation",
        detail: basename(s.projectPath),
        icon: IconFile,
        run: () => navigate({ name: "chat", id: s.id }),
      })),
  ]
    .filter(
      (a: { label: string; detail: string; always?: boolean }) =>
        (a.always && url) || `${a.label} ${a.detail}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 30);
  const choose = (index: number) => {
    const item: { run(): void; keepOpen?: boolean } | undefined = actions[index];
    if (!item) return;
    if (!item.keepOpen) onClose();
    item.run();
  };
  return (
    <div
      className="modal-backdrop palette-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        ref={ref}
      >
        <div className="palette-search">
          <IconSearch size={20} />
          <input
            role="combobox"
            aria-label="Search conversations and commands"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={actions[active] ? `cmd-${active}` : undefined}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search conversations, projects, commands…"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next =
                  (active + (e.key === "ArrowDown" ? 1 : -1) + actions.length) % (actions.length || 1);
                setActive(next);
                document.getElementById(`cmd-${next}`)?.scrollIntoView({ block: "nearest" });
              }
              if (e.key === "Enter") {
                e.preventDefault();
                choose(active);
              }
            }}
          />
          <button className="ghost icon" aria-label="Close search" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <div className="palette-results" id="command-results" role="listbox" aria-label="Results">
          {actions.map((a, index) => (
            <div
              id={`cmd-${index}`}
              key={a.id}
              role="option"
              aria-selected={index === active}
              className={`palette-item ${index === active ? "active" : ""}`}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <a.icon size={18} />
              <div>
                <strong>{a.label}</strong>
                <small>{a.detail}</small>
              </div>
              <span>↵</span>
            </div>
          ))}
          {!actions.length && <p className="muted pad">No conversations or commands match “{query}”.</p>}
        </div>
        <div className="palette-foot">
          <span>↑ ↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="spacer" />
          CDR
        </div>
      </div>
    </div>
  );
}
