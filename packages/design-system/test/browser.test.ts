import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome, leaseChrome } from "@harness/capture";
import { tokensCss } from "@harness/design-system";
import { DS_MODULES, writeWorkspace } from "./helpers.js";

const chrome = findChrome();

/** Keys as CDP wants them. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  End: { key: "End", code: "End", keyCode: 35 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
};

describe.skipIf(!chrome)("generated web components in Chrome", () => {
  let lease: Awaited<ReturnType<typeof leaseChrome>>;
  let session: string;
  const send = (m: string, p: object = {}) =>
    lease.cdp.send(m, p as Record<string, unknown>, session).catch((e: Error) => {
      throw new Error(`${m}: ${e.message}`);
    });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  };
  const press = async (name: keyof typeof KEYS) => {
    const k = KEYS[name]!;
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
    };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await evaluate("new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))");
  };
  const settle = () => evaluate("new Promise((r) => setTimeout(r, 50))");

  beforeAll(async () => {
    const { dir, ws } = writeWorkspace();
    const out = await build({
      entryPoints: [join(dir, "packages/web-components/src/index.ts")],
      bundle: true,
      format: "esm",
      write: false,
      target: "es2022",
      nodePaths: [DS_MODULES],
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
    });
    const js = out.outputFiles[0]!.text;
    const html = `<!doctype html><html><head><style>${tokensCss(ws.tokens)}</style></head><body>
<form id="f">
  <acme-text-input id="name" name="name" label="Name"></acme-text-input>
  <acme-checkbox id="cb" name="news" label="News"></acme-checkbox>
  <acme-toggle id="tg" name="wifi" label="Wi-Fi"></acme-toggle>
  <acme-radio-group id="rg" name="delivery" legend="Delivery">
    <acme-radio value="standard" label="Standard"></acme-radio>
    <acme-radio value="express" label="Express"></acme-radio>
    <acme-radio value="pickup" label="Pickup" disabled></acme-radio>
  </acme-radio-group>
  <acme-dropdown id="dd" name="plan" label="Plan">
    <option value="free">Free</option><option value="team">Team</option><option value="pro">Pro</option>
  </acme-dropdown>
  <acme-select id="sel" name="country" label="Country"><option value="de">Germany</option><option value="fr">France</option></acme-select>
</form>
<acme-tabs id="tabs" label="Account">
  <acme-tab value="a" label="A">Panel A</acme-tab><acme-tab value="b" label="B">Panel B</acme-tab><acme-tab value="c" label="C" disabled>Panel C</acme-tab>
</acme-tabs>
<acme-button id="opener">Open</acme-button>
<acme-modal id="modal" heading="Hello">Body</acme-modal>
<acme-tag id="tag" filter>Filter</acme-tag>
<acme-accordion><acme-accordion-item id="acc" title="Shipping">Fast</acme-accordion-item></acme-accordion>
<acme-button id="primary" kind="primary">Save</acme-button>
<script type="module">${js.replace(/<\/script/g, "<\\/script")}</script>
</body></html>`;
    lease = await leaseChrome(chrome!);
    const { targetId } = await lease.cdp.send("Target.createTarget", {
      url: "about:blank",
      browserContextId: lease.contextId,
    });
    ({ sessionId: session } = await lease.cdp.send("Target.attachToTarget", { targetId, flatten: true }));
    await send("Page.enable");
    await send("Runtime.enable");
    const page = join(dir, "test-page.html");
    writeFileSync(page, html);
    const loaded = lease.cdp.waitFor("Page.loadEventFired", session, 20_000);
    await send("Page.navigate", { url: pathToFileURL(page).href });
    await loaded;
    await evaluate(
      "customElements.whenDefined('acme-data-table').then(() => new Promise((r) => setTimeout(r, 100)))",
    );
  }, 60_000);

  afterAll(async () => {
    await lease?.close();
  });

  it("defines every element with roles and ARIA in place", async () => {
    const r = await evaluate<Record<string, unknown>>(`(() => {
      const q = (id, sel) => document.getElementById(id).shadowRoot.querySelector(sel);
      return {
        defined: ['acme-button','acme-text-input','acme-dropdown','acme-modal','acme-tabs','acme-data-table','acme-pagination','acme-tile','acme-icon'].every((t) => !!customElements.get(t)),
        switchRole: q('tg', 'button').getAttribute('role'),
        combobox: q('dd', '[role=combobox]').getAttribute('aria-expanded'),
        tablist: document.getElementById('tabs').shadowRoot.querySelectorAll('[role=tab]').length,
        accExpanded: q('acc', 'button').getAttribute('aria-expanded'),
        label: q('name', 'label').textContent,
        labelFor: q('name', 'label').htmlFor === q('name', 'input').id,
      }
    })()`);
    expect(r).toEqual({
      defined: true,
      switchRole: "switch",
      combobox: "false",
      tablist: 3,
      accExpanded: "false",
      label: "Name",
      labelFor: true,
    });
  });

  it("checkbox: Space toggles it, it submits with the form and resets", async () => {
    await evaluate("document.getElementById('cb').focus()");
    await press("Space");
    const r = await evaluate<{ checked: boolean; news: string | null }>(
      `({ checked: document.getElementById('cb').checked, news: new FormData(document.getElementById('f')).get('news') })`,
    );
    expect(r).toEqual({ checked: true, news: "on" });
    await evaluate("document.getElementById('f').reset()");
    await settle();
    expect(await evaluate("document.getElementById('cb').checked")).toBe(false);
  });

  it("text input: typed text is the value and the form value", async () => {
    await evaluate("document.getElementById('name').focus()");
    await send("Input.insertText", { text: "Jane" });
    await settle();
    expect(
      await evaluate(
        `[document.getElementById('name').value, new FormData(document.getElementById('f')).get('name')]`,
      ),
    ).toEqual(["Jane", "Jane"]);
  });

  it("toggle: click flips role=switch and the form value", async () => {
    await evaluate("document.getElementById('tg').shadowRoot.querySelector('button').click()");
    await settle();
    expect(
      await evaluate(
        `[document.getElementById('tg').shadowRoot.querySelector('button').getAttribute('aria-checked'), new FormData(document.getElementById('f')).get('wifi')]`,
      ),
    ).toEqual(["true", "on"]);
  });

  it("radio group: arrow keys move and select, skipping disabled options, with one tab stop", async () => {
    await evaluate(
      `(() => { window.rgChanges = 0; document.getElementById('rg').addEventListener('change', () => window.rgChanges++); document.querySelector('acme-radio').focus() })()`,
    );
    await press("ArrowDown");
    expect(await evaluate("document.getElementById('rg').value")).toBe("express");
    await press("ArrowDown"); // pickup is disabled: wraps to standard
    expect(await evaluate("document.getElementById('rg').value")).toBe("standard");
    const r = await evaluate<{ changes: number; tabStops: number; form: string | null }>(`({
      changes: window.rgChanges,
      tabStops: [...document.querySelectorAll('acme-radio')].filter((r) => r.shadowRoot.querySelector('[role=radio]').tabIndex === 0).length,
      form: new FormData(document.getElementById('f')).get('delivery'),
    })`);
    expect(r).toEqual({ changes: 2, tabStops: 1, form: "standard" });
  });

  it("dropdown: keyboard opens, moves, selects and closes", async () => {
    await evaluate("document.getElementById('dd').shadowRoot.querySelector('[role=combobox]').focus()");
    await press("ArrowDown");
    expect(await evaluate("document.getElementById('dd').open")).toBe(true);
    await press("ArrowDown");
    await press("Enter");
    const r = await evaluate(
      `[document.getElementById('dd').value, document.getElementById('dd').open, new FormData(document.getElementById('f')).get('plan')]`,
    );
    expect(r).toEqual(["team", false, "team"]);
    await press("ArrowDown");
    await press("End");
    await press("Escape");
    expect(
      await evaluate("[document.getElementById('dd').value, document.getElementById('dd').open]"),
    ).toEqual(["team", false]);
  });

  it("tabs: arrow keys select the next enabled tab and show its panel", async () => {
    await evaluate(
      "document.getElementById('tabs').shadowRoot.querySelector('[role=tab][aria-selected=true]').focus()",
    );
    await press("ArrowRight");
    const r = await evaluate<{ value: string; panelB: boolean; panelA: boolean }>(`(() => {
      const t = document.getElementById('tabs'); const panels = t.shadowRoot.querySelectorAll('[role=tabpanel]');
      return { value: t.value, panelA: !panels[0].hidden, panelB: !panels[1].hidden }
    })()`);
    expect(r).toEqual({ value: "b", panelA: false, panelB: true });
    await press("ArrowRight"); // C is disabled: wraps to A
    expect(await evaluate("document.getElementById('tabs').value")).toBe("a");
  });

  it("modal: opens as a modal dialog, Esc closes it and focus returns to the opener", async () => {
    await evaluate("document.getElementById('opener').focus(); document.getElementById('modal').show()");
    await settle();
    expect(
      await evaluate("document.getElementById('modal').shadowRoot.querySelector('dialog').matches(':modal')"),
    ).toBe(true);
    await press("Escape");
    await settle();
    expect(
      await evaluate(
        "[document.getElementById('modal').open, document.activeElement && document.activeElement.id]",
      ),
    ).toEqual([false, "opener"]);
  });

  it("tag: the remove button fires a cancelable acme-dismiss and hides the tag", async () => {
    const r = await evaluate(
      `(() => { let n = 0; const t = document.getElementById('tag'); t.addEventListener('acme-dismiss', () => n++); t.shadowRoot.querySelector('button').click(); return [n, t.hidden, t.shadowRoot.querySelector('button').getAttribute('aria-label')] })()`,
    );
    expect(r).toEqual([1, true, "Remove Filter"]);
  });

  it("accordion: the heading button toggles aria-expanded and the region", async () => {
    await evaluate("document.getElementById('acc').shadowRoot.querySelector('button').click()");
    await settle();
    expect(
      await evaluate(
        "[document.getElementById('acc').shadowRoot.querySelector('button').getAttribute('aria-expanded'), document.getElementById('acc').shadowRoot.querySelector('[role=region]').hidden]",
      ),
    ).toEqual(["true", false]);
  });

  it("primary button text meets 4.5:1 on its computed colours", async () => {
    const [fg, bg] = await evaluate<[string, string]>(
      `(() => { const b = document.getElementById('primary').shadowRoot.querySelector('button'); const s = getComputedStyle(b); return [s.color, s.backgroundColor] })()`,
    );
    const lum = (c: string) => {
      const [r, g, b] = c
        .match(/\d+(\.\d+)?/g)!
        .slice(0, 3)
        .map((v) => {
          const x = +v / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    expect(bg).toBe("rgb(15, 81, 50)"); // the brand colour, kept
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
