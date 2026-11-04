import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { on, pty } from "../ipc";

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** One terminal session bound to a PTY in the Rust backend. */
export function TerminalView({
  root,
  visible,
  command,
  onExit,
  onTitle,
}: {
  root: string;
  visible: boolean;
  command?: string;
  onExit?(code: number | null): void;
  onTitle?(t: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const id = useRef<number | null>(null);
  const cb = useRef({ onExit, onTitle });
  cb.current = { onExit, onTitle };

  useEffect(() => {
    const t = new XTerm({
      fontFamily: cssVar("--mono", "monospace"),
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: {
        background: cssVar("--bg", "#1b1c1b"),
        foreground: cssVar("--text", "#f4f2eb"),
        cursor: cssVar("--accent", "#efae8c"),
        selectionBackground: cssVar("--st-selection", "#3a4a66"),
      },
    });
    // Follow theme switches (the theme is a data attribute on <html>).
    const applyTheme = () => {
      t.options.theme = {
        background: cssVar("--bg", "#1b1c1b"),
        foreground: cssVar("--text", "#f4f2eb"),
        cursor: cssVar("--accent", "#efae8c"),
        selectionBackground: cssVar("--st-selection", "#3a4a66"),
      };
    };
    const themeObserver = new MutationObserver(() => requestAnimationFrame(applyTheme));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    try {
      f.fit();
    } catch {
      /* hidden */
    }
    let disposed = false;
    const unOut = on<{ id: number; data: string }>("pty://output", (e) => {
      if (e.id === id.current) t.write(decode(e.data));
    });
    const unExit = on<{ id: number; code: number | null }>("pty://exit", (e) => {
      if (e.id !== id.current) return;
      t.write(`\r\n\x1b[2m[process exited${e.code != null ? ` with code ${e.code}` : ""}]\x1b[0m\r\n`);
      cb.current.onExit?.(e.code);
    });
    t.onTitleChange((title) => cb.current.onTitle?.(title));
    void pty
      .spawn(root, t.cols, t.rows, command)
      .then((pid) => {
        if (disposed) return void pty.kill(pid);
        id.current = pid;
      })
      .catch((e) => t.write(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`));
    const dataSub = t.onData((d) => id.current != null && void pty.write(id.current, d));
    const resizeSub = t.onResize(
      ({ cols, rows }) => id.current != null && void pty.resize(id.current, cols, rows),
    );
    const ro = new ResizeObserver(() => {
      try {
        f.fit();
      } catch {
        /* not visible */
      }
    });
    ro.observe(host.current!);
    return () => {
      disposed = true;
      themeObserver.disconnect();
      ro.disconnect();
      unOut();
      unExit();
      dataSub.dispose();
      resizeSub.dispose();
      if (id.current != null) void pty.kill(id.current);
      t.dispose();
    };
  }, [root, command]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {
        /* ignore */
      }
      term.current?.focus();
    });
  }, [visible]);

  return <div ref={host} className="st-term" style={{ display: visible ? undefined : "none" }} />;
}
