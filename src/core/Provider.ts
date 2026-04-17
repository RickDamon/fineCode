import type { QueryOptions, StreamEvent } from './types.js';

/**
 * Provider abstraction — all model backends implement this interface.
 *
 * The Agent only talks to Provider; it has no idea whether the underlying
 * model is GPT-4, Claude, Qwen, or a local Ollama model. This is the
 * core of the "harness" philosophy: swap the brain, keep the body.
 */
export interface Provider {
  /** Display name, e.g., "openai:gpt-4o" or "anthropic:claude-sonnet-4-5" */
  readonly name: string;

  /** The model identifier sent to the API */
  readonly model: string;

  /**
   * Stream a query to the model. Must yield StreamEvents as they arrive.
   * Implementations are responsible for:
   *   - Converting our canonical Message[] to their API format
   *   - Converting tool definitions to their API format
   *   - Parsing streaming responses into our canonical StreamEvent format
   *   - Handling abort signals
   */
  stream(options: QueryOptions): AsyncGenerator<StreamEvent, void, unknown>;
}

export interface ProviderConfig {
  /** Model identifier, e.g., "gpt-4o", "claude-sonnet-4-5", "qwen2.5-coder" */
  model: string;
  /** API key, if applicable */
  apiKey?: string;
  /** Base URL override — useful for OpenAI-compatible endpoints */
  baseUrl?: string;
  /** Provider type: inferred from model name if not set */
  provider?: 'openai' | 'anthropic' | 'ollama';
}
