import type { Provider } from './Provider.js';
import type { Message, ToolCall, ToolDefinition, ToolExecutionContext, ToolResult, Usage } from './types.js';
import type { PermissionManager, PermissionPrompt } from '../permission/PermissionManager.js';
import type { Session } from '../session/Session.js';
import { computeCost } from '../constants/pricing.js';
import { microCompact } from '../commands/microCompact.js';

export type AgentEvent =
  | { type: 'assistant_text'; delta: string; buffer: string }
  | { type: 'assistant_done'; message: Message }
  | { type: 'tool_start'; call: ToolCall; tool: ToolDefinition }
  | { type: 'tool_result'; call: ToolCall; tool: ToolDefinition; content: string; isError: boolean }
  | { type: 'tool_denied'; call: ToolCall; tool: ToolDefinition }
  | { type: 'turn_done' }
  | { type: 'usage'; usage: Usage; model: string; cost: number; cumulativeCost: number }
  | { type: 'compacted'; droppedMessages: number; summary: string }
  | { type: 'info'; text: string }
  | { type: 'subagent_event'; agentName: string; depth: number; event: AgentEvent }
  | { type: 'error'; error: Error };

export interface AgentConfig {
  provider: Provider;
  tools: ToolDefinition[];
  permissionManager: PermissionManager;
  permissionPrompt: PermissionPrompt;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
  /** Optional session for persistence, cost tracking, snapshots. */
  session?: Session;
  /** Messages to pre-populate (used on resume). */
  initialHistory?: Message[];
  /** Max parallel read-only tool calls per partition. Default 10. */
  maxParallelTools?: number;
}

/**
 * Agent — the core harness loop.
 *
 * Implements the "implicit agent" philosophy: no DAG, no chain, no plan.
 * Loop: send messages → receive stream → execute any tool calls → loop.
 *
 * Features layered on top:
 *   - Session persistence (opt-in via config.session)
 *   - Token/cost accounting (via AgentEvent: 'usage')
 *   - Concurrent read-only tool execution (tools with needsPermission='never')
 *   - Host-triggered context compaction (see compactWithSummary)
 */
export class Agent {
  private config: AgentConfig;
  private history: Message[];
  private toolMap: Map<string, ToolDefinition>;
  private provider: Provider;
  private cumulativeCost = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = config.provider;
    this.history = [...(config.initialHistory ?? [])];
    this.toolMap = new Map(config.tools.map(t => [t.name, t]));

    // If we have a session + initial history, seed the totals so /cost is accurate.
    const meta = config.session?.getMeta();
    if (meta) {
      this.cumulativeCost = meta.totalCost;
      this.totalPromptTokens = meta.totalPromptTokens;
      this.totalCompletionTokens = meta.totalCompletionTokens;
    }
  }

  /** Hot-swap the provider (used by /model command). */
  setProvider(provider: Provider): void {
    this.provider = provider;
    this.config.provider = provider;
  }

  /** Register an additional tool at runtime (used by MCP client after discovery). */
  registerTool(tool: ToolDefinition): void {
    this.toolMap.set(tool.name, tool);
    // Keep config.tools in sync so the provider sees the tool on the NEXT turn.
    this.config.tools = [...this.config.tools, tool];
  }

  /** Replace the system prompt for the next turn onwards (used by /mode). */
  setSystemPrompt(systemPrompt: string): void {
    this.config.systemPrompt = systemPrompt;
  }

  getSystemPrompt(): string {
    return this.config.systemPrompt;
  }

  /** Erase in-memory history. Does NOT touch the persisted session log —
   *  callers that want a fresh session must create a new Session object. */
  clearHistory(): void {
    this.history = [];
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  getCostSummary(): {
    cumulativeCost: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } {
    return {
      cumulativeCost: this.cumulativeCost,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
    };
  }

  /**
   * Replace old history with a summary placeholder + tail.
   * Called by the host (REPL) when auto-compact decides to fire.
   * Returns the number of original messages that were dropped.
   */
  compactWithSummary(summary: string, keepTail: number): number {
    const dropped = Math.max(0, this.history.length - keepTail);
    if (dropped === 0) return 0;
    const tail = this.history.slice(-keepTail);
    this.history = [
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      ...tail,
    ];
    this.config.session?.recordCompact(dropped, summary);
    return dropped;
  }

  /** Run one user turn to completion. Yields events as they happen. */
  async *run(userInput: string, abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    const userMsg: Message = { role: 'user', content: userInput };
    this.history.push(userMsg);
    this.config.session?.recordMessage(userMsg);

    const maxTurns = this.config.maxTurns ?? 50;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (abortSignal.aborted) {
        yield { type: 'error', error: new Error('Aborted by user') };
        return;
      }

      let textBuffer = '';
      const toolCallsByIndex: { id: string; name: string; args: string }[] = [];
      const toolIdToIndex = new Map<string, number>();
      let errored: Error | null = null;
      let turnUsage: Usage | undefined;

      const stream = this.provider.stream({
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
          turnUsage = event.usage;
          break;
        }
      }

      if (errored) {
        yield { type: 'error', error: errored };
        return;
      }

      // Record usage + cost.
      if (turnUsage) {
        const cost = computeCost(this.provider.model, turnUsage.promptTokens, turnUsage.completionTokens);
        this.cumulativeCost += cost;
        this.totalPromptTokens += turnUsage.promptTokens;
        this.totalCompletionTokens += turnUsage.completionTokens;
        this.config.session?.recordUsage(turnUsage, this.provider.model, cost);
        yield {
          type: 'usage',
          usage: turnUsage,
          model: this.provider.model,
          cost,
          cumulativeCost: this.cumulativeCost,
        };
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
      this.config.session?.recordMessage(assistantMsg);
      yield { type: 'assistant_done', message: assistantMsg };

      if (toolCalls.length === 0) {
        yield { type: 'turn_done' };
        return;
      }

      // Partition into concurrent-safe groups and execute.
      const partitions = partitionToolCalls(toolCalls, this.toolMap);
      for (const partition of partitions) {
        yield* this.executePartition(partition, abortSignal);
      }
      // loop
    }

    yield { type: 'error', error: new Error(`Max turns (${maxTurns}) exceeded`) };
  }

  /**
   * Execute a group of tool calls. If all are read-only (needsPermission='never')
   * they run concurrently; otherwise we fall back to serial execution.
   */
  private async *executePartition(
    calls: ToolCall[],
    abortSignal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    if (calls.length === 0) return;

    // Single call → serial path (covers the write case and the trivial read case).
    if (calls.length === 1) {
      yield* this.executeTool(calls[0]!, abortSignal);
      return;
    }

    // Concurrent path — run up to maxParallelTools at a time, collect events in
    // completion order but surface them as they arrive.
    const maxPar = this.config.maxParallelTools ?? 10;
    const queues: AgentEvent[][] = calls.map(() => []);
    const done: boolean[] = calls.map(() => false);

    // Start each tool's generator; each one drains into its own queue.
    const runners = calls.map(async (call, i) => {
      for await (const ev of this.executeTool(call, abortSignal)) {
        queues[i]!.push(ev);
      }
      done[i] = true;
    });

    // Rate-limit: only maxPar active at a time. For simplicity, just start them
    // all (maxPar is usually >= typical fan-out). If callers truly need strict
    // limiting we can switch to a p-limit style pool later.
    void maxPar;

    // Drain loop: flush any queued events, yield; poll until all done.
    while (done.some(d => !d) || queues.some(q => q.length > 0)) {
      let emitted = false;
      for (let i = 0; i < queues.length; i++) {
        const q = queues[i]!;
        while (q.length > 0) {
          yield q.shift()!;
          emitted = true;
        }
      }
      if (!emitted) {
        // Wait a tick for runners to make progress.
        await new Promise(r => setImmediate(r));
      }
    }

    await Promise.all(runners);
  }

  private async *executeTool(
    call: ToolCall,
    abortSignal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      const msg = `Error: tool "${call.name}" is not available`;
      const toolMsg: Message = { role: 'tool', toolCallId: call.id, name: call.name, content: msg };
      this.history.push(toolMsg);
      this.config.session?.recordMessage(toolMsg);
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      const msg = `Error: invalid JSON arguments: ${call.arguments}`;
      const toolMsg: Message = { role: 'tool', toolCallId: call.id, name: call.name, content: msg };
      this.history.push(toolMsg);
      this.config.session?.recordMessage(toolMsg);
      return;
    }

    const decision = await this.config.permissionManager.request(
      tool,
      input,
      this.config.permissionPrompt,
    );
    if (decision === 'deny') {
      yield { type: 'tool_denied', call, tool };
      const denyMsg: Message = {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: 'User denied permission. Do not retry. Ask the user what to do instead.',
      };
      this.history.push(denyMsg);
      this.config.session?.recordMessage(denyMsg);
      return;
    }

    yield { type: 'tool_start', call, tool };

    // Event forwarder: tools that spawn agents (SpawnAgentTool) can push events
    // here to stream sub-activity up to the parent UI. We collect them in a
    // queue and flush interleaved with the await.
    const forwardQueue: AgentEvent[] = [];
    const forwardEvent = (ev: unknown) => {
      forwardQueue.push(ev as AgentEvent);
    };

    try {
      const ctx: ToolExecutionContext = {
        cwd: this.config.cwd,
        abortSignal,
        session: this.config.session,
        toolCallId: call.id,
        forwardEvent,
      };
      const execPromise = tool.execute(input, ctx);

      // Interleave: while waiting on execute, pump any forwarded events so the
      // user sees subagent progress as it happens instead of a big burst at the end.
      let settled = false;
      let result: ToolResult | undefined;
      let execError: unknown;
      execPromise
        .then(r => {
          result = r;
          settled = true;
        })
        .catch(e => {
          execError = e;
          settled = true;
        });

      while (!settled) {
        while (forwardQueue.length > 0) yield forwardQueue.shift()!;
        await new Promise(r => setImmediate(r));
      }
      // Drain any final events before reporting the result.
      while (forwardQueue.length > 0) yield forwardQueue.shift()!;

      if (execError) throw execError;
      const r = result!;

      // Micro-compact BEFORE the result hits history. The UI still sees the
      // full content via the event (so folding in the REPL is user-visible),
      // but the model's context gets the compacted version.
      const { content: historyContent, compacted, originalBytes } = microCompact(
        r.content,
        tool.name,
      );

      yield {
        type: 'tool_result',
        call,
        tool,
        content: r.content,
        isError: !!r.isError,
      };
      if (compacted) {
        yield {
          type: 'info',
          text: `↳ micro-compacted ${tool.name} result: ${originalBytes} → ${historyContent.length} bytes`,
        };
      }
      const toolMsg: Message = {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: historyContent,
      };
      this.history.push(toolMsg);
      this.config.session?.recordMessage(toolMsg);
    } catch (err) {
      // Drain any leftover forwarded events even on failure.
      while (forwardQueue.length > 0) yield forwardQueue.shift()!;
      const msg = (err as Error).message;
      yield { type: 'tool_result', call, tool, content: msg, isError: true };
      const toolMsg: Message = {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Error: ${msg}`,
      };
      this.history.push(toolMsg);
      this.config.session?.recordMessage(toolMsg);
    }
  }
}

/**
 * Partition a list of tool calls into serial groups where consecutive read-only
 * calls are bundled together (to be run in parallel), and any non-read-only
 * call is a group of its own (to be run serially).
 *
 * Read-only is proxied by `needsPermission === 'never'`, which is how our tools
 * already declare side-effect freedom (FileReadTool, GrepTool, GlobTool, LsTool,
 * TodoTool). BashTool / FileWriteTool / FileEditTool are 'always' and thus
 * always serial.
 */
export function partitionToolCalls(
  calls: ToolCall[],
  toolMap: Map<string, ToolDefinition>,
): ToolCall[][] {
  const out: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentIsReadOnly: boolean | null = null;

  const isReadOnly = (c: ToolCall): boolean => {
    const t = toolMap.get(c.name);
    return !!t && t.needsPermission === 'never';
  };

  for (const call of calls) {
    const ro = isReadOnly(call);
    if (current.length === 0) {
      current.push(call);
      currentIsReadOnly = ro;
      continue;
    }
    // Keep grouping only if both ro and same parity; write calls never group.
    if (ro && currentIsReadOnly) {
      current.push(call);
    } else {
      out.push(current);
      current = [call];
      currentIsReadOnly = ro;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}
