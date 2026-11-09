import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { exerciseInteractions } from "../src/interactions.js";

// a header whose menu panel is inserted by script on click (bvg.de: react-aria popover) and whose code is loaded lazily
const PAGE = `<!doctype html><html><body>
<header class="site-header"><nav class="navbar">
  <a href="/">Home</a>
  <button class="menu-button" aria-label="Seitenmenü anzeigen" aria-expanded="false">≡</button>
</nav></header>
<main><p>Content</p></main>
<script>
  const btn = document.querySelector(".menu-button");
  btn.addEventListener("click", () => {
    const nav = document.querySelector(".navbar");
    const open = btn.getAttribute("aria-expanded") === "true";
    if (open) { document.querySelector(".popover")?.remove(); btn.setAttribute("aria-expanded", "false"); return; }
    btn.setAttribute("aria-expanded", "true");
    const p = document.createElement("div");
    p.className = "popover";
    p.innerHTML = '<ul><li><a href="/de/verbindungen">Verbindungen</a></li><li><button class="sub" aria-expanded="false">Mehr</button></li></ul>';
    nav.appendChild(p);
    p.querySelector(".sub").addEventListener("click", (e) => {
      const b = e.currentTarget; b.setAttribute("aria-expanded", "true");
      const s = document.createElement("ul"); s.className = "submenu"; s.innerHTML = "<li>Touristen</li>"; b.after(s);
    });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") btn.click(); });
</script></body></html>`;

describe("navigation interactions (menus a page renders without its scripts must replay)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("records the inserted panel, the toggle's attributes and a sub-menu, and leaves the page closed", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(PAGE);
    const recs = await exerciseInteractions(page);
    expect(recs).toHaveLength(1);
    const menu = recs[0]!;
    expect(menu.label).toBe("Seitenmenü anzeigen");
    expect(menu.trigger).toContain('[aria-label="Seitenmenü anzeigen"]');
    expect(menu.changes).toContainEqual({ attr: { target: menu.trigger, name: "aria-expanded", value: "true" } });
    const insert = menu.changes.find((c) => c.insert)!.insert!;
    expect(insert.html).toContain("Verbindungen");
    expect(await page.evaluate((sel) => document.querySelectorAll(sel).length, insert.parent)).toBe(1);
    expect(menu.children?.[0]?.changes.some((c) => c.insert?.html.includes("Touristen"))).toBe(true);
    // closed again after recording
    expect(await page.locator(".popover").count()).toBe(0);
    expect(await page.getAttribute(".menu-button", "aria-expanded")).toBe("false");
    await page.close();
  });
});
