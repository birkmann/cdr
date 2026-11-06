// The design-md emitter: deterministic DESIGN.md + brand.json from a design system and
// captured screens, the optional prose step through a host model, the offline lint, and emitter plugin loading.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  emitDesignMd,
  generateBrandGuide,
  getEmitter,
  lintDesignMd,
  loadEmitters,
  splitDesignMd,
  type ProseModel,
} from "@harness/codegen";
import { fixtureDs, fixtureScreens } from "./brandmd-fixture-northwind.js";

const input = () => ({ screens: fixtureScreens(), system: fixtureDs, page: "Northwind" });

describe("design-md emitter", () => {
  it("is registered and writes DESIGN.md, brand.json and lint.json with 0 lint errors", () => {
    const e = getEmitter("design-md");
    expect(e).toBeDefined();
    const files = e!.emit(input(), {
      sourceUrl: "https://northwind.example/",
      capturedAt: "2026-10-20T10:00:00Z",
    });
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["DESIGN.md", "brand.json", "lint.json", "credits.json", "RECREATION.md"]),
    );
    const md = files["DESIGN.md"] as string;
    const fm = splitDesignMd(md).frontMatter;
    expect(fm.version).toBe("alpha");
    expect(fm.website).toBe("https://northwind.example");
    expect(fm.colors.primary).toBe("#1c69d4");
    const facts = JSON.parse(files["brand.json"] as string);
    expect(facts.capturedAt).toBe("2026-10-20");
    const lint = lintDesignMd(md, { facts });
    expect(lint.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(JSON.parse(files["lint.json"] as string).errors).toBe(0);
  });

  it("is deterministic: the same input gives the same DESIGN.md", () => {
    const o = { sourceUrl: "https://northwind.example/", capturedAt: "2026-10-20" };
    expect(emitDesignMd(input(), o)["DESIGN.md"]).toBe(emitDesignMd(input(), o)["DESIGN.md"]);
  });

  it("works without a design system (tokens of the first screen)", () => {
    const files = emitDesignMd({ screens: fixtureScreens() }, { sourceUrl: "https://northwind.example/" });
    expect(lintDesignMd(files["DESIGN.md"] as string).errors).toBe(0);
  });
});

describe("generateBrandGuide (optional prose through the host's model)", () => {
  it("without a model: the deterministic guide, not ok", async () => {
    const r = await generateBrandGuide(input(), {
      sourceUrl: "https://northwind.example/",
      capturedAt: "2026-10-20",
    });
    expect(r.guide.ok).toBe(false);
    expect(r.guide.slots).toEqual([]);
    expect(r.lint.errors).toBe(0);
  });

  it("a model's slot is used only when it passes validation (an invented hex is rejected)", async () => {
    const calls: string[] = [];
    const model: ProseModel = {
      name: "mock",
      async complete(req) {
        const user = req.messages.find((m) => m.role === "user")!.content;
        calls.push(user);
        if (user.includes('"knownGaps"'))
          return JSON.stringify({
            knownGaps: [
              "Northwind Sans is a licensed webfont; the capture could not verify an open substitute for it.",
              "Hover states were not captured on every control; pressed colours come from the primary button only.",
              "Only the home page and one inner page were captured; forms and filters may live elsewhere.",
              "No consent overlay covered the page at capture time, so nothing was hidden by it.",
              "Motion timings and transitions were not measured; the guide states static values only.",
            ],
          });
        if (user.includes('"touchTargets"'))
          return JSON.stringify({ touchTargets: ["Buttons use #ff00ff."] });
        return "{}";
      },
    };
    const r = await generateBrandGuide(input(), {
      model,
      sourceUrl: "https://northwind.example/",
      capturedAt: "2026-10-20",
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(r.guide.model).toBe("mock");
    expect(r.guide.slots.find((s) => s.slot === "knownGaps")?.ok).toBe(true);
    const touch = r.guide.slots.find((s) => s.slot === "touchTargets")!;
    expect(touch.ok).toBe(false);
    expect(r.guide.markdown).toContain("Motion timings and transitions were not measured");
    expect(r.guide.markdown).not.toContain("#ff00ff");
    expect(r.guide.ok).toBe(false);
    expect(r.lint.errors).toBe(0);
  });
});

describe("lintDesignMd (offline re-implementation of the format's checks)", () => {
  const doc = (fm: string, body = "## Overview\n\nText.\n") => `---\n${fm}\n---\n\n${body}`;
  const FM = [
    "version: alpha",
    "name: Acme",
    'website: "https://acme.example"',
    "colors:",
    '  primary: "#1c69d4"',
    '  canvas: "#ffffff"',
    '  ink: "#111111"',
    "typography:",
    "  body-md:",
    '    fontFamily: "Inter, sans-serif"',
    "    fontSize: 16px",
    "    fontWeight: 400",
    "    lineHeight: 1.5",
    "    letterSpacing: 0",
    "rounded:",
    "  none: 0px",
    "spacing:",
    "  md: 16px",
    "components:",
    "  button-primary:",
    '    backgroundColor: "{colors.primary}"',
    '    textColor: "{colors.canvas}"',
    '    typography: "{typography.body-md}"',
    "  page:",
    '    backgroundColor: "{colors.canvas}"',
    '    textColor: "{colors.ink}"',
  ].join("\n");
  const rules = (text: string, sev = "error") =>
    lintDesignMd(text)
      .findings.filter((f) => f.severity === sev)
      .map((f) => f.rule);

  it("a valid file has no errors; missing sections are warnings", () => {
    expect(rules(doc(FM))).toEqual([]);
    expect(rules(doc(FM), "warning")).toContain("section-missing");
  });

  it("flags letterSpacing: normal, bad colours and dimensions, broken refs and literal hexes", () => {
    expect(rules(doc(FM.replace("letterSpacing: 0", "letterSpacing: normal")))).toEqual([
      "invalid-dimension",
    ]);
    expect(rules(doc(FM.replace('primary: "#1c69d4"', "primary: blue")))).toContain("invalid-color");
    expect(rules(doc(FM.replace("none: 0px", "none: zero")))).toEqual(["invalid-dimension"]);
    expect(rules(doc(FM.replace('"{colors.ink}"', '"{colors.nope}"')))).toEqual(["broken-ref"]);
    expect(rules(doc(FM.replace('"{colors.ink}"', '"#111111"')))).toEqual(["literal-hex"]);
    expect(rules(doc(FM.replace("    fontWeight: 400\n", "")))).toEqual(["invalid-typography"]);
    expect(rules(doc(FM.replace("name: Acme\n", "")))).toEqual(["missing-key"]);
    expect(rules("## Overview\n")).toContain("front-matter");
  });

  it("checks section order and duplicates; warns on orphaned colours, contrast and off-spec props", () => {
    expect(rules(doc(FM, "## Colors\n\n## Overview\n"))).toEqual(["section-order"]);
    expect(rules(doc(FM, "## Overview\n\n## Overview\n"))).toEqual(["section-duplicate"]);
    const w = (t: string) => rules(t, "warning");
    expect(w(doc(FM.replace('  ink: "#111111"', '  ink: "#111111"\n  accent: "#ff0000"')))).toContain(
      "orphaned-tokens",
    );
    expect(w(doc(FM.replace('textColor: "{colors.ink}"', 'textColor: "{colors.canvas}"')))).toContain(
      "contrast-ratio",
    );
    expect(
      w(doc(FM.replace("    letterSpacing: 0", "    letterSpacing: 0\n    textTransform: uppercase"))),
    ).toContain("unknown-property");
    expect(
      w(
        doc(
          FM.replace("name: Acme", "name: Acme")
            .replace('  primary: "#1c69d4"\n', '  brand: "#1c69d4"\n')
            .replace("{colors.primary}", "{colors.brand}"),
        ),
      ),
    ).toContain("missing-primary");
    expect(w(doc(FM, "## Overview\n\nUses #abcdef and 13px.\n"))).toEqual(
      expect.arrayContaining(["ungrounded-hex", "ungrounded-px"]),
    );
  });
});

describe("loadEmitters (recreate.emitters)", () => {
  // vitest (vite-node) imports modules only under the workspace root: the test project lives in node_modules/.cache
  const cache = fileURLToPath(new URL("../../../node_modules/.cache/", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "emitters-"));
  const outside = mkdtempSync(join(tmpdir(), "emitters-outside-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "tools"));
  writeFileSync(
    join(root, "tools/emit-a.mjs"),
    'export default { id: "plugin-a", description: "A", emit: (i) => ({ "a.txt": String(i.screens.length) }) };\n',
  );
  writeFileSync(
    join(root, "tools/emit-b.mjs"),
    'export const emitter = { id: "plugin-b", emit: () => ({ "b.txt": "b" }) };\n',
  );
  writeFileSync(join(root, "tools/not.mjs"), "export const x = 1;\n");
  writeFileSync(join(outside, "evil.mjs"), 'export default { id: "evil", emit: () => ({}) };\n');
  symlinkSync(join(outside, "evil.mjs"), join(root, "tools/link.mjs"));

  it("registers default and `emitter` exports by id; reports the rest without throwing", async () => {
    const r = await loadEmitters(
      [
        "./tools/emit-a.mjs",
        "tools/emit-b.mjs",
        "tools/not.mjs",
        "../x.mjs",
        join(outside, "evil.mjs"),
        "tools/link.mjs",
        "tools/missing.mjs",
      ],
      root,
    );
    expect(r.loaded).toEqual(["plugin-a", "plugin-b"]);
    expect(r.errors.map((e) => [e.path, e.error])).toEqual([
      ["tools/not.mjs", expect.stringMatching(/no emitter export/)],
      ["../x.mjs", expect.stringMatching(/outside the project root/)],
      [join(outside, "evil.mjs"), expect.stringMatching(/outside the project root/)],
      ["tools/link.mjs", expect.stringMatching(/symlink/)],
      ["tools/missing.mjs", expect.stringMatching(/not found/)],
    ]);
    expect(getEmitter("plugin-a")!.emit({ screens: [] }, {})).toEqual({ "a.txt": "0" });
    expect(getEmitter("plugin-b")!.description).toBe("plugin-b");
    expect(getEmitter("evil")).toBeUndefined();
  });
});
