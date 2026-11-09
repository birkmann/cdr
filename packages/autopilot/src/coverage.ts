// DS coverage (plan §1, §2.4, §6.4): how much of the painted page is rendered by design-system components.
//
// A painted box counts when it is rendered by a primitive of `@<prefix>-ds/react` or by a repeated component of
// `@<prefix>-ds/site` (a set the page's `components` stage extracted). Boxes of a page's one-off section composites
// (header, hero, bands, footer) do not count: every box of the page is inside one of those, so they say nothing.
// `withSections` reports that wider count for reference.

/** What the in-page probe reports per viewport. */
export interface CoverageSample {
  viewport: string;
  painted: number;
  primitive: number;
  set: number;
  section: number;
  /** painted boxes of the document */
  byComponent: Record<string, number>;
}

export interface CoverageResult {
  /** share of painted boxes rendered by primitives and repeated components (the gated number): the lowest viewport */
  value: number;
  /** the same but counting the section composites too */
  withSections: number;
  /** share rendered by primitives alone */
  primitiveOnly: number;
  perViewport: Record<
    string,
    { value: number; withSections: number; primitiveOnly: number; sample: CoverageSample }
  >;
}

const share = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : 0);

export function summariseCoverage(samples: readonly CoverageSample[]): CoverageResult {
  const perViewport: CoverageResult["perViewport"] = {};
  for (const s of samples)
    perViewport[s.viewport] = {
      value: share(s.primitive + s.set, s.painted),
      withSections: share(s.primitive + s.set + s.section, s.painted),
      primitiveOnly: share(s.primitive, s.painted),
      sample: s,
    };
  const values = Object.values(perViewport);
  return {
    value: values.length ? Math.min(...values.map((v) => v.value)) : 0,
    withSections: values.length ? Math.min(...values.map((v) => v.withSections)) : 0,
    primitiveOnly: values.length ? Math.min(...values.map((v) => v.primitiveOnly)) : 0,
    perViewport,
  };
}

/** Runs in the page: counts every painted box (open shadow roots included) by what renders it. */
export const COVERAGE_PROBE_JS = `(() => {
  const IGNORE = new Set(["SCRIPT","STYLE","LINK","META","HEAD","TITLE","NOSCRIPT","TEMPLATE","SOURCE"]);
  const paints = (el, cs) => {
    if (["IMG","SVG","VIDEO","CANVAS","INPUT","SELECT","TEXTAREA","PICTURE"].includes(el.tagName.toUpperCase())) return true;
    if (cs.backgroundImage !== "none") return true;
    const a = cs.backgroundColor;
    if (a && a !== "transparent" && a !== "rgba(0, 0, 0, 0)") return true;
    for (const s of ["Top","Right","Bottom","Left"]) if (parseFloat(cs["border"+s+"Width"]) > 0 && cs["border"+s+"Style"] !== "none") return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  };
  const out = { painted: 0, primitive: 0, set: 0, section: 0, byComponent: {} };
  const visit = (el, ctx) => {
    if (el.nodeType !== 1 || IGNORE.has(el.tagName)) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;
    let c = ctx;
    const kind = el.getAttribute && el.getAttribute("data-ds-kind");
    const prim = el.getAttribute && el.getAttribute("data-ds-primitive");
    if (kind === "section" && !c.primitive && !c.set) c = { ...c, section: el.getAttribute("data-ds"), set: null };
    else if (kind === "set" && !c.primitive) c = { ...c, set: el.getAttribute("data-ds") };
    if (prim) c = { ...c, primitive: prim };
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && paints(el, cs)) {
      out.painted++;
      if (c.primitive) { out.primitive++; const k = "primitive:" + c.primitive; out.byComponent[k] = (out.byComponent[k] || 0) + 1; }
      else if (c.set) { out.set++; const k = "set:" + c.set; out.byComponent[k] = (out.byComponent[k] || 0) + 1; }
      else if (c.section) { out.section++; const k = "section:" + c.section; out.byComponent[k] = (out.byComponent[k] || 0) + 1; }
    }
    if (el.shadowRoot) for (const k of el.shadowRoot.children) visit(k, c);
    for (const k of el.children) visit(k, c);
  };
  for (const el of document.body.children) visit(el, { primitive: null, set: null, section: null });
  return out;
})()`;
