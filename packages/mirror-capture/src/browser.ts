/**
 * Code evaluated inside the crawled page. Kept as plain JS strings (not TS functions) so bundler helpers
 * (esbuild's __name etc.) never leak into page.evaluate.
 */

/** Computed-style properties captured per key element. */
export const STYLE_PROPS = [
  "color",
  "backgroundColor",
  "backgroundImage",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "textDecorationLine",
  "marginTop",
  "marginBottom",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderRadius",
  "borderTopWidth",
  "borderTopColor",
  "boxShadow",
  "display",
  "gap",
  "gridTemplateColumns",
  "maxWidth",
  "width",
  "height",
] as const;

/** Key elements: [key, selector]. First visible match per key is snapshotted. */
export const KEY_ELEMENTS: [string, string][] = [
  ["body", "body"],
  ["h1", "h1:not(.visually-hidden)"],
  ["h2", "h2:not(.visually-hidden)"],
  ["h3", "h3:not(.visually-hidden)"],
  ["p", "main p, [role=main] p, p"],
  ["a", ".text-content p a, main p a, [role=main] p a, main a:not(.button)"],
  ["button", ".button, button"],
  ["buttonPrimary", ".button--primary"],
  ["header", "header, [role=banner]"],
  ["nav", "nav, [role=navigation]"],
  ["navLink", "nav a, [role=navigation] a"],
  ["main", "main, [role=main]"],
  ["footer", "footer, [role=contentinfo]"],
  ["footerLink", "footer a"],
  ["container", ".container, .layout-container"],
  ["hero", ".paragraph--type--hero, .hero, [class*=hero]"],
  ["card", ".teaser, .card, [class*=card]"],
  ["img", "main img"],
  ["blockquote", "blockquote"],
  ["table", "table"],
  ["li", "main li"],
];

/** esbuild keepNames (tsx) may wrap inner functions in __name(); define it in the page. */
const NAME_SHIM = "var __name = function (f) { return f; };";

export const COLLECT_STYLES_JS = `(${function collect(cfg: { props: string[]; keys: [string, string][] }) {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const pick = (cs: CSSStyleDeclaration) => {
    const o: Record<string, string> = {};
    for (const p of cfg.props) o[p] = (cs as unknown as Record<string, string>)[p];
    return o;
  };
  const elements: unknown[] = [];
  for (const [key, sel] of cfg.keys) {
    let found: Element | undefined;
    for (const part of sel.split(/,\s*/)) {
      try {
        found = Array.from(document.querySelectorAll(part)).find(visible);
      } catch {
        found = undefined;
      }
      if (found) break;
    }
    if (!found) continue;
    const r = found.getBoundingClientRect();
    elements.push({
      key,
      selector: sel,
      tag: found.tagName.toLowerCase(),
      classes: Array.from(found.classList),
      rect: { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) },
      styles: pick(getComputedStyle(found)),
    });
  }
  const hist = {
    color: {} as Record<string, number>,
    backgroundColor: {} as Record<string, number>,
    borderColor: {} as Record<string, number>,
    fontSize: {} as Record<string, number>,
    fontFamily: {} as Record<string, number>,
    fontWeight: {} as Record<string, number>,
    lineHeight: {} as Record<string, number>,
    spacing: {} as Record<string, number>,
    radius: {} as Record<string, number>,
    shadow: {} as Record<string, number>,
    typography: {} as Record<string, number>,
  };
  const inc = (h: Record<string, number>, k: string | undefined) => {
    if (!k) return;
    h[k] = (h[k] ?? 0) + 1;
  };
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
    if (hasText) {
      inc(hist.color, cs.color);
      inc(hist.fontSize, cs.fontSize);
      inc(hist.fontFamily, cs.fontFamily);
      inc(hist.fontWeight, cs.fontWeight);
      inc(hist.lineHeight, cs.lineHeight);
      inc(hist.typography, [el.tagName.toLowerCase(), cs.fontSize, cs.fontWeight, cs.lineHeight, cs.fontFamily.split(",")[0].replace(/["']/g, "").trim()].join("|"));
    }
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") inc(hist.backgroundColor, cs.backgroundColor);
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none") inc(hist.borderColor, cs.borderTopColor);
    for (const p of ["marginTop", "marginBottom", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "rowGap", "columnGap"]) {
      const v = (cs as unknown as Record<string, string>)[p];
      if (v && v !== "0px" && v !== "normal" && /px$/.test(v)) inc(hist.spacing, v);
    }
    if (cs.borderTopLeftRadius && cs.borderTopLeftRadius !== "0px") inc(hist.radius, cs.borderTopLeftRadius);
    if (cs.boxShadow && cs.boxShadow !== "none") inc(hist.shadow, cs.boxShadow);
  }
  // custom properties declared on :root (same-origin sheets only) + media queries
  const vars: Record<string, string> = {};
  const media: string[] = [];
  const rootStyle = getComputedStyle(document.documentElement);
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const anyRule = rule as CSSRule & { selectorText?: string; style?: CSSStyleDeclaration; media?: MediaList; cssRules?: CSSRuleList; conditionText?: string };
      if (anyRule.media && anyRule.cssRules) {
        const m = anyRule.conditionText ?? anyRule.media.mediaText;
        if (m && !media.includes(m)) media.push(m);
        visit(anyRule.cssRules);
      } else if (anyRule.selectorText && anyRule.style && /(^|,)\s*(:root|html)\s*(,|$)/.test(anyRule.selectorText)) {
        for (let i = 0; i < anyRule.style.length; i++) {
          const name = anyRule.style[i];
          if (name.startsWith("--")) vars[name] = rootStyle.getPropertyValue(name).trim();
        }
      }
    }
  };
  const sheets: { href: string | null; media: string; rules: number }[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
      sheets.push({ href: sheet.href, media: sheet.media.mediaText, rules: sheet.cssRules.length });
    } catch {
      sheets.push({ href: sheet.href, media: sheet.media.mediaText, rules: -1 });
    }
  }
  const fonts: { family: string; weight: string; style: string; status: string }[] = [];
  (document as Document & { fonts: FontFaceSet }).fonts.forEach((f: FontFace) => fonts.push({ family: f.family.replace(/["']/g, ""), weight: f.weight, style: f.style, status: f.status }));
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentHeight: Math.round(document.documentElement.scrollHeight),
    elements,
    histograms: hist,
    cssVariables: vars,
    mediaQueries: media,
    stylesheets: sheets,
    fonts,
  };
}.toString()})`;

/** Scrolls through the page so lazy images load, then back to top; resolves when images are complete. */
export const SETTLE_JS = `${NAME_SHIM}(${async function settle() {
  // half a viewport per step: throttled scroll handlers and reveal thresholds miss larger jumps (bvg.de on mobile)
  const step = Math.max(200, Math.floor(window.innerHeight * 0.5));
  // Scroll-reveal animations (IntersectionObserver adds `animate` / `in-view` / `aos-animate`, CSS fades from opacity 0)
  // must end in their revealed state, as a visitor sees them: classes added to an initially invisible element while it
  // was in view are put back if a script removes them again when it leaves the viewport.
  const hidden = new Set<Element>();
  for (const el of Array.from(document.body.querySelectorAll("*")).slice(0, 20000)) {
    const cs = getComputedStyle(el);
    if (cs.opacity === "0" || cs.visibility === "hidden") hidden.add(el);
  }
  const added = new Map<Element, Set<string>>();
  const mo = new MutationObserver((ms) => {
    for (const m of ms) {
      const el = m.target as Element;
      if (!hidden.has(el)) continue;
      const before = new Set((m.oldValue ?? "").split(/\s+/).filter(Boolean));
      for (const c of Array.from(el.classList)) if (!before.has(c)) (added.get(el) ?? added.set(el, new Set()).get(el)!).add(c);
    }
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ["class"], attributeOldValue: true, subtree: true });
  // capped for very long / infinite pages; lazy loaders (blazy, IntersectionObserver, loading=lazy) fire on scroll.
  // 150 ms per step: observers and framework state updates need a few frames (40 ms missed React reveal effects).
  for (let y = 0, n = 0; y < document.documentElement.scrollHeight && n < 250; y += step, n++) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 150));
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise((r) => setTimeout(r, 200));
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 100));
  mo.disconnect();
  for (const [el, cls] of added) for (const c of cls) if (!el.classList.contains(c)) el.classList.add(c);
  const imgs = Array.from(document.images);
  await Promise.all(
    imgs.map((img) =>
      img.complete ? Promise.resolve() : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); ((window as unknown as { __cmpSetTimeout?: typeof setTimeout }).__cmpSetTimeout ?? setTimeout)(r, 3000); }),
    ),
  );
  await (document as Document & { fonts: FontFaceSet }).fonts.ready;
  return imgs.map((i) => ({ src: i.currentSrc || i.src, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, alt: i.alt }));
}.toString()})()`;

/** Raw-text extraction helpers evaluated as source strings. */
export function evalCollect(): string {
  return `${NAME_SHIM}${COLLECT_STYLES_JS}(${JSON.stringify({ props: STYLE_PROPS, keys: KEY_ELEMENTS })})`;
}
