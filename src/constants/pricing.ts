/**
 * Static pricing table for common models.
 *
 * Prices are USD per 1M tokens (input / output), as of each provider's public
 * pricing page. These are intentionally conservative: if we don't have a rate
 * we return { input: 0, output: 0 } which yields cost=0 — better than lying.
 *
 * Users who care about exact numbers can override via config.pricing.
 * (Not exposed yet; when we add it the lookup order will be: user override → table → zero.)
 */

export interface ModelRate {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /** Approximate context window (tokens). Used by auto-compact to know when to trigger. */
  contextWindow: number;
}

const ZERO: ModelRate = { input: 0, output: 0, contextWindow: 8_192 };

// Prefix match: model starts with key → use that rate.
// Order matters: longer / more specific prefixes first (e.g. claude-opus-4-7
// before claude-opus-4, since the 4.7 pricing differs from 4.x).
const PRICING_TABLE: Array<[string, ModelRate]> = [
  // DeepSeek
  ['deepseek-reasoner', { input: 0.55, output: 2.19, contextWindow: 65_536 }],
  ['deepseek-chat', { input: 0.27, output: 1.1, contextWindow: 65_536 }],

  // OpenAI
  ['gpt-4o-mini', { input: 0.15, output: 0.6, contextWindow: 128_000 }],
  ['gpt-4o', { input: 2.5, output: 10, contextWindow: 128_000 }],
  ['gpt-4-turbo', { input: 10, output: 30, contextWindow: 128_000 }],
  ['gpt-4', { input: 30, output: 60, contextWindow: 8_192 }],
  ['gpt-3.5', { input: 0.5, output: 1.5, contextWindow: 16_385 }],
  ['o3-mini', { input: 1.1, output: 4.4, contextWindow: 200_000 }],
  ['o1-mini', { input: 3, output: 12, contextWindow: 128_000 }],
  ['o1', { input: 15, output: 60, contextWindow: 200_000 }],

  // Anthropic (Claude). More specific prefixes FIRST.
  // Opus 4.7 (released 2026-04-16): $5/$25 per M tokens, per Anthropic pricing.
  ['claude-opus-4-7', { input: 5, output: 25, contextWindow: 200_000 }],
  ['claude-opus-4-6', { input: 5, output: 25, contextWindow: 200_000 }],
  ['claude-opus-4', { input: 15, output: 75, contextWindow: 200_000 }],
  ['claude-sonnet-4-7', { input: 3, output: 15, contextWindow: 200_000 }],
  ['claude-sonnet-4-5', { input: 3, output: 15, contextWindow: 200_000 }],
  ['claude-sonnet-4', { input: 3, output: 15, contextWindow: 200_000 }],
  ['claude-3-5-sonnet', { input: 3, output: 15, contextWindow: 200_000 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, contextWindow: 200_000 }],
  ['claude-3-opus', { input: 15, output: 75, contextWindow: 200_000 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25, contextWindow: 200_000 }],

  // Moonshot / Kimi
  // 2026 K2 series — 256K context; pricing from Moonshot's published rates.
  ['kimi-k2.5', { input: 0.55, output: 2.19, contextWindow: 256_000 }],
  ['kimi-k2-thinking', { input: 0.55, output: 2.19, contextWindow: 256_000 }],
  ['kimi-k2', { input: 0.55, output: 2.19, contextWindow: 256_000 }],
  // Legacy moonshot-v1
  ['moonshot-v1-128k', { input: 8.57, output: 8.57, contextWindow: 128_000 }],
  ['moonshot-v1-32k', { input: 3.43, output: 3.43, contextWindow: 32_000 }],
  ['moonshot-v1-8k', { input: 1.71, output: 1.71, contextWindow: 8_000 }],

  // Zhipu GLM (2026)
  ['glm-5.1', { input: 0.7, output: 2.1, contextWindow: 128_000 }],
  ['glm-5', { input: 0.7, output: 2.1, contextWindow: 128_000 }],
  ['glm-4.6', { input: 0.55, output: 1.65, contextWindow: 128_000 }],
  ['glm-4', { input: 0.55, output: 1.65, contextWindow: 128_000 }],

  // MiniMax M2 series (2026). Case preserved to match official model IDs.
  ['minimax-m2.7', { input: 0.3, output: 1.2, contextWindow: 192_000 }],
  ['minimax-m2.5', { input: 0.3, output: 1.2, contextWindow: 192_000 }],
  ['minimax-m2', { input: 0.3, output: 1.2, contextWindow: 192_000 }],

  // Groq (free tier-ish, roughly)
  ['llama-3.3-70b', { input: 0.59, output: 0.79, contextWindow: 128_000 }],
  ['llama-3.1-8b', { input: 0.05, output: 0.08, contextWindow: 128_000 }],

  // Ollama / local — free
  ['qwen', { input: 0, output: 0, contextWindow: 32_768 }],
  ['llama', { input: 0, output: 0, contextWindow: 8_192 }],
  ['mistral', { input: 0, output: 0, contextWindow: 8_192 }],
];

export function getModelRate(model: string): ModelRate {
  const m = model.toLowerCase();
  for (const [prefix, rate] of PRICING_TABLE) {
    if (m.startsWith(prefix)) return rate;
  }
  return ZERO;
}

/** Compute cost for a single usage record, in USD. */
export function computeCost(model: string, promptTokens: number, completionTokens: number): number {
  const r = getModelRate(model);
  return (promptTokens * r.input + completionTokens * r.output) / 1_000_000;
}

/** Format a USD amount suitable for a status bar. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format token count with k/M suffix. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
