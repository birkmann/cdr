// autopilot/sites.yaml: the sites of the matrix and the holdout (plan §3.2), normalised to SiteConfig.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { AutopilotPaths, SiteConfig, SitesFile } from "./types.js";

const FRAMEWORKS = new Set(["nextjs"]);
const SITE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The id of a site that names none: its host without `www.` and the top-level domain. */
export function siteIdFromUrl(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".");
  return (labels.length > 1 ? labels.slice(0, -1) : labels).join("-");
}

function parseEntry(id: string | undefined, raw: unknown, where: string): SiteConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${where}: expected a site entry`);
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url : undefined;
  const fixture = typeof r.fixture === "string" ? r.fixture : undefined;
  if (!url && !fixture) throw new Error(`${where}: a site needs a url or a fixture`);
  if (url && fixture) throw new Error(`${where}: a site has a url or a fixture, not both`);
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${where}: "${url}" is not a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error(`${where}: "${url}" is not an http(s) URL`);
  }
  const resolvedId = id ?? (typeof r.id === "string" ? r.id : url ? siteIdFromUrl(url) : fixture!);
  if (!SITE_ID.test(resolvedId))
    throw new Error(`${where}: "${resolvedId}" is not a site id (lower-case letters, digits, dashes)`);
  const framework = (r.framework as string | undefined) ?? "nextjs";
  if (!FRAMEWORKS.has(framework)) throw new Error(`${where}: framework "${framework}" is not supported`);
  if (r.viewports !== undefined && !Array.isArray(r.viewports))
    throw new Error(`${where}: viewports must be a list`);
  const viewports = r.viewports as unknown[] | undefined;
  const freeze = r.freeze as { wayback?: unknown } | undefined;
  return {
    id: resolvedId,
    ...(url ? { url } : {}),
    ...(fixture ? { fixture } : {}),
    framework: "nextjs",
    ...(viewports ? { viewports: viewports.map((v) => String(v)) } : {}),
    ...(freeze && typeof freeze === "object" ? { freeze: { wayback: freeze.wayback === true } } : {}),
  };
}

export function parseSites(text: string, source = "sites.yaml"): SitesFile {
  const doc = YAML.parse(text) as { sites?: unknown; holdout?: unknown } | null;
  if (!doc || typeof doc !== "object") throw new Error(`${source}: empty file`);
  const rawSites = doc.sites;
  if (typeof rawSites !== "object" || rawSites === null || Array.isArray(rawSites))
    throw new Error(`${source}: sites must be a mapping of id to site`);
  const sites = Object.entries(rawSites).map(([id, raw]) => parseEntry(id, raw, `${source}: ${id}`));
  const rawHoldout = doc.holdout ?? [];
  if (!Array.isArray(rawHoldout)) throw new Error(`${source}: holdout must be a list`);
  const holdout = (rawHoldout as unknown[]).map((raw, i) =>
    parseEntry(undefined, raw, `${source}: holdout ${i + 1}`),
  );
  const seen = new Set<string>();
  for (const s of [...sites, ...holdout]) {
    if (seen.has(s.id)) throw new Error(`${source}: site id "${s.id}" appears twice`);
    seen.add(s.id);
  }
  return { sites, holdout };
}

export function loadSites(paths: Pick<AutopilotPaths, "committed">): SitesFile {
  const file = join(paths.committed, "sites.yaml");
  if (!existsSync(file)) throw new Error(`no sites file at ${file}`);
  return parseSites(readFileSync(file, "utf8"), file);
}

/** The sites to run: every matrix site, or the named ones (holdout entries included). */
export function selectSites(file: SitesFile, ids?: string[]): SiteConfig[] {
  if (!ids?.length) return file.sites;
  const all = [...file.sites, ...file.holdout];
  return ids.map((id) => {
    const site = all.find((s) => s.id === id);
    if (!site) throw new Error(`unknown site "${id}" (known: ${all.map((s) => s.id).join(", ")})`);
    return site;
  });
}
