// The compare page: live shot and output side by side, swipe, overlay and the difference
// image per width, plus the real output page in an iframe. Static HTML written to <run>/compare/index.html; it
// references the measure images and the output by relative paths, so the server can serve the run folder as is.
import type { MeasureReport } from "./report.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * `measureDir`: path from compare/ to the measure folder holding `<width>/{live,out,diff}.png` (default
 * "../measure/<target>"); `outputPage`: path from compare/ to the output's index.html.
 */
export function comparePage(
  reports: MeasureReport[],
  o: {
    title: string;
    sourceUrl?: string;
    measureDir?: (target: string) => string;
    outputPage?: (target: string) => string;
  },
): string {
  const dir = o.measureDir ?? ((t) => `../measure/${t}`);
  const page = o.outputPage ?? ((t) => `../out/${t}/index.html`);
  const tabs = reports.flatMap((r) =>
    r.widths.map((w) => ({ id: `${r.target}-${w.width}`, label: `${r.target} · ${w.width}px`, r, w })),
  );
  const gateRows = reports
    .map(
      (r) =>
        `<tr><th>${esc(r.target)}</th>${r.gates
          .map(
            (g) =>
              `<td class="${g.pass ? "ok" : "bad"}" title="${esc(g.detail)}">${g.pass ? "✓" : "✗"} ${g.name}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  // the responsive sweep: one cell per width (issues on hover), and the output in a frame of any width
  const strips = reports
    .filter((r) => r.sweep?.length)
    .map((r) => {
      const cells = r
        .sweep!.map((c) => {
          const tip = [...c.issues, ...c.notes].join("\n") || "ok";
          const rot = r.sweepPlan?.rotating.includes(c.width) ? " rot" : "";
          return `<button type="button" class="cell ${c.pass ? "ok" : "bad"}${rot}" data-w="${c.width}" title="${esc(`${c.width}px\n${tip}`)}">${c.width}</button>`;
        })
        .join("");
      const max = Math.max(2560, ...r.sweep!.map((c) => c.width));
      return `<section class="sweep" data-target="${esc(r.target)}">
  <h2>${esc(r.target)}: every width</h2>
  <p class="nums">${r.sweep!.filter((c) => !c.pass).length} of ${r.sweep!.length} widths fail. Click a width, or drag the slider, to see the recreation at that width.</p>
  <div class="cells">${cells}</div>
  <label class="scrub">Width <input type="range" min="320" max="${max}" step="1" value="390" aria-label="Output width"> <output>390</output>px</label>
  <div class="frame"><div class="fit"><iframe title="recreation at any width" data-src="${page(r.target)}" width="390" height="900"></iframe></div><small class="scale" hidden></small></div>
</section>`;
    })
    .join("\n");
  const panels = tabs
    .map(({ id, r, w }) => {
      const img = (k: "live" | "out" | "diff") => `${dir(r.target)}/${w.width}/${k}.png`;
      return `<section class="panel" id="${id}" hidden>
  <p class="nums">pixel ${(w.pixel * 100).toFixed(2)} % · shifted ${(w.shifted * 100).toFixed(2)} % · text ${w.textReal} missing/extra (${w.textDrift} drift) · height ${w.outHeight} / ${w.liveHeight}px${w.hscroll ? ` · horizontal scroll ${w.hscroll}px` : ""}</p>
  ${w.interactions.length ? `<p class="nums">${w.interactions.map((c) => `<span class="${c.result === "fail" ? "bad" : "ok"}">${c.name}: ${c.result}</span>`).join(" · ")}</p>` : ""}
  <div class="modes"><button data-mode="side" class="on">Side by side</button><button data-mode="swipe">Swipe</button><button data-mode="overlay">Overlay</button><button data-mode="diff">Difference</button><button data-mode="live">Live output</button></div>
  <div class="view side" style="--w:${w.width}px">
    <figure class="a"><figcaption>Live</figcaption><img src="${img("live")}" alt="live page at ${w.width}px"></figure>
    <figure class="b"><figcaption>Recreation</figcaption><img src="${img("out")}" alt="recreation at ${w.width}px"></figure>
    <figure class="d"><figcaption>Difference (red: mismatch, amber: shifted)</figcaption><img src="${img("diff")}" alt="difference at ${w.width}px"></figure>
    <iframe class="f" title="recreation at ${w.width}px" loading="lazy" data-src="${page(r.target)}" width="${w.width}" height="900"></iframe>
    <input class="slider" type="range" min="0" max="100" value="50" aria-label="Swipe position">
  </div>
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compare: ${esc(o.title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1b1b1b; --muted: #6b6b6b; --line: #ddd; --ok: #1a7f37; --bad: #c62828; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #eee; --muted: #9a9a9a; --line: #333; --ok: #4ac26b; --bad: #ff6b6b; } }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
header { padding: 16px; border-bottom: 1px solid var(--line); }
h1 { font-size: 18px; margin: 0 0 4px; }
a { color: inherit; }
table { border-collapse: collapse; margin-top: 8px; }
td, th { padding: 2px 10px 2px 0; text-align: left; font-weight: normal; }
.ok { color: var(--ok); } .bad { color: var(--bad); }
nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 16px; }
nav button, .modes button { border: 1px solid var(--line); background: none; color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
nav button.on, .modes button.on { background: var(--fg); color: var(--bg); }
.panel { padding: 0 16px 32px; }
.nums { color: var(--muted); margin: 4px 0; }
.modes { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.view { position: relative; overflow-x: auto; }
.view figure { margin: 0; } .view img { display: block; width: var(--w); max-width: none; }
figcaption { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.view.side { display: flex; gap: 16px; align-items: flex-start; }
.view .d, .view .f, .view .slider { display: none; }
.view.side .d { display: block; }
.view.swipe, .view.overlay { width: var(--w); }
.view.swipe .b, .view.overlay .b { position: absolute; top: 0; left: 0; }
.view.swipe figcaption, .view.overlay figcaption { display: none; }
.view.swipe .b { clip-path: inset(0 0 0 var(--cut, 50%)); }
.view.swipe .slider { display: block; position: sticky; top: 0; width: var(--w); z-index: 2; }
.view.overlay .b { opacity: 0.5; }
.view.diff .a, .view.diff .b { display: none; } .view.diff .d { display: block; }
.view.live .a, .view.live .b { display: none; } .view.live .f { display: block; border: 1px solid var(--line); }
.sweep { padding: 8px 16px 16px; border-bottom: 1px solid var(--line); }
.sweep h2 { font-size: 15px; margin: 0; }
.cells { display: flex; flex-wrap: wrap; gap: 3px; margin: 8px 0; }
.cell { font: 11px/1 ui-monospace, monospace; padding: 4px 5px; border-radius: 4px; border: 1px solid var(--line); background: none; color: inherit; cursor: pointer; }
.cell.ok { border-color: color-mix(in srgb, var(--ok) 50%, transparent); }
.cell.bad { background: var(--bad); border-color: var(--bad); color: #fff; }
.cell.rot { border-style: dashed; }
.scrub { display: flex; align-items: center; gap: 8px; }
.scrub input { flex: 1; max-width: 640px; }
.frame { margin-top: 8px; }
.frame .fit { overflow: hidden; }
.frame iframe { border: 1px solid var(--line); background: #fff; transform-origin: 0 0; display: block; }
.frame .scale { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>${esc(o.title)}</h1>
  ${o.sourceUrl ? `<div>Live page: <a href="${esc(o.sourceUrl)}" rel="noreferrer">${esc(o.sourceUrl)}</a></div>` : ""}
  <table>${gateRows}</table>
</header>
${strips}
<nav>${tabs.map((t, i) => `<button data-tab="${t.id}"${i === 0 ? ' class="on"' : ""}>${esc(t.label)}</button>`).join("")}</nav>
${panels}
<script>
const show = (id) => { document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== id)); document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id)); };
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
document.querySelectorAll('.panel').forEach((p) => {
  const view = p.querySelector('.view');
  p.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => {
    p.querySelectorAll('.modes button').forEach((x) => x.classList.toggle('on', x === b));
    view.className = 'view ' + b.dataset.mode;
    const f = view.querySelector('iframe');
    if (b.dataset.mode === 'live' && !f.src) f.src = f.dataset.src;
  }));
  const s = view.querySelector('.slider');
  s.addEventListener('input', () => view.style.setProperty('--cut', s.value + '%'));
});
document.querySelectorAll('.sweep').forEach((sw) => {
  const f = sw.querySelector('iframe'), r = sw.querySelector('input[type=range]'), out = sw.querySelector('output');
  const fit = sw.querySelector('.fit'), note = sw.querySelector('.scale');
  // the page lays out at the chosen width; wider than the panel, it is shown scaled down to fit (not cut off)
  const scale = () => {
    const w = Number(f.width), room = sw.querySelector('.frame').clientWidth - 2;
    const k = w > room ? room / w : 1;
    f.style.transform = k < 1 ? 'scale(' + k + ')' : '';
    fit.style.width = Math.ceil((w + 2) * k) + 'px';
    fit.style.height = Math.ceil((Number(f.height) + 2) * k) + 'px';
    note.hidden = k >= 1;
    note.textContent = k < 1 ? 'shown at ' + Math.round(k * 100) + ' % to fit; laid out at ' + w + ' px' : '';
  };
  const set = (w) => { if (!f.src) f.src = f.dataset.src; f.width = String(w); r.value = String(w); out.textContent = String(w); scale(); };
  addEventListener('resize', scale);
  r.addEventListener('input', () => set(Number(r.value)));
  sw.querySelectorAll('.cell').forEach((c) => c.addEventListener('click', () => set(Number(c.dataset.w))));
});
const first = document.querySelector('.panel'); if (first) show(first.id);
</script>
</body>
</html>
`;
}
