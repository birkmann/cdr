import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeId as coreSafeId } from "@harness/mirror-core";

// the app template is its own TS project (bundler resolution): load it at runtime, outside the repo typecheck
const STORE = new URL("../templates/nextjs-contentful/src/lib/data/store.ts", import.meta.url).href;

describe("asset public paths (volkswagen.de: image URLs with long encoded query strings)", () => {
  it("the generated app derives /_assets/<safeId>/ exactly like the generator, capped below the filesystem limit", async () => {
    const { safeId: appSafeId, defaultAssetUrl } = (await import(STORE)) as {
      safeId: (id: string) => string;
      defaultAssetUrl: (a: { ccmId: string; src: string; fileName: string }) => string;
    };
    const ids = ["drupal:media:7", "html:asset:https://assets.volkswagen.test/is/image/x_" + "Zml0PWNyb3Am".repeat(40), "", "/// "];
    for (const id of ids) {
      expect(appSafeId(id)).toBe(coreSafeId(id));
      expect(appSafeId(id).length).toBeLessThanOrEqual(200);
    }
    expect(defaultAssetUrl({ ccmId: ids[1]!, src: "assets/x.png", fileName: "x.png" })).toBe(`/_assets/${coreSafeId(ids[1]!)}/x.png`);
  });
});

describe("html parser shared with the template", () => {
  it("is the template's own file", () => {
    const read = (u: string) => readFileSync(fileURLToPath(new URL(u, import.meta.url)), "utf8");
    expect(read("../src/template-html-parse.ts")).toBe(read("../templates/nextjs-contentful/src/lib/html/parse.ts"));
  });
});
