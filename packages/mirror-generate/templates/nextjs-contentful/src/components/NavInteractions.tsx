"use client";
/**
 * Menus, mobile navigation, search and other header layers of a page rendered from the source's browser DOM (react
 * render mode): the source's own scripts do not run here, so what each toggle changed on the original — recorded by the
 * crawl per viewport (source-html interactions.ts) — is replayed. A click on a toggle applies its changes (attributes,
 * inserted panels); a second click, Escape, a click outside or a breakpoint change reverts them. Toggles inside an open
 * panel (sub-menus) work the same way.
 */
import { useEffect } from "react";

export type DomChange = { attr?: { target: string; name: string; value: string | null }; insert?: { parent: string; before: string | null; html: string } };
export type InteractionRecord = { trigger: string; label: string; changes: DomChange[]; children?: InteractionRecord[] };
export type ViewportInteractions = Record<string, { width: number; records: InteractionRecord[] }>;

/** labels of buttons that close the panel they sit in */
export const CLOSE_LABEL = /^(×|✕|x)$|schlie(ß|ss)en|close|zurück|back|fermer|cerrar|chiudi|sluiten|stäng|luk|zamknij|zavřít/i;

type Opened = { rec: InteractionRecord; depth: number; nodes: Element[]; restore: [Element, string, string | null][] };

const query = (sel: string | null): Element | null => {
  if (!sel) return null;
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
};

/** the recorded viewport closest below the window width (smallest one for narrower windows) */
export function pickViewport(sets: ViewportInteractions, width: number): InteractionRecord[] {
  const list = Object.values(sets).sort((a, b) => a.width - b.width);
  let best = list[0];
  for (const s of list) if (s.width <= width) best = s;
  return best?.records ?? [];
}

export function applyChanges(rec: InteractionRecord, depth: number): Opened {
  const opened: Opened = { rec, depth, nodes: [], restore: [] };
  for (const c of rec.changes) {
    if (c.attr) {
      const el = query(c.attr.target);
      if (!el) continue;
      opened.restore.push([el, c.attr.name, el.getAttribute(c.attr.name)]);
      if (c.attr.value === null) el.removeAttribute(c.attr.name);
      else el.setAttribute(c.attr.name, c.attr.value);
    } else if (c.insert) {
      const parent = query(c.insert.parent);
      if (!parent) continue;
      const before = query(c.insert.before);
      const tpl = document.createElement("template");
      tpl.innerHTML = c.insert.html;
      for (const n of Array.from(tpl.content.children)) {
        parent.insertBefore(n, before && before.parentElement === parent ? before : null);
        opened.nodes.push(n);
      }
    }
  }
  return opened;
}

export function revertChanges(o: Opened): void {
  for (const n of o.nodes) n.remove();
  for (const [el, name, value] of [...o.restore].reverse()) {
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }
}

export function NavInteractions({ sets }: { sets?: ViewportInteractions }) {
  useEffect(() => {
    if (!sets || !Object.keys(sets).length) return;
    let records = pickViewport(sets, window.innerWidth);
    const open: Opened[] = [];
    const closeFrom = (depth: number) => {
      while (open.length && open[open.length - 1]!.depth >= depth) revertChanges(open.pop()!);
    };
    /** the record whose trigger was clicked: sub-menu records only while their parent is open */
    const find = (target: Element): { rec: InteractionRecord; depth: number } | undefined => {
      const levels: InteractionRecord[][] = [records, ...open.map((o) => o.rec.children ?? [])];
      for (let d = levels.length - 1; d >= 0; d--)
        for (const rec of levels[d]!) {
          try {
            if (target.closest(rec.trigger)) return { rec, depth: d };
          } catch {
            /* invalid selector */
          }
        }
      return undefined;
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest) return;
      const hit = find(target);
      if (hit) {
        e.preventDefault();
        const already = open.findIndex((o) => o.rec === hit.rec);
        if (already >= 0) closeFrom(hit.depth);
        else {
          closeFrom(hit.depth);
          open.push(applyChanges(hit.rec, hit.depth));
        }
        return;
      }
      // a close button inside an opened panel ("Suche schließen", ×) closes that panel
      const inside = open.findIndex((o) => o.nodes.some((n) => n.contains(target)));
      if (inside >= 0) {
        const btn = target.closest("button, [role=button]");
        const label = btn ? (btn.getAttribute("aria-label") || btn.getAttribute("title") || btn.textContent || "").trim() : "";
        if (btn && CLOSE_LABEL.test(label)) {
          e.preventDefault();
          closeFrom(open[inside]!.depth);
        }
        return;
      }
      // a click outside every opened panel closes them (links inside a panel navigate as usual)
      if (open.length) closeFrom(0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open.length) closeFrom(0);
    };
    const onResize = () => {
      const next = pickViewport(sets, window.innerWidth);
      if (next !== records) {
        closeFrom(0);
        records = next;
      }
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      closeFrom(0);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [sets]);
  return null;
}
