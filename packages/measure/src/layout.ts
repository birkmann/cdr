// Layout sanity at any width (the `responsive` gate): what breaks a page between or beyond the widths it was captured
// at, independent of pixels: content over content, text cut by its box or pushed off the screen, sideways scrolling, a
// page whose height does not follow its content. Run on the live page and on the output at the same widths, and
// compared by identity: an overlap the output has is fine only when the live page has the same one at that width (an
// intentional overlap, text over a hero photo), never because the live page happens to have as many of another kind.

/**
 * In-page probe (the live page and the output run the same one). Every finding carries a key that is the same on
 * both pages (the start of a text, "media" for an image or video, a control's label), so they can be compared.
 */
export const LAYOUT_CHECK_JS = String.raw`(() => {
  const vw = document.documentElement.clientWidth
  const sy = scrollY
  const shown = (el) => { const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }
  // a box that clips or scrolls sideways (a slider track, an overflow-hidden band) owns what sticks out of it
  const clippedX = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true } return false }
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  const keyOf = (t) => 't:' + norm(t).slice(0, 40).toLowerCase()
  // a text's key is its block's: the runs of one paragraph or heading split over inline elements on one page ("Der neue
  // <span>BMW iX4</span>") and joined on the other are the same text. The block is the nearest box that is not inline;
  // it keys by its rendered text when everything with text in it is inline (else by the element's own text)
  const inlineLevel = (el) => /^(inline|contents)$/.test(getComputedStyle(el).display)
  const blockKey = (n, own) => {
    let h = n
    while (h.parentElement && h.parentElement !== document.body && inlineLevel(h)) h = h.parentElement
    const all = h.querySelectorAll('*')
    if (all.length > 60) return keyOf(own)
    for (const e of all) if (e.tagName !== 'BR' && !inlineLevel(e) && norm(e.textContent || '')) return keyOf(own)
    return keyOf(h.innerText || own)
  }
  const sectionOf = (el) => { const s = el.closest && el.closest('[data-section]'); return s ? s.getAttribute('data-section') : undefined }
  const skip = (n) => /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg)$/i.test(n.tagName) || n.closest('[hidden],[aria-hidden="true"],[data-overlay]')
  const page = (r) => ({ l: r.left, t: r.top + sy, r: r.right, b: r.bottom + sy })
  // taken out of the page's flow by itself or an ancestor below body (sticky stays in flow)
  const outOfFlow = (el) => { for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'absolute' || pos === 'fixed') return true } return false }
  // lines of the text cut off by a box that hides its overflow vertically (a box too short for its text). Text the box
  // hides entirely (a closed accordion) and boxes that truncate on purpose (ellipsis, line-clamp) are not cuts.
  const cut = (el, lines) => {
    for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) return false
      const oy = cs.overflowY
      if (oy === 'auto' || oy === 'scroll') return false
      if (oy === 'hidden' || oy === 'clip') {
        const r = page(p.getBoundingClientRect())
        const seen = lines.filter((q) => q.b > r.t + 1 && q.t < r.b - 1)
        if (!seen.length) return false
        if (lines.some((q) => q.b > r.b + 2 || q.t < r.t - 2)) return true
      }
    }
    return false
  }
  const blocks = []
  const stack = [document.body]
  while (stack.length) {
    const n = stack.pop()
    if (!n || n.nodeType !== 1) continue
    if (skip(n)) continue
    let own = ''
    for (const c of n.childNodes) if (c.nodeType === 3) own += ' ' + c.textContent
    own = norm(own)
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
        for (const q of range.getClientRects()) if (q.width > 0 && q.height > 0) lines.push(page(q))
      }
      // what of its lines shows: clipped by the boxes around it that hide or scroll their overflow (a line a box cuts
      // off is no overlap with what is below the box)
      let clip = null
      for (let p = n.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
        const r = page(p.getBoundingClientRect())
        clip = clip ? { l: Math.max(clip.l, r.l), t: Math.max(clip.t, r.t), r: Math.min(clip.r, r.r), b: Math.min(clip.b, r.b) } : r
      }
      const seen = clip ? lines.map((q) => ({ l: Math.max(q.l, clip.l), t: Math.max(q.t, clip.t), r: Math.min(q.r, clip.r), b: Math.min(q.b, clip.b) })).filter((q) => q.r - q.l > 1 && q.b - q.t > 1) : lines
      if (box) blocks.push({ el: n, text: own.slice(0, 60), key: blockKey(n, own), box: { l: box.l, t: box.t + sy, r: box.r, b: box.b + sy }, lines: seen, raw: lines })
    }
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i])
    if (n.shadowRoot) for (const c of n.shadowRoot.children) stack.push(c)
  }
  // the glyphs collide when some line of one covers a quarter of some line of the other
  const hits = (as, bs) => as.some((p) => bs.some((q) => {
    const x = Math.min(p.r, q.r) - Math.max(p.l, q.l), y = Math.min(p.b, q.b) - Math.max(p.t, q.t)
    return x > 2 && y > 2 && x * y >= Math.min((p.r - p.l) * (p.b - p.t), (q.r - q.l) * (q.b - q.t)) * 0.25
  }))
  // a line covered for a quarter of its area by a box (an image, a control without text)
  const under = (lines, r) => lines.some((q) => {
    const x = Math.min(q.r, r.r) - Math.max(q.l, r.l), y = Math.min(q.b, r.b) - Math.max(q.t, r.t)
    return x > 2 && y > 2 && x * y >= (q.r - q.l) * (q.b - q.t) * 0.25
  })
  const pairs = []
  const seen = new Set()
  const add = (kind, a, bKey, bText, el, y) => {
    const key = [a.key, bKey].sort().join(' × ')
    if (seen.has(key)) return
    seen.add(key)
    pairs.push({ key, kind, a: a.text, b: bText, y: Math.round(y), ...(sectionOf(el) ? { section: sectionOf(el) } : {}) })
  }
  const overlaps = []
  let overlapCount = 0
  const sorted = [...blocks].sort((a, b) => a.box.t - b.box.t)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    if (!a.lines.length) continue
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]
      if (b.box.t >= a.box.b) break
      if (!b.lines.length || a.key === b.key || a.el.contains(b.el) || b.el.contains(a.el)) continue
      const w = Math.min(a.box.r, b.box.r) - Math.max(a.box.l, b.box.l), h = Math.min(a.box.b, b.box.b) - Math.max(a.box.t, b.box.t)
      if (w <= 2 || h <= 2) continue
      if (hits(a.lines, b.lines)) {
        overlapCount++
        if (overlaps.length < 20) overlaps.push([a.text, b.text])
        add('text', a, b.key, b.text, a.el, Math.max(a.box.t, b.box.t))
      }
    }
  }
  // text over media (an image or a video that is not the text's own box) and controls without text over text
  const boxes = []
  for (const el of document.querySelectorAll('img, video, canvas, iframe, button, input, select, textarea, a, [role="button"]')) {
    if (skip(el) || !shown(el)) continue
    const media = /^(IMG|VIDEO|CANVAS|IFRAME)$/.test(el.tagName)
    if (!media && norm(el.textContent || '')) continue
    const r = page(el.getBoundingClientRect())
    if (r.r - r.l < 8 || r.b - r.t < 8) continue
    const label = media ? 'media' : 'c:' + norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.tagName.toLowerCase()).slice(0, 30).toLowerCase()
    boxes.push({ el, r, key: media ? 'media' : label, kind: media ? 'media' : 'control' })
  }
  for (const a of blocks) for (const m of boxes) {
    if (m.r.t >= a.box.b || m.r.b <= a.box.t || m.r.l >= a.box.r || m.r.r <= a.box.l) continue
    if (m.el.contains(a.el) || a.el.contains(m.el)) continue
    if (under(a.lines, m.r)) add(m.kind, a, m.key, m.key, a.el, Math.max(a.box.t, m.r.t))
  }
  const offscreen = blocks.filter((b) => (b.box.l < -2 || b.box.r > vw + 2) && !clippedX(b.el))
  const clipped = blocks.filter((b) => cut(b.el, b.raw))
  const out = blocks.filter((b) => outOfFlow(b.el))
  // moving media (never the same frame twice): masked out of the pixel comparison at this width
  const media = [...document.querySelectorAll('video, canvas')].filter(shown).map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top + sy, w: r.width, h: r.height } }).filter((r) => r.w * r.h >= 40000).slice(0, 20)
  const uniq = (xs) => [...new Set(xs)]
  // the output's sections (data-section): the height of the copy shown at this width
  const sections = {}
  for (const el of document.querySelectorAll('[data-section]')) {
    const id = el.getAttribute('data-section')
    if (id in sections || !shown(el)) continue
    sections[id] = Math.round(el.getBoundingClientRect().height)
  }
  return {
    blocks: blocks.length,
    overlaps,
    overlapCount,
    offscreen: offscreen.map((b) => b.text).slice(0, 20),
    offscreenCount: offscreen.length,
    offscreenKeys: uniq(offscreen.map((b) => b.key)).slice(0, 200),
    pairs: pairs.slice(0, 200),
    clipped: uniq(clipped.map((b) => b.key)).slice(0, 200),
    clippedText: clipped.map((b) => ({ k: b.key, text: b.text, ...(sectionOf(b.el) ? { section: sectionOf(b.el) } : {}), y: Math.round(b.box.t) })).slice(0, 50),
    outOfFlow: uniq(out.map((b) => b.key)).slice(0, 400),
    docHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    anchors: sorted.slice(0, 200).map((b) => ({ k: b.key, x: Math.round(b.box.l), y: Math.round(b.box.t), ...(sectionOf(b.el) ? { s: sectionOf(b.el) } : {}) })),
    sections,
    media,
  }
})()`;

/** One overlapping pair: a text over another text, over an image or video, or under a control without text. */
export interface ContentPair {
  /** the same on the live page and the output: both parts' keys, sorted */
  key: string;
  kind: "text" | "media" | "control";
  a: string;
  b: string;
  /** page y where they meet */
  y?: number;
  /** the output's section the first part is in (`data-section`) */
  section?: string;
}

export interface LayoutFacts {
  blocks: number;
  overlaps: [string, string][];
  overlapCount: number;
  offscreen: string[];
  offscreenCount: number;
  /** boxes of the page's videos and canvases (page space) */
  media?: { x: number; y: number; w: number; h: number }[];
  // the facts below are newer: facts recorded before they existed are compared by count
  offscreenKeys?: string[];
  pairs?: ContentPair[];
  /** keys of texts a box cuts off vertically */
  clipped?: string[];
  clippedText?: { k?: string; text: string; section?: string; y?: number }[];
  /** keys of texts out of the page's flow (an absolute or fixed box at or above them, below body) */
  outOfFlow?: string[];
  docHeight?: number;
  /** text blocks (the first 200 by position): key, page position and the output's section (`data-section`) */
  anchors?: { k: string; x: number; y: number; s?: string }[];
  /** the output's sections: the height of the copy shown at this width */
  sections?: Record<string, number>;
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
  /** content pairs the output has and the live page does not (at this width or its neighbours) */
  pairs?: ContentPair[];
  /** texts the output cuts off and the live page does not */
  clipped?: { text: string; section?: string; y?: number }[];
  /** page height: output / live (px) and the difference in percent */
  height?: { out: number; live: number; pct: number };
  /** texts out of flow in the output that are in flow on the live page (the flow gate counts them) */
  outOfFlow?: string[];
  /** how far text blocks found on both pages sit from where the live page has them (px, relative to the page height) */
  drift?: { median: number; max: number; n: number };
  /** the live facts this width was judged against: its own, or its neighbours' (a rotating width), or none */
  against?: "own" | "neighbours" | "none";
  /** what fails the gate */
  issues: string[];
  /** what is reported but does not fail it (a layout of the live page that was not captured) */
  notes: string[];
}

const asFacts = (v: unknown): LayoutFacts | null =>
  v && typeof v === "object" && typeof (v as LayoutFacts).overlapCount === "number"
    ? (v as LayoutFacts)
    : null;

export interface LayoutCheckOptions {
  /** live facts of the nearest widths around this one (judged against their union when there is none of its own) */
  neighbours?: { probe?: unknown }[];
  /** page height gate in percent (sweepHeightPct); undefined: not checked */
  heightPct?: number;
}

/**
 * Keys compared without their spaces (a pair key: each side's, in order): one page renders a line break between two
 * inline runs where the other has a space ("Der neue" / "BMW iX4").
 */
const canon = (k: string) =>
  k
    .split(" × ")
    .map((x) => x.replace(/\s+/g, ""))
    .sort()
    .join("×");
const union = (xs: (string[] | undefined)[]) => new Set(xs.flatMap((x) => x ?? []).map(canon));

/**
 * A text the output splits into pieces of one block (its lines kept as separate boxes: "Der neue" / "BMW iX3 M60
 * xDrive.") is a piece of the live page's block: each piece's key (one side of a pair key too) maps to the live
 * block that contains it, the one nearest it on the page when several do. → the key, mapped where it is no live key.
 */
function fragments(of: LayoutFacts, refs: LayoutFacts[]): (key: string) => string {
  const live = refs.flatMap((r) => r.anchors ?? []);
  const known = new Set(live.map((a) => canon(a.k)));
  const ys = new Map((of.anchors ?? []).map((a) => [a.k, a.y]));
  const one = (k: string): string => {
    const c = canon(k);
    if (!k.startsWith("t:") || known.has(c) || c.length < 7) return k;
    const y = ys.get(k);
    let best: { k: string; d: number } | null = null;
    for (const a of live) {
      if (!canon(a.k).includes(c.slice(2))) continue;
      const d = y === undefined ? 0 : Math.abs(a.y - y);
      // (a piece sits near its block: a short text elsewhere that some far block happens to contain is no piece of it)
      if (d > 400) continue;
      if (!best || d < best.d) best = { k: a.k, d };
    }
    return best?.k ?? k;
  };
  return (key) => key.split(" × ").map(one).join(" × ");
}

/**
 * One width of the sweep: the output against the live page. With the newer facts every finding is compared by key
 * (an output overlap passes only when the live page has the same one); with older facts by count.
 */
export function layoutCheck(
  width: number,
  out: { probe?: unknown; overflowPx?: number },
  live: { probe?: unknown } | null,
  pixel: number | undefined,
  maxPixel: number,
  /** the width lies inside a variant's measured span: the output must match the live page there */
  gatePixel = true,
  o: LayoutCheckOptions = {},
): LayoutCheck {
  const notes: string[] = [];
  const issues: string[] = [];
  const of = asFacts(out.probe);
  const own = asFacts(live?.probe);
  const near = (o.neighbours ?? []).map((n) => asFacts(n.probe)).filter((f): f is LayoutFacts => !!f);
  const refs = own ? [own] : near;
  const against: LayoutCheck["against"] = own ? "own" : near.length ? "neighbours" : "none";
  const ref = refs[0] ?? null;
  const overlaps = {
    out: of?.overlapCount ?? 0,
    live: ref ? Math.max(...refs.map((r) => r.overlapCount)) : 0,
    samples: of?.overlaps ?? [],
  };
  const offscreen = {
    out: of?.offscreenCount ?? 0,
    live: ref ? Math.max(...refs.map((r) => r.offscreenCount)) : 0,
    samples: of?.offscreen ?? [],
  };
  if (!of) issues.push("the layout probe did not run");
  const keyed = !!of?.pairs && (refs.length === 0 || refs.every((r) => !!r.pairs));
  let pairs: ContentPair[] | undefined;
  let clipped: LayoutCheck["clipped"];
  if (of && keyed) {
    const fit = fragments(of, refs);
    const livePairs = union(refs.map((r) => r.pairs?.map((p) => p.key)));
    pairs = (of.pairs ?? []).filter((p) => !livePairs.has(canon(fit(p.key))));
    if (pairs.length)
      issues.push(
        `${pairs.length} overlapping pair${pairs.length === 1 ? "" : "s"} the live page does not have: ${pairs
          .slice(0, 2)
          .map((p) => `"${p.a}" × "${p.b}"`)
          .join(", ")}`,
      );
    const liveClipped = union(refs.map((r) => r.clipped));
    const cutKeys = new Set((of.clipped ?? []).filter((k) => !liveClipped.has(canon(k))));
    clipped = (of.clippedText ?? [])
      .filter((c) => cutKeys.has(c.k ?? `t:${c.text.toLowerCase().slice(0, 40)}`))
      .map(({ k: _k, ...c }) => c);
    if (cutKeys.size)
      issues.push(
        `${cutKeys.size} text${cutKeys.size === 1 ? "" : "s"} cut off by their box${clipped[0] ? `: "${clipped[0].text}"` : ""}`,
      );
    const liveOff = union(refs.map((r) => r.offscreenKeys));
    const off = (of.offscreenKeys ?? []).filter((k) => !liveOff.has(canon(k)));
    if (off.length)
      issues.push(
        `${off.length} text block${off.length === 1 ? "" : "s"} outside the screen${offscreen.samples[0] ? `: "${offscreen.samples[0]}"` : ""}`,
      );
    if (refs.length) {
      const liveIn = union(refs.map((r) => r.outOfFlow));
      const liveKeys = union(refs.map((r) => r.anchors?.map((a) => a.k)));
      // out of flow in the output, in flow (present, not out of flow) on the live page
      const oof = (of.outOfFlow ?? []).filter(
        (k) => liveKeys.has(canon(fit(k))) && !liveIn.has(canon(fit(k))),
      );
      if (oof.length) outOfFlowNote(oof, notes);
      return finish({ outOfFlow: oof });
    }
  } else if (of) {
    // older facts: by count (the live page's own overlaps allowed)
    if (overlaps.out > overlaps.live)
      issues.push(
        `${overlaps.out} overlapping text pairs (live ${overlaps.live})${overlaps.samples[0] ? `: "${overlaps.samples[0][0]}" × "${overlaps.samples[0][1]}"` : ""}`,
      );
    if (offscreen.out > offscreen.live)
      issues.push(
        `${offscreen.out} text blocks outside the screen (live ${offscreen.live})${offscreen.samples[0] ? `: "${offscreen.samples[0]}"` : ""}`,
      );
  }
  return finish({});

  function finish(extra: { outOfFlow?: string[] }): LayoutCheck {
    const hscroll = out.overflowPx ?? 0;
    if (hscroll > 0) issues.push(`${hscroll}px horizontal scroll`);
    if (pixel !== undefined && pixel > maxPixel) {
      if (gatePixel) issues.push(`pixel ${(pixel * 100).toFixed(1)} % (≤ ${(maxPixel * 100).toFixed(0)} %)`);
      else
        notes.push(
          `differs from the live page by ${(pixel * 100).toFixed(0)} %: the page has a layout here that was not captured (capture without --widths, or add a width near ${width}px)`,
        );
    }
    // the page's height follows its content: only against the live page's own height at this width
    let height: LayoutCheck["height"];
    if (own?.docHeight && of?.docHeight) {
      const pct = (Math.abs(of.docHeight - own.docHeight) / own.docHeight) * 100;
      height = { out: of.docHeight, live: own.docHeight, pct: Math.round(pct * 10) / 10 };
      if (o.heightPct !== undefined && pct > o.heightPct) {
        const msg = `page height ${of.docHeight}px, live ${own.docHeight}px (${pct.toFixed(1)} %, ≤ ${o.heightPct} %)`;
        if (gatePixel) issues.push(msg);
        else notes.push(`${msg}: the page has a layout here that was not captured`);
      }
    }
    const drift = own && of ? anchorDrift(of, own) : undefined;
    if (against === "none" && of) notes.push("no live facts at or near this width");
    return {
      width,
      pass: issues.length === 0,
      overlaps,
      offscreen,
      hscroll,
      ...(pixel !== undefined ? { pixel } : {}),
      ...(pairs ? { pairs } : {}),
      ...(clipped ? { clipped } : {}),
      ...(height ? { height } : {}),
      ...(extra.outOfFlow ? { outOfFlow: extra.outOfFlow } : {}),
      ...(drift ? { drift } : {}),
      against,
      issues,
      notes,
    };
  }
}

function outOfFlowNote(keys: string[], notes: string[]) {
  notes.push(
    `${keys.length} text block${keys.length === 1 ? "" : "s"} out of flow that the live page keeps in flow (${keys
      .slice(0, 2)
      .map((k) => `"${k.slice(2)}"`)
      .join(", ")})`,
  );
}

/** How far text blocks that both pages have once sit from each other, relative to each page's height. */
export function anchorDrift(out: LayoutFacts, live: LayoutFacts): LayoutCheck["drift"] | undefined {
  if (!out.anchors?.length || !live.anchors?.length || !out.docHeight || !live.docHeight) return undefined;
  const once = (as: { k: string; x: number; y: number }[]) => {
    const n = new Map<string, number>();
    for (const a of as) n.set(a.k, (n.get(a.k) ?? 0) + 1);
    return new Map(as.filter((a) => n.get(a.k) === 1).map((a) => [a.k, a]));
  };
  const a = once(out.anchors),
    b = once(live.anchors);
  const d: number[] = [];
  for (const [k, p] of a) {
    const q = b.get(k);
    if (q) d.push(Math.abs(p.y / out.docHeight - q.y / live.docHeight) * live.docHeight);
  }
  if (!d.length) return undefined;
  d.sort((x, y) => x - y);
  return { median: Math.round(d[Math.floor(d.length / 2)]!), max: Math.round(d[d.length - 1]!), n: d.length };
}

/**
 * Widths the live page is screenshotted at besides the captured ones (pixels compared there): the narrowest phone,
 * the middle of every gap between captures, and wide screens beyond the widest capture.
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

export interface SweepPlan {
  /** every GRID_STEP_NARROW px below 1024, GRID_STEP_WIDE above, up to the widest measured width, and 2560 */
  grid: number[];
  /** both sides of every variant boundary (`minWidth − 1`, `minWidth`) */
  boundaries: number[];
  /** widths no earlier measurement of the run used (seeded), at least ROTATE_GAP px from captured and measured widths */
  rotating: number[];
  /** widths the live page is probed at during the capture: the grid and the boundaries */
  live: number[];
  /** every width the output is checked at (no captured width: those are measured as such) */
  all: number[];
}

export const GRID_MIN = 320;
export const GRID_MAX = 2560;
export const GRID_STEP_NARROW = 24;
export const GRID_STEP_WIDE = 48;
export const ROTATING = 6;
export const ROTATE_GAP = 8;

/** FNV-1a → mulberry32: the same seed gives the same widths. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where the output is checked besides the captured widths: a dense grid (no width between two checks is wider than a
 * step), both sides of every variant boundary, and a few widths that change with every measurement of a run (`seed`:
 * the run id and how many measurements it had), so nothing can be fitted to the widths that are checked.
 */
export function sweepPlan(o: {
  captured: number[];
  /** widths the capture walked the page at (alt walks) besides the captured ones */
  measured?: number[];
  /** variants' minWidth (the first width each applies from) */
  boundaries?: number[];
  seed?: string;
}): SweepPlan {
  const captured = new Set(o.captured.map((w) => Math.round(w)));
  const measured = new Set((o.measured ?? []).map((w) => Math.round(w)));
  const top = Math.max(GRID_MIN, ...captured, ...measured);
  const grid: number[] = [];
  for (let w = GRID_MIN; w <= top; w += w < 1024 ? GRID_STEP_NARROW : GRID_STEP_WIDE) grid.push(w);
  if (grid[grid.length - 1] !== top) grid.push(top);
  grid.push(GRID_MAX);
  const boundaries = [
    ...new Set(
      (o.boundaries ?? []).filter((b) => b > GRID_MIN).flatMap((b) => [Math.round(b) - 1, Math.round(b)]),
    ),
  ];
  const fixed = new Set([...grid, ...boundaries].filter((w) => !captured.has(w)));
  const taken = [...captured, ...measured];
  const rotating: number[] = [];
  const next = rng(o.seed ?? "");
  for (let tries = 0; rotating.length < ROTATING && tries < 2000; tries++) {
    const w = Math.round(GRID_MIN + next() * (top - GRID_MIN));
    if (taken.some((t) => Math.abs(t - w) < ROTATE_GAP) || fixed.has(w) || rotating.includes(w)) continue;
    rotating.push(w);
  }
  const sort = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);
  const live = sort([...fixed]);
  return {
    grid: sort(grid.filter((w) => !captured.has(w))),
    boundaries: sort(boundaries.filter((w) => !captured.has(w))),
    rotating: sort(rotating),
    live,
    all: sort([...live, ...rotating]),
  };
}
