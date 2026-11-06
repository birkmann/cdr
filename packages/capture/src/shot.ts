// Full-page screenshots that do not distort the page, over CDP. Ported from the earlier project's scripts/lib/page-shot.mjs
// (Playwright) to the bare protocol:
//  - desktop: Chrome grows the viewport to the whole page during a full-page shot, so vh-sized boxes would get
//    taller: boxes whose size follows the viewport height are pinned to their used size first;
//  - mobile emulation: full-page shots paint wrongly beyond the viewport: shot viewport by viewport and stitched
//    (fixed boxes hidden and sticky ones made relative after the first tile).
// The page is changed by a shot (pinned sizes); take shots after everything else that reads the page.
import type { Cdp } from "./cdp.js";
import { decodePng, encodePng, type RgbImage } from "./png.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Viewport {
  width: number;
  height: number;
  /** emulate a phone / tablet (touch, mobile viewport) */
  mobile?: boolean;
}

/** `Emulation.setDeviceMetricsOverride` parameters for a viewport at dpr 1. */
export function metricsOf(vp: Viewport, height = vp.height): Record<string, unknown> {
  const m: Record<string, unknown> = { width: vp.width, height, deviceScaleFactor: 1, mobile: !!vp.mobile };
  if (vp.mobile)
    Object.assign(m, {
      screenWidth: vp.width,
      screenHeight: vp.height,
      screenOrientation: { type: "portraitPrimary", angle: 0 },
    });
  return m;
}

/** Animations finished (or cancelled when infinite), no caret, no transitions: the same frame every shot. */
export const STILL_JS = String.raw`(() => {
  const st = document.createElement('style')
  st.id = '__harness_still'
  st.textContent = '*,*::before,*::after{transition:none!important;caret-color:transparent!important}'
  document.head.appendChild(st)
  for (const a of document.getAnimations()) { try { a.finish() } catch { try { a.cancel() } catch {} } }
  return true
})()`;

/** Scroll through the page (lazy content), back to the top, wait for images and fonts. */
export const SCROLL_THROUGH_JS = String.raw`(async (max) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const H = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
  for (let y = 0; y < Math.min(H(), max); y += Math.max(200, innerHeight * 0.8)) { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); await sleep(120) }
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  const end = Date.now() + 6000
  while (Date.now() < end && [...document.images].some((i) => !i.complete)) await sleep(100)
  try { await Promise.race([document.fonts.ready, sleep(3000)]) } catch {}
  await sleep(200)
  return H()
})`;

/** Visible text blocks of the page (each element's own text, deduplicated in order) and its horizontal overflow. */
export const PAGE_FACTS_JS = String.raw`(() => {
  const out = [], seen = new Set()
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1 || r.right <= 0 || r.bottom + scrollY <= 0 || r.left >= document.documentElement.clientWidth) return false; if (/rect\((0|1)(px)?,? ?(0|1)(px)?,? ?(0|1)(px)?,? ?(0|1)(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath)) return false; return true }
  const stack = [document.body]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.shadowRoot) stack.push(...[...n.shadowRoot.children].reverse())
    const kids = n.children ? [...n.children] : []
    if (n.nodeType === 1 && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(n.tagName) && !n.closest('[hidden],[aria-hidden="true"]')) {
      let own = ''
      for (const c of n.childNodes) if (c.nodeType === 3) own += c.textContent
      own = own.replace(/\s+/g, ' ').trim()
      if (own.length > 1 && visible(n) && !seen.has(own)) { seen.add(own); out.push(own) }
    }
    stack.push(...kids.reverse())
  }
  const de = document.documentElement
  return { texts: out.slice(0, 2000), overflowPx: Math.max(0, Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0) - de.clientWidth) }
})()`;

/** in-page: per HTML box [height, min-height, max-height, padding-top, padding-bottom, display] */
const BOX_SIZES_JS = String.raw`(() => {
  const out = [], stack = [document.documentElement]
  while (stack.length) {
    const n = stack.pop()
    if (n.shadowRoot) stack.push(n.shadowRoot)
    for (let i = (n.children ? n.children.length : 0) - 1; i >= 0; i--) stack.push(n.children[i])
    if (n.nodeType !== 1) continue
    if (!(n instanceof window.HTMLElement)) { out.push(null); continue }
    const cs = getComputedStyle(n)
    out.push(cs.display === 'none' || cs.display === 'contents' ? null : [cs.height, cs.minHeight, cs.maxHeight, cs.paddingTop, cs.paddingBottom, cs.display])
  }
  return out
})()`;

/** in-page: pin what changed between the real viewport (`a`) and a page-tall one (`b`) to its `a` value */
const PIN_CHANGED_JS = String.raw`(({ a, b }) => {
  const els = [], stack = [document.documentElement]
  while (stack.length) {
    const n = stack.pop()
    if (n.shadowRoot) stack.push(n.shadowRoot)
    for (let i = (n.children ? n.children.length : 0) - 1; i >= 0; i--) stack.push(n.children[i])
    if (n.nodeType === 1) els.push(n)
  }
  if (els.length !== a.length) return 0
  const idx = new Map(els.map((e, i) => [e, i]))
  const grew = (i) => a[i] && b[i] && a[i][0] !== b[i][0]
  let n = 0
  els.forEach((el, i) => {
    if (!a[i] || !b[i] || !el.style) return
    const props = ['height', 'min-height', 'max-height', 'padding-top', 'padding-bottom']
    for (let k = 1; k < 5; k++) if (a[i][k] !== b[i][k] && /px$/.test(a[i][k])) { el.style.setProperty(props[k], a[i][k], 'important'); n++ }
    if (!grew(i) || /^inline/.test(a[i][5])) return
    const kids = [...el.children, ...(el.shadowRoot ? el.shadowRoot.children : [])]
    if (kids.some((c) => grew(idx.get(c)))) return
    el.style.setProperty('height', a[i][0], 'important'); n++
  })
  return n
})`;

const PAGE_HEIGHT_JS =
  "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)";

async function pinViewportSized(cdp: Cdp, s: string, vp: Viewport) {
  for (let pass = 0; pass < 4; pass++) {
    const a = await cdp.eval(s, BOX_SIZES_JS, 20_000);
    const tall = await cdp.eval(s, `Math.max(${PAGE_HEIGHT_JS}, window.innerHeight * 2)`, 5_000);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      metricsOf(vp, Math.min(Number(tall) || vp.height, 16000)),
      s,
    );
    await sleep(150);
    const b = await cdp.eval(s, BOX_SIZES_JS, 20_000);
    await cdp.send("Emulation.setDeviceMetricsOverride", metricsOf(vp), s);
    await sleep(150);
    const n = await cdp.eval(s, `${PIN_CHANGED_JS}(${JSON.stringify({ a, b })})`, 20_000);
    if (!n) break;
  }
  await cdp.eval(s, "window.scrollTo(0, 0)", 5_000);
}

async function tiledShot(cdp: Cdp, s: string, vp: Viewport): Promise<Buffer | null> {
  const H = Number(await cdp.eval(s, PAGE_HEIGHT_JS, 5_000)) || vp.height;
  if (H > 32000) return null;
  const tiles: { y: number; img: RgbImage }[] = [];
  try {
    for (let y = 0, k = 0; y < H; y += vp.height, k++) {
      const top = Math.min(y, Math.max(0, H - vp.height));
      const at = await cdp.eval(
        s,
        String.raw`((top, k) => {
          if (k === 1) {
            const marks = (window.__harnessTiles = [])
            const all = [document.documentElement], els = []
            while (all.length) { const n = all.pop(); if (n.nodeType === 1) els.push(n); if (n.shadowRoot) all.push(n.shadowRoot); for (const c of n.children || []) all.push(c) }
            for (const el of els) { const p = getComputedStyle(el).position; if (p === 'fixed') marks.push([el, 'visibility', 'hidden']); else if (p === 'sticky') marks.push([el, 'position', 'relative']) }
            for (const m of marks) { if (!m[0].style) continue; m.push(m[0].style.getPropertyValue(m[1]), m[0].style.getPropertyPriority(m[1])); m[0].style.setProperty(m[1], m[2], 'important') }
          }
          window.scrollTo({ top, left: 0, behavior: 'instant' })
          return window.scrollY
        })(${top}, ${k})`,
        10_000,
      );
      if (Math.abs(Number(at) - top) > 1) return null;
      await sleep(120);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, s, 60_000);
      tiles.push({ y: top, img: decodePng(Buffer.from(shot.data, "base64")) });
      if (top + vp.height >= H) break;
    }
  } finally {
    await cdp
      .eval(
        s,
        "(() => { for (const [el, k, , v, pr] of window.__harnessTiles || []) if (el.style) el.style.setProperty(k, v, pr); window.scrollTo(0, 0) })()",
        5_000,
      )
      .catch(() => undefined);
  }
  if (!tiles.length) return null;
  const width = tiles[0].img.width;
  const out = new Uint8Array(width * H * 3).fill(255);
  for (const t of tiles) {
    if (t.img.width !== width) return null;
    const rows = Math.min(t.img.height, H - t.y);
    out.set(t.img.data.subarray(0, rows * width * 3), t.y * width * 3);
  }
  return encodePng({ width, height: H, data: out });
}

/** The current page of session `s` at viewport `vp` → full-page PNG (dpr 1). */
export async function fullPageShot(cdp: Cdp, s: string, vp: Viewport): Promise<Buffer> {
  await cdp.send("Emulation.setDeviceMetricsOverride", metricsOf(vp), s);
  await sleep(300);
  await cdp.eval(
    s,
    "window.addEventListener('resize', (e) => e.stopImmediatePropagation(), true), true",
    5_000,
  );
  await cdp.eval(s, STILL_JS, 5_000).catch(() => undefined);
  if (vp.mobile) {
    const shot = await tiledShot(cdp, s, vp).catch(() => null);
    if (shot) return shot;
  }
  await pinViewportSized(cdp, s, vp);
  const ph = Number(await cdp.eval(s, PAGE_HEIGHT_JS, 5_000)) || vp.height;
  const shot = await cdp.send(
    "Page.captureScreenshot",
    {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: vp.width, height: Math.min(ph, 32000), scale: 1 },
    },
    s,
    120_000,
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", metricsOf(vp), s).catch(() => undefined);
  return Buffer.from(shot.data, "base64");
}
