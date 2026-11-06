// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Page interactions of an exported site: slider arrows, dots, mouse drag, region states and menu behaviour.
//
// This file ships verbatim as src/lib/interactions.ts of the React export (export/interactions.ts appends the React
// hook `useInteractions`); the HTML export runs `installInteractions` serialised with Function#toString. It must
// therefore stay self-contained: no imports, and `installInteractions` uses nothing from module scope. The source text
// is embedded by scripts/recreate/embed.mjs (src/export/generated.ts); a test checks it is current.
//
// Everything is driven by data attributes in the page markup:
//   data-scroller="x"            a scrolling frame (carousel / slider track); CSS scroll-snap does the snapping
//   data-scroll-by="next|prev"   a slider arrow; data-scroll-page: by a page instead of one slide;
//                                data-scroll-target="<up>:<n>": its frame is the n-th [data-scroller] inside the
//                                ancestor <up> levels up (else: the nearest one); data-scroll-off: captured disabled
//   data-states / data-pt-state  a region with alternative states (data-pt-display: a state's own display)
//   data-set-state="<state id>"  a tap that shows that state; data-state-target="<up>:<n>" finds the region
//   [data-overlay][data-open]    an open menu (the page toggles it): the page behind does not scroll, focus moves in
//   data-scroll-shift="<dy>"     a pinned box the page moves once it scrolls (the band above a header sliding away):
//                                by dy px as soon as it scrolls (past data-scroll-shift-after px), or along with it up to
//                                dy (data-scroll-shift-mode="scroll")

/** Install the page interactions on `doc`; returns the uninstall. Safe to call once per document. */
export function installInteractions(win: Window, doc: Document): () => void {
  const cleanups: Array<() => void> = [];
  const listen = (
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    opts?: boolean | AddEventListenerOptions,
  ) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  const reduced = () => !!win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const css = (el: Element) => win.getComputedStyle(el);
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };

  /* ---------------------------------------------------------------- links between taps and what they move */

  /** `<up>:<n>` from `from`: the n-th match inside the ancestor `up` levels up (`<up>` alone: that ancestor). */
  function linked(from: Element, spec: string | null, sel: string): HTMLElement | null {
    if (spec) {
      const [up, n] = spec.split(":");
      let a: Element | null = from;
      for (let i = 0; i < Number(up) && a; i++) a = a.parentElement;
      if (a && n === undefined) return a as HTMLElement;
      const hit = a ? a.querySelectorAll<HTMLElement>(sel)[Number(n)] : undefined;
      if (hit) return hit;
    }
    // inside one (an arrow in its slider's own markup); else the nearest ancestor holding one, several: the one
    // closest vertically (as the capture paired them)
    const own = from.parentElement ? from.parentElement.closest<HTMLElement>(sel) : null;
    if (own) return own;
    const r = from.getBoundingClientRect();
    for (let a: Element | null = from.parentElement; a !== null; a = (a as Element).parentElement) {
      const list = Array.prototype.slice.call(a.querySelectorAll(sel)) as HTMLElement[];
      if (!list.length) continue;
      let best = list[0]!,
        gap = Infinity;
      for (const s of list) {
        const b = s.getBoundingClientRect();
        const d = Math.max(0, b.top - r.bottom, r.top - b.bottom);
        if (d < gap) {
          gap = d;
          best = s;
        }
      }
      return best;
    }
    return null;
  }
  const frames = new WeakMap<Element, HTMLElement | null>();
  function frameOf(arrow: Element): HTMLElement | null {
    let f = frames.get(arrow);
    if (f === undefined || (f && !f.isConnected)) {
      f = linked(arrow, arrow.getAttribute("data-scroll-target"), "[data-scroller]");
      frames.set(arrow, f);
    }
    return f;
  }

  /* ---------------------------------------------------------------- carousels */

  type Span = { start: number; end: number };
  const horizontal = (box: HTMLElement) => box.getAttribute("data-scroller") !== "y";
  /** layout px per screen px (a zoomed page) */
  const scaleOf = (box: HTMLElement, x: boolean) => {
    const r = box.getBoundingClientRect();
    const len = x ? box.offsetWidth : box.offsetHeight;
    return len && (x ? r.width : r.height) ? len / (x ? r.width : r.height) : 1;
  };
  const posOf = (box: HTMLElement) => (horizontal(box) ? box.scrollLeft : box.scrollTop);
  const maxOf = (box: HTMLElement) =>
    Math.max(0, horizontal(box) ? box.scrollWidth - box.clientWidth : box.scrollHeight - box.clientHeight);
  const viewOf = (box: HTMLElement) => (horizontal(box) ? box.clientWidth : box.clientHeight);

  /**
   * The row of slides: the first level (the frame's children, then theirs…) whose boxes sit side by side along the
   * axis and reach past the frame's end — a slider's own navigation laid over its track is no row of slides.
   */
  const rows = new WeakMap<HTMLElement, Element>();
  function rowOf(box: HTMLElement): Element {
    const hit = rows.get(box);
    if (hit && hit.isConnected) return hit;
    const x = horizontal(box);
    const sized = (p: Element) =>
      (Array.prototype.slice.call(p.children) as Element[])
        .map((c) => ({ c, r: c.getBoundingClientRect() }))
        .filter((k) => (x ? k.r.width : k.r.height) > 1);
    const b = box.getBoundingClientRect();
    const end = x ? b.left + box.clientWidth / scaleOf(box, x) : b.top + box.clientHeight / scaleOf(box, x);
    let level: Element[] = [box];
    let found: Element | null = null;
    for (let d = 0; d < 4 && !found && level.length <= 80; d++) {
      for (const p of level) {
        const sz = sized(p);
        if (sz.some((k) => k.c.querySelector("[data-scroll-by]") || k.c.hasAttribute("data-scroll-by")))
          continue;
        const kids = sz
          .map((k) => (x ? [k.r.left, k.r.right] : [k.r.top, k.r.bottom]))
          .sort((a, c) => a[0]! - c[0]!);
        if (
          kids.length >= 2 &&
          kids.every((k, i) => i === 0 || k[0]! >= kids[i - 1]![1]! - 2) &&
          kids[kids.length - 1]![1]! > end + 1
        ) {
          found = p;
          break;
        }
      }
      level = level.flatMap((p) => Array.prototype.slice.call(p.children) as Element[]);
    }
    // else the first level with two or more children (as the prototype)
    if (!found) {
      found = box;
      for (let d = 0; d < 3 && found.children.length < 2 && found.firstElementChild; d++)
        found = found.firstElementChild;
    }
    if (shown(box)) rows.set(box, found);
    return found;
  }
  /** The slides along the frame's axis, in its content coordinates. */
  function slidesOf(box: HTMLElement): Span[] {
    const row = rowOf(box);
    const x = horizontal(box);
    const b = box.getBoundingClientRect();
    const k = scaleOf(box, x);
    const base = posOf(box);
    const out: Span[] = [];
    for (const c of Array.prototype.slice.call(row.children) as Element[]) {
      const r = c.getBoundingClientRect();
      if ((x ? r.width : r.height) <= 1) continue;
      out.push({
        start: base + (x ? r.left - b.left : r.top - b.top) * k,
        end: base + (x ? r.right - b.left : r.bottom - b.top) * k,
      });
    }
    return out.sort((p, q) => p.start - q.start);
  }
  /**
   * A snapping frame whose slides carry no snap alignment (the capture aligned the boxes around them, e.g. the
   * slider's navigation row) rests on its slides instead — only where its current offset stays a resting place.
   */
  function snapSlides(box: HTMLElement) {
    const t = css(box).scrollSnapType;
    if (!t || t === "none") return;
    const row = rowOf(box);
    const slides = Array.prototype.slice.call(row.children) as HTMLElement[];
    if (slides.length < 2 || slides.some((c) => css(c).scrollSnapAlign !== "none")) return;
    const stops = stopsOf(box);
    if (!stops.some((v) => Math.abs(v - posOf(box)) <= 1)) return;
    for (const el of Array.prototype.slice.call(box.querySelectorAll("*")) as HTMLElement[])
      if (css(el).scrollSnapAlign !== "none" && el.parentElement !== row) el.style.scrollSnapAlign = "none";
    for (const c of slides) c.style.scrollSnapAlign = "start";
  }
  /** Where the slides come to rest (where the first one starts), within [0, max]. */
  function stopsOf(box: HTMLElement): number[] {
    const s = slidesOf(box);
    const max = maxOf(box);
    const out: number[] = [];
    for (const x of s) {
      const v = Math.min(max, Math.max(0, x.start - s[0]!.start));
      if (!out.length || v - out[out.length - 1]! > 1) out.push(v);
    }
    return out.length ? out : [0];
  }
  /**
   * Where an arrow moves the frame (as slider libraries do; mirrors prototype/scroll.ts carouselTarget): 'slide' one
   * slide on / back; 'page': the first slide not wholly in view comes to the start, back: the page ending with the
   * slide before the one at the start.
   */
  function targetOf(box: HTMLElement, dir: number, page: boolean): number {
    const s = slidesOf(box);
    const cur = posOf(box),
      view = viewOf(box),
      max = maxOf(box);
    const clamp = (v: number) => Math.min(max, Math.max(0, v));
    if (!s.length) return clamp(cur + dir * view);
    const inset = s[0]!.start;
    const stop = (i: number) => clamp(s[i]!.start - inset);
    if (dir > 0) {
      if (cur >= max - 1) return max;
      if (page) {
        for (let j = 0; j < s.length; j++)
          if (s[j]!.end > cur + view + 1) {
            if (stop(j) > cur + 1) return stop(j);
            break;
          }
      }
      for (let i = 0; i < s.length; i++) if (stop(i) > cur + 1) return stop(i);
      return max;
    }
    if (cur <= 1) return 0;
    if (page) {
      let first = s.length;
      for (let j = s.length - 1; j >= 0; j--) if (stop(j) >= cur - 1) first = j;
      const before = s[first - 1];
      if (!before) return 0;
      for (let j = 0; j < s.length; j++)
        if (stop(j) >= before.end - view - 1) return Math.min(stop(j), clamp(before.start - inset));
      return 0;
    }
    for (let i = s.length - 1; i >= 0; i--) if (stop(i) < cur - 1) return stop(i);
    return 0;
  }
  function scrollFrame(box: HTMLElement, to: number, smooth = true) {
    const opts: ScrollToOptions = { behavior: smooth && !reduced() ? "smooth" : "auto" };
    if (horizontal(box)) opts.left = to;
    else opts.top = to;
    if (typeof box.scrollTo === "function") box.scrollTo(opts);
    else if (horizontal(box)) box.scrollLeft = to;
    else box.scrollTop = to;
  }

  /* ---------------------------------------------------------------- looks: arrows (disabled) and dots (active) */

  // a control wears another one's captured look: every paint property of its subtree that differs, inline
  const PAINT = [
    "color",
    "background-color",
    "background-image",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
    "opacity",
    "fill",
    "stroke",
    "box-shadow",
  ];
  type Look = Array<{ node: HTMLElement | SVGElement; paint: string[] }>;
  const looks = new WeakMap<Element, Look>();
  /** what a control wears over its own look: each property with the inline value it had before */
  const worn = new WeakMap<
    Element,
    Array<{ node: HTMLElement | SVGElement; prop: string; was: string; prio: string }>
  >();
  function lookOf(el: Element): Look {
    let l = looks.get(el);
    if (!l) {
      const nodes = [el, ...Array.prototype.slice.call(el.querySelectorAll("*"))] as Array<
        HTMLElement | SVGElement
      >;
      l = nodes.map((node) => {
        const cs = css(node);
        return { node, paint: PAINT.map((p) => cs.getPropertyValue(p)) };
      });
      looks.set(el, l);
    }
    return l;
  }
  /** `el` shows `from`'s captured look (null / itself: its own again). */
  function wear(el: Element, from: Element | null) {
    const mine = lookOf(el);
    for (const w of (worn.get(el) ?? []).reverse()) {
      if (w.was) w.node.style.setProperty(w.prop, w.was, w.prio);
      else w.node.style.removeProperty(w.prop);
    }
    worn.delete(el);
    if (!from || from === el) return;
    const theirs = lookOf(from);
    // same markup: node by node; else only the control's own box
    const n = theirs.length === mine.length ? mine.length : 1;
    const set: Array<{ node: HTMLElement | SVGElement; prop: string; was: string; prio: string }> = [];
    for (let i = 0; i < n; i++) {
      const node = mine[i]!.node;
      PAINT.forEach((p, k) => {
        if (mine[i]!.paint[k] === theirs[i]!.paint[k]) return;
        set.push({
          node,
          prop: p,
          was: node.style.getPropertyValue(p),
          prio: node.style.getPropertyPriority(p),
        });
        node.style.setProperty(p, theirs[i]!.paint[k]!, "important");
      });
    }
    worn.set(el, set);
  }

  /** Arrows of a frame by side (visible ones). */
  function arrowsOf(box: HTMLElement): { prev: HTMLElement[]; next: HTMLElement[] } {
    const out = { prev: [] as HTMLElement[], next: [] as HTMLElement[] };
    for (const a of Array.prototype.slice.call(doc.querySelectorAll("[data-scroll-by]")) as HTMLElement[]) {
      if (frameOf(a) === box) out[a.getAttribute("data-scroll-by") === "prev" ? "prev" : "next"].push(a);
    }
    return out;
  }

  /**
   * Dots of a frame: two or more small controls of one size side by side near it (its parent or up to two levels
   * above, holding no other frame), at most one per slide. Remembered with the dot captured active.
   */
  type Dots = { dots: HTMLElement[]; active: number };
  const dotsCache = new WeakMap<HTMLElement, Dots | null>();
  const dotFrames = new WeakMap<Element, HTMLElement>();
  function dotsOf(box: HTMLElement): Dots | null {
    if (dotsCache.has(box)) return dotsCache.get(box)!;
    if (!shown(box)) return null;
    let found: Dots | null = null;
    const slides = slidesOf(box).length;
    for (
      let a: HTMLElement | null = box.parentElement, up = 0;
      a !== null && up < 3 && !found;
      a = (a as HTMLElement).parentElement, up++
    ) {
      if (a.querySelectorAll("[data-scroller]").length > 1) break;
      const groups = new Map<Element, HTMLElement[]>();
      for (const el of Array.prototype.slice.call(
        a.querySelectorAll('button, [role="button"], a'),
      ) as HTMLElement[]) {
        if (box.contains(el) || el.hasAttribute("data-scroll-by") || !el.parentElement) continue;
        const r = el.getBoundingClientRect();
        if (
          r.width < 4 ||
          r.height < 4 ||
          r.width > 48 ||
          r.height > 48 ||
          (el.textContent ?? "").trim().length > 2
        )
          continue;
        const g = groups.get(el.parentElement) ?? [];
        g.push(el);
        groups.set(el.parentElement, g);
      }
      for (const g of groups.values()) {
        const r0 = g[0]!.getBoundingClientRect();
        if (
          g.length < 2 ||
          g.length > Math.max(2, slides) ||
          !g.every((d) => {
            const r = d.getBoundingClientRect();
            return Math.abs(r.width - r0.width) < 1.5 && Math.abs(r.height - r0.height) < 1.5;
          })
        )
          continue;
        // the dot captured active looks unlike the others
        const sig = g.map((d) =>
          lookOf(d)
            .map((x) => x.paint.join())
            .join("|"),
        );
        const odd = sig.findIndex((s) => sig.filter((t) => t === s).length === 1);
        found = { dots: g, active: odd };
        break;
      }
    }
    if (found)
      found.dots.forEach((d, i) => {
        d.setAttribute("data-scroll-dot", String(i));
        dotFrames.set(d, box);
      });
    dotsCache.set(box, found);
    return found;
  }
  /** Scroll offset of each dot: one per resting place, else one per slide, else spread over them. */
  function dotStops(box: HTMLElement, n: number): number[] {
    const stops = stopsOf(box);
    if (stops.length === n) return stops;
    const s = slidesOf(box);
    const max = maxOf(box);
    if (s.length === n) return s.map((x) => Math.min(max, Math.max(0, x.start - s[0]!.start)));
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(stops[Math.round((i * (stops.length - 1)) / Math.max(1, n - 1))]!);
    return out;
  }
  /** the dot tapped last (several dots may share the frame's end) */
  const tapped = new WeakMap<HTMLElement, number>();
  function activeDot(box: HTMLElement, stops: number[]): number {
    const pos = posOf(box);
    const t = tapped.get(box);
    if (t !== undefined && Math.abs(stops[t]! - pos) <= 1) return t;
    // the nearest; at the frame's end the last of those resting there
    const end = pos >= maxOf(box) - 1;
    let at = 0;
    stops.forEach((v, i) => {
      const d = Math.abs(v - pos) - Math.abs(stops[at]! - pos);
      if (d < -0.5 || (end && d <= 0.5)) at = i;
    });
    return at;
  }

  /**
   * Arrows inside the frame they move (a slider's navigation row in its own scrolling markup) stay in view: the
   * frame's child holding them moves along with the scroll offset. A "2 / 5" counter there follows the position.
   */
  const counters = new WeakMap<Element, { node: Text; text: string; total: number }[]>();
  function pin(box: HTMLElement, arrows: HTMLElement[], at: number) {
    const x = horizontal(box);
    const kids = new Set<HTMLElement>();
    for (const a of arrows) {
      let c: HTMLElement | null = a;
      while (c && c.parentElement !== box) c = c.parentElement;
      if (c) kids.add(c);
    }
    kids.forEach((c) => {
      c.style.translate = x ? `${box.scrollLeft}px 0` : `0 ${box.scrollTop}px`;
      let list = counters.get(c);
      if (!list) {
        list = [];
        const walker = doc.createTreeWalker(c, 4);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const m = /^\s*\d+\s*\/\s*(\d+)\s*$/.exec(n.nodeValue ?? "");
          if (m) list.push({ node: n as Text, text: n.nodeValue ?? "", total: Number(m[1]) });
        }
        counters.set(c, list);
      }
      for (const k of list) k.node.nodeValue = k.text.replace(/\d+/, String(Math.min(at + 1, k.total)));
    });
  }

  /** Arrow and dot looks follow the position (only once the frame has moved: the page loads exactly as captured). */
  function sync(box: HTMLElement) {
    const max = maxOf(box),
      pos = posOf(box);
    const arrows = arrowsOf(box);
    const inside = arrows.prev.concat(arrows.next).filter((a) => box.contains(a));
    if (inside.length) {
      const stops = stopsOf(box);
      let at = 0;
      stops.forEach((s, i) => {
        if (Math.abs(s - pos) < Math.abs(stops[at]! - pos)) at = i;
      });
      pin(box, inside, at);
    }
    if (max > 1) {
      const off = { prev: pos <= 1, next: pos >= max - 1 };
      for (const side of ["prev", "next"] as const) {
        const other = side === "prev" ? "next" : "prev";
        for (const el of arrows[side]) {
          if (off[side]) el.setAttribute("aria-disabled", "true");
          else el.removeAttribute("aria-disabled");
          const capturedOff = el.hasAttribute("data-scroll-off");
          // the look of the state it is in now: its own, or the captured one of an arrow that was in that state
          const donor =
            capturedOff === off[side]
              ? el
              : (arrows[other].find((o) => o.hasAttribute("data-scroll-off") === off[side]) ?? el);
          wear(el, donor);
        }
      }
    }
    const d = dotsOf(box);
    if (d) {
      const at = activeDot(box, dotStops(box, d.dots.length));
      const idle = d.dots.findIndex((_, i) => i !== d.active);
      d.dots.forEach((dot, i) => {
        if (i === at) dot.setAttribute("aria-current", "true");
        else dot.removeAttribute("aria-current");
        if (d.active < 0) return;
        wear(dot, i === at ? d.dots[d.active]! : i === d.active ? d.dots[idle]! : null);
      });
    }
  }
  const queued = new Set<HTMLElement>();
  function queueSync(box: HTMLElement) {
    if (queued.has(box)) return;
    queued.add(box);
    win.requestAnimationFrame(() => {
      queued.delete(box);
      sync(box);
    });
  }

  // the captured looks are read before anything changes; aria state and dots are known from the start
  function init() {
    // controls that are no buttons take keyboard focus
    for (const el of Array.prototype.slice.call(
      doc.querySelectorAll("[data-scroll-by], [data-set-state]"),
    ) as HTMLElement[]) {
      if (
        !/^(BUTTON|A|SELECT|INPUT)$/.test(el.tagName) &&
        !el.hasAttribute("tabindex") &&
        !el.querySelector("select")
      )
        el.setAttribute("tabindex", "0");
    }
    for (const box of Array.prototype.slice.call(doc.querySelectorAll("[data-scroller]")) as HTMLElement[]) {
      if (!shown(box)) continue;
      snapSlides(box);
      dotsOf(box);
      const a = arrowsOf(box);
      for (const el of a.prev.concat(a.next)) lookOf(el);
      const max = maxOf(box);
      if (max > 1)
        for (const el of a.prev.concat(a.next)) {
          const off = el.getAttribute("data-scroll-by") === "prev" ? posOf(box) <= 1 : posOf(box) >= max - 1;
          if (off) el.setAttribute("aria-disabled", "true");
        }
    }
  }

  listen(
    doc,
    "scroll",
    (e) => {
      const box = e.target as HTMLElement;
      if (box && box.hasAttribute && box.hasAttribute("data-scroller")) queueSync(box);
    },
    true,
  );

  /* ---------------------------------------------------------------- mouse drag (touch scrolls natively) */

  let drag: { box: HTMLElement; x: number; left: number; k: number; moved: boolean; id: number } | null =
    null;
  let swallowClick = false;
  listen(doc, "pointerdown", (ev) => {
    const e = ev as PointerEvent;
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const t = e.target as Element;
    if (!t || !t.closest || t.closest("input, textarea, select, [contenteditable]")) return;
    const box = t.closest<HTMLElement>('[data-scroller="x"]');
    if (!box || maxOf(box) <= 1) return;
    drag = { box, x: e.clientX, left: box.scrollLeft, k: scaleOf(box, true), moved: false, id: e.pointerId };
  });
  listen(win, "pointermove", (ev) => {
    const e = ev as PointerEvent;
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 6) return;
      drag.moved = true;
      drag.box.style.scrollSnapType = "none";
      drag.box.style.scrollBehavior = "auto";
      drag.box.style.cursor = "grabbing";
      doc.documentElement.style.userSelect = "none";
    }
    drag.box.scrollLeft = drag.left - dx * drag.k;
  });
  const endDrag = (ev: Event) => {
    const e = ev as PointerEvent;
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    swallowClick = true;
    win.setTimeout(() => {
      swallowClick = false;
    }, 0);
    doc.documentElement.style.userSelect = "";
    d.box.style.cursor = "";
    const snaps = css(d.box).scrollSnapType;
    d.box.style.scrollBehavior = "";
    d.box.style.scrollSnapType = "";
    // a snapping frame comes to rest on the nearest slide, a little drag still moves on by one
    if (snaps && snaps !== "none" && css(d.box).scrollSnapType !== "none") {
      const cur = d.box.scrollLeft;
      const stops = stopsOf(d.box);
      let to = stops[0]!;
      for (const s of stops) if (Math.abs(s - cur) < Math.abs(to - cur)) to = s;
      if (Math.abs(to - d.left) < 1 && Math.abs(cur - d.left) > 30) {
        const dir = cur > d.left ? 1 : -1;
        for (const s of dir > 0 ? stops : stops.slice().reverse())
          if ((s - d.left) * dir > 1) {
            to = s;
            break;
          }
      }
      d.box.scrollLeft = cur;
      scrollFrame(d.box, to);
    }
  };
  listen(win, "pointerup", endDrag);
  listen(win, "pointercancel", endDrag);
  // a drag is no click (links / taps inside the slides), and images in a slider are not dragged out
  listen(
    doc,
    "click",
    (e) => {
      if (swallowClick) {
        swallowClick = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  listen(doc, "dragstart", (e) => {
    const t = e.target as Element;
    if (t && t.closest && t.closest('[data-scroller="x"]')) e.preventDefault();
  });

  /* ---------------------------------------------------------------- region states */

  /**
   * The state a tap names: its id; a component copy's (its instance prefix before it); else by number — a captured
   * region's states are `<region>s<n>-…` after its first (default) one, which component extraction may have renamed.
   */
  function stateFor(states: HTMLElement[], id: string): HTMLElement | undefined {
    const ids = states.map((c) => c.getAttribute("data-pt-state") ?? "");
    let i = ids.indexOf(id);
    if (i < 0) i = ids.findIndex((x) => x.endsWith(`__${id}`));
    if (i < 0) i = ids.findIndex((x) => x.endsWith(id));
    const n = /s(\d+)-[a-z0-9]+$/i.exec(id);
    if (i < 0 && n) {
      i = ids.findIndex((x) => new RegExp(`s${n[1]}-[a-z0-9]+$`, "i").test(x));
      if (i < 0 && Number(n[1]) + 1 < states.length) i = Number(n[1]) + 1;
    }
    return i < 0 ? undefined : states[i];
  }
  /**
   * Show the state `id` of a region (a state id of a component copy may carry its instance's prefix). What follows a
   * taller / shorter state moves by the difference, as the page reflows on the site (mirrors the prototype runtime).
   */
  function setState(region: HTMLElement, id: string) {
    const states = Array.prototype.filter.call(region.children, (c: Element) =>
      c.hasAttribute("data-pt-state"),
    ) as HTMLElement[];
    const next = stateFor(states, id);
    const cur = states.find((c) => css(c).display !== "none");
    if (!next || next === cur) return;
    // heights before: boxes that size to their content grow by themselves, the others are grown
    const before = new Map<HTMLElement, number>();
    for (let p: HTMLElement | null = region; p; p = p.parentElement) {
      before.set(p, p.offsetHeight);
      if (p.tagName === "MAIN") break;
    }
    if (cur) cur.style.display = "none";
    next.style.display = next.getAttribute("data-pt-display") || "block";
    const h0 = before.get(region)!;
    const h1 = Math.max(next.offsetHeight, next.scrollHeight);
    if (Math.abs(h1 - h0) <= 0.5) return;
    if (Math.abs(region.offsetHeight - h1) > 1) region.style.height = `${h1}px`;
    reflowAfter(region, before, h1 - h0);
  }
  /** Layers after `start` at every level up to the screen move by `delta`; the boxes holding it grow with it. */
  function reflowAfter(start: HTMLElement, before: Map<HTMLElement, number>, delta: number) {
    const px = (v: string) => parseFloat(v) || 0;
    let node = start,
      top = start.offsetTop,
      bottom = top + before.get(start)!;
    while (node.parentElement && node.tagName !== "MAIN") {
      const parent = node.parentElement;
      const inFlow = /^(static|relative|sticky)$/.test(css(node).position);
      for (const s of Array.prototype.slice.call(parent.children) as HTMLElement[]) {
        if (s === node) continue;
        const cs = css(s);
        if (cs.display === "none") continue;
        const st = s.offsetTop,
          sb = st + s.offsetHeight;
        if (cs.position === "absolute") {
          // a layer below moves; a background reaching across the region grows with it
          if (st >= bottom - 1) s.style.top = `${px(cs.top) + delta}px`;
          else if (st <= top + 1 && sb >= bottom - 1) s.style.height = `${s.offsetHeight + delta}px`;
        } else if (!inFlow && cs.position !== "fixed" && st >= bottom - 1) {
          // a flow box below an absolute region: moved by what the region grew so far
          const dy = px(s.getAttribute("data-state-dy") || "0") + delta;
          s.setAttribute("data-state-dy", String(dy));
          s.style.translate = dy ? `0 ${dy}px` : "";
        }
      }
      const h = before.get(parent) ?? parent.offsetHeight;
      if (Math.abs(parent.offsetHeight - (h + delta)) > 1) {
        const pcs = css(parent);
        parent.style.height = `${h + delta}px`;
        if (
          pcs.minHeight &&
          pcs.minHeight !== "0px" &&
          pcs.minHeight !== "auto" &&
          px(pcs.minHeight) > h + delta
        )
          parent.style.minHeight = `${h + delta}px`;
      }
      top = parent.offsetTop;
      bottom = top + h;
      node = parent;
    }
  }

  /* ---------------------------------------------------------------- taps */

  listen(doc, "click", (e) => {
    const t = e.target as Element;
    if (!t || !t.closest) return;
    const arrow = t.closest<HTMLElement>("[data-scroll-by]");
    if (arrow) {
      const box = frameOf(arrow);
      if (!box) return;
      e.preventDefault();
      scrollFrame(
        box,
        targetOf(
          box,
          arrow.getAttribute("data-scroll-by") === "prev" ? -1 : 1,
          arrow.hasAttribute("data-scroll-page"),
        ),
      );
      return;
    }
    const dot = t.closest<HTMLElement>("[data-scroll-dot]");
    const dotBox = dot ? dotFrames.get(dot) : undefined;
    if (dot && dotBox) {
      const d = dotsOf(dotBox);
      if (!d) return;
      e.preventDefault();
      const i = Number(dot.getAttribute("data-scroll-dot"));
      tapped.set(dotBox, i);
      scrollFrame(dotBox, dotStops(dotBox, d.dots.length)[i] ?? 0);
      queueSync(dotBox);
      return;
    }
    const tap = t.closest<HTMLElement>("[data-set-state]");
    if (tap && !t.closest("select")) {
      const region = linked(tap, tap.getAttribute("data-state-target"), "[data-states]");
      if (region) {
        e.preventDefault();
        setState(region, tap.getAttribute("data-set-state") ?? "");
      }
    }
  });
  // a drop-down's choice shows its state
  listen(doc, "change", (e) => {
    const sel = e.target as HTMLSelectElement;
    const tap = sel && sel.closest ? sel.closest<HTMLElement>("[data-set-state]") : null;
    if (!tap || sel.tagName !== "SELECT") return;
    const region = linked(tap, tap.getAttribute("data-state-target"), "[data-states]");
    if (region) setState(region, sel.value);
  });
  // controls that are no buttons (a div with role="button") work from the keyboard too
  listen(doc, "keydown", (ev) => {
    const e = ev as KeyboardEvent;
    const t = e.target as HTMLElement;
    if (
      (e.key !== "Enter" && e.key !== " ") ||
      !t ||
      !t.matches ||
      t.tagName === "BUTTON" ||
      t.tagName === "A"
    )
      return;
    if (t.matches("[data-scroll-by], [data-scroll-dot], [data-set-state]")) {
      e.preventDefault();
      t.click();
    }
  });

  /* ---------------------------------------------------------------- app state (apps built from a Brief) */

  // Variables (data-app-vars on a screen: [{ id, name, type, value, expr? }]), taps that set them / switch an app
  // region's state / branch on them (data-app-act: the interaction as JSON), texts showing one (data-app-text = id),
  // layers shown while a condition holds (data-app-show: { variableId, op, value }). Mirrors prototype/appState.ts.
  type Scalar = string | number | boolean;
  type AppVar = { id: string; name: string; type: string; value: Scalar; expr?: string };
  type Act = {
    onTap?: string;
    target?: string;
    state?: string;
    url?: string;
    variable?: { id: string; op?: string; value?: Scalar | { alias: string } };
    if?: { variableId: string; op: string; value: Scalar };
    then?: Act[];
    else?: Act[];
  };
  const appVars: AppVar[] = [];
  let appValues: Record<string, Scalar> = {};
  const STORE_KEY = "cdr-app-state";
  const num = (v: Scalar | undefined) =>
    typeof v === "number"
      ? v
      : typeof v === "boolean"
        ? Number(v)
        : Number.parseFloat(
            String(v ?? "")
              .replace(/[^\d.,-]/g, "")
              .replace(",", "."),
          );
  const nameKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const lookup = (name: string): Scalar | undefined => {
    if (name in appValues) return appValues[name];
    const k = nameKey(name);
    const hit = appVars.find(
      (v) => nameKey(v.name) === k || nameKey(v.name.split("/").pop() || v.name) === k,
    );
    return hit ? appValues[hit.id] : undefined;
  };
  const lang = () =>
    doc.documentElement.getAttribute("lang") ||
    (doc.querySelector("[lang]") && doc.querySelector("[lang]")!.getAttribute("lang")) ||
    "de-DE";
  const fmt = (n: number) => {
    const whole = Math.abs(n - Math.round(n)) < 1e-9;
    try {
      return n.toLocaleString(lang(), { maximumFractionDigits: whole ? 0 : 2 });
    } catch {
      return String(n);
    }
  };
  function evalPart(body: string): number | string {
    const tokens = body.match(/\d+(?:[.,]\d+)?|[A-Za-z_$][\w$.-]*|[+\-*]/g) || [];
    if (tokens.length === 1 && /^[A-Za-z_$]/.test(tokens[0]!)) {
      const v = lookup(tokens[0]!);
      return v === undefined ? "" : typeof v === "number" ? v : String(v);
    }
    let total = 0,
      term = 0,
      sign = 1,
      mul = false;
    for (const t of tokens) {
      if (t === "+" || t === "-") {
        total += sign * term;
        sign = t === "-" ? -1 : 1;
        term = 0;
        mul = false;
        continue;
      }
      if (t === "*") {
        mul = true;
        continue;
      }
      const raw = /^\d/.test(t) ? Number(t.replace(",", ".")) : num(lookup(t));
      const n = Number.isFinite(raw) ? raw : 0;
      term = mul ? term * n : n;
      mul = false;
    }
    return total + sign * term;
  }
  const evalTemplate = (tpl: string) =>
    tpl.replace(/\{([^{}]*)\}/g, (_m, b: string) => {
      const v = evalPart(b);
      return typeof v === "number" ? fmt(v) : v;
    });
  function compute() {
    for (let pass = 0; pass < 2; pass++) {
      for (const v of appVars) {
        if (!v.expr) continue;
        const one = /^\s*\{([^{}]*)\}\s*$/.exec(v.expr);
        const p = v.type === "number" && one ? evalPart(one[1]!) : null;
        appValues[v.id] = typeof p === "number" ? p : evalTemplate(v.expr);
      }
    }
  }
  function holds(c: { variableId: string; op?: string; value: Scalar } | undefined): boolean {
    if (!c) return true;
    const cur = appValues[c.variableId],
      want = c.value;
    const n1 = num(cur),
      n2 = num(want);
    const numeric =
      Number.isFinite(n1) && Number.isFinite(n2) && typeof cur !== "boolean" && typeof want !== "boolean";
    const eq = numeric ? n1 === n2 : String(cur) === String(want);
    switch (c.op || "eq") {
      case "eq":
        return eq;
      case "neq":
        return !eq;
      case "gt":
        return numeric && n1 > n2;
      case "gte":
        return numeric && n1 >= n2;
      case "lt":
        return numeric && n1 < n2;
      case "lte":
        return numeric && n1 <= n2;
      default:
        return false;
    }
  }
  const parse = <T>(s: string | null): T | null => {
    if (!s) return null;
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };
  function loadVars() {
    const seen = new Set(appVars.map((v) => v.id));
    for (const host of Array.prototype.slice.call(doc.querySelectorAll("[data-app-vars]")) as HTMLElement[]) {
      for (const v of parse<AppVar[]>(host.getAttribute("data-app-vars")) || []) {
        if (!v || typeof v.id !== "string" || seen.has(v.id)) continue;
        seen.add(v.id);
        appVars.push(v);
        if (!(v.id in appValues)) appValues[v.id] = v.value;
      }
    }
  }
  function applyApp() {
    compute();
    for (const el of Array.prototype.slice.call(
      doc.querySelectorAll("[data-app-act]:not(button):not(a):not([tabindex])"),
    ) as HTMLElement[])
      el.setAttribute("tabindex", "0");
    for (const el of Array.prototype.slice.call(doc.querySelectorAll("[data-app-text]")) as HTMLElement[]) {
      const v = appValues[el.getAttribute("data-app-text") || ""];
      if (v !== undefined && el.textContent !== String(v)) el.textContent = String(v);
    }
    for (const el of Array.prototype.slice.call(doc.querySelectorAll("[data-app-show]")) as HTMLElement[]) {
      const show = holds(parse(el.getAttribute("data-app-show")) || undefined);
      el.style.display = show ? el.getAttribute("data-app-display") || "" : "none";
    }
  }
  function saveApp() {
    try {
      win.sessionStorage.setItem(STORE_KEY, JSON.stringify(appValues));
    } catch {
      /* private mode */
    }
  }
  // choices carry over from another page of the app (a link followed), not into a fresh visit or a reload
  try {
    const ref = doc.referrer;
    const from =
      ref && ref.indexOf(win.location.origin) === 0
        ? ref.slice(win.location.origin.length).split(/[?#]/)[0]
        : "";
    const nav =
      win.performance && win.performance.getEntriesByType
        ? (win.performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
        : undefined;
    if (from && from !== win.location.pathname && (!nav || nav.type !== "reload")) {
      const saved = parse<Record<string, Scalar>>(win.sessionStorage.getItem(STORE_KEY));
      if (saved) appValues = saved;
    }
  } catch {
    /* no storage */
  }
  /** Show state `id` of every app region with that id (one per breakpoint variant); a region scrolled past comes back into view. */
  function showAppState(target: string, id: string) {
    for (const region of Array.prototype.slice.call(
      doc.querySelectorAll(`[data-app-id="${target}"]`),
    ) as HTMLElement[]) {
      const states = Array.prototype.filter.call(region.children, (c: Element) =>
        c.hasAttribute("data-pt-state"),
      ) as HTMLElement[];
      const next = states.find((c) => c.getAttribute("data-pt-state") === id) || stateFor(states, id);
      if (!next) continue;
      for (const s of states) if (s !== next) s.style.display = "none";
      next.style.display = next.getAttribute("data-pt-display") || "flex";
      region.setAttribute("data-app-state", id);
      if (shown(region)) {
        const top = region.getBoundingClientRect().top;
        if (top < 0) region.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
      }
    }
  }
  function runAct(a: Act | null | undefined, depth = 0) {
    if (!a || !a.onTap || depth > 16) return;
    switch (a.onTap) {
      case "set-variable": {
        const v = a.variable;
        if (!v || !v.id) return;
        const cur = appValues[v.id];
        const op = v.op || "set";
        if (op === "toggle") appValues[v.id] = !(cur === true || cur === "true");
        else if (op === "increment" || op === "decrement") {
          const step = v.value === undefined || typeof v.value === "object" ? 1 : num(v.value);
          const base = num(cur);
          appValues[v.id] =
            (Number.isFinite(base) ? base : 0) +
            (op === "increment" ? 1 : -1) * (Number.isFinite(step) ? step : 1);
        } else if (v.value !== undefined)
          appValues[v.id] = typeof v.value === "object" ? appValues[v.value.alias]! : v.value;
        compute();
        return;
      }
      case "conditional": {
        const branch = !a.if || holds(a.if) ? a.then : a.else;
        for (const x of branch || []) runAct(x, depth + 1);
        return;
      }
      case "set-state":
        if (a.target && a.state) showAppState(a.target, a.state);
        return;
      case "scroll-to": {
        const t = a.target ? doc.querySelector<HTMLElement>(`[data-app-id="${a.target}"]`) : null;
        if (t) t.scrollIntoView({ behavior: reduced() ? "auto" : "smooth" });
        return;
      }
      case "open-url":
        if (a.url) win.open(a.url, "_blank", "noopener");
        return;
      default:
        return;
    }
  }
  listen(doc, "click", (e) => {
    const t = e.target as Element;
    const tap = t && t.closest ? t.closest<HTMLElement>("[data-app-act]") : null;
    if (!tap) return;
    const act = parse<Act>(tap.getAttribute("data-app-act"));
    if (!act) return;
    e.preventDefault();
    // a form's submit confirms only with its required fields filled
    const form = tap.hasAttribute("data-app-submit") ? tap.closest<HTMLElement>("[data-app-form]") : null;
    if (form) {
      let first: HTMLElement | null = null;
      for (const f of Array.prototype.slice.call(
        form.querySelectorAll("[data-app-required]"),
      ) as HTMLElement[]) {
        const input = (
          f.matches("input, textarea, select") ? f : f.querySelector("input, textarea, select")
        ) as HTMLInputElement | null;
        if (!input) continue;
        const empty =
          !String(input.value || "").trim() || (input.type === "email" && !/.+@.+\..+/.test(input.value));
        input.setAttribute("aria-invalid", empty ? "true" : "false");
        f.style.outline = empty ? "2px solid currentColor" : "";
        f.style.outlineOffset = empty ? "2px" : "";
        if (empty && !first) first = input;
      }
      const err = form.querySelector<HTMLElement>("[data-app-error]");
      if (err) err.style.display = first ? err.getAttribute("data-app-display") || "block" : "none";
      if (first) {
        first.focus();
        return;
      }
    }
    // what the form took goes into its variables (a confirmation greets with them)
    const holder = tap.hasAttribute("data-app-submit")
      ? (tap.closest<HTMLElement>("[data-app-form]") ?? tap.parentElement)
      : null;
    if (holder) {
      for (const f of Array.prototype.slice.call(
        holder.querySelectorAll("[data-app-input]"),
      ) as HTMLElement[]) {
        const input = (
          f.matches("input, textarea") ? f : f.querySelector("input, textarea")
        ) as HTMLInputElement | null;
        const id = f.getAttribute("data-app-input");
        if (input && id) appValues[id] = String(input.value || "").trim();
      }
      compute();
    }
    // a copy button puts its code on the clipboard
    const copy =
      tap.getAttribute("data-app-copy") ??
      (tap.closest("[data-app-copy]") as HTMLElement | null)?.getAttribute("data-app-copy");
    if (copy) {
      const nav = (win as Window).navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(copy).catch(() => {});
    }
    runAct(act);
    applyApp();
    saveApp();
  });
  listen(doc, "keydown", (ev) => {
    const e = ev as KeyboardEvent;
    const t = e.target as HTMLElement;
    if (
      (e.key !== "Enter" && e.key !== " ") ||
      !t ||
      !t.matches ||
      t.tagName === "BUTTON" ||
      t.tagName === "A" ||
      t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA"
    )
      return;
    if (t.matches("[data-app-act]")) {
      e.preventDefault();
      t.click();
    }
  });
  // a single-page app (React) renders another screen: its variables join, its texts show the current values
  const loadAndApply = () => {
    if (!doc.querySelector("[data-app-vars], [data-app-text], [data-app-show], [data-app-act]")) return;
    loadVars();
    applyApp();
  };
  const AppObserver = (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (typeof AppObserver === "function") {
    let queued = false;
    const mo = new AppObserver(() => {
      if (queued) return;
      queued = true;
      win.requestAnimationFrame(() => {
        queued = false;
        loadAndApply();
      });
    });
    mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    cleanups.push(() => mo.disconnect());
  }
  loadAndApply();

  /* ---------------------------------------------------------------- menus (overlays the page opens) */

  let opener: HTMLElement | null = null;
  let wasOpen = false;
  const openLayers = () =>
    Array.prototype.slice.call(doc.querySelectorAll("[data-overlay][data-open]")) as HTMLElement[];
  function overlaysChanged() {
    const open = openLayers();
    const root = doc.documentElement;
    if (open.length && !wasOpen) {
      // the page behind an open menu stays put; focus moves into the menu (back to its button once it closes)
      opener =
        doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
      root.setAttribute("data-scroll-lock", "");
    } else if (!open.length && wasOpen) {
      root.removeAttribute("data-scroll-lock");
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      opener = null;
    }
    const top = open[open.length - 1];
    const panel = top ? top.querySelector<HTMLElement>("[data-overlay-panel]") : null;
    if (panel && !panel.contains(doc.activeElement)) {
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      panel.focus({ preventScroll: true });
    }
    wasOpen = open.length > 0;
  }
  const Observer = (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (typeof Observer === "function") {
    const mo = new Observer(overlaysChanged);
    mo.observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-open"] });
    cleanups.push(() => mo.disconnect());
  }
  // focus stays in the open menu
  listen(doc, "focusin", (e) => {
    const open = openLayers();
    const top = open[open.length - 1];
    const panel = top ? top.querySelector<HTMLElement>("[data-overlay-panel]") : null;
    if (panel && e.target instanceof Node && !top!.contains(e.target)) panel.focus({ preventScroll: true });
  });

  /* ---------------------------------------------------------------- pinned boxes that move on scroll */

  const shifted = Array.prototype.slice.call(doc.querySelectorAll("[data-scroll-shift]")) as HTMLElement[];
  if (shifted.length) {
    const place = () => {
      const y = win.scrollY || doc.documentElement.scrollTop || 0;
      for (const el of shifted) {
        const dy = Number(el.getAttribute("data-scroll-shift")) || 0;
        const along = el.getAttribute("data-scroll-shift-mode") === "scroll";
        const after = Number(el.getAttribute("data-scroll-shift-after")) || 0;
        const by = along ? Math.sign(dy) * Math.min(Math.abs(dy), y) : y > after ? dy : 0;
        el.style.translate = by ? `0 ${by}px` : "";
      }
    };
    for (const el of shifted)
      if (el.getAttribute("data-scroll-shift-mode") !== "scroll" && !reduced())
        el.style.transition = "translate .2s ease-out";
    listen(win, "scroll", place, { passive: true });
    place();
  }

  init();
  // another breakpoint's variant shows: its sliders' dots are found once they have a size
  listen(win, "resize", () => {
    for (const box of Array.prototype.slice.call(doc.querySelectorAll("[data-scroller]")) as HTMLElement[]) {
      if (!dotsCache.has(box) && shown(box)) {
        snapSlides(box);
        dotsOf(box);
      }
    }
  });
  return () => {
    for (const c of cleanups.splice(0).reverse()) c();
  };
}

/**
 * Motion (dsl/motion.ts): entrances waiting for their layer to scroll into view get `data-motion-in` once it does; a
 * number in a `data-counter` text counts up from 0 each time the text comes into view (a step shown again counts
 * again). Works on any root (the Preview player's stage too); layers added later are picked up. Self-contained.
 */
export function installMotion(win: Window, root: Document | HTMLElement): () => void {
  const IO = (win as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  const MO = (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const reduced = !!win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const seen = new WeakSet<Element>();
  const original = new WeakMap<Element, string>();
  const counting = new WeakMap<Element, number>();
  function count(el: HTMLElement) {
    const text = original.get(el) ?? el.textContent ?? "";
    original.set(el, text);
    const m = /(\d[\d.,\s]*\d|\d)/.exec(text);
    if (!m || reduced) return;
    const digits = m[1]!;
    const sep = /\d[.,\s]\d{3}(?!\d)/.test(digits)
      ? /\d(\.)\d{3}/.exec(digits)
        ? "."
        : /\d(,)\d{3}/.exec(digits)
          ? ","
          : " "
      : "";
    const dec = sep === "." ? "," : ".";
    const clean = sep ? digits.split(sep).join("") : digits;
    const target = Number(clean.replace(dec, "."));
    if (!Number.isFinite(target)) return;
    const places = (clean.split(dec)[1] || "").length;
    const fmt = (n: number) => {
      const s = n.toFixed(places);
      const [a, b] = s.split(".");
      const g = sep ? a!.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : a!;
      return b ? `${g}${dec}${b}` : g;
    };
    const dur = Math.min(2400, 900 + String(Math.round(target)).length * 220);
    const t0 = win.performance ? win.performance.now() : Date.now();
    const id = (counting.get(el) ?? 0) + 1;
    counting.set(el, id);
    const tick = () => {
      if (counting.get(el) !== id) return;
      const t = Math.min(1, ((win.performance ? win.performance.now() : Date.now()) - t0) / dur);
      const k = 1 - Math.pow(1 - t, 3);
      el.textContent = text.slice(0, m.index) + fmt(target * k) + text.slice(m.index + digits.length);
      if (t < 1) win.requestAnimationFrame(tick);
      else el.textContent = text;
    };
    tick();
    // frames can stall (a hidden tab, a busy player): the figure lands on its value when the count is due
    win.setTimeout(() => {
      if (counting.get(el) === id) {
        counting.set(el, -1);
        el.textContent = text;
      }
    }, dur + 120);
  }
  const io =
    typeof IO === "function"
      ? new IO(
          (entries) => {
            for (const e of entries) {
              const el = e.target as HTMLElement;
              // out of view: the count stops and the figure shows its full value again (never a number cut short)
              if (!e.isIntersecting) {
                if (el.hasAttribute("data-counter")) {
                  counting.set(el, -1);
                  const full = original.get(el);
                  if (full !== undefined) el.textContent = full;
                }
                continue;
              }
              if (el.hasAttribute("data-motion-trigger")) el.setAttribute("data-motion-in", "");
              if (el.hasAttribute("data-counter")) count(el);
            }
          },
          { threshold: 0.15 },
        )
      : null;
  function scan() {
    const list = Array.prototype.slice.call(
      root.querySelectorAll('[data-motion-trigger="view"], [data-counter]'),
    ) as HTMLElement[];
    for (const el of list) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (io) io.observe(el);
      else el.setAttribute("data-motion-in", "");
    }
    // an entrance never keeps content hidden: what has not come into view after a moment shows anyway (a choice below
    // the fold, a screenshot, an assistive tool reading the page)
    if (list.length)
      win.setTimeout(() => {
        for (const el of list)
          if (el.hasAttribute("data-motion-trigger") && !el.hasAttribute("data-motion-in"))
            el.setAttribute("data-motion-in", "");
      }, 1500);
  }
  scan();
  const readyOn = (root as Document).documentElement ?? (root as HTMLElement);
  readyOn.setAttribute("data-motion-ready", "");
  let mo: MutationObserver | null = null;
  if (typeof MO === "function") {
    let queued = false;
    mo = new MO(() => {
      if (queued) return;
      queued = true;
      win.requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    });
    mo.observe(root, { childList: true, subtree: true });
  }
  return () => {
    readyOn.removeAttribute("data-motion-ready");
    if (io) io.disconnect();
    if (mo) mo.disconnect();
  };
}
