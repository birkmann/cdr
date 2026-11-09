import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { collectReferences, readCcm, validateCcm, CcmReadError } from "../src/validate.js";
import { createTempWorkspace } from "../src/testing.js";
import type { Workspace } from "../src/workspace.js";
import { writeSampleCcm } from "../src/__tests__/ccm-sample.js";

let ws: Workspace;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ ws, cleanup } = await createTempWorkspace("val"));
});
afterEach(() => cleanup());

const codes = (r: { issues: { code: string; severity: string }[] }, sev = "error") => r.issues.filter((i) => i.severity === sev).map((i) => i.code);

describe("validateCcm", () => {
  it("accepts a valid bundle", async () => {
    await writeSampleCcm(ws);
    const r = await validateCcm(ws);
    expect(codes(r)).toEqual([]);
    expect(codes(r, "warning")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.entries).toBe(5);
    expect(r.stats.entryIds).toBe(3);
    expect(r.stats.references).toBeGreaterThan(5);
  });

  it("reports missing schema and locales on an empty ccm/", async () => {
    const r = await validateCcm(ws);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(expect.arrayContaining(["CCM_MISSING_SCHEMA", "CCM_MISSING_LOCALES"]));
  });

  it("flags invalid JSON and schema-invalid files", async () => {
    await writeSampleCcm(ws, (d) => {
      d.extra["ccm/assets/bad.json"] = { ccmId: "x" }; // missing src/fileName/mime/source
    });
    await writeFile(ws.path("ccm/entries/page/broken.en.json"), "{not json");
    const r = await validateCcm(ws);
    expect(codes(r)).toEqual(expect.arrayContaining(["CCM_INVALID_JSON", "CCM_INVALID_FILE"]));
    expect(r.issues.find((i) => i.code === "CCM_INVALID_FILE")?.ref).toBe("ccm/assets/bad.json");
  });

  it("detects dangling references in fields, rich text, navigation and settings", async () => {
    await writeSampleCcm(ws, (d) => {
      d.entries[0].fields.body.children[0].children[1].ref.id = "drupal:node:999";
      d.entries[0].fields.image = { kind: "asset", id: "drupal:media:404" };
      d.entries[0].fields.tags = [{ kind: "term", id: "drupal:taxonomy_term:77" }];
      d.extra["ccm/navigation/footer.json"] = { id: "footer", name: "Footer", items: [{ id: "f", label: { en: "x" }, ref: { kind: "entry", id: "nope" }, children: [] }] };
      d.extra["ccm/settings/site.json"] = { siteName: { en: "D" }, baseUrl: "http://x", logo: { kind: "asset", id: "missing-logo" } };
    });
    const r = await validateCcm(ws);
    const dangling = r.issues.filter((i) => i.code === "CCM_DANGLING_REF").map((i) => i.ref);
    expect(dangling).toEqual(expect.arrayContaining(["drupal:node:999", "drupal:media:404", "drupal:taxonomy_term:77", "nope", "missing-logo"]));
    expect(r.ok).toBe(false);
  });

  it("enforces allowedTypes on reference/componentList fields", async () => {
    await writeSampleCcm(ws, (d) => {
      d.entries[0].fields.sections = [{ kind: "entry", id: "drupal:node:2" }]; // page, not sectionHero
      d.entries[0].fields.image = { kind: "term", id: "drupal:taxonomy_term:1" }; // term where asset allowed
    });
    const r = await validateCcm(ws);
    expect(r.issues.filter((i) => i.code === "CCM_REF_NOT_ALLOWED")).toHaveLength(2);
  });

  it("checks entry type, required fields, value types, enum, cardinality, unknown fields", async () => {
    await writeSampleCcm(ws, (d) => {
      d.entries.push({ ccmId: "x:1", type: "ghost", locale: "en", fields: {}, source: { system: "x", kind: "k", id: "1" } });
      d.entries[2].fields.title = ""; // required
      d.entries[3].fields.style = "neon"; // enum
      d.entries[0].fields.published = "not-a-date";
      d.entries[0].fields.cta = { label: "no target" };
      d.entries[1].fields.tags = { kind: "term", id: "drupal:taxonomy_term:1" }; // cardinality -1 but single
      d.entries[1].fields.extraneous = 1;
    });
    const r = await validateCcm(ws);
    expect(codes(r)).toEqual(expect.arrayContaining(["CCM_UNKNOWN_TYPE", "CCM_REQUIRED_FIELD_MISSING", "CCM_FIELD_TYPE", "CCM_FIELD_CARDINALITY"]));
    expect(r.issues.filter((i) => i.code === "CCM_FIELD_TYPE").length).toBeGreaterThanOrEqual(3);
    expect(codes(r, "warning")).toContain("CCM_UNKNOWN_FIELD");
  });

  it("detects duplicate paths, unknown locales, bad locale config, redirect loops", async () => {
    await writeSampleCcm(ws, (d) => {
      d.entries[2].path = "/"; // same as node 1 en
      d.entries.push({ ccmId: "drupal:node:3", type: "page", locale: "fr", path: "/fr", fields: { title: "Fr" }, source: { system: "drupal", kind: "node", id: "3" } });
      d.extra["ccm/i18n/locales.json"] = [
        { code: "en", name: "English", default: true },
        { code: "de", name: "Deutsch", default: true, fallback: "it" },
      ];
      d.extra["ccm/redirects/redirects.json"] = [{ from: "/a", to: "/a" }];
    });
    const r = await validateCcm(ws);
    expect(codes(r)).toEqual(expect.arrayContaining(["CCM_DUPLICATE_PATH", "CCM_UNKNOWN_LOCALE", "CCM_LOCALE_DEFAULT", "CCM_LOCALE_FALLBACK", "CCM_REDIRECT_LOOP"]));
  });

  it("warns when an entry file is not at its canonical path", async () => {
    await writeSampleCcm(ws, (d) => {
      d.extra["ccm/entries/page/odd-name.json"] = { ccmId: "drupal:node:9", type: "page", locale: "en", path: "/nine", fields: { title: "9" }, source: { system: "drupal", kind: "node", id: "9" } };
    });
    const r = await validateCcm(ws);
    expect(r.ok).toBe(true);
    expect(codes(r, "warning")).toContain("CCM_PATH_MISMATCH");
  });

  it("checks collections reference existing types", async () => {
    await writeSampleCcm(ws, (d) => {
      d.extra["ccm/collections/x.json"] = { id: "x", name: "X", type: "nothing" };
    });
    const r = await validateCcm(ws);
    expect(codes(r)).toContain("CCM_UNKNOWN_TYPE");
  });
});

describe("readCcm", () => {
  it("returns the parsed bundle with defaults applied", async () => {
    await writeSampleCcm(ws);
    const b = await readCcm(ws);
    expect(b.schema.contentTypes.map((t) => t.id)).toEqual(["page", "sectionHero"]);
    expect(b.entries).toHaveLength(5);
    expect(b.entries[0].status).toBe("published");
    expect(b.assets[0].ccmId).toBe("drupal:media:21");
    expect(b.taxonomies[0].hierarchical).toBe(false);
    expect(b.navigation[0].id).toBe("main");
    expect(b.redirects[0].status).toBe(301);
    expect(b.locales.find((l) => l.default)?.code).toBe("en");
    expect(b.collections[0].filters).toEqual([]);
    expect(b.settings?.siteName.en).toBe("Demo");
  });

  it("throws CcmReadError in strict mode on invalid files, skips them otherwise", async () => {
    await writeSampleCcm(ws, (d) => {
      d.extra["ccm/assets/bad.json"] = { ccmId: "x" };
    });
    await expect(readCcm(ws)).rejects.toBeInstanceOf(CcmReadError);
    const b = await readCcm(ws, { strict: false });
    expect(b.assets).toHaveLength(1);
  });
});

describe("collectReferences", () => {
  it("finds nested references with paths", () => {
    const refs = collectReferences({ a: { kind: "asset", id: "x" }, b: [{ c: { ref: { kind: "entry", id: "y" } } }], d: { kind: "other", id: "z" } });
    expect(refs).toEqual([
      { path: "a", ref: { kind: "asset", id: "x" } },
      { path: "b[0].c.ref", ref: { kind: "entry", id: "y" } },
    ]);
  });
});
