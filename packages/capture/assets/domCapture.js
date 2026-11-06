// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
/*
 * DOM capture for the URL importer (importers/url). ONE script shared by every capture path: the Node / Playwright
 * driver (scripts/import-url.mjs) and fig-server's headless-Chrome endpoint (crates/fig-server/src/capture.rs, via
 * include_str!) both evaluate `(<this file>)(options)` inside the page and get a Snapshot (importers/url/snapshot.ts).
 * It runs in the browser sandbox only. Nothing here is executed by the app.
 *
 *   prepare  → dismiss the cookie / consent banner, scroll through the page for lazy content, back to the top,
 *              wait for images + webfonts
 *   pseudo   → ::before / ::after with content are materialised as real spans (computed style copied) so the
 *              walker sees their boxes; the pseudos themselves are switched off
 *   walk     → flattened tree (open shadow roots + slots): every painted box with its page rect and the computed
 *              styles that matter, text runs split into rendered lines, images, inline SVG (computed paint inlined),
 *              form controls; video / canvas / iframe / unresolvable SVG become `raster` boxes the driver screenshots
 * Options: { prepare = true, freeze = true, maxScroll = 30000, settleMs = 600, stableMs = 6000, viewportHeight = innerHeight,
 *            fixedToPageBottom = false, menu = false, state = false, mode }
 *   states   → phone / tablet: `menu` finds the navigation toggle before the walk (→ `marks.trigger`); the driver then
 *              calls mode 'menu-open' (page thawed, returns the point to tap), taps, mode 'menu-settle' (motion, panel,
 *              close button tagged) and walks again with `{ prepare: false, state: true }` (→ `marks.panel` / `close`)
 *   brand    → `{ brand: true, requested, css }` adds `brand` (BrandCapture, brandmd/types.ts: controls with hover /
 *              focus / active from the CSSOM, custom properties, @media widths, logo / icons, images, icons, bands,
 *              grids, font files, overlay, texts); mode 'sheets' first lists the cross-origin sheets whose text the
 *              driver passes back as `css` ([{ href, text }])
 */
/* global window, document, getComputedStyle, XMLSerializer, location, setTimeout, URL, DocumentTimeline, Event */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
;(async function figCapture(opts) {
  opts = opts || {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const VH = opts.viewportHeight || window.innerHeight
  const VW = document.documentElement.clientWidth || window.innerWidth
  const round = (n) => Math.round(n * 100) / 100

  /* ------------------------------------------------------------------ prepare */

  function* deepElements(root) {
    const stack = [root]
    while (stack.length) {
      const n = stack.pop()
      if (n.nodeType === 1) yield n
      if (n.shadowRoot) stack.push(n.shadowRoot)
      const kids = n.children || []
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    }
  }
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  // Didomi, OneTrust, Cookiebot, Usercentrics (v2 + v3), consentmanager, TrustArc, Sourcepoint, Borlabs
  const CONSENT_IDS = ['#didomi-notice-agree-button', '#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#accept-all-cookies', '[data-testid="uc-accept-all-button"]', '.uc-accept-button', '.cmpboxbtnyes', '#uc-btn-accept-banner', '#truste-consent-button', '.truste-button2', '.sp_choice_type_11', '[data-cookie-accept-all]', '#BorlabsCookieBox a._brlbs-btn-accept-all']
  // whole label only (anchored), so "Ablehnen", "Einstellungen", "Reject and continue" never match
  const ACCEPT = /^(alle\s+(cookies\s+)?(akzeptieren|annehmen|zulassen|erlauben)|(cookies\s+)?akzeptieren|zustimmen|alle zustimmen|einverstanden|accept( all)?( cookies)?|allow all( cookies)?|agree|i agree|ok, verstanden|akzeptieren und schließen|(einwilligen|zustimmen|akzeptieren)\s+und\s+weiter|(accept|agree)\s+and\s+(continue|close))$/i
  async function dismissConsent() {
    for (let round = 0; round < 3; round++) {
      let clicked = false
      for (const sel of CONSENT_IDS) {
        for (const el of deepElements(document)) {
          if (el.matches && el.matches(sel) && visible(el)) { el.click(); clicked = true; break }
        }
      }
      if (!clicked) {
        const cands = []
        for (const el of deepElements(document)) {
          if (!/^(button|a)$/i.test(el.localName) && el.getAttribute('role') !== 'button') continue
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (t.length < 60 && ACCEPT.test(t) && visible(el)) cands.push({ el, all: /alle|all/i.test(t) ? 0 : 1 })
        }
        cands.sort((a, b) => a.all - b.all)
        if (cands[0]) { cands[0].el.click(); clicked = true }
      }
      if (!clicked) break
      await sleep(900)
    }
  }

  // region / language suggestion dialogs ("Sie scheinen sich in Deutschland zu befinden … [Abbrechen] [Wechseln]"):
  // the page as the visitor gets it once they declined — never the button that switches to another site
  const REGION_RE = /\b(region|regions|land|länder|standort|sprache|country|countries|location|language|locale)\b|lokale[nr]? (website|seite)|local (site|website)|ihre aktuelle region|your (current )?region/i
  const DECLINE_RE = /^\s*(×|✕|✖|x|close|schließen|schliessen|dialog schließen|close dialog|abbrechen|cancel|stay|bleiben|hier bleiben|stay here|no,? thanks|nein,? danke|not now|nicht jetzt|dismiss)\s*$/i
  const SWITCH_RE = /wechseln|switch|change|ändern|go to|zur .*seite|visit|continue to|weiter zu/i
  /**
   * A shown modal (role=dialog / aria-modal, or a fixed box over a full-viewport dim layer) about the visitor's region,
   * country or language: closed with its ×, Close, Abbrechen, Cancel, Stay or Bleiben control (never Switch / Wechseln
   * / Change: those leave the page). → how many were closed.
   */
  async function dismissRegionDialogs() {
    let closed = 0
    for (let round = 0; round < 2; round++) {
      const vw = window.innerWidth, vh = window.innerHeight
      const dims = []
      for (const el of deepElements(document.body)) {
        const cs = getComputedStyle(el)
        if (cs.position !== 'fixed' || !visible(el)) continue
        const r = el.getBoundingClientRect()
        if (r.width >= vw * 0.95 && r.height >= vh * 0.95 && !(el.innerText || '').trim()) dims.push(el)
      }
      const dialogs = []
      for (const el of deepElements(document.body)) {
        if (!visible(el)) continue
        const modal = el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog' || el.getAttribute('aria-modal') === 'true' || el.localName === 'dialog'
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        const floating = (cs.position === 'fixed' || cs.position === 'absolute') && dims.length > 0 && r.width < vw * 0.95 && r.height < vh * 0.95 && r.width > 120 && r.height > 60
        if (!modal && !floating) continue
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim()
        if (text.length < 8 || text.length > 600 || !REGION_RE.test(text)) continue
        if (dialogs.some((d) => d.contains(el))) continue
        dialogs.push(el)
      }
      if (!dialogs.length) break
      for (const d of dialogs) {
        const controls = [...deepElements(d)].filter((c) => /^(button|a)$/i.test(c.localName) || c.getAttribute('role') === 'button')
        const label = (c) => `${c.getAttribute('aria-label') || ''} ${c.getAttribute('title') || ''} ${(c.innerText || c.textContent || '').trim()}`.trim()
        const decline = controls.find((c) => visible(c) && !SWITCH_RE.test(label(c)) && (DECLINE_RE.test((c.innerText || c.textContent || '').trim()) || DECLINE_RE.test(c.getAttribute('aria-label') || '') || DECLINE_RE.test(c.getAttribute('title') || '') || /close|schlie(ß|ss)en|dismiss/i.test(`${c.getAttribute('aria-label') || ''} ${c.getAttribute('title') || ''} ${classOf(c)}`)))
        if (decline) { decline.click(); closed++ } else document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }
      await sleep(700)
    }
    return closed
  }

  /* ------------------------------------------------------------------ states (navigation menu) */

  // hamburger / menu toggles (labels, class names) in the languages the importer meets; controls that are never it
  const MENU_RE = /men[uüú]|navigation|navigatie|navegaci|hamburger|burger|off-?canvas|nav-?(toggle|trigger|open|button|btn|icon)|(toggle|open|mobile)-?nav|drawer/i
  const NOT_MENU_RE = /such|search|cart|warenkorb|basket|einkaufs|log-?in|anmelden|account|konto|profil|\buser\b|benutzer|nutzer|sprache|language|barrierefrei|accessib|a11y|schlie(ß|ss)en|close|share|teilen|merkliste|wunschliste|wishlist|filter|skip|springen|zum inhalt/i
  // the whole label is the menu ("Menü", "Hauptmenü öffnen", "Open navigation"): the site navigation, not a sub-menu
  const MENU_ONLY_RE = /^((haupt|main|site)?\s*-?\s*(men[uüú]|navigation)(\s+(öffnen|anzeigen|open|toggle|einblenden))?|(open|toggle|show)\s+(the\s+)?(main\s+)?(menu|navigation))$/i
  /** three thin horizontal bars stacked (a hamburger drawn with boxes, as many sites do instead of an icon) */
  function hamburgerBars(el) {
    const bars = []
    for (const c of el.querySelectorAll('*')) { const r = c.getBoundingClientRect(); if (r.width >= 12 && r.width <= 40 && r.height > 0 && r.height <= 4) bars.push(r) }
    return bars.length >= 3 && bars.length <= 6 && new Set(bars.map((b) => Math.round(b.top))).size >= 3
  }
  const MAIN_RE = /haupt|main|primary|global|seiten|site/i
  const CLOSE_RE = /schlie(ß|ss)en|close|fermer|cerrar|chiudi|sluiten|zamknij|^\s*[×✕✖x]\s*$/i
  const nextFrame = () => new Promise((r) => window.requestAnimationFrame(() => r()))
  /** a is b or contains it (across shadow roots) */
  const inside = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false }
  const classOf = (el) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '')
  function labelOf(el) {
    const by = el.getAttribute('aria-labelledby')
    const ref = by && by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim()
    const inner = el.querySelector && el.querySelector('[aria-label], title, img[alt]')
    const t = el.getAttribute('aria-label') || ref || el.getAttribute('title') || (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() || (inner ? inner.getAttribute('aria-label') || inner.getAttribute('alt') || inner.textContent : '') || ''
    return t.replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  /** visible part (px²) of the box inside the viewport, 0 when not painted */
  function shownArea(el) {
    const r = el.getBoundingClientRect()
    const w = Math.min(r.right, VW) - Math.max(r.left, 0), h = Math.min(r.bottom, VH) - Math.max(r.top, 0)
    if (w < 2 || h < 2) return 0
    if (el.checkVisibility ? !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : !visible(el)) return 0
    return w * h
  }
  /**
   * The control that opens the site navigation on a phone / tablet layout: a visible button-like box near the top whose
   * label / class reads "menu" (or that toggles an aria-controls target full of links), never search / cart / login.
   */
  function findMenuTrigger() {
    let best = null, bestScore = 0
    for (const el of deepElements(document)) {
      const tag = el.localName, role = el.getAttribute('role')
      if (!(tag === 'button' || tag === 'summary' || role === 'button' || el.hasAttribute('aria-expanded') || (tag === 'a' && el.hasAttribute('href')) || (tag === 'label' && el.htmlFor))) continue
      const r = el.getBoundingClientRect()
      if (r.width < 12 || r.height < 12 || r.width > VW * 0.6 || r.height > 160 || r.top > 160 || r.bottom < 4 || r.left < -1 || r.right > VW + 1) continue
      if (!shownArea(el)) continue
      const label = labelOf(el)
      if (NOT_MENU_RE.test(label)) continue
      const names = `${classOf(el)} ${el.id} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('aria-controls') || ''} ${el.getAttribute('data-target') || ''}`
      const ctl = el.getAttribute('aria-controls') && el.getRootNode().getElementById?.(el.getAttribute('aria-controls'))
      const ctlNav = !!ctl && (MENU_RE.test(`${classOf(ctl)} ${ctl.id}`) || ctl.localName === 'nav' || ctl.querySelectorAll('a[href]').length >= 4)
      const words = MENU_RE.test(label) || MENU_RE.test(names) || ctlNav
      if (!words) continue
      const exp = el.getAttribute('aria-expanded')
      let s = 0
      if (MENU_RE.test(label)) s += 4
      if (MENU_ONLY_RE.test(label)) s += 3
      if (hamburgerBars(el)) s += 3
      if (MAIN_RE.test(label) || MAIN_RE.test(names)) s += 1
      if (/hamburger|burger/i.test(names)) s += 4
      else if (MENU_RE.test(names)) s += 2
      if (ctlNav) s += 2
      if (exp === 'false') s += el.hasAttribute('aria-controls') ? 3 : 2
      else if (exp === 'true') s -= 3
      if (/^(true|menu|dialog)$/.test(el.getAttribute('aria-haspopup') || '')) s += 1
      if (el.closest('header, [role="banner"], nav')) s += 1
      if (r.top < 120) s += 1
      if (r.width <= 80 && r.height <= 80) s += 1
      if (r.left < 90 || r.right > VW - 90) s += 1
      // the outermost of a row of header icons
      if (r.left < 30 || r.right > VW - 30) s += 0.5
      // a link to another page is a sitemap link, not a toggle
      const href = tag === 'a' ? (el.getAttribute('href') || '').trim() : ''
      if (href && !/^(#|javascript:)/i.test(href)) s -= 5
      if (s > bestScore) { best = { el, label }; bestScore = s }
    }
    return bestScore >= 5 ? best : null
  }
  /** undo the walk's page changes (frozen transitions, materialised pseudos, the interval stub): the page reacts again */
  function thaw() {
    for (const id of ['__figcap_freeze', '__figcap_solo']) document.getElementById(id)?.remove()
    const pseudos = []
    for (const el of deepElements(document)) {
      if (el.hasAttribute('data-figcap-pseudo')) pseudos.push(el)
      el.removeAttribute('data-figcap-b'); el.removeAttribute('data-figcap-a')
    }
    for (const el of pseudos) el.remove()
    if (window.__figcapSetInterval) window.setInterval = window.__figcapSetInterval
    // animation loops whose pending frame the freeze cancelled start again
    try { window.jQuery?.fx?.stop?.() } catch { /* no jQuery */ }
    try { window.gsap?.ticker?.wake?.() } catch { /* no GSAP */ }
  }
  /**
   * mode 'menu-open': the page as it was before the walk, the trigger (tagged by the main walk) scrolled to, and what
   * is visible / animating recorded for menu-settle. Returns the viewport point the driver taps, or `{ clicked }` when
   * the trigger is covered there or `click` is set (clicked in the page instead), or null.
   */
  async function menuOpen() {
    thaw()
    const t = window.__figcapMenuTrigger
    if (!t || !t.isConnected) return null
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    await nextFrame(); await nextFrame()
    await triggerSettled(t)
    const M = record(t)
    const r = (M.rect = t.getBoundingClientRect())
    const hit = (x, y) => { let h = document.elementFromPoint(x, y); while (h && h.shadowRoot) { const d = h.shadowRoot.elementFromPoint(x, y); if (!d || d === h) break; h = d } return h }
    // `click`: the driver's tap opened nothing (no touch / pointer handling there): a plain click on the element
    if (!opts.click) {
      for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy, h = hit(x, y)
        if (h && (inside(t, h) || inside(h, t))) return { x: round(x), y: round(y) }
      }
    }
    M.t0 = window.performance.now()
    t.click()
    return { clicked: true }
  }
  /**
   * Back at the top, a hide-on-scroll header (BVG: the nav bar slid up by a transform while the page was scrolled
   * down, e.g. by the widget states) is still sliding in: tapped now, the toggle sits off-screen, the menu is anchored
   * to that spot (over the header and its own toggle) and its close control is lost. Waits (≤ 1.5 s) until the
   * trigger stopped moving and nothing that moves it (it or an ancestor) still animates.
   */
  async function triggerSettled(t) {
    const t0 = window.performance.now()
    let last = '', still = 0
    while (window.performance.now() - t0 < 1500) {
      const r = t.getBoundingClientRect()
      const at = `${round(r.left)},${round(r.top)},${round(r.width)},${round(r.height)}`
      const moving = document.getAnimations ? document.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.target && inside(a.effect.target, t) && (() => { try { return Number.isFinite(a.effect.getComputedTiming().endTime) } catch { return false } })()) : false
      still = at === last && !moving ? still + 1 : 0
      if (still >= 3) return
      last = at
      await sleep(40)
    }
  }
  /**
   * What is visible / animating before `t` is activated, recorded for menu-settle (window.__figcapMenu): shown boxes,
   * running animations, the first frame of everything the activation restyles; links do not leave the page meanwhile.
   */
  function record(t, extra) {
    const pre = new Map()
    for (const el of deepElements(document.body)) { const a = shownArea(el); if (a) pre.set(el, a) }
    const M = (window.__figcapMenu = { trigger: t, pre, url: location.href, expanded: t.getAttribute('aria-expanded'), anims: new Set(document.getAnimations ? document.getAnimations() : []), samples: new Map(), t0: 0, ...extra })
    // first frame of everything the click restyles (class / style toggles, JS tweens, nodes it inserts)
    const sample = (el) => {
      if (el.nodeType !== 1 || M.samples.size > 600) return
      const s = M.samples.get(el)
      if (s) { s.last = window.performance.now(); return }
      const cs = getComputedStyle(el)
      M.samples.set(el, { first: { transform: cs.transform, translate: cs.translate, opacity: cs.opacity, left: cs.left, right: cs.right, top: cs.top, bottom: cs.bottom, height: cs.height, clipPath: cs.clipPath }, at: window.performance.now(), last: window.performance.now() })
    }
    M.mo = new window.MutationObserver((list) => { for (const m of list) { if (m.type === 'attributes') sample(m.target); else for (const n of m.addedNodes) { sample(n); if (n.querySelectorAll) for (const c of n.querySelectorAll('*')) sample(c) } } })
    M.mo.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden'] })
    // a toggle that is a link must not leave the page (handlers registered before this one still run)
    M.noNav = (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a && !/^(#|javascript:)/i.test((a.getAttribute('href') || '').trim())) e.preventDefault() }
    window.addEventListener('click', M.noNav)
    return M
  }
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim()
  const taggedEl = (k) => { for (const el of deepElements(document)) if ((el.getAttribute('data-figcap-menu') || '').split(' ').includes(k)) return el; return null }
  const tag = (el, k) => { const v = (el.getAttribute('data-figcap-menu') || '').split(' ').filter(Boolean); if (!v.includes(k)) v.push(k); el.setAttribute('data-figcap-menu', v.join(' ')) }
  const untag = (k) => { for (const el of deepElements(document)) { const v = (el.getAttribute('data-figcap-menu') || '').split(' '); if (v.includes(k)) { const rest = v.filter((x) => x && x !== k); if (rest.length) el.setAttribute('data-figcap-menu', rest.join(' ')); else el.removeAttribute('data-figcap-menu') } } }
  /**
   * An entry of the open menu that opens a next level in place (drill-down): a link / button row ending in an arrow
   * icon, or one that announces a popup / reads collapsed. Plain links (no arrow) navigate.
   */
  function drillsDown(el) {
    if (el.getAttribute('aria-haspopup') === 'true' || el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-expanded') === 'false') return true
    const r = el.getBoundingClientRect()
    if (r.width < 3 * r.height) return false
    for (const icon of el.querySelectorAll('svg, img, i, [class*="icon" i], [class*="chevron" i], [class*="arrow" i]')) {
      const b = icon.getBoundingClientRect()
      if (b.width > 0 && b.width <= 32 && b.height <= 32 && r.right - b.right <= 40 && b.left > r.left + r.width / 2) return true
    }
    return false
  }
  /** mode 'submenu-open' (`index`): activate the menu entry tagged `sub<index>` in the open menu (a click in the page) */
  async function submenuOpen() {
    thaw()
    const el = taggedEl(`sub${opts.index}`)
    const panel = taggedEl('panel')
    if (!el || !shownArea(el) || !panel) return null
    const M = record(el, { sub: true, text: norm(panel.innerText), label: labelOf(el), shown: norm(el.innerText) })
    M.t0 = window.performance.now()
    el.click()
    return { clicked: true }
  }
  /**
   * mode 'submenu-back': back to the menu's first level (the next level's back control, else closing and reopening the
   * menu). `{ ok }` = the first level shows again.
   */
  async function submenuBack() {
    thaw()
    const first = () => { const e = taggedEl('sub0'); return !!e && !!shownArea(e) }
    const back = taggedEl('back')
    untag('back')
    if (back && shownArea(back)) { back.click(); await sleep(700) }
    if (!first()) {
      const t = window.__figcapMenuTrigger, close = taggedEl('close')
      if (close && shownArea(close)) close.click(); else if (t) t.click()
      await sleep(900)
      if (t && t.isConnected) { t.click(); await sleep(1200) }
    }
    return { ok: first() }
  }
  /**
   * mode 'menu-close': close the open menu again. First call: `{ x, y }` = the viewport point of its close control (else
   * its toggle) for the driver to tap, or `{ ok: true }` when it is closed already. `finish`: still open → a click on
   * the control, then Escape; the menu's tags dropped, so the page can be walked / its menu opened at another width.
   * `{ ok }` = the panel is gone.
   */
  async function menuClose() {
    thaw()
    const t = window.__figcapMenuTrigger, close = taggedEl('close'), panel = taggedEl('panel')
    const open = () => !!panel && panel.isConnected && !!shownArea(panel)
    const ctl = close && shownArea(close) ? close : t && shownArea(t) ? t : null
    if (!opts.finish) {
      if (!open()) return { ok: true }
      if (ctl) { const r = ctl.getBoundingClientRect(); return { x: round(r.left + r.width / 2), y: round(r.top + r.height / 2) } }
    }
    if (open() && ctl) { ctl.click(); await sleep(900) }
    if (open()) { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(600) }
    const M = window.__figcapMenu
    if (M && M.mo) M.mo.disconnect()
    if (M && M.noNav) window.removeEventListener('click', M.noNav)
    for (const el of deepElements(document)) {
      const v = (el.getAttribute('data-figcap-menu') || '').split(' ').filter((k) => k && k !== 'panel' && k !== 'close' && k !== 'back' && !/^sub\d+$/.test(k))
      if (v.length) el.setAttribute('data-figcap-menu', v.join(' ')); else el.removeAttribute('data-figcap-menu')
    }
    window.__figcapMenu = null
    return { ok: !open() }
  }
  /** the transform / translate offset (px) of a computed or keyframe value */
  function translateOf(v, w, h) {
    const out = { x: 0, y: 0 }
    if (!v || v === 'none') return out
    const len = (s, ref) => (/%$/.test(s) ? (parseFloat(s) / 100) * ref : parseFloat(s) || 0)
    const m = /^matrix(3d)?\(([^)]*)\)$/.exec(v.trim())
    if (m) { const n = m[2].split(',').map(Number); return m[1] ? { x: n[12] || 0, y: n[13] || 0 } : { x: n[4] || 0, y: n[5] || 0 } }
    if (!/\(/.test(v)) { const p = v.trim().split(/\s+/); return { x: len(p[0], w), y: p[1] ? len(p[1], h) : 0 } }
    for (const f of v.matchAll(/(translate(?:3d|X|Y)?)\(([^)]*)\)/g)) {
      const a = f[2].split(',').map((s) => s.trim())
      if (f[1] === 'translateX') out.x += len(a[0], w)
      else if (f[1] === 'translateY') out.y += len(a[0], h)
      else { out.x += len(a[0], w); out.y += a[1] ? len(a[1], h) : 0 }
    }
    return out
  }
  /** vertical scale factor of a transform / scale value */
  function scaleYOf(v) {
    if (!v || v === 'none') return 1
    const m = /^matrix(3d)?\(([^)]*)\)$/.exec(v.trim())
    if (m) { const n = m[2].split(',').map(Number); return m[1] ? Math.hypot(n[4], n[5]) : Math.hypot(n[2], n[3]) }
    if (!/\(/.test(v)) { const p = v.trim().split(/\s+/).map(Number); return p[1] ?? p[0] ?? 1 }
    let y = 1
    for (const f of v.matchAll(/(scale(?:3d|X|Y)?)\(([^)]*)\)/g)) {
      const a = f[2].split(',').map(Number)
      if (f[1] === 'scaleY') y *= a[0]; else if (f[1] !== 'scaleX') y *= f[1] === 'scale' ? a[1] ?? a[0] : a[1]
    }
    return y
  }
  /**
   * Edge a box came in from, by its first and last animated values: the translate / offset it moved by (started left
   * of its place → 'left'…), else 'top' for a box unfolding from (near) zero height / clip, 'fade' for opacity or a
   * slight zoom; null = no motion.
   */
  function motionEdge(from, to, w, h) {
    const has = (k) => from[k] !== undefined && to[k] !== undefined && from[k] !== to[k]
    const a = translateOf(from.transform, w, h), b = translateOf(to.transform, w, h)
    const c = translateOf(from.translate, w, h), d = translateOf(to.translate, w, h)
    let dx = a.x - b.x + c.x - d.x, dy = a.y - b.y + c.y - d.y
    for (const [k, sx, sy] of [['left', 1, 0], ['right', -1, 0], ['top', 0, 1], ['bottom', 0, -1], ['marginLeft', 1, 0], ['marginTop', 0, 1]]) {
      if (!has(k) || !/px$/.test(from[k]) || !/px$/.test(to[k])) continue
      const delta = parseFloat(from[k]) - parseFloat(to[k])
      dx += sx * delta; dy += sy * delta
    }
    // a nudge of a few px under a fade (popovers dropping 10px) is a fade, not a slide from the edge
    const far = Math.abs(dx) >= Math.abs(dy) ? Math.abs(dx) >= Math.min(40, 0.5 * (w || 1e9)) : Math.abs(dy) >= Math.min(40, 0.5 * (h || 1e9))
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= 2 && (far || !has('opacity'))) return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom'
    const grows = (k) => has(k) && (/^0(px)?$/.test(from[k]) || parseFloat(from[k]) < 0.25 * parseFloat(to[k]))
    const sy = Math.min(scaleYOf(from.transform), scaleYOf(from.scale)), sy1 = Math.min(scaleYOf(to.transform), scaleYOf(to.scale))
    if (grows('height') || grows('maxHeight') || has('clipPath') || (has('gridTemplateRows') && /^0/.test(from.gridTemplateRows)) || sy < 0.5 * sy1) return 'top'
    if (has('opacity') || Math.abs(sy - sy1) > 0.01) return 'fade'
    return null
  }
  /**
   * mode 'menu-settle' (right after the driver's tap): read how the panel comes in while it animates, wait until every
   * animation the tap started has finished (≤ 1.5 s), find the panel (aria-controls target, else the largest box that
   * became visible) and the control that closes it; tag them for the state walk. `{ ok: false }` = nothing opened.
   */
  async function menuSettle() {
    const M = window.__figcapMenu
    if (!M) return null
    const t0 = M.t0 || window.performance.now()
    const seen = new Map()
    const finite = (a) => { try { return Number.isFinite(a.effect.getComputedTiming().endTime) } catch { return false } }
    const grab = () => {
      if (!document.getAnimations) return
      for (const a of document.getAnimations()) {
        if (M.anims.has(a) || seen.has(a) || !a.effect || !a.effect.target || !finite(a)) continue
        let kf = []
        try { kf = a.effect.getKeyframes() } catch { /* no keyframes */ }
        const timing = a.effect.getComputedTiming()
        seen.set(a, { target: a.effect.target, pseudo: a.effect.pseudoElement || null, kf, end: Math.max(0, timing.endTime), easing: (kf[0] && kf[0].easing !== 'linear' && kf[0].easing) || a.effect.getTiming().easing || 'linear' })
      }
    }
    grab()
    const settleAnims = async (limit) => {
      const s0 = window.performance.now()
      while (window.performance.now() - s0 < limit) {
        await sleep(40)
        grab()
        const running = document.getAnimations ? document.getAnimations().some((a) => !M.anims.has(a) && finite(a) && (a.playState === 'running' || a.pending)) : false
        if (!running && window.performance.now() - s0 > 200) break
      }
    }
    await settleAnims(1500)
    // the panel's copy shown (text the tap made visible): a menu a script opens a moment later
    // (a backdrop first, the panel after a timeout or a class toggled on the next frame) is walked once it is there, not
    // as an empty backdrop — up to 3 s more, then its own transitions are waited for too
    if (!M.sub) {
      // what the tap opened (boxes not shown before, a twenty-fifth of the viewport or more): any of them with copy?
      // (nothing opened at all: no wait — the toggle opens nothing)
      const openedState = () => {
        let any = false
        for (const el of deepElements(document.body)) {
          if (M.pre.has(el) || inside(M.trigger, el) || shownArea(el) <= VW * VH * 0.04) continue
          any = true
          if ((el.innerText || '').trim()) return 'copy'
        }
        return any ? 'empty' : 'none'
      }
      const w0 = window.performance.now()
      let waited = false
      while (openedState() === 'empty' && window.performance.now() - w0 < 3000) { await sleep(150); grab(); waited = true }
      if (waited) await settleAnims(1500)
    }
    await nextFrame()
    M.mo.disconnect()
    window.removeEventListener('click', M.noNav)
    if (M.sub) return subSettle(M, seen)
    const t = M.trigger
    // the panel: aria-controls target, else the largest box that became visible (content over bare backdrops),
    // else the largest box the tap animated
    let panel = null
    const id = t.getAttribute('aria-controls')
    const ctl = id && (t.getRootNode().getElementById?.(id) || document.getElementById(id))
    if (ctl && shownArea(ctl) && (!M.pre.has(ctl) || t.getAttribute('aria-expanded') !== M.expanded)) panel = ctl
    if (!panel) {
      const fresh = new Set()
      for (const el of deepElements(document.body)) { const a = shownArea(el); if (a && (!M.pre.has(el) || a > M.pre.get(el) * 2 + VW * VH * 0.04)) fresh.add(el) }
      let bestScore = VW * VH * 0.04
      for (const el of fresh) {
        if (el.parentElement && fresh.has(el.parentElement)) continue
        if (inside(el, t)) continue
        const pos = getComputedStyle(el).position
        const score = shownArea(el) * (/^(fixed|absolute|sticky)$/.test(pos) ? 1.5 : 1) * (el.querySelector('a[href], button') || (el.innerText || '').trim() ? 1 : 0.25)
        if (score > bestScore) { bestScore = score; panel = el }
      }
    }
    if (!panel) {
      let bestA = VW * VH * 0.04
      for (const s of seen.values()) { if (s.pseudo || inside(s.target, t)) continue; const a = shownArea(s.target); if (a > bestA) { bestA = a; panel = s.target } }
    }
    // a panel with no copy (a backdrop chosen for its size) while the tap showed entries elsewhere (the site's nav list,
    // laid over by the backdrop): the box that holds those entries is the panel — its nearest positioned box not around
    // the toggle, else their common box
    if (panel && !(panel.innerText || '').trim()) {
      const links = []
      for (const el of deepElements(document.body)) {
        if ((el.localName === 'a' || el.localName === 'button') && !M.pre.has(el) && !inside(M.trigger, el) && !inside(el, M.trigger) && (el.innerText || '').trim() && shownArea(el)) links.push(el)
      }
      if (links.length >= 2) {
        let common = links[0].parentElement
        while (common && !links.every((l) => inside(common, l))) common = common.parentElement
        if (common && common !== document.body && !inside(common, M.trigger)) {
          let box = common
          for (let a = common; a && a !== document.body && !inside(a, M.trigger); a = a.parentElement) if (/^(fixed|absolute)$/.test(getComputedStyle(a).position)) { box = a; break }
          panel = box
        }
      }
    }
    if (!panel || location.href !== M.url) return { ok: false }
    const motion = readMotion(panel, M, seen)
    // the control that closes it: the trigger when it now reads expanded (or still sits on top), else a "close" / × button
    tag(panel, 'panel')
    let close = null
    const tr = t.getBoundingClientRect()
    const onTop = shownArea(t) && (() => { const h = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2); return h && (inside(t, h) || inside(h, t)) })()
    if (onTop && t.getAttribute('aria-expanded') === 'true') close = t
    if (!close) {
      let best = -1
      for (const el of deepElements(document.body)) {
        if (!/^(button|a)$/.test(el.localName) && el.getAttribute('role') !== 'button') continue
        const label = `${labelOf(el)} ${classOf(el)}`
        if (!CLOSE_RE.test(label) || !shownArea(el)) continue
        const r = el.getBoundingClientRect()
        const score = (inside(panel, el) ? 1000 : 0) - r.top
        if (score > best) { best = score; close = el }
      }
    }
    // the panel's own toggle drawn where the trigger was (an unlabelled ×, often a second burger button; the trigger is
    // covered or hidden now)
    const was = tr.width && tr.height ? tr : M.rect
    if (!onTop && was && was.width && was.height && (!close || !inside(panel, close))) {
      const h = document.elementFromPoint(was.left + was.width / 2, was.top + was.height / 2)
      const b = h && h.closest && h.closest('button, [role="button"], a')
      const href = b && b.localName === 'a' ? (b.getAttribute('href') || '').trim() : ''
      if (b && inside(panel, b) && (!href || /^(#|javascript:)/i.test(href))) close = b
    }
    if (!close && onTop) close = t
    if (close) tag(close, 'close')
    // entries that open a next level in place: tagged for the driver's walks of each level (sub0, sub1…)
    let subs = 0
    for (const el of deepElements(panel)) {
      if (subs >= 8) break
      if (el === close || (!/^(button|a)$/.test(el.localName) && el.getAttribute('role') !== 'button') || !shownArea(el)) continue
      if (drillsDown(el)) tag(el, `sub${subs++}`)
    }
    return { ok: true, motion, expanded: t.getAttribute('aria-expanded'), subs }
  }
  /**
   * menu-settle after submenu-open: the menu panel now shows another level (its text changed; else the entry was a
   * plain link: `{ ok: false }`). The level is the largest box in the panel that came into view; its back control (a
   * new button reading back / zurück, or the entry's own label, usually with an arrow) is tagged `back`.
   */
  function subSettle(M, seen) {
    const panel = taggedEl('panel')
    if (!panel || !shownArea(panel) || location.href !== M.url || norm(panel.innerText) === M.text) return { ok: false }
    const fresh = new Set()
    for (const el of deepElements(panel)) if (shownArea(el) && !M.pre.has(el)) fresh.add(el)
    let level = panel, best = 0
    for (const el of fresh) { if (el.parentElement && fresh.has(el.parentElement)) continue; const a = shownArea(el); if (a > best) { best = a; level = el } }
    const BACK_RE = /zur[üu]ck|\bback\b|retour|atr[aá]s|indietro|terug|wstecz|voltar/i
    let back = null, score = 0
    for (const el of fresh) {
      if (!/^(button|a)$/.test(el.localName) && el.getAttribute('role') !== 'button') continue
      const words = `${labelOf(el)} ${classOf(el)}`
      const own = labelOf(el)
      let s = (BACK_RE.test(words) ? 3 : 0) + (own && (own === M.label || own === M.shown) ? 2 : 0)
      if (!s) continue
      if (el.querySelector('svg, img')) s += 1
      s -= el.getBoundingClientRect().top / 1e5
      if (s > score) { score = s; back = el }
    }
    untag('back')
    if (back) tag(back, 'back')
    return { ok: true, motion: readMotion(level, M, seen), back: !!back, label: M.shown || M.label }
  }
  /** how `panel` came in: its own animations, else an animated ancestor (wrapper), else its largest animated descendant */
  function readMotion(panel, M, seen) {
    const kfValue = (kf, i, k) => (kf[i] && kf[i][k] !== undefined ? String(kf[i][k]) : undefined)
    const order = (el) => (el === panel ? 0 : inside(el, panel) ? 1 : 2)
    const groups = new Map()
    for (const s of seen.values()) if (!s.pseudo && (inside(panel, s.target) || inside(s.target, panel))) { if (!groups.has(s.target)) groups.set(s.target, []); groups.get(s.target).push(s) }
    const targets = [...groups.keys()].sort((a, b) => order(a) - order(b) || shownArea(b) - shownArea(a))
    let motion = null
    for (const el of targets) {
      const cs = getComputedStyle(el), from = {}, to = {}
      for (const s of groups.get(el)) {
        const last = s.kf.length - 1
        for (const k of new Set(s.kf.flatMap((f) => Object.keys(f)))) {
          if (/^(offset|easing|composite|computedOffset)$/.test(k)) continue
          from[k] = kfValue(s.kf, 0, k) ?? cs[k]; to[k] = kfValue(s.kf, last, k) ?? cs[k]
        }
      }
      const enter = motionEdge(from, to, el.offsetWidth || 0, el.offsetHeight || 0)
      if (!enter) continue
      // the longest; on a tie the one that moves / fades the box (not a colour or size tween beside it)
      const moves = (x) => (x.kf.some((f) => ['transform', 'translate', 'opacity', 'left', 'right', 'top', 'bottom', 'clipPath', 'maxHeight'].some((k) => k in f)) ? 1 : 0)
      const g = groups.get(el).sort((a, b) => b.end - a.end || moves(b) - moves(a))
      motion = { enter, duration: Math.round(g[0].end), easing: g[0].easing }
      break
    }
    // JS-driven tweens (no Animation objects): first restyled frame vs now, timed by the mutations
    if (!motion) {
      const cand = [...M.samples.keys()].filter((el) => el.isConnected && (inside(panel, el) || inside(el, panel))).sort((a, b) => order(a) - order(b))
      for (const el of cand) {
        const s = M.samples.get(el), cs = getComputedStyle(el)
        const to = { transform: cs.transform, translate: cs.translate, opacity: cs.opacity, left: cs.left, right: cs.right, top: cs.top, bottom: cs.bottom, height: cs.height, clipPath: cs.clipPath }
        const enter = motionEdge(s.first, to, el.offsetWidth || 0, el.offsetHeight || 0)
        if (!enter) continue
        const ms = (v) => (parseFloat(v) || 0) * (/ms$/.test((v || '').trim()) ? 1 : 1000), delays = cs.transitionDelay.split(',')
        const tr = cs.transitionDuration.split(',').map((v, i) => ms(v) + ms(delays[i % delays.length]))
        motion = { enter, duration: Math.round(Math.max(s.last - s.at, ...tr)), easing: cs.transitionTimingFunction.split(',')[0].trim() || 'linear' }
        break
      }
    }
    return motion || { enter: 'none', duration: 0, easing: 'linear' }
  }

  /* ------------------------------------------------------------------ states (widgets that change in place) */

  /** inside a fixed / sticky box (header, cookie banner, chat teaser): never part of an in-place widget */
  const pinnedBox = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement || (p.parentNode && p.parentNode.host)) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky') return true } return false }
  const ancestorsOf = (el) => { const out = []; for (let p = el.parentElement || (el.parentNode && el.parentNode.host); p && p !== document.documentElement; p = p.parentElement || (p.parentNode && p.parentNode.host)) out.push(p); return out }
  /**
   * Controls that change their part of the page in place (`kind` 'select': picks one of a group, 'toggle': on / off):
   * choice chips and tabs (a label around a radio / checkbox, role tab / radio), pressed / expanded buttons (accordions,
   * disclosures), and buttons that are the slides of a horizontal slider (a card opening its details below it). Never in
   * a fixed / sticky bar, never the menu toggle, a slider arrow or a link to another page. At most 40, in page order.
   */
  function findStateControls() {
    const out = [], seen = new Set()
    // phones / tablets: the other buttons of the bar the menu toggle sits in (account, search, bmw.de's "My BMW") open
    // the navigation or a sheet over the page, not a widget in place, and clicking them again does not close it — the
    // menu state that follows would find the menu already open and capture nothing (desktop flyouts stay states)
    const trigger = window.__figcapMenuTrigger
    const menuBar = trigger && window.innerWidth < 1024 ? trigger.closest('header, nav, [role="navigation"], [role="banner"]') : null
    const scrollsX = (el) => { for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) { const cs = getComputedStyle(p); if (/auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 2) return true } return false }
    const add = (el, kind) => {
      if (out.length >= 40 || seen.has(el)) return
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8 || !visible(el) || el === window.__figcapMenuTrigger || (menuBar && menuBar.contains(el)) || pinnedBox(el)) return
      if (/n[äa]chst|vorherig|\bnext\b|\bprev(ious)?\b/i.test(`${el.getAttribute('aria-label') || ''} ${classOf(el)}`)) return
      const href = el.localName === 'a' ? (el.getAttribute('href') || '').trim() : ''
      if (href && !/^(#|javascript:)/i.test(href)) return
      seen.add(el); out.push({ el, kind, tag: el.localName, label: labelOf(el), cls: classOf(el), at: { x: r.left + window.scrollX, y: r.top + window.scrollY } })
    }
    // a short native drop-down: one choice per option (the phone layout of a chip filter)
    const options = (el) => {
      const r = el.getBoundingClientRect()
      if (el.multiple || el.options.length < 2 || el.options.length > 24 || r.width < 8 || r.height < 8 || !visible(el) || pinnedBox(el)) return
      for (let i = 0; i < el.options.length && out.length < 40; i++) out.push({ el, kind: 'select', option: i, base: el.selectedIndex, tag: 'select', label: labelOf(el), text: norm(el.options[i].textContent), cls: classOf(el), at: { x: r.left + window.scrollX, y: r.top + window.scrollY } })
    }
    for (const el of deepElements(document.body)) {
      const tag = el.localName, role = el.getAttribute('role')
      if (tag === 'select') { options(el); continue }
      if (tag === 'label') {
        const input = el.querySelector('input') || (el.htmlFor && document.getElementById(el.htmlFor))
        if (input && /^(radio|checkbox)$/.test(input.type)) add(el, input.type === 'radio' ? 'select' : 'toggle')
      } else if (role === 'tab' || role === 'radio') add(el, 'select')
      else if ((tag === 'button' || role === 'button') && el.hasAttribute('aria-pressed')) add(el, 'toggle')
      else if ((tag === 'button' || tag === 'summary' || role === 'button') && el.getAttribute('aria-expanded') === 'false' && !el.hasAttribute('aria-haspopup')) add(el, 'toggle')
      else if (tag === 'button' && scrollsX(el)) add(el, 'toggle')
    }
    return out
  }
  /**
   * The control's element now: the one found, else (a widget that re-rendered after an earlier state) the element of the
   * same tag and label nearest to where it was (generated class names change with a re-render: same class wins a tie),
   * tagged again.
   */
  function controlEl(c, k) {
    if (c.el.isConnected) return c.el
    let best = null, d = Infinity
    for (const el of deepElements(document.body)) {
      if (el.localName !== c.tag || labelOf(el) !== c.label) continue
      const r = el.getBoundingClientRect()
      const dd = Math.hypot(r.left + window.scrollX - c.at.x, r.top + window.scrollY - c.at.y) + (classOf(el) === c.cls ? 0 : 0.5)
      if (dd < d) { d = dd; best = el }
    }
    if (best) { c.el = best; best.setAttribute('data-figcap-ctl', [...new Set([...(best.getAttribute('data-figcap-ctl') || '').split(' ').filter(Boolean), String(k)])].join(' ')) }
    return best
  }
  /** the control a 'select' falls back to: the checked / selected one of its group (radio name, tablist) */
  function selectedOf(el) {
    const input = el.localName === 'label' ? el.querySelector('input') || (el.htmlFor && document.getElementById(el.htmlFor)) : null
    const cands = (window.__figcapCtl || []).filter((c) => c.kind === 'select')
    for (const c of cands) {
      const i = c.el.localName === 'label' ? c.el.querySelector('input') || (c.el.htmlFor && document.getElementById(c.el.htmlFor)) : null
      if (input && i && i.name === input.name && i.checked) return c.el
      if (!input && c.el.parentElement === el.parentElement && /^true$/.test(c.el.getAttribute('aria-selected') || c.el.getAttribute('aria-checked') || '')) return c.el
    }
    return null
  }
  /** until the DOM has been quiet for 300 ms (and what it started animating has finished), at most `max` ms */
  async function quiet(S, max) {
    const t0 = window.performance.now()
    while (window.performance.now() - t0 < max) { await sleep(50); if (window.performance.now() - S.last > 300 && window.performance.now() - t0 > 250) break }
    const end = window.performance.now() + 1000
    while (document.getAnimations && window.performance.now() < end && document.getAnimations().some((a) => a.playState === 'running' && Number.isFinite(a.effect && a.effect.getComputedTiming().endTime))) await sleep(50)
  }
  /**
   * mode 'state-open' (`index`): the control's widget scrolled into view, the DOM watched, the control clicked (links do
   * not leave). The text of the control's ancestors is kept to tell the region was restored.
   */
  async function stateOpen() {
    thaw()
    const c = (window.__figcapCtl || [])[opts.index]
    if (!c || !controlEl(c, opts.index) || !visible(c.el)) return null
    c.el.scrollIntoView({ block: 'center', behavior: 'instant' })
    await nextFrame(); await nextFrame()
    const S = (window.__figcapState = { ctl: c, changed: [], url: location.href, last: window.performance.now(), texts: new Map(ancestorsOf(c.el).slice(0, 12).map((a) => [a, norm(a.innerText)])) })
    S.mo = new window.MutationObserver((list) => { S.last = window.performance.now(); for (const m of list) S.changed.push(m.type === 'characterData' ? m.target.parentElement : m.target) })
    S.mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    S.noNav = (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a && !/^(#|javascript:)/i.test((a.getAttribute('href') || '').trim())) e.preventDefault() }
    window.addEventListener('click', S.noNav)
    if (c.option !== undefined) chooseOption(c.el, c.option)
    else c.el.click()
    return { clicked: true }
  }
  /** pick option `i` of a native drop-down the way a visitor does (frameworks listen to input / change) */
  function chooseOption(sel, i) {
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    set.call(sel, sel.options[i].value)
    sel.dispatchEvent(new Event('input', { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }
  /**
   * mode 'state-settle': the region the click changed — the lowest ancestor of the control holding most of the shown
   * boxes that changed (strays left out: timers elsewhere, a footnote list renumbered at the page's end), a box of
   * the base walk, not pinned — its lazy
   * images loaded, tagged for the region walk. `{ ok: false }` when nothing changed in place.
   */
  async function stateSettle() {
    const S = window.__figcapState
    if (!S) return null
    await quiet(S, 2500)
    S.mo.disconnect()
    window.removeEventListener('click', S.noNav)
    if (location.href !== S.url) return { ok: false }
    // body / html attribute churn (scroll locks, state classes) says nothing about where the widget is
    const shown = [...new Set(S.changed)].filter((n) => n && n.nodeType === 1 && n.isConnected && !/^(script|style|link|meta|noscript|body|html)$/.test(n.localName) && n.getBoundingClientRect().width > 0)
    if (!shown.length) return { ok: false }
    let region = null
    for (const a of [...S.texts.keys()]) {
      let n = 0
      for (const x of shown) if (inside(a, x)) n++
      if (n > 0.5 * shown.length) { region = a; break }
    }
    while (region && region.__figcapBase === undefined) region = region.parentElement
    if (!region || region === document.body || pinnedBox(region) || norm(region.innerText) === S.texts.get(region) && !shown.some((x) => inside(region, x) && x !== region)) return { ok: false }
    S.region = region
    // what the state shows loads now (slider libraries and lazy images inside it)
    for (const img of region.querySelectorAll('img')) {
      if (img.loading === 'lazy') img.loading = 'eager'
      const lazy = !img.getAttribute('src') && (img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-splide-lazy'))
      if (lazy) img.setAttribute('src', lazy)
    }
    const imgs = [...region.querySelectorAll('img')].filter((i) => !i.complete)
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }) }))), sleep(4000)])
    await Promise.race([Promise.all([...region.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => {}) : null))), sleep(2000)])
    region.setAttribute('data-figcap-region', '')
    // no focus ring of the click in the state's look (nor in the next one's)
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur()
    // controls the state re-rendered are found again, so the state's own walk knows them
    ;(window.__figcapCtl || []).forEach((c, k) => controlEl(c, k))
    return { ok: true, region: region.__figcapBase, kind: S.ctl.kind, label: S.ctl.text || labelOf(S.ctl.el) }
  }
  /**
   * mode 'state-restore' (`index`): the page as before — a toggle clicked again, a choice back on the group's selected
   * one. `{ ok }` = the region (else the control's surroundings) reads as before.
   */
  async function stateRestore() {
    thaw()
    const S = window.__figcapState, c = (window.__figcapCtl || [])[opts.index]
    if (!S || !c) return { ok: false }
    if (S.region) S.region.removeAttribute('data-figcap-region')
    const back = c.option !== undefined ? c.el : c.kind === 'toggle' ? c.el : selectedOf(c.el)
    if (!back) return { ok: false }
    const R = { last: window.performance.now() }
    const mo = new window.MutationObserver(() => { R.last = window.performance.now() })
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    window.addEventListener('click', S.noNav)
    if (c.option !== undefined) chooseOption(back, c.base)
    else back.click()
    await quiet(R, 2500)
    mo.disconnect()
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur()
    window.removeEventListener('click', S.noNav)
    const probe = S.region || [...S.texts.keys()][3] || [...S.texts.keys()][0]
    return { ok: !!probe && norm(probe.innerText) === S.texts.get(probe) }
  }

  /**
   * mode 'sheets' (before the walk): the style sheets the page cannot read (cross-origin, also when @imported) — the
   * driver fetches their text and passes it back as `opts.css` for the brand extras
   */
  function unreadableSheets() {
    const out = []
    const visit = (list, depth) => {
      for (const sh of list) {
        let rules
        try { rules = sh.cssRules } catch { if (sh.href) out.push(sh.href); continue }
        if (rules && depth < 4) for (const r of rules) if (r.type === 3 /* IMPORT */ && r.styleSheet) visit([r.styleSheet], depth + 1)
      }
    }
    visit(document.styleSheets, 0)
    for (const el of deepElements(document)) if (el.shadowRoot) visit(el.shadowRoot.styleSheets, 0)
    return { url: location.href, sheets: [...new Set(out)] }
  }

  /* ------------------------------------------------------------------ layout ranges (modes 'breakpoints', 'layout-sig', 'layout-diff') */

  /**
   * mode 'breakpoints': the viewport widths where the page's style sheets switch rules (`@media` width conditions of
   * every readable sheet, nested ones and @imports included) → `{ breakpoints: [{ px, rules }] }`: `px` is the first
   * width of the new range (`min-width: 960px` → 960, `max-width: 1024px` → 1025, `max-width: 959.98px` → 960),
   * `rules` the style rules switched there. The driver then measures which of them really change the page's layout.
   */
  function mediaBreakpoints() {
    const at = new Map()
    const toPx = (n, u) => (u === 'em' || u === 'rem' ? +n * 16 : +n)
    const add = (px, n) => { if (!(px >= 300 && px <= 4000)) return; px = Math.round(px); at.set(px, (at.get(px) || 0) + n) }
    const count = (rules, depth) => { let n = 0; for (const r of rules) { if (r.type === 1) n++; else if (r.cssRules && depth < 6) n += count(r.cssRules, depth + 1) } return n }
    const parse = (q, n) => {
      for (const m of q.matchAll(/(min|max)-width\s*:\s*([\d.]+)(px|em|rem)?/gi)) { const v = toPx(m[2], m[3]); add(m[1].toLowerCase() === 'min' ? Math.ceil(v - 0.001) : Math.floor(v) + 1, n) }
      for (const m of q.matchAll(/(?:^|[(\s])width\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)?/gi)) { const v = toPx(m[2], m[3]); add(m[1] === '>=' || m[1] === '<' ? Math.ceil(v - 0.001) : Math.floor(v) + 1, n) }
      for (const m of q.matchAll(/([\d.]+)(px|em|rem)?\s*(<=|<|>=|>)\s*width/gi)) { const v = toPx(m[1], m[2]); add(m[3] === '<=' || m[3] === '>' ? Math.ceil(v - 0.001) : Math.floor(v) + 1, n) }
    }
    // @container width conditions: the viewport width they switch at depends on the container's width ('container-switches')
    const conds = []
    const containerCond = (r) => {
      const q = r.containerQuery || r.conditionText || ''
      const name = (r.containerName || '').trim()
      const add = (v) => { if (v > 0 && v < 4000 && conds.length < 400) conds.push({ name, px: v, rules: count(r.cssRules, 0) }) }
      for (const m of q.matchAll(/(?:min-|max-)?(?:inline-size|width)\s*:\s*([\d.]+)(px|em|rem)?/gi)) add(toPx(m[1], m[2]))
      for (const m of q.matchAll(/(?:inline-size|width)\s*(?:>=|<=|>|<)\s*([\d.]+)(px|em|rem)?/gi)) add(toPx(m[1], m[2]))
      for (const m of q.matchAll(/([\d.]+)(px|em|rem)?\s*(?:>=|<=|>|<)\s*(?:inline-size|width)/gi)) add(toPx(m[1], m[2]))
    }
    const visit = (rules, depth) => {
      for (const r of rules) {
        if (window.CSSContainerRule && r instanceof window.CSSContainerRule) { containerCond(r); if (depth < 8) visit(r.cssRules, depth + 1) }
        else if (r.type === 4 && r.media) { parse(r.media.mediaText, count(r.cssRules, 0)); if (depth < 8) visit(r.cssRules, depth + 1) }
        else if (r.type === 3 && r.styleSheet) { try { if (r.media && r.media.mediaText) parse(r.media.mediaText, count(r.styleSheet.cssRules, 0)); if (depth < 4) visit(r.styleSheet.cssRules, depth + 1) } catch { /* cross-origin import */ } }
        else if (r.cssRules && depth < 8) visit(r.cssRules, depth + 1)
      }
    }
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])]
    for (const el of deepElements(document)) if (el.shadowRoot) sheets.push(...el.shadowRoot.styleSheets, ...(el.shadowRoot.adoptedStyleSheets || []))
    for (const sh of sheets) {
      try { if (sh.media && sh.media.mediaText) parse(sh.media.mediaText, count(sh.cssRules, 0)); visit(sh.cssRules, 0) } catch { /* cross-origin sheet */ }
    }
    // <link media="(min-width: …)"> sheets the browser did not load the rules of are still breakpoints
    for (const l of document.querySelectorAll('link[rel~="stylesheet"][media], source[media]')) parse(l.getAttribute('media') || '', 1)
    // one entry per container name and width
    const seen = new Map()
    for (const c of conds) { const k = `${c.name}|${c.px}`; seen.set(k, { ...c, rules: (seen.get(k)?.rules || 0) + c.rules }) }
    window.__figcapContainerConds = [...seen.values()]
    return { breakpoints: [...at].map(([px, rules]) => ({ px, rules })).sort((a, b) => a.px - b.px), containers: seen.size }
  }

  /**
   * mode 'layout-sig' `{ key }`: the layout of the page at the current viewport width, kept in the page for
   * 'layout-diff': for each element (the same list for every key) whether it is shown, its formatting (display,
   * position, flex direction / wrap, grid column count, float), its box and font size.
   */
  function layoutSig() {
    let L = window.__figcapLayout
    if (!L) {
      const els = []
      const index = new Map()
      for (const el of deepElements(document.body)) {
        if (/^(script|style|noscript|template|link|meta|source|track|option|br|wbr)$/.test(el.localName) || el.ownerSVGElement) continue
        index.set(el, els.length)
        els.push(el)
        if (els.length >= 25000) break
      }
      const parent = els.map((el) => { for (let p = el.parentNode || el.host; p; p = p.parentNode || p.host) if (index.has(p)) return index.get(p); return -1 })
      // size containers (`container-type`), for the viewport widths their @container conditions switch at
      const containers = els.filter((el) => { const t = getComputedStyle(el).containerType; return t && t !== 'normal' }).slice(0, 500)
      // boxes inside a horizontally clipping / scrolling box (a slider track): their offsets follow the track, not a switch
      const track = els.map((el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (/^(hidden|auto|scroll|clip)$/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 2) return true } return false })
      L = window.__figcapLayout = { els, parent, sigs: {}, containers, cw: {}, toks: {}, track }
    }
    const cols = (v) => (!v || v === 'none' ? 0 : v.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+(?![^(]*\))/).filter(Boolean).length)
    // the page's structure without element identity (scripts may re-create their nodes on resize): every shown box in
    // document order as tag, role, formatting and its own text
    const toks = []
    for (const el of deepElements(document.body)) {
      if (/^(script|style|noscript|template|link|meta|source|track|option|br|wbr)$/.test(el.localName) || el.ownerSVGElement) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      let own = ''
      for (const c of el.childNodes) if (c.nodeType === 3) own += c.data
      toks.push(`${el.localName}|${el.getAttribute('role') || ''}|${cs.display}|${cs.position}|${cs.flexDirection}|${cols(cs.gridTemplateColumns)}|${own.replace(/\s+/g, ' ').trim().slice(0, 24)}`)
      if (toks.length >= 25000) break
    }
    L.toks[opts.key] = toks
    let hash = 0x811c9dc5
    for (const t of toks) for (let i = 0; i < t.length; i++) hash = Math.imul(hash ^ t.charCodeAt(i), 0x01000193)
    hash = (hash >>> 0).toString(36)
    if (opts.tokensOnly) return { hash, shown: toks.length }
    const sy = window.scrollY, sx = window.scrollX
    const sig = L.els.map((el) => {
      if (!el.isConnected) return 0
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return 0
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return 0
      return { k: `${cs.display}|${cs.position}|${cs.flexDirection}|${cs.flexWrap}|${cols(cs.gridTemplateColumns)}|${cs.float}`, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, fs: parseFloat(cs.fontSize) || 0, inline: /^inline(?!-(block|flex|grid))/.test(cs.display) }
    })
    L.sigs[opts.key] = { sig, vw: document.documentElement.clientWidth || window.innerWidth, vh: window.innerHeight }
    L.cw[opts.key] = L.containers.map((el) => { if (!el.isConnected) return null; const cs = getComputedStyle(el); return el.clientWidth ? el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) : null })
    return { n: L.els.length, shown: sig.filter(Boolean).length, hash }
  }

  /**
   * mode 'container-switches': the viewport widths where a size container's width crosses one of its @container
   * conditions ('breakpoints' read them), from the container widths 'layout-sig' recorded (linear between the two
   * recorded viewport widths around the crossing) → `{ widths: [px, …] }` (the first width past it, ascending)
   */
  function containerSwitches() {
    const L = window.__figcapLayout, conds = window.__figcapContainerConds || []
    if (!L || !conds.length) return { widths: [] }
    const keys = Object.keys(L.cw).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    const out = new Set()
    L.containers.forEach((el, i) => {
      const names = (getComputedStyle(el).containerName || 'none').split(/\s+/)
      const mine = conds.filter((c) => !c.name || names.includes(c.name))
      for (const c of mine) {
        for (let k = 1; k < keys.length; k++) {
          const v1 = keys[k - 1], v2 = keys[k], c1 = L.cw[v1][i], c2 = L.cw[v2][i]
          if (c1 == null || c2 == null || c1 === c2 || (c1 - c.px) * (c2 - c.px) > 0 || (c1 <= c.px && c2 <= c.px)) continue
          const v = v1 + ((c.px - c1) * (v2 - v1)) / (c2 - c1)
          if (v > 320 && v < 2560) out.add(Math.ceil(v + 0.001))
        }
      }
    })
    return { widths: [...out].sort((a, b) => a - b) }
  }

  /**
   * mode 'layout-diff' `{ pairs: [[keyA, keyB], …] }`: how much the layout changes between two 'layout-sig' keys
   * (the widths just below and at a breakpoint). `structural`: boxes that appear / disappear or switch formatting
   * (a nav hidden, a column stack becoming a row, a grid gaining a column); `shifted`: boxes that jump sideways or
   * resize by more than the 1 px of viewport explains, or change their font size. Each is the area of the outermost
   * changed boxes over the viewport's area (a box counts with at most one viewport), plus the number of such boxes and
   * a few of their names.
   */
  function layoutDiff() {
    const L = window.__figcapLayout
    if (!L) return { pairs: [] }
    const name = (el) => `${el.localName}${el.id ? `#${el.id}` : ''}${classOf(el) ? `.${classOf(el).trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`.slice(0, 80)
    // `noise` [keyA, keyB]: two samples at one width a moment apart: boxes that changed there (animations, tickers,
    // autoplay) change by themselves, not at a switch — left out, with everything inside them
    const unstable = new Uint8Array(L.els.length)
    const N = opts.noise && L.sigs[opts.noise[0]] && L.sigs[opts.noise[1]] ? [L.sigs[opts.noise[0]].sig, L.sigs[opts.noise[1]].sig] : null
    if (N) {
      for (let i = 0; i < L.els.length; i++) {
        const a = N[0][i], b = N[1][i]
        const p = L.parent[i]
        if ((p >= 0 && unstable[p]) || (!a) !== (!b) || (a && b && (a.k !== b.k || Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1))) unstable[i] = 1
      }
    }
    const pairs = (opts.pairs || []).map(([ka, kb]) => {
      const A = L.sigs[ka], B = L.sigs[kb]
      if (!A || !B) return null
      const vw = Math.max(A.vw, B.vw), vh = Math.max(A.vh, B.vh), view = vw * vh
      const area = (s) => Math.min(s.w, vw) * Math.min(s.h, vh)
      const kind = new Int8Array(L.els.length)
      const out = { a: ka, b: kb, structural: 0, shifted: 0, ns: 0, nj: 0, samples: [] }
      for (let i = 0; i < L.els.length; i++) {
        const a = A.sig[i], b = B.sig[i]
        if ((!a && !b) || unstable[i]) continue
        let k = 0
        if (!a || !b || a.k !== b.k) k = 1
        else if (!a.inline && !(L.track && L.track[i]) && (Math.abs(a.x - b.x) > 2 || Math.abs(a.w - b.w) > 2 || Math.abs(a.fs - b.fs) > 0.3)) k = 2
        kind[i] = k
        if (!k) continue
        // the outermost changed box only (its content moves with it)
        const p = L.parent[i]
        if (p >= 0 && kind[p] === k) continue
        const s = b || a
        const ar = area(s) / view
        if (k === 1) { out.structural += ar; out.ns++ } else { out.shifted += ar; out.nj++ }
        if (out.samples.length < 6 && ar > 0.002) out.samples.push(`${k === 1 ? 'S' : 'J'} ${name(L.els[i])}`)
      }
      // the structure compared without identity: share of shown boxes that are not on the other side (multiset)
      const ta = L.toks[ka], tb = L.toks[kb]
      if (ta && tb) {
        const m = new Map()
        for (const t of ta) m.set(t, (m.get(t) || 0) + 1)
        let common = 0
        for (const t of tb) { const n = m.get(t) || 0; if (n) { common++; m.set(t, n - 1) } }
        out.tokens = Math.round((1 - common / Math.max(1, ta.length, tb.length)) * 10000) / 10000
      }
      out.structural = Math.round(out.structural * 10000) / 10000
      out.shifted = Math.round(out.shifted * 10000) / 10000
      return out
    })
    return { pairs }
  }
  if (opts.mode === 'sheets') return unreadableSheets()
  if (opts.mode === 'breakpoints') return mediaBreakpoints()
  if (opts.mode === 'layout-sig') return layoutSig()
  if (opts.mode === 'layout-diff') return layoutDiff()
  if (opts.mode === 'container-switches') return containerSwitches()
  if (opts.mode === 'freeze') { freezePage(); return { ok: true } }
  if (opts.mode === 'thaw') { thaw(); return { ok: true } }
  if (opts.mode === 'menu-close') return menuClose()
  // mode 'consent': the cookie / consent banner dismissed as the capture does (the layout probe measures the page a
  // visitor sees once it is gone)
  if (opts.mode === 'consent') { await dismissConsent(); await dismissRegionDialogs(); return { ok: true } }
  if (opts.mode === 'region-dialog') return { closed: await dismissRegionDialogs() }
  if (opts.mode === 'menu-open') return menuOpen()
  if (opts.mode === 'menu-settle') return menuSettle()
  if (opts.mode === 'submenu-open') return submenuOpen()
  if (opts.mode === 'submenu-back') return submenuBack()
  if (opts.mode === 'state-open') return stateOpen()
  if (opts.mode === 'state-settle') return stateSettle()
  if (opts.mode === 'state-restore') return stateRestore()

  const scrollTo = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' })
  const noSmooth = document.createElement('style')
  noSmooth.textContent = 'html,body,*{scroll-behavior:auto!important}'
  document.head.appendChild(noSmooth)
  async function settle() {
    // native lazy images outside the scrolled strip (carousel slides, collapsed panels) load too
    for (const el of deepElements(document)) if (el.localName === 'img' && el.loading === 'lazy') el.loading = 'eager'
    // script-lazy images (slider libraries load the slides next to the visible ones only): their source now, so slides
    // kept for the carousel are not empty boxes
    for (const el of deepElements(document)) {
      if (el.localName !== 'img' || el.getAttribute('src')) continue
      const lazy = el.getAttribute('data-splide-lazy') || el.getAttribute('data-src') || el.getAttribute('data-lazy') || el.getAttribute('data-lazy-src')
      const set = el.getAttribute('data-splide-lazy-srcset') || el.getAttribute('data-srcset')
      if (set) el.setAttribute('srcset', set)
      if (lazy) el.setAttribute('src', lazy)
    }
    const max = Math.min(opts.maxScroll || 30000, document.documentElement.scrollHeight)
    for (let y = 0; y < max; y += Math.round(VH * 0.7)) { scrollTo(y); await sleep(140) }
    scrollTo(document.documentElement.scrollHeight); await sleep(400)
    scrollTo(0); await sleep(opts.settleMs || 600)
    const imgs = [...document.images].filter((i) => !i.complete)
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }) }))), sleep(8000)])
    // decoded too: a box sized by its image must not grow after the walk
    await Promise.race([Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null))), sleep(4000)])
    if (document.fonts) await Promise.race([document.fonts.ready, sleep(5000)])
  }

  /** layout signature: document height + boxes of the page's sections and images (sampled) */
  function layoutKey() {
    const parts = [document.documentElement.scrollHeight]
    const els = document.querySelectorAll('body > *, main > *, section, header, footer, img, video, picture')
    const step = Math.max(1, Math.floor(els.length / 300))
    for (let i = 0; i < els.length; i += step) { const r = els[i].getBoundingClientRect(); parts.push(Math.round(r.top + window.scrollY), Math.round(r.height)) }
    return parts.join(',')
  }
  /**
   * wait until the page is quiet (late images, hydration, resize handlers): two polls 400 ms apart with the same layout
   * and no DOM mutation in between
   */
  async function stable(maxMs) {
    const end = Date.now() + maxMs
    let muts = 0
    const mo = window.MutationObserver ? new window.MutationObserver((l) => { muts += l.length }) : null
    if (mo) mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    let prev = layoutKey(), same = 0
    while (Date.now() < end && same < 2) { muts = 0; await sleep(400); const k = layoutKey(); same = k === prev && !muts ? same + 1 : 0; prev = k }
    if (mo) mo.disconnect()
    return same >= 2
  }

  /**
   * Nothing moves between this walk and the driver's screenshots: autoplaying carousels stop on their first slide,
   * pending timers / animation frames are cancelled and later intervals never start (the page is done loading; JS
   * tweens jump to nothing, CSS transitions are switched off below), videos loop instead of ending (an `ended`
   * handler would advance a slider).
   */
  function freezePage() {
    for (const el of deepElements(document)) {
      const sw = el.swiper
      if (sw && typeof sw.slideTo === 'function') {
        try {
          if (sw.autoplay && sw.autoplay.running) { sw.autoplay.stop(); if (sw.slideToLoop) sw.slideToLoop(0, 0, false); else sw.slideTo(0, 0, false) }
        } catch { /* destroyed */ }
      }
      if (el.localName === 'video') el.loop = true
    }
    const $ = window.jQuery
    if ($ && $.fn && $.fn.slick) try { $('.slick-initialized').slick('slickPause').slick('slickGoTo', 0, true) } catch { /* no slick */ }
    const hi = window.setTimeout(() => {}, 0)
    for (let i = Math.max(0, hi - 100000); i <= hi; i++) { window.clearTimeout(i); window.clearInterval(i) }
    if (window.requestAnimationFrame) { const ra = window.requestAnimationFrame(() => {}); for (let i = Math.max(0, ra - 10000); i <= ra; i++) window.cancelAnimationFrame(i) }
    if (!window.__figcapSetInterval) window.__figcapSetInterval = window.setInterval
    window.setInterval = () => 0
  }

  /**
   * Pinned boxes the page moves once it scrolls (a band above the header sliding away, a header hiding): each fixed /
   * sticky box measured at scroll 0, 16 and 400 px; one that moved is tagged `data-figcap-shift="<dy>"` (its offset
   * at 400 px) and `data-figcap-shift-mode` ('scroll': it moves with the page up to that offset, 'step': it jumps
   * there as soon as the page scrolls) for the walk (`SnapElement.scrollShift`).
   */
  async function scrollShifts() {
    const pinned = []
    for (const el of deepElements(document.body)) {
      const p = getComputedStyle(el).position
      if ((p === 'fixed' || p === 'sticky') && visible(el)) pinned.push([el, el.getBoundingClientRect().top])
      if (pinned.length >= 60) break
    }
    if (!pinned.length || document.documentElement.scrollHeight < VH + 420) return
    // (read once the boxes stop moving: a header sliding away on a transition, or after a throttled scroll handler, is
    // caught every run, not only when it happened to finish within a fixed wait)
    const tops = () => pinned.map(([el]) => Math.round(el.getBoundingClientRect().top))
    const at = async (y) => {
      scrollTo(y)
      await sleep(y ? 500 : 300)
      let prev = tops()
      for (let t = 0; t < 10; t++) { await sleep(250); const now = tops(); if (t >= 2 && now.every((v, i) => v === prev[i])) return now; prev = now }
      return prev
    }
    const a16 = await at(16), a400 = await at(400)
    // a header that hides only once the page scrolled further (hide-on-scroll after a threshold)
    const far = document.documentElement.scrollHeight >= VH + 1220 ? await at(1200) : a400
    await at(0)
    pinned.forEach(([el, y0], i) => {
      const late = Math.abs(a400[i] - y0) < 2 && Math.abs(far[i] - y0) >= 2
      const dy = Math.round((late ? far[i] : a400[i]) - y0)
      if (late && Math.abs(dy) >= 2 && Math.abs(dy) <= 400) { el.setAttribute('data-figcap-shift', String(dy)); el.setAttribute('data-figcap-shift-mode', 'step'); el.setAttribute('data-figcap-shift-after', '400'); return }
      // sticky boxes stuck to the top while the page scrolls, or scrolled along with it: no shift of their own
      if (Math.abs(dy) < 2 || Math.abs(dy) > 400 || (getComputedStyle(el).position === 'sticky' && Math.abs(dy + 400) < 2)) return
      const d16 = a16[i] - y0
      el.setAttribute('data-figcap-shift', String(dy))
      el.setAttribute('data-figcap-shift-mode', Math.abs(d16 - Math.max(dy, -16)) < 2 && Math.abs(dy) > 16 ? 'scroll' : 'step')
    })
  }

  if (opts.prepare !== false) {
    await sleep(300)
    await dismissConsent()
    // a resize as real browsers fire it (URL bar, rotation): layouts sized by JS on resize only (NIVEA's 16:9 →
    // portrait media boxes on phones) settle in their final shape
    window.dispatchEvent(new Event('resize'))
    await settle()
    await dismissConsent()
    await dismissRegionDialogs()
    // hints that pop up a moment after scrolling (chat nudges): wait for them; they stay, as a visitor sees them
    await sleep(2300)
    await stable(opts.stableMs || 6000)
    await scrollShifts()
  }
  scrollTo(0)
  await sleep(50)
  // mode 'prepare': the page readied as the capture readies it (consent, lazy content, region dialogs, hints, a stable
  // layout) and nothing else: the live shots compare against the same page (scripts/lib/page-probe.mjs prepareLive)
  if (opts.mode === 'prepare') return { ok: true, height: document.documentElement.scrollHeight }
  // a walk at another width (`alt`): what the resize started loading (a <picture>'s source for this width) is drawn
  // before the boxes are read — an image still loading would be walked as nothing, or as the previous width's picture
  if (opts.alt) {
    const pending = [...document.images].filter((i) => !i.complete || (i.currentSrc && i.naturalWidth === 0))
    if (pending.length) await Promise.race([Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }) }))), sleep(4000)])
    await Promise.race([Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null))), sleep(2000)])
  }
  if (opts.freeze !== false) freezePage()
  const freeze = document.createElement('style')
  freeze.id = '__figcap_freeze'
  freeze.textContent = '*,*::before,*::after{transition:none!important;caret-color:transparent!important}[data-figcap-b]::before{content:none!important}[data-figcap-a]::after{content:none!important}'
  document.head.appendChild(freeze)
  // the capture must not depend on when it ran: entrance animations (fade / slide in) jump to their end state,
  // endless ones (spinners, Ken Burns zooms, marquees) stop at the current frame; scroll-driven ones keep the
  // scroll-0 state they already show
  if (document.getAnimations) {
    for (const a of document.getAnimations()) {
      try {
        if (typeof DocumentTimeline !== 'undefined' && !(a.timeline instanceof DocumentTimeline)) continue
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null
        if (t && Number.isFinite(t.endTime)) a.finish(); else a.pause()
      } catch { /* not finishable */ }
    }
  }
  // content-visibility: auto skips rendering off-screen subtrees: lay them out for real so every box measures
  for (const el of deepElements(document)) if (getComputedStyle(el).contentVisibility === 'auto') el.style.setProperty('content-visibility', 'visible', 'important')
  await sleep(50)

  /* ------------------------------------------------------------------ helpers */

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'source', 'track', 'param', 'datalist', 'option', 'optgroup', 'colgroup', 'col', 'map', 'area', 'slot'])
  const RASTER = new Set(['video', 'canvas', 'iframe', 'object', 'embed', 'audio'])
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c)
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  const absUrl = (u) => { try { return new URL(u, location.href).href } catch { return null } }
  /** a loaded img's pixels as a WebP data URL at its box × 2 (never upscaled); null when the canvas is tainted */
  const blobPixels = (img, r) => {
    try {
      const nw = img.naturalWidth, nh = img.naturalHeight
      const s = Math.min(1, Math.max((r.w * 2) / nw, (r.h * 2) / nh))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(nw * s)); c.height = Math.max(1, Math.round(nh * s))
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      const d = c.toDataURL('image/webp', 0.86)
      return d.startsWith('data:image/webp') ? d : null
    } catch { return null }
  }
  let nextId = 1

  const pageH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)

  /** split a CSS list at top-level commas */
  function splitTop(v) {
    const out = []; let depth = 0, cur = ''
    for (const ch of v) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }

  /** materialise ::before / ::after with content as real spans */
  function parseContent(c, el) {
    if (!c || c === 'none' || c === 'normal') return null
    let text = '', url = null
    const unescape = (s) => s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1')
    // url() first, its quoted form with escapes: a data: SVG holds `\"` (`url("data:image/svg+xml,<svg a=\"b\">")`)
    const re = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"')\s]+))\s*\)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)|counter\([^)]*\)|open-quote|close-quote|\//g
    let m
    while ((m = re.exec(c))) {
      // `content: url(…) / "alt"`: what follows the slash is the accessible text, not drawn
      if (m[0] === '/') break
      if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined) url = absUrl(unescape(m[1] ?? m[2] ?? m[3]))
      else if (m[4] !== undefined || m[5] !== undefined) text += unescape(m[4] ?? m[5])
      else if (m[6]) text += el.getAttribute(m[6]) || ''
      else if (m[0] === 'open-quote') text += '„'
      else if (m[0] === 'close-quote') text += '“'
    }
    return { text, url }
  }
  function materialisePseudos(root) {
    const els = [...deepElements(root)]
    for (const el of els) {
      if (SKIP.has(el.localName) || RASTER.has(el.localName) || el.localName === 'svg' || el.closest('svg') || /^(img|input|textarea|select|br|hr)$/.test(el.localName)) continue
      for (const which of ['::before', '::after']) {
        const pcs = getComputedStyle(el, which)
        if (pcs.display === 'none') continue
        const content = parseContent(pcs.content, el)
        if (!content) continue
        const span = document.createElement(content.url && !content.text ? 'img' : 'span')
        for (let i = 0; i < pcs.length; i++) {
          const name = pcs[i]
          if (name === 'content' || name.startsWith('transition') || name.startsWith('animation')) continue
          span.style.setProperty(name, pcs.getPropertyValue(name))
        }
        span.setAttribute('data-figcap-pseudo', which.slice(2))
        if (content.url && !content.text) span.src = content.url
        else span.textContent = content.text
        if (which === '::before') { el.setAttribute('data-figcap-b', ''); (el.shadowRoot || el).insertBefore(span, (el.shadowRoot || el).firstChild) } else { el.setAttribute('data-figcap-a', ''); (el.shadowRoot || el).appendChild(span) }
      }
    }
  }
  // tags of an earlier walk of this page (the state walk after the menu opened): ids are per walk
  for (const el of deepElements(document)) { el.removeAttribute('data-figcap-id'); if (!opts.state && !opts.alt) el.removeAttribute('data-figcap-menu') }
  // `menu`: the navigation toggle is tagged for the walk (its id → `marks.trigger`) and for mode 'menu-open'
  let menuLabel
  if (opts.menu) {
    untag('trigger')
    const m = findMenuTrigger()
    window.__figcapMenuTrigger = m ? m.el : null
    if (m) { m.el.setAttribute('data-figcap-menu', 'trigger'); menuLabel = m.label }
  }
  // `states`: the controls that change their widget in place, tagged for the walk (→ `controls`) and the state modes
  if (opts.states && !opts.state) {
    for (const el of deepElements(document)) el.removeAttribute('data-figcap-ctl')
    window.__figcapCtl = findStateControls()
    // one element can stand for several controls (a drop-down's options): every index it is
    window.__figcapCtl.forEach((c, k) => c.el.setAttribute('data-figcap-ctl', [...(c.el.getAttribute('data-figcap-ctl') || '').split(' ').filter(Boolean), String(k)].join(' ')))
  }
  if (opts.pseudo !== false) materialisePseudos(document.body)
  await sleep(50)

  const rectOf = (r) => ({ x: round(r.left + window.scrollX), y: round(r.top + window.scrollY), w: round(r.width), h: round(r.height) })
  const intersects = (a, c) => !c || (a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y)
  const intersect = (a, b) => { if (!b) return a; const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y); return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) } }

  /** webfont families actually loaded */
  const webfonts = new Set()
  if (document.fonts) for (const f of document.fonts) if (f.status === 'loaded') webfonts.add(f.family.replace(/["']/g, '').trim().toLowerCase())
  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont'])
  function renderedFamily(stack) {
    const fams = splitTop(stack).map((f) => f.replace(/["']/g, '').trim())
    for (const f of fams) if (webfonts.has(f.toLowerCase())) return f
    return fams.find((f) => !GENERIC.has(f.toLowerCase())) || fams[0] || 'sans-serif'
  }
  const usedFonts = new Map()
  let mctx = null
  const measureCtx = () => mctx || (mctx = document.createElement('canvas').getContext('2d'))

  /** font ascent (px) of the face that draws the text: line rect top + ascent = baseline */
  const ascents = new Map()
  function ascentOf(cs, family) {
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} "${family}"`
    if (!ascents.has(font)) { const g = measureCtx(); g.font = font; ascents.set(font, round(g.measureText('x').fontBoundingBoxAscent)) }
    return ascents.get(font)
  }
  /**
   * Symbols the webfont lacks (◄ ► ✓ …) are drawn by a later family of the stack: name that family so the design
   * does not fall back differently. Canvas probe: the first stack prefix whose width changes when a family is added
   * is the family that draws the glyphs. Only for text outside Latin.
   */
  function coveringFamily(cs, family, text) {
    const chars = [...text].filter((c) => c.codePointAt(0) > 0x24f && !/[\s\u2000-\u206f\u20ac]/.test(c)).filter((c, i, a) => a.indexOf(c) === i).join('')
    if (!chars || !webfonts.has(family.toLowerCase())) return null
    const fams = splitTop(cs.fontFamily).map((x) => x.replace(/["']/g, '').trim())
    const i0 = fams.findIndex((f) => f.toLowerCase() === family.toLowerCase())
    if (i0 < 0) return null
    const g = measureCtx()
    const w = (list) => { g.font = `${cs.fontStyle} ${cs.fontWeight} 40px ${list.map((f) => (GENERIC.has(f.toLowerCase()) ? f : `"${f}"`)).join(', ')}`; return g.measureText(chars).width }
    let prev = w(fams.slice(0, i0 + 1))
    for (let i = i0 + 1; i < fams.length; i++) {
      const cur = w(fams.slice(0, i + 1))
      if (cur !== prev) return GENERIC.has(fams[i].toLowerCase()) ? null : fams[i]
      prev = cur
    }
    return null
  }
  /**
   * text-decoration of the nearest ancestor that draws one (decorations propagate, computed values don't): to every
   * in-flow child, blocks inside an underlined span too (vw.com's "Explore and personalize your model"); atomic inlines,
   * floats and absolutely positioned boxes stop it
   */
  function decoSource(el, cs) {
    let e = el, c = cs
    for (let i = 0; e && i < 6; i++) {
      if (c.textDecorationLine && c.textDecorationLine !== 'none') return c
      if (/^inline-(block|flex|grid|table)$/.test(c.display) || c.float !== 'none' || c.position === 'absolute' || c.position === 'fixed') return null
      e = e.parentElement
      c = e ? getComputedStyle(e) : null
    }
    return null
  }
  /** -webkit-line-clamp of the text's block (set on the clamping box, inherited by nothing): lines past it end in … */
  function lineClampOf(el, cs) {
    for (let e = el, c = cs, i = 0; e && i < 4; i++) {
      const n = parseInt(c.webkitLineClamp, 10)
      if (n > 0) return n
      if (!/^inline/.test(c.display)) break
      e = e.parentElement; c = e ? getComputedStyle(e) : null
    }
    return undefined
  }
  function fontOf(cs, el) {
    const family = renderedFamily(cs.fontFamily)
    const weight = Number(cs.fontWeight) || 400
    const key = `${family}|${weight}|${cs.fontStyle}`
    if (!usedFonts.has(key)) usedFonts.set(key, { family, weight, style: cs.fontStyle === 'normal' ? 'normal' : 'italic', stack: cs.fontFamily })
    const dc = el ? decoSource(el, cs) : cs.textDecorationLine !== 'none' ? cs : null
    const deco = dc ? { line: dc.textDecorationLine, color: dc.textDecorationColor, thickness: dc.textDecorationThickness, style: dc.textDecorationStyle, offset: dc.textUnderlineOffset } : undefined
    const fill = cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color && !transparent(cs.webkitTextFillColor) ? cs.webkitTextFillColor : cs.color
    // gradient text: a transparent fill showing the background of a box clipped to its text (itself or a near ancestor)
    let clipBg
    if (el && transparent(fill)) {
      for (let a = el, i = 0; a && a.nodeType === 1 && i < 4; a = a.parentElement, i++) {
        const as = a === el ? cs : getComputedStyle(a)
        if ((as.backgroundClip === 'text' || as.webkitBackgroundClip === 'text') && as.backgroundImage && as.backgroundImage !== 'none') { clipBg = as.backgroundImage; break }
      }
    }
    return {
      ...(clipBg ? { clipBg } : {}),
      family, stack: cs.fontFamily, size: px(cs.fontSize), weight, ascent: ascentOf(cs, family), italic: cs.fontStyle !== 'normal' || undefined,
      lineHeight: cs.lineHeight === 'normal' ? null : px(cs.lineHeight), letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
      color: fill, transform: cs.textTransform !== 'none' ? cs.textTransform : undefined, decoration: deco,
      align: cs.textAlign, whiteSpace: cs.whiteSpace, shadow: cs.textShadow !== 'none' ? cs.textShadow : undefined,
      features: cs.fontFeatureSettings !== 'normal' ? cs.fontFeatureSettings : undefined,
      textWrap: /balance|pretty/.exec(`${cs.textWrapStyle || ''} ${cs.textWrap || ''}`)?.[0],
      hyphens: (cs.hyphens || cs.webkitHyphens) === 'auto' ? 'auto' : undefined,
      wordSpacing: px(cs.wordSpacing) || undefined,
      variation: cs.fontVariationSettings && cs.fontVariationSettings !== 'normal' ? cs.fontVariationSettings : undefined,
      stretch: cs.fontStretch && cs.fontStretch !== '100%' && cs.fontStretch !== 'normal' ? cs.fontStretch : undefined,
      stroke: px(cs.webkitTextStrokeWidth) > 0 && !transparent(cs.webkitTextStrokeColor) ? { w: px(cs.webkitTextStrokeWidth), color: cs.webkitTextStrokeColor } : undefined,
      verticalAlign: /^(super|sub)$/.test(cs.verticalAlign) ? cs.verticalAlign : undefined,
      lineClamp: lineClampOf(el, cs),
    }
  }

  /** text node → rendered lines (char-level measurement, handles wrapping and hyphenation) */
  function textLines(node, clip) {
    const data = node.data
    const range = document.createRange()
    const lines = []
    let cur = null
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i)
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) continue
      // surrogate pairs: measure both units together
      const len = ch >= 0xd800 && ch <= 0xdbff ? 2 : 1
      range.setStart(node, i); range.setEnd(node, i + len)
      const rs = range.getClientRects()
      if (len === 2) i++
      if (!rs.length) continue
      // a char right after a hyphenation point reports [hyphen on the previous line, glyph]: the glyph is the last rect
      let r = rs[rs.length - 1]
      for (let j = rs.length - 1; j >= 0; j--) if (rs[j].width > 0) { r = rs[j]; break }
      if (r.width === 0 && r.height === 0) continue
      // …and that hyphen is drawn at the end of the previous line: it belongs to that line's box
      if (cur && rs.length > 1) for (const h of rs) if (h !== r && h.width > 0 && h.top < cur.bottom - 1 && h.bottom > cur.top + 1 && h.left >= cur.right - 2) cur.right = Math.max(cur.right, h.right)
      if (cur && r.top < cur.bottom - 1 && r.left >= cur.right - 2) { cur.end = i + 1; cur.right = Math.max(cur.right, r.right); cur.bottom = Math.max(cur.bottom, r.bottom); cur.top = Math.min(cur.top, r.top); continue }
      // drawn right to left on the same row (a mirrored / 180°-rotated box, RTL script): still the same line
      if (cur && Math.abs(r.top - cur.top) < 1 && Math.abs(r.bottom - cur.bottom) < 1 && r.right <= cur.left + 2 && r.left < cur.left) { cur.end = i + 1; cur.left = r.left; continue }
      cur = { start: i + 1 - len, end: i + 1, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
      lines.push(cur)
    }
    const out = []
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k]
      range.setStart(node, l.start); range.setEnd(node, l.end)
      // union of this line's own fragments only (a range starting right after a hyphenation point also reports the
      // hyphen on the line above: its bounding rect would span both lines)
      let x0 = l.left, x1 = l.right, y0 = l.top, y1 = l.bottom
      for (const f of range.getClientRects()) {
        if (f.width <= 0 && f.height <= 0) continue
        const mid = (f.top + f.bottom) / 2
        if (mid < l.top - 1 || mid > l.bottom + 1) continue
        x0 = Math.min(x0, f.left); x1 = Math.max(x1, f.right); y0 = Math.min(y0, f.top); y1 = Math.max(y1, f.bottom)
      }
      const rect = rectOf({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
      if (!intersects(rect, clip)) continue
      const next = lines[k + 1]
      const gap = next ? data.slice(l.end, next.start) : ''
      const text = data.slice(l.start, l.end)
      out.push({ text, ...rect, brk: next ? (/\s/.test(gap) ? 'space' : /[-‐–—/]$/.test(text) ? 'join' : 'word') : undefined })
    }
    return out
  }

  /** box-level computed styles (only non-default values) */
  function boxStyle(el, cs, rect) {
    const s = {}
    if (!transparent(cs.backgroundColor)) s.bg = cs.backgroundColor
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const imgs = splitTop(cs.backgroundImage), sizes = splitTop(cs.backgroundSize), poss = splitTop(cs.backgroundPosition), reps = splitTop(cs.backgroundRepeat)
      const clips = splitTop(cs.backgroundClip), origins = splitTop(cs.backgroundOrigin), atts = splitTop(cs.backgroundAttachment), blends = splitTop(cs.backgroundBlendMode || 'normal')
      s.bgLayers = imgs.map((img, i) => {
        const u = /^url\(\s*["']?(.*?)["']?\s*\)$/.exec(img)
        const l = { image: u ? absUrl(u[1]) : img, url: !!u, size: sizes[i % sizes.length], position: poss[i % poss.length], repeat: reps[i % reps.length] }
        // non-default painting / positioning area, fixed attachment, blending with the layers below
        const clip = clips[i % clips.length], origin = origins[i % origins.length], att = atts[i % atts.length], blend = blends[i % blends.length]
        if (clip && clip !== 'border-box' && clip !== 'text') l.clip = clip
        if (origin && origin !== 'padding-box') l.origin = origin
        if (att === 'fixed') l.attachment = 'fixed'
        if (blend && blend !== 'normal') l.blend = blend
        return l
      }).filter((l) => l.image && l.image !== 'none')
      if (!s.bgLayers.length) delete s.bgLayers
      if (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text') s.bgClipText = true
    }
    const sides = ['Top', 'Right', 'Bottom', 'Left']
    const b = sides.map((sd) => ({ w: px(cs[`border${sd}Width`]), style: cs[`border${sd}Style`], color: cs[`border${sd}Color`] }))
    if (b.some((x) => x.w > 0 && x.style !== 'none' && x.style !== 'hidden' && !transparent(x.color))) s.border = b.map((x) => (x.w > 0 && x.style !== 'none' && x.style !== 'hidden' && !transparent(x.color) ? x : null))
    const corners = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((c) => cs[`border${c}Radius`].split(' '))
    const radius = corners.map(([v]) => (v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(rect.w, rect.h) : px(v)))
    if (radius.some((r) => r > 0)) s.radius = radius.map((r) => round(Math.min(r, Math.max(rect.w, rect.h))))
    // elliptical corners (`30px / 12px`, 50% of a non-square box): the used [horizontal, vertical] radii, scaled down
    // like CSS does when adjacent radii overlap
    const ref = (v, len) => (v.endsWith('%') ? (parseFloat(v) / 100) * len : px(v))
    const W = el.offsetWidth || rect.w, H = el.offsetHeight || rect.h
    const xy = corners.map(([a, b]) => [ref(a, W), ref(b === undefined ? a : b, H)])
    if (xy.some(([a, b]) => Math.abs(a - b) > 0.01)) {
      const f = Math.min(1, W / (xy[0][0] + xy[1][0] || 1), W / (xy[3][0] + xy[2][0] || 1), H / (xy[0][1] + xy[3][1] || 1), H / (xy[1][1] + xy[2][1] || 1))
      s.radii = xy.map(([a, b]) => [round(a * f), round(b * f)])
    }
    // background colour painted only inside the padding / content box
    if (s.bg && cs.backgroundClip && /^(padding-box|content-box)/.test(cs.backgroundClip)) s.bgClip = splitTop(cs.backgroundClip).pop()
    if (cs.borderImageSource && cs.borderImageSource !== 'none') {
      const u = /^url\(\s*["']?(.*?)["']?\s*\)$/.exec(cs.borderImageSource)
      s.borderImage = { source: u ? absUrl(u[1]) : cs.borderImageSource, url: !!u, slice: cs.borderImageSlice, width: cs.borderImageWidth, outset: cs.borderImageOutset, repeat: cs.borderImageRepeat }
    }
    if (cs.boxShadow && cs.boxShadow !== 'none') s.shadow = cs.boxShadow
    if (cs.outlineStyle !== 'none' && px(cs.outlineWidth) > 0 && !transparent(cs.outlineColor)) s.outline = { w: px(cs.outlineWidth), color: cs.outlineColor, offset: px(cs.outlineOffset), style: cs.outlineStyle }
    const op = Number(cs.opacity)
    if (op < 1) s.opacity = op
    if (cs.mixBlendMode !== 'normal') s.blend = cs.mixBlendMode
    if (cs.filter !== 'none') s.filter = cs.filter
    if (cs.backdropFilter && cs.backdropFilter !== 'none') s.backdrop = cs.backdropFilter
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') s.overflow = [cs.overflowX, cs.overflowY]
    if (cs.clipPath && cs.clipPath !== 'none') s.clipPath = cs.clipPath
    if (cs.transform && cs.transform !== 'none') s.transform = cs.transform
    if (cs.color) s.color = cs.color
    return s
  }

  /** does the box establish a stacking context (its z-indexed descendants are painted inside it)? */
  /** the box whose layout places el (flat tree: slots and display: contents boxes are skipped) */
  function layoutParent(el) {
    let p = el.assignedSlot || el.parentElement || (el.parentNode && el.parentNode.host) || null
    for (let i = 0; p && i < 32; i++) {
      if (p.localName !== 'slot' && getComputedStyle(p).display !== 'contents') return p
      p = p.assignedSlot || p.parentElement || (p.parentNode && p.parentNode.host) || null
    }
    return null
  }
  function stackingContext(cs, el) {
    const p = cs.position
    if (p === 'fixed' || p === 'sticky') return true
    if (cs.zIndex !== 'auto') {
      if (p !== 'static') return true
      // z-index on a static box only counts for flex / grid items
      const lp = layoutParent(el)
      if (lp && /flex|grid/.test(getComputedStyle(lp).display)) return true
    }
    if (Number(cs.opacity) < 1 || cs.mixBlendMode !== 'normal' || cs.isolation === 'isolate') return true
    for (const k of ['transform', 'translate', 'rotate', 'scale', 'filter', 'backdropFilter', 'perspective', 'clipPath', 'maskImage', 'webkitMaskImage']) {
      const v = cs[k]
      if (v && v !== 'none') return true
    }
    if (/\b(paint|layout|strict|content)\b/.test(cs.contain || '')) return true
    if (/size/.test(cs.containerType || '')) return true
    return /\b(opacity|transform|translate|rotate|scale|filter|perspective|clip-path|mask|isolation|z-index)\b/.test(cs.willChange || '')
  }

  function layoutInfo(cs, el) {
    const d = cs.display
    const out = { display: d, position: cs.position }
    if (cs.position !== 'static' && cs.zIndex !== 'auto') out.z = Number(cs.zIndex)
    if (d !== 'contents' && stackingContext(cs, el)) out.stack = true
    if (/flex/.test(d)) Object.assign(out, { dir: cs.flexDirection, wrap: cs.flexWrap, justify: cs.justifyContent, align: cs.alignItems, gap: [px(cs.rowGap), px(cs.columnGap)] })
    if (/grid/.test(d)) Object.assign(out, { cols: cs.gridTemplateColumns, rows: cs.gridTemplateRows, gap: [px(cs.rowGap), px(cs.columnGap)], justify: cs.justifyContent, align: cs.alignItems })
    const pad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px)
    if (pad.some((p) => p)) out.padding = pad
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px)
    if (bw.some((p) => p)) out.borderWidth = bw
    if (cs.alignSelf !== 'auto') out.alignSelf = cs.alignSelf
    if (cs.flexGrow !== '0') out.grow = Number(cs.flexGrow)
    return out
  }

  function attrsOf(el) {
    const a = {}
    for (const k of ['id', 'class', 'role', 'aria-label', 'alt', 'title', 'href', 'type', 'name', 'data-testid']) {
      let v = k === 'class' ? (typeof el.className === 'string' ? el.className : el.getAttribute('class')) : el.getAttribute(k)
      if (k === 'href' && v) v = absUrl(v)
      if (v) a[k] = String(v).slice(0, 200)
    }
    return a
  }

  /** inline SVG with computed paint inlined (classes / CSS / currentColor no longer needed) */
  const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-miterlimit', 'opacity', 'stop-color', 'stop-opacity', 'clip-rule', 'visibility', 'display', 'transform-origin']
  const PAINT_EXTRA = ['stroke-dashoffset', 'clip-path', 'mask', 'filter', 'vector-effect', 'paint-order', 'mix-blend-mode', 'marker-start', 'marker-mid', 'marker-end', 'shape-rendering']
  const SVG_FONT = ['font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'text-decoration-line']
  function svgMarkup(svg, rect) {
    const clone = svg.cloneNode(true)
    const src = [svg, ...svg.querySelectorAll('*')]
    const dst = [clone, ...clone.querySelectorAll('*')]
    let unresolved = false
    const externals = []
    for (let i = 0; i < src.length; i++) {
      const s = src[i], d = dst[i]
      if (!d || d.nodeType !== 1) continue
      const cs = getComputedStyle(s)
      if (cs.display === 'none' && i > 0) { d.setAttribute('display', 'none'); continue }
      for (const p of PAINT) {
        let v = cs.getPropertyValue(p)
        if (!v || (p === 'transform-origin')) continue
        if (p === 'display' || p === 'visibility') { if (v === 'hidden' || v === 'none') d.setAttribute(p, v); continue }
        if (/url\(/.test(v)) v = v.replace(/url\(\s*["']?[^#"')]*(#[^"')]+)["']?\s*\)/g, 'url($1)')
        d.setAttribute(p, v)
      }
      // set through classes (lost with them): only when not the initial value
      for (const p of PAINT_EXTRA) {
        let v = cs.getPropertyValue(p)
        if (!v || v === 'none' || v === 'normal' || v === 'auto' || v === '0px') continue
        if (/url\(/.test(v)) v = v.replace(/url\(\s*["']?[^#"')]*(#[^"')]+)["']?\s*\)/g, 'url($1)')
        d.setAttribute(p, v)
      }
      if (/^(text|tspan|textPath)$/.test(d.localName)) for (const p of SVG_FONT) { const v = cs.getPropertyValue(p); if (v && v !== 'normal' && v !== 'auto') d.setAttribute(p, v) }
      if (cs.transform && cs.transform !== 'none' && !s.getAttribute('transform') && i > 0) d.setAttribute('transform', cs.transform.replace(/px/g, ''))
      d.removeAttribute('class'); d.removeAttribute('style')
      // raster <image>: absolute URL (the markup leaves the page)
      if (d.localName === 'image') {
        const href = s.getAttribute('href') || s.getAttribute('xlink:href') || ''
        if (href && !href.startsWith('data:')) { const abs = absUrl(href); d.removeAttribute('xlink:href'); if (abs) d.setAttribute('href', abs) }
      }
      if (d.localName === 'use') {
        const href = s.getAttribute('href') || s.getAttribute('xlink:href') || ''
        if (href.startsWith('#')) {
          const target = svg.ownerDocument.getElementById(href.slice(1)) || (svg.getRootNode().getElementById ? svg.getRootNode().getElementById(href.slice(1)) : null)
          if (target && !svg.contains(target)) {
            const inner = svgMarkup(target, null)
            if (inner.unresolved) unresolved = true
            const vb = target.getAttribute('viewBox')
            const g = document.createElementNS('http://www.w3.org/2000/svg', vb ? 'svg' : 'g')
            if (vb) { g.setAttribute('viewBox', vb); for (const k of ['x', 'y', 'width', 'height']) { const v = s.getAttribute(k); if (v) g.setAttribute(k, v) } if (!s.getAttribute('width')) { g.setAttribute('width', '100%'); g.setAttribute('height', '100%') } }
            g.innerHTML = inner.inner
            for (const p of PAINT) { const v = d.getAttribute(p); if (v && !g.getAttribute(p)) g.setAttribute(p, v) }
            d.replaceWith(g)
          } else if (!target) unresolved = true
        } else if (href) {
          // external sprite (`/icons.svg#name`): the driver fetches it and inlines the symbol
          const abs = absUrl(href)
          if (abs) { d.removeAttribute('xlink:href'); d.setAttribute('href', abs); externals.push(abs) } else unresolved = true
        }
      }
    }
    for (const n of clone.querySelectorAll('script, foreignObject')) { unresolved = unresolved || n.localName === 'foreignObject'; n.remove() }
    // paint servers / clips / masks / filters referenced by id but defined elsewhere on the page (a shared hidden
    // `<svg><defs>` sprite): copy them in, else the icon loses its gradient or clip
    if (rect) {
      const have = new Set([...clone.querySelectorAll('[id]')].map((n) => n.id))
      const scope = svg.getRootNode()
      let defs = null
      for (let pass = 0; pass < 4; pass++) {
        const want = new Set()
        for (const n of [clone, ...clone.querySelectorAll('*')]) {
          for (const a of n.attributes) {
            for (const m of a.value.matchAll(/url\(\s*["']?#([^"')]+)["']?\s*\)/g)) want.add(m[1])
            if ((a.name === 'href' || a.name === 'xlink:href') && a.value.startsWith('#') && /^(linearGradient|radialGradient|pattern|filter)$/.test(n.localName)) want.add(a.value.slice(1))
          }
        }
        let added = false
        for (const id of want) {
          if (have.has(id)) continue
          have.add(id)
          let target = null
          try { target = (scope.getElementById ? scope.getElementById(id) : null) || document.getElementById(id) } catch { /* bad id */ }
          if (!target || !(target instanceof window.SVGElement) || svg.contains(target)) continue
          const copy = svgMarkup(target, null)
          const holder = document.createElementNS('http://www.w3.org/2000/svg', 'g')
          holder.innerHTML = copy.markup
          if (!defs) { defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); clone.insertBefore(defs, clone.firstChild) }
          for (const k of [...holder.childNodes]) defs.appendChild(k)
          added = true
        }
        if (!added) break
      }
    }
    if (rect) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(rect.w)); clone.setAttribute('height', String(rect.h))
      clone.setAttribute('color', getComputedStyle(svg).color)
      if (!clone.getAttribute('viewBox')) {
        try { const bb = svg.viewBox && svg.viewBox.baseVal; if (!bb || !bb.width) clone.setAttribute('viewBox', `0 0 ${rect.w} ${rect.h}`) } catch { /* no viewBox */ }
      }
      for (const a of [...clone.attributes]) if (/^on/i.test(a.name)) clone.removeAttribute(a.name)
    }
    const markup = new XMLSerializer().serializeToString(clone)
    return { markup, inner: clone.innerHTML, unresolved, externals }
  }

  /** opt-in (`fixedToPageBottom`): fixed element anchored to the viewport bottom → page bottom, like a stitched full-page shot; by default fixed boxes stay where they sit at scroll 0 */
  function fixedShift(el, cs, r) {
    if (cs.position !== 'fixed' || !opts.fixedToPageBottom) return 0
    if (cs.bottom !== 'auto' && (cs.top === 'auto' || r.top > VH / 2) && r.height < VH * 0.6) return pageH - VH
    return 0
  }

  /* ------------------------------------------------------------------ walk */

  function flatChildren(el) {
    const root = el.shadowRoot || el
    const out = []
    const push = (n) => {
      if (n.nodeType === 1 && n.localName === 'slot') {
        const assigned = n.assignedNodes({ flatten: true })
        if (assigned.length) assigned.forEach(push); else n.childNodes.forEach(push)
      } else out.push(n)
    }
    root.childNodes.forEach(push)
    return out
  }

  const firstLine = (n) => {
    for (const c of n.children || []) {
      if (c.kind === 'text' && c.lines.length) return { ...c.lines[0], ascent: c.font.ascent }
      if (c.children) { const l = firstLine(c); if (l) return l }
    }
    return null
  }

  let count = 0
  const MAX = opts.maxNodes || 60000
  const tagged = []
  const ctlIds = new Map()

  /* ------------------------------------------------------------------ carousels */

  const scrollers = [], controls = []
  const CAROUSEL_RE = /carousel|slider|swiper|splide|slick|glide|flickity|embla|keen-slider|owl-|scroller|slides|track/i
  const NEXT_RE = /n[äa]chst|\bnext\b|vorw[äa]rts|forward|suivant|siguiente|successiv|(arrow|chevron)[-_]?right|[-_]next\b/i
  const PREV_RE = /vorherig|previous|\bprev\b|zur[üu]ck|r[üu]ckw[äa]rts|backward|pr[ée]c[ée]dent|anterior|(arrow|chevron)[-_]?left|[-_]prev\b/i
  const namesOf = (el) => `${classOf(el)} ${el.id || ''} ${el.getAttribute('data-testid') || ''}`
  /**
   * A row of slides inside `el` (itself or up to two levels down): two or more boxes side by side, one of them starting
   * at or past el's right edge (scrolled / translated out of view).
   */
  function slideRow(el, r) {
    let level = [el]
    for (let d = 0; d < 3 && level.length; d++) {
      for (const p of level) {
        const kids = [...p.children].map((c) => c.getBoundingClientRect()).filter((k) => k.width > 20 && k.height > 20)
        if (kids.length >= 2 && kids.every((k) => Math.abs(k.top - kids[0].top) < 4) && kids.some((k) => k.left >= r.right - 1)) return true
      }
      level = level.flatMap((p) => [...p.children])
      if (level.length > 40) return false
    }
    return false
  }
  /**
   * `{ axis, kind, snap? }` when the box scrolls its content: a native scroller (overflow auto / scroll with content past
   * its box) or a slide track (overflow hidden around a row of slides moved by transform: Splide, Swiper, Slick…).
   * Vertical panes count on the page only when smaller than the viewport (an app-shell scroller is the page itself);
   * in a state walk (the open menu drawer) they always do.
   */
  function scrollerOf(el, cs, rect) {
    if (el === document.body || el === document.documentElement || rect.w < 60 || rect.h < 20) return null
    const sx = /auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2
    const sy = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2
    const snap = cs.scrollSnapType && cs.scrollSnapType !== 'none' ? cs.scrollSnapType : undefined
    if (sx && (!sy || el.scrollWidth - el.clientWidth >= el.scrollHeight - el.clientHeight)) return { axis: 'x', kind: 'scroll', ...(snap ? { snap } : {}) }
    if (sy && (opts.state || rect.h < VH * 0.9)) return { axis: 'y', kind: 'scroll', ...(snap ? { snap } : {}) }
    if (sx || sy || !/hidden|clip/.test(cs.overflowX) || el.scrollWidth <= el.clientWidth + 20) return null
    let named = CAROUSEL_RE.test(namesOf(el))
    for (let p = el.parentElement, i = 0; p && i < 3 && !named; p = p.parentElement, i++) named = CAROUSEL_RE.test(namesOf(p)) || /carousel/i.test(p.getAttribute('aria-roledescription') || '')
    if (!named) for (const c of el.children) if (CAROUSEL_RE.test(namesOf(c))) named = true
    return named && slideRow(el, el.getBoundingClientRect()) ? { axis: 'x', kind: 'track' } : null
  }
  /** a previous / next arrow of a slider: a small button whose label or class reads next / previous */
  function isCarouselControl(el) {
    const tag = el.localName
    const href = tag === 'a' ? (el.getAttribute('href') || '').trim() : ''
    if (!(tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'a' && (!href || /^(#|javascript:)/i.test(href))))) return false
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8 || r.width > 160 || r.height > 160) return false
    const words = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${namesOf(el)}`
    return NEXT_RE.test(words) !== PREV_RE.test(words)
  }
  /**
   * Arrows → the slider they move: the scroller in the nearest ancestor that holds one (several: the closest
   * vertically), within 400px. `node.carousel = { dir: 1 | -1, scroller: <node id>, disabled? }`.
   */
  function linkCarouselControls() {
    for (const { el, node } of controls) {
      const words = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${namesOf(el)}`
      const r = el.getBoundingClientRect()
      let best = null
      for (let a = el.parentElement || el.getRootNode().host, i = 0; a && i < 8 && !best; a = a.parentElement || (a.parentNode && a.parentNode.host), i++) {
        let gap = 400
        for (const s of scrollers) {
          if (s.node.scroller.axis !== 'x' || !inside(a, s.el)) continue
          const b = s.el.getBoundingClientRect()
          const d = Math.max(0, b.top - r.bottom, r.top - b.bottom)
          if (d <= gap) { gap = d; best = s }
        }
      }
      if (!best) continue
      const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || /(^|[-_\s])disabled\b/i.test(classOf(el))
      node.carousel = { dir: NEXT_RE.test(words) ? 1 : -1, scroller: best.node.id, ...(disabled ? { disabled: true } : {}) }
    }
  }

  function walk(el, clip, shift) {
    if (++count > MAX) return null
    const tag = el.localName
    if (SKIP.has(tag)) return null
    const cs = getComputedStyle(el)
    if (cs.display === 'none') return null
    if (Number(cs.opacity) === 0) return null
    // the consent tool's own layer (OneTrust's reopen badge floating over every page): consent UI, not the site's design
    if (el.id === 'onetrust-consent-sdk' || el.id === 'ot-sdk-btn-floating') return null
    // a nudge of a fixed bar (bmw.de's AI-assistant teaser next to its chat button) pops up for a few seconds after the
    // visitor scrolls and fades again: not the page at rest (a coachmark that stays is no "nudge" and is kept)
    if (/(^|[-_\s])nudge($|[-_\s])/i.test(typeof el.className === 'string' ? el.className : '') && (() => { for (let a = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).position === 'fixed') return true; return false })()) return null
    const hidden = cs.visibility !== 'visible'
    const r = el.getBoundingClientRect()
    const myShift = shift || fixedShift(el, cs, r)
    const rect = rectOf(r)
    rect.y = round(rect.y + myShift)
    // screen-reader-only and collapsed boxes
    if (cs.display !== 'contents' && (cs.overflow !== 'visible' || cs.clip !== 'auto') && rect.w <= 2 && rect.h <= 2) return null
    if (cs.display !== 'contents' && cs.position !== 'static' && rect.w > 0 && !intersects(rect, clip) && !el.querySelector('*')) return null
    const node = { id: nextId++, tag, rect, layout: layoutInfo(cs, el), attrs: attrsOf(el), style: {}, children: [] }
    if (el.hasAttribute('data-figcap-menu')) tagged.push([el.getAttribute('data-figcap-menu'), node.id])
    if (el.hasAttribute('data-figcap-ctl')) for (const k of el.getAttribute('data-figcap-ctl').split(' ')) ctlIds.set(Number(k), node.id)
    // the page's own walk: every box remembers its id (a widget state names its region by it)
    if (opts.alt) { if (el.__figcapBase !== undefined) node.base = el.__figcapBase } else if (!opts.state) el.__figcapBase = node.id
    if (el.hasAttribute('data-figcap-pseudo')) node.pseudo = el.getAttribute('data-figcap-pseudo')
    if (el.hasAttribute('data-figcap-shift')) node.scrollShift = { dy: Number(el.getAttribute('data-figcap-shift')), mode: el.getAttribute('data-figcap-shift-mode') === 'scroll' ? 'scroll' : 'step', ...(el.hasAttribute('data-figcap-shift-after') ? { after: Number(el.getAttribute('data-figcap-shift-after')) } : {}) }
    if (cs.display === 'contents') node.contents = true
    else if (!hidden) node.style = boxStyle(el, cs, rect)
    if (hidden) node.hidden = true
    if (cs.transform && cs.transform !== 'none') node.size = { w: el.offsetWidth || rect.w, h: el.offsetHeight || rect.h }
    if (cs.cursor === 'pointer') node.pointer = true
    // children clip rect
    let childClip = clip
    // a visibility: hidden box records no style but still clips its (visible) descendants: a collapsed menu wrapper
    const clipsKids = cs.display !== 'contents' && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible')
    if (clipsKids || (cs.clipPath && /^inset/.test(cs.clipPath))) {
      const bw = node.layout.borderWidth || [0, 0, 0, 0]
      const box = { x: rect.x + bw[3], y: rect.y + bw[0], w: rect.w - bw[1] - bw[3], h: rect.h - bw[0] - bw[2] }
      const ox = cs.overflowX !== 'visible', oy = cs.overflowY !== 'visible'
      childClip = intersect({ x: ox ? box.x : -1e6, y: oy ? box.y : -1e6, w: ox ? box.w : 2e6, h: oy ? box.h : 2e6 }, clip)
    }
    if (!intersects(rect, clip) && (rect.w > 0 || rect.h > 0) && !node.contents && cs.overflow !== 'visible') return null
    // carousels / scrolling panes keep what is scrolled (or translated) out of view along their axis: the converter
    // makes them scrolling frames
    const sc = !hidden && clipsKids ? scrollerOf(el, cs, rect) : null
    if (sc) {
      node.scroller = sc
      scrollers.push({ el, node })
      childClip = sc.axis === 'x' ? { x: -1e6, w: 2e6, y: childClip.y, h: childClip.h } : { x: childClip.x, w: childClip.w, y: -1e6, h: 2e6 }
    }
    if (isCarouselControl(el)) controls.push({ el, node })

    // CSS mask-image (icons painted as background-colour through an SVG mask, fade-outs): one url / gradient layer is
    // kept as data (recolourable in the design); anything more complex becomes a screenshot of the box
    const mask = cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage : cs.webkitMaskImage && cs.webkitMaskImage !== 'none' ? cs.webkitMaskImage : null
    if (mask && !hidden && rect.w > 0 && rect.h > 0) {
      const layers = splitTop(mask)
      const u = /^url\(\s*["']?(.*?)["']?\s*\)$/.exec(layers[0] || '')
      if (layers.length === 1 && (u || /gradient\(/.test(layers[0]))) {
        node.style.mask = { image: u ? absUrl(u[1]) : layers[0], url: !!u, size: cs.maskSize || cs.webkitMaskSize, position: cs.maskPosition || cs.webkitMaskPosition, repeat: cs.maskRepeat || cs.webkitMaskRepeat, mode: cs.maskMode }
      } else if (rect.w * rect.h < 40000 || !(el.textContent || '').trim()) {
        node.kind = 'raster'
        el.setAttribute('data-figcap-id', String(node.id))
        return node
      }
    }
    if (RASTER.has(tag)) {
      node.kind = 'raster'
      el.setAttribute('data-figcap-id', String(node.id))
      if (tag === 'video') {
        const p = el.getAttribute('poster'); if (p) node.poster = absUrl(p); node.objectFit = cs.objectFit; node.objectPosition = cs.objectPosition
        // player state at capture time: the driver can screenshot / restore without flipping the page's play UI
        node.video = { paused: !!el.paused, time: round(el.currentTime || 0), ended: !!el.ended || undefined }
      }
      return node
    }
    if (tag === 'img' || (tag === 'input' && el.type === 'image')) {
      if (hidden) return null
      node.kind = 'img'
      node.src = el.currentSrc || el.src || null
      node.natural = { w: el.naturalWidth || 0, h: el.naturalHeight || 0 }
      node.objectFit = cs.objectFit; node.objectPosition = cs.objectPosition
      node.alt = el.getAttribute('alt') || ''
      if (!node.src || !el.naturalWidth) { if (node.style.bg || node.style.border || node.style.bgLayers) { node.kind = undefined; return node } return null }
      // a script-made `blob:` photo: pages revoke the URL once the img has loaded, so the driver cannot read it back
      // later; the decoded pixels are still here (at display size × 2, never upscaled)
      if (node.src.startsWith('blob:')) node.src = blobPixels(el, rect) || node.src
      return node
    }
    if (tag === 'svg') {
      if (hidden || rect.w === 0 || rect.h === 0 || !intersects(rect, clip)) return null
      const m = svgMarkup(el, rect)
      node.kind = 'svg'
      el.setAttribute('data-figcap-id', String(node.id))
      if (m.unresolved || m.markup.length > 400000) node.kind = 'raster'
      else node.svg = m.markup
      if (m.externals.length) node.svgExternal = [...new Set(m.externals)]
      node.color = cs.color
      return node
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (hidden) return null
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (tag === 'input' && /^(checkbox|radio|range|color|file)$/.test(type)) { node.kind = 'raster'; el.setAttribute('data-figcap-id', String(node.id)); return node }
      if (tag === 'input' && type === 'hidden') return null
      node.kind = 'input'
      const isBtn = tag === 'input' && /^(submit|button|reset)$/.test(type)
      const value = tag === 'select' ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent.trim() : '') : el.value
      const pcs = getComputedStyle(el, '::placeholder')
      // a placeholder hidden by CSS (opacity 0 / transparent colour, e.g. under an overlaid floating label) is none
      const phHidden = Number(pcs.opacity) === 0 || transparent(pcs.color) || pcs.visibility === 'hidden' || pcs.display === 'none'
      node.input = { type: isBtn ? 'button' : tag === 'select' ? 'select' : type, value: value || '', placeholder: phHidden ? '' : el.getAttribute('placeholder') || '', placeholderColor: pcs.color, font: fontOf(cs), multiline: tag === 'textarea' }
      return node
    }
    if (tag === 'br') { node.kind = 'br'; node.layout = undefined; node.style = undefined; return node }

    // a box that clips to nothing (a collapsed filter panel: height 0, overflow hidden) shows none of its content: its
    // pills would otherwise be kept as empty outlines (their labels fall outside the clip) over whatever lies below
    const clippedAway = !sc && !!childClip && (childClip.w < 1 || childClip.h < 1)
    for (const child of clippedAway ? [] : flatChildren(el)) {
      if (child.nodeType === 3) {
        if (hidden || !child.data.trim()) continue
        const lines = textLines(child, childClip)
        if (!lines.length) continue
        if (myShift) for (const l of lines) l.y = round(l.y + myShift)
        const font = fontOf(cs, el)
        const fb = coveringFamily(cs, font.family, child.data)
        if (fb) { font.family = fb; font.ascent = ascentOf(cs, fb) }
        const tn = { id: nextId++, kind: 'text', text: child.data, lines, font, parent: node.id }
        // the main walk's id of this text (alt walks: `base`, see the element boxes)
        if (opts.alt) { if (child.__figcapBase !== undefined) tn.base = child.__figcapBase } else if (!opts.state) child.__figcapBase = tn.id
        node.children.push(tn)
      } else if (child.nodeType === 1) {
        const c = walk(child, childClip, myShift)
        if (c) node.children.push(c)
      }
    }
    // outside list markers (::marker is not measurable): bullet / number right-aligned before the first line
    if (cs.display === 'list-item' && cs.listStyleType !== 'none' && cs.listStylePosition === 'outside' && cs.listStyleImage === 'none' && !hidden) {
      const first = firstLine(node)
      if (first) {
        const t = cs.listStyleType
        const g = measureCtx(); g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        const left = rect.x + (node.layout.borderWidth ? node.layout.borderWidth[3] : 0) + (node.layout.padding ? node.layout.padding[3] : 0)
        if (t === 'disc' || t === 'circle' || t === 'square') {
          // Chromium paints symbol markers as shapes (list_marker.cc): with a = ascent, o = ⌊a·⅔⌋ the marker box starts
          // o + 8px before the content (InlineMarginsForOutside: −o − kCMarkerPaddingPx(7) − 1) and the bullet sits at
          // (1, ⌊3(a − o)/2⌋) in it, ⌊(o + 1)/2⌋ square (RelativeSymbolMarkerRect); the box top is the line's ascent top
          const ascent = Math.round(g.measureText('x').fontBoundingBoxAscent)
          const o = Math.floor(ascent * 2 / 3)
          const d = Math.floor((o + 1) / 2)
          const baseline = first.y + (first.ascent ?? ascent)
          node.children.unshift({ id: nextId++, kind: 'marker', tag: 'li', shape: t, color: cs.color, rect: { x: round(left - o - 7), y: round(baseline - ascent + Math.floor(3 * (ascent - o) / 2)), w: d, h: d } })
        } else {
          const idx = [...el.parentElement.children].filter((c) => getComputedStyle(c).display === 'list-item').indexOf(el) + 1
          const mark = t === 'decimal' ? `${idx}.` : t === 'lower-alpha' || t === 'lower-latin' ? `${String.fromCharCode(96 + idx)}.` : t === 'upper-alpha' || t === 'upper-latin' ? `${String.fromCharCode(64 + idx)}.` : `${idx}.`
          const wMark = g.measureText(mark).width, wFull = g.measureText(`${mark} `).width
          node.children.unshift({ id: nextId++, kind: 'text', text: mark, lines: [{ text: mark, x: round(left - wFull), y: first.y, w: round(wMark), h: first.h }], font: fontOf(cs, el), parent: node.id, marker: true })
        }
      }
    }
    if (hidden && !node.children.length) return null
    return node
  }

  const html = document.documentElement, body = document.body
  const hcs = getComputedStyle(html), bcs = getComputedStyle(body)
  const pageBg = !transparent(hcs.backgroundColor) ? hcs.backgroundColor : !transparent(bcs.backgroundColor) ? bcs.backgroundColor : 'rgb(255, 255, 255)'
  // `scope: 'region'`: only the box a widget state changed (tagged by state-settle), in page coordinates
  const scoped = opts.scope === 'region' ? [...deepElements(document.body)].find((e) => e.hasAttribute('data-figcap-region')) : null
  if (opts.scope === 'region' && !scoped) return null
  const root = walk(scoped || body, null, 0)
  linkCarouselControls()
  if (root && opts.restack !== false) restack(root)
  /** ids of the tagged menu boxes that made it into the tree: { trigger, panel, close } (+ the trigger's label) */
  let marks
  if (tagged.length && root) {
    const ids = new Set(), stack = [root]
    while (stack.length) { const n = stack.pop(); ids.add(n.id); for (const c of n.children || []) stack.push(c) }
    for (const [v, id] of tagged) for (const k of v.split(' ')) if (ids.has(id)) (marks = marks || {})[k] = id
    if (marks && marks.trigger && menuLabel) marks.label = menuLabel
  }

  /**
   * Paint order: a positioned box with a z-index other than 0 is painted in its nearest stacking context, not inside
   * its parent. When ancestors in between do not form one, the snapshot tree (DOM order) would paint it wrongly: a
   * `z-index: -1` card backdrop over the card's own background, a `z-index: 399` hero under a `z-index: 398` header
   * overlay that only happens to be its DOM uncle. Such boxes are re-parented to that stacking context, right after
   * the subtree they came from (tree order is kept among them), and remember the original parent in `from`. A
   * clipping ancestor (overflow / clip-path) stops the move so the clip still applies. Coordinates are page space, so
   * nothing else changes.
   */
  function restack(top) {
    const moves = []
    const path = []
    const clips = (n) => !!(n.style && (n.style.overflow || n.style.clipPath))
    const visit = (n) => {
      path.push(n)
      for (const c of n.children || []) {
        if (c.kind === 'text' || !c.layout) continue
        if (c.layout.z && c.layout.position !== 'static') {
          let t = path.length - 1
          while (t > 0 && !path[t].layout?.stack && !clips(path[t])) t--
          if (t < path.length - 1) moves.push({ c, from: n, to: path[t], after: path[t + 1] })
        }
        if (c.children) visit(c)
      }
      path.pop()
    }
    visit(top)
    const lastAfter = new Map()
    for (const m of moves) {
      const i = m.from.children.indexOf(m.c)
      if (i < 0) continue
      m.from.children.splice(i, 1)
      const anchor = lastAfter.get(m.after) || m.after
      const j = m.to.children.indexOf(anchor)
      m.to.children.splice(j < 0 ? m.to.children.length : j + 1, 0, m.c)
      lastAfter.set(m.after, m.c)
      m.c.from = m.from.id
    }
  }

  /** @font-face rules from readable sheets; unreadable (cross-origin) sheet URLs for the driver to fetch */
  const fontFaces = [], sheets = []
  const readSheets = (list, base) => {
    for (const sh of list) {
      let rules
      try { rules = sh.cssRules } catch { if (sh.href) sheets.push(sh.href); continue }
      for (const rule of rules) {
        if (rule.type === 5 /* FONT_FACE */) {
          const st = rule.style
          const srcs = []
          const re = /url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/g
          let m
          while ((m = re.exec(st.getPropertyValue('src')))) srcs.push({ url: new URL(m[1], sh.href || base).href, format: m[2] || null })
          fontFaces.push({ family: st.getPropertyValue('font-family').replace(/["']/g, '').trim(), weight: st.getPropertyValue('font-weight') || '400', style: st.getPropertyValue('font-style') || 'normal', unicodeRange: st.getPropertyValue('unicode-range') || undefined, stretch: st.getPropertyValue('font-stretch') || undefined, src: srcs })
        } else if (rule.type === 3 /* IMPORT */ && rule.styleSheet) readSheets([rule.styleSheet], base)
        else if (rule.cssRules && rule.type !== 1) readSheets([{ cssRules: rule.cssRules, href: sh.href }], base)
      }
    }
  }
  readSheets(document.styleSheets, location.href)
  for (const el of deepElements(document)) if (el.shadowRoot) { readSheets(el.shadowRoot.styleSheets, location.href); if (el.shadowRoot.adoptedStyleSheets) readSheets(el.shadowRoot.adoptedStyleSheets, location.href) }

  /* ------------------------------------------------------------------ brand extras (opts.brand → `brand`) */

  /**
   * What the brand guide needs on top of the tree (BrandCapture, brandmd/types.ts), read once on the walked page:
   *   controls → distinct buttons / links / inputs / selects / chips / tabs / icon buttons, deduped by look, with their
   *              hover / focus / active looks from the CSSOM: a page script cannot put an element in :hover, so the
   *              rules that would apply are matched instead (state pseudo-classes stripped, the base selector tested
   *              with `matches` on the control and the box drawing its label, var() resolved on the element, the
   *              declarations computed on a probe over the control's own look); no rule or no change → `unreached`
   *   sheets   → readable sheets + the cross-origin ones the driver fetched (mode 'sheets' lists them before the walk,
   *              their text comes back as `opts.css` [{ href, text }], parsed into constructed sheets never applied):
   *              :root / html / body custom properties (rules of @media that match now), @media width conditions with
   *              their rule counts, @font-face files
   *   page     → brand marks (header logo = first home link holding an svg / img, a footer / dark-band one when it
   *              differs, icon links, og / theme / manifest), rasters (img + CSS backgrounds), inline SVG icons ≤ 48 px
   *              deduped by geometry, the page's bands (top-level boxes, wrappers unfolded), repeated rows (grids), a
   *              consent layer still covering the page, the visible strings
   * Every list is capped so a capture stays small; nothing here changes the page except a hidden probe (removed).
   */
  async function brandCapture() {
    const CAP = { images: 300, icons: 200, iconBytes: 20000, iconTotal: 600000, logoBytes: 100000, controls: 150, texts: 3000, textLen: 1000, grids: 100, sections: 80, props: 1500, propLen: 300, media: 200, fontFiles: 200, stateRules: 8000, css: 60 }
    const t0 = Date.now()
    const all = []
    for (const el of deepElements(document.body)) { if (!SKIP.has(el.localName) && !el.ownerSVGElement) all.push(el); if (all.length >= 60000) break }
    const shown = (el, r) => r.width > 0 && r.height > 0 && (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : visible(el))
    let cctx = null
    const rgba = (c) => {
      if (!c || c === 'transparent') return [0, 0, 0, 0]
      const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c)
      if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]]
      if (!cctx) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; cctx = cv.getContext('2d', { willReadFrequently: true }) }
      cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = '#000'; cctx.fillStyle = c; cctx.fillRect(0, 0, 1, 1)
      const d = cctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    /** #rrggbb when opaque, rgba() when translucent, undefined when fully transparent */
    const hex = (c) => {
      const [r, g, b, a] = rgba(c)
      if (a === 0) return undefined
      return a >= 0.999 ? `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${round(a)})`
    }
    const col = (c) => hex(c) || 'transparent'
    /** Rec. 601 brightness 0..1 (over the page background when translucent) */
    const pageRgb = rgba(pageBg)
    const bright = (c) => { const [r, g, b, a] = rgba(c); const m = (v, i) => v * a + pageRgb[i] * (1 - a); return (0.299 * m(r, 0) + 0.587 * m(g, 1) + 0.114 * m(b, 2)) / 255 }
    // svg markup leaves the page: without the walk's tags
    const svgOut = (svg, box) => { const m = svgMarkup(svg, box); return { ...m, markup: m.markup.replace(/\sdata-figcap-[\w-]+="[^"]*"/g, '') } }
    const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) }
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    // icon fonts draw glyphs from ligature names ("arrow_chevron_down"): no text a visitor reads
    const ICON_FONT_RE = /icon|symbol|glyph|awesome|dashicons/i
    const iconFont = (el) => ICON_FONT_RE.test(getComputedStyle(el).fontFamily)

    /* -------- style sheets: readable + fetched cross-origin text */
    const sheetList = []
    const addSheet = (sh, href) => { try { if (sh && sh.cssRules && !(sh.ownerNode && /^__figcap/.test(sh.ownerNode.id || ''))) sheetList.push({ sheet: sh, href: sh.href || href }) } catch { /* cross-origin: opts.css */ } }
    for (const sh of document.styleSheets) addSheet(sh, location.href)
    for (const sh of document.adoptedStyleSheets || []) addSheet(sh, location.href)
    for (const el of all) if (el.shadowRoot) { for (const sh of el.shadowRoot.styleSheets) addSheet(sh, location.href); for (const sh of el.shadowRoot.adoptedStyleSheets || []) addSheet(sh, location.href) }
    for (const c of (opts.css || []).slice(0, CAP.css)) {
      if (!c || typeof c.text !== 'string') continue
      try { const sh = new window.CSSStyleSheet({ baseURL: c.href }); sh.replaceSync(c.text); sheetList.push({ sheet: sh, href: c.href || location.href, fetched: true }) } catch { /* unparsable */ }
    }
    const mediaOk = new Map()
    const matchesMedia = (m) => { if (!m) return true; const q = m.media ? m.media.mediaText : m.conditionText; if (!mediaOk.has(q)) { let ok = true; try { ok = window.matchMedia(q).matches } catch { /* odd query */ } mediaOk.set(q, ok) } return mediaOk.get(q) }
    const countStyle = (rules, depth) => { let n = 0; for (const r of rules) { if (r.type === 1) n++; else if (r.cssRules && depth < 6) n += countStyle(r.cssRules, depth + 1) } return n }
    function eachRule(visit) {
      const go = (rules, href, media, depth) => {
        for (const r of rules) {
          if (r.type === 1 || r.type === 5) visit(r, href, media)
          else if (r.type === 3) { try { if (r.styleSheet && r.styleSheet.cssRules && depth < 4) go(r.styleSheet.cssRules, r.styleSheet.href || href, media, depth + 1) } catch { /* cross-origin import */ } }
          else if (r.type === 4) { visit(r, href, media); if (depth < 8) go(r.cssRules, href, r, depth + 1) }
          else if (r.cssRules && depth < 8) go(r.cssRules, href, media, depth + 1)
        }
      }
      for (const s of sheetList) { try { go(s.sheet.cssRules, s.href, null, 0) } catch { /* gone */ } }
    }
    const pxOf = (n, u) => round(u === 'em' || u === 'rem' ? +n * 16 : +n)
    function widthsOf(q) {
      let minWidth, maxWidth
      for (const m of q.matchAll(/(min|max)-width\s*:\s*([\d.]+)(px|em|rem)?/gi)) { const v = pxOf(m[2], m[3]); if (m[1].toLowerCase() === 'min') minWidth = v; else maxWidth = v }
      for (const m of q.matchAll(/(?:^|[(\s])width\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)?/gi)) { const v = pxOf(m[2], m[3]); if (m[1][0] === '>') minWidth = v; else maxWidth = v }
      for (const m of q.matchAll(/([\d.]+)(px|em|rem)?\s*(<=|<|>=|>)\s*width/gi)) { const v = pxOf(m[1], m[2]); if (m[3][0] === '<') minWidth = v; else maxWidth = v }
      return { minWidth, maxWidth }
    }
    // state pseudo-classes outside (…) / […]: `.btn:hover` → base `.btn`; an emptied compound becomes `*`
    const STATE_RE = /:(hover|focus-visible|focus|active)(?![-\w])/g
    function stripState(part) {
      let depth = 0, flat = ''
      for (let i = 0; i < part.length; i++) { const ch = part[i]; if (ch === '(' || ch === '[') depth++; flat += depth ? '_' : ch; if ((ch === ')' || ch === ']') && depth) depth-- }
      if (/::|:(before|after|placeholder|marker|selection|-webkit-|-moz-)/i.test(flat)) return null
      const found = [...flat.matchAll(STATE_RE)]
      if (!found.length) return null
      const kinds = new Set(found.map((m) => (m[1] === 'focus-visible' ? 'focus' : m[1])))
      if (kinds.size > 1) return null
      const state = [...kinds][0]
      const lastComb = Math.max(flat.lastIndexOf(' '), flat.lastIndexOf('>'), flat.lastIndexOf('+'), flat.lastIndexOf('~'))
      // hover / active hold for the ancestors of the hovered control too; focus only for the control itself
      if (state === 'focus' && found.some((m) => m.index < lastComb)) return null
      let base = part
      for (const m of found.reverse()) {
        const a = m.index, b = a + m[0].length
        const lone = (a === 0 || /[\s>+~]/.test(base[a - 1])) && (b >= base.length || /[\s>+~]/.test(base[b]))
        base = base.slice(0, a) + (lone ? '*' : '') + base.slice(b)
      }
      base = base.trim()
      const cls = /[(\\]/.test(base) ? null : (/\.([\w-]+)[^\s>+~]*$/.exec(base) || [])[1] || null
      return { base, state, cls }
    }

    const customProperties = {}
    let propCount = 0
    const media = new Map()
    const stateRules = []
    const faces = [...fontFaces]
    eachRule((r, href, inMedia) => {
      if (r.type === 4) {
        const q = r.media ? r.media.mediaText : r.conditionText
        const w = widthsOf(q || '')
        if (w.minWidth === undefined && w.maxWidth === undefined) return
        const have = media.get(q)
        if (have) have.rules += countStyle(r.cssRules, 0)
        else media.set(q, { query: q, ...(w.minWidth !== undefined ? { minWidth: w.minWidth } : {}), ...(w.maxWidth !== undefined ? { maxWidth: w.maxWidth } : {}), rules: countStyle(r.cssRules, 0) })
        return
      }
      if (r.type === 5) {
        const st = r.style, srcs = []
        for (const m of (st.getPropertyValue('src') || '').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/g)) { try { srcs.push({ url: new URL(m[1], href).href, format: m[2] || null }) } catch { /* bad url */ } }
        faces.push({ family: st.getPropertyValue('font-family').replace(/["']/g, '').trim(), weight: st.getPropertyValue('font-weight') || '400', style: st.getPropertyValue('font-style') || 'normal', unicodeRange: st.getPropertyValue('unicode-range') || undefined, src: srcs })
        return
      }
      const sel = r.selectorText || ''
      if (/:(hover|focus|active)/.test(sel) && stateRules.length < CAP.stateRules && matchesMedia(inMedia)) {
        for (const part of splitTop(sel)) { const p = stripState(part); if (p) stateRules.push({ ...p, style: r.style }) }
      }
      if (/(^|,)\s*(:root|html|body|html:root)\s*(,|$)/i.test(sel) && matchesMedia(inMedia)) {
        const st = r.style
        for (let i = 0; i < st.length; i++) {
          const n = st[i]
          if (!n.startsWith('--')) continue
          if (!(n in customProperties)) { if (propCount >= CAP.props) continue; propCount++ }
          customProperties[n] = st.getPropertyValue(n).trim().slice(0, CAP.propLen)
        }
      }
    })
    const mediaQueries = [...media.values()].sort((a, b) => b.rules - a.rules).slice(0, CAP.media)

    /* -------- sections: the page's bands (top-level boxes; wrappers holding most of the page unfolded) */
    function flowKids(el, depth = 0) {
      const out = []
      for (const c of flatChildren(el)) {
        if (c.nodeType !== 1 || SKIP.has(c.localName) || c.hasAttribute('data-figcap-pseudo')) continue
        const cs = getComputedStyle(c)
        if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'absolute') continue
        if (cs.display === 'contents' && depth < 4) out.push(...flowKids(c, depth + 1)); else out.push(c)
      }
      return out
    }
    const bandEls = []
    const collectBands = (el, depth) => {
      for (const c of flowKids(el)) {
        const r = c.getBoundingClientRect()
        if (r.height < 24 || r.width < 1) continue
        const kids = depth < 14 ? flowKids(c).map((k) => [k, k.getBoundingClientRect()]).filter(([, kr]) => kr.height >= 24) : []
        // wrappers: one holding most of the page (or <main>) with several boxes, one that only wraps a box as tall
        const tall = c.localName === 'main' || r.height >= pageH * 0.45
        const unfold = (kids.length >= 2 && tall) || (kids.length === 1 && (tall || (Math.abs(kids[0][1].height - r.height) < 4 && transparent(getComputedStyle(c).backgroundColor))))
        if (unfold) collectBands(c, depth + 1); else bandEls.push(c)
      }
    }
    if (body) collectBands(body, 0)
    const sectionEls = bandEls.map((el) => [el, el.getBoundingClientRect()]).sort((a, b) => a[1].top - b[1].top).slice(0, CAP.sections)
    const sections = sectionEls.map(([el, r]) => {
      let bg = null, photo = false, level = [el]
      for (let d = 0; d < 4 && level.length && !bg; d++) {
        const next = []
        for (const e of level) {
          const er = e.getBoundingClientRect()
          if (er.width * er.height < r.width * r.height * 0.85) continue
          const cs = getComputedStyle(e)
          if (/url\(/.test(cs.backgroundImage)) photo = true
          if (!transparent(cs.backgroundColor)) { bg = cs.backgroundColor; break }
          next.push(...flatChildren(e).filter((k) => k.nodeType === 1))
        }
        level = next.slice(0, 80)
      }
      for (let a = el.parentElement; !bg && a; a = a.parentElement) { const c = getComputedStyle(a).backgroundColor; if (!transparent(c)) bg = c }
      if (!bg) bg = pageBg
      let top = Infinity, bottom = -Infinity, n = 0, textColor = null
      for (const e of deepElements(el)) {
        if (++n > 3000) break
        if (SKIP.has(e.localName) || e.ownerSVGElement) continue
        const isMedia = /^(img|svg|video|canvas|picture|input|select|textarea|button|iframe)$/.test(e.localName)
        const hasText = !isMedia && [...e.childNodes].some((t) => t.nodeType === 3 && t.data.trim())
        if (!isMedia && !hasText) continue
        const er = e.getBoundingClientRect()
        if (er.width < 1 || er.height < 1) continue
        if (isMedia && er.width >= r.width * 0.8 && er.height >= r.height * 0.6) { if (e.localName !== 'svg') photo = true; continue }
        if (!shown(e, er)) continue
        if (hasText && !textColor) textColor = getComputedStyle(e).color
        top = Math.min(top, er.top); bottom = Math.max(bottom, er.bottom)
      }
      const dark = photo && textColor ? bright(textColor) > 0.6 : bright(bg) < 0.4
      return { box: rectOf(r), ...(hex(bg) ? { background: hex(bg) } : {}), ...(photo ? { backgroundImage: true } : {}), paddingTop: top === Infinity ? 0 : round(Math.max(0, top - r.top)), paddingBottom: bottom === -Infinity ? 0 : round(Math.max(0, r.bottom - bottom)), dark }
    })
    const sectionOf = (box) => { const cy = box.y + box.h / 2; const i = sections.findIndex((s) => cy >= s.box.y && cy < s.box.y + s.box.h); return i >= 0 ? { section: i } : {} }

    /* -------- brand marks */
    const meta = (sel) => { for (const m of document.querySelectorAll(sel)) { const med = m.getAttribute('media'); if (med && !window.matchMedia(med).matches) continue; const v = norm(m.getAttribute('content')); if (v) return v } return undefined }
    const here = new URL(location.href)
    const site = (h) => h.replace(/^www\./, '')
    const trimPath = (p) => p.replace(/\/+$/, '') || '/'
    const segs = here.pathname.split('/').filter(Boolean)
    const homes = new Set(['/', '/index.html', '/index.htm', '/index.php', trimPath(here.pathname)])
    if (segs.length) for (const p of [`/${segs[0]}`, `/${segs[0]}/index.html`, `/${segs[0]}.html`]) homes.add(p)
    const isHome = (a) => {
      const h = (a.getAttribute('href') || '').trim()
      if (!h || /^(#|javascript:|mailto:|tel:)/i.test(h)) return false
      try { const u = new URL(h, location.href); return site(u.hostname) === site(here.hostname) && homes.has(trimPath(u.pathname)) } catch { return false }
    }
    const LOGO_RE = /logo|wordmark|signet|emblem|brand-?mark|site-?brand|home-?link|startseite/i
    const visualOf = (a) => {
      if (a.localName === 'svg' || a.localName === 'img') return a
      let best = null, area = 0, n = 0
      for (const e of deepElements(a)) {
        if (++n > 400) break
        if ((e.localName !== 'svg' && e.localName !== 'img') || e.ownerSVGElement) continue
        const r = e.getBoundingClientRect()
        if (r.width * r.height > area && r.width >= 12 && r.height >= 8 && shown(e, r)) { best = e; area = r.width * r.height }
      }
      return best
    }
    function findLogo(list, not) {
      const links = [], named = []
      for (const e of list) {
        if (e.localName === 'a' && isHome(e)) links.push(e)
        else if (LOGO_RE.test(`${e.id || ''} ${classOf(e)} ${e.getAttribute('aria-label') || ''} ${e.localName === 'img' ? e.getAttribute('alt') || '' : ''}`)) named.push(e)
      }
      for (const group of [links, named]) {
        for (const a of group) {
          const v = visualOf(a)
          if (v && v !== not) return { link: a, el: v }
        }
      }
      return null
    }
    const logoEls = new Set()
    const markOf = (hit) => {
      if (!hit) return undefined
      logoEls.add(hit.el)
      const box = rectOf(hit.el.getBoundingClientRect())
      const t = hit.el.localName === 'svg' ? hit.el.querySelector('title') : null
      const alt = norm(hit.el.getAttribute('alt') || hit.link.getAttribute('aria-label') || hit.link.getAttribute('title') || (t ? t.textContent : '')) || undefined
      if (hit.el.localName === 'img') return { src: hit.el.currentSrc || hit.el.src, ...(alt ? { alt } : {}), box }
      const m = svgOut(hit.el, box)
      return { ...(m.markup.length <= CAP.logoBytes ? { svg: m.markup } : {}), ...(alt ? { alt } : {}), box }
    }
    const isBanner = (e) => e.localName === 'header' || e.getAttribute('role') === 'banner'
    const header = all.find((e) => isBanner(e) && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().top + window.scrollY < 400)
    const topBand = all.filter((e) => { const r = e.getBoundingClientRect(); return r.top + window.scrollY < 250 && r.height < 300 && r.height > 0 })
    const headHit = (header && findLogo([...deepElements(header)])) || findLogo(topBand)
    const logo = markOf(headHit)
    const footers = all.filter((e) => e.localName === 'footer' || e.getAttribute('role') === 'contentinfo')
    const darkBands = sectionEls.filter((_, i) => sections[i].dark).map(([e]) => e)
    let altHit = null
    for (const scope of [...footers.reverse(), ...darkBands]) { if (headHit && scope.contains(headHit.el)) continue; altHit = findLogo([...deepElements(scope)], headHit && headHit.el); if (altHit) break }
    let logoAlt = altHit ? markOf(altHit) : undefined
    if (logoAlt && logo && ((logoAlt.svg && logoAlt.svg === logo.svg) || (logoAlt.src && logoAlt.src === logo.src))) logoAlt = undefined
    const linkIcons = []
    for (const l of document.querySelectorAll('link[rel][href]')) {
      const rel = (l.getAttribute('rel') || '').toLowerCase().trim()
      if (!/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/.test(rel) || linkIcons.length >= 20) continue
      const href = absUrl(l.getAttribute('href'))
      if (href) linkIcons.push({ rel, href, ...(l.getAttribute('sizes') ? { sizes: l.getAttribute('sizes') } : {}), ...(l.getAttribute('type') ? { type: l.getAttribute('type') } : {}) })
    }
    const og = meta('meta[property="og:image"], meta[name="og:image"]')
    const manifest = document.querySelector('link[rel="manifest"][href]')
    const marks = {
      ...(document.title ? { title: norm(document.title) } : {}),
      ...(meta('meta[property="og:site_name"], meta[name="og:site_name"]') ? { siteName: meta('meta[property="og:site_name"], meta[name="og:site_name"]') } : {}),
      ...(meta('meta[name="theme-color"]') ? { themeColor: meta('meta[name="theme-color"]') } : {}),
      ...(logo ? { logo } : {}), ...(logoAlt ? { logoAlt } : {}),
      icons: linkIcons,
      ...(og && absUrl(og) && !/^\/?$/.test(new URL(absUrl(og)).pathname) && absUrl(og) !== location.href ? { ogImage: absUrl(og) } : {}),
      ...(manifest && absUrl(manifest.getAttribute('href')) ? { manifest: absUrl(manifest.getAttribute('href')) } : {}),
    }

    /* -------- one pass: rasters, icons, a consent layer still over the page, visible strings */
    const images = [], seenImg = new Set(), bgImages = [], icons = new Map(), texts = [], seenText = new Set()
    let iconBytes = 0, overlay = null
    const CONSENT_RE = /cookie|consent|privacy|gdpr|didomi|onetrust|usercentrics|cookiebot|truste|sp_message|cmpbox|cmpwrapper|cmp-?banner|borlabs|datenschutz|einwillig/i
    const RASTER_URL = (u) => u && !/^data:/i.test(u) && !/\.svg(\?|#|$)/i.test(u)
    const srcsetBest = (set) => {
      let best = null, score = -1
      for (const m of String(set || '').matchAll(/\s*([^\s,][^\s]*)(?:\s+([\d.]+)([wx]))?\s*(?:,|$)/g)) {
        const s = m[2] ? +m[2] * (m[3] === 'x' ? 1000 : 1) : 1
        if (s > score) { score = s; best = m[1] }
      }
      return best ? absUrl(best) : null
    }
    const bestOf = (img) => {
      const pic = img.parentElement && img.parentElement.localName === 'picture' ? img.parentElement : null
      if (pic) for (const s of pic.querySelectorAll('source[srcset]')) { const m = s.getAttribute('media'); if (m && !window.matchMedia(m).matches) continue; const b = srcsetBest(s.getAttribute('srcset')); if (b) return b }
      return srcsetBest(img.getAttribute('srcset'))
    }
    const addText = (s) => { const t = norm(s).slice(0, CAP.textLen); if (t && !seenText.has(t) && texts.length < CAP.texts) { seenText.add(t); texts.push(t) } }
    const iconKey = (svg) => `${svg.getAttribute('viewBox') || ''}|${svg.innerHTML.replace(/\s(class|style|fill|stroke|color|id|data-[\w-]+)="[^"]*"/g, '').replace(/\s+/g, ' ').trim()}`
    for (const el of all) {
      const tag = el.localName
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none') continue
      const box = () => rectOf(r)
      if (tag === 'img' && images.length < CAP.images && el.naturalWidth > 2 && RASTER_URL(el.currentSrc || el.src) && shown(el, r)) {
        const src = el.currentSrc || el.src, b = box(), k = `${src}|${Math.round(b.x)}|${Math.round(b.y)}`
        if (!seenImg.has(k)) {
          seenImg.add(k)
          const best = bestOf(el)
          images.push({ src, naturalW: el.naturalWidth, naturalH: el.naturalHeight, box: b, ...(el.hasAttribute('alt') ? { alt: norm(el.getAttribute('alt')) } : {}), ...(best && best !== src ? { best } : {}), objectFit: cs.objectFit, ...sectionOf(b) })
        }
      }
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && images.length < CAP.images && r.width >= 24 && r.height >= 24) {
        const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(cs.backgroundImage)
        const src = m ? absUrl(m[1]) : null
        if (RASTER_URL(src) && shown(el, r)) {
          const b = box(), k = `${src}|${Math.round(b.x)}|${Math.round(b.y)}`
          if (!seenImg.has(k)) { seenImg.add(k); const im = { src, naturalW: 0, naturalH: 0, box: b, objectFit: cs.backgroundSize, ...sectionOf(b), background: true }; images.push(im); bgImages.push(im) }
        }
      }
      if (tag === 'svg' && r.width <= 48 && r.height <= 48 && !logoEls.has(el) && !el.querySelector('text') && shown(el, r)) {
        const k = iconKey(el), have = icons.get(k)
        if (have) have.count++
        else if (icons.size < CAP.icons) {
          const m = svgOut(el, box())
          if (!m.unresolved && m.markup.length <= CAP.iconBytes && iconBytes + m.markup.length <= CAP.iconTotal) { iconBytes += m.markup.length; icons.set(k, { svg: m.markup, w: round(r.width), h: round(r.height), count: 1 }) }
        }
      }
      if (cs.position === 'fixed') {
        const iw = window.innerWidth, ih = window.innerHeight
        const share = Math.max(0, Math.min(r.right, iw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, ih) - Math.max(r.top, 0)) / (iw * ih)
        const host = el.getRootNode && el.getRootNode().host
        const names = `${el.id || ''} ${classOf(el)} ${el.getAttribute('aria-label') || ''} ${host ? `${host.id || ''} ${classOf(host)}` : ''} ${tag === 'iframe' ? el.getAttribute('src') || '' : ''}`
        const dialog = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || tag === 'dialog'
        if (share >= 0.05 && (CONSENT_RE.test(names) || (dialog && CONSENT_RE.test((el.textContent || '').slice(0, 3000)))) && shown(el, r)) {
          const b = box()
          overlay = overlay ? (() => { const x = Math.min(overlay.x, b.x), y = Math.min(overlay.y, b.y); return { x, y, w: round(Math.max(overlay.x + overlay.w, b.x + b.w) - x), h: round(Math.max(overlay.y + overlay.h, b.y + b.h) - y) } })() : b
        }
      }
      if (texts.length < CAP.texts && !(r.width <= 2 && r.height <= 2)) {
        let direct = false
        for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) { direct = true; break }
        if (direct && shown(el, r) && !ICON_FONT_RE.test(cs.fontFamily)) {
          for (const n of el.childNodes) if (n.nodeType === 3) addText(n.data)
          // a line of inline runs ("Mehr <b>erfahren</b>") also as the one string it reads as
          if (cs.display !== 'inline' && el.children.length && el.children.length <= 12 && [...el.children].every((k) => /^inline/.test(getComputedStyle(k).display))) addText(el.textContent)
        }
        if ((tag === 'input' || tag === 'textarea') && shown(el, r)) { if (/^(submit|button|reset)$/i.test(el.type)) addText(el.value); if (el.placeholder) addText(el.placeholder) }
      }
    }
    // natural size of CSS background images (cached by the page: they are drawn already)
    const natural = new Map()
    await Promise.race([Promise.all([...new Set(bgImages.map((i) => i.src))].slice(0, 120).map((u) => new Promise((res) => {
      const im = new window.Image()
      im.onload = () => { natural.set(u, [im.naturalWidth, im.naturalHeight]); res() }
      im.onerror = () => res()
      im.src = u
    }))), sleep(2500)])
    for (const i of bgImages) { const s = natural.get(i.src); if (s) { i.naturalW = s[0]; i.naturalH = s[1] } }

    /* -------- grids: rows of ≥ 2 repeated siblings of similar size */
    const grids = [], gridSeen = new Set()
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0 }
    for (const el of all) {
      if (grids.length >= CAP.grids || Date.now() - t0 > 20000) break
      if (el.childElementCount < 2 && !el.shadowRoot) continue
      const kids = flowKids(el).map((k) => [k, k.getBoundingClientRect()]).filter(([, kr]) => kr.width >= 100 && kr.height >= 48)
      if (kids.length < 2) continue
      const w = median(kids.map(([, kr]) => kr.width))
      const same = kids.filter(([k, kr]) => k.localName === kids[0][0].localName && Math.abs(kr.width - w) <= w * 0.15)
      if (same.length < 2 || same.length < kids.length * 0.6) continue
      const top = same[0][1].top
      const row = same.filter(([, kr]) => Math.abs(kr.top - top) < 4)
      if (row.length < 2) continue
      const er = el.getBoundingClientRect()
      const left = Math.max(0, er.left), right = Math.min(window.innerWidth, er.right)
      const columns = row.filter(([, kr]) => kr.left + kr.width / 2 >= left && kr.left + kr.width / 2 <= right).length
      if (columns < 2) continue
      const gaps = []
      for (let i = 1; i < row.length; i++) gaps.push(row[i][1].left - row[i - 1][1].right)
      const b = rectOf(er), key = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`
      if (gridSeen.has(key)) continue
      gridSeen.add(key)
      grids.push({ box: b, columns, gap: round(Math.max(0, median(gaps))), itemW: round(w), count: same.length, ...sectionOf(b) })
    }

    /* -------- controls, deduped by look, with their states from the CSSOM */
    const CTL_TAGS = /^(a|button|input|select|textarea|summary)$/
    const CTL_ROLES = /^(button|link|tab|switch|checkbox|radio|menuitem|option|combobox|searchbox|textbox)$/
    const sideBorder = (cs) => { let w = 0, c = null; for (const s of ['Top', 'Right', 'Bottom', 'Left']) { const bw = cs[`border${s}Style`] === 'none' ? 0 : px(cs[`border${s}Width`]); if (bw > w) { w = bw; c = cs[`border${s}Color`] } } return { w, c } }
    const decoOf = (cs, lcs) => (cs.textDecorationLine && cs.textDecorationLine !== 'none' ? cs.textDecorationLine : lcs.textDecorationLine) || 'none'
    const lookOf = (cs, lcs) => {
      const b = sideBorder(cs)
      return {
        backgroundColor: col(cs.backgroundColor), color: col(lcs.color), ...(b.w ? { borderColor: col(b.c) } : {}), borderWidth: round(b.w),
        outline: cs.outlineStyle === 'none' || px(cs.outlineWidth) === 0 ? 'none' : `${cs.outlineWidth} ${cs.outlineStyle} ${col(cs.outlineColor)}`,
        boxShadow: cs.boxShadow, textDecoration: decoOf(cs, lcs), opacity: round(Number(cs.opacity)),
      }
    }
    /** the boxes inside a control that draw its label (icon-font glyphs and svg text left out) */
    const labelBoxes = (el) => {
      const out = []
      let n = 0
      for (const e of deepElements(el)) {
        if (++n > 200) break
        if (e.ownerSVGElement || e.localName === 'svg' || SKIP.has(e.localName)) continue
        for (const t of e.childNodes) if (t.nodeType === 3 && t.data.trim()) { if (!iconFont(e)) out.push(e); break }
      }
      return out
    }
    const glyphs = (el) => { let n = 0; for (const e of deepElements(el)) { if (++n > 200) break; if (e.localName === 'svg' || e.localName === 'img' || (e !== el && [...e.childNodes].some((t) => t.nodeType === 3 && t.data.trim()) && iconFont(e))) return true } return false }
    function kindOf(el, tag, role, cs, r, text) {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (role === 'tab') return 'tab'
      if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select'
      if (tag === 'textarea' || role === 'searchbox' || role === 'textbox' || (tag === 'input' && !/^(submit|button|reset|image|checkbox|radio|range|color|file)$/.test(type))) return 'input'
      if ((tag === 'input' && /^(checkbox|radio|range|color|file)$/.test(type)) || /^(switch|checkbox|radio|option|menuitem)$/.test(role)) return 'other'
      const b = sideBorder(cs)
      const framed = b.w > 0 && !transparent(b.c) && px(cs.borderLeftWidth) > 0 && px(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'
      if (!text && r.width <= 80 && r.height <= 80 && glyphs(el)) return 'icon-button'
      const pill = px(cs.borderTopLeftRadius) >= Math.min(12, r.height / 2 - 1) && (framed || !transparent(cs.backgroundColor))
      if ((el.hasAttribute('aria-pressed') && pill) || /(^|[-_\s])(chip|pill|tag|filter-?(button|btn|item))s?($|[-_\s])/i.test(classOf(el))) return 'chip'
      if (tag === 'button' || role === 'button' || tag === 'input' || tag === 'summary' || !transparent(cs.backgroundColor) || framed) return 'button'
      return 'link'
    }
    const looks = new Map()
    for (const el of all) {
      const tag = el.localName, role = el.getAttribute('role') || ''
      if (!CTL_TAGS.test(tag) && !CTL_ROLES.test(role)) continue
      if (tag === 'a' && !el.hasAttribute('href') && !role) continue
      if (tag === 'input' && /^hidden$/i.test(el.type)) continue
      // a control inside a control (a button in a link) counts once: as the outer one
      if (el.parentElement && el.parentElement.closest('a[href], button, [role="button"], [role="tab"], [role="link"]')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4 || r.height > 200 || r.width * r.height > window.innerWidth * window.innerHeight * 0.15 || !shown(el, r)) continue
      const cs = getComputedStyle(el)
      const boxes = /^(input|select|textarea)$/.test(tag) ? [] : labelBoxes(el)
      // text slotted into a shadow root is not below the control in the DOM: innerText follows the rendering
      const text = tag === 'input' ? (/^(submit|button|reset)$/i.test(el.type) ? norm(el.value) : '') : norm(boxes.map((e) => [...e.childNodes].filter((t) => t.nodeType === 3).map((t) => t.data).join(' ')).join(' ')) || (el.shadowRoot || el.getRootNode() !== document ? norm(el.innerText) : '')
      const kind = kindOf(el, tag, role, cs, r, text)
      const label = kind === 'input' || kind === 'select' ? null : boxes[0] || null
      const lcs = label ? getComputedStyle(label) : cs
      const fs = px(lcs.fontSize)
      const base = {
        ...lookOf(cs, lcs),
        fontFamily: renderedFamily(lcs.fontFamily), fontSize: round(fs), fontWeight: Number(lcs.fontWeight) || 400,
        letterSpacing: lcs.letterSpacing === 'normal' ? 0 : round(px(lcs.letterSpacing)), lineHeight: lcs.lineHeight === 'normal' ? round(fs * 1.2) : round(px(lcs.lineHeight)),
        ...(lcs.textTransform && lcs.textTransform !== 'none' ? { textTransform: lcs.textTransform } : {}),
        borderRadius: round(px(cs.borderTopLeftRadius)), paddingTop: round(px(cs.paddingTop)), paddingRight: round(px(cs.paddingRight)), paddingBottom: round(px(cs.paddingBottom)), paddingLeft: round(px(cs.paddingLeft)), height: round(r.height),
      }
      const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
      const ac = el.getAttribute('aria-current')
      const selected = el.getAttribute('aria-selected') === 'true' || (ac !== null && ac !== 'false') || el.getAttribute('aria-pressed') === 'true'
      const sig = [kind, /^(a|button)$/.test(tag) ? '' : tag, base.backgroundColor, base.color, base.borderWidth, base.borderColor || '', base.borderRadius, base.fontFamily, base.fontSize, base.fontWeight, base.textTransform || '', base.letterSpacing, base.boxShadow,
        kind === 'link' ? '' : [base.paddingTop, base.paddingRight, base.paddingBottom, base.paddingLeft, Math.round(base.height / 4)].join(','), disabled ? 'd' : '', selected ? 's' : ''].join('|')
      const have = looks.get(sig)
      if (have) { have.count++; continue }
      looks.set(sig, { el, label, kind, text: text.slice(0, 80) || norm(el.getAttribute('aria-label') || el.getAttribute('title')).slice(0, 80), box: rectOf(r), count: 1, base, disabled, selected, sig })
    }
    const STATE_PROPS = ['background', 'background-color', 'color', 'border', 'border-color', 'border-width', 'border-style', 'border-top', 'border-right', 'border-bottom', 'border-left',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'outline', 'outline-color', 'outline-width', 'outline-style', 'box-shadow',
      'text-decoration', 'text-decoration-line', 'text-decoration-color', 'opacity']
    const LABEL_PROPS = /^(color|text-decoration)/
    const resolveVars = (v, vars, cs, depth = 0) => {
      if (depth > 8 || !/var\(/.test(v)) return v
      return resolveVars(v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_, n, fb) => (vars.has(n) ? vars.get(n) : cs.getPropertyValue(n).trim()) || (fb || '').trim()), vars, cs, depth + 1)
    }
    let probe = null
    function stateOf(c, state) {
      const decls = [], vars = new Map()
      for (const [t, onLabel] of [[c.el, false], ...(c.label && c.label !== c.el ? [[c.label, true]] : [])]) {
        const tcs = getComputedStyle(t)
        for (const sr of stateRules) {
          if (sr.state !== state || sr.bad || (sr.cls && !t.classList.contains(sr.cls))) continue
          let hit = false
          try { hit = t.matches(sr.base) } catch { sr.bad = true }
          if (!hit) continue
          const st = sr.style
          for (let i = 0; i < st.length; i++) if (st[i].startsWith('--')) vars.set(st[i], st.getPropertyValue(st[i]).trim())
          for (const p of STATE_PROPS) {
            if (onLabel && !LABEL_PROPS.test(p)) continue
            const v = st.getPropertyValue(p)
            if (v) decls.push([p, v, st.getPropertyPriority(p) === 'important', tcs])
          }
        }
      }
      if (!decls.length) return null
      if (!probe) { probe = document.createElement('div'); probe.setAttribute('data-figcap-probe', ''); document.body.appendChild(probe) }
      const ecs = getComputedStyle(c.el), lcs = c.label ? getComputedStyle(c.label) : ecs
      probe.removeAttribute('style')
      const set = (p, v) => probe.style.setProperty(p, v, 'important')
      for (const [p, v] of [['position', 'absolute'], ['left', '-10000px'], ['top', '0'], ['width', '10px'], ['height', '10px'], ['visibility', 'hidden'], ['pointer-events', 'none'], ['transition', 'none'], ['animation', 'none'],
        ['color', lcs.color], ['background-color', ecs.backgroundColor], ['outline-style', ecs.outlineStyle], ['outline-width', ecs.outlineWidth], ['outline-color', ecs.outlineColor],
        ['box-shadow', ecs.boxShadow], ['text-decoration-line', decoOf(ecs, lcs)], ['opacity', ecs.opacity]]) set(p, v)
      for (const s of ['top', 'right', 'bottom', 'left']) { set(`border-${s}-style`, ecs.getPropertyValue(`border-${s}-style`)); set(`border-${s}-width`, ecs.getPropertyValue(`border-${s}-width`)); set(`border-${s}-color`, ecs.getPropertyValue(`border-${s}-color`)) }
      for (const important of [false, true]) for (const [p, v, imp, tcs] of decls) if (imp === important) set(p, resolveVars(v, vars, tcs))
      const pcs = getComputedStyle(probe)
      const now = lookOf(pcs, pcs), out = {}
      for (const k of Object.keys(now)) if (now[k] !== c.base[k]) out[k] = now[k]
      return Object.keys(out).length ? out : null
    }
    const controls = []
    for (const c of [...looks.values()].sort((a, b) => b.count - a.count).slice(0, CAP.controls)) {
      const out = { key: `${c.kind}-${fnv(c.sig)}`, kind: c.kind, ...(c.text ? { text: c.text } : {}), box: c.box, count: c.count, base: c.base }
      const unreached = []
      for (const state of ['hover', 'focus', 'active']) {
        const s = Date.now() - t0 < 25000 ? stateOf(c, state) : null
        if (s) out[state] = s; else unreached.push(state)
      }
      if (c.disabled) out.disabled = true
      if (c.selected) out.selected = true
      if (unreached.length) out.unreached = unreached
      controls.push(out)
    }
    if (probe) probe.remove()

    /* -------- webfont files (@font-face of readable and fetched sheets): the file a browser picks per face */
    const fontFiles = [], seenFont = new Set()
    const used = (f) => webfonts.has(String(f.family).toLowerCase())
    const rank = (s) => { const f = String(s.format || (/\.(\w+)(\?|#|$)/.exec(s.url) || [])[1] || '').toLowerCase(); return f === 'woff2' ? 0 : f === 'woff' ? 1 : /truetype|ttf/.test(f) ? 2 : /opentype|otf/.test(f) ? 3 : 4 }
    // subsets for other scripts are left out (as the drivers embed fonts: Latin letters only)
    const latin = (range) => !range || String(range).split(',').some((part) => {
      const p = part.trim().replace(/^u\+/i, ''), [a, z] = p.includes('-') ? p.split('-') : [p.replace(/\?/g, '0'), p.replace(/\?/g, 'f')]
      const lo = parseInt(String(a).replace(/\?/g, '0'), 16), hi = parseInt(z, 16)
      return (lo <= 0x7a && hi >= 0x41) || (lo <= 0xfc && hi >= 0xc0)
    })
    for (const f of [...faces.filter(used), ...faces.filter((f) => !used(f))]) {
      if (!latin(f.unicodeRange)) continue
      const s = (f.src || []).filter((x) => x.url && !/^data:/i.test(x.url)).sort((a, b) => rank(a) - rank(b))[0]
      if (!s || fontFiles.length >= CAP.fontFiles || seenFont.has(s.url)) continue
      seenFont.add(s.url)
      fontFiles.push({ family: f.family, weight: String(f.weight || '400'), style: String(f.style || 'normal'), url: s.url, ...(s.format ? { format: s.format } : {}), ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}) })
    }

    return {
      url: typeof opts.requested === 'string' && opts.requested ? opts.requested : location.href, finalUrl: location.href, width: window.innerWidth,
      customProperties, mediaQueries, marks, images, icons: [...icons.values()].sort((a, b) => b.count - a.count), sections, grids, controls, fontFiles, overlay, texts,
    }
  }
  let brand
  if (opts.brand && !opts.state && opts.scope !== 'region') {
    try { brand = await brandCapture() } catch (e) { brand = { error: String((e && e.message) || e).slice(0, 300) } }
  }

  return {
    version: 1,
    url: location.href,
    title: document.title,
    lang: html.lang || undefined,
    capturedAt: new Date().toISOString(),
    viewport: { width: VW, height: VH },
    page: { width: VW, height: Math.max(pageH, root ? Math.round(root.rect.y + root.rect.h) : 0), background: pageBg, color: bcs.color, font: renderedFamily(bcs.fontFamily) },
    root,
    fonts: [...usedFonts.values()],
    fontFaces,
    sheets: [...new Set(sheets)],
    nodes: count,
    truncated: count > MAX || undefined,
    devicePixelRatio: window.devicePixelRatio,
    // for the driver only (it builds `states` from them and drops this)
    marks,
    // the state controls (findStateControls order): kind and id in this walk (none when not in it)
    controls: window.__figcapCtl && window.__figcapCtl.length ? window.__figcapCtl.map((c, k) => ({ kind: c.kind, ...(ctlIds.has(k) ? { id: ctlIds.get(k) } : {}), ...(c.option !== undefined ? { option: c.option, label: c.text } : {}) })) : undefined,
    // `opts.brand`: what the brand guide reads on top of the tree (BrandCapture; { error } when it failed)
    ...(brand ? { brand } : {}),
  }
})
