import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import type { Provider, ProviderConfig } from '../core/Provider.js';

/**
 * Factory: auto-detect provider from model name or explicit config.
 *
 * Detection rules:
 *   - model starts with "claude-" → Anthropic
 *   - model starts with "gpt-" / "o1" / "o3" → OpenAI
 *   - baseUrl points to localhost:11434 → Ollama (uses OpenAI-compat endpoint)
 *   - anything else with baseUrl → OpenAI-compatible
 *   - anything else → OpenAI
 *
 * Explicit config.provider always wins.
 */
export function createProvider(config: ProviderConfig): Provider {
  const explicit = config.provider;
  if (explicit === 'anthropic') return new AnthropicProvider(config);
  if (explicit === 'openai' || explicit === 'ollama') {
    return new OpenAIProvider(applyOllamaDefaults(config));
  }

  // Auto-detect
  const model = config.model.toLowerCase();
  if (model.startsWith('claude-')) {
    return new AnthropicProvider(config);
  }
  return new OpenAIProvider(applyOllamaDefaults(config));
}

function applyOllamaDefaults(config: ProviderConfig): ProviderConfig {
  if (config.provider === 'ollama' && !config.baseUrl) {
    return { ...config, baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' };
  }
  return config;
}

/** Common preset base URLs for convenience. */
export const PRESETS: Record<string, Partial<ProviderConfig>> = {
  openai: { baseUrl: undefined },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1' },
  together: { baseUrl: 'https://api.together.xyz/v1' },
  ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
};
