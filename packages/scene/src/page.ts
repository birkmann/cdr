// Captures of one page → its screens and sections.
// `pageScreens` is ported from the earlier project's apps/web/src/importers/ui.ts without the canvas placement: ids are
// deterministic (`<page>-<width>`, `<variant>-menu-<n>`), so a re-run of the scene stage yields the same JSON.
// `pageSections` is new: the stacked full-width blocks of every variant, matched across widths, which the build
// stage emits one at a time and checks against the live page band by band.
import type { SceneElement, SceneScreen, SceneTokens } from "@harness/protocol";
import type { Snapshot } from "@harness/capture";
import { findElement, walk } from "./dsl/tree.js";
import {
  applyRegionStates,
  menuInteraction,
  menuOverlayOf,
  pageNameOfSnapshot,
  regionKeepIds,
  snapshotToScreen,
  type UrlImportStats,
} from "./importers/url/convert.js";
import { altKeep, altSnapshots, measureAlts } from "./importers/url/fluid.js";
import { mergeProjectFonts, type ProjectFont } from "./lib/projectFonts.js";
import { slugify } from "./lib/slug.js";

/** One capture of the page: its width, breakpoint tier and DOM snapshot. */
export interface PageCapture {
  width: number;
  minWidth: number;
  snap: Snapshot;
}

export interface PageScreens {
  /** variants by ascending width, each followed by its menu overlay screens */
  screens: SceneScreen[];
  variants: Array<{ width: number; id: string; name: string; menuId?: string }>;
  /** the page name the variants share */
  page: string;
  fonts: ProjectFont[];
  /** token hints and stats of the widest capture */
  hints: Partial<SceneTokens>;
  stats: UrlImportStats;
  warnings: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Captures of one page → its screens. Several captures: each variant is named `<Page> · <width>` and carries
 * `responsive: { group, minWidth }`. A capture with an opened menu adds the overlay screen `<Variant> · Menu`
 * (`root.meta.overlayOf` = the variant id), wired to the variant's menu button; its drill-down levels swap in place.
 */
export function pageScreens(
  caps: PageCapture[],
  // (one capture walked at other widths is a responsive page of one variant: it follows its measured geometry)
  responsive = caps.length > 1 || caps.some((c) => (c.snap.alt?.length ?? 0) > 0),
  /** flow: false converts the fitted geometry (UrlImportOptions.flow) */
  o: { flow?: boolean } = {},
): PageScreens {
  const flow = o.flow === false ? { flow: false } : {};
  const sorted = [...caps].sort((a, b) => a.width - b.width);
  const warnings: string[] = [];
  const conv = sorted.map((c) => {
    const menus = (c.snap.states ?? []).filter((s) => s.kind === "menu" && s.snapshot);
    const keep = [
      ...menus.flatMap((m) => (m.trigger !== undefined ? [m.trigger] : [])),
      ...regionKeepIds(c.snap),
    ];
    const res = snapshotToScreen(c.snap, { keep, idPrefix: `w${c.width}-`, ...flow });
    // the page measured at the other widths of its layout range: its layers follow the site between them
    let measured: number[] = [];
    try {
      measured = measureAlts(
        res,
        altSnapshots(c.snap).map((a) => ({
          ...a,
          res: snapshotToScreen(a.snap, {
            keep: altKeep(a.snap, keep),
            idPrefix: `w${c.width}a${a.width}-`,
            ...flow,
          }),
        })),
      );
    } catch (err) {
      res.warnings.push(
        `the ${c.width}px layout could not be measured at its other widths (${message(err)})`,
      );
    }
    // the page's widgets in their other states (filters, expanding cards, accordions) switch in place
    const widgets = applyRegionStates(c.snap, res, o.flow);
    return {
      c,
      menus,
      measured,
      res: {
        ...res,
        warnings: [...res.warnings, ...widgets.warnings],
        fonts: [...res.fonts, ...widgets.fonts],
      },
    };
  });
  if (!conv.length) throw new Error("no captures to convert");
  const widest = conv[conv.length - 1];
  const page = responsive ? pageNameOfSnapshot(widest.c.snap) : widest.res.screen.name;
  const group = slugify(page, "page");
  const screens: SceneScreen[] = [];
  const variants: PageScreens["variants"] = [];
  const fonts: ProjectFont[][] = [];
  for (const { c, menus, res, measured } of conv) {
    const id = `${group}-${c.width}`;
    const name = responsive ? `${page} · ${c.width}` : res.screen.name;
    const screen: SceneScreen = {
      ...res.screen,
      id,
      name,
      platform: "web",
      ...(responsive
        ? { responsive: { group, minWidth: c.minWidth, ...(measured.length ? { measured } : {}) } }
        : {}),
    };
    const tag = responsive ? `${c.width}px: ` : "";
    warnings.push(...res.warnings.map((w) => tag + w));
    fonts.push(res.fonts);
    screens.push(screen);
    const variant: PageScreens["variants"][number] = { width: c.width, id, name };
    variants.push(variant);
    menus.forEach((state, mi) => {
      try {
        const all = c.snap.states ?? [];
        const levels = all.filter(
          (s) =>
            s.kind === "submenu" && s.snapshot && s.parent === all.indexOf(state) && s.item !== undefined,
        );
        const m = menuOverlayOf(c.snap, state, { keep: levels.map((l) => l.item!), ...flow });
        const menuId = `${id}-menu-${mi + 1}`;
        const trigger = state.trigger !== undefined ? res.idOf.get(state.trigger) : undefined;
        const button = trigger ? findElement(screen.root, trigger) : null;
        if (button) button.interaction = menuInteraction(menuId, m, state.motion);
        else warnings.push(`${tag}menu button not found: the menu screen is not linked`);
        const close = m.closeId ? findElement(m.screen.root, m.closeId) : null;
        if (close) close.interaction = { onTap: "close-overlay" };
        const menuName = `${name} · ${menus.length > 1 ? `Menu ${mi + 1}` : "Menu"}`;
        screens.push({
          ...m.screen,
          id: menuId,
          name: menuName,
          platform: "web",
          root: { ...m.screen.root, meta: { ...m.screen.root.meta, overlayOf: id } },
        });
        fonts.push(m.fonts);
        variant.menuId ??= menuId;
        // next levels: the entry swaps the menu for its level in place, the level's back control swaps back
        levels.forEach((level, li) => {
          const entryId = m.idOf.get(level.item!);
          const entry = entryId ? findElement(m.screen.root, entryId) : null;
          if (!entry) {
            warnings.push(`${tag}menu entry ${level.label ?? ""} not found: its next level is not linked`);
            return;
          }
          const sub = menuOverlayOf(c.snap, level, flow);
          const subId = `${menuId}-level-${li + 1}`;
          entry.interaction = { ...menuInteraction(subId, sub, level.motion), onTap: "swap-overlay" };
          const back = sub.backId ? findElement(sub.screen.root, sub.backId) : null;
          if (back)
            back.interaction = {
              ...menuInteraction(menuId, m, { enter: "none", duration: 0, easing: "linear" }),
              onTap: "swap-overlay",
            };
          const subClose = sub.closeId ? findElement(sub.screen.root, sub.closeId) : null;
          if (subClose) subClose.interaction = { onTap: "close-overlay" };
          screens.push({
            ...sub.screen,
            id: subId,
            name: `${menuName} › ${level.label || "Level"}`,
            platform: "web",
            root: { ...sub.screen.root, meta: { ...sub.screen.root.meta, overlayOf: id } },
          });
          fonts.push(sub.fonts);
        });
      } catch (err) {
        warnings.push(`${tag}menu could not be rebuilt (${message(err)})`);
      }
    });
  }
  return {
    screens,
    variants,
    page,
    fonts: mergeProjectFonts([], fonts.flat()),
    hints: widest.res.designSystemHints,
    stats: widest.res.stats,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------------- sections

export type SectionKind = "header" | "hero" | "section" | "footer";

/** A section of one variant: its element and page-space band. */
export interface SectionCopy {
  screen: string;
  width: number;
  element: string;
  y: number;
  h: number;
}

/** One section of the page, matched across the variants (order kept). */
export interface Section {
  id: string;
  index: number;
  kind: SectionKind;
  label: string;
  copies: SectionCopy[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Page-space boxes of a screen's elements (absolute children placed from x / y; flow children estimated by order). */
function boxes(screen: SceneScreen): Map<SceneElement, Box> {
  const out = new Map<SceneElement, Box>();
  const visit = (el: SceneElement, x: number, y: number, pw: number) => {
    const L = el.layout ?? {};
    const w = typeof L.width === "number" ? L.width : pw;
    const h = typeof L.height === "number" ? L.height : 0;
    const box = { x, y, w, h };
    out.set(el, box);
    const pad =
      typeof L.padding === "number" ? [L.padding, L.padding] : Array.isArray(L.padding) ? L.padding : [0, 0];
    const padTop = pad[0] ?? 0,
      padLeft = (pad.length === 4 ? pad[3] : pad[1]) ?? 0;
    let flowY = y + padTop;
    for (const c of el.children ?? []) {
      const C = c.layout ?? {};
      if (C.position === "absolute") visit(c, x + (C.x ?? 0), y + (C.y ?? 0), w);
      else if (L.direction === "row")
        visit(c, x + padLeft, y + padTop, typeof C.width === "number" ? C.width : w);
      else {
        visit(c, x + padLeft, flowY, w - 2 * padLeft);
        flowY += out.get(c)!.h + (L.gap ?? 0);
      }
    }
    // hug: as tall as the children
    if (!h) {
      let bottom = y;
      for (const c of el.children ?? []) {
        const b = out.get(c)!;
        bottom = Math.max(bottom, b.y + b.h);
      }
      box.h = Math.max(0, bottom - y);
    }
  };
  visit(screen.root, 0, 0, screen.width);
  return out;
}

const textOf = (el: SceneElement): string => {
  const parts: string[] = [];
  walk(el, (e) => {
    if (e.type === "text" && e.text) parts.push(e.text);
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
};

const headingOf = (el: SceneElement): string | null => {
  let best: { size: number; text: string } | null = null;
  walk(el, (e) => {
    if (e.type !== "text" || !e.text?.trim()) return;
    const size = e.style?.fontSize ?? 0;
    if (!best || size > best.size) best = { size, text: e.text.trim() };
  });
  return best ? (best as { text: string }).text.slice(0, 60) : null;
};

/** The stacked full-width blocks of one variant (descending through single wrappers), top to bottom. */
function variantBlocks(screen: SceneScreen): { el: SceneElement; box: Box }[] {
  const bx = boxes(screen);
  const W = screen.width;
  const viewport = W < 600 ? 844 : W < 1024 ? 1024 : 1000;
  const qualifying = (container: SceneElement) =>
    (container.children ?? [])
      // a widget's states frame stands for its active state; the other states are hidden behind it and are never
      // sections of their own
      .map((c) => (c.states?.active ? (c.children?.find((x) => x.id === c.states!.active) ?? c) : c))
      .filter((c) => {
        const b = bx.get(c)!;
        return b.w >= W * 0.6 && b.h >= 24 && c.meta?.hidden !== true;
      });
  // a page wrapper (main, #page, .content …), or a block taller than 1.5 viewports, holding several full-width blocks
  const WRAPPER = /^(main|page|content|wrapper|container|site|app|body|root|layout)\b/i;
  const blocks = (container: SceneElement, depth: number): SceneElement[] => {
    const out: SceneElement[] = [];
    const kids = qualifying(container);
    for (const k of kids) {
      const inner = depth < 8 ? qualifying(k) : [];
      const wrapper =
        inner.length >= 2 &&
        (kids.length === 1 || WRAPPER.test(k.name ?? "") || bx.get(k)!.h > viewport * 1.5);
      if (wrapper) out.push(...blocks(k, depth + 1));
      else out.push(k);
    }
    return out;
  };
  return blocks(screen.root, 0)
    .map((el) => ({ el, box: bx.get(el)! }))
    .sort((a, b) => a.box.y - b.box.y || a.box.h - b.box.h);
}

function classify(i: number, n: number, box: Box, viewport: number): SectionKind {
  if (i === 0 && box.h <= 200) return "header";
  if (i === n - 1 && n > 1) return "footer";
  if ((i === 1 || (i === 0 && box.h > 200)) && box.y < viewport) return "hero";
  return "section";
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
function similarity(a: string, b: string): number {
  const A = words(a),
    B = words(b);
  if (!A.size && !B.size) return 1;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(1, Math.min(A.size, B.size));
}

/**
 * The sections of a page's variants (overlay screens excluded), matched across widths: the widest variant names the
 * sections, the others join by order and shared words (a weighted longest common subsequence); a block a variant has
 * alone becomes a section of its own.
 */
export function pageSections(screens: SceneScreen[]): Section[] {
  const variants = screens
    .filter((s) => typeof s.root.meta?.overlayOf !== "string")
    .sort((a, b) => b.width - a.width);
  const sections: (Section & { text: string })[] = [];
  const viewport = (w: number) => (w < 600 ? 844 : w < 1024 ? 1024 : 1000);
  for (const s of variants) {
    const list = variantBlocks(s).map(({ el, box }) => ({ el, box, text: textOf(el) }));
    if (!sections.length) {
      list.forEach(({ el, box, text }, i) => {
        const kind = classify(i, list.length, box, viewport(s.width));
        const label = kind === "header" || kind === "footer" ? kind : (headingOf(el) ?? `Section ${i + 1}`);
        sections.push({
          id: "",
          index: i,
          kind,
          label,
          text,
          copies: [{ screen: s.id, width: s.width, element: el.id, y: box.y, h: box.h }],
        });
      });
      continue;
    }
    // LCS over (existing sections, this variant's blocks) by text similarity ≥ 0.4
    const n = sections.length,
      m = list.length;
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) {
        const sim = similarity(sections[i].text, list[j].text);
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], sim >= 0.4 ? sim + dp[i + 1][j + 1] : 0);
      }
    const matched = new Map<number, number>();
    for (let i = 0, j = 0; i < n && j < m;) {
      const sim = similarity(sections[i].text, list[j].text);
      if (sim >= 0.4 && dp[i][j] === sim + dp[i + 1][j + 1]) {
        matched.set(j, i);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    let insertAt = 0;
    list.forEach(({ el, box, text }, j) => {
      const copy = { screen: s.id, width: s.width, element: el.id, y: box.y, h: box.h };
      const i = matched.get(j);
      if (i !== undefined) {
        const target = sections.find((x) => x.index === i)!;
        target.copies.push(copy);
        insertAt = sections.indexOf(target) + 1;
      } else {
        sections.splice(insertAt++, 0, {
          id: "",
          index: -1,
          kind: "section",
          label: headingOf(el) ?? "Section",
          text,
          copies: [copy],
        });
      }
    });
    sections.forEach((x, k) => (x.index = k));
  }
  const used = new Map<string, number>();
  return sections.map(({ text: _text, ...x }, index) => {
    const base = x.kind === "section" ? slugify(x.label, "section").slice(0, 32) : x.kind;
    const k = (used.get(base) ?? 0) + 1;
    used.set(base, k);
    return {
      ...x,
      index,
      id: k === 1 ? base : `${base}-${k}`,
      copies: x.copies.sort((a, b) => a.width - b.width),
    };
  });
}

/**
 * Mark each section's element (`meta.section`, emitted as `data-section` inside `<!-- section:id -->` markers) in a
 * copy of the screens; page-level absolute layers inside a section's band get `meta.sectionOf` (`data-section-of`).
 */
export function tagSections(screens: SceneScreen[], sections: Section[]): SceneScreen[] {
  const byElement = new Map<string, string>();
  const bands = new Map<string, { id: string; y: number; h: number }[]>();
  for (const s of sections)
    for (const c of s.copies) {
      byElement.set(`${c.screen}|${c.element}`, s.id);
      bands.set(c.screen, [...(bands.get(c.screen) ?? []), { id: s.id, y: c.y, h: c.h }]);
    }
  return screens.map((screen) => {
    const root = structuredClone(screen.root);
    walk(root, (e) => {
      const id = byElement.get(`${screen.id}|${e.id}`);
      if (id) e.meta = { ...e.meta, section: id };
    });
    for (const c of root.children ?? []) {
      if (c.meta?.section || c.layout?.position !== "absolute" || typeof c.layout.y !== "number") continue;
      const y = c.layout.y;
      const band = (bands.get(screen.id) ?? []).find((b) => y >= b.y && y < b.y + b.h);
      if (band) c.meta = { ...c.meta, sectionOf: band.id };
    }
    return { ...screen, root };
  });
}

/**
 * The screens with only the first `count` sections (later sections removed from every variant; overlay screens
 * kept): what the build stage writes after each section, so the preview shows the page growing.
 */
export function screensUpTo(screens: SceneScreen[], sections: Section[], count: number): SceneScreen[] {
  const drop = new Set<string>();
  const bands = new Map<string, [number, number][]>();
  for (const s of sections.slice(count))
    for (const c of s.copies) {
      drop.add(`${c.screen}|${c.element}`);
      bands.set(c.screen, [...(bands.get(c.screen) ?? []), [c.y, c.y + c.h]]);
    }
  return screens.map((screen) => {
    if (typeof screen.root.meta?.overlayOf === "string") return screen;
    const inBand = (el: SceneElement) => {
      const y = el.layout?.y;
      return (
        el.layout?.position === "absolute" &&
        typeof y === "number" &&
        (bands.get(screen.id) ?? []).some(([a, b]) => y >= a && y < b)
      );
    };
    const prune = (el: SceneElement, top: boolean): SceneElement => ({
      ...el,
      ...(el.children
        ? {
            children: el.children
              .filter((c) => !drop.has(`${screen.id}|${c.id}`) && !(top && inBand(c)))
              .map((c) => prune(c, false)),
          }
        : {}),
    });
    return { ...screen, root: prune(screen.root, true) };
  });
}
