// Layout sanity at any width (the `responsive` gate): what breaks a page between or beyond the widths it was captured
// at, independent of pixels: text over text, content pushed off the screen, sideways scrolling. Run on the live page
// and on the output at the same widths, so a page's own quirks (an intentional overlap) do not count against the
// recreation: the output may not have more of them than the live page.

/** In-page probe: overlapping text blocks and text outside the viewport (samples for the report). */
export const LAYOUT_CHECK_JS = String.raw`(() => {
  const vw = document.documentElement.clientWidth
  const shown = (el) => { const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }
  // a box that clips or scrolls sideways (a slider track, an overflow-hidden band) owns what sticks out of it
  const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true } return false }
  const blocks = []
  const stack = [document.body]
  while (stack.length) {
    const n = stack.pop()
    if (!n || n.nodeType !== 1) continue
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg)$/i.test(n.tagName) || n.closest('[hidden],[aria-hidden="true"],[data-overlay]')) continue
    let own = ''
    for (const c of n.childNodes) if (c.nodeType === 3) own += c.textContent
    own = own.replace(/\s+/g, ' ').trim()
    if (own.length > 1 && /[\p{L}\p{N}]/u.test(own) && shown(n)) {
      // the glyph box of the element's own text (a block's box can be far wider than its words)
      // and its line boxes: a run that wraps has a bounding box as wide as the paragraph, which the link on one of its
      // lines (a sibling run of the same paragraph) would seem to overlap
      const range = document.createRange()
      let box = null
      const lines = []
      for (const c of n.childNodes) if (c.nodeType === 3 && c.textContent.trim()) {
        range.selectNodeContents(c)
        const r = range.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) box = box ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom }
        for (const q of range.getClientRects()) if (q.width > 0 && q.height > 0) lines.push({ l: q.left, t: q.top + scrollY, r: q.right, b: q.bottom + scrollY })
      }
      if (box) blocks.push({ el: n, text: own.slice(0, 60), box: { l: box.l, t: box.t + scrollY, r: box.r, b: box.b + scrollY }, lines })
    }
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i])
    if (n.shadowRoot) for (const c of n.shadowRoot.children) stack.push(c)
  }
  const overlaps = []
  const sorted = [...blocks].sort((a, b) => a.box.t - b.box.t)
  for (let i = 0; i < sorted.length && overlaps.length < 50; i++) {
    const a = sorted[i]
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]
      if (b.box.t >= a.box.b) break
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const w = Math.min(a.box.r, b.box.r) - Math.max(a.box.l, b.box.l), h = Math.min(a.box.b, b.box.b) - Math.max(a.box.t, b.box.t)
      if (w <= 2 || h <= 2) continue
      // the glyphs collide when some line of one covers a quarter of some line of the other
      const hit = a.lines.some((p) => b.lines.some((q) => {
        const x = Math.min(p.r, q.r) - Math.max(p.l, q.l), y = Math.min(p.b, q.b) - Math.max(p.t, q.t)
        return x > 2 && y > 2 && x * y >= Math.min((p.r - p.l) * (p.b - p.t), (q.r - q.l) * (q.b - q.t)) * 0.25
      }))
      if (hit) overlaps.push([a.text, b.text])
    }
  }
  const offscreen = blocks.filter((b) => (b.box.l < -2 || b.box.r > vw + 2) && !clipped(b.el)).map((b) => b.text)
  // moving media (never the same frame twice): masked out of the pixel comparison at this width
  const media = [...document.querySelectorAll('video, canvas')].filter(shown).map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, w: r.width, h: r.height } }).filter((r) => r.w * r.h >= 40000).slice(0, 20)
  return { blocks: blocks.length, overlaps: overlaps.slice(0, 20), overlapCount: overlaps.length, offscreen: offscreen.slice(0, 20), offscreenCount: offscreen.length, media }
})()`;

export interface LayoutFacts {
  blocks: number;
  overlaps: [string, string][];
  overlapCount: number;
  offscreen: string[];
  offscreenCount: number;
  /** boxes of the page's videos and canvases (page space) */
  media?: { x: number; y: number; w: number; h: number }[];
}

export interface LayoutCheck {
  width: number;
  pass: boolean;
  /** overlapping text pairs: output / live */
  overlaps: { out: number; live: number; samples: [string, string][] };
  offscreen: { out: number; live: number; samples: string[] };
  hscroll: number;
  /** pixel mismatch against the live page at this width (no exact capture there: a looser threshold) */
  pixel?: number;
  /** what fails the gate */
  issues: string[];
  /** what is reported but does not fail it (a layout of the live page that was not captured) */
  notes: string[];
}

const asFacts = (v: unknown): LayoutFacts | null =>
  v && typeof v === "object" && typeof (v as LayoutFacts).overlapCount === "number"
    ? (v as LayoutFacts)
    : null;

/** One width of the sweep: output vs live (a little slack for live pages whose own text touches). */
export function layoutCheck(
  width: number,
  out: { probe?: unknown; overflowPx?: number },
  live: { probe?: unknown } | null,
  pixel: number | undefined,
  maxPixel: number,
  /** the width lies inside a variant's measured span: the output must match the live page there */
  gatePixel = true,
): LayoutCheck {
  const notes: string[] = [];
  const o = asFacts(out.probe),
    l = asFacts(live?.probe);
  const issues: string[] = [];
  const overlaps = { out: o?.overlapCount ?? 0, live: l?.overlapCount ?? 0, samples: o?.overlaps ?? [] };
  const offscreen = {
    out: o?.offscreenCount ?? 0,
    live: l?.offscreenCount ?? 0,
    samples: o?.offscreen ?? [],
  };
  if (!o) issues.push("the layout probe did not run");
  if (overlaps.out > overlaps.live + 1)
    issues.push(
      `${overlaps.out} overlapping text pairs (live ${overlaps.live})${overlaps.samples[0] ? `: "${overlaps.samples[0][0]}" × "${overlaps.samples[0][1]}"` : ""}`,
    );
  if (offscreen.out > offscreen.live)
    issues.push(
      `${offscreen.out} text blocks outside the screen (live ${offscreen.live})${offscreen.samples[0] ? `: "${offscreen.samples[0]}"` : ""}`,
    );
  const hscroll = out.overflowPx ?? 0;
  if (hscroll > 0) issues.push(`${hscroll}px horizontal scroll`);
  if (pixel !== undefined && pixel > maxPixel) {
    if (gatePixel) issues.push(`pixel ${(pixel * 100).toFixed(1)} % (≤ ${(maxPixel * 100).toFixed(0)} %)`);
    else
      notes.push(
        `differs from the live page by ${(pixel * 100).toFixed(0)} %: the page has a layout here that was not captured (capture without --widths, or add a width near ${width}px)`,
      );
  }
  return {
    width,
    pass: issues.length === 0,
    overlaps,
    offscreen,
    hscroll,
    ...(pixel !== undefined ? { pixel } : {}),
    issues,
    notes,
  };
}

/**
 * Widths the output is checked at besides the captured ones: the narrowest phone, the middle of every gap between
 * captures, and wide screens beyond the widest capture (where nothing may be extrapolated).
 */
export function sweepWidths(captured: number[]): number[] {
  const ws = [...new Set(captured.map((w) => Math.round(w)))].sort((a, b) => a - b);
  if (!ws.length) return [];
  const out = new Set<number>();
  if (ws[0] > 340) out.add(320);
  for (let i = 1; i < ws.length; i++)
    if (ws[i] - ws[i - 1] > 120) out.add(Math.round((ws[i] + ws[i - 1]) / 2));
  const top = ws[ws.length - 1];
  if (top < 1880) out.add(1920);
  if (top < 2500) out.add(2560);
  return [...out].filter((w) => !ws.includes(w)).sort((a, b) => a - b);
}
