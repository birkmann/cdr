// The modern recreation's behaviour, as one small dependency-free module (app.js): the navigation menu (open,
// submenus, close, back, Escape, focus kept inside, focus returned), sliders (scroll-snap tracks driven by arrows,
// dots, keyboard and autoplay that pauses on hover, focus and reduced motion) and background video (a pause control,
// no autoplay under reduced motion). Everything works from data attributes the emitter writes.
export const MODERN_RUNTIME_JS = String.raw`// Behaviour of the recreated page: menu, sliders, video. No dependencies.
const root = document.documentElement
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

// ---- menu
let opener = null
const focusables = (el) => [...el.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetWidth || x.offsetHeight || x.getClientRects().length)
const panelOf = (name) => document.querySelector('[data-menu-panel="' + name + '"]') || document.querySelector('[data-menu-panel]')
function openMenu(name, from) {
  const was = root.getAttribute('data-menu')
  if (!was) opener = from
  root.setAttribute('data-menu', name)
  for (const t of document.querySelectorAll('[data-menu-open]')) t.setAttribute('aria-expanded', String(t.getAttribute('data-menu-open') === name || (name !== 'menu' && t.getAttribute('data-menu-open') === 'menu')))
  requestAnimationFrame(() => {
    const panel = panelOf(name)
    const first = panel && focusables(panel).find((x) => !x.hasAttribute('data-menu-open') || x.getAttribute('data-menu-open') !== 'menu')
    if (first) first.focus()
  })
}
function closeMenu() {
  if (!root.hasAttribute('data-menu')) return
  root.removeAttribute('data-menu')
  for (const t of document.querySelectorAll('[data-menu-open]')) t.setAttribute('aria-expanded', 'false')
  if (opener) opener.focus()
  opener = null
}
document.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('[data-menu-open], [data-menu-close], [data-menu-back]')
  if (!t) return
  if (t.hasAttribute('data-menu-close')) { e.preventDefault(); closeMenu(); return }
  if (t.hasAttribute('data-menu-back')) { e.preventDefault(); openMenu('menu', t); return }
  const name = t.getAttribute('data-menu-open')
  e.preventDefault()
  if (root.getAttribute('data-menu') === name && name === 'menu') closeMenu()
  else openMenu(name, t)
})
document.addEventListener('keydown', (e) => {
  const open = root.getAttribute('data-menu')
  if (!open) return
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return }
  if (e.key !== 'Tab') return
  const panel = panelOf(open)
  if (!panel) return
  const list = focusables(panel)
  if (!list.length) return
  const first = list[0], last = list[list.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
})
// a wider window where the menu has no panel: closed
window.matchMedia('(min-width: 1024px)').addEventListener('change', () => closeMenu())

// ---- sliders
for (const track of document.querySelectorAll('[data-slider]')) {
  const id = track.id
  const slides = () => [...track.children].filter((c) => c.offsetWidth > 0)
  const loop = track.hasAttribute('data-loop')
  const controls = (sel) => [...document.querySelectorAll(sel + '[aria-controls="' + id + '"]')]
  const dots = controls('[data-slider-dot]')
  const steps = controls('[data-slider-step]')
  const index = () => {
    const s = slides()
    const x = track.scrollLeft + 2
    let k = 0
    s.forEach((c, i) => { if (c.offsetLeft - s[0].offsetLeft <= x) k = i })
    return k
  }
  const atEnd = () => track.scrollLeft + track.clientWidth >= track.scrollWidth - 2
  const go = (k) => {
    const s = slides()
    if (!s.length) return
    if (k < 0) k = loop ? s.length - 1 : 0
    if (k >= s.length || (k > index() && atEnd())) k = loop ? 0 : s.length - 1
    track.scrollTo({ left: s[k].offsetLeft - s[0].offsetLeft, behavior: reduced.matches ? 'auto' : 'smooth' })
  }
  const sync = () => {
    const k = index()
    dots.forEach((d, i) => { d.setAttribute('aria-current', String(i === k)); d.classList.toggle('is-active', i === k) })
    if (!loop) for (const b of steps) {
      const off = Number(b.getAttribute('data-slider-step')) < 0 ? track.scrollLeft <= 2 : atEnd()
      b.setAttribute('aria-disabled', String(off))
    }
  }
  for (const b of steps) b.addEventListener('click', () => go(index() + Number(b.getAttribute('data-slider-step'))))
  dots.forEach((d) => d.addEventListener('click', () => go(Number(d.getAttribute('data-slider-dot')))))
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index() + 1) }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index() - 1) }
  })
  let t = 0
  track.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(sync, 80) }, { passive: true })
  sync()
  // autoplay: only while visible, never under reduced motion, paused while the pointer or focus is on it
  const delay = Number(track.getAttribute('data-autoplay')) || 0
  if (delay) {
    let timer = 0, visible = false, held = false
    const region = track.closest('section') || track.parentElement
    const run = () => { clearInterval(timer); if (visible && !held && !reduced.matches) timer = setInterval(() => go(index() + 1), delay) }
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; run() }).observe(track)
    for (const [ev, v] of [['pointerenter', true], ['pointerleave', false], ['focusin', true], ['focusout', false]]) region.addEventListener(ev, () => { held = v; run() })
    reduced.addEventListener('change', run)
  }
}

// ---- widgets that switch in place (tabs, accordions, a toggle that swaps an icon): data-state on their region
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-region-toggle], [data-region-set]')
  if (!b) return
  const toggle = b.hasAttribute('data-region-toggle')
  const [id, state] = b.getAttribute(toggle ? 'data-region-toggle' : 'data-region-set').split(':')
  const region = document.querySelector('[data-region="' + id + '"]')
  if (!region) return
  // a toggle switches its state on and off; a selection sets its state ('' = the widget at rest)
  const on = toggle ? region.getAttribute('data-state') !== state : true
  if (on && state) region.setAttribute('data-state', state); else region.removeAttribute('data-state')
  for (const c of document.querySelectorAll('[data-region-toggle^="' + id + ':"], [data-region-set^="' + id + ':"]')) {
    const mine = c.getAttribute(c.hasAttribute('data-region-toggle') ? 'data-region-toggle' : 'data-region-set') === id + ':' + state
    const attr = c.hasAttribute('aria-selected') ? 'aria-selected' : c.hasAttribute('aria-checked') ? 'aria-checked' : c.hasAttribute('aria-expanded') ? 'aria-expanded' : c.hasAttribute('aria-pressed') && !c.hasAttribute('data-video-toggle') && !c.hasAttribute('data-marquee-toggle') ? 'aria-pressed' : null
    if (attr) c.setAttribute(attr, String(mine && on))
  }
})

// ---- marquees: the page's pause control
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-marquee-toggle]')
  if (!b) return
  const m = document.querySelector('[data-marquee="' + b.getAttribute('data-marquee-toggle') + '"]')
  if (!m) return
  const paused = !m.hasAttribute('data-paused')
  m.toggleAttribute('data-paused', paused)
  b.setAttribute('aria-pressed', String(paused))
  b.setAttribute('aria-label', paused ? (b.dataset.playLabel || 'Play animation') : (b.dataset.pauseLabel || 'Pause animation'))
})

// ---- video
// background videos start once the page has loaded (their posters paint first), only while visible, never under
// reduced motion
const startVideos = () => {
  for (const v of document.querySelectorAll('video[data-autoplay]')) {
    if (reduced.matches || v.dataset.userPaused) continue
    v.muted = true
    new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting && !v.dataset.userPaused && !reduced.matches) v.play().catch(() => {}); else if (!e.isIntersecting) v.pause() } }).observe(v)
  }
}
if (document.readyState === 'complete') startVideos(); else window.addEventListener('load', startVideos, { once: true })
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-video-toggle]')
  if (!b) return
  const v = document.getElementById(b.getAttribute('data-video-toggle'))
  if (!v || v.tagName !== 'VIDEO') return
  if (v.paused) { delete v.dataset.userPaused; v.play() } else { v.dataset.userPaused = '1'; v.pause() }
})
for (const b of document.querySelectorAll('[data-video-toggle]')) {
  const v = document.getElementById(b.getAttribute('data-video-toggle'))
  if (!v || v.tagName !== 'VIDEO') continue
  const sync = () => { b.setAttribute('aria-pressed', String(v.paused)); b.setAttribute('aria-label', v.paused ? (b.dataset.playLabel || 'Play video') : (b.dataset.pauseLabel || 'Pause video')) }
  v.addEventListener('play', sync)
  v.addEventListener('pause', sync)
  sync()
}
`;
