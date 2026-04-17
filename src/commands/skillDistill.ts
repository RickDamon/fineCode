/**
 * /skill save — ask the model to distill the recent session into a SKILL.md.
 *
 * We reuse the provider factory (same model/key/url as the main loop), but do
 * NOT go through Agent — skill distillation is a single, bounded API call with
 * no tools.
 */

import type { Message } from '../core/types.js';
import { createProvider, PRESETS } from '../providers/factory.js';
import { readConfig, inferApiKeyFromEnv } from '../config/Config.js';
import { saveSkill, type Skill } from '../context/Skills.js';

const DISTILL_SYSTEM = `You are a skill distillation assistant. You will receive a transcript of a coding session. Produce a short, reusable "skill" document that the assistant can apply to similar future tasks.

Output strictly in this format:

TITLE: <one-line title>
TRIGGERS: <comma-separated keywords likely to appear in a user's message when this skill applies>

## When to apply
<one paragraph>

## Steps
1. <concrete step>
2. <concrete step>
...

## Pitfalls
- <gotcha 1>
- <gotcha 2>

Rules:
- Be concrete. Prefer file paths, command names, API function names.
- Do NOT invent steps that didn't happen in the transcript.
- Keep under 40 lines total.`.trim();

function renderHistoryForSkill(history: Message[], lastN: number): string {
  const tail = history.slice(-lastN);
  const lines: string[] = [];
  for (const m of tail) {
    if (m.role === 'user') lines.push(`USER: ${m.content ?? ''}`);
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`ASSISTANT: ${m.content}`);
      if (m.toolCalls) {
        for (const tc of m.toolCalls) lines.push(`  → ${tc.name}(${tc.arguments.slice(0, 200)})`);
      }
    } else if (m.role === 'tool') {
      lines.push(`TOOL[${m.name}]: ${(m.content ?? '').slice(0, 300)}`);
    }
  }
  return lines.join('\n\n');
}

function parseDistilled(raw: string): { title: string; triggers: string[]; body: string } {
  let title = 'untitled-skill';
  let triggers: string[] = [];
  let body = raw;

  const lines = raw.split('\n');
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor]!;
    if (line.toUpperCase().startsWith('TITLE:')) {
      title = line.slice(6).trim();
      cursor++;
    } else if (line.toUpperCase().startsWith('TRIGGERS:')) {
      triggers = line
        .slice(9)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      cursor++;
    } else if (line.trim() === '') {
      cursor++;
    } else {
      break;
    }
  }
  body = lines.slice(cursor).join('\n').trim();
  return { title, triggers, body };
}

export interface DistillOptions {
  /** Number of trailing messages to use as the source transcript. */
  lastN?: number;
  /** Optional name override; otherwise derived from title. */
  name?: string;
  /** Model to use for distillation; defaults to the current session's model. */
  model: string;
}

/**
 * Run distillation and persist the result. Returns the saved Skill.
 * Throws on provider errors.
 */
export async function distillSkill(
  history: Message[],
  opts: DistillOptions,
): Promise<Skill> {
  const lastN = opts.lastN ?? 20;
  if (history.length === 0) {
    throw new Error('No history to distill from. Have a conversation first.');
  }

  const cfg = readConfig();
  const baseUrl = cfg.baseUrl ?? (cfg.preset ? PRESETS[cfg.preset]?.baseUrl : undefined);
  const apiKey =
    cfg.apiKey ??
    inferApiKeyFromEnv(opts.model, cfg.provider, cfg.preset) ??
    (cfg.preset === 'ollama' || cfg.provider === 'ollama' ? 'ollama' : undefined);
  const provider = createProvider({ model: opts.model, apiKey, baseUrl, provider: cfg.provider });

  const transcript = renderHistoryForSkill(history, lastN);
  const ac = new AbortController();
  const stream = provider.stream({
    messages: [{ role: 'user', content: `Transcript:\n\n${transcript}` }],
    systemPrompt: DISTILL_SYSTEM,
    abortSignal: ac.signal,
    temperature: 0.2,
    maxTokens: 900,
  });

  let raw = '';
  for await (const ev of stream) {
    if (ev.type === 'text') raw += ev.delta;
    else if (ev.type === 'error') throw ev.error;
    else if (ev.type === 'done') break;
  }
  raw = raw.trim();
  if (!raw) throw new Error('Distillation produced empty output.');

  const parsed = parseDistilled(raw);
  const derivedName =
    parsed.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || `skill-${Date.now()}`;
  const name = opts.name ?? derivedName;
  return saveSkill(name, {
    title: parsed.title,
    triggers: parsed.triggers,
    body: parsed.body,
  });
}
