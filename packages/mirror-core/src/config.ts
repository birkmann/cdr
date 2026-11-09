/**
 * sites/<site>.yaml loading + validation against the frozen `SiteConfig` Zod schema.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SiteConfig } from "./contracts.js";
import { findRepoRoot } from "./env.js";

export class SiteConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(message);
    this.name = "SiteConfigError";
  }
}

/** Directory holding `<site>.yaml` files: `CMP_SITES_DIR` or `<repoRoot>/sites`. */
export function sitesDir(override?: string): string {
  return resolve(override ?? process.env.CMP_SITES_DIR ?? join(findRepoRoot(), "sites"));
}

/** Resolve a site slug ("fixture") or a path ("sites/fixture.yaml", "/abs/x.yml") to a yaml file path. */
export function resolveSiteConfigPath(siteOrPath: string, opts: { sitesDir?: string } = {}): string {
  const looksLikePath = /\.ya?ml$/i.test(siteOrPath) || siteOrPath.includes("/") || siteOrPath.includes("\\");
  if (looksLikePath) return isAbsolute(siteOrPath) ? siteOrPath : resolve(siteOrPath);
  return join(sitesDir(opts.sitesDir), `${siteOrPath}.yaml`);
}

/** Parse + validate a config object (already loaded from YAML). Throws SiteConfigError with readable Zod issues. */
export function parseSiteConfig(raw: unknown, file?: string): SiteConfig {
  const res = SiteConfig.safeParse(raw);
  if (!res.success) {
    throw new SiteConfigError(`Invalid site config${file ? ` ${file}` : ""}:\n${z.prettifyError(res.error)}`, file);
  }
  return res.data;
}

export interface LoadedSiteConfig {
  config: SiteConfig;
  /** the YAML as written (before Zod defaults) — lets callers see whether e.g. `crawl` was configured explicitly */
  raw: Record<string, unknown>;
  path: string;
}

/** Parse YAML text into a validated config (+ the raw mapping). */
export function parseSiteConfigYaml(text: string, file?: string): { config: SiteConfig; raw: Record<string, unknown> } {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new SiteConfigError(`YAML parse error${file ? ` in ${file}` : ""}: ${(e as Error).message}`, file);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SiteConfigError(`Site config${file ? ` ${file}` : ""} must be a YAML mapping`, file);
  return { config: parseSiteConfig(raw, file), raw: raw as Record<string, unknown> };
}

export async function loadSiteConfigWithRaw(siteOrPath: string, opts: { sitesDir?: string } = {}): Promise<LoadedSiteConfig> {
  const path = resolveSiteConfigPath(siteOrPath, opts);
  if (!existsSync(path)) {
    throw new SiteConfigError(`Site config not found: ${path} (create it with \`pnpm migrate init <site>\`)`, path);
  }
  return { ...parseSiteConfigYaml(await readFile(path, "utf8"), path), path };
}

/** Load `sites/<site>.yaml` (or an explicit path) and validate it. */
export async function loadSiteConfig(siteOrPath: string, opts: { sitesDir?: string } = {}): Promise<SiteConfig> {
  return (await loadSiteConfigWithRaw(siteOrPath, opts)).config;
}
