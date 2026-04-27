/**
 * SpawnAgentTool — let the parent agent delegate a task to a fresh subagent.
 *
 * Design goals:
 *   - Keep the parent's context lean: subagent does many tool calls, only its
 *     final text is fed back to the parent as tool_result.
 *   - Let the user mix models: research with deepseek-chat, edit with claude,
 *     review with gpt-4o. All via the same interface.
 *   - Safe by default: subagents use a tool whitelist, not the full tool set.
 *
 * Concurrency:
 *   Declared as `needsPermission: 'never'` so multiple subagent calls in the
 *   same turn are auto-parallelized by the Agent's partitioner.
 *   (Note: 'never' here is a semantic overload meaning "concurrency-safe";
 *   subagents internally still request permission for their own tools.)
 */

import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../core/types.js';
import { Agent, type AgentEvent } from '../core/Agent.js';
import { PermissionManager } from '../permission/PermissionManager.js';
import { createProvider, PRESETS } from '../providers/factory.js';
import { readConfig, inferApiKeyFromEnv } from '../config/Config.js';

export interface SubagentPreset {
  /** Model override; falls back to the parent's current model. */
  model?: string;
  /** System prompt specific to this subagent. Prefixed with the parent's cwd / env info. */
  systemPrompt?: string;
  /** Tool whitelist. Only tool names in this list are exposed to the subagent. */
  allow?: string[];
  /** Human-readable description shown in /help. */
  description?: string;
  /** Cap on agent-loop turns. Default 20 (vs. parent's 50). */
  maxTurns?: number;
}

/**
 * Bag of things a subagent needs, inherited from the parent. We don't pass the
 * parent Agent itself because that would risk shared-state bugs.
 */
export interface SpawnContext {
  parentTools: ToolDefinition[];
  parentModel: string;
  cwd: string;
  /** The parent's system prompt — we prefix it so the subagent has the same env context. */
  parentSystemPrompt: string;
  /** Nesting depth (parent is 0, its subagent is 1, etc). Used for safety cap. */
  depth: number;
}

const MAX_NESTING_DEPTH = 3;

interface SpawnInput {
  agent_type?: string;
  prompt: string;
  model?: string;
  allow?: string[];
}

export function createSpawnAgentTool(ctx: SpawnContext): ToolDefinition<SpawnInput> {
  const cfg = readConfig();
  const presets = cfg.subagents ?? {};
  const presetNames = Object.keys(presets);

  const description = [
    'Delegate a self-contained task to a fresh subagent. The subagent runs its own agent loop,',
    'calls its own tools, and returns only its final text as the tool result — keeping the',
    "parent's context lean.",
    '',
    'When to use:',
    '- Research tasks that will read/grep many files (parent only needs the conclusion).',
    '- Reviewing your own work with a fresh perspective.',
    '- Running parallel investigations (call this tool multiple times in one turn).',
    '',
    presetNames.length > 0
      ? `Available agent types: ${presetNames.join(', ')}`
      : '(No agent presets configured; pass `prompt` only to use the default research profile.)',
  ].join('\n');

  return {
    name: 'spawn_agent',
    description,
    parameters: {
      type: 'object',
      properties: {
        agent_type: {
          type: 'string',
          description:
            presetNames.length > 0
              ? `Preset from config.subagents: ${presetNames.join(', ')}. Omit to use the default.`
              : 'Preset name (none configured).',
        },
        prompt: {
          type: 'string',
          description: 'The task description for the subagent. Be specific about what to return.',
        },
        model: {
          type: 'string',
          description: 'Override model for this call (e.g. "gpt-4o-mini", "deepseek-chat").',
        },
        allow: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override the tool whitelist (tool names). Defaults to read-only tools.',
        },
      },
      required: ['prompt'],
    },
    needsPermission: 'never',
    renderCall: input =>
      `spawn ${input.agent_type ?? 'default'}${input.model ? ` @${input.model}` : ''}: ${input.prompt.slice(0, 60)}${input.prompt.length > 60 ? '…' : ''}`,
    execute: async (input, execCtx) => runSubagent(input, ctx, execCtx, presets),
  };
}

const DEFAULT_SUBAGENT_ALLOW = ['read_file', 'grep', 'glob', 'ls', 'todo_write'];

async function runSubagent(
  input: SpawnInput,
  spawnCtx: SpawnContext,
  execCtx: ToolExecutionContext,
  presets: Record<string, SubagentPreset>,
): Promise<ToolResult> {
  if (spawnCtx.depth >= MAX_NESTING_DEPTH) {
    return {
      content: `Subagent nesting too deep (max ${MAX_NESTING_DEPTH}). Collapse tasks or return to the parent.`,
      isError: true,
    };
  }

  const preset = input.agent_type ? presets[input.agent_type] : undefined;
  if (input.agent_type && !preset) {
    return {
      content: `Unknown agent_type: "${input.agent_type}". Available: ${Object.keys(presets).join(', ') || '(none configured)'}`,
      isError: true,
    };
  }

  const model = input.model ?? preset?.model ?? spawnCtx.parentModel;
  const allow = input.allow ?? preset?.allow ?? DEFAULT_SUBAGENT_ALLOW;
  const subName = input.agent_type ?? 'default';

  const toolMap = new Map(spawnCtx.parentTools.map(t => [t.name, t]));
  const subTools: ToolDefinition[] = [];
  for (const name of allow) {
    const t = toolMap.get(name);
    if (t) subTools.push(t);
  }
  // Let subagents nest further, within depth cap.
  subTools.push(
    createSpawnAgentTool({
      ...spawnCtx,
      depth: spawnCtx.depth + 1,
      parentTools: spawnCtx.parentTools,
      parentModel: model,
    }),
  );

  const cfg = readConfig();
  const baseUrl = cfg.baseUrl ?? (cfg.preset ? PRESETS[cfg.preset]?.baseUrl : undefined);
  const apiKey =
    cfg.apiKey ??
    inferApiKeyFromEnv(model, cfg.provider, cfg.preset) ??
    (cfg.preset === 'ollama' || cfg.provider === 'ollama' ? 'ollama' : undefined);
  const provider = createProvider({ model, apiKey, baseUrl, provider: cfg.provider });

  const baseSystemPrompt = [
    `You are a subagent named "${subName}".`,
    `Your job is to complete the task below and return a CONCISE final answer — only the answer, not the process.`,
    `Do NOT spawn further subagents unless the task explicitly requires it.`,
    preset?.systemPrompt ?? 'Keep responses focused. Use tools when needed. Be brief.',
    '',
    '# Inherited environment',
    spawnCtx.parentSystemPrompt.split('# Environment')[1]?.split('# User rules')[0]?.trim() ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  const agent = new Agent({
    provider,
    tools: subTools,
    permissionManager: new PermissionManager({ bypass: false }),
    // Bubble permission requests up to the parent's prompt when we have one.
    // This lets subagents configured with write-capable tools (e.g. a
    // 'hard-debug' preset with edit_file + bash) actually work — previously
    // they would auto-deny the first permission check and die. Falls back to
    // deny when no parent prompt exists (e.g. running standalone).
    permissionPrompt: execCtx.parentPermissionPrompt ?? (async () => 'deny'),
    systemPrompt: baseSystemPrompt,
    cwd: spawnCtx.cwd,
    maxTurns: preset?.maxTurns ?? 20,
  });

  // Forward every event up to the parent via the execution context's forwardEvent.
  let finalText = '';
  let hadError = false;
  try {
    for await (const ev of agent.run(input.prompt, execCtx.abortSignal)) {
      if (execCtx.forwardEvent) {
        const wrapped: AgentEvent = {
          type: 'subagent_event',
          agentName: subName,
          depth: spawnCtx.depth + 1,
          event: ev,
        };
        execCtx.forwardEvent(wrapped);
      }

      if (ev.type === 'assistant_text') finalText = ev.buffer;
      else if (ev.type === 'error') {
        hadError = true;
        finalText = `Subagent error: ${ev.error.message}`;
      }
    }
  } catch (e) {
    return { content: `Subagent crashed: ${(e as Error).message}`, isError: true };
  }

  const summary = finalText.trim() || '(subagent returned no text)';
  return {
    content: `[subagent:${subName}] ${summary}`,
    isError: hadError,
  };
}
