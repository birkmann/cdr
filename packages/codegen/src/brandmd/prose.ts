// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// The model-written slots of DESIGN.md (design-md--generator/PLAN.md §6.3): one design-model request per slot group
// (components in batches), JSON answers at low temperature, each slot checked by validate.ts. A rejected slot is asked
// again once with the error list; when it still fails it is reported failed. There is no template fallback: without a
// model every slot fails, so a run without AI is visibly incomplete.
// CDR: the model is not resolved here. The caller (core, through the session's ProviderRegistry)
// passes a `ProseModel` function; this package stays free of providers.
import {
  COMPONENT_BATCH,
  proseMessages,
  retryMessage,
  SLOT_GROUPS,
  type ChatMessage,
  type SlotGroup,
} from "./prompts.js";
import type { BrandFacts, ProseSlots, SlotName, SlotReport } from "@harness/protocol";
import { validateSlot } from "./validate.js";

/** Requests in flight at once. */
export const PROSE_CONCURRENCY = 2;
export const PROSE_TEMPERATURE = 0.2;
/** Requests per slot: the first answer plus one re-ask with the errors. */
export const PROSE_ATTEMPTS = 3;

/** One request to the model: the messages, a JSON answer wanted, its budget. Returns the answer text. */
export interface ProseRequest {
  messages: ChatMessage[];
  temperature: number;
  /** answer budget in tokens */
  maxTokens: number;
  signal?: AbortSignal;
}

/** The model that writes the prose (supplied by the host: core's ProviderRegistry, a MockProvider in tests). */
export interface ProseModel {
  name: string;
  complete(req: ProseRequest): Promise<string>;
}

export const NO_MODEL =
  "no AI model available: the brand guide prose needs a model (recreate.models.naming or the session model)";

/** The first JSON object in a model answer (tolerates code fences and text around it); null when there is none. */
export function parseJsonLoose<T>(text: string): T | null {
  const s = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  } catch {
    /* fall through */
  }
  const a = s.indexOf("{"),
    b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

interface Task {
  group: SlotGroup;
  keys?: string[];
  label: string;
}

interface TaskResult {
  values: Partial<ProseSlots>;
  reports: SlotReport[];
}

type Pick = ProseModel;

const aborted = (signal?: AbortSignal) => !!signal?.aborted;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One group (or components batch): ask, check, re-ask the rejected slots once. */
async function runTask(
  task: Task,
  facts: BrandFacts,
  pick: Pick,
  o: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<TaskResult> {
  const started = performance.now();
  const pending = new Set<SlotName>(task.group.slots);
  const values: Partial<ProseSlots> = {};
  const errors = new Map<SlotName, string[]>();
  const attempts = new Map<SlotName, number>();
  const done = new Map<SlotName, number>();
  let messages: ChatMessage[] = proseMessages(task.group.id, facts, task.keys);
  // a slot that only came back too short (an SEO answer of 14 words for 20) gets two more tries: the model is told the
  // count it missed, and lengthens what it wrote
  const shortOnly = () =>
    pending.size > 0 &&
    [...pending].every((s) => {
      const e = errors.get(s) ?? [];
      return e.length > 0 && e.every((x) => /too short/.test(x));
    });
  const limit = () => PROSE_ATTEMPTS + (shortOnly() ? 2 : 0);
  for (let attempt = 1; attempt <= limit() && pending.size; attempt++) {
    for (const s of pending) attempts.set(s, attempt);
    let text = "";
    try {
      text = await pick.complete({
        messages,
        temperature: PROSE_TEMPERATURE,
        maxTokens: task.group.numPredict,
        signal: o.signal,
      });
    } catch (e) {
      if (aborted(o.signal)) throw e;
      for (const s of pending) errors.set(s, [`model call failed: ${message(e)}`]);
      continue;
    }
    const answer = parseJsonLoose<Record<string, unknown>>(text);
    if (!answer) for (const s of pending) errors.set(s, [`${s}: the answer was not a JSON object`]);
    else {
      for (const s of [...pending]) {
        const r = validateSlot(s, answer[s], facts, task.keys ? { expectKeys: task.keys } : {});
        if (r.value !== undefined) {
          (values as Record<string, unknown>)[s] = r.value;
          pending.delete(s);
          errors.delete(s);
          done.set(s, performance.now() - started);
        } else errors.set(s, r.errors);
      }
    }
    if (pending.size && attempt < limit()) {
      const list = [...pending].flatMap((s) => errors.get(s) ?? []);
      o.onProgress?.(
        `Brand guide: ${task.label}: ${list.length} problem${list.length === 1 ? "" : "s"}, asking again…`,
      );
      messages = [
        ...messages,
        { role: "assistant", content: text || "{}" },
        { role: "user", content: retryMessage([...pending], list) },
      ];
    }
  }
  const ms = performance.now() - started;
  return {
    values,
    reports: task.group.slots.map((slot) => ({
      slot,
      ok: !pending.has(slot),
      attempts: attempts.get(slot) ?? 0,
      errors: errors.get(slot) ?? [],
      ms: Math.round(done.get(slot) ?? ms),
      model: pick.name,
    })),
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The tasks for a run: one per group, the components in batches of COMPONENT_BATCH keys. */
export function proseTasks(facts: BrandFacts): Task[] {
  const tasks: Task[] = [];
  for (const group of SLOT_GROUPS) {
    if (group.id !== "components") {
      tasks.push({ group, label: group.title });
      continue;
    }
    const keys = facts.components.map((c) => c.key);
    const n = Math.ceil(keys.length / COMPONENT_BATCH);
    for (let i = 0; i < n; i++)
      tasks.push({
        group,
        keys: keys.slice(i * COMPONENT_BATCH, (i + 1) * COMPONENT_BATCH),
        label: n > 1 ? `${group.title} ${i + 1}/${n}` : group.title,
      });
  }
  return tasks;
}

/** Merge the components batches into one report (ok when every batch is). */
function mergeReports(reports: SlotReport[]): SlotReport[] {
  const out = new Map<SlotName, SlotReport>();
  for (const r of reports) {
    const prev = out.get(r.slot);
    out.set(
      r.slot,
      prev
        ? {
            ...prev,
            ok: prev.ok && r.ok,
            attempts: Math.max(prev.attempts, r.attempts),
            errors: [...prev.errors, ...r.errors],
            ms: prev.ms + r.ms,
          }
        : r,
    );
  }
  return [...out.values()];
}

/**
 * Write every prose slot from the facts. Slots that fail validation twice are left out of `slots` and reported with
 * `ok: false`; component batches that pass are kept even when another batch failed (the report says which keys).
 * Throws only on abort.
 */
export async function writeProse(
  facts: BrandFacts,
  o: { model?: ProseModel | null; signal?: AbortSignal; onProgress?: (msg: string) => void } = {},
): Promise<{ slots: Partial<ProseSlots>; reports: SlotReport[]; model?: string }> {
  const pick = o.model ?? null;
  const allSlots = SLOT_GROUPS.flatMap((g) => g.slots);
  if (!pick) {
    o.onProgress?.(`Brand guide: ${NO_MODEL}`);
    return {
      slots: {},
      reports: allSlots.map((slot) => ({ slot, ok: false, attempts: 0, errors: [NO_MODEL], ms: 0 })),
    };
  }
  const tasks = proseTasks(facts).filter((t) => !t.keys || t.keys.length);
  let finished = 0;
  o.onProgress?.(`Brand guide: writing ${tasks.length} parts with ${pick.name}…`);
  const results = await pool(tasks, PROSE_CONCURRENCY, async (task) => {
    if (aborted(o.signal)) throw new DOMException("aborted", "AbortError");
    o.onProgress?.(`Brand guide: writing ${task.label}…`);
    const r = await runTask(task, facts, pick, o);
    finished++;
    const failed = r.reports.filter((x) => !x.ok).map((x) => x.slot);
    o.onProgress?.(
      `Brand guide: ${task.label} ${failed.length ? `failed (${failed.join(", ")})` : "done"} · ${finished}/${tasks.length}`,
    );
    return r;
  });
  const slots: Partial<ProseSlots> = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.values)) {
      const key = k as SlotName;
      if (key === "components" || key === "colorRoles")
        (slots as Record<string, unknown>)[key] = {
          ...((slots[key] as Record<string, string> | undefined) ?? {}),
          ...(v as Record<string, string>),
        };
      else (slots as Record<string, unknown>)[key] = v;
    }
  }
  const reports = mergeReports(results.flatMap((r) => r.reports));
  // a system without components: the slot has nothing to write and nothing to fail
  if (allSlots.includes("components") && !tasks.some((t) => t.group.id === "components")) {
    slots.components = {};
    reports.push({ slot: "components", ok: true, attempts: 0, errors: [], ms: 0, model: pick.name });
  }
  const order = new Map(allSlots.map((s, i) => [s, i]));
  reports.sort((a, b) => order.get(a.slot)! - order.get(b.slot)!);
  return { slots, reports, model: pick.name };
}
