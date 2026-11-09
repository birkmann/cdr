/**
 * LLM usage accounting for the loop: wraps the client so every attempt knows its calls, tokens, cost and cache hits,
 * and the loop can stop at the budget (AUTOFIX_BUDGET_EXHAUSTED) independently of the client's own guard.
 */
import { estimateCostUsd, type LlmClient, type LlmRequest, type LlmResponse } from "@harness/mirror-core";

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  estCostUsd: number;
  cached: number;
  failed: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, promptTokens: 0, completionTokens: 0, estCostUsd: 0, cached: 0, failed: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    estCostUsd: Math.round((a.estCostUsd + b.estCostUsd) * 1e6) / 1e6,
    cached: a.cached + b.cached,
    failed: a.failed + b.failed,
  };
}

/** true when an LLM error means "budget spent" (W1-A's client guard or a 402 from the provider) */
export function isBudgetError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return (e as { code?: string })?.code === "budget" || /budget/i.test(m) || (e as { status?: number })?.status === 402 || /insufficient.?balance/i.test(m);
}

export class MeteredLlm implements LlmClient {
  total: Usage = emptyUsage();
  private window: Usage = emptyUsage();
  budgetHit = false;

  constructor(
    private readonly inner: LlmClient,
    private readonly budgetUsd?: number,
  ) {}

  spentUsd(): number {
    return this.total.estCostUsd;
  }

  remainingUsd(): number | undefined {
    return this.budgetUsd === undefined ? undefined : Math.max(0, Math.round((this.budgetUsd - this.total.estCostUsd) * 1e6) / 1e6);
  }

  exhausted(): boolean {
    return this.budgetHit || (this.budgetUsd !== undefined && this.total.estCostUsd >= this.budgetUsd);
  }

  /** usage since the last take() */
  take(): Usage {
    const w = this.window;
    this.window = emptyUsage();
    return w;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (this.exhausted()) {
      this.budgetHit = true;
      throw new Error(`autofix LLM budget of $${this.budgetUsd} exhausted (spent $${this.total.estCostUsd.toFixed(4)})`);
    }
    let res: LlmResponse;
    try {
      res = await this.inner.complete(req);
    } catch (e) {
      if (isBudgetError(e)) this.budgetHit = true;
      this.bump({ ...emptyUsage(), calls: 1, failed: 1 });
      throw e;
    }
    const cached = !!res.cached;
    const provider = (res.provider ?? "deepseek") as "deepseek" | "ollama";
    // W1-A's client reports the per-model price (flash / v4-pro, cache hits); fall back to the provider list price
    const own = (res as { estCostUsd?: number }).estCostUsd;
    const cost = cached ? 0 : typeof own === "number" ? own : estimateCostUsd(provider === "ollama" ? "ollama" : "deepseek", res.promptTokens ?? 0, res.completionTokens ?? 0);
    this.bump({
      calls: 1,
      promptTokens: cached ? 0 : (res.promptTokens ?? 0),
      completionTokens: cached ? 0 : (res.completionTokens ?? 0),
      estCostUsd: cost,
      cached: cached ? 1 : 0,
      failed: 0,
    });
    return res;
  }

  private bump(u: Usage): void {
    this.total = addUsage(this.total, u);
    this.window = addUsage(this.window, u);
  }
}
