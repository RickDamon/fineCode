/**
 * Session — conversation persistence + usage tracking.
 *
 * Storage layout:
 *   ~/.fineCode/sessions/
 *     <session-id>.jsonl   append-only log (one JSON record per line)
 *     <session-id>.meta.json   metadata (cwd, model, createdAt, lastAt, totals)
 *
 * Why JSONL?
 *   - Append-only → crash-safe; the process can die mid-turn and nothing is corrupted.
 *   - Easy to stream-parse for large histories.
 *   - Every record is self-contained; we can skip malformed lines on resume.
 *
 * Record types:
 *   { t: 'msg', m: Message }
 *   { t: 'usage', u: Usage, model: string }
 *   { t: 'snapshot', path: string, hash: string, bytes: number }   (used by B5 /rewind)
 *   { t: 'compact', droppedMessages: number, summary: string }     (used by B1 auto-compact)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Message, Usage } from '../core/types.js';
import { sessionsDir } from '../config/paths.js';

/** Back-compat shim: prefer calling `sessionsDir()` directly. */
export const SESSIONS_DIR = sessionsDir();

export interface SessionMeta {
  id: string;
  createdAt: number;
  lastAt: number;
  cwd: string;
  model: string;
  /** First user message, used as a human-friendly label. */
  title?: string;
  /** Running totals (prompt / completion / total tokens, approx cost in USD). */
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  /** How many messages are currently in the log after any compactions. */
  messageCount: number;
  /** Active workflow mode: none / ddd / tdd / sdd. */
  mode?: 'none' | 'ddd' | 'tdd' | 'sdd';
  /**
   * How many auto-compact attempts have failed back-to-back. Used as a
   * circuit breaker so a broken compaction path doesn't burn quota forever.
   * Reset to 0 on any successful compaction.
   */
  consecutiveCompactFailures?: number;
  /**
   * The session-scoped todo list (mirrors TodoTool's state). Kept in meta so
   * it survives Ctrl+C / `fine -c`, and so sibling subagents can't clobber
   * the parent's list.
   */
  todos?: TodoEntry[];
}

/** Loose copy of TodoTool's item shape — declared here to avoid a circular
 *  import (TodoTool reads and writes this via Session). */
export interface TodoEntry {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface SnapshotRecord {
  toolCallId: string;
  /** Absolute path of the file that was edited. */
  path: string;
  /** SHA-256 of the ORIGINAL (pre-edit) content, used as the snapshot filename. */
  hash: string;
  bytes: number;
  ts: number;
}

type LogRecord =
  | { t: 'msg'; m: Message }
  | { t: 'usage'; u: Usage; model: string; cost: number }
  | { t: 'snapshot'; snap: SnapshotRecord }
  | { t: 'compact'; droppedMessages: number; summary: string };

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function newId(): string {
  // YYYYMMDD-HHMMSS-<rand4>
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

export class Session {
  readonly id: string;
  readonly logPath: string;
  readonly metaPath: string;
  readonly snapshotDir: string;
  private meta: SessionMeta;
  private logStream: fs.WriteStream | null = null;
  private snapshots: SnapshotRecord[] = [];

  private constructor(id: string, meta: SessionMeta) {
    const dir = sessionsDir();
    this.id = id;
    this.logPath = path.join(dir, `${id}.jsonl`);
    this.metaPath = path.join(dir, `${id}.meta.json`);
    this.snapshotDir = path.join(dir, `${id}.snapshots`);
    this.meta = meta;
  }

  /** Create a fresh session. */
  static create(opts: { cwd: string; model: string }): Session {
    ensureDir(sessionsDir());
    const id = newId();
    const meta: SessionMeta = {
      id,
      createdAt: Date.now(),
      lastAt: Date.now(),
      cwd: opts.cwd,
      model: opts.model,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCost: 0,
      messageCount: 0,
    };
    const s = new Session(id, meta);
    s.flushMeta();
    return s;
  }

  /** Load an existing session by id. Returns null if not found. */
  static load(id: string): { session: Session; messages: Message[] } | null {
    const dir = sessionsDir();
    const metaPath = path.join(dir, `${id}.meta.json`);
    const logPath = path.join(dir, `${id}.jsonl`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(logPath)) return null;

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SessionMeta;
    } catch {
      return null;
    }
    const session = new Session(id, meta);
    const messages = session.replay();
    return { session, messages };
  }

  /** List recent sessions, newest first. */
  static list(limit = 20): SessionMeta[] {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.meta.json'));
    const metas: SessionMeta[] = [];
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j && typeof j === 'object' && j.id) metas.push(j as SessionMeta);
      } catch {
        /* ignore malformed meta */
      }
    }
    metas.sort((a, b) => b.lastAt - a.lastAt);
    return metas.slice(0, limit);
  }

  /** Find the most recent session for the given cwd. */
  static mostRecent(cwd?: string): SessionMeta | null {
    const all = Session.list(50);
    if (cwd) {
      return all.find(m => m.cwd === cwd) ?? all[0] ?? null;
    }
    return all[0] ?? null;
  }

  getMeta(): SessionMeta {
    return { ...this.meta };
  }

  getSnapshots(): SnapshotRecord[] {
    return [...this.snapshots];
  }

  /**
   * Re-read the log into a Message[] (used on resume). Side effect: populates
   * snapshots.
   *
   * Post-processes the raw log through `normalizeForResume()` so that a session
   * killed mid-tool-call doesn't explode on the next API request. Specifically:
   *   - Strips tool_use entries whose tool_result was never written back.
   *   - Drops resulting empty assistant shells.
   *   - Appends a "continue from where you left off" user message if the log
   *     ends with an interrupted turn.
   */
  private replay(): Message[] {
    const raw = fs.readFileSync(this.logPath, 'utf8');
    const messages: Message[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(line) as LogRecord;
      } catch {
        continue;
      }
      if (rec.t === 'msg') messages.push(rec.m);
      else if (rec.t === 'snapshot') this.snapshots.push(rec.snap);
      else if (rec.t === 'compact') {
        // Drop the oldest N messages and inject the summary at the front.
        const kept = messages.slice(rec.droppedMessages);
        messages.length = 0;
        messages.push({ role: 'user', content: `[Previous conversation summary] ${rec.summary}` });
        messages.push(...kept);
      }
    }
    const normalized = normalizeForResume(messages);
    this.meta.messageCount = normalized.length;
    return normalized;
  }

  private openLog(): fs.WriteStream {
    if (!this.logStream) {
      ensureDir(sessionsDir());
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a', mode: 0o600 });
    }
    return this.logStream;
  }

  private writeLine(rec: LogRecord): void {
    this.openLog().write(JSON.stringify(rec) + '\n');
  }

  private flushMeta(): void {
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2), { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  /** Append a new message to the log. */
  recordMessage(m: Message): void {
    this.writeLine({ t: 'msg', m });
    this.meta.messageCount += 1;
    this.meta.lastAt = Date.now();
    // Use the first user message as the session title.
    if (!this.meta.title && m.role === 'user' && typeof m.content === 'string') {
      this.meta.title = m.content.slice(0, 80);
    }
    this.flushMeta();
  }

  /** Record token usage and running cost. */
  recordUsage(usage: Usage, model: string, cost: number): void {
    this.writeLine({ t: 'usage', u: usage, model, cost });
    this.meta.totalPromptTokens += usage.promptTokens;
    this.meta.totalCompletionTokens += usage.completionTokens;
    this.meta.totalCost += cost;
    this.flushMeta();
  }

  /** Record a file snapshot (used by write_file / edit_file before changes). */
  recordSnapshot(snap: SnapshotRecord, content: Buffer | string): void {
    ensureDir(this.snapshotDir);
    const dest = path.join(this.snapshotDir, snap.hash);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, content);
    }
    this.snapshots.push(snap);
    this.writeLine({ t: 'snapshot', snap });
  }

  /** Record a context compaction event. Caller is expected to have rewritten in-memory history already. */
  recordCompact(droppedMessages: number, summary: string): void {
    this.writeLine({ t: 'compact', droppedMessages, summary });
    this.meta.messageCount -= droppedMessages;
    if (this.meta.messageCount < 0) this.meta.messageCount = 0;
    this.flushMeta();
  }

  /** Persist the active workflow mode on the session meta. */
  setMode(mode: SessionMeta['mode']): void {
    this.meta.mode = mode;
    this.flushMeta();
  }

  /** Persist an updated model (used when /model switches). */
  setModel(model: string): void {
    this.meta.model = model;
    this.flushMeta();
  }

  /** Circuit-breaker support for auto-compact. See SessionMeta docs. */
  recordCompactSuccess(): void {
    if (this.meta.consecutiveCompactFailures) {
      this.meta.consecutiveCompactFailures = 0;
      this.flushMeta();
    }
  }

  recordCompactFailure(): number {
    this.meta.consecutiveCompactFailures = (this.meta.consecutiveCompactFailures ?? 0) + 1;
    this.flushMeta();
    return this.meta.consecutiveCompactFailures;
  }

  /**
   * Get/set the session's todo list. We store this in session meta (rather
   * than as a module-level singleton) so that (a) concurrent subagents don't
   * pollute each other's lists and (b) `fine -c` restores todos after a
   * restart instead of silently losing them.
   */
  getTodos(): TodoEntry[] {
    return this.meta.todos ? [...this.meta.todos] : [];
  }

  setTodos(todos: TodoEntry[]): void {
    this.meta.todos = todos;
    this.flushMeta();
  }

  /** Read a previously-saved snapshot by hash. Returns null if missing. */
  readSnapshot(hash: string): Buffer | null {
    const p = path.join(this.snapshotDir, hash);
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  close(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}

// ---------- resume-time normalization ----------

/**
 * Clean a replayed message list so the next API request doesn't reject it.
 *
 * When the process is killed (Ctrl+C, crash, network drop) mid-turn, the JSONL
 * log can end in a few bad shapes that every provider dislikes:
 *
 *   1. Assistant message with `tool_use` entries whose matching `tool_result`
 *      was never written. Anthropic explicitly errors:
 *        "tool_use ids were found without tool_result blocks"
 *
 *   2. Assistant message that was streamed into the log but only contains
 *      partial/empty content (model was generating when we died).
 *
 *   3. A trailing user message with no assistant reply — the model will
 *      otherwise just continue where it left off with zero context on what
 *      was interrupted.
 *
 * We fix each in the least-invasive way: filter, drop empty shells, and
 * optionally append a short continuation prompt.
 *
 * Exported for unit tests.
 */
export function normalizeForResume(messages: Message[]): Message[] {
  // Pass 1: collect all tool_result ids so we know which tool_use calls were
  // resolved.
  const resolvedIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) resolvedIds.add(m.toolCallId);
  }

  // Pass 2: rebuild list, pruning orphan tool_use entries + empty assistant
  // shells. A "shell" is an assistant message whose text is blank AND whose
  // only reason to exist was the (now dropped) orphan tool_use.
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const kept = m.toolCalls.filter(tc => resolvedIds.has(tc.id));
      const hasText = typeof m.content === 'string' && m.content.trim().length > 0;
      if (kept.length === 0 && !hasText) continue; // drop empty shell
      out.push({
        ...m,
        toolCalls: kept.length > 0 ? kept : undefined,
      });
    } else if (m.role === 'tool') {
      // Any tool_result whose parent tool_use got dropped above would be
      // orphaned in the other direction. In practice our pass-1 logic means
      // this shouldn't happen (we only ever dropped tool_use with NO result),
      // but defense in depth:
      if (!m.toolCallId || resolvedIds.has(m.toolCallId)) out.push(m);
    } else {
      out.push(m);
    }
  }

  // Pass 3: if the log ends with a user message (model never replied), or with
  // an assistant message that had orphan tool_calls stripped and now reads as
  // "incomplete", append a short continuation prompt. This nudges the model
  // to resume without pretending nothing was interrupted.
  const last = out[out.length - 1];
  const needsNudge =
    last?.role === 'user' ||
    (last?.role === 'assistant' &&
      !(last.toolCalls && last.toolCalls.length > 0) &&
      (typeof last.content !== 'string' || last.content.trim().length === 0));

  if (needsNudge) {
    out.push({
      role: 'user',
      content:
        '[Previous turn was interrupted before completion. Continue from where you left off — no apology, pick up mid-thought.]',
    });
  }

  return out;
}
