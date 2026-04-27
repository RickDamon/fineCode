/**
 * Context compaction.
 *
 * When the conversation grows close to the model's context window, we ask the
 * SAME model to summarize the older portion of the history, then replace those
 * messages with a single "summary" user message. Recent messages are kept verbatim
 * so tool-call continuity and immediate context are preserved.
 *
 * Strategy:
 *   - Keep the last KEEP_TAIL messages untouched (so tool_use/tool_result pairs
 *     near the tip don't get separated).
 *   - Summarize everything before that via a one-shot API call.
 *   - The summary prompt is deliberately "structure-oriented": what did the user
 *     ask, what did we do, what decisions were made, what files were touched.
 *
 * We do not use this project's Agent here — we call the provider directly with a
 * minimal prompt, because compaction should NOT consume tools or trigger another
 * agent loop.
 */

import type { Message } from '../core/types.js';
import { createProvider, PRESETS } from '../providers/factory.js';
import { readConfig, inferApiKeyFromEnv } from '../config/Config.js';
import { getModelRate } from '../constants/pricing.js';

export const KEEP_TAIL_DEFAULT = 6;

/**
 * Max consecutive auto-compact failures before we stop trying.
 *
 * Anecdote from Claude Code's own telemetry (quoted in BQ 2026-03 session
 * review): "1,279 sessions had 50+ consecutive failures before we added the
 * cap." We pick a conservative 3 — fail twice and the third time we give up
 * until a successful manual /compact resets the counter.
 */
export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

/** Auto-compact trigger: returns true if cumulative usage crosses 70% of the window
 *  AND the circuit breaker hasn't tripped. */
export function shouldAutoCompact(
  model: string,
  usedTokens: number,
  consecutiveFailures: number = 0,
  override?: number,
): boolean {
  if (consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) return false;
  const window = override ?? getModelRate(model).contextWindow;
  if (!window) return false;
  return usedTokens > window * 0.7;
}

const SUMMARY_SYSTEM = `You are a compaction assistant. You will receive a transcript of a coding session between a user and an AI coding assistant. Summarize it so the assistant can continue the work with a much shorter context.

Your summary MUST preserve, in order of priority:
1. The user's goals and outstanding requests.
2. Decisions already made (choice of libraries, file layout, naming, etc).
3. Files that were read, created, or edited — with absolute paths.
4. Commands that were run and their effect (success/failure).
5. Any errors or warnings that have NOT yet been resolved.

Be specific. Use short bullet points. Omit filler. DO NOT invent information.`;

/** Render a message into plain text suitable for inclusion in a summary prompt. */
function renderMessage(m: Message): string {
  if (m.role === 'user') return `USER: ${m.content ?? ''}`;
  if (m.role === 'assistant') {
    const parts: string[] = [];
    if (m.content) parts.push(`ASSISTANT: ${m.content}`);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        parts.push(`  → called ${tc.name}(${tc.arguments})`);
      }
    }
    return parts.join('\n');
  }
  if (m.role === 'tool') {
    const preview = (m.content ?? '').slice(0, 500);
    return `TOOL[${m.name}]: ${preview}`;
  }
  return '';
}

export interface CompactResult {
  /** The generated summary text. */
  summary: string;
  /** How many tail messages should be kept verbatim (caller reuses for compactWithSummary). */
  kept: number;
}

/**
 * Summarize `history` except the last `keepTail` messages.
 * Uses the current config (model/preset/apiKey) via the provider factory.
 */
export async function compactHistory(
  history: Message[],
  model: string,
  keepTail: number = KEEP_TAIL_DEFAULT,
): Promise<CompactResult> {
  const toSummarize = history.slice(0, Math.max(0, history.length - keepTail));
  if (toSummarize.length === 0) {
    return { summary: '(nothing to compact)', kept: history.length };
  }

  const transcript = toSummarize.map(renderMessage).filter(Boolean).join('\n\n');

  const cfg = readConfig();
  const baseUrl = cfg.baseUrl ?? (cfg.preset ? PRESETS[cfg.preset]?.baseUrl : undefined);
  const apiKey =
    cfg.apiKey ??
    inferApiKeyFromEnv(model, cfg.provider, cfg.preset) ??
    (cfg.preset === 'ollama' || cfg.provider === 'ollama' ? 'ollama' : undefined);

  const provider = createProvider({ model, apiKey, baseUrl, provider: cfg.provider });

  const ac = new AbortController();
  const stream = provider.stream({
    messages: [{ role: 'user', content: `Transcript:\n\n${transcript}` }],
    systemPrompt: SUMMARY_SYSTEM,
    abortSignal: ac.signal,
    temperature: 0.2,
    maxTokens: 1024,
  });

  let out = '';
  for await (const ev of stream) {
    if (ev.type === 'text') out += ev.delta;
    else if (ev.type === 'error') throw ev.error;
    else if (ev.type === 'done') break;
  }
  const summary = out.trim() || '(no summary produced)';
  return { summary, kept: keepTail };
}
