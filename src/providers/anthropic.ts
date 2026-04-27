import type { Provider, ProviderConfig } from '../core/Provider.js';
import type { Message, QueryOptions, StreamEvent, ToolDefinition } from '../core/types.js';
import { wrapHttpError, wrapGenericError } from '../core/ProviderError.js';

/**
 * Anthropic Claude provider — direct API, not via @anthropic-ai/sdk.
 * Uses raw fetch to keep the codebase lean and avoid SDK lock-in.
 *
 * Converts our canonical (OpenAI-style) format to Anthropic's content-block format.
 */
export class AnthropicProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.name = `anthropic:${config.model}`;
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  async *stream(options: QueryOptions): AsyncGenerator<StreamEvent, void, unknown> {
    const { messages, tools } = this.toAnthropicFormat(options.messages, options.tools);

    // ── Prompt caching (Anthropic ephemeral cache) ──
    // Anthropic charges 10% of input cost on cache hits. Long coding sessions
    // resend identical system prompts + tool schemas every turn — caching them
    // cuts real spend by ~50% for users on Claude.
    //
    // We split the system prompt at the first "# Environment" header (if any).
    // Everything above it is considered static (core prompt, FINE.md, skills),
    // gets cache_control. Everything from "# Environment" onward contains
    // wall-clock / git branch / cwd listing which drift every run, so we leave
    // it uncached to preserve the cache prefix for the static half.
    const systemBlocks = splitSystemForCache(options.systemPrompt);

    // Tools rarely change within a session. We mark the LAST tool with
    // cache_control so everything up to and including it becomes a cache
    // breakpoint (per Anthropic's cache rules: a cache_control marker caches
    // the entire prefix up to that position).
    const cachedTools = tools && tools.length > 0
      ? tools.map((t, i) =>
          i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
        )
      : tools;

    const body = {
      model: this.model,
      messages,
      system: systemBlocks,
      tools: cachedTools,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      stream: true,
    };

    try {
      const resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });

      if (!resp.ok || !resp.body) {
        const errorCtx = {
          providerLabel: 'anthropic',
          model: this.model,
          baseUrl: this.baseUrl,
        };
        yield { type: 'error', error: await wrapHttpError(resp, errorCtx) };
        return;
      }

      yield* this.parseSSE(resp.body);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      yield {
        type: 'error',
        error: wrapGenericError(err, {
          providerLabel: 'anthropic',
          model: this.model,
          baseUrl: this.baseUrl,
        }),
      };
    }
  }

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Map block index -> tool call state
    const toolBlocks = new Map<number, { id: string; name: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Accept both \n and \r\n line separators. Cloudflare / some proxies
      // insert \r before \n; splitting on \n alone would leave a trailing
      // \r on every data: line which then fails JSON.parse silently.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            toolBlocks.set(event.index, { id: block.id, name: block.name });
            yield { type: 'tool_call_start', id: block.id, name: block.name };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text', delta: delta.text };
          } else if (delta.type === 'input_json_delta') {
            const tb = toolBlocks.get(event.index);
            if (tb) {
              yield { type: 'tool_call_delta', id: tb.id, argumentsDelta: delta.partial_json };
            }
          }
        } else if (event.type === 'content_block_stop') {
          const tb = toolBlocks.get(event.index);
          if (tb) yield { type: 'tool_call_end', id: tb.id };
        } else if (event.type === 'message_delta') {
          const stop = event.delta?.stop_reason;
          if (stop) {
            yield {
              type: 'done',
              finishReason: stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop',
              usage: event.usage
                ? {
                    promptTokens: event.usage.input_tokens ?? 0,
                    completionTokens: event.usage.output_tokens ?? 0,
                    totalTokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
                  }
                : undefined,
            };
          }
        }
      }
    }
  }

  private toAnthropicFormat(messages: Message[], tools?: ToolDefinition[]) {
    const apiMessages: any[] = [];
    // Anthropic requires grouping: assistant messages with tool_use, then user messages with tool_result
    for (const msg of messages) {
      if (msg.role === 'user') {
        apiMessages.push({ role: 'user', content: msg.content ?? '' });
      } else if (msg.role === 'assistant') {
        const content: any[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: safeParse(tc.arguments),
            });
          }
        }
        apiMessages.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        // Merge consecutive tool results into a single user message
        const last = apiMessages[apiMessages.length - 1];
        const block = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content ?? '',
        };
        if (last && last.role === 'user' && Array.isArray(last.content)) {
          last.content.push(block);
        } else {
          apiMessages.push({ role: 'user', content: [block] });
        }
      }
    }

    const apiTools = tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    return { messages: apiMessages, tools: apiTools };
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Cut the system prompt into two content blocks for Anthropic:
 *   [ { static, cache_control }, { dynamic } ]
 *
 * The static half is everything before the first `# Environment` (or
 * `## Environment`) heading — that's where buildSystemPrompt() injects
 * per-run state (cwd, git branch, current date). Caching the static prefix
 * yields a ~90% input-token discount on cache hits; the dynamic tail stays
 * cheap because it's short anyway.
 *
 * If no `# Environment` marker is present we cache the whole thing as one
 * block — safe, just slightly less efficient on re-runs that change (none of
 * our callers currently skip the marker, but be defensive).
 */
function splitSystemForCache(
  systemPrompt: string,
): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> {
  const marker = systemPrompt.search(/^#{1,2}\s*Environment\b/m);
  if (marker < 0) {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
  const staticPart = systemPrompt.slice(0, marker).trimEnd();
  const dynamicPart = systemPrompt.slice(marker);
  // Anthropic requires every block to be non-empty.
  if (!staticPart) {
    return [{ type: 'text', text: dynamicPart }];
  }
  return [
    { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicPart },
  ];
}
