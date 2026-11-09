/**
 * Resolve the profile set for a site run (P1, docs/DEEPSEEK_ONLY_PLAN.md §5.1):
 *   site `mapping/profiles.yaml` > theme pack (`source.themePack`: auto | none | <id>) > generic.
 * "auto" detects the theme from `/themes/custom/<theme>/` paths in the crawled asset list and raw HTML.
 */
import type { Issue, SiteConfig, Workspace } from "@harness/mirror-core";
import type { AssetRecord, PageManifest } from "./crawl.js";
import { detectThemes, packForThemes, parseProfilePack, profileSetFor, type ProfilePack, type ProfileSet } from "./profiles.js";

export const SITE_PROFILES_PATH = "mapping/profiles.yaml";

export interface ResolvedProfiles {
  set: ProfileSet;
  /** "auto" | "none" | <id> as configured */
  requested: string;
  /** theme names found in the crawl (auto only) */
  detected: string[];
  sitePack?: ProfilePack;
  issues: Issue[];
}

/** Read + validate workspace mapping/profiles.yaml (undefined when absent; throws when invalid — it is a reviewed file). */
export async function readSiteProfiles(ws: Workspace, rel = SITE_PROFILES_PATH): Promise<ProfilePack | undefined> {
  if (!(await ws.exists(rel))) return undefined;
  return parseProfilePack(await ws.readText(rel), `${ws.site}/${rel}`);
}

export async function resolveProfileSet(
  ws: Workspace,
  site: Pick<SiteConfig, "source">,
  crawl?: { pages: PageManifest[]; assets: AssetRecord[] },
  opts: { themePack?: string; sitePack?: ProfilePack | null } = {},
): Promise<ResolvedProfiles> {
  const requested = opts.themePack ?? site.source?.themePack ?? "auto";
  const issues: Issue[] = [];
  let detected: string[] = [];
  let packId = requested;
  if (requested === "auto") {
    const texts: string[] = (crawl?.assets ?? []).map((a) => a.path);
    for (const p of (crawl?.pages ?? []).slice(0, 5)) {
      const f = p.files.raw ?? p.files.rendered;
      if (!f) continue;
      try {
        texts.push(await ws.readText(f));
      } catch {
        /* not captured */
      }
    }
    detected = detectThemes(texts);
    packId = packForThemes(detected);
    if (packId === "none")
      issues.push({
        severity: "info",
        code: "THEME_PACK_NONE",
        message: `no theme pack for ${detected.length ? `theme(s) ${detected.slice(0, 3).join(", ")}` : "this site (no /themes/custom/<theme>/ paths)"} — generic extraction; profile-infer (autofix) proposes ${SITE_PROFILES_PATH}`,
      });
  }
  const sitePack = opts.sitePack === null ? undefined : (opts.sitePack ?? (await readSiteProfiles(ws)));
  const set = profileSetFor(packId, sitePack);
  return { set, requested, detected, sitePack, issues };
}
