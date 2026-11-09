/** `ccm` data source: reads a workspace ccm/ directory (CCM_DIR) at build time — fully offline. */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CcmBundle, StoreOptions } from "./store";
import { Store } from "./store";

async function listJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let ents;
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function loadCcmBundle(dir: string): Promise<CcmBundle> {
  const root = resolve(/*turbopackIgnore: true*/ dir);
  const all = async <T>(sub: string) => Promise.all((await listJson(join(root, sub))).map((f) => readJson<T>(f, null as T))).then((xs) => xs.filter(Boolean));
  const schema = await readJson<{ contentTypes: CcmBundle["contentTypes"] }>(join(root, "schema/content-types.json"), { contentTypes: [] });
  return {
    contentTypes: schema.contentTypes ?? [],
    entries: await all<CcmBundle["entries"][number]>("entries"),
    assets: await all<CcmBundle["assets"][number]>("assets"),
    taxonomies: await all<CcmBundle["taxonomies"][number]>("taxonomies"),
    navigation: await all<CcmBundle["navigation"][number]>("navigation"),
    collections: await all<CcmBundle["collections"][number]>("collections"),
    redirects: await readJson(join(root, "redirects/redirects.json"), []),
    locales: await readJson(join(root, "i18n/locales.json"), []),
    settings: await readJson(join(root, "settings/site.json"), null),
  };
}

export async function createCcmSource(dir: string, opts: StoreOptions = {}): Promise<Store> {
  return new Store(await loadCcmBundle(dir), { id: "ccm", ...opts });
}
