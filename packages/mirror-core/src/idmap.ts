/**
 * ID map (MIGRATION_PLAN.md §3.4): `idmap.json` = `{ [target]: { [ccmId(:locale)?]: targetId } }`.
 * Target adapters use it so re-runs update instead of duplicating.
 */
import { Workspace } from "./workspace.js";

export type IdMapData = Record<string, Record<string, string>>;

export class IdMap {
  private dirty = false;
  constructor(
    private readonly ws: Workspace,
    private data: IdMapData = {},
  ) {}

  /** Load idmap.json (empty map when missing). */
  static async load(ws: Workspace): Promise<IdMap> {
    if (!(await ws.exists(Workspace.IDMAP_PATH))) return new IdMap(ws, {});
    const raw = await ws.readJson<IdMapData>(Workspace.IDMAP_PATH);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${Workspace.IDMAP_PATH} must be an object`);
    return new IdMap(ws, raw);
  }

  /** Key convention: `ccmId` or `ccmId:locale` for per-locale target objects. */
  static key(ccmId: string, locale?: string): string {
    return locale ? `${ccmId}:${locale}` : ccmId;
  }

  get(target: string, key: string): string | undefined {
    return this.data[target]?.[key];
  }
  has(target: string, key: string): boolean {
    return this.get(target, key) !== undefined;
  }
  set(target: string, key: string, targetId: string): void {
    const t = (this.data[target] ??= {});
    if (t[key] !== targetId) {
      t[key] = targetId;
      this.dirty = true;
    }
  }
  delete(target: string, key: string): boolean {
    if (!this.data[target] || !(key in this.data[target])) return false;
    delete this.data[target][key];
    this.dirty = true;
    return true;
  }
  /** All [key, targetId] pairs of one target. */
  entries(target: string): [string, string][] {
    return Object.entries(this.data[target] ?? {});
  }
  targets(): string[] {
    return Object.keys(this.data);
  }
  size(target?: string): number {
    return target ? Object.keys(this.data[target] ?? {}).length : this.targets().reduce((n, t) => n + this.size(t), 0);
  }
  get isDirty(): boolean {
    return this.dirty;
  }
  toJSON(): IdMapData {
    return this.data;
  }

  /** Persist to idmap.json with sorted keys (stable diffs). */
  async save(): Promise<string> {
    const sorted: IdMapData = {};
    for (const t of Object.keys(this.data).sort()) {
      sorted[t] = {};
      for (const k of Object.keys(this.data[t]).sort()) sorted[t][k] = this.data[t][k];
    }
    this.data = sorted;
    await this.ws.writeJson(Workspace.IDMAP_PATH, sorted);
    this.dirty = false;
    return Workspace.IDMAP_PATH;
  }
}
