/**
 * Navigation interactions (menus, mobile nav, search / dealer layers) observed while crawling.
 *
 * The crawl opens each header/nav toggle of a page once per viewport and closes it again:
 *  - code the site loads only on that click (a menu flyout bundle) is requested and captured like every other asset,
 *    so a statically rendered page that runs the original scripts does not hit a missing chunk;
 *  - what the click changed in the DOM is recorded (attributes set, subtrees inserted). A page rendered from its
 *    browser DOM without the original scripts (react mode: a Next.js source) replays these records at runtime, so its
 *    menus open and close like on the original.
 * Second-level toggles inside an opened panel (mobile sub-menus) are recorded as children of that toggle.
 */
import type { Page } from "playwright";

export interface DomChange {
  /** attribute set on an element that existed before the click */
  attr?: { target: string; name: string; value: string | null };
  /** subtree inserted by the click: outerHTML placed into `parent` before `before` (null = appended) */
  insert?: { parent: string; before: string | null; html: string };
}
export interface InteractionRecord {
  /** unique CSS selector of the toggle */
  trigger: string;
  label: string;
  changes: DomChange[];
  children?: InteractionRecord[];
}
export interface ViewportInteractions {
  width: number;
  records: InteractionRecord[];
}

/** page-side helpers (plain JS: evaluated as source, no transpiler helpers) */
const PAGE_LIB = `
var CMP_I = window.__cmpInteractions || (window.__cmpInteractions = {});
CMP_I.esc = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\\\" + c; }); };
CMP_I.unique = function (sel, root) { try { return (root || document).querySelectorAll(sel).length === 1; } catch (e) { return false; } };
CMP_I.part = function (el) {
  var s = el.tagName.toLowerCase();
  var cls = Array.prototype.filter.call(el.classList, function (c) { return !/^(is-|has-|active|open|focus|hover|visible|show|js-)/i.test(c); }).slice(0, 4);
  cls.forEach(function (c) { s += "." + CMP_I.esc(c); });
  var label = el.getAttribute("aria-label");
  if (label) s += '[aria-label="' + label.replace(/"/g, '\\\\"') + '"]';
  return s;
};
CMP_I.selector = function (el) {
  if (!el || el.nodeType !== 1) return null;
  if (el === document.body) return "body";
  if (el === document.documentElement) return "html";
  var path = [], cur = el;
  for (var depth = 0; cur && cur.nodeType === 1 && cur !== document.body && depth < 12; depth++) {
    var p = CMP_I.part(cur), parent = cur.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
      var withPart = Array.prototype.filter.call(parent.children, function (c) { try { return c.matches(p); } catch (e) { return false; } });
      if (withPart.length > 1) p += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
    }
    path.unshift(p);
    var sel = path.join(" > ");
    if (CMP_I.unique(sel)) return sel;
    cur = parent;
  }
  var full = (cur === document.body ? "body > " : "") + path.join(" > ");
  return CMP_I.unique(full) ? full : null;
};
CMP_I.visible = function (e) { var r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom > 0 && r.top < innerHeight; };
CMP_I.TOGGLE = "button, [role=button], summary, [aria-expanded], [aria-haspopup]";
CMP_I.REGION = "header, nav, [role=banner], [role=navigation], [class*=header], [class*=Header], [class*=navbar], [class*=NavBar], [class*=masthead], [class*=Masthead]";
CMP_I.toggles = function (root, topOnly) {
  var list = Array.prototype.slice.call((root || document).querySelectorAll(CMP_I.TOGGLE));
  return list.filter(function (e) {
    if (!CMP_I.visible(e) || e.closest("a[href]") && e.tagName !== "BUTTON") return false;
    if (e.getAttribute("aria-expanded") === "true" || e.disabled) return false;
    if (topOnly) { if (e.getBoundingClientRect().top > 220 || !e.closest(CMP_I.REGION)) return false; }
    else if (e.getAttribute("aria-expanded") === null && !e.getAttribute("aria-haspopup") && !e.getAttribute("aria-controls")) return false;
    return true;
  }).slice(0, 12);
};
CMP_I.SKIP_ATTR = /^(data-(pressed|focus|focused|focus-visible|hovered|hover|entering|exiting|react-aria|rac)|style$)/;
CMP_I.start = function () {
  var log = CMP_I.log = { attrs: new Map(), added: [] };
  CMP_I.mo = new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      if (m.type === "childList") { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) log.added.push(n); }); return; }
      var t = m.target;
      if (!log.attrs.has(t)) log.attrs.set(t, new Map());
      var a = log.attrs.get(t);
      if (!a.has(m.attributeName)) a.set(m.attributeName, m.oldValue);
    });
  });
  CMP_I.mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
};
CMP_I.stop = function () {
  CMP_I.mo.disconnect();
  var log = CMP_I.log, changes = [], roots = [];
  // inserted subtrees still in the document; nested ones are covered by their top-most inserted ancestor
  log.added.forEach(function (n) { if (n.isConnected && roots.indexOf(n) < 0) roots.push(n); });
  roots = roots.filter(function (n) { return !roots.some(function (o) { return o !== n && o.contains(n); }); });
  roots.forEach(function (n) {
    if (/^(SCRIPT|STYLE|LINK|IFRAME)$/.test(n.tagName)) return;
    var parent = CMP_I.selector(n.parentElement);
    if (!parent) return;
    var next = n.nextElementSibling;
    while (next && roots.indexOf(next) >= 0) next = next.nextElementSibling;
    changes.push({ insert: { parent: parent, before: next ? CMP_I.selector(next) : null, html: n.outerHTML } });
  });
  log.attrs.forEach(function (attrs, t) {
    if (!t.isConnected || roots.some(function (r) { return r.contains(t); })) return;
    var target = CMP_I.selector(t);
    if (!target) return;
    attrs.forEach(function (old, name) {
      var now = t.getAttribute(name);
      if (now === old || CMP_I.SKIP_ATTR.test(name) && name !== "style") return;
      if (name === "style" && t !== document.body && t !== document.documentElement) return;
      changes.push({ attr: { target: target, name: name, value: now } });
    });
  });
  return { changes: changes, roots: roots.map(function (r) { return CMP_I.selector(r); }).filter(Boolean) };
};
`;

/** open/close every header toggle of the loaded page (lazy chunks load) and record what each one changes */
export async function exerciseInteractions(page: Page, opts: { maxDepth?: number } = {}): Promise<InteractionRecord[]> {
  const maxDepth = opts.maxDepth ?? 2;
  await page.evaluate(PAGE_LIB);
  const pageUrl = page.url();
  const settle = async () => {
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  };
  const close = async (trigger: string) => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(300);
    const stillOpen = await page.evaluate((sel: string) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", trigger).catch(() => false);
    if (stillOpen) {
      await page.evaluate((sel: string) => (document.querySelector(sel) as HTMLElement | null)?.click(), trigger).catch(() => undefined);
      await page.waitForTimeout(400);
    }
  };
  const topLevel = new Set<string>();
  const record = async (topOnly: boolean, scope: string | null, depth: number): Promise<InteractionRecord[]> => {
    const triggers: { sel: string; label: string }[] = await page.evaluate(
      ([topOnly, scope]: [boolean, string | null]) => {
        const I = (window as unknown as { __cmpInteractions: Record<string, (...a: unknown[]) => unknown> }).__cmpInteractions;
        const root = scope ? document.querySelector(scope) : document;
        return ((I.toggles(root, topOnly) as Element[]) ?? [])
          .map((e) => ({ sel: I.selector(e) as string | null, label: (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60) }))
          .filter((t): t is { sel: string; label: string } => !!t.sel);
      },
      [topOnly, scope] as [boolean, string | null],
    );
    const out: InteractionRecord[] = [];
    if (topOnly) for (const t of triggers) topLevel.add(t.sel);
    for (const t of triggers) {
      if (!topOnly && topLevel.has(t.sel)) continue;
      await page.evaluate("window.__cmpInteractions.start()");
      const clicked = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return false;
        el.click();
        return true;
      }, t.sel);
      if (!clicked) continue;
      await settle();
      // a toggle that navigated away (a link styled as button) is not an interaction
      if (page.url() !== pageUrl) {
        await page.goBack({ waitUntil: "load" }).catch(() => undefined);
        await page.evaluate(PAGE_LIB);
        continue;
      }
      const res: { changes: DomChange[]; roots: string[] } = await page.evaluate("window.__cmpInteractions.stop()");
      const rec: InteractionRecord = { trigger: t.sel, label: t.label, changes: res.changes };
      // second level: toggles inside what just opened (inserted panel or the element the toggle controls)
      if (depth < maxDepth && res.changes.length) {
        const inner: string | null = await page.evaluate((sel: string) => {
          const I = (window as unknown as { __cmpInteractions: Record<string, (...a: unknown[]) => unknown> }).__cmpInteractions;
          const el = document.querySelector(sel);
          const id = el?.getAttribute("aria-controls");
          const target = id ? document.getElementById(id) : null;
          return target ? (I.selector(target) as string | null) : null;
        }, t.sel);
        // a sub-menu scope is the opened panel itself, never the page around it
        const scopes = [...new Set([inner, ...res.roots])].filter((s): s is string => !!s && s !== "body" && s !== "html");
        const children: InteractionRecord[] = [];
        for (const sc of scopes) children.push(...(await record(false, sc, depth + 1)));
        if (children.length) rec.children = children.filter((c) => c.trigger !== t.sel);
      }
      if (rec.changes.length) out.push(rec);
      await close(t.sel);
    }
    return out;
  };
  return record(true, null, 1);
}
