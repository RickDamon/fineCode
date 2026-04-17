/**
 * Long-term memory — distilled "key facts" from past sessions.
 *
 * Inspired by Hermes Agent's two-layer memory but kept deliberately simple:
 *   - No SQLite / vector DB. One JSON file, linear scan, good up to a few
 *     thousand entries.
 *   - Facts are extracted at session-end (or on /memory save) by the same
 *     model that ran the session, guided by a tight system prompt.
 *   - Retrieval is by cwd match + recency + optional keyword, capped to 5.
 *
 * Storage: <profile-root>/memory.json
 *   {
 *     "entries": [
 *       { "id": "...", "cwd": "/path", "facts": ["..."], "addedAt": 123, "sessionId": "..." }
 *     ]
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { memoryFile } from '../config/paths.js';
import type { Message } from '../core/types.js';
import { createProvider, PRESETS } from '../providers/factory.js';
import { readConfig, inferApiKeyFromEnv } from './Config.js';

export interface MemoryEntry {
  id: string;
  cwd: string;
  facts: string[];
  addedAt: number;
  sessionId?: string;
}

interface MemoryStore {
  entries: MemoryEntry[];
}

const MAX_ENTRIES_TOTAL = 2000;
const RECALL_DEFAULT_DAYS = 60;

function loadStore(): MemoryStore {
  const file = memoryFile();
  try {
    if (!fs.existsSync(file)) return { entries: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) return parsed as MemoryStore;
  } catch {
    /* ignore, return empty */
  }
  return { entries: [] };
}

function saveStore(store: MemoryStore): void {
  const file = memoryFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Cap the total by dropping oldest entries.
  if (store.entries.length > MAX_ENTRIES_TOTAL) {
    store.entries.sort((a, b) => b.addedAt - a.addedAt);
    store.entries = store.entries.slice(0, MAX_ENTRIES_TOTAL);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listMemories(): MemoryEntry[] {
  return loadStore().entries.slice().sort((a, b) => b.addedAt - a.addedAt);
}

export function addMemoryEntry(entry: Omit<MemoryEntry, 'id' | 'addedAt'>): MemoryEntry {
  const full: MemoryEntry = {
    ...entry,
    id: crypto.randomBytes(3).toString('hex'),
    addedAt: Date.now(),
  };
  const store = loadStore();
  store.entries.push(full);
  saveStore(store);
  return full;
}

export function removeMemoryEntry(id: string): boolean {
  if (id === 'all') {
    saveStore({ entries: [] });
    return true;
  }
  const store = loadStore();
  const idx = store.entries.findIndex(e => e.id === id);
  if (idx < 0) return false;
  store.entries.splice(idx, 1);
  saveStore(store);
  return true;
}

/**
 * Fetch up to `limit` memory entries relevant to `cwd`.
 * Primary sort: exact cwd match first, then cwd prefix matches, then everything
 * else; secondary sort: recency (newest wins).
 * Entries older than `windowDays` are dropped unless no others qualify.
 */
export function recallForCwd(
  cwd: string,
  limit = 5,
  windowDays = RECALL_DEFAULT_DAYS,
): MemoryEntry[] {
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const all = loadStore().entries;

  const scored = all.map(e => {
    let score = 0;
    if (e.cwd === cwd) score += 100;
    else if (cwd.startsWith(e.cwd) || e.cwd.startsWith(cwd)) score += 50;
    const ageMs = now - e.addedAt;
    if (ageMs < windowMs) score += Math.max(0, 20 - ageMs / (7 * 24 * 60 * 60 * 1000));
    return { entry: e, score, ageMs };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.ageMs - b.ageMs; // newer first
  });

  const withinWindow = scored.filter(s => s.ageMs < windowMs).slice(0, limit);
  if (withinWindow.length > 0) return withinWindow.map(s => s.entry);
  // Fallback: return top-scored regardless of window (better to show stale context than none).
  return scored.slice(0, limit).map(s => s.entry);
}

/** Build a system-prompt block for the given entries. null if empty. */
export function memorySystemBlock(entries: MemoryEntry[]): string | null {
  if (entries.length === 0) return null;
  const parts: string[] = [
    '# User context (recalled from past sessions in this directory)',
    'These are facts distilled from previous conversations. Trust them, but verify with tools if something looks outdated.',
    '',
  ];
  for (const e of entries) {
    const age = Math.floor((Date.now() - e.addedAt) / (24 * 60 * 60 * 1000));
    parts.push(`## ${e.cwd} (${age}d ago)`);
    for (const f of e.facts) parts.push(`- ${f}`);
    parts.push('');
  }
  return parts.join('\n');
}

// ---- Distillation ----

const DISTILL_SYSTEM = `You extract durable facts from a coding session transcript. The user will return to a similar project later; your output must help the assistant remember what matters without re-reading the whole session.

Output a JSON array of short, concrete facts. Nothing else — no prose, no markdown, no explanation.

Each fact must be:
- Self-contained (understandable without the session history).
- Durable (still true days/weeks later — not "the user asked X").
- Specific (file paths, library versions, decision rationale).
- < 120 chars each.

Include at most 6 facts. Return [] if nothing durable happened.`;

function renderForDistill(history: Message[], maxMessages = 40): string {
  const tail = history.slice(-maxMessages);
  const out: string[] = [];
  for (const m of tail) {
    if (m.role === 'user') out.push(`USER: ${m.content ?? ''}`);
    else if (m.role === 'assistant') {
      if (m.content) out.push(`ASSISTANT: ${m.content}`);
      if (m.toolCalls) {
        for (const tc of m.toolCalls) out.push(`  → ${tc.name}(${tc.arguments.slice(0, 150)})`);
      }
    } else if (m.role === 'tool') {
      out.push(`TOOL[${m.name}]: ${(m.content ?? '').slice(0, 200)}`);
    }
  }
  return out.join('\n\n');
}

/**
 * Distill a session into memory facts and persist them. Returns the new entry,
 * or null if the model declined (returned empty array / noise).
 */
export async function distillSession(
  history: Message[],
  opts: { model: string; cwd: string; sessionId?: string },
): Promise<MemoryEntry | null> {
  if (history.length < 4) return null; // not enough substance

  const cfg = readConfig();
  const baseUrl = cfg.baseUrl ?? (cfg.preset ? PRESETS[cfg.preset]?.baseUrl : undefined);
  const apiKey =
    cfg.apiKey ??
    inferApiKeyFromEnv(opts.model, cfg.provider, cfg.preset) ??
    (cfg.preset === 'ollama' || cfg.provider === 'ollama' ? 'ollama' : undefined);
  const provider = createProvider({ model: opts.model, apiKey, baseUrl, provider: cfg.provider });

  const transcript = renderForDistill(history);
  const ac = new AbortController();
  const stream = provider.stream({
    messages: [{ role: 'user', content: `Project directory: ${opts.cwd}\n\nTranscript:\n\n${transcript}` }],
    systemPrompt: DISTILL_SYSTEM,
    abortSignal: ac.signal,
    temperature: 0.1,
    maxTokens: 600,
  });

  let raw = '';
  for await (const ev of stream) {
    if (ev.type === 'text') raw += ev.delta;
    else if (ev.type === 'error') throw ev.error;
    else if (ev.type === 'done') break;
  }

  // Extract the JSON array. Model sometimes wraps in ```json fences.
  const m = raw.match(/\[[\s\S]*?\]/);
  if (!m) return null;
  let facts: string[];
  try {
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return null;
    facts = parsed
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map(s => s.trim().slice(0, 240))
      .slice(0, 6);
  } catch {
    return null;
  }

  if (facts.length === 0) return null;

  return addMemoryEntry({ cwd: opts.cwd, facts, sessionId: opts.sessionId });
}
