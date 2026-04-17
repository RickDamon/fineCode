import type { Provider } from './Provider.js';
import type { Message, StreamEvent, ToolCall, ToolDefinition } from './types.js';
import type { PermissionManager, PermissionPrompt } from '../permission/PermissionManager.js';

export type AgentEvent =
  | { type: 'assistant_text'; delta: string; buffer: string }
  | { type: 'assistant_done'; message: Message }
  | { type: 'tool_start'; call: ToolCall; tool: ToolDefinition }
  | { type: 'tool_result'; call: ToolCall; tool: ToolDefinition; content: string; isError: boolean }
  | { type: 'tool_denied'; call: ToolCall; tool: ToolDefinition }
  | { type: 'turn_done' }
  | { type: 'error'; error: Error };

export interface AgentConfig {
  provider: Provider;
  tools: ToolDefinition[];
  permissionManager: PermissionManager;
  permissionPrompt: PermissionPrompt;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
}

/**
 * Agent — the core harness loop.
 *
 * Implements the "implicit agent" philosophy: no DAG, no chain, no plan.
 * We just loop: send messages → get response → if tool calls, execute them,
 * append results to history, loop again. The model decides what to do each turn.
 */
export class Agent {
  private config: AgentConfig;
  private history: Message[] = [];
  private toolMap: Map<string, ToolDefinition>;

  constructor(config: AgentConfig) {
    this.config = config;
    this.toolMap = new Map(config.tools.map(t => [t.name, t]));
  }

  /** Run one user turn to completion. Yields events as they happen. */
  async *run(userInput: string, abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    this.history.push({ role: 'user', content: userInput });
    const maxTurns = this.config.maxTurns ?? 50;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortSignal.aborted) {
        yield { type: 'error', error: new Error('Aborted by user') };
        return;
      }

      // Stream this turn's assistant response, yielding text events live
      let textBuffer = '';
      const toolCallsByIndex: { id: string; name: string; args: string }[] = [];
      const toolIdToIndex = new Map<string, number>();
      let errored: Error | null = null;

      const stream = this.config.provider.stream({
        messages: this.history,
        tools: this.config.tools,
        systemPrompt: this.config.systemPrompt,
        abortSignal,
      });

      for await (const event of stream) {
        if (event.type === 'text') {
          textBuffer += event.delta;
          yield { type: 'assistant_text', delta: event.delta, buffer: textBuffer };
        } else if (event.type === 'tool_call_start') {
          const idx = toolCallsByIndex.length;
          toolCallsByIndex.push({ id: event.id, name: event.name, args: '' });
          toolIdToIndex.set(event.id, idx);
        } else if (event.type === 'tool_call_delta') {
          const idx = toolIdToIndex.get(event.id);
          if (idx !== undefined) toolCallsByIndex[idx]!.args += event.argumentsDelta;
        } else if (event.type === 'error') {
          errored = event.error;
          break;
        } else if (event.type === 'done') {
          break;
        }
      }

      if (errored) {
        yield { type: 'error', error: errored };
        return;
      }

      const toolCalls: ToolCall[] = toolCallsByIndex.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.args || '{}',
      }));

      const assistantMsg: Message = {
        role: 'assistant',
        content: textBuffer || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      this.history.push(assistantMsg);
      yield { type: 'assistant_done', message: assistantMsg };

      // No tool calls → turn is done
      if (toolCalls.length === 0) {
        yield { type: 'turn_done' };
        return;
      }

      // Execute tool calls in order, feeding results into history
      for (const tc of toolCalls) {
        yield* this.executeTool(tc, abortSignal);
      }
      // Loop: model sees tool results, may emit more tool calls or finish
    }

    yield { type: 'error', error: new Error(`Max turns (${maxTurns}) exceeded`) };
  }

  private async *executeTool(
    call: ToolCall,
    abortSignal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      const msg = `Error: tool "${call.name}" is not available`;
      this.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: msg });
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      const msg = `Error: invalid JSON arguments: ${call.arguments}`;
      this.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: msg });
      return;
    }

    const decision = await this.config.permissionManager.request(
      tool,
      input,
      this.config.permissionPrompt,
    );
    if (decision === 'deny') {
      yield { type: 'tool_denied', call, tool };
      this.history.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: 'User denied permission. Do not retry. Ask the user what to do instead.',
      });
      return;
    }

    yield { type: 'tool_start', call, tool };
    try {
      const result = await tool.execute(input, { cwd: this.config.cwd, abortSignal });
      yield {
        type: 'tool_result',
        call,
        tool,
        content: result.content,
        isError: !!result.isError,
      };
      this.history.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      });
    } catch (err) {
      const msg = (err as Error).message;
      yield { type: 'tool_result', call, tool, content: msg, isError: true };
      this.history.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Error: ${msg}`,
      });
    }
  }

  getHistory(): Message[] {
    return [...this.history];
  }
}
