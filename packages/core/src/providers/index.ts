import type { HarnessConfig } from "@harness/protocol";
import { OpenAICompatibleProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import type { Provider } from "./types.js";
import { parseModelRef } from "../config.js";
import { registerSecret } from "../util.js";

export * from "./types.js";
export * from "./openai.js";
export * from "./anthropic.js";
export * from "./mock.js";
export * from "./text-protocol.js";

/** Lazily constructs providers from config; tests can inject instances. */
export class ProviderRegistry {
  private readonly cache = new Map<string, Provider>();
  constructor(
    private readonly cfg: HarnessConfig,
    injected: Record<string, Provider> = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const [k, v] of Object.entries(injected)) this.cache.set(k, v);
  }

  get(providerId: string): Provider {
    const cached = this.cache.get(providerId);
    if (cached) return cached;
    const pc = this.cfg.providers[providerId];
    if (!pc) throw new Error(`Unknown provider "${providerId}"`);
    const apiKey = pc.apiKey ?? (pc.apiKeyEnv ? this.env[pc.apiKeyEnv] : undefined);
    registerSecret(apiKey);
    if (pc.apiKeyEnv && !apiKey) {
      throw new Error(`Provider "${providerId}" needs ${pc.apiKeyEnv} (set it in the environment or .env)`);
    }
    let p: Provider;
    if (pc.type === "openai-compatible") {
      if (!pc.baseURL) throw new Error(`Provider "${providerId}" needs baseURL`);
      p = new OpenAICompatibleProvider({
        id: providerId,
        baseURL: pc.baseURL,
        apiKey,
        headers: pc.headers,
        models: pc.models,
      });
    } else if (pc.type === "anthropic") {
      p = new AnthropicProvider({ id: providerId, baseURL: pc.baseURL, apiKey, models: pc.models });
    } else if (pc.type === "mock") {
      // Scripted replies for offline demos / subprocess tests: HARNESS_MOCK_REPLIES='[{"text":"hi"}]'
      const raw = this.env.HARNESS_MOCK_REPLIES;
      p = new MockProvider({ id: providerId, replies: raw ? JSON.parse(raw) : undefined });
    } else throw new Error(`Unsupported provider type "${(pc as { type: string }).type}"`);
    this.cache.set(providerId, p);
    return p;
  }

  resolve(ref: string): { provider: Provider; model: string; ref: string } {
    const { provider, model } = parseModelRef(ref);
    return { provider: this.get(provider), model, ref };
  }

  isConfigured(providerId: string): boolean {
    const pc = this.cfg.providers[providerId];
    if (!pc) return false;
    if (this.cache.has(providerId)) return true;
    return !pc.apiKeyEnv || !!(pc.apiKey ?? this.env[pc.apiKeyEnv]);
  }
}

/**
 * User-facing reason a model cannot be used yet (no model chosen, unknown provider, missing API key),
 * or undefined when its provider is configured. Lets UIs say "connect a model" instead of starting a run.
 */
export function modelConnectionProblem(
  cfg: HarnessConfig,
  registry: ProviderRegistry,
  ref: string | undefined,
): string | undefined {
  if (!ref) return "No model is connected. Choose a model, or set models.executor in cdr.config.json.";
  let provider: string;
  try {
    provider = parseModelRef(ref).provider;
  } catch (e) {
    return (e as Error).message;
  }
  const pc = cfg.providers[provider];
  if (!pc)
    return `No model is connected: provider "${provider}" (for ${ref}) is not set up. Add it to cdr.config.json or choose another model.`;
  if (registry.isConfigured(provider)) return undefined;
  return `No model is connected. ${ref} needs ${pc.apiKeyEnv}. Add your ${provider} API key (desktop app: Settings → Model providers; otherwise ~/.harness/.env or the project .env), or choose a model from a connected provider.`;
}
