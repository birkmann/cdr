// In-page helpers of the capture driver (run in the page sandbox; their results are data). Ported from the earlier
// project's api/_lib/capture.ts and crates/fig-server/src/capture.rs (SOLO_JS with the first-frame seek of videos).

/** Click "accept" on consent dialogs inside an iframe (in-process ones through an isolated world). */
export const FRAME_CONSENT_JS = String.raw`(() => {
  const ids = ['#didomi-notice-agree-button', '#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#accept-all-cookies', '[data-testid="uc-accept-all-button"]', '.cmpboxbtnyes', '#uc-btn-accept-banner', '.sp_choice_type_11', '.truste-button2', '#truste-consent-button']
  const accept = /^(alle\s+(cookies\s+)?(akzeptieren|annehmen|zulassen|erlauben)|(cookies\s+)?akzeptieren|zustimmen|alle zustimmen|einverstanden|accept( all)?( cookies)?|allow all( cookies)?|agree|i agree|ok, verstanden|akzeptieren und schließen|(einwilligen|zustimmen|akzeptieren) und weiter|(accept|agree) and (continue|close))$/i
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  for (const sel of ids) { const el = document.querySelector(sel); if (el && visible(el)) { el.click(); return true } }
  const cands = []
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    const t = (el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
    if (t.length < 60 && accept.test(t) && visible(el)) cands.push({ el, all: /alle|all/i.test(t) ? 0 : 1 })
  }
  cands.sort((a, b) => a.all - b.all)
  if (cands[0]) { cands[0].el.click(); return true }
  return false
})()`;

/** `<use href="/sprite.svg#icon">` → the symbol inlined (still a vector); called as `(items, files)`. */
export const SPRITE_JS = String.raw`((items, files) => {
  const NS = 'http://www.w3.org/2000/svg', XL = 'http://www.w3.org/1999/xlink'
  const parse = (t) => { try { const d = new DOMParser().parseFromString(t, 'image/svg+xml'); return d.getElementsByTagName('parsererror').length ? null : d } catch { return null } }
  const docs = new Map()
  const doc = (f) => { if (!docs.has(f)) docs.set(f, files[f] ? parse(files[f]) : null); return docs.get(f) }
  const clean = (root) => { for (const n of [...root.querySelectorAll('script, foreignObject')]) n.remove(); for (const n of [root, ...root.querySelectorAll('*')]) for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name) }
  const resolveVars = (text, vals) => {
    let out = '', i = 0
    while (i < text.length) {
      const j = text.indexOf('var(', i)
      if (j < 0) { out += text.slice(i); break }
      out += text.slice(i, j)
      let depth = 0, k = j + 3
      for (; k < text.length; k++) { if (text[k] === '(') depth++; else if (text[k] === ')' && --depth === 0) break }
      const inner = text.slice(j + 4, k), comma = inner.indexOf(',')
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim(), fallback = comma < 0 ? '' : inner.slice(comma + 1).trim()
      out += vals[name] || resolveVars(fallback, vals) || 'currentColor'
      i = k + 1
    }
    return out
  }
  const out = {}
  for (const it of items) {
    const host = parse(it.svg)
    if (!host) { out[it.id] = null; continue }
    let ok = true
    for (const use of [...host.getElementsByTagName('use')]) {
      const href = use.getAttribute('href') || use.getAttributeNS(XL, 'href') || ''
      if (!/^https?:/.test(href)) continue
      const [file, id] = href.split('#')
      const d = doc(file)
      const sym = d && id ? d.getElementById(id) : null
      if (!sym) { ok = false; continue }
      const svg = host.createElementNS(NS, 'svg')
      for (const k of ['viewBox', 'preserveAspectRatio']) { const v = sym.getAttribute(k); if (v) svg.setAttribute(k, v) }
      for (const a of [...use.attributes]) if (a.localName !== 'href') svg.setAttribute(a.name, a.value)
      if (!use.hasAttribute('width')) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%') }
      for (const c of [...sym.childNodes]) svg.appendChild(host.importNode(c, true))
      clean(svg)
      use.replaceWith(svg)
    }
    let text = new XMLSerializer().serializeToString(host.documentElement)
    if (!ok || /<use\b[^>]*href="https?:/.test(text)) { out[it.id] = null; continue }
    if (/var\(--/.test(text)) {
      const names = [...new Set([...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))]
      const el = document.querySelector('[data-figcap-id="' + it.id + '"]')
      const cs = el ? getComputedStyle(el) : null
      text = resolveVars(text, Object.fromEntries(names.map((k) => [k, cs ? cs.getPropertyValue(k).trim() : ''])))
    }
    out[it.id] = text
  }
  return out
})`;

/** Show one element alone (everything else hidden, transparent page), scroll it in and return its page rect. */
export const SOLO_JS = String.raw`(async (id) => {
  const el = document.querySelector('[data-figcap-id="' + id + '"]')
  if (!el) return null
  if (el.localName === 'video') {
    if (el.readyState < 2) await new Promise((r) => { el.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 3000) })
    try { el.pause() } catch { /* not playable */ }
    // its first frame (what a visitor sees as the page opens), not wherever autoplay got to: the same frame every capture
    if (el.currentTime > 0.05) {
      try { await new Promise((r) => { el.addEventListener('seeked', r, { once: true }); setTimeout(r, 3000); el.currentTime = 0 }) } catch { /* not seekable */ }
    }
  }
  const st = document.createElement('style')
  st.id = '__figcap_solo'
  st.textContent = 'html,body{background:transparent!important}body *{visibility:hidden!important}*,*::before,*::after{animation-play-state:paused!important;caret-color:transparent!important}[data-figcap-id="' + id + '"],[data-figcap-id="' + id + '"] *{visibility:visible!important}'
  document.head.appendChild(st)
  let r = el.getBoundingClientRect()
  if (r.height <= innerHeight && (r.top < 0 || r.bottom > innerHeight)) {
    window.scrollTo({ top: Math.max(0, r.top + scrollY - (innerHeight - r.height) / 2), left: 0, behavior: 'instant' })
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    r = el.getBoundingClientRect()
  }
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, inView: r.top >= 0 && r.bottom <= innerHeight + 0.5 }
})`;

/** Re-encode image bytes at (display size × dpr) as WebP in a blank page. Bytes in, data URL out; nothing fetched. */
export const SHRINK_JS = String.raw`(async (b64, mime, w, h) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }))
  const scale = Math.min(1, Math.max(w / bmp.width, h / bmp.height))
  const cw = Math.max(1, Math.round(bmp.width * scale)), ch = Math.max(1, Math.round(bmp.height * scale))
  const c = new OffscreenCanvas(cw, ch)
  c.getContext('2d').drawImage(bmp, 0, 0, cw, ch)
  const out = await c.convertToBlob({ type: 'image/webp', quality: 0.86 })
  return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(out) })
})`;

export const NO_SERVICE_WORKERS_JS =
  "try { if (window.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = function () { return Promise.reject(new DOMException('service workers are off during capture', 'SecurityError')) } } catch (e) {}";

/** Native dialogs would block the page (and the capture script) forever. */
export const NO_DIALOGS_JS =
  "window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; window.print = () => {};";

/**
 * On-load overlays a visitor dismisses (region / language switchers, newsletter or app-download modals, promo layers):
 * closed through their own decline / close control where there is one, else hidden, together with full-viewport
 * backdrops and the scroll lock they put on the page. Cookie banners are the capture script's consent step; the
 * page's header, navigation and small sticky widgets are left alone. → number of overlays removed.
 */
export const DISMISS_OVERLAYS_JS = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const vw = innerWidth, vh = innerHeight
  const DECLINE = /^\s*(×|✕|✖|x|close|schließen|schliessen|dialog schließen|close dialog|abbrechen|cancel|stay|bleiben|hier bleiben|stay here|no,? thanks|nein,? danke|not now|nicht jetzt|später|later|dismiss|maybe later|vielleicht später|continue|weiter|ok|got it|verstanden)\s*$/i
  const SWITCH = /wechseln|switch|change|ändern|go to|zur .*seite|visit|continue to|weiter zu|subscribe|anmelden|abonnieren|download|install/i
  const deep = (root) => { const out = [], stack = [root]; while (stack.length) { const n = stack.pop(); if (!n) continue; if (n.nodeType === 1) out.push(n); if (n.shadowRoot) stack.push(...n.shadowRoot.children); stack.push(...(n.children || [])) } return out }
  const shown = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 }
  const isOverlay = (el) => {
    if (el === document.body || el === document.documentElement) return false
    if (el.closest('header, nav, [role=banner], [role=navigation], [data-harness-kept]')) return false
    if (/cookie|consent|onetrust|didomi|cookiebot|usercentrics/i.test((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : ''))) return false
    const role = el.getAttribute('role')
    const modal = role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true' || (el.localName === 'dialog' && el.open)
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const area = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0))
    if (area <= 0) return false
    const fixed = cs.position === 'fixed'
    // a bar along the top (the header) or a small corner widget (chat button) is part of the page
    const bar = r.top <= 1 && r.height < vh * 0.25
    const small = area < vw * vh * 0.12
    if (modal) return !small || r.height > 120
    return fixed && !bar && !small && (el.innerText || '').trim().length > 8 && Number(cs.zIndex || 0) >= 1
  }
  let removed = 0
  for (let round = 0; round < 2; round++) {
    const found = []
    for (const el of deep(document.body)) if (shown(el) && isOverlay(el) && !found.some((f) => f.contains(el))) found.push(el)
    if (!found.length) break
    for (const d of found) {
      const controls = deep(d).filter((c) => (/^(button|a)$/i.test(c.localName) || c.getAttribute('role') === 'button') && shown(c))
      const label = (c) => ((c.innerText || c.textContent || '') + ' ' + (c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '')).replace(/\s+/g, ' ').trim()
      const decline = controls.find((c) => !SWITCH.test(label(c)) && (DECLINE.test((c.innerText || c.textContent || '').trim()) || DECLINE.test(c.getAttribute('aria-label') || '') || /close|schlie(ß|ss)en|dismiss/i.test((c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '') + ' ' + (typeof c.className === 'string' ? c.className : ''))))
      if (decline) { try { decline.click() } catch {} }
    }
    await sleep(700)
    for (const d of found) if (d.isConnected && shown(d)) { d.style.setProperty('display', 'none', 'important'); d.setAttribute('data-harness-dismissed', '') }
    removed += found.length
  }
  if (removed) {
    // backdrops left behind: full-viewport fixed boxes without text
    for (const el of deep(document.body)) {
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' || !shown(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width >= vw * 0.95 && r.height >= vh * 0.95 && !(el.innerText || '').trim() && !el.querySelector('img,video,canvas,svg')) el.style.setProperty('display', 'none', 'important')
    }
    // the scroll lock a modal puts on the page
    for (const el of [document.documentElement, document.body]) if (getComputedStyle(el).overflowY === 'hidden') el.style.setProperty('overflow', 'visible', 'important')
  }
  return removed
})()`;
