/**
 * Workspace layout (MIGRATION_PLAN.md §4). FROZEN CONTRACT: every package reads/writes through these paths.
 *
 * workspace/<site>/
 *   raw/<extractor>/...        unaltered source data (drupal-jsonapi/, drupal-config/, html/, files/)
 *   analysis/                  inventory.json, complexity.json, SUMMARY.md
 *   mapping/                   *.yaml (reviewed, committed)
 *   ccm/schema/content-types.json      CcmSchemaFile
 *   ccm/entries/<type>/<safeId>.<locale>.json   Entry
 *   ccm/assets/<safeId>.json           Asset
 *   ccm/taxonomies/<id>.json           Taxonomy
 *   ccm/navigation/<id>.json           Navigation
 *   ccm/redirects/redirects.json       Redirect[]
 *   ccm/i18n/locales.json              Locale[]
 *   ccm/collections/<id>.json          Collection
 *   ccm/settings/site.json             SiteSettings
 *   design/screenshots/<viewport>/<safePath>.png
 *   design/tokens.json, design/components/, design/templates/<contentType>.json
 *   verify/                    per-check reports
 *   reports/<step>.json + <step>.md
 *   llm-log/<timestamp>-<step>.json
 *   llm-cache/<sha256>.json            (validated LLM responses, replayed on re-runs)
 *   autofix/attempts/<n>-<handler>.json (every proposal: dossier hash, patch, metrics before/after, accepted?)
 *   effort.jsonl               S5 human-effort log
 *   idmap.json                 { [target]: { [ccmId(:locale)?]: targetId } }
 *   TASKS.md                   machine-maintained open items
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";

export const WORKSPACE_DIRS = [
  "raw",
  "analysis",
  "mapping",
  "ccm/schema",
  "ccm/entries",
  "ccm/assets",
  "ccm/taxonomies",
  "ccm/navigation",
  "ccm/redirects",
  "ccm/i18n",
  "ccm/collections",
  "ccm/settings",
  "design/screenshots",
  "design/components",
  "design/templates",
  "verify",
  "reports",
  "llm-log",
  "llm-cache",
  "autofix",
] as const;

/**
 * Max safeId length. Filesystems cap a path segment at 255 bytes (APFS/ext4); callers append suffixes such as
 * ".<locale>.json" or ".rendered.html", so leave headroom.
 */
export const SAFE_ID_MAX = 200;
const SAFE_ID_HASH_LEN = 12;

/**
 * Filesystem-safe id: "drupal:node:12" -> "drupal_node_12", "/de/über uns" -> "_de__ber_uns".
 * Ids longer than SAFE_ID_MAX after sanitising (e.g. asset URLs with long query strings) are truncated and suffixed
 * with a sha1 of the full original id, so the result stays deterministic and collision-free. Ids that fit are unchanged.
 */
export function safeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s.length) return "root";
  if (s.length <= SAFE_ID_MAX) return s;
  const hash = createHash("sha1").update(id).digest("hex").slice(0, SAFE_ID_HASH_LEN);
  return `${s.slice(0, SAFE_ID_MAX - SAFE_ID_HASH_LEN - 1).replace(/[._-]+$/, "")}_${hash}`;
}

export class Workspace {
  readonly root: string;
  constructor(
    readonly site: string,
    baseDir = process.env.CMP_WORKSPACE_DIR ?? "workspace",
  ) {
    this.root = resolve(baseDir, site);
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  async init(): Promise<void> {
    for (const d of WORKSPACE_DIRS) await mkdir(this.path(d), { recursive: true });
  }

  async exists(...parts: string[]): Promise<boolean> {
    try {
      await stat(this.path(...parts));
      return true;
    } catch {
      return false;
    }
  }

  async readJson<T = unknown>(rel: string, schema?: z.ZodType<T>): Promise<T> {
    const data = JSON.parse(await readFile(this.path(rel), "utf8"));
    return schema ? schema.parse(data) : (data as T);
  }

  async writeJson(rel: string, data: unknown): Promise<string> {
    const p = this.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(data, null, 2) + "\n", "utf8");
    return p;
  }

  async readText(rel: string): Promise<string> {
    return readFile(this.path(rel), "utf8");
  }

  async writeText(rel: string, text: string | Uint8Array): Promise<string> {
    const p = this.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  }

  /** Recursively list files (workspace-relative) under a directory. */
  async list(rel: string, ext?: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (r: string) => {
      let ents;
      try {
        ents = await readdir(this.path(r), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const child = join(r, e.name);
        if (e.isDirectory()) await walk(child);
        else if (!ext || e.name.endsWith(ext)) out.push(child);
      }
    };
    await walk(rel);
    return out.sort();
  }

  // ---- canonical CCM paths
  entryPath(type: string, ccmId: string, locale: string) {
    return `ccm/entries/${type}/${safeId(ccmId)}.${locale}.json`;
  }
  assetPath(ccmId: string) {
    return `ccm/assets/${safeId(ccmId)}.json`;
  }
  taxonomyPath(id: string) {
    return `ccm/taxonomies/${safeId(id)}.json`;
  }
  navigationPath(id: string) {
    return `ccm/navigation/${safeId(id)}.json`;
  }
  collectionPath(id: string) {
    return `ccm/collections/${safeId(id)}.json`;
  }
  static readonly SCHEMA_PATH = "ccm/schema/content-types.json";
  static readonly REDIRECTS_PATH = "ccm/redirects/redirects.json";
  static readonly LOCALES_PATH = "ccm/i18n/locales.json";
  static readonly SETTINGS_PATH = "ccm/settings/site.json";
  static readonly IDMAP_PATH = "idmap.json";
}
