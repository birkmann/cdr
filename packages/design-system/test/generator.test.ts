import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspace,
  elements,
  normalizeSpec,
  TEMPLATES,
  TEMPLATES_HASH,
  toReact,
} from "@harness/design-system";

const ws = buildWorkspace(normalizeSpec({ name: "Acme Outdoor", colors: { primary: "#0f5132" } }));
const f = ws.files;

describe("embedded templates", () => {
  it("are in sync with packages/design-system/templates (run scripts/design-system/embed.mjs after editing)", () => {
    const dir = new URL("../templates/", import.meta.url).pathname;
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files[p.slice(dir.length)] = readFileSync(p, "utf8");
      }
    };
    walk(dir);
    const h = createHash("sha256");
    for (const [k, v] of Object.entries(files)) h.update(k).update("\0").update(v).update("\0");
    expect(h.digest("hex").slice(0, 16)).toBe(TEMPLATES_HASH);
    expect(Object.keys(files)).toEqual(Object.keys(TEMPLATES));
  });
});

describe("generated workspace", () => {
  it("has every package with a valid package.json and the docs", () => {
    for (const p of [
      "package.json",
      "packages/tokens/package.json",
      "packages/web-components/package.json",
      "packages/react/package.json",
      "packages/angular/package.json",
      "docs/package.json",
    ])
      expect(() => JSON.parse(f[p]!), p).not.toThrow();
    const root = JSON.parse(f["package.json"]!);
    expect(root.workspaces).toEqual([
      "packages/tokens",
      "packages/web-components",
      "packages/react",
      "packages/angular",
      "docs",
    ]);
    expect(JSON.parse(f["packages/react/package.json"]!).dependencies["@acme-ds/web-components"]).toBe(
      "0.1.0",
    );
    for (const p of [
      "brand.json",
      "README.md",
      "DESIGN.md",
      "docs/index.html",
      "docs/main.ts",
      "docs/foundations.html",
      "packages/tokens/css/tokens.css",
      "packages/tokens/contrast.json",
    ])
      expect(f[p], p).toBeTruthy();
  });

  it("fills the prefix everywhere", () => {
    for (const [p, c] of Object.entries(f)) expect(c.includes("__P__"), p).toBe(false);
    expect(f["packages/web-components/src/components/button.ts"]).toContain("var(--acme-button-primary)");
  });

  it("registers every element once and wraps each for React and Angular", () => {
    const els = elements();
    expect(els.length).toBe(28);
    const index = f["packages/web-components/src/index.ts"]!;
    const react = f["packages/react/src/index.ts"]!;
    const api = f["packages/angular/src/public-api.ts"]!;
    for (const e of els) {
      expect(index.match(new RegExp(`'acme-${e.tag}': ${e.cls},`, "g"))?.length, e.tag).toBe(1);
      expect(react).toContain(`export const ${e.cls} = createComponent({`);
      expect(f[`packages/angular/src/lib/${e.tag}.directive.ts`], e.tag).toContain(
        `selector: 'acme-${e.tag}'`,
      );
      expect(api).toContain(`AcmeButtonDirective`);
      if (e.form)
        expect(f[`packages/angular/src/lib/${e.tag}.value-accessor.ts`], e.tag).toContain(
          "NG_VALUE_ACCESSOR",
        );
    }
    expect(react).toContain("onDismiss: 'acme-dismiss',");
    expect(react).toContain("onPageChange: 'acme-page-change',");
  });

  it("reads props, events and slots from the component sources", () => {
    const button = elements().find((e) => e.tag === "button")!;
    expect(button.props.map((p) => p.attribute)).toEqual(
      expect.arrayContaining(["kind", "size", "disabled", "href", "full-width"]),
    );
    expect(button.props.find((p) => p.name === "kind")!.type).toContain("'ghost'");
    const input = elements().find((e) => e.tag === "text-input")!;
    expect(input.props.map((p) => p.name)).toEqual(
      expect.arrayContaining(["name", "disabled", "required", "helperText", "invalid"]),
    );
    expect(input.events.map((e) => e.name)).toEqual(["input", "change"]);
    expect(elements().find((e) => e.tag === "modal")!.slots).toEqual(["", "footer"]);
  });

  it("uses only token variables for colours in component styles", () => {
    for (const [p, c] of Object.entries(f)) {
      if (!p.startsWith("packages/web-components/src/")) continue;
      const css = [...c.matchAll(/css`([\s\S]*?)`/g)].map((m) => m[1]).join("\n");
      const raw = css.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [];
      expect(raw, p).toEqual([]);
    }
  });

  it("turns docs examples into JSX for the React tab", () => {
    const r = toReact(
      '<acme-text-input label="Email" helper-text="We never share it" disabled></acme-text-input>',
      "acme",
    );
    expect(r.code).toBe('<TextInput label="Email" helperText="We never share it" disabled></TextInput>');
    expect(r.imports).toEqual(["TextInput"]);
  });

  it("reports the brand reading in DESIGN.md", () => {
    expect(f["DESIGN.md"]).toContain("`#0f5132`");
    expect(f["DESIGN.md"]).toMatch(/all \d+ checked pairs pass/);
  });
});
