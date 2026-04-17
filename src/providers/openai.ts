import OpenAI from 'openai';
import type { Provider, ProviderConfig } from '../core/Provider.js';
import type {
  FinishReason,
  Message,
  QueryOptions,
  StreamEvent,
  ToolDefinition,
} from '../core/types.js';
import { wrapOpenAIError } from '../core/ProviderError.js';

/**
 * OpenAI-compatible provider.
 * Supports: OpenAI, Azure OpenAI, OpenRouter, DeepSeek, Moonshot, vLLM, LM Studio,
 * LocalAI, Together AI, Groq, Fireworks, and any OpenAI-API-compatible endpoint.
 */
export class OpenAIProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;
  private baseUrl?: string;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.name = `openai:${config.model}`;
    this.baseUrl = config.baseUrl;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'no-key-required',
      baseURL: config.baseUrl,
    });
  }

  async *stream(options: QueryOptions): AsyncGenerator<StreamEvent, void, unknown> {
    const apiMessages = this.toApiMessages(options.systemPrompt, options.messages);
    const apiTools = options.tools ? this.toApiTools(options.tools) : undefined;

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: apiMessages,
          tools: apiTools,
          tool_choice: apiTools ? 'auto' : undefined,
          stream: true,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens,
        },
        { signal: options.abortSignal },
      );

      // Tracks accumulated tool call state per index, since OpenAI streams
      // tool calls as partial deltas indexed by position (not by id).
      const toolCallState = new Map<number, { id: string; name: string }>();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;

        if (delta.content) {
          yield { type: 'text', delta: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let state = toolCallState.get(idx);

            // First chunk for this index usually contains id + name
            if (!state && tc.id && tc.function?.name) {
              state = { id: tc.id, name: tc.function.name };
              toolCallState.set(idx, state);
              yield { type: 'tool_call_start', id: tc.id, name: tc.function.name };
            }
            if (!state) continue;

            if (tc.function?.arguments) {
              yield {
                type: 'tool_call_delta',
                id: state.id,
                argumentsDelta: tc.function.arguments,
              };
            }
          }
        }

        if (choice.finish_reason) {
          for (const state of toolCallState.values()) {
            yield { type: 'tool_call_end', id: state.id };
          }
          yield {
            type: 'done',
            finishReason: this.mapFinishReason(choice.finish_reason),
            usage: chunk.usage
              ? {
                  promptTokens: chunk.usage.prompt_tokens,
                  completionTokens: chunk.usage.completion_tokens,
                  totalTokens: chunk.usage.total_tokens,
                }
              : undefined,
          };
          return;
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      yield {
        type: 'error',
        error: wrapOpenAIError(err, {
          providerLabel: 'openai',
          model: this.model,
          baseUrl: this.baseUrl,
        }),
      };
    }
  }

  private toApiMessages(
    systemPrompt: string,
    messages: Message[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const apiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === 'user') {
        apiMessages.push({ role: 'user', content: msg.content ?? '' });
      } else if (msg.role === 'assistant') {
        const m: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: msg.content,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          m.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        apiMessages.push(m);
      } else if (msg.role === 'tool') {
        apiMessages.push({
          role: 'tool',
          tool_call_id: msg.toolCallId!,
          content: msg.content ?? '',
        });
      }
    }

    return apiMessages;
  }

  private toApiTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private mapFinishReason(r: string): FinishReason {
    if (r === 'tool_calls' || r === 'function_call') return 'tool_calls';
    if (r === 'length') return 'length';
    if (r === 'stop') return 'stop';
    return 'error';
  }
}
