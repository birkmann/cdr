// A dialog the frozen page opens on load (a consent banner, a notice) is part of what a first-time visitor sees, and the
// verify suite compares that view. The rebuild's capture dismisses such dialogs, so the scene does not have them: the
// replica takes them from the page as it stands, with their computed styles, and they close as on the original.
import { loadForCaptureInfo, newCaptureContext, type ViewportSpec } from "@harness/mirror-verify";

export interface OnLoadOverlay {
  /** the variant's minimum width (the page's layout range this overlay belongs to) */
  minWidth: number;
  /** the capture viewport */
  viewport: string;
  html: string;
}

/** Runs in the page: fixed dialogs in the first screen, serialised with inline computed styles. */
export const ONLOAD_OVERLAY_JS = `(() => {
  const PROPS = ["position","top","right","bottom","left","z-index","display","flex-direction","flex-wrap","align-items","justify-content","gap","width","height","min-width","min-height","max-width","max-height","margin-top","margin-right","margin-bottom","margin-left","padding-top","padding-right","padding-bottom","padding-left","background-color","background-image","color","font-family","font-size","font-weight","font-style","line-height","letter-spacing","text-align","text-transform","text-decoration","white-space","border-top","border-right","border-bottom","border-left","border-radius","box-shadow","opacity","overflow","cursor","box-sizing"];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const ser = (el) => {
    if (el.nodeType === 3) return esc(el.nodeValue);
    if (el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style") return "";
    const cs = getComputedStyle(el);
    const style = PROPS.map((p) => p + ":" + cs.getPropertyValue(p)).join(";");
    const keep = ["id","class","role","aria-label","aria-modal","type"].filter((a) => el.hasAttribute(a)).map((a) => " " + a + '="' + esc(el.getAttribute(a)) + '"').join("");
    const inner = tag === "svg" ? el.innerHTML : Array.from(el.childNodes).map(ser).join("");
    return "<" + tag + keep + ' style="' + esc(style) + '">' + inner + "</" + tag + ">";
  };
  const looksLikeDialog = (el) => {
    const role = el.getAttribute("role") || "";
    const label = [el.id, el.className, el.getAttribute("aria-label")].join(" ");
    return role === "dialog" || role === "alertdialog" || el.getAttribute("aria-modal") === "true" || /cookie|consent|gdpr|privacy|notice/i.test(label);
  };
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    // the capture routine pins fixed boxes to the document before it shoots; they are still the page's fixed dialogs
    const pinned = el.getAttribute("data-cmp-was") === "fixed";
    if ((cs.position !== "fixed" && !pinned) || cs.visibility === "hidden" || cs.display === "none") continue;
    if (!looksLikeDialog(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.top >= innerHeight || r.bottom <= 0) continue;
    if (r.width * r.height > innerWidth * innerHeight * 0.6) continue;
    if (el.parentElement && el.parentElement.closest("[style*=position]") && getComputedStyle(el.parentElement).position === "fixed") continue;
    out.push(ser(el).replace(/position:[a-z]+;top:[^;]*;right:[^;]*;bottom:[^;]*;left:[^;]*;/, () => {
      const left = "left:" + r.left + "px;right:" + (innerWidth - r.right) + "px;";
      return r.top < innerHeight / 2 ? "position:fixed;top:" + r.top + "px;" + left : "position:fixed;bottom:" + (innerHeight - r.bottom) + "px;" + left;
    }));
  }
  return out;
})()`;

/** The on-load dialogs of the frozen page, one set per layout range, in the same state verify sees. */
export async function probeOnLoadOverlays(o: {
  browser: Parameters<typeof newCaptureContext>[0];
  url: string;
  viewports: ViewportSpec[];
  capture: Parameters<typeof newCaptureContext>[2];
  /** the minimum width of the variant a viewport falls in */
  minWidthOf(width: number): number;
}): Promise<OnLoadOverlay[]> {
  const out: OnLoadOverlay[] = [];
  for (const vp of o.viewports) {
    const ctx = await newCaptureContext(o.browser, vp, o.capture);
    try {
      const page = await ctx.newPage();
      await loadForCaptureInfo(page, o.url, vp);
      const items = (await page.evaluate(ONLOAD_OVERLAY_JS).catch(() => [])) as string[];
      for (const html of items) out.push({ minWidth: o.minWidthOf(vp.width), viewport: vp.name, html });
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
  return out;
}

/** The query that opens the page as it is after those dialogs were dismissed (what the rebuild's live captures show). */
export const DISMISSED_QUERY = "cdr-dismissed=1";

/** `app/OnLoadOverlays.tsx`. Rendered on the server, so the first paint has it; any button in it closes it. */
export function overlaysComponent(overlays: readonly OnLoadOverlay[]): string {
  const mins = [...new Set(overlays.map((o) => o.minWidth))].sort((a, b) => a - b);
  const rules = mins
    .map((m, i) => {
      const hi = mins[i + 1];
      const query = [m > 0 ? `(min-width: ${m}px)` : "", hi ? `(max-width: ${hi - 1}px)` : ""]
        .filter(Boolean)
        .join(" and ");
      const rule = `[data-onload-overlay="${m}"] { display: contents; }`;
      return query ? `@media ${query} { ${rule} }` : rule;
    })
    .join("\n");
  return `'use client'
import { useEffect, useState } from 'react'

const OVERLAYS: { minWidth: number; html: string }[] = ${JSON.stringify(overlays.map((o) => ({ minWidth: o.minWidth, html: o.html })))}
const CSS = ${JSON.stringify(`[data-onload-overlay] { display: none; }\n${rules}`)}

export function OnLoadOverlays() {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has(${JSON.stringify(DISMISSED_QUERY.split("=")[0])})) setOpen(false)
  }, [])
  if (!open) return null
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      {OVERLAYS.map((o, i) => (
        <div
          key={i}
          data-onload-overlay={o.minWidth}
          onClick={(e) => {
            if ((e.target as Element).closest('button')) setOpen(false)
          }}
          dangerouslySetInnerHTML={{ __html: o.html }}
        />
      ))}
    </>
  )
}
`;
}
