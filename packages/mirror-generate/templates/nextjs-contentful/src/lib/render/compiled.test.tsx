/**
 * Compiled design components (generator: Handlebars subset → TSX) must render the same DOM as the reference renderer
 * of @cmp/design (renderTemplate) for the mined example props — that is what makes the ported CSS give visual parity.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { compileComponentModule } from "../../../../../packages/generators/nextjs-contentful/src/compile";
import { renderTemplate } from "../../../../../packages/design/src/render";
import { parseHtml, type HNode } from "../html/parse";
import { scope, type RenderCtx } from "./runtime";

const DESIGN = fileURLToPath(new URL("../../../../../packages/generators/nextjs-contentful/src/__fixtures__/ws/design/components", import.meta.url));
const OUT = fileURLToPath(new URL("../../__gen_test__/", import.meta.url));

/** canonical DOM string: attribute names lower-cased + sorted, class tokens normalised, boolean attrs "", text kept */
function canon(html: string): string {
  const walk = (ns: HNode[]): string =>
    ns
      .map((n) => {
        if (n.type === "text") return n.value.replace(/\s+/g, " ");
        if (n.type === "comment") return "";
        const attrs = n.attrs
          .map(([k, v]) => [k.toLowerCase(), k.toLowerCase() === "class" ? (v ?? "").split(/\s+/).filter(Boolean).join(" ") : (v ?? "")] as const)
          .filter(([k, v]) => !(k === "class" && v === ""))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}="${v}"`)
          .join(" ");
        return `<${n.name}${attrs ? " " + attrs : ""}>${walk(n.children)}</${n.name}>`;
      })
      .join("")
      .replace(/ +/g, " ");
  return walk(parseHtml(html));
}

const ctx = { locale: "en", path: "/", chrome: { languages: [] }, renderEntry: () => null, renderComponent: () => null } as unknown as RenderCtx;

describe("compiled components ≡ @cmp/design renderTemplate", () => {
  mkdirSync(OUT, { recursive: true });
  afterAll(() => rmSync(OUT, { recursive: true, force: true }));
  for (const f of readdirSync(DESIGN).sort()) {
    const c = JSON.parse(readFileSync(`${DESIGN}/${f}`, "utf8"));
    it(`${c.id}`, async () => {
      const mod = compileComponentModule(c.id, c.template, f, "../lib/render/runtime");
      expect(mod.fallback).toBe(false);
      const file = `${OUT}${c.id}.tsx`;
      writeFileSync(file, mod.code);
      const Comp = (await import(/* @vite-ignore */ file)).default;
      const ours = renderToStaticMarkup(<Comp vm={scope(c.exampleProps)} ctx={ctx} />);
      const ref = renderTemplate(c.template, c.exampleProps);
      // React 19 emits <link rel=preload> for fetchpriority=high images (hoisted into <head> in the app)
      expect(canon(ours.replace(/<link rel="preload"[^>]*\/>/g, ""))).toBe(canon(ref));
    });
  }
});
