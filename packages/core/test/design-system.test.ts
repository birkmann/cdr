import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePng } from "@harness/capture";
import { designSystemTool, discoverSkills, matchSkills } from "@harness/core";
import { tempProject, toolCtx } from "./helpers.js";

/** A white PNG with a blue band. */
function png(): Buffer {
  const w = 120,
    h = 120,
    data = new Uint8Array(w * h * 3).fill(255);
  for (let y = 40; y < 70; y++) for (let x = 0; x < w; x++) data.set([0x00, 0x43, 0xce], (y * w + x) * 3);
  return encodePng({ width: w, height: h, data });
}

const VISION =
  '```json\n{"name": "Northwind", "theme": "light", "colors": {"primary": "#0043ce", "background": "#ffffff", "text": "#161616"}, "fonts": {"sans": "IBM Plex Sans"}, "radius": {"control": 0, "container": 0}, "controlHeight": 40, "density": "normal", "buttons": {"secondary": "outline", "uppercase": false}, "elevation": "none", "notes": ["flat and sharp"]}\n```';

describe("design_system tool", () => {
  it("builds a workspace from images with a vision reading and shows the foundations", async () => {
    const root = tempProject({});
    writeFileSync(join(root, "shot.png"), png());
    const ctx = toolCtx(root);
    const calls: { role: string; images: number }[] = [];
    ctx.complete = async (role, messages) => {
      const user = messages.find((m) => m.role === "user") as { images?: unknown[] };
      calls.push({ role, images: user.images?.length ?? 0 });
      return VISION;
    };
    const r = await designSystemTool.execute({ images: ["shot.png"] }, ctx);
    expect(r.ok, r.output).toBe(true);
    expect(calls).toEqual([{ role: "executor", images: 1 }]);
    const out = join(root, "design-system/northwind");
    const brand = JSON.parse(readFileSync(join(out, "brand.json"), "utf8"));
    expect(brand).toMatchObject({
      name: "Northwind",
      prefix: "northwind",
      colors: { primary: "#0043ce" },
      fonts: { sans: "IBM Plex Sans" },
    });
    for (const f of [
      "packages/web-components/src/components/button.ts",
      "packages/react/src/index.ts",
      "packages/angular/src/public-api.ts",
      "docs/foundations.html",
    ])
      expect(existsSync(join(out, f)), f).toBe(true);
    expect(ctx.events).toContainEqual({
      type: "preview.ready",
      path: "design-system/northwind/docs/foundations.html",
      title: "Northwind foundations",
    });
    expect(r.output).toMatch(/primary #0043ce \(vision/);
    expect(r.output).toMatch(/all \d+ checked pairs pass/);
    expect(r.output).toMatch(/npm install/);
  });

  it("uses designSystem.model for the image reading", async () => {
    const root = tempProject({});
    writeFileSync(join(root, "a.png"), png());
    const ctx = toolCtx(root, { designSystem: { model: "anthropic/vision" } } as never);
    let role = "";
    ctx.complete = async (r) => ((role = r), VISION);
    await designSystemTool.execute({ images: ["a.png"], name: "Acme", out: "ds" }, ctx);
    expect(role).toBe("anthropic/vision");
    expect(JSON.parse(readFileSync(join(root, "ds/brand.json"), "utf8")).name).toBe("Acme");
  });

  it("regenerates from brand.json with overrides", async () => {
    const root = tempProject({});
    writeFileSync(join(root, "a.png"), png());
    const ctx = toolCtx(root);
    ctx.complete = async () => VISION;
    await designSystemTool.execute({ images: ["a.png"], out: "ds" }, ctx);
    const r = await designSystemTool.execute(
      { out: "ds", overrides: { colors: { primary: "#da1e28" }, radius: { control: 999 } } },
      ctx,
    );
    expect(r.ok, r.output).toBe(true);
    const brand = JSON.parse(readFileSync(join(root, "ds/brand.json"), "utf8"));
    expect(brand.colors.primary).toBe("#da1e28");
    expect(brand.radius.control).toBe(999);
    expect(brand.fonts.sans).toBe("IBM Plex Sans"); // kept from the first reading
    expect(brand.sources["colors.primary"]).toBe("override");
    expect(readFileSync(join(root, "ds/packages/tokens/css/tokens.css"), "utf8")).toContain(
      "--northwind-button-primary: #da1e28;",
    );
  });

  it("explains missing or conflicting input and confines paths", async () => {
    const root = tempProject({ "notes.txt": "x" });
    const ctx = toolCtx(root);
    expect((await designSystemTool.execute({}, ctx)).output).toMatch(/give `url` or `images`/);
    expect(
      (await designSystemTool.execute({ url: "https://x.test", images: ["a.png"] }, ctx)).output,
    ).toMatch(/not both/);
    expect((await designSystemTool.execute({ images: ["missing.png"] }, ctx)).output).toMatch(
      /No such image/,
    );
    expect((await designSystemTool.execute({ images: ["notes.txt"] }, ctx)).output).toMatch(/not a png/);
    await expect(designSystemTool.execute({ images: ["../../etc/passwd.png"] }, ctx)).rejects.toThrow(
      /outside/,
    );
    await expect(designSystemTool.execute({ out: "../elsewhere", overrides: {} }, ctx)).rejects.toThrow(
      /outside/,
    );
  });
});

describe("design-system skill", () => {
  it("loads for design-system requests in sandbox chats, not for ordinary pages", () => {
    const skills = discoverSkills(tempProject({}));
    const names = (task: string) => matchSkills(skills, task, { sandbox: true }).map((s) => s.name);
    expect(names("Create a design system like IBM Carbon from https://acme.com")).toContain("design-system");
    expect(names("build me a component library from these screenshots")).toContain("design-system");
    expect(names("make design tokens for our brand")).toContain("design-system");
    expect(names("build a landing page for my bakery")).not.toContain("design-system");
  });
});

const chromePath = (await import("@harness/capture")).findChrome();
describe.skipIf(!chromePath)("design_system from a URL (fixture site, headless Chrome)", () => {
  it("reads the page's brand and returns the live shot", async () => {
    const { serveSite } = await import("../../capture/test/sites/serve.js");
    const site = await serveSite("acme");
    try {
      const root = tempProject({});
      const ctx = toolCtx(root, { recreate: { allowLocal: true, respectRobots: false } } as never);
      const r = await designSystemTool.execute({ url: site.url, name: "Acme Outdoor", out: "ds" }, ctx);
      expect(r.ok, r.output).toBe(true);
      const brand = JSON.parse(readFileSync(join(root, "ds/brand.json"), "utf8"));
      expect(brand).toMatchObject({
        name: "Acme Outdoor",
        prefix: "acme",
        colors: { primary: "#0f5132" },
        fonts: { sans: "Acme Sans" },
      });
      expect(brand.sources["colors.primary"]).toBe("site");
      expect(r.images?.[0]).toMatchObject({ mimeType: "image/png", name: "source-1440.png" });
      expect(r.output).toMatch(/primary #0f5132 \(site/);
    } finally {
      await site.close();
    }
  }, 120_000);

  it("refuses private addresses unless allowLocal is set", async () => {
    const root = tempProject({});
    const r = await designSystemTool.execute({ url: "http://127.0.0.1:9/" }, toolCtx(root));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Could not read/);
  });
});
