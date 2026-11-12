// Fixture behaviour: menu, background video pause, a transform slider (arrows, dots, autoplay, loop) and a JS hover.
const toggle = document.querySelector('.nav-toggle')
const menu = document.getElementById('menu')
toggle.addEventListener('click', () => { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true') })
for (const c of menu.querySelectorAll('.menu-close')) c.addEventListener('click', () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false') })

const video = document.querySelector('.hero-video')
const pause = document.querySelector('.hero-pause')
pause.addEventListener('click', () => {
  if (video.paused) { video.play(); pause.setAttribute('aria-label', 'Pause background video') } else { video.pause(); pause.setAttribute('aria-label', 'Play background video') }
})

const track = document.querySelector('.slider-track')
const slides = [...track.children]
const dots = [...document.querySelectorAll('.slider-dots .dot')]
let index = 0
function go(i) {
  index = (i + slides.length) % slides.length
  const s = slides[index]
  track.style.transform = `translateX(${-s.offsetLeft}px)`
  dots.forEach((d, k) => { d.classList.toggle('is-active', k === index); d.setAttribute('aria-selected', String(k === index)) })
}
document.querySelector('.slider-next').addEventListener('click', () => go(index + 1))
document.querySelector('.slider-prev').addEventListener('click', () => go(index - 1))
dots.forEach((d, k) => d.addEventListener('click', () => go(k)))
setInterval(() => go(index + 1), 4000)
window.__slider = { autoplay: 4000, loop: true }

for (const card of document.querySelectorAll('.card')) {
  card.addEventListener('mouseenter', () => card.classList.add('is-hovered'))
  card.addEventListener('mouseleave', () => card.classList.remove('is-hovered'))
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) {
      const on = t === tab
      t.setAttribute('aria-selected', String(on))
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on
    }
  })
}
for (const q of document.querySelectorAll('.faq-q')) {
  q.addEventListener('click', () => {
    const open = q.getAttribute('aria-expanded') !== 'true'
    q.setAttribute('aria-expanded', String(open))
    document.getElementById(q.getAttribute('aria-controls')).hidden = !open
  })
}
