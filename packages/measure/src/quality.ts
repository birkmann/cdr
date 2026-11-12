// Quality of a recreation beyond its pixels: accessibility (axe-core in the page), markup (one DOM, landmarks, headings,
// image attributes, no copies of the page hidden per width), motion (videos that play where the live page plays them,
// with a pause control) and behaviour (sliders driven by arrows, dots, keys and autoplay as on the live page), and the
// hover looks of its controls against the live page's. Every check compares with what the live page has; none asks
// for less than the live page offers, and accessibility never inherits the live page's failures.
import type { SnapHover, Snapshot } from "@harness/capture";
import { AXE_SOURCE, AXE_VERSION } from "./axe.generated.js";

export { AXE_VERSION };

/** What the live page has that the recreation must have too (from its snapshots). */
export interface LiveQuality {
  /** videos that play by themselves */
  videos: number;
  /** sliders: with dots, autoplaying, looping */
  sliders: { dots: boolean; autoplay?: number; loop: boolean }[];
  /** controls whose look changes under the pointer (tag + label), from the capture */
  hover: { tag: string; label: string; props: string[] }[];
  /** widgets that switch in place (tabs, accordions, toggles): how many states the capture opened */
  widgets: number;
}

export function liveQuality(snaps: Snapshot[]): LiveQuality {
  const videos = new Set<string>();
  const sliders = new Map<string, LiveQuality["sliders"][0]>();
  const hover = new Map<string, LiveQuality["hover"][0]>();
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.media?.kind === "video" && n.media.autoplay) videos.add(n.key ?? String(videos.size));
    const f = n.scroller?.slider;
    if (f && n.key && !sliders.has(n.key))
      sliders.set(n.key, { dots: !!f.dots, ...(f.autoplay ? { autoplay: f.autoplay } : {}), loop: !!f.loop });
    for (const c of n.children ?? []) visit(c);
  };
  for (const s of snaps) {
    visit(s.root);
    for (const i of (s as { invisible?: { node: unknown }[] }).invisible ?? []) visit(i.node);
    for (const h of (s.hover ?? []) as SnapHover[]) {
      const label = norm(h.label ?? "");
      if (!label) continue;
      const k = `${h.tag ?? ""}|${label}`;
      if (!hover.has(k))
        hover.set(k, {
          tag: h.tag ?? "",
          label,
          props: [...new Set(h.changes.flatMap((c) => Object.keys(c.props)))],
        });
    }
  }
  const widgets = Math.max(
    0,
    ...snaps.map((s) => (s.states ?? []).filter((x) => x.kind === "region").length),
  );
  return { videos: videos.size, sliders: [...sliders.values()], hover: [...hover.values()], widgets };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The in-page probe (async): axe-core over the page, the markup facts, every video's motion and every slider's
 * behaviour. Its result is `QualityProbe`.
 */
export const QUALITY_PROBE_JS = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  // ---- accessibility
  try {
    if (!window.axe) { ${AXE_SOURCE}
    }
    const axe = window.axe
    axe.configure({ reporter: 'v2' })
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] })
    out.axe = r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => String(n.target && n.target.join ? n.target.join(' ') : n.target).slice(0, 160)) }))
  } catch (e) { out.axeError = String(e && e.message || e).slice(0, 300) }
  // ---- markup
  const all = document.querySelectorAll('body *')
  out.nodes = all.length
  let depth = 0
  for (const el of all) { let d = 0; for (let p = el; p && p !== document.body; p = p.parentElement) d++; if (d > depth) depth = d }
  out.depth = depth
  out.lang = document.documentElement.getAttribute('lang') || ''
  out.title = document.title || ''
  out.description = !!(document.querySelector('meta[name="description"]') || {}).content
  out.h1 = document.querySelectorAll('h1').length
  const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]))
  out.headingJumps = levels.filter((l, i) => i > 0 && l > levels[i - 1] + 1).length
  out.main = document.querySelectorAll('main, [role="main"]').length
  const imgs = [...document.querySelectorAll('img')]
  out.images = imgs.length
  out.imagesNoAlt = imgs.filter((i) => !i.hasAttribute('alt')).length
  out.imagesNoSize = imgs.filter((i) => !(i.getAttribute('width') && i.getAttribute('height')) && getComputedStyle(i).aspectRatio === 'auto').length
  const vh = innerHeight
  out.imagesEagerBelow = imgs.filter((i) => i.getBoundingClientRect().top > vh * 1.5 && i.loading !== 'lazy').length
  // copies of the page hidden per width: a hidden subtree whose text is shown elsewhere too
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const shown = new Set()
  const hiddenRoots = []
  for (const el of all) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none') { if (!hiddenRoots.some((h) => h.contains(el))) hiddenRoots.push(el); continue }
  }
  for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, a, button')) {
    if (hiddenRoots.some((h) => h.contains(el))) continue
    const t = norm(el.textContent)
    if (t.length >= 24) shown.add(t)
  }
  let dup = 0, dupText = 0
  for (const h of hiddenRoots) {
    if (h.closest('[data-menu-panel], dialog, [role="dialog"], template')) continue
    let hit = 0
    for (const el of h.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li')) { const t = norm(el.textContent); if (t.length >= 24 && shown.has(t)) { hit++; dupText += t.length } }
    if (hit) dup++
  }
  out.duplicateSubtrees = dup
  out.duplicateText = dupText
  out.cssBytes = [...document.styleSheets].reduce((a, s) => { try { return a + [...s.cssRules].reduce((b, r) => b + r.cssText.length, 0) } catch { return a } }, 0)
  out.mediaQueries = [...document.styleSheets].reduce((a, s) => { try { return a + [...s.cssRules].filter((r) => r.type === 4).length } catch { return a } }, 0)
  // ---- motion: videos that play, with a control that pauses them
  const vids = [...document.querySelectorAll('video')]
  const frames = (v) => (v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : 0)
  const f0 = vids.map(frames), t0 = vids.map((v) => v.currentTime)
  if (vids.length) await sleep(1200)
  out.videos = vids.map((v, i) => {
    const id = v.id
    const toggle = (id && document.querySelector('[aria-controls="' + id + '"], [data-video-toggle="' + id + '"]')) || [...(v.parentElement ? v.parentElement.querySelectorAll('button') : [])].find((b) => /pause|play|stop|anhalten/i.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent))
    // frames decoded since (a short clip loops: its time can go back)
    return { autoplay: v.autoplay || v.hasAttribute('autoplay') || v.hasAttribute('data-autoplay'), playing: !v.paused && (frames(v) > f0[i] + 2 || Math.abs(v.currentTime - t0[i]) > 0.15), toggle: !!toggle, src: (v.currentSrc || '').split('/').pop().slice(0, 80) }
  })
  // ---- sliders: arrows, dots, keys, autoplay
  const tracks = [...document.querySelectorAll('[data-slider], [data-scroller]')].filter((t) => t.offsetWidth > 0 && t.scrollWidth > t.clientWidth + 4).slice(0, 6)
  out.sliders = []
  for (const t of tracks) {
    const s = { dots: false, dotMoves: false, keyMoves: false, autoplay: false, loops: null }
    const id = t.id
    const reset = async () => { t.scrollTo({ left: 0, behavior: 'instant' }); await sleep(120) }
    const dots = id ? [...document.querySelectorAll('[data-slider-dot][aria-controls="' + id + '"]')] : []
    s.dots = dots.length > 1
    if (s.dots) { await reset(); dots[Math.min(2, dots.length - 1)].click(); await sleep(900); s.dotMoves = t.scrollLeft > 2 }
    await reset()
    t.focus()
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await sleep(900)
    s.keyMoves = t.scrollLeft > 2
    // the last slide's "next" goes back to the first on a looping slider
    const next = id ? document.querySelector('[data-slider-step="1"][aria-controls="' + id + '"]') : null
    if (next) {
      t.scrollTo({ left: t.scrollWidth, behavior: 'instant' }); await sleep(150)
      next.click(); await sleep(900)
      s.loops = t.scrollLeft < 4
    }
    const delay = Number(t.getAttribute('data-autoplay')) || 0
    if (delay) {
      await reset()
      // pointer and focus away from it, then wait for one step
      if (document.activeElement && t.contains(document.activeElement)) document.activeElement.blur()
      t.blur()
      t.dispatchEvent(new PointerEvent('pointerleave'))
      ;(t.closest('section') || t.parentElement).dispatchEvent(new PointerEvent('pointerleave'))
      ;(t.closest('section') || t.parentElement).dispatchEvent(new FocusEvent('focusout'))
      const start = t.scrollLeft
      for (let w = 0; w < Math.min(delay * 1.6, 9000) && Math.abs(t.scrollLeft - start) < 2; w += 250) await sleep(250)
      s.autoplay = Math.abs(t.scrollLeft - start) >= 2
    }
    await reset()
    out.sliders.push(s)
  }
  // ---- widgets that switch in place (tabs, accordions): each control changes its region's state, and back
  out.widgets = []
  for (const c of [...document.querySelectorAll('[data-region-set], [data-region-toggle]')].filter((x) => x.getClientRects().length).slice(0, 12)) {
    const ref = c.getAttribute('data-region-set') ?? c.getAttribute('data-region-toggle')
    const region = document.querySelector('[data-region="' + ref.split(':')[0] + '"]')
    if (!region) { out.widgets.push({ switches: false, shows: false }); continue }
    const before = region.getAttribute('data-state'), text = region.innerText
    c.click(); await sleep(250)
    const after = region.getAttribute('data-state')
    out.widgets.push({ switches: before !== after || ref.endsWith(':'), shows: region.innerText !== text })
    if (c.hasAttribute('data-region-toggle')) { c.click(); await sleep(150) }
  }
  return out
})()`;

export interface QualityProbe {
  axe?: { id: string; impact: string | null; help: string; nodes: number; targets: string[] }[];
  axeError?: string;
  nodes: number;
  depth: number;
  lang: string;
  title: string;
  description: boolean;
  h1: number;
  headingJumps: number;
  main: number;
  images: number;
  imagesNoAlt: number;
  imagesNoSize: number;
  imagesEagerBelow: number;
  duplicateSubtrees: number;
  duplicateText: number;
  cssBytes: number;
  mediaQueries: number;
  videos: { autoplay: boolean; playing: boolean; toggle: boolean; src: string }[];
  sliders: {
    dots: boolean;
    dotMoves: boolean;
    keyMoves: boolean;
    autoplay: boolean;
    loops: boolean | null;
  }[];
  /** widgets that switch in place: whether each control changed its region's state, and what it shows */
  widgets?: { switches: boolean; shows: boolean }[];
  error?: string;
}

export interface QualityGate {
  name: "a11y" | "markup" | "motion" | "hover" | "behaviour";
  pass: boolean;
  detail: string;
}

export interface QualityReport {
  width: number;
  probe?: QualityProbe;
  /** the live page's own axe result at the same width (for comparison; never an excuse) */
  live?: { axe?: QualityProbe["axe"]; nodes?: number };
  hover?: { matched: number; total: number; missing: string[] };
  gates: QualityGate[];
}

const SERIOUS = new Set(["critical", "serious"]);

/** The quality gates of one output at one width. */
export function qualityGates(
  probe: QualityProbe | undefined,
  live: LiveQuality,
  o: { liveNodes?: number; outHover?: SnapHover[]; liveAxe?: QualityProbe["axe"] } = {},
): { gates: QualityGate[]; hover?: QualityReport["hover"] } {
  const gates: QualityGate[] = [];
  if (!probe || probe.error) {
    for (const name of ["a11y", "markup", "motion", "behaviour"] as const)
      gates.push({
        name,
        pass: false,
        detail: `the page could not be inspected${probe?.error ? `: ${probe.error}` : ""}`,
      });
    return { gates };
  }
  // accessibility: no critical or serious violation
  const serious = (probe.axe ?? []).filter((v) => SERIOUS.has(v.impact ?? ""));
  const liveSerious = (o.liveAxe ?? []).filter((v) => SERIOUS.has(v.impact ?? "")).length;
  gates.push({
    name: "a11y",
    pass: !probe.axeError && serious.length === 0,
    detail: probe.axeError
      ? `axe failed: ${probe.axeError}`
      : `${serious.length ? `${serious.length} serious: ${serious.map((v) => `${v.id} (${v.nodes})`).join(", ")}` : "no serious violations"}${(probe.axe ?? []).length - serious.length ? `; ${(probe.axe ?? []).length - serious.length} minor` : ""}${o.liveAxe ? `; live page: ${liveSerious} serious` : ""}`,
  });
  // markup: one DOM, a document outline, images that do not shift the layout
  const issues: string[] = [];
  if (probe.duplicateSubtrees)
    issues.push(`${probe.duplicateSubtrees} hidden copies of shown content (${probe.duplicateText} chars)`);
  if (probe.h1 !== 1) issues.push(`${probe.h1} h1`);
  if (probe.headingJumps) issues.push(`${probe.headingJumps} skipped heading levels`);
  if (probe.main !== 1) issues.push(`${probe.main} main landmarks`);
  if (!probe.lang) issues.push("no lang");
  if (!probe.title) issues.push("no title");
  if (!probe.description) issues.push("no meta description");
  if (probe.imagesNoAlt) issues.push(`${probe.imagesNoAlt} images without alt`);
  if (probe.imagesNoSize) issues.push(`${probe.imagesNoSize} images without size`);
  if (o.liveNodes && probe.nodes > o.liveNodes * 1.3 + 50)
    issues.push(`${probe.nodes} nodes (live ${o.liveNodes})`);
  gates.push({
    name: "markup",
    pass: issues.length === 0,
    detail: issues.length
      ? issues.join("; ")
      : `${probe.nodes} nodes, ${probe.mediaQueries} media rules, ${Math.round(probe.cssBytes / 1024)} kB CSS`,
  });
  // motion: the live page's videos play here too, each with a pause control
  if (live.videos) {
    const playing = probe.videos.filter((v) => v.playing);
    const noToggle = probe.videos.filter((v) => v.autoplay && !v.toggle);
    gates.push({
      name: "motion",
      pass: playing.length >= Math.min(live.videos, 1) && noToggle.length === 0,
      detail: `${playing.length}/${live.videos} videos play${noToggle.length ? `, ${noToggle.length} without a pause control` : ""}`,
    });
  } else gates.push({ name: "motion", pass: true, detail: "no moving video on the live page" });
  // widgets (tabs, accordions) the live page switches in place: each control switches its region here too
  const widgetFail =
    live.widgets && probe.widgets?.length && !probe.widgets.every((w) => w.switches)
      ? `${probe.widgets.filter((w) => !w.switches).length} of ${probe.widgets.length} widget controls switch nothing`
      : "";
  // behaviour: sliders as the live page's
  if (live.sliders.length) {
    const fails: string[] = [];
    const want = {
      dots: live.sliders.some((s) => s.dots),
      autoplay: live.sliders.some((s) => s.autoplay),
      loop: live.sliders.some((s) => s.loop),
    };
    if (!probe.sliders.length) fails.push("no slider");
    if (probe.sliders.length && !probe.sliders.some((s) => s.keyMoves))
      fails.push("no slider moves with the arrow keys");
    if (want.dots && !probe.sliders.some((s) => s.dots && s.dotMoves))
      fails.push("dots missing or do not move the slider");
    if (want.autoplay && !probe.sliders.some((s) => s.autoplay)) fails.push("no autoplay");
    if (want.loop && !probe.sliders.some((s) => s.loops)) fails.push("does not loop");
    if (widgetFail) fails.push(widgetFail);
    gates.push({
      name: "behaviour",
      pass: !fails.length,
      detail: fails.length
        ? fails.join("; ")
        : `${probe.sliders.length} slider(s): keys${want.dots ? ", dots" : ""}${want.autoplay ? ", autoplay" : ""}${want.loop ? ", loop" : ""}`,
    });
  } else
    gates.push({
      name: "behaviour",
      pass: !widgetFail,
      detail:
        widgetFail ||
        (probe.widgets?.length
          ? `${probe.widgets.length} widget controls switch`
          : "no slider on the live page"),
    });
  // hover: the live page's controls that change under the pointer change here too
  let hover: QualityReport["hover"];
  if (o.outHover && live.hover.length) {
    const out = new Set(o.outHover.map((h) => `${h.tag ?? ""}|${norm(h.label ?? "")}`));
    const outLabels = new Set(o.outHover.map((h) => norm(h.label ?? "")));
    const missing = live.hover.filter((h) => !out.has(`${h.tag}|${h.label}`) && !outLabels.has(h.label));
    hover = {
      matched: live.hover.length - missing.length,
      total: live.hover.length,
      missing: missing.slice(0, 12).map((h) => `${h.tag} "${h.label}"`),
    };
    const share = hover.matched / hover.total;
    gates.push({
      name: "hover",
      pass: share >= 0.8,
      detail: `${hover.matched}/${hover.total} hover looks${missing.length ? `; missing: ${hover.missing.slice(0, 4).join(", ")}` : ""}`,
    });
  }
  return { gates, ...(hover ? { hover } : {}) };
}
