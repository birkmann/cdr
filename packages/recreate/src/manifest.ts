// The run folder and its manifest. Every stage reads and writes files under
// `.harness/recreate/<run-id>/`, so a run is resumable and a later stage can be re-run alone (`--from components`).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  RecreateConsent,
  RecreateRequest,
  RecreateStage,
  RecreateTarget,
  RunStatus,
} from "@harness/protocol";

export const RUNS_DIR = ".harness/recreate";

/** A run id: one path segment (the server, the tools, the CLI and RunDir all enforce it). */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const isRunId = (id: unknown): id is string => typeof id === "string" && RUN_ID.test(id);

/** `base` joined with `rel`, or an error when `rel` is absolute or leaves `base` (`..`). */
export function joinInside(base: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`path "${rel}" must be relative`);
  const abs = resolve(base, rel);
  const r = relative(base, abs);
  if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r))
    throw new Error(`path "${rel}" leaves its folder`);
  return abs;
}

export interface StageRecord {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  ms?: number;
  startedAt?: string;
  detail?: string;
  /** parts budgets dropped (resumable) */
  skipped?: string[];
}

export interface RunManifest {
  id: string;
  version: 1;
  createdAt: string;
  updatedAt: string;
  request: RecreateRequest;
  /** the URL the page ended up at (redirects, www.) */
  finalUrl?: string;
  consent?: RecreateConsent;
  /** variants: capture width, the width the variant applies from, the session it was walked in */
  variants?: { width: number; minWidth: number; session: number }[];
  /** capture sessions (device classes): the loaded width and the other widths walked */
  sessions?: { width: number; alt: number[]; menus: number[] }[];
  /** widths between and beyond the captures the output is checked at (the responsive gate) */
  sweep?: number[];
  stages: Partial<Record<RecreateStage, StageRecord>>;
  /** output folders relative to the run folder */
  outputs: { target: RecreateTarget; path: string }[];
  measurements: { target: RecreateTarget; report: string; pass: boolean }[];
  gates: { name: string; pass: boolean; detail?: string }[];
  status?: RunStatus;
  summary?: string;
}

/** `20261105-121314-bvg-de`: sortable, readable, unique enough per project. */
export function newRunId(url: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  let host = "page";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep */
  }
  const slug =
    host
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "page";
  const rnd = Math.random().toString(36).slice(2, 5);
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${slug}-${rnd}`;
}

export class RunDir {
  constructor(
    readonly projectRoot: string,
    readonly id: string,
  ) {
    if (!isRunId(id)) throw new Error(`"${String(id)}" is not a run id`);
  }

  /** absolute path of the run folder (or of a file inside it); never outside the run folder */
  path(...parts: string[]): string {
    const root = join(this.projectRoot, RUNS_DIR, this.id);
    return parts.length ? joinInside(root, join(...parts)) : root;
  }

  /** path relative to the project root */
  rel(...parts: string[]): string {
    return [RUNS_DIR, this.id, ...parts].join("/");
  }

  exists(...parts: string[]): boolean {
    return existsSync(this.path(...parts));
  }

  write(rel: string, data: string | Uint8Array): void {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    // atomic for JSON the UI may be reading
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, data);
    renameSync(tmp, p);
  }

  writeJson(rel: string, value: unknown): void {
    this.write(rel, JSON.stringify(value, null, rel.endsWith("snapshot.json") ? 0 : 2) + "\n");
  }

  read(rel: string): Buffer {
    return readFileSync(this.path(rel));
  }

  readJson<T>(rel: string): T {
    return JSON.parse(readFileSync(this.path(rel), "utf8")) as T;
  }

  manifest(): RunManifest {
    return this.readJson<RunManifest>("manifest.json");
  }

  saveManifest(m: RunManifest): void {
    m.updatedAt = new Date().toISOString();
    this.writeJson("manifest.json", m);
  }
}

/** The stages in run order, and which ones each target needs. */
export const STAGE_ORDER: RecreateStage[] = [
  "consent",
  "probe",
  "capture",
  "scene",
  "build",
  "measure",
  "components",
  "system",
  "convert",
  "ds-export",
];

export function stagesFor(targets: RecreateTarget[]): RecreateStage[] {
  const need = new Set<RecreateStage>(["consent", "probe", "capture", "scene", "build", "measure"]);
  const componentTargets = targets.filter((t) => t.startsWith("ds-") || t === "tokens" || t === "design-md");
  if (componentTargets.length || targets.includes("react-vite")) {
    need.add("components");
    need.add("system");
  }
  if (targets.some((t) => t !== "static" && !componentTargets.includes(t))) need.add("convert");
  if (componentTargets.length) need.add("ds-export");
  return STAGE_ORDER.filter((s) => need.has(s));
}
