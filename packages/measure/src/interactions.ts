// Interaction checks on the recreated output: the menu opens (and its drill-down
// levels swap in), slider arrows move their track, the pinned header stays. Each check is compared with what the
// capture found on the live page at that width, so a check passes or fails "as live": a menu the live page has must
// open, a page without one needs none.

/** In-page probe for the static output (run per width by the shot driver: `ShotOptions.probe`). */
export const OUTPUT_PROBE_JS = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  const bp = [...document.querySelectorAll('[data-bp]')].find(visible) || document
  const out = { menu: null, submenu: null, carousels: [], pinned: null }
  // menu: the visible opener in the shown variant
  const opener = [...bp.querySelectorAll('[data-open-overlay]')].find(visible)
  if (opener) {
    const id = opener.getAttribute('data-open-overlay')
    opener.click()
    await sleep(500)
    const o = bp.querySelector('[data-overlay="' + id + '"]')
    out.menu = { opened: !!(o && o.hasAttribute('data-open') && visible(o.querySelector('[data-overlay-panel]') || o)) }
    const entry = o && [...o.querySelectorAll('[data-swap-overlay]')].find(visible)
    if (entry) {
      const sid = entry.getAttribute('data-swap-overlay')
      entry.click()
      await sleep(500)
      const so = bp.querySelector('[data-overlay="' + sid + '"]')
      out.submenu = { opened: !!(so && so.hasAttribute('data-open')) }
    }
    for (const x of document.querySelectorAll('[data-overlay][data-open]')) { x.removeAttribute('data-open'); x.hidden = true }
    document.documentElement.removeAttribute('data-scroll-lock')
  }
  // the modern runtime's menu: [data-menu-open] opens :root[data-menu] and shows its [data-menu-panel]
  if (!out.menu) {
    const mo = [...document.querySelectorAll('[data-menu-open="menu"]')].find(visible)
    if (mo) {
      mo.click()
      await sleep(500)
      const panel = document.querySelector('[data-menu-panel="menu"]') || document.querySelector('[data-menu-panel]')
      out.menu = { opened: document.documentElement.hasAttribute('data-menu') && visible(panel) }
      const sub = panel && [...panel.querySelectorAll('[data-menu-open]')].find((x) => visible(x) && x.getAttribute('data-menu-open') !== 'menu')
      if (sub) {
        const name = sub.getAttribute('data-menu-open')
        sub.click()
        await sleep(500)
        out.submenu = { opened: document.documentElement.getAttribute('data-menu') === name }
      }
      document.documentElement.removeAttribute('data-menu')
      await sleep(100)
    }
  }
  // the modern runtime's sliders: each visible "next" step moves the track it controls
  for (const a of [...document.querySelectorAll('[data-slider-step="1"]')].filter(visible).slice(0, 6)) {
    const track = document.getElementById(a.getAttribute('aria-controls') || '')
    if (!track) { out.carousels.push({ moved: false, reason: 'no track' }); continue }
    track.scrollTo({ left: 0, behavior: 'instant' })
    await sleep(100)
    const before = track.scrollLeft
    a.click()
    await sleep(900)
    out.carousels.push({ moved: track.scrollLeft > before + 1 })
    track.scrollTo({ left: 0, behavior: 'instant' })
  }
  // sliders: each visible "next" arrow moves its track
  for (const a of [...bp.querySelectorAll('[data-scroll-by="next"]')].filter(visible).slice(0, 6)) {
    const scope = a.closest('[data-scroller]') ? null : a.parentElement
    let track = null
    for (let p = a.parentElement; p && !track; p = p.parentElement) track = p.querySelector('[data-scroller]')
    if (!track) { out.carousels.push({ moved: false, reason: 'no track' }); continue }
    track.scrollTo({ left: 0, behavior: 'instant' })
    await sleep(100)
    const before = track.scrollLeft
    a.click()
    await sleep(700)
    out.carousels.push({ moved: track.scrollLeft > before + 1 })
    track.scrollTo({ left: 0, behavior: 'instant' })
  }
  // pinned header: the top bar stays at the top after scrolling
  const top = [...bp.querySelectorAll('*')].find((el) => { if (el.closest('[data-scroll-shift]')) return false; const cs = getComputedStyle(el); return (cs.position === 'sticky' || cs.position === 'fixed') && el.getBoundingClientRect().top <= 1 && visible(el) && el.getBoundingClientRect().width >= innerWidth * 0.6 })
  if (top) {
    window.scrollTo({ top: Math.min(600, document.documentElement.scrollHeight - innerHeight), behavior: 'instant' })
    await sleep(200)
    out.pinned = { stays: Math.abs(top.getBoundingClientRect().top) <= 2 }
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  return out
})()`;

/** What the live page has at one width (from the capture). */
export interface LiveExpectations {
  menu: boolean;
  submenu: boolean;
  carousels: number;
  pinnedHeader: boolean;
}

export type CheckResult = "pass" | "fail" | "as-live";

export interface InteractionCheck {
  name: "menu" | "submenu" | "carousel" | "pinned";
  result: CheckResult;
  detail?: string;
}

/** Output probe result vs. the live page's expectations → checks (absent on both sides: "as-live"). */
export function interactionChecks(probe: any, live: LiveExpectations): InteractionCheck[] {
  const out: InteractionCheck[] = [];
  const p = probe && typeof probe === "object" && !probe.error ? probe : {};
  if (live.menu)
    out.push(
      p.menu?.opened
        ? { name: "menu", result: "pass" }
        : {
            name: "menu",
            result: "fail",
            detail: p.menu ? "the menu button opened nothing" : "no menu button",
          },
    );
  else if (p.menu)
    out.push({ name: "menu", result: "as-live", detail: "a menu the live page did not show here" });
  if (live.submenu)
    out.push(
      p.submenu?.opened
        ? { name: "submenu", result: "pass" }
        : { name: "submenu", result: "fail", detail: "the drill-down level did not open" },
    );
  if (live.carousels > 0) {
    const moved = (p.carousels ?? []).filter((c: any) => c.moved).length;
    out.push(
      moved > 0
        ? {
            name: "carousel",
            result: "pass",
            detail: `${moved} of ${(p.carousels ?? []).length} sliders moved`,
          }
        : { name: "carousel", result: "fail", detail: "no slider arrow moved its track" },
    );
  }
  if (live.pinnedHeader)
    out.push(
      p.pinned?.stays
        ? { name: "pinned", result: "pass" }
        : { name: "pinned", result: "fail", detail: "the header does not stay at the top" },
    );
  if (probe?.error) out.push({ name: "menu", result: "fail", detail: `probe failed: ${probe.error}` });
  return out;
}

/** What the live page has at a width, read from the capture's snapshot (states, carousels, sticky boxes). */
export function liveExpectations(snapshot: any): LiveExpectations {
  const states: any[] = Array.isArray(snapshot?.states) ? snapshot.states : [];
  let carousels = 0;
  let pinnedHeader = false;
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.carousel && n.carousel.dir === 1) carousels++;
    const pos = n.layout?.position ?? n.style?.position;
    const pageW = Number(snapshot?.page?.width) || 1;
    const viewH = Number(snapshot?.viewport?.height) || 1000;
    const x = Number(n.rect?.x) || 0,
      w = Number(n.rect?.w) || 0,
      h = Number(n.rect?.h) || 0;
    if (
      (pos === "sticky" || pos === "fixed") &&
      !n.scrollShift &&
      (Number(n.rect?.y) || 0) <= 1 &&
      w >= pageW * 0.6 &&
      // a bar on screen: an off-canvas drawer (parked beside the page) or a full-screen panel is no header
      x < pageW &&
      x + w > 0 &&
      h <= viewH * 0.5
    )
      pinnedHeader = true;
    for (const c of Array.isArray(n.children) ? n.children : []) visit(c);
  };
  visit(snapshot?.root);
  return {
    menu: states.some((s) => s.kind === "menu"),
    submenu: states.some((s) => s.kind === "submenu"),
    carousels,
    pinnedHeader,
  };
}
