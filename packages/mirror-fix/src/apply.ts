/**
 * Applying candidate patches: path resolution, the data-only guard, backups and rollback, plus the reports/verify
 * snapshot that lets a rejected candidate restore the pre-candidate gate state without re-running verify.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Workspace } from "@harness/mirror-core";
import type { FilePatch } from "./types.js";

export class PatchRefused extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PatchRefused";
  }
}

/** Workspace-relative prefixes a candidate may write (data files only, guard rail 5). */
const WS_ALLOWED = [/^mapping\//, /^design\/overrides\//];
const WS_REFUSED = /^(ccm|reports|llm-log|llm-cache|raw|verify|autofix)\/|^idmap\.json$/;
const CODE_EXT = /\.(m?[jt]sx?|cjs|mts|cts|css\.ts|json5?|sh)$/i;

export interface ResolvedPatch {
  patch: FilePatch;
  abs: string;
  /** "ws" or "repo" relative, for the attempt log */
  display: string;
}

/** Resolve + guard one patch path. Throws PatchRefused. */
export function resolvePatchPath(p: string, ws: Workspace, repoRoot: string): { abs: string; display: string } {
  if (!p || isAbsolute(p) || p.split(/[/\\]/).includes("..")) throw new PatchRefused(`patch path must be relative without "..": ${p}`, p);
  const n = normalize(p).split(sep).join("/");
  let abs: string;
  if (n.startsWith("sites/") || n.startsWith("packages/")) {
    abs = resolve(repoRoot, n);
    const siteYaml = new RegExp(`^sites/${ws.site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.ya?ml$`);
    const themePack = /^packages\/adapters\/source-html\/themes\/[A-Za-z0-9_.-]+\.ya?ml$/;
    if (!siteYaml.test(n) && !themePack.test(n)) throw new PatchRefused(`repo path not writable by autofix (only sites/${ws.site}.yaml, source-html theme packs): ${n}`, p);
  } else {
    if (WS_REFUSED.test(n)) throw new PatchRefused(`generated / log path is never patched (fix the producing step's input instead): ${n}`, p);
    if (!WS_ALLOWED.some((r) => r.test(n))) throw new PatchRefused(`workspace path outside mapping/ and design/overrides/: ${n}`, p);
    if (CODE_EXT.test(n) && !/\.json$/i.test(n)) throw new PatchRefused(`code files are never patched by autofix: ${n}`, p);
    abs = ws.path(n);
  }
  if (abs.split(sep).includes("_golden") || /[/\\]_golden[/\\]/.test(abs)) throw new PatchRefused(`frozen golden output: ${abs}`, p);
  return { abs, display: n };
}

export interface Backup {
  abs: string;
  display: string;
  /** null = the file did not exist */
  content: Buffer | null;
}

async function readOrNull(abs: string): Promise<Buffer | null> {
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}

/** Back up every touched file, then write the patch. Guard errors throw before anything is written. */
export async function applyPatches(files: FilePatch[], ws: Workspace, repoRoot: string): Promise<Backup[]> {
  const resolved = files.map((f) => ({ f, ...resolvePatchPath(f.path, ws, repoRoot) }));
  const backups: Backup[] = [];
  const seen = new Set<string>();
  for (const r of resolved) {
    if (seen.has(r.abs)) continue;
    seen.add(r.abs);
    backups.push({ abs: r.abs, display: r.display, content: await readOrNull(r.abs) });
  }
  try {
    for (const r of resolved) {
      if (r.f.content === null) await rm(r.abs, { force: true });
      else {
        await mkdir(dirname(r.abs), { recursive: true });
        await writeFile(r.abs, r.f.content);
      }
    }
  } catch (e) {
    await restoreBackups(backups);
    throw e;
  }
  return backups;
}

export async function restoreBackups(backups: Backup[]): Promise<void> {
  for (const b of backups) {
    if (b.content === null) await rm(b.abs, { force: true });
    else {
      await mkdir(dirname(b.abs), { recursive: true });
      await writeFile(b.abs, b.content);
    }
  }
}

/** Save backups as files (autofix/attempts/<seq>-backup/…) so a crash mid-candidate can be rolled back by hand. */
export async function persistBackups(ws: Workspace, dir: string, backups: Backup[], repoRoot: string): Promise<void> {
  const index: { path: string; existed: boolean; file?: string }[] = [];
  let n = 0;
  for (const b of backups) {
    const rel = relative(repoRoot, b.abs).startsWith("..") ? b.display : relative(repoRoot, b.abs);
    if (b.content === null) index.push({ path: rel, existed: false });
    else {
      const file = `${dir}/${String(++n).padStart(2, "0")}-${b.display.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
      await ws.writeText(file, b.content);
      index.push({ path: rel, existed: true, file });
    }
  }
  await ws.writeJson(`${dir}/index.json`, { note: "pre-candidate content of every touched file; paths relative to the repo (or workspace)", files: index });
}

// ------------------------------------------------------------------ gate-state snapshot (reports/*.json, verify/*.json)

export interface StateSnapshot {
  files: Map<string, Buffer>;
}

async function listFiles(dir: string, pred: (rel: string) => boolean, base = dir): Promise<string[]> {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of ents) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(abs, pred, base)));
    else if (pred(relative(base, abs))) out.push(abs);
  }
  return out;
}

/** reports/*.{json,md} + verify/*.json (not screenshots) */
export async function snapshotState(ws: Workspace): Promise<StateSnapshot> {
  const files = new Map<string, Buffer>();
  for (const [dir, re] of [
    ["reports", /\.(json|md)$/],
    ["verify", /^[^/\\]+\.(json|md)$/],
  ] as const) {
    for (const abs of await listFiles(ws.path(dir), (r) => re.test(r))) files.set(abs, await readFile(abs));
  }
  return { files };
}

/** Restore the snapshot; files created after it (reports/verify only) are removed. */
export async function restoreState(ws: Workspace, snap: StateSnapshot): Promise<void> {
  for (const [dir, re] of [
    ["reports", /\.(json|md)$/],
    ["verify", /^[^/\\]+\.(json|md)$/],
  ] as const) {
    for (const abs of await listFiles(ws.path(dir), (r) => re.test(r))) if (!snap.files.has(abs) && !/autofix\.(json|md)$/.test(abs)) await rm(abs, { force: true });
  }
  for (const [abs, buf] of snap.files) {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
  }
}

export async function fileBytes(abs: string): Promise<number | null> {
  try {
    return (await stat(abs)).size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- app source snapshot (W2-I)

/** regenerated or installed parts of an app that a snapshot skips (frontend-generate / build / pnpm recreate them) */
const APP_SKIP = new Set(["node_modules", ".next", "public", ".turbo", "out"]);

export type AppSnapshot = { appAbs: string; files: Map<string, Buffer> };

async function appFiles(appAbs: string, dir = appAbs, out: string[] = []): Promise<string[]> {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (dir === appAbs && APP_SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await appFiles(appAbs, p, out);
    else if (e.isFile()) out.push(relative(appAbs, p));
  }
  return out;
}

/** Source files of the app under test (src/, .cmp/, root config), so a failed rollback never leaves it half-updated. */
export async function snapshotApp(appAbs: string): Promise<AppSnapshot | undefined> {
  try {
    if (!(await stat(appAbs)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const files = new Map<string, Buffer>();
  for (const rel of await appFiles(appAbs)) files.set(rel, await readFile(join(appAbs, rel)));
  return { appAbs, files };
}

/** Put the app source back exactly as snapshotted (files added since are removed). */
export async function restoreApp(s: AppSnapshot): Promise<void> {
  for (const rel of await appFiles(s.appAbs)) if (!s.files.has(rel)) await rm(join(s.appAbs, rel), { force: true });
  for (const [rel, buf] of s.files) {
    const abs = join(s.appAbs, rel);
    const cur = await readOrNull(abs);
    if (cur && cur.equals(buf)) continue;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
  }
}
